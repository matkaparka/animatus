import { afterEach, describe, expect, it } from 'vitest'
import { LIVE, applyLiveTuning } from '../../src/avatar/liveLayer.ts'
import { MOTION, applyMotionTuning } from '../../src/avatar/motionDirector.ts'
import { applyNumericTuning } from '../../src/avatar/tuning.ts'

const liveDefaults = structuredClone(LIVE)
const motionDefaults = structuredClone(MOTION)
afterEach(() => {
  Object.assign(LIVE, structuredClone(liveDefaults))
  Object.assign(MOTION, structuredClone(motionDefaults))
})

describe('applyLiveTuning', () => {
  it('assigns known numeric keys and returns the applied keys', () => {
    const applied = applyLiveTuning({ bodyScale: 0.5, nodAmp: 9, faceScale: 0 })
    expect(applied).toEqual(['bodyScale', 'nodAmp', 'faceScale'])
    expect(LIVE.bodyScale).toBe(0.5)
    expect(LIVE.nodAmp).toBe(9)
    expect(LIVE.faceScale).toBe(0)
  })

  it('ignores unknown keys and non-finite values', () => {
    const before = structuredClone(LIVE)
    const applied = applyLiveTuning({
      nope: 1,
      bodyScale: Number.NaN,
      nodAmp: Number.POSITIVE_INFINITY,
      tiltAmp: '3' as unknown as number,
      shrugAmp: null as unknown as number,
      talkLean: 4,
    })
    expect(applied).toEqual(['talkLean'])
    expect(LIVE).toEqual({ ...before, talkLean: 4 })
    expect('nope' in LIVE).toBe(false)
  })

  it('does not touch prototypes or non-numeric constants', () => {
    const evil = JSON.parse(
      '{"__proto__": 1, "constructor": 2, "toString": 3, "enabled": 0}'
    ) as Record<string, number>
    expect(applyLiveTuning(evil)).toEqual([])
    expect(LIVE.enabled).toBe(true)
    expect(Object.getPrototypeOf(LIVE)).toBe(Object.prototype)
  })

  it('sets one element of a [min, max] pair or the drift triple as key.N', () => {
    const applied = applyLiveTuning({
      'glanceYaw.1': 30,
      'driftHead.2': 0.5,
      'blinkInterval.0': 2,
      'glanceYaw.2': 1, // out of range
      'glanceYaw.x': 1, // not an index
      'bodyScale.0': 1, // not a tuple
      'nope.0': 1,
    })
    expect(applied).toEqual(['glanceYaw.1', 'driftHead.2', 'blinkInterval.0'])
    expect(LIVE.glanceYaw).toEqual([liveDefaults.glanceYaw[0], 30])
    expect(LIVE.driftHead).toEqual([liveDefaults.driftHead[0], liveDefaults.driftHead[1], 0.5])
    expect(LIVE.blinkInterval[0]).toBe(2)
    expect(LIVE.glanceYaw).toHaveLength(2)
  })

  it('an empty snapshot changes nothing', () => {
    expect(applyLiveTuning({})).toEqual([])
    expect(LIVE).toEqual(liveDefaults)
  })
})

describe('applyMotionTuning', () => {
  it('assigns known numeric keys and returns the applied keys', () => {
    expect(applyMotionTuning({ talkFade: 0.25, resumeWindow: 5, danceRootClamp: 0.2 })).toEqual([
      'talkFade',
      'resumeWindow',
      'danceRootClamp',
    ])
    expect(MOTION.talkFade).toBe(0.25)
    expect(MOTION.resumeWindow).toBe(5)
    expect(MOTION.danceRootClamp).toBe(0.2)
  })

  it('ignores unknown keys, the removed URL constant and non-finite values', () => {
    const before = structuredClone(MOTION)
    expect(
      applyMotionTuning({ defaultIdle: 1, bogus: 2, release: Number.NaN, idleFade: -Infinity })
    ).toEqual([])
    expect(MOTION).toEqual(before)
    expect('defaultIdle' in MOTION).toBe(false)
  })

  it('sets the speed and idleSwitch pairs element-wise', () => {
    expect(applyMotionTuning({ 'speed.0': 0.8, 'speed.1': 1.2, 'idleSwitch.0': 5 })).toEqual([
      'speed.0',
      'speed.1',
      'idleSwitch.0',
    ])
    expect(MOTION.speed).toEqual([0.8, 1.2])
    expect(MOTION.idleSwitch).toEqual([5, motionDefaults.idleSwitch[1]])
  })
})

describe('applyNumericTuning', () => {
  it('works on any plain object and reports keys in input order', () => {
    const target = { a: 1, b: [1, 2], c: 'text', d: { nested: 1 } }
    expect(applyNumericTuning(target, { 'b.1': 5, a: 3, c: 4, d: 5, 'd.nested': 6 })).toEqual([
      'b.1',
      'a',
    ])
    expect(target).toEqual({ a: 3, b: [1, 5], c: 'text', d: { nested: 1 } })
  })
})
