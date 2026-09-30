import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { formatReport, runChecks, summarise } from '../../src/cli/checks.ts'
import type { Check, DoctorEnv } from '../../src/cli/checks.ts'

const REPO = path.resolve(__dirname, '../../../..')
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/** A machine described in a few lines: which paths exist, which secrets are set, which ports are taken. */
function machine(
  over: Partial<{
    files: string[]
    dirs: string[]
    secrets: string[]
    busyPorts: number[]
    answering: string[]
    open: string[]
    node: string
    platform: NodeJS.Platform
    listing: Record<string, string[]>
  }> = {}
): DoctorEnv {
  const files = new Set(over.files ?? [])
  const dirSet = new Set(over.dirs ?? [])
  const norm = (p: string) => path.resolve(p)
  return {
    root: REPO,
    nodeVersion: over.node ?? '24.19.0',
    platform: over.platform ?? 'win32',
    exists: async (p) => (files.has(norm(p)) ? 'file' : dirSet.has(norm(p)) ? 'dir' : null),
    listDir: async (p) => over.listing?.[norm(p)] ?? [],
    portFree: async (port) => !(over.busyPorts ?? []).includes(port),
    httpAnswers: async (url) => (over.answering ?? []).some((a) => url.startsWith(a)),
    tcpOpens: async (h, port) => (over.open ?? []).includes(`${h}:${port}`),
    secretIsSet: async (name) => (over.secrets ?? []).includes(name),
  }
}

const p = (...parts: string[]) => path.resolve(...parts)

/** The settings of a GPT-SoVITS install that is all there. */
const GSV = {
  root: 'C:/GPT-SoVITS',
  python: 'C:/GPT-SoVITS/runtime/python.exe',
  tts_config: 'C:/GPT-SoVITS/GPT_SoVITS/configs/tts_infer.yaml',
}

/** A machine on which a first chat works: model, persona, voice, key, builds. */
function good() {
  const models = 'C:/models'
  const files = [
    p(REPO, 'packages/stage/dist/index.html'),
    p(REPO, 'packages/console/dist/index.html'),
    p(models, 'me.vrm'),
    p(REPO, 'personas/example/persona.md'),
    p('C:/voice/ref.wav'),
    p('C:/GPT-SoVITS/runtime/python.exe'),
    p('C:/GPT-SoVITS/GPT_SoVITS/configs/tts_infer.yaml'),
  ]
  const dirList = [p(REPO, 'node_modules'), p(models), p('C:/GPT-SoVITS')]
  return { models, files, dirs: dirList }
}

async function config(extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'animatus-doctor-'))
  dirs.push(dir)
  await mkdir(path.join(dir, 'config'), { recursive: true })
  const file = path.join(dir, 'config', 'animatus.config.yaml')
  await writeFile(
    file,
    YAML.stringify({
      paths: { models: 'C:/models', data_dir: path.join(dir, 'data') },
      stage: { model: 'me.vrm' },
      persona: './personas/example',
      llm: {
        providers: [{ id: 'primary', kind: 'gemini', model: 'm', api_key: '${secret:gemini}' }],
      },
      tts: { styles: { neutral: { ref_audio: 'C:/voice/ref.wav', ref_text: 'hello' } } },
      plugins: {
        gptsovits: {
          enabled: true,
          config: GSV,
        },
      },
      ...extra,
    })
  )
  return file
}

const by = (checks: Check[], id: string) => checks.find((c) => c.id === id)
const levels = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.id, c.level]))

describe('the doctor', () => {
  it('a machine that is ready says so: nothing fails', async () => {
    const g = good()
    const checks = await runChecks(await config(), machine({ ...g, secrets: ['gemini'] }))
    expect(summarise(checks).fail).toBe(0)
    expect(levels(checks)).toMatchObject({
      node: 'ok',
      config: 'ok',
      'stage-build': 'ok',
      'model-file': 'ok',
      persona: 'ok',
      llm: 'ok',
      'tts-styles': 'ok',
      'gsv-root': 'ok',
      'gsv-python': 'ok',
      'gsv-infer': 'ok',
      'port-stage': 'ok',
      'port-console': 'ok',
    })
    expect(by(checks, 'bilibili')?.level).toBe('warn') // no live room: fine for a first try, and it says why
    expect(formatReport(checks)).toContain('Ready to run.')
  })

  it('no configuration: it says where it looked and what to do, and goes no further', async () => {
    const checks = await runChecks(
      path.join(tmpdir(), 'no-such-dir', 'animatus.config.yaml'),
      machine()
    )
    const c = by(checks, 'config')
    expect(c?.level).toBe('fail')
    expect(c?.title).toBe('There is no configuration yet')
    expect(c?.fix).toContain('npm run setup')
    expect(checks.map((x) => x.id)).not.toContain('llm')
  })

  it('a configuration that does not parse: the reason is shown', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'animatus-doctor-'))
    dirs.push(dir)
    const file = path.join(dir, 'c.yaml')
    await writeFile(file, 'servers: { stage_port: 80 }\n')
    const c = by(await runChecks(file, machine()), 'config')
    expect(c?.level).toBe('fail')
    expect(c?.title).toBe('The configuration cannot be used')
    expect(c?.detail).toMatch(/stage_port|1024/)
  })

  it('an old Node, not Windows, no install: each is named', async () => {
    const checks = await runChecks(await config(), machine({ node: '20.1.0', platform: 'linux' }))
    expect(levels(checks)).toMatchObject({ node: 'fail', platform: 'warn', install: 'fail' })
    expect(by(checks, 'node')?.detail).toContain('24 or newer')
  })

  it('the builds are not there: the stage is a failure, the console a warning, both say to build', async () => {
    const g = good()
    const checks = await runChecks(
      await config(),
      machine({ ...g, files: g.files.filter((f) => !f.includes('dist')), secrets: ['gemini'] })
    )
    expect(levels(checks)).toMatchObject({ 'stage-build': 'fail', 'console-build': 'warn' })
    expect(by(checks, 'stage-build')?.fix).toContain('npm run build')
  })

  it('a model file that is not there lists the .vrm files the folder does have', async () => {
    const g = good()
    const checks = await runChecks(
      await config(),
      machine({
        ...g,
        files: g.files.filter((f) => !f.endsWith('me.vrm')),
        listing: { [p(g.models)]: ['other.vrm', 'notes.txt', 'third.VRM'] },
      })
    )
    const c = by(checks, 'model-file')
    expect(c?.level).toBe('fail')
    expect(c?.detail).toContain('other.vrm, third.VRM')
    expect(c?.detail).not.toContain('notes.txt')
  })

  it('a missing model folder, no model chosen, no persona', async () => {
    const g = good()
    const noFolder = await runChecks(
      await config(),
      machine({ ...g, dirs: g.dirs.filter((d) => d !== p(g.models)) })
    )
    expect(levels(noFolder)).toMatchObject({ models: 'fail' })
    const noModel = await runChecks(await config({ stage: {} }), machine(g))
    expect(levels(noModel)).toMatchObject({ 'model-file': 'warn' })
    const noPersona = await runChecks(
      await config(),
      machine({ ...g, files: g.files.filter((f) => !f.endsWith('persona.md')) })
    )
    expect(levels(noPersona)).toMatchObject({ persona: 'fail' })
  })

  it('a provider without its key: named, and it is a failure only when no provider has one', async () => {
    const g = good()
    const none = await runChecks(await config(), machine(g))
    expect(levels(none)).toMatchObject({ 'llm-primary': 'warn', llm: 'fail' })
    expect(by(none, 'llm-primary')?.detail).toContain('"gemini"')
    // the value itself is never asked for, so it cannot be printed
    expect(JSON.stringify(none)).not.toMatch(/AIza|sk-/)
    const two = await config({
      llm: {
        providers: [
          { id: 'a', kind: 'gemini', model: 'm', api_key: '${secret:gemini}' },
          {
            id: 'b',
            kind: 'openai-compatible',
            model: 'm',
            base_url: 'http://127.0.0.1:1/v1',
            api_key: '${secret:openai}',
          },
        ],
      },
    })
    const some = await runChecks(two, machine({ ...g, secrets: ['openai'] }))
    expect(levels(some)).toMatchObject({ 'llm-a': 'warn', llm: 'ok' })
  })

  it('no providers at all', async () => {
    const c = by(await runChecks(await config({ llm: { providers: [] } }), machine(good())), 'llm')
    expect(c?.level).toBe('fail')
  })

  it('the voice: a missing reference recording, an empty style list, no speech plugin, GPT-SoVITS not where it should be', async () => {
    const g = good()
    const noRef = await runChecks(
      await config(),
      machine({ ...g, files: g.files.filter((f) => !f.endsWith('ref.wav')) })
    )
    expect(by(noRef, 'tts-styles')?.level).toBe('fail')
    expect(by(noRef, 'tts-styles')?.detail).toContain('neutral')
    expect(by(await runChecks(await config({ tts: {} }), machine(g)), 'tts-styles')?.level).toBe(
      'fail'
    )
    expect(by(await runChecks(await config({ plugins: {} }), machine(g)), 'tts')?.level).toBe(
      'fail'
    )
    const moved = await runChecks(
      await config(),
      machine({
        ...g,
        dirs: g.dirs.filter((d) => !d.includes('GPT-SoVITS')),
        files: g.files.filter((f) => !f.includes('python.exe')),
      })
    )
    expect(levels(moved)).toMatchObject({ 'gsv-root': 'fail', 'gsv-python': 'fail' })
  })

  it('a speech server that you started yourself is asked only with --online', async () => {
    const g = good()
    const file = await config({
      plugins: { 'gptsovits-attach': { enabled: true, config: { url: 'http://127.0.0.1:9880' } } },
    })
    expect(by(await runChecks(file, machine(g)), 'gsv-attach')).toBeUndefined()
    expect(by(await runChecks(file, machine(g), { online: true }), 'gsv-attach')?.level).toBe(
      'warn'
    )
    expect(
      by(
        await runChecks(file, machine({ ...g, answering: ['http://127.0.0.1:9880'] }), {
          online: true,
        }),
        'gsv-attach'
      )?.level
    ).toBe('ok')
  })

  it('a proxy that does not answer is a warning, with --online', async () => {
    const g = good()
    const file = await config({
      llm: {
        providers: [
          {
            id: 'primary',
            kind: 'gemini',
            model: 'm',
            api_key: '${secret:gemini}',
            proxy: 'http://127.0.0.1:7897',
          },
        ],
      },
    })
    expect(
      by(
        await runChecks(file, machine({ ...g, secrets: ['gemini'] }), { online: true }),
        'proxy-primary'
      )?.level
    ).toBe('warn')
    expect(
      by(
        await runChecks(file, machine({ ...g, secrets: ['gemini'], open: ['127.0.0.1:7897'] }), {
          online: true,
        }),
        'proxy-primary'
      )
    ).toBeUndefined()
  })

  it('GPT-SoVITS without its inference config: the setting is named, and a config file that is not there is too', async () => {
    const g = good()
    const { tts_config: _left, ...withoutInfer } = GSV
    const unset = await runChecks(
      await config({ plugins: { gptsovits: { enabled: true, config: withoutInfer } } }),
      machine(g)
    )
    expect(by(unset, 'plugin-settings-gptsovits')?.level).toBe('fail')
    expect(by(unset, 'plugin-settings-gptsovits')?.detail).toContain(
      'plugins.gptsovits.config.tts_config is not set'
    )
    expect(by(unset, 'gsv-infer')).toBeUndefined() // one report per problem, not two
    expect(summarise(unset).fail).toBeGreaterThan(0)

    const gone = await runChecks(
      await config(),
      machine({ ...g, files: g.files.filter((f) => !f.endsWith('tts_infer.yaml')) })
    )
    expect(by(gone, 'gsv-infer')?.level).toBe('fail')
    expect(by(gone, 'gsv-infer')?.fix).toContain('tts_infer.yaml')
    expect(by(gone, 'plugin-settings-gptsovits')).toBeUndefined()
  })

  it('a relative inference config is looked for inside the GPT-SoVITS folder', async () => {
    const g = good()
    const relative = await config({
      plugins: {
        gptsovits: {
          enabled: true,
          config: { ...GSV, tts_config: 'GPT_SoVITS/configs/mine.yaml' },
        },
      },
    })
    expect(by(await runChecks(relative, machine(g)), 'gsv-infer')?.level).toBe('fail')
    const there = await runChecks(
      relative,
      machine({ ...g, files: [...g.files, p('C:/GPT-SoVITS/GPT_SoVITS/configs/mine.yaml')] })
    )
    expect(by(there, 'gsv-infer')?.level).toBe('ok')
  })

  it('a plugin that needs the light Python asks for it', async () => {
    const g = good()
    const file = await config({
      plugins: {
        gptsovits: {
          enabled: true,
          config: GSV,
        },
        screencap: { enabled: true },
      },
    })
    const without = await runChecks(file, machine(g))
    expect(by(without, 'python')?.level).toBe('fail')
    expect(by(without, 'python')?.detail).toContain('screencap')
    expect(by(without, 'python')?.fix).toContain('uv sync')
    const withPy = await runChecks(
      file,
      machine({ ...g, files: [...g.files, p(REPO, '.venv/Scripts/python.exe')] })
    )
    expect(by(withPy, 'python')?.level).toBe('ok')
  })

  it('a mode that is on: it must exist, have code, and have the services it needs', async () => {
    const g = good()
    const ghost = await runChecks(
      await config({ modes: { 'no-such-mode': { enabled: true } } }),
      machine(g)
    )
    expect(by(ghost, 'mode-no-such-mode')?.level).toBe('fail')
    // commentary needs the screencap service
    const lacking = await runChecks(
      await config({ modes: { commentary: { enabled: true } } }),
      machine(g)
    )
    expect(by(lacking, 'mode-commentary')?.level).toBe('fail')
    expect(by(lacking, 'mode-commentary')?.detail).toContain('screencap')
    const has = await runChecks(
      await config({
        modes: { commentary: { enabled: true } },
        plugins: {
          gptsovits: {
            enabled: true,
            config: GSV,
          },
          screencap: { enabled: true },
        },
      }),
      machine(g)
    )
    expect(by(has, 'mode-commentary')?.level).toBe('ok')
    // a mode that is off is not looked at
    expect(
      by(
        await runChecks(await config({ modes: { commentary: { enabled: false } } }), machine(g)),
        'mode-commentary'
      )
    ).toBeUndefined()
  })

  it('a live room: with and without a cookie', async () => {
    const g = good()
    const noCookie = await runChecks(
      await config({ sources: { bilibili: { enabled: true, room_id: 123 } } }),
      machine(g)
    )
    expect(levels(noCookie)).toMatchObject({ bilibili: 'ok', 'bilibili-cookie': 'warn' })
    const named = await config({
      sources: { bilibili: { enabled: true, room_id: 123, cookie_secret: 'bili_cookie' } },
    })
    expect(by(await runChecks(named, machine(g)), 'bilibili-cookie')?.level).toBe('warn')
    expect(
      by(await runChecks(named, machine({ ...g, secrets: ['bili_cookie'] })), 'bilibili-cookie')
    ).toBeUndefined()
  })

  it('a port that is taken is a warning that says why it might be', async () => {
    const g = good()
    const file = await config()
    const checks = await runChecks(file, machine({ ...g, busyPorts: [5810] }))
    expect(by(checks, 'port-stage')?.level).toBe('warn')
    expect(by(checks, 'port-stage')?.fix).toContain('Another copy')
    expect(by(checks, 'port-console')?.level).toBe('ok')
  })

  it('the report: one line each, what to do beneath what needs it, and a last line that counts', async () => {
    const g = good()
    const text = formatReport(await runChecks(await config(), machine(g)))
    expect(text).toMatch(/^\[ ok \] Node.js \(version 24/m)
    expect(text).toContain('[FAIL] No model provider has its key')
    expect(text).toContain('         Set the key of at least one provider.')
    expect(text.trimEnd().split('\n').at(-1)).toMatch(
      /^\d+ problem\(s\) to fix before it can run, \d+ thing\(s\) worth a look\.$/
    )
    expect(formatReport([{ id: 'x', level: 'ok', title: 'Fine' }])).toBe(
      '[ ok ] Fine\n\nEverything checks out.'
    )
  })
})
