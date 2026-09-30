import { afterEach, describe, expect, it } from 'vitest'
import { LlmConfigError } from '../../src/llm/http.ts'
import { OpenAiProvider } from '../../src/llm/openai.ts'
import type { OpenAiConfig } from '../../src/llm/openai.ts'
import { LlmError } from '../../src/llm/types.ts'
import type { LlmRequest } from '../../src/llm/types.ts'
import {
  DONE,
  closeAllServers,
  collect,
  deadPort,
  oStop,
  oText,
  oThink,
  oUsage,
  sendJson,
  sleep,
  sse,
  startServer,
  startSse,
  writeSliced,
} from './support/mocks.ts'
import type { Handler } from './support/mocks.ts'

const KEY = 'test-key-123'
const MODEL = 'local-test-model'

const made: OpenAiProvider[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((p) => p.close()))
  await closeAllServers()
})

function make(baseUrl: string, extra: Partial<OpenAiConfig> = {}): OpenAiProvider {
  const p = new OpenAiProvider({ id: 'o', baseUrl: `${baseUrl}/v1`, model: MODEL, ...extra })
  made.push(p)
  return p
}

const ask = (text = 'hello', extra: Partial<LlmRequest> = {}): LlmRequest => ({
  messages: [{ role: 'user', content: text }],
  ...extra,
})

/** A server that streams the given chunks and ends with [DONE]. */
const replying =
  (...chunks: unknown[]): Handler =>
  async (_seen, res) => {
    startSse(res)
    for (const c of chunks) res.write(sse(c))
    res.write(DONE)
    res.end()
  }

async function failure(p: OpenAiProvider, req: LlmRequest = ask()) {
  const out = await collect(p.stream(req))
  expect(out.error, 'expected the stream to fail').toBeInstanceOf(LlmError)
  return { error: out.error as LlmError, deltas: out.deltas }
}

const oaiError = (message: string, type: string, code: string | null = null) => ({
  error: { message, type, param: null, code },
})

describe('OpenAiProvider request', () => {
  it('posts to {baseUrl}/chat/completions with stream and usage requested', async () => {
    const srv = await startServer(replying(oText('ok'), oStop))
    await collect(make(srv.url).stream(ask()))
    const seen = srv.seen[0]!
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/v1/chat/completions')
    expect(seen.json).toMatchObject({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(seen.headers.accept).toBe('text/event-stream')
  })

  it('sends no Authorization header without a key, and Bearer with one, never in the URL or body', async () => {
    const srv = await startServer(replying(oText('ok'), oStop))
    await collect(make(srv.url).stream(ask()))
    await collect(make(srv.url, { apiKey: '' }).stream(ask()))
    await collect(make(srv.url, { apiKey: KEY }).stream(ask()))
    expect(srv.seen[0]!.headers.authorization).toBeUndefined()
    expect(srv.seen[1]!.headers.authorization).toBeUndefined()
    const keyed = srv.seen[2]!
    expect(keyed.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(keyed.url).not.toContain(KEY)
    expect(keyed.body).not.toContain(KEY)
    for (const [name, value] of Object.entries(keyed.headers)) {
      if (name !== 'authorization') expect(String(value), `header ${name}`).not.toContain(KEY)
    }
  })

  it('maps roles, temperature and the output limit', async () => {
    const srv = await startServer(replying(oText('ok'), oStop))
    await collect(
      make(srv.url, { temperature: 0.9 }).stream({
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'q2' },
        ],
        temperature: 0.2,
        maxOutputTokens: 55,
      })
    )
    const body = srv.seen[0]!.json
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(55)
  })

  it('supports max_completion_tokens, opting out of usage, and the configured temperature', async () => {
    const srv = await startServer(replying(oText('ok'), oStop))
    await collect(
      make(srv.url, {
        maxTokensField: 'max_completion_tokens',
        includeUsage: false,
        temperature: 0.4,
      }).stream(ask('hi', { maxOutputTokens: 9 }))
    )
    const body = srv.seen[0]!.json
    expect(body.max_completion_tokens).toBe(9)
    expect(body.max_tokens).toBeUndefined()
    expect(body.stream_options).toBeUndefined()
    expect(body.temperature).toBe(0.4)
  })

  it('merges extraBody but never lets it replace model, messages or stream', async () => {
    const srv = await startServer(replying(oText('ok'), oStop))
    await collect(
      make(srv.url, {
        temperature: 0.5,
        extraBody: {
          chat_template_kwargs: { enable_thinking: false },
          top_k: 20,
          temperature: 1.7,
          model: 'evil',
          messages: [],
          stream: false,
          stream_options: { include_usage: false },
        },
      }).stream(ask())
    )
    const body = srv.seen[0]!.json
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body.top_k).toBe(20)
    expect(body.model).toBe(MODEL)
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(body.temperature).toBe(0.5) // configured default beats extraBody
    expect(body.stream_options).toEqual({ include_usage: false }) // extraBody may replace the default
  })

  it('merges neighbouring same-role messages by default, keeps them apart on request, drops empty ones', async () => {
    const srv = await startServer(replying(oText('ok'), oStop))
    const messages: LlmRequest['messages'] = [
      { role: 'system', content: 's1' },
      { role: 'system', content: 's2' },
      { role: 'user', content: 'a' },
      { role: 'user', content: '' },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ]
    await collect(make(srv.url).stream({ messages }))
    await collect(make(srv.url, { mergeConsecutiveRoles: false }).stream({ messages }))
    expect(srv.seen[0]!.json.messages).toEqual([
      { role: 'system', content: 's1\ns2' },
      { role: 'user', content: 'a\nb' },
    ])
    expect(srv.seen[1]!.json.messages).toEqual([
      { role: 'system', content: 's1' },
      { role: 'system', content: 's2' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ])
  })

  it('sends images in user messages as data URIs', async () => {
    const srv = await startServer(replying(oText('ok'), oStop))
    await collect(
      make(srv.url).stream({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', mime: 'image/jpeg', base64: 'QUJD' },
            ],
          },
        ],
      })
    )
    expect(srv.seen[0]!.json.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
        ],
      },
    ])
  })

  it('refuses images outside user messages and requests with nothing to send, before the network', async () => {
    const srv = await startServer(replying(oText('ok'), oStop))
    const p = make(srv.url)
    for (const req of [
      {
        messages: [
          {
            role: 'assistant' as const,
            content: [{ type: 'image' as const, mime: 'image/png', base64: 'QQ==' }],
          },
        ],
      },
      { messages: [] },
      { messages: [{ role: 'user' as const, content: '' }] },
      ask('x', { maxOutputTokens: 1.5 }),
      ask('x', { temperature: Number.POSITIVE_INFINITY }),
    ]) {
      const { error } = await failure(p, req)
      expect(error.code).toBe('bad_request')
    }
    expect(srv.seen).toHaveLength(0)
  })

  it('builds the endpoint from the base URL in the forms people write it', async () => {
    const srv = await startServer(replying(oText('ok'), oStop))
    await collect(make(srv.url, { baseUrl: `${srv.url}/v1/` }).stream(ask()))
    await collect(make(srv.url, { baseUrl: `${srv.url}/v1/chat/completions` }).stream(ask()))
    await collect(make(srv.url, { baseUrl: srv.url }).stream(ask()))
    await collect(
      make(srv.url, { baseUrl: `${srv.url}/openai/deployments/d?api-version=2024-01-01` }).stream(
        ask()
      )
    )
    expect(srv.seen.map((s) => s.url)).toEqual([
      '/v1/chat/completions',
      '/v1/chat/completions',
      '/chat/completions',
      '/openai/deployments/d/chat/completions?api-version=2024-01-01',
    ])
  })
})

describe('OpenAiProvider configuration', () => {
  it('rejects a bad configuration without echoing the value', () => {
    const bad: [Partial<OpenAiConfig>, RegExp][] = [
      [{ id: '' }, /provider id is required/],
      [{ model: '' }, /model is required/],
      [{ baseUrl: '' }, /baseUrl is required/],
      [{ baseUrl: 'localhost:8081/v1' }, /baseUrl must (?:be an absolute|use)/],
      [{ baseUrl: 'http://user:pw-secret-1@127.0.0.1:1/v1' }, /must not contain credentials/],
      [{ apiKey: 'bad key with spaces' }, /printable ASCII/],
      [{ proxy: 'http://' }, /proxy must be an absolute URL/],
      [{ proxy: 'ftp://user:pw-secret-2@127.0.0.1:1' }, /proxy must use http: or https:/],
      [{ temperature: Number.NaN }, /temperature must be a number/],
      [{ timeoutMs: -1 }, /timeoutMs must be a positive number/],
    ]
    for (const [override, pattern] of bad) {
      let message = ''
      try {
        new OpenAiProvider({ id: 'o', baseUrl: 'http://127.0.0.1:1/v1', model: MODEL, ...override })
      } catch (e) {
        expect(e).toBeInstanceOf(LlmConfigError)
        message = (e as Error).message
      }
      expect(message, JSON.stringify(override)).toMatch(pattern)
      expect(message).not.toContain('pw-secret')
      expect(message).not.toContain('bad key')
    }
  })

  it('does not expose the key through JSON or util.inspect', async () => {
    const { inspect } = await import('node:util')
    const p = new OpenAiProvider({
      id: 'o',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: MODEL,
      apiKey: KEY,
    })
    made.push(p)
    for (const text of [JSON.stringify(p), inspect(p, { depth: 6, showHidden: true })])
      expect(text).not.toContain(KEY)
    expect(p.kind).toBe('openai-compatible')
  })
})

describe('OpenAiProvider streaming', () => {
  it('streams text and reads usage from the final chunk', async () => {
    const srv = await startServer(replying(oText('Hel'), oText('lo'), oStop, oUsage(7, 9)))
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('Hello')
    expect(out.deltas.at(-1)).toEqual({ type: 'usage', inputTokens: 7, outputTokens: 9 })
    expect(out.deltas.filter((d) => d.type === 'usage')).toHaveLength(1)
  })

  it('turns reasoning_content and reasoning into thinking deltas', async () => {
    const srv = await startServer(
      replying(
        oThink('hmm, '),
        { choices: [{ delta: { reasoning: 'ok. ' } }] },
        { choices: [{ delta: { role: 'assistant', content: null } }] },
        { choices: [{ delta: { reasoning_content: 'both ', content: 'Answer' } }] },
        oStop
      )
    )
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.thinking).toBe('hmm, ok. both ')
    expect(out.text).toBe('Answer')
    expect(out.deltas.map((d) => d.type)).toEqual(['thinking', 'thinking', 'thinking', 'text'])
  })

  it('accepts content sent as an array of text parts', async () => {
    const srv = await startServer(
      replying(
        {
          choices: [
            {
              delta: {
                content: [
                  { type: 'text', text: 'a' },
                  { type: 'text', text: 'b' },
                ],
              },
            },
          ],
        },
        oStop
      )
    )
    expect((await collect(make(srv.url).stream(ask()))).text).toBe('ab')
  })

  const WIRE = [
    ': comment\r\n\r\n',
    `data: ${JSON.stringify(oText('Grüße '))}\r\n\r\n`,
    `data: ${JSON.stringify(oText('世界 😀 '))}\r\n\r\n`,
    'data: {"choices":[{"delta":\n',
    'data: {"content":"multi-line "}}]}\n\n',
    `data: ${JSON.stringify(oStop)}\r\n\r\n`,
    `data: ${JSON.stringify(oUsage(3, 4))}\r\n\r\n`,
    'data: [DONE]\r\n\r\n',
  ].join('')

  it('handles CRLF, comments and multi-line data, whole and one byte at a time', async () => {
    const whole = await startServer(async (_s, res) => {
      startSse(res)
      res.end(WIRE)
    })
    const bytewise = await startServer(async (_s, res) => {
      startSse(res)
      await writeSliced(res, WIRE, 1)
      res.end()
    })
    for (const srv of [whole, bytewise]) {
      const out = await collect(make(srv.url).stream(ask()))
      expect(out.error).toBeUndefined()
      expect(out.text).toBe('Grüße 世界 😀 multi-line ')
      expect(out.usage).toEqual({ type: 'usage', inputTokens: 3, outputTokens: 4 })
    }
  })

  it.each([1, 2, 3])('handles random slices (seed %i)', async (seed) => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      await writeSliced(res, WIRE, { seed, max: 11 })
      res.end()
    })
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('Grüße 世界 😀 multi-line ')
  })

  it('accepts a stream that ends without [DONE]', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.end(sse(oText('no done marker')) + sse(oStop))
    })
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('no done marker')
  })

  it('stops at [DONE] without waiting for a server that keeps the connection open', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(oText('done soon')) + sse(oStop) + DONE)
      // never ends the response
    })
    const started = Date.now()
    const out = await collect(make(srv.url, { idleTimeoutMs: 10_000 }).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('done soon')
    expect(Date.now() - started).toBeLessThan(3_000)
    await srv.seen[0]!.closed // we closed it ourselves
  })

  it('accepts a complete JSON reply from a server that ignored stream: true', async () => {
    const srv = await startServer(async (_s, res) =>
      sendJson(res, 200, {
        choices: [
          {
            message: { role: 'assistant', content: 'whole answer', reasoning_content: 'because' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      })
    )
    const out = await collect(make(srv.url).stream(ask()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('whole answer')
    expect(out.thinking).toBe('because')
    expect(out.usage).toEqual({ type: 'usage', inputTokens: 2, outputTokens: 3 })
  })
})

describe('OpenAiProvider error mapping', () => {
  const rateLimitText =
    'Rate limit reached for gpt-x in organization org-abc on requests per min (RPM): Limit 3, Used 3. ' +
    'Please try again in 20s. You can increase your rate limit by adding a payment method at https://example.test/account/billing.'

  it.each([
    [
      '429 rate limit (its message links to billing)',
      429,
      oaiError(rateLimitText, 'requests', 'rate_limit_exceeded'),
      'rate_limit',
      true,
    ],
    ['429 plain text', 429, 'Too Many Requests', 'rate_limit', true],
    [
      '429 insufficient_quota',
      429,
      oaiError(
        'You exceeded your current quota, please check your plan and billing details.',
        'insufficient_quota',
        'insufficient_quota'
      ),
      'quota',
      true,
    ],
    [
      '429 mentioning the quota in the message only',
      429,
      oaiError('Your quota is used up', 'error'),
      'quota',
      true,
    ],
    ['429 insufficient balance', 429, oaiError('Insufficient Balance', 'error'), 'quota', true],
    ['402 payment required', 402, oaiError('Insufficient Balance', 'unknown_error'), 'quota', true],
    ['400 with insufficient_quota', 400, oaiError('nope', 'insufficient_quota'), 'quota', true],
    [
      '401',
      401,
      oaiError('Incorrect API key provided.', 'invalid_request_error', 'invalid_api_key'),
      'auth',
      false,
    ],
    ['403', 403, oaiError('Forbidden', 'error'), 'auth', false],
    [
      '400',
      400,
      oaiError("Unsupported parameter: 'foo'", 'invalid_request_error'),
      'bad_request',
      false,
    ],
    [
      '404 (model not found)',
      404,
      oaiError('The model does not exist', 'invalid_request_error', 'model_not_found'),
      'bad_request',
      false,
    ],
    ['413', 413, 'too large', 'bad_request', false],
    ['422', 422, { detail: 'unprocessable' }, 'bad_request', false],
    ['408', 408, 'timeout', 'timeout', true],
    ['500', 500, oaiError('The server had an error', 'server_error'), 'unavailable', true],
    ['502', 502, '<html>bad gateway</html>', 'unavailable', true],
    [
      '503 (model still loading)',
      503,
      oaiError('Loading model', 'unavailable_error', '503'),
      'unavailable',
      true,
    ],
    ['529', 529, 'overloaded', 'unavailable', true],
  ] as const)('HTTP %s', async (_name, status, body, code, retryable) => {
    const srv = await startServer(async (_s, res) => sendJson(res, status, body))
    const { error, deltas } = await failure(make(srv.url, { apiKey: KEY }))
    expect(error.code).toBe(code)
    expect(error.retryable).toBe(retryable)
    expect(error.status).toBe(status)
    expect(error.providerId).toBe('o')
    expect(deltas).toEqual([])
    expect(error.message).not.toContain(KEY)
  })

  it('reads Retry-After', async () => {
    const srv = await startServer(async (_s, res) =>
      sendJson(res, 429, oaiError('slow down', 'requests'), { 'retry-after': '12' })
    )
    expect((await failure(make(srv.url))).error.retryAfterMs).toBe(12_000)
  })

  it('maps a content-filtered reply without text to bad_request', async () => {
    const srv = await startServer(
      replying({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })
    )
    const { error } = await failure(make(srv.url))
    expect(error.code).toBe('bad_request')
    expect(error.message).toMatch(/content filter/)
  })

  it('explains a reply that ran out of tokens while only reasoning', async () => {
    const srv = await startServer(
      replying(
        oThink('long reasoning...'),
        { choices: [{ delta: {}, finish_reason: 'length' }] },
        oUsage(4, 100)
      )
    )
    const { error, deltas } = await failure(make(srv.url))
    expect(error.code).toBe('protocol')
    expect(error.message).toMatch(/token limit/)
    expect(deltas.some((d) => d.type === 'thinking')).toBe(true)
    expect(deltas.at(-1)).toEqual({ type: 'usage', inputTokens: 4, outputTokens: 100 }) // still reported
  })

  it('reports an empty reply, an unparsable event and an HTML page as protocol errors', async () => {
    const empty = await startServer(replying())
    expect((await failure(make(empty.url))).error.code).toBe('protocol')

    const junk = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(oText('ok ')))
      res.end('data: {not json}\n\n')
    })
    const junkResult = await failure(make(junk.url))
    expect(junkResult.error.code).toBe('protocol')
    expect(junkResult.deltas).toEqual([{ type: 'text', text: 'ok ' }])

    const html = await startServer(async (_s, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html>captive portal</html>')
    })
    expect((await failure(make(html.url))).error.code).toBe('protocol')
  })

  it.each([
    [
      'server_error',
      'The server had an error while processing your request',
      undefined,
      'unavailable',
    ],
    ['requests', 'Rate limit exceeded', 'rate_limit_exceeded', 'rate_limit'],
    ['insufficient_quota', 'You exceeded your current quota', 'insufficient_quota', 'quota'],
    ['invalid_request_error', 'Incorrect API key provided', 'invalid_api_key', 'auth'],
  ])('maps an in-stream %s error event', async (type, message, errCode, code) => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(oText('partial ')))
      res.end(sse(oaiError(message, type, errCode ?? null)))
    })
    const { error, deltas } = await failure(make(srv.url))
    expect(error.code).toBe(code)
    expect(deltas).toEqual([{ type: 'text', text: 'partial ' }])
  })

  it('maps an `event: error` frame', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      res.end(`event: error\ndata: ${JSON.stringify(oaiError('overloaded', 'server_error'))}\n\n`)
    })
    expect((await failure(make(srv.url))).error.code).toBe('unavailable')
  })

  it('maps a dropped connection and a refused connection to unavailable', async () => {
    const dropped = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(oText('Hello')))
      await sleep(30)
      res.write('data: {"choices":[{"delta":{"content":"wor')
      await sleep(30)
      res.socket!.destroy()
    })
    const first = await failure(make(dropped.url))
    expect(first.error.code).toBe('unavailable')
    expect(first.deltas).toEqual([{ type: 'text', text: 'Hello' }])

    const port = await deadPort()
    const second = await failure(
      new OpenAiProvider({ id: 'o', baseUrl: `http://127.0.0.1:${port}/v1`, model: MODEL })
    )
    expect(second.error.code).toBe('unavailable')
    expect(second.error.causeCode).toBe('ECONNREFUSED')
  })
})

describe('OpenAiProvider time limits and abort', () => {
  it('times out on idle and on the total budget, and closes the connection', async () => {
    const idle = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(oText('one')))
    })
    const idleResult = await failure(make(idle.url, { idleTimeoutMs: 250 }))
    expect(idleResult.error.code).toBe('timeout')
    expect(idleResult.error.message).toMatch(/no data from the provider for 250 ms/)
    expect(idleResult.deltas).toEqual([{ type: 'text', text: 'one' }])
    await idle.seen[0]!.closed
    expect(idle.seen[0]!.clientAborted).toBe(true)

    const busy = await startServer(async (_s, res) => {
      startSse(res)
      const timer = setInterval(() => res.write(sse(oText('.'))), 40)
      res.on('close', () => clearInterval(timer))
    })
    const busyResult = await failure(make(busy.url, { timeoutMs: 350, idleTimeoutMs: 10_000 }))
    expect(busyResult.error.code).toBe('timeout')
    expect(busyResult.error.message).toMatch(/350 ms time budget/)
    await busy.seen[0]!.closed
    expect(busy.seen[0]!.clientAborted).toBe(true)
  })

  it('aborts mid-stream on the caller signal', async () => {
    const srv = await startServer(async (_s, res) => {
      startSse(res)
      const timer = setInterval(() => res.write(sse(oText('tick '))), 30)
      res.on('close', () => clearInterval(timer))
    })
    const controller = new AbortController()
    let count = 0
    let caught: unknown
    try {
      for await (const d of make(srv.url).stream(ask('hi', { signal: controller.signal }))) {
        if (d.type === 'text' && ++count === 2) controller.abort()
      }
    } catch (e) {
      caught = e
    }
    expect((caught as LlmError).code).toBe('aborted')
    await srv.seen[0]!.closed
    expect(srv.seen[0]!.clientAborted).toBe(true)
  })
})
