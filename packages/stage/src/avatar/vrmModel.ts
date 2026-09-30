/**
 * Loading and disposing a VRM. This module creates no AudioContext and touches no globals (apart from
 * `fetch`); everything that belongs to a loaded model hangs off the returned `VRM`.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import type { VRM } from '@pixiv/three-vrm'
import { detectBlinkSupport } from './liveLayer.ts'
import { SmoothLookAtLoaderPlugin } from './lookAt.ts'

/** What the stage reports about a loaded model (`model.state.info` in the stage protocol). */
export interface ModelInfo {
  vrm_version: '0' | '1'
  /** Number of distinct morph target names on the model. */
  blend_shapes: number
  /** `eyeBlinkLeft` and `eyeBlinkRight` exist, so the procedural blink drives them directly. */
  arkit_blink: boolean
  /** The VRM preset expression `blink` exists (the fallback when there are no ARKit blink shapes). */
  vrm_blink: boolean
  spring_joints: number
}

/** Summarise a loaded model. Pure: reads the model, changes nothing. */
export function describeVrm(vrm: VRM): ModelInfo {
  const morphNames = new Set<string>()
  vrm.scene.traverse((obj) => {
    const dict = (obj as THREE.Mesh).morphTargetDictionary
    if (dict) for (const name of Object.keys(dict)) morphNames.add(name)
  })
  const blink = detectBlinkSupport(vrm)
  return {
    vrm_version: vrm.meta.metaVersion,
    blend_shapes: morphNames.size,
    arkit_blink: blink.arkit,
    vrm_blink: blink.vrm,
    spring_joints: vrm.springBoneManager?.joints.size ?? 0,
  }
}

/**
 * Fetch and parse a VRM (0.x or 1.0). VRM0 models are turned to face +Z. Frustum culling is switched
 * off on every object (skinned meshes have bounds that do not follow the animation). Rejects when the
 * request fails, the file is not a VRM, or `signal` aborts (the half-loaded model is disposed).
 */
export async function loadVrm(
  url: string,
  opts: { signal?: AbortSignal } = {}
): Promise<{ vrm: VRM; info: ModelInfo }> {
  const { signal } = opts
  signal?.throwIfAborted()

  // GLTFLoader.loadAsync has no way to cancel, so fetch the bytes here and parse them.
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`model request failed: HTTP ${res.status}`)
  const buffer = await res.arrayBuffer()
  signal?.throwIfAborted()

  const loader = new GLTFLoader()
  loader.register(
    (parser) => new VRMLoaderPlugin(parser, { lookAtPlugin: new SmoothLookAtLoaderPlugin(parser) })
  )
  const gltf = await loader.parseAsync(buffer, THREE.LoaderUtils.extractUrlBase(url))

  const vrm = gltf.userData['vrm'] as VRM | undefined
  if (!vrm) {
    VRMUtils.deepDispose(gltf.scene)
    throw new Error('the file is not a VRM model')
  }
  if (signal?.aborted) {
    disposeVrm(vrm)
    signal.throwIfAborted()
  }

  vrm.scene.name = 'VRMRoot'
  VRMUtils.rotateVRM0(vrm)
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false
  })
  return { vrm, info: describeVrm(vrm) }
}

/** Release the GPU resources of a model and detach it (and its gaze target) from the scene. */
export function disposeVrm(vrm: VRM): void {
  // The gaze target hangs off the camera, not off the model: take it off so it is not left behind.
  const lookAt = vrm.lookAt
  const target = lookAt?.target
  if (lookAt && target && !isDescendant(target, vrm.scene)) {
    target.removeFromParent()
    lookAt.target = null
  }
  vrm.scene.removeFromParent()
  VRMUtils.deepDispose(vrm.scene)
}

function isDescendant(obj: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = obj.parent; p; p = p.parent) if (p === ancestor) return true
  return false
}
