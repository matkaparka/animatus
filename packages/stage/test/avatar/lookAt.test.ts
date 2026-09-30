import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { VRMLookAt } from '@pixiv/three-vrm'
import type { VRMLookAtApplier } from '@pixiv/three-vrm'
import {
  DEFAULT_SACCADE,
  DEFAULT_SMOOTH_TAU,
  SmoothLookAt,
  attachGazeTarget,
} from '../../src/avatar/lookAt.ts'
import { makeFakeVrm, seededRandom } from './fakeVrm.ts'

const DT = 1 / 60

/** Head of the fake model is at about (0.2, 1.53, 0.1) and faces +Z. */
const HEAD = new THREE.Vector3(0.2, 1.53, 0.1)

function recorder() {
  const applied: { yaw: number; pitch: number }[] = []
  const applier: VRMLookAtApplier = {
    applyYawPitch: (yaw, pitch) => {
      applied.push({ yaw, pitch })
    },
    lookAt: () => {},
  }
  return { applied, applier }
}

/** A smooth look-at on the fake model's humanoid, and a reference plain VRMLookAt that gives the raw angles. */
function setup(opts: ConstructorParameters<typeof SmoothLookAt>[2] = {}) {
  const fake = makeFakeVrm({ lookAt: false })
  const { applied, applier } = recorder()
  const look = new SmoothLookAt(fake.vrm.humanoid, applier, opts)
  const ref = new VRMLookAt(fake.vrm.humanoid, recorder().applier)
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(HEAD.x, HEAD.y, HEAD.z + 3)
  camera.updateMatrixWorld(true)
  const target = new THREE.Object3D()
  camera.add(target)
  look.target = target
  ref.target = target
  const raw = () => {
    ref.update(0)
    return { yaw: ref.yaw, pitch: ref.pitch }
  }
  const last = () => applied[applied.length - 1]!
  return { fake, look, ref, camera, target, applied, raw, last }
}

/** Sequence of numbers, then a constant. */
function scripted(values: number[], fallback = 0.5) {
  let i = 0
  return () => (i < values.length ? values[i++]! : fallback)
}

describe('attachGazeTarget', () => {
  it('creates a child of the camera and points the model at it', () => {
    const fake = makeFakeVrm()
    const camera = new THREE.PerspectiveCamera()
    const target = attachGazeTarget(fake.vrm, camera)
    expect(target.parent).toBe(camera)
    expect(fake.vrm.lookAt?.target).toBe(target)
    expect(attachGazeTarget(fake.vrm, camera)).not.toBe(target) // each call makes a new one
  })

  it('still returns a target for a model without look-at', () => {
    const fake = makeFakeVrm({ lookAt: false })
    const camera = new THREE.PerspectiveCamera()
    const target = attachGazeTarget(fake.vrm, camera)
    expect(target.parent).toBe(camera)
    expect(fake.vrm.lookAt).toBeUndefined()
  })
})

describe('SmoothLookAt smoothing', () => {
  it('follows the target with an exponential filter (time constant tau)', () => {
    const { look, target, raw, last, applied } = setup({ tau: 0.05, saccade: { enabled: false } })
    target.position.set(0, 0, 0)
    look.update(DT)
    expect(last().yaw).toBeCloseTo(0, 6)
    expect(last().pitch).toBeCloseTo(0, 6)

    target.position.set(1, 0.5, 0)
    const r = raw()
    expect(Math.abs(r.yaw)).toBeGreaterThan(5)
    look.update(DT)
    const k = 1 - Math.exp(-DT / 0.05)
    expect(last().yaw).toBeCloseTo(r.yaw * k, 6)
    expect(last().pitch).toBeCloseTo(r.pitch * k, 6)

    // it never overshoots and converges
    let prev = last().yaw
    for (let i = 0; i < 300; i++) {
      look.update(DT)
      const y = last().yaw
      expect(Math.abs(y - r.yaw)).toBeLessThanOrEqual(Math.abs(prev - r.yaw) + 1e-9)
      prev = y
    }
    expect(last().yaw).toBeCloseTo(r.yaw, 4)
    expect(last().pitch).toBeCloseTo(r.pitch, 4)
    expect(applied.length).toBe(302)
  })

  it('starts at the target on the first update instead of swinging over from zero', () => {
    const { look, target, raw, last } = setup({ saccade: { enabled: false } })
    target.position.set(2, -1, 0)
    const r = raw()
    look.update(DT)
    expect(last().yaw).toBeCloseTo(r.yaw, 9)
    expect(last().pitch).toBeCloseTo(r.pitch, 9)
  })

  it('snaps to a new target object instead of swinging over', () => {
    const { look, camera, target, last } = setup({ saccade: { enabled: false } })
    target.position.set(0, 0, 0)
    look.update(DT)
    const other = new THREE.Object3D()
    camera.add(other)
    other.position.set(-2, 1, 0)
    look.target = other
    const ref = new VRMLookAt(look.humanoid, recorder().applier)
    ref.target = other
    ref.update(0)
    look.update(DT)
    expect(last().yaw).toBeCloseTo(ref.yaw, 9)
    expect(last().pitch).toBeCloseTo(ref.pitch, 9)
  })

  it('takes the short way round when the target crosses behind the head', () => {
    const { look, camera, target, last } = setup({ saccade: { enabled: false } })
    camera.position.set(HEAD.x, HEAD.y, HEAD.z - 3) // behind the model
    camera.updateMatrixWorld(true)
    target.position.set(0.05, 0, 0)
    look.update(DT)
    const before = last().yaw
    expect(Math.abs(before)).toBeGreaterThan(170)
    target.position.set(-0.05, 0, 0)
    const seen: number[] = []
    for (let i = 0; i < 200; i++) {
      look.update(DT)
      seen.push(last().yaw)
    }
    expect(seen.every((y) => Math.abs(y) > 170)).toBe(true)
    expect(Math.abs(last().yaw)).toBeGreaterThan(170)
    expect(Math.sign(last().yaw)).toBe(-Math.sign(before)) // ended up on the other side of +-180
  })

  it('keeps the applied yaw inside [-180, 180)', () => {
    const { look, target, camera, last } = setup({ saccade: { enabled: false } })
    camera.position.set(HEAD.x, HEAD.y, HEAD.z - 3)
    camera.updateMatrixWorld(true)
    for (let i = 0; i < 600; i++) {
      target.position.set(Math.sin(i / 20) * 0.3, 0, 0)
      look.update(DT)
      expect(last().yaw).toBeGreaterThanOrEqual(-180)
      expect(last().yaw).toBeLessThan(180)
    }
  })

  it('reports the applied angles through yaw / pitch and never applies more than once per update', () => {
    const { look, target, applied, last } = setup({ saccade: { enabled: false } })
    target.position.set(1, 0, 0)
    look.update(DT)
    look.update(DT)
    expect(applied).toHaveLength(2)
    expect(look.yaw).toBeCloseTo(last().yaw, 12)
    expect(look.pitch).toBeCloseTo(last().pitch, 12)
  })

  it('handles a bad delta without producing NaN', () => {
    const { look, target, last } = setup({ saccade: { enabled: false } })
    target.position.set(1, 0, 0)
    look.update(DT)
    look.update(Number.NaN)
    look.update(-1)
    expect(Number.isFinite(last().yaw)).toBe(true)
    expect(Number.isFinite(last().pitch)).toBe(true)
  })
})

describe('SmoothLookAt saccades', () => {
  it('defaults to a few tenths of a degree up to 3 degrees every 1 to 4 seconds', () => {
    expect(DEFAULT_SACCADE).toEqual({
      enabled: true,
      minDeg: 0.3,
      maxDeg: 3,
      minInterval: 1,
      maxInterval: 4,
    })
  })

  it('jumps by the scripted size and direction at the scripted times', () => {
    // constructor: first interval = 1 + 3 x 0.5 = 2.5 s
    // saccade 1: u = 1 (size 3 deg), direction 0 (+yaw), next interval 1 s
    // saccade 2: u = 0 (size 0.3 deg), direction 90 deg (+pitch), next interval 4 s
    // then everything is 0.5: size 0.975 deg, direction 180 deg, interval 2.5 s
    const random = scripted([0.5, 1, 0, 0, 0, 0.25, 1])
    const { look, target, last } = setup({ random, tau: 0.05 })
    target.position.set(0, 0, 0)

    let frames = 0
    const at = (seconds: number) => {
      while (frames / 60 < seconds) {
        look.update(DT)
        frames++
      }
      return last()
    }
    expect(at(2.4).yaw).toBeCloseTo(0, 6)
    expect(at(2.4).pitch).toBeCloseTo(0, 6)
    expect(at(3.4).yaw).toBeCloseTo(3, 4) // first saccade, settled
    expect(at(3.4).pitch).toBeCloseTo(0, 4)
    expect(at(4.4).yaw).toBeCloseTo(0, 4) // second saccade replaces it
    expect(at(4.4).pitch).toBeCloseTo(0.3, 4)
    expect(at(7.4).pitch).toBeCloseTo(0.3, 4) // nothing for 4 s
    expect(at(8.6).yaw).toBeCloseTo(-0.975, 4) // third
    expect(at(8.6).pitch).toBeCloseTo(0, 4)
  })

  it('moves the eyes quickly but not instantly (the smoothing applies to saccades too)', () => {
    const random = scripted([0, 1, 0, 0]) // first saccade after 1 s: +3 deg yaw
    const { look, target, last } = setup({ random, tau: 0.05 })
    target.position.set(0, 0, 0)
    for (let i = 0; i < 61; i++) look.update(DT)
    const first = last().yaw
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(2) // well short of the full 3 degrees
    for (let i = 0; i < 30; i++) look.update(DT)
    expect(last().yaw).toBeCloseTo(3, 1)
  })

  it('stays within the configured size and at the configured rate over a long run', () => {
    const { look, target, raw, last } = setup({ random: seededRandom(7) })
    target.position.set(0.3, 0.2, 0)
    const r = raw()
    let events = 0
    let moving = false
    let prev = { yaw: 0, pitch: 0 }
    for (let i = 0; i < 60 * 300; i++) {
      look.update(DT)
      const offset = { yaw: last().yaw - r.yaw, pitch: last().pitch - r.pitch }
      expect(Math.hypot(offset.yaw, offset.pitch)).toBeLessThanOrEqual(3 + 1e-9)
      // a saccade shows up as the offset starting to move again after it had settled
      const nowMoving = Math.hypot(offset.yaw - prev.yaw, offset.pitch - prev.pitch) > 0.02
      if (nowMoving && !moving) events++
      moving = nowMoving
      prev = offset
    }
    // 300 s at one saccade every 1 to 4 s (mean 2.5 s): about 120
    expect(events).toBeGreaterThan(300 / 4 - 5)
    expect(events).toBeLessThan(300 / 1 + 5)
  })

  it('can be switched off', () => {
    const { look, target, raw, last } = setup({
      random: seededRandom(3),
      saccade: { enabled: false },
    })
    target.position.set(0.3, 0.2, 0)
    const r = raw()
    for (let i = 0; i < 60 * 30; i++) {
      look.update(DT)
      expect(last().yaw).toBeCloseTo(r.yaw, 9)
      expect(last().pitch).toBeCloseTo(r.pitch, 9)
    }
    // and on again at run time
    look.saccade.enabled = true
    let moved = false
    for (let i = 0; i < 60 * 30 && !moved; i++) {
      look.update(DT)
      moved = Math.abs(last().yaw - r.yaw) > 0.05 || Math.abs(last().pitch - r.pitch) > 0.05
    }
    expect(moved).toBe(true)
  })

  it('takes size and interval from the options', () => {
    const random = scripted([0, 1, 0.25]) // interval 5 s (min 5, max 9 -> 5 + 4 x 0), size 10, direction 90 deg
    const { look, target, last } = setup({
      random,
      saccade: { minDeg: 1, maxDeg: 10, minInterval: 5, maxInterval: 9 },
    })
    target.position.set(0, 0, 0)
    for (let i = 0; i < 60 * 4.9; i++) look.update(DT)
    expect(last().pitch).toBeCloseTo(0, 6)
    for (let i = 0; i < 60 * 2; i++) look.update(DT)
    expect(last().pitch).toBeCloseTo(10, 3)
  })
})

describe('SmoothLookAt without a target', () => {
  it('behaves like the plain VRMLookAt: applies hand-set angles once', () => {
    const { look, applied } = setup()
    look.target = null
    look.update(DT) // the constructor left a pending update: applies (0, 0)
    applied.length = 0
    look.yaw = 12
    look.pitch = -5
    look.update(DT)
    expect(applied).toEqual([{ yaw: 12, pitch: -5 }])
    look.update(DT)
    expect(applied).toHaveLength(1)
  })

  it('does the same when autoUpdate is off', () => {
    const { look, target, applied } = setup()
    target.position.set(2, 0, 0)
    look.autoUpdate = false
    look.update(DT)
    applied.length = 0
    look.yaw = 7
    look.update(DT)
    expect(applied).toEqual([{ yaw: 7, pitch: 0 }])
  })

  it('snaps to the target again after tracking was off', () => {
    const { look, target, raw, last } = setup({ saccade: { enabled: false } })
    target.position.set(0, 0, 0)
    look.update(DT)
    look.autoUpdate = false
    look.update(DT)
    look.autoUpdate = true
    target.position.set(2, 1, 0)
    const r = raw()
    look.update(DT)
    expect(last().yaw).toBeCloseTo(r.yaw, 9)
  })
})

describe('SmoothLookAt.copy', () => {
  it('copies the base settings and the smoothing options', () => {
    const { look } = setup({ tau: 0.2, saccade: { maxDeg: 8 } })
    look.faceFront.set(0, 0, -1)
    look.offsetFromHeadBone.set(0, 0.1, 0)
    const copy = new SmoothLookAt(look.humanoid, look.applier).copy(look)
    expect(copy.smoothTau).toBe(0.2)
    expect(copy.saccade.maxDeg).toBe(8)
    expect(copy.faceFront.toArray()).toEqual([0, 0, -1])
    expect(copy.offsetFromHeadBone.toArray()).toEqual([0, 0.1, 0])
    expect(copy.target).toBe(look.target)
  })

  it('accepts a plain VRMLookAt as the source', () => {
    const fake = makeFakeVrm({ lookAt: 'plain' })
    const smooth = new SmoothLookAt(fake.vrm.humanoid, recorder().applier)
    smooth.copy(fake.vrm.lookAt!)
    expect(smooth.smoothTau).toBe(DEFAULT_SMOOTH_TAU)
  })
})
