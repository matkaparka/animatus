import { afterEach, describe, expect, it } from 'vitest'
import { GeminiProvider } from '../../src/llm/gemini.ts'
import type { GeminiConfig } from '../../src/llm/gemini.ts'
import { LlmConfigError } from '../../src/llm/http.ts'
import { LlmError } from '../../src/llm/types.ts'
import type { LlmRequest } from '../../src/llm/types.ts'
import {
  closeAllServers,
  collect,
  deadPort,
  gDone,
  gText,
  gThought,
  sendJson,
  sleep,
  sse,
  startServer,
  startSse,
  writeSliced,
} from './support/mocks.ts'
import type { Handler } from './support/mocks.ts'

const KEY = 'test-key-123'
const MODEL = 'gemini-test-model'
const PATH = `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`

const made: GeminiProvider[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((p) => p.close()))
  await closeAllServers()
})

function make(baseUrl: string, extra: Partial<GeminiConfig> = {}): GeminiProvider {
  const p = new GeminiProvider({ id: 'g', apiKey: KEY, model: MODEL, baseUrl, ...extra })
  made.push(p)
  return p
}

const ask = (text = 'hello', extra: Partial<LlmRequest> = {}): LlmRequest => ({
  messages: [{ role: 'user', content: text }],
  ...extra,
})

/** A server that streams the given events as one well-formed SSE reply. */
const replying =
  (...events: unknown[]): Handler =>
  async (_seen, res) => {
    startSse(res)
    for (const e of events) res.write(sse(e))
    res.end()
  }

async function failure(p: GeminiProvider, req: LlmRequest = ask()) {
  const out = await collect(p.stream(req))
  expect(out.error, 'expected the stream to fail').toBeInstanceOf(LlmError)
  return { error: out.error as LlmError, deltas: out.deltas }
}

const quotaBody = (quotaId: string, retryDelay = '34s') => ({
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. Please retry in 34.5s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId,
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
    ],
  },
})

describe('GeminiProvider request', () => {
  it('posts to streamGenerateContent with alt=sse and the key only in the x-goog-api-key header', async () => {
    const srv = await startServer(replying(gDone('ok')))
    await collect(make(srv.url).stream(ask()))
    const seen = srv.seen[0]!
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe(PATH)
    expect(seen.headers['x-goog-api-key']).toBe(KEY)
    expect(seen.headers['content-type']).toBe('application/json')
    expect(seen.headers.accept).toBe('text/event-stream')
    expect(seen.url).not.toContain(KEY)
    expect(seen.body).not.toContain(KEY)
    for (const [name, value] of Object.entries(seen.headers)) {
      if (name !== 'x-goog-api-key') expect(String(value), `header ${name}`).not.toContain(KEY)
    }
  })

  it('maps system to systemInstruction, assistant to model and images to inlineData', async () => {
    const srv = await startServer(replying(gDone('ok')))
    await collect(
      make(srv.url).stream({
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', mime: 'image/png', base64: 'QUJD' },
            ],
          },
        ],
        temperature: 0.3,
        maxOutputTokens: 77,
      })
    )
    const body = srv.seen[0]!.json
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] })
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: 'second' }] },
      {
        role: 'user',
        parts: [{ text: 'what is this?' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }],
      },
    ])
    expect(body.generationConfig).toEqual({ temperature: 0.3, maxOutputTokens: 77 })
    expect(body.safetySettings).toBeUndefined()
  })

  it('merges neighbouring same-role messages and drops empty ones', async () => {
    const srv = await startServer(replying(gDone('ok')))
    await collect(
      make(srv.url).stream({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'system', content: 'sys' },
          { role: 'user', content: '' },
          {
            role: 'user',
            content: [
              { type: 'text', text: '' },
              { type: 'text', text: 'b' },
            ],
          },
        ],
      })
    )
    expect(srv.seen[0]!.json.contents).toEqual([
      { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
    ])
    expect(srv.seen[0]!.json.systemInstruction).toEqual({ parts: [{ text: 'sys' }] })
  })

  it('lets the request temperature win over the configured default', async () => {
    const srv = await startServer(replying(gDone('ok')))
    const p = make(srv.url, { temperature: 0.9 })
    await collect(p.stream(ask()))
    await collect(p.stream(ask('again', { temperature: 0 })))
    expect(srv.seen[0]!.json.generationConfig).toEqual({ temperature: 0.9 })
    expect(srv.seen[1]!.json.generationConfig).toEqual({ temperature: 0 })
  })

  it('sends thinkingBudget only when configured, and 0 turns thinking off', async () => {
    const srv = await startServer(replying(gDone('ok')))
    await collect(make(srv.url).stream(ask()))
    await collect(make(srv.url, { thinkingBudget: 0 }).stream(ask()))
    await collect(make(srv.url, { thinkingBudget: 1024, includeThoughts: true }).stream(ask()))
    await collect(make(srv.url, { thinkingBudget: 0, includeThoughts: true }).stream(ask()))
    expect(srv.seen[0]!.json.generationConfig).toBeUndefined()
    expect(srv.seen[1]!.json.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 })
    expect(srv.seen[2]!.json.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 1024,
      includeThoughts: true,
    })
    expect(srv.seen[3]!.json.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  it('merges the generationConfig escape hatch under the explicit fields', async () => {
    const srv = await startServer(replying(gDone('ok')))
    const p = make(srv.url, { temperature: 0.5, generationConfig: { topP: 0.8, temperature: 2 } })
    await collect(p.stream(ask()))
    expect(srv.seen[0]!.json.generationConfig).toEqual({ topP: 0.8, temperature: 0.5 })
  })

  it('turns the adjustable safety filters off when asked', async () => {
    const srv = await startServer(replying(gDone('ok')))
    await collect(make(srv.url, { safetyOff: true }).stream(ask()))
    const settings = srv.seen[0]!.json.safetySettings as { category: string; threshold: string }[]
    expect(settings).toHaveLength(4)
    expect(settings.every((s) => s.threshold === 'BLOCK_NONE')).toBe(true)
    expect(new Set(settings.map((s) => s.category)).size).toBe(4)
  })

  it('normalises the base URL and the model name', async () => {
    const srv = await startServer(replying(gDone('ok')))
    await collect(make(`${srv.url}/v1beta/`).stream(ask()))
    await collect(make(`${srv.url}/`, { model: `models/${MODEL}` }).stream(ask()))
    await collect(make(`${srv.url}/v1`, { model: 'tunedModels/my tuned' }).stream(ask()))
    expect(srv.seen.map((s) => s.url)).toEqual([
      PATH,
      PATH,
      '/v1beta/tunedModels/my%20tuned:streamGenerateContent?alt=sse',
    ])
  })

  it('keeps a path prefix of the base URL (a reverse proxy in front of the API)', async () => {
    const srv = await startServer(replying(gDone('ok')))
    await collect(make(`${srv.url}/gemini/`).stream(ask()))
    expect(srv.seen[0]!.url).toBe(`/gemini${PATH}`)
  })

  it('refuses a request that has nothing to send, before touching the network', async () => {
    const srv = await startServer(replying(gDone('ok')))
    const p = make(srv.url)
    for (const req of [
      { messages: [] },
      { messages: [{ role: 'system' as const, content: 'only a system prompt' }] },
      { messages: [{ role: 'user' as const, content: '' }] },
      ask('x', { maxOutputTokens: 0 }),
      ask('x', { temperature: Number.NaN }),
      {
        messages: [
          {
            role: 'system' as const,
            content: [{ type: 'image' as const, mime: 'image/png', base64: 'QQ==' }],
          },
          { role: 'user' as const, content: 'x' },
        ],
      },
      {
        messages: [
          {
            role: 'user' as const,
            content: [{ type: 'image' as const, mime: 'text/plain', base64: 'QQ==' }],
          },
        ],
      },
    ]) {
      const { error } = await failure(p, req)
      expect(error.code).toBe('bad_request')
      expect(error.retryable).toBe(false)
    }
    expect(srv.seen).toHaveLength(0)
  })
})

describe('GeminiProvider configuration', () => {
  it('rejects a bad configuration without echoing the value', () => {
    const bad: [Partial<GeminiConfig>, RegExp][] = [
      [{ apiKey: '' }, /apiKey is required/],
      [{ apiKey: '   ' }, /apiKey is required/],
      [{ apiKey: 'has a space-99' }, /printable ASCII/],
      [{ model: '' }, /model is required/],
      [{ id: '' }, /provider id is required/],
      [{ baseUrl: 'not a url' }, /baseUrl must be an absolute/],
      [{ baseUrl: 'ftp://host/x' }, /http: or https:/],
      [{ baseUrl: 'http://user:pw-secret-1@host/x' }, /must not contain credentials/],
      [{ proxy: 'not a proxy' }, /proxy must be an absolute URL/],
      [{ proxy: 'ftp://user:pw-secret-2@127.0.0.1:1' }, /proxy must use http: or https:/],
      [{ proxy: 'socks5://127.0.0.1:1080' }, /proxy must use http: or https:/],
      [{ timeoutMs: 0 }, /timeoutMs must be a positive number/],
      [{ idleTimeoutMs: -5 }, /idleTimeoutMs must be a positive number/],
      [{ connectTimeoutMs: Number.NaN }, /connectTimeoutMs must be a positive number/],
      [{ temperature: Number.NaN }, /temperature must be a number/],
    ]
    for (const [override, pattern] of bad) {
      let message = ''
      try {
        new GeminiProvider({ id: 'g', apiKey: KEY, model: MODEL, ...override })
      } catch (e) {
        expect(e).toBeInstanceOf(LlmConfigError)
        message = (e as Error).message
      }
      expect(message, JSON.stringify(override)).toMatch(pattern)
      expect(message).not.toContain('pw-secret')
      expect(message).not.toContain('has a space')
    }
  })

  it('treats an empty proxy string as no proxy', () => {
    expect(
      () => new GeminiProvider({ id: 'g', apiKey: KEY, model: MODEL, proxy: '' })
    ).not.toThrow()
  })

  it('does not expose the key through JSON or util.inspect', async () => {
    const { inspect } = await import('node:util')
    const p = new GeminiProvider({ id: 'g', apiKey: KEY, model: MODEL })
    made.push(p)
    for (const text of [JSON.stringify(p), inspect(p, { depth: 6, showHidden: true }), String(p)]) {
      expect(text).not.toContain(KEY)
    }
    expect(p.id).toBe('g')
    expect(p.kind).toBe('gemini')
  })
})

describe('GeminiProvider streaming', () => {
  it('streams text in order and reports usage once, thinking tokens included in the output count', async () => {
    const srv = await startServer(
      replying(
        gText('Hel', { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 1 } }),
        gText('lo ', { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 2 } }),
        gDone('world', {
          promptTokenCount: 11,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 30,
          totalTokenCount: 45,
        })
      )
    )
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('Hello world')
    expect(out.deltas.filter((d) => d.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 11, outputTokens: 34 },
    ])
    expect(out.deltas.at(-1)).toEqual({ type: 'usage', inputTokens: 11, outputTokens: 34 })
  })

  it('turns thought parts into thinking deltas', async () => {
    const srv = await startServer(
      replying(gThought('let me think'), gThought(' more'), gText('The answer'), gDone('.'))
    )
    const out = await collect(
      make(srv.url, { thinkingBudget: 512, includeThoughts: true }).stream(ask())
    )
    expect(out.thinking).toBe('let me think more')
    expect(out.text).toBe('The answer.')
    expect(out.deltas.map((d) => d.type)).toEqual(['thinking', 'thinking', 'text', 'text'])
  })

  it('skips empty text parts and non-text parts', async () => {
    const srv = await startServer(
      replying(
        {
          candidates: [
            {
              content: {
                parts: [{ text: '' }, { functionCall: { name: 'x', args: {} } }, { text: 'ok' }],
              },
            },
          ],
        },
        { candidates: [{ finishReason: 'STOP' }] }
      )
    )
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.deltas).toEqual([{ type: 'text', text: 'ok' }])
  })

  const REPLY = [
    ': keep-alive comment\r\n\r\n',
    `data: ${JSON.stringify(gText('Grüße, '))}\r\n\r\n`,
    `data: ${JSON.stringify(gText('世界 😀 '))}\r\n\r\n`,
    // one JSON document spread over several data lines (joined with a newline, which is JSON whitespace)
    'data: {"candidates":[{"content":\n',
    'data:   {"parts":[{"text":"multi-line"}]}}]}\r\n\r\n',
    ': another comment\n',
    `data: ${JSON.stringify(gDone('!', { promptTokenCount: 5, candidatesTokenCount: 6 }))}\n\n`,
  ].join('')
  const EXPECTED_TEXT = 'Grüße, 世界 😀 multi-line!'

  it('parses CRLF, comments and multi-line data in one piece', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.end(REPLY)
    })
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe(EXPECTED_TEXT)
    expect(out.usage).toEqual({ type: 'usage', inputTokens: 5, outputTokens: 6 })
  })

  it('parses the same reply when it is written one byte at a time', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      await writeSliced(res, REPLY, 1)
      res.end()
    })
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe(EXPECTED_TEXT)
    expect(out.usage).toEqual({ type: 'usage', inputTokens: 5, outputTokens: 6 })
  })

  it.each([1, 2, 3])('parses the same reply written in random slices (seed %i)', async (seed) => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      await writeSliced(res, REPLY, { seed, max: 13 })
      res.end()
    })
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe(EXPECTED_TEXT)
  })

  it('accepts a final event that lacks its terminating blank line', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.end(`data: ${JSON.stringify(gText('a'))}\n\ndata: ${JSON.stringify(gDone('b'))}`)
    })
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('ab')
  })

  it('accepts a JSON array or a single JSON object instead of an event stream', async () => {
    const array = await startServer(async (_s, res) =>
      sendJson(res, 200, [
        gText('one '),
        gDone('two', { promptTokenCount: 3, candidatesTokenCount: 4 }),
      ])
    )
    const single = await startServer(async (_s, res) =>
      sendJson(res, 200, gDone('single', { promptTokenCount: 1, candidatesTokenCount: 2 }))
    )
    const fromArray = await collect(make(array.url).stream(ask()))
    expect(fromArray.error).toBeUndefined()
    expect(fromArray.text).toBe('one two')
    expect(fromArray.usage).toEqual({ type: 'usage', inputTokens: 3, outputTokens: 4 })
    const fromSingle = await collect(make(single.url).stream(ask()))
    expect(fromSingle.error).toBeUndefined()
    expect(fromSingle.text).toBe('single')
    expect(fromSingle.usage).toEqual({ type: 'usage', inputTokens: 1, outputTokens: 2 })
  })

  it('does not follow a redirect (the key header must not travel to another host)', async () => {
    const other = await startServer(replying(gDone('leaked')))
    const srv = await startServer(async (_s, res) => {
      res.writeHead(307, { location: `${other.url}${PATH}` })
      res.end()
    })
    const { error } = await failure(make(srv.url))
    expect(error.code).toBe('bad_request')
    expect(error.status).toBe(307)
    expect(error.message).toMatch(/redirect/)
    expect(other.seen).toHaveLength(0)
  })
})

describe('GeminiProvider error mapping', () => {
  it.each([
    [
      '429 RESOURCE_EXHAUSTED',
      429,
      quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
      'quota',
      true,
    ],
    [
      '429 with no details',
      429,
      {
        error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' },
      },
      'quota',
      true,
    ],
    ['429 with a body that is not JSON', 429, 'Too Many Requests', 'quota', true],
    [
      '500 whose body says RESOURCE_EXHAUSTED',
      500,
      { error: { code: 500, message: 'x', status: 'RESOURCE_EXHAUSTED' } },
      'quota',
      true,
    ],
    [
      '429 per-minute quota only',
      429,
      quotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
      'rate_limit',
      true,
    ],
    [
      '401',
      401,
      {
        error: {
          code: 401,
          message: 'Request had invalid authentication credentials.',
          status: 'UNAUTHENTICATED',
        },
      },
      'auth',
      false,
    ],
    [
      '403',
      403,
      { error: { code: 403, message: 'Permission denied', status: 'PERMISSION_DENIED' } },
      'auth',
      false,
    ],
    [
      '400 API_KEY_INVALID',
      400,
      {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
          ],
        },
      },
      'auth',
      false,
    ],
    [
      '400 INVALID_ARGUMENT',
      400,
      { error: { code: 400, message: 'Invalid value at contents[0]', status: 'INVALID_ARGUMENT' } },
      'bad_request',
      false,
    ],
    [
      '400 region not supported',
      400,
      {
        error: {
          code: 400,
          message: 'User location is not supported for the API use.',
          status: 'FAILED_PRECONDITION',
        },
      },
      'unavailable',
      true,
    ],
    [
      '404',
      404,
      { error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } },
      'bad_request',
      false,
    ],
    ['413', 413, 'payload too large', 'bad_request', false],
    ['408', 408, 'request timeout', 'timeout', true],
    [
      '500',
      500,
      { error: { code: 500, message: 'Internal error', status: 'INTERNAL' } },
      'unavailable',
      true,
    ],
    [
      '503',
      503,
      { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } },
      'unavailable',
      true,
    ],
    [
      '504',
      504,
      { error: { code: 504, message: 'Deadline exceeded', status: 'DEADLINE_EXCEEDED' } },
      'unavailable',
      true,
    ],
    ['502 HTML page', 502, '<html><body>Bad gateway</body></html>', 'unavailable', true],
    ['503 with an empty body', 503, '', 'unavailable', true],
  ] as const)('HTTP %s', async (_name, status, body, code, retryable) => {
    const srv = await startServer(async (_s, res) => sendJson(res, status, body))
    const { error, deltas } = await failure(make(srv.url))
    expect(error.code).toBe(code)
    expect(error.retryable).toBe(retryable)
    expect(error.status).toBe(status)
    expect(error.providerId).toBe('g')
    expect(deltas).toEqual([])
    expect(error.message).not.toContain(KEY)
  })

  it('reads a per-day quota as quota even when a per-minute quota is named too', async () => {
    const body = quotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')
    ;(body.error.details[0] as any).violations.push({
      quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
    })
    const srv = await startServer(async (_s, res) => sendJson(res, 429, body))
    expect((await failure(make(srv.url))).error.code).toBe('quota')
  })

  it('reports how long the provider asked us to wait', async () => {
    const srv = await startServer(async (_s, res) =>
      sendJson(res, 429, quotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '34s'))
    )
    expect((await failure(make(srv.url))).error.retryAfterMs).toBe(34_000)

    const header = await startServer(async (_s, res) =>
      sendJson(res, 503, 'busy', { 'retry-after': '7' })
    )
    expect((await failure(make(header.url))).error.retryAfterMs).toBe(7_000)
  })

  it('quotes the provider message but bounds its length', async () => {
    const srv = await startServer(async (_s, res) =>
      sendJson(res, 500, `<html>${'a'.repeat(200_000)}</html>`)
    )
    const { error } = await failure(make(srv.url))
    expect(error.code).toBe('unavailable')
    expect(error.message.length).toBeLessThan(600)
  })

  it('maps a safety block on the prompt to bad_request with a clear message', async () => {
    const srv = await startServer(
      replying({
        promptFeedback: { blockReason: 'SAFETY' },
        usageMetadata: { promptTokenCount: 9 },
      })
    )
    const { error, deltas } = await failure(make(srv.url))
    expect(error.code).toBe('bad_request')
    expect(error.retryable).toBe(false)
    expect(error.message).toMatch(/blocked the prompt \(blockReason SAFETY\)/)
    expect(deltas).toEqual([{ type: 'usage', inputTokens: 9 }])
  })

  it.each(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'])(
    'maps finishReason %s without text to bad_request',
    async (reason) => {
      const srv = await startServer(replying({ candidates: [{ finishReason: reason, index: 0 }] }))
      const { error } = await failure(make(srv.url))
      expect(error.code).toBe('bad_request')
      expect(error.message).toContain(`finishReason ${reason}`)
    }
  )

  it('lets a reply that was cut off by the safety filter after some text end normally', async () => {
    const srv = await startServer(
      replying(gText('Partial answer'), { candidates: [{ finishReason: 'SAFETY' }] })
    )
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('Partial answer')
  })

  it('reports a reply without text as a protocol error and explains MAX_TOKENS', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(gThought('thinking only')))
      res.end(sse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))
    })
    const { error } = await failure(make(srv.url))
    expect(error.code).toBe('protocol')
    expect(error.message).toMatch(/MAX_TOKENS/)
    expect(error.message).toMatch(/thinking/)

    const empty = await startServer(async (_s, res) => {
      startSse(res)
      res.end()
    })
    expect((await failure(make(empty.url))).error.code).toBe('protocol')
  })

  it('reports HTML from a captive portal or misconfigured proxy as a protocol error', async () => {
    const srv = await startServer(async (_s, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>please log in</html>')
    })
    const { error } = await failure(make(srv.url))
    expect(error.code).toBe('protocol')
    expect(error.message).toMatch(/content type/)
  })

  it('reports an event that is not JSON as a protocol error, after the text before it', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(gText('fine ')))
      res.end('data: {"candidates": [oops\n\n')
    })
    const { error, deltas } = await failure(make(srv.url))
    expect(error.code).toBe('protocol')
    expect(deltas).toEqual([{ type: 'text', text: 'fine ' }])
  })

  it.each([
    ['UNAVAILABLE', 503, 'unavailable'],
    ['RESOURCE_EXHAUSTED', 429, 'quota'],
    ['PERMISSION_DENIED', 403, 'auth'],
  ])('maps an %s error event inside a 200 stream', async (status, httpCode, code) => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(gText('half an ans')))
      res.end(sse({ error: { code: httpCode, message: 'in-stream failure', status } }))
    })
    const { error, deltas } = await failure(make(srv.url))
    expect(error.code).toBe(code)
    expect(error.status).toBe(httpCode)
    expect(deltas).toEqual([{ type: 'text', text: 'half an ans' }])
  })

  it('maps a connection dropped mid-stream to unavailable, keeping what arrived before it', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(gText('Hello')))
      await sleep(30)
      res.write('data: {"candidates":[{"content":{"parts":[{"text":"par')
      await sleep(30)
      res.socket!.destroy()
    })
    const { error, deltas } = await failure(make(srv.url))
    expect(error.code).toBe('unavailable')
    expect(error.retryable).toBe(true)
    expect(deltas).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('maps a connection dropped before any response to unavailable', async () => {
    const srv = await startServer(async (_s, res) => {
      res.socket!.destroy()
    })
    const { error } = await failure(make(srv.url))
    expect(error.code).toBe('unavailable')
  })

  it('maps a refused connection to unavailable', async () => {
    const port = await deadPort()
    const { error } = await failure(make(`http://127.0.0.1:${port}`))
    expect(error.code).toBe('unavailable')
    expect(error.causeCode).toBe('ECONNREFUSED')
    expect(error.status).toBeUndefined()
  })
})

describe('GeminiProvider time limits and abort', () => {
  it('ends an attempt that exceeds the total time budget', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      const timer = setInterval(() => res.write(sse(gText('.'))), 40)
      res.on('close', () => clearInterval(timer))
    })
    const started = Date.now()
    const { error, deltas } = await failure(
      make(srv.url, { timeoutMs: 400, idleTimeoutMs: 10_000 })
    )
    expect(error.code).toBe('timeout')
    expect(error.message).toMatch(/400 ms time budget/)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(deltas.length).toBeGreaterThan(0)
    await srv.seen[0]!.closed
    expect(srv.seen[0]!.clientAborted).toBe(true)
  })

  it('lets the request override the configured time budget', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(gText('x')))
    })
    const { error } = await failure(
      make(srv.url, { timeoutMs: 20_000, idleTimeoutMs: 20_000 }),
      ask('hi', { timeoutMs: 300 })
    )
    expect(error.code).toBe('timeout')
    expect(error.message).toMatch(/300 ms time budget/)
  })

  it('accepts an unlimited time budget without firing the timer at once', async () => {
    const srv = await startServer(replying(gDone('fine')))
    const out = await collect(
      make(srv.url).stream(ask('hi', { timeoutMs: Number.POSITIVE_INFINITY }))
    )
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('fine')
  })

  it('ends an attempt when no bytes arrive for the idle timeout, and closes the connection', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(gText('one')))
      // then stalls
    })
    const started = Date.now()
    const { error, deltas } = await failure(make(srv.url, { idleTimeoutMs: 300 }))
    expect(error.code).toBe('timeout')
    expect(error.message).toMatch(/no data from the provider for 300 ms/)
    expect(deltas).toEqual([{ type: 'text', text: 'one' }])
    expect(Date.now() - started).toBeLessThan(5_000)
    await srv.seen[0]!.closed
    expect(srv.seen[0]!.clientAborted).toBe(true)
  })

  it('applies the idle timeout while waiting for the response headers too', async () => {
    const srv = await startServer(async () => {
      // never answers
    })
    const { error } = await failure(make(srv.url, { idleTimeoutMs: 250 }))
    expect(error.code).toBe('timeout')
    await srv.seen[0]!.closed
    expect(srv.seen[0]!.clientAborted).toBe(true)
  })

  it('does not count time the consumer spends between deltas as idle time', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(gText('first ')))
      await sleep(50)
      res.write(sse(gDone('second')))
      res.end()
    })
    const p = make(srv.url, { idleTimeoutMs: 200 })
    const parts: string[] = []
    for await (const d of p.stream(ask())) {
      if (d.type === 'text') parts.push(d.text)
      await sleep(600) // far longer than the idle timeout; the generator is suspended, not waiting for the server
    }
    expect(parts.join('')).toBe('first second')
  })

  it('aborts mid-stream on the caller signal and the server sees the connection close', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      const timer = setInterval(() => res.write(sse(gText('tick '))), 30)
      res.on('close', () => clearInterval(timer))
    })
    const controller = new AbortController()
    const p = make(srv.url)
    const got: string[] = []
    let caught: unknown
    try {
      for await (const d of p.stream(ask('hi', { signal: controller.signal }))) {
        if (d.type === 'text') got.push(d.text)
        if (got.length === 2) controller.abort()
      }
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('aborted')
    expect((caught as LlmError).retryable).toBe(false)
    await srv.seen[0]!.closed
    expect(srv.seen[0]!.clientAborted).toBe(true)
  })

  it('aborts while still waiting for the response', async () => {
    const srv = await startServer(async () => {
      // never answers
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 80)
    const { error } = await failure(make(srv.url), ask('hi', { signal: controller.signal }))
    expect(error.code).toBe('aborted')
    await srv.seen[0]!.closed
    expect(srv.seen[0]!.clientAborted).toBe(true)
  })

  it('does not even connect when the signal is already aborted', async () => {
    const srv = await startServer(replying(gDone('never')))
    const { error } = await failure(make(srv.url), ask('hi', { signal: AbortSignal.abort() }))
    expect(error.code).toBe('aborted')
    expect(srv.seen).toHaveLength(0)
  })

  it('closes the connection when the consumer stops reading', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      const timer = setInterval(() => res.write(sse(gText('tick '))), 30)
      res.on('close', () => clearInterval(timer))
    })
    const p = make(srv.url)
    let count = 0
    for await (const d of p.stream(ask())) {
      if (d.type === 'text' && ++count === 2) break
    }
    await srv.seen[0]!.closed
    expect(srv.seen[0]!.clientAborted).toBe(true)
  })
})
