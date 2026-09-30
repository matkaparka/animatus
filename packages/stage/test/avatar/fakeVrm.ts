/**
 * A synthetic VRM built from three-vrm's own classes, for tests in Node (a real model needs the DOM
 * for its textures). It has a humanoid with the usual bones, a morph target mesh, an expression manager
 * and a look-at whose applier just records what it was given.
 */
import * as THREE from 'three'
import {
  VRM,
  VRMExpression,
  VRMExpressionManager,
  VRMExpressionMorphTargetBind,
  VRMHumanoid,
  VRMLookAt,
} from '@pixiv/three-vrm'
import type { VRMHumanBoneName, VRMHumanBones, VRMLookAtApplier, VRMMeta } from '@pixiv/three-vrm'
import { SmoothLookAt } from '../../src/avatar/lookAt.ts'

type Vec3 = [number, number, number]

/** name, parent, local rest position (VRM1 style: the character's left is +X). */
export const HIERARCHY: [VRMHumanBoneName, VRMHumanBoneName | null, Vec3][] = [
  ['hips', null, [0.2, 1, 0.1]],
  ['spine', 'hips', [0, 0.1, 0]],
  ['chest', 'spine', [0, 0.15, 0]],
  ['neck', 'chest', [0, 0.2, 0]],
  ['head', 'neck', [0, 0.08, 0]],
  ['leftEye', 'head', [0.03, 0.05, 0.08]],
  ['rightEye', 'head', [-0.03, 0.05, 0.08]],
  ['jaw', 'head', [0, 0, 0.05]],
  ['leftShoulder', 'chest', [0.05, 0.15, 0]],
  ['leftUpperArm', 'leftShoulder', [0.1, 0, 0]],
  ['leftLowerArm', 'leftUpperArm', [0.25, 0, 0]],
  ['leftHand', 'leftLowerArm', [0.25, 0, 0]],
  ['rightShoulder', 'chest', [-0.05, 0.15, 0]],
  ['rightUpperArm', 'rightShoulder', [-0.1, 0, 0]],
  ['rightLowerArm', 'rightUpperArm', [-0.25, 0, 0]],
  ['rightHand', 'rightLowerArm', [-0.25, 0, 0]],
  ['leftUpperLeg', 'hips', [0.08, -0.05, 0]],
  ['leftLowerLeg', 'leftUpperLeg', [0, -0.4, 0]],
  ['leftFoot', 'leftLowerLeg', [0, -0.4, 0]],
  ['rightUpperLeg', 'hips', [-0.08, -0.05, 0]],
  ['rightLowerLeg', 'rightUpperLeg', [0, -0.4, 0]],
  ['rightFoot', 'rightLowerLeg', [0, -0.4, 0]],
]

export interface FakeVrmOptions {
  metaVersion?: '0' | '1'
  /** `eyeBlinkLeft` / `eyeBlinkRight` expressions, each driving a morph target of its own name. */
  arkitBlink?: boolean
  /** Only `eyeBlinkLeft` (to test the "either is missing" rule). */
  arkitLeftOnly?: boolean
  /** The VRM preset `blink` expression, driving the morph target `Blink`. */
  vrmBlink?: boolean
  /** happy / angry / sad / relaxed / surprised, each driving a morph target of its own. */
  emotions?: boolean
  /** aa / ih / ou / ee / oh, driving morph targets A / I / U / E / O. */
  mouth?: boolean
  /** The ARKit brow / squint / sneer shapes the procedural layer drives. */
  face?: boolean
  /** Extra (or replacing) expressions: name -> { morph target name: bind weight }. */
  expressions?: Record<string, Record<string, number>>
  /** `smooth` gives a SmoothLookAt; `plain` a VRMLookAt; false no look-at at all. Default plain. */
  lookAt?: 'plain' | 'smooth' | false
}

export interface FakeVrm {
  vrm: VRM
  scene: THREE.Group
  /** The raw (skeleton) bone nodes by name. */
  raw: Partial<Record<VRMHumanBoneName, THREE.Object3D>>
  mesh: THREE.Mesh
  /** Every (yaw, pitch) the look-at applier was given, in order. */
  applied: { yaw: number; pitch: number }[]
  /** Current influence of a morph target by name (after `vrm.expressionManager.update()`). */
  morph(name: string): number
  /** Normalised bone node. */
  bone(name: VRMHumanBoneName): THREE.Object3D
}

const ARKIT_FACE = [
  'browInnerUp',
  'browDownLeft',
  'browDownRight',
  'browOuterUpLeft',
  'browOuterUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'noseSneerLeft',
  'noseSneerRight',
]

export function makeFakeVrm(opts: FakeVrmOptions = {}): FakeVrm {
  const scene = new THREE.Group()
  const raw: Partial<Record<VRMHumanBoneName, THREE.Object3D>> = {}
  for (const [name, parent, pos] of HIERARCHY) {
    const node = new THREE.Object3D()
    node.name = `J_${name}`
    node.position.set(...pos)
    raw[name] = node
    ;(parent ? raw[parent]! : scene).add(node)
  }
  scene.updateMatrixWorld(true)

  const bones = {} as Record<string, { node: THREE.Object3D }>
  for (const [name] of HIERARCHY) bones[name] = { node: raw[name]! }
  const humanoid = new VRMHumanoid(bones as unknown as VRMHumanBones)
  scene.add(humanoid.normalizedHumanBonesRoot)

  // ------------------------------------------------ expressions and morph targets
  const morphs: string[] = []
  const expressions: [string, Record<string, number>][] = []
  const both = (names: string[]) => names.forEach((n) => expressions.push([n, { [n]: 1 }]))
  if (opts.arkitBlink) both(['eyeBlinkLeft', 'eyeBlinkRight'])
  if (opts.arkitLeftOnly) both(['eyeBlinkLeft'])
  if (opts.vrmBlink) expressions.push(['blink', { Blink: 1 }])
  if (opts.emotions) both(['happy', 'angry', 'sad', 'relaxed', 'surprised'])
  if (opts.mouth) {
    for (const [expr, morph] of [
      ['aa', 'A'],
      ['ih', 'I'],
      ['ou', 'U'],
      ['ee', 'E'],
      ['oh', 'O'],
    ] as const) {
      expressions.push([expr, { [morph]: 1 }])
    }
  }
  if (opts.face) both(ARKIT_FACE)
  for (const [name, binds] of Object.entries(opts.expressions ?? {})) {
    const at = expressions.findIndex(([n]) => n === name)
    if (at >= 0) expressions[at] = [name, binds]
    else expressions.push([name, binds])
  }
  for (const [, binds] of expressions) {
    for (const morph of Object.keys(binds)) if (!morphs.includes(morph)) morphs.push(morph)
  }

  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.name = 'Face'
  mesh.morphTargetDictionary = Object.fromEntries(morphs.map((m, i) => [m, i]))
  mesh.morphTargetInfluences = morphs.map(() => 0)
  scene.add(mesh)

  const expressionManager = new VRMExpressionManager()
  for (const [name, binds] of expressions) {
    const expression = new VRMExpression(name)
    expression.name = `VRMExpression_${name}`
    for (const [morph, weight] of Object.entries(binds)) {
      expression.addBind(
        new VRMExpressionMorphTargetBind({
          primitives: [mesh],
          index: morphs.indexOf(morph),
          weight,
        })
      )
    }
    scene.add(expression)
    expressionManager.registerExpression(expression)
  }

  // ------------------------------------------------ look-at
  const applied: { yaw: number; pitch: number }[] = []
  const applier: VRMLookAtApplier = {
    applyYawPitch: (yaw, pitch) => {
      applied.push({ yaw, pitch })
    },
    lookAt: () => {},
  }
  const lookAtKind = opts.lookAt ?? 'plain'
  const lookAt =
    lookAtKind === 'smooth'
      ? new SmoothLookAt(humanoid, applier)
      : lookAtKind === 'plain'
        ? new VRMLookAt(humanoid, applier)
        : undefined

  const meta = { metaVersion: opts.metaVersion ?? '1' } as unknown as VRMMeta
  const vrm = new VRM({ scene, meta, humanoid, expressionManager, lookAt })

  return {
    vrm,
    scene,
    raw,
    mesh,
    applied,
    morph: (name) => mesh.morphTargetInfluences![mesh.morphTargetDictionary![name]!]!,
    bone: (name) => humanoid.getNormalizedBoneNode(name)!,
  }
}

/** A small deterministic RNG (mulberry32) for reproducible randomness. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
