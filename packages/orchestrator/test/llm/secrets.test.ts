/**
 * Key hygiene end to end. Real providers talk to servers that echo the key they received back in every
 * shape an API error might use (JSON message, header dump, URL in an HTML page, in-stream error event).
 * Then every surface that leaves the gateway is searched for the key and its encoded forms: thrown
 * errors (message, stack, JSON, inspect), `stats()`, log lines, and the providers themselves.
 */
import { inspect } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmGateway } from '../../src/llm/gateway.ts'
import type { LlmLogLevel } from '../../src/llm/gateway.ts'
import { GeminiProvider } from '../../src/llm/gemini.ts'
import { OpenAiProvider } from '../../src/llm/openai.ts'
import { LlmError } from '../../src/llm/types.ts'
import type { LlmProvider } from '../../src/llm/types.ts'
import {
  closeAllServers,
  collect,
  gText,
  sendJson,
  sse,
  startServer,
  startSse,
} from './support/mocks.ts'
import type { Handler, Seen } from './support/mocks.ts'

const PLAIN_KEY = 'test-key-123'
// Awkward characters: they appear JSON-escaped and URL-encoded in an echo.
const WEIRD_KEY = 'te"st\\key/+=123'
// A key that has the shape of a well-known vendor key, assembled so this file holds no such literal.
const VENDOR_SHAPED_KEY = ['sk', '-proj-', 'Q'.repeat(24)].join('')

const made: LlmProvider[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((p) => p.close?.()))
  await closeAllServers()
})

/** The forms of a key that must never be found. */
const forms = (key: string) => [
  key,
  encodeURIComponent(key),
  JSON.stringify(key).slice(1, -1),
  Buffer.from(key).toString('base64'),
  Buffer.from(key).toString('base64').replace(/=+$/, ''),
]

function expectClean(surface: string, text: string, key: string): void {
  for (const form of forms(key)) {
    expect(
      text.includes(form),
      `${surface} contains ${form === key ? 'the key' : 'an encoded form of the key'}`
    ).toBe(false)
  }
}

/** The key a request carried, whichever header it used. */
const keyOf = (seen: Seen): string =>
  String(seen.headers['x-goog-api-key'] ?? '') ||
  String(seen.headers.authorization ?? '').replace(/^Bearer /, '')

// ───────────────────────────── hostile servers ─────────────────────────────

const geminiEchoes: Record<string, Handler> = {
  'JSON error message': async (seen, res) =>
    sendJson(res, 400, {
      error: { code: 400, message: `API key ${keyOf(seen)} not valid`, status: 'INVALID_ARGUMENT' },
    }),
  'quota message': async (seen, res) =>
    sendJson(res, 429, {
      error: {
        code: 429,
        message: `quota exceeded for key ${keyOf(seen)}`,
        status: 'RESOURCE_EXHAUSTED',
      },
    }),
  'JSON request echo': async (seen, res) =>
    sendJson(res, 403, {
      error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' },
      request: { api_key: keyOf(seen), headers: { 'x-goog-api-key': keyOf(seen) } },
    }),
  'header dump': async (seen, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(
      `POST ${seen.url} HTTP/1.1\r\nx-goog-api-key: ${keyOf(seen)}\r\nhost: ${seen.headers.host}\r\n\r\n`
    )
  },
  'URL inside an HTML page': async (seen, res) => {
    res.writeHead(502, { 'content-type': 'text/html' })
    res.end(
      `<html>upstream https://h.example/v1beta/x?alt=sse&key=${encodeURIComponent(keyOf(seen))} failed</html>`
    )
  },
  'error event inside the stream': async (seen, res) => {
    startSse(res)
    res.end(
      sse({
        error: { code: 503, status: 'UNAVAILABLE', message: `overloaded (key ${keyOf(seen)})` },
      })
    )
  },
  'error event after some text': async (seen, res) => {
    startSse(res)
    res.write(sse(gText('some text ')))
    res.end(
      sse({
        error: { code: 503, status: 'UNAVAILABLE', message: `overloaded (key ${keyOf(seen)})` },
      })
    )
  },
}

const openAiEchoes: Record<string, Handler> = {
  'invalid key message': async (seen, res) =>
    sendJson(res, 401, {
      error: {
        message: `Incorrect API key provided: ${keyOf(seen)}.`,
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    }),
  'masked vendor key': async (seen, res) => {
    const key = keyOf(seen)
    sendJson(res, 401, {
      error: {
        message: `Incorrect API key provided: ${key.slice(0, 8)}${'*'.repeat(20)}${key.slice(-4)}.`,
        type: 'invalid_request_error',
      },
    })
  },
  'header dump': async (seen, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(
      `POST ${seen.url}\r\nAuthorization: Bearer ${keyOf(seen)}\r\nhost: ${seen.headers.host}\r\n`
    )
  },
  'error event inside the stream': async (seen, res) => {
    startSse(res)
    res.end(
      sse({ error: { message: `server error while using ${keyOf(seen)}`, type: 'server_error' } })
    )
  },
}

// ───────────────────────────── the check ─────────────────────────────

interface Captured {
  level: LlmLogLevel
  msg: string
  extra?: Record<string, unknown>
}

async function runAndInspect(primary: LlmProvider, key: string, servers: { seen: Seen[] }[]) {
  const logs: Captured[] = []
  const backup: LlmProvider = {
    id: 'backup',
    kind: 'fake',
    async *stream() {
      throw new LlmError('unavailable', 'backup is down too', { providerId: 'backup' })
    },
  }
  made.push(primary)
  const gw = new LlmGateway({
    providers: [primary, backup],
    order: [primary.id, 'backup'],
    log: (level, msg, extra) => logs.push({ level, msg, ...(extra ? { extra } : {}) }),
  })
  const out = await collect(
    gw.stream({ messages: [{ role: 'user', content: 'hello' }], tag: 'chat' })
  )
  expect(out.error, 'the hostile server should have made the request fail').toBeInstanceOf(LlmError)
  const error = out.error as LlmError

  const surfaces: [string, string][] = [
    ['error.message', error.message],
    ['error.stack', error.stack ?? ''],
    ['String(error)', String(error)],
    ['JSON.stringify(error)', JSON.stringify(error)],
    ['inspect(error)', inspect(error, { depth: 8 })],
    ['stats()', JSON.stringify(gw.stats())],
    [
      'log lines',
      logs.map((l) => `${l.level} ${l.msg} ${JSON.stringify(l.extra ?? {})}`).join('\n'),
    ],
    ['inspect(gateway)', inspect(gw, { depth: 8, showHidden: true })],
    ['inspect(provider)', inspect(primary, { depth: 8, showHidden: true })],
    ['JSON.stringify(provider)', JSON.stringify(primary)],
    ['provider.redact', primary.redact?.(`x ${key} y`) ?? ''],
  ]
  for (const [surface, text] of surfaces) expectClean(surface, text, key)

  // The key was sent (so the echo was real), in a header only.
  const requests = servers.flatMap((s) => s.seen)
  expect(requests.length).toBeGreaterThan(0)
  for (const seen of requests) {
    expect(keyOf(seen), 'the server should have received the key').toBe(key)
    expectClean('request URL', seen.url, key)
    expectClean('request body', seen.body, key)
    for (const [name, value] of Object.entries(seen.headers)) {
      if (name !== 'x-goog-api-key' && name !== 'authorization')
        expectClean(`request header ${name}`, String(value), key)
    }
  }
  return { error, logs, gw }
}

describe('a key echoed by a Gemini server never leaves the gateway', () => {
  for (const [name, handler] of Object.entries(geminiEchoes)) {
    for (const key of [PLAIN_KEY, WEIRD_KEY]) {
      it(`${name} (${key === PLAIN_KEY ? 'plain key' : 'key with quotes and slashes'})`, async () => {
        const srv = await startServer(handler)
        const gemini = new GeminiProvider({
          id: 'gemini',
          apiKey: key,
          model: 'm',
          baseUrl: srv.url,
        })
        const { error } = await runAndInspect(gemini, key, [srv])
        expect(error.code).toBe('unavailable') // the gateway's summary: every provider failed
      })
    }
  }
})

describe('a key echoed by an OpenAI-compatible server never leaves the gateway', () => {
  for (const [name, handler] of Object.entries(openAiEchoes)) {
    for (const key of [PLAIN_KEY, VENDOR_SHAPED_KEY]) {
      it(`${name} (${key === PLAIN_KEY ? 'plain key' : 'vendor-shaped key'})`, async () => {
        const srv = await startServer(handler)
        const provider = new OpenAiProvider({
          id: 'local',
          baseUrl: `${srv.url}/v1`,
          model: 'q',
          apiKey: key,
        })
        await runAndInspect(provider, key, [srv])
      })
    }
  }
})

describe('other places a secret can hide', () => {
  it('scrubs a token that is part of the configured base URL', async () => {
    // Assembled from pieces so the source holds no literal that looks like a credential assignment.
    const token = ['url', 'value', 'abcdef', '123456'].join('-')
    const srv = await startServer(async (seen, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`failed at ${seen.url}`)
    })
    const provider = new OpenAiProvider({
      id: 'local',
      baseUrl: `${srv.url}/v1?token=${token}`,
      model: 'q',
    })
    made.push(provider)
    const out = await collect(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))
    const error = out.error as LlmError
    expect(error.code).toBe('unavailable')
    expect(srv.seen[0]!.url).toContain(token) // it is the user's own URL, it has to be sent
    for (const text of [error.message, error.stack ?? '', JSON.stringify(error)])
      expect(text).not.toContain(token)
  })

  it('scrubs the key from a transport failure message (an invalid header value echoes the value)', async () => {
    // A key that fetch would reject as a header value cannot even be constructed: checked up front.
    expect(() => new GeminiProvider({ id: 'g', apiKey: 'bad\nkey-value-99', model: 'm' })).toThrow(
      /printable ASCII/
    )
    let message = ''
    try {
      new GeminiProvider({ id: 'g', apiKey: 'bad\nkey-value-99', model: 'm' })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toContain('key-value-99')
  })

  it('removes the key from arbitrary text through provider.redact', () => {
    const p = new GeminiProvider({ id: 'g', apiKey: WEIRD_KEY, model: 'm' })
    made.push(p)
    const text = [
      `k=${WEIRD_KEY}`,
      `u=${encodeURIComponent(WEIRD_KEY)}`,
      `j=${JSON.stringify({ k: WEIRD_KEY })}`,
      `h=x-goog-api-key: ${WEIRD_KEY}`,
    ].join('\n')
    expectClean('redacted text', p.redact(text), WEIRD_KEY)
  })

  it('keeps every request URL free of the key across a whole gateway run', async () => {
    const good = await startServer(async (_s, res) => {
      startSse(res)
      res.end(sse(gText('fine')))
    })
    const gemini = new GeminiProvider({
      id: 'gemini',
      apiKey: PLAIN_KEY,
      model: 'm',
      baseUrl: good.url,
    })
    made.push(gemini)
    const gw = new LlmGateway({ providers: [gemini], order: ['gemini'] })
    await gw.complete({ messages: [{ role: 'user', content: 'a' }] })
    await gw.complete({ messages: [{ role: 'user', content: 'b' }] })
    expect(good.seen).toHaveLength(2)
    for (const seen of good.seen) {
      expect(seen.url).not.toContain(PLAIN_KEY)
      expect(seen.headers['x-goog-api-key']).toBe(PLAIN_KEY)
    }
  })
})
