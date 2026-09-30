/**
 * The tracks of sleep mode: what is in the `asmr` library folder.
 *
 * The offline pipeline that makes a track writes `<name>.wav` / `<name>.mp3` and `<name>.json` (the words and the
 * second each is whispered at) into one folder. This module reads such a folder into a playlist and never fails on
 * one bad file: a file that cannot be played is left out, a timing file that cannot be read is left unused, and both
 * are reported (`skipped`, `notes`) instead of stopping the scan.
 *
 *   <root>/rain.mp3, rain.wav, rain.json    one track, "rain": of several formats the first of mp3, ogg, m4a, flac, wav
 *   <root>/night/ocean.ogg                  a track called "night/ocean" (folders down to three levels are read)
 *   <root>/_drafts/, <root>/.old/, _x.wav   ignored: a folder or file whose name starts with "_" or "."
 *
 * The timing file is JSON with `lines: [{ text, start, end }]` (seconds from the start of the track) and, optionally,
 * `duration_s`. Everything else in it is ignored, so the pipeline may keep adding fields.
 */
import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { SleepPlay } from '@animatus/protocol'
import { naturalCompare } from '../../library/motionLibrary.ts'
import { isSafeSegment } from '../../stage/assets.ts'
import { stripBom } from '../../stage/util.ts'

/** One line of a track's caption timeline, as `sleep.play` carries it. */
export type Caption = SleepPlay['captions'][number]

export interface TrackFile {
  /** Name without extension, `/` between folders: the row id in the console and what a console request names. */
  key: string
  /** What the operator sees; the same as the key. */
  title: string
  /** Folder names and the file name under the library folder, for `host.assetUrl('asmr', ...parts)`. */
  parts: string[]
  /** The extension of the file that was chosen (`.mp3`). */
  ext: string
  /** From the timing file, when it says. */
  durationS: number | null
  /** Sorted by start, every line valid for the stage. Empty when there is no usable timing file. */
  captions: Caption[]
  /** Problems with the timing file, for the console (the track plays without captions or with fewer). */
  notes: string[]
}

export interface SkippedTrack {
  /** Relative path with `/` separators. */
  path: string
  reason: string
}

export interface TrackScan {
  /** In natural order of their keys (`night_2` before `night_10`). */
  tracks: TrackFile[]
  skipped: SkippedTrack[]
}

/** Formats the stage's media element plays. Of several files with the same name the first of these is used: the smaller streams better. */
export const AUDIO_PREFERENCE = ['.mp3', '.ogg', '.m4a', '.flac', '.wav'] as const

/** Folders below the library folder that are looked into. */
export const MAX_DEPTH = 3
/** More than this many tracks are cut off (a folder with the wrong path in it), and that is reported. */
export const MAX_TRACKS = 500
/** The protocol's limits for one `sleep.play` (`captions` and the text of a line). */
export const MAX_CAPTIONS = 5000
export const MAX_CAPTION_CHARS = 2000
/** The console's row ids are at most 120 characters. */
export const MAX_KEY_CHARS = 120
const MAX_JSON_BYTES = 4 * 1024 * 1024

interface Group {
  dir: string[]
  stem: string
  /** Extension to file name. */
  audio: Map<string, string>
  meta?: string
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Everything a timing file may give us, checked: numbers are finite, times are in order, text fits the stage. */
export function readTiming(raw: unknown): {
  durationS: number | null
  captions: Caption[]
  notes: string[]
} {
  const notes: string[] = []
  if (!isObject(raw))
    return { durationS: null, captions: [], notes: ['the timing file is not a JSON object'] }
  const d = raw.duration_s
  const durationS = typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : null
  if (raw.lines === undefined) return { durationS, captions: [], notes }
  if (!Array.isArray(raw.lines))
    return { durationS, captions: [], notes: ['"lines" in the timing file is not a list'] }

  const good: Caption[] = []
  let ignored = 0
  for (const l of raw.lines as unknown[]) {
    const text = isObject(l) && typeof l.text === 'string' ? l.text.replace(/\s+/g, ' ').trim() : ''
    const start = isObject(l) ? l.start : undefined
    const end = isObject(l) ? l.end : undefined
    if (
      text === '' ||
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start
    ) {
      ignored++
      continue
    }
    good.push({ text: text.slice(0, MAX_CAPTION_CHARS), start, end })
  }
  // The stage shows the first line whose window contains the time, so the list has to be in order.
  good.sort((a, b) => a.start - b.start)
  if (good.length > MAX_CAPTIONS) {
    notes.push(`only the first ${MAX_CAPTIONS} lines of the timing file are used`)
    good.length = MAX_CAPTIONS
  }
  if (ignored > 0)
    notes.push(
      `${ignored} line(s) of the timing file were ignored (no text, or times that do not fit)`
    )
  return { durationS, captions: good, notes }
}

const compareNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Reads the folder. Rejects only when the folder itself cannot be read (with a message that says why); a problem with
 * a single file is in the result.
 */
export async function scanSleepTracks(root: string): Promise<TrackScan> {
  const skipped: SkippedTrack[] = []
  const groups = new Map<string, Group>()
  const groupOf = (dir: string[], stem: string): Group => {
    const key = [...dir, stem].join('/')
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { dir, stem, audio: new Map() }))
    return g
  }

  async function walk(dir: string[], depth: number): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(path.join(root, ...dir), { withFileTypes: true })
    } catch (e) {
      if (depth === 0) {
        const code = (e as NodeJS.ErrnoException).code
        throw new Error(
          code === 'ENOENT'
            ? 'the folder does not exist'
            : code === 'ENOTDIR'
              ? 'it is not a folder'
              : `the folder cannot be read (${code ?? (e as Error).message})`
        )
      }
      skipped.push({ path: dir.join('/'), reason: 'the folder cannot be read' })
      return
    }
    for (const entry of entries.sort((a, b) => compareNames(a.name, b.name))) {
      const name = entry.name
      if (name.startsWith('.') || name.startsWith('_')) continue
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const s = await stat(path.join(root, ...dir, name))
          isDir = s.isDirectory()
          isFile = s.isFile()
        } catch {
          continue // a link that leads nowhere
        }
      }
      if (isDir) {
        if (depth < MAX_DEPTH) await walk([...dir, name], depth + 1)
        else
          skipped.push({
            path: [...dir, name].join('/'),
            reason: `more than ${MAX_DEPTH} folders deep`,
          })
        continue
      }
      if (!isFile) continue
      const ext = path.extname(name).toLowerCase()
      const stem = name.slice(0, name.length - ext.length)
      if (ext === '.json') groupOf(dir, stem).meta = name
      else if ((AUDIO_PREFERENCE as readonly string[]).includes(ext))
        groupOf(dir, stem).audio.set(ext, name)
    }
  }
  await walk([], 0)

  const withAudio = [...groups.entries()]
    .filter(([, g]) => g.audio.size > 0)
    .sort(([a], [b]) => naturalCompare(a, b))

  const tracks: TrackFile[] = []
  let beyond = 0
  for (const [key, g] of withAudio) {
    if (tracks.length >= MAX_TRACKS) {
      beyond++ // not looked at: only counted
      continue
    }
    if (key.length > MAX_KEY_CHARS) {
      skipped.push({ path: key, reason: `the name is longer than ${MAX_KEY_CHARS} characters` })
      continue
    }
    if (!g.dir.every(isSafeSegment)) {
      skipped.push({ path: key, reason: 'a folder name is not safe to serve' })
      continue
    }
    // The first format that can be served: a file with an unsafe name or no content does not hide the others.
    let chosen: { ext: string; name: string } | null = null
    const why: string[] = []
    for (const ext of AUDIO_PREFERENCE) {
      const name = g.audio.get(ext)
      if (name === undefined) continue
      if (!isSafeSegment(name)) {
        why.push(`${name}: the file name is not safe to serve`)
        continue
      }
      const size = await stat(path.join(root, ...g.dir, name)).then(
        (s) => s.size,
        () => null
      )
      if (size === null) why.push(`${name}: the file cannot be read`)
      else if (size === 0) why.push(`${name}: the file is empty`)
      else {
        chosen = { ext, name }
        break
      }
    }
    if (!chosen) {
      skipped.push({ path: key, reason: why.join('; ') })
      continue
    }

    let timing: ReturnType<typeof readTiming> = { durationS: null, captions: [], notes: [] }
    if (g.meta !== undefined) {
      const file = path.join(root, ...g.dir, g.meta)
      try {
        if ((await stat(file)).size > MAX_JSON_BYTES)
          timing.notes.push(
            `the timing file is bigger than ${MAX_JSON_BYTES / 1024 / 1024} MiB and is not used`
          )
        else timing = readTiming(JSON.parse(stripBom(await readFile(file, 'utf8'))))
      } catch (e) {
        timing.notes.push(
          e instanceof SyntaxError
            ? 'the timing file is not valid JSON'
            : `the timing file could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`
        )
      }
    }
    tracks.push({
      key,
      title: key,
      parts: [...g.dir, chosen.name],
      ext: chosen.ext,
      durationS: timing.durationS,
      captions: timing.captions,
      notes: timing.notes,
    })
  }
  if (beyond > 0)
    skipped.push({
      path: '(the rest)',
      reason: `${beyond} track(s) beyond the first ${MAX_TRACKS} are ignored`,
    })
  return { tracks, skipped }
}
