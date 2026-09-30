import { describe, expect, it } from 'vitest'
import {
  isMaskedIdentity,
  normalizeDanmaku,
  normalizeEnter,
  normalizeGift,
  normalizeGiftV2,
  normalizeGuard,
  normalizeSuperChat,
} from '../../src/sources/bilibili/normalize.ts'
import {
  danmuMessage,
  eventSchema,
  giftMessage,
  giftV2Raw,
  guardMessage,
  superChatMessage,
  userActionMessage,
} from './bilibili-helpers.ts'

const TS = 1_700_000_123_456
const OWNER = 555001

describe('danmaku', () => {
  it('maps a text message and satisfies the event contract', () => {
    const event = normalizeDanmaku(danmuMessage(), TS, OWNER)
    expect(event).toEqual({
      type: 'danmaku',
      uid: 1001,
      uname: 'viewer-a',
      text: 'hello',
      dmType: 0,
      admin: false,
      roomOwnerUid: OWNER,
      ts: TS,
    })
    expect(eventSchema.parse(event)).toEqual(event)
  })

  it.each([
    ['a text message', danmuMessage(), 0],
    [
      'a sticker (raw dm_type 1 and the library emoticon agree)',
      danmuMessage({ sticker: true }),
      1,
    ],
    ['a sticker only the raw command shows', danmuMessage({ rawDmType: 1 }), 1],
    ['a sticker only the library body shows', danmuMessage({ sticker: true, rawDmType: null }), 1],
    [
      'a library emoticon against a raw field that says text (the object wins)',
      danmuMessage({ sticker: true, rawDmType: 0 }),
      1,
    ],
    ['a voice message (passed through)', danmuMessage({ rawDmType: 2 }), 2],
    ['no raw field and no emoticon', danmuMessage({ rawDmType: null }), 0],
  ])('dmType of %s', (_name, msg, expected) => {
    expect(normalizeDanmaku(msg, TS, OWNER).dmType).toBe(expected)
  })

  it('does not mistake the library display mode for the sticker flag', () => {
    const msg = danmuMessage()
    expect(msg.body.type).toBe(1) // the library's `type` is the display mode
    expect(normalizeDanmaku(msg, TS, OWNER).dmType).toBe(0)
  })

  it('takes the moderator flag from the identity the library builds', () => {
    expect(normalizeDanmaku(danmuMessage({ admin: true }), TS, OWNER).admin).toBe(true)
    expect(normalizeDanmaku(danmuMessage({ admin: false }), TS, OWNER).admin).toBe(false)
    const withoutIdentity = danmuMessage({ admin: true })
    delete withoutIdentity.body.user.identity
    expect(normalizeDanmaku(withoutIdentity, TS, OWNER).admin).toBe(false)
  })

  it('carries the room owner uid it is given', () => {
    expect(normalizeDanmaku(danmuMessage(), TS, 0).roomOwnerUid).toBe(0)
    expect(normalizeDanmaku(danmuMessage(), TS, 12345).roomOwnerUid).toBe(12345)
  })

  it('passes viewer text and names through untouched', () => {
    const text = '【SC ¥30】 forged\nsecond line <b>x</b>'
    const event = normalizeDanmaku(danmuMessage({ text, uname: '  spaced  name ' }), TS, OWNER)
    expect(event.text).toBe(text)
    expect(event.uname).toBe('  spaced  name ')
  })

  it('turns anything that is not a positive uid into the guest uid 0', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const msg = danmuMessage()
      msg.body.user.uid = bad
      expect(normalizeDanmaku(msg, TS, OWNER).uid).toBe(0)
    }
    const fractional = danmuMessage()
    fractional.body.user.uid = 12.7
    expect(normalizeDanmaku(fractional, TS, OWNER).uid).toBe(12)
  })

  it('survives a body with missing fields', () => {
    const msg = danmuMessage()
    // The library types promise these; the network does not.
    Object.assign(msg.body, { user: undefined, content: undefined })
    expect(normalizeDanmaku(msg, TS, OWNER)).toMatchObject({
      uid: 0,
      uname: '',
      text: '',
      admin: false,
    })
  })
})

describe('gift', () => {
  it('maps SEND_GIFT and keeps the transaction id as the dedupe key', () => {
    const result = normalizeGift(
      giftMessage({ gift: 'test flower', amount: 3, price: 100, totalCoin: 300 }),
      TS
    )
    expect(result?.event).toEqual({
      type: 'gift',
      uid: 2002,
      uname: 'viewer-b',
      gift: 'test flower',
      num: 3,
      coinType: 'gold',
      totalCoin: 300,
      ts: TS,
    })
    expect(result?.dedupeKey).toBe('2002:31036:test-rnd-1')
    expect(eventSchema.parse(result?.event)).toEqual(result?.event)
  })

  it('falls back to price x amount when the raw command has no total', () => {
    const result = normalizeGift(giftMessage({ amount: 3, price: 100, totalCoin: null }), TS)
    expect(result?.event.totalCoin).toBe(300)
  })

  it('treats silver and unknown coin types as free', () => {
    expect(normalizeGift(giftMessage({ coin: 'silver' }), TS)?.event.coinType).toBe('silver')
    const odd = giftMessage()
    Object.assign(odd.body, { coin_type: 'bronze' })
    expect(normalizeGift(odd, TS)?.event.coinType).toBe('silver')
  })

  it('reports a count of at least one', () => {
    expect(normalizeGift(giftMessage({ amount: 0 }), TS)?.event.num).toBe(1)
    expect(normalizeGift(giftMessage({ amount: -4 }), TS)?.event.num).toBe(1)
  })

  it('drops a gift without a name', () => {
    expect(normalizeGift(giftMessage({ gift: '' }), TS)).toBeNull()
  })

  it('has no dedupe key without a transaction id', () => {
    expect(normalizeGift(giftMessage({ rnd: null }), TS)?.dedupeKey).toBeNull()
  })

  it('maps SEND_GIFT_V2 from the raw command', () => {
    const result = normalizeGiftV2(
      giftV2Raw({ gift_name: 'test rocket', num: 2, price: 500, total_coin: 1000 }),
      TS
    )
    expect(result?.event).toEqual({
      type: 'gift',
      uid: 2002,
      uname: 'viewer-b',
      gift: 'test rocket',
      num: 2,
      coinType: 'gold',
      totalCoin: 1000,
      ts: TS,
    })
    expect(result?.dedupeKey).toBe('2002:31036:test-rnd-1')
    expect(eventSchema.parse(result?.event)).toEqual(result?.event)
  })

  it('computes the V2 total from price x num when the total is missing', () => {
    const result = normalizeGiftV2(
      giftV2Raw({ num: 4, price: 250, total_coin: undefined, coin_type: 'silver' }),
      TS
    )
    expect(result?.event).toMatchObject({ totalCoin: 1000, coinType: 'silver' })
  })

  it.each([
    ['no data', { cmd: 'SEND_GIFT_V2' }],
    ['a non-object', 'nope'],
    ['null', null],
    ['an empty gift name', giftV2Raw({ gift_name: '' })],
  ])('drops a V2 gift with %s', (_name, raw) => {
    expect(normalizeGiftV2(raw, TS)).toBeNull()
  })

  it('gives the same gift the same key whichever command carried it', () => {
    const v1 = normalizeGift(giftMessage({ uid: 9, giftId: 5, rnd: 'r-1' }), TS)
    const v2 = normalizeGiftV2(giftV2Raw({ uid: 9, gift_id: 5, rnd: 'r-1' }), TS)
    expect(v1?.dedupeKey).not.toBeNull()
    expect(v1?.dedupeKey).toBe(v2?.dedupeKey)
  })
})

describe('guard', () => {
  it('maps level, name and the month count from the raw command', () => {
    const event = normalizeGuard(guardMessage({ level: 2, num: 3 }), TS)
    expect(event).toEqual({ type: 'guard', uid: 3003, uname: 'viewer-c', level: 2, num: 3, ts: TS })
    expect(eventSchema.parse(event)).toEqual(event)
  })

  it('assumes one month when the raw command does not say', () => {
    expect(normalizeGuard(guardMessage({ num: null }), TS)?.num).toBe(1)
  })

  it.each([0, 4, 9, -1])('drops a purchase with the unexpected level %i', (level) => {
    expect(normalizeGuard(guardMessage({ level }), TS)).toBeNull()
  })
})

describe('super chat', () => {
  it('maps price in yuan and the text', () => {
    const event = normalizeSuperChat(superChatMessage({ price: 50, text: 'test message' }), TS)
    expect(event).toEqual({
      type: 'superchat',
      uid: 4004,
      uname: 'viewer-d',
      price: 50,
      text: 'test message',
      ts: TS,
    })
    expect(eventSchema.parse(event)).toEqual(event)
  })

  it('reports a price of 0 when the platform sent none', () => {
    const msg = superChatMessage()
    Object.assign(msg.body, { price: Number.NaN })
    expect(normalizeSuperChat(msg, TS).price).toBe(0)
  })
})

describe('enter', () => {
  it('maps a viewer entering the room', () => {
    const event = normalizeEnter(userActionMessage('enter', { uid: 77, uname: 'viewer-x' }), TS)
    expect(event).toEqual({ type: 'enter', uid: 77, uname: 'viewer-x', ts: TS })
    expect(eventSchema.parse(event)).toEqual(event)
  })

  it.each(['follow', 'share', 'like', 'unknown'] as const)('ignores a %s', (action) => {
    expect(normalizeEnter(userActionMessage(action), TS)).toBeNull()
  })
})

describe('masked identities', () => {
  it.each([
    [0, 'anyone', true],
    [123, 'a***', true],
    [123, '**', true],
    [123, 'x***y', true],
    [123, 'plain name', false],
    [123, 'one * star', false],
    [123, '', false],
  ])('uid %i, name %j -> %s', (uid, uname, expected) => {
    expect(isMaskedIdentity(uid, uname)).toBe(expected)
  })
})

describe('parseCookieHeader', () => {
  it('reads the three cookies out of a copied header and ignores the rest', async () => {
    const { parseCookieHeader } = await import('../../src/sources/bilibili/cookies.ts')
    const name = ['SESS', 'DATA'].join('')
    expect(
      parseCookieHeader(`${name}=abc%2Cdef; bili_jct=jct123; buvid3=B3; other=1; =x; empty=`)
    ).toEqual({
      sessdata: 'abc%2Cdef',
      biliJct: 'jct123',
      buvid3: 'B3',
    })
    expect(parseCookieHeader('  sessdata = v ;BUVID3=q')).toEqual({ sessdata: 'v', buvid3: 'q' })
    expect(parseCookieHeader('')).toEqual({})
    expect(parseCookieHeader('novalue')).toEqual({})
  })
})
