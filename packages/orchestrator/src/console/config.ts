/**
 * `GET /api/config` shows the orchestrator's configuration on the console's settings page. The backend
 * hands over an already sanitised object; this is the second line of defence: a string under a key that
 * names a secret (`token`, `password`, `api_key`, `cookie` ...) is replaced before it leaves the process,
 * whatever the backend meant to do.
 */
import { ApiFailure } from './backend.ts'

export const REDACTED_VALUE = '[redacted]'

/** A cap on what one response may carry, so a runaway object cannot flood the browser. */
const MAX_CONFIG_BYTES = 256 * 1024

/** Words that make a key secret when they end it: `bili_token`, `apiKey` (api + key), `X-Cookie`. */
const SECRET_LAST_WORDS = new Set([
  'token',
  'password',
  'passwd',
  'secret',
  'cookie',
  'authorization',
  'sessdata',
  'apikey',
])
/** `key` alone is too common (`hotkey`, `sort_key`); it only counts after one of these. */
const KEY_QUALIFIERS = new Set([
  'api',
  'access',
  'private',
  'secret',
  'auth',
  'license',
  'signing',
  'session',
  'encryption',
])

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '')
}

/** True when a configuration key names something that must not be shown. */
export function isSecretKey(key: string): boolean {
  const words = keyWords(key)
  const last = words[words.length - 1]
  if (last === undefined) return false
  if (SECRET_LAST_WORDS.has(last)) return true
  const before = words[words.length - 2]
  return last === 'key' && before !== undefined && KEY_QUALIFIERS.has(before)
}

/**
 * Returns a JSON-safe copy of `config` with secret-looking string values masked. Numbers and booleans under
 * such keys are left alone (a `max_tokens: 300` is not a secret), as are empty strings. Throws
 * `ApiFailure(500)` when the object cannot be serialised or is too large.
 */
export function sanitizeConfig(config: unknown): Record<string, unknown> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new ApiFailure('config_invalid', 'the configuration is not an object', 500)
  }
  let text: string
  try {
    text = JSON.stringify(config, (key, value: unknown) => {
      if (key !== '' && isSecretKey(key) && typeof value === 'string' && value !== '')
        return REDACTED_VALUE
      if (typeof value === 'bigint') return value.toString()
      return value
    })
  } catch {
    throw new ApiFailure(
      'config_invalid',
      'the configuration cannot be serialised (cycle or depth)',
      500
    )
  }
  if (text === undefined || Buffer.byteLength(text) > MAX_CONFIG_BYTES) {
    throw new ApiFailure('config_too_large', 'the configuration is too large to show', 500)
  }
  return JSON.parse(text) as Record<string, unknown>
}
