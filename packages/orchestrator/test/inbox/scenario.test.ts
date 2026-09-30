import { describe, expect, it } from 'vitest'
import {
  FORMATS,
  type BatchPart,
  type InboxConfigInput,
  type PacerState,
} from '../../src/inbox/index.ts'
import { chat, gift, pacerSetup } from './helpers.ts'

// Scripted sessions over simulated time. A fake brain answers every send with half a second of
// "processing" and three seconds of "speaking"; the loop ticks every half second, like the legacy sender.
// The expected timelines were worked out by hand from the rules of the legacy bridge, not recorded from
// this implementation.

const T0 = 1_000_000
const STEP = 500

type Rig = ReturnType<typeof pacerSetup>

class FakeBrain {
  processingUntil = -Infinity
  speakingUntil = -Infinity
  dancing: [number, number][] = []
  sleeping: [number, number][] = []

  receive(now: number): void {
    this.processingUntil = now + 500
    this.speakingUntil = this.processingUntil + 3000
  }

  state(now: number): PacerState {
    const within = (spans: [number, number][]) => spans.some(([a, b]) => now >= a && now < b)
    return {
      connected: true,
      processing: now < this.processingUntil,
      speaking: now >= this.processingUntil && now < this.speakingUntil,
      dancing: within(this.dancing),
      singing: false,
      sleeping: within(this.sleeping),
      queued: 0,
    }
  }
}

interface Sent {
  /** Milliseconds after the start of the session. */
  t: number
  text: string
  sleepReply: boolean
  parts: BatchPart[]
}

/** Run a session: events are `[ms after start, action]`, applied before each tick. */
function session(opts: {
  config?: InboxConfigInput
  until: number
  brain?: FakeBrain
  events?: [number, (h: Rig) => void][]
}) {
  const h: Rig = pacerSetup(opts.config ?? {}, [], T0)
  const brain = opts.brain ?? new FakeBrain()
  const events = opts.events ?? []
  const sent: Sent[] = []
  for (let t = 0; t <= opts.until; t += STEP) {
    h.clock.set(T0 + t)
    for (const [at, act] of events) if (at === t) act(h)
    h.router.tick()
    const d = h.pacer.decide(brain.state(t), T0 + t) // the brain thinks in session time, the pacer in clock time
    if (d.action === 'send') {
      brain.receive(t)
      sent.push({ t, text: d.text, sleepReply: d.sleepReply, parts: d.batch.parts })
    }
  }
  return { h, sent, brain }
}

describe('a live session', () => {
  const brain = new FakeBrain()
  brain.dancing = [[30_000, 60_000]] // the streamer dances from 30 s to 60 s
  const { h, sent } = session({
    until: 70_000,
    brain,
    events: [
      [0, (r) => chat(r, 1, 'alice', 'hello everyone')],
      [500, (r) => chat(r, 2, 'bob', 'nice model')],
      [1000, (r) => gift(r, 3, 'carol', 'rocket', 1, 20_000)], // 20 yuan: a big gift
      [1500, (r) => r.router.onSuperChat({ uid: 4, uname: 'dave', price: 30, msg: 'keep it up' })],
      [2000, (r) => chat(r, 5, 'erin', 'what game is this')],
      [
        2000,
        (r) => r.router.addSongLine(FORMATS.songQueued('frank', 'Song A', ['Artist'], 1, true)),
      ],
      [3000, (r) => chat(r, 1, 'alice', 'hello everyone')], // repeated: dropped
      [3500, (r) => chat(r, 9, 'zed', 'x')], // too short: dropped
      [7000, (r) => gift(r, 6, 'lena', 'pebble', 3, 300)], // small: never adds up in this session
      [17_000, (r) => r.router.onGuard({ uid: 7, uname: 'frank', level: 3, num: 3 })],
      [17_500, (r) => chat(r, 8, 'heidi', 'lol nice')],
      [31_000, (r) => chat(r, 10, 'judy', 'first to arrive')], // arrives while dancing, waits too long
      [59_000, (r) => chat(r, 11, 'kate', 'see you next time')],
    ],
  })

  it('sends batches in priority order, each only when the brain is free', () => {
    expect(sent.map((s) => [s.t, s.text])).toEqual([
      // 1.5 s: idle long enough; the paid message outranks the chat that has been waiting since 0 s
      [1500, '【SC ¥30】dave：keep it up'],
      // brain busy until 5 s, idle from 5 s, settled at 6.5 s; the song result outranks the big gift and chat
      [6500, '【点歌】frank 点了《Song A》（Artist），排在第 1 首，已经准备好了'],
      // the big gift's window closed at 11 s
      [11_500, '【礼物】carol 送了 1 个 rocket'],
      // now the three waiting chat lines, merged
      [
        16_500,
        '【弹幕】alice：hello everyone\n【弹幕】bob：nice model\n【弹幕】erin：what game is this',
      ],
      // a guard purchase (queued at 17 s) outranks the chat that arrived at 17.5 s
      [21_500, '【上舰】frank 开通了舰长（3个月）'],
      [26_500, '【弹幕】heidi：lol nice'],
      // dancing from 30 s to 60 s: nothing is sent; judy's message (31 s) is too old by 61.5 s, kate's is not
      [61_500, '【弹幕】kate：see you next time'],
    ])
  })

  it('reports what it dropped, in order', () => {
    expect(h.drops).toEqual([
      { reason: 'duplicate', info: { uid: 1, uname: 'alice', text: 'hello everyone' } },
      { reason: 'too_short', info: { uid: 9, uname: 'zed', text: 'x' } },
      { reason: 'expired', info: { prio: 4, text: '【弹幕】judy：first to arrive' } },
    ])
  })

  it('hands the brain the sender of every line', () => {
    const merged = sent.find((s) => s.t === 16_500)
    expect(merged?.parts.map((p) => [p.kind, p.uid, p.uname])).toEqual([
      ['danmaku', 1, 'alice'],
      ['danmaku', 2, 'bob'],
      ['danmaku', 5, 'erin'],
    ])
    expect(sent.find((s) => s.t === 1500)?.parts).toEqual([
      { prio: 0, kind: 'superchat', text: '【SC ¥30】dave：keep it up', uid: 4, uname: 'dave' },
    ])
    expect(sent.find((s) => s.t === 6500)?.parts).toEqual([
      {
        prio: 5,
        kind: 'song',
        text: '【点歌】frank 点了《Song A》（Artist），排在第 1 首，已经准备好了',
      },
    ])
    expect(sent.every((s) => !s.sleepReply)).toBe(true)
  })

  it('leaves the small gift waiting and everything else drained', () => {
    expect(h.router.stats()).toEqual({
      queued: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      smallReady: 0,
      smallAccumulating: 1,
      giftWindows: 0,
      danceWindows: 0,
      recentTexts: 6, // the six accepted chat texts; none is old enough to have been swept
    })
  })
})

describe('a sleep session', () => {
  const brain = new FakeBrain()
  brain.sleeping = [[0, 200_000]]
  const { sent } = session({
    until: 210_000,
    brain,
    events: [
      [5000, (r) => chat(r, 1, 'mia', 'good night')],
      [40_000, (r) => chat(r, 2, 'noah', 'sleep well')],
      [
        50_000,
        (r) =>
          r.router.onSuperChat({ uid: 3, uname: 'carol', price: 30, msg: 'thanks for the stream' }),
      ],
      [100_000, (r) => gift(r, 4, 'dave', 'rocket', 1, 20_000)],
    ],
  })

  it('whispers back at most one chat message per interval and holds everything else until waking up', () => {
    expect(sent.map((s) => [s.t, s.text, s.sleepReply])).toEqual([
      // entered sleep mode at 0 s: the first reply comes 30 s later
      [30_000, '【助眠】mia：good night', true],
      // the next one 90 s after that; noah's message waited 80 s, well inside the 180 s limit
      [120_000, '【助眠】noah：sleep well', true],
      // awake at 200 s: the paid message and the big gift that were held back, in priority order
      [201_500, '【SC ¥30】carol：thanks for the stream', false],
      [206_500, '【礼物】dave 送了 1 个 rocket', false],
    ])
  })
})

describe('a quiet room', () => {
  it('speaks up every three minutes of silence when cold starts are enabled, counting the whole silence', () => {
    const { sent } = session({ config: { cold: { enabled: true, minutes: 3 } }, until: 600_000 })
    expect(sent.map((s) => [s.t, s.text])).toEqual([
      [180_000, '【冷场】已经3分钟没有人发弹幕了'],
      [360_000, '【冷场】已经6分钟没有人发弹幕了'],
      [540_000, '【冷场】已经9分钟没有人发弹幕了'],
    ])
    expect(sent[0]?.parts).toEqual([
      { prio: 4, kind: 'cold', text: '【冷场】已经3分钟没有人发弹幕了' },
    ])
  })

  it('stays silent when cold starts are off', () => {
    const { sent } = session({ until: 600_000 })
    expect(sent).toEqual([])
  })

  it('a message resets the silence', () => {
    const { sent } = session({
      config: { cold: { enabled: true, minutes: 3 } },
      until: 600_000,
      events: [[100_000, (r) => chat(r, 1, 'alice', 'anyone here')]],
    })
    expect(sent.map((s) => [s.t, s.text])).toEqual([
      // the brain has been idle for ages, so the message goes out in the very step it arrives
      [100_000, '【弹幕】alice：anyone here'],
      [280_000, '【冷场】已经3分钟没有人发弹幕了'], // 3 minutes after the message
      [460_000, '【冷场】已经6分钟没有人发弹幕了'],
    ])
  })
})

describe('bursts', () => {
  it('a crowd arriving at once is served in merged batches of three, oldest first, one per speech', () => {
    const { sent, h } = session({
      until: 30_000,
      events: [
        [
          0,
          (r) => {
            for (let i = 1; i <= 8; i++)
              chat(r, i, `viewer${i}`, `message number ${i} in the burst`)
          },
        ],
      ],
    })
    // 1.5 s: idle long enough; each later batch waits for the brain to finish speaking and settle
    expect(sent.map((s) => s.t)).toEqual([1500, 6500, 11_500])
    expect(sent.map((s) => s.parts.length)).toEqual([3, 3, 2])
    expect(sent[0]?.text.split('\n')[0]).toBe('【弹幕】viewer1：message number 1 in the burst')
    expect(sent[2]?.text.split('\n')).toEqual([
      '【弹幕】viewer7：message number 7 in the burst',
      '【弹幕】viewer8：message number 8 in the burst',
    ])
    expect(h.drops).toEqual([])
  })
})
