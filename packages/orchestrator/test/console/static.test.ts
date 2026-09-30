import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONSOLE_CSP, consoleCsp, isAssetOrigin } from '../../src/console/policy.ts'
import { decodeStaticSegments, isSafeSegment, staticContentType } from '../../src/console/static.ts'
import { INDEX_HTML, createCleanup, rawRequest, rawSocket, startConsole } from './support.ts'

const cleanup = createCleanup()
afterEach(() => cleanup.run())

const start = (over: Parameters<typeof startConsole>[1] = {}) => startConsole(cleanup, over)

/** The policy the console must be served with, spelled out here so that a change has to be deliberate. */
const EXPECTED_CSP =
  "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

describe('path rules', () => {
  it('segments: nothing that could leave the folder, name a device or hide a stream', () => {
    for (const ok of [
      'index.html',
      'app-3f9a1c.js',
      'a.b.c',
      'Fira Sans.woff2',
      'x@2x.png',
      'ünï.css',
    ])
      expect(isSafeSegment(ok), ok).toBe(true)
    for (const bad of [
      '',
      '.',
      '..',
      '.env',
      '.git',
      'a/b',
      'a\\b',
      'a\0b',
      'a\nb',
      'C:',
      'a:b',
      'a*b',
      'a?b',
      'a<b',
      'a"b',
      'a|b',
      'con',
      'NUL.txt',
      'com1',
      'LPT9.log',
      'trailing.',
      'trailing ',
      'x'.repeat(256),
    ]) {
      expect(isSafeSegment(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('a path is decoded segment by segment, once', () => {
    expect(decodeStaticSegments('/')).toEqual([])
    expect(decodeStaticSegments('/assets/app.js')).toEqual(['assets', 'app.js'])
    expect(decodeStaticSegments('/a%20b.txt')).toEqual(['a b.txt'])
    expect(decodeStaticSegments('/%252e%252e/x')).toEqual(['%2e%2e', 'x']) // decoded once: a file called "%2e%2e", not ".."
    for (const bad of [
      '/%2e%2e/x',
      '/..%2fx',
      '/a%5cb',
      '/a%00b',
      '/%',
      '/a%zz',
      '/a//b',
      '/./x',
      '/x/../y',
      'no-slash',
      `/${'a/'.repeat(40)}`,
      `/${'a'.repeat(3000)}`,
    ]) {
      expect(decodeStaticSegments(bad), bad.slice(0, 40)).toBeNull()
    }
  })

  it('content types', () => {
    expect(staticContentType('a.html')).toBe('text/html; charset=utf-8')
    expect(staticContentType('a.JS')).toBe('text/javascript; charset=utf-8')
    expect(staticContentType('a.css')).toBe('text/css; charset=utf-8')
    expect(staticContentType('a.woff2')).toBe('font/woff2')
    expect(staticContentType('a.unknown')).toBe('application/octet-stream')
    expect(staticContentType('noext')).toBe('application/octet-stream')
  })
})

describe('the console build', () => {
  it('serves index.html at / without a token, with the policy and the other security headers', async () => {
    const run = await start()
    for (const p of ['/', '/index.html']) {
      const res = await rawRequest(run.port, p)
      expect(res.status, p).toBe(200)
      expect(res.text()).toBe(INDEX_HTML)
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.headers['content-security-policy']).toBe(EXPECTED_CSP)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['referrer-policy']).toBe('no-referrer')
      expect(res.headers['x-frame-options']).toBe('DENY')
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.headers.etag).toBeTruthy()
    }
    expect(CONSOLE_CSP).toBe(EXPECTED_CSP)
  })

  it('pictures a mode shows may come from the stage server on this machine, and from nowhere else', async () => {
    const run = await start({ assetOrigin: 'http://127.0.0.1:5810' })
    const res = await rawRequest(run.port, '/')
    const csp = res.headers['content-security-policy'] as string
    expect(csp).toContain("img-src 'self' data: http://127.0.0.1:5810;")
    expect(csp).toBe(consoleCsp('http://127.0.0.1:5810'))
    // everything else is the plain policy
    expect(csp.replace(' http://127.0.0.1:5810', '')).toBe(EXPECTED_CSP)
    expect(consoleCsp()).toBe(EXPECTED_CSP)
    for (const ok of ['http://127.0.0.1:5810', 'http://localhost:80', 'http://localhost:65535'])
      expect(isAssetOrigin(ok), ok).toBe(true)
    for (const bad of [
      'https://127.0.0.1:5810',
      'http://evil.example:5810',
      'http://127.0.0.1',
      'http://127.0.0.1:5810/',
      'http://127.0.0.1:5810 http://evil.example',
      'http://127.0.0.1:5810; script-src *',
      '*',
      '',
    ]) {
      expect(isAssetOrigin(bad), bad).toBe(false)
      expect(() => consoleCsp(bad), bad).toThrow('not a local asset origin')
    }
  })

  it('the policy leaves no way to load or run anything from elsewhere', () => {
    const directives = Object.fromEntries(
      EXPECTED_CSP.split(';')
        .map((d) => d.trim().split(/\s+/))
        .map(([name, ...values]) => [name, values])
    )
    expect(directives['default-src']).toEqual(["'self'"])
    expect(directives['script-src']).toBeUndefined() // falls back to default-src 'self': no inline, no eval, no other host
    expect(directives['object-src']).toEqual(["'none'"])
    expect(directives['base-uri']).toEqual(["'none'"])
    expect(directives['frame-ancestors']).toEqual(["'none'"])
    expect(EXPECTED_CSP).not.toContain('unsafe-eval')
    expect(EXPECTED_CSP).not.toMatch(/https?:/)
    // no bare wildcard source anywhere (a wildcard port on a loopback name is fine)
    for (const [name, values] of Object.entries(directives)) expect(values, name).not.toContain('*')
    expect(directives['connect-src']).toEqual(["'self'", 'ws://127.0.0.1:*', 'ws://localhost:*'])
  })

  it('every response carries the policy: pages, files, errors, API answers and refusals', async () => {
    const run = await start()
    const responses = [
      await rawRequest(run.port, '/'),
      await rawRequest(run.port, '/assets/app.js'),
      await rawRequest(run.port, '/missing.js'),
      await run.call('GET', '/api/status'),
      await run.call('GET', '/api/status', { token: null }),
      await run.call('GET', '/api/nope'),
      await run.call('GET', '/api/status', { origin: 'http://evil.example' }),
      await rawRequest(run.port, '/', { host: 'evil.example' }),
    ]
    for (const res of responses) {
      expect(res.headers['content-security-policy']).toBe(EXPECTED_CSP)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['referrer-policy']).toBe('no-referrer')
    }
    // API responses are never cached
    for (const res of responses.slice(3, 7)) expect(res.headers['cache-control']).toBe('no-store')
  })

  it('serves scripts, styles and maps with the right types', async () => {
    const run = await start()
    expect((await rawRequest(run.port, '/assets/app.js')).headers['content-type']).toBe(
      'text/javascript; charset=utf-8'
    )
    expect((await rawRequest(run.port, '/assets/app.css')).headers['content-type']).toBe(
      'text/css; charset=utf-8'
    )
    expect((await rawRequest(run.port, '/assets/app.js.map')).headers['content-type']).toBe(
      'application/json'
    )
    expect((await rawRequest(run.port, '/favicon.ico')).headers['content-type']).toBe(
      'image/x-icon'
    )
    expect((await rawRequest(run.port, '/assets/app.js')).text()).toBe('console.log("app")')
  })

  it('falls back to the app shell only for paths without a file extension', async () => {
    const run = await start()
    for (const p of [
      '/settings',
      '/a/b/c',
      '/assets',
      '/assets/',
      '/some-route/',
      '/apix',
      '/API/status',
    ]) {
      const res = await rawRequest(run.port, p)
      expect(res.status, p).toBe(200)
      expect(res.text(), p).toBe(INDEX_HTML)
    }
    for (const p of [
      '/missing.js',
      '/assets/missing.css',
      '/some.route',
      '/nothing.png',
      '/assets/app.js.bak',
    ]) {
      const res = await rawRequest(run.port, p)
      expect(res.status, p).toBe(404)
      expect(res.text(), p).not.toContain('<title>')
    }
  })

  it('/api is never the app shell: without a token it is a 401, not a page', async () => {
    const run = await start()
    for (const p of ['/api', '/api/', '/api/anything', '/api/status/x']) {
      const res = await rawRequest(run.port, p)
      expect(res.status, p).toBe(401)
      expect(res.text(), p).not.toContain('<title>')
    }
  })

  it('answers HEAD and conditional requests', async () => {
    const run = await start()
    const head = await rawRequest(run.port, '/', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(INDEX_HTML.length))
    expect(head.body.length).toBe(0)
    const etag = head.headers.etag as string
    const cond = await rawRequest(run.port, '/', { headers: { 'If-None-Match': etag } })
    expect(cond.status).toBe(304)
    expect(cond.body.length).toBe(0)
    expect(cond.headers['content-security-policy']).toBe(EXPECTED_CSP)
    expect(
      (await rawRequest(run.port, '/', { headers: { 'If-None-Match': '"other"' } })).status
    ).toBe(200)
    expect((await rawRequest(run.port, '/', { headers: { 'If-None-Match': '*' } })).status).toBe(
      304
    )
  })

  it('only GET and HEAD: everything else on a page is 405', async () => {
    const run = await start()
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await rawRequest(run.port, '/', { method })
      expect(res.status, method).toBe(405)
      expect(res.headers.allow).toBe('GET, HEAD')
    }
  })

  it.each([
    '/../outside.txt',
    '/%2e%2e/outside.txt',
    '/%2E%2E/outside.txt',
    '/assets/../../outside.txt',
    '/assets/%2e%2e/%2e%2e/outside.txt',
    '/..%2foutside.txt',
    '/..%2Foutside.txt',
    '/assets/..%2f..%2foutside.txt',
    '/%252e%252e/outside.txt',
    '/..\\outside.txt',
    '/assets/..\\..\\outside.txt',
    '/%5coutside.txt',
    '/%5c..%5coutside.txt',
    '/C:/Windows/win.ini',
    '/C%3a/Windows/win.ini',
    '/outside.txt%00.html',
    '/%00',
    '/.env',
    '/assets/.env',
    '/%2eenv',
    '/assets//app.js',
    '//assets/app.js',
    '/./index.html',
    '/assets/./app.js',
    '/%',
    '/a%zz',
    '/assets/app.js::$DATA',
    '/assets/app.js%3a%3a$DATA',
    '/CON',
    '/assets/NUL.js',
  ])('404 for %s: never a file outside the build, never a hidden one', async (p) => {
    const run = await start()
    const res = await rawRequest(run.port, p)
    expect(res.status).toBe(404)
    expect(res.text()).not.toContain('outside the static folder')
    expect(res.text()).not.toContain('SECRET')
  })

  it('does not follow a junction out of the build folder', async (ctx) => {
    const run = await start()
    fs.mkdirSync(path.join(run.root, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(run.root, 'lib', 'secret.txt'), 'outside via junction')
    try {
      fs.symlinkSync(path.join(run.root, 'lib'), path.join(run.staticDir, 'escape'), 'junction')
    } catch {
      return ctx.skip()
    }
    const res = await rawRequest(run.port, '/escape/secret.txt')
    expect(res.status).toBe(404)
    expect(res.text()).not.toContain('outside via junction')
  })

  it('answers 503 with a hint while the console has not been built, and picks a build up when it appears', async () => {
    const run = await start({ build: false })
    for (const method of ['GET', 'HEAD']) {
      const res = await rawRequest(run.port, '/', { method })
      expect(res.status).toBe(503)
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(res.headers['retry-after']).toBeTruthy()
      if (method === 'GET') {
        expect(res.text()).toMatch(/has not been built/)
        expect(res.text()).toMatch(/npm run build -w @animatus\/console/)
      } else {
        expect(res.body.length).toBe(0)
      }
    }
    expect((await rawRequest(run.port, '/some/route')).status).toBe(503)
    // the API works without a build
    expect((await run.call('GET', '/api/status')).status).toBe(200)

    fs.mkdirSync(run.staticDir, { recursive: true })
    const noIndex = await rawRequest(run.port, '/')
    expect(noIndex.status).toBe(503)
    expect(noIndex.text()).toMatch(/index\.html/)
    fs.writeFileSync(path.join(run.staticDir, 'index.html'), INDEX_HTML)
    const ok = await rawRequest(run.port, '/')
    expect(ok.status).toBe(200)
    expect(ok.text()).toBe(INDEX_HTML)
  })

  it('answers 503 when no folder is configured at all', async () => {
    // an explicit undefined replaces the folder the helper would otherwise create
    const run = await start({ staticDir: undefined })
    const res = await rawRequest(run.port, '/')
    expect(res.status).toBe(503)
    expect(res.text()).toMatch(/has not been built/)
  })

  it('a request target that is not origin-form is a 400, and junk does not hurt the server', async () => {
    const run = await start()
    const absolute = await rawSocket(
      run.port,
      `GET http://127.0.0.1:${run.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${run.port}\r\nConnection: close\r\n\r\n`
    )
    expect(absolute).toMatch(/^HTTP\/1\.1 400/)
    expect(absolute).not.toContain('<title>')
    const junk = await rawSocket(run.port, 'THIS IS NOT HTTP\r\n\r\n', 500)
    expect(junk).toMatch(/^HTTP\/1\.1 400/)
    expect((await run.call('GET', '/api/status')).status).toBe(200)
  })
})
