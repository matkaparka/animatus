import { describe, expect, it } from 'vitest'
import * as avatar from '../../src/avatar/index.ts'

describe('avatar public API', () => {
  it('exports everything the stage needs from one place', () => {
    const functions = [
      'LiveLayer',
      'applyLiveTuning',
      'detectBlinkSupport',
      'MotionDirector',
      'applyMotionTuning',
      'loadVrma',
      'parseVrma',
      'createClip',
      'mirrorVRMAnimation',
      'SmoothLookAt',
      'SmoothLookAtLoaderPlugin',
      'attachGazeTarget',
      'ExpressionController',
      'loadVrm',
      'describeVrm',
      'disposeVrm',
      'TPoseMonitor',
      'meanAngleFromBind',
    ]
    for (const name of functions) {
      expect(typeof (avatar as Record<string, unknown>)[name], name).toBe('function')
    }
    for (const name of ['LIVE', 'MOTION', 'DEFAULT_SACCADE']) {
      expect(typeof (avatar as Record<string, unknown>)[name], name).toBe('object')
    }
  })

  it('exposes the tuning objects as the very objects the classes read', () => {
    expect(avatar.applyLiveTuning({ nodAmp: 7 })).toEqual(['nodAmp'])
    expect(avatar.LIVE.nodAmp).toBe(7)
    avatar.applyLiveTuning({ nodAmp: 3.5 })
    expect(avatar.applyMotionTuning({ release: 0.3 })).toEqual(['release'])
    expect(avatar.MOTION.release).toBe(0.3)
    avatar.applyMotionTuning({ release: 0.2 })
  })

  it('keeps the shared tuning helper internal', () => {
    expect('applyNumericTuning' in avatar).toBe(false)
  })
})
