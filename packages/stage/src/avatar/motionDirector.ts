/**
 * Body motion scheduler: idle base pose, talk clips rotated while speaking, one-shot tag motions and
 * dances, all played through one `THREE.AnimationMixer`.
 *
 * Weights are computed here by hand every frame; three.js `fadeIn` / `fadeOut` are not used. When the
 * weights of the actions animating a bone sum to less than 1, AnimationMixer blends the missing share
 * into the bind pose (a T-pose). The body then jumps for a frame at every switch and the spring bones
 * (hair, tails, ...) get flung. So every frame the weights of all managed actions are normalised to
 * sum to exactly `1 - external`.
 *
 * Note that this only holds for bones every managed clip animates: a bone that exists in one clip but
 * not in another still drifts towards the bind pose while the clip without it has weight. Clips built
 * with `createClip` from one motion library normally cover the same bones.
 *
 * No I/O in here: the caller turns animations into `THREE.AnimationClip`s and hands them over.
 */
import * as THREE from 'three'
import { applyNumericTuning } from './tuning.ts'

export const MOTION = {
  talkFade: 0.4, // cross-fade between talk clips, and between talk and idle (s)
  oneShotFade: 0.4,
  externalFade: 0.5, // hand-over to / from an external static pose (s)
  release: 0.2, // how long the sound may be gone before it no longer counts as speaking; + talkFade ~ 0.6 s back to idle
  resumeWindow: 3, // if speech resumes within this many seconds, carry on with the same talk clip
  minRemain: 1.5, // a random start point leaves at least this much of the clip; a clip with less left is not continued
  speed: [0.9, 1.1] as [number, number], // playback speed of a talk clip, random each time
  idleFade: 1.5, // cross-fade between idle poses (s)
  baseFade: 0.35, // from a non-default idle pose (arms crossed, ...) back to the base pose before speaking / a tag motion (s)
  idleSwitch: [180, 360] as [number, number], // how often idle poses rotate (s)

  // dance
  danceCooldown: 180, // minimum gap between two dances (s), counted from the end of the previous one
  danceFadeIn: 1.0, // fade from idle to frame 0 of the dance (s)
  danceFadeOut: 1.5, // the last seconds of the dance fade back to the base pose (s)
  danceRootClamp: 0.35, // horizontal travel limit of the hips (m); the excess is pressed back softly
  danceRootScale: 1.0, // horizontal hips travel is multiplied by this before the limit is applied
  danceSpringDrag: 0.5, // spring bone drag while dancing: dragForce moves this far towards 1 (0 = unchanged)
  danceSpringStiffness: 1.5, // spring bone stiffness multiplier while dancing
  dancePendingTimeout: 90, // give up waiting for the current speech to finish after this long (s)
}

/**
 * Apply a `tuning.set` snapshot to `MOTION`. Only existing numeric constants are assigned; the
 * `speed` and `idleSwitch` pairs can be set element-wise as `speed.0` / `speed.1`. Unknown keys and
 * non-finite values are ignored. Returns the keys that were applied.
 */
export function applyMotionTuning(partial: Record<string, number>): string[] {
  return applyNumericTuning(MOTION, partial)
}

type Kind = 'idle' | 'talk' | 'oneshot' | 'dance'

interface Entry {
  kind: Kind
  action: THREE.AnimationAction
  w: number
  target: number
  fade: number
  /** How long the weight has been 0 (for talk: decides whether it can still be resumed). */
  idleAge: number
  /** A talk clip generated live for this utterance. */
  live?: boolean
  /** Name for logs and `debugState` (the library name of a talk clip); the clip's own name if unset. */
  name?: string
}

export interface TalkClip {
  name: string
  clip: THREE.AnimationClip
  /** Shared by an original and its mirror so the shuffle bag never plays them back to back. */
  base: number
}

export interface IdleSource {
  id: string
  /** Load (or return the cached) clip. Called lazily, the first time the pose is switched to. */
  getClip(): Promise<THREE.AnimationClip | null>
}

export interface MotionDirectorOptions {
  /** Injectable RNG (tests); default `Math.random`. */
  random?: () => number
  /** Injectable clock in milliseconds (tests); default `performance.now`. */
  now?: () => number
}

/** What `debugState()` reports for one managed action. */
export interface DirectorEntryInfo {
  kind: Kind
  /** Library name of a talk clip, otherwise the clip's own name. */
  clip: string
  /** Weight before normalisation. */
  w: number
  target: number
  action: THREE.AnimationAction
}

/** Id of the base idle pose (the first action given to `setIdle`) in the rotation; cannot clash with a ClipRef id. */
const DEFAULT_IDLE_ID = '<default>'

export class MotionDirector {
  private entries: Entry[] = []
  private idle: Entry | null = null
  private talk: Entry | null = null
  private oneShot: Entry | null = null
  private oneShotDone?: () => void
  private dance: Entry | null = null
  private danceFadeIn = MOTION.danceFadeIn
  private external = 0
  private externalTarget = 0
  private silentFor = Infinity
  private clips: TalkClip[] = []
  private talkClipSet = new Set<THREE.AnimationClip>()
  private bag: number[] = []
  private lastBase = -1
  private idleSources: IdleSource[] = []
  private idleClips = new Map<string, THREE.AnimationClip>()
  private idleId: string | null = DEFAULT_IDLE_ID
  private idleTimer: number
  private idleSwitching = false
  private defaultIdleAction?: THREE.AnimationAction
  /** The next utterance (about to start sounding): its live clip, or null = rotate the talk clips. */
  private pendingUtterance: { clip: THREE.AnimationClip | null; at: number } | null = null
  private disposed = false
  private readonly random: () => number
  private readonly now: () => number
  private readonly applied = new Map<THREE.AnimationAction, number>()
  private _idleWeight = 1
  private _danceWeight = 0

  private readonly mixer: THREE.AnimationMixer

  /** While true the pose does not count as idle (so idle poses do not rotate), e.g. while singing or in calm mode. */
  holdIdle = false

  constructor(mixer: THREE.AnimationMixer, opts: MotionDirectorOptions = {}) {
    this.mixer = mixer
    this.random = opts.random ?? Math.random
    this.now = opts.now ?? (() => performance.now())
    this.idleTimer = this.rand(MOTION.idleSwitch[0], MOTION.idleSwitch[1])
  }

  // ------------------------------------------------------------ library
  /**
   * Replace the talk clips. The caller supplies the originals and their mirrored copies; `base` is
   * shared by an original and its mirror.
   */
  setTalkClips(clips: readonly TalkClip[]) {
    this.clips = clips.filter((c) => c.clip.duration > 0)
    this.talkClipSet = new Set(this.clips.map((c) => c.clip))
    this.bag = []
  }

  /**
   * The idle variants that `switchIdle` (and the automatic rotation) can pick from, next to the base
   * pose. Clips are fetched lazily and cached by id, so ids must be stable for the same content.
   */
  setIdleSources(sources: readonly IdleSource[]) {
    const ids = new Set<string>([DEFAULT_IDLE_ID])
    const unique: IdleSource[] = []
    for (const s of sources) {
      if (ids.has(s.id)) continue
      ids.add(s.id)
      unique.push(s)
    }
    this.idleSources = unique
    for (const id of [...this.idleClips.keys()]) {
      if (!ids.has(id)) this.idleClips.delete(id)
    }
  }

  /** Switch to another idle pose right now (still only when truly idle). Returns whether it switched. */
  async switchIdle(): Promise<boolean> {
    const ids = [DEFAULT_IDLE_ID, ...this.idleSources.map((s) => s.id)]
    const candidates = ids.filter((id) => id !== this.idleId)
    if (candidates.length === 0 || this.idleSwitching || this.disposed) return false
    const id = candidates[this.randInt(candidates.length)]!
    this.idleSwitching = true
    try {
      let action: THREE.AnimationAction | undefined
      if (id === DEFAULT_IDLE_ID) {
        action = this.defaultIdleAction
      } else {
        let clip = this.idleClips.get(id)
        if (!clip) {
          const loaded = await this.idleSources.find((s) => s.id === id)?.getClip()
          if (!loaded) return false
          clip = loaded
          this.idleClips.set(id, clip)
        }
        action = this.mixer.clipAction(clip)
      }
      if (!action || this.disposed) return false
      if (!this.isIdle) return false // speech started while the clip was loading: try again next time
      this.setIdle(action, MOTION.idleFade)
      this.idleId = id
      return true
    } catch (e) {
      console.warn(`[stage] failed to switch to idle pose "${id}"`, e)
      return false
    } finally {
      this.idleSwitching = false
    }
  }

  /** Back to the default base pose (for example when entering calm mode); does nothing if already there. */
  resetIdle(fade = MOTION.idleFade) {
    if (this.defaultIdleAction && this.idle?.action !== this.defaultIdleAction) {
      this.setIdle(this.defaultIdleAction, fade)
      this.idleId = DEFAULT_IDLE_ID
    }
  }

  /** An idle pose set from outside (drag and drop, ...): it is not part of the rotation. */
  markExternalIdle() {
    this.idleId = null
  }

  // ------------------------------------------------------------ idle
  /** Change the idle action. `fade` = 0 switches at once (the first time). The first action ever set is the default idle. */
  setIdle(action: THREE.AnimationAction, fade = 0) {
    if (this.idle?.action === action) return
    if (!this.defaultIdleAction) this.defaultIdleAction = action
    // `fade` sets the speed of both the old idle fading out and the new one fading in: with equal
    // rates the weights keep summing to 1.
    const f = fade > 0 ? fade : MOTION.talkFade
    if (this.idle) {
      this.idle.target = 0
      this.idle.fade = f
      if (fade <= 0) this.idle.w = 0
    }
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.enabled = true
    action.play()
    const e = this.add('idle', action, f)
    if (fade <= 0 || this.entries.length === 1) e.w = 1
    this.idle = e
  }

  get idleAction(): THREE.AnimationAction | undefined {
    return this.idle?.action
  }

  /** Actual weight of the idle base pose (the procedural layer's body part steps aside by it). */
  get idleWeight(): number {
    return this._idleWeight
  }

  /** Truly idle: not speaking, no one-shot, no dance, no external pose, and no transition running. */
  get isIdle(): boolean {
    return (
      !this.holdIdle &&
      !this.oneShot &&
      !this.dance &&
      this.externalTarget === 0 &&
      this.silentFor > MOTION.release &&
      this.entries.every((e) => e === this.idle || (e.w === 0 && e.target === 0))
    )
  }

  // ------------------------------------------------------------ tag motions
  playOneShot(action: THREE.AnimationAction, onDone?: () => void) {
    if (this.oneShot && this.oneShot.action !== action) this.oneShot.target = 0
    this.oneShotDone?.()
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.reset()
    action.play()
    const existing = this.entries.find((e) => e.action === action)
    const e = existing ?? this.add('oneshot', action, MOTION.oneShotFade)
    e.target = 1
    this.oneShot = e
    this.oneShotDone = onDone
  }

  /** Fade out the tag motion at once (stop button); calls its `onDone`. */
  stopOneShot() {
    if (!this.oneShot) return
    this.oneShot.target = 0
    this.oneShot = null
    const done = this.oneShotDone
    this.oneShotDone = undefined
    done?.()
  }

  get oneShotActive(): boolean {
    return this.oneShot !== null
  }

  // ------------------------------------------------------------ dance
  /**
   * The time of a dance action is set by the caller every frame from the audio clock (`action.time`);
   * the director only handles the weights: first back to the base pose, then a fade-in of `fadeIn`
   * seconds. Talk rotation, idle rotation and tag motions step aside meanwhile.
   */
  playDance(action: THREE.AnimationAction, fadeIn: number) {
    this.stopOneShot()
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.reset()
    action.paused = true
    action.time = 0
    action.play()
    this.danceFadeIn = Math.max(fadeIn, 0.01)
    const e = this.add('dance', action, this.danceFadeIn)
    e.target = 0 // raised by setTargets('dance') once the body is back at the base pose
    this.dance = e
  }

  /** The dance fades out while the default base pose fades in (same rate, so the weights keep summing to 1). */
  stopDance(fadeOut: number) {
    if (!this.dance) return
    const f = Math.max(fadeOut, 0.01)
    for (const e of this.entries) {
      e.target = e === this.idle ? 1 : 0
      e.fade = f
    }
    this.dance = null
  }

  get danceActive(): boolean {
    return this.dance !== null
  }

  /** Actual weight of the dance (fade-out included); the procedural layer's body part steps aside by it. */
  get danceWeight(): number {
    return this._danceWeight
  }

  // ------------------------------------------------------------ live-generated motion
  /**
   * Call before each utterance starts sounding. `clip` is a motion generated for this utterance (it
   * starts from its first frame, in sync with the speech); `null` means this utterance uses the
   * rotating talk clips (the live service was late, or this sentence is not generated).
   */
  beginUtterance(clip: THREE.AnimationClip | null) {
    this.pendingUtterance = { clip, at: this.now() }
  }

  /** At the start of speech: process the motion that `beginUtterance` queued. */
  private applyPendingUtterance(frameDelta: number) {
    const p = this.pendingUtterance
    if (!p) return
    this.pendingUtterance = null
    if (p.clip) {
      const action = this.mixer.clipAction(p.clip)
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
      action.reset()
      action.timeScale = 1
      // Time that passed between queueing and the speech really starting (audio decoding, ...) is made
      // up for, to stay in sync with the voice. `mixer.update(delta)` advances this frame's delta again
      // later, so it is subtracted first; otherwise a hitching frame would be counted twice.
      const elapsed = (this.now() - p.at) / 1000
      action.time = Math.min(Math.max(0, elapsed - frameDelta), Math.max(0, p.clip.duration - 0.05))
      action.play()
      if (this.talk) {
        this.talk.target = 0
        this.talk.fade = MOTION.talkFade
      }
      this.talk = this.add('talk', action, MOTION.talkFade)
      this.talk.live = true
      this.talk.name = p.clip.name || 'live'
    } else if (this.talk?.live) {
      // The previous sentence was live-generated; this one goes back to rotating clips.
      this.talk.target = 0
      this.talk.fade = MOTION.talkFade
      this.talk = this.startTalk()
    }
  }

  // ------------------------------------------------------------ external static pose
  /** Call with true while an external static pose takes over the body, false when it is released. */
  setExternal(on: boolean) {
    this.externalTarget = on ? 1 : 0
  }

  // ------------------------------------------------------------ per frame
  /** Call once per frame before `mixer.update(delta)`. `audioPlaying`: speech (or vocals) is sounding. */
  update(delta: number, audioPlaying: boolean) {
    if (this.disposed) return
    const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), 0.1) : 0
    this.silentFor = audioPlaying ? 0 : this.silentFor + dt

    // Idle pose rotation: when the timer is up, wait for truly idle, then switch.
    if (this.idleSources.length > 0) {
      this.idleTimer -= dt
      if (this.idleTimer <= 0 && this.isIdle && !this.idleSwitching) {
        this.idleTimer = this.rand(MOTION.idleSwitch[0], MOTION.idleSwitch[1])
        void this.switchIdle()
      }
    }
    // No talk rotation while dancing (the caller holds speech during a dance anyway; belt and braces).
    // Talk needs something to play: library clips, or a live clip that is queued / already running.
    const canTalk =
      this.clips.length > 0 ||
      this.pendingUtterance?.clip != null ||
      (this.talk?.live === true && this.talk.target > 0)
    const wantTalk = !this.dance && this.silentFor < MOTION.release && canTalk

    // Blending a non-default idle pose (arms crossed, ...) directly with speech or a tag motion can pass
    // a forearm through the torso half way (measured: 15 cm on one model). So go back to the base pose
    // first, then start.
    const busy = !!this.oneShot || wantTalk || !!this.dance
    if (busy && this.defaultIdleAction && this.idle?.action !== this.defaultIdleAction) {
      this.setIdle(this.defaultIdleAction, MOTION.baseFade)
      this.idleId = DEFAULT_IDLE_ID
    }
    const settling =
      busy && this.entries.some((e) => e.kind === 'idle' && e !== this.idle && e.w > 0)
    if (this.oneShot) this.oneShot.action.paused = settling // the tag motion waits on its first frame while returning to the base pose

    // The tag motion is nearly over: start fading it out and hand back to talk / idle.
    if (!settling && this.oneShot && this.remaining(this.oneShot) <= MOTION.oneShotFade) {
      this.oneShot.target = 0
      this.oneShot = null
      const done = this.oneShotDone
      this.oneShotDone = undefined
      done?.()
    }

    if (settling) {
      this.setTargets('idle')
    } else if (this.dance) {
      this.setTargets('dance', this.danceFadeIn)
    } else if (this.oneShot) {
      this.setTargets('oneshot')
    } else if (wantTalk) {
      this.applyPendingUtterance(Number.isFinite(delta) ? Math.max(delta, 0) : 0)
      this.ensureTalk(audioPlaying)
      this.setTargets('talk')
    } else {
      this.setTargets('idle')
    }

    // The talk clip is almost over and speech goes on: cross-fade into the next one.
    // (A live-generated clip ends together with its sentence: if the voice stopped too, it stays on its
    // last frame until idle takes over, and the next sentence brings its own clip. Only when the voice
    // goes on past the end of the clip is another one added.)
    if (
      wantTalk &&
      !settling &&
      !this.oneShot &&
      this.talk &&
      (this.talk.live
        ? audioPlaying && this.remaining(this.talk) <= 0.02
        : this.remaining(this.talk) <= MOTION.talkFade)
    ) {
      this.talk.target = 0
      this.talk.fade = MOTION.talkFade
      this.talk = this.startTalk()
      if (this.talk) this.talk.target = 1
    }

    const ef = Math.max(MOTION.externalFade, 1e-3)
    this.external +=
      Math.sign(this.externalTarget - this.external) *
      Math.min(Math.abs(this.externalTarget - this.external), dt / ef)
    this.external = Math.min(1, Math.max(0, this.external))

    // Every entry walks towards its target at its own fade speed.
    for (const e of this.entries) {
      const step = e.fade > 0 ? dt / e.fade : 1
      if (e.w < e.target) e.w = Math.min(e.target, e.w + step)
      else if (e.w > e.target) e.w = Math.max(e.target, e.w - step)
      e.idleAge = e.w === 0 && e.target === 0 ? e.idleAge + dt : 0
      // A talk clip that has fully faded out pauses where it is, so when speech resumes it carries on
      // from there instead of restarting.
      if (e.kind === 'talk') e.action.paused = e.w === 0 && e.target === 0
    }

    // Cleanup: actions whose weight is 0 and that will not be needed again are stopped.
    const kept: Entry[] = []
    const dropped: Entry[] = []
    for (const e of this.entries) {
      const keep =
        e.w > 0 ||
        e.target > 0 ||
        e === this.idle ||
        e === this.oneShot || // while returning to the base pose the tag motion has weight 0 but is still queued
        e === this.dance ||
        (e.kind === 'talk' && e.idleAge < MOTION.resumeWindow)
      ;(keep ? kept : dropped).push(e)
    }
    this.entries = kept
    for (const e of dropped) {
      if (e === this.talk) this.talk = null
      // Another entry may still drive the very same action (for example an idle pose that was switched
      // away from and back within its fade): then the action must keep running.
      if (kept.some((k) => k.action === e.action)) continue
      this.release(e)
    }

    // Normalise: everything the director manages sums to 1 - external. If several entries share one
    // action, its weight is the sum of their shares, so the total stays exact.
    let sum = 0
    for (const e of this.entries) sum += e.w
    const share = 1 - this.external
    let idleW = 0
    let danceW = 0
    this.applied.clear()
    for (const e of this.entries) {
      const w = sum > 1e-4 ? (e.w / sum) * share : e === this.idle ? share : 0
      this.applied.set(e.action, (this.applied.get(e.action) ?? 0) + w)
      if (e.kind === 'idle') idleW += w
      if (e.kind === 'dance') danceW += w
    }
    for (const [action, w] of this.applied) {
      action.enabled = true
      action.setEffectiveWeight(w)
    }
    this._idleWeight = idleW
    this._danceWeight = danceW
  }

  /** Stop everything the director started. The mixer itself belongs to the caller. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    const done = this.oneShotDone
    this.oneShotDone = undefined
    const entries = this.entries
    this.entries = []
    this.idle = this.talk = this.oneShot = this.dance = null
    this.pendingUtterance = null
    const stopped = new Set<THREE.AnimationAction>()
    for (const e of entries) {
      if (stopped.has(e.action)) continue
      stopped.add(e.action)
      this.release(e)
    }
    done?.()
  }

  /** Introspection for tests and the debug overlay. */
  debugState(): {
    external: number
    idle: string | null
    talk: string | null
    entries: DirectorEntryInfo[]
  } {
    return {
      external: this.external,
      idle: this.idle ? this.nameOf(this.idle) : null,
      talk: this.talk ? this.nameOf(this.talk) : null,
      entries: this.entries.map((e) => ({
        kind: e.kind,
        clip: this.nameOf(e),
        w: e.w,
        target: e.target,
        action: e.action,
      })),
    }
  }

  // ------------------------------------------------------------ internals
  private rand(a: number, b: number) {
    return a + this.random() * (b - a)
  }

  /** Random integer in [0, n). */
  private randInt(n: number) {
    return Math.min(n - 1, Math.floor(this.random() * n))
  }

  private nameOf(e: Entry): string {
    return e.name ?? e.action.getClip().name
  }

  private add(kind: Kind, action: THREE.AnimationAction, fade: number): Entry {
    const e: Entry = { kind, action, w: 0, target: 1, fade, idleAge: 0 }
    this.entries.push(e)
    return e
  }

  /** Stop the action of a dropped entry, and free the mixer's bookkeeping for clips that were made only for it. */
  private release(e: Entry) {
    e.action.stop()
    // Duplicated copies (see startTalk) and live clips are used once and then released.
    const clip = e.action.getClip()
    if (e.kind === 'talk' && !this.talkClipSet.has(clip)) this.mixer.uncacheClip(clip)
  }

  /**
   * Entries whose target changes all get the same transition time (`talkFade` by default): fading in
   * and out at the same speed keeps the weights summing to 1.
   */
  private setTargets(active: Kind, fade = MOTION.talkFade) {
    // Talk was requested but nothing is there to play: keep the idle pose instead of fading everything out.
    const idleFallback = active === 'talk' && !this.talk
    for (const e of this.entries) {
      const on =
        active === 'oneshot'
          ? e === this.oneShot
          : active === 'talk' && !idleFallback
            ? e === this.talk
            : active === 'dance'
              ? e === this.dance
              : e === this.idle
      const target = on ? 1 : 0
      if (e.target !== target) {
        e.target = target
        e.fade = fade
      }
    }
  }

  private remaining(e: Entry): number {
    const clip = e.action.getClip()
    return (clip.duration - e.action.time) / Math.max(e.action.timeScale, 0.01)
  }

  /** Speech is on: carry on with the clip that stopped a moment ago if it has enough left, otherwise start a new one. */
  private ensureTalk(audioPlaying: boolean) {
    // A live-generated clip is as long as its sentence: keep it until it is over (short sentences too);
    // if it is over but the voice has stopped as well (between the end of the sentence and going back to
    // idle) it stays on its last frame instead of adding a random clip.
    if (this.talk?.live) {
      if (this.remaining(this.talk) > 0.02 || !audioPlaying) return
    } else if (this.talk) {
      // Clips shorter than 2 x minRemain would otherwise be replaced on every frame.
      const minRemain = Math.min(MOTION.minRemain, this.talk.action.getClip().duration / 2)
      if (this.remaining(this.talk) > minRemain) return
    }
    if (this.talk) this.talk.target = 0
    this.talk = this.startTalk()
  }

  private startTalk(): Entry | null {
    const talk = this.nextClip()
    if (!talk) return null
    const clip = talk.clip
    let action = this.mixer.clipAction(clip)
    // The action of this very clip is still fading out (happens with few clips): copy the clip to get an independent action.
    if (this.entries.some((e) => e.action === action)) action = this.mixer.clipAction(clip.clone())
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.reset()
    action.timeScale = this.rand(MOTION.speed[0], MOTION.speed[1])
    const minRemain = Math.min(MOTION.minRemain, clip.duration / 2)
    action.time = this.rand(0, Math.max(0, clip.duration - minRemain - 1))
    action.play()
    const e = this.add('talk', action, MOTION.talkFade)
    e.name = talk.name
    return e
  }

  private shuffledIndices(): number[] {
    const idx = this.clips.map((_, i) => i)
    for (let i = idx.length - 1; i > 0; i--) {
      const j = this.randInt(i + 1)
      ;[idx[i], idx[j]] = [idx[j]!, idx[i]!]
    }
    return idx
  }

  /**
   * Shuffle bag: every clip once per round, and an original never right after its mirror (or the
   * other way round).
   */
  private nextClip(): TalkClip | null {
    if (this.clips.length === 0) return null
    if (this.bag.length === 0) this.bag = this.shuffledIndices()
    const differs = (i: number) => this.clips[i]!.base !== this.lastBase
    let k = this.bag.findIndex(differs)
    if (k < 0) {
      // Everything left in this round shares the base that just played (its mirror). Start a new round
      // rather than play the mirror straight after the original.
      this.bag = this.shuffledIndices()
      k = this.bag.findIndex(differs)
      if (k < 0) k = 0 // a single base: nothing better to do
    }
    const clip = this.clips[this.bag.splice(k, 1)[0]!]!
    this.lastBase = clip.base
    return clip
  }
}
