/**
 * Reading what the model answers to the mode's own questions. Models wrap JSON in code fences, add a sentence of
 * their own, write "0.8" for a number and "yes" for a boolean, and sometimes answer something else entirely: every
 * reader here returns null for an answer it cannot use instead of guessing, and the caller counts and reports that.
 */
import { MAX_GAME_CHARS, MAX_SCENE_CHARS, cleanNote, clip, normalizeGame } from './memory.ts'

export interface Identification {
  /** '' when the model did not name one. */
  game: string
  scene: string
  /** 0 to 1. */
  confidence: number
}

export interface Analysis {
  scene: string
  /** The picture shows another game or application than the one known. */
  switched: boolean
}

/** The first `{...}` object in the text (string-aware, so braces inside a value do not count), parsed. Null if none. */
export function extractObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1))
        return typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null
      } catch {
        return null
      }
    }
  }
  return null
}

/** 0.8, "0.8", "80%" and 80 all mean the same; anything else is 0 (not sure at all). */
export function toConfidence(value: unknown): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value.replace('%', ''))
        : Number.NaN
  if (!Number.isFinite(n) || n < 0) return 0
  return n > 1 ? Math.min(1, n / 100) : n
}

const truthy = (value: unknown): boolean =>
  value === true ||
  value === 1 ||
  (typeof value === 'string' && ['true', 'yes', 'y', '1'].includes(value.trim().toLowerCase()))

/** Ways a model says it does not know, instead of leaving the name out. */
const NOT_A_NAME = new Set(
  [
    'unknown',
    'unsure',
    'none',
    'null',
    'na',
    'unclear',
    'notsure',
    'notagame',
    '未知',
    '不确定',
    '无',
    '不明',
  ].map(normalizeGame)
)

export function parseIdentification(text: string): Identification | null {
  const raw = extractObject(text)
  if (!raw || (!('game' in raw) && !('confidence' in raw))) return null
  let game = cleanNote(raw.game, MAX_GAME_CHARS)
  if (NOT_A_NAME.has(normalizeGame(game))) game = ''
  return {
    game,
    scene: cleanNote(raw.scene, MAX_SCENE_CHARS),
    confidence: game === '' ? 0 : toConfidence(raw.confidence),
  }
}

export function parseAnalysis(text: string): Analysis | null {
  const raw = extractObject(text)
  if (!raw) return null
  const scene = cleanNote(raw.scene, MAX_SCENE_CHARS)
  if (scene === '' && !('switch' in raw)) return null
  return { scene, switched: truthy(raw.switch) }
}

/** The story, as one line no longer than `max` characters, cut at the end of a sentence when there is one to cut at. */
export function parseSummary(text: string, max: number): string | null {
  const bare = text
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const flat = cleanNote(bare.replace(/^["“'‘]+|["”'’]+$/g, ''), Number.MAX_SAFE_INTEGER)
  if (flat === '') return null
  const chars = [...flat]
  if (chars.length <= max) return flat
  const head = chars.slice(0, max).join('')
  const end = Math.max(
    ...['。', '．', '.', '!', '?', '！', '？', '；', ';'].map((mark) => head.lastIndexOf(mark))
  )
  // a sentence end past the middle keeps most of what was written; otherwise cut hard, marking the cut
  return end >= head.length / 2 ? head.slice(0, end + 1).trim() : clip(flat, max)
}
