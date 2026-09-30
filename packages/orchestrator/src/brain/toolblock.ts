/**
 * Reading a tool call out of the model's reply. The model asks for a tool by writing a fenced block whose language
 * word is `tool`, with one JSON object inside:
 *
 *   {"tool": "enter_mode", "args": {"mode": "sleep"}}
 *
 * This module only reads the block. Whether the call may run is decided by the tool gate, and never here.
 */

/** A block longer than this is not a tool call. */
export const MAX_TOOL_BLOCK_CHARS = 2000

const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/

export type ToolBlockProblem = 'too_big' | 'bad_block' | 'unterminated' | 'too_many'

export type ParsedToolBlock =
  | { ok: true; tool: string; args: Record<string, unknown> }
  | { ok: false; reason: ToolBlockProblem }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseToolBlock(raw: string): ParsedToolBlock {
  if (raw.length > MAX_TOOL_BLOCK_CHARS) return { ok: false, reason: 'too_big' }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'bad_block' }
  }
  if (!isPlainObject(value)) return { ok: false, reason: 'bad_block' }
  const tool = value.tool
  if (typeof tool !== 'string' || !TOOL_NAME.test(tool)) return { ok: false, reason: 'bad_block' }
  const args = value.args === undefined ? {} : value.args
  if (!isPlainObject(args)) return { ok: false, reason: 'bad_block' }
  return { ok: true, tool, args }
}
