/** The mode's client of the capture service, over a real socket. */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { CaptureError, createCaptureClient } from '../../src/modes/commentary/captureClient.ts'
import type { CaptureRequest } from '../../src/modes/commentary/captureClient.ts'
import { FakeCapture, jpegBase64, notFound, win } from './fakeCapture.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function serveFake(fake: FakeCapture): Promise<string> {
  const s = await fake.serve()
  closers.push(s.close)
  return s.url
}

/** A server that answers however the test says, for answers the real service would never give. */
async function serveRaw(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const request = (over: Partial<CaptureRequest> = {}): CaptureRequest => ({
  window: 'Some Game',
  maxWidth: 768,
  quality: 80,
  blackThreshold: 10,
  method: 'auto',
  ...over,
})

const failure = async (p: Promise<unknown>): Promise<CaptureError> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(CaptureError)
    return e as CaptureError
  }
  throw new Error('expected a CaptureError')
}

describe('capturing', () => {
  it('returns the picture as base64 with what the service said about it', async () => {
    const fake = new FakeCapture()
    fake.windows = [
      win('4242', 'Some Game 游戏 - World 1', { process: 'javaw.exe', width: 1600, height: 900 }),
    ]
    fake.script = [{ kind: 'frame', n: 7, brightness: 42.5, method: 'screen' }]
    const client = createCaptureClient(await serveFake(fake), { timeoutMs: 5000 })
    const frame = await client.capture(request({ window: 'some game' }))
    expect(frame).toEqual({
      mime: 'image/jpeg',
      base64: jpegBase64(7),
      bytes: 7,
      width: 768,
      height: 432,
      sourceWidth: 1600,
      sourceHeight: 900,
      brightness: 42.5,
      black: false,
      method: 'screen',
      window: { id: '4242', title: 'Some Game 游戏 - World 1', process: 'javaw.exe' },
    })
  })

  it('sends what it was asked to, and reports black pictures as black', async () => {
    const fake = new FakeCapture()
    fake.script = [{ kind: 'frame', black: true }]
    const client = createCaptureClient(await serveFake(fake), { timeoutMs: 5000 })
    const frame = await client.capture(
      request({
        window: 'exe:javaw.exe',
        maxWidth: 512,
        quality: 60,
        blackThreshold: 15,
        method: 'screen',
      })
    )
    expect(frame.black).toBe(true)
    expect(fake.calls).toEqual([
      { window: 'exe:javaw.exe', maxWidth: 512, quality: 60, blackThreshold: 15, method: 'screen' },
    ])
  })

  it('passes the error of the service on with its own code, words and status', async () => {
    const fake = new FakeCapture()
    fake.script = [
      notFound('Ghost'),
      {
        kind: 'error',
        status: 409,
        code: 'window_minimized',
        message: 'the window is minimised',
        retryable: true,
      },
      { kind: 'error', status: 500, code: 'capture_failed', message: 'PrintWindow failed' },
    ]
    const client = createCaptureClient(await serveFake(fake), { timeoutMs: 5000 })
    const gone = await failure(client.capture(request({ window: 'Ghost' })))
    expect([gone.code, gone.retryable, gone.status]).toEqual(['window_not_found', true, 404])
    expect(gone.message).toContain('Ghost')
    const minimised = await failure(client.capture(request()))
    expect([minimised.code, minimised.status]).toEqual(['window_minimized', 409])
    const failed = await failure(client.capture(request()))
    expect([failed.code, failed.retryable, failed.status]).toEqual(['capture_failed', false, 500])
  })

  it('does not accept a 200 that is not a picture', async () => {
    const fake = new FakeCapture()
    fake.script = [
      { kind: 'garbage', body: '<html>captive portal</html>', type: 'text/html' },
      { kind: 'garbage', body: 'not a jpeg at all', type: 'image/jpeg' },
      { kind: 'garbage', body: '', type: 'image/jpeg' },
    ]
    const client = createCaptureClient(await serveFake(fake), { timeoutMs: 5000 })
    for (const [i, expected] of [
      'text/html instead of a JPEG',
      'image/jpeg instead of a JPEG',
      'image/jpeg instead of a JPEG',
    ].entries()) {
      const e = await failure(client.capture(request()))
      expect([e.code, e.retryable], `answer ${i}`).toEqual(['bad_response', false])
      expect(e.message).toContain(expected)
    }
  })

  it('does not accept a picture without the headers that say what it is', async () => {
    const url = await serveRaw((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'x-image-width': '10' })
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
    })
    const e = await failure(createCaptureClient(url, { timeoutMs: 5000 }).capture(request()))
    expect(e.code).toBe('bad_response')
    expect(e.message).toContain('header')
  })

  it('does not accept a picture with a nonsense header', async () => {
    const url = await serveRaw((_req, res) => {
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'x-image-width': 'wide',
        'x-image-height': '10',
        'x-source-width': '10',
        'x-source-height': '10',
        'x-brightness': '1',
        'x-black': 'false',
        'x-method': 'screen',
        'x-window-id': '1',
        'x-window-title': 'T',
        'x-window-process': 'p.exe',
      })
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    })
    const e = await failure(createCaptureClient(url, { timeoutMs: 5000 }).capture(request()))
    expect([e.code, e.message]).toEqual([
      'bad_response',
      'the capture service sent a bad x-image-width header',
    ])
  })

  it('describes an error answer it does not understand without repeating the page it came with', async () => {
    const url = await serveRaw((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' })
      res.end(`<html><body>${'Bad gateway '.repeat(100)}</body></html>`)
    })
    const e = await failure(createCaptureClient(url, { timeoutMs: 5000 }).capture(request()))
    expect([e.code, e.status, e.retryable]).toEqual(['bad_response', 502, true])
    expect(e.message.length).toBeLessThan(250)
    expect(e.message).toContain('HTTP 502')
  })

  it('says the service is down when nothing listens, and that it is worth trying again', async () => {
    const fake = new FakeCapture()
    const s = await fake.serve()
    await s.close()
    const e = await failure(createCaptureClient(s.url, { timeoutMs: 2000 }).capture(request()))
    expect([e.code, e.retryable]).toEqual(['service_down', true])
    expect(e.message).toContain('not answering')
  })

  it('says the service is down when it closes the connection without an answer', async () => {
    const fake = new FakeCapture()
    fake.script = [{ kind: 'drop' }]
    const e = await failure(
      createCaptureClient(await serveFake(fake), { timeoutMs: 2000 }).capture(request())
    )
    expect([e.code, e.retryable]).toEqual(['service_down', true])
  })

  it('says the service is down when it dies in the middle of an answer', async () => {
    const url = await serveRaw((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '1000' })
      res.write(Buffer.from([0xff, 0xd8, 0xff]))
      setTimeout(() => res.destroy(), 20)
    })
    const e = await failure(createCaptureClient(url, { timeoutMs: 2000 }).capture(request()))
    expect(e.code).toBe('service_down')
  })

  it('gives up on a service that never answers, after the time it was given', async () => {
    const fake = new FakeCapture()
    fake.script = [{ kind: 'hang' }]
    const client = createCaptureClient(await serveFake(fake), { timeoutMs: 150 })
    const started = Date.now()
    const e = await failure(client.capture(request()))
    expect([e.code, e.retryable]).toEqual(['timeout', true])
    expect(Date.now() - started).toBeLessThan(2000)
    expect(e.message).toContain('150 ms')
  })

  it('stops at once when it is cancelled, and says that is what happened', async () => {
    const fake = new FakeCapture()
    fake.script = [{ kind: 'hang' }]
    const client = createCaptureClient(await serveFake(fake), { timeoutMs: 5000 })
    const ctl = new AbortController()
    const pending = failure(client.capture(request({ signal: ctl.signal })))
    setTimeout(() => ctl.abort(), 50)
    const e = await pending
    expect([e.code, e.retryable]).toEqual(['aborted', false])

    const already = new AbortController()
    already.abort()
    const early = await failure(client.capture(request({ signal: already.signal })))
    expect(early.code).toBe('aborted')
    expect(fake.calls).toHaveLength(1) // the second never left the client
  })

  it('does not go through a proxy taken from the environment', async () => {
    const saved = { http: process.env.HTTP_PROXY, use: process.env.NODE_USE_ENV_PROXY }
    process.env.HTTP_PROXY = 'http://127.0.0.1:9'
    process.env.NODE_USE_ENV_PROXY = '1'
    try {
      const fake = new FakeCapture()
      const frame = await createCaptureClient(await serveFake(fake), { timeoutMs: 3000 }).capture(
        request()
      )
      expect(frame.black).toBe(false)
    } finally {
      if (saved.http === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = saved.http
      if (saved.use === undefined) delete process.env.NODE_USE_ENV_PROXY
      else process.env.NODE_USE_ENV_PROXY = saved.use
    }
  })
})

describe('listing windows', () => {
  it('returns what the service lists', async () => {
    const fake = new FakeCapture()
    fake.windows = [
      win('1', 'A 游戏'),
      win('2', 'B', { minimized: true, overlay: true, width: 0, height: 0 }),
    ]
    const list = await createCaptureClient(await serveFake(fake), { timeoutMs: 5000 }).windows()
    expect(list).toEqual(fake.windows)
  })

  it('rejects a list it does not understand', async () => {
    for (const body of [
      '{"windows":[{"id":1}]}',
      '{"windows":"none"}',
      '[]',
      'nonsense',
      '{"count":0}',
    ]) {
      const url = await serveRaw((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
      })
      const e = await failure(createCaptureClient(url, { timeoutMs: 5000 }).windows())
      expect(e.code, body).toBe('bad_response')
    }
  })

  it('reports the service error, and refuses an answer far bigger than a list can be', async () => {
    const url = await serveRaw((req, res) => {
      if (req.url === '/windows') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(' '.repeat(5 * 1024 * 1024))
      }
    })
    const e = await failure(createCaptureClient(url, { timeoutMs: 5000 }).windows())
    expect(e.code).toBe('bad_response')
    expect(e.message).toContain('more than it should')

    const broken = await serveRaw((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { code: 'capture_failed', message: 'the window list could not be read' },
        })
      )
    })
    const f = await failure(createCaptureClient(broken, { timeoutMs: 5000 }).windows())
    expect([f.code, f.message]).toEqual(['capture_failed', 'the window list could not be read'])
  })

  it('can be cancelled', async () => {
    const url = await serveRaw(() => undefined) // never answers
    const ctl = new AbortController()
    const pending = failure(createCaptureClient(url, { timeoutMs: 5000 }).windows(ctl.signal))
    setTimeout(() => ctl.abort(), 30)
    expect((await pending).code).toBe('aborted')
  })
})
