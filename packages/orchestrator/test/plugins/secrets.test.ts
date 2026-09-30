import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CompositeSecretStore,
  EnvFileSecretStore,
  EnvVarSecretStore,
  MemorySecretStore,
  REDACTED,
  SecretStoreError,
  createRedactor,
  parseDotenv,
  redact,
  secretAliasesFrom,
  type SecretStore,
} from '../../src/plugins/secrets.ts'
import { cleanupAll, makeTempDir } from './helpers.ts'

afterEach(cleanupAll)

const VALUE = 'test-secret-123'

async function envFile(text?: string): Promise<string> {
  const dir = await makeTempDir()
  const path = join(dir, 'config', '.env')
  if (text !== undefined) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  }
  return path
}

describe('parseDotenv', () => {
  it('reads plain assignments, comments, blank lines and the export prefix', () => {
    const text = [
      '# a comment',
      '',
      'ONE=1',
      '  TWO = two words  ',
      'export THREE=3',
      '#COMMENTED=no',
      'FOUR=a=b=c',
    ].join('\n')
    expect(parseDotenv(text)).toEqual({ ONE: '1', TWO: 'two words', THREE: '3', FOUR: 'a=b=c' })
  })

  it('handles single quotes (literal), double quotes (escapes) and comments after a value', () => {
    const text = [
      "SINGLE='a #b \\n $HOME'",
      'DOUBLE="tab\\there\\nnew \\"quoted\\" back\\\\slash"',
      'WINPATH="C:\\Program Files\\bin"',
      'NEWLINE_ESCAPE="C:\\new"',
      'COMMENTED=value # trailing comment',
      "QUOTED_COMMENT='v' # comment",
      'HASH_INSIDE=abc#def',
      'EMPTY=',
      'EMPTY_QUOTED=""',
    ].join('\n')
    expect(parseDotenv(text)).toEqual({
      SINGLE: 'a #b \\n $HOME',
      DOUBLE: 'tab\there\nnew "quoted" back\\slash',
      WINPATH: 'C:\\Program Files\\bin', // unknown escapes keep their backslash
      NEWLINE_ESCAPE: 'C:\new', // but \n is an escape in double quotes (single quotes are literal)
      COMMENTED: 'value',
      QUOTED_COMMENT: 'v',
      HASH_INSIDE: 'abc#def',
      EMPTY: '',
      EMPTY_QUOTED: '',
    })
  })

  it('does not interpolate variables', () => {
    expect(parseDotenv('A=1\nB=${A}$A\nC="${A}"')).toEqual({ A: '1', B: '${A}$A', C: '${A}' })
  })

  it('reads a double-quoted value that spans lines, and takes an unclosed quote literally', () => {
    const text = 'KEY="line one\nline two"\nNEXT=1\nBROKEN="never closed\nAFTER=2'
    const parsed = parseDotenv(text)
    expect(parsed.KEY).toBe('line one\nline two')
    expect(parsed.NEXT).toBe('1')
    expect(parsed.BROKEN).toBeDefined() // the runaway quote swallows what follows or is taken literally, but never throws
  })

  it('accepts CRLF, old Mac line ends and a byte order mark; the last duplicate wins', () => {
    expect(parseDotenv('\uFEFFA=1\r\nB=2\rC=3\r\nA=4')).toEqual({ A: '4', B: '2', C: '3' })
  })

  it('ignores lines that are not assignments', () => {
    expect(parseDotenv('just words\n=novalue\nKEY WITH SPACE=1\nGOOD=1')).toEqual({ GOOD: '1' })
  })

  it('accepts the characters secret names may use', () => {
    expect(parseDotenv('a.b:c@d-e_f=1')).toEqual({ 'a.b:c@d-e_f': '1' })
  })
})

describe('EnvFileSecretStore', () => {
  it('reads nothing from a file that does not exist', async () => {
    const store = new EnvFileSecretStore(await envFile())
    expect(await store.get('gemini')).toBeUndefined()
    expect(await store.names()).toEqual([])
    await store.delete('gemini') // nothing to do, no error
  })

  it('treats an empty value (as in the shipped example file) as not set', async () => {
    const store = new EnvFileSecretStore(
      await envFile('GEMINI_API_KEY=\nOPENAI_API_KEY=\nREAL=abcdef\n')
    )
    expect(await store.get('GEMINI_API_KEY')).toBeUndefined()
    expect(await store.names()).toEqual([{ name: 'REAL', source: 'env-file' }])
  })

  it('names() never carries values', async () => {
    const store = new EnvFileSecretStore(await envFile(`A=${VALUE}\nB="${VALUE} two"\n`))
    const names = await store.names()
    expect(names).toEqual([
      { name: 'A', source: 'env-file' },
      { name: 'B', source: 'env-file' },
    ])
    expect(JSON.stringify(names)).not.toContain(VALUE)
    expect(Object.keys(names[0] ?? {}).sort()).toEqual(['name', 'source'])
  })

  it('creates the file and its directory on first set', async () => {
    const path = await envFile()
    const store = new EnvFileSecretStore(path)
    await store.set('gemini', VALUE)
    expect(await readFile(path, 'utf8')).toBe(`gemini=${VALUE}\n`)
    expect(await store.get('gemini')).toBe(VALUE)
  })

  it('round-trips awkward values through quoting', async () => {
    const path = await envFile()
    const store = new EnvFileSecretStore(path)
    const values: Record<string, string> = {
      spaces: ' leading and trailing ',
      single: "it's",
      double: 'say "hi"',
      both: `it's "both"`,
      hash: 'abc # not a comment',
      hashfirst: '#start',
      backslash: 'C:\\Tools\\name\\new',
      backslashn: "literal\\n and quote's",
      newline: 'line one\nline two\r\nline three',
      dollar: '${HOME}$PATH',
      equals: 'a=b=c',
      unicode: '\u4e2d\u6587\u5bc6\u7801-\u00e9',
      plain: 'test-plain_value-0123456789',
    }
    for (const [name, value] of Object.entries(values)) await store.set(name, value)
    const fresh = new EnvFileSecretStore(path)
    for (const [name, value] of Object.entries(values))
      expect(await fresh.get(name), name).toBe(value)
    expect(Object.keys(parseDotenv(await readFile(path, 'utf8'))).sort()).toEqual(
      Object.keys(values).sort()
    )
  })

  it('keeps comments, other keys and the line ending style when writing', async () => {
    const path = await envFile('# my keys\r\nA=1\r\n\r\n# spacing kept\r\nB=2\r\n')
    const store = new EnvFileSecretStore(path)
    await store.set('B', 'changed')
    await store.set('C', 'new')
    expect(await readFile(path, 'utf8')).toBe(
      '# my keys\r\nA=1\r\n\r\n# spacing kept\r\nB=changed\r\nC=new\r\n'
    )
  })

  it('replaces the effective (last) definition and drops older duplicates, including multi-line values', async () => {
    const path = await envFile('K=old1\nOTHER=x\nK="old\nmulti"\nAFTER=y\n')
    const store = new EnvFileSecretStore(path)
    await store.set('K', 'fresh')
    expect(await readFile(path, 'utf8')).toBe('OTHER=x\nK=fresh\nAFTER=y\n')
  })

  it('deletes every definition of a key, and leaves the file alone when the key is absent', async () => {
    const path = await envFile('A=1\nB=2\nA=3\n')
    const store = new EnvFileSecretStore(path)
    await store.delete('A')
    expect(await readFile(path, 'utf8')).toBe('B=2\n')
    await store.delete('missing')
    expect(await readFile(path, 'utf8')).toBe('B=2\n')
    await store.delete('B')
    expect(await readFile(path, 'utf8')).toBe('')
  })

  it('writes atomically: no temporary file is left behind and parallel writes do not lose each other', async () => {
    const path = await envFile('KEEP=1\n')
    const store = new EnvFileSecretStore(path)
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.set(`key${i}`, `value-${i}-${'x'.repeat(50)}`))
    )
    const names = (await store.names()).map((entry) => entry.name)
    expect(names).toHaveLength(26)
    for (let i = 0; i < 25; i++)
      expect(await store.get(`key${i}`)).toBe(`value-${i}-${'x'.repeat(50)}`)
    expect(await readdir(dirname(path))).toEqual(['.env'])
  })

  it('serialises writes to one key: the last call wins', async () => {
    const path = await envFile()
    const store = new EnvFileSecretStore(path)
    await Promise.all(['one', 'two', 'three', 'four'].map((value) => store.set('same', value)))
    expect(await store.get('same')).toBe('four')
    expect((await readFile(path, 'utf8')).match(/^same=/gm)).toHaveLength(1)
  })

  it('rejects bad names and values without echoing them', async () => {
    const store = new EnvFileSecretStore(await envFile())
    for (const name of ['', 'has space', 'a=b', 'line\nbreak', 'x'.repeat(97)]) {
      const err = await store.set(name, VALUE).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SecretStoreError)
      expect((err as SecretStoreError).code).toBe('invalid_name')
      expect((err as Error).message).not.toContain(VALUE)
    }
    for (const value of ['', 'nul\0inside']) {
      const err = await store.set('ok', value).catch((e: unknown) => e)
      expect((err as SecretStoreError).code).toBe('invalid_value')
    }
    // a caller that swapped the arguments must not see the secret in the error text
    const swapped = await store.set(VALUE + ' with space', 'name').catch((e: unknown) => e)
    expect((swapped as Error).message).not.toContain(VALUE)
    expect(await store.names()).toEqual([])
  })

  it('maps secret names to file keys with aliases', async () => {
    const path = await envFile('GEMINI_API_KEY=\nOPENAI_API_KEY=test-openai-0000\n')
    const store = new EnvFileSecretStore(path, {
      aliases: { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' },
    })
    expect(await store.get('gemini')).toBeUndefined() // present but empty
    expect(await store.get('openai')).toBe('test-openai-0000')
    expect(await store.names()).toEqual([{ name: 'openai', source: 'env-file' }])
    await store.set('gemini', VALUE)
    expect(parseDotenv(await readFile(path, 'utf8')).GEMINI_API_KEY).toBe(VALUE)
    expect((await store.names()).map((entry) => entry.name)).toEqual(['gemini', 'openai'])
    await store.delete('openai')
    expect(await store.get('openai')).toBeUndefined()
  })

  it('picks up edits made to the file while it runs', async () => {
    const path = await envFile('A=1\n')
    const store = new EnvFileSecretStore(path)
    expect(await store.get('A')).toBe('1')
    await writeFile(path, 'A=2\n')
    expect(await store.get('A')).toBe('2')
  })

  it('reports the source label it was given', async () => {
    const store = new EnvFileSecretStore(await envFile('A=abcdef\n'), { source: 'dotenv' })
    expect(await store.names()).toEqual([{ name: 'A', source: 'dotenv' }])
  })
})

describe('MemorySecretStore', () => {
  it('stores, lists names only, and deletes', async () => {
    const store = new MemorySecretStore({ b: 'two-two', a: 'one-one' })
    expect(await store.get('a')).toBe('one-one')
    expect(await store.names()).toEqual([
      { name: 'a', source: 'memory' },
      { name: 'b', source: 'memory' },
    ])
    await store.set('c', VALUE)
    await store.delete('a')
    expect((await store.names()).map((entry) => entry.name)).toEqual(['b', 'c'])
    await expect(store.set('bad name', VALUE)).rejects.toBeInstanceOf(SecretStoreError)
  })
})

describe('EnvVarSecretStore', () => {
  const env = { GEMINI_API_KEY: VALUE, EMPTY_ONE: '', OTHER: 'x-other-value', UNSET: undefined }

  it('reads from the given environment, by alias or by variable name', async () => {
    const store = new EnvVarSecretStore({
      env,
      aliases: { gemini: 'GEMINI_API_KEY', empty: 'EMPTY_ONE', ghost: 'NOT_THERE' },
    })
    expect(await store.get('gemini')).toBe(VALUE)
    expect(await store.get('OTHER')).toBe('x-other-value') // no alias: the variable of that name
    expect(await store.get('empty')).toBeUndefined() // empty counts as unset
    expect(await store.get('ghost')).toBeUndefined()
  })

  it('lists only aliased names that are set, without values', async () => {
    const store = new EnvVarSecretStore({
      env,
      aliases: { gemini: 'GEMINI_API_KEY', empty: 'EMPTY_ONE', ghost: 'NOT_THERE' },
      source: 'process-env',
    })
    const names = await store.names()
    expect(names).toEqual([{ name: 'gemini', source: 'process-env' }])
    expect(JSON.stringify(names)).not.toContain(VALUE)
  })

  it('is read-only and says which variables it reads', async () => {
    const store = new EnvVarSecretStore({ env, aliases: { gemini: 'GEMINI_API_KEY' } })
    expect(store.writable).toBe(false)
    await expect(store.set()).rejects.toMatchObject({ code: 'read_only' })
    await expect(store.delete()).rejects.toMatchObject({ code: 'read_only' })
    expect(store.envNames()).toEqual(['GEMINI_API_KEY'])
  })

  it('reads process.env by default', async () => {
    process.env.ANIMATUS_TEST_SECRET_VAR = VALUE
    try {
      expect(await new EnvVarSecretStore().get('ANIMATUS_TEST_SECRET_VAR')).toBe(VALUE)
    } finally {
      delete process.env.ANIMATUS_TEST_SECRET_VAR
    }
  })
})

describe('CompositeSecretStore', () => {
  const readOnly = (values: Record<string, string>, source = 'readonly'): SecretStore =>
    new EnvVarSecretStore({
      env: values,
      aliases: Object.fromEntries(Object.keys(values).map((k) => [k, k])),
      source,
    })

  it('lets the first store that has a name win', async () => {
    const first = new MemorySecretStore({ shared: 'from-first', only1: 'one-one' }, 'first')
    const second = new MemorySecretStore({ shared: 'from-second', only2: 'two-two' }, 'second')
    const store = new CompositeSecretStore([first, second])
    expect(await store.get('shared')).toBe('from-first')
    expect(await store.get('only1')).toBe('one-one')
    expect(await store.get('only2')).toBe('two-two')
    expect(await store.get('none')).toBeUndefined()
  })

  it('sends writes to the first writable store', async () => {
    const env = readOnly({ FROM_ENV: 'env-value' })
    const memory = new MemorySecretStore({}, 'memory')
    const later = new MemorySecretStore({}, 'later')
    const store = new CompositeSecretStore([env, memory, later])
    expect(store.writable).toBe(true)
    await store.set('fresh', VALUE)
    expect(await memory.get('fresh')).toBe(VALUE)
    expect(await later.get('fresh')).toBeUndefined()
  })

  it('refuses to write when no store is writable', async () => {
    const store = new CompositeSecretStore([readOnly({ A: 'aaaa' })])
    expect(store.writable).toBe(false)
    await expect(store.set('x', VALUE)).rejects.toMatchObject({ code: 'read_only' })
  })

  it('deletes from every writable store and leaves read-only ones alone', async () => {
    const env = readOnly({ shared: 'env-value' })
    const a = new MemorySecretStore({ shared: 'a-value' })
    const b = new MemorySecretStore({ shared: 'b-value' })
    const store = new CompositeSecretStore([a, b, env])
    await store.delete('shared')
    expect(await a.get('shared')).toBeUndefined()
    expect(await b.get('shared')).toBeUndefined()
    expect(await store.get('shared')).toBe('env-value') // the read-only store still has it
  })

  it('warns by behaviour: a read-only store listed first keeps shadowing a value written later', async () => {
    const store = new CompositeSecretStore([readOnly({ key: 'from-env' }), new MemorySecretStore()])
    await store.set('key', 'from-console')
    expect(await store.get('key')).toBe('from-env')
  })

  it('lists each name once, with the source of the store that wins, and no values', async () => {
    const store = new CompositeSecretStore([
      new MemorySecretStore({ shared: 'first-value', z: 'zzzz' }, 'first'),
      new MemorySecretStore({ shared: 'second-value', a: 'aaaa' }, 'second'),
    ])
    const names = await store.names()
    expect(names).toEqual([
      { name: 'a', source: 'second' },
      { name: 'shared', source: 'first' },
      { name: 'z', source: 'first' },
    ])
    expect(JSON.stringify(names)).not.toMatch(/first-value|second-value|zzzz|aaaa/)
  })

  it('reports every environment variable name of its stores', () => {
    const store = new CompositeSecretStore([
      readOnly({ A_KEY: 'aaaa' }),
      new MemorySecretStore(),
      readOnly({ B_KEY: 'bbbb', A_KEY: 'aaaa' }),
    ])
    expect(store.envNames().sort()).toEqual(['A_KEY', 'B_KEY'])
  })

  it('lets a store error through instead of hiding it', async () => {
    const broken: SecretStore = {
      async get() {
        throw new SecretStoreError('cannot decrypt', 'decrypt_failed')
      },
      async set() {},
      async delete() {},
      async names() {
        return []
      },
    }
    await expect(
      new CompositeSecretStore([broken, new MemorySecretStore({ a: 'aaaa' })]).get('a')
    ).rejects.toMatchObject({ code: 'decrypt_failed' })
  })
})

describe('secretAliasesFrom', () => {
  it('maps declared names to their environment variables; the first declaration wins', () => {
    const entries = [
      {
        manifest: {
          secrets: [
            { name: 'gemini', env: 'GEMINI_API_KEY' },
            { name: 'cookie', env: 'SITE_COOKIE' },
          ],
        },
      },
      { manifest: { secrets: [{ name: 'gemini', env: 'GOOGLE_API_KEY' }] } },
      { manifest: { secrets: [] } },
    ]
    expect(secretAliasesFrom(entries)).toEqual({ gemini: 'GEMINI_API_KEY', cookie: 'SITE_COOKIE' })
  })
})

describe('redact', () => {
  it('masks every occurrence of every known value', () => {
    expect(
      redact(`key=${VALUE} again ${VALUE}; other=second-secret-value`, [
        VALUE,
        'second-secret-value',
      ])
    ).toBe(`key=${REDACTED} again ${REDACTED}; other=${REDACTED}`)
  })

  it('leaves text without secrets alone, and does nothing without secrets', () => {
    expect(redact('plain log line', [VALUE])).toBe('plain log line')
    expect(redact(`has ${VALUE}`, [])).toBe(`has ${VALUE}`)
    expect(redact('', [VALUE])).toBe('')
  })

  it('masks a secret that contains another secret as a whole', () => {
    expect(redact('token=abcd-efgh-long-value', ['abcd', 'abcd-efgh-long-value'])).toBe(
      `token=${REDACTED}`
    )
  })

  it('takes values literally: regex characters and replacement patterns are not special', () => {
    const tricky = 'a.b*c+d?e(f)[g]{h}|i^j$k\\l$&m'
    expect(redact(`x ${tricky} y`, [tricky])).toBe(`x ${REDACTED} y`)
    expect(redact('aXb aYb', ['a.b'])).toBe('aXb aYb')
  })

  it('also masks the URL-encoded and JSON-escaped forms', () => {
    const value = 'p@ss word/with"quote'
    const text = `GET /x?k=${encodeURIComponent(value)} body=${JSON.stringify({ k: value })}`
    const masked = redact(text, [value])
    expect(masked).not.toContain(encodeURIComponent(value))
    expect(masked).not.toContain(JSON.stringify(value).slice(1, -1))
    expect(masked).toBe(`GET /x?k=${REDACTED} body={"k":"${REDACTED}"}`)
  })

  it('masks the lines of a multi-line secret one by one', () => {
    const key = '-----BEGIN KEY-----\nabcdefghijklmnop\nqrstuvwxyz012345\n-----END KEY-----'
    const masked = redact('leak: abcdefghijklmnop and qrstuvwxyz012345', [key])
    expect(masked).toBe(`leak: ${REDACTED} and ${REDACTED}`)
  })

  it('ignores values too short to be credible, so ordinary text is not mangled', () => {
    expect(redact('a 1 abc true', ['1', 'a', 'abc', ''])).toBe('a 1 abc true')
    expect(redact('abcd', ['abcd'])).toBe(REDACTED)
  })

  it('masks strings and keys deep inside a JSON-like value, without touching the original', () => {
    const original = {
      detail: `key ${VALUE}`,
      nested: { list: [VALUE, 1, true, null, { [VALUE]: 'x' }] },
      count: 5,
    }
    const copy = createRedactor([VALUE]).applyDeep(original)
    expect(copy).toEqual({
      detail: `key ${REDACTED}`,
      nested: { list: [REDACTED, 1, true, null, { [REDACTED]: 'x' }] },
      count: 5,
    })
    expect(JSON.stringify(original)).toContain(VALUE)
    expect(createRedactor([]).applyDeep(original)).toBe(original)
  })

  it('exposes the length of the longest thing it masks', () => {
    expect(createRedactor([]).maxLength).toBe(0)
    expect(createRedactor(['abcd', 'abcdefgh']).maxLength).toBeGreaterThanOrEqual(8)
    expect(createRedactor(['abcd']).apply('xx abcd xx')).toBe(`xx ${REDACTED} xx`)
  })
})
