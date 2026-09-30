import { describe, expect, it } from 'vitest'
import { REDACTED, Redactor, redactSecrets, secretsFromUrl } from '../../src/llm/redact.ts'
import { LlmError } from '../../src/llm/types.ts'

const KEY = 'test-key-123'

describe('redactSecrets: registered secrets', () => {
  it('removes a key from a request URL', () => {
    const text = `POST https://host.example/v1beta/models/m:streamGenerateContent?alt=sse&key=${KEY} failed`
    const out = redactSecrets(text, [KEY])
    expect(out).not.toContain(KEY)
    expect(out).toContain('https://host.example/v1beta/models/m:streamGenerateContent?alt=sse')
  })

  it('removes a key from a JSON body, wherever it appears', () => {
    const body = JSON.stringify({
      error: { message: `key ${KEY} is not valid` },
      echo: { api_key: KEY, list: [KEY] },
    })
    const out = redactSecrets(body, [KEY])
    expect(out).not.toContain(KEY)
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it('removes a key from a header dump', () => {
    const dump = [
      'POST /v1/chat/completions HTTP/1.1',
      'Host: local',
      `x-goog-api-key: ${KEY}`,
      `Authorization: Bearer ${KEY}`,
      '',
      '',
    ].join('\r\n')
    const out = redactSecrets(dump, [KEY])
    expect(out).not.toContain(KEY)
    expect(out).toContain('Host: local')
  })

  it('handles several occurrences and several secrets', () => {
    const out = redactSecrets(`a ${KEY} b other-secret-77 c ${KEY}`, [KEY, 'other-secret-77'])
    expect(out).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED}`)
  })

  it('removes the URL-encoded, JSON-escaped and base64 forms of a secret', () => {
    const secret = 'pa ss&w/rd="1"'
    expect(redactSecrets(`?p=${encodeURIComponent(secret)}`, [secret])).not.toContain('pa%20ss')
    expect(redactSecrets(JSON.stringify({ p: secret }), [secret])).not.toContain('rd=\\"1\\"')
    const b64 = Buffer.from(secret).toString('base64')
    expect(redactSecrets(`Token: ${b64}`, [secret])).not.toContain(b64)
    expect(redactSecrets(`Token: ${b64.replace(/=+$/, '')}`, [secret])).not.toContain(
      b64.replace(/=+$/, '')
    )
  })

  it('removes the longer secret as a whole when one contains another', () => {
    const out = redactSecrets('value abc-secret-long here', ['abc-secret', 'abc-secret-long'])
    expect(out).toBe(`value ${REDACTED} here`)
  })

  it('ignores empty and very short secrets instead of wrecking the text', () => {
    expect(redactSecrets('a b c', ['', 'a', 'b'])).toBe('a b c')
  })

  it('is idempotent', () => {
    const once = redactSecrets(`x?key=${KEY}`, [KEY])
    expect(redactSecrets(once, [KEY])).toBe(once)
  })
})

describe('redactSecrets: credential-looking fragments without a registered secret', () => {
  const secretValue = 'zz9top-Secret.value'

  it.each([
    ['query parameter key=', `https://x.example/a?alt=sse&key=${secretValue}&z=1`],
    ['query parameter api_key=', `https://x.example/a?api_key=${secretValue}`],
    ['query parameter apikey=', `https://x.example/a?apikey=${secretValue}`],
    ['form access_token=', `grant=1&access_token=${secretValue}&x=2`],
    ['x-goog-api-key header line', `x-goog-api-key: ${secretValue}\r\nhost: h`],
    ['Authorization header line', `Authorization: Bearer ${secretValue}`],
    ['Authorization Basic header line', `authorization: Basic ${secretValue}`],
    ['Proxy-Authorization header', `Proxy-Authorization: Basic ${secretValue}`],
    ['JSON api_key field', `{"api_key":"${secretValue}","n":1}`],
    ['JSON apiKey field', `{"apiKey": "${secretValue}"}`],
    ['JSON authorization field', `{"authorization":"Bearer ${secretValue}"}`],
    ['JSON x-goog-api-key field', `{"x-goog-api-key":"${secretValue}"}`],
    ['inspect-style header object', `{ authorization: 'Bearer ${secretValue}', host: 'h' }`],
    ['bare bearer token', `sent Bearer ${secretValue} to the server`],
    ['URL credentials', `via http://proxyuser:${secretValue}@127.0.0.1:7897/`],
  ])('%s', (_name, text) => {
    const out = redactSecrets(text, [])
    expect(out).not.toContain(secretValue)
    expect(out).toContain(REDACTED)
  })

  it('catches well-known key shapes, also partially masked', () => {
    const google = ['AIza', 'Sy', 'A'.repeat(33)].join('')
    const openai = ['sk', '-', 'proj', '-', 'b'.repeat(30)].join('')
    const masked = ['sk', '-proj-', '*'.repeat(12), 'abcd'].join('')
    const github = ['gh', 'p_', 'C'.repeat(36)].join('')
    for (const text of [
      `bad key ${google} given`,
      `Incorrect API key: ${openai}.`,
      `Incorrect API key: ${masked}.`,
      `token ${github}`,
    ]) {
      const out = redactSecrets(text, [])
      expect(out).toContain(REDACTED)
      expect(out).not.toMatch(/AIza|sk-|ghp_|abcd/)
    }
  })

  it('leaves ordinary error text alone', () => {
    for (const text of [
      'HTTP 429 RESOURCE_EXHAUSTED: You exceeded your current quota for model gemini-x',
      'API key not valid. Please pass a valid API key.',
      'no data from the provider for 15000 ms',
      'all LLM providers failed: primary=quota (HTTP 429), local=timeout',
      'Rate limit reached on requests per min. Visit https://example.test/account/billing to learn more.',
      'the task-based sk-learn style words and monkey=1',
    ]) {
      expect(redactSecrets(text, [])).toBe(text)
    }
  })
})

describe('Redactor and helpers', () => {
  it('redacts strings nested in log extras, including errors', () => {
    const r = new Redactor([KEY])
    const out = r.redactValue({
      provider: 'p',
      message: `failed with ${KEY}`,
      nested: { list: [`a ${KEY}`, 3, null], error: new Error(`boom ${KEY}`) },
      n: 4,
    })
    expect(JSON.stringify(out)).not.toContain(KEY)
    expect(out.provider).toBe('p')
    expect(out.n).toBe(4)
  })

  it('can learn secrets after construction', () => {
    const r = new Redactor()
    expect(r.redact('has late-secret-9')).toBe('has late-secret-9')
    r.add('late-secret-9')
    expect(r.redact('has late-secret-9')).toBe(`has ${REDACTED}`)
  })

  it('derives secrets from a URL with credentials and query tokens', () => {
    const secrets = secretsFromUrl('http://proxy-user:p%40ss@127.0.0.1:7897/?token=abcdef123456')
    expect(secrets).toContain('p%40ss')
    expect(secrets).toContain('p@ss')
    expect(secrets).toContain('proxy-user')
    expect(secrets).toContain(Buffer.from('proxy-user:p@ss').toString('base64'))
    expect(secrets).toContain('abcdef123456')
    expect(secretsFromUrl('not a url')).toEqual([])
  })
})

describe('LlmError', () => {
  it('scrubs credential fragments from its message and stack at construction', () => {
    const err = new LlmError(
      'bad_request',
      'request to https://h.example/x?key=leaky-value-1 failed',
      { providerId: 'p' }
    )
    expect(err.message).not.toContain('leaky-value-1')
    expect(err.stack ?? '').not.toContain('leaky-value-1')
    expect(err.name).toBe('LlmError')
    expect(err.stack ?? '').toContain('LlmError')
  })

  it('derives retryable from the code unless told otherwise', () => {
    const retryable = (code: ConstructorParameters<typeof LlmError>[0]) =>
      new LlmError(code, 'm', { providerId: 'p' }).retryable
    expect(
      ['quota', 'rate_limit', 'unavailable', 'timeout'].map((c) => retryable(c as never))
    ).toEqual([true, true, true, true])
    expect(
      ['auth', 'bad_request', 'aborted', 'protocol'].map((c) => retryable(c as never))
    ).toEqual([false, false, false, false])
    expect(new LlmError('auth', 'm', { providerId: 'p', retryable: true }).retryable).toBe(true)
  })
})
