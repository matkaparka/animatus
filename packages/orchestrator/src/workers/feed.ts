/**
 * Reading a worker's events without losing or repeating any: the cursor, the epoch, the pages, the restart.
 *
 * A reader holds the epoch of the run it has read and the last `seq` it has seen. Asking the worker with both, it gets
 * what is new; if the worker was restarted in the meantime (another epoch), the answer says `reset` and starts from the
 * beginning of the new run, and the reader forgets its cursor. That is the whole point of the epoch: the older agents began
 * their numbers again at 1 after a restart, and a reader that had seen 200 events skipped the first 200 of the new run.
 */
import type { WorkerEvent, WorkerState } from '@animatus/protocol'
import type { WorkerApi } from './client.ts'

const MAX_PAGES_PER_POLL = 20

export interface Polled {
  /** Oldest first. After a `reset`, only the new run's events. */
  events: WorkerEvent[]
  /** The worker restarted since the last poll: what the reader knew about the game may be wrong. */
  reset: boolean
  epoch: string
}

export class WorkerFeed {
  private epoch: string | null = null
  private cursor = 0

  constructor(private readonly api: WorkerApi) {}

  /** Start from what the worker has now: what happened before is not news (the mode has just been entered). */
  startFrom(state: WorkerState): void {
    this.epoch = state.epoch
    this.cursor = state.latest_seq
  }

  /** Forget everything: the next poll reads from the beginning of whatever run there is. */
  clear(): void {
    this.epoch = null
    this.cursor = 0
  }

  get position(): { epoch: string | null; cursor: number } {
    return { epoch: this.epoch, cursor: this.cursor }
  }

  /** What is new since the last call. Throws what the worker's client throws (a `WorkerError`). */
  async poll(): Promise<Polled> {
    let events: WorkerEvent[] = []
    let reset = false
    for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
      const r = await this.api.events(this.cursor, this.epoch)
      if (r.reset) {
        // another run: what was read of the old one is void, and so is the cursor
        reset = true
        events = []
        this.cursor = 0
      }
      this.epoch = r.epoch
      for (const e of r.events) {
        if (e.seq <= this.cursor) continue // a repeat: the cursor is the reader's, not the worker's
        events.push(e)
        this.cursor = e.seq
      }
      if (!r.more || r.events.length === 0) break
    }
    return { events, reset, epoch: this.epoch as string }
  }
}
