/**
 * Secret redaction for everything the LLM layer says out loud: error messages, log lines, stats.
 *
 * Two layers, both applied by `redactSecrets` / `Redactor`:
 *
 * 1. Exact match of the secrets the caller registered (API keys, proxy credentials), in the raw form
 *    and in the forms a secret usually takes when it is echoed: URL-encoded, JSON-escaped, base64.
 * 2. Generic fragments that look like credentials whatever their value: `key=...` query parameters,
 *    `Authorization: ...` header dumps, JSON fields called `api_key` / `token`, `Bearer ...`,
 *    `scheme://user:password@host` and a few well-known key shapes. This catches a provider that
 *    echoes a masked or reformatted key back in an error body.
 *
 * Redaction is applied before an error object is created (a stack string is fixed at construction)
 * and again by the gateway as a second line of defence.
 */

export const REDACTED = '[REDACTED]'

/** Secrets shorter than this are ignored: replacing a 1-2 character string would wreck every message. */
const MIN_SECRET_LENGTH = 3

const NAME =
  'api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|key'

/** Replace the captured value and keep its quotes, so redacted JSON stays valid JSON. */
const keepQuotes = (_match: string, head: string, value: string): string => {
  const quote = value.charAt(0)
  return quote === '"' || quote === "'"
    ? `${head}${quote}${REDACTED}${quote}`
    : `${head}${REDACTED}`
}

const GENERIC_RULES: readonly (readonly [RegExp, string | ((...args: string[]) => string)])[] = [
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, `$1${REDACTED}@`],
  // Header dumps and header-like JSON: `Authorization: Bearer x`, `"x-goog-api-key": "x"`
  [
    /\b((?:(?:proxy-)?authorization|x-goog-api-key|x-api-key|api-key|x-auth-token|set-cookie|cookie)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi,
    keepQuotes,
  ],
  // Query strings and form bodies: `?key=abc&x=1`
  [new RegExp(`\\b(${NAME})=([^&\\s"'<>#]+)`, 'gi'), `$1=${REDACTED}`],
  // JSON fields: `"api_key": "abc"`
  [new RegExp(`(["'](?:${NAME})["']\\s*:\\s*)("[^"]*"|'[^']*'|[^\\s,}\\]]+)`, 'gi'), keepQuotes],
  // Bearer tokens anywhere
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // Well-known key shapes (also catches partially masked echoes such as `sk-proj-****abcd`)
  [/AIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_*-]{8,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
]

/** Apply only the value-independent rules. Used by `LlmError` so even a bare error carries no obvious credential. */
export function redactGeneric(text: string): string {
  let out = text
  for (const [re, replacement] of GENERIC_RULES) {
    // `replace` has separate overloads for a string and for a function.
    out =
      typeof replacement === 'string' ? out.replace(re, replacement) : out.replace(re, replacement)
  }
  return out
}

/** The forms in which `secret` is likely to show up inside a URL, a JSON body or a header dump. */
function variantsOf(secret: string): string[] {
  const out = new Set<string>([secret])
  try {
    out.add(encodeURIComponent(secret))
  } catch {
    // lone surrogate: not URL-encodable, the raw form is still covered
  }
  out.add(JSON.stringify(secret).slice(1, -1))
  const b64 = Buffer.from(secret, 'utf8').toString('base64')
  out.add(b64)
  out.add(b64.replace(/=+$/, ''))
  out.add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  return [...out].filter((v) => v.length >= MIN_SECRET_LENGTH)
}

/**
 * Secrets derived from a URL a user configured: credentials in the authority and query values.
 * A base URL or proxy URL can carry a token without being called a key.
 */
export function secretsFromUrl(raw: string): string[] {
  const out: string[] = []
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return out
  }
  const safeDecode = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  if (url.password) out.push(url.password, safeDecode(url.password))
  if (url.username) out.push(url.username, safeDecode(url.username))
  if (url.username || url.password) {
    out.push(
      Buffer.from(`${safeDecode(url.username)}:${safeDecode(url.password)}`).toString('base64')
    )
  }
  for (const value of url.searchParams.values()) if (value.length >= 8) out.push(value)
  return out
}

/** A set of secrets with the redaction function built from them. Cheap to call repeatedly. */
export class Redactor {
  #variants: string[] = []
  #known = new Set<string>()

  constructor(secrets: readonly string[] = []) {
    this.add(...secrets)
  }

  add(...secrets: readonly (string | undefined | null)[]): void {
    for (const secret of secrets) {
      if (
        typeof secret !== 'string' ||
        secret.length < MIN_SECRET_LENGTH ||
        this.#known.has(secret)
      )
        continue
      this.#known.add(secret)
      this.#variants.push(...variantsOf(secret))
    }
    // Longest first, so a secret that contains another is removed as a whole.
    this.#variants = [...new Set(this.#variants)].sort((a, b) => b.length - a.length)
  }

  redact(text: string): string {
    let out = text
    for (const v of this.#variants) if (out.includes(v)) out = out.split(v).join(REDACTED)
    return redactGeneric(out)
  }

  /** Redact every string inside a log `extra` object (plain objects, arrays, errors; bounded depth). */
  redactValue<T>(value: T): T {
    return mapStrings(value, (s) => this.redact(s))
  }
}

/** `text` with every registered secret and every credential-looking fragment replaced by `[REDACTED]`. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  return new Redactor(secrets).redact(text)
}

const MAX_DEPTH = 5

/**
 * A copy of `value` with `fn` applied to every string in it (plain objects, arrays and errors; bounded
 * depth). Used for the `extra` object of a log call.
 */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  return walk(value, fn, 0) as T
}

function walk(value: unknown, fn: (s: string) => string, depth: number): unknown {
  if (typeof value === 'string') return fn(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (value instanceof Error) return fn(`${value.name}: ${value.message}`)
  if (Array.isArray(value)) return value.map((v) => walk(v, fn, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = walk(v, fn, depth + 1)
  return out
}
