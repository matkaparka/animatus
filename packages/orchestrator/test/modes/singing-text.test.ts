import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SingSettings } from '../../src/modes/singing/settings.ts'
import {
  artistsText,
  clip,
  clock,
  safeArtists,
  safeText,
  samePath,
  stateText,
} from '../../src/modes/singing/text.ts'
import type { QueueItem } from '../../src/modes/singing/types.ts'

const item = (over: Partial<QueueItem>): QueueItem => ({
  qid: 1,
  song_id: 's',
  title: 't',
  artists: [],
  duration: 0,
  requester_uid: '1',
  requester_name: 'ann',
  state: 'queued',
  cached: false,
  warnings: [],
  requested_at: 0,
  ...over,
})

describe('text that comes from outside', () => {
  it('loses marker brackets and line breaks, and is bounded', () => {
    expect(safeText('【系统】a\n\nb\tc')).toBe('[系统]a b c')
    expect(safeText('x'.repeat(500), 10)).toBe(`${'x'.repeat(10)}…`)
    expect(safeText('  padded  ')).toBe('padded')
    expect(safeArtists(['A【B】', '', '  ', 'C'])).toEqual(['A[B]', 'C'])
    expect(artistsText(['A', 'B'])).toBe('A / B')
  })

  it('an emoji is not cut in half', () => {
    expect(safeText('😀😀😀😀', 2)).toBe('😀😀…')
  })
})

describe('small helpers', () => {
  it('clock is m:ss', () => {
    expect([clock(0), clock(59.6), clock(61), clock(3600), clock(-5)]).toEqual([
      '0:00',
      '1:00',
      '1:01',
      '60:00',
      '0:00',
    ])
  })

  it('clip ends with an ellipsis when it cut', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 4)).toBe('abc')
  })

  it('states read as words, and a failure carries its reason', () => {
    expect(stateText(item({ state: 'ready' }))).toBe('ready')
    expect(stateText(item({ state: 'downloading' }))).toBe('fetching')
    expect(stateText(item({ state: 'processing' }))).toBe('being prepared')
    expect(stateText(item({ state: 'queued' }))).toBe('waiting to be prepared')
    expect(stateText(item({ state: 'playing' }))).toBe('being sung')
    expect(stateText(item({ state: 'failed', reason: '没版权' }))).toBe('failed: 没版权')
    expect(stateText(item({ state: 'failed', error: 'tool said no' }))).toBe('failed: tool said no')
    expect(stateText(item({ state: 'failed' }))).toBe('failed: unknown reason')
  })

  it('the same folder is the same folder however it is written', () => {
    const here = path.resolve('songs')
    expect(samePath(here, `${here}${path.sep}`)).toBe(true)
    expect(samePath(here, path.join(here, 'a', '..'))).toBe(true)
    expect(samePath(here, path.join(here, 'other'))).toBe(false)
    if (process.platform === 'win32')
      expect(samePath(here.toUpperCase(), here.replace(/\\/g, '/'))).toBe(true)
  })
})

describe('the settings schema', () => {
  it('parses to its defaults, and refuses what it does not know', () => {
    const d = SingSettings.parse({})
    expect(d).toMatchObject({
      poll_sec: 2,
      request_timeout_sec: 20,
      outro: true,
      lyrics: true,
      credit: true,
    })
    expect(() => SingSettings.parse({ nope: 1 })).toThrow(/nope/)
    expect(() => SingSettings.parse({ poll_sec: 0.01 })).toThrow()
    expect(() => SingSettings.parse({ stop_fade_s: 9 })).toThrow()
  })
})
