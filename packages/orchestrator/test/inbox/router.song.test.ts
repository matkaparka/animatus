import { describe, expect, it } from 'vitest'
import { Router, emptyBlocklist, type InboxConfigInput } from '../../src/inbox/index.ts'
import { SEC, chat, setup, type Logged } from './helpers.ts'

// Song commands are Chinese chat words: request "点歌 <keyword>" (also 點歌), cancel "取消点歌 [n]" (also
// 撤销点歌 / 撤回点歌), skip "切歌", list "歌单". They are the viewer-facing protocol and so appear as data
// below; everything else in this file is English.

/** `n` characters that are not all the same. */
const long = (n: number): string => 'abcdefghij'.repeat(Math.ceil(n / 10)).slice(0, n)
/** `n` astral letters, not all the same. */
const longAstral = (n: number): string =>
  Array.from({ length: n }, (_, i) => String.fromCodePoint(0x20000 + (i % 50))).join('')

describe('song requests', () => {
  const requests: [string, string][] = [
    ['点歌 sunny day', 'sunny day'],
    ['點歌 sunny day', 'sunny day'], // traditional character
    ['点歌：sunny day', 'sunny day'], // full-width colon
    ['点歌:sunny day', 'sunny day'],
    ['点歌 : sunny day', 'sunny day'],
    ['点歌sunny day', 'sunny day'], // no space needed
    ['点歌   sunny    day  ', 'sunny day'], // whitespace is collapsed first
    ['点歌\nsunny day', 'sunny day'],
    ['点歌\u{3000}sunny day', 'sunny day'], // ideographic space
    ['点歌 【x】', '[x]'], // brackets are neutralised like everywhere
  ]
  for (const [msg, keyword] of requests) {
    it(`understands ${JSON.stringify(msg)}`, () => {
      const h = setup()
      chat(h, 1, 'alice', msg)
      expect(h.commands).toEqual([{ kind: 'request', uid: 1, name: 'alice', keyword }])
      expect(h.router.pick()).toBeNull() // a command is not also passed on as chat
      expect(h.drops).toEqual([])
    })
  }

  it('pins a legacy quirk: a request whose keyword is only a colon is a request for ":"', () => {
    const half = setup()
    chat(half, 1, 'alice', '点歌:')
    expect(half.commands).toEqual([{ kind: 'request', uid: 1, name: 'alice', keyword: ':' }])
    const full = setup()
    chat(full, 1, 'alice', '点歌：')
    expect(full.commands).toEqual([{ kind: 'request', uid: 1, name: 'alice', keyword: '：' }])
  })

  it('pins a legacy quirk: "点歌单" is a request for the keyword "单", not a list command', () => {
    const h = setup()
    chat(h, 1, 'alice', '点歌单')
    expect(h.commands).toEqual([{ kind: 'request', uid: 1, name: 'alice', keyword: '单' }])
  })

  it('cuts the keyword to 40 characters, without an ellipsis, counting code points', () => {
    const h = setup()
    chat(h, 1, 'alice', `点歌 ${long(50)}`)
    chat(h, 2, 'bob', `点歌 ${longAstral(45)}`)
    chat(h, 3, 'carol', `点歌 ${long(40)}`)
    expect(h.commands.map((c) => c.kind === 'request' && c.keyword)).toEqual([
      long(40),
      longAstral(40),
      long(40),
    ])
  })

  it('a bare request word is ordinary chat', () => {
    const h = setup()
    chat(h, 1, 'alice', '点歌')
    expect(h.commands).toEqual([])
    expect(h.router.pick()?.text).toBe('【弹幕】alice：点歌')
  })

  it('the command word must start the message', () => {
    const h = setup()
    chat(h, 1, 'alice', '我想点歌 sunny day')
    chat(h, 2, 'bob', '【点歌】xyz') // the brackets become square ones, so this is not a command either
    expect(h.commands).toEqual([])
    expect(h.router.pick()?.text).toBe('【弹幕】alice：我想点歌 sunny day\n【弹幕】bob：[点歌]xyz')
  })

  it('a keyword with a blocklisted word is refused and reported', () => {
    const h = setup({}, ['rude'])
    chat(h, 1, 'alice', '点歌 a rude song')
    chat(h, 1, 'alice', '点歌 r u d e')
    expect(h.commands).toEqual([])
    expect(h.reasons()).toEqual(['song_rejected', 'song_rejected'])
    expect(h.drops[0]?.info).toEqual({
      uid: 1,
      uname: 'alice',
      text: '点歌 a rude song',
      word: 'rude',
    })
    expect(h.router.pick()).toBeNull()
  })

  it('pins a legacy quirk: a request from a blocklisted name is refused, not anonymised', () => {
    const h = setup({}, ['rude'])
    chat(h, 1, 'rude fan', '点歌 sunny day')
    expect(h.commands).toEqual([])
    expect(h.reasons()).toEqual(['song_rejected'])
    expect(h.drops[0]?.info.word).toBe('rude')
  })

  it('ignored users and stickers are never commands', () => {
    const h = setup({ ignoreUids: [7] })
    chat(h, 7, 'helper', '点歌 sunny day')
    chat(h, 1, 'alice', '点歌 sunny day', { dmType: 1 })
    expect(h.commands).toEqual([])
    expect(h.reasons()).toEqual(['ignored_uid', 'emote_sticker'])
  })

  it('when song commands are switched off, they are ordinary chat', () => {
    const h = setup({ singing: { enabled: false } })
    chat(h, 1, 'alice', '点歌 sunny day')
    chat(h, 5, 'owner', '切歌', { admin: true })
    expect(h.commands).toEqual([])
    expect(h.router.pick()?.text).toBe('【弹幕】alice：点歌 sunny day\n【弹幕】owner：切歌')
  })
})

describe('cancelling', () => {
  for (const word of ['取消点歌', '撤销点歌', '撤回点歌', '取消點歌', '撤回點歌']) {
    it(`${word} by anyone cancels their own latest request`, () => {
      const h = setup()
      chat(h, 1, 'alice', word)
      expect(h.commands).toEqual([{ kind: 'cancel', uid: 1, name: 'alice' }])
      expect('position' in (h.commands[0] ?? {})).toBe(false)
      expect(h.router.pick()).toBeNull()
    })
  }

  it('trailing punctuation is fine', () => {
    const h = setup()
    for (const msg of ['取消点歌！', '取消点歌~~', '取消点歌。', '取消点歌!.~～'])
      chat(h, 1, 'alice', msg)
    expect(h.commands).toHaveLength(4)
    expect(h.commands.every((c) => c.kind === 'cancel')).toBe(true)
  })

  const positions: [string, number][] = [
    ['取消点歌 2', 2],
    ['取消点歌2', 2],
    ['取消点歌 12。', 12],
    ['取消点歌 007', 7],
    ['取消点歌 0', 0],
    ['取消点歌 \u{ff12}', 2], // full-width digit
    ['取消点歌\u{ff11}\u{ff12}', 12],
    ['取消点歌 \u{663}', 3], // Arabic-Indic digit
    [`取消点歌 ${String.fromCodePoint(0x1d7d0)}`, 2], // mathematical bold digit
  ]
  for (const [msg, position] of positions) {
    it(`staff can remove queue entry ${position} with ${JSON.stringify(msg)}`, () => {
      const h = setup()
      chat(h, 1, 'mod', msg, { admin: true })
      expect(h.commands).toEqual([{ kind: 'cancel', uid: 1, name: 'mod', position }])
    })
  }

  it('anything else after the word is not a cancel command and is ordinary chat', () => {
    const h = setup()
    chat(h, 1, 'alice', '取消点歌abc')
    chat(h, 2, 'bob', '取消点歌 2 3')
    expect(h.commands).toEqual([])
    expect(h.router.pick()?.text).toBe('【弹幕】alice：取消点歌abc\n【弹幕】bob：取消点歌 2 3')
  })
})

describe('who may remove entries and skip', () => {
  const cases: {
    name: string
    who: { uid: number; admin?: boolean; roomOwnerUid?: number }
    cfg?: InboxConfigInput
    allowed: boolean
  }[] = [
    { name: 'an ordinary viewer', who: { uid: 1 }, allowed: false },
    { name: 'a moderator', who: { uid: 1, admin: true }, allowed: true },
    {
      name: 'a moderator when moderators may not manage the queue',
      who: { uid: 1, admin: true },
      cfg: { singing: { adminsCanSkip: false } },
      allowed: false,
    },
    {
      name: 'a configured owner id',
      who: { uid: 5 },
      cfg: { singing: { ownerUids: [5] } },
      allowed: true,
    },
    {
      name: 'a configured owner id even when moderators may not manage the queue',
      who: { uid: 5 },
      cfg: { singing: { ownerUids: [5], adminsCanSkip: false } },
      allowed: true,
    },
    { name: 'the room owner', who: { uid: 9, roomOwnerUid: 9 }, allowed: true },
    {
      name: 'someone else when the room owner is known',
      who: { uid: 8, roomOwnerUid: 9 },
      allowed: false,
    },
    {
      name: 'a guest (id 0) when the room owner is unknown (0)',
      who: { uid: 0, roomOwnerUid: 0 },
      allowed: false,
    },
    {
      name: 'a guest (id 0) when the room owner is unknown (missing)',
      who: { uid: 0 },
      allowed: false,
    },
  ]
  for (const c of cases) {
    it(`${c.name}: remove-by-number is ${c.allowed ? 'allowed' : 'ignored and swallowed'}`, () => {
      const h = setup(c.cfg)
      chat(h, c.who.uid, 'sam', '取消点歌 2', c.who)
      if (c.allowed) {
        expect(h.commands).toEqual([{ kind: 'cancel', uid: c.who.uid, name: 'sam', position: 2 }])
        expect(h.reasons()).toEqual([])
      } else {
        expect(h.commands).toEqual([])
        expect(h.reasons()).toEqual(['song_not_allowed'])
        expect(h.drops[0]?.info).toEqual({ uid: c.who.uid, uname: 'sam', text: '取消点歌 2' })
      }
      expect(h.router.pick()).toBeNull() // never falls through to ordinary chat
    })

    it(`${c.name}: skip is ${c.allowed ? 'allowed' : 'ignored and swallowed'}`, () => {
      const h = setup(c.cfg)
      chat(h, c.who.uid, 'sam', '切歌', c.who)
      if (c.allowed) {
        expect(h.commands).toEqual([{ kind: 'skip', uid: c.who.uid, name: 'sam' }])
        expect(h.reasons()).toEqual([])
      } else {
        expect(h.commands).toEqual([])
        expect(h.reasons()).toEqual(['song_not_allowed'])
      }
      expect(h.router.pick()).toBeNull()
    })
  }

  it('cancelling your own latest request needs no permission, whoever you are', () => {
    const h = setup({ singing: { adminsCanSkip: false } })
    chat(h, 0, 'guest', '取消点歌')
    expect(h.commands).toEqual([{ kind: 'cancel', uid: 0, name: 'guest' }])
  })

  it('skip accepts trailing punctuation and nothing else', () => {
    const h = setup()
    for (const msg of ['切歌！！', '切歌~', '切歌.', '切歌。'])
      chat(h, 1, 'mod', msg, { admin: true })
    chat(h, 1, 'mod', '切歌 吧', { admin: true })
    chat(h, 1, 'mod', '请切歌', { admin: true })
    expect(h.commands.map((c) => c.kind)).toEqual(['skip', 'skip', 'skip', 'skip'])
    expect(h.router.pick()?.text).toBe('【弹幕】mod：切歌 吧\n【弹幕】mod：请切歌')
  })
})

describe('listing the queue', () => {
  for (const msg of ['歌单', '歌单？', '歌单?', '歌单!!', '歌单。', '歌单 ']) {
    it(`${JSON.stringify(msg)} is for everyone`, () => {
      const h = setup()
      chat(h, 1, 'alice', msg)
      expect(h.commands).toEqual([{ kind: 'list', uid: 1, name: 'alice' }])
      expect(h.router.pick()).toBeNull()
    })
  }

  it('the word must stand alone', () => {
    const h = setup()
    chat(h, 1, 'alice', '歌单吗')
    chat(h, 2, 'bob', '看歌单')
    expect(h.commands).toEqual([])
    expect(h.router.pick()?.text).toBe('【弹幕】alice：歌单吗\n【弹幕】bob：看歌单')
  })
})

describe('commands bypass the ordinary chat filters', () => {
  it('a short command repeated within the duplicate window is a command every time', () => {
    const h = setup({}, [])
    chat(h, 5, 'mod', '切歌', { admin: true })
    chat(h, 5, 'mod', '切歌', { admin: true })
    chat(h, 1, 'alice', '歌单')
    chat(h, 1, 'alice', '歌单')
    expect(h.commands.map((c) => c.kind)).toEqual(['skip', 'skip', 'list', 'list'])
    expect(h.reasons()).toEqual([])
  })

  it('the minimum length does not apply', () => {
    const h = setup({ filter: { minChars: 10 } })
    chat(h, 1, 'alice', '歌单')
    chat(h, 1, 'alice', '取消点歌')
    expect(h.commands.map((c) => c.kind)).toEqual(['list', 'cancel'])
  })

  it('a keyword may repeat one character', () => {
    const h = setup()
    chat(h, 1, 'alice', '点歌 aaaa')
    expect(h.commands).toEqual([{ kind: 'request', uid: 1, name: 'alice', keyword: 'aaaa' }])
  })

  it('the same request can be made again straight away', () => {
    const h = setup()
    chat(h, 1, 'alice', '点歌 sunny day')
    chat(h, 1, 'alice', '点歌 sunny day')
    expect(h.commands).toHaveLength(2)
  })

  it('commands count as viewer activity, even when they are refused', () => {
    const h = setup()
    h.clock.advance(5 * SEC)
    chat(h, 1, 'alice', '切歌') // refused
    expect(h.router.lastActivity).toBe(h.clock.t)
  })

  it('carry the cleaned name; only requests are shielded from a blocklisted name (by being refused)', () => {
    const h = setup({}, ['rude'])
    chat(h, 1, 'rude  fan\n', '取消点歌')
    chat(h, 2, 'rude fan', '歌单')
    chat(h, 3, 'rude fan', '切歌', { admin: true })
    expect(h.commands).toEqual([
      { kind: 'cancel', uid: 1, name: 'rude fan' },
      { kind: 'list', uid: 2, name: 'rude fan' },
      { kind: 'skip', uid: 3, name: 'rude fan' },
    ])
  })
})

describe('delivery of commands', () => {
  it('without a handler a command is logged as a warning and discarded', () => {
    const logs: Logged[] = []
    const router = new Router({}, emptyBlocklist, {
      log: (level, msg, extra) => logs.push({ level, msg, extra }),
    })
    router.onDanmaku({ uid: 1, uname: 'alice', msg: '点歌 sunny day', dmType: 0 })
    expect(router.pick()).toBeNull()
    expect(
      logs.some((l) => l.level === 'warn' && l.msg === 'song command discarded: no handler is set')
    ).toBe(true)
  })

  it('a handler can be attached later', () => {
    const router = new Router()
    const got: string[] = []
    router.onSongCommand = (cmd) => got.push(cmd.kind)
    router.onDanmaku({ uid: 1, uname: 'alice', msg: '歌单', dmType: 0 })
    expect(got).toEqual(['list'])
  })

  it('a handler that throws does not break the router', () => {
    const h = setup()
    h.router.onSongCommand = () => {
      throw new Error('song service down')
    }
    chat(h, 1, 'alice', '歌单')
    chat(h, 1, 'alice', 'hello there')
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there')
    expect(h.logs.some((l) => l.level === 'error' && l.msg === 'song command handler threw')).toBe(
      true
    )
  })

  it('logs each command', () => {
    const h = setup()
    chat(h, 1, 'alice', '点歌 sunny day')
    const line = h.logs.find((l) => l.msg === 'song command: request')
    expect(line?.level).toBe('info')
    expect(line?.extra).toEqual({ kind: 'request', uid: 1, name: 'alice', keyword: 'sunny day' })
  })
})

describe('song result lines', () => {
  it('are queued as they come and served like any other line', () => {
    const h = setup()
    h.router.addSongLine('【点歌】alice 点了《Song A》（Artist），排在第 1 首，已经准备好了')
    expect(h.router.pick()).toEqual({
      text: '【点歌】alice 点了《Song A》（Artist），排在第 1 首，已经准备好了',
      parts: [
        {
          prio: 5,
          kind: 'song',
          text: '【点歌】alice 点了《Song A》（Artist），排在第 1 首，已经准备好了',
        },
      ],
    })
  })

  it('are passed through as given, not cleaned', () => {
    const h = setup()
    h.router.addSongLine('【歌单】x\n【点歌】y')
    expect(h.router.pick()?.text).toBe('【歌单】x\n【点歌】y')
  })
})
