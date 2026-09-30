import { describe, expect, it } from 'vitest'
import { entropy, globToRegExp, redact, scanText } from './rules.mjs'

// Samples are built from pieces so this file itself stays clean under the scanner.
const rnd = (n, alphabet = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY') =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('')

const ids = (text, opts) => scanText(text, opts).map((f) => f.rule)

describe('scanText', () => {
  it('finds a Google API key and never echoes it', () => {
    const key = 'AI' + 'za' + rnd(35)
    const hits = scanText(`const k = "${key}"`)
    expect(hits.map((h) => h.rule)).toContain('google-api-key')
    for (const h of hits) expect(h.preview).not.toContain(key.slice(6))
  })

  it('finds provider tokens', () => {
    expect(ids('x = ' + 'sk-' + 'ant-' + rnd(40))).toContain('anthropic-key')
    expect(ids('x = ' + 'sk-' + rnd(40))).toContain('openai-style-key')
    expect(ids('x = ' + 'gh' + 'p_' + rnd(40, 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1'))).toContain(
      'github-token'
    )
    expect(ids('id = ' + 'AK' + 'IA' + 'ABCDEFGH12345678')).toContain('aws-access-key')
    expect(ids('-----BEGIN ' + 'RSA PRIVATE KEY-----')).toContain('private-key-block')
  })

  it('finds Bilibili cookie values but not placeholders', () => {
    expect(ids('SESS' + 'DATA=' + rnd(30))).toContain('bilibili-cookie')
    expect(ids('SESS' + 'DATA=your-sessdata-here')).not.toContain('bilibili-cookie')
    expect(ids('bili_jct=${BILI_JCT}')).not.toContain('bilibili-cookie')
  })

  it('flags secret-looking assignments, skips placeholders and low-entropy values', () => {
    expect(ids(`api_key: "${rnd(32)}"`)).toContain('generic-secret-assignment')
    expect(ids('api_key: "your-api-key-goes-here-please"')).not.toContain(
      'generic-secret-assignment'
    )
    expect(ids('token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"')).not.toContain('generic-secret-assignment')
    expect(ids('password = process.env.PASSWORD_FROM_ENV_VAR_LONG')).not.toContain(
      'generic-secret-assignment'
    )
  })

  it('flags personal Windows paths but allows placeholders', () => {
    const win = 'C:\\Us' + 'ers\\'
    const nix = 'C:/Us' + 'ers/'
    expect(ids(win + 'alice\\project')).toContain('personal-path')
    expect(ids(nix + 'bob/x')).toContain('personal-path')
    expect(ids(win + '<you>\\project')).not.toContain('personal-path')
    expect(ids('%USERPROFILE%\\x and ' + win + 'Public\\x')).not.toContain('personal-path')
  })

  it('applies the private deny list case-insensitively without printing the term', () => {
    const hits = scanText('Some Secret-Name here', { denyTerms: ['secret-name'] })
    expect(hits).toHaveLength(1)
    expect(hits[0].rule).toBe('deny-term')
    expect(hits[0].preview).not.toMatch(/secret-name/i)
  })

  it('reports line numbers', () => {
    const hits = scanText('ok\nok\n' + 'AI' + 'za' + rnd(35))
    expect(hits[0].line).toBe(3)
  })

  it('skips very long lines (minified output)', () => {
    expect(scanText('x'.repeat(5000) + 'AI' + 'za' + rnd(35))).toEqual([])
  })
})

describe('helpers', () => {
  it('entropy orders values sensibly', () => {
    expect(entropy('aaaaaaaa')).toBe(0)
    expect(entropy(rnd(32))).toBeGreaterThan(3)
  })
  it('redact keeps at most 3 characters', () => {
    expect(redact('abcdefghij')).toMatch(/^abc\*+ \(10 chars\)$/)
    expect(redact('ab')).toBe('***')
  })
  it('globToRegExp handles * and **', () => {
    expect(globToRegExp('docs/*.md').test('docs/a.md')).toBe(true)
    expect(globToRegExp('docs/*.md').test('docs/x/a.md')).toBe(false)
    expect(globToRegExp('**/fixtures/**').test('a/b/fixtures/c/d.txt')).toBe(true)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
  })
})
