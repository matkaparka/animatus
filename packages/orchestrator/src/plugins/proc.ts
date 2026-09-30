/**
 * Process plumbing for the supervisor: child environment, output capture, killing a process tree.
 * Kept apart from supervisor.ts so each piece can be tested without a running plugin.
 */
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

export const IS_WINDOWS = process.platform === 'win32'

/** Resolves true after `ms`, or false as soon as `signal` aborts (the timer is cleared either way). */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ───────────────────────────────── environment ─────────────────────────────────

export interface ChildEnvInput {
  /** The orchestrator's own environment. */
  base: Readonly<Record<string, string | undefined>>
  /** Variable names to leave out. Compared case-insensitively. */
  strip: Iterable<string>
  /** Set only when the variable is absent after stripping (and `env_vars`/`secrets` did not name it). */
  defaults?: Readonly<Record<string, string>>
  /** The manifest's `env_vars`, already resolved. */
  envVars: Readonly<Record<string, string>>
  /** Secret values keyed by the environment variable they are injected as. They are applied last. */
  secrets: Readonly<Record<string, string>>
}

const findKey = (env: Record<string, string>, key: string): string | undefined => {
  if (!IS_WINDOWS) return Object.hasOwn(env, key) ? key : undefined
  const wanted = key.toUpperCase()
  return Object.keys(env).find((existing) => existing.toUpperCase() === wanted)
}

function setVar(env: Record<string, string>, key: string, value: string): void {
  // Windows variable names are case-insensitive: `Path` and `PATH` must not both survive.
  for (let existing = findKey(env, key); existing !== undefined; existing = findKey(env, key))
    delete env[existing]
  env[key] = value
}

/**
 * The environment of a plugin process: the orchestrator's environment minus every name in `strip`
 * (secrets, and the variable that breaks relative `call x.bat`), plus the defaults, plus `env_vars`,
 * plus the secrets the manifest asked for.
 */
export function buildChildEnv(input: ChildEnvInput): Record<string, string> {
  const stripped = new Set([...input.strip].map((name) => name.toUpperCase()))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined || stripped.has(key.toUpperCase())) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(input.defaults ?? {})) {
    if (findKey(env, key) === undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(input.envVars)) setVar(env, key, value)
  for (const [key, value] of Object.entries(input.secrets)) setVar(env, key, value)
  return env
}

// ─────────────────────────────────── output ───────────────────────────────────

/** Turns text chunks into lines. A carriage return inside a line overwrites what came before it, like a terminal. */
export class LineSplitter {
  private pending = ''
  private readonly maxPending: number
  private readonly holdBack: () => number

  /**
   * @param maxPending a line longer than this is cut, so a service without newlines cannot grow memory
   * @param holdBack characters kept back when cutting, so a secret split by the cut is still masked whole
   */
  constructor(maxPending = 16 * 1024, holdBack: () => number = () => 0) {
    this.maxPending = maxPending
    this.holdBack = holdBack
  }

  push(chunk: string): string[] {
    this.pending += chunk
    const lines: string[] = []
    for (let index = this.pending.indexOf('\n'); index >= 0; index = this.pending.indexOf('\n')) {
      lines.push(tidy(this.pending.slice(0, index)))
      this.pending = this.pending.slice(index + 1)
    }
    if (this.pending.length > this.maxPending) {
      const cut = this.pending.length - Math.min(Math.max(this.holdBack(), 0), this.pending.length)
      lines.push(tidy(this.pending.slice(0, cut)))
      this.pending = this.pending.slice(cut)
    }
    return lines
  }

  /** The unfinished last line, if any. */
  flush(): string | undefined {
    const rest = this.pending
    this.pending = ''
    return rest === '' ? undefined : tidy(rest)
  }
}

function tidy(line: string): string {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  const overwrite = trimmed.lastIndexOf('\r')
  return overwrite >= 0 ? trimmed.slice(overwrite + 1) : trimmed
}

export class RingBuffer<T> {
  private items: T[] = []
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  push(item: T): void {
    this.items.push(item)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
  }

  /** Oldest first. With `limit`, only the newest `limit` items. */
  toArray(limit?: number): T[] {
    if (limit === undefined) return [...this.items]
    return limit <= 0 ? [] : this.items.slice(-limit)
  }
}

// ───────────────────────────────── batch files ─────────────────────────────────

export interface Invocation {
  file: string
  args: string[]
  /** Pass the arguments to CreateProcess exactly as given (needed for cmd.exe). */
  verbatim: boolean
}

/**
 * Node refuses to start `.bat` and `.cmd` files directly (EINVAL). On Windows they are run through
 * `cmd.exe /d /s /c "..."` with every argument quoted. Arguments that cannot be quoted safely (a quote,
 * a percent sign, a line break) are rejected rather than escaped. Returns undefined for anything else.
 */
export function batchInvocation(command: readonly string[]): Invocation | undefined {
  const [file] = command
  if (!IS_WINDOWS || file === undefined || !/\.(bat|cmd)$/i.test(file)) return undefined
  const quoted = command.map((arg) => {
    if (/["%\r\n]/.test(arg))
      throw new Error(
        'an argument of a batch file contains a quote, a percent sign or a line break, which cmd.exe cannot take safely'
      )
    return arg === '' || /[\s&|<>^()!,;=]/.test(arg) ? `"${arg}"` : arg
  })
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${quoted.join(' ')}"`],
    verbatim: true,
  }
}

// ───────────────────────────────── killing trees ─────────────────────────────────

/** True when no process with this pid exists (any more). A process we may not signal still counts as existing. */
export function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

const taskkillPath = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')

/**
 * Kills a process and everything it started. Windows: `taskkill /PID <pid> /T /F`. Elsewhere the child
 * was started as a process group leader, so the whole group gets SIGKILL. A process that is already
 * gone is not an error.
 */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!IS_WINDOWS) {
      killGroup(pid)
      return resolve()
    }
    const killer = spawn(taskkillPath(), ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => resolve())
    killer.once('exit', () => resolve())
  })
}

export function killTreeSync(pid: number): void {
  if (!IS_WINDOWS) return killGroup(pid)
  spawnSync(taskkillPath(), ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 5000,
  })
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

const live = new Set<number>()
let exitHookInstalled = false

/**
 * Remembers a running plugin process. If the orchestrator exits normally without stopping its plugins
 * (an uncaught exception, `process.exit`), the exit hook kills their trees synchronously. A force-kill
 * never reaches the hook; that case is the job guard's.
 */
export function trackChild(pid: number): void {
  live.add(pid)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const tracked of live) killTreeSync(tracked)
  })
}

export function untrackChild(pid: number): void {
  live.delete(pid)
}
