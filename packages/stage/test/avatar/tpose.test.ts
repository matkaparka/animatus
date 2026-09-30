import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { TPOSE_BONES, TPoseMonitor, meanAngleFromBind } from '../../src/diag/tpose.ts'
import { makeFakeVrm } from './fakeVrm.ts'

const rot = (axis: 'x' | 'y' | 'z', deg: number) =>
  new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0),
    (deg * Math.PI) / 180
  )

describe('meanAngleFromBind', () => {
  it('is 0 for the identity', () => {
    expect(meanAngleFromBind([new THREE.Quaternion()])).toBe(0)
    expect(meanAngleFromBind([new THREE.Quaternion(), new THREE.Quaternion()])).toBe(0)
  })

  it('returns the rotation angle in degrees', () => {
    expect(meanAngleFromBind([rot('y', 90)])).toBeCloseTo(90, 9)
    expect(meanAngleFromBind([rot('x', 30)])).toBeCloseTo(30, 9)
    expect(meanAngleFromBind([rot('z', -45)])).toBeCloseTo(45, 9)
    expect(meanAngleFromBind([rot('y', 180)])).toBeCloseTo(180, 9)
  })

  it('is accurate for very small angles', () => {
    expect(meanAngleFromBind([rot('x', 0.001)])).toBeCloseTo(0.001, 9)
  })

  it('averages over the quaternions', () => {
    expect(meanAngleFromBind([new THREE.Quaternion(), rot('x', 180)])).toBeCloseTo(90, 9)
    expect(meanAngleFromBind([rot('x', 10), rot('y', 20), rot('z', 60)])).toBeCloseTo(30, 9)
  })

  it('treats q and -q as the same rotation', () => {
    const q = rot('y', 50)
    const neg = new THREE.Quaternion(-q.x, -q.y, -q.z, -q.w)
    expect(meanAngleFromBind([neg])).toBeCloseTo(50, 9)
    expect(meanAngleFromBind([new THREE.Quaternion(0, 0, 0, -1)])).toBe(0)
  })

  it('tolerates quaternions that are not normalised', () => {
    const q = rot('x', 70)
    const scaled = new THREE.Quaternion(q.x * 3, q.y * 3, q.z * 3, q.w * 3)
    expect(meanAngleFromBind([scaled])).toBeCloseTo(70, 9)
  })

  it('accepts any iterable and returns 0 for none', () => {
    function* gen() {
      yield rot('x', 20)
      yield rot('x', 40)
    }
    expect(meanAngleFromBind(gen())).toBeCloseTo(30, 9)
    expect(meanAngleFromBind(new Set([rot('y', 12)]))).toBeCloseTo(12, 9)
    expect(meanAngleFromBind([])).toBe(0)
  })
})

describe('TPoseMonitor', () => {
  const setPose = (fake: ReturnType<typeof makeFakeVrm>, deg: number, names = TPOSE_BONES) => {
    for (const name of names) fake.bone(name).quaternion.copy(rot('z', deg))
  }

  it('checks arms, forearms, hands, legs, spine and chest by default', () => {
    expect([...TPOSE_BONES].sort()).toEqual(
      [
        'leftUpperArm',
        'rightUpperArm',
        'leftLowerArm',
        'rightLowerArm',
        'leftHand',
        'rightHand',
        'leftUpperLeg',
        'rightUpperLeg',
        'leftLowerLeg',
        'rightLowerLeg',
        'spine',
        'chest',
      ].sort()
    )
  })

  it('is true when every checked bone is at the bind rotation', () => {
    const fake = makeFakeVrm()
    const monitor = new TPoseMonitor(fake.vrm)
    expect(monitor.check()).toBe(true)
    expect(monitor.lastMeanAngle).toBe(0)
  })

  it('is false in a normal pose', () => {
    const fake = makeFakeVrm()
    const monitor = new TPoseMonitor(fake.vrm)
    fake.bone('leftUpperArm').quaternion.copy(rot('z', -62))
    fake.bone('rightUpperArm').quaternion.copy(rot('z', 62))
    fake.bone('leftLowerArm').quaternion.copy(rot('y', 26))
    fake.bone('rightLowerArm').quaternion.copy(rot('y', -26))
    expect(monitor.check()).toBe(false)
    expect(monitor.lastMeanAngle).toBeCloseTo((62 + 62 + 26 + 26) / 12, 6)
  })

  it('does not fire for a gesture that leaves most bones at bind but moves the arms', () => {
    const fake = makeFakeVrm()
    const monitor = new TPoseMonitor(fake.vrm)
    setPose(fake, 60, ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'])
    expect(monitor.check()).toBe(false) // 4 x 60 / 12 = 20 degrees
  })

  it('goes back to true when the pose returns to bind', () => {
    const fake = makeFakeVrm()
    const monitor = new TPoseMonitor(fake.vrm)
    setPose(fake, 30)
    expect(monitor.check()).toBe(false)
    setPose(fake, 0)
    expect(monitor.check()).toBe(true)
  })

  it('uses the threshold (default 4 degrees, strictly below)', () => {
    const fake = makeFakeVrm()
    setPose(fake, 3.9)
    expect(new TPoseMonitor(fake.vrm).check()).toBe(true)
    setPose(fake, 4.1)
    expect(new TPoseMonitor(fake.vrm).check()).toBe(false)
    expect(new TPoseMonitor(fake.vrm, { thresholdDeg: 10 }).check()).toBe(true)
    setPose(fake, 3.9)
    expect(new TPoseMonitor(fake.vrm, { thresholdDeg: 2 }).check()).toBe(false)
  })

  it('looks only at the bones it is given and skips bones the model lacks', () => {
    const fake = makeFakeVrm()
    setPose(fake, 80, ['leftUpperArm'])
    expect(new TPoseMonitor(fake.vrm, { bones: ['head'] }).check()).toBe(true)
    expect(new TPoseMonitor(fake.vrm, { bones: ['leftUpperArm'] }).check()).toBe(false)
    // upperChest does not exist on the fake model: only the head is judged
    expect(new TPoseMonitor(fake.vrm, { bones: ['head', 'upperChest'] }).check()).toBe(true)
  })

  it('is false when there is nothing to judge by', () => {
    const fake = makeFakeVrm()
    expect(new TPoseMonitor(fake.vrm, { bones: ['upperChest'] }).check()).toBe(false)
    expect(new TPoseMonitor(fake.vrm, { bones: [] }).check()).toBe(false)
  })
})
