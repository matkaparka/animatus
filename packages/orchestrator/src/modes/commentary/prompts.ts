/** The prompt files of the commentary pack (`modes/commentary/prompts/`), and asking the host for them. */
import type { ModeHost } from '../host.ts'

export const MODE_ID = 'commentary'

/** The files the pack must have; a missing one stops the mode from starting instead of being replaced by a guess. */
export const REQUIRED_PROMPTS = [
  'round',
  'identify',
  'analyze',
  'summarize',
  'screen_known',
  'screen_unsure',
  'seen',
  'progress',
] as const
export type PromptName = (typeof REQUIRED_PROMPTS)[number]

/** A prompt of the pack with its `{{variables}}` filled in. */
export function prompt(
  host: Pick<ModeHost, 'prompt'>,
  name: PromptName,
  vars: Record<string, string> = {}
): string {
  const text = host.prompt(MODE_ID, name, vars)
  if (text === null) throw new Error(`the commentary pack has no prompts/${name}.md`)
  return text
}

/** The files the pack lacks, as `prompts/<name>.md`; empty when it is complete. */
export function missingPrompts(host: Pick<ModeHost, 'prompt'>): string[] {
  return REQUIRED_PROMPTS.filter((name) => host.prompt(MODE_ID, name) === null).map(
    (name) => `prompts/${name}.md`
  )
}
