/**
 * T-pose detection for the soak test.
 *
 * In the normalised humanoid space a bone's local rotation is relative to the bind (T-) pose, so the
 * bind pose is the identity rotation for every bone. If the mixer ever lets weight slip to the bind
 * pose (see the motion director), the arms, legs and spine of the normalised skeleton all snap to
 * identity at once. A legitimate gesture never puts all of them there at the same time.
 */
import type * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

/** The bones checked by default: arms, forearms, hands, upper and lower legs, spine and chest. */
export const TPOSE_BONES: readonly VRMHumanBoneName[] = [
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftHand',
  'rightHand',
  'leftUpperLeg',
  'rightUpperLeg',
  'leftLowerLeg',
  'rightLowerLeg',
  'spine',
  'chest',
]

const RAD2DEG = 180 / Math.PI

/** Rotation angle of one quaternion away from identity, in degrees (0..180). Tolerates non-unit input. */
function angleFromIdentity(q: THREE.Quaternion): number {
  const v = Math.hypot(q.x, q.y, q.z)
  return 2 * Math.atan2(v, Math.abs(q.w)) * RAD2DEG
}

/**
 * Mean rotation angle, in degrees, of the given quaternions away from the identity (the bind pose).
 * q and -q are the same rotation and give the same angle. Returns 0 for no input.
 */
export function meanAngleFromBind(quats: Iterable<THREE.Quaternion>): number {
  let sum = 0
  let n = 0
  for (const q of quats) {
    sum += angleFromIdentity(q)
    n++
  }
  return n === 0 ? 0 : sum / n
}

export interface TPoseMonitorOptions {
  /** The pose counts as "everything at bind" when the mean angle is below this (default 4 degrees). */
  thresholdDeg?: number
  /** Bones to look at (default `TPOSE_BONES`). Bones the model does not have are skipped. */
  bones?: readonly VRMHumanBoneName[]
}

export class TPoseMonitor {
  private nodes: THREE.Object3D[] = []
  private readonly threshold: number
  private mean = 0

  constructor(vrm: VRM, opts: TPoseMonitorOptions = {}) {
    this.threshold = opts.thresholdDeg ?? 4
    for (const name of opts.bones ?? TPOSE_BONES) {
      const node = vrm.humanoid.getNormalizedBoneNode(name)
      if (node) this.nodes.push(node)
    }
  }

  /** Mean angle (degrees) measured by the last `check()`. */
  get lastMeanAngle(): number {
    return this.mean
  }

  /**
   * True when the whole body is in bind pose: the mean angle of the checked bones is below the
   * threshold. False when none of the bones exist (nothing to judge by). Call once per frame, after
   * everything that moves bones has run.
   */
  check(): boolean {
    if (this.nodes.length === 0) return false
    let sum = 0
    for (const node of this.nodes) sum += angleFromIdentity(node.quaternion)
    this.mean = sum / this.nodes.length
    return this.mean < this.threshold
  }
}
