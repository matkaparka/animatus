/**
 * Small text tools of the game mode. Whatever the game agent reports may carry other people's words (a player's chat line,
 * a name, a sign in the world), so everything that goes into a prompt, a panel or a log line passes through here.
 */
import { WorkerError } from '../../workers/index.ts'
import { cleanNote, clip, firstLine } from '../commentary/memory.ts'

export { clip, firstLine }
export { ago } from '../commentary/panel.ts'

/**
 * Text from the game or its agent, made safe to put in a prompt: one line, no control or invisible characters, square
 * brackets turned into round ones (it cannot look like a `[motion:...]` tag or a 【系统】 line), braces broken up (it
 * cannot look like a placeholder), backticks turned into apostrophes (it cannot carry a tool block), cut to `max`.
 */
export function cleanGameText(value: unknown, max: number): string {
  return cleanNote(value, max).replaceAll('`', "'")
}

/** A directive as it is sent: on one line, without control characters. */
export function oneLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** What went wrong with a call to the agent, in the agent's own words where it gave any; one short line. */
export function workerWords(e: unknown): string {
  if (e instanceof WorkerError) return cleanGameText(e.message, 200) || e.code
  return clip(firstLine(e), 200)
}
