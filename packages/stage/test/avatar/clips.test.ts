import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VRMAnimation } from '@pixiv/three-vrm-animation'
import {
  DEFAULT_SKIP_BONES,
  createClip,
  loadVrma,
  mirrorVRMAnimation,
  parseVrma,
} from '../../src/avatar/clips.ts'
import { makeFakeVrm } from './fakeVrm.ts'
import { VRMA_FIXTURE, buildVrmaGlb } from './vrmaFixture.ts'

const unit = (x: number, y: number, z: number, w: number) => {
  const n = Math.hypot(x, y, z, w)
  return [x / n, y / n, z / n, w / n]
}

const Q_ARM = [...unit(0.1, 0.2, 0.3, 0.9), ...unit(0.3, -0.2, 0.1, 0.8)]
const Q_HIPS = [...unit(0.05, 0.4, -0.1, 0.9), ...unit(-0.2, 0.1, 0.3, 0.9)]
const Q_HAND = [...unit(0.5, 0.1, 0.1, 0.8), ...unit(0.2, 0.2, -0.4, 0.8)]
const Q_EYE = [...unit(0.1, 0.1, 0.1, 0.9), ...unit(0.0, 0.2, 0.0, 0.9)]
const T_HIPS = [0.5, 0.5, 0.5, 0.7, 0.5, 0.9]

/** A hand-built VRMAnimation with a left arm, hips, a right hand without a left twin, and eyes. */
function handmade(): VRMAnimation {
  const a = new VRMAnimation()
  a.duration = 1
  a.restHipsPosition.set(0, 0.5, 0)
  const rot = (name: 'leftUpperArm' | 'hips' | 'rightHand' | 'leftEye' | 'jaw', values: number[]) =>
    a.humanoidTracks.rotation.set(
      name,
      new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], values)
    )
  rot('leftUpperArm', Q_ARM)
  rot('hips', Q_HIPS)
  rot('rightHand', Q_HAND)
  rot('leftEye', Q_EYE)
  rot('jaw', Q_EYE)
  a.humanoidTracks.translation.set(
    'hips',
    new THREE.VectorKeyframeTrack('hips.position', [0, 1], T_HIPS)
  )
  const num = (name: string, values: number[]) =>
    new THREE.NumberKeyframeTrack(`${name}.weight`, [0, 1], values)
  a.expressionTracks.preset.set('blinkLeft', num('blinkLeft', [0, 1]))
  a.expressionTracks.preset.set('blink', num('blink', [0, 0.5]))
  a.expressionTracks.preset.set('happy', num('happy', [1, 0]))
  a.expressionTracks.custom.set('eyeBlinkRight', num('eyeBlinkRight', [0.2, 0.9]))
  return a
}

const values = (t: THREE.KeyframeTrack | undefined) => Array.from(t?.values ?? [])

describe('mirrorVRMAnimation', () => {
  it('mirrors rotations as (x, -y, -z, w) and swaps left and right bones', () => {
    const m = mirrorVRMAnimation(handmade())
    const arm = values(m.humanoidTracks.rotation.get('rightUpperArm'))
    expect(arm).toHaveLength(8)
    for (let i = 0; i < 8; i += 4) {
      expect(arm[i]).toBeCloseTo(Q_ARM[i]!, 6)
      expect(arm[i + 1]).toBeCloseTo(-Q_ARM[i + 1]!, 6)
      expect(arm[i + 2]).toBeCloseTo(-Q_ARM[i + 2]!, 6)
      expect(arm[i + 3]).toBeCloseTo(Q_ARM[i + 3]!, 6)
    }
    expect([...m.humanoidTracks.rotation.keys()].sort()).toEqual([
      'hips',
      'jaw',
      'leftHand',
      'rightEye',
      'rightUpperArm',
    ])
    // bones without a side are mirrored in place
    expect(values(m.humanoidTracks.rotation.get('hips'))[1]).toBeCloseTo(-Q_HIPS[1]!, 6)
  })

  it("makes the rotation R' = M R M for the mirror matrix M = diag(-1, 1, 1)", () => {
    const src = handmade()
    const m = mirrorVRMAnimation(src)
    const q = new THREE.Quaternion().fromArray(Q_ARM, 4)
    const qm = new THREE.Quaternion().fromArray(
      values(m.humanoidTracks.rotation.get('rightUpperArm')),
      4
    )
    for (const v of [
      new THREE.Vector3(1, 2, 3),
      new THREE.Vector3(-0.5, 0.25, 4),
      new THREE.Vector3(0, 1, 0),
    ]) {
      const viaOriginal = v.clone().applyQuaternion(q)
      viaOriginal.x = -viaOriginal.x // M (R v)
      const mirroredFirst = v.clone()
      mirroredFirst.x = -mirroredFirst.x // M v
      mirroredFirst.applyQuaternion(qm) // R' (M v)
      expect(mirroredFirst.distanceTo(viaOriginal)).toBeLessThan(1e-6)
    }
  })

  it('negates the x translation of the hips only', () => {
    const m = mirrorVRMAnimation(handmade())
    expect(values(m.humanoidTracks.translation.get('hips'))).toEqual(
      [-0.5, 0.5, 0.5, -0.7, 0.5, 0.9].map((x) => expect.closeTo(x, 6))
    )
  })

  it('swaps Left / Right expressions (preset and custom) and keeps the others', () => {
    const m = mirrorVRMAnimation(handmade())
    expect([...m.expressionTracks.preset.keys()].sort()).toEqual(['blink', 'blinkRight', 'happy'])
    expect(values(m.expressionTracks.preset.get('blinkRight'))).toEqual([0, 1])
    expect(m.expressionTracks.preset.get('blinkRight')?.name).toBe('blinkRight.weight')
    expect(values(m.expressionTracks.preset.get('blink'))).toEqual([0, 0.5])
    expect([...m.expressionTracks.custom.keys()]).toEqual(['eyeBlinkLeft'])
    expect(m.expressionTracks.custom.get('eyeBlinkLeft')?.name).toBe('eyeBlinkLeft.weight')
    expect(values(m.expressionTracks.custom.get('eyeBlinkLeft'))[0]).toBeCloseTo(0.2, 6)
  })

  it('is its own inverse', () => {
    const src = handmade()
    const twice = mirrorVRMAnimation(mirrorVRMAnimation(src))
    expect([...twice.humanoidTracks.rotation.keys()].sort()).toEqual(
      [...src.humanoidTracks.rotation.keys()].sort()
    )
    for (const [name, track] of src.humanoidTracks.rotation) {
      const back = twice.humanoidTracks.rotation.get(name)!
      values(track).forEach((v, i) => expect(back.values[i]).toBeCloseTo(v, 6))
    }
    values(src.humanoidTracks.translation.get('hips')).forEach((v, i) =>
      expect(twice.humanoidTracks.translation.get('hips')!.values[i]).toBeCloseTo(v, 6)
    )
    expect([...twice.expressionTracks.preset.keys()].sort()).toEqual(
      [...src.expressionTracks.preset.keys()].sort()
    )
    expect([...twice.expressionTracks.custom.keys()]).toEqual([
      ...src.expressionTracks.custom.keys(),
    ])
  })

  it('does not modify the source, copies times and keeps duration, rest hips and interpolation', () => {
    const src = handmade()
    const before = values(src.humanoidTracks.rotation.get('leftUpperArm'))
    const discrete = new THREE.QuaternionKeyframeTrack(
      'spine.quaternion',
      [0, 1],
      Q_ARM,
      THREE.InterpolateDiscrete
    )
    src.humanoidTracks.rotation.set('spine', discrete)
    const m = mirrorVRMAnimation(src)
    expect(values(src.humanoidTracks.rotation.get('leftUpperArm'))).toEqual(before)
    expect(m.duration).toBe(1)
    expect(m.restHipsPosition).not.toBe(src.restHipsPosition)
    expect(m.restHipsPosition.toArray()).toEqual([0, 0.5, 0])
    const mt = m.humanoidTracks.rotation.get('spine')!
    expect(mt.times).not.toBe(discrete.times)
    expect(mt.getInterpolation()).toBe(THREE.InterpolateDiscrete)
    expect(mt).toBeInstanceOf(THREE.QuaternionKeyframeTrack)
  })

  it('keeps rotations normalised and mirrors the look-at track too', () => {
    const src = handmade()
    src.lookAtTrack = new THREE.QuaternionKeyframeTrack('lookAt.quaternion', [0, 1], Q_EYE)
    const m = mirrorVRMAnimation(src)
    for (const t of m.humanoidTracks.rotation.values()) {
      for (let i = 0; i < t.values.length; i += 4) {
        expect(
          Math.hypot(t.values[i]!, t.values[i + 1]!, t.values[i + 2]!, t.values[i + 3]!)
        ).toBeCloseTo(1, 6)
      }
    }
    expect(m.lookAtTrack?.values[1]).toBeCloseTo(-Q_EYE[1]!, 6)
    expect(mirrorVRMAnimation(handmade()).lookAtTrack).toBeNull()
  })
})

describe('createClip', () => {
  it('builds humanoid, hips and expression tracks named after the model nodes', () => {
    const { vrm } = makeFakeVrm({ vrmBlink: true, emotions: true, arkitBlink: true })
    const clip = createClip(handmade(), vrm)
    expect(clip.name).toBe('vrma')
    expect(clip.duration).toBe(1)
    expect(trackNames(clip)).toEqual(
      [
        'Normalized_J_hips.position',
        'Normalized_J_hips.quaternion',
        'Normalized_J_leftUpperArm.quaternion',
        'Normalized_J_rightHand.quaternion',
        // 'blinkLeft' does not exist on this model and is dropped by the official helper
        'VRMExpression_blink.weight',
        'VRMExpression_eyeBlinkRight.weight',
        'VRMExpression_happy.weight',
      ].sort()
    )
  })

  it('skips the eyes and the jaw by default, and only what skipBones lists when given', () => {
    const { vrm } = makeFakeVrm()
    expect(DEFAULT_SKIP_BONES).toEqual(['leftEye', 'rightEye', 'jaw'])
    const names = trackNames(createClip(handmade(), vrm))
    expect(names.some((n) => n.includes('leftEye') || n.includes('jaw'))).toBe(false)

    const keepAll = trackNames(createClip(handmade(), vrm, { skipBones: [] }))
    expect(keepAll).toContain('Normalized_J_leftEye.quaternion')
    expect(keepAll).toContain('Normalized_J_jaw.quaternion')

    const skipHand = trackNames(createClip(handmade(), vrm, { skipBones: ['rightHand'] }))
    expect(skipHand).not.toContain('Normalized_J_rightHand.quaternion')
    expect(skipHand).toContain('Normalized_J_leftEye.quaternion')
  })

  it('can skip the hips (rotation and position)', () => {
    const { vrm } = makeFakeVrm()
    const names = trackNames(createClip(handmade(), vrm, { skipBones: ['hips'] }))
    expect(names.some((n) => n.startsWith('Normalized_J_hips'))).toBe(false)
  })

  it('leaves expression tracks out with expressions: false', () => {
    const { vrm } = makeFakeVrm({ vrmBlink: true, emotions: true })
    const names = trackNames(createClip(handmade(), vrm, { expressions: false }))
    expect(names.some((n) => n.startsWith('VRMExpression_'))).toBe(false)
    expect(names.length).toBeGreaterThan(0)
  })

  it('never creates a look-at track', () => {
    const { vrm } = makeFakeVrm({ lookAt: 'smooth' })
    const anim = handmade()
    anim.lookAtTrack = new THREE.QuaternionKeyframeTrack('lookAt.quaternion', [0, 1], Q_EYE)
    const names = trackNames(createClip(anim, vrm))
    expect(names.some((n) => /look/i.test(n))).toBe(false)
    expect(vrm.scene.children.some((c) => c.name === 'VRMLookAtQuaternionProxy')).toBe(false)
  })

  it('keeps VRM1 rotations and scales the hips translation to the model', () => {
    const { vrm } = makeFakeVrm({ metaVersion: '1' })
    const clip = createClip(handmade(), vrm)
    const arm = clip.tracks.find((t) => t.name === 'Normalized_J_leftUpperArm.quaternion')!
    Array.from(arm.values).forEach((v, i) => expect(v).toBeCloseTo(Q_ARM[i]!, 6))
    // model hips height 1.0 / animation hips height 0.5 = x2
    const pos = clip.tracks.find((t) => t.name === 'Normalized_J_hips.position')!
    Array.from(pos.values).forEach((v, i) => expect(v).toBeCloseTo(T_HIPS[i]! * 2, 6))
  })

  it('flips x and z for VRM0 through the official helper', () => {
    const { vrm } = makeFakeVrm({ metaVersion: '0' })
    const clip = createClip(handmade(), vrm)
    const arm = clip.tracks.find((t) => t.name === 'Normalized_J_leftUpperArm.quaternion')!
    for (let i = 0; i < 8; i += 4) {
      expect(arm.values[i]).toBeCloseTo(-Q_ARM[i]!, 6)
      expect(arm.values[i + 1]).toBeCloseTo(Q_ARM[i + 1]!, 6)
      expect(arm.values[i + 2]).toBeCloseTo(-Q_ARM[i + 2]!, 6)
      expect(arm.values[i + 3]).toBeCloseTo(Q_ARM[i + 3]!, 6)
    }
    const pos = clip.tracks.find((t) => t.name === 'Normalized_J_hips.position')!
    const expected = T_HIPS.map((v, i) => (i % 3 === 1 ? v : -v) * 2)
    Array.from(pos.values).forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 6))
  })

  it('aligns the first hips frame horizontally to the rest pose, leaving height and motion alone', () => {
    const fake = makeFakeVrm()
    const rest = fake.vrm.humanoid.normalizedRestPose.hips!.position!
    expect(rest).toEqual([expect.closeTo(0.2), expect.closeTo(1), expect.closeTo(0.1)])
    const anim = handmade()
    const srcBefore = values(anim.humanoidTracks.translation.get('hips'))

    const plain = createClip(anim, fake.vrm).tracks.find(
      (t) => t.name === 'Normalized_J_hips.position'
    )!
    expect(plain.values[0]).toBeCloseTo(1, 6) // 0.5 x 2, not aligned

    const clip = createClip(anim, fake.vrm, { alignHipsXZToRest: true })
    const pos = clip.tracks.find((t) => t.name === 'Normalized_J_hips.position')!
    expect(pos.values[0]).toBeCloseTo(rest[0]!, 6)
    expect(pos.values[2]).toBeCloseTo(rest[2]!, 6)
    // frame 1 keeps its offset from frame 0 (x2 scaling: dx 0.2 -> 0.4, dz 0.4 -> 0.8)
    expect(pos.values[3]! - pos.values[0]!).toBeCloseTo(0.4, 6)
    expect(pos.values[5]! - pos.values[2]!).toBeCloseTo(0.8, 6)
    // heights untouched
    expect(pos.values[1]).toBeCloseTo(1, 6)
    expect(pos.values[4]).toBeCloseTo(1, 6)
    // the source animation is not modified
    expect(values(anim.humanoidTracks.translation.get('hips'))).toEqual(srcBefore)
  })

  it('names the clip', () => {
    expect(createClip(handmade(), makeFakeVrm().vrm, { name: 'wave' }).name).toBe('wave')
  })

  it('plays on the model: the track names resolve to the normalised bones', () => {
    const fake = makeFakeVrm({ vrmBlink: true })
    const clip = createClip(handmade(), fake.vrm)
    const mixer = new THREE.AnimationMixer(fake.vrm.scene)
    const action = mixer.clipAction(clip)
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.play()
    mixer.update(1)
    const q = fake.bone('leftUpperArm').quaternion
    expect(q.x).toBeCloseTo(Q_ARM[4]!, 5)
    expect(q.y).toBeCloseTo(Q_ARM[5]!, 5)
    expect(fake.vrm.expressionManager!.getValue('blink')).toBeCloseTo(0.5, 5)
  })
})

describe('parseVrma / loadVrma', () => {
  it('parses a .vrma held in memory', async () => {
    const anim = await parseVrma(buildVrmaGlb())
    expect(anim).not.toBeNull()
    expect(anim!.duration).toBeCloseTo(VRMA_FIXTURE.duration, 6)
    expect(anim!.restHipsPosition.toArray()).toEqual(VRMA_FIXTURE.restHips)
    expect([...anim!.humanoidTracks.rotation.keys()].sort()).toEqual(['leftUpperArm', 'spine'])
    expect([...anim!.humanoidTracks.translation.keys()]).toEqual(['hips'])
    const spine = anim!.humanoidTracks.rotation.get('spine')!
    expect(spine).toBeInstanceOf(THREE.QuaternionKeyframeTrack)
    Array.from(spine.values).forEach((v, i) =>
      expect(v).toBeCloseTo(VRMA_FIXTURE.spineRotation[i]!, 6)
    )
    expect(Array.from(anim!.expressionTracks.preset.get('blink')!.values)).toEqual(
      VRMA_FIXTURE.blinkWeights
    )
  })

  it('resolves null for a glTF that is not a VRM animation and rejects on garbage', async () => {
    expect(await parseVrma(buildVrmaGlb({ extension: false }))).toBeNull()
    await expect(parseVrma(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).rejects.toThrow()
  })

  it('goes from file to clip to mirrored clip', async () => {
    const anim = (await parseVrma(buildVrmaGlb()))!
    const fake = makeFakeVrm()
    const clip = createClip(anim, fake.vrm)
    expect(trackNames(clip)).toContain('Normalized_J_spine.quaternion')
    const mirrored = createClip(mirrorVRMAnimation(anim), fake.vrm)
    expect(trackNames(mirrored)).toContain('Normalized_J_rightUpperArm.quaternion')
    expect(trackNames(mirrored)).not.toContain('Normalized_J_leftUpperArm.quaternion')
    const spine = mirrored.tracks.find((t) => t.name === 'Normalized_J_spine.quaternion')!
    expect(spine.values[5]).toBeCloseTo(-VRMA_FIXTURE.spineRotation[5]!, 6)
  })

  describe('over HTTP', () => {
    let server: ReturnType<typeof createServer>
    let base = ''
    beforeAll(async () => {
      const file = Buffer.from(buildVrmaGlb())
      server = createServer((req, res) => {
        if (req.url === '/walk.vrma') {
          res.writeHead(200, { 'content-type': 'model/gltf-binary' })
          res.end(file)
        } else if (req.url === '/plain.vrma') {
          res.writeHead(200, { 'content-type': 'model/gltf-binary' })
          res.end(Buffer.from(buildVrmaGlb({ extension: false })))
        } else {
          res.writeHead(404).end()
        }
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('loads a .vrma from a URL', async () => {
      const anim = await loadVrma(`${base}/walk.vrma`)
      expect(anim?.duration).toBeCloseTo(1, 6)
      expect(anim?.humanoidTracks.rotation.has('spine')).toBe(true)
    })

    it('resolves null for a file without the extension and rejects on 404', async () => {
      expect(await loadVrma(`${base}/plain.vrma`)).toBeNull()
      await expect(loadVrma(`${base}/missing.vrma`)).rejects.toThrow()
    })
  })
})

function trackNames(c: THREE.AnimationClip) {
  return c.tracks.map((t) => t.name).sort()
}
