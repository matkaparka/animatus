import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventSource, ToolTier } from '@animatus/protocol'
import { AutomationEngine } from '../../src/automation/engine.ts'
import type { AutomationDeps, AutomationEvent } from '../../src/automation/engine.ts'
import { AutomationsConfig } from '../../src/automation/rules.ts'
import type { GateResult } from '../../src/tools/gate.ts'

afterEach(() => vi.useRealTimers())

interface Rig {
  engine: AutomationEngine
  said: string[]
  told: { text: string; fromProgram: boolean }[]
  tools: { tool: string; args: unknown; origin: EventSource }[]
  logs: string[]
  warns: { code: string; message: string; subject: string }[]
  consolidated: number
  clock: { now: number }
  quiet: { answer: boolean; wait: Promise<void> | null }
  toolAnswer: { result: GateResult }
  tellGate: { wait: Promise<void> | null }
}

function rig(
  rules: unknown[],
  over: { max_per_minute?: number; memory?: boolean; tiers?: Record<string, ToolTier> } = {}
): Rig {
  const cfg = AutomationsConfig.parse({
    rules,
    ...(over.max_per_minute ? { max_per_minute: over.max_per_minute } : {}),
  })
  const r: Rig = {
    said: [],
    told: [],
    tools: [],
    logs: [],
    warns: [],
    consolidated: 0,
    clock: { now: 1_000_000 },
    quiet: { answer: true, wait: null },
    toolAnswer: { result: { status: 'ran', id: 'ap-000000000001' } },
    tellGate: { wait: null },
    engine: undefined as never,
  }
  const deps: AutomationDeps = {
    say: (t) => void r.said.push(t),
    tell: async (text, o) => {
      r.told.push({ text, fromProgram: o.fromProgram })
      if (r.tellGate.wait) await r.tellGate.wait
    },
    tool: async (req) => {
      r.tools.push(req)
      return r.toolAnswer.result
    },
    ...(over.memory === false
      ? {}
      : {
          consolidate: async () => {
            r.consolidated++
          },
        }),
    whenQuiet: async () => {
      if (r.quiet.wait) await r.quiet.wait
      return r.quiet.answer
    },
    tierOf: (name) =>
      over.tiers?.[name] ??
      (name === 'tell_streamer' ? 'free' : name === 'enter_mode' ? 'approval' : undefined),
    log: (t) => void r.logs.push(t),
    warn: (code, message, subject) => void r.warns.push({ code, message, subject }),
    now: () => r.clock.now,
  }
  r.engine = new AutomationEngine(cfg, deps)
  return r
}

const guard = (
  over: Partial<Extract<AutomationEvent, { type: 'guard' }>> = {}
): AutomationEvent => ({
  type: 'guard',
  uid: 5,
  name: 'ann',
  title: '舰长',
  months: 1,
  ...over,
})

describe('what a rule does', () => {
  it('says a fixed line for a program event, once the voice is free', async () => {
    const r = rig([{ id: 'bye', on: 'stream_end', do: [{ say: 'thanks for watching' }] }])
    r.engine.fire({ type: 'stream_end' })
    await r.engine.idle()
    expect(r.said).toEqual(['thanks for watching'])
    expect(r.logs).toEqual(['automation bye: said "thanks for watching"'])
  })

  it('fills the placeholders the event offers', async () => {
    const r = rig([
      { id: 'thanks', on: 'guard', do: [{ say: '{name} became {title} for {months} months' }] },
      { id: 'quiet', on: 'cold_start', do: [{ say: '{minutes} minutes of quiet' }] },
      { id: 'sc', on: 'superchat', do: [{ say: '{name} sent {yuan} yuan: {text}' }] },
      { id: 'mode', on: 'mode_entered', do: [{ say: '{mode} is on' }] },
    ])
    r.engine.fire(guard({ name: 'ann', months: 3 }))
    r.engine.fire({ type: 'cold_start', minutes: 7 })
    r.engine.fire({ type: 'superchat', uid: 1, name: 'bob', yuan: 30, text: 'hi there' })
    r.engine.fire({ type: 'mode_entered', mode: 'sleep' })
    await r.engine.idle()
    expect(r.said).toEqual([
      'ann became 舰长 for 3 months',
      '7 minutes of quiet',
      'bob sent 30 yuan: hi there',
      'sleep is on',
    ])
  })

  it('only the rules that name the event run; several rules for one event run in the order written', async () => {
    const r = rig([
      { id: 'a', on: 'stream_end', do: [{ say: 'first' }] },
      { id: 'b', on: 'stream_start', do: [{ say: 'not this one' }] },
      { id: 'c', on: 'stream_end', do: [{ say: 'second' }, { say: 'third' }] },
    ])
    r.engine.fire({ type: 'stream_end' })
    await r.engine.idle()
    expect(r.said).toEqual(['first', 'second', 'third'])
  })

  it('a rule switched off, or all of them, does nothing', async () => {
    const off = rig([{ id: 'a', enabled: false, on: 'stream_end', do: [{ say: 'no' }] }])
    off.engine.fire({ type: 'stream_end' })
    await off.engine.idle()
    expect(off.said).toEqual([])
    expect(off.engine.has('stream_end')).toBe(false)

    const cfg = AutomationsConfig.parse({
      enabled: false,
      rules: [{ id: 'a', on: 'stream_end', do: [{ say: 'no' }] }],
    })
    const all = new AutomationEngine(cfg, {
      ...rig([]).engine['d'],
      say: () => void 0,
    } as AutomationDeps)
    expect(all.has('stream_end')).toBe(false)
  })

  it('a filter narrows the rule: the mode, the price', async () => {
    const r = rig([
      { id: 'sleep', on: 'mode_entered', mode: 'sleep', do: [{ say: 'good night' }] },
      { id: 'big', on: 'superchat', min_yuan: 50, do: [{ say: 'wow' }] },
    ])
    r.engine.fire({ type: 'mode_entered', mode: 'dance' })
    r.engine.fire({ type: 'mode_entered', mode: 'sleep' })
    r.engine.fire({ type: 'superchat', uid: 1, name: 'a', yuan: 30, text: '' })
    r.clock.now += 60_000
    r.engine.fire({ type: 'superchat', uid: 1, name: 'a', yuan: 50, text: '' })
    await r.engine.idle()
    expect(r.said).toEqual(['good night', 'wow'])
  })
})

describe('the model and the audience', () => {
  it('an event the program made: the model is asked in the program’s own words; one from the audience: not', async () => {
    const r = rig([
      { id: 'topic', on: 'cold_start', do: [{ tell: 'bring up a topic' }] },
      { id: 'crew', on: 'guard', do: [{ tell: 'thank {name}' }] },
    ])
    r.engine.fire({ type: 'cold_start', minutes: 3 })
    r.engine.fire(guard({ name: 'ann' }))
    await r.engine.idle()
    expect(r.told).toEqual([
      { text: 'bring up a topic', fromProgram: true },
      { text: 'thank ann', fromProgram: false },
    ])
  })

  it('a tool called after a program event is the system’s; after the audience’s, the viewer’s, with their name and id', async () => {
    const r = rig([
      {
        id: 'note',
        on: 'stream_end',
        do: [{ tool: { name: 'tell_streamer', args: { text: 'the stream ended' } } }],
      },
      {
        id: 'crew',
        on: 'guard',
        do: [{ tool: { name: 'tell_streamer', args: { text: '{name} joined' } } }],
      },
    ])
    r.engine.fire({ type: 'stream_end' })
    r.engine.fire(guard({ uid: 42, name: 'ann' }))
    await r.engine.idle()
    expect(
      r.tools.map((t) => [
        t.tool,
        t.args,
        t.origin.kind,
        t.origin.trust,
        t.origin.uid,
        t.origin.name,
      ])
    ).toEqual([
      ['tell_streamer', { text: 'the stream ended' }, 'system', 'privileged', undefined, undefined],
      ['tell_streamer', { text: 'ann joined' }, 'viewer', 'untrusted', '42', 'ann'],
    ])
  })

  it('placeholders inside the arguments of a tool are filled, however deep', async () => {
    const r = rig([
      {
        id: 'c',
        on: 'guard',
        do: [{ tool: { name: 'tell_streamer', args: { a: { b: ['{name}', 3, true] } } } }],
      },
    ])
    r.engine.fire(guard({ name: 'ann' }))
    await r.engine.idle()
    expect(r.tools[0]?.args).toEqual({ a: { b: ['ann', 3, true] } })
  })

  it('what the gate answered is written down, refusals with their reason', async () => {
    const r = rig([
      { id: 'c', on: 'guard', do: [{ tool: { name: 'enter_mode', args: { mode: 'sleep' } } }] },
    ])
    r.toolAnswer.result = { status: 'rejected', reason: 'untrusted_origin' }
    r.engine.fire(guard())
    await r.engine.idle()
    expect(r.logs).toEqual(['automation c: tool enter_mode rejected (untrusted_origin)'])
  })

  it('at start it says which rules can never work: a tool that waits for approval after an audience event, one that does not exist', () => {
    const r = rig([
      { id: 'crew', on: 'guard', do: [{ tool: { name: 'enter_mode', args: {} } }] },
      { id: 'ghost', on: 'superchat', do: [{ tool: { name: 'no_such_tool', args: {} } }] },
      { id: 'fine', on: 'guard', do: [{ tool: { name: 'tell_streamer', args: { text: 'x' } } }] },
      { id: 'timer-ok', on: 'stream_end', do: [{ tool: { name: 'enter_mode', args: {} } }] },
    ])
    r.engine.start()
    r.engine.stop()
    expect(r.warns.map((w) => [w.code, w.subject])).toEqual([
      ['automation_tool_untrusted', 'crew'],
      ['automation_tool_unknown', 'ghost'],
    ])
    expect(r.warns[0]?.message).toContain('cannot ask for')
  })

  it('consolidating memory runs the pass; with memory off it says there is nothing to do', async () => {
    const on = rig([{ id: 'after', on: 'stream_end', do: [{ consolidate_memory: true }] }])
    on.engine.fire({ type: 'stream_end' })
    await on.engine.idle()
    expect(on.consolidated).toBe(1)
    const off = rig([{ id: 'after', on: 'stream_end', do: [{ consolidate_memory: true }] }], {
      memory: false,
    })
    off.engine.fire({ type: 'stream_end' })
    await off.engine.idle()
    expect(off.logs).toEqual(['automation after: memory is off, nothing to consolidate'])
  })
})

describe('limits', () => {
  it('a line that finds the voice busy is dropped, not kept waiting behind it', async () => {
    const r = rig([{ id: 'a', on: 'stream_end', do: [{ say: 'one' }, { say: 'two' }] }])
    r.quiet.answer = false
    r.engine.fire({ type: 'stream_end' })
    await r.engine.idle()
    expect(r.said).toEqual([])
    expect(r.logs).toEqual(['automation a: say skipped, the voice was busy'])
  })

  it('an event from the audience: a rule waits 30 seconds before it runs again; one from the program: no wait; a setting overrides both', async () => {
    const r = rig([
      { id: 'crew', on: 'guard', do: [{ say: 'welcome' }] },
      { id: 'end', on: 'stream_end', do: [{ say: 'bye' }] },
      { id: 'slow', on: 'stream_start', cooldown_sec: 100, do: [{ say: 'hello' }] },
    ])
    for (let i = 0; i < 3; i++) {
      r.engine.fire(guard())
      r.engine.fire({ type: 'stream_end' })
      r.engine.fire({ type: 'stream_start' })
      r.clock.now += 20_000
    }
    await r.engine.idle()
    expect(r.said.filter((s) => s === 'welcome')).toHaveLength(2) // at 0 s and 40 s; 20 s and 60 s are inside the wait
    expect(r.said.filter((s) => s === 'bye')).toHaveLength(3)
    expect(r.said.filter((s) => s === 'hello')).toHaveLength(1)
  })

  it('all the rules together do at most max_per_minute things a minute, and the rest are dropped', async () => {
    const r = rig([{ id: 'a', on: 'stream_end', do: [{ say: 'x' }] }], { max_per_minute: 3 })
    for (let i = 0; i < 6; i++) r.engine.fire({ type: 'stream_end' })
    await r.engine.idle()
    expect(r.said).toHaveLength(3)
    expect(r.logs.filter((l) => l.includes('is the limit'))).toHaveLength(1)
    r.clock.now += 61_000
    r.engine.fire({ type: 'stream_end' })
    await r.engine.idle()
    expect(r.said).toHaveLength(4)
  })

  it('rules run one at a time, in order; at most ten wait and the rest are dropped', async () => {
    const r = rig([{ id: 'a', on: 'stream_end', do: [{ tell: 'answer' }] }])
    let release!: () => void
    r.tellGate.wait = new Promise<void>((res) => (release = res))
    for (let i = 0; i < 14; i++) r.engine.fire({ type: 'stream_end' })
    expect(r.logs.filter((l) => l.includes('are already waiting'))).toHaveLength(4)
    await new Promise((res) => setTimeout(res, 20))
    expect(r.told).toHaveLength(1) // the second one waits for the first
    r.tellGate.wait = null
    release()
    await r.engine.idle()
    expect(r.told).toHaveLength(10)
  })

  it('an action that throws is written down and does not stop the next rule', async () => {
    const r = rig([
      { id: 'a', on: 'stream_end', do: [{ tell: 'x' }] },
      { id: 'b', on: 'stream_end', do: [{ say: 'still here' }] },
    ])
    const boom = new Error('the model is away\nwith a second line')
    const spy = vi.spyOn(r.told, 'push').mockImplementationOnce(() => {
      throw boom
    })
    r.engine.fire({ type: 'stream_end' })
    await r.engine.idle()
    spy.mockRestore()
    expect(r.said).toEqual(['still here'])
    expect(r.logs[0]).toBe('automation a: tell failed: the model is away')
  })

  it('a stopped engine ignores events', async () => {
    const r = rig([{ id: 'a', on: 'stream_end', do: [{ say: 'x' }] }])
    r.engine.stop()
    r.engine.fire({ type: 'stream_end' })
    await r.engine.idle()
    expect(r.said).toEqual([])
  })
})

describe('timers', () => {
  it('a timer rule fires every so many minutes while the engine runs, and stops when it stops', async () => {
    vi.useFakeTimers()
    const r = rig([
      { id: 'follow', on: 'timer', every_min: 20, do: [{ say: 'follow us' }] },
      { id: 'other', on: 'timer', every_min: 5, do: [{ say: 'tick' }] },
    ])
    r.engine.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(r.said).toEqual(['tick'])
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(r.said.filter((s) => s === 'follow us')).toHaveLength(1)
    expect(r.said.filter((s) => s === 'tick')).toHaveLength(4)
    r.engine.stop()
    const before = r.said.length
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(r.said).toHaveLength(before)
  })

  it('a timer event names its rule: another rule’s timer does not run this one', async () => {
    const r = rig([
      { id: 'a', on: 'timer', every_min: 5, do: [{ say: 'a' }] },
      { id: 'b', on: 'timer', every_min: 5, do: [{ say: 'b' }] },
    ])
    r.engine.fire({ type: 'timer', rule: 'b' })
    await r.engine.idle()
    expect(r.said).toEqual(['b'])
  })
})
