import { describe, expect, it } from 'vitest'
import { ApiFailure } from '../../src/console/backend.ts'
import { REDACTED_VALUE, isSecretKey, sanitizeConfig } from '../../src/console/config.ts'

describe('isSecretKey', () => {
  it.each([
    'token',
    'access_token',
    'authToken',
    'bili-token',
    'password',
    'db_password',
    'passwd',
    'secret',
    'client_secret',
    'cookie',
    'bili_cookie',
    'X-Cookie',
    'authorization',
    'Authorization',
    'sessdata',
    'apiKey',
    'api_key',
    'API_KEY',
    'apikey',
    'access_key',
    'private_key',
    'secret_key',
    'auth_key',
    'license_key',
    'signing_key',
    'session_key',
    'encryption_key',
  ])('%s is a secret', (key) => {
    expect(isSecretKey(key)).toBe(true)
  })

  it.each([
    'model',
    'max_tokens',
    'tokens',
    'token_limit',
    'hotkey',
    'sort_key',
    'primary_key',
    'cache_key',
    'key',
    'keys',
    'api_key_env',
    'secrets',
    'passwordless',
    'cookie_policy',
    'author',
    '',
    '0',
    'a.b.c',
  ])('%s is not', (key) => {
    expect(isSecretKey(key)).toBe(false)
  })
})

describe('sanitizeConfig', () => {
  it('masks strings under secret-looking keys at any depth, and only strings', () => {
    const out = sanitizeConfig({
      llm: {
        api_key: 'abcdef',
        model: 'm',
        max_tokens: 300,
        nested: { bili_cookie: 'zzz', list: [{ token: 'ttt', keep: 1 }] },
      },
      password: 12345,
      secret: true,
      cookie: { a: 'b' },
      empty_token: '',
    })
    expect(out).toEqual({
      llm: {
        api_key: REDACTED_VALUE,
        model: 'm',
        max_tokens: 300,
        nested: { bili_cookie: REDACTED_VALUE, list: [{ token: REDACTED_VALUE, keep: 1 }] },
      },
      password: 12345,
      secret: true,
      cookie: { a: 'b' },
      empty_token: '',
    })
  })

  it('returns a JSON-safe copy: no shared references, no functions, no undefined', () => {
    const input = { a: { b: 1 }, f: () => 1, u: undefined, d: new Date(0), big: 10n }
    const out = sanitizeConfig(input)
    expect(out).toEqual({ a: { b: 1 }, d: '1970-01-01T00:00:00.000Z', big: '10' })
    expect(out.a).not.toBe(input.a)
  })

  it('refuses what is not an object, cannot be serialised, or is too big', () => {
    for (const bad of [null, undefined, 'x', 1, [], [{}]]) {
      expect(() => sanitizeConfig(bad), String(bad)).toThrow(ApiFailure)
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => sanitizeConfig(cyclic)).toThrow(/cannot be serialised/)
    expect(() => sanitizeConfig({ blob: 'x'.repeat(300 * 1024) })).toThrow(/too large/)
    try {
      sanitizeConfig(null)
    } catch (err) {
      expect((err as ApiFailure).httpStatus).toBe(500)
    }
  })
})
