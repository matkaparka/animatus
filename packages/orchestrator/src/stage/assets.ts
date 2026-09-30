/**
 * Asset route: `GET|HEAD /asset/<library>/<relative path>`.
 *
 * Libraries are named directories the user configured (models, motions, songs, ...). Every request
 * is untrusted input: the path is decoded segment by segment exactly once, every decoded segment is
 * checked, and the final file must still be inside the library root after `realpath` (so a symlink
 * or junction that leaves the root fails). Files are streamed, never buffered, and Range requests
 * are supported because the browser streams long audio tracks with them.
 */
import { createReadStream } from 'node:fs'
import type { Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { noopLogger } from './logger.ts'
import type { Logger } from './logger.ts'

// ───────────────────────────── content types ─────────────────────────────

const ASSET_TYPES = new Map<string, string>([
  ['.vrm', 'model/gltf-binary'],
  ['.vrma', 'model/gltf-binary'],
  ['.glb', 'model/gltf-binary'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.json', 'application/json'],
  ['.lrc', 'text/plain; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
])

/** Web types for the stage build. Deliberately not used for `/asset`: user files never get an executable type. */
const STATIC_TYPES = new Map<string, string>([
  ...ASSET_TYPES,
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.map', 'application/json'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.webmanifest', 'application/manifest+json'],
])

const OCTET_STREAM = 'application/octet-stream'

export const assetContentType = (file: string): string =>
  ASSET_TYPES.get(path.extname(file).toLowerCase()) ?? OCTET_STREAM

export const staticContentType = (file: string): string =>
  STATIC_TYPES.get(path.extname(file).toLowerCase()) ?? OCTET_STREAM

// ───────────────────────────── path handling ─────────────────────────────

const MAX_PATH_CHARS = 2048
const MAX_SEGMENTS = 32
const MAX_SEGMENT_CHARS = 255

/** Names Windows treats as devices, with or without an extension (`con`, `NUL.txt`, `com1`, ...). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9]) *(\.|$)/i

/**
 * True when a decoded path segment is safe to join under a root on any OS.
 * Rejects: empty, `.`/`..`, hidden (leading dot) names, control characters, both kinds of slash,
 * `: * ? " < > |` (drive letters, NTFS alternate streams, wildcards), Windows device names and names
 * ending in a dot or space (Windows silently trims those).
 */
export function isSafeSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > MAX_SEGMENT_CHARS) return false
  if (segment.startsWith('.')) return false
  if (/[\x00-\x1f\x7f<>:"|?*\\/]/.test(segment)) return false
  if (/[. ]$/.test(segment)) return false
  if (WINDOWS_DEVICE.test(segment)) return false
  return true
}

/**
 * Splits a raw (still percent-encoded, no query string) URL path into decoded segments.
 * Every segment is decoded exactly once and validated with `isSafeSegment`, so an encoded slash,
 * dot segment, backslash, NUL or drive letter can never reach the file system. Returns null when
 * anything is wrong. `/` yields an empty list.
 */
export function decodeUrlPathSegments(rawPath: string): string[] | null {
  if (!rawPath.startsWith('/') || rawPath.length > MAX_PATH_CHARS) return null
  if (rawPath === '/') return []
  const parts = rawPath.slice(1).split('/')
  if (parts.length > MAX_SEGMENTS) return null
  const out: string[] = []
  for (const part of parts) {
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    } catch {
      return null
    }
    if (!isSafeSegment(decoded)) return null
    out.push(decoded)
  }
  return out
}

/** `/asset/<library>/<parts...>`, each part percent-encoded. Throws when a part could not be served (`isSafeSegment`). */
export function assetUrl(library: string, ...parts: string[]): string {
  for (const p of [library, ...parts])
    if (!isSafeSegment(p)) throw new Error(`not a safe asset path segment: ${JSON.stringify(p)}`)
  return `/asset/${[library, ...parts].map(encodeURIComponent).join('/')}`
}

export function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

export interface ResolvedFile {
  /** Canonical path (symlinks resolved); the file is opened through this, not the requested name. */
  file: string
  stats: Stats
}

/**
 * Joins already-validated segments under `root` and returns the file only when it is a regular
 * file whose real path is still inside the real root. Any file-system error counts as "not found".
 */
export async function resolveInsideRoot(
  root: string,
  segments: readonly string[]
): Promise<ResolvedFile | null> {
  if (segments.length === 0) return null
  try {
    const rootReal = await realpath(root)
    const fileReal = await realpath(path.join(rootReal, ...segments))
    if (!isPathInside(rootReal, fileReal)) return null
    const stats = await stat(fileReal)
    return stats.isFile() ? { file: fileReal, stats } : null
  } catch {
    return null
  }
}

// ───────────────────────────── responses ─────────────────────────────

const securityHeaders = (): Record<string, string> => ({
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
})

/** Small plain-text response; `head` suppresses the body. */
export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
  head = false
): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...securityHeaders(),
    ...headers,
  })
  res.end(head ? undefined : body)
}

export type RangeResult =
  { kind: 'none' } | { kind: 'unsatisfiable' } | { kind: 'range'; start: number; end: number }

/**
 * Parses a single `bytes=a-b`, `bytes=a-` or `bytes=-n` range. Anything else (several ranges, other
 * units, garbage, `b < a`) is ignored and the whole file is served, which RFC 9110 allows. A range
 * that starts beyond the end (or `-0`) is unsatisfiable.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return { kind: 'none' }
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/i.exec(header.trim())
  if (!m) return { kind: 'none' }
  const first = m[1] ?? ''
  const last = m[2] ?? ''
  if (first === '' && last === '') return { kind: 'none' }
  if (first === '') {
    const n = Number(last)
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(first)
  if (last !== '' && Number(last) < start) return { kind: 'none' }
  if (start >= size) return { kind: 'unsatisfiable' }
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  return { kind: 'range', start, end }
}

function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true
  return header.split(',').some((token) => token.trim().replace(/^W\//, '') === etag)
}

export interface ServeFileOptions {
  contentType: string
  /** Extra response headers (for example a Content-Security-Policy for HTML). */
  headers?: Record<string, string>
}

/**
 * Serves one regular file: ETag (size + mtime) with `If-None-Match` -> 304, single Range with
 * `If-Range`, HEAD, `Cache-Control: no-cache`. Streams with `createReadStream`.
 */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  stats: Stats,
  options: ServeFileOptions
): Promise<void> {
  const size = stats.size
  const etag = `"${size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`
  const lastModified = stats.mtime.toUTCString()
  const base: Record<string, string | number> = {
    ...securityHeaders(),
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': lastModified,
    ...options.headers,
  }

  const ifNoneMatch = req.headers['if-none-match']
  if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, etag)) {
    res.writeHead(304, base)
    res.end()
    return
  }

  let status = 200
  let start = 0
  let end = size - 1
  const range = parseRange(req.headers.range, size)
  const ifRange = req.headers['if-range']
  const rangeApplies = ifRange === undefined || ifRange === etag || ifRange === lastModified
  if (range.kind !== 'none' && rangeApplies) {
    if (range.kind === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 })
      res.end()
      return
    }
    status = 206
    start = range.start
    end = range.end
  }

  const length = size === 0 ? 0 : end - start + 1
  const headers: Record<string, string | number> = {
    ...base,
    'Content-Type': options.contentType,
    'Accept-Ranges': 'bytes',
    'Content-Length': length,
  }
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || length === 0) {
    res.end()
    return
  }
  try {
    await pipeline(createReadStream(file, { start, end }), res)
  } catch {
    // Client went away (premature close) or the file vanished mid-stream: nothing more to send.
    if (!res.destroyed) res.destroy()
  }
}

// ───────────────────────────── the asset route ─────────────────────────────

export type AssetHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
) => Promise<boolean>

/**
 * `libraries` maps a library name to a directory. `pathname` must be the raw request path
 * (percent-escapes not yet decoded, no query string). Returns false when the path is not under
 * `/asset`, so the caller can continue routing; otherwise the response has been sent (404 with no
 * detail for anything that is not a servable file).
 */
export function createAssetHandler(
  libraries: Record<string, string>,
  logger: Logger = noopLogger
): AssetHandler {
  return async function handleAsset(req, res, pathname) {
    if (pathname !== '/asset' && !pathname.startsWith('/asset/')) return false
    const head = req.method === 'HEAD'
    const notFound = () => sendText(res, 404, 'Not found', {}, head)
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' })
        return true
      }
      const segments = decodeUrlPathSegments(pathname)
      const library = segments?.[1]
      if (!segments || segments[0] !== 'asset' || library === undefined || segments.length < 3) {
        notFound()
        return true
      }
      // Own properties only: a library called "constructor" or "__proto__" must not resolve.
      const root = Object.hasOwn(libraries, library) ? libraries[library] : undefined
      if (typeof root !== 'string' || root === '') {
        notFound()
        return true
      }
      const resolved = await resolveInsideRoot(root, segments.slice(2))
      if (!resolved) {
        notFound()
        return true
      }
      await serveFile(req, res, resolved.file, resolved.stats, {
        contentType: assetContentType(resolved.file),
      })
    } catch (err) {
      // The client only ever sees a generic message; the details stay in the log.
      logger('error', 'asset request failed', { err, path: pathname })
      if (!res.headersSent) sendText(res, 500, 'Internal error', {}, head)
      else res.destroy()
    }
    return true
  }
}
