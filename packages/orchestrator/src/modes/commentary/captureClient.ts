/**
 * The mode's side of the capture service's HTTP contract (`plugins/screencap`, docs/mode-commentary.md).
 *
 * Plain `node:http` with a fresh connection per request, like the plugin health checks: `fetch` may send loopback
 * traffic through a proxy taken from the environment, and this is a picture of the operator's screen.
 *
 * Every failure is a `CaptureError` with a code the mode can show: the service's own codes (`window_not_found`,
 * `window_minimized`, ...) pass through, and the client adds `service_down`, `timeout`, `aborted` and `bad_response`
 * (an answer that is not what the contract promises, for example a 200 with something other than a picture).
 */
import http from 'node:http'
import { ServiceError } from '@animatus/protocol'
import { z } from 'zod'

export class CaptureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}

export interface WindowInfo {
  id: string
  title: string
  process: string
  width: number
  height: number
  minimized: boolean
  overlay: boolean
}

export interface CaptureRequest {
  /** A window id, part of a title, or `exe:<program>`. */
  window: string
  maxWidth: number
  quality: number
  blackThreshold: number
  method: 'auto' | 'printwindow' | 'screen'
  signal?: AbortSignal
}

export interface CapturedFrame {
  mime: 'image/jpeg'
  base64: string
  bytes: number
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  /** Mean brightness of the picture, 0 to 255. */
  brightness: number
  black: boolean
  /** `printwindow` or `screen`: how the pixels were obtained. */
  method: string
  window: { id: string; title: string; process: string }
}

export interface CaptureClient {
  windows(signal?: AbortSignal): Promise<WindowInfo[]>
  capture(req: CaptureRequest): Promise<CapturedFrame>
}

const WindowList = z.object({
  windows: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        title: z.string().max(2000),
        process: z.string().max(400),
        width: z.number().int().min(0),
        height: z.number().int().min(0),
        minimized: z.boolean(),
        overlay: z.boolean(),
      })
    )
    .max(2000),
})

/** A 768-wide picture is well under 1 MB; this only stops a runaway answer. */
const MAX_PICTURE_BYTES = 32 * 1024 * 1024
const MAX_LIST_BYTES = 4 * 1024 * 1024
const JPEG_MAGIC = [0xff, 0xd8, 0xff]

interface Answer {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNABORTED',
])

function get(
  url: URL,
  opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal | undefined }
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted)
      return reject(new CaptureError('aborted', 'the request was cancelled', false))
    let finished = false
    /** Why this side ended the request (a timeout, a cancel, an oversized answer): what the error events then say is not the cause. */
    let reason: CaptureError | undefined
    const finish = (settle: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const fail = (e: unknown) => finish(() => reject(reason ?? asCaptureError(e)))
    const stop = (why: CaptureError) => {
      reason ??= why
      req.destroy(why)
    }
    const req = http.request(
      url,
      { method: 'GET', agent: false, headers: { connection: 'close', accept: '*/*' } },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > opts.maxBytes)
            return stop(
              new CaptureError(
                'bad_response',
                'the capture service sent more than it should',
                false
              )
            )
          chunks.push(chunk)
        })
        res.once('end', () =>
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            })
          )
        )
        res.once('close', () => {
          // closed before the body was complete: the service died, or was stopped, in the middle of an answer
          if (!res.complete)
            fail(
              new CaptureError(
                'service_down',
                'the capture service closed the connection mid-answer',
                true
              )
            )
        })
        res.once('error', fail)
      }
    )
    const timer = setTimeout(
      () =>
        stop(
          new CaptureError(
            'timeout',
            `the capture service did not answer within ${opts.timeoutMs} ms`,
            true
          )
        ),
      opts.timeoutMs
    )
    const onAbort = () => stop(new CaptureError('aborted', 'the request was cancelled', false))
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    req.once('error', fail)
    req.end()
  })
}

function asCaptureError(e: unknown): CaptureError {
  if (e instanceof CaptureError) return e
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code && CONNECTION_ERRORS.has(code))
    return new CaptureError('service_down', `the capture service is not answering (${code})`, true)
  return new CaptureError(
    'service_down',
    `the capture service could not be reached: ${flat((e as Error)?.message ?? String(e), 120)}`,
    true
  )
}

/** One bounded line of somebody else's text, for a message. */
const flat = (text: string, max: number): string => {
  const one = text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** The error the service reports (a `ServiceError` body), or a description of whatever else came back. */
function failure(answer: Answer): CaptureError {
  let json: unknown
  try {
    json = JSON.parse(answer.body.toString('utf8'))
  } catch {
    json = undefined
  }
  const parsed = ServiceError.safeParse(json)
  if (parsed.success) {
    const e = parsed.data.error
    return new CaptureError(e.code, e.message, e.retryable, answer.status)
  }
  return new CaptureError(
    'bad_response',
    `the capture service answered HTTP ${answer.status} without an error it understands` +
      (answer.body.length > 0 ? ` (${flat(answer.body.toString('utf8', 0, 200), 100)})` : ''),
    answer.status >= 500,
    answer.status
  )
}

function header(answer: Answer, name: string): string {
  const value = answer.headers[name]
  const text = Array.isArray(value) ? value[0] : value
  if (text === undefined || text === '')
    throw new CaptureError('bad_response', `the capture service left out the ${name} header`, false)
  return text
}

function int(answer: Answer, name: string): number {
  const n = Number(header(answer, name))
  if (!Number.isInteger(n) || n < 0)
    throw new CaptureError('bad_response', `the capture service sent a bad ${name} header`, false)
  return n
}

function decoded(answer: Answer, name: string): string {
  const raw = header(answer, name)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function createCaptureClient(baseUrl: string, opts: { timeoutMs: number }): CaptureClient {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    async windows(signal) {
      const answer = await get(new URL(`${base}/windows`), {
        timeoutMs: opts.timeoutMs,
        maxBytes: MAX_LIST_BYTES,
        signal,
      })
      if (answer.status !== 200) throw failure(answer)
      let json: unknown
      try {
        json = JSON.parse(answer.body.toString('utf8'))
      } catch {
        json = undefined
      }
      const parsed = WindowList.safeParse(json)
      if (!parsed.success)
        throw new CaptureError(
          'bad_response',
          'the capture service sent a window list it does not understand',
          false
        )
      return parsed.data.windows
    },

    async capture(req) {
      const query = new URLSearchParams({
        window: req.window,
        max_width: String(req.maxWidth),
        quality: String(req.quality),
        black_threshold: String(req.blackThreshold),
        method: req.method,
      })
      const answer = await get(new URL(`${base}/capture?${query}`), {
        timeoutMs: opts.timeoutMs,
        maxBytes: MAX_PICTURE_BYTES,
        signal: req.signal,
      })
      if (answer.status !== 200) throw failure(answer)
      const type = String(answer.headers['content-type'] ?? '')
      if (!type.startsWith('image/jpeg') || !JPEG_MAGIC.every((b, i) => answer.body[i] === b))
        throw new CaptureError(
          'bad_response',
          `the capture service answered 200 with ${type ? flat(type, 40) : 'no content type'} instead of a JPEG picture`,
          false,
          200
        )
      return {
        mime: 'image/jpeg',
        base64: answer.body.toString('base64'),
        bytes: answer.body.length,
        width: int(answer, 'x-image-width'),
        height: int(answer, 'x-image-height'),
        sourceWidth: int(answer, 'x-source-width'),
        sourceHeight: int(answer, 'x-source-height'),
        brightness: Number(header(answer, 'x-brightness')) || 0,
        black: header(answer, 'x-black') === 'true',
        method: header(answer, 'x-method'),
        window: {
          id: header(answer, 'x-window-id'),
          title: decoded(answer, 'x-window-title'),
          process: decoded(answer, 'x-window-process'),
        },
      }
    },
  }
}
