/**
 * Response helpers and the JSON body reader of the console server.
 *
 * Every response goes through here, so every response carries the security headers and no response can
 * carry a CORS header. Error bodies are always `ApiError`, with code and message clamped to what the
 * contract allows.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { z } from 'zod'
import { CONSOLE_MAX_BODY_BYTES } from '@animatus/protocol'
import type { ApiError } from '@animatus/protocol'
import { ApiFailure } from './backend.ts'
import { baseSecurityHeaders } from './policy.ts'

export function clampText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...baseSecurityHeaders(),
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

export function sendApiError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {}
): void {
  const body: ApiError = { error: { code: clampText(code, 64), message: clampText(message, 600) } }
  sendJson(res, status, body, headers)
}

/** Plain text, used for the API's one text route (logs) and for non-API errors. `head` drops the body. */
export function sendPlain(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
  head = false
): void {
  res.writeHead(status, {
    ...baseSecurityHeaders(),
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(head ? undefined : text)
}

// ─────────────────────────────── request bodies ───────────────────────────────

/** The peer hung up while its request was still being read: there is nobody to answer. */
export class ClientAborted extends Error {
  constructor() {
    super('the client closed the connection before the request ended')
    this.name = 'ClientAborted'
  }
}

/** Collects the body, refusing as soon as it is over `limit` and discarding whatever still arrives. */
function collectBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('close', onClose)
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        cleanup()
        chunks.length = 0
        req.resume() // no listeners left: the rest of the body is read and thrown away
        reject(
          new ApiFailure('payload_too_large', `the request body may be at most ${limit} bytes`, 413)
        )
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = () => {
      cleanup()
      reject(new ClientAborted())
    }
    const onClose = () => {
      if (req.complete) return
      cleanup()
      reject(new ClientAborted())
    }
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('close', onClose)
  })
}

export interface JsonBody {
  /** False when the request had no body at all. */
  present: boolean
  value: unknown
}

const JSON_TYPE = /^application\/json\s*(;.*)?$/i

/**
 * Reads a JSON request body: at most `limit` bytes, `application/json` only, valid UTF-8, valid JSON.
 * Refusals are `ApiFailure`s. The messages are fixed text: a JSON parser's own message can quote the
 * input, and the input may be a secret.
 */
export async function readJsonBody(
  req: IncomingMessage,
  limit = CONSOLE_MAX_BODY_BYTES
): Promise<JsonBody> {
  const declared = req.headers['content-length']
  if (declared !== undefined) {
    const n = Number(declared)
    if (!Number.isFinite(n) || n < 0)
      throw new ApiFailure('invalid_request', 'invalid Content-Length header', 400)
    if (n > limit)
      throw new ApiFailure(
        'payload_too_large',
        `the request body may be at most ${limit} bytes`,
        413
      )
  }
  const raw = await collectBody(req, limit)
  if (raw.length === 0) return { present: false, value: undefined }
  if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) {
    throw new ApiFailure('unsupported_media_type', 'send the body as application/json', 415)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new ApiFailure('invalid_json', 'the body is not valid UTF-8 JSON', 400)
  }
  try {
    return { present: true, value: JSON.parse(text) as unknown }
  } catch {
    throw new ApiFailure('invalid_json', 'the body is not valid JSON', 400)
  }
}

// ─────────────────────────────── validation ───────────────────────────────

/** Issues as one line. zod's messages name types and limits, never the offending value. */
export function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join('.') : 'body'
    return `${where}: ${issue.message}`
  })
  const more = error.issues.length > 5 ? ` (+${error.issues.length - 5} more)` : ''
  return `${parts.join('; ')}${more}`
}

/**
 * Validates `input` against an object schema and refuses fields the schema does not know: a typo such as
 * `speeed` is an error, not something to drop silently. Never echoes a value. With `nameFields: false`
 * (secret bodies) it does not even echo the names of unknown fields.
 */
export function parseStrict<S extends z.ZodObject>(
  schema: S,
  input: unknown,
  what: string,
  nameFields = true
): z.infer<S> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApiFailure('invalid_body', `${what} must be a JSON object`, 400)
  }
  const known = new Set(Object.keys(schema.shape))
  const unknown = Object.keys(input).filter((key) => !known.has(key))
  if (unknown.length > 0) {
    const names = unknown.slice(0, 3).map((k) => JSON.stringify(clampText(k, 32)))
    throw new ApiFailure(
      'unknown_field',
      nameFields
        ? `${what} has no field ${names.join(', ')}`
        : `${what} has a field that is not allowed`,
      400
    )
  }
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new ApiFailure('invalid_request', describeIssues(parsed.error), 400)
  return parsed.data as z.infer<S>
}
