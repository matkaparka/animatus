import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { parseConfig } from '../../src/config.ts'
import { MemorySecretStore } from '../../src/plugins/secrets.ts'
import { runSetup } from '../../src/cli/wizard.ts'
import type { Fs, Prompter } from '../../src/cli/wizard.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/** A repository folder with a persona in it and a folder with a model, a motion folder, a voice and a GPT-SoVITS folder. */
async function world() {
  const root = await mkdtemp(path.join(tmpdir(), 'animatus-setup-'))
  dirs.push(root)
  const p = (...parts: string[]) => path.join(root, ...parts).replace(/\\/g, '/')
  await mkdir(path.join(root, 'personas', 'example'), { recursive: true })
  await writeFile(path.join(root, 'personas', 'example', 'persona.md'), '# persona')
  await mkdir(path.join(root, 'personas', 'mine'), { recursive: true })
  await writeFile(path.join(root, 'personas', 'mine', 'persona.md'), '# mine')
  await mkdir(path.join(root, 'stuff', 'models'), { recursive: true })
  await writeFile(path.join(root, 'stuff', 'models', 'a.vrm'), 'x')
  await mkdir(path.join(root, 'stuff', 'motions'), { recursive: true })
  await mkdir(path.join(root, 'stuff', 'gsv', 'runtime'), { recursive: true })
  await writeFile(path.join(root, 'stuff', 'gsv', 'runtime', 'python.exe'), 'x')
  await mkdir(path.join(root, 'stuff', 'gsv', 'GPT_SoVITS', 'configs'), { recursive: true })
  await writeFile(path.join(root, 'stuff', 'gsv', 'GPT_SoVITS', 'configs', 'tts_infer.yaml'), 'x')
  await writeFile(path.join(root, 'stuff', 'ref.wav'), 'x')
  await writeFile(path.join(root, 'stuff', 'chrome.exe'), 'x')
  return { root, p }
}

const realFs: Fs = {
  async exists(pth) {
    try {
      const { stat } = await import('node:fs/promises')
      return (await stat(pth)).isDirectory() ? 'dir' : 'file'
    } catch {
      return null
    }
  },
  async listDir(pth) {
    const { readdir } = await import('node:fs/promises')
    try {
      return await readdir(pth)
    } catch {
      return []
    }
  },
  mkdirp: async (pth) => void (await mkdir(pth, { recursive: true })),
  writeFile: (pth, text) => writeFile(pth, text, 'utf8'),
}

/** A person, as a script: what they type, in order. Questions that were not scripted fail the test. */
function scripted(answers: (string | boolean | number)[]) {
  const said: string[] = []
  const asked: string[] = []
  const queue = [...answers]
  const next = (kind: string, q: string): string | boolean | number => {
    asked.push(`${kind}: ${q}`)
    if (queue.length === 0) throw new Error(`nothing scripted for: ${q}`)
    return queue.shift() as string | boolean | number
  }
  const prompt: Prompter = {
    say: (t) => void said.push(t),
    ask: async (q, o) => {
      const a = String(next('ask', q))
      return a === '' && o?.default ? o.default : a
    },
    askSecret: async (q) => String(next('secret', q)),
    confirm: async (q, def) => {
      const a = next('confirm', q)
      return a === '' ? def : a === true || a === 'y'
    },
    choose: async (q, _o, def = 0) => {
      const a = next('choose', q)
      return a === '' ? def : Number(a)
    },
  }
  return { prompt, said, asked, left: () => queue.length }
}

describe('first-run setup', () => {
  it('a whole session: the file is a configuration the program accepts, and the key is in the store, not in the file', async () => {
    const { root, p } = await world()
    const secrets = new MemorySecretStore()
    const s = scripted([
      p('stuff/models'), // models folder (one .vrm: used without asking)
      p('stuff/motions'),
      '', // persona: the default
      true, // use the browser found
      0, // provider: Gemini
      'my-model-name',
      'http://127.0.0.1:7890', // proxy
      'THE-SECRET-KEY-VALUE', // key
      0, // voice: start it for me
      p('stuff/ref.wav'),
      'what the recording says',
      p('stuff/gsv'),
      '', // python: the guess
      '', // inference config: the guess
      '4242', // live room
    ])
    const result = await runSetup({
      root,
      prompt: s.prompt,
      fs: realFs,
      secrets,
      browserCandidates: [p('stuff/chrome.exe')],
    })
    expect(result.file).toBe(path.join(root, 'config', 'animatus.config.yaml'))
    expect(result.keyStored).toBe(true)
    expect(s.left()).toBe(0)

    const text = await readFile(result.file as string, 'utf8')
    expect(text).not.toContain('THE-SECRET-KEY-VALUE')
    expect(text).toContain('${secret:gemini}')
    expect(text).toMatch(
      /^# Animatus configuration, written by `npm run setup` on \d{4}-\d\d-\d\d\./
    )
    expect(await secrets.get('gemini')).toBe('THE-SECRET-KEY-VALUE')
    expect(s.said.join('\n')).not.toContain('THE-SECRET-KEY-VALUE')

    // and the program accepts it
    const cfg = parseConfig(YAML.parse(text), { root })
    expect(cfg.stage.model).toBe('a.vrm')
    expect(cfg.paths.models).toBe(path.resolve(root, 'stuff/models'))
    expect(cfg.persona).toBe(path.resolve(root, 'personas/example'))
    expect(cfg.llm.providers[0]).toMatchObject({
      id: 'primary',
      kind: 'gemini',
      model: 'my-model-name',
      proxy: 'http://127.0.0.1:7890',
    })
    expect(cfg.plugins.gptsovits).toMatchObject({
      enabled: true,
      config: {
        root: p('stuff/gsv'),
        python: p('stuff/gsv/runtime/python.exe'),
        tts_config: p('stuff/gsv/GPT_SoVITS/configs/tts_infer.yaml'),
      },
    })
    expect(cfg.tts.styles.neutral).toMatchObject({ ref_text: 'what the recording says' })
    expect(cfg.sources.bilibili).toMatchObject({ enabled: true, room_id: 4242 })
    expect(cfg.stage.browser?.executable).toBe(p('stuff/chrome.exe'))
    expect(result.next.join(' ')).toContain('npm start')
  })

  it('the shortest session: everything left for later still gives a configuration that loads', async () => {
    const { root } = await world()
    const s = scripted([
      '', // no model folder
      '', // no motions
      '', // persona default
      '', // no browser found: ask for a path
      2, // provider later
      2, // voice later
      '', // no live room
    ])
    const result = await runSetup({
      root,
      prompt: s.prompt,
      fs: realFs,
      secrets: new MemorySecretStore(),
      browserCandidates: [],
    })
    const cfg = parseConfig(YAML.parse(await readFile(result.file as string, 'utf8')), { root })
    expect(cfg.llm.providers).toEqual([])
    expect(cfg.stage.browser).toBeNull()
    expect(cfg.sources.bilibili?.enabled).toBe(false)
    expect(result.keyStored).toBe(false)
    expect(result.next.join(' ')).toContain('Keys page')
  })

  it('an answer that is not right is asked again, with the reason; several models in the folder are chosen from', async () => {
    const { root, p } = await world()
    await writeFile(path.join(root, 'stuff', 'models', 'b.vrm'), 'x')
    const s = scripted([
      p('nowhere'), // not a folder
      p('stuff/models'),
      1, // the second model
      '', // no motions
      p('personas/nothing'), // no persona.md there
      p('personas/mine'),
      '',
      2,
      2,
      '',
    ])
    const result = await runSetup({ root, prompt: s.prompt, fs: realFs, browserCandidates: [] })
    expect(s.said.join('\n')).toContain('That folder does not exist')
    expect(s.said.join('\n')).toContain('There is no persona.md in')
    const cfg = parseConfig(YAML.parse(await readFile(result.file as string, 'utf8')), { root })
    expect(cfg.stage.model).toBe('b.vrm')
    expect(cfg.persona).toBe(path.resolve(root, 'personas/mine'))
  })

  it('the inference config is asked for when the stock one is not there; a relative answer is read from the GPT-SoVITS folder', async () => {
    const { root, p } = await world()
    await rm(path.join(root, 'stuff', 'gsv', 'GPT_SoVITS', 'configs', 'tts_infer.yaml'))
    await writeFile(path.join(root, 'stuff', 'gsv', 'mine.yaml'), 'x')
    const s = scripted([
      '', // no model folder
      '', // no motions
      '', // persona default
      '', // no browser
      2, // provider later
      0, // voice: start it for me
      p('stuff/ref.wav'),
      'words',
      p('stuff/gsv'),
      '', // python: the guess
      p('stuff/gsv/nothing.yaml'), // not there
      'mine.yaml', // relative to the GPT-SoVITS folder
      '', // no live room
    ])
    const result = await runSetup({ root, prompt: s.prompt, fs: realFs, browserCandidates: [] })
    expect(s.left()).toBe(0)
    expect(s.said.join('\n')).toContain('There is no file at')
    const cfg = parseConfig(YAML.parse(await readFile(result.file as string, 'utf8')), { root })
    expect(cfg.plugins.gptsovits?.config.tts_config).toBe('mine.yaml')
  })

  it('an existing configuration is not overwritten: the new one goes next to it, unless the person says replace', async () => {
    const { root } = await world()
    await mkdir(path.join(root, 'config'), { recursive: true })
    const old = path.join(root, 'config', 'animatus.config.yaml')
    await writeFile(old, '# mine\nversion: 1\n')
    const answers = ['', '', '', '', 2, 2, '']
    const keep = await runSetup({
      root,
      prompt: scripted([false, ...answers]).prompt,
      fs: realFs,
      browserCandidates: [],
    })
    expect(keep.file).toBe(path.join(root, 'config', 'animatus.config.new.yaml'))
    expect(await readFile(old, 'utf8')).toBe('# mine\nversion: 1\n')
    const replace = await runSetup({
      root,
      prompt: scripted([true, ...answers]).prompt,
      fs: realFs,
      browserCandidates: [],
    })
    expect(replace.file).toBe(old)
    expect(await readFile(old, 'utf8')).toContain('written by `npm run setup`')
  })

  it('a speech server you start yourself, an OpenAI-compatible provider, and a machine with no encrypted store', async () => {
    const { root, p } = await world()
    const s = scripted([
      '',
      '',
      '',
      '',
      1, // provider: OpenAI-compatible
      'some-model',
      'http://127.0.0.1:8081/v1',
      '', // no proxy
      'A-KEY', // key
      1, // voice: already running
      p('stuff/ref.wav'),
      'words',
      '', // default address
      '',
    ])
    const result = await runSetup({
      root,
      prompt: s.prompt,
      fs: realFs,
      secrets: undefined,
      browserCandidates: [],
    })
    const cfg = parseConfig(YAML.parse(await readFile(result.file as string, 'utf8')), { root })
    expect(cfg.llm.providers[0]).toMatchObject({
      kind: 'openai-compatible',
      base_url: 'http://127.0.0.1:8081/v1',
      model: 'some-model',
    })
    expect(cfg.plugins['gptsovits-attach']).toMatchObject({
      enabled: true,
      config: { url: 'http://127.0.0.1:9880' },
    })
    expect(result.keyStored).toBe(false)
    expect(s.said.join('\n')).toContain('config/.env as OPENAI_API_KEY')
    expect(s.said.join('\n')).not.toContain('A-KEY')
    expect(await readFile(result.file as string, 'utf8')).not.toContain('A-KEY')
  })

  it('a key the store refuses is reported, without the key', async () => {
    const { root } = await world()
    const store = new MemorySecretStore()
    store.set = async () => {
      throw new Error('the store is read-only\nmore text')
    }
    const s = scripted(['', '', '', '', 0, 'm', '', 'KEY-VALUE', 2, ''])
    const result = await runSetup({
      root,
      prompt: s.prompt,
      fs: realFs,
      secrets: store,
      browserCandidates: [],
    })
    expect(result.keyStored).toBe(false)
    expect(s.said.join('\n')).toContain('The key could not be stored: the store is read-only')
    expect(s.said.join('\n')).not.toContain('KEY-VALUE')
  })

  it('asks the same question only so many times, then gives up instead of looping', async () => {
    const { root, p } = await world()
    const s = scripted(Array.from({ length: 20 }, () => p('nowhere')))
    await expect(runSetup({ root, prompt: s.prompt, fs: realFs })).rejects.toThrow(
      /no usable answer/
    )
  })
})
