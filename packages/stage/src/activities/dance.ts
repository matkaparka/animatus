import * as THREE from 'three'
import type { VRM, VRMSpringBoneJoint } from '@pixiv/three-vrm'
import type { DancePlay, DanceTune, StageUpstream } from '@animatus/protocol'
import type { AudioEngine } from '../audio/engine.ts'
import { MOTION, createClip, loadVrma, type MotionDirector } from '../avatar/index.ts'

type Phase = 'idle' | 'loading' | 'playing' | 'ending'
type Reason = 'finished' | 'stopped' | 'error' | 'cancelled'

export interface DanceAvatar {
  vrm: VRM
  mixer: THREE.AnimationMixer
  director: MotionDirector
}

export interface DanceDeps {
  engine: AudioEngine
  setCredit(text: string | null): void
  /** Hold spoken utterances back while the dance runs. */
  hold(on: boolean): void
  report(msg: StageUpstream): void
}

/**
 * The stage's half of a dance: load the motion and the music, start both on the audio clock, keep the
 * body on the motion (spring bones damped, root clamped, face happy), and report the phases. Whether a
 * dance may happen, the cooldown, the outro line: all that is the orchestrator's business.
 *
 * Motion time = (heard audio time - t0) * speed, so the body is where the music is *as heard*, on any
 * output device. If the audio context cannot run, the dance still plays, silently, on the wall clock.
 */
export class DanceStage {
  private avatar: DanceAvatar | null = null
  private clips = new Map<string, THREE.AnimationClip>()
  private phase: Phase = 'idle'
  private current: DancePlay | null = null
  private token = 0
  private action: THREE.AnimationAction | null = null
  private music: { source: AudioBufferSourceNode; gain: GainNode } | null = null
  private useAudioClock = false
  private t0 = 0
  private musicStart = 0
  private speed = 1
  private duration = 0
  private endAt = 0
  private endReason: Reason = 'finished'
  private springBackup = new Map<VRMSpringBoneJoint, { dragForce: number; stiffness: number }>()
  private hips: THREE.Object3D | null = null
  private restXZ = new THREE.Vector2()
  private scratch = new THREE.Vector2()

  constructor(private readonly deps: DanceDeps) {}

  get active(): boolean {
    return this.phase !== 'idle'
  }

  /** Face override while dancing. */
  get faceOverride(): 'happy' | null {
    return this.phase === 'idle' ? null : 'happy'
  }

  setAvatar(avatar: DanceAvatar | null): void {
    if (this.phase !== 'idle') this.abort('cancelled')
    this.clips.clear()
    this.avatar = avatar
    this.hips = avatar?.vrm.humanoid.getNormalizedBoneNode('hips') ?? null
    const rest = avatar?.vrm.humanoid.normalizedRestPose.hips?.position
    if (rest) this.restXZ.set(rest[0], rest[2])
  }

  play(msg: DancePlay): void {
    if (this.phase !== 'idle' || !this.avatar) {
      this.state(
        msg.dance_id,
        'idle',
        this.avatar ? 'cancelled' : 'error',
        this.avatar ? undefined : 'no model loaded'
      )
      return
    }
    this.current = msg
    void this.start(msg)
  }

  stop(fadeS: number): void {
    if (this.phase === 'loading') {
      this.token++
      this.finish('stopped')
    } else if (this.phase === 'playing') {
      this.beginEnding(fadeS, 'stopped')
    }
  }

  /** Live tuning: the music is already scheduled and cannot move, so offset shifts the motion. */
  tune(msg: DanceTune): void {
    if (this.phase !== 'playing') return
    if (msg.offset !== undefined) this.t0 = this.musicStart - msg.offset
    if (msg.speed !== undefined && msg.speed > 0) this.speed = msg.speed
  }

  /** Before director.update and mixer.update. */
  update(): void {
    if (this.phase !== 'playing' && this.phase !== 'ending') return
    const now = this.clock()
    const t = Math.max(0, now - this.t0) * this.speed
    if (this.action) this.action.time = Math.min(t, this.duration)
    if (this.phase === 'playing' && (this.duration - t) / this.speed <= MOTION.danceFadeOut) {
      this.beginEnding(MOTION.danceFadeOut, 'finished')
    } else if (this.phase === 'ending' && now >= this.endAt) {
      this.finish(this.endReason)
    }
  }

  /** After mixer.update: soft-limit the horizontal drift of the root bone. */
  afterMixer(): void {
    if (!this.hips || !this.avatar || this.avatar.director.danceWeight <= 0) return
    const p = this.hips.position
    const d = this.scratch.set(p.x - this.restXZ.x, p.z - this.restXZ.y)
    d.multiplyScalar(MOTION.danceRootScale)
    const limit = MOTION.danceRootClamp
    const len = d.length()
    if (limit > 0 && len > 1e-6) d.multiplyScalar((limit * Math.tanh(len / limit)) / len)
    p.x = this.restXZ.x + d.x
    p.z = this.restXZ.y + d.y
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private clock(): number {
    return this.useAudioClock ? this.deps.engine.heardTime() : performance.now() / 1000
  }

  private state(id: string, phase: Phase, reason?: Reason, error?: string): void {
    this.deps.report({
      type: 'dance.state',
      dance_id: id,
      phase,
      ...(reason ? { reason } : {}),
      ...(error ? { error } : {}),
    })
  }

  private async start(msg: DancePlay): Promise<void> {
    const avatar = this.avatar as DanceAvatar
    const token = ++this.token
    this.phase = 'loading'
    this.deps.hold(true)
    this.state(msg.dance_id, 'loading')
    try {
      let clip = this.clips.get(msg.motion_url)
      if (!clip) {
        const anim = await loadVrma(msg.motion_url)
        if (!anim) throw new Error(`cannot load ${msg.motion_url}`)
        clip = createClip(anim, avatar.vrm, {
          name: `dance_${msg.name}`,
          alignHipsXZToRest: true,
          expressions: false,
        })
        this.clips.set(msg.motion_url, clip)
      }
      const engine = this.deps.engine
      const running = await engine.ensureRunning(500)
      let buffer: AudioBuffer | null = null
      if (msg.music_url && running && engine.ctx) {
        try {
          const res = await fetch(msg.music_url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          buffer = await engine.ctx.decodeAudioData(await res.arrayBuffer())
        } catch (e) {
          console.warn('[stage] dance music failed, dancing without it', e)
        }
      } else if (msg.music_url) {
        console.warn('[stage] audio context not running: dancing without music')
      }
      if (token !== this.token || this.phase !== 'loading') return

      this.useAudioClock = running
      this.speed = msg.speed
      this.duration = clip.duration
      const ctx = engine.ctx
      const now = this.useAudioClock && ctx ? ctx.currentTime : performance.now() / 1000
      // Motion frame 0 at t0; the music starts `offset` later (a negative offset delays the motion).
      this.t0 = now + MOTION.danceFadeIn + Math.max(0, -msg.offset)
      this.musicStart = this.t0 + msg.offset
      if (buffer && ctx) {
        const source = ctx.createBufferSource()
        source.buffer = buffer
        const gain = ctx.createGain()
        gain.gain.value = msg.volume
        source.connect(gain).connect(engine.master as GainNode)
        source.start(this.musicStart)
        this.music = { source, gain }
      }
      this.action = avatar.mixer.clipAction(clip)
      avatar.director.playDance(this.action, MOTION.danceFadeIn)
      this.dampSprings(true)
      this.deps.setCredit(msg.credit || null)
      this.phase = 'playing'
      this.state(msg.dance_id, 'playing')
    } catch (e) {
      console.error('[stage] dance failed to start', e)
      if (token === this.token) this.finish('error', String((e as Error)?.message ?? e))
    }
  }

  private beginEnding(fadeS: number, reason: Reason): void {
    if (!this.avatar || !this.current) return
    this.phase = 'ending'
    this.endReason = reason
    this.avatar.director.stopDance(fadeS)
    const now = this.clock()
    this.endAt = now + fadeS
    const ctx = this.deps.engine.ctx
    if (this.music && ctx) {
      const g = this.music.gain.gain
      const t = ctx.currentTime
      g.cancelScheduledValues(t)
      g.setValueAtTime(g.value, t)
      g.linearRampToValueAtTime(0, t + fadeS)
      try {
        this.music.source.stop(t + fadeS + 0.05)
      } catch {
        // not started yet
      }
    }
    this.state(this.current.dance_id, 'ending')
  }

  /** Abort without a fade (model swap, lost connection). */
  abort(reason: Reason = 'cancelled'): void {
    if (this.phase === 'idle') return
    this.token++
    this.avatar?.director.stopDance(0.2)
    if (this.music) {
      try {
        this.music.source.stop()
      } catch {
        // already stopped
      }
    }
    this.finish(reason)
  }

  private finish(reason: Reason, error?: string): void {
    const id = this.current?.dance_id
    this.dampSprings(false)
    this.music?.gain.disconnect()
    this.music = null
    this.action = null
    this.current = null
    this.phase = 'idle'
    this.deps.setCredit(null)
    this.deps.hold(false)
    if (id) this.state(id, 'idle', reason, error)
  }

  /** Spring bones get more damping and stiffness while dancing so tails and tentacles are not flung. */
  private dampSprings(on: boolean): void {
    const joints = this.avatar?.vrm.springBoneManager?.joints
    if (!joints) return
    if (on) {
      if (this.springBackup.size > 0) return
      for (const j of joints) {
        const s = j.settings
        this.springBackup.set(j, { dragForce: s.dragForce, stiffness: s.stiffness })
        s.dragForce += (1 - s.dragForce) * MOTION.danceSpringDrag
        s.stiffness *= MOTION.danceSpringStiffness
      }
    } else {
      for (const [j, s] of this.springBackup) {
        j.settings.dragForce = s.dragForce
        j.settings.stiffness = s.stiffness
      }
      this.springBackup.clear()
    }
  }
}
