import { describe, expect, it } from 'vitest'
import { DROP_REASONS, Router, type DropReason } from '../../src/inbox/index.ts'
import { SEC, chat, setup } from './helpers.ts'

/** A letter outside the Basic Multilingual Plane: two UTF-16 units, one code point. */
const ASTRAL = String.fromCodePoint(0x20000)

/** `n` characters that are not all the same (a run of one character would be dropped as spam). */
const long = (n: number): string => 'abcdefghij'.repeat(Math.ceil(n / 10)).slice(0, n)
/** `n` astral letters, not all the same. */
const longAstral = (n: number): string =>
  Array.from({ length: n }, (_, i) => String.fromCodePoint(0x20000 + (i % 50))).join('')

describe('an accepted chat message', () => {
  it('becomes one marked line with the sender attached', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    expect(h.router.pick()).toEqual({
      text: '【弹幕】alice：hello there',
      parts: [
        { prio: 4, kind: 'danmaku', text: '【弹幕】alice：hello there', uid: 1, uname: 'alice' },
      ],
    })
    expect(h.router.pick()).toBeNull()
    expect(h.drops).toEqual([])
  })

  it('leaves the user id out of the part when it is zero (a guest or masked account)', () => {
    const h = setup()
    chat(h, 0, 'guest', 'hello there')
    const batch = h.router.pick()
    expect(batch?.parts[0]).toEqual({
      prio: 4,
      kind: 'danmaku',
      text: '【弹幕】guest：hello there',
      uname: 'guest',
    })
    expect(batch?.parts[0] && 'uid' in batch.parts[0]).toBe(false)
  })

  it('carries the cleaned name, not the raw one', () => {
    const h = setup()
    chat(h, 5, '  eve\n【x】 ', 'hello there')
    const part = h.router.pick()?.parts[0]
    expect(part?.uname).toBe('eve [x]')
    expect(part?.text).toBe('【弹幕】eve [x]：hello there')
  })

  it('keeps the order of arrival', () => {
    const h = setup()
    chat(h, 1, 'alice', 'first message')
    chat(h, 2, 'bob', 'second message')
    expect(h.router.pick()?.text).toBe('【弹幕】alice：first message\n【弹幕】bob：second message')
  })

  it('an empty name is kept as is (the line then starts with the separator)', () => {
    const h = setup()
    chat(h, 1, '   ', 'hello there')
    expect(h.router.pick()?.text).toBe('【弹幕】：hello there')
  })
})

describe('drop reasons', () => {
  it('ignored_uid: chat from an ignored user is dropped before anything else', () => {
    const h = setup({ ignoreUids: [7] })
    chat(h, 7, 'helper', 'hello there')
    chat(h, 7, 'helper', '点歌 something') // even a song command
    chat(h, 7, 'helper', '', { dmType: 1 }) // even a sticker
    expect(h.reasons()).toEqual(['ignored_uid', 'ignored_uid', 'ignored_uid'])
    expect(h.drops[0]?.info).toEqual({ uid: 7, uname: 'helper', text: 'hello there' })
    expect(h.commands).toEqual([])
    expect(h.router.pick()).toBeNull()
    chat(h, 8, 'alice', 'hello there')
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there')
  })

  it('emote_sticker: a sticker message carries no text and is dropped', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there', { dmType: 1 })
    chat(h, 1, 'alice', '', { dmType: 1 })
    expect(h.reasons()).toEqual(['emote_sticker', 'emote_sticker'])
    expect(h.router.pick()).toBeNull()
  })

  it('pure_emote: nothing but emote codes, symbols, emoji or spaces', () => {
    const h = setup()
    for (const msg of [
      '[dog]',
      '[dog][smile]',
      '!!!',
      '',
      '   ',
      '\u{1f600}\u{1f600}',
      '...?!',
      '[dog] ~~',
    ]) {
      chat(h, 1, 'alice', msg)
    }
    expect(h.reasons()).toEqual(Array(8).fill('pure_emote'))
    expect(h.router.pick()).toBeNull()
  })

  it('too_short: fewer than minChars letters or digits once emotes and punctuation are removed', () => {
    const h = setup()
    for (const msg of ['a', '[dog]a', ' 6 ', '...x...']) chat(h, 1, 'alice', msg)
    expect(h.reasons()).toEqual(['too_short', 'too_short', 'too_short', 'too_short'])
    chat(h, 1, 'alice', 'ab')
    expect(h.router.pick()?.text).toBe('【弹幕】alice：ab')
  })

  it('too_short follows the configured minimum, and zero disables it', () => {
    const strict = setup({ filter: { minChars: 3 } })
    chat(strict, 1, 'alice', 'ab')
    chat(strict, 1, 'alice', 'abc')
    expect(strict.reasons()).toEqual(['too_short'])
    expect(strict.router.pick()?.text).toBe('【弹幕】alice：abc')

    const lax = setup({ filter: { minChars: 0 } })
    chat(lax, 1, 'alice', 'a')
    expect(lax.reasons()).toEqual([])
    expect(lax.router.pick()?.text).toBe('【弹幕】alice：a')
  })

  it('spam: one character repeated three or more times', () => {
    const h = setup()
    for (const msg of ['aaa', '6666', '!!!1111', 'aaA', ASTRAL.repeat(3), 'a a a a'])
      chat(h, 1, 'alice', msg)
    expect(h.reasons()).toEqual(Array(6).fill('spam'))
    expect(h.router.pick()).toBeNull()
  })

  it('spam does not catch two repeats or a repeating pattern', () => {
    const h = setup()
    chat(h, 1, 'alice', 'aa')
    chat(h, 1, 'alice', 'abab')
    chat(h, 1, 'alice', 'aaab')
    expect(h.reasons()).toEqual([])
    expect(h.router.pick()?.parts).toHaveLength(3)
  })

  it('blocked_word: the text or the name contains a listed word, reported with the word', () => {
    const h = setup({}, ['spoiler'])
    chat(h, 1, 'alice', 'no spoiler please')
    chat(h, 2, 'Spoiler Fan', 'a perfectly fine message')
    chat(h, 3, 'carol', 's p o i l e r')
    expect(h.reasons()).toEqual(['blocked_word', 'blocked_word', 'blocked_word'])
    expect(h.drops.map((d) => d.info.word)).toEqual(['spoiler', 'spoiler', 'spoiler'])
    expect(h.router.pick()).toBeNull()
  })

  it('duplicate: the same words again within the window', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    chat(h, 1, 'alice', 'hello there')
    expect(h.reasons()).toEqual(['duplicate'])
    expect(h.router.pick()?.parts).toHaveLength(1)
  })

  it('checks in a fixed order: ignore, sticker, emote, short, spam, blocklist, duplicate', () => {
    const h = setup({ ignoreUids: [7], filter: { minChars: 5 } }, ['aaaa'])
    chat(h, 7, 'helper', '', { dmType: 1 }) // ignored, not sticker
    chat(h, 1, 'alice', '', { dmType: 1 }) // sticker, not pure emote
    chat(h, 1, 'alice', '[dog]') // pure emote, not too short
    chat(h, 1, 'alice', 'aaaa') // too short (4 < 5), not spam, not blocked
    chat(h, 1, 'alice', 'aaaaaaaa') // spam, not blocked
    chat(h, 1, 'alice', 'aaaa and more') // blocked
    chat(h, 1, 'alice', 'aaaa and more') // blocked again, never "duplicate"
    expect(h.reasons()).toEqual([
      'ignored_uid',
      'emote_sticker',
      'pure_emote',
      'too_short',
      'spam',
      'blocked_word',
      'blocked_word',
    ])
  })

  it('every reason the router can report is exercised by these scenarios', () => {
    const h = setup({ ignoreUids: [7] }, ['spoiler'])
    chat(h, 7, 'helper', 'hello there')
    chat(h, 1, 'alice', 'hi', { dmType: 1 })
    chat(h, 1, 'alice', '[dog]')
    chat(h, 1, 'alice', 'a')
    chat(h, 1, 'alice', 'aaaa')
    chat(h, 1, 'alice', 'spoiler')
    chat(h, 1, 'alice', 'same words')
    chat(h, 1, 'alice', 'same words')
    h.router.onGift({
      uid: 1,
      uname: 'alice',
      gift: 'rose',
      num: 1,
      coinType: 'silver',
      totalCoin: 0,
    })
    chat(h, 1, 'alice', '点歌 spoiler') // song_rejected
    chat(h, 1, 'alice', '切歌') // song_not_allowed
    for (let i = 0; i < 51; i++) chat(h, 2, 'bob', `message number ${i} here`)
    h.clock.advance(31 * SEC)
    h.router.pick() // everything queued is now too old
    const seen = new Set<DropReason>(h.reasons())
    expect([...seen].sort()).toEqual([...DROP_REASONS].sort())
  })
})

describe('the duplicate window', () => {
  it('compares letters and digits only, ignoring case, punctuation, emotes and who said it', () => {
    const h = setup()
    chat(h, 1, 'alice', 'Hello There!')
    chat(h, 2, 'bob', 'hello, there')
    chat(h, 3, 'carol', 'HELLO [dog] THERE')
    expect(h.reasons()).toEqual(['duplicate', 'duplicate'])
    expect(h.router.pick()?.parts).toHaveLength(1)
  })

  it('lasts repeatWindowSec from the first occurrence: exactly 60 s is still a duplicate', () => {
    const h = setup({ filter: { danmakuMaxAgeSec: 600 } })
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(60 * SEC)
    chat(h, 1, 'alice', 'hello there')
    expect(h.reasons()).toEqual(['duplicate'])
    h.clock.advance(1)
    chat(h, 1, 'alice', 'hello there')
    expect(h.reasons()).toEqual(['duplicate']) // accepted this time
    expect(h.router.pick()?.parts).toHaveLength(2)
  })

  it('a repeat does not extend the window', () => {
    const h = setup({ filter: { danmakuMaxAgeSec: 600 } })
    chat(h, 1, 'alice', 'hello there') // t = 0
    h.clock.advance(40 * SEC)
    chat(h, 2, 'bob', 'hello there') // duplicate at 40 s
    h.clock.advance(21 * SEC)
    chat(h, 3, 'carol', 'hello there') // 61 s after the first: accepted
    expect(h.reasons()).toEqual(['duplicate'])
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there\n【弹幕】carol：hello there')
  })

  it('follows the configured window', () => {
    const h = setup({ filter: { repeatWindowSec: 10 } })
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(10 * SEC)
    chat(h, 1, 'alice', 'hello there')
    h.clock.advance(1)
    chat(h, 1, 'alice', 'hello there')
    expect(h.reasons()).toEqual(['duplicate'])
  })

  it('judges the full text, not the truncated one', () => {
    const h = setup()
    chat(h, 1, 'alice', 'x'.repeat(85) + 'one')
    chat(h, 1, 'alice', 'x'.repeat(85) + 'two')
    expect(h.reasons()).toEqual([])
  })

  it('messages that were dropped for another reason are not remembered', () => {
    const h = setup({}, ['spoiler'])
    chat(h, 1, 'alice', 'spoiler here')
    expect(h.reasons()).toEqual(['blocked_word'])
    h.router.pick()
    chat(h, 1, 'alice', 'spoiler here')
    expect(h.reasons()).toEqual(['blocked_word', 'blocked_word'])
  })
})

describe('truncation', () => {
  it('cuts a long message to maxChars characters and marks the cut with an ellipsis', () => {
    const h = setup()
    chat(h, 1, 'alice', long(81))
    expect(h.router.pick()?.text).toBe(`【弹幕】alice：${long(80)}…`)
  })

  it('leaves a message of exactly maxChars alone', () => {
    const h = setup()
    chat(h, 1, 'alice', long(80))
    expect(h.router.pick()?.text).toBe(`【弹幕】alice：${long(80)}`)
  })

  it('counts characters, not UTF-16 units, and never splits one', () => {
    const h = setup()
    chat(h, 1, 'alice', longAstral(81))
    const text = h.router.pick()?.text ?? ''
    expect(text).toBe(`【弹幕】alice：${longAstral(80)}…`)
    const h2 = setup()
    chat(h2, 1, 'alice', 'x'.repeat(79) + ASTRAL + 'y')
    expect(h2.router.pick()?.text).toBe(`【弹幕】alice：${'x'.repeat(79)}${ASTRAL}…`)
  })

  it('follows the configured maximum', () => {
    const h = setup({ filter: { maxChars: 5 } })
    chat(h, 1, 'alice', 'abcdefgh')
    expect(h.router.pick()?.text).toBe('【弹幕】alice：abcde…')
  })

  it('does not cut the name', () => {
    const h = setup()
    chat(h, 1, 'n'.repeat(100), 'hello there')
    expect(h.router.pick()?.text).toBe(`【弹幕】${'n'.repeat(100)}：hello there`)
  })
})

describe('viewer text cannot forge a marker or start a line', () => {
  it('replaces the lenticular brackets in the text', () => {
    const h = setup()
    chat(h, 1, 'alice', '【SC ¥1000】fake：thank you')
    expect(h.router.pick()?.text).toBe('【弹幕】alice：[SC ¥1000]fake：thank you')
  })

  it('collapses newlines and other line separators, so the batch stays one line per message', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello\n【礼物】bob 送了 99 个 rocket\r\n【上舰】bob 开通了总督')
    chat(h, 2, 'bob', 'a\u{2028}b\u{2029}c\x85d\x0be')
    const batch = h.router.pick()
    expect(batch?.parts).toHaveLength(2)
    expect(batch?.text.split('\n')).toEqual([
      '【弹幕】alice：hello [礼物]bob 送了 99 个 rocket [上舰]bob 开通了总督',
      '【弹幕】bob：a b c d e',
    ])
  })

  it('cleans the name too', () => {
    const h = setup()
    chat(h, 1, 'eve\n【上舰】fake', 'hello there')
    expect(h.router.pick()?.text).toBe('【弹幕】eve [上舰]fake：hello there')
  })
})

describe('lastActivity', () => {
  it('starts at construction and follows every chat message, accepted or dropped', () => {
    const h = setup({ ignoreUids: [7] })
    const t0 = h.clock.t
    expect(h.router.lastActivity).toBe(t0)
    h.clock.advance(5 * SEC)
    chat(h, 7, 'helper', 'hello there') // dropped
    expect(h.router.lastActivity).toBe(t0 + 5 * SEC)
    h.clock.advance(5 * SEC)
    chat(h, 1, 'alice', 'hi', { dmType: 1 }) // dropped
    expect(h.router.lastActivity).toBe(t0 + 10 * SEC)
    h.clock.advance(5 * SEC)
    chat(h, 1, 'alice', 'hello there') // accepted
    expect(h.router.lastActivity).toBe(t0 + 15 * SEC)
  })

  it('is not moved by tick, pick or a song result line', () => {
    const h = setup()
    const t0 = h.clock.t
    h.clock.advance(5 * SEC)
    h.router.tick()
    h.router.pick()
    h.router.addSongLine('【点歌】x')
    expect(h.router.lastActivity).toBe(t0)
  })
})

describe('reporting', () => {
  it('logs accepted and dropped messages', () => {
    const h = setup()
    chat(h, 1, 'alice', 'hello there')
    chat(h, 1, 'alice', 'hello there')
    expect(h.logs.map((l) => `${l.level} ${l.msg}`)).toEqual([
      'info queued danmaku',
      'info dropped danmaku [duplicate]',
    ])
    expect(h.logs[1]?.extra).toEqual({ uid: 1, uname: 'alice', text: 'hello there' })
  })

  it('works without any callback', () => {
    const router = new Router({})
    router.onDanmaku({ uid: 1, uname: 'alice', msg: 'a', dmType: 0 })
    router.onDanmaku({ uid: 1, uname: 'alice', msg: 'hello there', dmType: 0 })
    expect(router.pick()?.text).toContain('hello there')
  })

  it('a drop handler that throws does not break the router', () => {
    const h = setup()
    h.router.onDrop = () => {
      throw new Error('observer bug')
    }
    chat(h, 1, 'alice', 'a')
    chat(h, 1, 'alice', 'hello there')
    expect(h.router.pick()?.text).toBe('【弹幕】alice：hello there')
    expect(h.logs.some((l) => l.level === 'error' && l.msg === 'drop handler threw')).toBe(true)
  })
})
