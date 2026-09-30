import type { CameraFit } from '@animatus/protocol'

/** World-space numbers measured once the model is standing in its idle pose. */
export interface BodyMetrics {
  /** Where the body stands, horizontally. */
  x: number
  z: number
  /** The lower of the two ankle joints (not the sole). */
  footY: number
  hipsY: number
  /** The head joint (base of the skull), not the crown. */
  headY: number
}

export type FitMode = Exclude<CameraFit, 'none'>

/** Height of the crown above the head joint, as a share of the head-joint-to-foot height. */
const CROWN = 0.15
/** Half the width to keep in view, as a share of the head-joint-to-foot height (shoulders, arms, a little air). */
const HALF_WIDTH: Record<FitMode, number> = { full_body: 0.32, upper_body: 0.32, head: 0.2 }
/** Air around the framed part. */
const MARGIN = 1.08

/** The vertical span of the world (bottom, top) that a fit mode wants in view. */
export function frameSpan(fit: FitMode, m: BodyMetrics): { bottom: number; top: number } {
  const height = Math.max(m.headY - m.footY, 0.1)
  const crown = m.headY + CROWN * height
  switch (fit) {
    case 'full_body':
      // footY is the ankle joint; the sole is lower by roughly a tenth of the figure.
      return { bottom: m.footY - 0.1 * height, top: crown + 0.05 * height }
    case 'upper_body':
      return { bottom: m.hipsY, top: crown + 0.06 * height }
    case 'head':
      return { bottom: m.headY - 0.2 * height, top: crown + 0.03 * height }
  }
}

/**
 * Camera that shows the chosen part of the body in the middle of the frame, looking straight along -z from
 * far enough away for both the height and the width to fit. Works for any model scale.
 */
export function fitCamera(
  fit: FitMode,
  fovDeg: number,
  aspect: number,
  m: BodyMetrics
): { position: [number, number, number]; target: [number, number, number] } {
  const { bottom, top } = frameSpan(fit, m)
  const tan = Math.tan((Math.max(fovDeg, 1) * Math.PI) / 360)
  const height = Math.max(m.headY - m.footY, 0.1)
  const needForHeight = (top - bottom) / 2 / tan
  const needForWidth = (HALF_WIDTH[fit] * height) / (tan * Math.max(aspect, 0.1))
  const distance = Math.max(needForHeight, needForWidth) * MARGIN
  const cy = (top + bottom) / 2
  return { position: [m.x, cy, m.z + distance], target: [m.x, cy, m.z] }
}
