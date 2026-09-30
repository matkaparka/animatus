/**
 * Procedural motion layer: body, face and gaze.
 *
 * Runs every frame on top of whatever the animation mixer produced. It never involves the LLM.
 *   - Idle: irregular breathing, a weight shift every so often, slow head drift, eyes that glance to
 *     one side and come back, irregular blinking, faint brow drift.
 *   - Speaking: finds the stressed syllables in the audio that is playing and nods or tilts the head
 *     on them, raises or knits the brows, now and then shrugs or beats time with a forearm. The louder
 *     the voice, the further the upper body leans in.
 *   - Emotion changes fade in and out instead of jumping, and blinking carries on during an emotion.
 *
 * Angles are defined for a model facing the camera and are in degrees. To change the amplitude edit
 * `LIVE` (or apply a `tuning.set` snapshot with `applyLiveTuning`).
 *
 * Frame order: mixer.update -> LiveLayer.update -> vrm.update.
 */
import * as THREE from 'three'
import { VRMExpressionMorphTargetBind } from '@pixiv/three-vrm'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import { applyNumericTuning } from './tuning.ts'

export const LIVE = {
  enabled: true,
  bodyScale: 1.0, // overall body amplitude, 0 = no body motion
  faceScale: 1.0, // overall face amplitude, 0 = no face motion

  // breathing
  breathPeriod: [3.4, 5.0] as [number, number], // length of one breath (s), random each time
  breathChest: 0.8, // chest rise and fall (deg)
  breathShoulder: 0.6, // shoulders rise and fall with the breath (deg)

  // weight shift and drift
  swayInterval: [6, 14] as [number, number], // how often the weight shifts (s)
  swayChest: 1.2, // upper body side lean (deg)
  driftHead: [2.5, 1.5, 1.2] as [number, number, number], // slow head drift: yaw / pitch / roll (deg)

  // speaking
  talkLean: 1.8, // the louder the voice, the further the upper body leans forward (deg)
  nodAmp: 3.5, // nod on a stressed syllable (deg)
  tiltAmp: 2.5, // now and then a head tilt or turn replaces the nod (deg)
  shrugAmp: 2.5, // shrug on a strong stress (deg)
  beatForearm: 7, // forearm lifts to beat time on a strong stress (deg)

  // gaze
  glanceInterval: [4, 9] as [number, number], // how often to glance away while silent (s)
  glanceIntervalTalking: [7, 15] as [number, number], // same while talking; mostly looks at the camera
  glanceYaw: [6, 18] as [number, number], // how far to the side a glance goes (deg)
  glancePitch: [-10, 4] as [number, number], // up / down (negative = down, e.g. reading chat)
  headFollow: 0.35, // share of the gaze angle that the head follows

  // face
  baseLid: 0.12, // upper lids rest a little low (half-lidded, looking-down feel), 0 = off
  baseBrowDown: 0.06, // brows rest slightly low
  blinkInterval: [1.6, 5.5] as [number, number], // gap between blinks (s), random each time
  doubleBlink: 0.15, // probability of a double blink
  browAccent: 0.35, // brow raise / knit on a stress
  squintAccent: 0.15, // squint on a stress
  oneBrowChance: 0.15, // probability of raising only one brow
  emotionScale: 1.0, // emotion expression strength
  emotionIn: 0.15, // emotion fade-in time constant (s)
  emotionOut: 0.3, // emotion fade-out time constant (s)

  // calm mode (LiveState.calm = 1, e.g. sleep content): quiet, but visibly alive
  calmBreathSlow: 1.3, // breath length x this (slower)
  calmBreathDepth: 2.0, // breath amplitude x this (deeper, so the chest visibly moves)
  calmMotion: 1.0, // amplitude of weight shift, head drift, glances and the nod at the start of a sentence
  calmNod: 1.6, // slow nod at the start of every sentence (deg)
  calmTilt: 1.4, // now and then a slow head tilt (deg)
  calmLid: 0.3, // resting lid level in calm mode (more relaxed than baseLid)
}

/**
 * Apply a `tuning.set` snapshot to `LIVE`. Only existing numeric constants are assigned; a `[min, max]`
 * pair (or the drift triple) can be set element-wise as `key.0` / `key.1` / `key.2`. Unknown keys and
 * non-finite values are ignored. Returns the keys that were applied.
 */
export function applyLiveTuning(partial: Record<string, number>): string[] {
  return applyNumericTuning(LIVE, partial)
}

const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised']
const FACE = [
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'browInnerUp',
  'browDownLeft',
  'browDownRight',
  'browOuterUpLeft',
  'browOuterUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'noseSneerLeft',
  'noseSneerRight',
]
const ARKIT_BLINK = ['eyeBlinkLeft', 'eyeBlinkRight']
const VRM_BLINK = ['blink']
const NO_BLINK: string[] = []
const BONES: VRMHumanBoneName[] = [
  'spine',
  'chest',
  'neck',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
]

const DEG = Math.PI / 180
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const approach = (x: number, target: number, dt: number, tau: number) =>
  x + (target - x) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)))

type Random = () => number

/** How blinking is driven: the ARKit blend shapes, the VRM preset `blink`, or not at all. */
export type BlinkMode = 'arkit' | 'vrm' | 'none'

/**
 * What the model offers for blinking. `arkit` needs both `eyeBlinkLeft` and `eyeBlinkRight` (as
 * expressions that drive a morph target); `vrm` is the standard VRM preset expression `blink`.
 */
export function detectBlinkSupport(vrm: VRM): { arkit: boolean; vrm: boolean } {
  const em = vrm.expressionManager
  const hasMorph = (name: string) =>
    !!em?.getExpression(name)?.binds.some((b) => b instanceof VRMExpressionMorphTargetBind)
  return {
    arkit: hasMorph('eyeBlinkLeft') && hasMorph('eyeBlinkRight'),
    vrm: (em?.getExpression('blink')?.binds.length ?? 0) > 0,
  }
}

/** Critically damped spring: every target value is approached smoothly and never jumps. */
class Spring {
  x = 0
  v = 0
  readonly freq: number
  constructor(freq: number) {
    this.freq = freq
  }
  step(target: number, dt: number) {
    const w = 2 * Math.PI * this.freq
    const n = Math.max(1, Math.ceil((dt * w) / 0.2))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      const a = w * w * (target - this.x) - 2 * w * this.v
      this.v += a * h
      this.x += this.v * h
    }
    return this.x
  }
}

/** One-off swells (nods, brow raises, ...): a smooth rise-then-fall envelope, and they stack. */
class Pulses {
  private list: { t: number; tau: number; amp: number }[] = []
  add(amp: number, tau: number) {
    this.list.push({ t: 0, tau, amp })
  }
  step(dt: number) {
    let v = 0
    let n = 0
    for (const p of this.list) {
      p.t += dt
      const u = p.t / p.tau
      v += p.amp * u * Math.exp(1 - u)
      if (p.t < p.tau * 6) this.list[n++] = p // drop the finished ones in place (no per-frame garbage)
    }
    this.list.length = n
    return v
  }
}

/** Slow drift that never repeats: a few sines whose frequencies do not divide each other. */
class Drift {
  private f: [number, number, number]
  private p: [number, number, number]
  constructor(random: Random) {
    this.f = [
      0.047 * (0.8 + 0.4 * random()),
      0.083 * (0.8 + 0.4 * random()),
      0.131 * (0.8 + 0.4 * random()),
    ]
    this.p = [random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2]
  }
  value(t: number) {
    return (
      (Math.sin(2 * Math.PI * this.f[0] * t + this.p[0]) +
        0.6 * Math.sin(2 * Math.PI * this.f[1] * t + this.p[1]) +
        0.35 * Math.sin(2 * Math.PI * this.f[2] * t + this.p[2])) /
      1.95
    )
  }
}

/**
 * Extracts loudness, stress and the start / end of a phrase from the speech that is playing.
 * Stress detection: find the loudness peak of each syllable and call it stressed when it is clearly
 * louder than the average of the recent peaks. That way it fires only on real emphasis, whether or not
 * the TTS leaves clean gaps between syllables, instead of nodding on every word.
 */
class Voice {
  level = 0
  talking = false
  private fast = 0
  private prevFast = 0
  private quiet = 0
  private sinceAccent = 10
  private rising = false
  private valley = 0
  private peak = 0
  private meanPeak = -1
  private firstInPhrase = false
  private buf: Float32Array<ArrayBuffer>
  private analyser?: AnalyserNode
  private out = { accent: 0, phraseStart: false, phraseEnd: false }

  constructor(analyser?: AnalyserNode) {
    this.analyser = analyser
    this.buf = new Float32Array(analyser ? analyser.fftSize : 2048)
  }

  update(dt: number, external: number | null) {
    let lv = 0
    if (external != null) {
      lv = clamp(external, 0, 1)
    } else if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.buf)
      let s = 0
      for (let i = 0; i < this.buf.length; i++) s += this.buf[i]! * this.buf[i]!
      const db = 20 * Math.log10(Math.sqrt(s / this.buf.length) + 1e-7)
      lv = clamp((db + 48) / 33, 0, 1) // below -48 dB is silence, -15 dB is full scale
    }
    this.prevFast = this.fast
    this.fast = approach(this.fast, lv, dt, lv > this.fast ? 0.015 : 0.06)
    this.level = approach(this.level, lv, dt, lv > this.level ? 0.05 : 0.25)

    let phraseStart = false
    let phraseEnd = false
    if (this.level > 0.12) {
      this.quiet = 0
      if (!this.talking) {
        this.talking = true
        phraseStart = true
        this.firstInPhrase = true
      }
    } else if (this.talking) {
      this.quiet += dt
      if (this.quiet > 0.4) {
        this.talking = false
        phraseEnd = true
        this.meanPeak = -1
      }
    }

    // Syllable peak: loudness rises then falls; the rise has to be big enough to count as a syllable.
    let accent = 0
    this.sinceAccent += dt
    if (this.fast >= this.prevFast) {
      if (!this.rising) this.valley = this.prevFast
      this.rising = true
      this.peak = this.fast
    } else if (this.rising && this.prevFast - this.fast > 0.004) {
      this.rising = false
      const pk = this.peak
      if (pk > 0.3 && pk - this.valley > 0.05) {
        if (this.meanPeak < 0) this.meanPeak = pk
        const above = pk - this.meanPeak
        if (this.sinceAccent > 0.3 && (above > 0.06 || this.firstInPhrase)) {
          accent = this.firstInPhrase ? 0.6 : clamp(0.35 + above / 0.2, 0.35, 1)
          this.sinceAccent = 0
        }
        this.firstInPhrase = false
        this.meanPeak += (pk - this.meanPeak) * 0.3
      }
    }
    this.out.accent = accent
    this.out.phraseStart = phraseStart
    this.out.phraseEnd = phraseEnd
    return this.out
  }
}

interface BoneSlot {
  node: THREE.Object3D
  base: THREE.Quaternion
  out: THREE.Quaternion
}

export interface LiveState {
  emotion: string
  /** Current weight of the idle base pose. It drops to 0 while a tag motion plays; the body layer steps aside with it. */
  idleWeight: number
  /** 0..1: how much the body layer (head included) steps aside, e.g. while dancing. */
  bodyYield?: number
  /** 0..1: calm mode. Sound still drives the mouth, but no speaking gestures; slower, deeper breathing; a slow nod at the start of a sentence. */
  calm?: number
  /** Amplitude of the small motions while calm (default `LIVE.calmMotion`). */
  calmMotion?: number
  /** Volume (0..1) from another source than the analyser; null = use the analyser. */
  externalVolume: number | null
}

export interface LiveLayerOptions {
  /** Injectable RNG (tests); default `Math.random`. */
  random?: () => number
}

export class LiveLayer {
  /**
   * How this model blinks: `arkit` drives `eyeBlinkLeft` / `eyeBlinkRight`; `vrm` falls back to the VRM
   * preset expression `blink` when either ARKit shape is missing; `none` when the model has neither.
   */
  readonly blinkMode: BlinkMode

  private vrm: VRM
  private camera: THREE.Object3D
  private voice: Voice
  private random: Random
  private flip: boolean
  private disposed = false
  private time: number
  private calm = 0
  private calmMotion = LIVE.calmMotion
  private bones = new Map<VRMHumanBoneName, BoneSlot>()
  private face = new Set<string>()
  private emoW: Record<string, number> = {}
  private emoBinds: Record<string, Map<string, number>> = {}
  private faceKey: Record<string, string> = {}
  private contrib = new Map<string, number>()
  private lidNames: string[]

  // body
  private breathPhase: number
  private breathPeriod: number
  private swayTarget = 0
  private swayTimer: number
  private sway = new Spring(0.35)
  private lean = new Spring(0.8)
  private drift: [Drift, Drift, Drift, Drift]
  private headYaw = new Spring(1.2)
  private headPitch = new Spring(2.2)
  private headRoll = new Spring(1.5)
  private nod = new Pulses()
  private tilt = new Pulses()
  private turn = new Pulses()
  private shrug = new Pulses()
  private chestKick = new Pulses()
  private beatL = new Pulses()
  private beatR = new Pulses()
  private beatSide: boolean
  private armL = new Spring(3)
  private armR = new Spring(3)

  // gaze
  private gazeTarget = new THREE.Vector2()
  private gaze = new THREE.Vector2()
  private glanceTimer: number
  private glanceHold = -1

  // face
  private blinkT = -1
  private blinkTimer: number
  private sinceBlink = 10
  private pendingDouble = false
  private blinkGap = -1
  private browUp = new Pulses()
  private browUpL = new Pulses()
  private browUpR = new Pulses()
  private browDown = new Pulses()
  private squint = new Pulses()
  private sneer = new Pulses()
  private browDrift: Drift

  private _v = new THREE.Vector3()
  private _w = new THREE.Vector3()
  private _q = new THREE.Quaternion()
  private _e = new THREE.Euler()

  /**
   * @param vrm the model
   * @param analyser analyser of the speech that is playing (or undefined: then only `externalVolume` drives the voice)
   * @param lookAtTargetParent the object the gaze target is attached to (normally the camera);
   *   `vrm.lookAt.target` must be a child of it for the gaze to move
   */
  constructor(
    vrm: VRM,
    analyser: AnalyserNode | undefined,
    lookAtTargetParent: THREE.Object3D,
    opts: LiveLayerOptions = {}
  ) {
    this.vrm = vrm
    this.camera = lookAtTargetParent
    this.random = opts.random ?? Math.random
    this.voice = new Voice(analyser)
    // VRM0 models face -Z, which mirrors the x / z components of a local rotation (see setBone).
    this.flip = vrm.meta.metaVersion === '0'

    this.time = this.random() * 100
    this.breathPhase = this.random()
    this.breathPeriod = this.rand(LIVE.breathPeriod)
    this.swayTimer = this.rand(LIVE.swayInterval)
    this.drift = [
      new Drift(this.random),
      new Drift(this.random),
      new Drift(this.random),
      new Drift(this.random),
    ]
    this.beatSide = this.random() < 0.5
    this.glanceTimer = this.rand(LIVE.glanceInterval)
    this.blinkTimer = this.rand(LIVE.blinkInterval)
    this.browDrift = new Drift(this.random)

    for (const name of BONES) {
      const node = vrm.humanoid.getNormalizedBoneNode(name)
      if (node) {
        this.bones.set(name, {
          node,
          base: node.quaternion.clone(),
          out: node.quaternion.clone(),
        })
      }
    }

    const em = vrm.expressionManager
    const keyOf = (b: VRMExpressionMorphTargetBind) => (b.primitives[0]?.uuid ?? '') + ':' + b.index
    const morphBind = (name: string) =>
      em?.getExpression(name)?.binds.find((b) => b instanceof VRMExpressionMorphTargetBind) as
        VRMExpressionMorphTargetBind | undefined
    for (const name of FACE) {
      const bind = morphBind(name)
      if (bind) {
        this.face.add(name)
        this.faceKey[name] = keyOf(bind)
      }
    }
    for (const name of EMOTIONS) {
      this.emoW[name] = 0
      const map = new Map<string, number>()
      for (const b of em?.getExpression(name)?.binds ?? []) {
        if (b instanceof VRMExpressionMorphTargetBind) {
          map.set(keyOf(b), (map.get(keyOf(b)) ?? 0) + b.weight)
        }
      }
      this.emoBinds[name] = map
    }

    // Blink fallback: a model without the ARKit blink shapes still has to blink. Drive the VRM preset
    // `blink` with the same curve. (The legacy layer only knew the ARKit shapes, so such a model never
    // blinked at all.)
    const support = detectBlinkSupport(vrm)
    this.blinkMode = support.arkit ? 'arkit' : support.vrm ? 'vrm' : 'none'
    this.lidNames =
      this.blinkMode === 'arkit' ? ARKIT_BLINK : this.blinkMode === 'vrm' ? VRM_BLINK : NO_BLINK
    if (this.blinkMode === 'vrm') {
      const bind = morphBind('blink')
      if (bind) this.faceKey['blink'] = keyOf(bind)
    }
  }

  /** Advance the layer by `delta` seconds. Call after `mixer.update` and before `vrm.update`. */
  public update(delta: number, state: LiveState) {
    if (!LIVE.enabled || this.disposed) return
    const dt = Number.isFinite(delta) ? clamp(delta, 0, 0.1) : 0
    this.time += dt
    const v = this.voice.update(dt, state.externalVolume)
    // In calm mode the audio still feeds the lip-sync analyser but does not count as "speaking":
    // no nods, brow raises, shrugs, beats or forward lean, and blinks / glances do not follow sentences.
    this.calm = clamp(state.calm ?? 0, 0, 1)
    this.calmMotion = clamp(state.calmMotion ?? LIVE.calmMotion, 0, 2)
    const quiet = this.calm > 0.5
    if (quiet && v.phraseStart) this.onCalmPhrase()
    const accent = quiet ? 0 : v.accent
    const phraseStart = quiet ? false : v.phraseStart
    const phraseEnd = quiet ? false : v.phraseEnd
    const talking = this.voice.talking && !quiet
    const emotion = state.emotion

    if (accent > 0) this.onAccent(accent, emotion)
    this.updateGaze(dt, talking, phraseStart, phraseEnd)
    this.updateBody(dt, clamp(state.idleWeight, 0, 1), talking, clamp(state.bodyYield ?? 0, 0, 1))
    this.updateFace(dt, emotion, talking, phraseStart || phraseEnd)
  }

  /**
   * Stop driving the model: hand the bones back and zero every expression this layer wrote. The layer
   * ignores further `update` calls. Call before the model is disposed.
   */
  public dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const slot of this.bones.values()) {
      if (slot.node.quaternion.equals(slot.out)) slot.node.quaternion.copy(slot.base)
    }
    const em = this.vrm.expressionManager
    if (!em) return
    for (const name of [...EMOTIONS, ...this.face, ...this.lidNames]) em.setValue(name, 0)
  }

  private rand(r: readonly [number, number]) {
    return r[0] + this.random() * (r[1] - r[0])
  }

  private pick<T>(a: readonly T[]): T {
    return a[Math.floor(this.random() * a.length)] as T
  }

  // ---------------------------------------------------------------- stress
  private onAccent(s: number, emotion: string) {
    const r = this.random()
    if (r < 0.62) this.nod.add(LIVE.nodAmp * s, this.rand([0.12, 0.18]))
    else if (r < 0.82) this.tilt.add(this.pick([-1, 1]) * LIVE.tiltAmp * s, 0.25)
    else this.turn.add(this.pick([-1, 1]) * LIVE.tiltAmp * s, 0.3)
    this.chestKick.add(0.6 * s, 0.2)

    if (s > 0.75 && this.random() < 0.3) this.shrug.add(LIVE.shrugAmp * s, 0.22)
    if (s > 0.6 && this.random() < 0.45) {
      const both = this.random() < 0.2
      this.beatSide = !this.beatSide
      if (both || this.beatSide) this.beatL.add(s, this.rand([0.18, 0.24]))
      if (both || !this.beatSide) this.beatR.add(s, this.rand([0.18, 0.24]))
    }

    const a = LIVE.browAccent * s
    if (emotion === 'angry') {
      this.browDown.add(a, 0.2)
      this.squint.add(LIVE.squintAccent * 1.5 * s, 0.25)
      if (this.random() < 0.4) this.sneer.add(0.25 * s, 0.25)
    } else if (emotion === 'sad') {
      this.browUp.add(a * 0.8, 0.25)
    } else if (this.random() < LIVE.oneBrowChance) {
      ;(this.random() < 0.5 ? this.browUpL : this.browUpR).add(a * 1.3, 0.3)
    } else {
      this.browUp.add(a, 0.2)
      this.squint.add(LIVE.squintAccent * s, 0.2)
    }
  }

  /** Calm mode: one slow nod (sometimes a slow tilt) at the start of each sentence instead of the fast, dense stress motions. */
  private onCalmPhrase() {
    const k = this.calmMotion
    if (this.random() < 0.7) {
      this.nod.add(LIVE.calmNod * k * this.rand([0.7, 1]), this.rand([0.6, 0.9]))
    } else {
      this.tilt.add(this.pick([-1, 1]) * LIVE.calmTilt * k, this.rand([0.8, 1.2]))
    }
  }

  // ---------------------------------------------------------------- gaze
  private startGlance(hold: readonly [number, number]) {
    const m = this.calmScale()
    const yaw = this.pick([-1, 1]) * this.rand(LIVE.glanceYaw) * m
    const pitch = this.rand(LIVE.glancePitch) * m
    this.gazeTarget.set(yaw, pitch)
    this.glanceHold = this.rand(hold)
    if (Math.abs(yaw) > 10 && this.random() < 0.5) this.triggerBlink()
    // While silent, now and then raise one brow during a glance: a slightly appraising look (not in calm mode).
    if (this.calm < 0.5 && this.random() < 0.2) {
      ;(yaw > 0 ? this.browUpL : this.browUpR).add(LIVE.browAccent, 0.5)
      this.squint.add(LIVE.squintAccent, 0.5)
    }
  }

  private updateGaze(dt: number, talking: boolean, phraseStart: boolean, phraseEnd: boolean) {
    if (this.glanceHold >= 0) {
      this.glanceHold -= dt
      if (this.glanceHold < 0) {
        this.gazeTarget.set(0, 0)
        this.glanceTimer = this.rand(talking ? LIVE.glanceIntervalTalking : LIVE.glanceInterval)
      }
    } else {
      this.glanceTimer -= dt
      if (phraseStart && this.random() < 0.3) this.startGlance([0.35, 0.8])
      else if (phraseEnd && this.random() < 0.3) this.startGlance([0.6, 1.4])
      else if (this.glanceTimer <= 0) this.startGlance(talking ? [0.4, 0.9] : [0.6, 1.8])
    }
    // The eyes jump fast, like a real saccade.
    this.gaze.x = approach(this.gaze.x, this.gazeTarget.x, dt, 0.035)
    this.gaze.y = approach(this.gaze.y, this.gazeTarget.y, dt, 0.035)

    const target = this.vrm.lookAt?.target
    const head = this.vrm.humanoid.getNormalizedBoneNode('head')
    if (target && head && target.parent === this.camera) {
      const dist = Math.max(
        0.5,
        head.getWorldPosition(this._v).distanceTo(this.camera.getWorldPosition(this._w))
      )
      target.position.set(dist * Math.tan(this.gaze.x * DEG), dist * Math.tan(this.gaze.y * DEG), 0)
    }
  }

  // ---------------------------------------------------------------- body
  private updateBody(dt: number, idleW: number, talking: boolean, bodyYield = 0) {
    const S = LIVE.bodyScale * (1 - bodyYield)
    const torsoW = S * (0.5 + 0.5 * idleW)
    const armW = S * idleW
    const t = this.time

    // Breathing: quick in, slow out, and every breath has its own length. The floor keeps a bad tuning
    // value (period <= 0) from turning the phase into Infinity / NaN and the bones into NaN with it.
    this.breathPhase += dt / Math.max(this.breathPeriod, 0.2)
    if (this.breathPhase >= 1) {
      this.breathPhase -= 1
      this.breathPeriod =
        this.rand(LIVE.breathPeriod) *
        (talking ? 0.8 : 1) *
        (1 + (LIVE.calmBreathSlow - 1) * this.calm)
    }
    const ph = this.breathPhase
    const warped = ph < 0.4 ? (ph / 0.4) * 0.5 : 0.5 + ((ph - 0.4) / 0.6) * 0.5
    const breath =
      (0.5 - 0.5 * Math.cos(warped * 2 * Math.PI)) *
      (talking ? 0.6 : 1) *
      (1 + (LIVE.calmBreathDepth - 1) * this.calm) // deeper breathing in calm mode

    // Weight shift: every so often move to the other side, slowly, and stay there.
    this.swayTimer -= dt
    if (this.swayTimer <= 0) {
      this.swayTimer = this.rand(LIVE.swayInterval)
      const side = this.swayTarget > 0 ? -1 : 1
      this.swayTarget = this.random() < 0.8 ? side * this.rand([0.4, 1]) : this.rand([-0.3, 0.3])
    }
    const m = this.calmScale()
    const sway = this.sway.step(this.swayTarget, dt) * m
    const lean = this.lean.step(talking ? this.voice.level : 0, dt)
    const kick = this.chestKick.step(dt)

    this.setBone('spine', breath * 0.3 * LIVE.breathChest, 0, -sway * 0.4 * LIVE.swayChest, torsoW)
    this.setBone(
      'chest',
      breath * LIVE.breathChest + lean * LIVE.talkLean + kick,
      this.drift[3].value(t) * 1.0 * m + this.gaze.x * 0.08,
      sway * LIVE.swayChest,
      torsoW
    )

    // Head: slow drift + following the gaze + nod / tilt / turn on stresses.
    const dh = LIVE.driftHead
    const yaw = this.headYaw.step(
      this.drift[0].value(t) * dh[0] * m + this.gaze.x * LIVE.headFollow + this.turn.step(dt),
      dt
    )
    const pitch = this.headPitch.step(
      this.drift[1].value(t) * dh[1] * m - this.gaze.y * LIVE.headFollow + this.nod.step(dt),
      dt
    )
    const roll = this.headRoll.step(
      this.drift[2].value(t) * dh[2] * m + this.tilt.step(dt) - sway * 0.5,
      dt
    )
    const headW = S * (0.5 + 0.5 * idleW)
    this.setBone('neck', pitch * 0.4, yaw * 0.4, roll * 0.4, headW)
    this.setBone('head', pitch * 0.6, yaw * 0.6, roll * 0.6, headW)

    // Shoulders: a slight lift with the breath + a shrug on strong stresses.
    const sh = breath * LIVE.breathShoulder + this.shrug.step(dt)
    this.setBone('leftShoulder', 0, 0, sh, torsoW)
    this.setBone('rightShoulder', 0, 0, -sh, torsoW)

    // Arms: only ever move away from the body (forearm lifts, upper arm swings slightly forward and
    // out), never into it.
    const bl = this.armL.step(this.beatL.step(dt), dt)
    const br = this.armR.step(this.beatR.step(dt), dt)
    const fa = LIVE.beatForearm
    this.setBone('leftUpperArm', -bl * fa * 0.3, 0, bl * fa * 0.25, armW)
    this.setBone('rightUpperArm', -br * fa * 0.3, 0, -br * fa * 0.25, armW)
    this.setBone('leftLowerArm', 0, -bl * fa, 0, armW)
    this.setBone('rightLowerArm', 0, br * fa, 0, armW)
  }

  /** Amplitude factor of the small motions; equals `calmMotion` when calm = 1. */
  private calmScale() {
    return 1 - (1 - this.calmMotion) * this.calm
  }

  /** Layer a small rotation on top of the pose the animation produced (x pitch, y yaw, z roll; degrees). */
  private setBone(name: VRMHumanBoneName, x: number, y: number, z: number, w: number) {
    const slot = this.bones.get(name)
    if (!slot) return
    const q = slot.node.quaternion
    // If the animation did not write this bone this frame, take last frame's offset off first so the
    // offsets do not pile up.
    if (q.equals(slot.out)) q.copy(slot.base)
    slot.base.copy(q)
    this._e.set(x * w * DEG, y * w * DEG, z * w * DEG, 'YXZ')
    this._q.setFromEuler(this._e)
    if (this.flip) {
      this._q.x = -this._q.x
      this._q.z = -this._q.z
    }
    q.premultiply(this._q)
    slot.out.copy(q)
  }

  // ---------------------------------------------------------------- face
  private triggerBlink() {
    if (this.blinkT < 0 && this.blinkGap < 0 && this.sinceBlink > 0.5) {
      this.blinkT = 0
      this.pendingDouble = this.random() < LIVE.doubleBlink
    }
  }

  /** Blink curve: 70 ms closing, 30 ms held, 140 ms opening; now and then a second blink 80 ms later. */
  private blinkValue(dt: number) {
    this.sinceBlink += dt
    if (this.blinkGap >= 0) {
      this.blinkGap -= dt
      if (this.blinkGap < 0) this.blinkT = 0
    } else if (this.blinkT < 0) {
      this.blinkTimer -= dt
      if (this.blinkTimer <= 0) {
        this.blinkTimer = this.rand(LIVE.blinkInterval)
        this.triggerBlink()
      }
    }
    if (this.blinkT < 0) return 0

    this.blinkT += dt
    const close = 0.07
    const hold = 0.03
    const open = 0.14
    const t = this.blinkT
    if (t < close) return (t / close) * (t / close)
    if (t < close + hold) return 1
    if (t < close + hold + open) {
      const u = (t - close - hold) / open
      return 1 - u * (2 - u)
    }
    this.blinkT = -1
    this.sinceBlink = 0
    if (this.pendingDouble) {
      this.pendingDouble = false
      this.blinkGap = 0.08
    }
    return 0
  }

  private updateFace(dt: number, emotion: string, talking: boolean, boundary: boolean) {
    const em = this.vrm.expressionManager
    if (!em) return

    // Emotion expressions fade in and out. `contrib` collects how much the emotions already drive each
    // morph target, so the procedural face values below can be reduced by that amount.
    const contrib = this.contrib
    contrib.clear()
    for (const name of EMOTIONS) {
      const want = name === emotion ? LIVE.emotionScale : 0
      const w0 = this.emoW[name] ?? 0
      const tau = want > w0 ? LIVE.emotionIn : LIVE.emotionOut
      const w = approach(w0, want, dt, tau)
      this.emoW[name] = w
      if (em.getExpression(name)) em.setValue(name, w)
      const binds = this.emoBinds[name]
      if (binds) for (const [k, bw] of binds) contrib.set(k, (contrib.get(k) ?? 0) + bw * w)
    }
    const E = (name: string) => contrib.get(this.faceKey[name] ?? '') ?? 0

    if (boundary && this.random() < 0.5) this.triggerBlink()
    const blink = this.blinkValue(dt)

    const F = LIVE.faceScale
    const surprised = (this.emoW['surprised'] ?? 0) > 0.3
    const set = (name: string, v: number) => {
      if (!this.face.has(name)) return
      const e = E(name)
      em.setValue(name, clamp(v * F * (1 - e), 0, Math.max(0, 1 - e)))
    }

    // Eyelids: resting droop + blink, merged with whatever eye closure the emotion expressions already
    // contain, so a blink can close the eyes fully without overshooting. The ARKit shapes and the VRM
    // preset `blink` (fallback) follow exactly the same curve.
    const lid = LIVE.baseLid + (LIVE.calmLid - LIVE.baseLid) * this.calm
    for (const name of this.lidNames) {
      const e = E(name)
      const base = Math.max(e, surprised ? 0 : lid * F)
      const want = base + (1 - base) * blink
      em.setValue(name, clamp(want - e, 0, 1))
    }

    const up = this.browUp.step(dt)
    const upL = this.browUpL.step(dt)
    const upR = this.browUpR.step(dt)
    const down = this.browDown.step(dt)
    const sq = this.squint.step(dt)
    const sn = this.sneer.step(dt)
    const drift = this.browDrift.value(this.time) * (talking ? 0.04 : 0.06)
    const baseDown = surprised ? 0 : LIVE.baseBrowDown

    set('browInnerUp', up + Math.max(0, drift))
    set('browOuterUpLeft', up * 0.7 + upL + Math.max(0, drift) * 0.5)
    set('browOuterUpRight', up * 0.7 + upR + Math.max(0, drift) * 0.5)
    set('browDownLeft', baseDown + down + Math.max(0, -drift))
    set('browDownRight', baseDown + down + Math.max(0, -drift))
    set('eyeSquintLeft', sq)
    set('eyeSquintRight', sq)
    set('noseSneerLeft', sn)
    set('noseSneerRight', sn * 0.85)
  }
}
