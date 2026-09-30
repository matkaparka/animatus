/**
 * A relaxed standing pose for a model that has no idle motion of its own.
 *
 * Without a motion library the base pose is the model's rest pose, which is a T-pose: arms straight out to the sides.
 * A fresh install has no library, so this clip puts the arms down and the elbows a little bent instead. It is only a base
 * pose: breathing, gaze and the gestures made while speaking still play on top of it, and an idle motion from the motion
 * library replaces it as soon as there is one.
 */
import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

/** How far the upper arms hang down from the T-pose, and how far the elbows bend (degrees). Fits any body. */
export const REST_POSE = { armDrop: 65, elbowBend: 15 } as const

const AXIS = { y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) } as const

/**
 * The clip is two keys of the same pose on the normalised bones. In a VRM 1 model the character's left is +X in that
 * space: the left upper arm turns about Z away from +X and down, the right one the other way, and each forearm turns
 * about Y so that the hand comes forward. The normalised bones of a VRM 0 model sit in a frame turned half way about Y,
 * so there the x and z parts of each rotation change sign (the same flip the animation loader makes).
 */
export function restPoseClip(vrm: VRM): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = []
  const flip = vrm.meta.metaVersion === '0'
  const pose = (bone: VRMHumanBoneName, axis: keyof typeof AXIS, degrees: number) => {
    const node = vrm.humanoid.getNormalizedBoneNode(bone)
    if (!node) return
    const q = new THREE.Quaternion().setFromAxisAngle(AXIS[axis], THREE.MathUtils.degToRad(degrees))
    if (flip) {
      q.x = -q.x
      q.z = -q.z
    }
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${node.name}.quaternion`,
        [0, 1],
        [...q.toArray(), ...q.toArray()]
      )
    )
  }
  pose('leftUpperArm', 'z', -REST_POSE.armDrop)
  pose('rightUpperArm', 'z', REST_POSE.armDrop)
  pose('leftLowerArm', 'y', -REST_POSE.elbowBend)
  pose('rightLowerArm', 'y', REST_POSE.elbowBend)
  return new THREE.AnimationClip('rest', 1, tracks)
}
