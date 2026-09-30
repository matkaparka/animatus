import { EventEmitter } from 'node:events'
import type {
  AttentionChangeMsg,
  DanmuMsg,
  GiftMsg,
  GuardBuyMsg,
  Message,
  MessageListener,
  MsgHandler,
  SuperChatMsg,
  UserActionMsg,
  startListen,
} from 'blive-message-listener'
import type { SEND_GIFT_V2 } from 'tiny-bilibili-ws'
import { z } from 'zod'
import type { Clock } from '../../src/sources/bilibili/clock.ts'
import { BilibiliSource } from '../../src/sources/bilibili/source.ts'
import type {
  BilibiliCookies,
  BilibiliSourceEvent,
  BilibiliSourceOptions,
  ListenOptions,
  LogLevel,
} from '../../src/sources/bilibili/types.ts'

// ---------------------------------------------------------------- clock

/** Never touches the real time. `advance` runs due timers in order and lets promises settle in between. */
export class FakeClock implements Clock {
  private current: number
  private nextId = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()

  constructor(start = 1_700_000_000_000) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.nextId++
    this.timers.set(id, { at: this.current + Math.max(0, ms), fn })
    return () => {
      this.timers.delete(id)
    }
  }

  /** Timers that are waiting. */
  get pending(): number {
    return this.timers.size
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms
    for (;;) {
      await settle()
      let nextId: number | undefined
      let nextAt = Infinity
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at
          nextId = id
        }
      }
      if (nextId === undefined) break
      const timer = this.timers.get(nextId)
      this.timers.delete(nextId)
      if (!timer) break
      this.current = Math.max(this.current, timer.at)
      timer.fn()
    }
    this.current = target
    await settle()
  }
}

/** Lets every promise continuation that does not depend on real I/O run (a few turns, for body streams). */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) await new Promise<void>((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------- fake HTTP

export interface FetchCall {
  url: string
  path: string
  query: URLSearchParams
  /** Header names are lower-cased. */
  headers: Record<string, string>
}

/** `hang` never answers (until the caller gives up); an Error is a network failure. */
export type Reply = { status?: number; json?: unknown; text?: string } | Error | 'hang'

/** Obviously fake signing keys, and the shape in which the nav response carries them. */
export const FAKE_WBI_KEYS = {
  imgKey: '00112233445566778899aabbccddeeff',
  subKey: 'ffeeddccbbaa99887766554433221100',
}
const WBI_IMG = {
  img_url: `https://example.invalid/bfs/wbi/${FAKE_WBI_KEYS.imgKey}.png`,
  sub_url: `https://example.invalid/bfs/wbi/${FAKE_WBI_KEYS.subKey}.png`,
}

export function roomInitReply(over: { room_id?: number; short_id?: number; uid?: number } = {}) {
  return {
    code: 0,
    msg: 'ok',
    message: 'ok',
    data: { room_id: 424242, short_id: 7, uid: 555001, live_status: 0, ...over },
  }
}

export function navReply(state: { loggedIn: true; uid: number } | { loggedIn: false }) {
  return state.loggedIn
    ? { code: 0, message: '0', ttl: 1, data: { isLogin: true, mid: state.uid, wbi_img: WBI_IMG } }
    : {
        code: -101,
        message: 'not logged in',
        ttl: 1,
        data: { isLogin: false, wbi_img: WBI_IMG },
      }
}

export function danmuInfoReply(token: string) {
  return { code: 0, message: '0', data: { token, host_list: [] } }
}

export class FakeApi {
  readonly calls: FetchCall[] = []
  room: (call: FetchCall) => Reply = () => ({ json: roomInitReply() })
  nav: (call: FetchCall) => Reply = () => ({ json: navReply({ loggedIn: true, uid: 4242 }) })
  danmuInfo: (call: FetchCall) => Reply = () => ({ json: danmuInfoReply('test-danmu-token') })

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    const call: FetchCall = { url: url.href, path: url.pathname, query: url.searchParams, headers }
    this.calls.push(call)
    const reply = this.route(call)
    if (reply === 'hang') return new Promise<Response>(() => {})
    if (reply instanceof Error) return Promise.reject(reply)
    const body = reply.text ?? JSON.stringify(reply.json ?? null)
    return Promise.resolve(new Response(body, { status: reply.status ?? 200 }))
  }

  callsTo(path: 'room_init' | 'nav' | 'getDanmuInfo'): FetchCall[] {
    const suffix = { room_init: '/room_init', nav: '/nav', getDanmuInfo: '/getDanmuInfo' }[path]
    return this.calls.filter((call) => call.path.endsWith(suffix))
  }

  private route(call: FetchCall): Reply {
    if (call.path.endsWith('/room_init')) return this.room(call)
    if (call.path.endsWith('/nav')) return this.nav(call)
    if (call.path.endsWith('/getDanmuInfo')) return this.danmuInfo(call)
    return new Error(`unexpected request to ${call.path}`)
  }
}

// ---------------------------------------------------------------- fake library

export class FakeSocket {
  destroyed = false
  private readonly onDestroyed: () => void

  constructor(onDestroyed: () => void) {
    this.onDestroyed = onDestroyed
  }

  /** Like a real socket: destroying it ends up in the library's `close` callback. */
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      queueMicrotask(this.onDestroyed)
    }
    return this
  }
}

/** Stands in for the library's `KeepLiveTCP`: an emitter with a socket. */
export class FakeLive extends EventEmitter {
  tcpSocket: FakeSocket | null = null
}

export interface FakeConnection {
  roomId: number
  handler: MsgHandler
  options: ListenOptions | undefined
  ws: ListenOptions['ws']
  live: FakeLive
  /** How often the source called the listener's `close()`. */
  closeCalls: number
  /** Gives the connection a socket, as the library does once it got as far as connecting. */
  attachSocket(): FakeSocket
  /** The transport came up: the library's `onOpen`. */
  open(): void
  /** The transport went away: the library's `onClose`. */
  drop(): void
}

export function createFakeFactory() {
  const connections: FakeConnection[] = []
  const factory: typeof startListen = (roomId, handler, options) => {
    const live = new FakeLive()
    const connection: FakeConnection = {
      roomId,
      handler,
      options,
      ws: options?.ws,
      live,
      closeCalls: 0,
      attachSocket: () => {
        const socket = new FakeSocket(() => handler.onClose?.())
        live.tcpSocket = socket
        return socket
      },
      open: () => handler.onOpen?.(),
      drop: () => handler.onClose?.(),
    }
    connection.attachSocket()
    connections.push(connection)
    // Only what the source touches is real. `roomId` is 0 like in the real library (a snapshot taken too early).
    const listener = {
      live,
      roomId: 0,
      online: 0,
      closed: false,
      close: () => {
        connection.closeCalls += 1
      },
      getAttention: async () => 0,
      getOnline: async () => 0,
      reconnect: () => {},
      heartbeat: () => {},
      send: () => {},
    }
    return listener as unknown as MessageListener
  }
  return {
    factory,
    connections,
    get last(): FakeConnection {
      const connection = connections.at(-1)
      if (!connection) throw new Error('the source has not created a listener yet')
      return connection
    },
  }
}

// ---------------------------------------------------------------- message fixtures

let sequence = 0

function message<T>(type: string, body: T, raw: unknown): Message<T> {
  return { id: `test-${++sequence}`, timestamp: 1_700_000_000_000, type, body, raw }
}

export interface DanmuFixture {
  uid?: number
  uname?: string
  text?: string
  admin?: boolean
  /** The library's `emoticon` object is present. */
  sticker?: boolean
  /** `info[0][12]` of the raw command. `null` leaves the field out. Defaults to 1 for stickers, else 0. */
  rawDmType?: number | null
}

/**
 * The typed body follows `DanmuMsg`. The raw command only fills the positions the source reads. Those
 * positions (`info[0][12]` = dm_type, `info[2][2]` = moderator flag) match a live capture; the values are made up.
 */
export function danmuMessage(over: DanmuFixture = {}): Message<DanmuMsg> {
  const uid = over.uid ?? 1001
  const uname = over.uname ?? 'viewer-a'
  const text = over.text ?? 'hello'
  const admin = over.admin ?? false
  const sticker = over.sticker ?? false
  const dmType = over.rawDmType === null ? undefined : (over.rawDmType ?? (sticker ? 1 : 0))
  const body: DanmuMsg = {
    user: { uid, uname, identity: { rank: 0, guard_level: 0, room_admin: admin } },
    content: text,
    type: 1, // display mode (scrolling). It is not the sticker flag.
    content_color: '#ffffff',
    timestamp: 1_700_000_000_000,
    lottery: false,
    ...(sticker
      ? {
          emoticon: {
            id: 'test-sticker',
            height: 60,
            width: 60,
            url: 'https://example.invalid/sticker.png',
          },
        }
      : {}),
  }
  const head: unknown[] = new Array(18).fill(0)
  head[1] = 1
  head[12] = dmType
  const raw = {
    cmd: 'DANMU_MSG',
    info: [head, text, [uid, uname, admin ? 1 : 0, 0, 0, 10000, 1, '']],
    dm_v2: '',
  }
  return message('DANMU_MSG', body, raw)
}

export interface GiftFixture {
  uid?: number
  uname?: string
  gift?: string
  giftId?: number
  amount?: number
  coin?: 'gold' | 'silver'
  price?: number
  /** `data.total_coin` of the raw command. `null` leaves the field out. */
  totalCoin?: number | null
  /** `data.rnd` of the raw command (the transaction id). `null` leaves the field out. */
  rnd?: string | null
}

/** `SEND_GIFT`. Guessed: the raw `data` keys other than the ones the library reads (`total_coin`, `rnd`). */
export function giftMessage(over: GiftFixture = {}): Message<GiftMsg> {
  const uid = over.uid ?? 2002
  const amount = over.amount ?? 1
  const price = over.price ?? 1000
  const body: GiftMsg = {
    user: { uid, uname: over.uname ?? 'viewer-b' },
    gift_id: over.giftId ?? 31036,
    gift_name: over.gift ?? 'test gift',
    coin_type: over.coin ?? 'gold',
    price,
    amount,
  }
  const data: Record<string, unknown> = {
    giftName: body.gift_name,
    num: amount,
    uid,
    price,
    coin_type: body.coin_type,
    giftId: body.gift_id,
  }
  if (over.totalCoin !== null) data.total_coin = over.totalCoin ?? price * amount
  if (over.rnd !== null) data.rnd = over.rnd ?? 'test-rnd-1'
  return message('SEND_GIFT', body, { cmd: 'SEND_GIFT', data })
}

/** `SEND_GIFT_V2` as the library hands it to a `raw` handler, typed with the library's own interface. */
export function giftV2Raw(over: Partial<SEND_GIFT_V2['data']> = {}): SEND_GIFT_V2 {
  return {
    cmd: 'SEND_GIFT_V2',
    data: {
      dmscore: 0,
      gift_id: 31036,
      gift_name: 'test gift',
      num: 1,
      gift_type: 0,
      price: 1000,
      total_coin: 1000,
      coin_type: 'gold',
      tid: 'test-tid-1',
      timestamp: 1_700_000_000,
      rnd: 'test-rnd-1',
      action: 'gift',
      gift_img_basic: '',
      uid: 2002,
      uname: 'viewer-b',
      face: '',
      guard_level: 0,
      medal_level: 0,
      medal_name: '',
      medal_room_id: 0,
      medal_ruid: 0,
      blind_gift_name: '',
      blind_price: 0,
      ...over,
    },
  }
}

export interface GuardFixture {
  uid?: number
  uname?: string
  level?: number
  /** `data.num` of the raw command (months). `null` leaves the field out. */
  num?: number | null
}

/** `GUARD_BUY`. The month count is only in the raw command; the library's body has no such field. */
export function guardMessage(over: GuardFixture = {}): Message<GuardBuyMsg> {
  const uid = over.uid ?? 3003
  const uname = over.uname ?? 'viewer-c'
  const level = over.level ?? 3
  const body: GuardBuyMsg = {
    user: { uid, uname },
    gift_id: 10003,
    gift_name: 'test guard',
    guard_level: level as GuardBuyMsg['guard_level'],
    price: 198000,
    start_time: 1_700_000_000,
    end_time: 1_702_592_000,
  }
  const data: Record<string, unknown> = {
    uid,
    username: uname,
    guard_level: level,
    price: 198000,
    gift_id: 10003,
    gift_name: 'test guard',
  }
  if (over.num !== null) data.num = over.num ?? 1
  return message('GUARD_BUY', body, { cmd: 'GUARD_BUY', data })
}

export interface SuperChatFixture {
  uid?: number
  uname?: string
  price?: number
  text?: string
}

export function superChatMessage(over: SuperChatFixture = {}): Message<SuperChatMsg> {
  return message(
    'SUPER_CHAT_MESSAGE',
    {
      id: 1,
      user: {
        uid: over.uid ?? 4004,
        uname: over.uname ?? 'viewer-d',
        identity: { rank: 0, guard_level: 0, room_admin: false },
      },
      content: over.text ?? 'test super chat',
      content_color: '#ffffff',
      price: over.price ?? 30,
      time: 60,
    },
    { cmd: 'SUPER_CHAT_MESSAGE' }
  )
}

export function userActionMessage(
  action: UserActionMsg['action'],
  over: { uid?: number; uname?: string } = {}
): Message<UserActionMsg> {
  return message(
    'INTERACT_WORD',
    {
      user: { uid: over.uid ?? 5005, uname: over.uname ?? 'viewer-e' },
      action,
      timestamp: 1_700_000_000_000,
    },
    { cmd: 'INTERACT_WORD' }
  )
}

/** The server's answer to a heartbeat. */
export function heartbeatMessage(): Message<AttentionChangeMsg> {
  return message('heartbeat', { attention: 100 }, 100)
}

// ---------------------------------------------------------------- event contract

const uid = z.number().int().nonnegative()

/** The contract of the events, strict so that an extra field (a leaked raw payload, say) fails. */
export const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('danmaku'),
    uid,
    uname: z.string(),
    text: z.string(),
    dmType: z.number().int(),
    admin: z.boolean(),
    roomOwnerUid: uid,
    ts: z.number(),
  }),
  z.strictObject({
    type: z.literal('gift'),
    uid,
    uname: z.string(),
    gift: z.string().min(1),
    num: z.number().int().positive(),
    coinType: z.enum(['gold', 'silver']),
    totalCoin: z.number().nonnegative(),
    ts: z.number(),
  }),
  z.strictObject({
    type: z.literal('guard'),
    uid,
    uname: z.string(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    num: z.number().int().positive(),
    ts: z.number(),
  }),
  z.strictObject({
    type: z.literal('superchat'),
    uid,
    uname: z.string(),
    price: z.number().nonnegative(),
    text: z.string(),
    ts: z.number(),
  }),
  z.strictObject({ type: z.literal('enter'), uid, uname: z.string(), ts: z.number() }),
  z.strictObject({
    type: z.literal('alarm'),
    code: z.enum(['cookie_invalid', 'masked_names', 'guest_connection', 'connection_lost']),
    message: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('status'),
    state: z.enum(['connecting', 'open', 'closed', 'reconnecting']),
    detail: z.string().optional(),
  }),
])

// ---------------------------------------------------------------- harness

/** Obviously fake cookies. */
export const COOKIES: BilibiliCookies = {
  sessdata: 'test-sessdata',
  biliJct: 'test-bili-jct',
  buvid3: 'test-buvid3',
}
export const COOKIE_HEADER = 'SESSDATA=test-sessdata; bili_jct=test-bili-jct; buvid3=test-buvid3'

export interface LogLine {
  level: LogLevel
  msg: string
  extra?: Record<string, unknown>
}

export interface HarnessOptions {
  roomId?: number
  /** Undefined: the test cookies. Null: no cookie provider at all. */
  cookies?: BilibiliCookies | (() => Promise<BilibiliCookies> | BilibiliCookies) | null
  reconnect?: BilibiliSourceOptions['reconnect']
  listenerFactory?: BilibiliSourceOptions['listenerFactory']
}

type EventOf<T extends BilibiliSourceEvent['type']> = Extract<BilibiliSourceEvent, { type: T }>

export function createHarness(options: HarnessOptions = {}) {
  const clock = new FakeClock()
  const api = new FakeApi()
  const fake = createFakeFactory()
  const logs: LogLine[] = []
  const events: BilibiliSourceEvent[] = []
  const cookies = options.cookies
  const getCookies =
    cookies === null
      ? undefined
      : typeof cookies === 'function'
        ? cookies
        : () => cookies ?? COOKIES
  const source = new BilibiliSource({
    roomId: options.roomId ?? 7,
    getCookies,
    reconnect: options.reconnect,
    clock,
    fetch: api.fetch,
    listenerFactory: options.listenerFactory ?? fake.factory,
    logger: (level, msg, extra) => logs.push({ level, msg, extra }),
  })
  source.on('event', (event) => events.push(event))

  const ofType = <T extends BilibiliSourceEvent['type']>(type: T): EventOf<T>[] =>
    events.filter((event): event is EventOf<T> => event.type === type)

  return {
    clock,
    api,
    fake,
    logs,
    events,
    source,
    ofType,
    /** The `state` of every status event so far. */
    statuses: () => ofType('status').map((event) => event.state),
    /** The `code` of every alarm so far. */
    alarms: () => ofType('alarm').map((event) => event.code),
    lastStatus: () => ofType('status').at(-1),
  }
}
