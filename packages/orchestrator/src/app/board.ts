/**
 * What the operator sees of a running orchestrator: a rolling event log, per-sentence traces and the
 * list of things that need attention. These are plain in-memory records; the console reads them through
 * its backend and gets live updates through `subscribe`.
 */
import type { Alarm, RunEvent, SpeechTraceView } from '@animatus/protocol'
import type { TraceRecord } from '../speech/director.ts'

type Listener<T> = (value: T) => void

/** Control characters and line breaks would make a log line lie about its shape. */
const oneLine = (text: string, max: number): string => {
  const flat = text
    .replace(/[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export class RunLog {
  private readonly ring: RunEvent[] = []
  private readonly listeners = new Set<Listener<RunEvent>>()

  constructor(
    private readonly capacity = 500,
    private readonly now: () => number = Date.now
  ) {}

  add(kind: RunEvent['kind'], text: string, trust?: RunEvent['trust']): RunEvent {
    const event: RunEvent = {
      ts: this.now(),
      kind,
      text: oneLine(text, 400),
      ...(trust ? { trust } : {}),
    }
    this.ring.push(event)
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity)
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        // a broken listener must not stop the log
      }
    }
    return event
  }

  /** Oldest first. */
  recent(limit: number): RunEvent[] {
    return limit <= 0 ? [] : this.ring.slice(-limit)
  }

  subscribe(fn: Listener<RunEvent>): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
}

/** Sentence traces, updated in place as a sentence moves through synthesis, sending and playback. */
export class TraceBoard {
  private readonly order: string[] = []
  private readonly byId = new Map<string, SpeechTraceView>()
  private readonly listeners = new Set<Listener<SpeechTraceView>>()

  constructor(private readonly capacity = 200) {}

  update(t: TraceRecord): SpeechTraceView {
    const view: SpeechTraceView = {
      id: t.id,
      turn: t.turn,
      text: oneLine(t.text, 400),
      ...(t.audioSec !== undefined ? { audioSec: t.audioSec } : {}),
      ...(t.synthDoneAt !== undefined
        ? { synthMs: Math.max(0, t.synthDoneAt - t.enqueuedAt) }
        : {}),
      ...(t.sentAt !== undefined ? { sendMs: Math.max(0, t.sentAt - t.enqueuedAt) } : {}),
      ...(t.startedAt !== undefined ? { startMs: Math.max(0, t.startedAt - t.enqueuedAt) } : {}),
      ...(t.liveMotion !== undefined ? { liveMotion: t.liveMotion } : {}),
    }
    if (!this.byId.has(t.id)) {
      this.order.push(t.id)
      while (this.order.length > this.capacity) this.byId.delete(this.order.shift() as string)
    }
    this.byId.set(t.id, view)
    for (const fn of this.listeners) {
      try {
        fn(view)
      } catch {
        // see RunLog
      }
    }
    return view
  }

  /** Oldest first. */
  recent(limit: number): SpeechTraceView[] {
    if (limit <= 0) return []
    return this.order
      .slice(-limit)
      .map((id) => this.byId.get(id))
      .filter((v): v is SpeechTraceView => v !== undefined)
  }

  subscribe(fn: Listener<SpeechTraceView>): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
}

/** Things that need attention. One alarm per code and subject: raising it again refreshes it. */
export class AlarmBoard {
  private readonly alarms = new Map<string, Alarm>()
  private readonly listeners = new Set<Listener<Alarm>>()

  constructor(private readonly now: () => number = Date.now) {}

  private static key(code: string, subject?: string): string {
    return subject ? `${code}:${subject}` : code
  }

  raise(code: string, level: Alarm['level'], message: string, subject?: string): Alarm {
    const key = AlarmBoard.key(code, subject)
    const id = key.replace(/[^A-Za-z0-9._:@-]/g, '_').slice(0, 96)
    const alarm: Alarm = {
      id,
      ts: this.now(),
      level,
      code: code.slice(0, 64),
      message: oneLine(message, 600),
      ...(subject ? { subject: subject.slice(0, 64) } : {}),
    }
    this.alarms.set(key, alarm)
    for (const fn of this.listeners) {
      try {
        fn(alarm)
      } catch {
        // see RunLog
      }
    }
    return alarm
  }

  /** The problem went away. */
  clear(code: string, subject?: string): boolean {
    return this.alarms.delete(AlarmBoard.key(code, subject))
  }

  has(code: string, subject?: string): boolean {
    return this.alarms.has(AlarmBoard.key(code, subject))
  }

  /** Newest first. */
  list(): Alarm[] {
    return [...this.alarms.values()].sort((a, b) => b.ts - a.ts)
  }

  subscribe(fn: Listener<Alarm>): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
}
