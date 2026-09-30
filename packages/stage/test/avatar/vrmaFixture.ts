/**
 * Builds a tiny but valid .vrma (a GLB with the VRMC_vrm_animation extension) in memory, so the
 * loading code can be tested end to end without any asset files.
 *
 * Contents: a 1 s animation. The hips move from (0, 1, 0) to (0.5, 1, 0); the spine turns 90 degrees
 * about Y, the left upper arm 90 degrees about Z; the `blink` expression goes from 0 to 1.
 */

const S = Math.SQRT1_2

export interface VrmaFixtureOptions {
  /** false leaves the VRMC_vrm_animation extension out (a plain glTF animation). Default true. */
  extension?: boolean
}

export const VRMA_FIXTURE = {
  duration: 1,
  times: [0, 1],
  hipsTranslation: [0, 1, 0, 0.5, 1, 0],
  spineRotation: [0, 0, 0, 1, 0, S, 0, S],
  armRotation: [0, 0, 0, 1, 0, 0, S, S],
  blinkWeights: [0, 1],
  restHips: [0, 1, 0],
}

function padded(bytes: Uint8Array, fill: number): Uint8Array {
  const out = new Uint8Array(bytes.length + ((4 - (bytes.length % 4)) % 4)).fill(fill)
  out.set(bytes)
  return out
}

export function glb(json: object, bin: ArrayBuffer): ArrayBuffer {
  const jsonChunk = padded(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const binChunk = padded(new Uint8Array(bin), 0)
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length
  const out = new ArrayBuffer(total)
  const dv = new DataView(out)
  const u8 = new Uint8Array(out)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonChunk.length, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  u8.set(jsonChunk, 20)
  const o = 20 + jsonChunk.length
  dv.setUint32(o, binChunk.length, true)
  dv.setUint32(o + 4, 0x004e4942, true) // 'BIN\0'
  u8.set(binChunk, o + 8)
  return out
}

export function buildVrmaGlb(opts: VrmaFixtureOptions = {}): ArrayBuffer {
  const f = VRMA_FIXTURE
  const arrays = [f.times, f.hipsTranslation, f.spineRotation, f.armRotation, f.blinkWeights].map(
    (a) => new Float32Array(a)
  )
  // blink weights are stored as the x component of a translation, per the VRMA spec
  const blink = new Float32Array(f.blinkWeights.flatMap((w) => [w, 0, 0]))
  arrays[4] = blink

  const bin = new ArrayBuffer(arrays.reduce((n, a) => n + a.byteLength, 0))
  const bufferViews: object[] = []
  let offset = 0
  for (const a of arrays) {
    new Float32Array(bin, offset, a.length).set(a)
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: a.byteLength })
    offset += a.byteLength
  }
  const accessor = (view: number, type: string, count: number, extra: object = {}) => ({
    bufferView: view,
    componentType: 5126,
    count,
    type,
    ...extra,
  })
  const accessors = [
    accessor(0, 'SCALAR', 2, { min: [0], max: [1] }),
    accessor(1, 'VEC3', 2),
    accessor(2, 'VEC4', 2),
    accessor(3, 'VEC4', 2),
    accessor(4, 'VEC3', 2),
  ]

  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 4] }],
    nodes: [
      { name: 'hips', translation: [0, 1, 0], children: [1] },
      { name: 'spine', translation: [0, 0.1, 0], children: [2, 3] },
      { name: 'head', translation: [0, 0.3, 0] },
      { name: 'leftUpperArm', translation: [0.1, 0.2, 0] },
      { name: 'blinkNode' },
    ],
    animations: [
      {
        samplers: [0, 1, 2, 3].map((i) => ({ input: 0, output: i + 1, interpolation: 'LINEAR' })),
        channels: [
          { sampler: 0, target: { node: 0, path: 'translation' } },
          { sampler: 1, target: { node: 1, path: 'rotation' } },
          { sampler: 2, target: { node: 3, path: 'rotation' } },
          { sampler: 3, target: { node: 4, path: 'translation' } },
        ],
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
  }
  if (opts.extension !== false) {
    json['extensionsUsed'] = ['VRMC_vrm_animation']
    json['extensions'] = {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: {
          humanBones: {
            hips: { node: 0 },
            spine: { node: 1 },
            head: { node: 2 },
            leftUpperArm: { node: 3 },
          },
        },
        expressions: { preset: { blink: { node: 4 } } },
      },
    }
  }
  return glb(json, bin)
}
