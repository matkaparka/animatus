import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import { LIVE, LiveLayer, detectBlinkSupport } from '../../src/avatar/liveLayer.ts'
import type { LiveState } from '../../src/avatar/liveLayer.ts'
import { attachGazeTarget } from '../../src/avatar/lookAt.ts'
import { makeFakeVrm, seededRandom } from './fakeVrm.ts'
import type { FakeVrmOptions } from './fakeVrm.ts'

const DT = 1 / 60
const RAD2DEG = 180 / Math.PI

const defaults = structuredClone(LIVE)
afterEach(() => {
  Object.assign(LIVE, structuredClone(defaults))
})

const IDLE: LiveState = { emotion: 'neutral', idleWeight: 1, externalVolume: 0 }
const LOUD: LiveState = { emotion: 'neutral', idleWeight: 1, externalVolume: 1 }

function make(opts: FakeVrmOptions = {}, seed = 1) {
  const fake = makeFakeVrm(opts)
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(0.2, 1.5, 3)
  const target = attachGazeTarget(fake.vrm, camera)
  const layer = new LiveLayer(fake.vrm, undefined, camera, { random: seededRandom(seed) })
  const em = fake.vrm.expressionManager!
  const step = (state: LiveState = IDLE) => {
    layer.update(DT, state)
    em.update()
  }
  const run = (seconds: number, each?: (frame: number) => void, state: LiveState = IDLE) => {
    const n = Math.round(seconds / DT)
    for (let i = 0; i < n; i++) {
      step(state)
      each?.(i)
    }
  }
  return { fake, camera, target, layer, step, run, em }
}

const angleDeg = (q: THREE.Quaternion, from = new THREE.Quaternion()) => q.angleTo(from) * RAD2DEG

/** Rising edges through 0.6: one per blink (a double blink counts twice). */
function countBlinks(values: number[]) {
  let n = 0
  for (let i = 1; i < values.length; i++) if (values[i - 1]! < 0.6 && values[i]! >= 0.6) n++
  return n
}

describe('blink mode', () => {
  const modeOf = (o: FakeVrmOptions) =>
    new LiveLayer(makeFakeVrm(o).vrm, undefined, new THREE.Object3D()).blinkMode

  it('drives the ARKit shapes when both eyeBlinkLeft and eyeBlinkRight exist', () => {
    expect(modeOf({ arkitBlink: true })).toBe('arkit')
    expect(modeOf({ arkitBlink: true, vrmBlink: true })).toBe('arkit')
  })

  it('falls back to the VRM preset blink when either ARKit shape is missing', () => {
    expect(modeOf({ vrmBlink: true })).toBe('vrm')
    expect(modeOf({ arkitLeftOnly: true, vrmBlink: true })).toBe('vrm')
  })

  it('is none when the model has neither', () => {
    expect(modeOf({})).toBe('none')
    expect(modeOf({ arkitLeftOnly: true })).toBe('none')
    expect(modeOf({ emotions: true, mouth: true, face: true })).toBe('none')
  })

  it('is reported by detectBlinkSupport, independent of the model version', () => {
    expect(
      detectBlinkSupport(makeFakeVrm({ arkitBlink: true, vrmBlink: true, metaVersion: '0' }).vrm)
    ).toEqual({
      arkit: true,
      vrm: true,
    })
    expect(detectBlinkSupport(makeFakeVrm({ vrmBlink: true }).vrm)).toEqual({
      arkit: false,
      vrm: true,
    })
    expect(detectBlinkSupport(makeFakeVrm({ arkitLeftOnly: true }).vrm)).toEqual({
      arkit: false,
      vrm: false,
    })
  })

  it('a model without an expression manager gets none and does not throw', () => {
    const fake = makeFakeVrm()
    const bare = { ...fake.vrm, expressionManager: undefined } as unknown as typeof fake.vrm
    const layer = new LiveLayer(bare, undefined, new THREE.Object3D())
    expect(layer.blinkMode).toBe('none')
    expect(() => layer.update(DT, IDLE)).not.toThrow()
  })
})

describe('blinking', () => {
  it('ARKit mode: both eyes close fully, rest slightly lowered, several blinks over 40 s', () => {
    const { fake, run } = make({ arkitBlink: true })
    const left: number[] = []
    const right: number[] = []
    run(40, () => {
      left.push(fake.morph('eyeBlinkLeft'))
      right.push(fake.morph('eyeBlinkRight'))
    })
    expect(Math.max(...left)).toBeCloseTo(1, 9)
    expect(Math.min(...left)).toBeCloseTo(LIVE.baseLid, 9)
    expect(right).toEqual(left)
    expect(countBlinks(left)).toBeGreaterThanOrEqual(5)
    expect(countBlinks(left)).toBeLessThanOrEqual(40)
  })

  it('VRM mode: the preset blink follows the same curve, and no ARKit shapes are touched', () => {
    const { fake, run } = make({ vrmBlink: true })
    const values: number[] = []
    run(40, () => values.push(fake.morph('Blink')))
    expect(Math.max(...values)).toBeCloseTo(1, 9)
    expect(Math.min(...values)).toBeCloseTo(LIVE.baseLid, 9)
    expect(countBlinks(values)).toBeGreaterThanOrEqual(5)
    expect(fake.mesh.morphTargetDictionary!['eyeBlinkLeft']).toBeUndefined()
  })

  it('VRM mode is frame for frame the ARKit curve (same random seed)', () => {
    const a = make({ arkitBlink: true }, 5)
    const b = make({ vrmBlink: true }, 5)
    for (let i = 0; i < 60 * 30; i++) {
      a.step()
      b.step()
      expect(b.fake.morph('Blink')).toBeCloseTo(a.fake.morph('eyeBlinkLeft'), 12)
    }
  })

  it('ARKit wins over the preset when a model has both', () => {
    const { fake, run } = make({ arkitBlink: true, vrmBlink: true })
    let blinkPreset = 0
    let arkit = 0
    run(20, () => {
      blinkPreset = Math.max(blinkPreset, fake.morph('Blink'))
      arkit = Math.max(arkit, fake.morph('eyeBlinkLeft'))
    })
    expect(arkit).toBeCloseTo(1, 9)
    expect(blinkPreset).toBe(0)
  })

  it('none mode: nothing to drive, nothing breaks, the rest of the face still works', () => {
    const { layer, fake, run } = make({ face: true, emotions: true })
    expect(layer.blinkMode).toBe('none')
    let lo = Infinity
    let hi = 0
    run(10, () => {
      lo = Math.min(lo, fake.morph('browDownLeft'))
      hi = Math.max(hi, fake.morph('browDownLeft'))
    })
    // resting level plus a faint drift
    expect(lo).toBeCloseTo(LIVE.baseBrowDown, 9)
    expect(hi).toBeLessThan(LIVE.baseBrowDown + 0.07)
  })

  it('keeps blinking under an emotion (the emotion fades in on top)', () => {
    const { fake, run } = make({ vrmBlink: true, emotions: true })
    const state: LiveState = { ...IDLE, emotion: 'happy' }
    run(3, undefined, state)
    expect(fake.vrm.expressionManager!.getValue('happy')).toBeGreaterThan(0.999)
    const values: number[] = []
    run(30, () => values.push(fake.morph('Blink')), state)
    expect(Math.max(...values)).toBeCloseTo(1, 9)
    expect(countBlinks(values)).toBeGreaterThanOrEqual(4)
  })

  it('merges with eye closure that the emotion already drives (never above 1, resting level = the emotion)', () => {
    // 'happy' half closes the same morph target that the blink drives
    const { fake, run } = make({ vrmBlink: true, expressions: { happy: { Joy: 1, Blink: 0.5 } } })
    const state: LiveState = { ...IDLE, emotion: 'happy' }
    run(3, undefined, state)
    const values: number[] = []
    run(30, () => values.push(fake.morph('Blink')), state)
    expect(Math.max(...values)).toBeLessThanOrEqual(1 + 1e-9)
    expect(Math.max(...values)).toBeCloseTo(1, 6)
    expect(Math.min(...values)).toBeCloseTo(0.5, 3)
  })

  it('opens the eyes wide when surprised (no resting droop) but still blinks', () => {
    const { fake, run } = make({ vrmBlink: true, emotions: true })
    const state: LiveState = { ...IDLE, emotion: 'surprised' }
    run(3, undefined, state)
    const values: number[] = []
    run(30, () => values.push(fake.morph('Blink')), state)
    expect(Math.min(...values)).toBeLessThan(1e-6)
    expect(Math.max(...values)).toBeCloseTo(1, 9)
  })

  it('rests lower in calm mode and with faceScale 0 not at all', () => {
    const calm = make({ arkitBlink: true })
    const calmValues: number[] = []
    calm.run(20, () => calmValues.push(calm.fake.morph('eyeBlinkLeft')), { ...IDLE, calm: 1 })
    expect(Math.min(...calmValues)).toBeCloseTo(LIVE.calmLid, 9)

    LIVE.faceScale = 0
    const flat = make({ arkitBlink: true })
    const flatValues: number[] = []
    flat.run(20, () => flatValues.push(flat.fake.morph('eyeBlinkLeft')))
    expect(Math.min(...flatValues)).toBeCloseTo(0, 9)
    expect(Math.max(...flatValues)).toBeCloseTo(1, 9)
  })

  it('does not blink at all when the layer is disabled', () => {
    LIVE.enabled = false
    const { fake, run } = make({ arkitBlink: true })
    run(10, () => expect(fake.morph('eyeBlinkLeft')).toBe(0))
  })

  it('face values stay inside 0..1', () => {
    const { fake, run } = make({ arkitBlink: true, face: true, emotions: true })
    const names = Object.keys(fake.mesh.morphTargetDictionary!)
    const state: LiveState = { emotion: 'angry', idleWeight: 1, externalVolume: 1 }
    run(
      20,
      () => {
        for (const n of names) {
          expect(fake.morph(n)).toBeGreaterThanOrEqual(0)
          expect(fake.morph(n)).toBeLessThanOrEqual(1 + 1e-9)
        }
      },
      state
    )
  })
})

describe('emotion fading', () => {
  it('fades the emotion in with time constant emotionIn and out with emotionOut', () => {
    const { fake, run } = make({ emotions: true })
    const value = () => fake.vrm.expressionManager!.getValue('happy')!
    const happy: LiveState = { ...IDLE, emotion: 'happy' }
    run(LIVE.emotionIn, undefined, happy)
    expect(value()).toBeCloseTo(1 - Math.exp(-1), 2)
    run(1, undefined, happy)
    expect(value()).toBeCloseTo(1, 3)
    run(LIVE.emotionOut, undefined, IDLE)
    expect(value()).toBeCloseTo(Math.exp(-1), 2)
    run(2, undefined, IDLE)
    expect(value()).toBeLessThan(1e-3)
  })

  it('ignores an emotion the model does not know', () => {
    const { run } = make({ emotions: true })
    expect(() => run(2, undefined, { ...IDLE, emotion: 'embarrassed' })).not.toThrow()
  })
})

describe('body', () => {
  const BONES: VRMHumanBoneName[] = [
    'spine',
    'chest',
    'neck',
    'head',
    'leftShoulder',
    'rightShoulder',
    'leftUpperArm',
    'rightUpperArm',
    'leftLowerArm',
    'rightLowerArm',
  ]

  it('moves the body a little while idle', () => {
    const { fake, run } = make()
    let peak = 0
    run(30, () => {
      for (const b of BONES) peak = Math.max(peak, angleDeg(fake.bone(b).quaternion))
    })
    expect(peak).toBeGreaterThan(0.2)
    expect(peak).toBeLessThan(12)
  })

  it('does not move a bone at all with bodyScale 0 or with the body fully yielded', () => {
    LIVE.bodyScale = 0
    const off = make()
    off.run(
      10,
      () => {
        for (const b of BONES) expect(angleDeg(off.fake.bone(b).quaternion)).toBeLessThan(1e-9)
      },
      LOUD
    )

    LIVE.bodyScale = 1
    const yielded = make()
    yielded.run(
      10,
      () => {
        for (const b of BONES) expect(angleDeg(yielded.fake.bone(b).quaternion)).toBeLessThan(1e-9)
      },
      { ...LOUD, bodyYield: 1 }
    )
  })

  it('does nothing when the layer is disabled', () => {
    LIVE.enabled = false
    const { fake, run } = make()
    run(5, () => {
      for (const b of BONES) expect(angleDeg(fake.bone(b).quaternion)).toBe(0)
    })
  })

  it('steps aside while a tag motion plays: the arms stay put, the torso and head move less', () => {
    const away: LiveState = { ...IDLE, idleWeight: 0 }
    const { fake, run } = make()
    run(
      20,
      () => {
        for (const b of [
          'leftUpperArm',
          'rightUpperArm',
          'leftLowerArm',
          'rightLowerArm',
        ] as const) {
          expect(angleDeg(fake.bone(b).quaternion)).toBeLessThan(1e-9)
        }
      },
      away
    )
    expect(angleDeg(fake.bone('head').quaternion)).toBeGreaterThan(0)
  })

  it('layers on the pose the animation wrote instead of piling up, whether or not the bone was rewritten', () => {
    const animated = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.35)

    // the mixer writes the same pose before every update
    const a = make()
    let peak = 0
    for (let i = 0; i < 60 * 20; i++) {
      const q = a.fake.bone('head').quaternion
      q.copy(animated)
      a.step()
      peak = Math.max(peak, angleDeg(q, animated))
    }
    expect(peak).toBeLessThan(8)
    expect(peak).toBeGreaterThan(0.05)

    // nobody rewrites the bone: last frame's offset must be taken off before the new one goes on
    const b = make()
    let drift = 0
    b.run(120, () => {
      drift = Math.max(drift, angleDeg(b.fake.bone('head').quaternion))
    })
    expect(drift).toBeLessThan(8)
  })

  it('keeps every bone a valid unit quaternion under heavy, changing input', () => {
    for (const metaVersion of ['0', '1'] as const) {
      const { fake, step } = make({ metaVersion, arkitBlink: true, face: true, emotions: true }, 9)
      for (let i = 0; i < 60 * 40; i++) {
        const burst = i % 18 < 6 ? 0.9 : 0.05
        step({
          emotion: ['neutral', 'happy', 'angry', 'sad', 'surprised', 'relaxed'][
            Math.floor(i / 300) % 6
          ]!,
          idleWeight: 0.5 + 0.5 * Math.sin(i / 90),
          bodyYield: i % 700 < 100 ? 0.5 : 0,
          calm: i % 900 < 200 ? 1 : 0,
          calmMotion: 0.5,
          externalVolume: burst,
        })
        for (const b of BONES) {
          const q = fake.bone(b).quaternion
          expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true)
          expect(q.length()).toBeCloseTo(1, 6)
        }
      }
    }
  })

  it('mirrors the x and z components for VRM0 models', () => {
    const v1 = make({ metaVersion: '1' }, 4)
    const v0 = make({ metaVersion: '0' }, 4)
    for (let i = 0; i < 400; i++) {
      v1.step()
      v0.step()
    }
    for (const b of ['head', 'chest', 'neck'] as const) {
      const a = v1.fake.bone(b).quaternion
      const c = v0.fake.bone(b).quaternion
      expect(c.x).toBeCloseTo(-a.x, 12)
      expect(c.y).toBeCloseTo(a.y, 12)
      expect(c.z).toBeCloseTo(-a.z, 12)
      expect(c.w).toBeCloseTo(a.w, 12)
    }
    expect(angleDeg(v1.fake.bone('head').quaternion)).toBeGreaterThan(0.05)
  })

  it('reads a loud voice as speech: the upper body leans in; calm mode does not', () => {
    LIVE.talkLean = 10
    LIVE.breathChest = 0
    LIVE.swayChest = 0
    const lean = (state: LiveState) => {
      const { fake, run } = make({}, 2)
      run(6, undefined, state)
      return angleDeg(fake.bone('chest').quaternion)
    }
    expect(lean(LOUD)).toBeGreaterThan(8)
    expect(lean(LOUD)).toBeLessThan(12)
    expect(lean(IDLE)).toBeLessThan(3)
    expect(lean({ ...LOUD, calm: 1 })).toBeLessThan(3)
  })

  it('takes the voice from an analyser when there is no external volume', () => {
    LIVE.talkLean = 10
    LIVE.breathChest = 0
    LIVE.swayChest = 0
    const loud = {
      fftSize: 512,
      getFloatTimeDomainData(buf: Float32Array) {
        for (let i = 0; i < buf.length; i++) buf[i] = 0.3 * Math.sin(i / 5)
      },
    } as unknown as AnalyserNode
    const silent = {
      fftSize: 512,
      getFloatTimeDomainData: (buf: Float32Array) => buf.fill(0),
    } as unknown as AnalyserNode
    const chestAfter = (analyser: AnalyserNode) => {
      const fake = makeFakeVrm()
      const camera = new THREE.Object3D()
      const layer = new LiveLayer(fake.vrm, analyser, camera, { random: seededRandom(2) })
      for (let i = 0; i < 360; i++)
        layer.update(DT, { emotion: 'neutral', idleWeight: 1, externalVolume: null })
      return angleDeg(fake.bone('chest').quaternion)
    }
    expect(chestAfter(loud)).toBeGreaterThan(8)
    expect(chestAfter(silent)).toBeLessThan(3)
  })
})

describe('gaze', () => {
  it('moves the gaze target sideways for glances, in the camera plane', () => {
    const { target, run } = make()
    let reach = 0
    run(60, () => {
      reach = Math.max(reach, Math.abs(target.position.x))
      expect(target.position.z).toBe(0)
    })
    expect(reach).toBeGreaterThan(0.1)
  })

  it('leaves a target alone that is not a child of the given parent', () => {
    const fake = makeFakeVrm()
    const cameraA = new THREE.Object3D()
    const cameraB = new THREE.Object3D()
    const target = attachGazeTarget(fake.vrm, cameraB)
    const layer = new LiveLayer(fake.vrm, undefined, cameraA, { random: seededRandom(1) })
    for (let i = 0; i < 60 * 30; i++) layer.update(DT, IDLE)
    expect(target.position.toArray()).toEqual([0, 0, 0])
  })

  it('works for a model without look-at', () => {
    const { run } = make({ lookAt: false })
    expect(() => run(5)).not.toThrow()
  })
})

describe('dispose', () => {
  it('hands the bones back and zeroes what the layer drove', () => {
    const { fake, layer, run, em } = make({ arkitBlink: true, face: true, emotions: true })
    run(10, undefined, { ...LOUD, emotion: 'happy' })
    expect(angleDeg(fake.bone('head').quaternion)).toBeGreaterThan(0)
    layer.dispose()
    for (const b of ['spine', 'chest', 'neck', 'head', 'leftUpperArm'] as const) {
      expect(angleDeg(fake.bone(b).quaternion)).toBeLessThan(1e-9)
    }
    for (const name of ['happy', 'eyeBlinkLeft', 'eyeBlinkRight', 'browInnerUp'])
      expect(em.getValue(name)).toBe(0)
  })

  it('ignores updates afterwards and can be called twice', () => {
    const { fake, layer } = make({ arkitBlink: true })
    layer.dispose()
    layer.dispose()
    for (let i = 0; i < 600; i++) layer.update(DT, LOUD)
    expect(angleDeg(fake.bone('head').quaternion)).toBe(0)
    expect(fake.vrm.expressionManager!.getValue('eyeBlinkLeft')).toBe(0)
  })
})

describe('robustness', () => {
  it('survives odd deltas', () => {
    const { fake, layer } = make({ arkitBlink: true })
    for (const d of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 5, 1e-9]) {
      expect(() => layer.update(d, IDLE)).not.toThrow()
    }
    const q = fake.bone('head').quaternion
    expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true)
  })

  it('survives a nonsensical breathPeriod tuning', () => {
    LIVE.breathPeriod = [0, 0]
    const { fake, run } = make()
    run(10)
    for (const b of ['chest', 'spine', 'head'] as const) {
      const q = fake.bone(b).quaternion
      expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true)
    }
  })

  it('is deterministic for a given random seed', () => {
    const trace = () => {
      const { fake, run } = make({ arkitBlink: true }, 11)
      const out: number[] = []
      run(10, () => out.push(fake.bone('head').quaternion.x, fake.morph('eyeBlinkLeft')))
      return out
    }
    expect(trace()).toEqual(trace())
  })
})
