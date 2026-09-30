/**
 * A thin wrapper around the `git` command for the memory folder: every change is a commit whose author says who
 * made it (the streamer, the program's consolidation, the system), so the history can be read and any file rolled
 * back. Nothing here touches the user's git configuration: identity and settings are passed on each command, and
 * the user-level and system-level configuration files are ignored.
 *
 * When `git` is not installed the wrapper says so once (`available()` is false) and every call answers "no
 * history": memory keeps working, only history and rollback are off.
 */
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** What git accepts as an empty configuration file (`os.devNull` is spelled in a way git for Windows rejects). */
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

export type Author = 'human' | 'agent' | 'system'

const IDENTITIES: Record<Author, { name: string; email: string }> = {
  human: { name: 'human', email: 'human@animatus.invalid' },
  agent: { name: 'agent', email: 'agent@animatus.invalid' },
  system: { name: 'system', email: 'system@animatus.invalid' },
}

export interface Commit {
  hash: string
  author: Author
  /** Milliseconds since the epoch. */
  time: number
  subject: string
}

export interface GitOptions {
  /** The folder that is the work tree. */
  root: string
  /** Where the repository lives; default `<root>/.git`. */
  gitDir?: string
  /** Timeout of one git command in ms. Default 15 000. */
  timeoutMs?: number
  /** The executable. Default `git`. */
  executable?: string
}

interface Result {
  ok: boolean
  stdout: string
  stderr: string
}

export class MemoryGit {
  private readonly root: string
  private readonly gitDir: string
  private readonly timeoutMs: number
  private readonly exe: string
  private ready: Promise<boolean> | null = null

  constructor(opts: GitOptions) {
    this.root = opts.root
    this.gitDir = opts.gitDir ?? path.join(opts.root, '.git')
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.exe = opts.executable ?? 'git'
  }

  private run(args: string[], author: Author = 'system', input?: string): Promise<Result> {
    const id = IDENTITIES[author]
    const full = [
      '--git-dir',
      this.gitDir,
      '--work-tree',
      this.root,
      '-c',
      `user.name=${id.name}`,
      '-c',
      `user.email=${id.email}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.quotepath=false',
      '-c',
      'gc.auto=0',
      ...args,
    ]
    return new Promise((resolve) => {
      const child = execFile(
        this.exe,
        full,
        {
          cwd: this.root,
          timeout: this.timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: NULL_DEVICE,
            GIT_TERMINAL_PROMPT: '0',
            LC_ALL: 'C',
          },
        },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' })
      )
      if (input !== undefined) child.stdin?.end(input)
    })
  }

  /** True when git is installed and the repository exists (it is made on the first call). */
  available(): Promise<boolean> {
    this.ready ??= (async () => {
      const v = await this.run(['--version'])
      if (!v.ok) return false
      if (!existsSync(path.join(this.gitDir, 'HEAD'))) {
        await mkdir(this.root, { recursive: true })
        await mkdir(path.dirname(this.gitDir), { recursive: true })
        const init = await this.run(['init', '--quiet', '--initial-branch=main'])
        if (!init.ok) return false
      }
      return true
    })()
    return this.ready
  }

  /** Commit these paths (relative, `/` separators; a path that no longer exists is recorded as removed). */
  async commit(paths: readonly string[], message: string, author: Author): Promise<boolean> {
    if (!(await this.available()) || paths.length === 0) return false
    const add = await this.run(['add', '-A', '--', ...paths], author)
    if (!add.ok) return false
    const staged = await this.run(['diff', '--cached', '--quiet', '--', ...paths], author)
    if (staged.ok) return false // nothing changed
    const c = await this.run(
      ['commit', '--quiet', '--allow-empty-message', '-m', message.slice(0, 200), '--', ...paths],
      author
    )
    return c.ok
  }

  /** Newest first. */
  async log(file: string | null, limit = 50): Promise<Commit[]> {
    if (!(await this.available())) return []
    const res = await this.run([
      'log',
      `--max-count=${Math.max(1, Math.min(500, limit))}`,
      '--format=%H%x1f%an%x1f%at%x1f%s',
      ...(file ? ['--', file] : []),
    ])
    if (!res.ok) return []
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash = '', an = 'system', at = '0', ...subject] = l.split('\x1f')
        const author: Author = an === 'human' || an === 'agent' ? an : 'system'
        return { hash, author, time: Number(at) * 1000, subject: subject.join('\x1f') }
      })
  }

  /** True when `rev` is a hash of a commit this repository has. */
  async hasCommit(rev: string): Promise<boolean> {
    if (!(await this.available()) || !/^[0-9a-f]{7,40}$/.test(rev)) return false
    return (await this.run(['cat-file', '-e', `${rev}^{commit}`])).ok
  }

  /** A file as it was in a commit, or null when it did not exist then. */
  async show(rev: string, file: string): Promise<string | null> {
    if (!(await this.available()) || !/^[0-9a-f]{7,40}$/.test(rev)) return null
    const res = await this.run(['show', `${rev}:${file}`])
    return res.ok ? res.stdout : null
  }

  /** The unified diff of one file between two commits (`to` defaults to the work tree). */
  async diff(file: string, from: string, to?: string): Promise<string | null> {
    if (!(await this.available()) || !/^[0-9a-f]{7,40}$/.test(from)) return null
    if (to !== undefined && !/^[0-9a-f]{7,40}$/.test(to)) return null
    const res = await this.run([
      'diff',
      '--no-color',
      '--unified=2',
      from,
      ...(to ? [to] : []),
      '--',
      file,
    ])
    return res.ok ? res.stdout : null
  }
}
