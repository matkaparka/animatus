/**
 * The memory store: a folder of Markdown files that the streamer and the program both read and write.
 *
 *   persona/     the persona text and the rules the character follows (only the streamer writes here; the program can
 *                only leave a proposal)
 *   viewers/     one file per viewer: what they said about themselves, the songs they asked for, when they joined
 *   stream/      notes and rolling summaries of streams
 *   world/       memes, settings, what the community knows
 *   search-cache/ results of web searches, all of it untrusted
 *   proposals/   changes the program would like the streamer to approve
 *   inbox/       raw events of the running stream, waiting for the consolidation pass (not in the history)
 *
 * Every change to the persona, the world, the stream notes and the web results is one commit whose author says who
 * made it. Viewer files are not versioned: they hold what people said about themselves, and "forget me" has to be
 * able to erase it completely, which a history would make impossible. The streamer's edits win: the program can neither
 * change nor remove a line the streamer wrote, and never a locked one. Every write carries the hash of what it was
 * based on, so two writers cannot silently overwrite each other. Calls are serialised, so two changes never
 * interleave. The search index is updated before a call returns: an edit is in effect for the very next reply.
 */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { MemoryGit } from './git.ts'
import type { Author, Commit } from './git.ts'
import {
  TRUST,
  cleanFactText,
  formatFact,
  joinLines,
  parseLine,
  splitLines,
  todayString,
} from './lines.ts'
import type { FactLine, ParsedLine, Source } from './lines.ts'
import { Bm25Index } from './search.ts'

export const SECTIONS = [
  'persona',
  'viewers',
  'stream',
  'world',
  'search-cache',
  'proposals',
  'inbox',
] as const
export type Section = (typeof SECTIONS)[number]

/** Sections whose lines can be recalled into a reply. */
const RECALLED: readonly Section[] = ['viewers', 'stream', 'world', 'search-cache']

export const MAX_FILE_BYTES = 256 * 1024
export const MAX_FACT_LINES_PER_FILE = 600

export type FailureCode =
  | 'bad_path'
  | 'forbidden'
  | 'conflict'
  | 'locked'
  | 'human_wins'
  | 'not_found'
  | 'too_big'
  | 'no_line'
  | 'bad_line'
export type Outcome<T = object> =
  ({ ok: true } & T) | { ok: false; code: FailureCode; message: string }

const fail = (
  code: FailureCode,
  message: string
): { ok: false; code: FailureCode; message: string } => ({
  ok: false,
  code,
  message,
})

export interface LineMeta {
  file: string
  section: Section
  /** 0-based line number in the file. */
  lineNo: number
  line: ParsedLine
}

export interface FileView {
  path: string
  content: string
  hash: string
  lines: ParsedLine[]
}

export interface TreeEntry {
  path: string
  section: Section
  bytes: number
  /** Fact lines in the file. */
  facts: number
  mtime: number
}

export interface StoreOptions {
  root: string
  now?: () => number
  /** How long a change by the program waits to be committed together with the next ones. Default 20 000 ms. */
  commitDelayMs?: number
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void
  /** Watch the folder for edits made by hand in an editor. Default true. */
  watch?: boolean
  /** A substitute for the git wrapper (tests). */
  git?: MemoryGit
}

type Events = { change: [file: string, author: Author] }

const hashOf = (content: string): string => createHash('sha1').update(content).digest('hex')

/** The normalised form of a path inside the store, or null when it is not one. */
export function normalizePath(input: string): { path: string; section: Section } | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 200) return null
  const parts = input.replace(/\\/g, '/').split('/')
  if (parts.length < 2 || parts.length > 3) return null
  for (const p of parts) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(p) || p.length > 100 || /[. ]$/.test(p))
      return null
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)) return null
  }
  const section = parts[0] as Section
  if (!SECTIONS.includes(section)) return null
  const name = parts[parts.length - 1] as string
  const ok =
    section === 'inbox'
      ? name.endsWith('.jsonl')
      : section === 'proposals'
        ? name.endsWith('.json')
        : name.endsWith('.md')
  if (!ok) return null
  return { path: parts.join('/'), section }
}

export class MemoryStore extends EventEmitter<Events> {
  readonly root: string
  readonly git: MemoryGit
  private readonly now: () => number
  private readonly commitDelayMs: number
  private readonly log: NonNullable<StoreOptions['log']>
  private readonly watchEnabled: boolean
  private readonly index = new Bm25Index<LineMeta>()
  /** file -> hash of what the store last wrote or read, to tell an edit by hand from its own write. */
  private readonly known = new Map<string, string>()
  private readonly pending = new Map<Author, Set<string>>()
  private readonly pendingMessages = new Map<Author, string[]>()
  private commitTimer: NodeJS.Timeout | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private watcher: FSWatcher | null = null
  private watchTimer: NodeJS.Timeout | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  private readonly dirty = new Set<string>()
  private started = false
  /** viewer uid -> name from the file's heading, for recognising a viewer mentioned by name. */
  private readonly viewerNames = new Map<number, string>()
  /** persona file -> its text, for `personaText()`. */
  private readonly persona = new Map<string, string>()

  constructor(opts: StoreOptions) {
    super()
    this.root = path.resolve(opts.root)
    this.now = opts.now ?? Date.now
    this.commitDelayMs = opts.commitDelayMs ?? 20_000
    this.log = opts.log ?? (() => {})
    this.watchEnabled = opts.watch !== false
    this.git = opts.git ?? new MemoryGit({ root: this.root })
  }

  // ─────────────────────────────── life cycle ───────────────────────────────

  async init(): Promise<void> {
    if (this.started) return
    this.started = true
    for (const s of SECTIONS) await mkdir(path.join(this.root, s), { recursive: true })
    if (await this.git.available()) {
      // raw stream events are not history
      await writeFile(path.join(this.root, '.gitignore'), 'inbox/\nviewers/\n', {
        flag: 'a',
      }).catch(() => {})
    } else {
      this.log(
        'warn',
        'git is not installed: memory works, but there is no history and no rollback'
      )
    }
    for (const entry of await this.walk()) await this.reindexFile(entry)
    if (this.watchEnabled) {
      this.startWatching()
      this.rescanTimer = setInterval(() => void this.rescan(), 60_000)
      this.rescanTimer.unref?.()
    }
  }

  async dispose(): Promise<void> {
    this.watcher?.close()
    this.watcher = null
    if (this.watchTimer) clearTimeout(this.watchTimer)
    if (this.rescanTimer) clearInterval(this.rescanTimer)
    this.rescanTimer = null
    if (this.commitTimer) clearTimeout(this.commitTimer)
    this.commitTimer = null
    await this.serial(async () => {
      await this.flushDirty()
      await this.flushCommits()
    })
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  // ─────────────────────────────── reading ───────────────────────────────

  private abs(file: string): string {
    return path.join(this.root, ...file.split('/'))
  }

  /** Every store file (relative, `/`), skipping the git folder and anything that is not a store path. */
  private async walk(): Promise<string[]> {
    const out: string[] = []
    const visit = async (rel: string, depth: number) => {
      let entries
      try {
        entries = await readdir(path.join(this.root, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (depth < 2 && SECTIONS.includes((rel ? rel.split('/')[0] : e.name) as Section))
            await visit(r, depth + 1)
        } else if (normalizePath(r)) out.push(r)
      }
    }
    await visit('', 0)
    return out
  }

  async tree(): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = []
    for (const file of await this.walk()) {
      const n = normalizePath(file)
      if (!n) continue
      try {
        const st = await stat(this.abs(file))
        const content =
          file.startsWith('inbox/') || file.startsWith('proposals/')
            ? ''
            : await readFile(this.abs(file), 'utf8')
        entries.push({
          path: file,
          section: n.section,
          bytes: st.size,
          facts: splitLines(content).filter((l) => parseLine(l).kind === 'fact').length,
          mtime: st.mtimeMs,
        })
      } catch {
        // gone while listing
      }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path))
  }

  async read(file: string): Promise<FileView | null> {
    const n = normalizePath(file)
    if (!n) return null
    let content: string
    try {
      content = await readFile(this.abs(n.path), 'utf8')
    } catch {
      return null
    }
    content = content.replace(/^﻿/, '')
    return {
      path: n.path,
      content,
      hash: hashOf(content),
      lines: splitLines(content).map(parseLine),
    }
  }

  // ─────────────────────────────── the index ───────────────────────────────

  private async reindexFile(file: string): Promise<void> {
    const n = normalizePath(file)
    if (!n) return
    this.index.removePrefix(`${file}#`)
    if (n.section === 'proposals' || n.section === 'inbox') return
    let content: string
    try {
      content = (await readFile(this.abs(file), 'utf8')).replace(/^﻿/, '')
    } catch {
      this.dropFile(file, n.section)
      return
    }
    this.known.set(file, hashOf(content))
    this.indexContent(file, n.section, content)
  }

  /** Forget everything the store holds in memory about a file that is gone. */
  private dropFile(file: string, section: Section): void {
    this.index.removePrefix(`${file}#`)
    this.known.delete(file)
    this.persona.delete(file)
    if (section === 'viewers') this.forgetName(file)
  }

  /**
   * The persona files of the memory folder as one text, for the brain to add to the persona: rules and notes the
   * streamer keeps in `persona/`, in file order. Kept in memory, so a change made in the console or by hand is in
   * the very next prompt.
   */
  personaText(): string {
    return [...this.persona.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, text]) => text.trim())
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 64_000)
  }

  private indexContent(file: string, section: Section, content: string): void {
    if (section === 'persona') this.persona.set(file, content)
    this.index.removePrefix(`${file}#`)
    const lines = splitLines(content)
    if (section === 'viewers') {
      const m = /^#\s+(.+?)\s+\(uid (\d+)\)\s*$/.exec(lines[0] ?? '')
      const uid = Number(/^viewers\/(\d+)\.md$/.exec(file)?.[1])
      if (m && Number.isFinite(uid)) this.viewerNames.set(uid, m[1] as string)
    }
    lines.forEach((raw, lineNo) => {
      const line = parseLine(raw)
      if (line.kind === 'note' && (line.text.trim() === '' || line.text.startsWith('#'))) return
      const text = line.kind === 'fact' ? line.text : line.text
      this.index.add({
        id: `${file}#${lineNo}`,
        meta: { file, section: section, lineNo, line },
        text,
      })
    })
  }

  private forgetName(file: string): void {
    const uid = Number(/^viewers\/(\d+)\.md$/.exec(file)?.[1])
    if (Number.isFinite(uid)) this.viewerNames.delete(uid)
  }

  /** The index, for the recall code: only lines of the recalled sections. */
  searchLines(query: string, limit: number, accept?: (m: LineMeta) => boolean) {
    return this.index.search(
      query,
      limit,
      (m) => RECALLED.includes(m.section) && (accept ? accept(m) : true)
    )
  }

  /** Lines of one file, from the index (no disk access). */
  linesOf(file: string): LineMeta[] {
    return this.index
      .all()
      .filter((d) => d.meta.file === file)
      .map((d) => d.meta)
      .sort((a, b) => a.lineNo - b.lineNo)
  }

  /** Viewer uids whose recorded name occurs in `text` (at least two characters). */
  viewersNamedIn(text: string): number[] {
    const out: number[] = []
    for (const [uid, name] of this.viewerNames)
      if ([...name].length >= 2 && text.includes(name)) out.push(uid)
    return out
  }

  viewerName(uid: number): string | undefined {
    return this.viewerNames.get(uid)
  }

  // ─────────────────────────────── permission rules ───────────────────────────────

  /** May this author touch this file at all? */
  private mayWrite(author: Author, section: Section): string | null {
    if (author === 'human') return null
    if (section === 'persona')
      return 'only the streamer changes the persona; the program can leave a proposal'
    if (section === 'inbox') return author === 'system' || author === 'agent' ? null : 'not allowed'
    if (section === 'proposals')
      return author === 'agent' || author === 'system' ? null : 'not allowed'
    return null
  }

  /**
   * Whether replacing `oldLines` by `newLines` keeps what this author has no right to remove: the program never
   * loses a human line (locked or not) and never a viewer line; the system may drop viewer and agent lines (expiry,
   * forgetting) but not a human one.
   */
  private preserved(
    author: Author,
    oldLines: readonly string[],
    newLines: readonly string[]
  ): FailureCode | null {
    if (author === 'human') return null
    const remaining = new Map<string, number>()
    for (const l of newLines) remaining.set(l, (remaining.get(l) ?? 0) + 1)
    for (const l of oldLines) {
      const p = parseLine(l)
      const protectedLine =
        p.kind === 'note'
          ? l.trim() !== ''
          : p.source === 'human' || (author === 'agent' && p.source === 'viewer')
      if (!protectedLine) continue
      const n = remaining.get(l) ?? 0
      if (n === 0) return p.kind === 'fact' && p.locked ? 'locked' : 'human_wins'
      remaining.set(l, n - 1)
    }
    return null
  }

  // ─────────────────────────────── writing ───────────────────────────────

  private async put(
    file: string,
    content: string,
    author: Author,
    verb: string,
    after = ''
  ): Promise<string> {
    const target = this.abs(file)
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, target)
    const hash = hashOf(content)
    this.known.set(file, hash)
    const n = normalizePath(file)
    if (n) this.indexContent(file, n.section, content)
    this.scheduleCommit(author, file, `${author}: ${verb} ${file}${after}`)
    // the streamer's edit is history by the time the call returns (the program's are batched)
    if (author === 'human') await this.flushCommits()
    this.emit('change', file, author)
    return hash
  }

  private scheduleCommit(author: Author, file: string, message: string): void {
    if (file.startsWith('inbox/') || file.startsWith('viewers/')) return // never in the history
    if (!this.pending.has(author)) this.pending.set(author, new Set())
    this.pending.get(author)?.add(file)
    const messages = this.pendingMessages.get(author) ?? []
    messages.push(message)
    this.pendingMessages.set(author, messages)
    if (author === 'human') {
      // the streamer's edits are history at once
      void this.serial(() => this.flushCommits())
      return
    }
    if (!this.commitTimer) {
      this.commitTimer = setTimeout(() => {
        this.commitTimer = null
        void this.serial(() => this.flushCommits())
      }, this.commitDelayMs)
      this.commitTimer.unref?.()
    }
  }

  /** Commit what is waiting, one commit per author. */
  private async flushCommits(): Promise<void> {
    for (const [author, files] of [...this.pending]) {
      const paths = [...files]
      const messages = this.pendingMessages.get(author) ?? []
      this.pending.delete(author)
      this.pendingMessages.delete(author)
      const subject =
        messages.length <= 1
          ? (messages[0] ?? `${author}: change`)
          : `${author}: ${messages.length} changes (${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', ...' : ''})`
      await this.git.commit(paths, subject, author)
    }
  }

  /** Write a whole file. `expectedHash` is the hash of the version this content is based on (omit only for a new file). */
  write(
    file: string,
    content: string,
    opts: { author: Author; expectedHash?: string }
  ): Promise<Outcome<{ hash: string }>> {
    return this.serial(async () => {
      const n = normalizePath(file)
      if (!n) return fail('bad_path', `"${file}" is not a memory file`)
      const denied = this.mayWrite(opts.author, n.section)
      if (denied) return fail('forbidden', denied)
      if (Buffer.byteLength(content) > MAX_FILE_BYTES)
        return fail('too_big', 'the file would be larger than 256 KB')
      const old = await this.read(n.path)
      if (old) {
        if (opts.expectedHash !== undefined && opts.expectedHash !== old.hash)
          return fail(
            'conflict',
            'the file changed since it was read; read it again and redo the change'
          )
      } else if (opts.expectedHash !== undefined) {
        return fail('conflict', 'the file no longer exists')
      }
      const lost = old
        ? this.preserved(opts.author, splitLines(old.content), splitLines(content))
        : null
      if (lost)
        return fail(
          lost,
          lost === 'locked'
            ? 'a locked line cannot be changed or removed by the program'
            : 'the program cannot change or remove what the streamer or a viewer wrote'
        )
      if (old && old.content === content) return { ok: true, hash: old.hash }
      const hash = await this.put(n.path, content, opts.author, old ? 'edit' : 'create')
      return { ok: true, hash }
    })
  }

  /**
   * Add one fact to a file (created with `header` if it does not exist). The source must fit the author: the streamer
   * writes `human`, the consolidation `agent`, the program's own bookkeeping `viewer` or `agent`. A fact the file
   * already has (same words, whatever the source) is not added twice.
   */
  append(
    file: string,
    fact: { source: Source; text: string; date?: string; locked?: boolean },
    opts: { author: Author; header?: string }
  ): Promise<Outcome<{ duplicate: boolean }>> {
    return this.serial(async () => {
      const n = normalizePath(file)
      if (!n) return fail('bad_path', `"${file}" is not a memory file`)
      if (n.section === 'inbox' || n.section === 'proposals')
        return fail('forbidden', 'facts go to the other sections')
      const denied = this.mayWrite(opts.author, n.section)
      if (denied) return fail('forbidden', denied)
      const allowed: Record<Author, readonly Source[]> = {
        human: ['human'],
        agent: ['agent'],
        system: ['viewer', 'agent'],
      }
      if (!allowed[opts.author].includes(fact.source))
        return fail('forbidden', `${opts.author} cannot write ${fact.source} lines`)
      const text = cleanFactText(fact.text, 400)
      if (text === '') return fail('bad_line', 'an empty fact')
      const old = await this.read(n.path)
      const oldLines = old ? splitLines(old.content) : opts.header ? [opts.header] : []
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
      for (const l of oldLines) {
        const p = parseLine(l)
        if (p.kind === 'fact' && norm(p.text) === norm(text)) return { ok: true, duplicate: true }
      }
      if (oldLines.filter((l) => parseLine(l).kind === 'fact').length >= MAX_FACT_LINES_PER_FILE)
        return fail('too_big', 'the file already holds as many facts as it may')
      const line = formatFact({
        source: fact.source,
        locked: fact.locked === true && fact.source === 'human',
        date: fact.date ?? todayString(this.now()),
        text,
      })
      const content = joinLines([...oldLines, line])
      if (Buffer.byteLength(content) > MAX_FILE_BYTES)
        return fail('too_big', 'the file would be larger than 256 KB')
      await this.put(n.path, content, opts.author, old ? 'add a fact to' : 'create')
      return { ok: true, duplicate: false }
    })
  }

  /** A viewer's file: the path, and the heading a new file starts with. */
  viewerFile(uid: number, name: string): { path: string; header: string } {
    const safe = cleanFactText(name, 40).replace(/[()]/g, '')
    return { path: `viewers/${uid}.md`, header: `# ${safe || 'viewer'} (uid ${uid})` }
  }

  /**
   * Change or remove one line of a file. `index` and `expectText` say which line, as it was when the caller read it;
   * a line that is no longer there is a conflict. `replacement` null removes the line.
   */
  editLine(
    file: string,
    edit: { index: number; expectText: string; replacement: string | null },
    opts: { author: Author }
  ): Promise<Outcome<{ hash: string }>> {
    return this.serial(async () => {
      const n = normalizePath(file)
      if (!n) return fail('bad_path', `"${file}" is not a memory file`)
      const denied = this.mayWrite(opts.author, n.section)
      if (denied) return fail('forbidden', denied)
      const old = await this.read(n.path)
      if (!old) return fail('not_found', 'no such file')
      const lines = splitLines(old.content)
      if (lines[edit.index] !== edit.expectText)
        return fail('conflict', 'that line has changed since it was read; read the file again')
      const p = parseLine(edit.expectText)
      if (opts.author !== 'human') {
        if (p.kind === 'fact' && p.locked)
          return fail('locked', 'a locked line cannot be changed or removed by the program')
        const mine =
          p.kind === 'fact' &&
          (p.source === 'agent' || (opts.author === 'system' && p.source === 'viewer'))
        if (!mine)
          return fail(
            'human_wins',
            'the program cannot change or remove what the streamer or a viewer wrote'
          )
        if (edit.replacement !== null) {
          const r = parseLine(edit.replacement)
          if (
            r.kind !== 'fact' ||
            (r.source === 'human' && true) ||
            TRUST[r.source] > TRUST[p.source]
          )
            return fail(
              'forbidden',
              'a replacement cannot claim more trust than the line it replaces'
            )
        }
      }
      if (edit.replacement !== null && /[\r\n]/.test(edit.replacement))
        return fail('bad_line', 'a line is one line')
      const next = [...lines]
      if (edit.replacement === null) next.splice(edit.index, 1)
      else next[edit.index] = edit.replacement.replace(/^﻿/, '')
      const hash = await this.put(
        n.path,
        joinLines(next),
        opts.author,
        edit.replacement === null ? 'remove a line of' : 'edit a line of'
      )
      return { ok: true, hash }
    })
  }

  /** Lock or unlock a human line (only the streamer can). */
  setLocked(
    file: string,
    index: number,
    expectText: string,
    locked: boolean
  ): Promise<Outcome<{ hash: string }>> {
    return this.serial(async () => {
      const n = normalizePath(file)
      if (!n) return fail('bad_path', `"${file}" is not a memory file`)
      const old = await this.read(n.path)
      if (!old) return fail('not_found', 'no such file')
      const lines = splitLines(old.content)
      if (lines[index] !== expectText)
        return fail('conflict', 'that line has changed since it was read')
      const p = parseLine(expectText)
      if (p.kind !== 'fact' || p.source !== 'human')
        return fail('bad_line', 'only a line the streamer wrote can be locked')
      lines[index] = formatFact({ ...p, locked })
      const hash = await this.put(
        n.path,
        joinLines(lines),
        'human',
        locked ? 'lock a line of' : 'unlock a line of'
      )
      return { ok: true, hash }
    })
  }

  // ─────────────────────────────── forgetting ───────────────────────────────

  /**
   * Delete a viewer's file. This is what "forget me" does; the file was never in the history, so nothing is left.
   */
  forgetViewer(uid: number): Promise<Outcome<{ existed: boolean }>> {
    return this.serial(async () => {
      if (!Number.isSafeInteger(uid) || uid <= 0) return fail('bad_path', 'not a viewer id')
      const file = `viewers/${uid}.md`
      let existed = true
      try {
        await rm(this.abs(file))
      } catch {
        existed = false
      }
      this.index.removePrefix(`${file}#`)
      this.forgetName(file)
      this.known.delete(file)
      this.emit('change', file, 'system')
      return { ok: true, existed }
    })
  }

  // ─────────────────────────────── history ───────────────────────────────

  history(file: string | null, limit = 50): Promise<Commit[]> {
    if (file !== null && (!normalizePath(file) || file.startsWith('viewers/')))
      return Promise.resolve([])
    return this.serial(async () => {
      await this.flushCommits()
      return this.git.log(file, limit)
    })
  }

  diff(file: string, from: string, to?: string): Promise<string | null> {
    if (!normalizePath(file)) return Promise.resolve(null)
    return this.serial(async () => {
      await this.flushCommits()
      return this.git.diff(file, from, to)
    })
  }

  /** Put a file back as it was in a commit. It is a new commit, so the history stays whole. */
  rollback(file: string, rev: string): Promise<Outcome<{ hash: string | null }>> {
    return this.serial(async () => {
      const n = normalizePath(file)
      if (!n) return fail('bad_path', `"${file}" is not a memory file`)
      if (n.section === 'viewers' || n.section === 'inbox')
        return fail(
          'not_found',
          'these files are not versioned, so there is nothing to roll back to'
        )
      await this.flushCommits()
      if (!(await this.git.available()))
        return fail('not_found', 'there is no history (git is not installed)')
      // an unknown revision must not be mistaken for "the file did not exist then", which removes it
      if (!(await this.git.hasCommit(rev))) return fail('not_found', 'there is no such version')
      const before = await this.git.show(rev, n.path)
      if (before === null) {
        // it did not exist then: rolling back removes it
        await rm(this.abs(n.path), { force: true })
        this.dropFile(n.path, n.section)
        this.scheduleCommit('human', n.path, `human: roll back ${n.path} to before it existed`)
        this.emit('change', n.path, 'human')
        return { ok: true, hash: null }
      }
      const hash = await this.put(n.path, before, 'human', 'roll back', ` to ${rev.slice(0, 7)}`)
      return { ok: true, hash }
    })
  }

  // ─────────────────────────────── the inbox ───────────────────────────────

  /** Append one raw event of the running stream (one JSON line, in today's file). Never part of the history. */
  appendInbox(event: Record<string, unknown>): Promise<void> {
    return this.serial(async () => {
      const file = `inbox/${todayString(this.now())}.jsonl`
      const line = JSON.stringify({ ts: this.now(), ...event })
      if (line.length > 4000) return
      try {
        await appendFile(this.abs(file), `${line}\n`, 'utf8')
      } catch (e) {
        this.log('warn', `inbox could not be written: ${(e as Error).message.split('\n')[0]}`)
      }
    })
  }

  /** Inbox files, oldest first. */
  async inboxFiles(): Promise<string[]> {
    try {
      return (await readdir(this.abs('inbox')))
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .map((f) => `inbox/${f}`)
    } catch {
      return []
    }
  }

  async readInbox(file: string): Promise<Record<string, unknown>[]> {
    const n = normalizePath(file)
    if (!n || n.section !== 'inbox') return []
    try {
      return (await readFile(this.abs(n.path), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>]
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }

  /** Move a processed inbox file out of the way (kept for a while, then it is the operator's to delete). */
  archiveInbox(file: string): Promise<void> {
    return this.serial(async () => {
      const n = normalizePath(file)
      if (!n || n.section !== 'inbox') return
      const target = this.abs(`inbox/${path.basename(n.path)}.done`)
      await rename(this.abs(n.path), target).catch(() => {})
    })
  }

  // ─────────────────────────────── proposals ───────────────────────────────

  /** The program asks for a change it may not make itself; the streamer approves or refuses it in the console. */
  propose(target: string, content: string, reason: string): Promise<Outcome<{ id: string }>> {
    return this.serial(async () => {
      const n = normalizePath(target)
      if (!n) return fail('bad_path', `"${target}" is not a memory file`)
      const id = `${this.now()}-${hashOf(`${target}${content}`).slice(0, 6)}`
      const body = JSON.stringify(
        { id, target: n.path, reason: cleanFactText(reason, 300), content, at: this.now() },
        null,
        2
      )
      if (Buffer.byteLength(body) > MAX_FILE_BYTES)
        return fail('too_big', 'the proposal is too large')
      const file = `proposals/${id}.json`
      await writeFile(this.abs(file), body, 'utf8')
      this.scheduleCommit('agent', file, `agent: propose a change to ${n.path}`)
      this.emit('change', file, 'agent')
      return { ok: true, id }
    })
  }

  async proposals(): Promise<
    { id: string; target: string; reason: string; content: string; at: number }[]
  > {
    let names: string[] = []
    try {
      names = (await readdir(this.abs('proposals'))).filter((f) => f.endsWith('.json')).sort()
    } catch {
      return []
    }
    const out: { id: string; target: string; reason: string; content: string; at: number }[] = []
    for (const f of names) {
      try {
        const p = JSON.parse(await readFile(this.abs(`proposals/${f}`), 'utf8')) as {
          id: string
          target: string
          reason: string
          content: string
          at: number
        }
        if (
          typeof p.id === 'string' &&
          typeof p.target === 'string' &&
          typeof p.content === 'string'
        )
          out.push(p)
      } catch {
        // a torn proposal is left alone
      }
    }
    return out
  }

  /** Approving writes the proposed text as the streamer's edit and removes the proposal. */
  approveProposal(id: string): Promise<Outcome<{ hash: string }>> {
    return this.resolveProposal(id, true)
  }

  rejectProposal(id: string): Promise<Outcome<{ hash: string }>> {
    return this.resolveProposal(id, false)
  }

  private async resolveProposal(id: string, approve: boolean): Promise<Outcome<{ hash: string }>> {
    const p = (await this.proposals()).find((x) => x.id === id)
    if (!p) return fail('not_found', 'no such proposal')
    let hash = ''
    if (approve) {
      const r = await this.write(p.target, p.content, { author: 'human' })
      if (!r.ok) return r
      hash = r.hash
    }
    return this.serial(async () => {
      const file = `proposals/${p.id}.json`
      await rm(this.abs(file), { force: true })
      this.scheduleCommit(
        'human',
        file,
        `human: ${approve ? 'approve' : 'reject'} the proposal for ${p.target}`
      )
      this.emit('change', file, 'human')
      return { ok: true, hash }
    })
  }

  // ─────────────────────────────── edits made by hand ───────────────────────────────

  private startWatching(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
        if (!name) return
        const rel = String(name).replace(/\\/g, '/')
        if (rel.startsWith('.git') || rel.endsWith('.tmp') || rel.startsWith('inbox/')) return
        this.dirty.add(rel)
        if (this.watchTimer) clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => void this.serial(() => this.flushDirty()), 250)
        this.watchTimer.unref?.()
      })
      this.watcher.on('error', () => {})
    } catch (e) {
      this.log(
        'warn',
        `memory folder cannot be watched (${(e as Error).message}); edits by hand show up after a restart`
      )
    }
  }

  /** Files that changed on disk without the store's doing: index them and record them as the streamer's edits. */
  private async flushDirty(): Promise<void> {
    const files = [...this.dirty]
    this.dirty.clear()
    for (const rel of files) {
      const n = normalizePath(rel)
      if (!n) continue
      let content: string | null = null
      try {
        content = (await readFile(this.abs(n.path), 'utf8')).replace(/^﻿/, '')
      } catch {
        content = null
      }
      if (content !== null && this.known.get(n.path) === hashOf(content)) continue // our own write
      if (content === null && !this.known.has(n.path)) continue
      if (content === null) {
        this.dropFile(n.path, n.section)
      } else {
        this.known.set(n.path, hashOf(content))
        if (n.section !== 'proposals' && n.section !== 'inbox')
          this.indexContent(n.path, n.section, content)
      }
      this.scheduleCommit('human', n.path, `human: edit ${n.path} by hand`)
      this.emit('change', n.path, 'human')
    }
  }

  /**
   * Look at every file now: pick up what was changed by hand (whether or not the watcher noticed), and commit it as the
   * streamer's. Runs every minute as a safety net, and is what a test calls to see an edit by hand.
   */
  async rescan(): Promise<void> {
    await this.serial(async () => {
      const files = new Set(await this.walk())
      for (const f of files) if (!f.startsWith('inbox/')) this.dirty.add(f)
      for (const f of this.known.keys()) if (!files.has(f)) this.dirty.add(f)
      await this.flushDirty()
      await this.flushCommits()
    })
  }

  /** The fact lines of a file as parsed lines (a convenience for callers that know the file). */
  async facts(file: string): Promise<FactLine[]> {
    const v = await this.read(file)
    return (v?.lines ?? []).filter((l): l is FactLine => l.kind === 'fact')
  }
}
