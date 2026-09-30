import { z } from 'zod'
import type { Clock } from './clock.ts'
import { describeError, isRecord } from './util.ts'
import { parseWbiKeys, signWbi, type WbiKeys } from './wbi.ts'

/**
 * The three public HTTP calls the source makes itself: room-init (long room id and owner uid), the nav
 * login check, and the signed connection-token request. All go through an injectable `fetch`, honour the
 * source's abort signal and time out on the injectable clock.
 */

/** A browser-like User-Agent. The token request is refused (code -352) without one. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const REQUEST_TIMEOUT_MS = 10_000

const ROOM_INIT_URL = 'https://api.live.bilibili.com/room/v1/Room/room_init'
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
const DANMU_INFO_URL = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo'

const CODE_ROOM_NOT_FOUND = 60004
const CODE_NOT_LOGGED_IN = -101
const NOT_LOGGED_IN_TEXT = /未登录|not\s+logged\s+in|not\s+login/i

export interface HttpDeps {
  fetch: typeof fetch
  clock: Clock
  signal: AbortSignal
}

/** Network failure, timeout, bad HTTP status or an unreadable body. */
export class HttpFailure extends Error {}

/** The room-init API says the room does not exist: retrying will not help. */
export class RoomNotFoundError extends Error {}

/** Headers for every request, and for the library's own requests (it forwards `ws.headers` untouched). */
export function requestHeaders(cookieHeader: string): Record<string, string> {
  return cookieHeader === ''
    ? { 'User-Agent': USER_AGENT }
    : { 'User-Agent': USER_AGENT, Cookie: cookieHeader }
}

/** Rejects as soon as `signal` aborts, even if `promise` (a fetch that ignores its signal) never settles. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

function asFailure(err: unknown, signal: AbortSignal, fallback?: string): HttpFailure {
  if (err instanceof HttpFailure) return err
  if (signal.aborted) {
    const reason: unknown = signal.reason
    return reason instanceof HttpFailure ? reason : new HttpFailure(describeError(reason))
  }
  return new HttpFailure(fallback ?? describeError(err))
}

async function requestJson(
  deps: HttpDeps,
  url: string,
  headers: Record<string, string>
): Promise<unknown> {
  const controller = new AbortController()
  const abortWithParent = (): void => controller.abort(deps.signal.reason)
  if (deps.signal.aborted) abortWithParent()
  else deps.signal.addEventListener('abort', abortWithParent, { once: true })
  const cancelTimer = deps.clock.setTimeout(() => {
    controller.abort(new HttpFailure(`request timed out after ${REQUEST_TIMEOUT_MS / 1000} s`))
  }, REQUEST_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await raceAbort(
        deps.fetch(url, { headers, signal: controller.signal }),
        controller.signal
      )
    } catch (err) {
      throw asFailure(err, controller.signal)
    }
    if (!response.ok) throw new HttpFailure(`HTTP ${response.status}`)
    try {
      return await raceAbort(response.json() as Promise<unknown>, controller.signal)
    } catch (err) {
      throw asFailure(err, controller.signal, 'response is not valid JSON')
    }
  } finally {
    cancelTimer()
    deps.signal.removeEventListener('abort', abortWithParent)
  }
}

/** The envelope every API answers with. `data` is validated per call: error answers put `[]` or null there. */
const Envelope = z.object({
  code: z.number(),
  message: z.string().optional(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
})

// ---- room-init

export interface ResolvedRoom {
  /** The long room id; the library needs it and short ids do not connect. */
  roomId: number
  /** Uid of the room's owner. */
  ownerUid: number
}

const RoomData = z.object({
  room_id: z.number().int().positive(),
  uid: z.number().int().nonnegative(),
})

export async function resolveRoom(deps: HttpDeps, roomId: number): Promise<ResolvedRoom> {
  const json = await requestJson(deps, `${ROOM_INIT_URL}?id=${roomId}`, requestHeaders(''))
  const envelope = Envelope.safeParse(json)
  if (!envelope.success) throw new HttpFailure('unexpected room-init response')
  if (envelope.data.code === CODE_ROOM_NOT_FOUND) {
    throw new RoomNotFoundError('The configured room does not exist.')
  }
  if (envelope.data.code !== 0) {
    throw new HttpFailure(`room-init answered code ${envelope.data.code}`)
  }
  const data = RoomData.safeParse(envelope.data.data)
  if (!data.success) throw new HttpFailure('room-init response has no room id')
  return { roomId: data.data.room_id, ownerUid: data.data.uid }
}

// ---- login check

export type LoginCheck =
  | { kind: 'logged_in'; uid: number; wbi: WbiKeys | null }
  | { kind: 'not_logged_in'; reason: string; wbi: WbiKeys | null }
  /** The check itself did not work (network, HTTP status, unexpected answer). Says nothing about the cookie. */
  | { kind: 'failed'; reason: string }

const NavData = z.object({
  isLogin: z.boolean().optional(),
  mid: z.number().optional(),
  wbi_img: z.object({ img_url: z.string(), sub_url: z.string() }).optional(),
})

/**
 * Ports the legacy `check_login`. The nav endpoint answers even for anonymous requests: code -101 with
 * `isLogin: false`, and it carries the signing keys either way.
 */
export async function checkLogin(deps: HttpDeps, cookieHeader: string): Promise<LoginCheck> {
  let json: unknown
  try {
    json = await requestJson(deps, NAV_URL, requestHeaders(cookieHeader))
  } catch (err) {
    return { kind: 'failed', reason: describeError(err) }
  }
  const envelope = Envelope.safeParse(json)
  if (!envelope.success) return { kind: 'failed', reason: 'unexpected nav response' }
  const { code } = envelope.data
  const message = envelope.data.message ?? envelope.data.msg ?? ''
  const parsed = NavData.safeParse(isRecord(envelope.data.data) ? envelope.data.data : {})
  const data: z.infer<typeof NavData> = parsed.success ? parsed.data : {}
  const wbi = data.wbi_img ? parseWbiKeys(data.wbi_img.img_url, data.wbi_img.sub_url) : null

  if (data.isLogin === true) {
    return typeof data.mid === 'number' && data.mid > 0
      ? { kind: 'logged_in', uid: data.mid, wbi }
      : { kind: 'failed', reason: 'logged-in answer without a uid' }
  }
  if (
    data.isLogin === false ||
    code === CODE_NOT_LOGGED_IN ||
    (code !== 0 && NOT_LOGGED_IN_TEXT.test(message))
  ) {
    return { kind: 'not_logged_in', reason: message === '' ? 'not logged in' : message, wbi }
  }
  return { kind: 'failed', reason: `nav answered code ${code}` }
}

// ---- connection token

const DanmuInfoData = z.object({ token: z.string().min(1) })

/**
 * The token the connection handshake needs, requested with the cookie the connection will use. The
 * token belongs to that cookie's identity, which is why it is fetched per attempt instead of taking the
 * library's process-wide cached one.
 */
export async function fetchDanmuToken(
  deps: HttpDeps,
  roomId: number,
  cookieHeader: string,
  wbi: WbiKeys
): Promise<string> {
  const query = signWbi({ id: roomId, type: 0 }, wbi, Math.floor(deps.clock.now() / 1000))
  const json = await requestJson(deps, `${DANMU_INFO_URL}?${query}`, requestHeaders(cookieHeader))
  const envelope = Envelope.safeParse(json)
  if (!envelope.success) throw new HttpFailure('unexpected getDanmuInfo response')
  if (envelope.data.code !== 0) {
    throw new HttpFailure(`getDanmuInfo answered code ${envelope.data.code}`)
  }
  const data = DanmuInfoData.safeParse(envelope.data.data)
  if (!data.success) throw new HttpFailure('getDanmuInfo response has no token')
  return data.data.token
}
