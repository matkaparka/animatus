/**
 * Small pure helpers of the planner: reading the model's JSON, tidying a prompt it wrote, picture sizes.
 * Ported from the legacy planner; the quality-word list and the clean-up rules are the same on purpose.
 */
import type { GenerationParams } from './settings.ts'

/** A single backslash that is not a JSON escape (`\(` in a danbooru tag), which the model writes all the time. */
const BAD_ESCAPE = /\\(?![\\"/bfnrtu])/g

/** The first JSON object in the text, or null. Code fences around it are ignored. */
function firstObject(text: string): Record<string, unknown> | null {
  const t = text.replace(/```(?:json)?/g, '').trim()
  let start = t.indexOf('{')
  while (start !== -1) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < t.length; i++) {
      const c = t[i]
      if (inString) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') inString = false
      } else if (c === '"') inString = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          try {
            const value: unknown = JSON.parse(t.slice(start, i + 1))
            if (value !== null && typeof value === 'object' && !Array.isArray(value))
              return value as Record<string, unknown>
          } catch {
            // not JSON after all: look for the next opening brace
          }
          break
        }
      }
    }
    start = t.indexOf('{', start + 1)
  }
  return null
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  return firstObject(text) ?? firstObject(text.replace(BAD_ESCAPE, '\\\\'))
}

const QUALITY_TOKEN =
  /^\(?\s*(masterpiece|best quality|high quality|ultra quality|amazing quality|very aesthetic|absurdres|highres|score_\d(_up)?|rating_safe)\s*(:[\d.]+)?\s*\)?$/i

/** Takes out the LoRA tags the model wrote, its quality words (added by the program per model) and remarks about trigger words. */
export function cleanPrompt(prompt: string): string {
  const p = prompt
    .replace(/<(lora|lyco):[^>]+>/gi, '')
    .replace(/[,;]?\s*[^,.;]*\btrigger (words?|tokens?)\b[^.;]*/gi, '')
  return p
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '' && !QUALITY_TOKEN.test(part))
    .join(', ')
}

/**
 * Tags that mean something else in the models' vocabulary (`husky` is a dog there) are dropped unless the request
 * has one of the words listed for them.
 */
export function dropAmbiguous(
  prompt: string,
  request: string,
  table: Readonly<Record<string, readonly string[]>>
): string {
  const lower = request.toLowerCase()
  const words = new Map(Object.entries(table).map(([k, v]) => [k.toLowerCase(), v]))
  return prompt
    .split(',')
    .filter((part) => {
      const allowed = words.get(part.trim().toLowerCase())
      return allowed === undefined || allowed.some((w) => lower.includes(w.toLowerCase()))
    })
    .join(',')
}

const round64 = (x: number): number => Math.max(512, Math.round(x / 64) * 64)

export type Orientation = 'portrait' | 'landscape' | 'square'

export const orientationOf = (v: unknown): Orientation =>
  v === 'portrait' || v === 'landscape' || v === 'square' ? v : 'square'

/** Width and height (multiples of 64) for a shape, from the area of the model's usual square picture unless the size is named. */
export function sizeFor(params: GenerationParams, orientation: Orientation): [number, number] {
  const named = params.sizes[orientation]
  if (named) return [named[0], named[1]]
  const area = params.width * params.height
  if (orientation === 'square') {
    const s = round64(Math.sqrt(area))
    return [s, s]
  }
  const short = round64(Math.sqrt((area * 13) / 19))
  const long = Math.max(512, Math.floor(Math.floor(area / short) / 64) * 64)
  return orientation === 'portrait' ? [short, long] : [long, short]
}
