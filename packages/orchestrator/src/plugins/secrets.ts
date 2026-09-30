/**
 * Secret storage. The orchestrator is the only secret holder: values live here, reach a plugin only as
 * environment variables of that plugin's process (see supervisor.ts), and are masked in every log line
 * the console can show. The console's key page is write-only, which is why `names()` exists and no call
 * returns a value to a UI.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Id } from '@animatus/protocol'

export interface SecretStore {
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  /** Which secrets exist and where they come from. Never returns values. */
  names(): Promise<{ name: string; source: string }[]>
  /** `false` for stores that cannot be written (the process environment). Absent means writable. */
  readonly writable?: boolean
  /** Names of process environment variables this store reads secrets from, so children do not inherit them. */
  envNames?(): string[]
}

export type SecretStoreErrorCode =
  | 'invalid_name'
  | 'invalid_value'
  | 'read_only'
  | 'unsupported'
  | 'unavailable'
  | 'corrupt'
  | 'decrypt_failed'

/** Messages of this error never contain a secret value. */
export class SecretStoreError extends Error {
  readonly code: SecretStoreErrorCode

  constructor(message: string, code: SecretStoreErrorCode) {
    super(message)
    this.name = 'SecretStoreError'
    this.code = code
  }
}

function checkName(name: string): void {
  // The message must not echo the argument: a caller that mixed up name and value would print a secret.
  if (!Id.safeParse(name).success) {
    throw new SecretStoreError(
      'invalid secret name (letters, digits and . _ : @ - only, at most 96 characters)',
      'invalid_name'
    )
  }
}

function checkValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) {
    throw new SecretStoreError(
      'a secret value must be a non-empty string without NUL characters',
      'invalid_value'
    )
  }
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0

/** Secret name -> the key it is stored under in an environment-style store. */
export type SecretAliases = Readonly<Record<string, string>>

/**
 * Builds an alias table from plugin manifests: a secret `{ name: gemini, env: GEMINI_API_KEY }` is read
 * from the key `GEMINI_API_KEY` of `.env` files and the process environment. The first declaration of a
 * name wins.
 */
export function secretAliasesFrom(
  entries: Iterable<{ manifest: { secrets: readonly { name: string; env: string }[] } }>
): Record<string, string> {
  const aliases: Record<string, string> = {}
  for (const { manifest } of entries) {
    for (const secret of manifest.secrets) aliases[secret.name] ??= secret.env
  }
  return aliases
}

// ───────────────────────────────── memory ─────────────────────────────────

/** In-memory store, for tests and for secrets that must not touch the disk. */
export class MemorySecretStore implements SecretStore {
  readonly source: string
  private readonly values = new Map<string, string>()

  constructor(initial: Readonly<Record<string, string>> = {}, source = 'memory') {
    this.source = source
    for (const [name, value] of Object.entries(initial)) this.values.set(name, value)
  }

  async get(name: string): Promise<string | undefined> {
    return this.values.get(name)
  }

  async set(name: string, value: string): Promise<void> {
    checkName(name)
    checkValue(value)
    this.values.set(name, value)
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name)
  }

  async names(): Promise<{ name: string; source: string }[]> {
    return [...this.values.keys()].map((name) => ({ name, source: this.source })).sort(byName)
  }
}

// ────────────────────────────── process environment ──────────────────────────────

export interface EnvVarSecretStoreOptions {
  /** Secret name -> environment variable (default: the variable with the same name). */
  aliases?: SecretAliases
  /** The environment to read; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
  source?: string
}

/**
 * Reads secrets from the process environment. Read-only. `names()` lists the aliased names that are set
 * (listing all of `process.env` would be noise), while `get` also answers for any variable name.
 */
export class EnvVarSecretStore implements SecretStore {
  readonly writable = false
  readonly source: string
  private readonly aliases: SecretAliases
  private readonly env: Readonly<Record<string, string | undefined>>

  constructor(options: EnvVarSecretStoreOptions = {}) {
    this.aliases = options.aliases ?? {}
    this.env = options.env ?? process.env
    this.source = options.source ?? 'env'
  }

  async get(name: string): Promise<string | undefined> {
    const value = this.env[this.aliases[name] ?? name]
    return value === undefined || value === '' ? undefined : value
  }

  async set(): Promise<void> {
    throw new SecretStoreError('the process environment is read-only', 'read_only')
  }

  async delete(): Promise<void> {
    throw new SecretStoreError('the process environment is read-only', 'read_only')
  }

  async names(): Promise<{ name: string; source: string }[]> {
    const found: { name: string; source: string }[] = []
    for (const [name, key] of Object.entries(this.aliases)) {
      const value = this.env[key]
      if (value !== undefined && value !== '') found.push({ name, source: this.source })
    }
    return found.sort(byName)
  }

  envNames(): string[] {
    return Object.values(this.aliases)
  }
}

// ─────────────────────────────────── dotenv file ───────────────────────────────────

interface EnvEntry {
  key: string
  value: string
  /** Line range in the file (inclusive); a double-quoted value may span lines. */
  start: number
  end: number
}

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z0-9_.:@-]+)\s*=(.*)$/

/** Index of the first `"` that is not escaped, or -1. */
function closingQuote(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i
  }
  return -1
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(["\\nrt])/g, (_match, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch
  )
}

function parseEntries(text: string): EnvEntry[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  const entries: EnvEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*(#|$)/.test(line)) continue
    const match = KEY_LINE.exec(line)
    if (!match) continue
    const key = match[1] ?? ''
    const rest = (match[2] ?? '').trimStart()
    let end = i
    let value: string
    if (rest.startsWith('"')) {
      let buffer = rest.slice(1)
      let close = closingQuote(buffer)
      while (close < 0 && end + 1 < lines.length) {
        end++
        buffer += `\n${lines[end] ?? ''}`
        close = closingQuote(buffer)
      }
      if (close >= 0) value = unescapeDouble(buffer.slice(0, close))
      else {
        end = i // never closed: take the line literally
        value = rest
      }
    } else if (rest.startsWith("'")) {
      const close = rest.indexOf("'", 1)
      value = close >= 0 ? rest.slice(1, close) : rest
    } else {
      const comment = rest.search(/(^|\s)#/)
      value = (comment >= 0 ? rest.slice(0, comment) : rest).trim()
    }
    entries.push({ key, value, start: i, end })
    i = end
  }
  return entries
}

/**
 * Parses dotenv text: `KEY=value`, `export KEY=value`, `#` comments (whole-line, or after whitespace in
 * an unquoted value), single quotes (literal), double quotes (`\n \r \t \" \\` escapes, may span lines).
 * No variable interpolation. When a key repeats, the last one wins.
 */
export function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of parseEntries(text)) result[entry.key] = entry.value
  return result
}

/** The text form of a value that `parseDotenv` reads back unchanged. */
function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)) return value
  if (!/['\r\n]/.test(value)) return `'${value}'`
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  return `"${escaped}"`
}

function splitLines(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function joinLines(original: string, lines: string[]): string {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  return lines.length === 0 ? '' : lines.join(newline) + newline
}

function applySet(text: string, key: string, value: string): string {
  const lines = splitLines(text)
  const line = `${key}=${formatEnvValue(value)}`
  const entries = parseEntries(text).filter((entry) => entry.key === key)
  if (entries.length === 0) lines.push(line)
  else {
    // Bottom to top so earlier line numbers stay valid: the last definition is replaced, older ones go.
    for (const [index, entry] of [...entries].reverse().entries()) {
      lines.splice(entry.start, entry.end - entry.start + 1, ...(index === 0 ? [line] : []))
    }
  }
  return joinLines(text, lines)
}

function applyDelete(text: string, key: string): string | undefined {
  const entries = parseEntries(text).filter((entry) => entry.key === key)
  if (entries.length === 0) return undefined
  const lines = splitLines(text)
  for (const entry of [...entries].reverse()) lines.splice(entry.start, entry.end - entry.start + 1)
  return joinLines(text, lines)
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Windows: an indexer or antivirus scanner may hold the target for a moment.
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}

/** Writes `data` next to `path` and renames it into place, so a reader sees the old or the new file, never half of one. */
async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  )
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(temp, path)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

export interface EnvFileSecretStoreOptions {
  /** Secret name -> key in the file (default: the key with the same name). */
  aliases?: SecretAliases
  source?: string
}

/**
 * Secrets in a dotenv file (`config/.env`). The file is re-read on every call so hand edits show up
 * without a restart; writes keep comments and other keys and replace the file atomically. An empty value
 * (`KEY=`, as in the shipped example file) counts as not set.
 */
export class EnvFileSecretStore implements SecretStore {
  readonly path: string
  readonly source: string
  private readonly aliases: SecretAliases
  private readonly logicalName = new Map<string, string>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(path: string, options: EnvFileSecretStoreOptions = {}) {
    this.path = path
    this.aliases = options.aliases ?? {}
    this.source = options.source ?? 'env-file'
    for (const [name, key] of Object.entries(this.aliases)) this.logicalName.set(key, name)
  }

  private keyFor(name: string): string {
    return this.aliases[name] ?? name
  }

  async get(name: string): Promise<string | undefined> {
    const text = await readIfExists(this.path)
    if (text === undefined) return undefined
    const value = parseDotenv(text)[this.keyFor(name)]
    return value === undefined || value === '' ? undefined : value
  }

  async names(): Promise<{ name: string; source: string }[]> {
    const text = await readIfExists(this.path)
    if (text === undefined) return []
    return Object.entries(parseDotenv(text))
      .filter(([, value]) => value !== '')
      .map(([key]) => ({ name: this.logicalName.get(key) ?? key, source: this.source }))
      .sort(byName)
  }

  async set(name: string, value: string): Promise<void> {
    checkName(name)
    checkValue(value)
    const key = this.keyFor(name)
    await this.edit((text) => applySet(text, key, value))
  }

  async delete(name: string): Promise<void> {
    const key = this.keyFor(name)
    await this.edit((text) => applyDelete(text, key))
  }

  envNames(): string[] {
    return []
  }

  /** Read-modify-write, one at a time so parallel calls cannot lose each other's changes. */
  private edit(change: (text: string) => string | undefined): Promise<void> {
    const run = async () => {
      const before = (await readIfExists(this.path)) ?? ''
      const after = change(before)
      if (after !== undefined && after !== before) await writeFileAtomic(this.path, after)
    }
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => undefined)
    return result
  }
}

// ───────────────────────────────── Windows DPAPI ─────────────────────────────────

/**
 * Runs inside Windows PowerShell 5.1. The request arrives on stdin as JSON; values travel as base64 of
 * their UTF-8 bytes in both directions, so no console code page can damage them. The script text holds
 * no secret, it is the same for every call, and it goes on the command line encoded.
 *
 * protect:   { op, items: { name: base64(plain) } }     -> { name: { ok, value: <DPAPI protected string> } }
 * unprotect: { op, items: { name: <protected> } }        -> { name: { ok, value: base64(plain) } }
 */
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $result = @{}
  foreach ($item in $request.items.PSObject.Properties) {
    try {
      if ($request.op -eq 'protect') {
        $plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($item.Value))
        $value = ConvertTo-SecureString -String $plain -AsPlainText -Force | ConvertFrom-SecureString
      } else {
        $secure = ConvertTo-SecureString -String $item.Value
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        $value = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain))
      }
      $result[$item.Name] = @{ ok = $true; value = $value }
    } catch {
      $result[$item.Name] = @{ ok = $false }
    }
  }
  [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
} catch {
  [Console]::Out.Write((@{ fatal = $_.Exception.GetType().FullName } | ConvertTo-Json -Compress))
  exit 1
}
`

const DPAPI_ENCODED_SCRIPT = Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64')

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

interface PowerShellResult {
  [name: string]: { ok: boolean; value?: string }
}

export interface DpapiFileSecretStoreOptions {
  /** Path of Windows PowerShell 5.1. Defaults to the copy under %SystemRoot%. */
  powershell?: string
  /** How to start it. Defaults to `child_process.spawn`; tests wrap it to look at the arguments. */
  spawn?: SpawnFn
  /** Give up on one PowerShell call after this long (default 30 s). */
  timeoutMs?: number
  source?: string
}

function defaultPowerShell(): string {
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

/**
 * Secrets encrypted with Windows DPAPI in the current user's scope: the file holds a JSON object of
 * name -> protected string, useless on another machine or under another Windows account. Encryption and
 * decryption run in PowerShell 5.1 (`ConvertTo-SecureString` / `ConvertFrom-SecureString`); the values
 * are sent over its stdin and never appear on a command line. Everything is decrypted on the first read
 * (one PowerShell start for all secrets) and kept in memory afterwards.
 */
export class DpapiFileSecretStore implements SecretStore {
  readonly path: string
  readonly source: string
  private readonly powershell: string
  private readonly spawnFn: SpawnFn
  private readonly timeoutMs: number
  private readonly ownPowerShell: boolean
  /** name -> protected string, as in the file. Loaded lazily. */
  private entries: Map<string, string> | undefined
  /** name -> plain value, for entries decrypted so far. */
  private readonly plain = new Map<string, string>()
  /** Names whose entry could not be decrypted (another user or machine). */
  private readonly undecryptable = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(path: string, options: DpapiFileSecretStoreOptions = {}) {
    this.path = path
    this.source = options.source ?? 'dpapi-file'
    this.ownPowerShell = options.powershell !== undefined
    this.powershell = options.powershell ?? defaultPowerShell()
    this.spawnFn = options.spawn ?? (nodeSpawn as SpawnFn)
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async get(name: string): Promise<string | undefined> {
    const entries = await this.load()
    if (!entries.has(name)) return undefined
    const known = this.plain.get(name)
    if (known !== undefined) return known
    await this.exclusive(() => this.decryptPending())
    const value = this.plain.get(name)
    if (value === undefined) {
      throw new SecretStoreError(
        `secret "${name}" cannot be decrypted (it was saved by another Windows user or on another machine)`,
        'decrypt_failed'
      )
    }
    return value
  }

  async set(name: string, value: string): Promise<void> {
    checkName(name)
    checkValue(value)
    await this.exclusive(async () => {
      const entries = await this.load()
      const result = await this.runPowerShell(
        'protect',
        { [name]: Buffer.from(value, 'utf8').toString('base64') },
        [value]
      )
      const protectedValue = result[name]?.ok ? result[name]?.value : undefined
      if (!protectedValue)
        throw new SecretStoreError('Windows could not protect the secret', 'unavailable')
      const next = new Map(entries).set(name, protectedValue)
      await this.persist(next)
      this.entries = next
      this.plain.set(name, value)
      this.undecryptable.delete(name)
    })
  }

  async delete(name: string): Promise<void> {
    await this.exclusive(async () => {
      const entries = await this.load()
      if (!entries.has(name)) return
      const next = new Map(entries)
      next.delete(name)
      await this.persist(next)
      this.entries = next
      this.plain.delete(name)
      this.undecryptable.delete(name)
    })
  }

  async names(): Promise<{ name: string; source: string }[]> {
    const entries = await this.load()
    return [...entries.keys()].map((name) => ({ name, source: this.source })).sort(byName)
  }

  envNames(): string[] {
    return []
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job, job)
    this.chain = result.catch(() => undefined)
    return result
  }

  private async load(): Promise<Map<string, string>> {
    if (this.entries) return this.entries
    const text = await readIfExists(this.path)
    const map = new Map<string, string>()
    if (text !== undefined && text.trim() !== '') {
      let parsed: unknown
      try {
        parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
      } catch {
        throw new SecretStoreError('the secret file is not valid JSON', 'corrupt')
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SecretStoreError('the secret file must hold a JSON object', 'corrupt')
      }
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value !== 'string')
          throw new SecretStoreError('the secret file holds a non-string entry', 'corrupt')
        map.set(name, value)
      }
    }
    this.entries = map
    return map
  }

  private async persist(map: Map<string, string>): Promise<void> {
    const sorted = Object.fromEntries(
      [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
    await writeFileAtomic(this.path, `${JSON.stringify(sorted, null, 2)}\n`)
  }

  /** Decrypts every entry that is not decrypted yet, in one PowerShell call. */
  private async decryptPending(): Promise<void> {
    const entries = await this.load()
    const pending: Record<string, string> = {}
    for (const [name, protectedValue] of entries) {
      if (!this.plain.has(name) && !this.undecryptable.has(name)) pending[name] = protectedValue
    }
    if (Object.keys(pending).length === 0) return
    const result = await this.runPowerShell('unprotect', pending, [])
    for (const name of Object.keys(pending)) {
      const item = result[name]
      if (item?.ok && typeof item.value === 'string')
        this.plain.set(name, Buffer.from(item.value, 'base64').toString('utf8'))
      else this.undecryptable.add(name)
    }
  }

  private runPowerShell(
    op: 'protect' | 'unprotect',
    items: Record<string, string>,
    secretsInPlay: string[]
  ): Promise<PowerShellResult> {
    if (process.platform !== 'win32' && !this.ownPowerShell) {
      return Promise.reject(
        new SecretStoreError('DPAPI is only available on Windows', 'unsupported')
      )
    }
    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        // Nothing here should contain a value, but a message is cheap to scrub.
        reject(new SecretStoreError(createRedactor(secretsInPlay).apply(message), 'unavailable'))
      }
      let child: ChildProcess
      try {
        child = this.spawnFn(
          this.powershell,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', DPAPI_ENCODED_SCRIPT],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        )
      } catch (err) {
        return fail(`cannot start PowerShell: ${err instanceof Error ? err.message : String(err)}`)
      }
      let stdout = ''
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        child.kill()
        fail(`PowerShell did not answer within ${this.timeoutMs} ms`)
      }, this.timeoutMs)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => (stdout += chunk))
      child.stderr?.resume()
      child.stdin?.on('error', () => undefined) // a dead child surfaces through 'error' / 'close'
      child.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fail(`cannot start PowerShell: ${err.message}`)
      })
      child.once('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        let parsed: unknown
        try {
          parsed = JSON.parse(stdout)
        } catch {
          return fail(`PowerShell exited with code ${code} and no usable answer`)
        }
        if (typeof parsed === 'object' && parsed !== null && 'fatal' in parsed) {
          return fail(`PowerShell failed (${String((parsed as { fatal: unknown }).fatal)})`)
        }
        if (code !== 0 || typeof parsed !== 'object' || parsed === null)
          return fail(`PowerShell exited with code ${code}`)
        resolve(parsed as PowerShellResult)
      })
      child.stdin?.end(JSON.stringify({ op, items }))
    })
  }
}

// ───────────────────────────────────── composite ─────────────────────────────────────

/**
 * Several stores in priority order. `get`: the first store that has the name wins. `set`: goes to the
 * first writable store (put writable stores before read-only ones, or a read-only store that has the
 * name keeps shadowing the new value). `delete`: removes the name from every writable store.
 */
export class CompositeSecretStore implements SecretStore {
  private readonly stores: readonly SecretStore[]

  constructor(stores: readonly SecretStore[]) {
    this.stores = [...stores]
  }

  get writable(): boolean {
    return this.stores.some((store) => store.writable !== false)
  }

  async get(name: string): Promise<string | undefined> {
    for (const store of this.stores) {
      const value = await store.get(name)
      if (value !== undefined) return value
    }
    return undefined
  }

  async set(name: string, value: string): Promise<void> {
    const target = this.stores.find((store) => store.writable !== false)
    if (!target) throw new SecretStoreError('none of the secret stores is writable', 'read_only')
    await target.set(name, value)
  }

  async delete(name: string): Promise<void> {
    for (const store of this.stores) if (store.writable !== false) await store.delete(name)
  }

  async names(): Promise<{ name: string; source: string }[]> {
    const seen = new Map<string, { name: string; source: string }>()
    for (const store of this.stores) {
      for (const entry of await store.names())
        if (!seen.has(entry.name)) seen.set(entry.name, entry)
    }
    return [...seen.values()].sort(byName)
  }

  envNames(): string[] {
    return [...new Set(this.stores.flatMap((store) => store.envNames?.() ?? []))]
  }
}

// ───────────────────────────────────── redaction ─────────────────────────────────────

export const REDACTED = '***'

/** Values shorter than this are not masked: they would mangle ordinary text and are not credible secrets. */
const MIN_REDACT_LENGTH = 4

export interface Redactor {
  /** Length of the longest string it masks (0 when it masks nothing). */
  readonly maxLength: number
  apply(text: string): string
  /** A copy of a JSON-like value (an object a service reported, say) with every string and key masked. */
  applyDeep<T>(value: T): T
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function maskDeep(value: unknown, apply: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return apply(value)
  if (depth > 8 || typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, apply, depth + 1))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [apply(key), maskDeep(item, apply, depth + 1)])
  )
}

/**
 * Builds a function that masks the given secret values. Besides the raw value it masks the URL-encoded
 * and the JSON-escaped forms, and the individual lines of a multi-line value. Longer values are matched
 * first so a secret that contains another secret is masked as a whole.
 */
export function createRedactor(values: Iterable<string>): Redactor {
  const variants = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.length < MIN_REDACT_LENGTH) continue
    variants.add(value)
    variants.add(encodeURIComponent(value))
    variants.add(JSON.stringify(value).slice(1, -1))
    if (/[\r\n]/.test(value))
      for (const line of value.split(/\r\n|\n|\r/)) if (line.length >= 8) variants.add(line)
  }
  const ordered = [...variants]
    .filter((variant) => variant.length >= MIN_REDACT_LENGTH)
    .sort((a, b) => b.length - a.length)
  if (ordered.length === 0)
    return { maxLength: 0, apply: (text) => text, applyDeep: (value) => value }
  const pattern = new RegExp(ordered.map(escapeRegExp).join('|'), 'g')
  const apply = (text: string) => text.replace(pattern, () => REDACTED)
  return {
    maxLength: ordered[0]?.length ?? 0,
    apply,
    applyDeep: <T>(value: T) => maskDeep(value, apply) as T,
  }
}

/** Removes every occurrence of the given secret values from `text`. */
export function redact(text: string, values: Iterable<string>): string {
  return createRedactor(values).apply(text)
}
