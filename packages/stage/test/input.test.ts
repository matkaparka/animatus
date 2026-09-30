// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDENTITY, type Adjust } from '../src/camera.ts'
import { CameraInput, type CameraControls } from '../src/input.ts'

class FakeControls implements CameraControls {
  locked = false
  adjust: Adjust = { ...IDENTITY, pan: [0, 0, 0] }
  interacting = false
  calls: string[] = []
  get currentAdjust(): Adjust {
    return { ...this.adjust, pan: [...this.adjust.pan] as [number, number, number] }
  }
  setInteracting(on: boolean) {
    this.interacting = on
  }
  orbit(dx: number, dy: number) {
    this.calls.push(`orbit ${dx},${dy}`)
    this.adjust.yaw -= dx / 100
  }
  pan(dx: number, dy: number) {
    this.calls.push(`pan ${dx},${dy}`)
    this.adjust.pan[0] += dx / 100
  }
  dolly(deltaY: number) {
    this.calls.push(`dolly ${deltaY}`)
    this.adjust.zoom *= deltaY < 0 ? 0.9 : 1 / 0.9
  }
  resetAdjust() {
    this.calls.push('reset')
    this.adjust = { ...IDENTITY, pan: [0, 0, 0] }
  }
}

function setup(options: { settleMs?: number } = {}) {
  const canvas = document.createElement('canvas')
  const captured: number[] = []
  ;(canvas as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = (id) =>
    captured.push(id)
  ;(canvas as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture = (
    id
  ) => captured.splice(captured.indexOf(id), 1)
  const controls = new FakeControls()
  const reports: Adjust[] = []
  const input = new CameraInput(canvas, controls, { onSettled: (a) => reports.push(a), ...options })
  // happy-dom has no PointerEvent constructor we can rely on: an Event with the fields the input reads
  const fire = (type: string, init: Record<string, unknown> = {}, cancelable = true) => {
    const e = new Event(type, { cancelable, bubbles: true })
    Object.assign(
      e,
      {
        pointerId: 1,
        button: 0,
        clientX: 0,
        clientY: 0,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        deltaY: 0,
        deltaMode: 0,
      },
      init
    )
    canvas.dispatchEvent(e)
    return e
  }
  return { canvas, controls, reports, input, fire, captured }
}

describe('camera input', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a grab hand, and a closed one while dragging', () => {
    const { canvas, fire } = setup()
    expect(canvas.style.cursor).toBe('grab')
    fire('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    expect(canvas.style.cursor).toBe('grabbing')
    fire('pointerup', { button: 0 })
    expect(canvas.style.cursor).toBe('grab')
  })

  it('left drag orbits by the distance the pointer moved, and reports once when it ends', () => {
    const { controls, reports, fire, captured } = setup()
    fire('pointerdown', { button: 0, clientX: 100, clientY: 100 })
    expect(captured).toEqual([1])
    expect(controls.interacting).toBe(true)
    fire('pointermove', { clientX: 130, clientY: 90 })
    fire('pointermove', { clientX: 150, clientY: 90 })
    expect(controls.calls).toEqual(['orbit 30,-10', 'orbit 20,0'])
    expect(reports).toHaveLength(0) // nothing is reported while the pointer is still down
    fire('pointerup')
    expect(controls.interacting).toBe(false)
    expect(captured).toEqual([])
    expect(reports).toHaveLength(1)
    expect(reports[0]?.yaw).toBeCloseTo(-0.5, 9)
  })

  it('right drag, and shift, ctrl or meta with the left button, pan; the middle button zooms', () => {
    const { controls, fire } = setup()
    fire('pointerdown', { button: 2, clientX: 0, clientY: 0 })
    fire('pointermove', { clientX: 5, clientY: 0 })
    fire('pointerup')
    for (const key of ['shiftKey', 'ctrlKey', 'metaKey']) {
      fire('pointerdown', { button: 0, [key]: true, clientX: 0, clientY: 0 })
      fire('pointermove', { clientX: 4, clientY: 0 })
      fire('pointerup')
    }
    fire('pointerdown', { button: 1, clientX: 0, clientY: 0 })
    fire('pointermove', { clientX: 0, clientY: 50 })
    fire('pointerup')
    expect(controls.calls).toEqual(['pan 5,0', 'pan 4,0', 'pan 4,0', 'pan 4,0', 'dolly 50'])
  })

  it('a click that does not move reports nothing', () => {
    const { reports, fire } = setup()
    fire('pointerdown', { button: 0, clientX: 5, clientY: 5 })
    fire('pointerup')
    expect(reports).toHaveLength(0)
  })

  it('ignores other buttons and a second pointer while one drag is in progress', () => {
    const { controls, fire } = setup()
    fire('pointerdown', { button: 3, clientX: 0, clientY: 0 })
    fire('pointermove', { clientX: 20, clientY: 0 })
    expect(controls.calls).toEqual([])
    fire('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fire('pointerdown', { button: 2, pointerId: 2, clientX: 0, clientY: 0 })
    fire('pointermove', { pointerId: 2, clientX: 30, clientY: 0 })
    expect(controls.calls).toEqual([])
    fire('pointermove', { pointerId: 1, clientX: 30, clientY: 0 })
    expect(controls.calls).toEqual(['orbit 30,0'])
  })

  it('a drag that loses the pointer (window switch, capture stolen) ends like a release', () => {
    const { controls, reports, fire } = setup()
    fire('pointerdown', { button: 0, clientX: 0, clientY: 0 })
    fire('pointermove', { clientX: 40, clientY: 0 })
    fire('lostpointercapture')
    expect(controls.interacting).toBe(false)
    expect(reports).toHaveLength(1)
    fire('pointermove', { clientX: 90, clientY: 0 })
    expect(controls.calls).toEqual(['orbit 40,0'])
  })

  it('the wheel zooms, is not passed on to the page, and is reported once it has stopped', () => {
    const { controls, reports, fire } = setup({ settleMs: 300 })
    const e1 = fire('wheel', { deltaY: -100 })
    expect(e1.defaultPrevented).toBe(true)
    fire('wheel', { deltaY: -100 })
    fire('wheel', { deltaY: -100 })
    expect(controls.calls).toEqual(['dolly -100', 'dolly -100', 'dolly -100'])
    expect(controls.interacting).toBe(true)
    vi.advanceTimersByTime(200)
    expect(reports).toHaveLength(0)
    fire('wheel', { deltaY: 100 }) // still turning: the wait starts over
    vi.advanceTimersByTime(250)
    expect(reports).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(reports).toHaveLength(1)
    expect(controls.interacting).toBe(false)
  })

  it('wheel deltas in lines or pages are turned into pixels', () => {
    const { controls, fire } = setup()
    fire('wheel', { deltaY: 3, deltaMode: 1 })
    fire('wheel', { deltaY: 1, deltaMode: 2 })
    expect(controls.calls).toEqual(['dolly 48', 'dolly 100'])
  })

  it('a double click starts over and reports that at once', () => {
    const { controls, reports, fire } = setup()
    fire('pointerdown', { button: 0, clientX: 0, clientY: 0 })
    fire('pointermove', { clientX: 60, clientY: 0 })
    fire('pointerup')
    expect(reports).toHaveLength(1)
    fire('dblclick')
    expect(controls.calls.at(-1)).toBe('reset')
    expect(reports).toHaveLength(2)
    expect(reports[1]).toEqual({ ...IDENTITY, pan: [0, 0, 0] })
    // and a double click on an untouched camera says nothing
    fire('dblclick')
    expect(reports).toHaveLength(2)
  })

  it('does not report what the orchestrator has just told it', () => {
    const { controls, reports, fire, input } = setup()
    controls.adjust = { ...IDENTITY, yaw: 0.7, pan: [0, 0, 0] } // a snapshot arrived and was applied
    input.synced()
    fire('dblclick')
    fire('dblclick')
    expect(reports).toHaveLength(1) // the reset is a change; the second double click is not
    controls.adjust = { ...IDENTITY, yaw: 0.7, pan: [0, 0, 0] }
    input.synced()
    fire('pointerdown', { button: 0, clientX: 0, clientY: 0 })
    fire('pointerup')
    expect(reports).toHaveLength(1)
  })

  it('a locked composition takes no input at all and shows an ordinary pointer', () => {
    const { canvas, controls, reports, fire, input } = setup()
    controls.locked = true
    input.refreshCursor()
    expect(canvas.style.cursor).toBe('default')
    fire('pointerdown', { button: 0, clientX: 0, clientY: 0 })
    fire('pointermove', { clientX: 50, clientY: 0 })
    fire('pointerup')
    const wheel = fire('wheel', { deltaY: -100 })
    fire('dblclick')
    expect(controls.calls).toEqual([])
    expect(reports).toHaveLength(0)
    expect(wheel.defaultPrevented).toBe(false)
    controls.locked = false
    input.refreshCursor()
    expect(canvas.style.cursor).toBe('grab')
  })

  it('the context menu never opens over the stage (right drag needs the button)', () => {
    const { fire } = setup()
    expect(fire('contextmenu').defaultPrevented).toBe(true)
  })

  it('dispose stops listening', () => {
    const { controls, fire, input } = setup()
    input.dispose()
    fire('pointerdown', { button: 0, clientX: 0, clientY: 0 })
    fire('pointermove', { clientX: 30, clientY: 0 })
    expect(controls.calls).toEqual([])
  })
})
