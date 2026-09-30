import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@animatus/protocol'
import {
  ALARMS_KEPT,
  EVENTS_KEPT,
  TRACES_KEPT,
  initialState,
  mergeAlarms,
  reducer,
} from '../src/state.ts'
import type { ConsoleState } from '../src/state.ts'
import { alarm, mode, plugin, status } from './helpers.tsx'

const run = (text: string, ts = 1, over: Partial<RunEvent> = {}): RunEvent => ({
  ts,
  kind: 'system',
  text,
  ...over,
})
const withStatus = (over: Record<string, unknown> = {}): ConsoleState =>
  reducer(initialState, { type: 'status', status: status(over) })

describe('reducer', () => {
  it('starts empty', () => {
    expect(initialState).toEqual({
      status: null,
      events: [],
      traces: [],
      alarms: [],
      approvalsSeen: 0,
    })
  })

  it('an approvals event sets how many wait, and counts as a change for the page that lists them', () => {
    const state = withStatus()
    expect(state.status?.approvals_pending).toBe(0)
    const one = reducer(state, { type: 'event', event: { type: 'approvals', pending: 2 } })
    expect(one.status?.approvals_pending).toBe(2)
    expect(one.approvalsSeen).toBe(1)
    const two = reducer(one, { type: 'event', event: { type: 'approvals', pending: 1 } })
    expect([two.status?.approvals_pending, two.approvalsSeen]).toEqual([1, 2])
    // before the first status there is nowhere to put the number, but the change is still counted
    const early = reducer(initialState, { type: 'event', event: { type: 'approvals', pending: 3 } })
    expect([early.status, early.approvalsSeen]).toEqual([null, 1])
  })

  it('the approvals page telling how many wait changes the number and nothing else', () => {
    const state = withStatus()
    const next = reducer(state, { type: 'approvals', pending: 4 })
    expect(next.status?.approvals_pending).toBe(4)
    expect(next.approvalsSeen).toBe(0)
    expect(reducer(next, { type: 'approvals', pending: 4 })).toBe(next)
    expect(reducer(initialState, { type: 'approvals', pending: 4 })).toBe(initialState)
  })

  it('a status replaces the last one and brings its alarms in', () => {
    const state = reducer(initialState, {
      type: 'event',
      event: { type: 'status', status: status({ alarms: [alarm({ id: 'a', ts: 5 })] }) },
    })
    expect(state.status?.version).toBe('0.1.0')
    expect(state.alarms.map((a) => a.id)).toEqual(['a'])
    const next = reducer(state, {
      type: 'status',
      status: status({ version: '0.2.0', alarms: [alarm({ id: 'b', ts: 9 })] }),
    })
    expect(next.status?.version).toBe('0.2.0')
    expect(next.alarms.map((a) => a.id)).toEqual(['b', 'a'])
  })

  it('hello changes nothing', () => {
    const state = withStatus()
    expect(reducer(state, { type: 'event', event: { type: 'hello', api: 1, now: 1 } })).toBe(state)
  })

  it('run events are appended and only the newest 500 are kept', () => {
    let state = initialState
    for (let i = 0; i < EVENTS_KEPT + 25; i++)
      state = reducer(state, { type: 'event', event: { type: 'run', event: run(`e${i}`, i) } })
    expect(state.events).toHaveLength(EVENTS_KEPT)
    expect(state.events[0]?.text).toBe('e25')
    expect(state.events.at(-1)?.text).toBe(`e${EVENTS_KEPT + 24}`)
  })

  it('a trace is updated in place as its sentence progresses, and only the newest 100 are kept', () => {
    let state = reducer(initialState, {
      type: 'event',
      event: { type: 'trace', trace: { id: 't1', turn: 'u', text: 'hello' } },
    })
    state = reducer(state, {
      type: 'event',
      event: { type: 'trace', trace: { id: 't2', turn: 'u', text: 'again' } },
    })
    state = reducer(state, {
      type: 'event',
      event: {
        type: 'trace',
        trace: { id: 't1', turn: 'u', text: 'hello', synthMs: 120, liveMotion: 'used' },
      },
    })
    expect(state.traces.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(state.traces[0]).toMatchObject({ synthMs: 120, liveMotion: 'used' })
    for (let i = 0; i < TRACES_KEPT + 10; i++)
      state = reducer(state, {
        type: 'event',
        event: { type: 'trace', trace: { id: `x${i}`, turn: 'u', text: 't' } },
      })
    expect(state.traces).toHaveLength(TRACES_KEPT)
    expect(state.traces.at(-1)?.id).toBe(`x${TRACES_KEPT + 9}`)
  })

  it('alarms: one per id, newest first, bounded', () => {
    let state = initialState
    state = reducer(state, {
      type: 'event',
      event: { type: 'alarm', alarm: alarm({ id: 'a', ts: 10, message: 'first' }) },
    })
    state = reducer(state, {
      type: 'event',
      event: { type: 'alarm', alarm: alarm({ id: 'b', ts: 30 }) },
    })
    state = reducer(state, {
      type: 'event',
      event: { type: 'alarm', alarm: alarm({ id: 'a', ts: 10, message: 'second' }) },
    })
    expect(state.alarms.map((a) => [a.id, a.message])).toEqual([
      ['b', 'something'],
      ['a', 'second'],
    ])
    expect(
      mergeAlarms(
        [],
        Array.from({ length: ALARMS_KEPT + 5 }, (_, i) => alarm({ id: `x${i}`, ts: i }))
      ).length
    ).toBe(ALARMS_KEPT)
    expect(
      mergeAlarms(
        [],
        Array.from({ length: ALARMS_KEPT + 5 }, (_, i) => alarm({ id: `x${i}`, ts: i }))
      )[0]?.id
    ).toBe(`x${ALARMS_KEPT + 4}`)
  })

  it('a plugin event replaces that plugin in the status, or adds it; without a status there is nothing to change', () => {
    const state = withStatus({
      plugins: [
        plugin({ id: 'speech', status: 'ready' }),
        plugin({ id: 'motion', status: 'ready' }),
      ],
    })
    const changed = reducer(state, {
      type: 'event',
      event: { type: 'plugin', plugin: plugin({ id: 'motion', status: 'failed' }) },
    })
    expect(changed.status?.plugins.map((p) => [p.id, p.status])).toEqual([
      ['speech', 'ready'],
      ['motion', 'failed'],
    ])
    const added = reducer(state, {
      type: 'plugin',
      plugin: plugin({ id: 'image', status: 'stopped' }),
    })
    expect(added.status?.plugins.map((p) => p.id)).toEqual(['speech', 'motion', 'image'])
    expect(reducer(initialState, { type: 'plugin', plugin: plugin() })).toBe(initialState)
    expect(
      reducer(state, { type: 'plugins', plugins: [plugin({ id: 'only' })] }).status?.plugins.map(
        (p) => p.id
      )
    ).toEqual(['only'])
  })

  it('a mode event replaces that mode in the status', () => {
    const state = withStatus({ modes: [mode({ id: 'dance' }), mode({ id: 'sing' })] })
    const changed = reducer(state, {
      type: 'event',
      event: { type: 'mode', mode: mode({ id: 'sing', state: 'ACTIVE' }) },
    })
    expect(changed.status?.modes.map((m) => [m.id, m.state])).toEqual([
      ['dance', 'IDLE'],
      ['sing', 'ACTIVE'],
    ])
    expect(reducer(initialState, { type: 'mode', mode: mode() })).toBe(initialState)
    expect(reducer(state, { type: 'modes', modes: [] }).status?.modes).toEqual([])
  })

  it('history goes in front of what the socket delivered meanwhile, without duplicating it', () => {
    let state = reducer(initialState, {
      type: 'event',
      event: { type: 'run', event: run('live 1', 100) },
    })
    state = reducer(state, {
      type: 'event',
      event: { type: 'trace', trace: { id: 't-live', turn: 'u', text: 'live' } },
    })
    const next = reducer(state, {
      type: 'history',
      events: [run('old 1', 10), run('old 2', 20), run('live 1', 100)],
      traces: [
        { id: 't-old', turn: 'u', text: 'old' },
        { id: 't-live', turn: 'u', text: 'stale copy' },
      ],
    })
    expect(next.events.map((e) => e.text)).toEqual(['old 1', 'old 2', 'live 1'])
    expect(next.traces.map((t) => [t.id, t.text])).toEqual([
      ['t-old', 'old'],
      ['t-live', 'live'],
    ])
  })

  it('history is bounded like everything else', () => {
    const many = Array.from({ length: EVENTS_KEPT + 50 }, (_, i) => run(`h${i}`, i))
    const state = reducer(initialState, { type: 'history', events: many, traces: [] })
    expect(state.events).toHaveLength(EVENTS_KEPT)
    expect(state.events.at(-1)?.text).toBe(`h${EVENTS_KEPT + 49}`)
  })
})
