/**
 * Helpers on top of `@pixiv/three-vrm-animation`: load / parse `.vrma` files, turn a `VRMAnimation`
 * into a `THREE.AnimationClip` for a given model, and mirror an animation left to right.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { VRM, VRMExpressionPresetName, VRMHumanBoneName } from '@pixiv/three-vrm'
import {
  VRMAnimation,
  VRMAnimationLoaderPlugin,
  createVRMAnimationExpressionTracks,
  createVRMAnimationHumanoidTracks,
} from '@pixiv/three-vrm-animation'

// ------------------------------------------------------------------ loading

let sharedLoader: GLTFLoader | undefined

/** One loader for every .vrma (created on first use, so importing this module costs nothing). */
function loader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader()
    sharedLoader.register((parser) => new VRMAnimationLoaderPlugin(parser))
  }
  return sharedLoader
}

function firstAnimation(gltf: { userData: Record<string, unknown> }): VRMAnimation | null {
  const list = gltf.userData['vrmAnimations'] as VRMAnimation[] | undefined
  return list?.[0] ?? null
}

/**
 * Fetch and parse a .vrma. Resolves null when the file holds no VRM animation; rejects on network,
 * HTTP or parse errors. (The bytes are fetched here rather than by `GLTFLoader.loadAsync`, which needs
 * browser-only globals and cannot be cancelled.)
 */
export async function loadVrma(
  url: string,
  opts: { signal?: AbortSignal } = {}
): Promise<VRMAnimation | null> {
  const res = await fetch(url, { signal: opts.signal })
  if (!res.ok) throw new Error(`motion request failed: HTTP ${res.status}`)
  return parseVrma(await res.arrayBuffer())
}

/** Parse a .vrma that is already in memory (for example a live clip that arrived over a WebSocket). */
export async function parseVrma(buffer: ArrayBuffer): Promise<VRMAnimation | null> {
  return firstAnimation(await loader().parseAsync(buffer, ''))
}

// ------------------------------------------------------------------ clip creation

/** Bones no clip should drive by default: gaze belongs to the procedural layer, the jaw to lip sync. */
export const DEFAULT_SKIP_BONES: readonly VRMHumanBoneName[] = ['leftEye', 'rightEye', 'jaw']

export interface CreateClipOptions {
  /** Name of the clip (default `vrma`). */
  name?: string
  /** Bones whose tracks are dropped (default: `leftEye`, `rightEye`, `jaw`; pass `[]` to keep everything). */
  skipBones?: readonly VRMHumanBoneName[]
  /** Shift the hips position track so that its first frame is at the model's rest position horizontally (x / z). */
  alignHipsXZToRest?: boolean
  /** Include the expression tracks (default true). */
  expressions?: boolean
}

/**
 * Build a `THREE.AnimationClip` from a `VRMAnimation` for this model: normalised humanoid rotation
 * tracks, the hips translation track and (unless `expressions: false`) the expression tracks. There is
 * never a look-at track: gaze belongs to the procedural layer.
 *
 * The VRM0 / VRM1 coordinate flip and the hips scaling are done by the official helper.
 */
export function createClip(
  anim: VRMAnimation,
  vrm: VRM,
  opts: CreateClipOptions = {}
): THREE.AnimationClip {
  const skip = new Set<VRMHumanBoneName>(opts.skipBones ?? DEFAULT_SKIP_BONES)
  const humanoid = createVRMAnimationHumanoidTracks(anim, vrm.humanoid, vrm.meta.metaVersion)
  const tracks: THREE.KeyframeTrack[] = []

  for (const [bone, track] of humanoid.rotation) {
    if (!skip.has(bone)) tracks.push(track)
  }
  for (const [bone, track] of humanoid.translation) {
    if (skip.has(bone)) continue
    if (bone === 'hips' && opts.alignHipsXZToRest) alignHipsXZ(track, vrm)
    tracks.push(track)
  }

  if (opts.expressions !== false && vrm.expressionManager) {
    const expressions = createVRMAnimationExpressionTracks(anim, vrm.expressionManager)
    tracks.push(...expressions.preset.values(), ...expressions.custom.values())
  }

  return new THREE.AnimationClip(opts.name ?? 'vrma', anim.duration, tracks)
}

/** Move the whole hips track horizontally so that frame 0 sits at the model's rest x / z. */
function alignHipsXZ(track: THREE.KeyframeTrack, vrm: VRM) {
  const rest = vrm.humanoid.normalizedRestPose.hips?.position
  const v = track.values
  if (!rest || v.length < 3) return
  const dx = rest[0] - v[0]!
  const dz = rest[2] - v[2]!
  for (let i = 0; i < v.length; i += 3) {
    v[i] = v[i]! + dx
    v[i + 2] = v[i + 2]! + dz
  }
}

// ------------------------------------------------------------------ mirroring

const swapBone = (name: string) =>
  name.startsWith('left')
    ? 'right' + name.slice(4)
    : name.startsWith('right')
      ? 'left' + name.slice(5)
      : name

/** `blinkLeft` <-> `blinkRight`, `eyeLookInLeft` <-> `eyeLookInRight`, ...: a trailing Left / Right is swapped. */
const swapExpression = (name: string) =>
  name.endsWith('Left')
    ? name.slice(0, -4) + 'Right'
    : name.endsWith('Right')
      ? name.slice(0, -5) + 'Left'
      : name

/** Mirror across the YZ plane: a rotation (x, y, z, w) becomes (x, -y, -z, w). */
function mirrorQuaternionValues(values: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(values)
  for (let i = 0; i + 3 < out.length; i += 4) {
    out[i + 1] = -out[i + 1]!
    out[i + 2] = -out[i + 2]!
  }
  return out
}

/**
 * A left-right mirrored copy of an animation. The tracks of a `VRMAnimation` are in the VRM1
 * normalised space (the VRM0 flip only happens in `createClip`), so mirroring across the YZ plane is:
 * rotation (x, y, z, w) -> (x, -y, -z, w), translation (x, y, z) -> (-x, y, z), left and right bones
 * swapped, and expressions whose name ends in Left / Right swapped. The source is not modified.
 */
export function mirrorVRMAnimation(src: VRMAnimation): VRMAnimation {
  const out = new VRMAnimation()
  out.duration = src.duration
  out.restHipsPosition = src.restHipsPosition.clone()

  for (const [bone, track] of src.humanoidTracks.rotation) {
    const target = swapBone(bone) as VRMHumanBoneName
    out.humanoidTracks.rotation.set(
      target,
      new THREE.QuaternionKeyframeTrack(
        `${target}.quaternion`,
        Float32Array.from(track.times),
        mirrorQuaternionValues(track.values),
        track.getInterpolation()
      )
    )
  }

  for (const [bone, track] of src.humanoidTracks.translation) {
    const values = Float32Array.from(track.values)
    for (let i = 0; i < values.length; i += 3) values[i] = -values[i]!
    out.humanoidTracks.translation.set(
      bone,
      new THREE.VectorKeyframeTrack(
        `${bone}.position`,
        Float32Array.from(track.times),
        values,
        track.getInterpolation()
      )
    )
  }

  for (const [name, track] of src.expressionTracks.preset) {
    const target = swapExpression(name) as VRMExpressionPresetName
    const t = track.clone()
    t.name = `${target}.weight`
    out.expressionTracks.preset.set(target, t)
  }
  for (const [name, track] of src.expressionTracks.custom) {
    const target = swapExpression(name)
    const t = track.clone()
    t.name = `${target}.weight`
    out.expressionTracks.custom.set(target, t)
  }

  if (src.lookAtTrack) {
    out.lookAtTrack = new THREE.QuaternionKeyframeTrack(
      src.lookAtTrack.name,
      Float32Array.from(src.lookAtTrack.times),
      mirrorQuaternionValues(src.lookAtTrack.values),
      src.lookAtTrack.getInterpolation()
    )
  }
  return out
}
