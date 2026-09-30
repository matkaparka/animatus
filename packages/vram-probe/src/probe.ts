import { EventEmitter } from 'node:events'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ROLES, RoleClassifier, type RoleMap } from './roles.ts'
import type { AdapterInfo, LogRecord, Mark, MetaRecord, ProcEntry, RawSample, Sample } from './types.ts'

export const COLLECTOR_PATH = join(dirname(fileURLToPath(import.meta.url)), 'collector.ps1')

export interface ProbeOptions {
  /** Seconds between samples handed to the collector (default 1). */
  intervalSec?: number
  /** Role matchers (default: DEFAULT_ROLES). */
  roles?: RoleMap
  /** Force the target adapter, e.g. luid_0x00000000_0x000122ab. Default: the NVIDIA adapter, else the largest hardware one. */
  luid?: string
  /** Write <label>-<timestamp>.jsonl and .csv here. Omit to keep everything in memory. */
  outDir?: string
  label?: string
  /** Ignore processes holding less than this on an adapter (MiB, default 1). */
  minProcMB?: number
  /** Cross-check the adapter total against nvidia-smi (default true; switched off automatically when it is missing). */
  nvidiaSmi?: boolean
  /** Samples kept in memory (default 86400 = a day at 1 Hz). */
  maxSamples?: number
  /** Replace the collector process (tests). */
  collectorCommand?: { command: string; args: string[] }
}

const round1 = (n: number) => Math.round(n * 10) / 10

function readNvidiaSmi(): Promise<number | null> {
  return new Promise((res) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return res(null)
        const n = parseInt(String(stdout).split(/\r?\n/)[0] ?? '', 10)
        res(Number.isFinite(n) ? n : null)
      }
    )
  })
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    child.kill('SIGKILL')
  }
}

const closeStream = (s: WriteStream | null) =>
  new Promise<void>((res) => {
    if (!s) return res()
    s.end(() => res())
  })

/** Choose the adapter whose memory is the budget: NVIDIA first, else the largest non-software adapter. */
export function pickTarget(adapters: AdapterInfo[], luid?: string): AdapterInfo | null {
  if (luid) {
    const want = luid.toLowerCase()
    return adapters.find((a) => a.luid === want || a.luid.startsWith(want)) ?? null
  }
  const hw = adapters.filter((a) => (a.flags & 2) === 0)
  const nvidia = hw.filter((a) => a.vendor.toLowerCase() === '0x10de')
  const pool = nvidia.length ? nvidia : hw
  return [...pool].sort((a, b) => b.dedicated_mb - a.dedicated_mb)[0] ?? null
}

/**
 * Records dedicated GPU memory once per interval, per process and per adapter, and attributes it to
 * roles. Events: 'adapters', 'sample', 'mark', 'collector-stderr', 'exit'.
 */
export class VramProbe extends EventEmitter {
  readonly classifier: RoleClassifier
  adapters: AdapterInfo[] = []
  target: AdapterInfo | null = null
  samples: Sample[] = []
  marks: Mark[] = []
  /** Paths of the files being written, once started (outDir given). */
  files: { jsonl: string; csv: string } | null = null

  private readonly opts: ProbeOptions
  private child: ChildProcess | null = null
  private t0 = 0
  private jsonl: WriteStream | null = null
  private csv: WriteStream | null = null
  private csvRoles: string[] = []
  private chain: Promise<void> = Promise.resolve()
  private nvsmiOk: boolean

  constructor(opts: ProbeOptions = {}) {
    super()
    this.opts = opts
    this.classifier = new RoleClassifier(opts.roles ?? DEFAULT_ROLES)
    this.nvsmiOk = opts.nvidiaSmi !== false
  }

  /** Resolves once the collector has reported the adapters. */
  async start(): Promise<void> {
    if (this.child) throw new Error('probe already started')
    this.t0 = Date.now()
    const interval = this.opts.intervalSec ?? 1
    const cmd = this.opts.collectorCommand ?? {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        COLLECTOR_PATH,
        '-IntervalSec',
        String(interval),
        '-MinProcMB',
        String(this.opts.minProcMB ?? 1),
      ],
    }
    const child = spawn(cmd.command, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => this.emit('collector-stderr', d))
    const ready = new Promise<void>((ok, fail) => {
      this.once('adapters', () => ok())
      child.once('error', fail)
      child.once('exit', (code) => fail(new Error(`collector exited before reporting adapters (code ${code})`)))
    })
    child.once('exit', (code) => this.emit('exit', code))
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => this.onLine(line))
    await ready
  }

  latest(): Sample | null {
    return this.samples[this.samples.length - 1] ?? null
  }

  mark(label: string): Mark {
    const t = Date.now()
    const m: Mark = { t, elapsed_s: round1((t - this.t0) / 1000), label }
    this.marks.push(m)
    this.write({ type: 'mark', ...m })
    this.emit('mark', m)
    return m
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          done()
        })
        killTree(child)
      })
    }
    await this.chain
    await closeStream(this.jsonl)
    await closeStream(this.csv)
    this.jsonl = this.csv = null
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private write(rec: LogRecord): void {
    this.jsonl?.write(JSON.stringify(rec) + '\n')
  }

  private adapterName(luid: string): string {
    return this.adapters.find((a) => a.luid === luid)?.name ?? luid
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    switch (msg.type) {
      case 'adapters':
        this.onAdapters(msg.adapters as AdapterInfo[], Number(msg.interval_s) || 1)
        break
      case 'proc': {
        const cmd = typeof msg.cmd === 'string' ? msg.cmd.slice(0, 400) : undefined
        this.classifier.setProc({
          pid: Number(msg.pid),
          ppid: msg.ppid === undefined ? undefined : Number(msg.ppid),
          name: typeof msg.name === 'string' ? msg.name : undefined,
          cmd,
          gone: msg.gone === true,
        })
        this.write({ type: 'proc', pid: Number(msg.pid), name: msg.name as string | undefined, cmd })
        break
      }
      case 'sample': {
        const raw: RawSample = {
          t: Number(msg.t),
          adapters: (msg.adapters ?? {}) as Record<string, number>,
          procs: (msg.procs ?? []) as RawSample['procs'],
        }
        this.chain = this.chain
          .then(() => this.finishSample(raw))
          .catch((e) => {
            // 'probe-error', not 'error': an unhandled 'error' event would throw
            this.emit('probe-error', e)
          })
        break
      }
    }
  }

  private onAdapters(adapters: AdapterInfo[], intervalS: number): void {
    this.adapters = adapters.map((a) => ({ ...a, luid: a.luid.toLowerCase() }))
    this.target = pickTarget(this.adapters, this.opts.luid)
    this.csvRoles = [...Object.keys(this.classifier.roles), 'other']
    if (this.opts.outDir) {
      const dir = resolve(this.opts.outDir)
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
      const base = join(dir, `${this.opts.label ?? 'vram'}-${stamp}`)
      this.files = { jsonl: `${base}.jsonl`, csv: `${base}.csv` }
      this.jsonl = createWriteStream(this.files.jsonl, { encoding: 'utf8' })
      this.csv = createWriteStream(this.files.csv, { encoding: 'utf8' })
      this.csv.write(['elapsed_s', 'target_mb', 'nvsmi_mb', ...this.csvRoles, 'other_gpus_mb'].join(',') + '\n')
    }
    const meta: MetaRecord = {
      type: 'meta',
      started_at: new Date(this.t0).toISOString(),
      label: this.opts.label ?? 'vram',
      interval_s: intervalS,
      adapters: this.adapters,
      target: this.target,
      roles: this.classifier.roles,
    }
    this.write(meta)
    this.emit('adapters', this.adapters, this.target)
  }

  private async finishSample(raw: RawSample): Promise<void> {
    const nvsmi = this.nvsmiOk ? await readNvidiaSmi() : null
    if (this.nvsmiOk && nvsmi === null) this.nvsmiOk = false
    const target = this.target

    const roles: Record<string, number> = {}
    for (const r of this.csvRoles) roles[r] = 0
    const procs: ProcEntry[] = []
    const off: Sample['roles_off_target'] = {}
    for (const p of raw.procs) {
      const role = this.classifier.classify(p.pid)
      const name = this.classifier.proc(p.pid)?.name
      if (target && p.luid === target.luid) {
        roles[role] = (roles[role] ?? 0) + p.mb
        procs.push({ pid: p.pid, role, mb: p.mb, ...(name ? { name } : {}) })
      } else if (role !== 'other') {
        const ad = this.adapterName(p.luid)
        const bucket = (off[ad] ??= {})
        bucket[role] = round1((bucket[role] ?? 0) + p.mb)
      }
    }
    for (const k of Object.keys(roles)) roles[k] = round1(roles[k] ?? 0)
    procs.sort((a, b) => b.mb - a.mb)

    const others: Record<string, number> = {}
    for (const [luid, mb] of Object.entries(raw.adapters)) {
      if (!target || luid !== target.luid) others[this.adapterName(luid)] = mb
    }

    const sample: Sample = {
      t: raw.t,
      elapsed_s: round1((raw.t - this.t0) / 1000),
      target_mb: target ? (raw.adapters[target.luid] ?? 0) : 0,
      nvsmi_mb: nvsmi,
      other_gpus_mb: others,
      roles,
      procs,
      roles_off_target: off,
    }
    this.samples.push(sample)
    const cap = this.opts.maxSamples ?? 86400
    if (this.samples.length > cap) this.samples.splice(0, this.samples.length - cap)
    this.write({ type: 'sample', ...sample })
    this.csv?.write(
      [
        sample.elapsed_s,
        sample.target_mb,
        sample.nvsmi_mb ?? '',
        ...this.csvRoles.map((r) => roles[r] ?? 0),
        round1(Object.values(others).reduce((a, b) => a + b, 0)),
      ].join(',') + '\n'
    )
    this.emit('sample', sample)
  }
}
