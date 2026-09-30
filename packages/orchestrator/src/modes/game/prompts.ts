/**
 * The prompt files of the game pack (`modes/game/prompts/`), the words for the agent's status, and the blocks of text made
 * from what the agent reported. All of it goes to the model, so all of it is cleaned (see text.ts): the agent's events carry
 * other players' words, and a block is introduced as facts, never as orders.
 */
import type { WorkerState } from '@animatus/protocol'
import type { ModeHost } from '../host.ts'
import type { GameEvent } from './events.ts'
import { ago, cleanGameText } from './text.ts'

export const MODE_ID = 'game'

/**
 * The files the pack must have; a missing one stops the mode from starting instead of being replaced by a guess. `active`
 * is the manifest's own prompt; the others are told to the model with each comment.
 */
export const REQUIRED_PROMPTS = ['active', 'comment', 'restarted', 'steering'] as const
export type PromptName = (typeof REQUIRED_PROMPTS)[number]

/** A prompt of the pack with its `{{variables}}` filled in. */
export function prompt(
  host: Pick<ModeHost, 'prompt'>,
  name: PromptName,
  vars: Record<string, string> = {}
): string {
  const text = host.prompt(MODE_ID, name, vars)
  if (text === null) throw new Error(`the game pack has no prompts/${name}.md`)
  return text
}

/** The files the pack lacks, as `prompts/<name>.md`; empty when it is complete. */
export function missingPrompts(host: Pick<ModeHost, 'prompt'>): string[] {
  return REQUIRED_PROMPTS.filter((name) => host.prompt(MODE_ID, name) === null).map(
    (name) => `prompts/${name}.md`
  )
}

/** The facts of the state as lines; at most this many are shown, the agent may send thirty. */
const MAX_FACT_LINES = 20
const MAX_FACT_VALUE_CHARS = 120
const MAX_SUMMARY_CHARS = 400
const MAX_EVENT_CHARS = 300

/**
 * What the game agent is doing, in words for the model: `not known yet` before the first answer, `not answering` while it
 * does not, `offline` when it is not in a game, `paused`, `doing <what>`, `stuck`, `thinking`, else `idle`.
 */
export function describeStatus(state: WorkerState | null, unreachable: string | null): string {
  if (state === null) return 'not known yet'
  if (unreachable !== null) return 'not answering right now (what follows may be out of date)'
  if (!state.online) return 'offline (it is not in a game)'
  if (state.paused) return 'paused (it is not playing right now)'
  const p = state.planner
  if (p.executing) return `doing: ${cleanGameText(p.executing, 120)}`
  if (p.given_up) return 'stuck (it gave up on its goal and needs a new directive)'
  if (p.thinking) return 'thinking about what to do next'
  return 'idle (waiting for something to do)'
}

/** The state's numbers and words as `- key: value` lines; a line for each, `(none reported)` when there are none. */
export function factLines(facts: WorkerState['facts'] | undefined): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(facts ?? {})) {
    if (value === null) continue
    const k = cleanGameText(key, 40)
    if (k === '') continue
    const v = typeof value === 'string' ? cleanGameText(value, MAX_FACT_VALUE_CHARS) : String(value)
    lines.push(`- ${k}: ${v}`)
    if (lines.length >= MAX_FACT_LINES) break
  }
  return lines.length > 0 ? lines.join('\n') : '(none reported)'
}

/** The background notes as `- text (12 s ago)` lines, oldest first. */
export function noteLines(notes: readonly GameEvent[], now: number): string {
  if (notes.length === 0) return '(nothing yet)'
  return notes.map((e) => `- ${e.text} (${ago(now - e.seenAt)})`).join('\n')
}

/** What the comment is about: `- kind (12 s ago): "text"`, immediate events first, and a line for what was left out. */
export function eventLines(events: readonly GameEvent[], omitted: number, now: number): string {
  const lines = events.map(
    (e) => `- ${e.kind} (${ago(now - e.seenAt)}): "${e.text.replaceAll('"', "'")}"`
  )
  if (omitted > 0) lines.push(`- (${omitted} more that are not listed)`)
  return lines.length > 0 ? lines.join('\n') : '(nothing else was reported)'
}

/** How an event is kept: cleaned and bounded, with the numbers of the mode's own run. */
export function keepEvent(
  no: number,
  e: { kind: string; text: string; urgency: GameEvent['urgency'] },
  now: number
): GameEvent {
  return {
    no,
    kind: cleanGameText(e.kind, 40) || 'event',
    text: cleanGameText(e.text, MAX_EVENT_CHARS),
    urgency: e.urgency,
    seenAt: now,
  }
}

export interface PromptView {
  /** How the game is called. */
  title: string
  state: WorkerState | null
  /** Why the agent does not answer, or null while it does. */
  unreachable: string | null
  notes: readonly GameEvent[]
  now: number
  /** The pack's `steering.md`, or '' when the operator switched the tool off. */
  steering: string
}

/** The values of the `{{placeholders}}` of `active.md`. Nothing is ever `undefined`: what is not known says so. */
export function promptVars(v: PromptView): Record<string, string> {
  return {
    game_name: v.title,
    game_status: describeStatus(v.state, v.unreachable),
    game_summary: cleanGameText(v.state?.summary, MAX_SUMMARY_CHARS) || '(nothing reported yet)',
    game_facts: factLines(v.state?.facts),
    game_notes: noteLines(v.notes, v.now),
    game_steering: v.steering,
  }
}
