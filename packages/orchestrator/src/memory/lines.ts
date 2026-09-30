/**
 * The line format of the memory files.
 *
 * Memory is Markdown in a folder, one fact per line, and the same files are read and written by the operator
 * and by the program. A fact line starts with where it came from, then the date, then the words:
 *
 *   [human] 2026-09-30 Never discusses politics.
 *   [human:locked] 2026-09-30 Her catchphrase is "watch closely".
 *   [viewer] 2026-09-29 小明: has a cat
 *   [agent] 2026-09-30 小明 usually comes on weekends.
 *
 * Sources, most trusted first: `human` (the streamer wrote it), `viewer` (a viewer said it about themselves),
 * `agent` (the program summarised it). Where two lines disagree the more trusted one wins. A human line may be
 * locked: the program can never change or remove it. Anything else in a file (headings, notes, blank lines) is
 * kept as it is; it is read as a human note.
 */

export const SOURCES = ['human', 'viewer', 'agent'] as const
export type Source = (typeof SOURCES)[number]

/** Higher wins. */
export const TRUST: Readonly<Record<Source, number>> = { human: 3, viewer: 2, agent: 1 }

export interface FactLine {
  kind: 'fact'
  source: Source
  locked: boolean
  /** `YYYY-MM-DD`. */
  date: string
  text: string
}

export interface NoteLine {
  kind: 'note'
  /** The whole line, unchanged (a heading, a comment, an empty line). */
  text: string
}

export type ParsedLine = FactLine | NoteLine

const FACT = /^\[(human|viewer|agent)(:locked)?\][ \t]+(\d{4}-\d{2}-\d{2})[ \t]+(.*)$/

export function parseLine(line: string): ParsedLine {
  const m = FACT.exec(line)
  if (!m) return { kind: 'note', text: line }
  // a lock only means something on a human line
  const source = m[1] as Source
  return {
    kind: 'fact',
    source,
    locked: m[2] !== undefined && source === 'human',
    date: m[3] as string,
    text: (m[4] as string).trimEnd(),
  }
}

export function formatFact(f: Pick<FactLine, 'source' | 'locked' | 'date' | 'text'>): string {
  const tag = f.locked && f.source === 'human' ? 'human:locked' : f.source
  return `[${tag}] ${f.date} ${f.text}`
}

export function todayString(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** Lines of a file: `\n` or `\r\n`, the final newline does not make an extra empty line. */
export function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function joinLines(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * A viewer's words made safe to keep in a fact line and to show to the model later: one line, no control
 * characters, the chat's own marker brackets neutralised (a viewer cannot type a marker of their own), no line that
 * looks like a fact of another source, bounded.
 */
export function cleanFactText(text: string, max = 200): string {
  let t = text
    .replace(/[\x00-\x1f\x7f\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/【/g, '[')
    .replace(/】/g, ']')
    .replace(/\s+/g, ' ')
    .trim()
  // a fact must not start like a line of its own (`[human] 2026-01-01 ...`)
  t = t.replace(/^\[(?:human|viewer|agent)(?::locked)?\]/i, '(source tag removed)')
  const chars = [...t]
  if (chars.length > max) t = `${chars.slice(0, max - 1).join('')}…`
  return t
}
