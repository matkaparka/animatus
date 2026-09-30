import { afterEach, describe, expect, it } from 'vitest'
import { GeminiProvider } from '../../src/llm/gemini.ts'
import { LlmGateway } from '../../src/llm/gateway.ts'
import type { LlmLogLevel } from '../../src/llm/gateway.ts'
import { OpenAiProvider } from '../../src/llm/openai.ts'
import { LlmError } from '../../src/llm/types.ts'
import type { LlmDelta, LlmErrorCode } from '../../src/llm/types.ts'
import {
  DONE,
  closeAllServers,
  collect,
  gDone,
  gText,
  oStop,
  oText,
  sendJson,
  sleep,
  sse,
  startServer,
  startSse,
} from './support/mocks.ts'
import {
  clock,
  fails,
  failsAfter,
  fake,
  gate,
  req,
  says,
  silent,
  text,
  thinking,
  tracked,
  usage,
} from './support/fakes.ts'
import type { FakeProvider } from './support/fakes.ts'

const MIN = 60_000

afterEach(closeAllServers)

const providerOf = (gw: LlmGateway, i: number) => gw.stats().providers[i]!

async function failureOf(gw: LlmGateway, r = req()) {
  const out = await collect(gw.stream(r))
  expect(out.error, 'expected the stream to fail').toBeInstanceOf(LlmError)
  return { error: out.error as LlmError, deltas: out.deltas }
}

describe('LlmGateway construction', () => {
  it('validates providers and order', () => {
    const a = fake('a', says('x'))
    const a2 = fake('a', says('y'))
    expect(() => new LlmGateway({ providers: [a, a2], order: ['a'] })).toThrow(
      /duplicate LLM provider id 'a'/
    )
    expect(() => new LlmGateway({ providers: [a], order: [] })).toThrow(/order is empty/)
    expect(() => new LlmGateway({ providers: [a], order: ['nope'] })).toThrow(
      /unknown provider 'nope'/
    )
    expect(() => new LlmGateway({ providers: [a], order: ['a', 'a'] })).toThrow(/twice/)
  })

  it('only uses providers that are in the order, in that order', async () => {
    const a = fake('a', says('from a'))
    const b = fake('b', says('from b'))
    const c = fake('c', says('from c'))
    const gw = new LlmGateway({ providers: [a, b, c], order: ['c', 'a'] })
    expect(gw.order).toEqual(['c', 'a'])
    expect(await gw.complete(req())).toBe('from c')
    expect([a.calls, b.calls, c.calls]).toEqual([0, 0, 1])
    expect(gw.stats().providers.map((p) => p.id)).toEqual(['c', 'a'])
  })
})

describe('LlmGateway fallback', () => {
  it('serves from the first provider and never touches the others', async () => {
    const a = fake('a', says('Hel', 'lo'))
    const b = fake('b', says('other'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    const out = await collect(gw.stream(req()))
    expect(out.text).toBe('Hello')
    expect(out.error).toBeUndefined()
    expect(b.calls).toBe(0)
  })

  it('passes the request through unchanged', async () => {
    const a = fake('a', says('x'))
    const gw = new LlmGateway({ providers: [a], order: ['a'] })
    const signal = new AbortController().signal
    const r = req({ temperature: 0.4, maxOutputTokens: 10, timeoutMs: 999, tag: 'chat', signal })
    await gw.complete(r)
    expect(a.requests[0]).toBe(r)
  })

  it.each<LlmErrorCode>([
    'quota',
    'rate_limit',
    'unavailable',
    'timeout',
    'auth',
    'bad_request',
    'protocol',
  ])('falls back to the next provider after %s before any text', async (code) => {
    const a = fake('a', fails(code))
    const b = fake('b', says('from b'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    const out = await collect(gw.stream(req()))
    expect(out.error).toBeUndefined()
    expect(out.text).toBe('from b')
    expect([a.calls, b.calls]).toEqual([1, 1])
  })

  it('walks the whole order and reports each provider when all of them fail', async () => {
    const a = fake('a', fails('quota', { status: 429 }))
    const b = fake('b', fails('timeout'))
    const c = fake('c', fails('auth', { status: 401 }))
    const gw = new LlmGateway({ providers: [a, b, c], order: ['a', 'b', 'c'] })
    const { error, deltas } = await failureOf(gw)
    expect(deltas).toEqual([])
    expect(error.code).toBe('unavailable')
    expect(error.retryable).toBe(true)
    expect(error.message).toBe(
      'all LLM providers failed: a=quota (HTTP 429), b=timeout, c=auth (HTTP 401)'
    )
    expect(error.attempts).toMatchObject([
      { providerId: 'a', outcome: 'error', code: 'quota', status: 429 },
      { providerId: 'b', outcome: 'error', code: 'timeout' },
      { providerId: 'c', outcome: 'error', code: 'auth', status: 401 },
    ])
    // what each provider said travels with the attempt, so the operator sees more than a code
    for (const a of error.attempts ?? []) expect(a.detail).toBeTypeOf('string')
    expect([a.calls, b.calls, c.calls]).toEqual([1, 1, 1])
  })

  it('does not fall back after the first text delta: the error reaches the consumer as it is', async () => {
    const original = new LlmError('unavailable', 'connection dropped', { providerId: 'a' })
    const a = fake('a', async function* () {
      yield text('Hel')
      yield text('lo, ')
      throw original
    })
    const b = fake('b', says('must not be used'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    const out = await collect(gw.stream(req()))
    expect(out.text).toBe('Hello, ')
    expect(out.error).toBe(original)
    expect(b.calls).toBe(0)
    expect(providerOf(gw, 0).failures).toBe(1)
    expect(providerOf(gw, 1).requests).toBe(0)
  })

  it('still cools the provider down after such a mid-answer failure', async () => {
    const c = clock()
    const a = fake('a', failsAfter(['partial'], 'timeout'))
    const b = fake('b', says('from b'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'], now: c.now })
    await collect(gw.stream(req()))
    expect(await gw.complete(req())).toBe('from b')
    expect(a.calls).toBe(1)
  })

  it('does fall back when only thinking was produced before the failure', async () => {
    const a = fake('a', failsAfter([thinking('hmm'), usage(3, 0)], 'unavailable'))
    const b = fake('b', says('answer'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    const out = await collect(gw.stream(req()))
    expect(out.error).toBeUndefined()
    expect(out.thinking).toBe('hmm')
    expect(out.text).toBe('answer')
  })

  it('counts an empty text delta as no text', async () => {
    const a = fake('a', says(text(''), thinking('only thoughts')))
    const b = fake('b', says('real answer'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    expect(await gw.complete(req())).toBe('real answer')
    expect(a.calls).toBe(1)
  })

  it('treats a provider that finishes without any text as failed (protocol)', async () => {
    const a = fake('a', silent)
    const b = fake('b', says('from b'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    expect(await gw.complete(req())).toBe('from b')
    expect(providerOf(gw, 0).lastError?.code).toBe('protocol')

    const only = new LlmGateway({ providers: [fake('a', silent)], order: ['a'] })
    const { error } = await failureOf(only)
    expect(error.message).toBe('all LLM providers failed: a=protocol')
  })

  it('turns a plain exception from a provider into an unavailable failure and falls back', async () => {
    const a = fake('a', async function* () {
      throw new TypeError('something broke inside the provider')
    })
    const b = fake('b', says('from b'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    expect(await gw.complete(req())).toBe('from b')
    expect(providerOf(gw, 0).lastError?.code).toBe('unavailable')
  })

  it('stops at once when the caller aborts, without trying another provider', async () => {
    const controller = new AbortController()
    const a = fake('a', async function* (r) {
      yield text('start ')
      controller.abort()
      throw new LlmError('aborted', 'request aborted', { providerId: 'a' })
    })
    const b = fake('b', says('must not run'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    const out = await collect(gw.stream(req({ signal: controller.signal })))
    expect((out.error as LlmError).code).toBe('aborted')
    expect(b.calls).toBe(0)
    const s = providerOf(gw, 0)
    expect([s.aborted, s.failures, s.successes]).toEqual([1, 0, 0])
    expect(s.cooldownUntil).toBeUndefined()
  })

  it('reports an abort even when the provider failed with something else at that moment', async () => {
    const controller = new AbortController()
    const a = fake('a', async function* () {
      controller.abort()
      throw new LlmError('unavailable', 'socket closed', { providerId: 'a' })
    })
    const b = fake('b', says('must not run'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    const { error } = await failureOf(gw, req({ signal: controller.signal }))
    expect(error.code).toBe('aborted')
    expect(b.calls).toBe(0)
  })

  it('does not call any provider when the signal is already aborted', async () => {
    const a = fake('a', says('x'))
    const gw = new LlmGateway({ providers: [a], order: ['a'] })
    const { error } = await failureOf(gw, req({ signal: AbortSignal.abort() }))
    expect(error.code).toBe('aborted')
    expect(a.calls).toBe(0)
  })

  it('closes the provider stream when the consumer stops reading, and counts it as aborted', async () => {
    const a: FakeProvider = fake('a', (r, call) =>
      tracked(a, says('one ', 'two ', 'three'))(r, call)
    )
    const gw = new LlmGateway({ providers: [a], order: ['a'] })
    for await (const d of gw.stream(req({ tag: 'chat' }))) {
      if (d.type === 'text') break
    }
    expect(a.abandoned).toBe(1) // the provider's own stream was closed, not left running
    const s = providerOf(gw, 0)
    expect([s.requests, s.aborted, s.failures, s.successes]).toEqual([1, 1, 0, 0])
    expect(gw.stats().tags.chat).toMatchObject({
      requests: 1,
      aborted: 1,
      failures: 0,
      successes: 0,
    })
  })

  it('runs concurrent requests independently', async () => {
    const g1 = gate()
    const a = fake('a', async function* (_r, call) {
      if (call === 1) await g1.promise
      yield text(`reply ${call}`)
    })
    const gw = new LlmGateway({ providers: [a], order: ['a'] })
    const first = gw.complete(req())
    const second = await gw.complete(req())
    g1.open()
    expect(second).toBe('reply 2')
    expect(await first).toBe('reply 1')
    expect(providerOf(gw, 0)).toMatchObject({ requests: 2, successes: 2 })
  })
})

describe('LlmGateway cooldown', () => {
  const setup = (
    code: LlmErrorCode,
    cooldownMs?: ConstructorParameters<typeof LlmGateway>[0]['cooldownMs']
  ) => {
    const c = clock()
    const a = fake('a', fails(code))
    const b = fake('b', says('from b'))
    const gw = new LlmGateway({
      providers: [a, b],
      order: ['a', 'b'],
      now: c.now,
      ...(cooldownMs ? { cooldownMs } : {}),
    })
    return { c, a, b, gw }
  }

  it('skips a provider for 30 minutes after quota, then tries it again (injected clock)', async () => {
    const { c, a, gw } = setup('quota')
    const t0 = c.t
    expect(await gw.complete(req())).toBe('from b')
    expect(a.calls).toBe(1)
    expect(providerOf(gw, 0).cooldownUntil).toBe(t0 + 30 * MIN)

    c.advance(29 * MIN + 59_000)
    expect(await gw.complete(req())).toBe('from b')
    expect(a.calls).toBe(1) // still cooling down
    expect(providerOf(gw, 0).requests).toBe(1)

    c.advance(2_000) // 30 min + 1 s since the failure
    expect(providerOf(gw, 0).cooldownUntil).toBeUndefined()
    await gw.complete(req())
    expect(a.calls).toBe(2) // eligible again (and fails again, which starts a new cooldown)
    expect(providerOf(gw, 0).cooldownUntil).toBe(c.t + 30 * MIN)
  })

  it.each<[LlmErrorCode, number]>([
    ['rate_limit', 30_000],
    ['unavailable', 15_000],
    ['timeout', 15_000],
    ['auth', 5 * MIN],
  ])('%s: default cooldown of %i ms', async (code, ms) => {
    const { c, a, gw } = setup(code)
    await gw.complete(req())
    expect(a.calls).toBe(1)
    c.advance(ms - 1)
    await gw.complete(req())
    expect(a.calls).toBe(1)
    c.advance(2)
    await gw.complete(req())
    expect(a.calls).toBe(2)
  })

  it.each<LlmErrorCode>(['bad_request', 'protocol'])(
    '%s starts no cooldown: the request is at fault',
    async (code) => {
      const { a, gw } = setup(code)
      await gw.complete(req())
      await gw.complete(req())
      await gw.complete(req())
      expect(a.calls).toBe(3)
      expect(providerOf(gw, 0).cooldownUntil).toBeUndefined()
    }
  )

  it('takes cooldown lengths from the options, and 0 turns a cooldown off', async () => {
    const custom = setup('quota', { quota: 1_000 })
    await custom.gw.complete(req())
    custom.c.advance(1_001)
    await custom.gw.complete(req())
    expect(custom.a.calls).toBe(2)

    const off = setup('rate_limit', { rate_limit: 0 })
    await off.gw.complete(req())
    await off.gw.complete(req())
    expect(off.a.calls).toBe(2)

    // timeout follows `unavailable` unless it has its own value
    const follows = setup('timeout', { unavailable: 2_000 })
    await follows.gw.complete(req())
    follows.c.advance(1_500)
    await follows.gw.complete(req())
    expect(follows.a.calls).toBe(1)
    follows.c.advance(600)
    await follows.gw.complete(req())
    expect(follows.a.calls).toBe(2)
  })

  it('believes a provider that asks for a longer wait than the default, but not a shorter one', async () => {
    const c = clock()
    const long = fake('a', fails('rate_limit', { retryAfterMs: 120_000 }))
    const short = fake('s', fails('rate_limit', { retryAfterMs: 1_000 }))
    const b = fake('b', says('from b'))
    const gw = new LlmGateway({ providers: [long, short, b], order: ['a', 's', 'b'], now: c.now })
    await gw.complete(req())
    const stats = gw.stats().providers
    expect(stats[0]!.cooldownUntil).toBe(c.t + 120_000)
    expect(stats[1]!.cooldownUntil).toBe(c.t + 30_000)
  })

  it('never lets a huge Retry-After lock a provider for more than a day', async () => {
    const c = clock()
    const a = fake('a', fails('rate_limit', { retryAfterMs: 90 * 24 * 60 * MIN }))
    const b = fake('b', says('from b'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'], now: c.now })
    await gw.complete(req())
    expect(providerOf(gw, 0).cooldownUntil).toBe(c.t + 24 * 60 * MIN)
  })

  it('resetCooldown makes a provider eligible at once; unknown ids are an error', async () => {
    const { a, gw } = setup('quota')
    await gw.complete(req())
    await gw.complete(req())
    expect(a.calls).toBe(1)
    gw.resetCooldown('a')
    expect(providerOf(gw, 0).cooldownUntil).toBeUndefined()
    await gw.complete(req())
    expect(a.calls).toBe(2)
    expect(() => gw.resetCooldown('zzz')).toThrow(/unknown LLM provider 'zzz'/)
    gw.resetCooldown() // all
    await gw.complete(req())
    expect(a.calls).toBe(3)
  })

  it('lists every provider as skipped when all of them are cooling down, and calls none', async () => {
    const c = clock()
    const a = fake('a', fails('quota'))
    const b = fake('b', fails('rate_limit'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'], now: c.now })
    await failureOf(gw)
    c.advance(10_000)
    const { error } = await failureOf(gw)
    expect(error.code).toBe('unavailable')
    expect(error.message).toBe(
      'all LLM providers failed: a=skipped (cooling down after quota, 1790 s left), b=skipped (cooling down after rate_limit, 20 s left)'
    )
    expect(error.attempts?.every((x) => x.outcome === 'cooldown')).toBe(true)
    expect([a.calls, b.calls]).toEqual([1, 1])
  })

  it('a success clears the cooldown, except one that a concurrent request started meanwhile', async () => {
    const c = clock()
    const slowStart = gate()
    const a = fake('a', async function* (_r, call) {
      if (call === 1) {
        await slowStart.promise // request X is in flight
        yield text('x done')
        return
      }
      throw new LlmError('unavailable', 'down', { providerId: 'a' }) // request Y fails
    })
    const b = fake('b', says('from b'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'], now: c.now })

    const x = gw.complete(req())
    await sleep(5) // let X reach provider a
    c.advance(10)
    expect(await gw.complete(req())).toBe('from b') // Y: a fails, cooldown starts after X began
    slowStart.open()
    expect(await x).toBe('x done') // X succeeds afterwards
    expect(providerOf(gw, 0).cooldownUntil).toBeDefined() // ...and did not erase Y's verdict
    await gw.complete(req())
    expect(a.calls).toBe(2) // still skipped
  })

  it('a provider that works after its cooldown is used first again', async () => {
    const c = clock()
    const a = fake('a', async function* (_r, call) {
      if (call === 1) throw new LlmError('quota', 'exhausted', { providerId: 'a' })
      yield text('a is back')
    })
    const b = fake('b', says('from b'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'], now: c.now })
    expect(await gw.complete(req())).toBe('from b')
    c.advance(31 * MIN)
    expect(await gw.complete(req())).toBe('a is back')
    expect(await gw.complete(req())).toBe('a is back')
    expect([a.calls, b.calls]).toEqual([3, 1])
    expect(providerOf(gw, 0).cooldownUntil).toBeUndefined()
  })
})

describe('LlmGateway statistics', () => {
  it('counts requests, successes, failures and tokens per provider', async () => {
    const c = clock()
    const a = fake('a', async function* (_r, call) {
      if (call === 2) throw new LlmError('timeout', 'slow', { providerId: 'a', status: 504 })
      yield text('ok')
      yield usage(10, 5)
    })
    const b = fake('b', says('from b', usage(4, 6)))
    const gw = new LlmGateway({
      providers: [a, b],
      order: ['a', 'b'],
      now: c.now,
      cooldownMs: { timeout: 0 },
    })
    await gw.complete(req())
    c.advance(1234)
    await gw.complete(req())
    await gw.complete(req())
    const [sa, sb] = gw.stats().providers
    expect(sa).toEqual({
      id: 'a',
      kind: 'fake',
      requests: 3,
      successes: 2,
      failures: 1,
      aborted: 0,
      lastError: { code: 'timeout', at: c.t, status: 504 },
      inputTokens: 20,
      outputTokens: 10,
    })
    expect(sb).toEqual({
      id: 'b',
      kind: 'fake',
      requests: 1,
      successes: 1,
      failures: 0,
      aborted: 0,
      inputTokens: 4,
      outputTokens: 6,
    })
  })

  it('takes the last usage snapshot of a stream, and counts the usage of a failed attempt', async () => {
    const a = fake('a', says(usage(10, 0), usage(12, 3))) // no text: fails as empty, but its tokens were spent
    const b = fake('b', says('answer', usage(5, 7)))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    await gw.complete(req({ tag: 'chat' }))
    const [sa, sb] = gw.stats().providers
    expect([sa!.inputTokens, sa!.outputTokens]).toEqual([12, 3])
    expect([sb!.inputTokens, sb!.outputTokens]).toEqual([5, 7])
    expect(gw.stats().tags.chat).toMatchObject({ inputTokens: 17, outputTokens: 10 })
  })

  it('counts whole requests per tag, with untagged requests and a cap on distinct tags', async () => {
    const a = fake('a', async function* (_r, call) {
      if (call === 3) throw new LlmError('bad_request', 'nope', { providerId: 'a' })
      yield text('ok')
    })
    const gw = new LlmGateway({ providers: [a], order: ['a'] })
    await gw.complete(req({ tag: 'chat' }))
    await gw.complete(req({ tag: 'chat' }))
    await collect(gw.stream(req({ tag: 'observer' }))) // fails: only provider, bad_request
    await gw.complete(req())
    expect(gw.stats().tags).toEqual({
      chat: { requests: 2, successes: 2, failures: 0, aborted: 0, inputTokens: 0, outputTokens: 0 },
      observer: {
        requests: 1,
        successes: 0,
        failures: 1,
        aborted: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      untagged: {
        requests: 1,
        successes: 1,
        failures: 0,
        aborted: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    })

    const many = new LlmGateway({ providers: [fake('a', says('x'))], order: ['a'] })
    for (let i = 0; i < 80; i++) await many.complete(req({ tag: `t${i}` }))
    const tags = Object.keys(many.stats().tags)
    expect(tags.length).toBeLessThanOrEqual(65)
    expect(tags).toContain('other')
    expect(many.stats().tags.other!.requests).toBe(80 - 64)
  })

  it('returns a snapshot: changing it does not change the gateway', async () => {
    const gw = new LlmGateway({ providers: [fake('a', says('x'))], order: ['a'] })
    await gw.complete(req())
    const snapshot = gw.stats()
    snapshot.providers[0]!.requests = 999
    snapshot.providers.length = 0
    expect(gw.stats().providers[0]!.requests).toBe(1)
  })

  it('contains only plain data', async () => {
    const a = fake('a', fails('quota', { status: 429 }, 'x?key=some-leaky-value'))
    const gw = new LlmGateway({ providers: [a, fake('b', says('ok'))], order: ['a', 'b'] })
    await gw.complete(req())
    const text = JSON.stringify(gw.stats())
    expect(text).not.toContain('leaky')
    expect(JSON.parse(text)).toEqual(gw.stats())
  })
})

describe('LlmGateway complete()', () => {
  it('joins the text deltas and ignores thinking and usage', async () => {
    const gw = new LlmGateway({
      providers: [fake('a', says(thinking('t'), 'Hel', usage(1, 1), 'lo'))],
      order: ['a'],
    })
    expect(await gw.complete(req())).toBe('Hello')
  })

  it('rejects with the gateway error when every provider fails', async () => {
    const gw = new LlmGateway({ providers: [fake('a', fails('quota'))], order: ['a'] })
    await expect(gw.complete(req())).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('LlmGateway logging and redaction', () => {
  interface Line {
    level: LlmLogLevel
    msg: string
    extra?: Record<string, unknown>
  }
  const capture = () => {
    const lines: Line[] = []
    return {
      lines,
      log: (level: LlmLogLevel, msg: string, extra?: Record<string, unknown>) => {
        lines.push({ level, msg, ...(extra ? { extra } : {}) })
      },
      text: () =>
        lines.map((l) => `${l.level} ${l.msg} ${JSON.stringify(l.extra ?? {})}`).join('\n'),
    }
  }

  it('logs failures, cooldowns and fallbacks without prompts or answers', async () => {
    const cap = capture()
    const a = fake('a', fails('quota', { status: 429 }, 'quota exhausted'))
    const b = fake('b', says('the secret sauce is in the answer'))
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'], log: cap.log })
    await gw.complete({
      messages: [{ role: 'user', content: 'a very private prompt' }],
      tag: 'chat',
    })
    const warnings = cap.lines.filter((l) => l.level === 'warn').map((l) => l.msg)
    expect(warnings).toContain('llm provider failed')
    expect(warnings).toContain('llm provider is cooling down')
    expect(
      cap.lines.some(
        (l) => l.level === 'info' && l.msg === 'llm request served by a fallback provider'
      )
    ).toBe(true)
    expect(cap.lines.find((l) => l.msg === 'llm provider failed')!.extra).toMatchObject({
      provider: 'a',
      code: 'quota',
      status: 429,
      tag: 'chat',
    })
    expect(cap.text()).not.toContain('private prompt')
    expect(cap.text()).not.toContain('secret sauce')
  })

  it('logs an error line when every provider failed', async () => {
    const cap = capture()
    const gw = new LlmGateway({
      providers: [fake('a', fails('timeout'))],
      order: ['a'],
      log: cap.log,
    })
    await collect(gw.stream(req()))
    expect(cap.lines.some((l) => l.level === 'error' && l.msg.includes('every provider'))).toBe(
      true
    )
  })

  it('survives a logger that throws', async () => {
    const gw = new LlmGateway({
      providers: [fake('a', fails('quota')), fake('b', says('fine'))],
      order: ['a', 'b'],
      log: () => {
        throw new Error('disk full')
      },
    })
    expect(await gw.complete(req())).toBe('fine')
  })

  it('scrubs registered secrets from error messages and log lines, whoever leaked them', async () => {
    const cap = capture()
    const leaky = fake(
      'a',
      fails('unavailable', {}, 'upstream said: bad key other-secret-77 in request')
    )
    const ok = fake('b', says('fine'))
    const gw = new LlmGateway({
      providers: [leaky, ok],
      order: ['a', 'b'],
      log: cap.log,
      secrets: ['other-secret-77'],
    })
    await gw.complete(req())
    expect(cap.text()).not.toContain('other-secret-77')
    expect(cap.lines.find((l) => l.msg === 'llm provider failed')!.extra!.message).toBe(
      'upstream said: bad key [REDACTED] in request'
    )

    const only = new LlmGateway({
      providers: [
        fake('a', failsAfter(['half '], 'unavailable', {}, 'bad key other-secret-77', 'a')),
      ],
      order: ['a'],
      secrets: ['other-secret-77'],
    })
    const out = await collect(only.stream(req()))
    const error = out.error as LlmError
    expect(error.message).toBe('bad key [REDACTED]')
    expect(error.stack ?? '').not.toContain('other-secret-77')
    expect(error.code).toBe('unavailable')
    expect(error.providerId).toBe('a')
  })

  it("scrubs with each provider's own redact() and survives one that throws", async () => {
    const cap = capture()
    const a = fake('a', fails('unavailable', {}, 'echoed provider-private-9 here'), (t) =>
      t.replaceAll('provider-private-9', '[gone]')
    )
    const b = fake('b', fails('unavailable', {}, 'other text'), () => {
      throw new Error('broken redactor')
    })
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'], log: cap.log })
    const { error } = await failureOf(gw)
    expect(cap.text()).not.toContain('provider-private-9')
    expect(cap.lines.find((l) => l.msg === 'llm provider failed')!.extra!.message).toBe(
      'echoed [gone] here'
    )
    expect(error.code).toBe('unavailable')
  })

  it('scrubs a plain exception message too', async () => {
    const a = fake('a', async function* () {
      throw new Error('fetch failed for https://h.example/x?key=raw-token-value')
    })
    const cap = capture()
    const gw = new LlmGateway({ providers: [a], order: ['a'], log: cap.log })
    await collect(gw.stream(req()))
    expect(cap.text()).toContain('unexpected provider failure')
    expect(cap.text()).not.toContain('raw-token-value')
  })
})

describe('LlmGateway.close', () => {
  it('closes every provider and tolerates one that fails to close', async () => {
    const a = fake('a', says('x'))
    const b = fake('b', says('y'))
    b.close = async () => {
      throw new Error('already closed')
    }
    const gw = new LlmGateway({ providers: [a, b], order: ['a', 'b'] })
    await expect(gw.close()).resolves.toBeUndefined()
    expect(a.closed).toBe(true)
  })
})

// ───────────────────── with real providers against local mock servers ─────────────────────

describe('LlmGateway with real providers', () => {
  const KEY = 'test-key-123'
  const made: { close(): Promise<void> }[] = []
  afterEach(async () => {
    await Promise.all(made.splice(0).map((p) => p.close()))
  })
  const gemini = (
    url: string,
    extra: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {}
  ) => {
    const p = new GeminiProvider({ id: 'gemini', apiKey: KEY, model: 'm', baseUrl: url, ...extra })
    made.push(p)
    return p
  }
  const local = (
    url: string,
    extra: Partial<ConstructorParameters<typeof OpenAiProvider>[0]> = {}
  ) => {
    const p = new OpenAiProvider({ id: 'local', baseUrl: `${url}/v1`, model: 'q', ...extra })
    made.push(p)
    return p
  }
  const quotaBody = {
    error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED' },
  }
  const localReply = async (_s: unknown, res: import('node:http').ServerResponse) => {
    startSse(res)
    res.write(sse(oText('local answer')) + sse(oStop) + DONE)
    res.end()
  }

  it('falls back from a quota error to the local model, skips Gemini while it cools down, and retries it later', async () => {
    const c = clock()
    const g = await startServer(async (_s, res) => sendJson(res, 429, quotaBody))
    const l = await startServer(localReply)
    const gw = new LlmGateway({
      providers: [gemini(g.url), local(l.url)],
      order: ['gemini', 'local'],
      now: c.now,
    })

    expect(await gw.complete(req())).toBe('local answer')
    expect([g.seen.length, l.seen.length]).toEqual([1, 1])
    expect(gw.stats().providers[0]!.lastError).toMatchObject({ code: 'quota', status: 429 })

    c.advance(10 * MIN)
    expect(await gw.complete(req())).toBe('local answer')
    expect([g.seen.length, l.seen.length]).toEqual([1, 2]) // Gemini was not even contacted

    c.advance(21 * MIN)
    expect(await gw.complete(req())).toBe('local answer')
    expect([g.seen.length, l.seen.length]).toEqual([2, 3]) // retried after 30 minutes
  })

  it('does not switch provider when the connection drops after the first text', async () => {
    const g = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse(gText('Hello, ')))
      await sleep(30)
      res.socket!.destroy()
    })
    const l = await startServer(localReply)
    const gw = new LlmGateway({
      providers: [gemini(g.url), local(l.url)],
      order: ['gemini', 'local'],
    })
    const out = await collect(gw.stream(req()))
    expect(out.text).toBe('Hello, ')
    expect((out.error as LlmError).code).toBe('unavailable')
    expect(l.seen).toHaveLength(0)
  })

  it('falls back when the first provider goes idle before any text', async () => {
    const g = await startServer(async () => {
      // accepts the request and says nothing
    })
    const l = await startServer(localReply)
    const gw = new LlmGateway({
      providers: [gemini(g.url, { idleTimeoutMs: 200 }), local(l.url)],
      order: ['gemini', 'local'],
    })
    expect(await gw.complete(req())).toBe('local answer')
    expect(gw.stats().providers[0]!.lastError?.code).toBe('timeout')
    await g.seen[0]!.closed
    expect(g.seen[0]!.clientAborted).toBe(true)
  })

  it('aborts mid-stream: the caller gets `aborted`, no other provider runs, the server sees the connection close', async () => {
    const g = await startServer(async (_s, res) => {
      startSse(res)
      const timer = setInterval(() => res.write(sse(gText('tick '))), 25)
      res.on('close', () => clearInterval(timer))
    })
    const l = await startServer(localReply)
    const gw = new LlmGateway({
      providers: [gemini(g.url), local(l.url)],
      order: ['gemini', 'local'],
    })
    const controller = new AbortController()
    let seen = 0
    let caught: unknown
    try {
      for await (const d of gw.stream(req({ signal: controller.signal }))) {
        if (d.type === 'text' && ++seen === 3) controller.abort()
      }
    } catch (e) {
      caught = e
    }
    expect((caught as LlmError).code).toBe('aborted')
    expect(l.seen).toHaveLength(0)
    await g.seen[0]!.closed
    expect(g.seen[0]!.clientAborted).toBe(true)
    const s = gw.stats().providers[0]!
    expect([s.aborted, s.failures, s.cooldownUntil]).toEqual([1, 0, undefined])
  })

  it('falls back on a safety block and reports a total failure with both reasons', async () => {
    const g = await startServer(async (_s, res) => {
      startSse(res)
      res.end(sse({ promptFeedback: { blockReason: 'SAFETY' } }))
    })
    const l = await startServer(localReply)
    const gw = new LlmGateway({
      providers: [gemini(g.url), local(l.url)],
      order: ['gemini', 'local'],
    })
    expect(await gw.complete(req())).toBe('local answer')
    expect(gw.stats().providers[0]!.lastError?.code).toBe('bad_request')
    expect(gw.stats().providers[0]!.cooldownUntil).toBeUndefined() // a blocked prompt is not a sick provider

    const bad = await startServer(async (_s, res) =>
      sendJson(res, 400, { error: { message: 'bad', status: 'INVALID_ARGUMENT' } })
    )
    const worse = await startServer(async (_s, res) =>
      sendJson(res, 503, { error: { message: 'down', status: 'UNAVAILABLE' } })
    )
    const both = new LlmGateway({
      providers: [gemini(bad.url), local(worse.url)],
      order: ['gemini', 'local'],
    })
    const { error } = await failureOf(both)
    expect(error.message).toBe(
      'all LLM providers failed: gemini=bad_request (HTTP 400), local=unavailable (HTTP 503)'
    )
    expect(error.message).not.toContain(KEY)
  })

  it('serves a Gemini answer with usage and thinking straight through', async () => {
    const g = await startServer(async (_s, res) => {
      startSse(res)
      res.write(sse({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] }))
      res.end(
        sse(gDone('Hi!', { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 5 }))
      )
    })
    const gw = new LlmGateway({
      providers: [gemini(g.url, { thinkingBudget: 256, includeThoughts: true })],
      order: ['gemini'],
    })
    const out = await collect(gw.stream(req({ tag: 'chat' })))
    expect(out.thinking).toBe('hmm')
    expect(out.text).toBe('Hi!')
    const expectedUsage: LlmDelta = { type: 'usage', inputTokens: 8, outputTokens: 7 }
    expect(out.deltas.at(-1)).toEqual(expectedUsage)
    expect(gw.stats().providers[0]).toMatchObject({ inputTokens: 8, outputTokens: 7, successes: 1 })
  })
})
