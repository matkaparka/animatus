import { describe, expect, it } from 'vitest'
import {
  checkLogin,
  fetchDanmuToken,
  HttpFailure,
  REQUEST_TIMEOUT_MS,
  resolveRoom,
  RoomNotFoundError,
  type HttpDeps,
} from '../../src/sources/bilibili/api.ts'
import { buildCookieHeader, cleanCookies } from '../../src/sources/bilibili/cookies.ts'
import { parseWbiKeys, signWbi, wbiMixinKey } from '../../src/sources/bilibili/wbi.ts'
import {
  COOKIE_HEADER,
  COOKIES,
  danmuInfoReply,
  FakeApi,
  FakeClock,
  FAKE_WBI_KEYS,
  navReply,
  roomInitReply,
} from './bilibili-helpers.ts'

function setup(signal: AbortSignal = new AbortController().signal) {
  const api = new FakeApi()
  const clock = new FakeClock()
  const deps: HttpDeps = { fetch: api.fetch, clock, signal }
  return { api, clock, deps }
}

describe('request signing', () => {
  // Example keys. The mixin key is the one the public write-ups of the scheme give for them.
  const keys = {
    imgKey: '7cd084941338484aae1ad9425b84077c',
    subKey: '4932caff0ff746eab6f01bf08b70ac45',
  }

  it('mixes the two key halves into the signing key', () => {
    expect(wbiMixinKey(keys)).toBe('ea1db124af3c7062474693fa704f4ff8')
  })

  it('signs a sorted query', () => {
    // Pinned from this implementation's output. The live API accepted requests signed this way and
    // answered a wrong w_rid with code -352.
    expect(signWbi({ foo: '114', bar: '514', baz: 1919810 }, keys, 1684746385)).toBe(
      'bar=514&baz=1919810&foo=114&wts=1684746385&w_rid=e06ec93bdc65c354c873296b3246e16e'
    )
  })

  it('strips the characters the platform strips and percent-encodes the rest', () => {
    const query = signWbi({ q: "a!b'c(d)e*f g" }, keys, 1)
    expect(query).toMatch(/^q=abcdef%20g&wts=1&w_rid=[0-9a-f]{32}$/)
  })

  it('reads the keys from the image URLs', () => {
    expect(
      parseWbiKeys(
        'https://example.invalid/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        'https://example.invalid/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
      )
    ).toEqual(keys)
  })

  it.each([
    ['a key that is too short', 'https://example.invalid/bfs/wbi/abc.png'],
    ['a key that is not hex', `https://example.invalid/bfs/wbi/${'z'.repeat(32)}.png`],
    ['no file name', 'https://example.invalid/bfs/wbi/'],
  ])('refuses %s', (_name, bad) => {
    expect(parseWbiKeys(bad, `https://example.invalid/${keys.subKey}.png`)).toBeNull()
    expect(parseWbiKeys(`https://example.invalid/${keys.imgKey}.png`, bad)).toBeNull()
  })
})

describe('cookies', () => {
  it('builds the header from the cookies that are present, in a fixed order', () => {
    expect(buildCookieHeader(COOKIES)).toBe(COOKIE_HEADER)
    expect(buildCookieHeader({ buvid3: 'test-only-one' })).toBe('buvid3=test-only-one')
    expect(buildCookieHeader({})).toBe('')
  })

  it('trims values and drops empty ones', () => {
    expect(cleanCookies({ sessdata: '  abc123  ', biliJct: '', buvid3: '   ' })).toEqual({
      cookies: { sessdata: 'abc123' },
      rejected: [],
    })
  })

  it('keeps the characters real values contain', () => {
    const sessdata = 'abcdef%2C1700000000%2Cfedcba*a1'
    expect(cleanCookies({ sessdata }).cookies.sessdata).toBe(sessdata)
  })

  it.each([
    ['a space inside', 'has space'],
    ['a semicolon', 'a;b'],
    ['a newline (header injection)', 'a\r\nX-Injected: 1'],
    ['a quote', 'a"b'],
    ['a comma', 'a,b'],
    ['non-ASCII text', 'café'],
  ])('drops a value with %s and reports only the name', (_name, value) => {
    const cleaned = cleanCookies({ sessdata: 'fine-value', biliJct: value })
    expect(cleaned.cookies).toEqual({ sessdata: 'fine-value' })
    expect(cleaned.rejected).toEqual(['biliJct'])
    expect(JSON.stringify(cleaned.rejected)).not.toContain(value)
  })
})

describe('checkLogin', () => {
  it('reports the uid and the signing keys of a logged-in cookie', async () => {
    const { api, deps } = setup()
    api.nav = () => ({ json: navReply({ loggedIn: true, uid: 4242 }) })
    expect(await checkLogin(deps, COOKIE_HEADER)).toEqual({
      kind: 'logged_in',
      uid: 4242,
      wbi: FAKE_WBI_KEYS,
    })
  })

  it('sends the browser identity and the cookie, and no cookie header when there is none', async () => {
    const { api, deps } = setup()
    await checkLogin(deps, COOKIE_HEADER)
    await checkLogin(deps, '')
    expect(api.calls[0]?.headers.cookie).toBe(COOKIE_HEADER)
    expect(api.calls[0]?.headers['user-agent']).toMatch(/^Mozilla\//)
    expect(api.calls[1]?.headers.cookie).toBeUndefined()
    expect(api.calls[1]?.headers['user-agent']).toMatch(/^Mozilla\//)
  })

  it('says not logged in for code -101 and still hands over the signing keys', async () => {
    const { api, deps } = setup()
    api.nav = () => ({ json: navReply({ loggedIn: false }) })
    expect(await checkLogin(deps, COOKIE_HEADER)).toEqual({
      kind: 'not_logged_in',
      reason: 'not logged in',
      wbi: FAKE_WBI_KEYS,
    })
  })

  it("recognises the platform's own not-logged-in text under another code", async () => {
    const { api, deps } = setup()
    // "not logged in", in the platform's own words.
    api.nav = () => ({ json: { code: -400, message: '账号未登录', data: null } })
    expect(await checkLogin(deps, COOKIE_HEADER)).toMatchObject({ kind: 'not_logged_in' })
  })

  it('does not blame the cookie for a rate limit or a risk-control answer', async () => {
    const { api, deps } = setup()
    api.nav = () => ({ json: { code: -352, message: 'risk control', data: null } })
    expect(await checkLogin(deps, COOKIE_HEADER)).toEqual({
      kind: 'failed',
      reason: 'nav answered code -352',
    })
  })

  it('does not trust a logged-in answer without a uid', async () => {
    const { api, deps } = setup()
    api.nav = () => ({ json: { code: 0, data: { isLogin: true } } })
    expect(await checkLogin(deps, COOKIE_HEADER)).toMatchObject({ kind: 'failed' })
  })

  it.each([
    ['a network error', new Error('connect ECONNREFUSED'), 'connect ECONNREFUSED'],
    ['an HTTP error status', { status: 412, json: {} }, 'HTTP 412'],
    ['a body that is not JSON', { text: '<html>blocked</html>' }, 'response is not valid JSON'],
    ['a body of the wrong shape', { json: 'nope' }, 'unexpected nav response'],
  ] as const)('is a failed check, not a verdict, on %s', async (_name, reply, reason) => {
    const { api, deps } = setup()
    api.nav = () => reply
    expect(await checkLogin(deps, COOKIE_HEADER)).toEqual({ kind: 'failed', reason })
  })

  it('gives up on a request that never answers after the timeout, and cancels its timer', async () => {
    const { api, clock, deps } = setup()
    api.nav = () => 'hang'
    const pending = checkLogin(deps, COOKIE_HEADER)
    await clock.advance(REQUEST_TIMEOUT_MS - 1)
    expect(clock.pending).toBe(1)
    await clock.advance(1)
    expect(await pending).toEqual({ kind: 'failed', reason: 'request timed out after 10 s' })
    expect(clock.pending).toBe(0)
  })

  it('stops waiting when the source is stopped', async () => {
    const controller = new AbortController()
    const { api, clock, deps } = setup(controller.signal)
    api.nav = () => 'hang'
    const pending = checkLogin(deps, COOKIE_HEADER)
    controller.abort(new Error('source stopped'))
    expect(await pending).toEqual({ kind: 'failed', reason: 'source stopped' })
    expect(clock.pending).toBe(0)
  })
})

describe('resolveRoom', () => {
  it('turns a short id into the long id and returns the owner uid', async () => {
    const { api, deps } = setup()
    expect(await resolveRoom(deps, 7)).toEqual({ roomId: 424242, ownerUid: 555001 })
    const call = api.callsTo('room_init')[0]
    expect(call?.query.get('id')).toBe('7')
    expect(call?.headers.cookie).toBeUndefined()
  })

  it('says the room does not exist for code 60004 (whose data is an empty array)', async () => {
    const { api, deps } = setup()
    api.room = () => ({ json: { code: 60004, msg: 'x', message: 'x', data: [] } })
    await expect(resolveRoom(deps, 7)).rejects.toBeInstanceOf(RoomNotFoundError)
  })

  it.each([
    ['another error code', { json: { code: -412, message: 'x', data: null } }, /code -412/],
    ['an answer without a room id', { json: { code: 0, data: [] } }, /no room id/],
    ['a room id of zero', { json: roomInitReply({ room_id: 0 }) }, /no room id/],
    ['an HTTP error', { status: 502, json: {} }, /HTTP 502/],
    ['a network error', new Error('getaddrinfo ENOTFOUND'), /ENOTFOUND/],
  ] as const)('fails on %s', async (_name, reply, message) => {
    const { api, deps } = setup()
    api.room = () => reply
    const failure = await resolveRoom(deps, 7).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(HttpFailure)
    expect((failure as Error).message).toMatch(message)
  })
})

describe('fetchDanmuToken', () => {
  it('asks for the token of the long room id, signed, with the cookie', async () => {
    const { api, clock, deps } = setup()
    api.danmuInfo = () => ({ json: danmuInfoReply('test-token-value') })
    const token = await fetchDanmuToken(deps, 424242, COOKIE_HEADER, FAKE_WBI_KEYS)
    expect(token).toBe('test-token-value')

    const call = api.callsTo('getDanmuInfo')[0]
    const nowSec = Math.floor(clock.now() / 1000)
    expect(call?.query.get('id')).toBe('424242')
    expect(call?.query.get('type')).toBe('0')
    expect(call?.query.get('wts')).toBe(String(nowSec))
    expect(call?.query.get('w_rid')).toMatch(/^[0-9a-f]{32}$/)
    expect(call?.url.split('?')[1]).toBe(signWbi({ id: 424242, type: 0 }, FAKE_WBI_KEYS, nowSec))
    expect(call?.headers.cookie).toBe(COOKIE_HEADER)
    expect(call?.headers['user-agent']).toMatch(/^Mozilla\//)
  })

  it.each([
    ['a refused request', { json: { code: -352, message: 'x', data: null } }, /code -352/],
    ['an answer without a token', { json: { code: 0, data: { token: '' } } }, /no token/],
    ['an unexpected answer', { json: 'nope' }, /unexpected/],
  ] as const)('rejects on %s', async (_name, reply, message) => {
    const { api, deps } = setup()
    api.danmuInfo = () => reply
    await expect(fetchDanmuToken(deps, 1, '', FAKE_WBI_KEYS)).rejects.toThrow(message)
  })
})
