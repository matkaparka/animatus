import { describe, expect, it } from 'vitest'
import { captionAt, lyricIndexAt, voiceActivity } from '../../src/activities/timeline.ts'

describe('lyricIndexAt', () => {
  const lines = [
    { t: 5, text: 'a' },
    { t: 10, text: 'b' },
    { t: 10.5, text: 'c' },
  ]
  it('is -1 before the first line and follows the timeline', () => {
    expect(lyricIndexAt(lines, 0)).toBe(-1)
    expect(lyricIndexAt(lines, 4.99)).toBe(-1)
    expect(lyricIndexAt(lines, 5)).toBe(0)
    expect(lyricIndexAt(lines, 9.9)).toBe(0)
    expect(lyricIndexAt(lines, 10)).toBe(1)
    expect(lyricIndexAt(lines, 100)).toBe(2)
  })
  it('handles an empty list', () => {
    expect(lyricIndexAt([], 3)).toBe(-1)
  })
})

describe('captionAt', () => {
  const caps = [
    { text: 'one', start: 1, end: 3 },
    { text: 'two', start: 10, end: 12 },
    { text: 'three', start: 13, end: 15 },
  ]
  it('shows a caption from just before it starts until 1.5 s after it ends', () => {
    expect(captionAt(caps, 0.5)).toBe('')
    expect(captionAt(caps, 0.95)).toBe('one')
    expect(captionAt(caps, 3.4)).toBe('one')
    expect(captionAt(caps, 4.6)).toBe('')
  })
  it('cuts over to the next caption when it starts before the hold expires', () => {
    expect(captionAt(caps, 12.5)).toBe('two')
    // the earlier caption is held until the next one's start, so there is no flicker of nothing
    expect(captionAt(caps, 12.95)).toBe('two')
    expect(captionAt(caps, 13.05)).toBe('three')
  })
  it('handles an empty list', () => {
    expect(captionAt([], 5)).toBe('')
  })
})

describe('voiceActivity', () => {
  const SR = 8000
  /** `spans` are [startSec, endSec] of loud sine bursts on a quiet noise floor. */
  const signal = (durSec: number, spans: [number, number][]) => {
    const s = new Float32Array(Math.round(durSec * SR))
    for (let i = 0; i < s.length; i++) {
      const t = i / SR
      const loud = spans.some(([a, b]) => t >= a && t < b)
      s[i] = (loud ? 0.5 : 0.0005) * Math.sin(2 * Math.PI * 220 * t)
    }
    return s
  }
  const active = (act: Uint8Array, sec: number) => act[Math.floor(sec / 0.05)] === 1

  it('marks phrases active and instrumental breaks inactive', () => {
    const act = voiceActivity(
      signal(12, [
        [1, 3],
        [8, 10],
      ]),
      SR
    )
    expect(active(act, 2)).toBe(true)
    expect(active(act, 9)).toBe(true)
    expect(active(act, 0.5)).toBe(false)
    expect(active(act, 6)).toBe(false) // long break stays inactive
  })

  it('bridges short breaths between phrases', () => {
    const act = voiceActivity(
      signal(8, [
        [1, 2],
        [2.4, 4],
      ]),
      SR
    )
    expect(active(act, 2.2)).toBe(true) // 0.4 s gap < 0.8 s bridge
  })

  it('holds the tail after a phrase ends', () => {
    const act = voiceActivity(signal(8, [[1, 2]]), SR)
    expect(active(act, 2.3)).toBe(true) // within the 0.5 s hold
    expect(active(act, 3)).toBe(false)
  })

  it('returns an empty array for empty input', () => {
    expect(voiceActivity(new Float32Array(0), SR)).toHaveLength(0)
  })
})
