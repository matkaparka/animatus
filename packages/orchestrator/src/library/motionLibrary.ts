/**
 * Motion library scanner.
 *
 * A motions folder is scanned with this layout (the layout of the previous live setup's public
 * folder, so it can be pointed at as is; other sub-folders are ignored):
 *
 *   <root>/idle_loop.vrma            default idle base pose (optional)
 *   <root>/idle/*.vrma               extra idle variants
 *   <root>/talk/*.vrma               clips rotated while speaking
 *   <root>/poses/<tag>.vrma          one-shot body motions by tag; <tag>_2.vrma, <tag>_3.vrma ... are variants
 *   <root>/dance/<name>/{motion.vrma, music.(ogg|mp3|wav), meta.json}
 *
 * Every clip becomes a `ClipRef` whose URL is served by the asset route (`/asset/<library>/...`).
 * Files the asset route would refuse (unsafe names) or that do not fit the protocol are left out and
 * listed in `skipped` instead of failing the scan.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'
import { ClipRef, DancePlay, LibrarySet } from '@animatus/protocol'
import { isSafeSegment } from '../stage/assets.ts'
import { noopLogger } from '../stage/logger.ts'
import { stripBom } from '../stage/util.ts'
import type { Logger } from '../stage/logger.ts'

export type { ClipRef }

export interface DanceMeta {
  title: string
  offset: number
  bpm: number
  speed: number
  volume: number
  credit: string
  enabled: boolean
}

export interface DanceInfo {
  /** Folder name. */
  name: string
  /** Same as `meta.title`. */
  title: string
  motion: ClipRef
  music: ClipRef | null
  meta: DanceMeta
}

export interface SkippedFile {
  /** Path relative to the library root, with `/` separators. */
  path: string
  reason: string
}

export interface MotionLibraryScan {
  idle: ClipRef | null
  idleVariants: ClipRef[]
  talk: ClipRef[]
  /** Lowercase tag -> variants (sorted). Keys are sorted too. */
  tags: Map<string, ClipRef[]>
  dances: DanceInfo[]
  /** Clips that were found but could not be offered to the stage. */
  skipped: SkippedFile[]
  scannedAt: number
}

/** Protocol limits of `library.set`. */
export const MAX_IDLE_VARIANTS = 64
export const MAX_TALK_CLIPS = 256

const MUSIC_FILES = ['music.ogg', 'music.mp3', 'music.wav']
const MAX_META_BYTES = 256 * 1024

// ───────────────────────────── helpers ─────────────────────────────

/** Natural, case-insensitive, locale-independent order: `nod`, `nod_2`, `nod_10`. */
export function naturalCompare(a: string, b: string): number {
  const ax = a.toLowerCase().match(/\d+|\D+/g) ?? []
  const bx = b.toLowerCase().match(/\d+|\D+/g) ?? []
  const n = Math.min(ax.length, bx.length)
  for (let i = 0; i < n; i++) {
    const x = ax[i] ?? ''
    const y = bx[i] ?? ''
    if (x === y) continue
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const diff = BigInt(x) - BigInt(y)
      if (diff !== 0n) return diff < 0n ? -1 : 1
      if (x.length !== y.length) return x.length - y.length
      continue
    }
    return x < y ? -1 : 1
  }
  if (ax.length !== bx.length) return ax.length - bx.length
  return a < b ? -1 : a > b ? 1 : 0
}

const isMissing = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Entry names of a directory; a missing directory is simply empty. */
async function readNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (err) {
    if (isMissing(err)) return []
    throw err
  }
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** Exact match first, then case-insensitive (Windows folders are case-insensitive anyway). */
const findName = (names: readonly string[], wanted: string): string | undefined =>
  names.includes(wanted) ? wanted : names.find((n) => n.toLowerCase() === wanted)

const stripVrma = (file: string): string => file.replace(/\.vrma$/i, '')

/** Tag of a pose file: lowercase stem without a trailing `_<digits>` (`Nod_2.vrma` -> `nod`). */
export function tagOfPoseFile(file: string): string {
  return stripVrma(file).toLowerCase().replace(/_\d+$/, '')
}

export function normalizeDanceMeta(raw: unknown, folderName: string): DanceMeta {
  const m =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  return {
    title: typeof m.title === 'string' ? m.title : folderName,
    offset: num(m.offset) ? m.offset : 0,
    bpm: num(m.bpm) ? m.bpm : 0,
    speed: num(m.speed) && m.speed > 0 ? m.speed : 1,
    volume: num(m.volume) ? Math.max(0, m.volume) : 1,
    credit: typeof m.credit === 'string' ? m.credit : '',
    enabled: m.enabled !== false,
  }
}

async function readDanceMeta(file: string | undefined, folderName: string): Promise<DanceMeta> {
  let raw: unknown = null
  if (file) {
    try {
      if ((await stat(file)).size <= MAX_META_BYTES) {
        raw = JSON.parse(stripBom(await readFile(file, 'utf8')))
      }
    } catch {
      raw = null // invalid JSON or unreadable: fall back to defaults, never fail the scan
    }
  }
  return normalizeDanceMeta(raw, folderName)
}

// ───────────────────────────── scanning ─────────────────────────────

/**
 * Scans `root`. A missing root is an error (a configuration problem); missing sub-folders are just
 * empty. `libraryName` is the asset library the folder is served as.
 */
export async function scanMotionLibrary(
  root: string,
  libraryName = 'motions',
  opts: { now?: () => number } = {}
): Promise<MotionLibraryScan> {
  if (!isSafeSegment(libraryName))
    throw new Error(`invalid library name: ${JSON.stringify(libraryName)}`)
  if (!(await isDirectory(root))) throw new Error(`motion library folder not found: ${root}`)

  const skipped: SkippedFile[] = []
  const usedIds = new Set<string>()

  /** Builds a ClipRef for `parts` (folder names + file name) or records why it cannot be offered. */
  function makeClip(parts: string[], idParts: string[] = parts): ClipRef | null {
    const rel = parts.join('/')
    if (!parts.every(isSafeSegment)) {
      skipped.push({ path: rel, reason: 'the file name is not safe to serve (see isSafeSegment)' })
      return null
    }
    // The id is derived from the relative path (`poses:nod_2`), so it is unique across the whole library.
    const raw = idParts.join(':').replace(/\.vrma$/i, '')
    const cleaned = raw.replace(/[^A-Za-z0-9._@:-]+/g, '_')
    let base = cleaned
    if (cleaned !== raw || cleaned.length === 0 || cleaned.length > 96) {
      // Not representable as a protocol Id as is: keep it readable and unique with a short hash.
      const hash = createHash('sha1').update(rel).digest('hex').slice(0, 6)
      base = `${cleaned.slice(0, 89)}-${hash}`
    }
    let id = base
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`
    const url = `/asset/${encodeURIComponent(libraryName)}/${parts.map(encodeURIComponent).join('/')}`
    const parsed = ClipRef.safeParse({ id, url })
    if (!parsed.success) {
      skipped.push({
        path: rel,
        reason: parsed.error.issues[0]?.message ?? 'not a valid clip reference',
      })
      return null
    }
    usedIds.add(id)
    return parsed.data
  }

  /** `.vrma` files of `<root>/<sub>` in natural order, with their names. */
  async function clipsIn(sub: string): Promise<{ file: string; clip: ClipRef }[]> {
    const dir = path.join(root, sub)
    const out: { file: string; clip: ClipRef }[] = []
    const names = (await readNames(dir)).filter((n) => /\.vrma$/i.test(n)).sort(naturalCompare)
    for (const file of names) {
      if (!(await isRegularFile(path.join(dir, file)))) continue
      const clip = makeClip([sub, file])
      if (clip) out.push({ file, clip })
    }
    return out
  }

  // idle_loop.vrma at the root
  let idle: ClipRef | null = null
  const idleFile = findName(await readNames(root), 'idle_loop.vrma')
  if (idleFile && (await isRegularFile(path.join(root, idleFile)))) idle = makeClip([idleFile])

  const idleVariants = (await clipsIn('idle')).map((c) => c.clip)
  const talk = (await clipsIn('talk')).map((c) => c.clip)

  const tagged = new Map<string, ClipRef[]>()
  for (const { file, clip } of await clipsIn('poses')) {
    const tag = tagOfPoseFile(file)
    if (tag === '') {
      skipped.push({
        path: `poses/${file}`,
        reason: 'the file name has no tag left after removing the _<number> suffix',
      })
      continue
    }
    const list = tagged.get(tag)
    if (list) list.push(clip)
    else tagged.set(tag, [clip])
  }
  const tags = new Map([...tagged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

  const dances = await scanDances(root, makeClip, skipped)

  return { idle, idleVariants, talk, tags, dances, skipped, scannedAt: (opts.now ?? Date.now)() }
}

async function scanDances(
  root: string,
  makeClip: (parts: string[], idParts?: string[]) => ClipRef | null,
  skipped: SkippedFile[]
): Promise<DanceInfo[]> {
  const danceRoot = path.join(root, 'dance')
  const out: DanceInfo[] = []
  for (const name of (await readNames(danceRoot)).sort(naturalCompare)) {
    const dir = path.join(danceRoot, name)
    if (!(await isDirectory(dir))) continue
    const files = await readNames(dir)
    const motionFile = findName(files, 'motion.vrma')
    if (!motionFile || !(await isRegularFile(path.join(dir, motionFile)))) continue // not a dance folder
    if (!isSafeSegment(name)) {
      skipped.push({
        path: `dance/${name}`,
        reason: 'the folder name is not safe to serve (see isSafeSegment)',
      })
      continue
    }
    const motion = makeClip(['dance', name, motionFile], ['dance', name, 'motion'])
    if (!motion) continue
    let music: ClipRef | null = null
    for (const wanted of MUSIC_FILES) {
      const file = findName(files, wanted)
      if (file && (await isRegularFile(path.join(dir, file)))) {
        music = makeClip(['dance', name, file], ['dance', name, 'music'])
        break
      }
    }
    const metaFile = findName(files, 'meta.json')
    const meta = await readDanceMeta(metaFile ? path.join(dir, metaFile) : undefined, name)
    out.push({ name, title: meta.title, motion, music, meta })
  }
  return out
}

// ───────────────────────────── using a scan ─────────────────────────────

/**
 * Picks a clip for a motion tag (case-insensitive). Unknown tag -> null. With several variants it is
 * random but avoids the previous pick for that tag when `last` (tag -> clip id) is given; `last` is
 * updated. Port of the previous behaviour: pick random, and if it equals the last pick advance to the next.
 */
export function pickTagClip(
  lib: Pick<MotionLibraryScan, 'tags'>,
  tag: string,
  last?: Map<string, string>,
  random: () => number = Math.random
): ClipRef | null {
  const key = tag.trim().toLowerCase()
  const variants = lib.tags.get(key)
  if (!variants || variants.length === 0) return null
  const r = random()
  let index = Number.isFinite(r)
    ? Math.min(variants.length - 1, Math.max(0, Math.floor(r * variants.length)))
    : 0
  if (variants.length > 1 && variants[index]?.id === last?.get(key))
    index = (index + 1) % variants.length
  const pick = variants[index]
  if (!pick) return null
  last?.set(key, pick.id)
  return pick
}

/** A valid `library.set` message for `hub.setLibrary`. Lists longer than the protocol allows are cut (sorted order). */
export function toLibrarySet(lib: MotionLibraryScan): z.output<typeof LibrarySet> {
  return LibrarySet.parse({
    type: 'library.set',
    idle: lib.idle,
    idle_variants: lib.idleVariants.slice(0, MAX_IDLE_VARIANTS),
    talk: lib.talk.slice(0, MAX_TALK_CLIPS),
  })
}

/** Tag names for the LLM prompt, sorted. */
export function promptTagList(lib: Pick<MotionLibraryScan, 'tags'>): string[] {
  return [...lib.tags.keys()].sort()
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** A `dance.play` message for a scanned dance. Values are clamped to the protocol ranges. */
export function toDancePlay(dance: DanceInfo, danceId: string): z.output<typeof DancePlay> {
  return DancePlay.parse({
    type: 'dance.play',
    dance_id: danceId,
    name: dance.name.slice(0, 80),
    title: dance.meta.title.slice(0, 120),
    motion_url: dance.motion.url,
    music_url: dance.music?.url ?? null,
    offset: clamp(dance.meta.offset, -30, 30),
    speed: clamp(dance.meta.speed, 0.25, 3),
    volume: clamp(dance.meta.volume, 0, 2),
    credit: dance.meta.credit.slice(0, 200),
  })
}

// ───────────────────────────── the live library ─────────────────────────────

export interface MotionLibraryOptions {
  /** Asset library name the folder is served as. Default 'motions'. */
  libraryName?: string
  /** A non-forced refresh rescans at most this often. Default 15 s. */
  minRefreshMs?: number
  now?: () => number
  logger?: Logger
}

/** A scanned library that can be refreshed (folders change while the program runs). */
export class MotionLibrary {
  readonly root: string
  readonly libraryName: string
  private readonly minRefreshMs: number
  private readonly now: () => number
  private readonly log: Logger
  private scan: MotionLibraryScan | null = null
  private inflight: Promise<MotionLibraryScan> | null = null
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private readonly lastPicks = new Map<string, string>()

  constructor(root: string, options: MotionLibraryOptions = {}) {
    this.root = root
    this.libraryName = options.libraryName ?? 'motions'
    this.minRefreshMs = options.minRefreshMs ?? 15_000
    this.now = options.now ?? Date.now
    this.log = options.logger ?? noopLogger
  }

  /** The last successful scan, or null before the first refresh. */
  get current(): MotionLibraryScan | null {
    return this.scan
  }

  /**
   * Rescans unless a scan was started less than `minRefreshMs` ago (or `force`). Concurrent calls share
   * one scan. When a rescan fails the previous scan is kept and the error logged; the very first scan
   * throws.
   */
  refresh(force = false): Promise<MotionLibraryScan> {
    if (this.inflight) return this.inflight
    if (!force && this.scan && this.now() - this.lastAttemptAt < this.minRefreshMs)
      return Promise.resolve(this.scan)
    this.lastAttemptAt = this.now()
    this.inflight = (async () => {
      try {
        const scan = await scanMotionLibrary(this.root, this.libraryName, { now: this.now })
        this.scan = scan
        if (scan.skipped.length > 0) {
          this.log('warn', 'some motion files were left out', {
            count: scan.skipped.length,
            first: scan.skipped[0],
          })
        }
        return scan
      } catch (err) {
        if (!this.scan) throw err
        this.log('warn', 'rescanning the motion library failed; keeping the previous scan', { err })
        return this.scan
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }

  /** Random clip for a tag (see `pickTagClip`), remembering the last pick per tag. */
  pick(tag: string, random?: () => number): ClipRef | null {
    return this.scan ? pickTagClip(this.scan, tag, this.lastPicks, random) : null
  }

  toLibrarySet(): z.output<typeof LibrarySet> {
    if (!this.scan) throw new Error('the motion library has not been scanned yet')
    return toLibrarySet(this.scan)
  }

  promptTagList(): string[] {
    return this.scan ? promptTagList(this.scan) : []
  }
}
