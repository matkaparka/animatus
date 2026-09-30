import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAssetHandler,
  decodeUrlPathSegments,
  isPathInside,
  isSafeSegment,
  parseRange,
} from '../../src/stage/assets.ts'
import {
  collectLogger,
  delay,
  makeTempDir,
  pcmPattern,
  rawRequest,
  writeTree,
} from '../_stage-support/fixtures.ts'
import type { RawResponse } from '../_stage-support/fixtures.ts'

// ───────────────────────────── pure helpers ─────────────────────────────

describe('isSafeSegment', () => {
  it.each([
    'hello.wav',
    'a b.vrma',
    'caf\xe9.ogg',
    'nod_2.vrma',
    '100%.txt',
    "it's.mp3",
    'a..b.wav',
    'UPPER.PNG',
  ])('accepts %s', (name) => {
    expect(isSafeSegment(name)).toBe(true)
  })

  it.each([
    '',
    '.',
    '..',
    '...',
    '.hidden',
    'a/b',
    'a\\b',
    'a:b',
    'C:',
    'c:foo.wav',
    'file.txt::$DATA',
    'nul\0.txt',
    'a\nb',
    'a\tb',
    'wild*card',
    'what?.wav',
    'a<b',
    'a>b',
    'a|b',
    'a"b',
    'trailing.',
    'trailing ',
    'CON',
    'con.txt',
    'Nul.vrma',
    'PRN',
    'aux.wav',
    'COM1',
    'com9.txt',
    'LPT3.wav',
    'conin$',
    'CON .txt',
    'x'.repeat(256),
  ])('rejects %j', (name) => {
    expect(isSafeSegment(name)).toBe(false)
  })

  it('does not treat lookalike names as devices', () => {
    for (const name of ['console.txt', 'auxiliary.wav', 'com10.txt', 'lpt.wav', 'nullable.vrma']) {
      expect(isSafeSegment(name)).toBe(true)
    }
  })
})

describe('decodeUrlPathSegments', () => {
  it('decodes each segment exactly once', () => {
    expect(decodeUrlPathSegments('/asset/lib/a%20b/caf%C3%A9.wav')).toEqual([
      'asset',
      'lib',
      'a b',
      'caf\xe9.wav',
    ])
    expect(decodeUrlPathSegments('/asset/lib/100%25.wav')).toEqual(['asset', 'lib', '100%.wav'])
    // %252e is a literal "%2e" after the one decode: harmless text, never a dot segment
    expect(decodeUrlPathSegments('/asset/lib/%252e%252e')).toEqual(['asset', 'lib', '%2e%2e'])
    expect(decodeUrlPathSegments('/')).toEqual([])
  })

  it.each([
    'asset/lib/x',
    '/asset/lib//x',
    '/asset/lib/x/',
    '/asset/lib/../x',
    '/asset/lib/%2e%2e/x',
    '/asset/lib/%2E./x',
    '/asset/lib/a%2fb',
    '/asset/lib/a%5cb',
    '/asset/lib/%00',
    '/asset/lib/%',
    '/asset/lib/%E0%A4%A',
    `/asset/${'a/'.repeat(40)}x`,
    `/asset/lib/${'a'.repeat(3000)}`,
  ])('rejects %s', (raw) => {
    expect(decodeUrlPathSegments(raw)).toBeNull()
  })
})

describe('parseRange', () => {
  it.each([
    ['bytes=0-9', 100, { kind: 'range', start: 0, end: 9 }],
    ['bytes=10-', 100, { kind: 'range', start: 10, end: 99 }],
    ['bytes=-10', 100, { kind: 'range', start: 90, end: 99 }],
    ['bytes=-500', 100, { kind: 'range', start: 0, end: 99 }],
    ['bytes=50-5000', 100, { kind: 'range', start: 50, end: 99 }],
    ['bytes=99-99', 100, { kind: 'range', start: 99, end: 99 }],
    ['BYTES=0-0', 100, { kind: 'range', start: 0, end: 0 }],
    ['bytes=100-', 100, { kind: 'unsatisfiable' }],
    ['bytes=100-200', 100, { kind: 'unsatisfiable' }],
    ['bytes=-0', 100, { kind: 'unsatisfiable' }],
    ['bytes=0-', 0, { kind: 'unsatisfiable' }],
    ['bytes=-5', 0, { kind: 'unsatisfiable' }],
    ['bytes=9-0', 100, { kind: 'none' }],
    ['bytes=0-5,10-15', 100, { kind: 'none' }],
    ['bytes=-', 100, { kind: 'none' }],
    ['bytes=abc', 100, { kind: 'none' }],
    ['items=0-5', 100, { kind: 'none' }],
    ['bytes=0-5 ', 100, { kind: 'range', start: 0, end: 5 }],
    ['bytes=1234567890123456789-', 100, { kind: 'none' }],
    [undefined, 100, { kind: 'none' }],
  ] as const)('%s on %i bytes', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected)
  })
})

describe('isPathInside', () => {
  const root = path.resolve('some', 'root')
  it('is true only for strict descendants', () => {
    expect(isPathInside(root, path.join(root, 'a', 'b.txt'))).toBe(true)
    expect(isPathInside(root, root)).toBe(false)
    expect(isPathInside(root, path.dirname(root))).toBe(false)
    expect(isPathInside(root, path.join(root, '..', 'root-sibling', 'x'))).toBe(false)
    expect(isPathInside(root, path.join(root, '..', 'elsewhere'))).toBe(false)
  })
})

// ───────────────────────────── the handler over HTTP ─────────────────────────────

const MiB = 1024 * 1024
const track = pcmPattern(1000, 11) // 1000 bytes, byte i = (i * 31 + 11) & 0xff

let tmp: ReturnType<typeof makeTempDir>
let root: string
let outside: string
let server: http.Server
let port: number
let junctionWorks = false
let fileSymlinkWorks = false
const libraries: Record<string, string> = {}
const { logger: handlerLogger, entries: handlerLog } = collectLogger()

const md5 = (data: Uint8Array) => createHash('md5').update(data).digest('hex')

beforeAll(async () => {
  tmp = makeTempDir()
  root = path.join(tmp.dir, 'lib')
  outside = path.join(tmp.dir, 'outside')
  const plainFiles: Record<string, string | Uint8Array> = {
    'hello.wav': track,
    'sub/dir/track.mp3': track,
    'caf\xe9 song.ogg': track,
    'empty.bin': new Uint8Array(0),
    'big.bin': pcmPattern(3 * MiB, 5),
    '.hidden.txt': 'hidden',
    'notes.txt': 'plain text',
    'data.json': '{"a":1}',
    'x.lrc': '[00:01.00]la',
    'weird.xyz': 'x',
    'script.html': '<script>alert(1)</script>',
    'image.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  }
  for (const name of [
    'model.vrm',
    'clip.vrma',
    'glb.glb',
    'a.mp3',
    'a.ogg',
    'a.flac',
    'a.m4a',
    'a.png',
    'pic.PNG',
    'a.jpg',
    'a.jpeg',
    'a.webp',
    'a.gif',
  ]) {
    plainFiles[name] = name
  }
  writeTree(root, plainFiles)
  writeTree(path.join(tmp.dir, 'other'), { 'only-here.txt': 'other library' })
  writeTree(outside, { 'secret.txt': 'top secret' })

  try {
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction')
    junctionWorks = fs.existsSync(path.join(root, 'link', 'secret.txt'))
  } catch {
    junctionWorks = false
  }
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'file-link.txt'), 'file')
    fileSymlinkWorks = fs.readFileSync(path.join(root, 'file-link.txt'), 'utf8') === 'top secret'
  } catch {
    fileSymlinkWorks = false
  }

  libraries.lib = root
  libraries.other = path.join(tmp.dir, 'other')
  libraries.gone = path.join(tmp.dir, 'does-not-exist')
  libraries.blank = ''

  const handler = createAssetHandler(libraries, handlerLogger)
  server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const cut = url.search(/[?#]/)
    handler(req, res, cut === -1 ? url : url.slice(0, cut)).then((handled) => {
      if (!handled) {
        res.statusCode = 599
        res.end('not an asset url')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  tmp?.remove()
})

const get = (
  rawPath: string,
  headers?: Record<string, string>,
  method = 'GET'
): Promise<RawResponse> => rawRequest(port, rawPath, { method, ...(headers ? { headers } : {}) })

describe('serving files', () => {
  it('serves a file with a body, length and the security headers, and no CORS', async () => {
    const r = await get('/asset/lib/hello.wav')
    expect(r.status).toBe(200)
    expect(md5(r.body)).toBe(md5(track))
    expect(r.headers['content-length']).toBe('1000')
    expect(r.headers['content-type']).toBe('audio/wav')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(r.headers['accept-ranges']).toBe('bytes')
    expect(r.headers['cache-control']).toBe('no-cache')
    expect(r.headers.etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
    expect(r.headers['last-modified']).toBeTruthy()
    for (const name of Object.keys(r.headers))
      expect(name.startsWith('access-control-')).toBe(false)
  })

  it.each([
    ['model.vrm', 'model/gltf-binary'],
    ['clip.vrma', 'model/gltf-binary'],
    ['glb.glb', 'model/gltf-binary'],
    ['hello.wav', 'audio/wav'],
    ['a.mp3', 'audio/mpeg'],
    ['a.ogg', 'audio/ogg'],
    ['a.flac', 'audio/flac'],
    ['a.m4a', 'audio/mp4'],
    ['a.png', 'image/png'],
    ['pic.PNG', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.webp', 'image/webp'],
    ['a.gif', 'image/gif'],
    ['data.json', 'application/json'],
    ['x.lrc', 'text/plain; charset=utf-8'],
    ['notes.txt', 'text/plain; charset=utf-8'],
    ['weird.xyz', 'application/octet-stream'],
    ['script.html', 'application/octet-stream'],
    ['image.svg', 'application/octet-stream'],
  ])('content type of %s is %s', async (name, type) => {
    const r = await get(`/asset/lib/${name}`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe(type)
  })

  it('serves nested paths, percent-encoded names and ignores a query string', async () => {
    expect((await get('/asset/lib/sub/dir/track.mp3')).status).toBe(200)
    const spaced = await get('/asset/lib/caf%C3%A9%20song.ogg')
    expect(spaced.status).toBe(200)
    expect(spaced.headers['content-type']).toBe('audio/ogg')
    expect(md5(spaced.body)).toBe(md5(track))
    expect((await get('/asset/lib/hello.wav?v=3&x=%2e%2e')).status).toBe(200)
  })

  it('keeps libraries apart', async () => {
    expect((await get('/asset/other/only-here.txt')).status).toBe(200)
    expect((await get('/asset/lib/only-here.txt')).status).toBe(404)
    expect((await get('/asset/other/hello.wav')).status).toBe(404)
  })

  it('serves an empty file with length 0', async () => {
    const r = await get('/asset/lib/empty.bin')
    expect(r.status).toBe(200)
    expect(r.headers['content-length']).toBe('0')
    expect(r.body.length).toBe(0)
    expect((await get('/asset/lib/empty.bin', { Range: 'bytes=0-' })).status).toBe(416)
  })

  it('streams big files intact', async () => {
    const r = await get('/asset/lib/big.bin')
    expect(r.status).toBe(200)
    expect(r.body.length).toBe(3 * MiB)
    expect(md5(r.body)).toBe(md5(pcmPattern(3 * MiB, 5)))
  })

  it('survives clients that abort a big download, and stays responsive', async () => {
    await new Promise<void>((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/asset/lib/big.bin', agent: false },
        (res) => {
          res.once('data', () => {
            req.destroy()
            resolve()
          })
        }
      )
      req.on('error', () => {})
    })
    await delay(100)
    expect((await get('/asset/lib/hello.wav')).status).toBe(200)
    // a few more aborts in a row
    await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<void>((resolve) => {
            const req = http.get(
              { host: '127.0.0.1', port, path: '/asset/lib/big.bin', agent: false },
              (res) => {
                res.once('data', () => {
                  res.destroy()
                  resolve()
                })
              }
            )
            req.on('error', () => resolve())
          })
      )
    )
    await delay(100)
    expect((await get('/asset/lib/big.bin', { Range: 'bytes=0-9' })).status).toBe(206)
  })

  it('answers many parallel range requests correctly', async () => {
    const answers = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        get('/asset/lib/hello.wav', { Range: `bytes=${i * 10}-${i * 10 + 9}` })
      )
    )
    answers.forEach((r, i) => {
      expect(r.status).toBe(206)
      expect(Buffer.compare(r.body, Buffer.from(track.subarray(i * 10, i * 10 + 10)))).toBe(0)
    })
  })
})

describe('rejecting everything that is not a plain file in a known library', () => {
  const traversal = [
    '/asset/lib/../outside/secret.txt',
    '/asset/lib/sub/../../outside/secret.txt',
    '/asset/lib/%2e%2e/outside/secret.txt',
    '/asset/lib/%2E%2E/outside/secret.txt',
    '/asset/lib/.%2e/outside/secret.txt',
    '/asset/lib/%2e./outside/secret.txt',
    '/asset/lib/%252e%252e/outside/secret.txt',
    '/asset/lib/%252e%252e%252foutside%252fsecret.txt',
    '/asset/lib/..%2foutside%2fsecret.txt',
    '/asset/lib/..%2Foutside%2Fsecret.txt',
    '/asset/lib/%2e%2e%2foutside%2fsecret.txt',
    '/asset/lib/..%5coutside%5csecret.txt',
    '/asset/lib/..\\outside\\secret.txt',
    '/asset/lib/sub\\..\\..\\outside\\secret.txt',
    '/asset/lib/sub%5c..%5c..%5coutside%5csecret.txt',
    '/asset/lib/%5coutside%5csecret.txt',
    '/asset/lib/%5c%5cserver%5cshare%5cx',
    '/asset/lib/\\\\server\\share\\x',
    '/asset/lib/%2foutside/secret.txt',
    '/asset/lib/%2f%2foutside%2fsecret.txt',
    '/asset/lib//hello.wav',
    '/asset/lib/sub//dir/track.mp3',
    '/asset/lib/./hello.wav',
    '/asset/lib/sub/./dir/track.mp3',
    '/asset/lib/hello.wav/',
    '/asset/lib/hello.wav/.',
    '/asset/lib/hello.wav/..',
    '/asset/lib/C:/Windows/win.ini',
    '/asset/lib/C%3A/Windows/win.ini',
    '/asset/lib/C%3a%5cWindows%5cwin.ini',
    '/asset/lib/c:hello.wav',
    '/asset/lib/hello.wav%00',
    '/asset/lib/hello.wav%00.txt',
    '/asset/lib/%00hello.wav',
    '/asset/lib/hello.wav::$DATA',
    '/asset/lib/hello.wav:stream',
    '/asset/lib/hello.wav.',
    '/asset/lib/hello.wav%20',
    '/asset/lib/hello.wav%2e',
    '/asset/lib/hello.wa*',
    '/asset/lib/hell?.wav',
    '/asset/lib/hell%3f.wav',
    '/asset/lib/CON',
    '/asset/lib/nul.txt',
    '/asset/lib/aux.wav',
    '/asset/lib/COM1',
    '/asset/lib/.hidden.txt',
    '/asset/lib/%2ehidden.txt',
    '/asset/lib/%',
    '/asset/lib/%zz',
    '/asset/lib/%E0%A4%A',
    '/asset/nolib/hello.wav',
    '/asset/LIB/hello.wav',
    '/asset/__proto__/hello.wav',
    '/asset/constructor/hello.wav',
    '/asset/toString/hello.wav',
    '/asset/hasOwnProperty/hello.wav',
    '/asset/gone/hello.wav',
    '/asset/blank/hello.wav',
    '/asset/%2e%2e/hello.wav',
    '/asset/../hello.wav',
    '/asset/lib',
    '/asset/lib/',
    '/asset/',
    '/asset',
    '/asset/lib/sub',
    '/asset/lib/sub/',
    '/asset/lib/sub/dir',
    `/asset/lib/${'a'.repeat(300)}`,
    `/asset/lib/${'a/'.repeat(40)}x`,
  ]

  it('has a control case that works, so the 404s below mean something', async () => {
    expect((await get('/asset/lib/hello.wav')).status).toBe(200)
    expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true)
    expect(fs.existsSync(path.join(root, '.hidden.txt'))).toBe(true)
  })

  it.each(traversal)('404 for %s', async (rawPath) => {
    const r = await get(rawPath)
    expect(r.status).toBe(404)
    // no detail: not the file, not the path, not the reason
    expect(r.body.toString('utf8')).toBe('Not found')
    expect(r.body.toString('utf8')).not.toMatch(/secret|outside|hello|\.\./i)
  })

  it('never leaks the outside file, whatever the spelling', async () => {
    for (const rawPath of traversal) {
      const r = await get(rawPath)
      expect(r.body.toString('utf8')).not.toContain('top secret')
    }
  })

  it('a junction that leaves the library root is refused', async (ctx) => {
    if (!junctionWorks) return ctx.skip()
    expect(fs.readFileSync(path.join(root, 'link', 'secret.txt'), 'utf8')).toBe('top secret') // the link itself works
    for (const rawPath of ['/asset/lib/link/secret.txt', '/asset/lib/link', '/asset/lib/link/']) {
      const r = await get(rawPath)
      expect(r.status).toBe(404)
      expect(r.body.toString('utf8')).not.toContain('top secret')
    }
  })

  it('a file symlink that leaves the library root is refused', async (ctx) => {
    if (!fileSymlinkWorks) return ctx.skip()
    const r = await get('/asset/lib/file-link.txt')
    expect(r.status).toBe(404)
    expect(r.body.toString('utf8')).not.toContain('top secret')
  })

  it('a link that stays inside the root still works', async (ctx) => {
    let made = false
    try {
      fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'inner-link'), 'junction')
      made = true
    } catch {
      made = false
    }
    if (!made) return ctx.skip()
    expect((await get('/asset/lib/inner-link/dir/track.mp3')).status).toBe(200)
  })

  it('rejects other methods with 405, and answers HEAD like GET without a body', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await get('/asset/lib/hello.wav', undefined, method)
      expect(r.status).toBe(405)
      expect(r.headers.allow).toBe('GET, HEAD')
    }
    const head = await get('/asset/lib/hello.wav', undefined, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe('1000')
    expect(head.headers['content-type']).toBe('audio/wav')
    expect(head.body.length).toBe(0)
    expect((await get('/asset/lib/nothing.wav', undefined, 'HEAD')).status).toBe(404)
  })

  it('returns false for paths outside /asset so the caller can keep routing', async () => {
    const handler = createAssetHandler(libraries)
    const res = { headersSent: false } as never
    for (const p of [
      '/',
      '/index.html',
      '/assets/x.js',
      '/assetx/lib/a',
      '/ASSET/lib/hello.wav',
      '/stage',
    ]) {
      expect(await handler({ method: 'GET' } as never, res, p)).toBe(false)
    }
    expect((await get('/index.html')).status).toBe(599) // proves the route above really declined
  })

  it('reads library names live, so a library added later works', async () => {
    const extra = makeTempDir()
    try {
      writeTree(extra.dir, { 'late.txt': 'added later' })
      expect((await get('/asset/late/late.txt')).status).toBe(404)
      libraries.late = extra.dir
      expect((await get('/asset/late/late.txt')).status).toBe(200)
      delete libraries.late
      expect((await get('/asset/late/late.txt')).status).toBe(404)
    } finally {
      extra.remove()
    }
  })

  it('answers unexpected failures with a generic 500 and logs the details', async () => {
    const boom = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('internal detail that must not leak')
        },
      }
    ) as Record<string, string>
    const handler = createAssetHandler(boom, handlerLogger)
    const srv = http.createServer((req, res) => void handler(req, res, req.url ?? '/'))
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    try {
      const p = (srv.address() as AddressInfo).port
      const r = await rawRequest(p, '/asset/lib/hello.wav')
      expect(r.status).toBe(500)
      expect(r.body.toString('utf8')).toBe('Internal error')
      expect(
        handlerLog.some((e) => e.level === 'error' && e.msg.includes('asset request failed'))
      ).toBe(true)
    } finally {
      srv.closeAllConnections()
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  })
})

describe('range requests', () => {
  const slice = (from: number, to: number) => Buffer.from(track.subarray(from, to + 1))

  it.each([
    ['bytes=0-9', 0, 9],
    ['bytes=990-', 990, 999],
    ['bytes=-10', 990, 999],
    ['bytes=500-5000', 500, 999],
    ['bytes=0-0', 0, 0],
    ['bytes=999-999', 999, 999],
    ['bytes=-5000', 0, 999],
  ])('%s -> 206 with the right slice and Content-Range', async (header, from, to) => {
    const r = await get('/asset/lib/hello.wav', { Range: header })
    expect(r.status).toBe(206)
    expect(r.headers['content-range']).toBe(`bytes ${from}-${to}/1000`)
    expect(r.headers['content-length']).toBe(String(to - from + 1))
    expect(r.headers['content-type']).toBe('audio/wav')
    expect(r.headers['accept-ranges']).toBe('bytes')
    expect(Buffer.compare(r.body, slice(from, to))).toBe(0)
  })

  it.each(['bytes=1000-', 'bytes=1000-2000', 'bytes=5000-', 'bytes=-0'])(
    '%s -> 416 with Content-Range */size',
    async (header) => {
      const r = await get('/asset/lib/hello.wav', { Range: header })
      expect(r.status).toBe(416)
      expect(r.headers['content-range']).toBe('bytes */1000')
      expect(r.body.length).toBe(0)
    }
  )

  it.each(['bytes=0-5,10-15', 'bytes=9-0', 'bytes=abc', 'items=0-5', 'bytes=-', 'bytes=0-9-'])(
    '%s is ignored: the whole file with 200',
    async (header) => {
      const r = await get('/asset/lib/hello.wav', { Range: header })
      expect(r.status).toBe(200)
      expect(r.headers['content-range']).toBeUndefined()
      expect(r.body.length).toBe(1000)
    }
  )

  it('honours If-Range: a matching validator keeps the range, a stale one gets the whole file', async () => {
    const first = await get('/asset/lib/hello.wav')
    const etag = first.headers.etag as string
    const modified = first.headers['last-modified'] as string
    expect(
      (await get('/asset/lib/hello.wav', { Range: 'bytes=0-9', 'If-Range': etag })).status
    ).toBe(206)
    expect(
      (await get('/asset/lib/hello.wav', { Range: 'bytes=0-9', 'If-Range': modified })).status
    ).toBe(206)
    const stale = await get('/asset/lib/hello.wav', { Range: 'bytes=0-9', 'If-Range': '"stale"' })
    expect(stale.status).toBe(200)
    expect(stale.body.length).toBe(1000)
  })

  it('HEAD with a range returns the 206 headers and no body', async () => {
    const r = await get('/asset/lib/hello.wav', { Range: 'bytes=10-19' }, 'HEAD')
    expect(r.status).toBe(206)
    expect(r.headers['content-range']).toBe('bytes 10-19/1000')
    expect(r.headers['content-length']).toBe('10')
    expect(r.body.length).toBe(0)
  })
})

describe('caching validators', () => {
  it('answers If-None-Match with 304 and no body, keeping the validators', async () => {
    const first = await get('/asset/lib/hello.wav')
    const etag = first.headers.etag as string
    for (const value of [etag, `W/${etag}`, `"nope", ${etag}`, '*']) {
      const r = await get('/asset/lib/hello.wav', { 'If-None-Match': value })
      expect(r.status).toBe(304)
      expect(r.body.length).toBe(0)
      expect(r.headers.etag).toBe(etag)
      expect(r.headers['cache-control']).toBe('no-cache')
      expect(r.headers['x-content-type-options']).toBe('nosniff')
    }
    const other = await get('/asset/lib/hello.wav', { 'If-None-Match': '"something-else"' })
    expect(other.status).toBe(200)
    expect(other.body.length).toBe(1000)
  })

  it('does not leak existence through 304: unknown files are still 404', async () => {
    expect((await get('/asset/lib/nothing.wav', { 'If-None-Match': '*' })).status).toBe(404)
  })

  it('the ETag changes when the file changes', async () => {
    const file = path.join(root, 'changing.txt')
    fs.writeFileSync(file, 'one')
    const a = (await get('/asset/lib/changing.txt')).headers.etag
    fs.writeFileSync(file, 'longer content')
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(file, later, later)
    const b = (await get('/asset/lib/changing.txt')).headers.etag
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
    expect((await get('/asset/lib/changing.txt', { 'If-None-Match': a as string })).status).toBe(
      200
    )
  })
})
