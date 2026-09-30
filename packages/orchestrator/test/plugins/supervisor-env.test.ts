/**
 * What a plugin process is given: its environment, its secrets, its working directory, how its output is
 * captured, and how it is launched (batch files, the job guard).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CompositeSecretStore,
  EnvVarSecretStore,
  MemorySecretStore,
} from '../../src/plugins/secrets.ts'
import {
  CAN_RUN_GUARD,
  FAKE_PY_SERVICE,
  FAKE_SERVICE,
  IS_WINDOWS,
  cleanupAll,
  fakeEntry,
  makeSupervisor,
  makeTempDir,
  pidAlive,
  readInfo,
  readJsonFile,
  recordStatuses,
  statusNames,
  trackPid,
  waitFor,
  waitForGone,
  waitForStatus,
  type FakeOptions,
  type MakeSupervisorOptions,
} from './helpers.ts'

afterEach(cleanupAll)

const SECRET = 'test-secret-123'
const OTHER = 'test-other-456'
const UNLISTED = 'test-unlisted-789'
const OPENAI = 'test-openai-000'

async function setup(options: FakeOptions & { supervisor?: MakeSupervisorOptions } = {}) {
  const dir = await makeTempDir()
  const infoFile = join(dir, 'info.json')
  const { supervisor: supervisorOptions, ...fake } = options
  const entry = fakeEntry(dir, { ...fake, args: ['--info-file', infoFile, ...(fake.args ?? [])] })
  const supervisor = await makeSupervisor([entry], supervisorOptions)
  return {
    dir,
    infoFile,
    entry,
    supervisor,
    events: recordStatuses(supervisor, entry.id),
    id: entry.id,
  }
}

const lowerKeys = (env: Record<string, string>) => Object.keys(env).map((key) => key.toLowerCase())

describe('the environment of a plugin process', () => {
  it('drops NoDefaultCurrentDirectoryInExePath, keeps the rest, and sets Python-friendly defaults', async () => {
    const baseEnv = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1', KEEP_ME: 'kept' }
    const { supervisor, infoFile, id } = await setup({ supervisor: { baseEnv } })
    await supervisor.start(id)
    const { env } = await readInfo(infoFile)
    expect(lowerKeys(env)).not.toContain('nodefaultcurrentdirectoryinexepath')
    expect(env.KEEP_ME).toBe('kept')
    expect(lowerKeys(env)).toContain('path')
    expect(env.PYTHONUNBUFFERED).toBe('1')
    expect(env.PYTHONIOENCODING).toBe('utf-8')
  })

  it('never overrides a value the environment or the manifest already sets', async () => {
    const baseEnv = { ...process.env, PYTHONUNBUFFERED: '0' }
    const { supervisor, infoFile, id } = await setup({
      envVars: { PYTHONIOENCODING: 'latin-1' },
      supervisor: { baseEnv },
    })
    await supervisor.start(id)
    const { env } = await readInfo(infoFile)
    expect(env.PYTHONUNBUFFERED).toBe('0')
    expect(env.PYTHONIOENCODING).toBe('latin-1')
  })

  it('resolves placeholders in env_vars and cwd', async () => {
    const workdir = await makeTempDir('plugins-work-')
    const dataDir = await makeTempDir('plugins-data-')
    const { supervisor, infoFile, dir, id } = await setup({
      cwd: '{config.workdir}',
      envVars: {
        FROM_CONFIG: '${config:greeting}',
        PORT_COPY: '{port}',
        DATA: '{data_dir}',
        HERE: '{plugin_dir}',
        MIXED: 'x-{config.nested.key}-y',
        LITERAL: 'plain',
      },
      supervisor: {
        dataDir,
        pluginConfig: {
          fake: { enabled: true, config: { greeting: 'hello', workdir, nested: { key: 'deep' } } },
        },
      },
    })
    const state = await supervisor.start(id)
    const info = await readInfo(infoFile)
    expect(info.env).toMatchObject({
      FROM_CONFIG: 'hello',
      PORT_COPY: String(state.port),
      DATA: dataDir,
      HERE: dir,
      MIXED: 'x-deep-y',
      LITERAL: 'plain',
    })
    expect(resolve(info.cwd).toLowerCase()).toBe(resolve(workdir).toLowerCase())
  })

  it('uses the plugin directory as the working directory when the manifest names none', async () => {
    const { supervisor, infoFile, dir, id } = await setup()
    await supervisor.start(id)
    expect(resolve((await readInfo(infoFile)).cwd).toLowerCase()).toBe(resolve(dir).toLowerCase())
  })
})

describe('secrets', () => {
  const secretRefs = [
    { name: 'gemini', env: 'GEMINI_API_KEY', required: true },
    { name: 'optional', env: 'OPTIONAL_KEY' },
  ]

  it('passes only the secrets the manifest lists, under the names it gives, and keeps every other one out', async () => {
    // The orchestrator's own environment holds copies of secrets, some of which no manifest mentions.
    const baseEnv = {
      ...process.env,
      GEMINI_API_KEY: 'stale-inherited-value', // the plugin's own name: must be replaced by the store's value
      OTHER_API_KEY: OTHER, // another plugin's secret, inherited
      unlisted: UNLISTED, // a store secret whose name happens to be a variable name
      OPENAI_API_KEY: OPENAI, // known only through the environment store's alias
    }
    const store = new CompositeSecretStore([
      new EnvVarSecretStore({ env: baseEnv, aliases: { openai: 'OPENAI_API_KEY' } }),
      new MemorySecretStore({ gemini: SECRET, other: OTHER, unlisted: UNLISTED }),
    ])
    const dir = await makeTempDir()
    const infoFile = join(dir, 'info.json')
    const main = fakeEntry(dir, {
      id: 'main',
      args: ['--info-file', infoFile],
      secrets: secretRefs,
    })
    const other = fakeEntry(dir, {
      id: 'other',
      secrets: [{ name: 'other', env: 'OTHER_API_KEY' }],
    })
    const supervisor = await makeSupervisor([main, other], { secrets: store, baseEnv })

    await supervisor.start('main')
    const { env } = await readInfo(infoFile)
    expect(env.GEMINI_API_KEY).toBe(SECRET)
    expect(lowerKeys(env)).not.toContain('other_api_key')
    expect(lowerKeys(env)).not.toContain('unlisted')
    expect(lowerKeys(env)).not.toContain('openai_api_key')
    expect(lowerKeys(env)).not.toContain('optional_key') // declared but not set: not passed at all
    const values = Object.values(env)
    for (const leaked of [OTHER, UNLISTED, OPENAI, 'stale-inherited-value'])
      expect(values).not.toContain(leaked)
    expect(values.filter((value) => value === SECRET)).toHaveLength(1)
  })

  it('does not put a secret on the command line', async () => {
    const { supervisor, infoFile, id } = await setup({
      secrets: secretRefs,
      supervisor: { secretValues: { gemini: SECRET } },
    })
    const state = await supervisor.start(id)
    const info = await readInfo(infoFile)
    expect(info.env.GEMINI_API_KEY).toBe(SECRET)
    expect(info.argv.join(' ')).not.toContain(SECRET)

    // what the operating system itself records as the command line of the process
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    if (IS_WINDOWS && existsSync(powershell)) {
      const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${state.pid}").CommandLine`
      const out = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', query], {
        encoding: 'utf8',
        windowsHide: true,
      })
      expect(out.stdout).toContain('fake-service.mjs') // it did find the right process
      expect(out.stdout).not.toContain(SECRET)
    }
  })

  it('resolves ${secret:name} in env_vars', async () => {
    const { supervisor, infoFile, id } = await setup({
      secrets: secretRefs,
      envVars: { AUTH_HEADER: 'Bearer ${secret:gemini}', EMPTY_OPTIONAL: '[${secret:optional}]' },
      supervisor: { secretValues: { gemini: SECRET } },
    })
    await supervisor.start(id)
    const { env } = await readInfo(infoFile)
    expect(env.AUTH_HEADER).toBe(`Bearer ${SECRET}`)
    expect(env.EMPTY_OPTIONAL).toBe('[]')
  })

  it('refuses a secret in the command line, naming the placeholder and never the value', async () => {
    const dir = await makeTempDir()
    const infoFile = join(dir, 'info.json')
    const entry = fakeEntry(dir, {
      command: [
        '{python}',
        FAKE_SERVICE,
        '--port',
        '{port}',
        '--info-file',
        infoFile,
        '--stdout-line',
        '${secret:gemini}',
      ],
      secrets: secretRefs,
    })
    const supervisor = await makeSupervisor([entry], { secretValues: { gemini: SECRET } })
    const state = await supervisor.start('fake')
    expect(state.status).toBe('failed')
    expect(state.lastError).toContain('${secret:gemini}')
    expect(state.lastError).toContain('only allowed in env_vars')
    expect(state.lastError).not.toContain(SECRET)
    expect(existsSync(infoFile)).toBe(false) // nothing was spawned
  })

  it('refuses a secret the manifest does not list', async () => {
    const { supervisor, id } = await setup({
      envVars: { SNEAKY: '${secret:gemini}' },
      supervisor: { secretValues: { gemini: SECRET } },
    })
    const state = await supervisor.start(id)
    expect(state.status).toBe('failed')
    expect(state.lastError).toMatch(/secret "gemini" is not listed in the manifest's secrets/)
    expect(state.lastError).not.toContain(SECRET)
  })

  it('fails before spawning when a required secret is missing, and works once it is set', async () => {
    const store = new MemorySecretStore()
    const { supervisor, events, infoFile, id } = await setup({
      secrets: secretRefs,
      supervisor: { secrets: store },
    })
    const failed = await supervisor.start(id)
    expect(failed.status).toBe('failed')
    expect(failed.lastError).toBe(
      'required secret "gemini" is not set (it is passed to the plugin as GEMINI_API_KEY)'
    )
    expect(existsSync(infoFile)).toBe(false)

    await store.set('gemini', SECRET)
    const ready = await supervisor.start(id)
    expect(ready.status).toBe('ready')
    expect(ready.lastError).toBeUndefined() // a manual start clears the old error
    expect((await readInfo(infoFile)).env.GEMINI_API_KEY).toBe(SECRET)
    expect(statusNames(events)).toEqual(['starting', 'failed', 'starting', 'ready'])
  })

  it('fails with the name of the unknown placeholder', async () => {
    const dir = await makeTempDir()
    const entry = fakeEntry(dir, {
      command: ['{python}', FAKE_SERVICE, '--port', '{port}', '{nope}'],
    })
    const supervisor = await makeSupervisor([entry])
    const state = await supervisor.start('fake')
    expect(state.status).toBe('failed')
    expect(state.lastError).toBe('runtime.command[4]: unknown placeholder ({nope})')
  })

  it('reports a secret it cannot read as a failure of the plugin that needs it only', async () => {
    const broken = new MemorySecretStore({ gemini: SECRET })
    broken.get = async (name: string) => {
      if (name === 'gemini') throw new Error('secret "gemini" cannot be decrypted')
      return undefined
    }
    const dir = await makeTempDir()
    const needs = fakeEntry(dir, { id: 'needs', secrets: secretRefs })
    const free = fakeEntry(dir, { id: 'free' })
    const supervisor = await makeSupervisor([needs, free], { secrets: broken })
    const [a, b] = await Promise.all([supervisor.start('needs'), supervisor.start('free')])
    expect(a.status).toBe('failed')
    expect(a.lastError).toBe('secret "gemini" cannot be decrypted')
    expect(b.status).toBe('ready')
  })
})

describe('captured output', () => {
  const store = { gemini: SECRET, other: OTHER, unlisted: UNLISTED }
  const refs = [{ name: 'gemini', env: 'GEMINI_API_KEY' }]

  it("masks every secret in the store in the log lines, not only the plugin's own", async () => {
    const { supervisor, id } = await setup({
      secrets: refs,
      args: [
        '--echo-env',
        'GEMINI_API_KEY',
        '--stdout-line',
        `leak: ${UNLISTED}`,
        '--stderr-line',
        `again ${SECRET} and ${OTHER}`,
        '--many-lines',
        '3',
      ],
      supervisor: { secretValues: store },
    })
    await supervisor.start(id)
    await waitFor(() => supervisor.logs(id).includes('line 3'), 10_000, 'the service output')
    await waitFor(
      () => supervisor.logs(id).filter((line) => line === 'GEMINI_API_KEY=***').length === 2,
      10_000,
      'stdout and stderr echoes'
    )

    const lines = supervisor.logs(id)
    expect(lines).toContain('leak: ***')
    expect(lines).toContain('again *** and ***')
    expect(lines).toEqual(expect.arrayContaining(['line 1', 'line 2', 'line 3']))
    expect(lines.some((line) => line.startsWith('[supervisor] '))).toBe(true)
    const everything = JSON.stringify([lines, supervisor.snapshot(), supervisor.getStatus(id)])
    for (const secret of Object.values(store)) expect(everything).not.toContain(secret)
  })

  it('masks secrets a service puts into its health report, in events, errors and the state', async () => {
    const { supervisor, events, id } = await setup({
      secrets: refs,
      args: ['--leak-env', 'GEMINI_API_KEY'],
      supervisor: { secretValues: store },
    })
    const { url } = await supervisor.start(id)
    await fetch(`${url}/control`, { method: 'POST', body: JSON.stringify({ mode: 'leaky' }) })
    await waitForStatus(supervisor, id, 'unhealthy')

    const unhealthy = events.find((event) => event.status === 'unhealthy')
    expect(unhealthy?.detail).toContain('upstream refused the key ***')
    const state = supervisor.getStatus(id)
    expect(state.health?.detail).toBe('upstream refused the key ***')
    expect(state.health?.config).toEqual({ token: '***' })
    expect(JSON.stringify([events, state])).not.toContain(SECRET)
  })

  it('keeps the newest 500 lines', async () => {
    const { supervisor, id } = await setup({ args: ['--many-lines', '650'] })
    await supervisor.start(id)
    await waitFor(() => supervisor.logs(id).includes('line 650'), 10_000, 'the last line')
    const lines = supervisor.logs(id)
    expect(lines).toHaveLength(500)
    expect(lines).not.toContain('line 1')
    expect(lines).toContain('line 400') // 650 lines and a couple of notes leave the newest 500
    expect(supervisor.logs(id, 3)).toHaveLength(3)
    expect(supervisor.logs(id, 3)).toContain('line 650') // the supervisor's own "ready" note may come after it
  })

  it('honours the logLines option', async () => {
    const { supervisor, id } = await setup({
      args: ['--many-lines', '30'],
      supervisor: { logLines: 10 },
    })
    await supervisor.start(id)
    await waitFor(() => supervisor.logs(id).includes('line 30'), 10_000, 'the last line')
    expect(supervisor.logs(id)).toHaveLength(10)
  })

  it('keeps the output of a crashed process, plus a note about how it ended', async () => {
    const { supervisor, id } = await setup({
      args: ['--stdout-line', 'about to crash', '--exit-after', '300', '--exit-code', '4'],
      restart: { policy: 'never' },
    })
    await supervisor.start(id)
    await waitForStatus(supervisor, id, 'failed')
    const lines = supervisor.logs(id)
    expect(lines).toContain('about to crash')
    expect(lines).toContain('[supervisor] exited with code 4')
    expect(supervisor.getStatus(id).lastError).toBe('exited with code 4')
  })
})

describe.runIf(IS_WINDOWS)('batch file launchers', () => {
  async function batchSetup(guard: boolean) {
    const dir = await makeTempDir()
    const infoFile = join(dir, 'info.json')
    const marker = join(dir, 'helper-ran.txt')
    // run.bat calls its sibling by a relative name, which fails when NoDefaultCurrentDirectoryInExePath is set
    await writeFile(
      join(dir, 'run.bat'),
      '@echo off\r\ncall helper.bat\r\n"%NODE_EXE%" "%FAKE_SCRIPT%" --port %1 --info-file "%INFO_FILE%"\r\n'
    )
    await writeFile(join(dir, 'helper.bat'), '@echo off\r\necho helper ran>"%HELPER_MARKER%"\r\n')
    const entry = fakeEntry(dir, {
      env: 'native',
      command: [join(dir, 'run.bat'), '{port}'],
      guard,
      envVars: {
        NODE_EXE: process.execPath,
        FAKE_SCRIPT: FAKE_SERVICE,
        INFO_FILE: infoFile,
        HELPER_MARKER: marker,
      },
    })
    const baseEnv = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' }
    const supervisor = await makeSupervisor([entry], { baseEnv })
    return { supervisor, infoFile, marker }
  }

  it('starts a .bat file that calls another one by a relative name, without the guard', async () => {
    const { supervisor, infoFile, marker } = await batchSetup(false)
    const state = await supervisor.start('fake')
    expect(state.status).toBe('ready')
    expect((await readFile(marker, 'utf8')).trim()).toBe('helper ran')
    const info = await readInfo(infoFile)
    expect(info.pid).not.toBe(state.pid) // the root process is cmd.exe, the service is its child

    await supervisor.stop('fake')
    await waitForGone(state.pid ?? 0)
    await waitForGone(info.pid)
  })

  it.runIf(CAN_RUN_GUARD)('starts the same launcher through the job guard', async () => {
    const { supervisor, infoFile, marker } = await batchSetup(true)
    const state = await supervisor.start('fake')
    expect(state.status).toBe('ready')
    expect((await readFile(marker, 'utf8')).trim()).toBe('helper ran')
    const info = await readInfo(infoFile)
    await supervisor.stop('fake')
    await waitForGone(state.pid ?? 0)
    await waitForGone(info.pid)
  })

  it('refuses arguments that cmd.exe cannot take safely instead of guessing', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'run.bat'), '@echo off\r\n')
    const entry = fakeEntry(dir, {
      env: 'native',
      command: [join(dir, 'run.bat'), '100%'],
      guard: false,
    })
    const supervisor = await makeSupervisor([entry])
    const state = await supervisor.start('fake')
    expect(state.status).toBe('failed')
    expect(state.lastError).toMatch(/cannot take safely/)
    expect(state.lastError).not.toContain('100%')
  })
})

describe.runIf(CAN_RUN_GUARD)('the job guard around a real Python service', () => {
  const pythonService = (dir: string, infoFile: string, stop: FakeOptions['stop']) =>
    fakeEntry(dir, {
      id: 'py',
      env: 'light',
      guard: true,
      command: [
        '{python}',
        FAKE_PY_SERVICE,
        '--port',
        '{port}',
        '--grandchild',
        '--info-file',
        infoFile,
      ],
      stop,
    })

  it('runs a Python service under the guard, decodes its UTF-8 output, and stops it politely', async () => {
    const dir = await makeTempDir()
    const infoFile = join(dir, 'py.json')
    const entry = pythonService(dir, infoFile, {
      http: { method: 'POST', path: '/shutdown' },
      grace_ms: 8000,
    })
    const supervisor = await makeSupervisor([entry])
    const state = await supervisor.start('py')
    expect(state.status).toBe('ready')
    expect(state.health?.service).toBe('fake-py')

    const info = await readJsonFile<{
      pid: number
      grandchildPid: number
      stdoutEncoding: string
      unbuffered: string
    }>(infoFile)
    trackPid(info.pid)
    trackPid(info.grandchildPid)
    expect(info.pid).not.toBe(state.pid) // state.pid is the guard's side of the tree
    expect(info.unbuffered).toBe('1')
    expect(info.stdoutEncoding.toLowerCase().replace('_', '-')).toBe('utf-8')
    await waitFor(
      () => supervisor.logs('py').some((line) => line.includes('fake python service listening')),
      10_000,
      'the service banner'
    )
    expect(supervisor.logs('py')).toContain('fake python service listening \u00e9 \u4f60\u597d')

    await supervisor.stop('py')
    expect(supervisor.logs('py').some((line) => line.includes('killing process tree'))).toBe(false) // it left on its own
    for (const pid of [state.pid ?? 0, info.pid, info.grandchildPid]) await waitForGone(pid, 8000)
  })

  it('kills the guard, the service and its grandchild when there is no polite stop', async () => {
    const dir = await makeTempDir()
    const infoFile = join(dir, 'py.json')
    const supervisor = await makeSupervisor([pythonService(dir, infoFile, { grace_ms: 100 })])
    const state = await supervisor.start('py')
    const info = await readJsonFile<{ pid: number; grandchildPid: number }>(infoFile)
    trackPid(info.pid)
    trackPid(info.grandchildPid)
    for (const pid of [state.pid ?? 0, info.pid, info.grandchildPid])
      expect(pidAlive(pid)).toBe(true)

    await supervisor.stop('py')
    for (const pid of [state.pid ?? 0, info.pid, info.grandchildPid]) await waitForGone(pid, 8000)
  })

  it('passes the exit code of the service through the guard to the restart policy', async () => {
    const dir = await makeTempDir()
    const entry = fakeEntry(dir, {
      id: 'py',
      env: 'light',
      guard: true,
      command: ['{python}', '-c', 'import sys; sys.exit(3)'],
      restart: { policy: 'never' },
    })
    const supervisor = await makeSupervisor([entry])
    const state = await supervisor.start('py')
    expect(state.status).toBe('failed')
    expect(state.lastError).toBe('exited with code 3')
  })

  it('fails with a clear message when the guard interpreter is missing', async () => {
    const dir = await makeTempDir()
    const entry = pythonService(dir, join(dir, 'py.json'), undefined)
    const supervisor = await makeSupervisor([entry], {
      guard: { python: join(dir, 'no-python.exe'), script: join(dir, 'no-guard.py') },
    })
    const state = await supervisor.start('py')
    expect(state.status).toBe('failed')
    expect(state.lastError).toMatch(/the job guard interpreter does not exist/)
  })

  it('fails with a clear message when the guard script is missing', async () => {
    const dir = await makeTempDir()
    await mkdir(dir, { recursive: true })
    const entry = pythonService(dir, join(dir, 'py.json'), undefined)
    const supervisor = await makeSupervisor([entry], {
      guard: { python: process.execPath, script: join(dir, 'no-guard.py') },
    })
    const state = await supervisor.start('py')
    expect(state.status).toBe('failed')
    expect(state.lastError).toMatch(/the job guard script does not exist/)
  })
})
