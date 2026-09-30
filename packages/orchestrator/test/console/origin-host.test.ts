import { afterEach, describe, expect, it } from 'vitest'
import { FakeBackend } from '../../src/console/fake.ts'
import { createConsoleServer } from '../../src/console/server.ts'
import {
  addressKey,
  allowedOrigins,
  isAllowedHost,
  isAllowedOrigin,
  parseExtraOrigins,
  rawPathOf,
  rawQueryOf,
} from '../../src/console/policy.ts'
import {
  INDEX_HTML,
  TestSocket,
  createCleanup,
  errorCode,
  rawRequest,
  rawSocket,
  startConsole,
  upgradeStatus,
} from './support.ts'

const cleanup = createCleanup()
afterEach(() => cleanup.run())

const start = (over: Parameters<typeof startConsole>[1] = {}) => startConsole(cleanup, over)

describe('the policy functions', () => {
  it('Host: exactly the two loopback names with the bound port, case-insensitive', () => {
    expect(isAllowedHost('127.0.0.1:5810', 5810)).toBe(true)
    expect(isAllowedHost('localhost:5810', 5810)).toBe(true)
    expect(isAllowedHost('LOCALHOST:5810', 5810)).toBe(true)
    for (const bad of [
      undefined,
      '',
      '127.0.0.1',
      'localhost',
      '127.0.0.1:1',
      '127.0.0.1:5810.evil.example',
      '127.0.0.1.evil.example:5810',
      'evil.example',
      'evil.example:5810',
      '[::1]:5810',
      '0.0.0.0:5810',
      '127.0.0.1:5810, evil.example',
      '127.0.0.1:5810@evil.example',
      'user@127.0.0.1:5810',
      '127.0.0.1:05810',
    ]) {
      expect(isAllowedHost(bad, 5810), String(bad)).toBe(false)
    }
  })

  it('Origin: this server, the extra origins, and a missing header; nothing else', () => {
    const allowed = allowedOrigins(
      5810,
      parseExtraOrigins(['http://127.0.0.1:5174', 'HTTP://Localhost:5175/'])
    )
    expect(isAllowedOrigin(undefined, allowed)).toBe(true)
    for (const ok of [
      'http://127.0.0.1:5810',
      'http://localhost:5810',
      'HTTP://LOCALHOST:5810',
      'http://127.0.0.1:5174',
      'http://localhost:5175',
    ]) {
      expect(isAllowedOrigin(ok, allowed), ok).toBe(true)
    }
    for (const bad of [
      'null',
      '',
      'http://evil.example',
      'http://evil.example:5810',
      'https://127.0.0.1:5810',
      'http://127.0.0.1',
      'http://127.0.0.1:5811',
      'http://127.0.0.1:5810.evil.example',
      'http://127.0.0.1:5810@evil.example',
      'http://localhost.evil.example:5810',
      'file://',
      'chrome-extension://abc',
      'http://127.0.0.1:5810/',
      'http://127.0.0.1:5810/path',
      'http://127.0.0.1:5810 http://evil.example',
      'http://127.0.0.1:5810, http://evil.example',
      'http://[::1]:5810',
    ]) {
      expect(isAllowedOrigin(bad, allowed), bad).toBe(false)
    }
  })

  it('extra origins are validated when the server is made, not trusted', () => {
    expect(
      parseExtraOrigins([
        'http://127.0.0.1:5174',
        'https://console.example:8443',
        'http://[::1]:5174',
      ])
    ).toEqual(['http://127.0.0.1:5174', 'https://console.example:8443', 'http://[::1]:5174'])
    for (const bad of [
      '*',
      'null',
      '',
      'http://x/path',
      'ftp://x',
      'javascript:alert(1)',
      'http://',
      'http://a b',
      'localhost:5174',
      '//x',
    ]) {
      expect(() => parseExtraOrigins([bad]), bad).toThrow(/invalid extra origin/)
    }
    expect(() =>
      createConsoleServer({ port: 0, backend: new FakeBackend(), extraOrigins: ['*'] })
    ).toThrow()
  })

  it('request targets and peer addresses', () => {
    expect(rawPathOf('/api/status?x=1#frag')).toBe('/api/status')
    expect(rawPathOf('/a%2Fb')).toBe('/a%2Fb')
    expect(rawPathOf('http://127.0.0.1/')).toBeNull()
    expect(rawPathOf('*')).toBeNull()
    expect(rawPathOf(undefined)).toBeNull()
    expect(rawQueryOf('/x?lines=3&a=b#frag')).toBe('lines=3&a=b')
    expect(rawQueryOf('/x')).toBe('')
    expect(addressKey('::ffff:127.0.0.1')).toBe('127.0.0.1')
    expect(addressKey('127.0.0.1')).toBe('127.0.0.1')
    expect(addressKey(undefined)).toBe('unknown')
  })
})

describe('Host header (DNS rebinding)', () => {
  it('the two loopback names work for API and static requests', async () => {
    const run = await start()
    for (const host of [
      `127.0.0.1:${run.port}`,
      `localhost:${run.port}`,
      `LOCALHOST:${run.port}`,
    ]) {
      expect((await run.call('GET', '/api/status', { host })).status, host).toBe(200)
      expect((await rawRequest(run.port, '/', { host })).status, host).toBe(200)
    }
  })

  it('anything else is 403, with a valid token and without, for every kind of route', async () => {
    const run = await start()
    const hosts = [
      'evil.example',
      `evil.example:${run.port}`,
      '127.0.0.1',
      'localhost',
      `[::1]:${run.port}`,
      `127.0.0.1.evil.example:${run.port}`,
      `127.0.0.1:${run.port}.evil.example`,
      `0.0.0.0:${run.port}`,
      `127.0.0.1:1`,
    ]
    for (const host of hosts) {
      for (const [method, path] of [
        ['GET', '/api/status'],
        ['POST', '/api/say'],
        ['GET', '/api/plugins/speech/logs'],
        ['GET', '/'],
        ['GET', '/assets/app.js'],
        ['GET', '/some/route'],
      ] as const) {
        for (const token of [undefined, null] as const) {
          const res = await run.call(method, path, {
            host,
            ...(token === null ? { token } : {}),
            ...(method === 'POST' ? { body: { text: 'x' } } : {}),
          })
          expect(res.status, `${host} ${method} ${path}`).toBe(403)
          expect(res.text(), `${host} ${path}`).not.toContain('<title>')
          expect(res.text(), `${host} ${path}`).not.toContain('console.log')
          expect(res.headers['x-content-type-options']).toBe('nosniff')
        }
      }
      // API refusals are ApiErrors; static ones are plain text
      expect(errorCode(await run.call('GET', '/api/status', { host }))).toBe('forbidden_host')
    }
    expect(run.backend.audit).toEqual([])
  })

  it('a missing Host header is refused too', async () => {
    const run = await start()
    const raw = await rawSocket(
      run.port,
      `GET /api/status HTTP/1.1\r\nAuthorization: Bearer ${run.token}\r\nConnection: close\r\n\r\n`
    )
    expect(raw).toMatch(/^HTTP\/1\.1 400/)
    const http10 = await rawSocket(
      run.port,
      `GET /api/status HTTP/1.0\r\nAuthorization: Bearer ${run.token}\r\n\r\n`
    )
    expect(http10).toMatch(/^HTTP\/1\.[01] 403/)
    expect(http10).not.toContain('"plugins"')
  })

  it('a bad Host is refused for a WebSocket upgrade before the token is looked at', async () => {
    const run = await start()
    expect(await upgradeStatus(run, { host: 'evil.example' })).toBe(403)
    expect(await upgradeStatus(run, { host: 'evil.example', token: null })).toBe(403)
    expect(await upgradeStatus(run, { host: `127.0.0.1.evil.example:${run.port}` })).toBe(403)
    expect(await upgradeStatus(run, { host: `localhost:${run.port}` })).toBe('connected')
  })
})

describe('Origin header (a page on another site)', () => {
  it('a cross-origin page is refused even with a valid token, on every route', async () => {
    const run = await start()
    for (const origin of [
      'http://evil.example',
      `http://evil.example:${run.port}`,
      'null',
      'https://127.0.0.1:' + run.port,
      'http://127.0.0.1',
      `http://127.0.0.1:${run.port}.evil.example`,
      'chrome-extension://abcdef',
      `http://127.0.0.1:${run.port}/`,
    ]) {
      for (const [method, path, body] of [
        ['GET', '/api/status', undefined],
        ['GET', '/api/secrets', undefined],
        ['POST', '/api/say', { text: 'hello' }],
        ['PUT', '/api/secrets/gemini', { value: 'v' }],
        ['DELETE', '/api/secrets/gemini', undefined],
        ['POST', '/api/plugins/image/start', undefined],
      ] as const) {
        const res = await run.call(method, path, { origin, ...(body ? { body } : {}) })
        expect(res.status, `${origin} ${method} ${path}`).toBe(403)
        expect(errorCode(res)).toBe('forbidden_origin')
        expect(res.text()).not.toContain('"plugins"')
        expect(res.text()).not.toContain('"secrets"')
      }
      // static files too: the page itself is not for other origins
      const page = await rawRequest(run.port, '/', { headers: { Origin: origin } })
      expect(page.status, origin).toBe(403)
      expect(page.text()).not.toContain('<title>')
    }
    expect(run.backend.audit).toEqual([])
  })

  it('an empty Origin header is not the same as none', async () => {
    const run = await start()
    expect((await run.call('GET', '/api/status', { origin: '' })).status).toBe(403)
  })

  it("this server's own origins and the configured extra origins work; a request without Origin needs the token", async () => {
    const run = await start({ extraOrigins: ['http://127.0.0.1:5174', 'http://localhost:5174'] })
    for (const origin of [
      run.origin,
      `http://localhost:${run.port}`,
      'http://127.0.0.1:5174',
      'http://localhost:5174',
    ]) {
      expect((await run.call('GET', '/api/status', { origin })).status, origin).toBe(200)
    }
    expect((await run.call('GET', '/api/status')).status).toBe(200) // no Origin, token
    const noToken = await run.call('GET', '/api/status', { token: null }) // no Origin, no token
    expect(noToken.status).toBe(401)
    // an extra origin is not a way round the token
    expect(
      (await run.call('GET', '/api/status', { origin: 'http://127.0.0.1:5174', token: null }))
        .status
    ).toBe(401)
    // and one that is not listed stays out
    expect((await run.call('GET', '/api/status', { origin: 'http://127.0.0.1:5175' })).status).toBe(
      403
    )
  })

  it('applies to WebSocket upgrades: a cross-origin page with a valid token cannot connect', async () => {
    const run = await start({ extraOrigins: ['http://127.0.0.1:5174'] })
    for (const origin of [
      'http://evil.example',
      `http://evil.example:${run.port}`,
      'null',
      'https://127.0.0.1:' + run.port,
      'chrome-extension://x',
    ]) {
      expect(await upgradeStatus(run, { origin }), origin).toBe(403)
    }
    expect(run.server.clientCount).toBe(0)
    expect(await upgradeStatus(run, { origin: run.origin })).toBe('connected')
    expect(await upgradeStatus(run, { origin: 'http://127.0.0.1:5174' })).toBe('connected')
    expect(await upgradeStatus(run, {})).toBe('connected') // non-browser tool: no Origin, valid token
    expect(await upgradeStatus(run, { token: null })).toBe(401)
  })

  it('a refused socket answers with an ApiError body', async () => {
    const run = await start()
    try {
      await TestSocket.connect(run, { origin: 'http://evil.example' })
      expect.unreachable()
    } catch (err) {
      const body = JSON.parse((err as { body: string }).body) as { error: { code: string } }
      expect(body.error.code).toBe('forbidden_origin')
    }
  })
})

describe('no CORS, ever', () => {
  it('no response of any kind carries an Access-Control header, and preflights get nothing', async () => {
    const run = await start()
    const responses = [
      await run.call('GET', '/api/status'),
      await run.call('GET', '/api/status', { token: null }),
      await run.call('GET', '/api/status', { origin: 'http://evil.example' }),
      await run.call('GET', '/api/status', { host: 'evil.example' }),
      await run.call('GET', '/api/nope'),
      await run.call('DELETE', '/api/status'),
      await run.call('POST', '/api/say', { body: { text: '' } }),
      await rawRequest(run.port, '/'),
      await rawRequest(run.port, '/assets/app.js'),
      await rawRequest(run.port, '/missing.js'),
      await rawRequest(run.port, '/', { headers: { Origin: 'http://evil.example' } }),
      await rawRequest(run.port, '/api/status', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://evil.example',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      }),
      await rawRequest(run.port, '/api/say', {
        method: 'OPTIONS',
        headers: {
          Origin: run.origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization, content-type',
        },
      }),
    ]
    for (const res of responses) {
      for (const name of Object.keys(res.headers))
        expect(name.startsWith('access-control-'), name).toBe(false)
    }
    // the preflight of a foreign page is refused outright; even a same-origin one gets no allowance
    expect(responses[11]?.status).toBe(403)
    expect([401, 405]).toContain(responses[12]?.status)
  })
})

describe('the app shell does not depend on the token', () => {
  it('serves the page without any credentials, and the page has no token in it', async () => {
    const run = await start()
    const res = await rawRequest(run.port, '/')
    expect(res.status).toBe(200)
    expect(res.text()).toBe(INDEX_HTML)
    expect(res.text()).not.toContain(run.token)
  })
})
