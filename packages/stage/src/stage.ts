import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { VRMAnimation } from '@pixiv/three-vrm-animation'
import type { ClipRef, ModelState, StageDownstream, StageUpstream } from '@animatus/protocol'
import { DanceStage } from './activities/dance.ts'
import { SingStage } from './activities/sing.ts'
import { SleepStage } from './activities/sleep.ts'
import { audioContextStats } from './audio/counter.ts'
import { AudioEngine } from './audio/engine.ts'
import { LipSync } from './audio/lipsync.ts'
import { SpeechPlayer, type EndReason, type UtteranceView } from './audio/speech.ts'
import {
  ExpressionController,
  LiveLayer,
  MotionDirector,
  TPoseMonitor,
  applyLiveTuning,
  applyMotionTuning,
  attachGazeTarget,
  createClip,
  disposeVrm,
  loadVrm,
  loadVrma,
  measureBody,
  mirrorVRMAnimation,
  parseVrma,
  type ModelInfo,
} from './avatar/index.ts'
import { FrameStats } from './diag/stats.ts'
import { CameraInput } from './input.ts'
import { StageClient, helloMessage } from './net/client.ts'
import { Backdrop } from './overlays/backdrop.ts'
import { Overlays } from './overlays/overlays.ts'
import { Viewer } from './viewer.ts'

type Msg<T extends StageDownstream['type']> = Extract<StageDownstream, { type: T }>

export interface StageOptions {
  canvas: HTMLCanvasElement
  overlaysRoot: HTMLElement
  backdropRoot: HTMLElement
  wsUrl: string
  /** Same-origin URL of the wLipSync profile. Missing profile = volume-driven mouth. */
  lipProfileUrl?: string
}

interface Avatar {
  url: string
  vrm: VRM
  info: ModelInfo
  mixer: THREE.AnimationMixer
  director: MotionDirector
  emote: ExpressionController
  live: LiveLayer
  tpose: TPoseMonitor
  gaze: THREE.Object3D
  clips: Map<string, THREE.AnimationClip>
  idleReady: boolean
  libraryGen: number
}

/** How long after the last utterance ends the face returns to neutral. */
const NEUTRAL_AFTER_MS = 1500
/** How long the last spoken words stay on screen after the voice has finished. */
const SUBTITLE_HOLD_MS = 1800

const NEUTRAL_LOOK: Msg<'look.set'> = {
  type: 'look.set',
  light: 1,
  mouth_scale: 1,
  calm: 0,
  motion_scale: 1,
  lip_range: null,
  dim: 0,
}

const vrmaCache = new Map<string, Promise<VRMAnimation | null>>()
const loadVrmaCached = (url: string) => {
  let p = vrmaCache.get(url)
  if (!p) {
    p = loadVrma(url).catch((e) => {
      console.warn(`[stage] cannot load ${url}`, e)
      vrmaCache.delete(url)
      return null
    })
    vrmaCache.set(url, p)
  }
  return p
}

/**
 * The stage: renders the model, plays what it is sent, reports what it played. It holds no decisions
 * and no settings; everything arrives from the orchestrator and is re-sent on every reconnect.
 */
export class Stage {
  private readonly viewer: Viewer
  private readonly input: CameraInput
  private readonly engine: AudioEngine
  private readonly lip: LipSync
  private readonly speech: SpeechPlayer
  private readonly overlays: Overlays
  private readonly backdrop: Backdrop
  private readonly client: StageClient
  private readonly dance: DanceStage
  private readonly sing: SingStage
  private readonly sleep: SleepStage
  private readonly stats = new FrameStats()
  private readonly stageId = crypto.randomUUID()

  private avatar: Avatar | null = null
  private modelUrl: string | null = null
  private modelToken = 0
  private library: Msg<'library.set'> | null = null
  private look: Msg<'look.set'> = NEUTRAL_LOOK
  private sceneLight = 1
  private dev = false
  private followHeadPending = false
  private lastFrameMs = 0
  private lastPeriodicMs = 0
  private counters = { tposeFrames: 0, framesTotal: 0, modelsLoaded: 0 }
  private liveClips = new Map<string, THREE.AnimationClip | null>()
  private neutralTimer: number | null = null
  private subtitleTimer: number | null = null

  constructor(private readonly opts: StageOptions) {
    this.viewer = new Viewer(opts.canvas)
    // The operator's mouse moves the camera at once; what it ends up as is reported, and the orchestrator keeps it.
    this.input = new CameraInput(opts.canvas, this.viewer, {
      onSettled: (adjust) => this.send({ type: 'camera.adjusted', adjust }),
    })
    this.engine = new AudioEngine()
    this.lip = new LipSync(this.engine)
    this.overlays = new Overlays(opts.overlaysRoot)
    this.backdrop = new Backdrop(opts.backdropRoot)

    const report = (m: StageUpstream) => this.send(m)
    this.speech = new SpeechPlayer(
      this.engine,
      {
        onVrma: (u, bytes) => this.onLiveVrma(u, bytes),
        onStart: (u) => this.onUtteranceStart(u),
        onEnd: (u, reason) => this.onUtteranceEnd(u, reason),
      },
      report
    )
    this.dance = new DanceStage({
      engine: this.engine,
      setCredit: (t) => this.overlays.setActivityCredit(t),
      hold: (on) => this.speech.hold('dance', on),
      report,
    })
    this.sing = new SingStage({
      engine: this.engine,
      setLyric: (t) => this.overlays.setLyric(t),
      hold: (on) => this.speech.hold('sing', on),
      report,
    })
    this.sleep = new SleepStage({
      engine: this.engine,
      setCaption: (t) => this.overlays.setSubtitle('track', t),
      report,
    })
    this.client = new StageClient(opts.wsUrl, {
      onOpen: () => this.onOpen(),
      onClose: () => this.onClose(),
      onMessage: (m) => this.onMessage(m),
      onFrame: (f) => this.speech.feed(f),
    })
    this.engine.events.on('state', () => this.reportAudio())
  }

  start(): void {
    this.client.connect()
    void this.initLipSync()
    requestAnimationFrame((t) => {
      this.lastFrameMs = t
      this.lastPeriodicMs = t
      requestAnimationFrame(this.frame)
    })
  }

  /**
   * The vowel analyser needs a profile, a worklet and a WebAssembly module, all fetched while the machine is
   * often busy starting other services. A hiccup there must not cost the whole session its vowel shapes, so a
   * failure is retried twice before the orchestrator is told (with the reason) that the mouth follows volume only.
   */
  private async initLipSync(): Promise<void> {
    const url = this.opts.lipProfileUrl ?? '/asset/lipsync/profile.json'
    for (const waitMs of [0, 2000, 8000]) {
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs))
      if ((await this.lip.init(url)) === 'wlipsync') return
    }
    this.send({
      type: 'error',
      code: 'lipsync_profile_missing',
      message: `wLipSync is not available (${this.lip.lastError ?? 'unknown reason'}); the mouth follows volume only`,
    })
  }

  // ─────────────────────────────── transport ───────────────────────────────

  private send(m: StageUpstream): void {
    this.client.send(m)
  }

  private onOpen(): void {
    this.send(
      helloMessage(this.stageId, {
        webgl2: true,
        audio_context: !!this.engine.ctx,
        output_latency_api:
          typeof AudioContext !== 'undefined' && 'outputLatency' in AudioContext.prototype,
      })
    )
  }

  /** The orchestrator is gone: stop everything audible and leave the character idling. */
  private onClose(): void {
    this.speech.cancel('all', undefined, 100)
    this.dance.abort()
    this.sing.abort()
    this.sleep.abort()
    if (this.subtitleTimer !== null) window.clearTimeout(this.subtitleTimer)
    this.subtitleTimer = null
    this.overlays.reset()
  }

  private onMessage(msg: StageDownstream): void {
    switch (msg.type) {
      case 'welcome':
        this.dev = msg.dev
        this.client.resetBackoff()
        this.reportAudio()
        if (this.avatar)
          this.reportModel({ status: 'ready', url: this.avatar.url, info: this.avatar.info })
        break
      case 'scene.set':
        this.applyScene(msg)
        break
      case 'library.set':
        this.library = msg
        void this.applyLibrary()
        break
      case 'look.set':
        this.applyLook(msg)
        break
      case 'tuning.set':
        applyMotionTuning(msg.motion)
        applyLiveTuning(msg.live)
        break
      case 'overlay.set':
        this.overlays.set(msg)
        break
      case 'utterance.begin':
        this.speech.begin(msg)
        break
      case 'utterance.cancel':
        this.speech.cancel(msg.scope, msg.utterance_id, msg.fade_ms)
        break
      case 'motion.play':
        void this.playClip(msg.motion)
        break
      case 'dance.play':
        this.dance.play(msg)
        break
      case 'dance.stop':
        this.dance.stop(msg.fade_s)
        break
      case 'dance.tune':
        this.dance.tune(msg)
        break
      case 'sing.play':
        this.sing.play(msg)
        break
      case 'sing.stop':
        this.sing.stop(msg.fade_s)
        break
      case 'sleep.play':
        void this.sleep.play(msg)
        break
      case 'sleep.pause':
        this.sleep.pause(msg.fade_s)
        break
      case 'sleep.resume':
        void this.sleep.resume(msg.fade_s, msg.volume)
        break
      case 'sleep.stop':
        this.sleep.stop(msg.fade_s)
        break
      case 'debug.request':
        if (this.dev) this.onDebug(msg)
        break
      case 'ping':
        this.send({ type: 'pong', t: msg.t })
        break
    }
  }

  // ─────────────────────────────── snapshots ───────────────────────────────

  private applyScene(msg: Msg<'scene.set'>): void {
    this.viewer.applyLayout(msg.layout.char)
    this.viewer.applyCamera(msg.camera)
    this.input.synced()
    this.sceneLight = msg.lighting.intensity
    this.viewer.setLighting(this.sceneLight, this.look.light)
    this.backdrop.apply(msg.background)
    this.overlays.setFrameRect(msg.layout.frame)
    const url = msg.model?.url ?? null
    if (url !== this.modelUrl) {
      this.modelUrl = url
      void this.loadModel(url)
    }
  }

  private applyLook(msg: Msg<'look.set'>): void {
    this.look = msg
    this.viewer.setLighting(this.sceneLight, msg.light)
    this.lip.setRange(msg.lip_range)
    this.backdrop.setDim(msg.dim)
  }

  // ─────────────────────────────── model ───────────────────────────────

  private reportModel(m: Omit<ModelState, 'type'>): void {
    this.send({ type: 'model.state', ...m })
  }

  private unloadAvatar(): void {
    const a = this.avatar
    if (!a) return
    this.avatar = null
    this.viewer.setBody(null)
    this.dance.setAvatar(null)
    a.live.dispose()
    a.director.dispose()
    a.mixer.stopAllAction()
    a.mixer.uncacheRoot(a.vrm.scene)
    a.gaze.parent?.remove(a.gaze)
    this.viewer.scene.remove(a.vrm.scene)
    disposeVrm(a.vrm)
  }

  private async loadModel(url: string | null): Promise<void> {
    const token = ++this.modelToken
    this.unloadAvatar()
    if (!url) {
      this.reportModel({ status: 'none' })
      return
    }
    this.reportModel({ status: 'loading', url })
    try {
      const { vrm, info } = await loadVrm(url)
      if (token !== this.modelToken) {
        disposeVrm(vrm)
        return
      }
      const mixer = new THREE.AnimationMixer(vrm.scene)
      const avatar: Avatar = {
        url,
        vrm,
        info,
        mixer,
        director: new MotionDirector(mixer),
        emote: new ExpressionController(vrm),
        live: new LiveLayer(vrm, this.engine.analyser ?? undefined, this.viewer.camera),
        tpose: new TPoseMonitor(vrm),
        gaze: attachGazeTarget(vrm, this.viewer.camera),
        clips: new Map(),
        idleReady: false,
        libraryGen: 0,
      }
      vrm.scene.visible = false
      this.viewer.scene.add(vrm.scene)
      this.avatar = avatar
      this.dance.setAvatar({ vrm, mixer, director: avatar.director })
      await this.applyIdle(avatar)
      if (token !== this.modelToken) return
      vrm.scene.visible = true
      this.followHeadPending = true
      this.counters.modelsLoaded++
      this.reportModel({ status: 'ready', url, info })
      void this.applyTalk(avatar)
    } catch (e) {
      console.error('[stage] model failed to load', e)
      if (token === this.modelToken) {
        this.reportModel({
          status: 'error',
          url,
          error: String((e as Error)?.message ?? e).slice(0, 400),
        })
      }
    }
  }

  // ─────────────────────────────── motion library ───────────────────────────────

  private clipFor(a: Avatar, key: string, build: () => THREE.AnimationClip): THREE.AnimationClip {
    let c = a.clips.get(key)
    if (!c) {
      c = build()
      a.clips.set(key, c)
    }
    return c
  }

  private async applyLibrary(): Promise<void> {
    const a = this.avatar
    if (!a) return
    await this.applyIdle(a)
    void this.applyTalk(a)
  }

  private async applyIdle(a: Avatar): Promise<void> {
    const lib = this.library
    if (!lib) return
    const gen = ++a.libraryGen
    if (lib.idle) {
      const anim = await loadVrmaCached(lib.idle.url)
      if (anim && this.avatar === a && gen === a.libraryGen) {
        const clip = this.clipFor(a, `idle:${lib.idle.url}`, () =>
          createClip(anim, a.vrm, { name: 'idle' })
        )
        a.director.setIdle(a.mixer.clipAction(clip), a.idleReady ? 1.5 : 0)
        a.idleReady = true
      }
    }
    if (this.avatar !== a) return
    a.director.setIdleSources(
      lib.idle_variants.map((v) => ({
        id: v.id,
        getClip: async () => {
          const anim = await loadVrmaCached(v.url)
          return anim
            ? this.clipFor(a, `idlevar:${v.url}`, () =>
                createClip(anim, a.vrm, { name: `idle_${v.id}` })
              )
            : null
        },
      }))
    )
  }

  private async applyTalk(a: Avatar): Promise<void> {
    const lib = this.library
    if (!lib) return
    const gen = a.libraryGen
    const list = lib.talk
    const anims = await Promise.all(list.map((c) => loadVrmaCached(c.url)))
    if (this.avatar !== a || gen !== a.libraryGen) return
    const clips: { name: string; clip: THREE.AnimationClip; base: number }[] = []
    anims.forEach((anim, i) => {
      if (!anim) return
      const ref = list[i] as ClipRef
      clips.push({
        name: ref.id,
        clip: this.clipFor(a, `talk:${ref.url}`, () =>
          createClip(anim, a.vrm, { name: `talk_${ref.id}` })
        ),
        base: i,
      })
      clips.push({
        name: `${ref.id}_mirror`,
        clip: this.clipFor(a, `talkm:${ref.url}`, () =>
          createClip(mirrorVRMAnimation(anim), a.vrm, { name: `talk_${ref.id}_mirror` })
        ),
        base: i,
      })
    })
    a.director.setTalkClips(clips)
  }

  /** One-shot body motion (tag motion or `motion.play`). Silently skipped if the model or file is missing. */
  private async playClip(ref: ClipRef): Promise<void> {
    const a = this.avatar
    if (!a) return
    const anim = await loadVrmaCached(ref.url)
    if (!anim || this.avatar !== a) return
    const clip = this.clipFor(a, `oneshot:${ref.url}`, () =>
      createClip(anim, a.vrm, { name: `oneshot_${ref.id}` })
    )
    a.director.playOneShot(a.mixer.clipAction(clip))
  }

  // ─────────────────────────────── speech hooks ───────────────────────────────

  private onLiveVrma(u: UtteranceView, bytes: Uint8Array): void {
    const a = this.avatar
    if (!a) return
    const id = u.id
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
    void parseVrma(buf)
      .then((anim) => {
        if (!anim || this.avatar !== a) return this.liveClips.set(id, null)
        this.liveClips.set(id, createClip(anim, a.vrm, { name: 'talk_live' }))
      })
      .catch(() => this.liveClips.set(id, null))
  }

  private onUtteranceStart(u: UtteranceView): void {
    const a = this.avatar
    const b = u.begin
    if (this.neutralTimer !== null) {
      window.clearTimeout(this.neutralTimer)
      this.neutralTimer = null
    }
    a?.emote.playEmotion(b.emotion)
    if (b.motion && this.look.calm <= 0.5) void this.playClip(b.motion)
    // The live clip never delays speech: if it was not ready by now, this utterance uses the talk clips.
    a?.director.beginUtterance(b.motion ? null : (this.liveClips.get(u.id) ?? null))
    if (this.subtitleTimer !== null) {
      window.clearTimeout(this.subtitleTimer)
      this.subtitleTimer = null
    }
    if (b.subtitle) this.overlays.setSubtitle('utterance', b.subtitle)
  }

  private onUtteranceEnd(u: UtteranceView, reason: EndReason): void {
    this.liveClips.delete(u.id)
    // The words stay a moment after the voice stops (and through the gap to the next sentence, which replaces
    // them); a cut-off sentence takes its words with it.
    if (this.subtitleTimer !== null) window.clearTimeout(this.subtitleTimer)
    this.subtitleTimer = null
    if (reason === 'done') {
      this.subtitleTimer = window.setTimeout(() => {
        this.subtitleTimer = null
        this.overlays.setSubtitle('utterance', '')
      }, SUBTITLE_HOLD_MS)
    } else {
      this.overlays.setSubtitle('utterance', '')
    }
    // Back to a neutral face when nothing follows for a moment (the legacy queue did this after 1.5 s).
    if (this.neutralTimer !== null) window.clearTimeout(this.neutralTimer)
    this.neutralTimer = window.setTimeout(() => {
      this.neutralTimer = null
      if (!this.speech.isSpeaking() && !this.dance.active) this.avatar?.emote.playEmotion('neutral')
    }, NEUTRAL_AFTER_MS)
  }

  // ─────────────────────────────── frame loop ───────────────────────────────

  private frame = (tMs: number): void => {
    requestAnimationFrame(this.frame)
    const dtMs = Math.max(0, tMs - this.lastFrameMs)
    this.lastFrameMs = tMs
    this.stats.frame(dtMs)
    this.update(Math.min(dtMs / 1000, 0.1), tMs)
    this.viewer.render()
    if (tMs - this.lastPeriodicMs >= 5000) {
      this.lastPeriodicMs = tMs
      this.reportStats()
      this.reportAudio()
    }
  }

  private update(delta: number, nowMs: number): void {
    this.engine.update(nowMs)
    this.speech.update(nowMs)
    const a = this.avatar
    if (!a) {
      this.sing.update()
      this.sleep.update()
      return
    }
    const lip = this.lip.update()
    a.emote.mouthScale = this.look.mouth_scale
    if (lip.vowels) a.emote.setVowels(lip.vowels)
    else a.emote.setVolumeMouth(lip.volume)
    a.emote.update(delta)

    this.dance.update()
    this.sing.update()
    this.sleep.update()
    a.director.holdIdle = this.sing.active || this.sleep.active
    const calm = this.look.calm > 0.5
    a.director.update(delta, (this.speech.isSpeaking() && !calm) || this.sing.voiceActive)
    a.mixer.update(delta)
    this.dance.afterMixer()

    a.live.update(delta, {
      emotion: this.dance.faceOverride ?? a.emote.currentEmotion,
      idleWeight: a.director.idleWeight,
      bodyYield: a.director.danceWeight,
      calm: this.look.calm,
      calmMotion: this.look.motion_scale,
      externalVolume: null,
    })

    if (a.idleReady && a.vrm.scene.visible) {
      this.counters.framesTotal++
      if (a.tpose.check()) this.counters.tposeFrames++
    }
    a.vrm.update(delta)
    if (this.followHeadPending && a.vrm.scene.visible) {
      this.followHeadPending = false
      this.viewer.setBody(measureBody(a.vrm))
    }
  }

  // ─────────────────────────────── reports ───────────────────────────────

  private reportAudio(): void {
    this.send({ type: 'audio.state', ...this.engine.describe() })
  }

  private reportStats(): void {
    const f = this.stats.snapshot()
    const c = audioContextStats()
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    this.send({
      type: 'stats',
      fps: f.fps,
      frame_ms_p95: f.frame_ms_p95,
      audio_contexts_created: c.created,
      audio_contexts_open: c.open,
      underruns_total: this.speech.underruns,
      tpose_frames: this.counters.tposeFrames,
      frames_total: this.counters.framesTotal,
      models_loaded: this.counters.modelsLoaded,
      ...(mem ? { js_heap_mb: Math.round(mem.usedJSHeapSize / 1048576) } : {}),
    })
  }

  private onDebug(msg: Msg<'debug.request'>): void {
    const reply = (ok: boolean, data?: unknown) =>
      this.send({
        type: 'debug.reply',
        request_id: msg.request_id,
        ok,
        ...(data === undefined ? {} : { data }),
      })
    switch (msg.op) {
      case 'stats':
        reply(true, {
          frames: this.stats.snapshot(),
          counters: this.counters,
          audio: this.engine.describe(),
          lipsync: this.lip.mode,
          blink: this.avatar?.live.blinkMode ?? null,
          dropped_media_frames: this.speech.dropped,
          invalid_frames: this.client.invalidFrames,
          underruns: this.speech.underruns,
        })
        break
      case 'bones': {
        const h = this.avatar?.vrm.humanoid
        if (!h) return reply(false)
        const out: Record<string, number[]> = {}
        for (const name of [
          'hips',
          'spine',
          'head',
          'leftUpperArm',
          'rightUpperArm',
          'leftLowerArm',
          'rightLowerArm',
        ] as const) {
          const n = h.getNormalizedBoneNode(name)
          if (n)
            out[name] = [n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w].map(
              (v) => Math.round(v * 1e4) / 1e4
            )
        }
        // World-space size, for choosing a camera: bone heights, the whole bounding box and where the camera is.
        const r3 = (v: THREE.Vector3) => [v.x, v.y, v.z].map((c) => Math.round(c * 1e3) / 1e3)
        const at = new THREE.Vector3()
        for (const name of ['hips', 'head', 'leftFoot'] as const) {
          const n = h.getNormalizedBoneNode(name)
          if (n) out[`world_${name}`] = r3(n.getWorldPosition(at))
        }
        const box = new THREE.Box3().setFromObject(this.avatar!.vrm.scene)
        out.bbox_min = r3(box.min)
        out.bbox_max = r3(box.max)
        out.camera = r3(this.viewer.camera.position)
        reply(true, out)
        break
      }
      case 'reload_model': {
        const url = this.modelUrl
        this.modelUrl = null
        this.modelToken++
        this.unloadAvatar()
        this.modelUrl = url
        void this.loadModel(url)
        reply(true)
        break
      }
    }
  }
}
