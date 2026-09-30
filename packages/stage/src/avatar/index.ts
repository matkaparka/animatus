export { LIVE, LiveLayer, applyLiveTuning, detectBlinkSupport } from './liveLayer.ts'
export type { BlinkMode, LiveLayerOptions, LiveState } from './liveLayer.ts'

export { MOTION, MotionDirector, applyMotionTuning } from './motionDirector.ts'
export type {
  DirectorEntryInfo,
  IdleSource,
  MotionDirectorOptions,
  TalkClip,
} from './motionDirector.ts'

export { DEFAULT_SKIP_BONES, createClip, loadVrma, mirrorVRMAnimation, parseVrma } from './clips.ts'
export type { CreateClipOptions } from './clips.ts'

export {
  DEFAULT_SACCADE,
  DEFAULT_SMOOTH_TAU,
  SmoothLookAt,
  SmoothLookAtLoaderPlugin,
  attachGazeTarget,
} from './lookAt.ts'
export type { SaccadeOptions, SmoothLookAtOptions } from './lookAt.ts'

export { ExpressionController } from './expression.ts'
export type { Vowel, VowelWeights } from './expression.ts'

export { describeVrm, disposeVrm, loadVrm } from './vrmModel.ts'
export type { ModelInfo } from './vrmModel.ts'

// T-pose detection lives in diag/ (soak test) but is re-exported here for convenience.
export { TPOSE_BONES, TPoseMonitor, meanAngleFromBind } from '../diag/tpose.ts'
export type { TPoseMonitorOptions } from '../diag/tpose.ts'

export { measureBody } from './measure.ts'
