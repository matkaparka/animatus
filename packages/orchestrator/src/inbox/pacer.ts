/**
 * Pacing: may the next batch go to the brain yet?
 *
 * A port of the decision logic of the legacy bridge's sender loop, as a state machine with no I/O. The
 * caller runs it on a short timer (the legacy loop used half a second): call `router.tick()`, gather
 * the brain's state, call `decide`, and act on the answer.
 *
 * The rules, as the legacy loop applied them:
 *
 * - After a send the pacer waits until the brain shows any sign of being busy, or `busyTimeoutSec` has
 *   passed, before it will consider another. Sending again before the brain's state has caught up would
 *   stack messages.
 * - Normally a batch goes out only after the brain has been idle for `idleSettleSec` without a break (the
 *   gaps between sentences must not count as idle) and at least `minIntervalSec` after the previous send.
 * - Speaking, processing, dancing, singing and a non-empty brain queue all count as busy.
 * - In sleep mode nothing but the sleep reply is sent: one chat message, `firstReplyAfterSec` after the
 *   mode began, then at most once per `replyIntervalSec`.
 * - When the brain is not connected nothing is sent and the idle timer restarts; a pending wait for the
 *   brain to become busy is kept, exactly as before.
 */
import { PacerConfigSchema, SleepConfigSchema } from './types.ts'
import type { Router } from './router.ts'
import type { Batch, InboxConfigInput, PacerConfig, SleepConfig } from './types.ts'

/** What the brain reports about itself; the legacy bridge read the same facts from the page. */
export interface PacerState {
  /** The brain is reachable. When false nothing is sent. */
  connected: boolean
  speaking: boolean
  /** A reply is being generated. */
  processing: boolean
  dancing: boolean
  singing: boolean
  sleeping: boolean
  /** Messages the brain has accepted but not started on. */
  queued: number
}

export type WaitReason =
  | 'disconnected'
  | 'waiting_busy'
  | 'busy'
  | 'sleep_disabled'
  | 'sleep_cooldown'
  | 'sleep_empty'
  | 'settling'
  | 'min_interval'
  | 'empty'

export type PacerDecision =
  /** `text` is `batch.text`; `sleepReply` is true when the batch is a sleep-mode reply. */
  | { action: 'send'; text: string; batch: Batch; sleepReply: boolean }
  | { action: 'wait'; reason: WaitReason }

export interface PacerSnapshot {
  waitingBusy: boolean
  sentAt: number
  idleSince: number | null
  sleeping: boolean
  lastSleepReply: number
}

export class Pacer {
  private readonly router: Router
  private readonly pacer: PacerConfig
  private readonly sleep: SleepConfig
  private waitingBusy = false
  private sentAt = -Infinity
  private idleSince: number | null = null
  private sleeping = false
  private lastSleepReply = -Infinity

  constructor(router: Router, config: Pick<InboxConfigInput, 'pacer' | 'sleep'> = {}) {
    this.router = router
    // Only these two sections are read, so a whole inbox configuration can be passed as is.
    this.pacer = PacerConfigSchema.parse(config.pacer ?? {})
    this.sleep = SleepConfigSchema.parse(config.sleep ?? {})
  }

  /**
   * Decide what to do at time `now` (milliseconds) given the brain's state. Also passes the singing flag
   * on to the router, whose expiry rules depend on it.
   *
   * A `send` answer is recorded as sent at `now`: the wait for the brain to become busy begins and the
   * minimum interval is measured from here. The caller need not (but may) call `markSent` afterwards.
   * The batch has already left the router's queues; if delivery fails it is lost, as it was before.
   */
  decide(state: PacerState, now: number): PacerDecision {
    if (!state.connected) {
      this.idleSince = null
      return { action: 'wait', reason: 'disconnected' }
    }

    this.router.setSinging(state.singing)
    const wasSleeping = this.sleeping
    this.sleeping = state.sleeping
    if (this.sleeping && !wasSleeping) {
      // Just entered sleep mode: the first reply comes firstReplyAfterSec from now.
      this.lastSleepReply =
        now - this.sleep.replyIntervalSec * 1000 + this.sleep.firstReplyAfterSec * 1000
    }

    const busy =
      state.speaking || state.processing || state.dancing || state.singing || state.queued > 0

    if (this.waitingBusy) {
      // Wait for the brain to actually start on the last batch before considering another.
      if (busy || now - this.sentAt > this.pacer.busyTimeoutSec * 1000) this.waitingBusy = false
      return { action: 'wait', reason: 'waiting_busy' }
    }
    if (busy) {
      this.idleSince = null
      return { action: 'wait', reason: 'busy' }
    }

    if (this.sleeping) {
      this.idleSince = null
      if (!this.sleep.enabled) return { action: 'wait', reason: 'sleep_disabled' }
      if (now - this.lastSleepReply < this.sleep.replyIntervalSec * 1000) {
        return { action: 'wait', reason: 'sleep_cooldown' }
      }
      const batch = this.router.pickSleep(this.sleep.maxAgeSec)
      if (batch === null) return { action: 'wait', reason: 'sleep_empty' }
      this.markSent(now, { sleepReply: true })
      return { action: 'send', text: batch.text, batch, sleepReply: true }
    }

    this.idleSince ??= now
    if (now - this.idleSince < this.pacer.idleSettleSec * 1000) {
      return { action: 'wait', reason: 'settling' }
    }
    if (now - this.sentAt < this.pacer.minIntervalSec * 1000) {
      return { action: 'wait', reason: 'min_interval' }
    }
    const batch = this.router.pick()
    if (batch === null) return { action: 'wait', reason: 'empty' }
    this.markSent(now)
    return { action: 'send', text: batch.text, batch, sleepReply: false }
  }

  /**
   * Record that a batch was sent at `now`, starting the wait for the brain to become busy. `decide` does
   * this itself for the batches it returns; call this for messages sent by other means (say, a line the
   * host typed into the console) so that the next batch does not talk over them, and to re-stamp a send
   * that took a while to complete.
   */
  markSent(now: number, options: { sleepReply?: boolean } = {}): void {
    this.sentAt = now
    this.waitingBusy = true
    this.idleSince = null
    if (options.sleepReply) this.lastSleepReply = now
  }

  snapshot(): PacerSnapshot {
    return {
      waitingBusy: this.waitingBusy,
      sentAt: this.sentAt,
      idleSince: this.idleSince,
      sleeping: this.sleeping,
      lastSleepReply: this.lastSleepReply,
    }
  }
}
