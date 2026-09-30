import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetUrl, DancePlay, Id, LibrarySet, StageDownstream } from '@animatus/protocol'
import {
  MAX_IDLE_VARIANTS,
  MAX_TALK_CLIPS,
  MotionLibrary,
  naturalCompare,
  normalizeDanceMeta,
  pickTagClip,
  promptTagList,
  scanMotionLibrary,
  tagOfPoseFile,
  toDancePlay,
  toLibrarySet,
} from '../../src/library/motionLibrary.ts'
import type { ClipRef, DanceInfo, MotionLibraryScan } from '../../src/library/motionLibrary.ts'
import { createStageServer } from '../../src/stage/server.ts'
import {
  collectLogger,
  createCleanup,
  makeTempDir,
  rawRequest,
  writeTree,
} from '../_stage-support/fixtures.ts'

const cleanup = createCleanup()
afterEach(() => cleanup.run())

const E_ACUTE = String.fromCodePoint(0xe9) // a non-ASCII letter for file names
const BOM = String.fromCodePoint(0xfeff) // some editors put one at the start of a JSON file

function tempRoot(files: Record<string, string | Uint8Array>): string {
  const tmp = makeTempDir()
  cleanup.add(() => tmp.remove())
  const root = path.join(tmp.dir, 'motions')
  fs.mkdirSync(root, { recursive: true })
  writeTree(root, files)
  return root
}

/** Tiny placeholder files: the scanner only looks at names, never at the contents. */
const X = 'x'

const FULL_TREE: Record<string, string | Uint8Array> = {
  'idle_loop.vrma': X,
  'stray.vrma': X,
  'idle/idle_b.vrma': X,
  'idle/idle_a.vrma': X,
  'idle/readme.txt': X,
  'talk/talk_10.vrma': X,
  'talk/talk_02.vrma': X,
  'talk/talk_01.vrma': X,
  'talk/notes.md': X,
  'poses/nod.vrma': X,
  'poses/nod_10.vrma': X,
  'poses/nod_2.vrma': X,
  'poses/Wave.vrma': X,
  'poses/laugh_2.vrma': X,
  'poses/a b.vrma': X,
  [`poses/caf${E_ACUTE}.vrma`]: X,
  'poses/Shout.VRMA': X,
  'poses/.hidden.vrma': X,
  'poses/_2.vrma': X,
  'poses/shrug.json': '{}',
  'poses/bow.json': '{}',
  'poses/NOTE.txt': X,
  'poses/sub/ignored.vrma': X,
  'dance/aipao/motion.vrma': X,
  'dance/aipao/music.ogg': X,
  'dance/aipao/meta.json': JSON.stringify({
    title: 'Aipao',
    offset: 0.26,
    bpm: 141,
    speed: 1,
    volume: 0.8,
    credit: 'Motion: someone',
    enabled: true,
  }),
  'dance/badjson/motion.vrma': X,
  'dance/badjson/meta.json': '{oops',
  'dance/nometa/motion.vrma': X,
  'dance/nometa/music.wav': X,
  'dance/both/motion.vrma': X,
  'dance/both/music.mp3': X,
  'dance/both/music.ogg': X,
  'dance/both/meta.json': `${BOM}${JSON.stringify({ title: 'Both', enabled: false, speed: 2 })}`,
  'dance/nomotion/music.mp3': X,
  'dance/loose-file.txt': X,
  'other/x.vrma': X,
}

const ids = (clips: ClipRef[]) => clips.map((c) => c.id)

// ───────────────────────────── scanning ─────────────────────────────

describe('scanMotionLibrary', () => {
  it('scans the whole layout: idle, variants, talk, tags, dances', async () => {
    const root = tempRoot(FULL_TREE)
    const now = 1_700_000_000_000
    const scan = await scanMotionLibrary(root, 'motions', { now: () => now })

    expect(scan.idle).toEqual({ id: 'idle_loop', url: '/asset/motions/idle_loop.vrma' })
    expect(scan.idleVariants).toEqual([
      { id: 'idle:idle_a', url: '/asset/motions/idle/idle_a.vrma' },
      { id: 'idle:idle_b', url: '/asset/motions/idle/idle_b.vrma' },
    ])
    expect(scan.talk).toEqual([
      { id: 'talk:talk_01', url: '/asset/motions/talk/talk_01.vrma' },
      { id: 'talk:talk_02', url: '/asset/motions/talk/talk_02.vrma' },
      { id: 'talk:talk_10', url: '/asset/motions/talk/talk_10.vrma' }, // natural order, not 10 before 2
    ])
    expect(scan.scannedAt).toBe(now)
  })

  it('builds tags from file stems: lowercase, trailing _<digits> removed, sorted, variants in natural order', async () => {
    const scan = await scanMotionLibrary(tempRoot(FULL_TREE))
    expect([...scan.tags.keys()]).toEqual(['a b', `caf${E_ACUTE}`, 'laugh', 'nod', 'shout', 'wave'])
    expect(ids(scan.tags.get('nod') ?? [])).toEqual(['poses:nod', 'poses:nod_2', 'poses:nod_10'])
    // a tag exists as soon as one file does, even if it is only a numbered variant
    expect(ids(scan.tags.get('laugh') ?? [])).toEqual(['poses:laugh_2'])
    // the URL keeps the real file name, the tag is lowercase
    expect(scan.tags.get('wave')).toEqual([
      { id: 'poses:Wave', url: '/asset/motions/poses/Wave.vrma' },
    ])
    expect(scan.tags.get('shout')).toEqual([
      { id: 'poses:Shout', url: '/asset/motions/poses/Shout.VRMA' },
    ]) // .VRMA counts
    // .json pose files, other extensions and sub-folders of poses/ are ignored
    expect(scan.tags.has('shrug')).toBe(false)
    expect(scan.tags.has('bow')).toBe(false)
    expect(scan.tags.has('note')).toBe(false)
    expect(scan.tags.has('ignored')).toBe(false)
  })

  it('percent-encodes every URL segment and keeps ids valid protocol ids', async () => {
    const scan = await scanMotionLibrary(tempRoot(FULL_TREE))
    const spaced = scan.tags.get('a b')?.[0]
    expect(spaced?.url).toBe('/asset/motions/poses/a%20b.vrma')
    expect(spaced?.id).toMatch(/^poses:a_b-[0-9a-f]{6}$/)
    const accented = scan.tags.get(`caf${E_ACUTE}`)?.[0]
    expect(accented?.url).toBe('/asset/motions/poses/caf%C3%A9.vrma')
    expect(accented?.id).toMatch(/^poses:caf_-[0-9a-f]{6}$/)

    const every = allClips(scan)
    for (const clip of every) {
      expect(Id.safeParse(clip.id).success, clip.id).toBe(true)
      expect(AssetUrl.safeParse(clip.url).success, clip.url).toBe(true)
    }
    expect(new Set(ids(every)).size).toBe(every.length) // ids are unique across the whole library
  })

  it('keeps ids unique even when sanitising would make names collide', async () => {
    const scan = await scanMotionLibrary(
      tempRoot({
        'poses/a b.vrma': X,
        'poses/a_b.vrma': X,
        'poses/a+b.vrma': X,
        'poses/a-b.vrma': X,
      })
    )
    const all = [...scan.tags.values()].flat()
    expect(all).toHaveLength(4)
    expect(new Set(ids(all)).size).toBe(4)
  })

  it('leaves out files it cannot offer and says why', async () => {
    const scan = await scanMotionLibrary(tempRoot(FULL_TREE))
    const skipped = Object.fromEntries(scan.skipped.map((s) => [s.path, s.reason]))
    expect(skipped['poses/.hidden.vrma']).toMatch(/not safe to serve/) // the asset route would answer 404 for it
    expect(skipped['poses/_2.vrma']).toMatch(/no tag/)
    expect(scan.skipped.map((s) => s.path)).not.toContain('poses/nod.vrma')
    // and they are not in any list
    const urls = allClips(scan).map((c) => c.url)
    expect(urls).not.toContain('/asset/motions/poses/.hidden.vrma')
    expect(urls).not.toContain('/asset/motions/poses/_2.vrma')
  })

  it('skips clips whose URL would not fit the protocol', async () => {
    // three UTF-8 bytes per character: the percent-encoded URL is longer than the 2048 characters allowed
    const name = String.fromCodePoint(0x4e00).repeat(250)
    const scan = await scanMotionLibrary(
      tempRoot({ [`poses/${name}.vrma`]: X, 'poses/ok.vrma': X })
    )
    expect([...scan.tags.keys()]).toEqual(['ok'])
    expect(scan.skipped).toHaveLength(1)
    expect(scan.skipped[0]?.path).toBe(`poses/${name}.vrma`)
    expect(scan.skipped[0]?.reason).toBeTruthy()
  })

  it('ignores stray files and other folders', async () => {
    const scan = await scanMotionLibrary(tempRoot(FULL_TREE))
    const urls = allClips(scan).map((c) => c.url)
    expect(urls.some((u) => u.includes('stray.vrma'))).toBe(false)
    expect(urls.some((u) => u.includes('/other/'))).toBe(false)
    expect(urls.some((u) => u.includes('/sub/'))).toBe(false)
  })

  it('scans dance folders: needs motion.vrma, prefers ogg over mp3 over wav, normalises meta.json', async () => {
    const scan = await scanMotionLibrary(tempRoot(FULL_TREE))
    expect(scan.dances.map((d) => d.name)).toEqual(['aipao', 'badjson', 'both', 'nometa']) // nomotion skipped, sorted

    const aipao = scan.dances[0] as DanceInfo
    expect(aipao).toEqual({
      name: 'aipao',
      title: 'Aipao',
      motion: { id: 'dance:aipao:motion', url: '/asset/motions/dance/aipao/motion.vrma' },
      music: { id: 'dance:aipao:music', url: '/asset/motions/dance/aipao/music.ogg' },
      meta: {
        title: 'Aipao',
        offset: 0.26,
        bpm: 141,
        speed: 1,
        volume: 0.8,
        credit: 'Motion: someone',
        enabled: true,
      },
    })

    const bad = scan.dances[1] as DanceInfo
    expect(bad.meta).toEqual({
      title: 'badjson',
      offset: 0,
      bpm: 0,
      speed: 1,
      volume: 1,
      credit: '',
      enabled: true,
    })
    expect(bad.music).toBeNull()

    const both = scan.dances[2] as DanceInfo
    expect(both.music?.url).toBe('/asset/motions/dance/both/music.ogg')
    expect(both.meta).toMatchObject({ title: 'Both', enabled: false, speed: 2 }) // BOM tolerated, disabled ones are still listed
    expect(both.title).toBe('Both')

    const nometa = scan.dances[3] as DanceInfo
    expect(nometa.meta.title).toBe('nometa') // folder name
    expect(nometa.music?.url).toBe('/asset/motions/dance/nometa/music.wav')
  })

  it('serves a different library name in its URLs', async () => {
    const scan = await scanMotionLibrary(tempRoot(FULL_TREE), 'clips')
    expect(scan.idle?.url).toBe('/asset/clips/idle_loop.vrma')
    expect(scan.dances[0]?.motion.url).toBe('/asset/clips/dance/aipao/motion.vrma')
    const spaced = await scanMotionLibrary(tempRoot({ 'talk/t.vrma': X }), 'my clips')
    expect(spaced.talk[0]?.url).toBe('/asset/my%20clips/talk/t.vrma')
    for (const bad of ['', '..', 'a/b', 'a\\b', '.hidden', 'CON']) {
      await expect(scanMotionLibrary(tempRoot({}), bad)).rejects.toThrow(/invalid library name/)
    }
  })

  it('an empty folder is an empty library; a missing folder is an error', async () => {
    const empty = await scanMotionLibrary(tempRoot({}))
    expect(empty).toMatchObject({ idle: null, idleVariants: [], talk: [], dances: [], skipped: [] })
    expect(empty.tags.size).toBe(0)

    const missing = path.join(makeTempDir().dir, 'nope')
    await expect(scanMotionLibrary(missing)).rejects.toThrow(/not found/)
    const file = path.join(tempRoot({ 'a.txt': X }), 'a.txt')
    await expect(scanMotionLibrary(file)).rejects.toThrow(/not found/)
  })

  it('finds idle_loop.vrma whatever its case, and ignores an idle_loop folder', async () => {
    const scan = await scanMotionLibrary(tempRoot({ 'Idle_Loop.VRMA': X }))
    expect(scan.idle?.url).toBe('/asset/motions/Idle_Loop.VRMA')
    expect((await scanMotionLibrary(tempRoot({ 'idle_loop.vrma/inner.txt': X }))).idle).toBeNull()
  })

  it('does not list directories that merely end in .vrma', async () => {
    const scan = await scanMotionLibrary(
      tempRoot({ 'poses/folder.vrma/inner.vrma': X, 'poses/real.vrma': X })
    )
    expect([...scan.tags.keys()]).toEqual(['real'])
  })

  it('is deterministic: two scans of the same folder are identical', async () => {
    const root = tempRoot(FULL_TREE)
    const a = await scanMotionLibrary(root, 'motions', { now: () => 1 })
    const b = await scanMotionLibrary(root, 'motions', { now: () => 1 })
    expect(a).toEqual(b)
    expect([...a.tags.keys()]).toEqual([...b.tags.keys()])
  })

  it('every URL it produces is served by the asset route', async () => {
    const root = tempRoot(FULL_TREE)
    const scan = await scanMotionLibrary(root, 'motions')
    const server = createStageServer({ port: 0, libraries: { motions: root } })
    await server.start()
    cleanup.add(() => server.stop())
    const clips = allClips(scan)
    expect(clips.length).toBeGreaterThan(15)
    for (const clip of clips) {
      const r = await rawRequest(server.port, clip.url)
      expect(r.status, clip.url).toBe(200)
      expect(r.headers['content-type']).toMatch(/^(model\/gltf-binary|audio\/)/)
    }
  })
})

function allClips(scan: MotionLibraryScan): ClipRef[] {
  return [
    ...(scan.idle ? [scan.idle] : []),
    ...scan.idleVariants,
    ...scan.talk,
    ...[...scan.tags.values()].flat(),
    ...scan.dances.flatMap((d) => [d.motion, ...(d.music ? [d.music] : [])]),
  ]
}

// ───────────────────────────── small helpers ─────────────────────────────

describe('naturalCompare and tagOfPoseFile', () => {
  it('sorts numbers by value, ignores case, and is stable for equal keys', () => {
    const sorted = ['nod_10', 'nod_2', 'nod', 'Nod_3', 'a10', 'a9', 'B', 'a'].sort(naturalCompare)
    expect(sorted).toEqual(['a', 'a9', 'a10', 'B', 'nod', 'nod_2', 'Nod_3', 'nod_10'])
    expect(naturalCompare('x', 'x')).toBe(0)
    expect(naturalCompare('a01', 'a1')).toBeGreaterThan(0) // same value: the shorter spelling first
    expect(naturalCompare('a1', 'a01')).toBeLessThan(0)
    expect(naturalCompare('a99999999999999999999', 'a100000000000000000000')).toBeLessThan(0) // beyond 2^53
  })

  it.each([
    ['nod.vrma', 'nod'],
    ['Nod_2.vrma', 'nod'],
    ['nod_10.VRMA', 'nod'],
    ['spread_arms_3.vrma', 'spread_arms'],
    ['spread_arms.vrma', 'spread_arms'],
    ['nod_.vrma', 'nod_'],
    ['nod2.vrma', 'nod2'],
    ['nod_2a.vrma', 'nod_2a'],
    ['_2.vrma', ''],
    ['2.vrma', '2'],
    ['a_1_2.vrma', 'a_1'],
  ])('%s -> tag %j', (file, tag) => {
    expect(tagOfPoseFile(file)).toBe(tag)
  })
})

describe('normalizeDanceMeta', () => {
  const defaults = (title: string) => ({
    title,
    offset: 0,
    bpm: 0,
    speed: 1,
    volume: 1,
    credit: '',
    enabled: true,
  })

  it.each([undefined, null, [], 42, 'text', true])(
    'non-object meta %j gives the defaults',
    (raw) => {
      expect(normalizeDanceMeta(raw, 'folder')).toEqual(defaults('folder'))
    }
  )

  it('takes valid values as they are', () => {
    expect(
      normalizeDanceMeta(
        {
          title: 'T',
          offset: -0.5,
          bpm: 120.5,
          speed: 1.5,
          volume: 0.25,
          credit: 'c',
          enabled: false,
        },
        'f'
      )
    ).toEqual({
      title: 'T',
      offset: -0.5,
      bpm: 120.5,
      speed: 1.5,
      volume: 0.25,
      credit: 'c',
      enabled: false,
    })
  })

  it('title: a string, else the folder name', () => {
    expect(normalizeDanceMeta({ title: 'Song' }, 'f').title).toBe('Song')
    for (const title of [5, null, undefined, {}, ['x'], true])
      expect(normalizeDanceMeta({ title }, 'f').title).toBe('f')
  })

  it('offset and bpm: numbers, default 0', () => {
    for (const bad of ['0.26', null, true, {}, [], undefined]) {
      expect(normalizeDanceMeta({ offset: bad, bpm: bad }, 'f')).toMatchObject({
        offset: 0,
        bpm: 0,
      })
    }
    expect(normalizeDanceMeta({ offset: -3, bpm: 0 }, 'f')).toMatchObject({ offset: -3, bpm: 0 })
  })

  it('speed: a number above 0, else 1', () => {
    expect(normalizeDanceMeta({ speed: 0.5 }, 'f').speed).toBe(0.5)
    expect(normalizeDanceMeta({ speed: 3 }, 'f').speed).toBe(3)
    for (const bad of [0, -2, '2', null, undefined, {}])
      expect(normalizeDanceMeta({ speed: bad }, 'f').speed).toBe(1)
  })

  it('volume: at least 0, default 1', () => {
    expect(normalizeDanceMeta({ volume: 0 }, 'f').volume).toBe(0)
    expect(normalizeDanceMeta({ volume: -1 }, 'f').volume).toBe(0)
    expect(normalizeDanceMeta({ volume: 3 }, 'f').volume).toBe(3)
    for (const bad of ['loud', null, undefined, {}])
      expect(normalizeDanceMeta({ volume: bad }, 'f').volume).toBe(1)
  })

  it('credit: a string, default empty', () => {
    expect(normalizeDanceMeta({ credit: 'by someone' }, 'f').credit).toBe('by someone')
    for (const bad of [5, null, undefined, {}])
      expect(normalizeDanceMeta({ credit: bad }, 'f').credit).toBe('')
  })

  it('enabled: only an explicit false disables', () => {
    expect(normalizeDanceMeta({ enabled: false }, 'f').enabled).toBe(false)
    for (const v of [true, 0, '', 'false', null, undefined, 1])
      expect(normalizeDanceMeta({ enabled: v }, 'f').enabled).toBe(true)
  })
})

// ───────────────────────────── picking ─────────────────────────────

/** Small seeded generator so "random" tests are repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clip = (id: string): ClipRef => ({ id, url: `/asset/motions/poses/${id}.vrma` })
const libWith = (tags: Record<string, string[]>): Pick<MotionLibraryScan, 'tags'> => ({
  tags: new Map(Object.entries(tags).map(([tag, list]) => [tag, list.map(clip)])),
})

describe('pickTagClip', () => {
  const lib = libWith({ nod: ['nod', 'nod_2', 'nod_3'], wave: ['wave'], think: [] })

  it('returns null for unknown or empty tags', () => {
    expect(pickTagClip(lib, 'dance')).toBeNull()
    expect(pickTagClip(lib, '')).toBeNull()
    expect(pickTagClip(lib, 'think')).toBeNull()
    expect(pickTagClip(lib, '__proto__')).toBeNull()
    expect(pickTagClip(lib, 'constructor')).toBeNull()
  })

  it('is case-insensitive and trims the tag', () => {
    expect(pickTagClip(lib, 'WAVE')?.id).toBe('wave')
    expect(pickTagClip(lib, '  Wave \n')?.id).toBe('wave')
  })

  it('picks by the random value and clamps it into range', () => {
    expect(pickTagClip(lib, 'nod', undefined, () => 0)?.id).toBe('nod')
    expect(pickTagClip(lib, 'nod', undefined, () => 0.4)?.id).toBe('nod_2')
    expect(pickTagClip(lib, 'nod', undefined, () => 0.99)?.id).toBe('nod_3')
    expect(pickTagClip(lib, 'nod', undefined, () => 1)?.id).toBe('nod_3') // a misbehaving RNG cannot go out of range
    expect(pickTagClip(lib, 'nod', undefined, () => -0.5)?.id).toBe('nod')
    expect(pickTagClip(lib, 'nod', undefined, () => Number.NaN)?.id).toBe('nod')
  })

  it('advances to the next variant when the random pick equals the last one', () => {
    const last = new Map([['nod', 'nod_2']])
    expect(pickTagClip(lib, 'nod', last, () => 0.4)?.id).toBe('nod_3') // would have been nod_2 again
    expect(last.get('nod')).toBe('nod_3')
    expect(pickTagClip(lib, 'nod', last, () => 0.99)?.id).toBe('nod') // wraps around from the end
    expect(last.get('nod')).toBe('nod')
    expect(pickTagClip(lib, 'nod', last, () => 0.4)?.id).toBe('nod_2') // different from the last one: kept
  })

  it('never repeats the previous pick in a row when there is more than one variant', () => {
    const random = mulberry32(42)
    const last = new Map<string, string>()
    let previous = ''
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const pick = pickTagClip(lib, 'nod', last, random)?.id ?? ''
      expect(pick).not.toBe(previous)
      seen.add(pick)
      previous = pick
    }
    expect(seen.size).toBe(3) // and all variants do get picked
  })

  it('without a memory map repeats are possible; with a single variant it always repeats', () => {
    const random = mulberry32(7)
    let repeated = false
    let previous = ''
    for (let i = 0; i < 200; i++) {
      const pick = pickTagClip(lib, 'nod', undefined, random)?.id ?? ''
      if (pick === previous) repeated = true
      previous = pick
    }
    expect(repeated).toBe(true)
    const last = new Map<string, string>()
    expect(pickTagClip(lib, 'wave', last, () => 0.3)?.id).toBe('wave')
    expect(pickTagClip(lib, 'wave', last, () => 0.3)?.id).toBe('wave')
  })

  it('keeps a separate memory per tag', () => {
    const last = new Map<string, string>()
    pickTagClip(lib, 'nod', last, () => 0)
    pickTagClip(lib, 'wave', last, () => 0)
    expect([...last.entries()]).toEqual([
      ['nod', 'nod'],
      ['wave', 'wave'],
    ])
  })
})

// ───────────────────────────── protocol messages ─────────────────────────────

describe('toLibrarySet', () => {
  it('produces a valid library.set for hub.setLibrary', async () => {
    const scan = await scanMotionLibrary(tempRoot(FULL_TREE))
    const msg = toLibrarySet(scan)
    expect(LibrarySet.safeParse(msg).success).toBe(true)
    expect(StageDownstream.safeParse(msg).success).toBe(true)
    expect(msg.idle).toEqual(scan.idle)
    expect(msg.idle_variants).toEqual(scan.idleVariants)
    expect(msg.talk).toEqual(scan.talk)
    expect(msg.type).toBe('library.set')
  })

  it('handles a library without an idle pose', async () => {
    const scan = await scanMotionLibrary(tempRoot({ 'talk/a.vrma': X }))
    const msg = toLibrarySet(scan)
    expect(msg.idle).toBeNull()
    expect(msg.idle_variants).toEqual([])
    expect(msg.talk).toHaveLength(1)
  })

  it('cuts lists at the protocol limits instead of producing an invalid message', () => {
    const scan: MotionLibraryScan = {
      idle: null,
      idleVariants: Array.from({ length: 70 }, (_, i) => clip(`i${i}`)),
      talk: Array.from({ length: 300 }, (_, i) => clip(`t${i}`)),
      tags: new Map(),
      dances: [],
      skipped: [],
      scannedAt: 0,
    }
    const msg = toLibrarySet(scan)
    expect(msg.idle_variants).toHaveLength(MAX_IDLE_VARIANTS)
    expect(msg.talk).toHaveLength(MAX_TALK_CLIPS)
    expect(msg.talk[0]?.id).toBe('t0') // the first ones in sorted order are kept
    expect(LibrarySet.safeParse(msg).success).toBe(true)
  })
})

describe('promptTagList', () => {
  it('lists tag names sorted', () => {
    expect(promptTagList(libWith({ wave: ['w'], nod: ['n'], clap: ['c'] }))).toEqual([
      'clap',
      'nod',
      'wave',
    ])
    expect(promptTagList({ tags: new Map() })).toEqual([])
  })
})

describe('toDancePlay', () => {
  const dance = (
    over: Partial<DanceInfo['meta']> = {},
    music: ClipRef | null = clip('m')
  ): DanceInfo => ({
    name: 'x',
    title: 'X',
    motion: { id: 'dance:x:motion', url: '/asset/motions/dance/x/motion.vrma' },
    music,
    meta: {
      title: 'X',
      offset: 0.5,
      bpm: 120,
      speed: 1,
      volume: 1,
      credit: 'c',
      enabled: true,
      ...over,
    },
  })

  it('builds a valid dance.play from a scanned dance', () => {
    const msg = toDancePlay(dance(), 'dance-1')
    expect(DancePlay.safeParse(msg).success).toBe(true)
    expect(msg).toMatchObject({
      type: 'dance.play',
      dance_id: 'dance-1',
      name: 'x',
      title: 'X',
      motion_url: '/asset/motions/dance/x/motion.vrma',
      music_url: '/asset/motions/poses/m.vrma',
      offset: 0.5,
      speed: 1,
      volume: 1,
      credit: 'c',
    })
    expect(toDancePlay(dance({}, null), 'd').music_url).toBeNull()
  })

  it('clamps values to the protocol ranges and cuts long text', () => {
    const msg = toDancePlay(
      dance({ offset: 99, speed: 10, volume: 5, credit: 'c'.repeat(500), title: 't'.repeat(500) }),
      'd'
    )
    expect(msg).toMatchObject({ offset: 30, speed: 3, volume: 2 })
    expect(msg.credit).toHaveLength(200)
    expect(msg.title).toHaveLength(120)
    expect(toDancePlay(dance({ offset: -99, speed: 0.01, volume: 0 }), 'd')).toMatchObject({
      offset: -30,
      speed: 0.25,
      volume: 0,
    })
    expect(toDancePlay({ ...dance(), name: 'n'.repeat(200) }, 'd').name).toHaveLength(80)
  })

  it('rejects an invalid dance id', () => {
    expect(() => toDancePlay(dance(), 'not valid!')).toThrow()
  })
})

// ───────────────────────────── the live library ─────────────────────────────

describe('MotionLibrary', () => {
  it('rescans at most every 15 s unless forced', async () => {
    const root = tempRoot({ 'talk/a.vrma': X })
    let clock = 1000
    const lib = new MotionLibrary(root, { now: () => clock })
    expect(lib.current).toBeNull()

    const first = await lib.refresh()
    expect(first.talk).toHaveLength(1)
    expect(lib.current).toBe(first)

    writeTree(root, { 'talk/b.vrma': X })
    clock += 14_999
    expect(await lib.refresh()).toBe(first) // too soon: the cached scan
    expect((await lib.refresh(true)).talk).toHaveLength(2) // forced

    writeTree(root, { 'talk/c.vrma': X })
    clock += 14_999
    expect((await lib.refresh()).talk).toHaveLength(2) // the forced scan restarted the clock
    clock += 2
    expect((await lib.refresh()).talk).toHaveLength(3)
  })

  it('concurrent refreshes share one scan', async () => {
    const lib = new MotionLibrary(tempRoot({ 'talk/a.vrma': X }))
    const [a, b, c] = await Promise.all([lib.refresh(), lib.refresh(true), lib.refresh()])
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('keeps the previous scan when a rescan fails, but the first scan throws', async () => {
    const { logger, has } = collectLogger()
    const missing = new MotionLibrary(path.join(makeTempDir().dir, 'nope'), { logger })
    await expect(missing.refresh()).rejects.toThrow(/not found/)

    const tmp = makeTempDir()
    cleanup.add(() => tmp.remove())
    const root = path.join(tmp.dir, 'm')
    writeTree(root, { 'talk/a.vrma': X })
    const lib = new MotionLibrary(root, { logger })
    const good = await lib.refresh()
    fs.rmSync(root, { recursive: true, force: true })
    const again = await lib.refresh(true)
    expect(again).toBe(good)
    expect(has('warn', 'keeping the previous scan')).toBe(true)
  })

  it('picks tags with a memory of the last pick, exports the library set and the prompt tags', async () => {
    const root = tempRoot({
      'poses/nod.vrma': X,
      'poses/nod_2.vrma': X,
      'poses/wave.vrma': X,
      'idle_loop.vrma': X,
      'talk/t.vrma': X,
    })
    const lib = new MotionLibrary(root, { libraryName: 'clips' })
    expect(lib.pick('nod')).toBeNull() // not scanned yet
    expect(lib.promptTagList()).toEqual([])
    expect(() => lib.toLibrarySet()).toThrow(/not been scanned/)

    await lib.refresh()
    expect(lib.promptTagList()).toEqual(['nod', 'wave'])
    const random = mulberry32(3)
    let previous = ''
    for (let i = 0; i < 50; i++) {
      const pick = lib.pick('NOD', random)?.id ?? ''
      expect(pick).not.toBe(previous)
      previous = pick
    }
    expect(lib.pick('unknown')).toBeNull()
    const set = lib.toLibrarySet()
    expect(set.idle?.url).toBe('/asset/clips/idle_loop.vrma')
    expect(LibrarySet.safeParse(set).success).toBe(true)
  })

  it('logs when files were left out', async () => {
    const { logger, has } = collectLogger()
    const lib = new MotionLibrary(tempRoot({ 'poses/.hidden.vrma': X }), { logger })
    await lib.refresh()
    expect(has('warn', 'left out')).toBe(true)
  })
})

// ───────────────────────────── a real folder, when one is given ─────────────────────────────

describe.skipIf(!process.env.ANIMATUS_TEST_MOTIONS)(
  'a real motions folder (ANIMATUS_TEST_MOTIONS)',
  () => {
    it('scans without errors and produces protocol-valid output', async () => {
      const dir = process.env.ANIMATUS_TEST_MOTIONS as string
      const scan = await scanMotionLibrary(dir)
      const counts = {
        idle: scan.idle ? 1 : 0,
        idleVariants: scan.idleVariants.length,
        talk: scan.talk.length,
        tags: scan.tags.size,
        tagClips: [...scan.tags.values()].reduce((n, list) => n + list.length, 0),
        dances: scan.dances.length,
        dancesEnabled: scan.dances.filter((d) => d.meta.enabled).length,
        skipped: scan.skipped.length,
      }
      // the point of this test is to look at these numbers
      console.log(
        `motion library at ${path.basename(dir)}:`,
        JSON.stringify(counts),
        'tags:',
        promptTagList(scan).join(', ')
      )
      if (scan.skipped.length) console.log('skipped:', JSON.stringify(scan.skipped))

      expect(StageDownstream.safeParse(toLibrarySet(scan)).success).toBe(true)
      for (const c of allClips(scan)) {
        expect(Id.safeParse(c.id).success, c.id).toBe(true)
        expect(AssetUrl.safeParse(c.url).success, c.url).toBe(true)
      }
      for (const d of scan.dances)
        expect(
          DancePlay.safeParse(toDancePlay(d, `d-${d.name.replace(/[^A-Za-z0-9]/g, '_')}`)).success,
          d.name
        ).toBe(true)
    })
  }
)
