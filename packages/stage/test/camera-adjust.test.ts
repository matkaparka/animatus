import { describe, expect, it } from 'vitest'
import {
  IDENTITY,
  applyAdjust,
  clampAdjust,
  dollyAdjust,
  isIdentity,
  orbitAdjust,
  panAdjust,
  sameAdjust,
  type Adjust,
  type Pose,
  type Vec3,
} from '../src/camera.ts'

// Looking at the origin from 10 m away along +z, with a 20 degree lens.
const BASE: Pose = { position: [0, 0, 10], target: [0, 0, 0] }
const FOV = 20
const HEIGHT = 1000

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const near = (a: Vec3, b: Vec3, digits = 6) => {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i] as number, digits)
}
const adj = (over: Partial<Adjust>): Adjust => ({ ...IDENTITY, pan: [0, 0, 0], ...over })

describe('applyAdjust', () => {
  it('the identity adjustment leaves the base pose alone', () => {
    const p = applyAdjust(BASE, FOV, IDENTITY)
    near(p.position, BASE.position)
    near(p.target, BASE.target)
    expect(p.distance).toBeCloseTo(10, 6)
    near(p.right, [1, 0, 0])
    near(p.up, [0, 1, 0])
  })

  it('yaw orbits around the target at the same distance, and a quarter turn puts the camera on the x axis', () => {
    const p = applyAdjust(BASE, FOV, adj({ yaw: Math.PI / 2 }))
    expect(dist(p.position, p.target)).toBeCloseTo(10, 6)
    near(p.position, [10, 0, 0], 5)
    near(p.target, [0, 0, 0])
    // still looking at the target: the camera's right axis turned with it
    near(p.right, [0, 0, -1], 5)
  })

  it('positive pitch takes the camera up, looking down at the same point', () => {
    const p = applyAdjust(BASE, FOV, adj({ pitch: 0.5 }))
    expect(p.position[1]).toBeGreaterThan(1)
    expect(p.position[2]).toBeLessThan(10)
    expect(dist(p.position, p.target)).toBeCloseTo(10, 6)
  })

  it('pitch stops short of the poles, so the camera never flips', () => {
    const p = applyAdjust(BASE, FOV, adj({ pitch: 1.5 }))
    expect(Number.isFinite(p.right[0])).toBe(true)
    const q = applyAdjust(BASE, FOV, adj({ pitch: -1.5 }))
    expect(q.position[1]).toBeLessThan(0)
    expect(Math.hypot(...p.right)).toBeCloseTo(1, 6)
  })

  it('zoom scales the distance', () => {
    expect(dist(applyAdjust(BASE, FOV, adj({ zoom: 0.5 })).position, [0, 0, 0])).toBeCloseTo(5, 6)
    expect(dist(applyAdjust(BASE, FOV, adj({ zoom: 2 })).position, [0, 0, 0])).toBeCloseTo(20, 6)
  })

  it('pan moves the point looked at, in units of the visible height at the base distance', () => {
    const visible = 2 * 10 * Math.tan((FOV * Math.PI) / 360)
    const p = applyAdjust(BASE, FOV, adj({ pan: [0.25, -0.1, 0] }))
    near(p.target, [0.25 * visible, -0.1 * visible, 0])
    // the camera moved with it, keeping its direction and distance
    near(p.position, [0.25 * visible, -0.1 * visible, 10])
  })

  it('orbiting after panning keeps the panned point as the centre', () => {
    const panned = adj({ pan: [0.3, 0, 0], yaw: Math.PI })
    const p = applyAdjust(BASE, FOV, panned)
    const visible = 2 * 10 * Math.tan((FOV * Math.PI) / 360)
    near(p.target, [0.3 * visible, 0, 0])
    expect(dist(p.position, p.target)).toBeCloseTo(10, 5)
    expect(p.position[2]).toBeLessThan(-9) // the far side of it
  })

  it('works for a camera that is not on the z axis and for any scale', () => {
    const base: Pose = { position: [30, 12, 40], target: [0, 5, 0] }
    const p = applyAdjust(base, 30, IDENTITY)
    near(p.position, base.position)
    const q = applyAdjust(base, 30, adj({ zoom: 0.5 }))
    expect(dist(q.position, q.target)).toBeCloseTo(dist(base.position, base.target) / 2, 6)
  })

  it('a base with no distance is returned as it is, not turned into NaN', () => {
    const flat: Pose = { position: [1, 2, 3], target: [1, 2, 3] }
    const p = applyAdjust(flat, FOV, adj({ yaw: 1, zoom: 2, pan: [1, 1, 1] }))
    expect(p.position).toEqual([1, 2, 3])
  })
})

describe('gestures', () => {
  it('a drag across the whole height is one full turn, and dragging right turns the scene to the right', () => {
    const a = orbitAdjust(IDENTITY, 0, HEIGHT, HEIGHT)
    expect(a.pitch).toBeCloseTo(1.5, 6) // clamped: a full turn cannot go past the pole
    const right = orbitAdjust(IDENTITY, 100, 0, HEIGHT)
    expect(right.yaw).toBeCloseTo(-(2 * Math.PI * 100) / HEIGHT, 6)
    // the camera moved to the left of the scene, so the scene appears to turn right
    expect(applyAdjust(BASE, FOV, right).position[0]).toBeLessThan(0)
  })

  it('yaw wraps instead of growing without bound', () => {
    let a = IDENTITY
    for (let i = 0; i < 50; i++) a = orbitAdjust(a, 400, 0, HEIGHT)
    expect(Math.abs(a.yaw)).toBeLessThanOrEqual(Math.PI)
  })

  it('panning: the scene follows the pointer', () => {
    const before = applyAdjust(BASE, FOV, IDENTITY)
    const a = panAdjust(IDENTITY, 100, 0, HEIGHT, before.right, before.up)
    const after = applyAdjust(BASE, FOV, a)
    // pointer right: the point looked at moved left, so the scene moved right on screen
    expect(after.target[0]).toBeLessThan(0)
    // 100 px of a 1000 px tall view is a tenth of the visible height
    const visible = 2 * 10 * Math.tan((FOV * Math.PI) / 360)
    expect(after.target[0]).toBeCloseTo(-0.1 * visible, 6)
    const down = panAdjust(IDENTITY, 0, 100, HEIGHT, before.right, before.up)
    expect(applyAdjust(BASE, FOV, down).target[1]).toBeGreaterThan(0) // pointer down: scene down: target up
  })

  it('panning while zoomed in moves the target less for the same pixels', () => {
    const before = applyAdjust(BASE, FOV, IDENTITY)
    const wide = panAdjust(adj({ zoom: 1 }), 100, 0, HEIGHT, before.right, before.up).pan[0]
    const close = panAdjust(adj({ zoom: 0.25 }), 100, 0, HEIGHT, before.right, before.up).pan[0]
    expect(Math.abs(close)).toBeCloseTo(Math.abs(wide) / 4, 9)
  })

  it('the wheel closes the distance by five percent per hundred units, and back again', () => {
    const closer = dollyAdjust(IDENTITY, -100)
    expect(closer.zoom).toBeCloseTo(0.95, 9)
    expect(dollyAdjust(closer, 100).zoom).toBeCloseTo(1, 9)
    expect(dollyAdjust(IDENTITY, 100).zoom).toBeCloseTo(1 / 0.95, 9)
  })

  it('every gesture stays inside the bounds the protocol accepts, however wild', () => {
    let a = IDENTITY
    for (let i = 0; i < 400; i++) a = dollyAdjust(a, -1000)
    expect(a.zoom).toBe(0.1)
    for (let i = 0; i < 400; i++) a = dollyAdjust(a, 1000)
    expect(a.zoom).toBe(8)
    const p = panAdjust(IDENTITY, 1e9, -1e9, HEIGHT, [1, 0, 0], [0, 1, 0])
    for (const v of p.pan) expect(Math.abs(v)).toBeLessThanOrEqual(4)
    expect(
      clampAdjust({ yaw: Number.NaN, pitch: Infinity, zoom: -3, pan: [Number.NaN, 9, -9] })
    ).toEqual({
      yaw: 0,
      pitch: 0, // not a number of any kind: back to the default rather than a guess
      zoom: 0.1,
      pan: [0, 4, -4],
    })
  })

  it('identity and equality checks tolerate rounding', () => {
    expect(isIdentity(IDENTITY)).toBe(true)
    expect(isIdentity(adj({ zoom: 1.001 }))).toBe(false)
    expect(sameAdjust(adj({ yaw: 0.1 }), adj({ yaw: 0.100001 }))).toBe(true)
    expect(sameAdjust(adj({ pan: [0, 0.2, 0] }), adj({ pan: [0, 0.3, 0] }))).toBe(false)
  })
})
