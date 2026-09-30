import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeSource } from '@animatus/protocol'
import type { ToolAuditEntry, ToolTier } from '@animatus/protocol'
import { ToolGate } from '../../src/tools/gate.ts'
import type { GateOptions } from '../../src/tools/gate.ts'
import { ToolRegistry, effectiveTier } from '../../src/tools/registry.ts'
import type { ToolSpec } from '../../src/tools/registry.ts'

const viewer = makeSource('viewer', { name: 'ann', uid: '1001' })
const moderator = makeSource('moderator', { name: 'mod', uid: '9' })
const host = makeSource('host')
const system = makeSource('system')

interface Rig {
  gate: ToolGate
  ran: { tool: string; args: unknown; origin: string }[]
  audit: ToolAuditEntry[]
  clock: { now: number }
  changes: () => number
}

function rig(over: Partial<GateOptions> = {}, extraTools: ToolSpec[] = []): Rig {
  const ran: Rig['ran'] = []
  const registry = new ToolRegistry()
  const spec = <A>(
    name: string,
    tier: ToolTier,
    schema: z.ZodType<A>,
    more: Partial<ToolSpec<A>> = {}
  ): ToolSpec<A> => ({
    name,
    description: `does ${name}`,
    usage: '{}',
    tier,
    schema,
    summarize: (a) => `${name} ${JSON.stringify(a)}`,
    run: async (a, ctx) => {
      ran.push({ tool: name, args: a, origin: ctx.origin.kind })
      return `${name} done`
    },
    ...more,
  })
  registry.register(spec('show_notice', 'free', z.object({ text: z.string().min(1).max(60) })))
  registry.register(
    spec('enter_mode', 'approval', z.object({ mode: z.string().min(1).max(32) }), {
      floor: 'approval',
    })
  )
  registry.register(spec('remember', 'approval', z.object({ text: z.string().min(1).max(200) })))
  registry.register(spec('old_tool', 'disabled', z.object({})))
  registry.register(
    spec('explodes', 'free', z.object({}), {
      run: async () => {
        throw new Error('boom\nwith a second line')
      },
    })
  )
  for (const t of extraTools) registry.register(t)
  const clock = { now: 1_000_000 }
  const audit: ToolAuditEntry[] = []
  let changes = 0
  const gate = new ToolGate({
    registry,
    now: () => clock.now,
    audit: (e) => audit.push(e),
    ...over,
  })
  gate.on('change', () => changes++)
  return { gate, ran, audit, clock, changes: () => changes }
}

describe('the one rule', () => {
  it('a free tool runs for anyone, whoever wrote the text that led to it', async () => {
    const { gate, ran } = rig()
    for (const origin of [viewer, moderator, host, system]) {
      const r = await gate.request({ tool: 'show_notice', args: { text: 'hi' }, origin })
      expect(r.status).toBe('ran')
    }
    expect(ran.map((x) => x.origin)).toEqual(['viewer', 'moderator', 'host', 'system'])
  })

  it('an approval tool asked for by an untrusted origin is refused, not queued: it never reaches the streamer', async () => {
    const { gate, ran, audit } = rig()
    const r = await gate.request({ tool: 'enter_mode', args: { mode: 'sleep' }, origin: viewer })
    expect(r).toEqual({ status: 'rejected', reason: 'untrusted_origin' })
    expect(gate.pending()).toEqual([])
    expect(ran).toEqual([])
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      tool: 'enter_mode',
      decision: 'rejected',
      reason: 'untrusted_origin',
      origin: { kind: 'viewer', trust: 'untrusted', name: 'ann' },
    })
  })

  it('a moderator or the host may ask for an approval tool: it is queued, and nothing runs before the streamer says yes', async () => {
    const { gate, ran } = rig()
    for (const origin of [moderator, host, system]) {
      const r = await gate.request({ tool: 'enter_mode', args: { mode: 'sleep' }, origin })
      expect(r.status).toBe('queued')
    }
    expect(ran).toEqual([])
    expect(gate.pending().map((p) => p.origin.kind)).toEqual(['moderator', 'host', 'system'])
    expect(gate.pending()[0]).toMatchObject({
      tool: 'enter_mode',
      status: 'pending',
      summary: 'enter_mode {"mode":"sleep"}',
      args: { mode: 'sleep' },
    })
  })

  it('a disabled tool never runs, whoever asks; an unknown one is refused', async () => {
    const { gate, ran } = rig()
    for (const origin of [viewer, moderator, host])
      expect(await gate.request({ tool: 'old_tool', args: {}, origin })).toEqual({
        status: 'rejected',
        reason: 'disabled',
      })
    expect(await gate.request({ tool: 'no_such_tool', args: {}, origin: host })).toEqual({
      status: 'rejected',
      reason: 'unknown_tool',
    })
    expect(await gate.request({ tool: 'constructor', args: {}, origin: host })).toEqual({
      status: 'rejected',
      reason: 'unknown_tool',
    })
    expect(await gate.request({ tool: '__proto__', args: {}, origin: host })).toEqual({
      status: 'rejected',
      reason: 'unknown_tool',
    })
    expect(ran).toEqual([])
  })

  it('an origin made up in the request cannot claim more trust than its kind gives: a viewer source is untrusted', () => {
    expect(makeSource('viewer').trust).toBe('untrusted')
    expect(makeSource('web').trust).toBe('untrusted')
    expect(makeSource('agent').trust).toBe('untrusted')
    expect(makeSource('plugin').trust).toBe('untrusted')
  })
})

describe('tiers from the configuration', () => {
  it('may switch a tool off, or ask for more care, and never drop a tool below its floor', async () => {
    const off = rig({ tiers: { show_notice: 'disabled' } })
    expect(
      await off.gate.request({ tool: 'show_notice', args: { text: 'x' }, origin: host })
    ).toEqual({ status: 'rejected', reason: 'disabled' })

    const care = rig({ tiers: { show_notice: 'approval' } })
    expect(
      (await care.gate.request({ tool: 'show_notice', args: { text: 'x' }, origin: viewer })).status
    ).toBe('rejected')
    expect(
      (await care.gate.request({ tool: 'show_notice', args: { text: 'x' }, origin: moderator }))
        .status
    ).toBe('queued')

    // enter_mode has a floor of approval: "free" in the configuration is not honoured
    const loose = rig({ tiers: { enter_mode: 'free' } })
    expect(loose.gate.tierOf('enter_mode')).toBe('approval')
    expect(
      await loose.gate.request({ tool: 'enter_mode', args: { mode: 'sleep' }, origin: viewer })
    ).toEqual({ status: 'rejected', reason: 'untrusted_origin' })
    // remember has no floor, so the operator may make it free (and accepts that viewers can trigger it)
    const free = rig({ tiers: { remember: 'free' } })
    expect(
      (await free.gate.request({ tool: 'remember', args: { text: 'x' }, origin: viewer })).status
    ).toBe('ran')
  })

  it('effectiveTier: the higher of the configured tier and the floor', () => {
    const t = (tier: ToolTier, floor: 'free' | 'approval' | undefined, cfg: ToolTier | undefined) =>
      effectiveTier({ tier, ...(floor ? { floor } : {}) }, cfg)
    expect(t('free', undefined, undefined)).toBe('free')
    expect(t('free', 'approval', undefined)).toBe('approval')
    expect(t('approval', 'approval', 'free')).toBe('approval')
    expect(t('approval', 'approval', 'disabled')).toBe('disabled')
    expect(t('free', undefined, 'approval')).toBe('approval')
    expect(t('disabled', undefined, 'free')).toBe('free') // the configuration may enable a tool that ships disabled
  })

  it('usableBy tells which tools a call of that trust could get somewhere with', () => {
    const { gate } = rig()
    expect(gate.usableBy('untrusted').map((s) => s.name)).toEqual(['show_notice', 'explodes'])
    expect(gate.usableBy('trusted').map((s) => s.name)).toEqual([
      'show_notice',
      'enter_mode',
      'remember',
      'explodes',
    ])
    expect(gate.usableBy('privileged').map((s) => s.name)).toEqual([
      'show_notice',
      'enter_mode',
      'remember',
      'explodes',
    ])
  })
})

describe('arguments', () => {
  it('are checked before anything runs or is queued: garbage neither runs nor bothers the streamer', async () => {
    const { gate, ran } = rig()
    for (const args of [
      {},
      { text: '' },
      { text: 'x'.repeat(61) },
      { text: 5 },
      null,
      'text',
      [1],
    ]) {
      const r = await gate.request({ tool: 'show_notice', args, origin: viewer })
      expect(r.status, JSON.stringify(args)).toBe('rejected')
      if (r.status === 'rejected') expect(r.reason).toBe('bad_args')
    }
    expect(
      (await gate.request({ tool: 'enter_mode', args: { mode: 5 }, origin: moderator })).status
    ).toBe('rejected')
    expect(gate.pending()).toEqual([])
    expect(ran).toEqual([])
  })

  it('what runs is what the schema made of them: fields it does not know are gone', async () => {
    const { gate, ran } = rig()
    await gate.request({
      tool: 'show_notice',
      args: { text: 'hi', extra: 'ignored', __proto__: { polluted: true } },
      origin: viewer,
    })
    expect(ran[0]?.args).toEqual({ text: 'hi' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('a queued call keeps its own copy: changing the original afterwards changes nothing', async () => {
    const { gate, ran } = rig()
    const args = { mode: 'sleep' }
    const q = await gate.request({ tool: 'enter_mode', args, origin: moderator })
    args.mode = 'sing'
    expect(gate.pending()[0]?.args).toEqual({ mode: 'sleep' })
    if (q.status !== 'queued') throw new Error('not queued')
    await gate.approve(q.id)
    expect(ran[0]?.args).toEqual({ mode: 'sleep' })
  })
})

describe('approving', () => {
  it('runs the queued call once, with its own arguments, and remembers the result', async () => {
    const { gate, ran, audit, changes } = rig()
    const q = await gate.request({
      tool: 'remember',
      args: { text: 'the mascot is a red panda' },
      origin: moderator,
    })
    if (q.status !== 'queued') throw new Error('not queued')
    const before = changes()
    const r = await gate.approve(q.id)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.view).toMatchObject({ status: 'approved', result: 'remember done' })
    expect(ran).toEqual([
      { tool: 'remember', args: { text: 'the mascot is a red panda' }, origin: 'moderator' },
    ])
    expect(gate.pending()).toEqual([])
    expect(gate.recent()[0]).toMatchObject({ id: q.id, status: 'approved' })
    expect(changes()).toBeGreaterThan(before)
    expect(audit.map((a) => a.decision)).toEqual(['queued', 'approved'])
  })

  it('a second approval of the same call finds nothing to run, even at the same moment', async () => {
    const { gate, ran } = rig()
    const q = await gate.request({ tool: 'remember', args: { text: 'once' }, origin: moderator })
    if (q.status !== 'queued') throw new Error('not queued')
    const [a, b] = await Promise.all([gate.approve(q.id), gate.approve(q.id)])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect(ran).toHaveLength(1)
    const again = await gate.approve(q.id)
    expect(again).toEqual({
      ok: false,
      code: 'not_pending',
      message: 'that request was already approved',
    })
  })

  it('a call that fails when it runs is recorded as failed, with the first line of the error', async () => {
    const boom: ToolSpec = {
      name: 'fragile',
      description: 'fails',
      usage: '{}',
      tier: 'approval',
      schema: z.object({}),
      summarize: () => 'fragile',
      run: async () => {
        throw new Error('disk full\nstack line')
      },
    }
    const { gate, audit } = rig({}, [boom])
    const q = await gate.request({ tool: 'fragile', args: {}, origin: host })
    if (q.status !== 'queued') throw new Error('not queued')
    const r = await gate.approve(q.id)
    expect(r.ok && r.view.result).toBe('failed: disk full')
    expect(audit.at(-1)).toMatchObject({ decision: 'failed', reason: 'disk full' })
  })

  it('denying drops it; deciding on what does not exist says so', async () => {
    const { gate, ran } = rig()
    const q = await gate.request({ tool: 'remember', args: { text: 'no' }, origin: moderator })
    if (q.status !== 'queued') throw new Error('not queued')
    const d = gate.deny(q.id)
    expect(d.ok && d.view.status).toBe('denied')
    expect(ran).toEqual([])
    expect((await gate.approve(q.id)).ok).toBe(false)
    expect(gate.deny('ap-nothing')).toEqual({
      ok: false,
      code: 'not_found',
      message: 'there is no such request',
    })
    expect(await gate.approve('ap-nothing')).toEqual({
      ok: false,
      code: 'not_found',
      message: 'there is no such request',
    })
  })

  it('a call that waited too long expires and cannot be approved any more', async () => {
    const { gate, ran, clock, audit } = rig({ ttlMs: 60_000 })
    const q = await gate.request({ tool: 'remember', args: { text: 'late' }, origin: moderator })
    if (q.status !== 'queued') throw new Error('not queued')
    clock.now += 61_000
    expect(gate.pending()).toEqual([])
    expect(gate.recent()[0]).toMatchObject({ id: q.id, status: 'expired' })
    expect(await gate.approve(q.id)).toEqual({
      ok: false,
      code: 'expired',
      message: 'that request waited too long and expired',
    })
    expect(ran).toEqual([])
    expect(audit.map((a) => a.decision)).toEqual(['queued', 'expired'])
  })
})

describe('limits', () => {
  it('only so many calls wait at once', async () => {
    const { gate } = rig({ maxPending: 2, perMinute: 100 })
    expect(
      (await gate.request({ tool: 'remember', args: { text: 'a' }, origin: moderator })).status
    ).toBe('queued')
    expect(
      (await gate.request({ tool: 'remember', args: { text: 'b' }, origin: moderator })).status
    ).toBe('queued')
    expect(
      await gate.request({ tool: 'remember', args: { text: 'c' }, origin: moderator })
    ).toEqual({ status: 'rejected', reason: 'queue_full' })
  })

  it('one origin can only ask so often, and the window slides', async () => {
    const { gate, clock } = rig({ perMinute: 3 })
    const ask = (origin = viewer) =>
      gate.request({ tool: 'show_notice', args: { text: 'x' }, origin })
    for (let i = 0; i < 3; i++) expect((await ask()).status).toBe('ran')
    expect(await ask()).toEqual({ status: 'rejected', reason: 'rate_limited' })
    expect((await ask(makeSource('viewer', { name: 'bob', uid: '1002' }))).status).toBe('ran') // another viewer is not held back
    clock.now += 61_000
    expect((await ask()).status).toBe('ran')
  })

  it('a flood of refused calls is refused each time and never queued', async () => {
    const { gate, audit } = rig()
    for (let i = 0; i < 200; i++)
      await gate.request({ tool: 'enter_mode', args: { mode: 'sleep' }, origin: viewer })
    expect(gate.pending()).toEqual([])
    expect(audit).toHaveLength(200)
    expect(audit.every((a) => a.decision === 'rejected')).toBe(true)
  })
})

describe('what a tool that fails does', () => {
  it('a free tool that throws is a failed result, not an exception, and not a crash of the gate', async () => {
    const { gate, audit } = rig()
    const r = await gate.request({ tool: 'explodes', args: {}, origin: viewer })
    expect(r).toMatchObject({ status: 'failed', error: 'boom' })
    expect(audit.at(-1)).toMatchObject({ decision: 'failed', reason: 'boom' })
    expect(
      (await gate.request({ tool: 'show_notice', args: { text: 'still works' }, origin: viewer }))
        .status
    ).toBe('ran')
  })

  it('an audit sink that throws does not change what runs', async () => {
    const { gate, ran } = rig({
      audit: () => {
        throw new Error('disk full')
      },
    })
    expect(
      (await gate.request({ tool: 'show_notice', args: { text: 'x' }, origin: viewer })).status
    ).toBe('ran')
    expect(ran).toHaveLength(1)
  })
})

describe('the registry', () => {
  it('refuses a bad or repeated name', () => {
    const r = new ToolRegistry()
    const base = {
      description: 'd',
      usage: '{}',
      tier: 'free' as const,
      schema: z.object({}),
      summarize: () => 's',
      run: async () => {},
    }
    expect(() => r.register({ ...base, name: 'Bad Name' })).toThrow('not a tool name')
    expect(() => r.register({ ...base, name: '' })).toThrow('not a tool name')
    r.register({ ...base, name: 'fine_name' })
    expect(() => r.register({ ...base, name: 'fine_name' })).toThrow('registered twice')
  })
})
