import { describe, expect, it } from 'vitest'
import { MIN, SEC, chat, gift, setup, type Harness } from './helpers.ts'

/** Fill every queue: 2 paid messages, 4 guards, 2 dance requests, 4 big gifts, 3 small gifts, 4 song lines, 5 chat. */
function fillEverything(h: Harness): void {
  h.router.onSuperChat({ uid: 1, uname: 'u1', price: 30, msg: 'sc one' })
  h.router.onSuperChat({ uid: 2, uname: 'u2', price: 30, msg: 'sc two' })
  for (let i = 1; i <= 4; i++) h.router.onGuard({ uid: 10 + i, uname: `g${i}`, level: 3, num: 1 })
  gift(h, 21, 'd1', 'star', 1, 0, 'silver')
  gift(h, 22, 'd2', 'star', 1, 0, 'silver')
  for (let i = 1; i <= 4; i++) gift(h, 30 + i, `b${i}`, 'rose', 1, 20_000)
  for (let i = 1; i <= 3; i++) gift(h, 40 + i, `s${i}`, 'pebble', 10, 1000)
  for (let i = 1; i <= 4; i++) h.router.addSongLine(`【点歌】song ${i}`)
  for (let i = 1; i <= 5; i++) chat(h, 50 + i, `c${i}`, `chat number ${i}`)
  h.clock.advance(10 * SEC)
  h.router.tick() // closes the gift and dance windows
}

describe('pick: priority order and merge limits', () => {
  it('serves paid messages, guards, dances, songs, gifts, then chat with small gifts', () => {
    const h = setup({ dance: { gifts: ['star'] } })
    fillEverything(h)
    const texts: (string | null)[] = []
    const batches = []
    for (let i = 0; i < 13; i++) {
      const b = h.router.pick()
      batches.push(b)
      texts.push(b ? b.text : null)
    }
    expect(texts).toEqual([
      // paid messages: one at a time
      '【SC ¥30】u1：sc one',
      '【SC ¥30】u2：sc two',
      // guards: up to three
      '【上舰】g1 开通了舰长\n【上舰】g2 开通了舰长\n【上舰】g3 开通了舰长',
      '【上舰】g4 开通了舰长',
      // dance requests: one at a time
      '【点舞】d1 送了 1 个 star，点名要看你跳舞',
      '【点舞】d2 送了 1 个 star，点名要看你跳舞',
      // song results: up to three, and BEFORE gifts and chat although their number is higher
      '【点歌】song 1\n【点歌】song 2\n【点歌】song 3',
      '【点歌】song 4',
      // big gifts: up to three
      '【礼物】b1 送了 1 个 rose\n【礼物】b2 送了 1 个 rose\n【礼物】b3 送了 1 个 rose',
      '【礼物】b4 送了 1 个 rose',
      // chat: up to three, with up to two flushed small gifts appended
      '【弹幕】c1：chat number 1\n【弹幕】c2：chat number 2\n【弹幕】c3：chat number 3\n【礼物】s1 送了 10 个 pebble\n【礼物】s2 送了 10 个 pebble',
      '【弹幕】c4：chat number 4\n【弹幕】c5：chat number 5\n【礼物】s3 送了 10 个 pebble',
      null,
    ])
    // the text is always the parts' lines joined by a newline
    for (const b of batches) {
      if (b) expect(b.text).toBe(b.parts.map((p) => p.text).join('\n'))
    }
    // the last chat batch shows how the parts are labelled
    expect(batches[10]?.parts.map((p) => [p.kind, p.prio])).toEqual([
      ['danmaku', 4],
      ['danmaku', 4],
      ['danmaku', 4],
      ['gift', 3],
      ['gift', 3],
    ])
    expect(batches[6]?.parts.map((p) => [p.kind, p.prio])).toEqual([
      ['song', 5],
      ['song', 5],
      ['song', 5],
    ])
    expect(batches[4]?.parts[0]).toMatchObject({ kind: 'dance', prio: 2, uid: 21, uname: 'd1' })
  })

  it('a higher-priority arrival jumps ahead of what is already waiting', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    h.router.onGuard({ uid: 2, uname: 'bob', level: 3, num: 1 })
    h.router.onSuperChat({ uid: 3, uname: 'carol', price: 30, msg: 'thanks' })
    expect(h.router.pick()?.text).toBe('【SC ¥30】carol：thanks')
    expect(h.router.pick()?.text).toBe('【上舰】bob 开通了舰长')
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there')
    expect(h.router.pick()).toBeNull()
  })

  it('merges up to maxMerge lines (paid messages and dance requests are always alone)', () => {
    const h = setup({ dance: { gifts: ['star'] }, filter: { maxMerge: 2 } })
    fillEverything(h)
    const sizes: number[] = []
    for (let b = h.router.pick(); b; b = h.router.pick()) sizes.push(b.parts.length)
    // sc, sc, guard 2+2, dance, dance, song 2+2, gift 2+2, chat 2+2+1 each with small gifts (2, 1)
    expect(sizes).toEqual([1, 1, 2, 2, 1, 1, 2, 2, 2, 2, 4, 3, 1])
  })

  it('with maxMerge 1 every batch is a single line', () => {
    const h = setup({ dance: { gifts: ['star'] }, filter: { maxMerge: 1 } })
    for (let i = 1; i <= 3; i++) h.router.onGuard({ uid: i, uname: `g${i}`, level: 3, num: 1 })
    expect(h.router.pick()?.parts).toHaveLength(1)
    expect(h.router.pick()?.parts).toHaveLength(1)
    expect(h.router.pick()?.parts).toHaveLength(1)
    expect(h.router.pick()).toBeNull()
  })

  it('with a large maxMerge a batch takes the whole queue, but paid messages stay single', () => {
    const h = setup({ filter: { maxMerge: 10 } })
    for (let i = 1; i <= 5; i++) h.router.onGuard({ uid: i, uname: `g${i}`, level: 3, num: 1 })
    for (let i = 1; i <= 2; i++)
      h.router.onSuperChat({ uid: i, uname: `u${i}`, price: 30, msg: 'x' })
    expect(h.router.pick()?.parts).toHaveLength(1)
    expect(h.router.pick()?.parts).toHaveLength(1)
    expect(h.router.pick()?.parts).toHaveLength(5)
  })

  it('returns null when there is nothing to say, again and again', () => {
    const h = setup()
    expect(h.router.pick()).toBeNull()
    expect(h.router.pick()).toBeNull()
    expect(h.router.pickSleep(180)).toBeNull()
  })
})

describe('pick: small gifts', () => {
  function withSmallGifts(n: number): Harness {
    const h = setup()
    for (let i = 1; i <= n; i++) gift(h, i, `s${i}`, 'pebble', 10, 1000)
    h.clock.advance(10 * SEC)
    h.router.tick()
    return h
  }

  it('are sent on their own when there is no chat to go with (two at a time)', () => {
    const h = withSmallGifts(3)
    expect(h.router.stats().smallReady).toBe(3)
    expect(h.router.pick()?.text).toBe('【礼物】s1 送了 10 个 pebble\n【礼物】s2 送了 10 个 pebble')
    expect(h.router.pick()?.text).toBe('【礼物】s3 送了 10 个 pebble')
    expect(h.router.pick()).toBeNull()
  })

  it('never delay chat: with chat waiting they ride along after the chat lines', () => {
    const h = withSmallGifts(1)
    chat(h, 9, 'alice', 'hello there')
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there\n【礼物】s1 送了 10 个 pebble')
  })

  it('big gifts are served before chat, and the small ones wait for the chat batch', () => {
    const h = withSmallGifts(1)
    gift(h, 8, 'big', 'rose', 1, 20_000)
    h.clock.advance(10 * SEC)
    h.router.tick()
    chat(h, 9, 'alice', 'hello there')
    expect(h.router.pick()?.text).toBe('【礼物】big 送了 1 个 rose')
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there\n【礼物】s1 送了 10 个 pebble')
  })
})

describe('pick: expiry', () => {
  it('drops chat that has waited longer than danmakuMaxAgeSec, exactly 30 s is still fine', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(30 * SEC)
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there')

    const late = setup()
    chat(late, 1, 'alice', 'hello there')
    late.clock.advance(30 * SEC + 1)
    expect(late.router.pick()).toBeNull()
    expect(late.reasons()).toEqual(['expired'])
    expect(late.drops[0]?.info).toEqual({ prio: 4, text: '【弹幕】alice：hello there' })
  })

  it('expires from the oldest: older lines go, newer ones stay', () => {
    const h = setup()
    chat(h, 1, 'alice', 'first message')
    h.clock.advance(20 * SEC)
    chat(h, 2, 'bob', 'second message')
    h.clock.advance(20 * SEC) // alice's is 40 s old, bob's 20 s
    expect(h.router.pick()?.text).toBe('【弹幕】bob：second message')
    expect(h.reasons()).toEqual(['expired'])
  })

  it('follows the configured limit', () => {
    const h = setup({ filter: { danmakuMaxAgeSec: 5 } })
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(5 * SEC + 1)
    expect(h.router.pick()).toBeNull()
  })

  it('happens on every pick, even when something more important is served', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(31 * SEC)
    h.router.onSuperChat({ uid: 2, uname: 'bob', price: 30, msg: 'thanks' })
    expect(h.router.pick()?.text).toBe('【SC ¥30】bob：thanks')
    expect(h.reasons()).toEqual(['expired'])
    expect(h.router.pick()).toBeNull()
  })

  it('does not apply to paid messages, guards, dances or gifts', () => {
    const h = setup()
    h.router.onSuperChat({ uid: 1, uname: 'a', price: 30, msg: 'x' })
    h.router.onGuard({ uid: 2, uname: 'b', level: 3, num: 1 })
    h.clock.advance(3600 * SEC)
    expect(h.router.pick()?.text).toBe('【SC ¥30】a：x')
    expect(h.router.pick()?.text).toBe('【上舰】b 开通了舰长')
    expect(h.reasons()).toEqual([])
  })

  it('song lines last ackMaxAgeSec (600 s), exactly that is still fine', () => {
    const h = setup()
    h.router.addSongLine('【点歌】alice 点了一首歌')
    h.clock.advance(600 * SEC)
    expect(h.router.pick()?.text).toBe('【点歌】alice 点了一首歌')

    const late = setup()
    late.router.addSongLine('【点歌】alice 点了一首歌')
    late.clock.advance(600 * SEC + 1)
    expect(late.router.pick()).toBeNull()
    expect(late.drops).toEqual([
      { reason: 'expired', info: { prio: 5, text: '【点歌】alice 点了一首歌' } },
    ])
  })

  it('song lines follow their configured limit', () => {
    const h = setup({ singing: { ackMaxAgeSec: 10 } })
    h.router.addSongLine('【点歌】x')
    h.clock.advance(10 * SEC + 1)
    expect(h.router.pick()).toBeNull()
  })
})

describe('pick: chat does not age while the streamer is singing', () => {
  it('measures from the last time singing was reported, exactly 30 s later is still fine', () => {
    const h = setup()
    const t0 = h.clock.t
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(100 * SEC)
    h.router.setSinging(true)
    expect(h.router.singing).toBe(true)
    expect(h.router.singingSeenAt).toBe(t0 + 100 * SEC)
    h.router.setSinging(false)
    expect(h.router.singing).toBe(false)
    expect(h.router.singingSeenAt).toBe(t0 + 100 * SEC) // remembered
    h.clock.advance(30 * SEC)
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there')
  })

  it('and expires one millisecond after that', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(100 * SEC)
    h.router.setSinging(true)
    h.router.setSinging(false)
    h.clock.advance(30 * SEC + 1)
    expect(h.router.pick()).toBeNull()
    expect(h.reasons()).toEqual(['expired'])
  })

  it('keeps postponing while singing continues to be reported', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    for (let i = 0; i < 20; i++) {
      h.clock.advance(20 * SEC)
      h.router.setSinging(true)
    }
    h.clock.advance(30 * SEC) // 430 s after the message, 30 s after singing was last reported
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there')
    expect(h.reasons()).toEqual([])
  })

  it('chat that arrives after the singing ended ages from its own arrival', () => {
    const h = setup()
    h.router.setSinging(true) // seen at t0
    h.clock.advance(5 * SEC)
    h.router.setSinging(false)
    chat(h, 1, 'alice', 'hello there') // arrives 5 s after the last report
    h.clock.advance(30 * SEC)
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there')
    chat(h, 2, 'bob', 'another one')
    h.clock.advance(30 * SEC + 1)
    expect(h.router.pick()).toBeNull()
  })

  it('a message that arrived during a song ages from the later of its arrival and the last report', () => {
    const h = setup()
    h.router.setSinging(true) // t0
    h.clock.advance(10 * SEC)
    chat(h, 1, 'alice', 'hello there') // arrives at t0 + 10 s while singing
    h.clock.advance(10 * SEC)
    h.router.setSinging(true) // seen again at t0 + 20 s
    h.clock.advance(30 * SEC) // t0 + 50 s: 30 s after the last report
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there')
  })

  it('does not apply to song lines', () => {
    const h = setup()
    h.router.addSongLine('【点歌】x')
    h.clock.advance(300 * SEC)
    h.router.setSinging(true)
    h.clock.advance(301 * SEC) // 601 s after the line was queued, 301 s after singing
    expect(h.router.pick()).toBeNull()
  })

  it('has never been singing at first', () => {
    const h = setup()
    expect(h.router.singing).toBe(false)
    expect(h.router.singingSeenAt).toBe(-Infinity)
  })
})

describe('the 50-line cap on every queue', () => {
  it('chat: the oldest lines are dropped to make room and reported', () => {
    const h = setup()
    for (let i = 0; i < 55; i++) chat(h, 1, 'alice', `message number ${i} here`)
    expect(h.router.stats().queued[4]).toBe(50)
    expect(h.reasons()).toEqual(Array(5).fill('queue_overflow'))
    expect(h.drops[0]?.info).toEqual({ prio: 4, text: '【弹幕】alice：message number 0 here' })
    expect(h.drops[4]?.info.text).toBe('【弹幕】alice：message number 4 here')
    expect(h.router.pick()?.text).toBe(
      ['5', '6', '7'].map((n) => `【弹幕】alice：message number ${n} here`).join('\n')
    )
  })

  it('exactly 50 lines fit', () => {
    const h = setup()
    for (let i = 0; i < 50; i++) chat(h, 1, 'alice', `message number ${i} here`)
    expect(h.router.stats().queued[4]).toBe(50)
    expect(h.drops).toEqual([])
  })

  const fillers: {
    name: string
    prio: 0 | 1 | 5
    fill: (h: Harness, i: number) => void
    dropped: string
    served: string
  }[] = [
    {
      name: 'paid messages',
      prio: 0,
      fill: (h, i) => h.router.onSuperChat({ uid: 1, uname: 'a', price: 30, msg: `sc ${i}` }),
      dropped: '【SC ¥30】a：sc 0',
      served: '【SC ¥30】a：sc 1',
    },
    {
      name: 'guards',
      prio: 1,
      fill: (h, i) => h.router.onGuard({ uid: 1, uname: `g${i}`, level: 3, num: 1 }),
      dropped: '【上舰】g0 开通了舰长',
      served: ['1', '2', '3'].map((n) => `【上舰】g${n} 开通了舰长`).join('\n'),
    },
    {
      name: 'song lines',
      prio: 5,
      fill: (h, i) => h.router.addSongLine(`【点歌】song ${i}`),
      dropped: '【点歌】song 0',
      served: ['1', '2', '3'].map((n) => `【点歌】song ${n}`).join('\n'),
    },
  ]
  for (const { name, prio, fill, dropped, served } of fillers) {
    it(`${name}: the 51st line pushes out the first`, () => {
      const h = setup()
      for (let i = 0; i < 51; i++) fill(h, i)
      expect(h.router.stats().queued[prio]).toBe(50)
      expect(h.drops).toEqual([{ reason: 'queue_overflow', info: { prio, text: dropped } }])
      expect(h.router.pick()?.text).toBe(served)
    })
  }

  it('dance requests and big gifts: the 51st pushes out the first', () => {
    const h = setup({ dance: { gifts: ['star'] } })
    for (let i = 0; i < 51; i++) gift(h, 100 + i, `d${i}`, 'star', 1, 0, 'silver')
    for (let i = 0; i < 51; i++) gift(h, 200 + i, `b${i}`, 'rose', 1, 20_000)
    h.clock.advance(10 * SEC)
    h.router.tick()
    expect(h.router.stats().queued[2]).toBe(50)
    expect(h.router.stats().queued[3]).toBe(50)
    expect(h.reasons()).toEqual(['queue_overflow', 'queue_overflow'])
    expect(h.drops.map((d) => d.info.prio)).toEqual([2, 3])
    expect(h.drops[0]?.info.text).toBe('【点舞】d0 送了 1 个 star，点名要看你跳舞')
    expect(h.drops[1]?.info.text).toBe('【礼物】b0 送了 1 个 rose')
  })
})

describe('cold start', () => {
  const cold = { cold: { enabled: true, minutes: 3 } }

  it('is off unless enabled', () => {
    const h = setup()
    h.clock.advance(10 * 60 * MIN)
    expect(h.router.pick()).toBeNull()
  })

  it('speaks after `minutes` of silence, counted from the start, then again every `minutes`', () => {
    const h = setup(cold)
    h.clock.advance(3 * MIN - 1)
    expect(h.router.pick()).toBeNull()
    h.clock.advance(1)
    expect(h.router.pick()).toEqual({
      text: '【冷场】已经3分钟没有人发弹幕了',
      // written by the program from nothing a viewer wrote: the role says so (see PartRole)
      parts: [{ prio: 4, kind: 'cold', role: 'system', text: '【冷场】已经3分钟没有人发弹幕了' }],
    })
    expect(h.router.pick()).toBeNull() // just spoke
    h.clock.advance(3 * MIN - 1)
    expect(h.router.pick()).toBeNull()
    h.clock.advance(1)
    expect(h.router.pick()?.text).toBe('【冷场】已经6分钟没有人发弹幕了') // total silence so far, whole minutes
  })

  it('reports whole minutes, rounding down', () => {
    const h = setup(cold)
    h.clock.advance(3 * MIN + 59 * SEC)
    expect(h.router.pick()?.text).toBe('【冷场】已经3分钟没有人发弹幕了')
  })

  it('any viewer event restarts the silence, even one that gets dropped', () => {
    const h = setup(cold)
    h.clock.advance(2 * MIN + 30 * SEC)
    chat(h, 1, 'alice', 'hi', { dmType: 1 }) // a sticker: dropped, but it is activity
    h.clock.advance(3 * MIN - 1)
    expect(h.router.pick()).toBeNull()
    h.clock.advance(1)
    expect(h.router.pick()?.text).toBe('【冷场】已经3分钟没有人发弹幕了')
  })

  it('gifts, guards and paid messages count as activity', () => {
    for (const act of [
      (h: Harness) => gift(h, 1, 'alice', 'rose', 1, 0, 'silver'),
      (h: Harness) => h.router.onGuard({ uid: 1, uname: 'a', level: 3, num: 1 }),
      (h: Harness) => h.router.onSuperChat({ uid: 1, uname: 'a', price: 30, msg: 'x' }),
    ]) {
      const h = setup(cold)
      h.clock.advance(2 * MIN)
      act(h)
      h.router.pick() // whatever was queued
      h.clock.advance(3 * MIN - 1)
      expect(h.router.pick()).toBeNull()
      h.clock.advance(1)
      expect(h.router.pick()?.text).toBe('【冷场】已经3分钟没有人发弹幕了')
    }
  })

  it('a song result line is not viewer activity', () => {
    const h = setup(cold)
    h.clock.advance(2 * MIN)
    h.router.addSongLine('【点歌】x')
    h.clock.advance(1 * MIN)
    expect(h.router.pick()?.text).toBe('【点歌】x') // served first: cold only speaks when nothing else waits
    expect(h.router.pick()?.text).toBe('【冷场】已经3分钟没有人发弹幕了')
  })

  it('the gap since the last cold-start line is a separate timer from the silence', () => {
    const h = setup(cold)
    h.clock.advance(3 * MIN)
    expect(h.router.pick()?.text).toBe('【冷场】已经3分钟没有人发弹幕了')
    h.clock.advance(30 * SEC) // 3:30
    chat(h, 1, 'alice', 'hello there')
    h.router.pick()
    h.clock.advance(3 * MIN - 1) // 6:29.999 (silent for 2:59.999)
    expect(h.router.pick()).toBeNull()
    h.clock.advance(1) // 6:30: silent for 3 minutes and the last cold line was 3:30 ago
    expect(h.router.pick()?.text).toBe('【冷场】已经3分钟没有人发弹幕了')
  })

  it('a fractional minute setting is honoured, and the count then reads zero', () => {
    const h = setup({ cold: { enabled: true, minutes: 0.5 } })
    h.clock.advance(30 * SEC)
    expect(h.router.pick()?.text).toBe('【冷场】已经0分钟没有人发弹幕了')
  })

  it('carries no viewer in its part', () => {
    const h = setup(cold)
    h.clock.advance(3 * MIN)
    const part = h.router.pick()?.parts[0]
    expect(part).toBeDefined()
    expect(part && 'uid' in part).toBe(false)
    expect(part && 'uname' in part).toBe(false)
  })
})

describe('pickSleep', () => {
  it('answers the newest chat message, marked as a sleep line, and leaves older ones waiting', () => {
    const h = setup()
    chat(h, 1, 'alice', 'first message')
    h.clock.advance(1 * SEC)
    chat(h, 2, 'bob', 'second message')
    expect(h.router.pickSleep(180)).toEqual({
      text: '【助眠】bob：second message',
      parts: [
        { prio: 4, kind: 'sleep', text: '【助眠】bob：second message', uid: 2, uname: 'bob' },
      ],
    })
    expect(h.router.pickSleep(180)?.text).toBe('【助眠】alice：first message')
    expect(h.router.pickSleep(180)).toBeNull()
  })

  it('lets chat wait maxAgeSec instead of the normal limit; exactly that is still fine', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(180 * SEC)
    expect(h.router.pickSleep(180)?.text).toBe('【助眠】alice：hello there')

    const late = setup()
    chat(late, 1, 'alice', 'hello there')
    late.clock.advance(180 * SEC + 1)
    expect(late.router.pickSleep(180)).toBeNull()
    expect(late.reasons()).toEqual(['expired'])
  })

  it('a message the normal pick would have dropped is still answered in sleep mode', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(100 * SEC)
    expect(h.router.pickSleep(180)?.text).toBe('【助眠】alice：hello there')
    chat(h, 2, 'bob', 'another one')
    h.clock.advance(100 * SEC)
    expect(h.router.pick()).toBeNull() // 100 s is too old for the normal limit
  })

  it('touches nothing but chat: paid messages, guards, gifts and songs wait for the mode to end', () => {
    const h = setup()
    h.router.onSuperChat({ uid: 3, uname: 'carol', price: 30, msg: 'thanks' })
    h.router.onGuard({ uid: 4, uname: 'dave', level: 3, num: 1 })
    h.router.addSongLine('【点歌】x')
    expect(h.router.pickSleep(180)).toBeNull()
    expect(h.router.pick()?.text).toBe('【SC ¥30】carol：thanks')
  })

  it('does not apply the singing rule to its expiry', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(100 * SEC)
    h.router.setSinging(true)
    h.clock.advance(81 * SEC) // 181 s old, but only 81 s since singing was seen
    expect(h.router.pickSleep(180)).toBeNull()
  })

  it('reports expired lines through the drop handler', () => {
    const h = setup()
    chat(h, 1, 'alice', 'first message')
    h.clock.advance(200 * SEC)
    chat(h, 2, 'bob', 'second message')
    expect(h.router.pickSleep(180)?.text).toBe('【助眠】bob：second message')
    expect(h.drops).toEqual([
      { reason: 'expired', info: { prio: 4, text: '【弹幕】alice：first message' } },
    ])
  })
})
