/**
 * Runs the automation rules (see rules.ts and docs/automations.md).
 *
 * The engine knows nothing about the program around it: it is handed what a rule may do (say a line, ask the model,
 * call a tool through the gate, consolidate memory) and is told when something happened. What keeps it safe:
 *
 *  - An event made from what the audience did (a guard purchase, a paid message) makes the model's reply and any tool
 *    call untrusted, whatever the rule says: the name and the words in it are theirs. Events the program itself makes
 *    (a timer, the end of the stream) are the program's own words, and a tool call from them is the system's; a tool
 *    that needs the streamer's yes still waits for it.
 *  - Lines wait for the voice to be free and are dropped, not piled up, when it is not.
 *  - Rules run one at a time, at most ten wait, and all rules together do at most `max_per_minute` things a minute.
 */
import { makeSource } from '@animatus/protocol'
import type { EventSource, ToolTier } from '@animatus/protocol'
import type { GateResult } from '../tools/gate.ts'
import { AUDIENCE_EVENTS, fill } from './rules.ts'
import type { Action, AutomationEventType, AutomationRule, AutomationsConfig } from './rules.ts'

export type AutomationEvent =
  | { type: 'timer'; rule: string }
  | { type: 'cold_start'; minutes: number }
  | { type: 'stream_start' }
  | { type: 'stream_end' }
  | { type: 'guard'; uid: number; name: string; title: string; months: number }
  | { type: 'superchat'; uid: number; name: string; yuan: number; text: string }
  | { type: 'mode_entered'; mode: string }
  | { type: 'mode_exited'; mode: string }

export interface AutomationDeps {
  /** Speak a line, no model. */
  say(text: string): void
  /** Ask the model to answer this. The reply is judged as untrusted unless `fromProgram`. */
  tell(text: string, opts: { fromProgram: boolean }): Promise<unknown>
  tool(req: { tool: string; args: unknown; origin: EventSource }): Promise<GateResult>
  /** Absent when memory is off. */
  consolidate?: () => Promise<unknown>
  /** Resolves true when nothing is being written or said, false after `ms` of trying. */
  whenQuiet(ms: number): Promise<boolean>
  tierOf(tool: string): ToolTier | undefined
  /** A line for the run log. */
  log(text: string): void
  /** Something the operator should look at; one alarm per code and subject. */
  warn(code: string, message: string, subject: string): void
  now(): number
}

const MAX_QUEUED = 10
const AUDIENCE_COOLDOWN_SEC = 30

const varsOf = (e: AutomationEvent): Record<string, string> => {
  switch (e.type) {
    case 'cold_start':
      return { minutes: String(e.minutes) }
    case 'guard':
      return { name: e.name, title: e.title, months: String(e.months) }
    case 'superchat':
      return { name: e.name, yuan: String(e.yuan), text: e.text }
    case 'mode_entered':
    case 'mode_exited':
      return { mode: e.mode }
    default:
      return {}
  }
}

/** The strings inside a value, filled in; other values are kept as they are. */
function fillDeep(value: unknown, vars: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return fill(value, vars)
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, vars))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, vars)]))
  return value
}

const label = (a: Action): string =>
  'say' in a
    ? 'say'
    : 'tell' in a
      ? 'tell'
      : 'tool' in a
        ? `tool ${a.tool.name}`
        : 'consolidate memory'

export class AutomationEngine {
  private readonly rules: AutomationRule[]
  private readonly lastRun = new Map<string, number>()
  private readonly recent: number[] = []
  private timers: NodeJS.Timeout[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private queued = 0
  private stopped = false
  private capWarnedAt = -Infinity

  constructor(
    private readonly cfg: AutomationsConfig,
    private readonly d: AutomationDeps
  ) {
    this.rules = cfg.enabled ? cfg.rules.filter((r) => r.enabled) : []
  }

  /** Whether a rule wants this event (the program may then leave its own handling of it out). */
  has(type: AutomationEventType): boolean {
    return this.rules.some((r) => r.on === type)
  }

  /** Starts the timers and says what can never work. */
  start(): void {
    this.stopped = false
    for (const rule of this.rules) {
      if (rule.on === 'timer' && rule.every_min !== undefined) {
        const t = setInterval(
          () => this.fire({ type: 'timer', rule: rule.id }),
          rule.every_min * 60_000
        )
        t.unref?.()
        this.timers.push(t)
      }
      if (!AUDIENCE_EVENTS.has(rule.on)) continue
      for (const a of rule.do) {
        if (!('tool' in a)) continue
        const tier = this.d.tierOf(a.tool.name)
        if (tier === undefined)
          this.d.warn(
            'automation_tool_unknown',
            `rule "${rule.id}" asks for the tool "${a.tool.name}", which does not exist`,
            rule.id
          )
        else if (tier !== 'free')
          this.d.warn(
            'automation_tool_untrusted',
            `rule "${rule.id}" asks for "${a.tool.name}" after something the audience did, but that tool ` +
              (tier === 'disabled'
                ? 'is switched off'
                : "waits for the streamer's yes, which text from the audience cannot ask for") +
              ': it will always be refused',
            rule.id
          )
      }
    }
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  /** Something happened. Never throws; rules that match are queued. */
  fire(event: AutomationEvent): void {
    if (this.stopped) return
    for (const rule of this.rules) {
      if (rule.on !== event.type) continue
      if (event.type === 'timer' && event.rule !== rule.id) continue
      if (
        (event.type === 'mode_entered' || event.type === 'mode_exited') &&
        rule.mode !== undefined &&
        rule.mode !== event.mode
      )
        continue
      if (event.type === 'superchat' && rule.min_yuan !== undefined && event.yuan < rule.min_yuan)
        continue
      const cooldownMs =
        (rule.cooldown_sec ?? (AUDIENCE_EVENTS.has(event.type) ? AUDIENCE_COOLDOWN_SEC : 0)) * 1000
      const last = this.lastRun.get(rule.id)
      if (cooldownMs > 0 && last !== undefined && this.d.now() - last < cooldownMs) continue
      this.lastRun.set(rule.id, this.d.now())
      if (this.queued >= MAX_QUEUED) {
        this.d.log(`automation ${rule.id}: dropped, ${MAX_QUEUED} rules are already waiting`)
        continue
      }
      this.queued++
      this.chain = this.chain
        .then(() => this.run(rule, event))
        .catch((e: unknown) =>
          this.d.log(`automation ${rule.id}: failed: ${(e as Error).message.split('\n')[0]}`)
        )
        .finally(() => void this.queued--)
    }
  }

  /** Resolves when everything queued so far has run (tests). */
  idle(): Promise<void> {
    return this.chain.then(() => undefined)
  }

  /** One more thing may be done this minute. */
  private allowed(): boolean {
    const t = this.d.now()
    while (this.recent.length > 0 && t - (this.recent[0] as number) >= 60_000) this.recent.shift()
    if (this.recent.length >= this.cfg.max_per_minute) {
      if (t - this.capWarnedAt >= 60_000) {
        this.capWarnedAt = t
        this.d.log(
          `automation: ${this.cfg.max_per_minute} things in a minute is the limit; the rest are dropped`
        )
      }
      return false
    }
    this.recent.push(t)
    return true
  }

  private async run(rule: AutomationRule, event: AutomationEvent): Promise<void> {
    const audience = AUDIENCE_EVENTS.has(event.type)
    const vars = varsOf(event)
    for (const action of rule.do) {
      if (this.stopped) return
      if (!this.allowed()) return
      try {
        if ('say' in action || 'tell' in action) {
          // a line waits for the voice; one that would only pile up behind a busy voice is dropped
          if (!(await this.d.whenQuiet(this.cfg.quiet_wait_sec * 1000))) {
            this.d.log(`automation ${rule.id}: ${label(action)} skipped, the voice was busy`)
            return
          }
          if ('say' in action) {
            const text = fill(action.say, vars)
            this.d.say(text)
            this.d.log(`automation ${rule.id}: said "${text.slice(0, 80)}"`)
          } else {
            const text = fill(action.tell, vars)
            // the model's reply is the program's own words only when nothing in them is the audience's
            await this.d.tell(text, { fromProgram: !audience })
            this.d.log(`automation ${rule.id}: asked the model to answer`)
          }
        } else if ('tool' in action) {
          const origin =
            event.type === 'guard' || event.type === 'superchat'
              ? makeSource('viewer', { uid: String(event.uid), name: event.name })
              : makeSource('system')
          const args = fillDeep(action.tool.args, vars)
          const r = await this.d.tool({ tool: action.tool.name, args, origin })
          const why =
            r.status === 'rejected'
              ? ` (${r.reason})`
              : r.status === 'failed'
                ? ` (${r.error})`
                : ''
          this.d.log(`automation ${rule.id}: tool ${action.tool.name} ${r.status}${why}`)
        } else if (this.d.consolidate) {
          await this.d.consolidate()
          this.d.log(`automation ${rule.id}: memory consolidated`)
        } else {
          this.d.log(`automation ${rule.id}: memory is off, nothing to consolidate`)
        }
      } catch (e) {
        this.d.log(
          `automation ${rule.id}: ${label(action)} failed: ${(e as Error).message.split('\n')[0]}`
        )
      }
    }
  }
}
