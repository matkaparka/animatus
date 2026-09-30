/**
 * A worker that lives in the test's own process (`MemoryWorker`), for the game tests that run under fake timers: sockets need
 * real time, this does not. It follows the same rules as the reference fake over HTTP (`../workers/fakes.ts`, one contract
 * test in game-fakes.test.ts checks that they agree), and can be made to fail in the ways a worker fails: not there, slow,
 * answering nonsense, refusing.
 */
import { WorkerState } from '@animatus/protocol'
import type { WorkerEvent, WorkerEventsResponse, WorkerFacts } from '@animatus/protocol'
import { WorkerError } from '../../src/workers/index.ts'
import type { WorkerApi } from '../../src/workers/index.ts'

export type Fault =
  | { kind: 'unreachable' }
  | { kind: 'hang' }
  | { kind: 'garbage' }
  /** An answer with a status and, if it has one to say, its words. */
  | { kind: 'refuse'; status: 400 | 409 | 503; message?: string }

export class MemoryWorker {
  worker = 'fakegame'
  epoch = 'epoch-aaaaaaaa'
  online = true
  paused = true
  thinking = false
  executing: string | null = null
  givenUp = false
  summary = 'nothing has happened yet'
  facts: WorkerFacts = {}
  events: WorkerEvent[] = []
  directives: string[] = []
  lastCommand: { text: string; at: number } | null = null
  forgets = 0
  /** A worker that answers "still paused" to a resume (it is not able to play, or it lies). */
  stuckPaused = false
  /** Every call that reached it, as `state`, `events`, `command`, `pause:true`, `forget`. */
  calls: string[] = []
  /**
   * Set to make calls fail: every call fails this way, or the function decides per call (`state`, `pause:false`, ...) and
   * answers null for the ones that work. Null for a healthy worker.
   */
  fault: Fault | ((call: string) => Fault | null) | null = null
  private epochs = 0

  push(kind: string, text: string, urgency: WorkerEvent['urgency'] = 'later'): void {
    this.events.push({
      seq: (this.events.at(-1)?.seq ?? 0) + 1,
      at: Date.now(),
      kind,
      text,
      urgency,
    })
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300)
  }

  /** A restart: a new epoch, the numbers begin again, and the worker is paused. */
  restart(): void {
    this.epoch = `epoch-restart-${++this.epochs}`
    this.events = []
    this.paused = true
    this.directives = []
    this.lastCommand = null
  }

  count(prefix: string): number {
    return this.calls.filter((c) => c === prefix || c.startsWith(`${prefix}:`)).length
  }

  private latest = () => this.events.at(-1)?.seq ?? 0

  /**
   * A client with a time limit, like the real one: a hung worker is a timeout after `timeoutMs` (of whatever clock the test
   * runs on). `expect` is the worker the caller believes it is talking to, as for `WorkerClient`.
   */
  client(timeoutMs = 5000, expect?: string): WorkerApi {
    const call = <T>(what: string, answer: () => T): Promise<T> => {
      this.calls.push(what)
      const f = typeof this.fault === 'function' ? this.fault(what) : this.fault
      if (f?.kind === 'hang')
        return new Promise<T>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new WorkerError(
                  'timeout',
                  `the worker did not answer ${what} within ${timeoutMs} ms`
                )
              ),
            timeoutMs
          )
        })
      if (f?.kind === 'unreachable')
        return Promise.reject(
          new WorkerError('unreachable', 'cannot reach the worker (connect ECONNREFUSED)')
        )
      if (f?.kind === 'garbage')
        return Promise.reject(
          new WorkerError('bad_response', `the answer to ${what} is not JSON`, 200)
        )
      if (f?.kind === 'refuse')
        return Promise.reject(
          new WorkerError(
            f.status === 409 ? 'not_online' : f.status === 400 ? 'bad_request' : 'refused',
            f.message ?? 'refused for a test',
            f.status
          )
        )
      try {
        return Promise.resolve(answer())
      } catch (e) {
        return Promise.reject(e)
      }
    }
    return {
      kind: 'worker',
      state: () =>
        call('state', () => {
          if (expect !== undefined && this.worker !== expect)
            throw new WorkerError(
              'wrong_worker',
              `this is the worker "${this.worker}", not "${expect}"`
            )
          return WorkerState.parse({
            protocol: 1,
            worker: this.worker,
            epoch: this.epoch,
            online: this.online,
            paused: this.paused,
            planner: {
              thinking: this.thinking,
              executing: this.executing,
              pending: 0,
              given_up: this.givenUp,
            },
            last_command: this.lastCommand,
            latest_seq: this.latest(),
            summary: this.summary,
            facts: this.facts,
          })
        }),
      events: (after, epoch) =>
        call('events', (): WorkerEventsResponse => {
          const reset = (epoch !== null && epoch !== this.epoch) || (epoch === null && after > 0)
          const from = reset ? 0 : after
          const all = this.events.filter((e) => e.seq > from)
          const page = all.slice(0, 50)
          return {
            epoch: this.epoch,
            latest: this.latest(),
            reset,
            events: page,
            more: all.length > page.length,
          }
        }),
      command: (text) => {
        // the real client checks the length before anything is sent, so no call reaches the worker
        const t = text.trim()
        if (t === '' || t.length > 300)
          return Promise.reject(
            new WorkerError('bad_request', 'a directive is 1 to 300 characters')
          )
        return call(`command:${t}`, () => {
          if (!this.online) throw new WorkerError('not_online', 'the game is not connected', 409)
          this.lastCommand = { text: t, at: Date.now() }
          this.directives.push(t)
          this.push('command', `directive: ${t}`, 'later')
        }).then(() => undefined)
      },
      pause: (paused) =>
        call(`pause:${paused}`, () => {
          this.paused = paused || this.stuckPaused
          return this.paused
        }),
      forget: () =>
        call('forget', () => {
          this.forgets++
          this.directives = []
          this.lastCommand = null
        }).then(() => undefined),
      trace: () => call('trace', () => [{ step: 1 }, { step: 2 }]),
    }
  }
}
