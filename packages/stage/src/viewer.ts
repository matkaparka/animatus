import * as THREE from 'three'
import type { CameraConfig, CharLayout } from '@animatus/protocol'
import { fitCamera, type BodyMetrics } from './camera.ts'

/** Base light intensities; the scene's `lighting.intensity` and the look's `light` multiply them. */
const DIRECTIONAL = 1.8
const AMBIENT = 1.2

/**
 * Renderer, camera and lights. There are no camera controls: the camera is placed from the scene
 * snapshot and, once the model is up, from what was measured of it (its head height, or a fit).
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
  }
  /** Measured once per model, so a re-sent scene snapshot puts the camera back where it was. */
  private body: BodyMetrics | null = null

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
    this.place()
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

  private place(): void {
    const { cfg, body, camera } = this
    camera.fov = cfg.fov
    if (body && cfg.fit !== 'none') {
      const f = fitCamera(cfg.fit, cfg.fov, camera.aspect, body)
      camera.position.set(...f.position)
      camera.lookAt(...f.target)
    } else if (body && cfg.follow_head) {
      camera.position.set(cfg.position[0], body.headY, cfg.position[2])
      camera.lookAt(body.x, body.headY, body.z)
    } else {
      camera.position.set(...cfg.position)
      camera.lookAt(...cfg.target)
    }
    camera.updateProjectionMatrix()
  }
}
