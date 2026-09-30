import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { BodyMetrics } from '../camera.ts'

/** Where the model stands and how tall it is, from the world position of a few humanoid bones. */
export function measureBody(vrm: VRM): BodyMetrics | null {
  vrm.scene.updateWorldMatrix(true, true)
  const at = (name: 'hips' | 'head' | 'leftFoot' | 'rightFoot'): THREE.Vector3 | null => {
    const node = vrm.humanoid.getNormalizedBoneNode(name)
    return node ? node.getWorldPosition(new THREE.Vector3()) : null
  }
  const hips = at('hips')
  const head = at('head')
  if (!hips || !head || head.y <= hips.y) return null
  const feet = [at('leftFoot'), at('rightFoot')].filter((p): p is THREE.Vector3 => p !== null)
  // Without ankle bones assume legs about as long as the torso above them.
  const footY = feet.length > 0 ? Math.min(...feet.map((p) => p.y)) : hips.y - (head.y - hips.y)
  return { x: hips.x, z: hips.z, footY, hipsY: hips.y, headY: head.y }
}
