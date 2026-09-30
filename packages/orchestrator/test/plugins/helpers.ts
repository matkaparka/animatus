/**
 * Shared test plumbing for the plugin tests: paths, temp directories, manifests for the fake services,
 * and cleanup that leaves no process behind even when an assertion fails.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginManifest, serviceName, type RuntimeEnv } from '@animatus/protocol'
import type { RegistryEntry } from '../../src/plugins/registry.ts'
import { MemorySecretStore, type SecretStore } from '../../src/plugins/secrets.ts'
import {
  Supervisor,
  type StatusEvent,
  type SupervisorOptions,
} from '../../src/plugins/supervisor.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '..', '..', '..', '..')
export const FAKE_SERVICE = join(here, 'fixtures', 'fake-service.mjs')
export const FAKE_PY_SERVICE = join(here, 'fixtures', 'fake_service.py')
export const GUARD_SCRIPT = join(REPO_ROOT, 'plugins', '_guard', 'job_guard.py')

const venvPython = join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
/** The light Python group of the repository, when `uv sync` has been run. */
export const LIGHT_PYTHON: string | undefined = existsSync(venvPython) ? venvPython : undefined
/** The guard is Windows-only and needs the light Python to run. */
export const CAN_RUN_GUARD =
  process.platform === 'win32' && LIGHT_PYTHON !== undefined && existsSync(GUARD_SCRIPT)
export const IS_WINDOWS = process.platform === 'win32'

// ───────────────────────────────── temp files and pids ─────────────────────────────────

const tempDirs: string[] = []
const trackedPids = new Set<number>()

export async function makeTempDir(prefix = 'plugins-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Marks a pid to be killed (with its tree) at cleanup if the test did not already stop it. */
export function trackPid(pid: number | null | undefined): void {
  if (typeof pid === 'number') trackedPids.add(pid)
}

export function killPidTree(pid: number): void {
  if (IS_WINDOWS) {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  what = 'the condition'
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(15)
  }
}

export const waitForGone = (pid: number, timeoutMs = 5000) =>
  waitFor(() => !pidAlive(pid), timeoutMs, `process ${pid} to be gone`)

export async function readJsonFile<T = Record<string, unknown>>(
  path: string,
  timeoutMs = 10_000
): Promise<T> {
  await waitFor(() => existsSync(path), timeoutMs, `${path} to exist`)
  // the writer may still be mid-write
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch (err) {
      if (attempt > 20) throw err
      await sleep(25)
    }
  }
}

export interface FakeInfo {
  pid: number
  ppid: number
  argv: string[]
  cwd: string
  env: Record<string, string>
  grandchildPid: number | null
}

/** Reads the info file a fake service writes once it listens, and remembers its pids for cleanup. */
export async function readInfo(path: string): Promise<FakeInfo> {
  const info = await readJsonFile<FakeInfo>(path)
  trackPid(info.pid)
  trackPid(info.grandchildPid)
  return info
}

// ───────────────────────────────────── manifests ─────────────────────────────────────

export interface FakeOptions {
  id?: string
  service?: string
  env?: RuntimeEnv
  /** Replaces the whole command (default: run the fake Node service on `{port}`). */
  command?: string[]
  /** Extra flags for the fake Node service. */
  args?: string[]
  cwd?: string
  port?: 'auto' | number
  envVars?: Record<string, string>
  guard?: boolean
  stop?: { http?: { method: 'GET' | 'POST'; path: string }; grace_ms?: number }
  http?: {
    path?: string
    method?: 'GET' | 'HEAD'
    expect_status?: number
    ready_field?: string | null
  }
  tcp?: boolean
  health?: {
    start_timeout_ms?: number
    interval_ms?: number
    timeout_ms?: number
    fail_threshold?: number
  }
  restart?: {
    policy?: 'never' | 'on-failure' | 'always'
    max_restarts?: number
    backoff_ms?: number[]
  }
  secrets?: { name: string; env: string; required?: boolean }[]
}

function finish(dir: string, id: string, manifest: PluginManifest): RegistryEntry {
  return {
    id,
    dir,
    manifestPath: join(dir, 'plugin.yaml'),
    manifest,
    service: serviceName(manifest),
  }
}

/**
 * A registry entry that runs the fake Node service. Timings are patched in after validation: the
 * schema's minimums (a 500 ms health interval, a 1 s start timeout) would make every test slow.
 */
export function fakeEntry(dir: string, options: FakeOptions = {}): RegistryEntry {
  const id = options.id ?? 'fake'
  const manifest = PluginManifest.parse({
    id,
    title: 'Fake service',
    kind: 'custom',
    ...(options.service ? { service: options.service } : {}),
    runtime: {
      type: 'process',
      env: options.env ?? 'node',
      command: options.command ?? [
        '{python}',
        FAKE_SERVICE,
        '--port',
        '{port}',
        ...(options.args ?? []),
      ],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      port: options.port ?? 'auto',
      env_vars: options.envVars ?? {},
      guard: options.guard ?? false,
      stop: {
        ...(options.stop?.http ? { http: options.stop.http } : {}),
        grace_ms: options.stop?.grace_ms ?? 1000,
      },
    },
    health: {
      http: options.tcp && !options.http ? undefined : { path: '/health', ...(options.http ?? {}) },
      tcp: options.tcp ?? false,
      start_timeout_ms: 1000,
      interval_ms: 500,
    },
    restart: {
      policy: options.restart?.policy ?? 'never',
      max_restarts: options.restart?.max_restarts ?? 3,
      backoff_ms: options.restart?.backoff_ms ?? [1000],
    },
    secrets: options.secrets ?? [],
  })
  manifest.health.start_timeout_ms = options.health?.start_timeout_ms ?? 8000
  manifest.health.interval_ms = options.health?.interval_ms ?? 40
  manifest.health.timeout_ms = options.health?.timeout_ms ?? 300
  manifest.health.fail_threshold = options.health?.fail_threshold ?? 2
  return finish(dir, id, manifest)
}

/** An entry for a service somebody else runs. */
export function externalEntry(
  dir: string,
  url: string,
  options: Pick<FakeOptions, 'id' | 'http' | 'tcp' | 'health'> = {}
): RegistryEntry {
  const id = options.id ?? 'ext'
  const manifest = PluginManifest.parse({
    id,
    title: 'External service',
    kind: 'custom',
    runtime: { type: 'external', url },
    health: {
      http: options.tcp && !options.http ? undefined : { path: '/health', ...(options.http ?? {}) },
      tcp: options.tcp ?? false,
    },
  })
  manifest.health.start_timeout_ms = options.health?.start_timeout_ms ?? 1500
  manifest.health.interval_ms = options.health?.interval_ms ?? 40
  manifest.health.timeout_ms = options.health?.timeout_ms ?? 300
  manifest.health.fail_threshold = options.health?.fail_threshold ?? 2
  return finish(dir, id, manifest)
}

export function inprocessEntry(dir: string, id = 'inproc'): RegistryEntry {
  const manifest = PluginManifest.parse({
    id,
    title: 'In-process plugin',
    kind: 'custom',
    runtime: { type: 'inprocess' },
    health: { tcp: true },
  })
  return finish(dir, id, manifest)
}

// ───────────────────────────────────── supervisors ─────────────────────────────────────

const supervisors: Supervisor[] = []

export interface MakeSupervisorOptions extends Partial<Omit<SupervisorOptions, 'registry'>> {
  secretValues?: Record<string, string>
}

export async function makeSupervisor(
  entries: RegistryEntry[],
  options: MakeSupervisorOptions = {}
): Promise<Supervisor> {
  const { secretValues, ...rest } = options
  const dataDir = rest.dataDir ?? (await makeTempDir('plugins-data-'))
  const secrets: SecretStore = rest.secrets ?? new MemorySecretStore(secretValues ?? {})
  const pluginConfig =
    rest.pluginConfig ?? Object.fromEntries(entries.map((entry) => [entry.id, { enabled: true }]))
  const supervisor = new Supervisor({
    interpreters: { light: LIGHT_PYTHON ?? 'python' },
    guard: { script: GUARD_SCRIPT, python: LIGHT_PYTHON ?? 'python' },
    startupPollMs: 20,
    ...rest,
    registry: entries,
    pluginConfig,
    secrets,
    dataDir,
  })
  supervisors.push(supervisor)
  return supervisor
}

export interface Recorded extends StatusEvent {
  at: number
}

/** Collects the status events of one plugin. */
export function recordStatuses(supervisor: Supervisor, id: string): Recorded[] {
  const events: Recorded[] = []
  supervisor.on('status', (event) => {
    if (event.id === id) events.push({ ...event, at: Date.now() })
  })
  return events
}

export const statusNames = (events: Recorded[]) => events.map((event) => event.status)

export async function waitForStatus(
  supervisor: Supervisor,
  id: string,
  status: string,
  timeoutMs = 10_000
): Promise<void> {
  await waitFor(
    () => supervisor.getStatus(id).status === status,
    timeoutMs,
    `${id} to be ${status} (is ${supervisor.getStatus(id).status})`
  )
}

/** Stops every supervisor made by `makeSupervisor`, kills leftover pids and removes temp directories. Call from afterEach. */
export async function cleanupAll(): Promise<void> {
  for (const supervisor of supervisors.splice(0)) {
    for (const snapshot of supervisor.snapshot()) trackPid(snapshot.pid)
    await supervisor.stopAll().catch(() => undefined)
  }
  for (const pid of trackedPids) if (pidAlive(pid)) killPidTree(pid)
  trackedPids.clear()
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => undefined
    )
}
