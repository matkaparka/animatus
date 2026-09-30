/**
 * What the game agent reported and has not been spoken about yet, and what the model is shown as background.
 *
 * The agent labels each event `immediate` (a death, a war: say something now), `soon` (a turn finished: say something at the
 * next quiet moment) or `later` (only context). Three rules keep the character from talking through a feed:
 *
 *  - `immediate` events are all kept, each one is worth its own mention;
 *  - a newer `soon` event of the same kind replaces an older one nobody has spoken about (say the latest turn, not all of
 *    them); events of different kinds (a turn, a chat line, a fight) do not replace each other;
 *  - `later` events are never spoken about, they are notes: the newest few go into the prompt.
 *
 * Pure: no clock (times are handed in), no I/O.
 */
import type { WorkerUrgency } from '@animatus/protocol'

/** One thing that happened in the game, as the mode keeps it. */
export interface GameEvent {
  /** Counts up over the whole run of the mode; the worker's own numbers start again after a restart. */
  no: number
  /** A short word for what kind of thing it is, already cleaned. */
  kind: string
  /** Already cleaned: one line, safe to put in a prompt. */
  text: string
  urgency: WorkerUrgency
  /** When the mode read it, by the mode's own clock: the worker's clock is not the mode's, and a comment that waited is judged by how long the mode has known. */
  seenAt: number
}

/** The most events one comment lists; the rest are counted, not listed. */
export const MAX_EVENTS_PER_COMMENT = 6
/** The most events kept while they wait: a worker that floods keeps its newest. */
const MAX_WAITING = 20

export interface DigestOptions {
  /** How many `later` events are kept as notes. */
  notesKept: number
  /** Events that waited longer than this are only notes. */
  staleMs: number
}

/** What a comment is going to be about. */
export interface Due {
  /** Immediate ones first, then the `soon` ones, oldest first within each. At most `MAX_EVENTS_PER_COMMENT`. */
  events: GameEvent[]
  /** Due but not listed because of the limit. */
  omitted: number
  /** Every event this look at the waiting ones took into account, for `done`: a later arrival is not among them. */
  taken: GameEvent[]
}

export class Digest {
  private immediate: GameEvent[] = []
  private soon = new Map<string, GameEvent>()
  private notes: GameEvent[] = []
  private restart = false

  constructor(private readonly o: DigestOptions) {}

  /** A new event, in the order the agent reported them. */
  add(e: GameEvent): void {
    if (e.urgency === 'immediate') {
      this.immediate.push(e)
      if (this.immediate.length > MAX_WAITING)
        this.immediate.splice(0, this.immediate.length - MAX_WAITING)
    } else if (e.urgency === 'soon') {
      // delete first so the newest is also the last in line
      this.soon.delete(e.kind)
      this.soon.set(e.kind, e)
      while (this.soon.size > MAX_WAITING) this.soon.delete(this.soon.keys().next().value as string)
    } else this.note(e)
  }

  private note(e: GameEvent): void {
    if (this.o.notesKept <= 0) return
    this.notes.push(e)
    if (this.notes.length > this.o.notesKept)
      this.notes.splice(0, this.notes.length - this.o.notesKept)
  }

  /**
   * Events that waited too long are not worth a comment any more: they become notes (the model may still be asked about
   * them). Returns how many.
   */
  dropStale(now: number): number {
    const stale = (e: GameEvent) => now - e.seenAt > this.o.staleMs
    const old = [...this.immediate, ...this.soon.values()].filter(stale).sort((a, b) => a.no - b.no)
    if (old.length === 0) return 0
    this.immediate = this.immediate.filter((e) => !stale(e))
    for (const [kind, e] of [...this.soon]) if (stale(e)) this.soon.delete(kind)
    for (const e of old) this.note(e)
    return old.length
  }

  /** What is worth a comment now. `soonOk` says whether the gap since the last comment has passed. */
  due(soonOk: boolean): Due {
    const soon = soonOk ? [...this.soon.values()] : []
    const imm = this.immediate.slice(-MAX_EVENTS_PER_COMMENT)
    const room = MAX_EVENTS_PER_COMMENT - imm.length
    const listed = [...imm, ...(room > 0 ? soon.slice(-room) : [])]
    const taken = [...this.immediate, ...soon]
    return { events: listed, omitted: taken.length - listed.length, taken }
  }

  /** The comment was made: what it took into account is not waiting any more. */
  done(taken: readonly GameEvent[]): void {
    const gone = new Set(taken.map((e) => e.no))
    this.immediate = this.immediate.filter((e) => !gone.has(e.no))
    for (const [kind, e] of [...this.soon]) if (gone.has(e.no)) this.soon.delete(kind)
  }

  waiting(): { immediate: number; soon: number } {
    return { immediate: this.immediate.length, soon: this.soon.size }
  }

  /** The background notes, oldest first. */
  background(): readonly GameEvent[] {
    return this.notes
  }

  /** The agent was restarted: what was known about the old run is gone, and the next comment says so. */
  reset(): void {
    this.immediate = []
    this.soon.clear()
    this.notes = []
    this.restart = true
  }

  /** The operator made the agent forget: the notes go, what is still to be said stays. */
  forget(): void {
    this.notes = []
  }

  /** The restart still has to be told (a comment about the game agent being restarted is due even if nothing else is). */
  get restarted(): boolean {
    return this.restart
  }

  /** Takes the restart notice to put in a comment; `keepRestart` puts it back when that comment did not happen. */
  takeRestart(): boolean {
    const was = this.restart
    this.restart = false
    return was
  }

  keepRestart(): void {
    this.restart = true
  }
}
