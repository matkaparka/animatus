import { describe, expect, it } from 'vitest'
import {
  InboxConfigSchema,
  Pacer,
  type PacerState,
  type WaitReason,
} from '../../src/inbox/index.ts'
import { SEC, chat, gift, pacerSetup, state } from './helpers.ts'

type H = ReturnType<typeof pacerSetup>

/** Move the shared clock to `t` and ask the pacer what to do with the brain in `st`. */
function at(h: H, t: number, st: PacerState = state()) {
  h.clock.set(t)
  return h.pacer.decide(st, t)
}

const wait = (reason: WaitReason) => ({ action: 'wait', reason })
const sleeping = state({ sleeping: true })

describe('idle settling', () => {
  it('sends only after the brain has been idle for idleSettleSec without a break', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'alice', 'hello there')
    expect(at(h, T)).toEqual(wait('settling'))
    expect(at(h, T + 1499)).toEqual(wait('settling'))
    const d = at(h, T + 1500)
    expect(d).toMatchObject({
      action: 'send',
      text: '【弹幕】alice：hello there',
      sleepReply: false,
    })
    if (d.action !== 'send') throw new Error('expected a send')
    expect(d.batch.text).toBe(d.text)
    expect(d.batch.parts).toEqual([
      { prio: 4, kind: 'danmaku', text: '【弹幕】alice：hello there', uid: 1, uname: 'alice' },
    ])
  })

  it('says "empty" once settled with nothing to send', () => {
    const h = pacerSetup()
    const T = h.clock.t
    expect(at(h, T)).toEqual(wait('settling'))
    expect(at(h, T + 1500)).toEqual(wait('empty'))
    expect(at(h, T + 5000)).toEqual(wait('empty'))
  })

  it('any sign of busyness restarts the settling time', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'alice', 'hello there')
    expect(at(h, T)).toEqual(wait('settling'))
    expect(at(h, T + 1000, state({ speaking: true }))).toEqual(wait('busy'))
    expect(h.pacer.snapshot().idleSince).toBeNull()
    expect(at(h, T + 1100)).toEqual(wait('settling')) // the count starts again here
    expect(at(h, T + 2599)).toEqual(wait('settling'))
    expect(at(h, T + 2600)).toMatchObject({ action: 'send' })
  })

  const busyKinds: [string, Partial<PacerState>][] = [
    ['speaking', { speaking: true }],
    ['processing a reply', { processing: true }],
    ['dancing', { dancing: true }],
    ['singing', { singing: true }],
    ['messages queued in the brain', { queued: 2 }],
  ]
  for (const [name, over] of busyKinds) {
    it(`${name} counts as busy`, () => {
      const h = pacerSetup()
      const T = h.clock.t
      chat(h, 1, 'alice', 'hello there')
      expect(at(h, T, state(over))).toEqual(wait('busy'))
      expect(at(h, T + 10_000, state(over))).toEqual(wait('busy'))
    })
  }

  it('follows the configured settling time', () => {
    const h = pacerSetup({ pacer: { idleSettleSec: 4 } })
    const T = h.clock.t
    chat(h, 1, 'alice', 'hello there')
    expect(at(h, T)).toEqual(wait('settling'))
    expect(at(h, T + 3999)).toEqual(wait('settling'))
    expect(at(h, T + 4000)).toMatchObject({ action: 'send' })
  })
})

describe('after a send', () => {
  it('waits for the brain to show it is busy, but not longer than busyTimeoutSec', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'alice', 'first message')
    at(h, T)
    expect(at(h, T + 1500)).toMatchObject({ action: 'send', text: '【弹幕】alice：first message' })
    expect(h.pacer.snapshot()).toMatchObject({
      waitingBusy: true,
      sentAt: T + 1500,
      idleSince: null,
    })
    chat(h, 2, 'bob', 'second message')

    expect(at(h, T + 2000)).toEqual(wait('waiting_busy')) // idle, but the last batch has not been picked up
    expect(at(h, T + 21_500)).toEqual(wait('waiting_busy')) // exactly 20 s after the send: still waiting
    expect(h.pacer.snapshot().waitingBusy).toBe(true)
    expect(at(h, T + 21_501)).toEqual(wait('waiting_busy')) // this call gives up waiting
    expect(h.pacer.snapshot().waitingBusy).toBe(false)
    expect(at(h, T + 21_600)).toEqual(wait('settling')) // and only now does the idle count begin
    expect(at(h, T + 23_099)).toEqual(wait('settling'))
    expect(at(h, T + 23_100)).toMatchObject({ action: 'send', text: '【弹幕】bob：second message' })
  })

  it('a busy brain ends the wait at once', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'alice', 'first message')
    at(h, T)
    at(h, T + 1500) // sent
    chat(h, 2, 'bob', 'second message')
    expect(at(h, T + 2000, state({ speaking: true }))).toEqual(wait('waiting_busy'))
    expect(h.pacer.snapshot().waitingBusy).toBe(false)
    expect(at(h, T + 2500, state({ speaking: true }))).toEqual(wait('busy'))
    expect(at(h, T + 3000)).toEqual(wait('settling'))
    expect(at(h, T + 4499)).toEqual(wait('settling'))
    expect(at(h, T + 4500)).toMatchObject({ action: 'send', text: '【弹幕】bob：second message' })
  })

  it('follows the configured timeout', () => {
    const h = pacerSetup({ pacer: { busyTimeoutSec: 3 } })
    const T = h.clock.t
    chat(h, 1, 'alice', 'first message')
    at(h, T)
    at(h, T + 1500) // sent
    expect(at(h, T + 4500)).toEqual(wait('waiting_busy'))
    expect(h.pacer.snapshot().waitingBusy).toBe(true)
    expect(at(h, T + 4501)).toEqual(wait('waiting_busy'))
    expect(h.pacer.snapshot().waitingBusy).toBe(false)
  })

  it('keeps at least minIntervalSec between sends', () => {
    const h = pacerSetup({ pacer: { idleSettleSec: 0, minIntervalSec: 5 } })
    const T = h.clock.t
    chat(h, 1, 'alice', 'first message')
    expect(at(h, T)).toMatchObject({ action: 'send' }) // no settling and no earlier send
    chat(h, 2, 'bob', 'second message')
    expect(at(h, T + 500, state({ speaking: true }))).toEqual(wait('waiting_busy'))
    expect(at(h, T + 1000)).toEqual(wait('min_interval'))
    expect(at(h, T + 4999)).toEqual(wait('min_interval'))
    expect(at(h, T + 5000)).toMatchObject({ action: 'send', text: '【弹幕】bob：second message' })
  })

  it('a send that comes after the settling time is not held up by the minimum interval', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'alice', 'first message')
    at(h, T)
    at(h, T + 1500) // sent
    at(h, T + 1600, state({ speaking: true }))
    chat(h, 2, 'bob', 'second message')
    at(h, T + 3000) // idle again: settling begins
    expect(at(h, T + 4500)).toMatchObject({ action: 'send' })
  })

  it('markSent starts the same wait for messages sent by other means', () => {
    const h = pacerSetup()
    const T = h.clock.t
    h.pacer.markSent(T)
    expect(h.pacer.snapshot()).toMatchObject({ waitingBusy: true, sentAt: T, idleSince: null })
    chat(h, 1, 'alice', 'hello there')
    expect(at(h, T + 500)).toEqual(wait('waiting_busy'))
    expect(at(h, T + 20_001)).toEqual(wait('waiting_busy'))
    expect(h.pacer.snapshot().waitingBusy).toBe(false)
  })

  it('markSent can re-stamp a send that took a while to deliver', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'alice', 'hello there')
    at(h, T)
    at(h, T + 1500) // send
    h.pacer.markSent(T + 6500)
    expect(at(h, T + 26_500)).toEqual(wait('waiting_busy'))
    expect(h.pacer.snapshot().waitingBusy).toBe(true) // 20 s after the re-stamp, not after the decision
  })

  it('markSent with sleepReply also starts the reply cooldown', () => {
    const h = pacerSetup()
    const T = h.clock.t
    at(h, T, sleeping) // enter sleep mode
    h.pacer.markSent(T + 40_000, { sleepReply: true })
    expect(h.pacer.snapshot().lastSleepReply).toBe(T + 40_000)
  })
})

describe('not connected', () => {
  it('sends nothing, whatever is queued', () => {
    const h = pacerSetup()
    const T = h.clock.t
    h.router.onSuperChat({ uid: 3, uname: 'carol', price: 30, msg: 'thanks' })
    expect(at(h, T, state({ connected: false }))).toEqual(wait('disconnected'))
    expect(at(h, T + 3_600_000, state({ connected: false }))).toEqual(wait('disconnected'))
    expect(h.router.stats().queued[0]).toBe(1)
  })

  it('restarts the idle count', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'alice', 'hello there')
    expect(at(h, T)).toEqual(wait('settling'))
    expect(at(h, T + 1000, state({ connected: false }))).toEqual(wait('disconnected'))
    expect(h.pacer.snapshot().idleSince).toBeNull()
    expect(at(h, T + 1100)).toEqual(wait('settling'))
    expect(at(h, T + 2599)).toEqual(wait('settling'))
    expect(at(h, T + 2600)).toMatchObject({ action: 'send' })
  })

  it('keeps a pending wait for the brain to become busy, as the legacy loop did', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'alice', 'hello there')
    at(h, T)
    at(h, T + 1500) // sent
    at(h, T + 2000, state({ connected: false }))
    expect(h.pacer.snapshot().waitingBusy).toBe(true)
    expect(at(h, T + 2500)).toEqual(wait('waiting_busy'))
  })

  it('does not pass the singing flag on to the router', () => {
    const h = pacerSetup()
    const T = h.clock.t
    at(h, T, state({ singing: true }))
    expect(h.router.singing).toBe(true)
    at(h, T + 1000, state({ connected: false, singing: false }))
    expect(h.router.singing).toBe(true) // unchanged
    at(h, T + 2000, state({ singing: false }))
    expect(h.router.singing).toBe(false)
  })
})

describe('singing', () => {
  it('is passed to the router, which remembers when it was last seen', () => {
    const h = pacerSetup()
    const T = h.clock.t
    expect(at(h, T, state({ singing: true }))).toEqual(wait('busy'))
    expect(h.router.singing).toBe(true)
    expect(h.router.singingSeenAt).toBe(T)
    expect(at(h, T + 1000, state({ singing: false }))).toEqual(wait('settling'))
    expect(h.router.singing).toBe(false)
    expect(h.router.singingSeenAt).toBe(T)
  })

  it('chat that queued up during a song is sent afterwards; chat that waited out ordinary speech expires', () => {
    const song = pacerSetup()
    const T = song.clock.t
    chat(song, 1, 'alice', 'hello there')
    for (let s = 10; s <= 60; s += 10) at(song, T + s * SEC, state({ singing: true }))
    expect(at(song, T + 61 * SEC)).toEqual(wait('settling'))
    expect(at(song, T + 62_500)).toMatchObject({
      action: 'send',
      text: '【弹幕】alice：hello there',
    })

    const talk = pacerSetup()
    chat(talk, 1, 'alice', 'hello there')
    for (let s = 10; s <= 60; s += 10) at(talk, T + s * SEC, state({ speaking: true }))
    expect(at(talk, T + 61 * SEC)).toEqual(wait('settling'))
    expect(at(talk, T + 62_500)).toEqual(wait('empty'))
    expect(talk.reasons()).toEqual(['expired'])
  })
})

describe('sleep mode', () => {
  it('replies to one chat message per interval: the first after firstReplyAfterSec, then every replyIntervalSec', () => {
    const h = pacerSetup()
    const T = h.clock.t
    expect(at(h, T, sleeping)).toEqual(wait('sleep_cooldown')) // enters sleep mode
    h.clock.set(T + 5 * SEC)
    chat(h, 1, 'mia', 'good night')
    expect(at(h, T + 29_999, sleeping)).toEqual(wait('sleep_cooldown'))
    const first = at(h, T + 30_000, sleeping)
    expect(first).toMatchObject({
      action: 'send',
      text: '【助眠】mia：good night',
      sleepReply: true,
    })
    if (first.action !== 'send') throw new Error('expected a send')
    expect(first.batch.parts).toEqual([
      { prio: 4, kind: 'sleep', text: '【助眠】mia：good night', uid: 1, uname: 'mia' },
    ])
    expect(h.pacer.snapshot()).toMatchObject({
      waitingBusy: true,
      sentAt: T + 30_000,
      lastSleepReply: T + 30_000,
    })

    expect(at(h, T + 31_000, sleeping)).toEqual(wait('waiting_busy'))
    expect(at(h, T + 31_500, state({ sleeping: true, speaking: true }))).toEqual(
      wait('waiting_busy')
    )
    expect(at(h, T + 32_000, state({ sleeping: true, speaking: true }))).toEqual(wait('busy'))
    expect(at(h, T + 35_000, sleeping)).toEqual(wait('sleep_cooldown'))

    h.clock.set(T + 40 * SEC)
    chat(h, 2, 'noah', 'sleep well')
    expect(at(h, T + 119_999, sleeping)).toEqual(wait('sleep_cooldown'))
    expect(at(h, T + 120_000, sleeping)).toMatchObject({
      action: 'send',
      text: '【助眠】noah：sleep well',
      sleepReply: true,
    })
  })

  it('an empty poll does not use up the interval: a message that arrives later is answered at once', () => {
    const h = pacerSetup()
    const T = h.clock.t
    at(h, T, sleeping)
    expect(at(h, T + 30_000, sleeping)).toEqual(wait('sleep_empty'))
    expect(at(h, T + 44_000, sleeping)).toEqual(wait('sleep_empty'))
    h.clock.set(T + 45_000)
    chat(h, 1, 'mia', 'good night')
    expect(at(h, T + 45_000, sleeping)).toMatchObject({
      action: 'send',
      text: '【助眠】mia：good night',
    })
  })

  it('answers the newest message and lets older ones wait for the next interval', () => {
    const h = pacerSetup()
    const T = h.clock.t
    at(h, T, sleeping)
    chat(h, 1, 'mia', 'first message')
    h.clock.set(T + 1000)
    chat(h, 2, 'noah', 'second message')
    expect(at(h, T + 30_000, sleeping)).toMatchObject({ text: '【助眠】noah：second message' })
    at(h, T + 31_000, state({ sleeping: true, speaking: true })) // the brain starts working on it
    expect(at(h, T + 120_000, sleeping)).toMatchObject({ text: '【助眠】mia：first message' })
  })

  it('lets chat wait maxAgeSec (180 s), not the usual 30 s', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'mia', 'good night')
    at(h, T, sleeping)
    expect(at(h, T + 179_000, sleeping)).toMatchObject({
      action: 'send',
      text: '【助眠】mia：good night',
    })

    const late = pacerSetup()
    chat(late, 1, 'mia', 'good night')
    at(late, T, sleeping)
    expect(at(late, T + 181_000, sleeping)).toEqual(wait('sleep_empty'))
    expect(late.reasons()).toEqual(['expired'])
  })

  it('sends nothing but sleep replies; everything else waits for the mode to end', () => {
    const h = pacerSetup()
    const T = h.clock.t
    h.router.onSuperChat({ uid: 3, uname: 'carol', price: 30, msg: 'thanks' })
    for (const s of [0, 30, 60, 120, 200]) {
      expect(at(h, T + s * SEC, sleeping)).toEqual(wait(s === 0 ? 'sleep_cooldown' : 'sleep_empty'))
    }
    expect(h.router.stats().queued[0]).toBe(1)
    expect(at(h, T + 201 * SEC)).toEqual(wait('settling')) // sleep mode is over
    expect(at(h, T + 201 * SEC + 1500)).toMatchObject({
      action: 'send',
      text: '【SC ¥30】carol：thanks',
      sleepReply: false,
    })
  })

  it('does nothing when sleep replies are switched off, even with chat waiting', () => {
    const h = pacerSetup({ sleep: { enabled: false } })
    const T = h.clock.t
    chat(h, 1, 'mia', 'good night')
    for (const s of [0, 30, 120, 3600]) {
      expect(at(h, T + s * SEC, sleeping)).toEqual(wait('sleep_disabled'))
    }
    expect(h.router.stats().queued[4]).toBe(1)
  })

  it('entering sleep mode again restarts the first-reply delay', () => {
    const h = pacerSetup()
    const T = h.clock.t
    at(h, T, sleeping) // first time
    expect(at(h, T + 11_000)).toEqual(wait('settling')) // awake again
    expect(at(h, T + 100_000, sleeping)).toEqual(wait('sleep_cooldown')) // second time: 30 s from here
    h.clock.set(T + 100_000)
    chat(h, 1, 'mia', 'good night')
    expect(at(h, T + 129_999, sleeping)).toEqual(wait('sleep_cooldown'))
    expect(at(h, T + 130_000, sleeping)).toMatchObject({ action: 'send' })
  })

  it('a busy brain is busy in sleep mode too', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'mia', 'good night')
    expect(at(h, T, state({ sleeping: true, speaking: true }))).toEqual(wait('busy'))
    expect(at(h, T + 60_000, state({ sleeping: true, dancing: true }))).toEqual(wait('busy'))
  })

  it('handles a first reply that is set later than the interval', () => {
    const h = pacerSetup({ sleep: { firstReplyAfterSec: 120, replyIntervalSec: 90 } })
    const T = h.clock.t
    chat(h, 1, 'mia', 'good night')
    expect(at(h, T, sleeping)).toEqual(wait('sleep_cooldown'))
    expect(at(h, T + 119_999, sleeping)).toEqual(wait('sleep_cooldown'))
    expect(at(h, T + 120_000, sleeping)).toMatchObject({ action: 'send' })
  })

  it('a zero first-reply delay answers straight away', () => {
    const h = pacerSetup({ sleep: { firstReplyAfterSec: 0, replyIntervalSec: 10 } })
    const T = h.clock.t
    chat(h, 1, 'mia', 'good night')
    expect(at(h, T, sleeping)).toMatchObject({ action: 'send', text: '【助眠】mia：good night' })
  })

  it('the interval follows the configuration', () => {
    const h = pacerSetup({ sleep: { firstReplyAfterSec: 0, replyIntervalSec: 10 } })
    const T = h.clock.t
    chat(h, 1, 'mia', 'good night')
    at(h, T, sleeping) // sent
    h.clock.set(T + 1000)
    chat(h, 2, 'noah', 'sleep well')
    at(h, T + 1000, state({ sleeping: true, speaking: true }))
    expect(at(h, T + 9999, sleeping)).toEqual(wait('sleep_cooldown'))
    expect(at(h, T + 10_000, sleeping)).toMatchObject({
      action: 'send',
      text: '【助眠】noah：sleep well',
    })
  })
})

describe('the contract with the caller', () => {
  it('does not tick the router: gift windows only close when the caller ticks', () => {
    const h = pacerSetup()
    const T = h.clock.t
    gift(h, 1, 'alice', 'rose', 1, 20_000)
    at(h, T)
    expect(at(h, T + 10 * SEC)).toEqual(wait('empty')) // ten seconds later, but nobody ticked
    h.router.tick()
    expect(at(h, T + 10_500)).toMatchObject({
      action: 'send',
      text: '【礼物】alice 送了 1 个 rose',
    })
  })

  it('works when the clock starts at zero', () => {
    const h = pacerSetup({}, [], 0)
    chat(h, 1, 'alice', 'hello there')
    expect(at(h, 0)).toEqual(wait('settling'))
    expect(h.pacer.snapshot().idleSince).toBe(0)
    expect(at(h, 1499)).toEqual(wait('settling'))
    expect(at(h, 1500)).toMatchObject({ action: 'send', text: '【弹幕】alice：hello there' })

    const s = pacerSetup({}, [], 0)
    chat(s, 1, 'mia', 'good night')
    expect(at(s, 0, sleeping)).toEqual(wait('sleep_cooldown'))
    expect(at(s, 29_999, sleeping)).toEqual(wait('sleep_cooldown'))
    expect(at(s, 30_000, sleeping)).toMatchObject({ action: 'send' })
  })

  it('a send answer names the batch and its parts, so the caller can attach a source to each line', () => {
    const h = pacerSetup()
    const T = h.clock.t
    chat(h, 1, 'alice', 'hello there')
    h.router.onGift({
      uid: 2,
      uname: 'bob',
      gift: 'pebble',
      num: 10,
      coinType: 'gold',
      totalCoin: 1000,
    })
    h.clock.set(T + 10 * SEC)
    h.router.tick()
    at(h, T + 10 * SEC)
    const d = at(h, T + 10 * SEC + 1500)
    if (d.action !== 'send') throw new Error('expected a send')
    expect(d.text).toBe('【弹幕】alice：hello there\n【礼物】bob 送了 10 个 pebble')
    expect(d.batch.parts.map((p) => [p.kind, p.uid, p.uname])).toEqual([
      ['danmaku', 1, 'alice'],
      ['gift', 2, 'bob'],
    ])
  })

  it('reads only the pacer and sleep sections, so a whole inbox configuration can be passed', () => {
    const h = pacerSetup()
    const whole = InboxConfigSchema.parse({ pacer: { idleSettleSec: 4 }, filter: { maxMerge: 2 } })
    const pacer = new Pacer(h.router, whole)
    chat(h, 1, 'alice', 'hello there')
    const T = h.clock.t
    h.clock.set(T)
    expect(pacer.decide(state(), T)).toEqual(wait('settling'))
    expect(pacer.decide(state(), T + 3999)).toEqual(wait('settling'))
    expect(pacer.decide(state(), T + 4000)).toMatchObject({ action: 'send' })
  })

  it('rejects unknown settings loudly', () => {
    const h = pacerSetup()
    expect(() => new Pacer(h.router, { pacer: { idleSettle: 1 } } as never)).toThrow()
    expect(() => new Pacer(h.router, { sleep: { enabled: 'yes' } } as never)).toThrow()
  })

  it('starts with a clean snapshot', () => {
    const h = pacerSetup()
    expect(h.pacer.snapshot()).toEqual({
      waitingBusy: false,
      sentAt: -Infinity,
      idleSince: null,
      sleeping: false,
      lastSleepReply: -Infinity,
    })
  })
})
