import { describe, expect, it } from 'vitest'
import { ModePanel } from '@animatus/protocol'
import { MAX_ROWS, clip, sleepPanel } from '../../src/modes/controllers/sleepPanel.ts'
import type { PanelState } from '../../src/modes/controllers/sleepPanel.ts'

const track = (key: string, over: Partial<PanelState['tracks'][number]> = {}) => ({
  key,
  title: key,
  durationS: 600,
  lines: 12,
  ext: '.mp3',
  notes: [],
  ...over,
})

const state = (over: Partial<PanelState> = {}): PanelState => ({
  running: true,
  idle: null,
  replying: false,
  phase: 'playing',
  connected: true,
  currentKey: 'rain',
  upcoming: ['ocean'],
  lastError: null,
  tracks: [track('rain'), track('ocean')],
  skipped: [],
  library: 'C:/path/to/asmr',
  problem: null,
  volume: 1,
  whisper: { style: 'whisper', found: true },
  order: { shuffle: false, loop: true },
  replies: { enabled: true, firstAfterS: 30, everyS: 90 },
  testLine: 'good night',
  ...over,
})

const status = (over: Partial<PanelState> = {}) => sleepPanel(state(over)).status

describe('the status line', () => {
  it('says what the mode is doing, in the order of what matters most', () => {
    expect(status({ running: false })).toBe('not running; 2 track(s) ready')
    expect(status({ running: false, tracks: [] })).toBe('not running; no tracks found yet')
    expect(status({ replying: true })).toBe('whispering; the track comes back afterwards')
    expect(status({ replying: true, idle: 'failed' })).toBe(
      'whispering; there is no track to bring back'
    )
    expect(status({ idle: 'empty' })).toBe('no tracks: only whispered replies')
    expect(status({ idle: 'failed' })).toContain('no track could be played')
    expect(status({ idle: 'finished' })).toBe('the playlist has ended: only whispered replies')
    expect(status({ currentKey: null })).toBe('starting')
    expect(status({ connected: false })).toBe('waiting for the stage page to connect (then "rain")')
  })

  it('follows what the stage reported about the track', () => {
    expect(status({ phase: 'playing' })).toBe('playing "rain" (1 of 2)')
    expect(status({ phase: 'playing', currentKey: 'ocean' })).toBe('playing "ocean" (2 of 2)')
    expect(status({ phase: 'paused' })).toBe('"rain" is paused')
    expect(status({ phase: 'ended' })).toBe('"rain" has ended; starting the next')
    expect(status({ phase: 'off' })).toBe('the stage has stopped "rain"')
    for (const phase of ['loading', 'error', null] as const)
      expect(status({ phase })).toBe('starting "rain" (1 of 2)')
  })

  it('a track that is no longer in the list is still named', () => {
    expect(status({ currentKey: 'gone' })).toContain('"gone"')
  })
})

describe('the panel', () => {
  it('marks the current row and offers a button on each', () => {
    const p = ModePanel.parse(sleepPanel(state({ currentKey: 'ocean' })))
    expect(p.sections[0]!.rows.map((r) => [r.id, r.active])).toEqual([
      ['rain', false],
      ['ocean', true],
    ])
    expect(
      p.sections[0]!.rows.every((r) => r.actions.map((a) => a.id).join() === 'play,skip')
    ).toBe(true)
  })

  it('skip is offered for the track that is playing and for one still to come, and says why it is not for the others', () => {
    const skips = (over: Partial<PanelState>) =>
      Object.fromEntries(
        ModePanel.parse(sleepPanel(state(over))).sections[0]!.rows.map((r) => [
          r.id,
          r.actions.find((a) => a.id === 'skip')!.disabled,
        ])
      )
    const three = { tracks: [track('rain'), track('ocean'), track('forest')] }
    // rain plays, ocean is next, forest has already played this round
    expect(skips({ ...three, upcoming: ['ocean'] })).toEqual({
      rain: undefined,
      ocean: undefined,
      forest: 'it is not coming up in this round',
    })
    expect(skips({ running: false, currentKey: null, upcoming: [] })).toEqual({
      rain: 'sleep mode is not running',
      ocean: 'sleep mode is not running',
    })
    expect(skips({ idle: 'finished', upcoming: [] })).toEqual({
      rain: 'nothing is playing',
      ocean: 'nothing is playing',
    })
  })

  it('a stopped mode has only the volume to offer, and says why the rest are off', () => {
    const p = ModePanel.parse(sleepPanel(state({ running: false, currentKey: null })))
    expect(p.actions.map((a) => [a.id, a.disabled])).toEqual([
      ['next', 'sleep mode is not running'],
      ['volume', undefined],
      ['whisper_test', 'sleep mode is not running'],
      ['stop', 'sleep mode is not running'],
    ])
  })

  it('"next" is off when there is nothing to go to; the test line is off while one is whispered', () => {
    const none = ModePanel.parse(sleepPanel(state({ tracks: [], idle: 'empty' })))
    expect(none.actions.find((a) => a.id === 'next')!.disabled).toBe('there are no tracks')
    const busy = ModePanel.parse(sleepPanel(state({ replying: true })))
    expect(busy.actions.find((a) => a.id === 'whisper_test')!.disabled).toContain('right now')
    expect(busy.actions.find((a) => a.id === 'next')!.disabled).toBeUndefined()
  })

  it('facts about the folder appear only when there is something to say', () => {
    const labels = (p: PanelState) => sleepPanel(p).facts!.map((f) => f.label)
    expect(labels(state())).toEqual(['Tracks', 'Whisper voice', 'Volume', 'Chat replies', 'Order'])
    expect(
      labels(
        state({
          problem: 'the asmr folder cannot be read',
          lastError: 'x',
          skipped: [{ path: 'a', reason: 'b' }],
        })
      )
    ).toEqual([
      'Tracks',
      'Whisper voice',
      'Volume',
      'Chat replies',
      'Order',
      'Folder',
      'Last problem',
      'Left out',
    ])
  })

  it('with no folder configured the empty list says how to set one up', () => {
    const p = ModePanel.parse(sleepPanel(state({ library: null, tracks: [], problem: 'x' })))
    expect(p.sections[0]!.empty).toContain('paths.asmr')
    expect(p.facts.find((f) => f.label === 'Tracks')!.value).toContain('paths.asmr')
  })

  it('whatever it is fed, it stays inside the limits of a panel (or the console would show nothing)', () => {
    const long = 'x'.repeat(2_000)
    const p = ModePanel.parse(
      sleepPanel(
        state({
          tracks: Array.from({ length: MAX_ROWS + 50 }, (_, i) =>
            track(`${'k'.repeat(100)}${i}`, {
              title: long,
              notes: [long, long],
            })
          ),
          currentKey: `${'k'.repeat(100)}3`,
          lastError: long,
          problem: long,
          library: long,
          skipped: [{ path: long, reason: long }],
          testLine: long,
          whisper: { style: 'w'.repeat(32), found: false },
        })
      )
    )
    expect(p.sections[0]!.rows).toHaveLength(MAX_ROWS)
    expect(p.sections[0]!.title).toBe(`Tracks (the first ${MAX_ROWS} of ${MAX_ROWS + 50})`)
    expect(p.status!.length).toBeLessThanOrEqual(300)
  })
})

describe('clip', () => {
  it('cuts to the length with an ellipsis and leaves shorter text alone', () => {
    expect(clip('abc', 5)).toBe('abc')
    expect(clip('abcde', 5)).toBe('abcde')
    expect(clip('abcdef', 5)).toBe('abcd…')
  })
})
