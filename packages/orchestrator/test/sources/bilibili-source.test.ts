import { describe, expect, it } from 'vitest'
import { BilibiliSource } from '../../src/sources/bilibili/source.ts'
import type { BilibiliCookies } from '../../src/sources/bilibili/types.ts'
import {
  COOKIE_HEADER,
  createHarness,
  danmuInfoReply,
  danmuMessage,
  eventSchema,
  giftMessage,
  giftV2Raw,
  guardMessage,
  heartbeatMessage,
  navReply,
  roomInitReply,
  settle,
  superChatMessage,
  userActionMessage,
  type HarnessOptions,
} from './bilibili-helpers.ts'

/** A started harness whose first connection is open. */
async function startOpen(options?: HarnessOptions) {
  const h = createHarness(options)
  await h.source.start()
  h.fake.last.open()
  return h
}

/** What the server sends to a connection that is not logged in. */
const LOG_IN_NOTICE = {
  cmd: 'LOG_IN_NOTICE',
  data: { notice_msg: 'test notice', image_web: '', image_app: '' },
}

describe('starting', () => {
  it('resolves the long room id, checks the login, asks for a token, and connects the library with all of it', async () => {
    const h = createHarness()
    await h.source.start()

    expect(h.statuses()).toEqual(['connecting'])
    expect(h.api.callsTo('room_init')).toHaveLength(1)
    expect(h.api.callsTo('room_init')[0]?.query.get('id')).toBe('7')
    expect(h.api.callsTo('nav')).toHaveLength(1)
    expect(h.api.callsTo('getDanmuInfo')).toHaveLength(1)

    expect(h.fake.connections).toHaveLength(1)
    const connection = h.fake.last
    expect(connection.roomId).toBe(424242) // the long id, not the configured short one
    expect(connection.ws).toMatchObject({ uid: 4242, keepalive: false, key: 'test-danmu-token' })
    expect(connection.ws?.headers?.Cookie).toBe(COOKIE_HEADER)
    expect(connection.ws?.headers?.['User-Agent']).toMatch(/^Mozilla\//)
    expect(h.source.realRoomId).toBe(424242)
    expect(h.source.roomOwnerUid).toBe(555001)
  })

  it('reports open when the transport comes up', async () => {
    const h = createHarness()
    await h.source.start()
    h.fake.last.open()
    expect(h.statuses()).toEqual(['connecting', 'open'])
  })

  it('connects as a guest, without a login lookup or a token of its own, when no cookie is configured', async () => {
    const h = createHarness({ cookies: null })
    await h.source.start()
    expect(h.api.callsTo('nav')).toHaveLength(0)
    expect(h.api.callsTo('getDanmuInfo')).toHaveLength(0)
    const ws = h.fake.last.ws
    expect(ws?.uid).toBe(0)
    expect(ws?.key).toBeUndefined()
    expect(ws?.headers).toEqual({ 'User-Agent': expect.stringMatching(/^Mozilla\//) })
    expect(h.alarms()).toEqual([]) // said a few seconds after the connection opened, not before
  })

  it('resolves the room once, not on every reconnect', async () => {
    const h = await startOpen()
    h.fake.last.drop()
    await h.clock.advance(1_000)
    expect(h.fake.connections).toHaveLength(2)
    expect(h.api.callsTo('room_init')).toHaveLength(1)
  })

  it('does nothing on a second start, and a stopped source cannot be started again', async () => {
    const h = createHarness()
    await h.source.start()
    await h.source.start()
    expect(h.fake.connections).toHaveLength(1)
    await h.source.stop()
    await expect(h.source.start()).rejects.toThrow(/stopped/)
  })

  it('rejects options that cannot work', () => {
    for (const roomId of [0, -3, 1.5, Number.NaN]) {
      expect(() => new BilibiliSource({ roomId })).toThrow(RangeError)
    }
    expect(() => new BilibiliSource({ roomId: 1, reconnect: { maxDelaySec: 0 } })).toThrow(
      RangeError
    )
    expect(() => new BilibiliSource({ roomId: 1, reconnect: { stableAfterSec: -1 } })).toThrow(
      RangeError
    )
  })
})

describe('the login check', () => {
  it('raises cookie_invalid when the check says the cookie is not logged in, and still connects as a guest', async () => {
    const h = createHarness()
    h.api.nav = () => ({ json: navReply({ loggedIn: false }) })
    await h.source.start()
    expect(h.alarms()).toEqual(['cookie_invalid'])
    expect(h.events.map((event) => event.type)).toEqual(['status', 'alarm']) // before the connection is made
    expect(h.fake.last.ws?.uid).toBe(0)
    // The signing keys of the -101 answer still let the source ask for a token of its own.
    expect(h.fake.last.ws?.key).toBe('test-danmu-token')
  })

  it('only warns when the check itself fails: a status detail, no alarm, and it connects anyway', async () => {
    const h = createHarness()
    h.api.nav = () => new Error('connect ECONNREFUSED')
    await h.source.start()
    expect(h.alarms()).toEqual([])
    const warning = h.ofType('status').find((event) => event.detail?.includes('login check failed'))
    expect(warning).toEqual({
      type: 'status',
      state: 'connecting',
      detail: 'login check failed (connect ECONNREFUSED); connecting as a guest',
    })
    expect(h.logs.some((line) => line.level === 'warn' && line.msg === 'login check failed')).toBe(
      true
    )
    expect(h.fake.connections).toHaveLength(1)
    expect(h.fake.last.ws?.uid).toBe(0)
    expect(h.fake.last.ws?.key).toBeUndefined() // no signing keys, so the library fetches the token
  })

  it('keeps the uid it last saw for this cookie when a later check fails', async () => {
    const h = await startOpen()
    h.api.nav = () => new Error('temporarily unreachable')
    h.fake.last.drop()
    await h.clock.advance(1_000)
    expect(h.fake.connections).toHaveLength(2)
    expect(h.fake.last.ws?.uid).toBe(4242)
    expect(h.alarms()).toEqual([])
  })

  it('checks again on every reconnect and notices a cookie that went bad', async () => {
    const h = await startOpen()
    expect(h.alarms()).toEqual([])
    h.api.nav = () => ({ json: navReply({ loggedIn: false }) })
    h.fake.last.drop()
    await h.clock.advance(1_000)
    expect(h.api.callsTo('nav')).toHaveLength(2)
    expect(h.alarms()).toEqual(['cookie_invalid'])
    expect(h.fake.last.ws?.uid).toBe(0)
  })

  it('does not check, and does not raise cookie_invalid, when the provider returns no session cookie', async () => {
    const h = createHarness({ cookies: { buvid3: 'test-buvid3' } })
    await h.source.start()
    expect(h.api.callsTo('nav')).toHaveLength(0)
    expect(h.alarms()).toEqual([])
    expect(h.fake.last.ws?.uid).toBe(0)
    expect(h.fake.last.ws?.headers?.Cookie).toBe('buvid3=test-buvid3')
  })

  it('raises cookie_invalid when the cookie provider fails, and connects as a guest', async () => {
    const h = createHarness({
      cookies: () => {
        throw new Error('vault locked')
      },
    })
    await h.source.start()
    expect(h.alarms()).toEqual(['cookie_invalid'])
    expect(h.fake.last.ws?.uid).toBe(0)
    expect(h.fake.last.ws?.headers).not.toHaveProperty('Cookie')
    expect(h.logs.some((line) => line.level === 'warn' && /cookie provider/.test(line.msg))).toBe(
      true
    )
  })

  it('drops a cookie value that cannot go into a header, and names it without showing it', async () => {
    const h = createHarness({ cookies: { sessdata: 'bad value;x', buvid3: 'test-buvid3' } })
    await h.source.start()
    expect(h.fake.last.ws?.headers?.Cookie).toBe('buvid3=test-buvid3')
    const dropped = h.logs.find((line) => line.msg.startsWith('a cookie value was dropped'))
    expect(dropped?.extra).toEqual({ cookie: 'sessdata' })
    expect(JSON.stringify(h.logs)).not.toContain('bad value')
  })

  it('falls back to the library token lookup when its own token request fails', async () => {
    const h = createHarness()
    h.api.danmuInfo = () => ({ json: { code: -352, message: 'x', data: null } })
    await h.source.start()
    expect(h.fake.connections).toHaveLength(1)
    expect(h.fake.last.ws?.key).toBeUndefined()
    expect(h.fake.last.ws?.uid).toBe(4242)
    expect(
      h.logs.some((line) => line.level === 'warn' && /no connection token/.test(line.msg))
    ).toBe(true)
  })
})

describe('events', () => {
  it('turns every kind of message into an event that satisfies the contract', async () => {
    const h = await startOpen()
    const { handler } = h.fake.last
    handler.onIncomeDanmu?.(danmuMessage({ text: 'hi', admin: true }))
    handler.onIncomeDanmu?.(danmuMessage({ sticker: true }))
    handler.onGift?.(giftMessage({ rnd: 'r-v1' }))
    handler.raw?.SEND_GIFT_V2?.(giftV2Raw({ rnd: 'r-v2' }))
    handler.onGuardBuy?.(guardMessage({ level: 1, num: 3 }))
    handler.onIncomeSuperChat?.(superChatMessage({ price: 30 }))
    handler.onUserAction?.(userActionMessage('enter'))
    handler.onUserAction?.(userActionMessage('follow')) // not reported

    const kinds = h.events.filter((e) => e.type !== 'status').map((e) => e.type)
    expect(kinds).toEqual(['danmaku', 'danmaku', 'gift', 'gift', 'guard', 'superchat', 'enter'])
    for (const event of h.events) expect(eventSchema.parse(event)).toEqual(event)

    const [text, sticker] = h.ofType('danmaku')
    expect(text).toMatchObject({
      text: 'hi',
      admin: true,
      dmType: 0,
      roomOwnerUid: 555001,
      ts: h.clock.now(),
    })
    expect(sticker).toMatchObject({ dmType: 1, admin: false })
    expect(h.ofType('guard')[0]).toMatchObject({ level: 1, num: 3 })
    expect(h.ofType('superchat')[0]).toMatchObject({ price: 30 })
  })

  it('reports each gift once even when it arrives as SEND_GIFT and as SEND_GIFT_V2', async () => {
    const h = await startOpen()
    const { handler } = h.fake.last
    handler.raw?.SEND_GIFT_V2?.(giftV2Raw({ uid: 9, gift_id: 5, rnd: 'r-1' }))
    handler.onGift?.(giftMessage({ uid: 9, giftId: 5, rnd: 'r-1' })) // the same gift, the other command
    expect(h.ofType('gift')).toHaveLength(1)

    handler.onGift?.(giftMessage({ uid: 9, giftId: 5, rnd: 'r-2' })) // another transaction
    expect(h.ofType('gift')).toHaveLength(2)

    await h.clock.advance(60_000) // the memory of a transaction is limited
    handler.raw?.SEND_GIFT_V2?.(giftV2Raw({ uid: 9, gift_id: 5, rnd: 'r-1' }))
    expect(h.ofType('gift')).toHaveLength(3)
  })

  it('does not merge gifts that carry no transaction id', async () => {
    const h = await startOpen()
    const { handler } = h.fake.last
    handler.raw?.SEND_GIFT_V2?.(giftV2Raw({ rnd: '' }))
    handler.raw?.SEND_GIFT_V2?.(giftV2Raw({ rnd: '' }))
    expect(h.ofType('gift')).toHaveLength(2)
  })

  it('drops a guard purchase with an unexpected level, with a warning', async () => {
    const h = await startOpen()
    h.fake.last.handler.onGuardBuy?.(guardMessage({ level: 9 }))
    expect(h.ofType('guard')).toHaveLength(0)
    expect(h.logs.some((line) => line.level === 'warn' && /guard purchase/.test(line.msg))).toBe(
      true
    )
  })

  it('stamps events with the receive time of its clock', async () => {
    const h = await startOpen()
    await h.clock.advance(1_234)
    h.fake.last.handler.onIncomeDanmu?.(danmuMessage())
    expect(h.ofType('danmaku')[0]?.ts).toBe(h.clock.now())
  })
})

describe('alarms', () => {
  it('raises masked_names before it delivers a message from a masked user', async () => {
    const h = await startOpen()
    h.fake.last.handler.onIncomeDanmu?.(danmuMessage({ uid: 0, uname: 'a***' }))
    expect(h.events.slice(-2).map((event) => event.type)).toEqual(['alarm', 'danmaku'])
    expect(h.ofType('alarm')[0]).toMatchObject({ code: 'masked_names' })
  })

  it('treats a masked name with a real uid, and a masked super chat, the same way', async () => {
    const h = await startOpen()
    h.fake.last.handler.onIncomeSuperChat?.(superChatMessage({ uid: 5, uname: 'x**y' }))
    expect(h.alarms()).toEqual(['masked_names'])
    expect(h.ofType('superchat')).toHaveLength(1)
  })

  it('does not raise it for one asterisk, or for gifts and entries (as the legacy handler)', async () => {
    const h = await startOpen()
    const { handler } = h.fake.last
    handler.onIncomeDanmu?.(danmuMessage({ uname: 'one * star' }))
    handler.onGift?.(giftMessage({ uid: 0, uname: 'a***' }))
    handler.onUserAction?.(userActionMessage('enter', { uname: 'a***' }))
    expect(h.alarms()).toEqual([])
  })

  it('raises at most one alarm per code in 60 s, and keeps delivering the messages', async () => {
    const h = await startOpen()
    const { handler } = h.fake.last
    const masked = () => handler.onIncomeDanmu?.(danmuMessage({ uid: 0, uname: 'a***' }))
    masked()
    masked()
    expect(h.alarms()).toEqual(['masked_names'])
    await h.clock.advance(59_999)
    masked()
    expect(h.alarms()).toEqual(['masked_names'])
    await h.clock.advance(1)
    masked()
    expect(h.alarms()).toEqual(['masked_names', 'masked_names'])
    expect(h.ofType('danmaku')).toHaveLength(4) // every message was delivered, alarmed or not
  })

  it('limits each code separately', async () => {
    const h = await startOpen()
    const { handler } = h.fake.last
    handler.onIncomeDanmu?.(danmuMessage({ uid: 0, uname: 'a***' }))
    handler.raw?.LOG_IN_NOTICE?.(LOG_IN_NOTICE)
    handler.onIncomeDanmu?.(danmuMessage({ uid: 0, uname: 'a***' }))
    handler.raw?.LOG_IN_NOTICE?.(LOG_IN_NOTICE)
    expect(h.alarms()).toEqual(['masked_names', 'guest_connection'])
  })

  it('raises guest_connection 5 s after a connection with uid 0 opened, not before', async () => {
    const h = createHarness({ cookies: null })
    await h.source.start()
    await h.clock.advance(10_000) // connecting does not count
    expect(h.alarms()).toEqual([])
    h.fake.last.open()
    await h.clock.advance(4_999)
    expect(h.alarms()).toEqual([])
    await h.clock.advance(1)
    expect(h.alarms()).toEqual(['guest_connection'])
  })

  it('does not raise guest_connection for a logged-in connection', async () => {
    const h = await startOpen()
    await h.clock.advance(60_000)
    expect(h.alarms()).toEqual([])
  })

  it('raises guest_connection at once when the server says the client is not logged in, even after a passed login check', async () => {
    const h = await startOpen()
    h.fake.last.handler.raw?.LOG_IN_NOTICE?.(LOG_IN_NOTICE)
    expect(h.alarms()).toEqual(['guest_connection'])
  })

  it('reports an anonymous connection once when the notice and the timer both fire', async () => {
    const h = createHarness({ cookies: null })
    await h.source.start()
    h.fake.last.open()
    h.fake.last.handler.raw?.LOG_IN_NOTICE?.(LOG_IN_NOTICE)
    await h.clock.advance(5_000)
    expect(h.alarms()).toEqual(['guest_connection'])
  })

  it('never puts a viewer name or message text into an alarm', async () => {
    const h = await startOpen()
    h.fake.last.handler.onIncomeDanmu?.(
      danmuMessage({ uid: 0, uname: 'a***', text: 'secret words' })
    )
    for (const alarm of h.ofType('alarm')) {
      expect(alarm.message).not.toContain('a***')
      expect(alarm.message).not.toContain('secret words')
    }
  })
})

describe('reconnecting', () => {
  it('retries after 1, 2, 4, 8, 16, 30, 30, 30 seconds', async () => {
    const h = createHarness()
    await h.source.start()
    const delays = [1, 2, 4, 8, 16, 30, 30, 30]
    for (const [index, delay] of delays.entries()) {
      const before = h.fake.connections.length
      h.fake.last.drop() // an attempt that never got anywhere
      expect(h.lastStatus()).toEqual({
        type: 'status',
        state: 'reconnecting',
        detail: `retry in ${delay} s (failure ${index + 1}): connection closed`,
      })
      await h.clock.advance(delay * 1000 - 1)
      expect(h.fake.connections).toHaveLength(before)
      await h.clock.advance(1)
      expect(h.fake.connections).toHaveLength(before + 1)
    }
  })

  it('honours a lower cap', async () => {
    const h = createHarness({ reconnect: { maxDelaySec: 5 } })
    await h.source.start()
    const seen: string[] = []
    for (let failure = 0; failure < 5; failure++) {
      h.fake.last.drop()
      seen.push(/retry in (\d+) s/.exec(h.lastStatus()?.detail ?? '')?.[1] ?? '?')
      await h.clock.advance(5_000)
    }
    expect(seen).toEqual(['1', '2', '4', '5', '5'])
  })

  it('starts over at 1 s after a connection that stayed open for at least 30 s', async () => {
    const h = createHarness()
    await h.source.start()
    h.fake.last.drop() // 1 s
    await h.clock.advance(1_000)
    h.fake.last.drop() // 2 s
    await h.clock.advance(2_000)
    h.fake.last.open()
    await h.clock.advance(30_000)
    h.fake.last.drop()
    expect(h.lastStatus()?.detail).toMatch(/^retry in 1 s \(failure 1\)/)
  })

  it('keeps counting after a connection that was open for less than 30 s', async () => {
    const h = createHarness()
    await h.source.start()
    h.fake.last.drop() // 1 s
    await h.clock.advance(1_000)
    h.fake.last.drop() // 2 s
    await h.clock.advance(2_000)
    h.fake.last.open()
    await h.clock.advance(29_999)
    h.fake.last.drop()
    expect(h.lastStatus()?.detail).toMatch(/^retry in 4 s \(failure 3\)/)
  })

  it('runs the login check and asks for a token again on every attempt', async () => {
    const h = await startOpen()
    h.fake.last.drop()
    await h.clock.advance(1_000)
    expect(h.api.callsTo('nav')).toHaveLength(2)
    expect(h.api.callsTo('getDanmuInfo')).toHaveLength(2)
  })

  it('goes connecting, open, reconnecting, connecting, open', async () => {
    const h = await startOpen()
    h.fake.last.drop()
    await h.clock.advance(1_000)
    h.fake.last.open()
    expect(h.statuses()).toEqual(['connecting', 'open', 'reconnecting', 'connecting', 'open'])
    expect(h.ofType('status')[3]?.detail).toBe('attempt 2')
  })

  it('raises connection_lost from the third consecutive failure on, at most once a minute', async () => {
    const h = createHarness()
    await h.source.start()
    h.fake.last.drop()
    await h.clock.advance(1_000)
    h.fake.last.drop()
    expect(h.alarms()).toEqual([])
    await h.clock.advance(2_000)
    h.fake.last.drop()
    expect(h.alarms()).toEqual(['connection_lost'])
    await h.clock.advance(4_000)
    h.fake.last.drop() // the fourth failure, 4 s later
    expect(h.alarms()).toEqual(['connection_lost'])
  })

  it('handles an error and the close that follows it as one failure', async () => {
    const h = await startOpen()
    const connection = h.fake.last
    connection.live.emit('error', new Error('read ECONNRESET'))
    expect(h.lastStatus()?.detail).toBe(
      'retry in 1 s (failure 1): connection error: read ECONNRESET'
    )
    connection.drop() // the socket's close follows its error
    await h.clock.advance(1_000)
    expect(h.fake.connections).toHaveLength(2)
    expect(h.ofType('status').filter((event) => event.state === 'reconnecting')).toHaveLength(1)
  })

  it('also reacts to onError, for a library version that calls it', async () => {
    const h = await startOpen()
    h.fake.last.handler.onError?.(new Error('boom'))
    expect(h.lastStatus()?.detail).toBe('retry in 1 s (failure 1): connection error: boom')
  })

  it('ends a failed connection completely: listener closed, socket destroyed, timers gone', async () => {
    const h = await startOpen()
    const connection = h.fake.last
    connection.drop()
    expect(connection.closeCalls).toBe(1)
    expect(connection.live.tcpSocket?.destroyed).toBe(true)
    expect(h.clock.pending).toBe(1) // only the reconnect timer
  })

  it('ignores what a dead connection still delivers', async () => {
    const h = await startOpen()
    const dead = h.fake.last
    dead.drop()
    await h.clock.advance(1_000)
    dead.handler.onIncomeDanmu?.(danmuMessage())
    dead.handler.raw?.LOG_IN_NOTICE?.(LOG_IN_NOTICE)
    dead.drop()
    expect(h.ofType('danmaku')).toHaveLength(0)
    expect(h.alarms()).toEqual([])
    expect(h.fake.connections).toHaveLength(2)
  })

  it('retries a failed room lookup, and reports the long id only once it has one', async () => {
    const h = createHarness()
    let up = false
    h.api.room = () => (up ? { json: roomInitReply() } : new Error('getaddrinfo ENOTFOUND'))
    await h.source.start()
    expect(h.fake.connections).toHaveLength(0)
    expect(h.source.realRoomId).toBeNull()
    expect(h.lastStatus()?.detail).toBe('retry in 1 s (failure 1): getaddrinfo ENOTFOUND')
    up = true
    await h.clock.advance(1_000)
    expect(h.fake.connections).toHaveLength(1)
    expect(h.source.realRoomId).toBe(424242)
  })

  it('raises connection_lost at once for a room that does not exist, and keeps retrying', async () => {
    const h = createHarness()
    h.api.room = () => ({ json: { code: 60004, msg: 'x', message: 'x', data: [] } })
    await h.source.start()
    expect(h.ofType('alarm')).toEqual([
      { type: 'alarm', code: 'connection_lost', message: 'The configured room does not exist.' },
    ])
    expect(h.lastStatus()?.state).toBe('reconnecting')
    h.api.room = () => ({ json: roomInitReply() })
    await h.clock.advance(1_000)
    expect(h.fake.connections).toHaveLength(1)
  })

  it('treats a listener factory that throws as a failed attempt', async () => {
    const h = createHarness({
      listenerFactory: () => {
        throw new Error('factory boom')
      },
    })
    await h.source.start()
    expect(h.lastStatus()?.detail).toBe('retry in 1 s (failure 1): factory boom')
    expect(h.clock.pending).toBe(1) // the reconnect timer, and nothing left of the attempt
  })

  it('abandons an attempt whose transport never comes up after 20 s', async () => {
    const h = createHarness()
    await h.source.start()
    const connection = h.fake.last
    await h.clock.advance(19_999)
    expect(h.statuses()).toEqual(['connecting'])
    await h.clock.advance(1)
    expect(h.lastStatus()?.detail).toBe('retry in 1 s (failure 1): no connection after 20 s')
    expect(connection.live.tcpSocket?.destroyed).toBe(true)
  })

  it('drops a connection that has gone silent for 90 s, while heartbeats keep one alive', async () => {
    const h = await startOpen()
    const { handler } = h.fake.last
    for (let beat = 0; beat < 10; beat++) {
      await h.clock.advance(30_000)
      handler.onAttentionChange?.(heartbeatMessage())
    }
    expect(h.statuses()).toEqual(['connecting', 'open']) // five minutes and still up
    await h.clock.advance(89_999)
    expect(h.statuses()).toEqual(['connecting', 'open'])
    await h.clock.advance(1)
    expect(h.lastStatus()?.detail).toBe('retry in 1 s (failure 1): no data for 90 s')
  })
})

describe('stopping', () => {
  it('closes the listener and the socket, cancels every timer, and never reconnects', async () => {
    const h = await startOpen()
    const connection = h.fake.last
    await h.source.stop()

    expect(connection.closeCalls).toBe(1)
    expect(connection.live.tcpSocket?.destroyed).toBe(true)
    expect(h.lastStatus()).toEqual({ type: 'status', state: 'closed' })
    expect(h.clock.pending).toBe(0)

    connection.drop() // the library reports the close after the fact
    await h.clock.advance(10 * 60_000)
    expect(h.fake.connections).toHaveLength(1)
    expect(h.statuses()).toEqual(['connecting', 'open', 'closed'])
  })

  it('ignores everything the library still delivers afterwards', async () => {
    const h = await startOpen()
    const { handler } = h.fake.last
    await h.source.stop()
    const before = h.events.length
    handler.onIncomeDanmu?.(danmuMessage({ uid: 0, uname: 'a***' }))
    handler.onGift?.(giftMessage())
    handler.raw?.LOG_IN_NOTICE?.(LOG_IN_NOTICE)
    handler.onAttentionChange?.(heartbeatMessage())
    expect(h.events).toHaveLength(before)
  })

  it('cancels a pending reconnect', async () => {
    const h = await startOpen()
    h.fake.last.drop()
    expect(h.clock.pending).toBe(1)
    await h.source.stop()
    expect(h.clock.pending).toBe(0)
    await h.clock.advance(120_000)
    expect(h.fake.connections).toHaveLength(1)
    expect(h.lastStatus()).toEqual({ type: 'status', state: 'closed' })
  })

  it('abandons a request that is still in flight, and creates no listener', async () => {
    const h = createHarness()
    h.api.nav = () => 'hang'
    const started = h.source.start()
    await settle()
    expect(h.api.callsTo('nav')).toHaveLength(1)
    await h.source.stop()
    await started
    expect(h.fake.connections).toHaveLength(0)
    expect(h.statuses()).toEqual(['connecting', 'closed'])
    expect(h.clock.pending).toBe(0)
  })

  it('ends a connection that the library completes after stop() (its close() does nothing until then)', async () => {
    const h = createHarness()
    await h.source.start()
    const connection = h.fake.last
    connection.live.tcpSocket = null // the library has not created its socket yet
    await h.source.stop()
    expect(connection.closeCalls).toBe(1)

    const late = connection.attachSocket() // it connects anyway
    connection.open()
    expect(late.destroyed).toBe(true)
    expect(h.statuses()).toEqual(['connecting', 'closed']) // never reported open
  })

  it('emits closed once, however often it is called, and nothing after it', async () => {
    const h = await startOpen()
    await Promise.all([h.source.stop(), h.source.stop()])
    await h.source.stop()
    expect(h.statuses().filter((state) => state === 'closed')).toHaveLength(1)
    expect(h.events.at(-1)).toEqual({ type: 'status', state: 'closed' })
  })

  it('may be stopped by a listener of its own events', async () => {
    const h = createHarness()
    h.source.on('event', (event) => {
      if (event.type === 'status' && event.state === 'reconnecting') void h.source.stop()
    })
    await h.source.start()
    h.fake.last.drop()
    await settle()
    expect(h.lastStatus()).toEqual({ type: 'status', state: 'closed' })
    expect(h.clock.pending).toBe(0)
  })

  it('does nothing for a source that never started', async () => {
    const h = createHarness()
    await h.source.stop()
    expect(h.events).toEqual([])
  })
})

describe('secrets', () => {
  const SECRETS = ['test-sessdata', 'test-bili-jct', 'test-buvid3', 'test-danmu-token']

  it('puts the cookies into the Cookie header and nowhere else in what it hands the library', async () => {
    const h = await startOpen()
    const ws = h.fake.last.ws
    expect(ws?.headers?.Cookie).toBe(COOKIE_HEADER)
    const { headers = {}, ...rest } = ws ?? {}
    const carriers = Object.entries(headers)
      .filter(([, value]) => value.includes('test-sessdata'))
      .map(([name]) => name)
    expect(carriers).toEqual(['Cookie'])
    for (const cookie of ['test-sessdata', 'test-bili-jct', 'test-buvid3']) {
      expect(JSON.stringify(rest)).not.toContain(cookie)
    }
  })

  it('keeps cookies and the token out of every event and every log line, errors included', async () => {
    const h = await startOpen()
    const { handler } = h.fake.last
    handler.onIncomeDanmu?.(danmuMessage())
    handler.onIncomeDanmu?.(danmuMessage({ uid: 0, uname: 'a***' }))
    handler.onGift?.(giftMessage())
    handler.raw?.LOG_IN_NOTICE?.(LOG_IN_NOTICE)

    // A network stack that puts the request it failed on into its error message.
    h.api.nav = () => new Error(`proxy rejected the request: ${COOKIE_HEADER}`)
    h.fake.last.drop()
    await h.clock.advance(1_000)
    // ...and a listener factory that echoes the token it was given.
    h.fake.last.handler.onError?.(new Error('handshake failed for key test-danmu-token'))
    await h.clock.advance(2_000)

    const seen = JSON.stringify(h.events) + JSON.stringify(h.logs)
    for (const secret of SECRETS) expect(seen).not.toContain(secret)
    expect(seen).toContain('SESSDATA=***; bili_jct=***; buvid3=***') // redacted, not dropped
    expect(seen).toContain('handshake failed for key ***')
  })

  it('redacts a token echoed by the listener factory', async () => {
    const h = createHarness({
      listenerFactory: (_room, _handler, options) => {
        throw new Error(`cannot listen with key ${options?.ws?.key}`)
      },
    })
    await h.source.start()
    expect(h.lastStatus()?.detail).toBe('retry in 1 s (failure 1): cannot listen with key ***')
    expect(JSON.stringify(h.logs) + JSON.stringify(h.events)).not.toContain('test-danmu-token')
  })
})

describe('cookies that change while the source runs', () => {
  const generations: BilibiliCookies[] = [
    { sessdata: 'test-sessdata-one', biliJct: 'test-jct-one', buvid3: 'test-buvid3-one' },
    { sessdata: 'test-sessdata-two', biliJct: 'test-jct-two', buvid3: 'test-buvid3-two' },
  ]

  it('uses the current cookies for every attempt: header, login check, uid and token', async () => {
    let generation = 0
    let providerCalls = 0
    const h = createHarness({
      cookies: () => {
        providerCalls += 1
        return generations[generation] ?? {}
      },
    })
    const second = (cookie: string | undefined) => cookie?.includes('sessdata-two') === true
    h.api.nav = (call) => ({
      json: navReply({ loggedIn: true, uid: second(call.headers.cookie) ? 2222 : 1111 }),
    })
    h.api.danmuInfo = (call) => ({
      json: danmuInfoReply(second(call.headers.cookie) ? 'test-token-two' : 'test-token-one'),
    })

    await h.source.start()
    const first = h.fake.last
    expect(first.ws?.headers?.Cookie).toBe(
      'SESSDATA=test-sessdata-one; bili_jct=test-jct-one; buvid3=test-buvid3-one'
    )
    expect(first.ws).toMatchObject({ uid: 1111, key: 'test-token-one' })

    generation = 1 // the operator pasted a new key
    first.drop()
    await h.clock.advance(1_000)

    const next = h.fake.last
    expect(h.fake.connections).toHaveLength(2)
    expect(next.ws?.headers?.Cookie).toBe(
      'SESSDATA=test-sessdata-two; bili_jct=test-jct-two; buvid3=test-buvid3-two'
    )
    expect(next.ws).toMatchObject({ uid: 2222, key: 'test-token-two' })
    expect(providerCalls).toBe(2)
    expect(h.api.callsTo('nav').map((call) => call.headers.cookie)).toEqual([
      'SESSDATA=test-sessdata-one; bili_jct=test-jct-one; buvid3=test-buvid3-one',
      'SESSDATA=test-sessdata-two; bili_jct=test-jct-two; buvid3=test-buvid3-two',
    ])
  })

  it('goes back to a guest connection when the provider stops returning a session cookie', async () => {
    let cookies: BilibiliCookies = generations[0] ?? {}
    const h = createHarness({ cookies: () => cookies })
    await h.source.start()
    expect(h.fake.last.ws?.uid).toBe(4242)
    cookies = {}
    h.fake.last.drop()
    await h.clock.advance(1_000)
    expect(h.fake.last.ws?.uid).toBe(0)
    expect(h.fake.last.ws?.headers).not.toHaveProperty('Cookie')
    expect(h.api.callsTo('nav')).toHaveLength(1)
  })

  it('scrubs the cookies of earlier generations too', async () => {
    let generation = 0
    const h = createHarness({ cookies: () => generations[generation] ?? {} })
    await h.source.start()
    generation = 1
    h.fake.last.drop()
    await h.clock.advance(1_000)
    h.api.nav = () => new Error('rejected test-sessdata-one and test-sessdata-two')
    h.fake.last.drop()
    await h.clock.advance(2_000)
    const seen = JSON.stringify(h.events) + JSON.stringify(h.logs)
    expect(seen).not.toContain('test-sessdata-one')
    expect(seen).not.toContain('test-sessdata-two')
  })
})

describe('what the library does wrong', () => {
  it('contains a library callback that throws instead of letting it escape', async () => {
    const h = await startOpen()
    const { live } = h.fake.last
    live.on('DANMU_MSG', () => {
      throw new Error('parser bug')
    })
    expect(() => live.emit('DANMU_MSG', {})).not.toThrow()
    expect(
      h.logs.some((line) => line.level === 'error' && line.msg === 'a library callback threw')
    ).toBe(true)
  })

  it('keeps going when handling one message throws', async () => {
    const h = await startOpen()
    const { handler } = h.fake.last
    const broken = danmuMessage()
    Object.defineProperty(broken.body, 'content', {
      get() {
        throw new Error('bad payload')
      },
    })
    handler.onIncomeDanmu?.(broken)
    handler.onIncomeDanmu?.(danmuMessage({ text: 'still here' }))
    expect(h.ofType('danmaku').map((event) => event.text)).toEqual(['still here'])
    expect(h.logs.some((line) => line.msg === 'failed to handle a message')).toBe(true)
  })

  it('keeps delivering to the other listeners, and keeps running, when a listener throws', async () => {
    const h = createHarness()
    const seen: string[] = []
    h.source.on('event', () => {
      throw new Error('consumer bug')
    })
    h.source.on('event', (event) => seen.push(event.type))
    await h.source.start()
    h.fake.last.open()
    h.fake.last.handler.onIncomeDanmu?.(danmuMessage())
    expect(seen).toEqual(['status', 'status', 'danmaku'])
    expect(h.ofType('danmaku')).toHaveLength(1)
    expect(h.logs.filter((line) => line.msg === 'an event listener threw')).toHaveLength(3)
  })

  it('serves a listener that is registered with once() once', async () => {
    const h = createHarness()
    const seen: string[] = []
    h.source.once('event', (event) => seen.push(event.type))
    await h.source.start()
    h.fake.last.open()
    expect(seen).toEqual(['status'])
  })
})
