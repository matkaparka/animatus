import { describe, expect, it } from 'vitest'
import { ModeManifest } from '@animatus/protocol'
import type { Background, CharLayout, Rect } from '@animatus/protocol'
import { composeStage, resolveModeStage } from '../../src/modes/stageProfile.ts'
import type { StagePresets } from '../../src/modes/stageProfile.ts'

const presets: StagePresets = {
  layouts: {
    frame: { char: { x: 40, y: 5, scale: 0.5 }, frame: { left: 5, top: 5, width: 60, height: 80 } },
    corner: { char: { x: 55, y: 0, scale: 0.4 } },
  },
  backgrounds: { night: { kind: 'color', color: '#001122' } },
  looks: { sleep: { calm: 1, dim: 0.6, mouth_scale: 0.5 } },
}
const mode = (stage: Record<string, unknown>, priority = 50) =>
  ModeManifest.parse({ id: 'm', title: 'm', priority, stage })

const baseChar: CharLayout = { x: 0, y: 0, scale: 1 }
const baseFrame: Rect | null = null
const baseBg: Background = { kind: 'none' }
const base = { layout: { char: baseChar, frame: baseFrame }, background: baseBg }

describe('resolveModeStage', () => {
  it('looks names up in the presets and passes values through', () => {
    const r = resolveModeStage(
      mode({ layout: 'frame', background: { kind: 'color', color: '#ffffff' }, look: 'sleep' }),
      presets
    )
    expect(r.problems).toEqual([])
    expect(r.stage.layout).toEqual(presets.layouts.frame)
    expect(r.stage.background).toEqual({ kind: 'color', color: '#ffffff' })
    expect(r.stage.look).toEqual(presets.looks.sleep)
  })

  it('a mode that asks for nothing changes nothing', () => {
    expect(resolveModeStage(mode({}), presets)).toEqual({ stage: {}, problems: [] })
  })

  it('a name the presets do not have is reported, and the rest of what the mode asked for still applies', () => {
    const r = resolveModeStage(mode({ layout: 'nope', look: 'sleep', background: 'gone' }), presets)
    expect(r.problems).toHaveLength(2)
    expect(r.problems[0]).toContain('layout "nope"')
    expect(r.problems[1]).toContain('background "gone"')
    expect(r.stage).toEqual({ look: presets.looks.sleep })
  })
})

describe('composeStage', () => {
  it('with nothing active it is the configuration', () => {
    expect(composeStage(base, [])).toEqual({ ...base, look: {} })
  })

  it('a layout changes the character and, if it says so, the frame; a missing field keeps the configuration', () => {
    const framed = composeStage(base, [resolveModeStage(mode({ layout: 'frame' }), presets).stage])
    expect(framed.layout).toEqual(
      presets.layouts.frame && {
        char: presets.layouts.frame.char,
        frame: presets.layouts.frame.frame,
      }
    )
    const corner = composeStage(base, [resolveModeStage(mode({ layout: 'corner' }), presets).stage])
    expect(corner.layout).toEqual({ char: { x: 55, y: 0, scale: 0.4 }, frame: null })
    const withFrame = composeStage(
      { ...base, layout: { char: baseChar, frame: { left: 1, top: 1, width: 2, height: 2 } } },
      [resolveModeStage(mode({ layout: 'corner' }), presets).stage]
    )
    expect(withFrame.layout.frame).toEqual({ left: 1, top: 1, width: 2, height: 2 })
    const cleared = composeStage(
      { ...base, layout: { char: baseChar, frame: { left: 1, top: 1, width: 2, height: 2 } } },
      [mode({ layout: { frame: null } }).stage as never]
    )
    expect(cleared.layout.frame).toBeNull()
  })

  it('the mode that comes last wins where two disagree, and looks merge field by field', () => {
    const low = resolveModeStage(
      mode({ background: 'night', look: { calm: 0.3, light: 0.8 } }),
      presets
    ).stage
    const high = resolveModeStage(mode({ look: 'sleep', layout: 'corner' }, 100), presets).stage
    const r = composeStage(base, [low, high])
    expect(r.background).toEqual({ kind: 'color', color: '#001122' }) // only the low one had a background
    expect(r.look).toEqual({ calm: 1, light: 0.8, dim: 0.6, mouth_scale: 0.5 }) // calm from the high one, light from the low one
    expect(r.layout.char).toEqual({ x: 55, y: 0, scale: 0.4 })
  })
})
