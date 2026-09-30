/**
 * Serves the built console (`packages/console/dist`) without a token: the page carries none, the token
 * arrives in the URL fragment which browsers never send to a server.
 *
 * Every request path is untrusted. It is split into segments and each is percent-decoded exactly once and
 * checked, so an encoded slash, dot segment, backslash, NUL or drive letter never reaches the file system;
 * the file that comes out must be a regular file whose real path (symlinks and junctions resolved) is still
 * inside the real root. Only paths that do not look like files fall back to the app shell.
 */
import { createReadStream } from 'node:fs'
import type { Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { baseSecurityHeaders } from './policy.ts'
import { sendPlain } from './http.ts'

const NOT_BUILT_TEXT =
  'The console has not been built yet.\n' +
  'Build it with: npm run build -w @animatus/console\n' +
  'Then reload this page.\n'

const TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json'],
  ['.map', 'application/json'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.webmanifest', 'application/manifest+json'],
])

export const staticContentType = (file: string): string =>
  TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'

// ─────────────────────────────── path handling ───────────────────────────────

const MAX_PATH_CHARS = 2048
const MAX_SEGMENTS = 32
const MAX_SEGMENT_CHARS = 255

/** Names Windows treats as devices, with or without an extension (`con`, `NUL.txt`, `com1`, ...). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9]) *(\.|$)/i

/**
 * True when a decoded path segment is safe to join under a root on any OS. Rejects: empty, `.` and `..`,
 * hidden names (leading dot), control characters (NUL included), both kinds of slash, `: * ? " < > |`
 * (drive letters, NTFS alternate streams, wildcards), Windows device names, and names ending in a dot or
 * space (Windows trims those silently).
 */
export function isSafeSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > MAX_SEGMENT_CHARS) return false
  if (segment.startsWith('.')) return false
  if (/[\u0000-\u001f\u007f<>:"|?*\\/]/.test(segment)) return false
  if (/[. ]$/.test(segment)) return false
  if (WINDOWS_DEVICE.test(segment)) return false
  return true
}

/**
 * Splits a raw (still percent-encoded, no query) request path into decoded segments, decoding every
 * segment once. Null when anything is wrong. `/` gives an empty list.
 */
export function decodeStaticSegments(rawPath: string): string[] | null {
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

function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

interface ResolvedFile {
  file: string
  stats: Stats
}

/** The regular file at `segments` under `root`, only when its real path is still inside the real root. */
async function resolveInsideRoot(
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

// ─────────────────────────────── serving ───────────────────────────────

function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true
  return header.split(',').some((token) => token.trim().replace(/^W\//, '') === etag)
}

async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  resolved: ResolvedFile,
  assetOrigin?: string
): Promise<void> {
  const { file, stats } = resolved
  const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`
  const base: Record<string, string | number> = {
    ...baseSecurityHeaders(assetOrigin),
    // The page must always be revalidated; the ETag makes that a 304 in the common case.
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': stats.mtime.toUTCString(),
  }
  const ifNoneMatch = req.headers['if-none-match']
  if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, etag)) {
    res.writeHead(304, base)
    res.end()
    return
  }
  res.writeHead(200, {
    ...base,
    'Content-Type': staticContentType(file),
    'Content-Length': stats.size,
  })
  if (req.method === 'HEAD' || stats.size === 0) {
    res.end()
    return
  }
  try {
    await pipeline(createReadStream(file), res)
  } catch {
    // The client went away or the file vanished mid-stream: nothing more to send.
    if (!res.destroyed) res.destroy()
  }
}

export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
) => Promise<void>

/**
 * `dir` is the console build. Without it, or before the build exists, pages answer 503 with a hint; a build
 * that appears later is picked up without a restart. `pathname` is the raw request path, no query.
 */
export function createStaticHandler(dir: string | undefined, assetOrigin?: string): StaticHandler {
  return async function handleStatic(req, res, pathname) {
    const head = req.method === 'HEAD'
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendPlain(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' })
    }
    const notFound = () => sendPlain(res, 404, 'Not found', {}, head)
    const notBuilt = (text = NOT_BUILT_TEXT) =>
      sendPlain(res, 503, text, { 'Retry-After': '10' }, head)
    if (!dir) return notBuilt()
    let root: string
    try {
      root = await realpath(dir)
      if (!(await stat(root)).isDirectory()) return notBuilt()
    } catch {
      return notBuilt()
    }

    let segments: string[] = []
    if (pathname !== '/') {
      const decoded = decodeStaticSegments(
        pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
      )
      if (!decoded) return notFound()
      segments = decoded
    }
    if (segments.length > 0) {
      const hit = await resolveInsideRoot(root, segments)
      if (hit) return serveFile(req, res, hit, assetOrigin)
      // Paths that look like files are real 404s; only route-like paths fall back to the app shell.
      if (path.extname(segments[segments.length - 1] ?? '') !== '') return notFound()
    }
    const index = await resolveInsideRoot(root, ['index.html'])
    if (!index)
      return notBuilt(
        'The console build has no index.html.\nRebuild it with: npm run build -w @animatus/console\n'
      )
    return serveFile(req, res, index, assetOrigin)
  }
}
