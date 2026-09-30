/**
 * Builds a small but valid VRM (a GLB with the VRM0 `VRM` or the VRM1 `VRMC_vrm` extension) in memory:
 * the usual humanoid, one mesh with two morph targets (`Blink`, `Joy`) that the expressions `blink` and
 * `happy` drive, and a bone look-at. No materials or textures, so it loads in Node.
 */
import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import { HIERARCHY } from './fakeVrm.ts'
import { glb } from './vrmaFixture.ts'

export const VRM_FIXTURE = {
  morphs: ['Blink', 'Joy'],
  boneCount: HIERARCHY.length,
}

export function buildVrmGlb(version: '0' | '1'): ArrayBuffer {
  const names = HIERARCHY.map(([name]) => name)
  const index = (name: VRMHumanBoneName) => names.indexOf(name)

  const nodes: Record<string, unknown>[] = HIERARCHY.map(([name, , pos]) => ({
    name: `J_${name}`,
    translation: pos,
    children: HIERARCHY.filter(([, parent]) => parent === name).map(([child]) => index(child)),
  }))
  const meshNode = nodes.length
  nodes.push({ name: 'Face', mesh: 0 })

  // binary: 3 vertex positions, then a position delta per morph target
  const positions = new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0])
  const blink = new Float32Array([0, -0.01, 0, 0, -0.01, 0, 0, -0.01, 0])
  const joy = new Float32Array([0, 0.01, 0, 0, 0.01, 0, 0, 0.01, 0])
  const bin = new ArrayBuffer(positions.byteLength * 3)
  new Float32Array(bin, 0, 9).set(positions)
  new Float32Array(bin, 36, 9).set(blink)
  new Float32Array(bin, 72, 9).set(joy)

  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, meshNode] }],
    nodes,
    meshes: [
      {
        name: 'Face',
        primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }, { POSITION: 2 }] }],
        extras: { targetNames: VRM_FIXTURE.morphs },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [0.1, 0.1, 0],
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, -0.01, 0],
        max: [0, -0.01, 0],
      },
      {
        bufferView: 2,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0.01, 0],
        max: [0, 0.01, 0],
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 36 },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  }

  if (version === '1') {
    json['extensionsUsed'] = ['VRMC_vrm']
    json['extensions'] = {
      VRMC_vrm: {
        specVersion: '1.0',
        meta: {
          name: 'Test model',
          version: '1',
          authors: ['nobody'],
          licenseUrl: 'https://vrm.dev/licenses/1.0/',
          avatarPermission: 'onlyAuthor',
          commercialUsage: 'personalNonProfit',
          creditNotation: 'required',
          modification: 'prohibited',
        },
        humanoid: {
          humanBones: Object.fromEntries(names.map((n) => [n, { node: index(n) }])),
        },
        lookAt: { type: 'bone', offsetFromHeadBone: [0, 0.06, 0] },
        expressions: {
          preset: {
            blink: { morphTargetBinds: [{ node: meshNode, index: 0, weight: 1 }] },
            happy: { morphTargetBinds: [{ node: meshNode, index: 1, weight: 1 }] },
          },
        },
      },
    }
  } else {
    json['extensionsUsed'] = ['VRM']
    json['extensions'] = {
      VRM: {
        exporterVersion: 'test',
        specVersion: '0.0',
        meta: {
          title: 'Test model',
          version: '1',
          author: 'nobody',
          allowedUserName: 'OnlyAuthor',
          violentUssageName: 'Disallow',
          sexualUssageName: 'Disallow',
          commercialUssageName: 'Disallow',
          licenseName: 'Redistribution_Prohibited',
        },
        humanoid: {
          humanBones: names.map((bone) => ({ bone, node: index(bone), useDefaultValues: true })),
        },
        firstPerson: {
          firstPersonBone: index('head'),
          firstPersonBoneOffset: { x: 0, y: 0.06, z: 0 },
          meshAnnotations: [],
          lookAtTypeName: 'Bone',
        },
        blendShapeMaster: {
          blendShapeGroups: [
            {
              name: 'Blink',
              presetName: 'blink',
              binds: [{ mesh: 0, index: 0, weight: 100 }],
              materialValues: [],
            },
            {
              name: 'Joy',
              presetName: 'joy',
              binds: [{ mesh: 0, index: 1, weight: 100 }],
              materialValues: [],
            },
          ],
        },
        secondaryAnimation: { boneGroups: [], colliderGroups: [] },
        materialProperties: [],
      },
    }
  }
  return glb(json, bin)
}
