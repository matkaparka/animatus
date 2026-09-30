import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConfigError,
  camelizeKeys,
  loadConfig,
  parseConfig,
  publicConfig,
  resolveSecrets,
  secretRefs,
  toProviderConfig,
} from '../src/config.ts'
import type { LlmProviderEntry } from '../src/config.ts'
import { MemorySecretStore } from '../src/plugins/secrets.ts'

const ROOT = path.resolve('/project')
const cfg = (raw: unknown = {}) => parseConfig(raw, { root: ROOT })
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

describe('parseConfig defaults', () => {
  it('an empty file is a valid, empty stage', () => {
    const c = cfg({})
    expect(c.servers).toEqual({ stage_port: 5810, console_port: 5811 })
    expect(c.stage.model).toBeNull()
    expect(c.stage.browser).toBeNull()
    expect(c.stage.camera.fit).toBe('upper_body')
    expect(c.stage.background).toEqual({ kind: 'none' })
    expect(c.llm.providers).toEqual([])
    expect(c.llm.history_messages).toBe(10)
    expect(c.speech.first_comma_min_chars).toBe(10)
    expect(c.plugins).toEqual({})
    expect(c.inbox.filter.maxMerge).toBe(3)
    expect(c.inbox.pacer.idleSettleSec).toBe(1.5)
  })

  it('makes paths absolute against the root and leaves absolute ones alone', () => {
    const abs = path.resolve('/elsewhere/models')
    const c = cfg({
      paths: { models: abs, motions: './motions' },
      persona: './personas/mine',
      speech: { sensitive_words_file: 'config/words.txt' },
      stage: { browser: { executable: 'C:/chrome.exe' } },
    })
    expect(c.root).toBe(ROOT)
    expect(c.paths.data_dir).toBe(path.join(ROOT, 'data'))
    expect(c.paths.models).toBe(abs)
    expect(c.paths.motions).toBe(path.join(ROOT, 'motions'))
    expect(c.paths.songs).toBeUndefined()
    expect(c.persona).toBe(path.join(ROOT, 'personas', 'mine'))
    expect(c.speech.sensitive_words_file).toBe(path.join(ROOT, 'config', 'words.txt'))
    expect(c.stage.browser?.profile_dir).toBe(path.join(ROOT, 'data', 'animatus-stage-profile'))
    expect(c.stage.browser?.window_size).toEqual([1920, 1080])
  })
})

describe('parseConfig validation', () => {
  it('reports every problem with its path, and never echoes a key value', () => {
    const secret = ['sk', 'live', 'do', 'not', 'print', '0123456789'].join('-')
    let message = ''
    try {
      cfg({
        servers: { stage_port: 80 },
        llm: { providers: [{ kind: 'gemini', id: 'a', model: 'm', api_key: secret, bogus: 1 }] },
      })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('invalid configuration')
    expect(message).toContain('servers.stage_port')
    expect(message).toContain('llm.providers.0')
    expect(message).not.toContain(secret)
  })

  it('a misspelt key is an error, not a silent default', () => {
    expect(() => cfg({ server: {} })).toThrow(ConfigError)
    expect(() => cfg({ stage: { modle: 'x.vrm' } })).toThrow(/modle|Unrecognized/i)
  })

  it('the two ports must differ', () => {
    expect(() => cfg({ servers: { stage_port: 5810, console_port: 5810 } })).toThrow(/must differ/)
  })

  it('llm.order may only name configured providers, and ids are unique', () => {
    const p = {
      kind: 'openai-compatible',
      id: 'local',
      base_url: 'http://127.0.0.1:8081/v1',
      model: 'm',
    }
    expect(cfg({ llm: { providers: [p], order: ['local'] } }).llm.order).toEqual(['local'])
    expect(() => cfg({ llm: { providers: [p], order: ['nope'] } })).toThrow(
      /no provider with id "nope"/
    )
    expect(() => cfg({ llm: { providers: [p, p] } })).toThrow(/unique/)
  })

  it('a provider needs its kind-specific fields', () => {
    expect(() => cfg({ llm: { providers: [{ kind: 'gemini', id: 'g', model: 'm' }] } })).toThrow(
      /api_key/
    )
    expect(() =>
      cfg({ llm: { providers: [{ kind: 'openai-compatible', id: 'o', model: 'm' }] } })
    ).toThrow(/base_url/)
    expect(() => cfg({ llm: { providers: [{ kind: 'other', id: 'o', model: 'm' }] } })).toThrow(
      ConfigError
    )
  })

  it('when styles are given the default style must be one of them', () => {
    const style = { ref_audio: 'a.wav', ref_text: 'hi' }
    expect(() => cfg({ tts: { styles: { happy: style } } })).toThrow(/default_style/)
    expect(cfg({ tts: { styles: { neutral: style } } }).tts.styles.neutral?.ref_text).toBe('hi')
    expect(
      cfg({ tts: { styles: { happy: style }, default_style: 'happy' } }).tts.default_style
    ).toBe('happy')
  })

  it('plugin and mode ids are lowercase kebab', () => {
    expect(() => cfg({ plugins: { GPT_SoVITS: { enabled: true } } })).toThrow(ConfigError)
    expect(
      cfg({ plugins: { gptsovits: { enabled: true, config: { root: 'x' } } } }).plugins.gptsovits
        ?.config
    ).toEqual({ root: 'x' })
  })
})

describe('the inbox section', () => {
  it('is written in snake_case and reaches the router in camelCase', () => {
    const c = cfg({
      inbox: {
        filter: { max_merge: 5, danmaku_max_age_sec: 12 },
        ignore_uids: [7],
        sleep: { reply_interval_sec: 30 },
      },
    })
    expect(c.inbox.filter.maxMerge).toBe(5)
    expect(c.inbox.filter.danmakuMaxAgeSec).toBe(12)
    expect(c.inbox.ignoreUids).toEqual([7])
    expect(c.inbox.sleep.replyIntervalSec).toBe(30)
    expect(c.inbox.sleep.firstReplyAfterSec).toBe(30)
  })

  it('an unknown inbox key is an error', () => {
    expect(() => cfg({ inbox: { filtr: {} } })).toThrow(/invalid inbox configuration/)
    expect(() => cfg({ inbox: { filter: { max_merge: 0 } } })).toThrow(/maxMerge/)
  })

  it('camelizeKeys handles nesting and arrays', () => {
    expect(camelizeKeys({ a_b: [{ c_d: 1 }], e: { f_g_h: 2 } })).toEqual({
      aB: [{ cD: 1 }],
      e: { fGH: 2 },
    })
  })
})

describe('secrets in the configuration', () => {
  const store = new MemorySecretStore({ gemini: 'AIza-test-value', 'my.key': 'other' })

  it('finds references anywhere in a string', () => {
    expect(secretRefs('plain')).toEqual([])
    expect(secretRefs('${secret:gemini}')).toEqual(['gemini'])
    expect(secretRefs('Bearer ${secret:a}:${secret:b.c}')).toEqual(['a', 'b.c'])
  })

  it('resolves them from the store', async () => {
    expect(await resolveSecrets('plain', store)).toBe('plain')
    expect(await resolveSecrets('${secret:gemini}', store)).toBe('AIza-test-value')
    expect(await resolveSecrets('k=${secret:gemini}&j=${secret:my.key}', store)).toBe(
      'k=AIza-test-value&j=other'
    )
  })

  it('a missing secret names itself and nothing else', async () => {
    await expect(resolveSecrets('${secret:missing}', store)).rejects.toThrow(
      /secret "missing" is not set/
    )
    await expect(resolveSecrets('${secret:gemini}${secret:missing}', store)).rejects.toThrow(
      ConfigError
    )
    try {
      await resolveSecrets('${secret:gemini}${secret:missing}', store)
    } catch (e) {
      expect((e as Error).message).not.toContain('AIza-test-value')
    }
  })

  it('maps a provider entry to the gateway configuration with the key resolved', async () => {
    const entry: LlmProviderEntry = {
      kind: 'gemini',
      id: 'primary',
      model: 'gem',
      api_key: '${secret:gemini}',
      proxy: 'http://127.0.0.1:7897',
      thinking_level: 'minimal',
      generation_config: { top_k: 5, snake_case_key: true },
      timeout_ms: 20000,
    }
    expect(await toProviderConfig(entry, store)).toEqual({
      kind: 'gemini',
      id: 'primary',
      model: 'gem',
      apiKey: 'AIza-test-value',
      proxy: 'http://127.0.0.1:7897',
      thinkingLevel: 'minimal',
      generationConfig: { top_k: 5, snake_case_key: true },
      timeoutMs: 20000,
    })
  })

  it('an OpenAI-compatible provider may have no key at all', async () => {
    const entry: LlmProviderEntry = {
      kind: 'openai-compatible',
      id: 'local',
      model: 'm',
      base_url: 'http://127.0.0.1:8081/v1',
      extra_body: { some_flag: 1 },
      max_tokens_field: 'max_completion_tokens',
    }
    const out = await toProviderConfig(entry, store)
    expect(out).toEqual({
      kind: 'openai-compatible',
      id: 'local',
      model: 'm',
      baseUrl: 'http://127.0.0.1:8081/v1',
      extraBody: { some_flag: 1 },
      maxTokensField: 'max_completion_tokens',
    })
    expect('apiKey' in out).toBe(false)
  })

  it('what the console may show keeps the reference and drops the machine-specific root', () => {
    const c = cfg({
      llm: { providers: [{ kind: 'gemini', id: 'g', model: 'm', api_key: '${secret:gemini}' }] },
    })
    const shown = publicConfig(c)
    const text = JSON.stringify(shown)
    expect(text).toContain('${secret:gemini}')
    expect(shown.root).toBeUndefined()
    expect(shown.file).toBeUndefined()
  })
})

describe('loadConfig', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'animatus-config-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads YAML, with or without a byte-order mark, and uses the folder above config/ as the root', async () => {
    await import('node:fs/promises').then((fs) => fs.mkdir(path.join(dir, 'config')))
    const file = path.join(dir, 'config', 'animatus.config.yaml')
    await writeFile(
      file,
      '\u{FEFF}version: 1\nservers:\n  stage_port: 6000\n  console_port: 6001\n'
    )
    const c = await loadConfig(file)
    expect(c.servers.stage_port).toBe(6000)
    expect(c.root).toBe(dir)
    expect(c.file).toBe(file)
    expect(c.paths.data_dir).toBe(path.join(dir, 'data'))
  })

  it('says where it looked when the file is missing', async () => {
    await expect(loadConfig(path.join(dir, 'nope.yaml'))).rejects.toThrow(/not found.*nope\.yaml/s)
  })

  it('reports YAML syntax errors as configuration errors', async () => {
    const file = path.join(dir, 'bad.yaml')
    await writeFile(file, 'servers: [unclosed\n')
    await expect(loadConfig(file)).rejects.toThrow(ConfigError)
  })

  it('an empty file is fine', async () => {
    const file = path.join(dir, 'empty.yaml')
    await writeFile(file, '')
    expect((await loadConfig(file, { root: dir })).servers.stage_port).toBe(5810)
  })
})

describe('the shipped example', () => {
  it('config.example/animatus.config.yaml parses under the schema', async () => {
    const c = await loadConfig(path.join(REPO, 'config.example', 'animatus.config.yaml'), {
      root: REPO,
    })
    expect(c.version).toBe(1)
    expect(c.llm.providers.length).toBeGreaterThan(0)
  })
})
