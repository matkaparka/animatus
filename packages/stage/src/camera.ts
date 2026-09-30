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

// ─────────────────────────── mouse adjustments ───────────────────────────
//
// The operator moves the camera with the mouse the way the legacy viewer's OrbitControls did: left drag
// orbits, right drag (or shift + left drag) pans, the wheel zooms, a double click starts over. What the
// gestures produce is a small `CameraAdjust` kept *relative* to the pose the configuration gives, so it
// still means the same thing after the model, its size or the window changes.

export type Vec3 = [number, number, number]

/** A camera pose: where it is and what it looks at. */
export interface Pose {
  position: Vec3
  target: Vec3
}

/** The pose after an adjustment, with the camera's own axes and its distance from what it looks at. */
export interface AdjustedPose extends Pose {
  right: Vec3
  up: Vec3
  distance: number
}

const EPS = 0.05
const MAX_PAN = 4
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const normalize = (a: Vec3): Vec3 => {
  const l = length(a)
  return l < 1e-9 ? [1, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]
}
const wrapPi = (a: number) => {
  const t = (a + Math.PI) % (2 * Math.PI)
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI
}

export interface Adjust {
  yaw: number
  pitch: number
  zoom: number
  pan: Vec3
}

export const IDENTITY: Adjust = { yaw: 0, pitch: 0, zoom: 1, pan: [0, 0, 0] }

/** Keep every axis inside the bounds the protocol allows (a wild gesture can never produce an invalid report). */
export function clampAdjust(a: Adjust): Adjust {
  return {
    yaw: wrapPi(Number.isFinite(a.yaw) ? a.yaw : 0),
    pitch: clamp(Number.isFinite(a.pitch) ? a.pitch : 0, -1.5, 1.5),
    zoom: clamp(Number.isFinite(a.zoom) ? a.zoom : 1, 0.1, 8),
    pan: a.pan.map((v) => clamp(Number.isFinite(v) ? v : 0, -MAX_PAN, MAX_PAN)) as Vec3,
  }
}

export function isIdentity(a: Adjust, eps = 1e-6): boolean {
  return (
    Math.abs(a.yaw) < eps &&
    Math.abs(a.pitch) < eps &&
    Math.abs(a.zoom - 1) < eps &&
    a.pan.every((v) => Math.abs(v) < eps)
  )
}

export function sameAdjust(a: Adjust, b: Adjust, eps = 1e-4): boolean {
  return (
    Math.abs(a.yaw - b.yaw) < eps &&
    Math.abs(a.pitch - b.pitch) < eps &&
    Math.abs(a.zoom - b.zoom) < eps &&
    a.pan.every((v, i) => Math.abs(v - (b.pan[i] as number)) < eps)
  )
}

/**
 * The base pose with the operator's adjustment applied: pan moves the point looked at (in world space, in
 * units of the visible height at the base distance), yaw and pitch orbit the camera around it, zoom scales
 * the distance. The identity adjustment returns the base pose unchanged.
 */
export function applyAdjust(base: Pose, fovDeg: number, adjust: Adjust): AdjustedPose {
  const o = sub(base.position, base.target)
  const r0 = length(o)
  if (r0 < 1e-6) return { ...base, right: [1, 0, 0], up: [0, 1, 0], distance: r0 }
  const theta = Math.atan2(o[0], o[2]) + adjust.yaw
  const phi = clamp(Math.acos(clamp(o[1] / r0, -1, 1)) - adjust.pitch, EPS, Math.PI - EPS)
  const r = r0 * adjust.zoom
  const dir: Vec3 = [
    Math.sin(phi) * Math.sin(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.cos(theta),
  ]
  const baseHeight = 2 * r0 * Math.tan((Math.max(fovDeg, 1) * Math.PI) / 360)
  const target = add(base.target, scale(adjust.pan, baseHeight))
  const position = add(target, scale(dir, r))
  const forward = scale(dir, -1)
  const right = normalize(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  return { position, target, right, up, distance: r }
}

/** Left drag: 2π of rotation per viewport height, like OrbitControls. Dragging right turns the scene to the right. */
export function orbitAdjust(a: Adjust, dxPx: number, dyPx: number, heightPx: number): Adjust {
  const k = (2 * Math.PI) / Math.max(heightPx, 1)
  return clampAdjust({ ...a, yaw: a.yaw - dxPx * k, pitch: a.pitch + dyPx * k })
}

/** Right drag: the scene follows the pointer. `right` and `up` are the camera's axes in world space. */
export function panAdjust(
  a: Adjust,
  dxPx: number,
  dyPx: number,
  heightPx: number,
  right: Vec3,
  up: Vec3
): Adjust {
  // One pixel is (visible height at the current distance) / height; in units of the base height that is zoom / height.
  const k = a.zoom / Math.max(heightPx, 1)
  const shift = add(scale(right, -dxPx * k), scale(up, dyPx * k))
  return clampAdjust({ ...a, pan: add(a.pan, shift) })
}

/** Wheel: each 100 units of delta closes or opens the distance by 5 percent, like OrbitControls. */
export function dollyAdjust(a: Adjust, deltaY: number): Adjust {
  const step = Math.pow(0.95, Math.abs(deltaY) * 0.01)
  return clampAdjust({ ...a, zoom: deltaY < 0 ? a.zoom * step : a.zoom / step })
}
