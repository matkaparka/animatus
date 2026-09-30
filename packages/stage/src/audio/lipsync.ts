import type { WLipSyncAudioNode } from 'wlipsync'
import type { AudioEngine } from './engine.ts'

export interface LipFrame {
  /** 0..1 loudness with the legacy sigmoid, used when the vowel analyser is unavailable. */
  volume: number
  /** Per-vowel mouth weights (already multiplied by the analyser volume) when wLipSync is running. */
  vowels?: { aa: number; ih: number; ou: number; ee: number; oh: number }
}

/** Lower bound of the open-mouth weight while any sound plays, whatever vowel was recognised. */
const JAW_FLOOR = 0.6

/**
 * Mouth movement from what is being heard. wLipSync estimates a/i/u/e/o from MFCCs; without a
 * profile (or if the worklet fails to load) it degrades to an amplitude-driven single open mouth.
 */
export class LipSync {
  private node: WLipSyncAudioNode | null = null
  private readonly buf: Float32Array
  private defaults: { min: number; max: number } | null = null
  /** Why the last `init` fell back to the volume mode, for the report to the orchestrator. */
  lastError: string | null = null

  constructor(private readonly engine: AudioEngine) {
    this.buf = new Float32Array(engine.analyser?.fftSize ?? 2048)
  }

  get mode(): 'wlipsync' | 'volume' {
    return this.node ? 'wlipsync' : 'volume'
  }

  /** Load a wLipSync profile from a same-origin URL. Resolves to the mode that ended up in use. */
  async init(profileUrl: string): Promise<'wlipsync' | 'volume'> {
    const ctx = this.engine.ctx
    const analyser = this.engine.analyser
    if (this.node) return 'wlipsync'
    if (!ctx || !analyser) {
      this.lastError = 'no audio context'
      return 'volume'
    }
    try {
      this.lastError = null
      const res = await fetch(profileUrl)
      if (!res.ok) throw new Error(`profile HTTP ${res.status}`)
      const profile = await res.json()
      // Imported on demand, never statically, and from the multi-file build: the single-file build inlines its
      // worklet and WebAssembly as data: URLs (which a strict Content-Security-Policy has to refuse) and
      // compiles at module load (top-level await), so one failure would stop the whole stage from starting.
      // Here the worklet and the wasm are same-origin files, and a failure only costs the vowel estimation.
      const [{ createWLipSyncNode, configuration }, processorUrl, wasmUrl] = await Promise.all([
        import('wlipsync/wlipsync.js'),
        import('wlipsync/audio-processor.js?url&no-inline').then((m) => m.default),
        import('wlipsync/wlipsync.wasm?url&no-inline').then((m) => m.default),
      ])
      if (!configuration.wasmModule) {
        const wasm = await fetch(wasmUrl)
        if (!wasm.ok) throw new Error(`wasm HTTP ${wasm.status}`)
        configuration.wasmModule = await WebAssembly.compile(await wasm.arrayBuffer())
      }
      await ctx.audioWorklet.addModule(processorUrl)
      const node = await createWLipSyncNode(ctx, profile)
      analyser.connect(node)
      this.node = node
      this.defaults = { min: node.minVolume, max: node.maxVolume }
    } catch (e) {
      this.lastError = String((e as Error)?.message ?? e).slice(0, 200)
      console.warn('[stage] wLipSync unavailable, using volume lip sync:', e)
    }
    return this.mode
  }

  /** Override the analyser's log10 volume window (calm looks need it wider); null restores the defaults. */
  setRange(range: { min: number; max: number } | null): void {
    const node = this.node
    if (!node || !this.defaults) return
    node.minVolume = range ? range.min : this.defaults.min
    node.maxVolume = range ? range.max : this.defaults.max
  }

  update(): LipFrame {
    const node = this.node
    if (node) {
      const w = node.weights
      const v = node.volume || 0
      return {
        volume: this.amplitude(),
        vowels: {
          aa: Math.max((w.A ?? 0) * v, JAW_FLOOR * v),
          ih: (w.I ?? 0) * v,
          ou: (w.U ?? 0) * v,
          ee: (w.E ?? 0) * v,
          oh: (w.O ?? 0) * v,
        },
      }
    }
    return { volume: this.amplitude() }
  }

  private amplitude(): number {
    const a = this.engine.analyser
    if (!a) return 0
    a.getFloatTimeDomainData(this.buf as Float32Array<ArrayBuffer>)
    let peak = 0
    for (let i = 0; i < this.buf.length; i++) peak = Math.max(peak, Math.abs(this.buf[i]!))
    const v = 1 / (1 + Math.exp(-45 * peak + 5))
    return v < 0.1 ? 0 : v
  }
}
