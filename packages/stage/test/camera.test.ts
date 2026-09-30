import { describe, expect, it } from 'vitest'
import { fitCamera, frameSpan, type BodyMetrics, type FitMode } from '../src/camera.ts'

// Roughly the proportions of the model this stage was built against: 4 m to the head, hips at 2 m.
const BIG: BodyMetrics = { x: 0, z: -0.2, footY: 0.38, hipsY: 2.02, headY: 4.23 }
const HUMAN: BodyMetrics = { x: 0, z: 0, footY: 0.08, hipsY: 0.9, headY: 1.5 }
const MODES: FitMode[] = ['head', 'upper_body', 'full_body']

const tan = (fov: number) => Math.tan((fov * Math.PI) / 360)

describe('frameSpan', () => {
  it('is ordered head < upper_body < full_body, and always brackets the head joint', () => {
    for (const m of [BIG, HUMAN]) {
      const head = frameSpan('head', m)
      const upper = frameSpan('upper_body', m)
      const full = frameSpan('full_body', m)
      expect(head.bottom).toBeGreaterThan(upper.bottom)
      expect(upper.bottom).toBeGreaterThan(full.bottom)
      for (const s of [head, upper, full]) {
        expect(s.bottom).toBeLessThan(m.headY)
        expect(s.top).toBeGreaterThan(m.headY)
      }
    }
  })

  it('full body reaches below the ankle joints and upper body stops at the hips', () => {
    expect(frameSpan('full_body', HUMAN).bottom).toBeLessThan(HUMAN.footY)
    expect(frameSpan('upper_body', HUMAN).bottom).toBe(HUMAN.hipsY)
  })
})

describe('fitCamera', () => {
  it('looks straight along -z at the middle of the framed span, from the body position', () => {
    const c = fitCamera('upper_body', 20, 16 / 9, BIG)
    const span = frameSpan('upper_body', BIG)
    expect(c.target[1]).toBeCloseTo((span.top + span.bottom) / 2, 6)
    expect(c.position[1]).toBe(c.target[1])
    expect(c.position[0]).toBe(BIG.x)
    expect(c.target[2]).toBe(BIG.z)
    expect(c.position[2]).toBeGreaterThan(BIG.z)
  })

  it.each(MODES)('%s: the span fits the frame with a little air, never much more', (fit) => {
    for (const aspect of [16 / 9, 1]) {
      const c = fitCamera(fit, 20, aspect, BIG)
      const visible = 2 * (c.position[2] - c.target[2]) * tan(20)
      const span = frameSpan(fit, BIG)
      expect(visible).toBeGreaterThanOrEqual(span.top - span.bottom)
      expect(visible).toBeLessThan((span.top - span.bottom) * 1.5)
    }
  })

  it('backs off for a narrow window, because the width has to fit as well', () => {
    // A standing figure is taller than wide, so a phone-shaped window is still limited by height...
    const wide = fitCamera('full_body', 20, 16 / 9, HUMAN)
    expect(fitCamera('full_body', 20, 9 / 16, HUMAN).position[2]).toBeCloseTo(wide.position[2], 6)
    // ...and only a really narrow one is limited by width.
    const narrow = fitCamera('full_body', 20, 0.3, HUMAN)
    expect(narrow.position[2]).toBeGreaterThan(wide.position[2])
    const visibleWidth = 2 * (narrow.position[2] - narrow.target[2]) * tan(20) * 0.3
    expect(visibleWidth).toBeGreaterThanOrEqual(2 * 0.32 * (HUMAN.headY - HUMAN.footY))
  })

  it('a wider lens comes closer', () => {
    const tele = fitCamera('upper_body', 20, 16 / 9, HUMAN)
    const wideLens = fitCamera('upper_body', 40, 16 / 9, HUMAN)
    expect(wideLens.position[2]).toBeLessThan(tele.position[2])
  })

  it('is scale invariant: the same figure twice the size is framed from twice the distance', () => {
    const k = 2
    const big: BodyMetrics = {
      x: 0,
      z: 0,
      footY: HUMAN.footY * k,
      hipsY: HUMAN.hipsY * k,
      headY: HUMAN.headY * k,
    }
    for (const fit of MODES) {
      const a = fitCamera(fit, 20, 16 / 9, HUMAN)
      const b = fitCamera(fit, 20, 16 / 9, big)
      expect(b.position[2]).toBeCloseTo(a.position[2] * k, 6)
      expect(b.target[1]).toBeCloseTo(a.target[1] * k, 6)
    }
  })

  it('survives degenerate input without NaN', () => {
    const flat: BodyMetrics = { x: 0, z: 0, footY: 1, hipsY: 1, headY: 1 }
    for (const fit of MODES) {
      for (const aspect of [0, 1e-9, 1e9]) {
        const c = fitCamera(fit, 0, aspect, flat)
        for (const v of [...c.position, ...c.target]) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })
})
