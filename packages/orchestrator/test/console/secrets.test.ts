import { afterEach, describe, expect, it } from 'vitest'
import { SecretsResponse } from '@animatus/protocol'
import { ApiFailure } from '../../src/console/backend.ts'
import { FakeBackend } from '../../src/console/fake.ts'
import { maskSecret } from '../../src/console/server.ts'
import {
  SECRET_VALUE,
  TestSocket,
  createCleanup,
  rawRequest,
  startConsole,
  waitUntil,
} from './support.ts'
import type { RawResponse } from './support.ts'

const cleanup = createCleanup()
afterEach(() => cleanup.run())

const start = (over: Parameters<typeof startConsole>[1] = {}) => startConsole(cleanup, over)

/** Everything a response shows: status line, every header, the body. */
const everything = (res: RawResponse): string =>
  `${res.status} ${JSON.stringify(res.headers)} ${res.text()}`

const VARIANTS = [
  SECRET_VALUE,
  JSON.stringify(SECRET_VALUE).slice(1, -1),
  encodeURIComponent(SECRET_VALUE),
  Buffer.from(SECRET_VALUE).toString('base64'),
]
const expectClean = (text: string, what: string): void => {
  for (const variant of VARIANTS) expect(text, `${what} contains ${variant}`).not.toContain(variant)
}

describe('a secret value never comes back', () => {
  it('not in any response, socket message, backend record or log line, on any route, however the request goes wrong', async () => {
    const run = await start()
    const off = run.backend.onEvent((event) => run.server.publish(event))
    cleanup.add(off)
    const socket = await TestSocket.connect(run)
    cleanup.add(() => socket.close())
    await socket.waitForType('hello')

    const seen: Array<[string, string]> = []
    const record = (what: string, res: RawResponse) => seen.push([what, everything(res)])
    const json = { 'Content-Type': 'application/json' }

    // the upload itself, and what follows
    const put = await run.call('PUT', '/api/secrets/openai_compat', {
      body: { value: SECRET_VALUE },
    })
    expect(put.status).toBe(200)
    record('the upload answer', put)

    // the same secret in every kind of bad request
    const bad: Array<[string, () => Promise<RawResponse>, number]> = [
      [
        'truncated JSON',
        () =>
          run.call('PUT', '/api/secrets/gemini', {
            rawBody: `{"value":"${SECRET_VALUE}"`,
            headers: json,
          }),
        400,
      ],
      [
        'not JSON at all',
        () => run.call('PUT', '/api/secrets/gemini', { rawBody: SECRET_VALUE, headers: json }),
        400,
      ],
      [
        'wrong content type',
        () =>
          run.call('PUT', '/api/secrets/gemini', {
            rawBody: JSON.stringify({ value: SECRET_VALUE }),
            headers: { 'Content-Type': 'text/plain' },
          }),
        415,
      ],
      [
        'an extra field',
        () => run.call('PUT', '/api/secrets/gemini', { body: { value: SECRET_VALUE, note: 'x' } }),
        400,
      ],
      [
        'the secret as a field name',
        () => run.call('PUT', '/api/secrets/gemini', { body: { [SECRET_VALUE]: 'x' } }),
        400,
      ],
      [
        'a value of the wrong type',
        () => run.call('PUT', '/api/secrets/gemini', { body: { value: [SECRET_VALUE] } }),
        400,
      ],
      [
        'a value that is too long',
        () => run.call('PUT', '/api/secrets/gemini', { body: { value: SECRET_VALUE.repeat(400) } }),
        400,
      ],
      [
        'the secret as the name',
        () => run.call('PUT', `/api/secrets/${SECRET_VALUE}`, { body: { value: 'x' } }),
        400,
      ],
      [
        'the secret as the name, encoded',
        () =>
          run.call('PUT', `/api/secrets/${encodeURIComponent(SECRET_VALUE)}`, {
            body: { value: 'x' },
          }),
        400,
      ],
      [
        'a key from the environment',
        () => run.call('PUT', '/api/secrets/search_api', { body: { value: SECRET_VALUE } }),
        409,
      ],
      [
        'a body over the limit',
        () =>
          run.call('PUT', '/api/secrets/gemini', {
            rawBody: `{"value":"${SECRET_VALUE}${'x'.repeat(70 * 1024)}"}`,
            headers: json,
          }),
        413,
      ],
      [
        'no token',
        () =>
          run.call('PUT', '/api/secrets/gemini', { token: null, body: { value: SECRET_VALUE } }),
        401,
      ],
      [
        'a foreign origin',
        () =>
          run.call('PUT', '/api/secrets/gemini', {
            origin: 'http://evil.example',
            body: { value: SECRET_VALUE },
          }),
        403,
      ],
      [
        'a foreign host',
        () =>
          run.call('PUT', '/api/secrets/gemini', {
            host: 'evil.example',
            body: { value: SECRET_VALUE },
          }),
        403,
      ],
      [
        'the wrong method',
        () => run.call('POST', '/api/secrets/gemini', { body: { value: SECRET_VALUE } }),
        405,
      ],
      [
        'a route that takes no body',
        () => run.call('POST', '/api/stop', { body: { value: SECRET_VALUE } }),
        400,
      ],
      [
        'say, by mistake',
        () => run.call('POST', '/api/say', { body: { text: 'ok', value: SECRET_VALUE } }),
        400,
      ],
    ]
    for (const [what, send, status] of bad) {
      const res = await send()
      expect(res.status, what).toBe(status)
      record(what, res)
    }

    // and now everything that can be read
    for (const path of [
      '/api/status',
      '/api/plugins',
      '/api/modes',
      '/api/secrets',
      '/api/events?limit=500',
      '/api/traces',
      '/api/config',
      '/api/plugins/speech/logs',
      '/api/plugins/singing/logs?lines=1000',
    ]) {
      const res = await run.call('GET', path)
      expect(res.status, path).toBe(200)
      record(path, res)
    }
    record('the app shell', await rawRequest(run.port, '/'))

    await waitUntil(() => socket.ofType('run').length >= 1, 3000, 'the run event about the upload')
    run.server.publish({ type: 'run', event: { ts: 1, kind: 'system', text: 'a later event' } })
    await socket.waitFor(
      () => socket.ofType('run').some((m) => JSON.stringify(m).includes('a later event')),
      3000,
      'the later event'
    )

    for (const [what, text] of seen) expectClean(text, what)
    expectClean(JSON.stringify(socket.received), 'the socket')
    expectClean(JSON.stringify(run.backend.audit), 'the backend audit trail')
    expectClean(run.logs.text(), 'the log')
    // the log did record what happened, just not the value
    expect(run.logs.entries.length).toBeGreaterThan(0)
  })

  it('a listing is names, flags and sources: nothing to leak into', async () => {
    const run = await start()
    await run.call('PUT', '/api/secrets/openai_compat', { body: { value: SECRET_VALUE } })
    const res = await run.call('GET', '/api/secrets')
    const { secrets } = SecretsResponse.parse(res.json())
    expect(secrets.find((s) => s.name === 'openai_compat')).toEqual({
      name: 'openai_compat',
      set: true,
      source: 'dpapi',
    })
    for (const s of res.json<{ secrets: Array<Record<string, unknown>> }>().secrets) {
      expect(Object.keys(s).sort()).toEqual(['name', 'set', 'source'])
    }
  })

  it('the request-finished log line names the route, not the name of the secret', async () => {
    const run = await start()
    await run.call('PUT', '/api/secrets/openai_compat', { body: { value: SECRET_VALUE } })
    await run.call('DELETE', '/api/secrets/openai_compat')
    await run.call('PUT', '/api/secrets/never_heard_of_this_one', { body: { value: SECRET_VALUE } })
    await run.call('GET', '/api/status')
    const lines = run.logs.entries.filter((e) => e.msg === 'console request')
    expect(lines.map((l) => l.extra?.path)).toEqual([
      '/api/secrets/:name',
      '/api/secrets/:name',
      '/api/secrets/:name',
      '/api/status',
    ])
    expect(JSON.stringify(lines)).not.toContain('openai_compat')
    expect(JSON.stringify(lines)).not.toContain('never_heard_of_this_one')
  })
})

describe('a backend that mishandles a secret does not get to leak it', () => {
  it('an error that carries the value is a generic 500 and the log names only the kind of error', async () => {
    class Careless extends FakeBackend {
      override putSecret(name: string, value: string): never {
        throw new Error(`the store rejected ${name} = ${value}`)
      }
    }
    const run = await start({ backend: new Careless() })
    const res = await run.call('PUT', '/api/secrets/gemini', { body: { value: SECRET_VALUE } })
    expect(res.status).toBe(500)
    expect(res.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'The orchestrator could not complete the request.',
      },
    })
    expectClean(everything(res), 'the response')
    expectClean(run.logs.text(), 'the log')
    expect(run.logs.has('error', 'console request failed')).toBe(true)
  })

  it('a refusal whose text quotes the value is masked on its way out, and its text is not logged at all', async () => {
    class Quoting extends FakeBackend {
      override putSecret(_name: string, value: string): never {
        throw new ApiFailure(
          `bad_${value}`,
          `cannot use "${value}" as a key (${encodeURIComponent(value)})`,
          422
        )
      }
    }
    const run = await start({ backend: new Quoting() })
    const res = await run.call('PUT', '/api/secrets/gemini', { body: { value: SECRET_VALUE } })
    expect(res.status).toBe(422)
    expectClean(everything(res), 'the response')
    expect(res.json<{ error: { message: string } }>().error.message).toBe(
      'cannot use "***" as a key (***)'
    )
    expectClean(run.logs.text(), 'the log')
  })

  it('an answer that contains the value is dropped: the client gets an error, not the value', async () => {
    class Echoing extends FakeBackend {
      override putSecret(name: string, value: string) {
        return { name, set: true, source: `stored as ${value}` }
      }
    }
    const run = await start({ backend: new Echoing() })
    const res = await run.call('PUT', '/api/secrets/gemini', { body: { value: SECRET_VALUE } })
    expect(res.status).toBe(500)
    expectClean(everything(res), 'the response')
    expectClean(run.logs.text(), 'the log')
    expect(run.logs.has('error', 'secret upload with the value in it')).toBe(true)
  })

  it('a secret that is deleted or listed by a backend never shows a value either way', async () => {
    const run = await start()
    await run.call('PUT', '/api/secrets/openai_compat', { body: { value: SECRET_VALUE } })
    const deleted = await run.call('DELETE', '/api/secrets/openai_compat')
    expectClean(everything(deleted), 'the delete answer')
    expect(deleted.json()).toEqual({ name: 'openai_compat', set: false, source: 'dpapi' })
  })
})

describe('maskSecret', () => {
  it('masks the raw, JSON-escaped and URL-encoded forms, and leaves short values alone', () => {
    expect(maskSecret('a test-secret-123 b', SECRET_VALUE)).toBe('a *** b')
    expect(maskSecret('x%20y', 'x y and more')).toBe('x%20y')
    expect(maskSecret('say "hi\\n"', 'say "hi\\n"')).toBe('***')
    expect(maskSecret('q=a%2Fb%2Fc', 'a/b/c')).toBe('q=***')
    expect(maskSecret('nothing here', SECRET_VALUE)).toBe('nothing here')
    expect(maskSecret('the v in the text', 'v')).toBe('the v in the text')
    expect(maskSecret('abc abc', 'abc')).toBe('abc abc') // three characters: too short to mask
    expect(maskSecret('abcd abcd', 'abcd')).toBe('*** ***')
  })
})
