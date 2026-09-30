/**
 * The mode manager: the only thing that enters and leaves modes.
 *
 * It replaces booleans scattered over half a dozen places in the legacy page. Each mode is
 * IDLE -> STARTING (start its services, run its controller) -> ACTIVE -> STOPPING (run the controller's exit,
 * release services nothing else needs, wait for GPU memory to fall back) -> IDLE. A step that takes too long
 * returns the mode to IDLE and raises an alarm; a mode never stays half-entered.
 *
 * Rules are data in the manifests (`exclusive_with`, `priority`, `preempts`) plus the admission matrix; there
 * is no mode-specific code here. Calls are serialised, so two triggers arriving together cannot interleave.
 */
import { EventEmitter } from 'node:events'
import type { ModeManifest, ModeState } from '@animatus/protocol'
import type { Matrix, Verdict } from './admission.ts'

/** What a mode does once its services are up. Implemented per mode (dance, sing, sleep, ...). */
export interface ModeController {
  enter(ctx: ModeContext): Promise<void>
  exit(ctx: ModeContext, reason: string): Promise<void>
}

export interface ModeContext {
  id: string
  manifest: ModeManifest
  /** Aborted when the mode is being torn down or a step timed out; controllers must stop promptly. */
  signal: AbortSignal
  log: Log
}

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void

export interface ModeManagerDeps {
  manifests: ModeManifest[]
  controllers: Record<string, ModeController>
  /** Start (if needed) and wait until these services are ready. Rejects if one cannot be. */
  ensureServices(names: string[], signal: AbortSignal): Promise<void>
  /** Stop these services (already checked: not resident, not needed by another active mode). */
  releaseServices(names: string[]): Promise<void>
  /** Services that stay up regardless of modes. */
  resident: string[]
  /** Current admission matrix (recomputed by the caller when settings change). */
  matrix(): Matrix
  /** Current GPU memory in use on the budget card (MiB), or null if unknown. */
  vramNow?(): number | null
  /** Marks for the VRAM probe: `enter:<id>` / `exit:<id>`. */
  mark?(label: string): void
  startTimeoutMs?: number
  stopTimeoutMs?: number
  /** After exit, memory must be within this many MiB of the level before entering (default 400). */
  settleToleranceMb?: number
  settleTimeoutMs?: number
  log?: Log
}

export type EnterRefusal =
  | { ok: false; code: 'unknown_mode' | 'no_controller' }
  | { ok: false; code: 'blocked'; blockedBy: string; reason: string }
  | { ok: false; code: 'excluded'; conflicts: string[]; reason: string }
  | { ok: false; code: 'no_fit'; reasons: string[] }
  | { ok: false; code: 'failed'; reason: string }
export type EnterResult = { ok: true; already?: boolean } | EnterRefusal

export type ManagerEvents = {
  state: [id: string, state: ModeState, previous: ModeState]
  alarm: [code: string, message: string, id?: string]
}

interface Slot {
  state: ModeState
  since: number
  baselineMb: number | null
  ctl?: AbortController
  neededServices: string[]
}

const DEFAULTS = {
  startTimeoutMs: 120_000,
  stopTimeoutMs: 60_000,
  settleToleranceMb: 400,
  settleTimeoutMs: 20_000,
}

export class ModeManager extends EventEmitter<ManagerEvents> {
  private readonly d: ModeManagerDeps & typeof DEFAULTS
  private readonly slots = new Map<string, Slot>()
  private readonly manifests = new Map<string, ModeManifest>()
  private chain: Promise<unknown> = Promise.resolve()
  private readonly log: Log

  constructor(deps: ModeManagerDeps) {
    super()
    this.d = { ...DEFAULTS, ...deps }
    this.log = deps.log ?? (() => {})
    for (const m of deps.manifests) {
      this.manifests.set(m.id, m)
      this.slots.set(m.id, {
        state: 'IDLE',
        since: Date.now(),
        baselineMb: null,
        neededServices: [],
      })
    }
  }

  state(id: string): ModeState {
    return this.slots.get(id)?.state ?? 'IDLE'
  }

  /** Modes that are ACTIVE or on their way (STARTING). */
  active(): string[] {
    return [...this.slots]
      .filter(([, s]) => s.state === 'ACTIVE' || s.state === 'STARTING')
      .map(([id]) => id)
  }

  snapshot(): { id: string; state: ModeState; since: number }[] {
    return [...this.slots].map(([id, s]) => ({ id, state: s.state, since: s.since }))
  }

  enter(id: string, opts: { replace?: boolean; force?: boolean } = {}): Promise<EnterResult> {
    return this.serial(() => this.doEnter(id, opts))
  }

  exit(id: string, reason = 'requested'): Promise<void> {
    return this.serial(() => this.doExit(id, reason))
  }

  /** Leave every active mode (shutdown, or a hard stop). */
  async exitAll(reason = 'shutdown'): Promise<void> {
    for (const id of this.active()) await this.exit(id, reason)
  }

  // ─────────────────────────────── enter ───────────────────────────────

  private async doEnter(
    id: string,
    opts: { replace?: boolean; force?: boolean }
  ): Promise<EnterResult> {
    const m = this.manifests.get(id)
    if (!m) return { ok: false, code: 'unknown_mode' }
    if (!this.d.controllers[id]) return { ok: false, code: 'no_controller' }
    const slot = this.slots.get(id) as Slot
    if (slot.state === 'ACTIVE') return { ok: true, already: true }

    const others = this.active().filter((x) => x !== id)

    // A preempting mode (sleep) interrupts everything else; while one is active nothing else may enter.
    if (m.preempts) {
      for (const o of others) await this.doExit(o, `preempted by ${id}`)
    } else {
      const blocker = others.find((o) => this.manifests.get(o)?.preempts)
      if (blocker && !opts.force) {
        return {
          ok: false,
          code: 'blocked',
          blockedBy: blocker,
          reason: `${blocker} is active and blocks other modes`,
        }
      }
      const conflicts = others.filter(
        (o) => m.exclusive_with.includes(o) || this.manifests.get(o)?.exclusive_with.includes(id)
      )
      if (conflicts.length && !opts.force) {
        if (!opts.replace) {
          return {
            ok: false,
            code: 'excluded',
            conflicts,
            reason: `${id} excludes ${conflicts.join(', ')} (active)`,
          }
        }
        for (const c of conflicts) await this.doExit(c, `replaced by ${id}`)
      }
    }

    if (!opts.force) {
      const mx = this.d.matrix()
      const remaining = this.active().filter((x) => x !== id)
      const bad: Verdict[] = []
      const alone = mx.alone[id]
      if (alone && !alone.ok) bad.push(alone)
      for (const o of remaining) {
        const pair = mx.pairs[id]?.[o]
        if (pair && !pair.ok) bad.push(pair)
      }
      if (bad.length) return { ok: false, code: 'no_fit', reasons: bad.flatMap((v) => v.reasons) }
    }

    return this.start(id, m, slot)
  }

  private async start(id: string, m: ModeManifest, slot: Slot): Promise<EnterResult> {
    const ctl = new AbortController()
    slot.ctl = ctl
    slot.baselineMb = this.d.vramNow?.() ?? null
    this.setState(id, slot, 'STARTING')
    this.d.mark?.(`enter:${id}`)
    const need = m.requires.services.filter((s) => !this.d.resident.includes(s))
    slot.neededServices = need
    const ctx: ModeContext = { id, manifest: m, signal: ctl.signal, log: this.log }
    const controller = this.d.controllers[id] as ModeController
    try {
      await this.withTimeout(
        (async () => {
          await this.d.ensureServices(m.requires.services, ctl.signal)
          await controller.enter(ctx)
        })(),
        this.d.startTimeoutMs,
        ctl,
        `entering ${id}`
      )
    } catch (e) {
      const message = (e as Error).message
      this.log('error', `mode ${id} failed to start: ${message}`)
      this.emit('alarm', 'mode_start_failed', `mode ${id} failed to start: ${message}`, id)
      await this.teardown(id, slot, `start failed: ${message}`, false)
      return { ok: false, code: 'failed', reason: message }
    }
    if (ctl.signal.aborted) {
      await this.teardown(id, slot, 'aborted while starting', false)
      return { ok: false, code: 'failed', reason: 'aborted while starting' }
    }
    this.setState(id, slot, 'ACTIVE')
    return { ok: true }
  }

  // ─────────────────────────────── exit ───────────────────────────────

  private async doExit(id: string, reason: string): Promise<void> {
    const slot = this.slots.get(id)
    if (!slot || slot.state === 'IDLE') return
    await this.teardown(id, slot, reason, true)
  }

  private async teardown(id: string, slot: Slot, reason: string, runExit: boolean): Promise<void> {
    const m = this.manifests.get(id) as ModeManifest
    slot.ctl?.abort()
    this.setState(id, slot, 'STOPPING')
    const ctl = new AbortController()
    const ctx: ModeContext = { id, manifest: m, signal: ctl.signal, log: this.log }
    try {
      await this.withTimeout(
        (async () => {
          if (runExit) await (this.d.controllers[id] as ModeController).exit(ctx, reason)
          const stillNeeded = new Set(
            this.active()
              .filter((x) => x !== id)
              .flatMap((x) => this.manifests.get(x)?.requires.services ?? [])
          )
          const release = slot.neededServices.filter((s) => !stillNeeded.has(s))
          if (release.length) await this.d.releaseServices(release)
          await this.waitSettle(slot, id)
        })(),
        this.d.stopTimeoutMs,
        ctl,
        `leaving ${id}`
      )
    } catch (e) {
      const message = (e as Error).message
      this.log('error', `mode ${id} did not stop cleanly: ${message}`)
      this.emit('alarm', 'mode_stop_failed', `mode ${id} did not stop cleanly: ${message}`, id)
    }
    this.d.mark?.(`exit:${id}`)
    slot.ctl = undefined
    slot.neededServices = []
    this.setState(id, slot, 'IDLE')
  }

  /** Wait for GPU memory to fall back near where it was before the mode started. */
  private async waitSettle(slot: Slot, id: string): Promise<void> {
    const now = this.d.vramNow
    if (!now || slot.baselineMb === null) return
    const limit = slot.baselineMb + this.d.settleToleranceMb
    const deadline = Date.now() + this.d.settleTimeoutMs
    const poll = Math.min(250, Math.max(10, this.d.settleTimeoutMs / 8))
    for (;;) {
      const v = now()
      if (v === null || v <= limit) return
      if (Date.now() >= deadline) {
        this.emit(
          'alarm',
          'vram_not_released',
          `after leaving ${id}, GPU memory is ${Math.round(v)} MiB, above the ${Math.round(slot.baselineMb)} MiB it was before (+${this.d.settleToleranceMb} tolerance)`,
          id
        )
        return
      }
      await new Promise((r) => setTimeout(r, poll))
    }
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private setState(id: string, slot: Slot, next: ModeState): void {
    const prev = slot.state
    if (prev === next) return
    slot.state = next
    slot.since = Date.now()
    this.log('info', `mode ${id}: ${prev} -> ${next}`)
    this.emit('state', id, next, prev)
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async withTimeout<T>(
    p: Promise<T>,
    ms: number,
    ctl: AbortController,
    what: string
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        ctl.abort()
        rej(new Error(`timed out ${what} after ${ms} ms`))
      }, ms)
    })
    try {
      return await Promise.race([p, timeout])
    } finally {
      clearTimeout(timer)
      p.catch(() => undefined) // a late failure of the abandoned step must not become an unhandled rejection
    }
  }
}
