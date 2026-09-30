import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { GptSovitsTts, TtsError, type GptSovitsConfig } from '../../src/tts/gptsovits.ts'
import { encodeWav } from '../../src/tts/wav.ts'

const tone = (sec: number, rate = 32000, amp = 8000) => {
  const n = Math.round(sec * rate)
  const b = new Uint8Array(n * 2)
  const dv = new DataView(b.buffer)
  for (let i = 0; i < n; i++)
    dv.setInt16(i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * amp), true)
  return b
}

interface Seen {
  method?: string
  url?: string
  body: Record<string, unknown>
}

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

async function start(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const s: Seen = { method: req.method, url: req.url, body: raw ? JSON.parse(raw) : {} }
      seen.push(s)
      handler(req, res, s)
    })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const port = (server!.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}`, seen }
}

const cfg = (baseUrl: string, extra: Partial<GptSovitsConfig> = {}): GptSovitsConfig => ({
  baseUrl,
  defaultStyle: 'neutral',
  styles: {
    neutral: { refAudio: 'C:\\voices\\neutral ref.wav', refText: 'reference text' },
    happy: { refAudio: 'C:\\voices\\happy.wav', refText: 'happy text', speed: 1.1 },
  },
  ...extra,
})

const readAll = async (s: AsyncIterable<Uint8Array>) => {
  const parts: number[] = []
  for await (const c of s) parts.push(...c)
  return Uint8Array.from(parts)
}

describe('GptSovitsTts', () => {
  it('sends the request the legacy bridge sent and returns PCM16 with the file sample rate', async () => {
    const audio = tone(0.5)
    const { baseUrl, seen } = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'audio/wav' })
      res.end(encodeWav(audio, 32000))
    })
    const tts = new GptSovitsTts(cfg(baseUrl))
    const out = await tts.synthesize({ text: 'hello there', style: 'neutral', speed: 1.25 })
    expect(out.sampleRate).toBe(32000)
    expect((await readAll(out.chunks)).length).toBe(audio.length)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.url).toBe('/tts')
    expect(seen[0]!.body).toMatchObject({
      text: 'hello there',
      text_lang: 'zh',
      prompt_lang: 'zh',
      prompt_text: 'reference text',
      ref_audio_path: 'C:/voices/neutral ref.wav', // slashes, no backslashes
      seed: -1,
      text_split_method: 'cut5',
      batch_size: 1,
      speed_factor: 1.25,
      media_type: 'wav',
      streaming_mode: false,
    })
  })

  it('maps styles to reference audio, multiplies style speed, falls back to the default, clamps speed', async () => {
    const { baseUrl, seen } = await start((_q, res) => {
      res.writeHead(200)
      res.end(encodeWav(tone(0.2), 32000))
    })
    const tts = new GptSovitsTts(cfg(baseUrl))
    await tts.synthesize({ text: 'a', style: 'happy', speed: 1 })
    await tts.synthesize({ text: 'b', style: 'no-such-style' })
    await tts.synthesize({ text: 'c', style: 'neutral', speed: 9 })
    expect(seen[0]!.body.ref_audio_path).toBe('C:/voices/happy.wav')
    expect(seen[0]!.body.speed_factor).toBeCloseTo(1.1, 9)
    expect(seen[1]!.body.ref_audio_path).toBe('C:/voices/neutral ref.wav')
    expect(seen[2]!.body.speed_factor).toBe(2)
    expect(await tts.styles()).toEqual(['neutral', 'happy'])
  })

  it('serialises requests: the server never sees two at once', async () => {
    let active = 0
    let maxActive = 0
    const { baseUrl } = await start((_q, res) => {
      active++
      maxActive = Math.max(maxActive, active)
      setTimeout(() => {
        active--
        res.writeHead(200)
        res.end(encodeWav(tone(0.2), 32000))
      }, 40)
    })
    const tts = new GptSovitsTts(cfg(baseUrl))
    await Promise.all([1, 2, 3, 4].map((i) => tts.synthesize({ text: `t${i}`, style: 'neutral' })))
    expect(maxActive).toBe(1)
  })

  it('an HTTP error becomes a TtsError with the server message, never silent audio', async () => {
    const { baseUrl } = await start((_q, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'tts failed', Exception: 'ref audio too short' }))
    })
    const tts = new GptSovitsTts(cfg(baseUrl))
    const err = await tts.synthesize({ text: 'x', style: 'neutral' }).catch((e) => e)
    expect(err).toBeInstanceOf(TtsError)
    expect(err.code).toBe('synth_failed')
    expect(err.retryable).toBe(false)
    expect(err.status).toBe(400)
    expect(err.message).toContain('ref audio too short')
  })

  it('a 500 is retryable', async () => {
    const { baseUrl } = await start((_q, res) => {
      res.writeHead(500)
      res.end('Traceback (most recent call last): ...')
    })
    const err = await new GptSovitsTts(cfg(baseUrl))
      .synthesize({ text: 'x', style: 'neutral' })
      .catch((e) => e)
    expect(err.code).toBe('synth_failed')
    expect(err.retryable).toBe(true)
  })

  it('rejects a 200 whose body is not a WAV, or is silence, or is empty', async () => {
    for (const [body, code] of [
      [
        new TextEncoder().encode(
          '<html>not audio at all, but long enough to pass the size check....</html>'
        ),
        'bad_audio',
      ],
      [encodeWav(new Uint8Array(32000 * 2), 32000), 'empty_audio'], // one second of digital silence
      [encodeWav(new Uint8Array(0), 32000), 'empty_audio'],
    ] as const) {
      const { baseUrl } = await start((_q, res) => {
        res.writeHead(200)
        res.end(body)
      })
      const err = await new GptSovitsTts(cfg(baseUrl))
        .synthesize({ text: 'x', style: 'neutral' })
        .catch((e) => e)
      expect(err).toBeInstanceOf(TtsError)
      expect(err.code).toBe(code)
      await new Promise<void>((r) => server!.close(() => r()))
      server = null
    }
  })

  it('reports an unreachable server as retryable unavailable', async () => {
    const tts = new GptSovitsTts(cfg('http://127.0.0.1:1'))
    const err = await tts.synthesize({ text: 'x', style: 'neutral' }).catch((e) => e)
    expect(err.code).toBe('unavailable')
    expect(err.retryable).toBe(true)
  })

  it('times out a hung server', async () => {
    const { baseUrl } = await start(() => {
      /* never answers */
    })
    const tts = new GptSovitsTts(cfg(baseUrl, { requestTimeoutMs: 80 }))
    const err = await tts.synthesize({ text: 'x', style: 'neutral' }).catch((e) => e)
    expect(err.code).toBe('timeout')
  })

  it('abort cancels an in-flight request and one still waiting in the queue', async () => {
    let calls = 0
    const { baseUrl } = await start((_q, res) => {
      calls++
      setTimeout(() => {
        res.writeHead(200)
        res.end(encodeWav(tone(0.2), 32000))
      }, 150)
    })
    const tts = new GptSovitsTts(cfg(baseUrl))
    const a = new AbortController()
    const b = new AbortController()
    const first = tts
      .synthesize({ text: 'one', style: 'neutral', signal: a.signal })
      .catch((e) => e)
    const second = tts
      .synthesize({ text: 'two', style: 'neutral', signal: b.signal })
      .catch((e) => e)
    setTimeout(() => a.abort(), 30)
    b.abort() // aborted while queued behind the first
    const [r1, r2] = await Promise.all([first, second])
    expect(r1.code).toBe('aborted')
    expect(r2.code).toBe('aborted')
    await new Promise((r) => setTimeout(r, 250))
    expect(calls).toBe(1) // the queued one never reached the server
  })

  it('refuses to be built without its default style', () => {
    expect(
      () => new GptSovitsTts({ baseUrl: 'http://127.0.0.1:1', defaultStyle: 'x', styles: {} })
    ).toThrow(/default style/)
  })
})
