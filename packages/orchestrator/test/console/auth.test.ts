import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleToken } from '@animatus/protocol'
import {
  FailureLimiter,
  assertValidToken,
  bearerToken,
  createTokenVerifier,
  generateToken,
  parseSubprotocols,
  tokenFromSubprotocols,
} from '../../src/console/auth.ts'
import { FakeBackend } from '../../src/console/fake.ts'
import { createConsoleServer } from '../../src/console/server.ts'
import {
  TEST_TOKEN,
  TestSocket,
  createCleanup,
  errorCode,
  rawRequest,
  startConsole,
  upgradeStatus,
} from './support.ts'

const cleanup = createCleanup()
afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup.run()
})

const start = (over: Parameters<typeof startConsole>[1] = {}) => startConsole(cleanup, over)

describe('the token', () => {
  it('is 32 random bytes as base64url, different every time, and fits the contract shape', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(a).not.toBe(b)
    expect(ConsoleToken.safeParse(a).success).toBe(true)
  })

  it('a server made without a token generates one; a token that cannot travel safely is refused without being echoed', async () => {
    const backend = new FakeBackend()
    const server = createConsoleServer({ port: 0, backend })
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await server.stop()
    for (const bad of [
      '',
      'short',
      'has spaces in it now',
      'semi;colon;token;value',
      'ünïcode-token-value-x',
      'x'.repeat(129),
    ]) {
      let message = ''
      try {
        createConsoleServer({ port: 0, backend, token: bad })
      } catch (err) {
        message = (err as Error).message
      }
      expect(message, bad).not.toBe('')
      if (bad.length > 3) expect(message).not.toContain(bad)
    }
    expect(() => assertValidToken(TEST_TOKEN)).not.toThrow()
  })

  it('openUrl carries the token in the fragment only; url and the log never carry it', async () => {
    const WRONG = ['wrong', 'token', 'value', '1234'].join('-')
    const run = await start()
    expect(run.server.openUrl).toBe(`http://127.0.0.1:${run.port}/#token=${TEST_TOKEN}`)
    expect(run.server.url).toBe(`http://127.0.0.1:${run.port}`)
    expect(run.server.url).not.toContain(TEST_TOKEN)
    await run.call('GET', '/api/status')
    await run.call('GET', '/api/status', { token: WRONG })
    expect(run.logs.text()).not.toContain(TEST_TOKEN)
    expect(run.logs.text()).not.toContain(WRONG)
    expect(run.logs.text().toLowerCase()).not.toContain('bearer')
  })
})

describe('the verifier', () => {
  it('accepts the right token and nothing else', () => {
    const verify = createTokenVerifier(TEST_TOKEN)
    expect(verify(TEST_TOKEN)).toBe(true)
    for (const wrong of [
      undefined,
      '',
      ' ',
      'x',
      TEST_TOKEN.slice(1),
      `${TEST_TOKEN}x`,
      TEST_TOKEN.toUpperCase(),
      ` ${TEST_TOKEN}`,
      'y'.repeat(20_000),
    ]) {
      expect(verify(wrong), String(wrong).slice(0, 20)).toBe(false)
    }
  })

  it('goes through crypto.timingSafeEqual with two 32-byte buffers, whatever the length of what was presented', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    const verify = createTokenVerifier(TEST_TOKEN)
    for (const presented of [TEST_TOKEN, 'x', 'y'.repeat(9000), '']) {
      spy.mockClear()
      verify(presented)
      expect(spy, presented.slice(0, 10)).toHaveBeenCalledTimes(1)
      const [a, b] = spy.mock.calls[0] as [Buffer, Buffer]
      expect([a.length, b.length]).toEqual([32, 32])
    }
  })

  it('parses the Authorization header strictly', () => {
    expect(bearerToken('Bearer abc.DEF-123_x~')).toBe('abc.DEF-123_x~')
    expect(bearerToken('bearer abc')).toBe('abc')
    expect(bearerToken('BEARER   abc')).toBe('abc')
    for (const bad of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      'Basic YWJj',
      'abc',
      'Bearer a b',
      'Bearer a,b',
      'Token abc',
      'Bearerabc',
    ]) {
      expect(bearerToken(bad), String(bad)).toBeUndefined()
    }
  })

  it('takes a WebSocket token only when exactly one is offered', () => {
    expect(parseSubprotocols('animatus.console.v1, token.abc')).toEqual([
      'animatus.console.v1',
      'token.abc',
    ])
    expect(parseSubprotocols(undefined)).toEqual([])
    expect(parseSubprotocols(' , a ,, b ')).toEqual(['a', 'b'])
    expect(tokenFromSubprotocols(['animatus.console.v1', 'token.abc'])).toBe('abc')
    expect(tokenFromSubprotocols(['animatus.console.v1'])).toBeUndefined()
    // several guesses for the price of one failure: no token at all
    expect(tokenFromSubprotocols(['animatus.console.v1', 'token.abc', 'token.def'])).toBeUndefined()
    expect(tokenFromSubprotocols(['token.'])).toBe('')
  })
})

describe('HTTP authentication', () => {
  it('missing, wrong and right', async () => {
    const run = await start()
    const missing = await run.call('GET', '/api/status', { token: null })
    expect(missing.status).toBe(401)
    expect(errorCode(missing)).toBe('unauthorized')
    expect(missing.headers['www-authenticate']).toBe('Bearer')
    expect(missing.headers['cache-control']).toBe('no-store')

    const wrong = await run.call('GET', '/api/status', { token: 'x'.repeat(43) })
    expect(wrong.status).toBe(401)
    expect(errorCode(wrong)).toBe('unauthorized')

    const right = await run.call('GET', '/api/status')
    expect(right.status).toBe(200)
  })

  it('the scheme is case-insensitive; other schemes, other places and other spellings do not count', async () => {
    const run = await start()
    expect(
      (
        await run.call('GET', '/api/status', {
          token: null,
          headers: { Authorization: `bearer ${TEST_TOKEN}` },
        })
      ).status
    ).toBe(200)
    const refused: Array<[string, Record<string, string>, string]> = [
      ['Basic scheme', { Authorization: `Basic ${TEST_TOKEN}` }, '/api/status'],
      ['no scheme', { Authorization: TEST_TOKEN }, '/api/status'],
      ['empty bearer', { Authorization: 'Bearer ' }, '/api/status'],
      ['token in a cookie', { Cookie: `token=${TEST_TOKEN}` }, '/api/status'],
      ['token in X-Token', { 'X-Token': TEST_TOKEN }, '/api/status'],
      ['token in X-Api-Key', { 'X-Api-Key': TEST_TOKEN }, '/api/status'],
      ['token in the query string', {}, `/api/status?token=${TEST_TOKEN}`],
      ['token in the path', {}, `/api/status/${TEST_TOKEN}`],
    ]
    for (const [label, headers, path] of refused) {
      const res = await run.call('GET', path, { token: null, headers })
      expect(res.status, label).toBe(401)
    }
  })

  it('does not tell an unauthenticated caller which routes exist', async () => {
    const run = await start()
    for (const [method, path] of [
      ['GET', '/api/nope'],
      ['DELETE', '/api/status'],
      ['GET', '/api/plugins/x/y/z'],
      ['PATCH', '/api/secrets/gemini'],
    ] as const) {
      const res = await run.call(method, path, { token: null })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
    // and the same requests with the token are told the truth
    expect((await run.call('GET', '/api/nope')).status).toBe(404)
    expect((await run.call('DELETE', '/api/status')).status).toBe(405)
  })

  it('never lets an unauthenticated request reach the backend', async () => {
    const run = await start()
    for (const [method, path, body] of [
      ['POST', '/api/say', { text: 'hi' }],
      ['POST', '/api/stop', undefined],
      ['PUT', '/api/secrets/gemini', { value: 'v' }],
      ['DELETE', '/api/secrets/gemini', undefined],
      ['POST', '/api/plugins/image/start', undefined],
      ['POST', '/api/modes/dance/enter', undefined],
      ['POST', '/api/inject', {}],
      ['GET', '/api/config', undefined],
      ['GET', '/api/secrets', undefined],
    ] as const) {
      const res = await run.call(method, path, { token: null, ...(body ? { body } : {}) })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
    expect(run.backend.audit).toEqual([])
  })

  it('compares with crypto.timingSafeEqual on the HTTP path and on the WebSocket path', async () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    const run = await start()
    await run.call('GET', '/api/status', { token: 'wrong' + 'x'.repeat(50) })
    expect(spy).toHaveBeenCalledTimes(1)
    await run.call('GET', '/api/status')
    expect(spy).toHaveBeenCalledTimes(2)
    for (const call of spy.mock.calls)
      expect([(call[0] as Buffer).length, (call[1] as Buffer).length]).toEqual([32, 32])
    const socket = await TestSocket.connect(run)
    socket.close()
    expect(spy).toHaveBeenCalledTimes(3)
    await upgradeStatus(run, { token: 'not-the-token-1234' })
    expect(spy).toHaveBeenCalledTimes(4)
  })
})

describe('the failure limiter', () => {
  it('ten failures inside a minute earn a minute of 429s, even for the right token', async () => {
    let now = 1_000_000
    const run = await start({ now: () => now })
    for (let i = 1; i <= 10; i++) {
      const res = await run.call('GET', '/api/status', { token: `wrong-token-number-${i}` })
      expect(res.status, `failure ${i}`).toBe(401)
    }
    const blocked = await run.call('GET', '/api/status')
    expect(blocked.status).toBe(429)
    expect(errorCode(blocked)).toBe('rate_limited')
    expect(blocked.headers['retry-after']).toBe('60')
    expect(blocked.headers['cache-control']).toBe('no-store')
    // still blocked halfway through, with the time left
    now += 30_000
    const half = await run.call('GET', '/api/status')
    expect(half.status).toBe(429)
    expect(half.headers['retry-after']).toBe('30')
    // a blocked request is not evaluated, so it does not extend the block
    now += 29_000
    expect((await run.call('GET', '/api/status', { token: 'wrong' + 'z'.repeat(20) })).status).toBe(
      429
    )
    now += 1_001
    expect((await run.call('GET', '/api/status')).status).toBe(200)
    // and the count started afresh
    expect((await run.call('GET', '/api/status', { token: 'wrong' + 'z'.repeat(20) })).status).toBe(
      401
    )
    expect(run.logs.has('warn', 'too many failed console logins')).toBe(true)
  })

  it('failures older than a minute do not add up', async () => {
    let now = 5_000_000
    const run = await start({ now: () => now })
    for (let i = 0; i < 9; i++)
      expect((await run.call('GET', '/api/status', { token: null })).status).toBe(401)
    now += 61_000
    for (let i = 0; i < 9; i++)
      expect((await run.call('GET', '/api/status', { token: null })).status).toBe(401)
    expect((await run.call('GET', '/api/status')).status).toBe(200)
  })

  it('a missing token counts like a wrong one', async () => {
    const run = await start({ now: () => 42 })
    for (let i = 0; i < 10; i++) await run.call('GET', '/api/status', { token: null })
    expect((await run.call('GET', '/api/status')).status).toBe(429)
  })

  it('WebSocket failures count towards the same limit, and a blocked address cannot open a socket either', async () => {
    const run = await start({ now: () => 7 })
    for (let i = 0; i < 5; i++)
      expect(await upgradeStatus(run, { token: `wrong-ws-token-${i}` })).toBe(401)
    for (let i = 0; i < 5; i++)
      expect((await run.call('GET', '/api/status', { token: null })).status).toBe(401)
    expect((await run.call('GET', '/api/status')).status).toBe(429)
    expect(await upgradeStatus(run)).toBe(429)
  })

  it('refusals for Host, Origin, static files and unknown paths are not failures', async () => {
    const run = await start({ now: () => 9 })
    for (let i = 0; i < 20; i++) {
      expect((await run.call('GET', '/api/status', { origin: 'http://evil.example' })).status).toBe(
        403
      )
      expect((await run.call('GET', '/api/status', { host: 'evil.example' })).status).toBe(403)
      expect((await rawRequest(run.port, '/')).status).toBe(200)
      expect((await rawRequest(run.port, '/missing.js')).status).toBe(404)
    }
    expect((await run.call('GET', '/api/status')).status).toBe(200)
    expect((await run.call('GET', '/api/status', { token: null })).status).toBe(401)
  })
})

describe('FailureLimiter', () => {
  it('keeps addresses apart and slides its window', () => {
    let now = 0
    const limiter = new FailureLimiter({ now: () => now })
    for (let i = 0; i < 9; i++) expect(limiter.recordFailure('a')).toBe(false)
    expect(limiter.retryAfterMs('a')).toBe(0)
    expect(limiter.retryAfterMs('b')).toBe(0)
    expect(limiter.recordFailure('a')).toBe(true)
    expect(limiter.retryAfterMs('a')).toBe(60_000)
    expect(limiter.retryAfterMs('b')).toBe(0)
    now = 59_999
    expect(limiter.retryAfterMs('a')).toBe(1)
    now = 60_000
    expect(limiter.retryAfterMs('a')).toBe(0)
    // failures spread out never trip it
    for (let i = 0; i < 40; i++) {
      now += 7_000
      expect(limiter.recordFailure('c')).toBe(false)
    }
  })

  it('does not grow without bound', () => {
    let now = 0
    const limiter = new FailureLimiter({ now: () => now, maxKeys: 8 })
    for (let i = 0; i < 100; i++) {
      now += 1
      limiter.recordFailure(`address-${i}`)
    }
    expect(limiter.size).toBeLessThanOrEqual(8)
  })
})
