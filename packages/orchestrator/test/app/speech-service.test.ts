import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { danmaku, installCleanup, onCleanup, rig, tone, until } from './rig.ts'

installCleanup()

const REPO_PLUGINS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../plugins'
)

function wav(pcm: Uint8Array, rate = 16000): Uint8Array {
  const out = new Uint8Array(44 + pcm.length)
  const v = new DataView(out.buffer)
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)))
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true)
  ascii(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}

/** Just enough of GPT-SoVITS api_v2: a docs page that answers 200, and POST /tts that returns a WAV. */
async function fakeGsv(opts: { firstDelayMs?: number; hangAfter?: number } = {}) {
  const requests: Record<string, unknown>[] = []
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/docs') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html>docs</html>')
      return
    }
    if (req.method === 'POST' && req.url === '/tts') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        const n = requests.length
        if (opts.hangAfter !== undefined && n > opts.hangAfter) return // never answers
        const answer = () =>
          res.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.from(wav(tone(0.4))))
        if (n === 1 && opts.firstDelayMs) setTimeout(answer, opts.firstDelayMs)
        else answer()
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  onCleanup(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

const speech = (url: string, extra: Record<string, unknown> = {}) => ({
  plugins: { 'gptsovits-attach': { enabled: true, config: { url } } },
  tts: {
    styles: { neutral: { ref_audio: 'C:/refs/neutral.wav', ref_text: 'a reference line' } },
    default_style: 'neutral',
    text_lang: 'zh',
    ...extra,
  },
})

describe('the speech service comes from its plugin', () => {
  it('starts from the shipped manifest, is warmed up before it is used, and holds the audience until then', async () => {
    const gsv = await fakeGsv({ firstDelayMs: 500 })
    const r = await rig({ noTts: true, pluginsDir: REPO_PLUGINS, config: speech(gsv.url) })
    r.llm.reply = () => ['[happy]Hello from the real path.']
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected, 3000, 'stage')

    // the service is up (the plugin is ready) but still warming up: nothing may be taken from the chat yet
    await until(() => gsv.requests.length >= 1, 5000, 'the warm-up request')
    r.bili.emit(danmaku('is anybody there'))
    await new Promise((res) => setTimeout(res, 200))
    expect(r.app.tts.attached).toBe(false)
    expect(r.llm.requests).toHaveLength(0)

    // the warm-up answered: the voice is attached and the waiting message is answered with it
    await until(() => r.app.tts.attached, 5000, 'the voice to be attached')
    await until(() => stage.begins.length >= 1, 5000, 'the first utterance')
    expect(r.llm.requests).toHaveLength(1)

    // what went to the speech server: the warm-up line first, then the sentence, in GPT-SoVITS' format
    expect(gsv.requests[0]?.text).toBe('你好。')
    const real = gsv.requests[1] as Record<string, unknown>
    expect(real).toMatchObject({
      text: 'Hello from the real path.',
      text_lang: 'zh',
      ref_audio_path: 'C:/refs/neutral.wav',
      prompt_text: 'a reference line',
      text_split_method: 'cut5',
      batch_size: 1,
      media_type: 'wav',
      streaming_mode: false,
    })
    expect(
      r.app.runLog
        .recent(40)
        .map((e) => e.text)
        .join('\n')
    ).toContain('warmed up')
    expect(r.app.alarms.list().map((a) => a.code)).not.toContain('tts_warmup_failed')
  })

  it('a missing setting in the plugin configuration is an alarm that names it, not a crash', async () => {
    const r = await rig({
      noTts: true,
      pluginsDir: REPO_PLUGINS,
      config: { plugins: { 'gptsovits-attach': { enabled: true, config: {} } } },
    })
    await until(() => r.app.alarms.has('plugin_failed', 'gptsovits-attach'), 4000, 'plugin alarm')
    const alarm = r.app.alarms.list().find((a) => a.code === 'plugin_failed')
    expect(alarm?.message).toContain('plugins.gptsovits-attach.config.url is not set')
    expect(r.app.tts.attached).toBe(false)
  })

  it('without any speech plugin the operator is told and the audience is not consumed', async () => {
    const r = await rig({ noTts: true })
    expect(r.app.alarms.has('tts_none')).toBe(true)
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('hello anyone'))
    await new Promise((res) => setTimeout(res, 250))
    expect(r.llm.requests).toHaveLength(0)
  })

  it('a speech server that stops answering is reported, and an external one is left for the operator to restart', async () => {
    const gsv = await fakeGsv({ hangAfter: 1 }) // answers the warm-up, then goes silent
    const r = await rig({
      noTts: true,
      pluginsDir: REPO_PLUGINS,
      config: speech(gsv.url, { request_timeout_ms: 250 }),
    })
    r.llm.reply = () => ['[happy]First sentence here. [happy]Second sentence here.']
    await r.connect()
    await until(() => r.app.tts.attached, 5000, 'the voice to be attached')
    r.bili.emit(danmaku('say two things'))
    await until(() => r.app.alarms.has('tts_hung'), 8000, 'the hung-service alarm')
    expect(r.app.alarms.list().find((a) => a.code === 'tts_hung')?.message).toContain(
      'restart it by hand'
    )
    expect(
      r.app.runLog.recent(60).some((e) => e.kind === 'speech' && e.text.includes('could not speak'))
    ).toBe(true)
  })
})
