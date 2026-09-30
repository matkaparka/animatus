import { describe, expect, it } from 'vitest'
import { JitterScheduler } from '../../src/audio/jitter.ts'

const SR = 32000
const chunk = (sec: number) => new Float32Array(Math.round(sec * SR)).fill(0.1)
const total = (cs: { duration: number }[]) => cs.reduce((a, c) => a + c.duration, 0)

describe('JitterScheduler', () => {
  it('starts immediately with a small lead when the whole utterance is already here', () => {
    const j = new JitterScheduler(SR)
    for (let i = 0; i < 3; i++) j.push(chunk(0.15))
    j.markLast()
    const out = j.pump(10)
    expect(out).toHaveLength(3)
    expect(out[0]!.startAt).toBeCloseTo(10.03, 9)
    expect(j.state).toBe('finished')
    expect(j.allScheduled).toBe(true)
    expect(j.endsAt).toBeCloseTo(10.03 + 0.45, 9)
    expect(j.startedAt).toBeCloseTo(10.03, 9)
  })

  it('schedules consecutive chunks with no gap and no overlap', () => {
    const j = new JitterScheduler(SR)
    for (let i = 0; i < 6; i++) j.push(chunk(0.1))
    j.markLast()
    const out = j.pump(5)
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.startAt).toBeCloseTo(out[i - 1]!.startAt + out[i - 1]!.duration, 9)
    }
    expect(total(out)).toBeCloseTo(0.6, 9)
  })

  it('waits for the pre-roll before starting a stream', () => {
    const j = new JitterScheduler(SR)
    j.push(chunk(0.05))
    expect(j.pump(1)).toHaveLength(0)
    expect(j.state).toBe('buffering')
    j.push(chunk(0.12)) // 0.17 s >= 0.15 s
    const out = j.pump(1.1)
    expect(out.length).toBeGreaterThan(0)
    expect(j.state).toBe('playing')
    expect(out[0]!.startAt).toBeCloseTo(1.13, 9)
  })

  it('a short utterance below the pre-roll starts as soon as it is complete', () => {
    const j = new JitterScheduler(SR)
    j.push(chunk(0.05))
    expect(j.pump(2)).toHaveLength(0)
    j.markLast()
    const out = j.pump(2.01)
    expect(out).toHaveLength(1)
    expect(j.state).toBe('finished')
  })

  it('an utterance with no audio finishes at once and reports no end time', () => {
    const j = new JitterScheduler(SR)
    j.markLast()
    expect(j.pump(3)).toEqual([])
    expect(j.state).toBe('finished')
    expect(j.endsAt).toBeNull()
    expect(j.startedAt).toBeNull()
  })

  it('never schedules more than maxAhead ahead of now', () => {
    const j = new JitterScheduler(SR, { maxAheadSec: 1.5 })
    for (let i = 0; i < 10; i++) j.push(chunk(0.5)) // 5 s
    j.markLast()
    let out = j.pump(0)
    // the loop schedules while nextStart - now < 1.5: chunks at 0.03, 0.53, 1.03 -> 3 chunks
    expect(out).toHaveLength(3)
    expect(j.state).toBe('playing')
    out = j.pump(1) // nextStart is 1.53, 0.53 ahead of 1 -> two more
    expect(out).toHaveLength(2)
    out = j.pump(3)
    expect(out.length).toBeGreaterThan(0)
  })

  it('a steady stream that keeps ahead never underruns', () => {
    const j = new JitterScheduler(SR)
    let now = 0
    let scheduledUntil = 0
    for (let i = 0; i < 40; i++) {
      j.push(chunk(0.15)) // arrives at real-time pace
      const out = j.pump(now)
      for (const c of out) scheduledUntil = c.startAt + c.duration
      now += 0.15
    }
    expect(j.underruns).toBe(0)
    expect(scheduledUntil).toBeGreaterThan(now)
  })

  it('re-syncs after an underrun: stops, re-buffers with a longer pre-roll, restarts from now', () => {
    const j = new JitterScheduler(SR)
    j.push(chunk(0.3))
    let out = j.pump(0)
    expect(out).toHaveLength(1)
    const firstEnd = j.endsAt!
    // time passes beyond the end, no data arrived
    expect(j.pump(firstEnd + 0.2)).toEqual([])
    expect(j.underruns).toBe(1)
    expect(j.state).toBe('buffering')
    expect(j.currentPrebufferSec).toBeCloseTo(0.225, 9)
    // new data: less than the raised pre-roll -> waits
    j.push(chunk(0.2))
    expect(j.pump(firstEnd + 0.3)).toEqual([])
    // enough now -> restarts from "now", not from the stale schedule
    j.push(chunk(0.1))
    out = j.pump(firstEnd + 0.4)
    expect(out[0]!.startAt).toBeCloseTo(firstEnd + 0.4 + 0.05, 9)
    expect(j.state).toBe('playing')
  })

  it('counts a late pump (data waiting, schedule already dry) as an underrun and re-syncs', () => {
    const j = new JitterScheduler(SR)
    j.push(chunk(0.2))
    j.pump(0) // scheduled 0.03 .. 0.23
    j.push(chunk(0.2))
    const out = j.pump(1) // the frame loop stalled for a second
    expect(j.underruns).toBe(1)
    expect(out[0]!.startAt).toBeCloseTo(1.05, 9)
  })

  it('the pre-roll growth is capped', () => {
    const j = new JitterScheduler(SR, { prebufferSec: 0.3, maxPrebufferSec: 0.5 })
    let now = 0
    for (let k = 0; k < 4; k++) {
      j.push(chunk(0.6))
      j.pump(now)
      now = j.endsAt! + 0.5
      j.pump(now) // dry
    }
    expect(j.currentPrebufferSec).toBeLessThanOrEqual(0.5)
  })

  it('chains gaplessly after the previous utterance (notBefore)', () => {
    const prevEnds = 10.4
    const j = new JitterScheduler(SR, {}, prevEnds)
    j.push(chunk(0.2))
    j.markLast()
    const out = j.pump(10)
    expect(out[0]!.startAt).toBeCloseTo(prevEnds, 9)
  })

  it('a notBefore in the past does not delay the start', () => {
    const j = new JitterScheduler(SR, {}, 1)
    j.push(chunk(0.2))
    j.markLast()
    expect(j.pump(10)[0]!.startAt).toBeCloseTo(10.03, 9)
  })

  it('reports buffered and scheduled durations', () => {
    const j = new JitterScheduler(SR)
    j.push(chunk(0.1))
    expect(j.bufferedSec).toBeCloseTo(0.1, 9)
    j.push(chunk(0.1))
    j.pump(0)
    expect(j.bufferedSec).toBeCloseTo(0, 9)
    expect(j.scheduledSec).toBeCloseTo(0.2, 9)
  })
})
