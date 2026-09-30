import { sameAdjust, type Adjust } from './camera.ts'

/** What the camera input drives: the viewer implements it. */
export interface CameraControls {
  readonly locked: boolean
  readonly currentAdjust: Adjust
  setInteracting(on: boolean): void
  orbit(dxPx: number, dyPx: number): void
  pan(dxPx: number, dyPx: number): void
  dolly(deltaY: number): void
  resetAdjust(): void
}

/** The parts of a DOM element the input uses, so it can be tested without a browser. */
export interface InputTarget {
  // `any`: the DOM's own overloads are keyed by event name, and a stand-in in a test is not a DOM element.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (e: any) => void, options?: any): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, listener: (e: any) => void): void
  setPointerCapture?(pointerId: number): void
  releasePointerCapture?(pointerId: number): void
  style: { cursor: string }
}

/** The fields of a pointer or wheel event the input reads. */
interface Gesture {
  pointerId: number
  button: number
  clientX: number
  clientY: number
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  deltaY: number
  deltaMode: number
  preventDefault(): void
}

type Mode = 'orbit' | 'pan' | 'dolly'

export interface CameraInputOptions {
  /** Called once a gesture has settled, with the adjustment the orchestrator should keep. */
  onSettled: (adjust: Adjust) => void
  /** Quiet time after the last wheel notch before it counts as settled (ms). */
  settleMs?: number
}

/**
 * The operator's mouse on the stage window, as the legacy viewer's OrbitControls had it:
 *   left drag                      orbit around what the camera looks at
 *   right drag, or shift/ctrl + left drag   pan (the scene follows the pointer)
 *   middle drag, wheel             zoom
 *   double click                   start over
 * The input moves the camera at once for feedback and, when a gesture ends, reports the result. It decides
 * nothing: the orchestrator stores what it is told and echoes it back in the scene snapshot.
 */
export class CameraInput {
  private drag: { id: number; mode: Mode; x: number; y: number } | null = null
  private reported: Adjust
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly settleMs: number
  private readonly handlers: [string, (e: Gesture) => void, unknown?][]

  constructor(
    private readonly target: InputTarget,
    private readonly controls: CameraControls,
    private readonly opts: CameraInputOptions
  ) {
    this.settleMs = opts.settleMs ?? 350
    this.reported = controls.currentAdjust
    const on = (type: string, fn: (e: Gesture) => void, options?: unknown) =>
      this.handlers.push([type, fn, options])
    this.handlers = []
    on('pointerdown', (e) => this.down(e))
    on('pointermove', (e) => this.move(e))
    on('pointerup', (e) => this.up(e))
    on('pointercancel', (e) => this.up(e))
    on('lostpointercapture', (e) => this.up(e))
    on('wheel', (e) => this.wheel(e), { passive: false })
    on('dblclick', (e) => this.doubleClick(e))
    on('contextmenu', (e) => e.preventDefault())
    for (const [type, fn, options] of this.handlers) target.addEventListener(type, fn, options)
    this.refreshCursor()
  }

  dispose(): void {
    for (const [type, fn] of this.handlers) this.target.removeEventListener(type, fn)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.drag = null
    this.controls.setInteracting(false)
  }

  /** The orchestrator's snapshot arrived: this is what it has, so it is not reported back. Call after applying it. */
  synced(): void {
    this.reported = this.controls.currentAdjust
    this.refreshCursor()
  }

  /** Grab hand over the stage, an ordinary pointer while the composition is locked. */
  refreshCursor(): void {
    this.target.style.cursor = this.controls.locked ? 'default' : this.drag ? 'grabbing' : 'grab'
  }

  private down(e: Gesture): void {
    if (this.controls.locked || this.drag) return
    const mode: Mode | null =
      e.button === 2 || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey))
        ? 'pan'
        : e.button === 0
          ? 'orbit'
          : e.button === 1
            ? 'dolly'
            : null
    if (!mode) return
    e.preventDefault()
    this.target.setPointerCapture?.(e.pointerId)
    this.drag = { id: e.pointerId, mode, x: e.clientX, y: e.clientY }
    this.controls.setInteracting(true)
    this.refreshCursor()
  }

  private move(e: Gesture): void {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.x = e.clientX
    d.y = e.clientY
    if (dx === 0 && dy === 0) return
    if (d.mode === 'orbit') this.controls.orbit(dx, dy)
    else if (d.mode === 'pan') this.controls.pan(dx, dy)
    else this.controls.dolly(dy)
  }

  private up(e: Gesture): void {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.target.releasePointerCapture?.(d.id)
    this.drag = null
    this.refreshCursor()
    this.settle()
  }

  private wheel(e: Gesture): void {
    if (this.controls.locked) return
    e.preventDefault()
    // Lines and pages to pixels, roughly what a browser does for a notch of the wheel.
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1)
    this.controls.setInteracting(true)
    this.controls.dolly(delta)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.settle(), this.settleMs)
  }

  private doubleClick(e: Gesture): void {
    if (this.controls.locked) return
    e.preventDefault()
    this.controls.resetAdjust()
    this.settle()
  }

  private settle(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.drag) this.controls.setInteracting(false)
    const now = this.controls.currentAdjust
    if (sameAdjust(now, this.reported)) return
    this.reported = now
    this.opts.onSettled(now)
  }
}
