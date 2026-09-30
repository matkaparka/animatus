/**
 * Smoothed gaze. `three-vrm` turns the eyes straight at `vrm.lookAt.target` on every frame, which looks
 * mechanical: any change in the target (or in the head pose the angles are measured against) shows up
 * at once. `SmoothLookAt` low-passes the yaw / pitch it hands to the applier with an exponential filter
 * and adds small random saccades, like the tiny involuntary eye jumps of a real gaze.
 *
 * The target itself is an object that hangs off the camera (`attachGazeTarget`); the procedural layer
 * moves it for glances and reads `vrm.lookAt.target` to do so, so it has to stay set.
 */
import * as THREE from 'three'
import { VRMLookAt, VRMLookAtLoaderPlugin } from '@pixiv/three-vrm'
import type { VRM, VRMHumanoid, VRMLookAtApplier } from '@pixiv/three-vrm'
import type { GLTF, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'

export interface SaccadeOptions {
  enabled: boolean
  /** Smallest / largest saccade, in degrees of look-at angle (before the model's range map shrinks them). */
  minDeg: number
  maxDeg: number
  /** Time between two saccades, drawn uniformly from this range (s). */
  minInterval: number
  maxInterval: number
}

export const DEFAULT_SACCADE: Readonly<SaccadeOptions> = {
  enabled: true,
  minDeg: 0.3,
  maxDeg: 3,
  minInterval: 1,
  maxInterval: 4,
}

export interface SmoothLookAtOptions {
  /** Time constant of the exponential smoothing (s). */
  tau?: number
  saccade?: Partial<SaccadeOptions>
  /** Injectable RNG (tests); default `Math.random`. */
  random?: () => number
}

/**
 * Default smoothing time constant (s). The procedural layer already moves its glance target with a
 * 35 ms time constant, so this is kept small enough that its glances still read as quick eye jumps.
 */
export const DEFAULT_SMOOTH_TAU = 0.03

/** Wrap an angle into [-180, 180) degrees (angles already in range come back unchanged). */
const wrapDeg = (d: number) => (d >= -180 && d < 180 ? d : ((((d + 180) % 360) + 360) % 360) - 180)

export class SmoothLookAt extends VRMLookAt {
  /** Time constant (s) of the exponential smoothing of the gaze angles. */
  smoothTau = DEFAULT_SMOOTH_TAU
  readonly saccade: SaccadeOptions = { ...DEFAULT_SACCADE }
  random: () => number = Math.random

  private _yawSmooth = 0
  private _pitchSmooth = 0
  private _saccadeYaw = 0
  private _saccadePitch = 0
  private _saccadeIn = 0
  private _primed = false
  private _lastTarget: THREE.Object3D | null | undefined = undefined
  private _worldPos = new THREE.Vector3()

  constructor(humanoid: VRMHumanoid, applier: VRMLookAtApplier, opts: SmoothLookAtOptions = {}) {
    super(humanoid, applier)
    if (opts.tau !== undefined) this.smoothTau = opts.tau
    if (opts.saccade) Object.assign(this.saccade, opts.saccade)
    if (opts.random) this.random = opts.random
    this._saccadeIn = this.nextSaccadeInterval()
  }

  override update(delta: number): void {
    if (this.target && this.autoUpdate) {
      // Raw angles towards the target: sets _yaw / _pitch.
      this.lookAt(this.target.getWorldPosition(this._worldPos))
      const dt = Number.isFinite(delta) ? Math.max(0, delta) : 0

      // A different target (or coming back from none): start from where it is, do not swing over.
      if (this.target !== this._lastTarget) {
        this._lastTarget = this.target
        this._primed = false
      }

      if (this.saccade.enabled) this.advanceSaccade(dt)
      else this._saccadeYaw = this._saccadePitch = 0

      const yaw = this._yaw + this._saccadeYaw
      const pitch = this._pitch + this._saccadePitch
      if (!this._primed) {
        this._yawSmooth = yaw
        this._pitchSmooth = pitch
        this._primed = true
      } else {
        const k = 1 - Math.exp(-dt / Math.max(this.smoothTau, 1e-4))
        // Yaw wraps at +-180 (a target behind the head): take the short way round, not through 0.
        this._yawSmooth = wrapDeg(this._yawSmooth + wrapDeg(yaw - this._yawSmooth) * k)
        this._pitchSmooth += (pitch - this._pitchSmooth) * k
      }

      // Report what is applied.
      this._yaw = this._yawSmooth
      this._pitch = this._pitchSmooth
      this.applier.applyYawPitch(this._yaw, this._pitch)
      this._needsUpdate = false
      return
    }

    // No automatic target: behave like the plain VRMLookAt (yaw / pitch set by hand).
    this._primed = false
    if (this._needsUpdate) {
      this._needsUpdate = false
      this.applier.applyYawPitch(this._yaw, this._pitch)
    }
  }

  override reset(): void {
    super.reset()
    this._primed = false
  }

  override copy(source: VRMLookAt): this {
    super.copy(source)
    if (source instanceof SmoothLookAt) {
      this.smoothTau = source.smoothTau
      Object.assign(this.saccade, source.saccade)
    }
    return this
  }

  private nextSaccadeInterval() {
    const s = this.saccade
    return s.minInterval + (s.maxInterval - s.minInterval) * this.random()
  }

  private advanceSaccade(dt: number) {
    this._saccadeIn -= dt
    if (this._saccadeIn > 0) return
    const s = this.saccade
    const u = this.random()
    const size = s.minDeg + (s.maxDeg - s.minDeg) * u * u // mostly small, now and then larger
    const dir = this.random() * 2 * Math.PI
    this._saccadeYaw = size * Math.cos(dir)
    this._saccadePitch = size * Math.sin(dir)
    this._saccadeIn = this.nextSaccadeInterval()
  }
}

/** Loader plugin that swaps the model's `VRMLookAt` for a `SmoothLookAt` (same applier, same settings). */
export class SmoothLookAtLoaderPlugin extends VRMLookAtLoaderPlugin {
  private readonly smoothOptions: SmoothLookAtOptions

  constructor(parser: GLTFParser, smoothOptions: SmoothLookAtOptions = {}) {
    super(parser)
    this.smoothOptions = smoothOptions
  }

  override get name(): string {
    return 'SmoothLookAtLoaderPlugin'
  }

  override async afterRoot(gltf: GLTF): Promise<void> {
    await super.afterRoot(gltf)
    const humanoid = gltf.userData['vrmHumanoid'] as VRMHumanoid | null | undefined
    const lookAt = gltf.userData['vrmLookAt'] as VRMLookAt | null | undefined
    if (humanoid && lookAt) {
      const smooth = new SmoothLookAt(humanoid, lookAt.applier, this.smoothOptions)
      smooth.copy(lookAt)
      gltf.userData['vrmLookAt'] = smooth
    }
  }
}

/**
 * Create the gaze target as a child of `camera` and point `vrm.lookAt` at it. Returns the target so
 * the caller can remove it again (`target.removeFromParent()`) when the model goes away.
 */
export function attachGazeTarget(vrm: VRM, camera: THREE.Object3D): THREE.Object3D {
  const target = new THREE.Object3D()
  target.name = 'GazeTarget'
  camera.add(target)
  if (vrm.lookAt) vrm.lookAt.target = target
  return target
}
