import { describe, expect, it, vi } from 'vitest'
import { ApiClientError, createApi } from '../src/api.ts'
import { SECRET_VALUE, TOKEN, mode, plugin, status } from './helpers.tsx'

interface Call {
  url: string
  init: RequestInit
}

/** A fetch that records what it was asked and answers with the next prepared response. */
function fakeFetch(...answers: Array<Response | (() => Response) | Error>) {
  const calls: Call[] = []
  let i = 0
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const answer = answers[Math.min(i++, answers.length - 1)]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer() : (answer as Response)
  })
  return { fetch: impl as unknown as typeof fetch, calls, impl }
}

const json = (body: unknown, statusCode = 200) =>
  new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  })
const text = (body: string, statusCode = 200, type = 'text/plain') =>
  new Response(body, { status: statusCode, headers: { 'Content-Type': type } })

const apiError = (code: string, message: string, statusCode: number) =>
  json({ error: { code, message } }, statusCode)

async function failureOf(promise: Promise<unknown>): Promise<ApiClientError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError)
    return err as ApiClientError
  }
  throw new Error('expected the call to fail')
}

describe('requests', () => {
  it("carry the bearer token, stay on the page's own origin, and use no cookies and no cache", async () => {
    const f = fakeFetch(json(status()))
    await createApi({ token: TOKEN, fetch: f.fetch }).status()
    expect(f.calls).toHaveLength(1)
    const { url, init } = f.calls[0] as Call
    expect(url).toBe('/api/status')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(init).toMatchObject({
      mode: 'same-origin',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('JSON bodies say so, and the token never goes in the URL', async () => {
    const f = fakeFetch(json({ ok: true }))
    await createApi({ token: TOKEN, fetch: f.fetch }).say({
      text: 'hello',
      emotion: 'happy',
      speed: 1.5,
    })
    const { url, init } = f.calls[0] as Call
    expect(url).toBe('/api/say')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello', emotion: 'happy', speed: 1.5 })
    expect(url).not.toContain(TOKEN)
  })

  it('a base URL is a prefix for every path', async () => {
    const f = fakeFetch(json(status()))
    await createApi({ token: TOKEN, fetch: f.fetch, baseUrl: 'http://127.0.0.1:7000' }).status()
    expect(f.calls[0]?.url).toBe('http://127.0.0.1:7000/api/status')
  })

  it('names in paths are escaped', async () => {
    const f = fakeFetch(json(plugin()), json(plugin()), text(''))
    const api = createApi({ token: TOKEN, fetch: f.fetch })
    await api.pluginAction('a/b c', 'restart')
    await api.pluginAction('x', 'stop')
    await api.pluginLogs('a?b', 50)
    expect(f.calls.map((c) => c.url)).toEqual([
      '/api/plugins/a%2Fb%20c/restart',
      '/api/plugins/x/stop',
      '/api/plugins/a%3Fb/logs?lines=50',
    ])
  })

  it('route by route: verbs, paths and bodies', async () => {
    const f = fakeFetch(
      json(status()),
      json({ plugins: [plugin()] }),
      json({ modes: [mode()] }),
      json(mode({ state: 'ACTIVE' })),
      json(mode()),
      json({ secrets: [{ name: 'gemini', set: true, source: 'dpapi' }] }),
      json({ name: 'gemini', set: true, source: 'dpapi' }),
      json({ name: 'gemini', set: false, source: 'dpapi' }),
      json({ ok: true }),
      json({ ok: true }),
      json({ ok: true }),
      json({ events: [] }),
      json({ traces: [] }),
      json({ config: { a: 1 } })
    )
    const api = createApi({ token: TOKEN, fetch: f.fetch })
    await api.status()
    await api.plugins()
    await api.modes()
    await api.modeAction('dance', 'enter', { replace: true })
    await api.modeAction('dance', 'exit')
    await api.secrets()
    await api.putSecret('gemini', 'value-1')
    await api.deleteSecret('gemini')
    await api.say({ text: 'x', emotion: 'neutral' })
    await api.inject({ kind: 'danmaku', name: 'n', text: 't', count: 1 })
    await api.stopSpeech()
    await api.events(20)
    await api.traces()
    await api.config()
    expect(f.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/status',
      'GET /api/plugins',
      'GET /api/modes',
      'POST /api/modes/dance/enter',
      'POST /api/modes/dance/exit',
      'GET /api/secrets',
      'PUT /api/secrets/gemini',
      'DELETE /api/secrets/gemini',
      'POST /api/say',
      'POST /api/inject',
      'POST /api/stop',
      'GET /api/events?limit=20',
      'GET /api/traces',
      'GET /api/config',
    ])
    expect(JSON.parse(f.calls[3]?.init.body as string)).toEqual({ replace: true, force: false })
    expect(JSON.parse(f.calls[4]?.init.body as string)).toEqual({ replace: false, force: false })
    expect(JSON.parse(f.calls[6]?.init.body as string)).toEqual({ value: 'value-1' })
    expect(f.calls[7]?.init.body).toBeUndefined()
    expect(f.calls[10]?.init.body).toBeUndefined()
  })
})

describe('the details of a mode action', () => {
  it('what a mode panel sends (action, row, inputs) reaches the server, and is left out when there is none', async () => {
    const f = fakeFetch(json(mode()), json(mode()))
    const api = createApi({ token: TOKEN, fetch: f.fetch })
    await api.modeAction('dance', 'act', {
      params: { action: 'tune', row: 'aipao', offset: 2.5, trial: true },
    })
    await api.modeAction('dance', 'enter')
    expect(f.calls[0]?.url).toBe('/api/modes/dance/act')
    expect(JSON.parse(f.calls[0]?.init.body as string)).toEqual({
      replace: false,
      force: false,
      params: { action: 'tune', row: 'aipao', offset: 2.5, trial: true },
    })
    expect(JSON.parse(f.calls[1]?.init.body as string)).toEqual({ replace: false, force: false })
  })
})

describe('answers are checked against the protocol', () => {
  it('returns the parsed value, with the schema defaults applied', async () => {
    const f = fakeFetch(
      json({
        plugins: [
          { id: 'p', title: 'P', kind: 'tts', service: 's', enabled: true, status: 'ready' },
        ],
      })
    )
    const [p] = await createApi({ token: TOKEN, fetch: f.fetch }).plugins()
    expect(p).toMatchObject({
      id: 'p',
      restarts: 0,
      gpu: false,
      vram_mb_est: null,
      vram_mb_measured: null,
    })
  })

  it('an answer of the wrong shape is a clear error, not something to render', async () => {
    for (const [label, body, call] of [
      [
        'a status without stage',
        { api: 1, version: '1' },
        (a: ReturnType<typeof createApi>) => a.status(),
      ],
      ['plugins as a bare array', [plugin()], (a: ReturnType<typeof createApi>) => a.plugins()],
      [
        'a plugin with a made-up status',
        { plugins: [{ ...plugin(), status: 'exploded' }] },
        (a: ReturnType<typeof createApi>) => a.plugins(),
      ],
      [
        'an API version that is not ours',
        { ...status(), api: 2 },
        (a: ReturnType<typeof createApi>) => a.status(),
      ],
      [
        'a secret list with the wrong types',
        { secrets: [{ name: 'gemini', set: 'yes', source: 1 }] },
        (a: ReturnType<typeof createApi>) => a.secrets(),
      ],
      [
        'an action answered with something else',
        { ok: false },
        (a: ReturnType<typeof createApi>) => a.stopSpeech(),
      ],
    ] as const) {
      const f = fakeFetch(json(body))
      const err = await failureOf(call(createApi({ token: TOKEN, fetch: f.fetch })))
      expect(err.code, label).toBe('bad_response')
      expect(err.status, label).toBe(200)
      expect(err.message, label).toMatch(/^Unexpected answer from \/api\//)
    }
  })

  it('an answer that is not JSON at all is reported the same way', async () => {
    const f = fakeFetch(text('<html>gateway</html>', 200, 'text/html'))
    const err = await failureOf(createApi({ token: TOKEN, fetch: f.fetch }).status())
    expect(err).toMatchObject({ code: 'bad_response', status: 200 })
    expect(err.message).toContain('/api/status')
  })

  it('fields nobody asked for are dropped: a secret list cannot smuggle a value into the page', async () => {
    const f = fakeFetch(
      json({ secrets: [{ name: 'gemini', set: true, source: 'dpapi', value: SECRET_VALUE }] })
    )
    const secrets = await createApi({ token: TOKEN, fetch: f.fetch }).secrets()
    expect(secrets).toEqual([{ name: 'gemini', set: true, source: 'dpapi' }])
    expect(JSON.stringify(secrets)).not.toContain(SECRET_VALUE)
  })

  it('the logs come back as lines, without the trailing newline', async () => {
    const f = fakeFetch(text('one\ntwo\nthree\n'), text(''), text('only'))
    const api = createApi({ token: TOKEN, fetch: f.fetch })
    expect(await api.pluginLogs('speech')).toEqual(['one', 'two', 'three'])
    expect(await api.pluginLogs('speech')).toEqual([])
    expect(await api.pluginLogs('speech', 5)).toEqual(['only'])
  })
})

describe('errors', () => {
  it('an ApiError body surfaces its own code, message and status', async () => {
    const f = fakeFetch(apiError('no_fit', 'draw: about 9800 MiB needed', 409))
    const err = await failureOf(
      createApi({ token: TOKEN, fetch: f.fetch }).modeAction('draw', 'enter')
    )
    expect(err).toMatchObject({
      code: 'no_fit',
      message: 'draw: about 9800 MiB needed',
      status: 409,
      name: 'ApiClientError',
    })
  })

  it('401 and 429 are told apart from the rest', async () => {
    const f = fakeFetch(
      apiError('unauthorized', 'A valid bearer token is required.', 401),
      apiError('rate_limited', 'Try again in 60 seconds.', 429)
    )
    const api = createApi({ token: TOKEN, fetch: f.fetch })
    expect(await failureOf(api.status())).toMatchObject({ code: 'unauthorized', status: 401 })
    expect(await failureOf(api.status())).toMatchObject({ code: 'rate_limited', status: 429 })
  })

  it('a failure whose body is not an ApiError is reported without pretending to understand it', async () => {
    for (const body of [
      text('<html>Bad gateway</html>', 502, 'text/html'),
      json({ oops: true }, 500),
      text('', 503),
      json({ error: { code: 'x'.repeat(65), message: 'm' } }, 500),
    ]) {
      const f = fakeFetch(body)
      const err = await failureOf(createApi({ token: TOKEN, fetch: f.fetch }).status())
      expect(err.code).toBe('bad_error_shape')
      expect(err.message).toMatch(/answered 50\d with a body the console does not understand/)
      expect(err.message).not.toContain('gateway')
    }
  })

  it('no answer at all is a network error', async () => {
    const f = fakeFetch(new TypeError('Failed to fetch'))
    const err = await failureOf(createApi({ token: TOKEN, fetch: f.fetch }).status())
    expect(err).toMatchObject({ code: 'network', status: 0 })
    expect(err.message).toMatch(/Cannot reach the orchestrator/)
  })

  it('nothing that was sent comes back in an error message: a key being saved cannot leak through one', async () => {
    const attempts: Array<Response | Error> = [
      apiError('invalid_request', 'body: something is wrong', 400),
      json({ oops: SECRET_VALUE.length }, 500),
      new TypeError('Failed to fetch'),
      json({ name: 'gemini', set: 'yes' }),
    ]
    for (const answer of attempts) {
      const f = fakeFetch(answer)
      const err = await failureOf(
        createApi({ token: TOKEN, fetch: f.fetch }).putSecret('gemini', SECRET_VALUE)
      )
      expect(err.message).not.toContain(SECRET_VALUE)
      expect(err.code).not.toContain(SECRET_VALUE)
      expect(f.calls[0]?.url).not.toContain(SECRET_VALUE)
    }
  })

  it('the token is never in an error either', async () => {
    const f = fakeFetch(
      apiError('unauthorized', 'A valid bearer token is required.', 401),
      new TypeError('Failed to fetch')
    )
    const api = createApi({ token: TOKEN, fetch: f.fetch })
    for (let i = 0; i < 2; i++) {
      const err = await failureOf(api.status())
      expect(`${err.code} ${err.message}`).not.toContain(TOKEN)
    }
  })
})

describe('the default fetch', () => {
  it('is the global one, looked up when the call is made', async () => {
    const original = globalThis.fetch
    const spy = vi.fn(async () => json(status()))
    globalThis.fetch = spy as unknown as typeof fetch
    try {
      const api = createApi({ token: TOKEN })
      await api.status()
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = original
    }
  })
})
