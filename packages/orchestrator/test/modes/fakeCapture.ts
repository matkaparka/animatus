/**
 * A stand-in for the capture service (`plugins/screencap`), for the commentary tests. One object holds what the
 * service would know (its windows, what the next captures should do) and offers it two ways:
 *
 *   fake.client()   a `CaptureClient` that answers in-process, so a test with fake timers stays deterministic;
 *   fake.serve()    the same behaviour over a real HTTP socket, speaking the wire contract of the real service
 *                   (JPEG body plus X-headers, JSON errors), for the client and end-to-end tests.
 *
 * The "pictures" are a few bytes that start like a JPEG; `jpeg(n)` and `jpegBase64(n)` say which one is which, so a
 * test can tell which capture reached the model.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { CaptureError } from '../../src/modes/commentary/captureClient.ts'
import type {
  CaptureClient,
  CaptureRequest,
  CapturedFrame,
  WindowInfo,
} from '../../src/modes/commentary/captureClient.ts'

export const jpeg = (n: number): Buffer =>
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, n & 0xff, 0x10, 0x4a])
export const jpegBase64 = (n: number): string => jpeg(n).toString('base64')

export const win = (id: string, title: string, over: Partial<WindowInfo> = {}): WindowInfo => ({
  id,
  title,
  process: 'game.exe',
  width: 1280,
  height: 720,
  minimized: false,
  overlay: false,
  ...over,
})

export type Step =
  /** A picture. `n` is the number `jpeg(n)` has; it defaults to the count of captures so far. */
  | { kind: 'frame'; n?: number; black?: boolean; brightness?: number; method?: string }
  | { kind: 'error'; status: number; code: string; message: string; retryable?: boolean }
  /** Never answers until `release()`; a cancelled request ends. */
  | { kind: 'hang' }
  /** Over HTTP: a 200 that is not a picture. */
  | { kind: 'garbage'; body: string; type?: string }
  /** Over HTTP: the connection closes without an answer. */
  | { kind: 'drop' }

export const notFound = (query: string): Step => ({
  kind: 'error',
  status: 404,
  code: 'window_not_found',
  message: `no visible window matches "${query}"`,
  retryable: true,
})

export class FakeCapture {
  windows: WindowInfo[] = [win('101', 'Some Game - World 1', { process: 'javaw.exe' })]
  /** Every capture request that reached it, in order. */
  calls: CaptureRequest[] = []
  windowListCalls = 0
  /** What the next captures do, one entry each; when it is empty `otherwise` decides. */
  script: Step[] = []
  otherwise: (call: number, req: CaptureRequest) => Step = () => ({ kind: 'frame' })
  private waiting = new Set<() => void>()

  /** Ends every capture that hangs. */
  release(): void {
    for (const r of [...this.waiting]) r()
  }

  /** The window a query names, or null; like the service: an id, `exe:name`, else part of a title. */
  resolve(query: string): WindowInfo | null {
    const q = query.trim()
    if (/^\d+$/.test(q)) {
      const byId = this.windows.find((w) => w.id === String(Number(q)))
      if (byId) return byId
    }
    if (q.toLowerCase().startsWith('exe:')) {
      const name = q.slice(4).trim().toLowerCase()
      return (
        this.windows.find((w) => [name, `${name}.exe`].includes(w.process.toLowerCase())) ?? null
      )
    }
    return this.windows.find((w) => w.title.toLowerCase().includes(q.toLowerCase())) ?? null
  }

  private step(req: CaptureRequest): Step {
    this.calls.push(req)
    return this.script.shift() ?? this.otherwise(this.calls.length, req)
  }

  private frameFor(
    step: Extract<Step, { kind: 'frame' }>,
    req: CaptureRequest
  ): CapturedFrame | Step {
    const w = this.resolve(req.window)
    if (!w) return notFound(req.window)
    const n = step.n ?? this.calls.length
    const bytes = jpeg(n)
    return {
      mime: 'image/jpeg',
      base64: bytes.toString('base64'),
      bytes: bytes.length,
      width: 768,
      height: 432,
      sourceWidth: w.width,
      sourceHeight: w.height,
      brightness: step.brightness ?? (step.black ? 1 : 60),
      black: step.black === true,
      method: step.method ?? 'printwindow',
      window: { id: w.id, title: w.title, process: w.process },
    }
  }

  // ─────────────────────────────── in-process ───────────────────────────────

  client(): CaptureClient {
    return {
      windows: async () => {
        this.windowListCalls++
        return this.windows.map((w) => ({ ...w }))
      },
      capture: async (req) => {
        const step = this.step(req)
        if (step.kind === 'hang')
          return new Promise<CapturedFrame>((_resolve, reject) => {
            const end = () =>
              reject(new CaptureError('aborted', 'the request was cancelled', false))
            req.signal?.addEventListener('abort', end, { once: true })
            this.waiting.add(end)
          })
        if (step.kind === 'garbage' || step.kind === 'drop')
          throw new CaptureError(
            'bad_response',
            'the fake capture service answered nonsense',
            false
          )
        const made = step.kind === 'frame' ? this.frameFor(step, req) : step
        if ('kind' in made) {
          if (made.kind !== 'error') throw new Error(`unexpected step ${made.kind}`)
          throw new CaptureError(made.code, made.message, made.retryable ?? false, made.status)
        }
        return made
      },
    }
  }

  // ─────────────────────────────── over HTTP ───────────────────────────────

  async serve(): Promise<{ url: string; close(): Promise<void> }> {
    const open = new Set<http.ServerResponse>()
    const server = http.createServer((req, res) => {
      open.add(res)
      res.once('close', () => open.delete(res))
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      if (url.pathname === '/health')
        return json(200, { ok: true, ready: true, service: 'screencap' })
      if (url.pathname === '/windows') {
        this.windowListCalls++
        return json(200, { windows: this.windows, count: this.windows.length })
      }
      if (url.pathname !== '/capture')
        return json(404, { error: { code: 'not_found', message: 'no' } })
      const q = url.searchParams
      const call: CaptureRequest = {
        window: q.get('window') ?? '',
        maxWidth: Number(q.get('max_width')),
        quality: Number(q.get('quality')),
        blackThreshold: Number(q.get('black_threshold')),
        method: (q.get('method') ?? 'auto') as CaptureRequest['method'],
      }
      const step = this.step(call)
      switch (step.kind) {
        case 'hang': {
          const end = () => res.destroy()
          this.waiting.add(end)
          res.once('close', () => this.waiting.delete(end))
          return
        }
        case 'drop':
          return res.destroy()
        case 'garbage':
          res.writeHead(200, { 'content-type': step.type ?? 'text/html' })
          return void res.end(step.body)
        case 'error':
          return json(step.status, {
            error: { code: step.code, message: step.message, retryable: step.retryable ?? false },
          })
        case 'frame': {
          const made = this.frameFor(step, call)
          if ('kind' in made && made.kind === 'error')
            return json(made.status, {
              error: { code: made.code, message: made.message, retryable: made.retryable ?? false },
            })
          const f = made as CapturedFrame
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'x-window-id': f.window.id,
            'x-window-title': encodeURIComponent(f.window.title),
            'x-window-process': encodeURIComponent(f.window.process),
            'x-source-width': String(f.sourceWidth),
            'x-source-height': String(f.sourceHeight),
            'x-image-width': String(f.width),
            'x-image-height': String(f.height),
            'x-black': String(f.black),
            'x-brightness': f.brightness.toFixed(2),
            'x-method': f.method,
          })
          return void res.end(Buffer.from(f.base64, 'base64'))
        }
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
      url,
      close: () =>
        new Promise<void>((resolve) => {
          this.release()
          for (const r of open) r.destroy()
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    }
  }
}
