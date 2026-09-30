import * as THREE from 'three'
import { NO_CAMERA_ADJUST } from '@animatus/protocol'
import type { CameraConfig, CharLayout } from '@animatus/protocol'
import {
  applyAdjust,
  clampAdjust,
  dollyAdjust,
  fitCamera,
  orbitAdjust,
  panAdjust,
  type Adjust,
  type BodyMetrics,
  type Pose,
  type Vec3,
} from './camera.ts'

/** Base light intensities; the scene's `lighting.intensity` and the look's `light` multiply them. */
const DIRECTIONAL = 1.8
const AMBIENT = 1.2

/**
 * Renderer, camera and lights. The camera is placed from the scene snapshot and, once the model is up, from
 * what was measured of it (its head height, or a fit). On top of that sits the operator's mouse adjustment
 * (orbit, pan, zoom), which is relative to that base pose and reported to the orchestrator, not kept here.
 */
export class Viewer {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  private readonly directional: THREE.DirectionalLight
  private readonly ambient: THREE.AmbientLight
  private lightScene = 1
  private lightLook = 1
  private cfg: CameraConfig = {
    fov: 20,
    position: [0, 1.3, 1.5],
    target: [0, 1.3, 0],
    follow_head: true,
    fit: 'none',
    adjust: NO_CAMERA_ADJUST,
    locked: false,
  }
  /** Measured once per model, so a re-sent scene snapshot puts the camera back where it was. */
  private body: BodyMetrics | null = null
  private adjust: Adjust = { ...NO_CAMERA_ADJUST, pan: [...NO_CAMERA_ADJUST.pan] as Vec3 }
  /** The camera's own axes after the last placement, for panning. */
  private axes: { right: Vec3; up: Vec3 } = { right: [1, 0, 0], up: [0, 1, 0] }
  /** A gesture is in progress: an echoed snapshot must not pull the camera out from under the pointer. */
  private interacting = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    // A model made at another scale (this one is 4 m tall, its tail reaches 10 m behind it) needs a deep frustum.
    this.camera = new THREE.PerspectiveCamera(this.cfg.fov, 1, 0.1, 200)
    this.scene.add(this.camera)

    this.directional = new THREE.DirectionalLight(0xffffff, DIRECTIONAL)
    this.directional.position.set(1, 1, 1).normalize()
    this.scene.add(this.directional)
    this.ambient = new THREE.AmbientLight(0xffffff, AMBIENT)
    this.scene.add(this.ambient)

    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  /** Character placement: scaled about the bottom-right corner, then translated (vw / vh). */
  applyLayout(layout: CharLayout): void {
    const s = this.canvas.style
    s.transformOrigin = '100% 100%'
    s.transform = `translate(${layout.x}vw, ${layout.y}vh) scale(${layout.scale})`
  }

  applyCamera(cfg: CameraConfig): void {
    this.cfg = cfg
    if (!this.interacting)
      this.adjust = clampAdjust({ ...cfg.adjust, pan: [...cfg.adjust.pan] as Vec3 })
    this.place()
  }

  /** The mouse does nothing while the composition is locked. */
  get locked(): boolean {
    return this.cfg.locked
  }

  /**
   * The measured body of the model now on stage (null when there is none). The legacy viewer measured the head
   * once after the first animated frame, because the animation shifts the origin; so does the stage.
   */
  setBody(body: BodyMetrics | null): void {
    this.body = body
    this.place()
  }

  setLighting(sceneFactor: number, lookFactor: number): void {
    this.lightScene = sceneFactor
    this.lightLook = lookFactor
    const k = this.lightScene * this.lightLook
    this.directional.intensity = DIRECTIONAL * k
    this.ambient.intensity = AMBIENT * k
  }

  resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.place()
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  // ─────────────────────────── the operator's mouse ───────────────────────────

  get currentAdjust(): Adjust {
    return { ...this.adjust, pan: [...this.adjust.pan] as Vec3 }
  }

  setInteracting(on: boolean): void {
    this.interacting = on
  }

  private get heightPx(): number {
    return this.canvas.clientHeight || window.innerHeight || 1
  }

  orbit(dxPx: number, dyPx: number): void {
    this.adjust = orbitAdjust(this.adjust, dxPx, dyPx, this.heightPx)
    this.place()
  }

  pan(dxPx: number, dyPx: number): void {
    this.adjust = panAdjust(this.adjust, dxPx, dyPx, this.heightPx, this.axes.right, this.axes.up)
    this.place()
  }

  dolly(deltaY: number): void {
    this.adjust = dollyAdjust(this.adjust, deltaY)
    this.place()
  }

  /** Back to the pose the configuration gives (double click). */
  resetAdjust(): void {
    this.adjust = { ...NO_CAMERA_ADJUST, pan: [...NO_CAMERA_ADJUST.pan] as Vec3 }
    this.place()
  }

  // ─────────────────────────── placement ───────────────────────────

  /** The pose before the operator's adjustment: fixed numbers, the head height, or a fit by the measured body. */
  private basePose(): Pose {
    const { cfg, body, camera } = this
    if (body && cfg.fit !== 'none') return fitCamera(cfg.fit, cfg.fov, camera.aspect, body)
    if (body && cfg.follow_head) {
      return {
        position: [cfg.position[0], body.headY, cfg.position[2]],
        target: [body.x, body.headY, body.z],
      }
    }
    return { position: [...cfg.position] as Vec3, target: [...cfg.target] as Vec3 }
  }

  private place(): void {
    const { cfg, camera } = this
    camera.fov = cfg.fov
    const p = applyAdjust(this.basePose(), cfg.fov, this.adjust)
    this.axes = { right: p.right, up: p.up }
    camera.position.set(...p.position)
    camera.lookAt(...p.target)
    camera.updateProjectionMatrix()
  }
}
