import type { TtsAdapter, TtsRequest, TtsStream } from '@animatus/protocol'
import { WavError, decodeWav, peakPcm16 } from './wav.ts'

export class TtsError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unknown_style'
      | 'synth_failed'
      | 'bad_audio'
      | 'empty_audio'
      | 'timeout'
      | 'aborted'
      | 'unavailable',
    readonly retryable = false,
    readonly status?: number
  ) {
    super(message)
    this.name = 'TtsError'
  }
}

export interface GptSovitsStyle {
  /** Path the *server* can open (same machine). Backslashes are converted to slashes. */
  refAudio: string
  /** Transcript of the reference audio. */
  refText: string
  /** Multiplier on the requested speed for this style. */
  speed?: number
}

export interface GptSovitsConfig {
  baseUrl: string
  styles: Record<string, GptSovitsStyle>
  /** Style used when the request's style is unknown. */
  defaultStyle: string
  textLang?: string
  promptLang?: string
  /** GPT-SoVITS text splitting method (`cut5` splits on Chinese punctuation). */
  splitMethod?: string
  batchSize?: number
  requestTimeoutMs?: number
  /** Injectable for tests. */
  fetch?: typeof fetch
}

const posix = (p: string) => p.replace(/\\/g, '/')

/**
 * Adapter for GPT-SoVITS `api_v2` (`POST /tts`). The server handles one sentence at a time, so requests
 * are serialised here (abortable while queued). Unlike the legacy bridge, a failed synthesis is an error,
 * never a 200 with silent audio: the caller decides what to do with a sentence that could not be spoken.
 */
export class GptSovitsTts implements TtsAdapter {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly cfg: Required<Omit<GptSovitsConfig, 'fetch'>> & { fetch: typeof fetch }

  constructor(cfg: GptSovitsConfig) {
    this.cfg = {
      textLang: 'zh',
      promptLang: 'zh',
      splitMethod: 'cut5',
      batchSize: 1,
      requestTimeoutMs: 120_000,
      fetch: globalThis.fetch,
      ...cfg,
      baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    }
    if (!this.cfg.styles[this.cfg.defaultStyle])
      throw new Error(`default style "${cfg.defaultStyle}" is not defined`)
  }

  async styles(): Promise<string[]> {
    return Object.keys(this.cfg.styles)
  }

  synthesize(req: TtsRequest): Promise<TtsStream> {
    const run = () => this.run(req)
    const p = this.tail.then(run, run)
    // the queue keeps going whatever this request's outcome
    this.tail = p.catch(() => undefined)
    return p
  }

  private async run(req: TtsRequest): Promise<TtsStream> {
    if (req.signal?.aborted) throw new TtsError('aborted before start', 'aborted')
    const c = this.cfg
    const style = c.styles[req.style] ?? c.styles[c.defaultStyle]
    if (!style) throw new TtsError(`no style "${req.style}"`, 'unknown_style')
    const speed = Math.min(2, Math.max(0.5, (req.speed ?? 1) * (style.speed ?? 1)))
    const body = {
      text: req.text,
      text_lang: req.lang ?? c.textLang,
      ref_audio_path: posix(style.refAudio),
      prompt_text: style.refText,
      prompt_lang: c.promptLang,
      seed: -1,
      text_split_method: c.splitMethod,
      batch_size: c.batchSize,
      speed_factor: speed,
      media_type: 'wav',
      streaming_mode: false,
    }

    const ctl = new AbortController()
    const onAbort = () => ctl.abort()
    req.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(
      () => ctl.abort(new TtsError('request timed out', 'timeout', true)),
      c.requestTimeoutMs
    )
    try {
      let res: Response
      try {
        res = await c.fetch(`${c.baseUrl}/tts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctl.signal,
        })
      } catch (e) {
        if (req.signal?.aborted) throw new TtsError('aborted', 'aborted')
        if (ctl.signal.reason instanceof TtsError) throw ctl.signal.reason
        throw new TtsError(
          `cannot reach the speech server: ${(e as Error).message}`,
          'unavailable',
          true
        )
      }
      const data = new Uint8Array(await res.arrayBuffer())
      if (!res.ok) {
        const detail = new TextDecoder().decode(data.subarray(0, 400)).replace(/\s+/g, ' ').trim()
        throw new TtsError(
          `speech server answered ${res.status}: ${detail}`,
          'synth_failed',
          res.status >= 500,
          res.status
        )
      }
      let wav
      try {
        wav = decodeWav(data)
      } catch (e) {
        throw new TtsError(
          `speech server returned audio that is not a WAV file (${(e as WavError).message})`,
          'bad_audio'
        )
      }
      if (wav.duration < 0.05 || peakPcm16(wav.pcm16) < 1e-4) {
        throw new TtsError(
          `speech server returned ${wav.duration.toFixed(2)} s of silence`,
          'empty_audio'
        )
      }
      return { sampleRate: wav.sampleRate, chunks: once(wav.pcm16) }
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
    }
  }
}

async function* once(pcm: Uint8Array): AsyncGenerator<Uint8Array> {
  yield pcm
}
