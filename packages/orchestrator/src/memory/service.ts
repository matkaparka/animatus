/**
 * The memory service: what the rest of the program sees of memory.
 *
 * - `recall` gives the brain the lines to put in the prompt of the next reply;
 * - `record` puts what happens during the stream (a chat message that got through the filters, a gift, someone
 *   joining) into the inbox, and `note...` keeps the facts that need no model (someone asked for a song);
 * - `chatCommand` answers the viewer who writes "forget me": their file, and every trace of it in the history, is gone;
 * - `consolidate` runs the pass that turns the inbox into lines of memory, now or every so many hours.
 *
 * Nothing here is allowed to break a reply: recall and recording never throw, and a failing consolidation is an
 * alarm, not a crash.
 */
import type { ChatCommandInput } from '../inbox/types.ts'
import { consolidate } from './consolidate.ts'
import type { ConsolidateOptions, ConsolidateReport, LlmText } from './consolidate.ts'
import { cleanFactText } from './lines.ts'
import { Recall } from './recall.ts'
import type { RecallOptions, Speaker } from './recall.ts'
import { MemoryStore } from './store.ts'
import type { StoreOptions } from './store.ts'

/** What a viewer writes to be forgotten. */
const FORGET = /^(?:请)?(?:忘记我|忘了我|忘掉我)[吧啦呀!！。.~～]*$/

export interface MemoryServiceOptions {
  store: Pick<StoreOptions, 'root' | 'commitDelayMs' | 'watch'>
  recall?: RecallOptions
  llmText: LlmText
  isSensitive?: ConsolidateOptions['isSensitive']
  /** Called with a line the model should say something about (someone was forgotten). */
  tell?: (text: string) => void
  /** Alarms: raised on a failure, cleared when it works again. */
  alarm?: (code: string, message: string) => void
  clearAlarm?: (code: string) => void
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void
  now?: () => number
  /** Run the consolidation every this many hours; 0 for only when asked. Default 0. */
  consolidateEveryHours?: number
  /** Events kept per day in the inbox; further ones are dropped. Default 5000. */
  inboxDailyCap?: number
  consolidate?: Pick<
    ConsolidateOptions,
    'maxViewers' | 'maxMessages' | 'minMessages' | 'maxFacts' | 'searchCacheDays' | 'streamNotes'
  >
}

export interface MemoryStatus {
  enabled: true
  root: string
  git: boolean
  files: number
  facts: number
  inboxEvents: number
  proposals: number
  recall: { p50: number; p95: number; n: number } | null
  consolidation: { at: number; report: ConsolidateReport } | null
  consolidating: boolean
}

export class MemoryService {
  readonly store: MemoryStore
  readonly recallIndex: Recall
  private readonly o: MemoryServiceOptions
  private readonly now: () => number
  private readonly log: NonNullable<MemoryServiceOptions['log']>
  private timer: NodeJS.Timeout | null = null
  private running: Promise<ConsolidateReport> | null = null
  private last: { at: number; report: ConsolidateReport } | null = null
  private inboxToday = { day: '', n: 0 }

  constructor(o: MemoryServiceOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    this.log = o.log ?? (() => {})
    this.store = new MemoryStore({
      ...o.store,
      now: this.now,
      log: (level, msg) => this.log(level, `memory: ${msg}`),
    })
    this.recallIndex = new Recall(this.store, { ...o.recall, now: this.now })
  }

  async start(): Promise<void> {
    await this.store.init()
    if (!(await this.store.git.available()))
      this.o.alarm?.(
        'memory_no_git',
        'git is not installed: memory works, but there is no history and no rollback'
      )
    const hours = this.o.consolidateEveryHours ?? 0
    if (hours > 0) {
      this.timer = setInterval(
        () => void this.consolidate().catch(() => undefined),
        hours * 3_600_000
      )
      this.timer.unref?.()
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running?.catch(() => undefined)
    await this.store.dispose()
  }

  // ─────────────────────────────── for the brain ───────────────────────────────

  /** The lines for the prompt of the next reply. Never throws. */
  recall(text: string, speakers: readonly Speaker[]): string[] {
    try {
      return this.recallIndex.lookup({ text, speakers }).lines
    } catch (e) {
      this.log('warn', `memory: recall failed: ${(e as Error).message}`)
      return []
    }
  }

  // ─────────────────────────────── recording ───────────────────────────────

  /** One raw event of the stream, for the next consolidation. Dropped silently past the daily cap. */
  record(event: {
    kind: 'chat' | 'gift' | 'guard' | 'superchat'
    uid?: number
    name?: string
    text?: string
  }): void {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    if (this.inboxToday.day !== day) this.inboxToday = { day, n: 0 }
    if (this.inboxToday.n >= (this.o.inboxDailyCap ?? 5000)) return
    this.inboxToday.n++
    void this.store
      .appendInbox({
        kind: event.kind,
        ...(event.uid !== undefined ? { uid: event.uid } : {}),
        ...(event.name !== undefined ? { name: cleanFactText(event.name, 40) } : {}),
        ...(event.text !== undefined ? { text: cleanFactText(event.text, 300) } : {}),
      })
      .catch(() => undefined)
  }

  /** A fact that needs no model: the viewer did this (asked for a song, joined the crew). */
  noteViewer(uid: number, name: string, text: string): void {
    const f = this.store.viewerFile(uid, name)
    void this.store
      .append(f.path, { source: 'viewer', text }, { author: 'system', header: f.header })
      .catch(() => undefined)
  }

  // ─────────────────────────────── "forget me" ───────────────────────────────

  /** True when the message was a request to be forgotten (and was taken). */
  chatCommand(cmd: ChatCommandInput): boolean {
    if (!FORGET.test(cmd.text.trim())) return false
    void this.forget(cmd.uid, cmd.uname)
    return true
  }

  private async forget(uid: number, name: string): Promise<void> {
    try {
      const r = await this.store.forgetViewer(uid)
      if (!r.ok) throw new Error(r.message)
      this.log('info', `memory: forgot viewer ${uid}`)
      this.o.tell?.(
        `【系统】${cleanFactText(name, 30)} 要求你忘记他。他的记录（${r.existed ? '有' : '本来就没有'}）已经全部删除，连历史里也没有了。用一句话回应他，不要复述他之前的任何内容。`
      )
    } catch (e) {
      this.o.alarm?.(
        'memory_forget_failed',
        `could not forget viewer ${uid}: ${(e as Error).message.split('\n')[0]}`
      )
    }
  }

  // ─────────────────────────────── consolidation ───────────────────────────────

  /** Run the pass now (one at a time: a second call while one runs waits for it and returns its report). */
  consolidate(): Promise<ConsolidateReport> {
    this.running ??= (async () => {
      try {
        const report = await consolidate({
          store: this.store,
          llmText: this.o.llmText,
          ...(this.o.isSensitive ? { isSensitive: this.o.isSensitive } : {}),
          now: this.now,
          log: (level, msg) => this.log(level, `memory: ${msg}`),
          ...this.o.consolidate,
        })
        this.last = { at: this.now(), report }
        if (report.failures.length > 0)
          this.o.alarm?.(
            'memory_consolidate',
            `consolidation: ${report.failures[0]}${report.failures.length > 1 ? ` (and ${report.failures.length - 1} more)` : ''}`
          )
        else this.o.clearAlarm?.('memory_consolidate')
        return report
      } catch (e) {
        this.o.alarm?.(
          'memory_consolidate',
          `consolidation failed: ${(e as Error).message.split('\n')[0]}`
        )
        throw e
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  async status(): Promise<MemoryStatus> {
    const tree = await this.store.tree()
    const inbox = await this.store.inboxFiles()
    let events = 0
    for (const f of inbox) events += (await this.store.readInbox(f)).length
    return {
      enabled: true,
      root: this.store.root,
      git: await this.store.git.available(),
      files: tree.filter((t) => t.section !== 'inbox' && t.section !== 'proposals').length,
      facts: tree.reduce((n, t) => n + t.facts, 0),
      inboxEvents: events,
      proposals: (await this.store.proposals()).length,
      recall: this.recallIndex.latency(),
      consolidation: this.last,
      consolidating: this.running !== null,
    }
  }
}
