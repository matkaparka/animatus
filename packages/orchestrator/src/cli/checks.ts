/**
 * The checks behind `npm run doctor`: is this installation ready to run, and if not, what to do about it.
 *
 * Everything that touches the machine comes in through `DoctorEnv`, so the checks are ordinary functions of a
 * configuration and a description of the machine, and the tests run them against invented ones. Nothing here
 * changes anything, prints a secret, or asks a model anything: a secret is only ever asked whether it is set.
 */
import path from 'node:path'
import { ConfigError, loadConfig, secretRefs } from '../config.ts'
import type { AppConfig } from '../config.ts'
import { loadModePacks } from '../modes/loader.ts'
import { PluginRegistry } from '../plugins/registry.ts'
import { builtinControllers } from '../modes/controllers/index.ts'

export type Level = 'ok' | 'warn' | 'fail'

export interface Check {
  id: string
  level: Level
  title: string
  /** What was found, in a line or two. */
  detail?: string
  /** What to do about it. */
  fix?: string
}

export interface DoctorEnv {
  /** The repository's root: where `config/`, `plugins/`, `modes/` and the builds are. */
  root: string
  nodeVersion: string
  platform: NodeJS.Platform
  exists(p: string): Promise<'file' | 'dir' | null>
  listDir(p: string): Promise<string[]>
  /** Whether nothing listens on this port of the loopback address. */
  portFree(port: number): Promise<boolean>
  /** Whether an HTTP GET to this URL answers at all (any status). */
  httpAnswers(url: string, timeoutMs: number): Promise<boolean>
  /** Whether a TCP connection to this address opens. */
  tcpOpens(host: string, port: number, timeoutMs: number): Promise<boolean>
  /** Whether a secret of this name has a value. Never returns the value. */
  secretIsSet(name: string): Promise<boolean>
}

export interface DoctorOptions {
  /** Also ask servers the configuration points at whether they answer (a speech server that is already running, a proxy). */
  online?: boolean
}

const ok = (id: string, title: string, detail?: string): Check => ({
  id,
  level: 'ok',
  title,
  ...(detail ? { detail } : {}),
})
const warn = (
  id: string,
  title: string,
  detail: string | undefined,
  fix: string | undefined
): Check => ({
  id,
  level: 'warn',
  title,
  ...(detail ? { detail } : {}),
  ...(fix ? { fix } : {}),
})
const fail = (
  id: string,
  title: string,
  detail: string | undefined,
  fix: string | undefined
): Check => ({
  id,
  level: 'fail',
  title,
  ...(detail ? { detail } : {}),
  ...(fix ? { fix } : {}),
})

const firstLine = (s: string): string => s.split(/\r?\n/, 1)[0] ?? ''

/** All the checks, in the order a person would fix them. */
export async function runChecks(
  file: string,
  env: DoctorEnv,
  opts: DoctorOptions = {}
): Promise<Check[]> {
  const out: Check[] = []

  // ── the machine
  const major = Number(env.nodeVersion.split('.')[0])
  out.push(
    major >= 24
      ? ok('node', 'Node.js', `version ${env.nodeVersion}`)
      : fail(
          'node',
          'Node.js is too old',
          `version ${env.nodeVersion}; 24 or newer is needed`,
          'Install Node.js 24 or newer (https://nodejs.org).'
        )
  )
  out.push(
    env.platform === 'win32'
      ? ok('platform', 'Windows')
      : warn(
          'platform',
          'Not Windows',
          `running on ${env.platform}`,
          'The window capture, the job guard and the encrypted key store are Windows-only; everything else may work.'
        )
  )
  out.push(
    (await env.exists(path.join(env.root, 'node_modules'))) === 'dir'
      ? ok('install', 'Dependencies are installed')
      : fail(
          'install',
          'Dependencies are not installed',
          undefined,
          'Run `npm install` in the repository folder.'
        )
  )

  // ── the configuration
  let config: AppConfig
  try {
    config = await loadConfig(file, { root: env.root })
  } catch (e) {
    if (e instanceof ConfigError) {
      const missing = /not found/.test(e.message)
      out.push(
        fail(
          'config',
          missing ? 'There is no configuration yet' : 'The configuration cannot be used',
          missing ? file : e.message,
          missing
            ? 'Run `npm run setup` to make one (or copy config.example/ to config/ and edit it).'
            : 'Fix what it says, in the configuration file.'
        )
      )
      return out
    }
    throw e
  }
  out.push(ok('config', 'The configuration is valid', file))

  // ── the builds
  const stageBuilt = await env.exists(
    path.join(env.root, 'packages', 'stage', 'dist', 'index.html')
  )
  out.push(
    stageBuilt
      ? ok('stage-build', 'The stage is built')
      : fail('stage-build', 'The stage is not built', undefined, 'Run `npm run build`.')
  )
  const consoleBuilt = await env.exists(
    path.join(env.root, 'packages', 'console', 'dist', 'index.html')
  )
  out.push(
    consoleBuilt
      ? ok('console-build', 'The console is built')
      : warn(
          'console-build',
          'The console is not built',
          'The console page cannot be opened without it.',
          'Run `npm run build`.'
        )
  )

  // ── files of your own
  const { models, motions, songs, asmr } = config.paths
  if (models === undefined) {
    out.push(
      warn(
        'models',
        'No model folder is set',
        'paths.models is empty: the stage shows nothing.',
        'Set paths.models to the folder that holds your VRM model.'
      )
    )
  } else if ((await env.exists(models)) !== 'dir') {
    out.push(fail('models', 'The model folder does not exist', models, 'Fix paths.models.'))
  } else if (config.stage.model === null || config.stage.model === undefined) {
    out.push(
      warn(
        'model-file',
        'No model is chosen',
        'stage.model is empty: the stage shows nothing.',
        `Set stage.model to a file in ${models}.`
      )
    )
  } else if ((await env.exists(path.join(models, config.stage.model))) !== 'file') {
    const found = (await env.listDir(models)).filter((f) => /\.vrm$/i.test(f)).slice(0, 5)
    out.push(
      fail(
        'model-file',
        'The model file is not there',
        `${path.join(models, config.stage.model)}${found.length ? `; the folder has: ${found.join(', ')}` : '; the folder has no .vrm file'}`,
        'Fix stage.model.'
      )
    )
  } else out.push(ok('model-file', 'The model file is there', config.stage.model))
  if (motions !== undefined)
    out.push(
      (await env.exists(motions)) === 'dir'
        ? ok('motions', 'The motion folder is there')
        : warn(
            'motions',
            'The motion folder does not exist',
            motions,
            'Fix paths.motions, or leave it out: the character then only moves by the built-in layer.'
          )
    )
  for (const [name, dir, mode] of [
    ['songs', songs, 'sing'],
    ['asmr', asmr, 'sleep'],
  ] as const) {
    if (dir !== undefined && (await env.exists(dir)) !== 'dir')
      out.push(
        warn(
          name,
          `The ${name} folder does not exist`,
          dir,
          `Fix paths.${name}, or leave the ${mode} mode off.`
        )
      )
  }
  const persona = path.join(config.persona, 'persona.md')
  out.push(
    (await env.exists(persona)) === 'file'
      ? ok('persona', 'The persona file is there')
      : fail(
          'persona',
          'The persona file is missing',
          persona,
          'Copy personas/example/ and write your character, then point `persona` at it.'
        )
  )

  // ── the stage window
  const browser = config.stage.browser
  if (browser) {
    out.push(
      (await env.exists(browser.executable)) === 'file'
        ? ok('browser', 'The browser for the stage window is there')
        : warn(
            'browser',
            'The browser for the stage window is missing',
            browser.executable,
            'Fix stage.browser.executable, or remove `browser` and open the stage page yourself (it is printed at start-up).'
          )
    )
  }

  // ── the model
  if (config.llm.providers.length === 0) {
    out.push(
      fail(
        'llm',
        'No model provider is configured',
        'llm.providers is empty',
        'Add a provider under llm.providers (see config.example).'
      )
    )
  } else {
    let usable = 0
    for (const p of config.llm.providers) {
      const names = secretRefs(JSON.stringify(p))
      const missing: string[] = []
      for (const n of names) if (!(await env.secretIsSet(n))) missing.push(n)
      if (missing.length === 0) usable++
      else
        out.push(
          warn(
            `llm-${p.id}`,
            `Provider "${p.id}" has no key`,
            `the secret ${missing.map((m) => `"${m}"`).join(', ')} is not set`,
            "Enter it on the console's Keys page (or run `npm run setup`), or put it in config/.env."
          )
        )
    }
    out.push(
      usable > 0
        ? ok('llm', 'A model provider is ready', `${usable} of ${config.llm.providers.length}`)
        : fail(
            'llm',
            'No model provider has its key',
            undefined,
            'Set the key of at least one provider.'
          )
    )
    if (opts.online) {
      for (const p of config.llm.providers) {
        const proxy = (p as { proxy?: string }).proxy
        if (proxy) {
          const u = safeUrl(proxy)
          if (u && !(await env.tcpOpens(u.hostname, Number(u.port || 80), 1500)))
            out.push(
              warn(
                `proxy-${p.id}`,
                `The proxy of "${p.id}" does not answer`,
                proxy,
                'Start the proxy, or remove `proxy` from the provider.'
              )
            )
        }
      }
    }
  }

  // ── speech
  const registry = await PluginRegistry.scan(path.join(env.root, 'plugins'))
  const speech = registry.enabledByService('tts', config.plugins)
  if (config.tts.styles && Object.keys(config.tts.styles).length > 0) {
    const missing: string[] = []
    for (const [name, style] of Object.entries(config.tts.styles))
      if ((await env.exists(style.ref_audio)) !== 'file')
        missing.push(`${name}: ${style.ref_audio}`)
    out.push(
      missing.length === 0
        ? ok(
            'tts-styles',
            'The reference recordings are there',
            Object.keys(config.tts.styles).join(', ')
          )
        : fail(
            'tts-styles',
            'A reference recording is missing',
            missing.join('; '),
            'Fix tts.styles.<name>.ref_audio.'
          )
    )
  } else
    out.push(
      fail(
        'tts-styles',
        'No voice is set',
        'tts.styles is empty',
        'Add a `neutral` style with a reference recording and what it says.'
      )
    )
  if (speech.length === 0) {
    out.push(
      fail(
        'tts',
        'No speech plugin is enabled',
        undefined,
        'Enable plugins.gptsovits (started for you) or plugins.gptsovits-attach (one you started).'
      )
    )
  } else {
    const entry = speech[0]
    if (entry?.id === 'gptsovits') {
      const cfg = config.plugins.gptsovits?.config ?? {}
      const root = String(cfg.root ?? '')
      const py = String(cfg.python ?? '')
      out.push(
        root && (await env.exists(root)) === 'dir'
          ? ok('gsv-root', 'GPT-SoVITS is there', root)
          : fail(
              'gsv-root',
              'GPT-SoVITS is not where the configuration says',
              root || 'plugins.gptsovits.config.root is empty',
              'Install GPT-SoVITS (its own instructions) and set plugins.gptsovits.config.root.'
            )
      )
      out.push(
        py && (await env.exists(py)) === 'file'
          ? ok('gsv-python', 'The Python of GPT-SoVITS is there')
          : fail(
              'gsv-python',
              'The Python of GPT-SoVITS is missing',
              py || 'plugins.gptsovits.config.python is empty',
              'Set plugins.gptsovits.config.python to the python.exe of its environment.'
            )
      )
    } else if (entry?.id === 'gptsovits-attach' && opts.online) {
      const url = String(config.plugins['gptsovits-attach']?.config.url ?? '')
      out.push(
        url && (await env.httpAnswers(`${url.replace(/\/+$/, '')}/docs`, 2500))
          ? ok('gsv-attach', 'The speech server answers', url)
          : warn(
              'gsv-attach',
              'The speech server does not answer',
              url,
              'Start it before the program, or use plugins.gptsovits and let the program start it.'
            )
      )
    }
  }

  // ── python for the plugins that need it
  const needsPython = registry
    .enabled(config.plugins)
    .filter((e) => e.manifest.runtime.type === 'process' && e.manifest.runtime.env === 'light')
  if (needsPython.length > 0) {
    const py = path.join(env.root, '.venv', 'Scripts', 'python.exe')
    out.push(
      (await env.exists(py)) === 'file'
        ? ok('python', 'The light Python environment is there')
        : fail(
            'python',
            'The light Python environment is missing',
            `needed by: ${needsPython.map((e) => e.id).join(', ')}`,
            'Run `uv sync` in the repository folder.'
          )
    )
  }

  // ── the audience
  const bili = config.sources.bilibili
  if (bili?.enabled) {
    out.push(ok('bilibili', 'Chat is read from a live room', `room ${bili.room_id}`))
    if (bili.cookie_secret !== undefined && !(await env.secretIsSet(bili.cookie_secret)))
      out.push(
        warn(
          'bilibili-cookie',
          'The chat cookie is not set',
          `the secret "${bili.cookie_secret}" has no value`,
          'Without it viewers show with masked names. Enter it on the Keys page.'
        )
      )
    else if (bili.cookie_secret === undefined)
      out.push(
        warn(
          'bilibili-cookie',
          'No chat cookie',
          undefined,
          'Without a logged-in cookie viewers show with masked names (sources.bilibili.cookie_secret).'
        )
      )
  } else
    out.push(
      warn(
        'bilibili',
        'No live room is connected',
        'sources.bilibili.enabled is off: nothing reads chat',
        'That is fine for a first try: the console can inject fake audience messages.'
      )
    )

  // ── modes
  for (const [id, entry] of Object.entries(config.modes)) {
    if (!entry.enabled) continue
    const { modes: packs } = await loadModePacks([
      path.join(env.root, 'modes'),
      path.join(env.root, 'config', 'modes'),
    ])
    const pack = packs.find((p) => p.manifest.id === id)
    if (!pack) {
      out.push(
        fail(
          `mode-${id}`,
          `Mode "${id}" is switched on but there is no such mode`,
          undefined,
          'Check the spelling, or the modes folder.'
        )
      )
      continue
    }
    if (!builtinControllers[id]) {
      out.push(
        fail(`mode-${id}`, `Mode "${id}" has no code in this program`, undefined, 'Switch it off.')
      )
      continue
    }
    const lacking = pack.manifest.requires.services.filter(
      (s) =>
        registry.enabledByService(s, config.plugins).length === 0 &&
        !config.vram.resident.includes(s)
    )
    out.push(
      lacking.length === 0
        ? ok(`mode-${id}`, `Mode "${id}" has what it needs`)
        : fail(
            `mode-${id}`,
            `Mode "${id}" needs a service that no enabled plugin provides`,
            lacking.join(', '),
            `Enable a plugin that provides ${lacking.join(', ')} (docs/mode-${id}.md).`
          )
    )
  }

  // ── the ports
  for (const [name, port] of [
    ['stage', config.servers.stage_port],
    ['console', config.servers.console_port],
  ] as const)
    out.push(
      (await env.portFree(port))
        ? ok(`port-${name}`, `Port ${port} is free`, `the ${name}`)
        : warn(
            `port-${name}`,
            `Port ${port} is in use`,
            `the ${name} port`,
            'Another copy of the program may be running, or change servers.' + name + '_port.'
          )
    )

  // ── memory
  if (config.memory.enabled) {
    const dir = config.memory.dir ?? path.join(config.paths.data_dir, 'memory')
    out.push(ok('memory', 'Memory is on', dir))
  }

  return out
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s)
  } catch {
    return null
  }
}

export interface Summary {
  ok: number
  warn: number
  fail: number
}

export const summarise = (checks: readonly Check[]): Summary => ({
  ok: checks.filter((c) => c.level === 'ok').length,
  warn: checks.filter((c) => c.level === 'warn').length,
  fail: checks.filter((c) => c.level === 'fail').length,
})

const MARK: Record<Level, string> = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]' }

/** The report as text: one line per check, what to do beneath the ones that need it, and a last line. */
export function formatReport(checks: readonly Check[]): string {
  const lines: string[] = []
  for (const c of checks) {
    lines.push(`${MARK[c.level]} ${c.title}${c.detail ? ` (${firstLine(c.detail)})` : ''}`)
    if (c.level !== 'ok' && c.fix) lines.push(`         ${c.fix}`)
    if (c.detail && c.detail.includes('\n'))
      for (const l of c.detail.split(/\r?\n/).slice(1, 8)) lines.push(`         ${l}`)
  }
  const s = summarise(checks)
  lines.push('')
  lines.push(
    s.fail > 0
      ? `${s.fail} problem(s) to fix before it can run, ${s.warn} thing(s) worth a look.`
      : s.warn > 0
        ? `Ready to run. ${s.warn} thing(s) worth a look.`
        : 'Everything checks out.'
  )
  return lines.join('\n')
}
