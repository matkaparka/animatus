/**
 * The per-launch token and the brake on guessing it.
 *
 * The token is 32 random bytes, base64url, made fresh every time the orchestrator starts. It travels in the
 * URL fragment (`#token=...`, which browsers never send to a server) and afterwards as
 * `Authorization: Bearer` on HTTP and as the `token.<token>` subprotocol on WebSocket. It is compared in
 * constant time and never appears in a log line, a response or a URL the server sees.
 */
import crypto from 'node:crypto'
import { CONSOLE_TOKEN_PROTOCOL_PREFIX, ConsoleToken } from '@animatus/protocol'

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** Throws for a token that could not travel safely. The message never contains the token. */
export function assertValidToken(token: string): void {
  if (!ConsoleToken.safeParse(token).success) {
    throw new Error('the console token must be 8 to 128 characters from A-Z a-z 0-9 . _ ~ -')
  }
}

const sha256 = (text: string): Buffer => crypto.createHash('sha256').update(text, 'utf8').digest()

export type TokenVerifier = (presented: string | undefined) => boolean

/**
 * Compares in constant time. Both sides are hashed first, so `timingSafeEqual` always sees two 32-byte
 * buffers: a token of the wrong length takes the same path as one of the right length, and nothing about
 * the expected token's length leaks.
 */
export function createTokenVerifier(expected: string): TokenVerifier {
  const expectedDigest = sha256(expected)
  return (presented) => {
    if (typeof presented !== 'string') return false
    return crypto.timingSafeEqual(sha256(presented), expectedDigest)
  }
}

/** The token of `Authorization: Bearer <token>` (scheme case-insensitive), or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const m = /^Bearer +([^\s,]+)$/i.exec(header.trim())
  return m?.[1]
}

/** Comma-separated `Sec-WebSocket-Protocol` values, trimmed, empty ones dropped. */
export function parseSubprotocols(header: string | undefined): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

/**
 * The token a WebSocket client offered. Exactly one `token.<token>` entry counts: a client that offers
 * several would get several guesses for the price of one failure, so more than one means no token at all.
 */
export function tokenFromSubprotocols(protocols: readonly string[]): string | undefined {
  const tokens = protocols.filter((p) => p.startsWith(CONSOLE_TOKEN_PROTOCOL_PREFIX))
  if (tokens.length !== 1) return undefined
  return (tokens[0] as string).slice(CONSOLE_TOKEN_PROTOCOL_PREFIX.length)
}

// ─────────────────────────────── failure limiter ───────────────────────────────

export interface FailureLimiterOptions {
  /** Failures inside the window that trip the block. Default 10. */
  maxFailures?: number
  /** Default 60 000. */
  windowMs?: number
  /** How long a tripped address is refused. Default 60 000. */
  blockMs?: number
  /** Injectable clock. */
  now?: () => number
  /** Keeps the table small even if addresses vary. Default 256. */
  maxKeys?: number
}

interface AddressRecord {
  failures: number[]
  blockedUntil: number
}

/**
 * Counts failed authentications per address. The failure that makes ten inside a minute trips the block;
 * from the next request on the address is refused with 429 for a minute, whatever token it presents (a
 * check that admitted the right token would tell a guesser when it guessed right).
 */
export class FailureLimiter {
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly blockMs: number
  private readonly now: () => number
  private readonly maxKeys: number
  private readonly records = new Map<string, AddressRecord>()

  constructor(options: FailureLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 10
    this.windowMs = options.windowMs ?? 60_000
    this.blockMs = options.blockMs ?? 60_000
    this.now = options.now ?? Date.now
    this.maxKeys = options.maxKeys ?? 256
  }

  /** Milliseconds until `key` may try again, 0 when it is not blocked. */
  retryAfterMs(key: string): number {
    const record = this.records.get(key)
    if (!record) return 0
    return Math.max(0, record.blockedUntil - this.now())
  }

  /** Returns true when this failure tripped the block. */
  recordFailure(key: string): boolean {
    const now = this.now()
    this.prune(now)
    const record: AddressRecord = this.records.get(key) ?? { failures: [], blockedUntil: 0 }
    record.failures = record.failures.filter((t) => now - t < this.windowMs)
    record.failures.push(now)
    let tripped = false
    if (record.failures.length >= this.maxFailures) {
      record.blockedUntil = now + this.blockMs
      record.failures = []
      tripped = true
    }
    this.records.set(key, record)
    return tripped
  }

  get size(): number {
    return this.records.size
  }

  private prune(now: number): void {
    if (this.records.size < this.maxKeys) return
    for (const [key, record] of this.records) {
      const idle = record.failures.every((t) => now - t >= this.windowMs)
      if (idle && record.blockedUntil <= now) this.records.delete(key)
    }
    // Still full (a flood of live keys): drop the oldest entries rather than grow.
    while (this.records.size >= this.maxKeys) {
      const oldest = this.records.keys().next().value
      if (oldest === undefined) break
      this.records.delete(oldest)
    }
  }
}
