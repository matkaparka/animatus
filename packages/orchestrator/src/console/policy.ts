/**
 * The console server's request policy: which Host and Origin values it answers, and the headers every
 * response carries. Pure functions, no I/O.
 */

/** Sent with every response. The console loads only its own scripts and styles and talks only to itself. */
export const CONSOLE_CSP =
  "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

/** Headers on every response, static files and API alike. Never any CORS header. */
export function baseSecurityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': CONSOLE_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
  }
}

/**
 * DNS-rebinding defence: a page on `evil.example` whose name resolves to 127.0.0.1 is same-origin with
 * itself, so the only defence is to refuse every request whose `Host` is not one of ours. The header must
 * be exactly `127.0.0.1:<port>` or `localhost:<port>` (case-insensitive) with the port we are bound to.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false
  const h = host.trim().toLowerCase()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`
}

/** Lower-case, no trailing slash: how configured origins are compared. */
export function normalizeConfiguredOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '')
}

/**
 * Validates `extraOrigins` (for example a Vite dev server, `http://127.0.0.1:5174`): each entry must be a
 * plain `http(s)://host[:port]` origin. `null`, wildcards, paths and anything else throw at start-up
 * instead of quietly widening the policy.
 */
export function parseExtraOrigins(list: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of list) {
    const origin = normalizeConfiguredOrigin(entry)
    if (!/^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/.test(origin)) {
      throw new Error(
        `invalid extra origin ${JSON.stringify(entry)}: expected http(s)://host[:port]`
      )
    }
    out.push(origin)
  }
  return out
}

/** The set of `Origin` header values that may talk to a console server bound to `port`. */
export function allowedOrigins(port: number, extraOrigins: readonly string[]): Set<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraOrigins])
}

/**
 * `undefined` (no Origin header: non-browser tools, top-level navigations) passes here; API routes still
 * need the token. A present Origin must be listed exactly, including `null` and empty values, which fail.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) return true
  return allowed.has(origin.trim().toLowerCase())
}

/** The peer address as a rate-limit key, with the IPv4-mapped IPv6 prefix removed. */
export function addressKey(remoteAddress: string | undefined): string {
  if (!remoteAddress) return 'unknown'
  return remoteAddress.toLowerCase().replace(/^::ffff:/, '')
}

/** Request target without query or fragment, still percent-encoded. Null unless it is origin-form (`/...`). */
export function rawPathOf(url: string | undefined): string | null {
  if (!url || !url.startsWith('/')) return null
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

/** The query string of a request target (without `?`), or ''. */
export function rawQueryOf(url: string | undefined): string {
  if (!url) return ''
  const q = url.indexOf('?')
  if (q === -1) return ''
  const hash = url.indexOf('#', q)
  return url.slice(q + 1, hash === -1 ? undefined : hash)
}

/** What may appear in a log line for a path: never the name of a secret. */
export function pathForLog(pathname: string): string {
  if (pathname.startsWith('/api/secrets/')) return '/api/secrets/:name'
  return pathname.length > 120 ? `${pathname.slice(0, 120)}...` : pathname
}
