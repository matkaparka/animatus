import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_CAPTIONS,
  MAX_CAPTION_CHARS,
  MAX_KEY_CHARS,
  MAX_TRACKS,
  readTiming,
  scanSleepTracks,
} from '../../src/modes/controllers/sleepTracks.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/** A library folder with these files (a few bytes each; a name ending in `/` makes an empty folder). */
async function library(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'animatus-asmr-'))
  dirs.push(root)
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, ...name.split('/'))
    if (name.endsWith('/')) await mkdir(full, { recursive: true })
    else {
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, content)
    }
  }
  return root
}

const timing = (lines: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'x', duration_s: 60, lines, ...extra })

describe('what is a track', () => {
  it('audio files in natural order; several formats of one name are one track and the smaller format wins', async () => {
    const root = await library({
      'night_10.wav': 'x',
      'night_2.wav': 'x',
      'rain.wav': 'xxxx',
      'rain.mp3': 'x',
      'rain.json': timing([]),
      'ocean.flac': 'x',
      'ocean.wav': 'x',
      'waves.ogg': 'x',
      'waves.m4a': 'x',
      'waves.wav': 'x',
    })
    const { tracks, skipped } = await scanSleepTracks(root)
    expect(tracks.map((t) => [t.key, t.ext])).toEqual([
      ['night_2', '.wav'],
      ['night_10', '.wav'],
      ['ocean', '.flac'],
      ['rain', '.mp3'],
      ['waves', '.ogg'],
    ])
    expect(tracks.find((t) => t.key === 'rain')!.parts).toEqual(['rain.mp3'])
    expect(skipped).toEqual([])
  })

  it('folders are read (three levels down), and a name that starts with "_" or "." is left alone, folder or file', async () => {
    const root = await library({
      'a.mp3': 'x',
      'night/b.mp3': 'x',
      'night/deep/c.mp3': 'x',
      'night/deep/deeper/d.mp3': 'x',
      'night/deep/deeper/deepest/e.mp3': 'x',
      '_drafts/f.mp3': 'x',
      '.old/g.mp3': 'x',
      '_h.mp3': 'x',
      '.i.mp3': 'x',
      'notes.txt': 'not audio',
      'only-timing.json': timing([]),
      'empty-folder/': '',
    })
    const { tracks, skipped } = await scanSleepTracks(root)
    expect(tracks.map((t) => t.key)).toEqual([
      'a',
      'night/b',
      'night/deep/c',
      'night/deep/deeper/d',
    ])
    expect(tracks.find((t) => t.key === 'night/deep/c')!.parts).toEqual(['night', 'deep', 'c.mp3'])
    expect(skipped).toEqual([
      { path: 'night/deep/deeper/deepest', reason: 'more than 3 folders deep' },
    ])
  })

  it('an empty file is left out with the reason, but does not hide another format of the same track', async () => {
    const root = await library({ 'a.mp3': '', 'a.wav': 'x', 'b.mp3': '', 'c.wav': 'x' })
    const { tracks, skipped } = await scanSleepTracks(root)
    expect(tracks.map((t) => [t.key, t.ext])).toEqual([
      ['a', '.wav'],
      ['c', '.wav'],
    ])
    expect(skipped).toEqual([{ path: 'b', reason: 'b.mp3: the file is empty' }])
  })

  it('a name too long for the console, and too many tracks, are left out and said so', async () => {
    const long = 'n'.repeat(MAX_KEY_CHARS + 1)
    const files: Record<string, string> = { [`${long}.mp3`]: 'x' }
    for (let i = 0; i < MAX_TRACKS + 1; i++) files[`t${String(i).padStart(4, '0')}.mp3`] = 'x'
    const root = await library(files)
    const { tracks, skipped } = await scanSleepTracks(root)
    expect(tracks).toHaveLength(MAX_TRACKS)
    expect(tracks[0]!.key).toBe('t0000')
    expect(skipped).toEqual([
      { path: long, reason: `the name is longer than ${MAX_KEY_CHARS} characters` },
      { path: '(the rest)', reason: `1 track(s) beyond the first ${MAX_TRACKS} are ignored` },
    ])
  })

  it('a folder that does not exist, or is a file, is an error that says so; an empty folder is just no tracks', async () => {
    const root = await library({ 'file.txt': 'x' })
    await expect(scanSleepTracks(path.join(root, 'nowhere'))).rejects.toThrow(
      'the folder does not exist'
    )
    await expect(scanSleepTracks(path.join(root, 'file.txt'))).rejects.toThrow(/folder/)
    const empty = await library({})
    expect(await scanSleepTracks(empty)).toEqual({ tracks: [], skipped: [] })
  })
})

describe('the timing file next to a track', () => {
  it('gives the captions in order, the length, and how many lines', async () => {
    const root = await library({
      'rain.mp3': 'x',
      'rain.json': timing([
        { n: 2, text: 'second', start: 6.5, end: 9 },
        { n: 1, text: '  first   line ', start: 1.5, end: 4 },
      ]),
    })
    const [t] = (await scanSleepTracks(root)).tracks
    expect(t!.durationS).toBe(60)
    expect(t!.captions).toEqual([
      { text: 'first line', start: 1.5, end: 4 },
      { text: 'second', start: 6.5, end: 9 },
    ])
    expect(t!.notes).toEqual([])
  })

  it('finds it next to the file in a folder, with a byte-order mark, and ignores every other field', async () => {
    const root = await library({
      'night/rain.ogg': 'x',
      'night/rain.json': `﻿${timing([{ text: 'a', start: 0, end: 1, lufs: -25 }], { peak_dbfs: -1.5 })}`,
    })
    const [t] = (await scanSleepTracks(root)).tracks
    expect(t!.captions).toEqual([{ text: 'a', start: 0, end: 1 }])
  })

  it('a track without one plays without captions; one that is broken is noted and the track still plays', async () => {
    const root = await library({
      'a.mp3': 'x',
      'b.mp3': 'x',
      'b.json': '{ not json',
      'c.mp3': 'x',
      'c.json': '[1, 2]',
      'd.mp3': 'x',
      'd.json': JSON.stringify({ lines: 'many' }),
    })
    const { tracks } = await scanSleepTracks(root)
    expect(tracks.map((t) => [t.key, t.captions.length, t.notes])).toEqual([
      ['a', 0, []],
      ['b', 0, ['the timing file is not valid JSON']],
      ['c', 0, ['the timing file is not a JSON object']],
      ['d', 0, ['"lines" in the timing file is not a list']],
    ])
  })

  it('a timing file that is too big is not used', async () => {
    const root = await library({
      'big.mp3': 'x',
      'big.json': timing([{ text: 'a', start: 0, end: 1 }], { pad: 'x'.repeat(4 * 1024 * 1024) }),
    })
    const [t] = (await scanSleepTracks(root)).tracks
    expect(t!.captions).toEqual([])
    expect(t!.notes[0]).toContain('bigger than 4 MiB')
  })
})

describe('readTiming', () => {
  it('drops lines the stage could not show, and says how many', () => {
    const r = readTiming({
      lines: [
        { text: 'ok', start: 0, end: 1 },
        { text: '', start: 0, end: 1 },
        { text: '   ', start: 0, end: 1 },
        { text: 'no times' },
        { text: 'strings', start: '1', end: '2' },
        { text: 'backwards', start: 5, end: 4 },
        { text: 'negative', start: -1, end: 1 },
        { text: 'infinite', start: 0, end: Infinity },
        { text: 'nan', start: Number.NaN, end: 1 },
        'a string',
        null,
        42,
      ],
    })
    expect(r.captions).toEqual([{ text: 'ok', start: 0, end: 1 }])
    expect(r.notes).toEqual([
      '11 line(s) of the timing file were ignored (no text, or times that do not fit)',
    ])
  })

  it('cuts a very long line and a very long list to what the stage accepts', () => {
    const lines = Array.from({ length: MAX_CAPTIONS + 10 }, (_, i) => ({
      text: i === 0 ? 'x'.repeat(MAX_CAPTION_CHARS + 50) : 'line',
      start: i,
      end: i + 0.5,
    }))
    const r = readTiming({ lines })
    expect(r.captions).toHaveLength(MAX_CAPTIONS)
    expect(r.captions[0]!.text).toHaveLength(MAX_CAPTION_CHARS)
    expect(r.notes).toEqual([`only the first ${MAX_CAPTIONS} lines of the timing file are used`])
  })

  it('a length that is not a sensible number is no length', () => {
    for (const d of [-1, 'long', null, Number.NaN, Infinity])
      expect(readTiming({ duration_s: d }).durationS).toBeNull()
    expect(readTiming({ duration_s: 0 }).durationS).toBe(0)
    expect(readTiming({})).toEqual({ durationS: null, captions: [], notes: [] })
  })
})
