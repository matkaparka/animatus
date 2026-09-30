import { afterEach, describe, expect, it } from 'vitest'
import { LlmGateway } from '../../src/llm/gateway.ts'
import { GeminiProvider } from '../../src/llm/gemini.ts'
import { OpenAiProvider } from '../../src/llm/openai.ts'
import { LlmError } from '../../src/llm/types.ts'
import type { LlmRequest } from '../../src/llm/types.ts'
import {
  DONE,
  closeAllServers,
  collect,
  deadPort,
  gDone,
  gText,
  oStop,
  oText,
  sleep,
  sse,
  startProxy,
  startServer,
  startSse,
} from './support/mocks.ts'
import type { Handler } from './support/mocks.ts'

const KEY = 'test-key-123'
const PROXY_USER = 'proxy-user'
const PROXY_PASSWORD = 'proxy-pass-987'

const made: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((p) => p.close()))
  await closeAllServers()
})

const geminiAt = (
  url: string,
  extra: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {}
) => {
  const p = new GeminiProvider({ id: 'gemini', apiKey: KEY, model: 'm', baseUrl: url, ...extra })
  made.push(p)
  return p
}
const localAt = (
  url: string,
  extra: Partial<ConstructorParameters<typeof OpenAiProvider>[0]> = {}
) => {
  const p = new OpenAiProvider({ id: 'local', baseUrl: `${url}/v1`, model: 'q', ...extra })
  made.push(p)
  return p
}
const ask = (extra: Partial<LlmRequest> = {}): LlmRequest => ({
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
})

const geminiReply: Handler = async (_s, res) => {
  startSse(res)
  res.write(sse(gText('via gemini ')))
  res.end(sse(gDone('ok')))
}
const localReply: Handler = async (_s, res) => {
  startSse(res)
  res.write(sse(oText('via local')) + sse(oStop) + DONE)
  res.end()
}

describe('per-provider proxy', () => {
  it('sends the traffic of a provider that has a proxy through it (absolute-URI form for plain http)', async () => {
    const upstream = await startServer(geminiReply)
    const proxy = await startProxy()
    const out = await collect(geminiAt(upstream.url, { proxy: proxy.url }).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('via gemini ok')
    expect(proxy.seen).toHaveLength(1)
    expect(proxy.seen[0]!.kind).toBe('absolute')
    expect(proxy.seen[0]!.target).toBe(
      `${upstream.url}/v1beta/models/m:streamGenerateContent?alt=sse`
    )
    expect(proxy.seen[0]!.target).not.toContain(KEY)
    expect(upstream.seen).toHaveLength(1)
    expect(upstream.seen[0]!.headers['x-goog-api-key']).toBe(KEY)
  })

  it('tunnels with CONNECT when asked to (what an https upstream always gets)', async () => {
    const upstream = await startServer(geminiReply)
    const proxy = await startProxy()
    const out = await collect(
      geminiAt(upstream.url, { proxy: proxy.url, proxyTunnel: true }).stream(ask())
    )
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('via gemini ok')
    expect(proxy.seen.map((s) => s.kind)).toEqual(['connect'])
    expect(proxy.seen[0]!.target).toBe(`127.0.0.1:${upstream.port}`)
    expect(upstream.seen).toHaveLength(1)
  })

  it('does not use a proxy for a provider without one, even when proxy environment variables are set', async () => {
    const upstream = await startServer(localReply)
    const proxy = await startProxy()
    const names = [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
    ]
    const saved = names.map((n) => [n, process.env[n]] as const)
    for (const n of names) process.env[n] = proxy.url
    try {
      const direct = await collect(localAt(upstream.url).stream(ask()))
      const emptyProxy = await collect(localAt(upstream.url, { proxy: '' }).stream(ask()))
      expect(direct.text).toBe('via local')
      expect(emptyProxy.text).toBe('via local')
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n]
        else process.env[n] = v
      }
    }
    expect(proxy.seen).toEqual([])
    expect(upstream.seen).toHaveLength(2)
  })

  it('proxies only the provider that has a proxy when a gateway mixes both', async () => {
    const remote = await startServer(geminiReply)
    const lan = await startServer(localReply)
    const proxy = await startProxy()
    const gw = new LlmGateway({
      providers: [geminiAt(remote.url, { proxy: proxy.url }), localAt(lan.url)],
      order: ['gemini', 'local'],
    })
    expect(await gw.complete(ask())).toBe('via gemini ok')
    // make the proxied provider fail so the local one is used as well
    await remote.close()
    gw.resetCooldown()
    expect(await gw.complete(ask())).toBe('via local')

    // Exactly the first request went through the proxy; the second, failing, attempt tried to.
    expect(proxy.seen.length).toBeGreaterThanOrEqual(1)
    expect(proxy.seen.every((s) => s.target.includes(String(remote.port)))).toBe(true)
    expect(proxy.seen.some((s) => s.target.includes(String(lan.port)))).toBe(false)
    expect(lan.seen).toHaveLength(1)
  })

  it('sends the proxy credentials to the proxy only, never on to the upstream', async () => {
    const upstream = await startServer(geminiReply)
    const proxy = await startProxy()
    const url = new URL(proxy.url)
    url.username = PROXY_USER
    url.password = PROXY_PASSWORD
    const out = await collect(geminiAt(upstream.url, { proxy: url.href }).stream(ask()))
    expect(out.error).toBeUndefined()
    const expected = `Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString('base64')}`
    expect(proxy.seen[0]!.headers['proxy-authorization']).toBe(expected)
    expect(JSON.stringify(upstream.seen[0]!.headers)).not.toContain(PROXY_PASSWORD)
    expect(upstream.seen[0]!.headers['proxy-authorization']).toBeUndefined()
  })

  it('never puts the proxy credentials into an error, whatever went wrong with the proxy', async () => {
    const dead = await deadPort()
    const withCredentials = (port: number) =>
      `http://${PROXY_USER}:${PROXY_PASSWORD}@127.0.0.1:${port}`
    const upstream = await startServer(geminiReply)

    // 1. the proxy is not running
    const down = await collect(
      geminiAt(upstream.url, { proxy: withCredentials(dead) }).stream(ask())
    )
    // 2. the proxy refuses (407, as a real proxy does for bad credentials)
    const refusing = await startServer(async (_s, res) => {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy"' })
      res.end('Proxy Authentication Required')
    })
    const refused = await collect(
      geminiAt(upstream.url, { proxy: withCredentials(refusing.port) }).stream(ask())
    )
    // 3. the proxy answers with an error page
    const broken = await startServer(async (_s, res) => {
      res.writeHead(502, { 'content-type': 'text/html' })
      res.end(`<html>bad gateway for ${PROXY_USER}:${PROXY_PASSWORD}</html>`)
    })
    const bad = await collect(
      geminiAt(upstream.url, { proxy: withCredentials(broken.port) }).stream(ask())
    )

    for (const result of [down, refused, bad]) {
      const error = result.error as LlmError
      expect(error).toBeInstanceOf(LlmError)
      expect(error.code).toBe('unavailable')
      for (const text of [error.message, error.stack ?? '', String(error), JSON.stringify(error)]) {
        expect(text).not.toContain(PROXY_PASSWORD)
        expect(text).not.toContain(
          Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString('base64')
        )
      }
    }
    expect(upstream.seen).toHaveLength(0)
  })

  it('lets the gateway fall back from a dead proxy to a direct local provider', async () => {
    const dead = await deadPort()
    const upstream = await startServer(geminiReply)
    const lan = await startServer(localReply)
    const gw = new LlmGateway({
      providers: [geminiAt(upstream.url, { proxy: `http://127.0.0.1:${dead}` }), localAt(lan.url)],
      order: ['gemini', 'local'],
    })
    expect(await gw.complete(ask())).toBe('via local')
    expect(gw.stats().providers[0]!.lastError?.code).toBe('unavailable')
    expect(upstream.seen).toHaveLength(0)
  })

  it('applies the time limits and abort to a proxied request too', async () => {
    const stalling = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(gText('one')))
    })
    const proxy = await startProxy()
    const idle = await collect(
      geminiAt(stalling.url, { proxy: proxy.url, idleTimeoutMs: 300 }).stream(ask())
    )
    expect((idle.error as LlmError).code).toBe('timeout')
    expect(idle.text).toBe('one')
    await stalling.seen[0]!.closed
    expect(stalling.seen[0]!.clientAborted).toBe(true)

    const ticking = await startServer(async (_s, res) => {
      startSse(res)
      const timer = setInterval(() => res.write(sse(gText('tick '))), 25)
      res.on('close', () => clearInterval(timer))
    })
    const controller = new AbortController()
    let count = 0
    let caught: unknown
    try {
      for await (const d of geminiAt(ticking.url, { proxy: proxy.url }).stream(
        ask({ signal: controller.signal })
      )) {
        if (d.type === 'text' && ++count === 2) controller.abort()
      }
    } catch (e) {
      caught = e
    }
    expect((caught as LlmError).code).toBe('aborted')
    await ticking.seen[0]!.closed
    await sleep(20)
    expect(ticking.seen[0]!.clientAborted).toBe(true)
  })
})
