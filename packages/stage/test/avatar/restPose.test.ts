import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { MotionDirector } from '../../src/avatar/motionDirector.ts'
import { REST_POSE, restPoseClip } from '../../src/avatar/restPose.ts'
import { makeFakeVrm } from './fakeVrm.ts'

const DEG = Math.PI / 180

/** Plays the clip on the fake model and returns where things end up in world space. */
function posed() {
  const fake = makeFakeVrm()
  const mixer = new THREE.AnimationMixer(fake.scene)
  mixer.clipAction(restPoseClip(fake.vrm)).play()
  mixer.update(0.1)
  fake.vrm.humanoid.update() // normalised pose -> the skeleton
  fake.scene.updateMatrixWorld(true)
  const at = (name: Parameters<typeof fake.bone>[0]) =>
    fake.raw[name]!.getWorldPosition(new THREE.Vector3())
  return { fake, at }
}

describe('the built-in rest pose', () => {
  it('has a track for each upper arm and each forearm, on the normalised bones', () => {
    const fake = makeFakeVrm()
    const bones = ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm'] as const
    const expected = bones.map((b) => `${fake.bone(b).name}.quaternion`).sort()
    expect(
      restPoseClip(fake.vrm)
        .tracks.map((t) => t.name)
        .sort()
    ).toEqual(expected)
  })

  it('lets both arms hang down, the same distance from the body on each side', () => {
    const { at } = posed()
    const leftDrop = at('leftShoulder').y - at('leftHand').y
    const rightDrop = at('rightShoulder').y - at('rightHand').y
    expect(leftDrop).toBeGreaterThan(0.3)
    expect(rightDrop).toBeCloseTo(leftDrop, 6)
    // symmetric about the body's middle (the fake hips sit at x = 0.2)
    expect(at('leftHand').x - 0.2).toBeCloseTo(0.2 - at('rightHand').x, 6)
  })

  it('an upper arm hangs at the angle asked for, and the hands come forward a little (the model faces +Z)', () => {
    const { at } = posed()
    const upper = at('leftLowerArm').sub(at('leftUpperArm'))
    const fromDown = Math.acos(-upper.y / upper.length()) / DEG
    expect(fromDown).toBeCloseTo(90 - REST_POSE.armDrop, 4)
    expect(at('leftHand').z).toBeGreaterThan(at('leftUpperArm').z + 0.01)
    expect(at('rightHand').z).toBeGreaterThan(at('rightUpperArm').z + 0.01)
  })

  it('a model that lacks a bone still gets a clip, without a track for that bone', () => {
    const fake = makeFakeVrm()
    const original = fake.vrm.humanoid.getNormalizedBoneNode.bind(fake.vrm.humanoid)
    fake.vrm.humanoid.getNormalizedBoneNode = ((name: Parameters<typeof original>[0]) =>
      name === 'rightLowerArm' ? null : original(name)) as typeof original
    expect(restPoseClip(fake.vrm).tracks).toHaveLength(3)
  })
})

describe('the rest pose as the fallback idle of the director', () => {
  function rig() {
    const root = new THREE.Group()
    root.name = 'root'
    const mixer = new THREE.AnimationMixer(root)
    const director = new MotionDirector(mixer)
    const action = (name: string) =>
      mixer.clipAction(
        new THREE.AnimationClip(name, 1, [
          new THREE.QuaternionKeyframeTrack('root.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
        ])
      )
    return { director, action }
  }

  it('the first real idle replaces it as the pose the character returns to, and a fallback never pushes a real idle out', () => {
    const { director, action } = rig()
    const rest = action('rest')
    const real = action('real')
    const variant = action('variant')
    director.setIdle(rest, 0, true)
    expect(director.idleAction).toBe(rest)
    director.setIdle(real, 0)
    expect(director.idleAction).toBe(real)
    director.setIdle(rest, 1.5, true)
    expect(director.idleAction).toBe(real)
    director.setIdle(variant, 0.2)
    director.resetIdle(0.1)
    expect(director.idleAction).toBe(real) // not the rest pose
  })

  it('with nothing but the rest pose, that is the pose the character has and returns to', () => {
    const { director, action } = rig()
    const rest = action('rest')
    director.setIdle(rest, 0, true)
    director.resetIdle(0.1)
    expect(director.idleAction).toBe(rest)
  })
})
