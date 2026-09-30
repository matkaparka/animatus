/**
 * What the stage looks like while modes are active.
 *
 * A mode pack says in its manifest what it wants of the stage (`stage.layout`, `stage.background`, `stage.look`),
 * either as the values themselves or as the name of a preset in the operator's configuration. This module turns
 * that into one scene and one look for the modes that are active right now; the application sends the result and
 * sends the plain configuration again when the mode is left. Nothing here talks to the stage.
 */
import type {
  Background,
  CharLayout,
  LayoutOverride,
  LookOverride,
  ModeManifest,
  Rect,
} from '@animatus/protocol'

/** The named presets of `stage.presets` in the configuration. */
export interface StagePresets {
  layouts: Readonly<Record<string, LayoutOverride>>
  backgrounds: Readonly<Record<string, Background>>
  looks: Readonly<Record<string, LookOverride>>
}

/** What one mode wants, with the names looked up. */
export interface ModeStage {
  layout?: LayoutOverride
  background?: Background
  look?: LookOverride
}

export interface ResolvedModeStage {
  stage: ModeStage
  /** Names the presets do not have. The rest of the mode's wishes still apply. */
  problems: string[]
}

export function resolveModeStage(m: ModeManifest, presets: StagePresets): ResolvedModeStage {
  const stage: ModeStage = {}
  const problems: string[] = []
  const wanted = m.stage
  if (wanted.layout !== undefined) {
    if (typeof wanted.layout === 'string') {
      const p = presets.layouts[wanted.layout]
      if (p) stage.layout = p
      else problems.push(`the layout "${wanted.layout}" is not in stage.presets.layouts`)
    } else stage.layout = wanted.layout
  }
  if (wanted.background !== undefined) {
    if (typeof wanted.background === 'string') {
      const p = presets.backgrounds[wanted.background]
      if (p) stage.background = p
      else
        problems.push(`the background "${wanted.background}" is not in stage.presets.backgrounds`)
    } else stage.background = wanted.background
  }
  if (wanted.look !== undefined) {
    if (typeof wanted.look === 'string') {
      const p = presets.looks[wanted.look]
      if (p) stage.look = p
      else problems.push(`the look "${wanted.look}" is not in stage.presets.looks`)
    } else stage.look = wanted.look
  }
  return { stage, problems }
}

export interface BaseStage {
  layout: { char: CharLayout; frame: Rect | null }
  background: Background
}

export interface ComposedStage extends BaseStage {
  /** Only the fields some mode set; the rest are the stage's own defaults. */
  look: LookOverride
}

/**
 * The stage for the configuration plus these modes, lowest priority first (so the one that comes last wins where
 * they disagree). Layout fields and look fields merge one by one; a background replaces the whole background.
 */
export function composeStage(base: BaseStage, stack: readonly ModeStage[]): ComposedStage {
  let char = base.layout.char
  let frame = base.layout.frame
  let background = base.background
  const look: LookOverride = {}
  for (const m of stack) {
    if (m.layout?.char) char = m.layout.char
    if (m.layout && m.layout.frame !== undefined) frame = m.layout.frame
    if (m.background) background = m.background
    if (m.look) Object.assign(look, m.look)
  }
  return { layout: { char, frame }, background, look }
}
