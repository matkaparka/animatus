/**
 * What the mode remembers about the stream, and the small text tools that keep what the model wrote about a picture
 * safe to put back into a prompt.
 *
 * The memory lasts for the whole stream: it is written to `data/commentary-state.json`, survives leaving and entering
 * the mode and a restart of the program, and is reset only when the operator clears it. It never holds a picture.
 */

/** The window the operator chose on the panel. Any of the three can find it again after the game is restarted. */
export interface WindowPick {
  /** The window id it had when it was picked; a new id every time the program starts. */
  id: string | null
  /** Its title (or what the operator typed: part of a title, `exe:name`). */
  title: string
  /** The program it belongs to, so a window whose title keeps changing can still be found. */
  process: string
}

export interface MemoryState {
  /** The last game identified with enough confidence; '' before there was one. */
  game: string
  /** How sure the most recent identification was, 0 to 1. Below the setting the game counts as "not sure". */
  confidence: number
  /** What was on screen when it was last looked at. */
  scene: string
  /** When the game was last identified (epoch ms); 0 = never. */
  identifiedAt: number
  /** The story so far. */
  summary: string
  /** Comments made since the memory was started or cleared. */
  rounds: number
  /** Comments since the story was last renewed. */
  sinceSummary: number
  /** Notes on the screen not yet folded into the story, oldest first. */
  pending: string[]
  /** The operator's window pick from the panel. */
  window: WindowPick | null
  /** The operator's interval from the panel; null = the setting. */
  interval: number | null
}

export const emptyMemory = (): MemoryState => ({
  game: '',
  confidence: 0,
  scene: '',
  identifiedAt: 0,
  summary: '',
  rounds: 0,
  sinceSummary: 0,
  pending: [],
  window: null,
  interval: null,
})

export const MAX_GAME_CHARS = 80
export const MAX_SCENE_CHARS = 300
/** Notes kept for the next story, whatever the settings: a story that keeps failing must not grow without end. */
export const MAX_PENDING = 60
const MAX_TITLE_CHARS = 300

// ─────────────────────────────── text ───────────────────────────────

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/gu
const INVISIBLE = /[\p{Cf}\u{e0000}-\u{e007f}]/gu

/** The first `max` characters (code points, never half a surrogate pair), with an ellipsis when something was cut. */
export function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, Math.max(0, max - 1))
        .join('')
        .trimEnd()}…`
}

/**
 * Text the model wrote about a picture, made safe to go back into a prompt: one line, no control or invisible
 * characters, square brackets turned into round ones (a note must not be able to look like a `[motion:...]` tag or a
 * 【system】 line), braces broken up (so it cannot be mistaken for a placeholder), cut to `max` characters.
 */
export function cleanNote(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = value
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/[[【［]/g, '(')
    .replace(/[\]】］]/g, ')')
    .replace(/\{\{/g, '{ {')
    .replace(/\}\}/g, '} }')
    .replace(/\s+/g, ' ')
    .trim()
  return clip(flat, max)
}

/** Lower case, only letters and digits of any script: "Minecraft: Java Edition" and "minecraft java edition" agree. */
export function normalizeGame(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** The same game under the same name. Deliberately not "one contains the other": "Civilization VI" is not "VII". */
export function sameGame(a: string, b: string): boolean {
  const x = normalizeGame(a)
  return x !== '' && x === normalizeGame(b)
}

// ─────────────────────────────── the state file ───────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const count = (v: unknown): number =>
  finite(v) && v >= 0 ? Math.min(Math.floor(v), 1_000_000_000) : 0

function parsePick(v: unknown): WindowPick | null {
  if (!isRecord(v)) return null
  const id = typeof v.id === 'string' && /^\d{1,20}$/.test(v.id) ? v.id : null
  const title = cleanTitle(v.title)
  const process = cleanTitle(v.process, 260)
  return id === null && title === '' && process === '' ? null : { id, title, process }
}

/** A window title or query as it is kept and sent: one line, bounded. Unlike a note, brackets stay (titles have them). */
export function cleanTitle(value: unknown, max = MAX_TITLE_CHARS): string {
  if (typeof value !== 'string') return ''
  return clip(value.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), max)
}

/**
 * Reads the state file's content. The file is edited by hand now and then and can be torn by a crash: whatever is
 * not the right kind of value is dropped, and nothing here throws.
 */
export function parseMemory(raw: unknown, summaryMax = 1000): MemoryState {
  const memory = emptyMemory()
  if (!isRecord(raw)) return memory
  memory.game = cleanNote(raw.game, MAX_GAME_CHARS)
  memory.confidence = finite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0
  memory.scene = cleanNote(raw.scene, MAX_SCENE_CHARS)
  memory.identifiedAt = finite(raw.identifiedAt) && raw.identifiedAt > 0 ? raw.identifiedAt : 0
  memory.summary = cleanNote(raw.summary, summaryMax)
  memory.rounds = count(raw.rounds)
  memory.sinceSummary = count(raw.sinceSummary)
  if (Array.isArray(raw.pending))
    memory.pending = raw.pending
      .map((s) => cleanNote(s, MAX_SCENE_CHARS))
      .filter((s) => s !== '')
      .slice(-MAX_PENDING)
  memory.window = parsePick(raw.window)
  memory.interval =
    finite(raw.interval) && raw.interval >= 3 && raw.interval <= 600 ? raw.interval : null
  // a game with no name cannot be sure of anything
  if (memory.game === '') memory.confidence = 0
  return memory
}

/** The file's content: the memory plus a version, so a later change of shape can be told apart. */
export function memoryFileContent(memory: MemoryState): Record<string, unknown> {
  return { version: 1, ...memory }
}
