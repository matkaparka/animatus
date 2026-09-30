import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ReplayError,
  ReplayScenario,
  ScenarioError,
  WavError,
  createShuffleBag,
  decodeWavToPcm16,
  evaluateReplay,
  formatElapsed,
  formatStats,
  loadUtterances,
  main,
  parseScenario,
  runReplay,
} from '../../src/dev/replay.ts'
import type { ReplayExpect, ReplayObservations, ReplayRunOptions } from '../../src/dev/replay.ts'
import type { StageServer } from '../../src/stage/server.ts'
import { FakeStage } from '../_stage-support/fake-stage.ts'
import type { FakeStageOptions } from '../_stage-support/fake-stage.ts'
import {
  concatBytes,
  createCleanup,
  makeTempDir,
  makeToneWav,
  makeWav,
  rawRequest,
  seededRandom,
  waitUntil,
  writeTree,
} from '../_stage-support/fixtures.ts'

const cleanup = createCleanup()
afterEach(() => cleanup.run())

const asciiBytes = (text: string) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)))

/** Builds a RIFF/WAVE file chunk by chunk, so malformed orders and contents can be produced. */
function riff(chunks: Array<[string, Uint8Array]>, form = 'WAVE'): Uint8Array {
  const parts: Uint8Array[] = []
  for (const [id, body] of chunks) {
    const head = new Uint8Array(8)
    head.set(asciiBytes(id), 0)
    new DataView(head.buffer).setUint32(4, body.byteLength, true)
    parts.push(head, body)
    if (body.byteLength % 2) parts.push(new Uint8Array(1))
  }
  const body = concatBytes(parts)
  const out = new Uint8Array(12 + body.byteLength)
  out.set(asciiBytes('RIFF'), 0)
  new DataView(out.buffer).setUint32(4, 4 + body.byteLength, true)
  out.set(asciiBytes(form), 8)
  out.set(body, 12)
  return out
}

function fmtChunk(tag: number, channels: number, rate: number, bits: number): Uint8Array {
  const b = new Uint8Array(16)
  const dv = new DataView(b.buffer)
  dv.setUint16(0, tag, true)
  dv.setUint16(2, channels, true)
  dv.setUint32(4, rate, true)
  dv.setUint32(8, (rate * channels * bits) / 8, true)
  dv.setUint16(12, (channels * bits) / 8, true)
  dv.setUint16(14, bits, true)
  return b
}

const int16Bytes = (values: number[]) => {
  const out = new Uint8Array(values.length * 2)
  const dv = new DataView(out.buffer)
  values.forEach((v, i) => dv.setInt16(i * 2, v, true))
  return out
}

const readInt16s = (bytes: Uint8Array) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => dv.getInt16(i * 2, true))
}

// ───────────────────────────── WAV decoding ─────────────────────────────

describe('decodeWavToPcm16', () => {
  it('keeps 16-bit mono exactly, at the file sample rate', () => {
    const samples = [0, 1, -1, 32767, -32768, 1234, -4321]
    const decoded = decodeWavToPcm16(
      makeWav({ sampleRate: 22050, frames: samples.map((s) => [s]) })
    )
    expect(decoded).toMatchObject({ sampleRate: 22050, channels: 1, frames: 7 })
    expect(Array.from(decoded.pcm16)).toEqual(Array.from(int16Bytes(samples)))
  })

  it('mixes 16-bit stereo down to mono by averaging', () => {
    const decoded = decodeWavToPcm16(
      makeWav({
        sampleRate: 44100,
        frames: [
          [1000, 3000],
          [-1000, -3000],
          [3, 4],
          [32767, 32767],
          [-32768, -32768],
          [32767, -32768],
        ],
      })
    )
    expect(decoded).toMatchObject({ sampleRate: 44100, channels: 2, frames: 6 })
    expect(readInt16s(decoded.pcm16)).toEqual([2000, -2000, 4, 32767, -32768, 0])
  })

  it('mixes more than two channels', () => {
    const decoded = decodeWavToPcm16(
      makeWav({
        frames: [
          [300, 600, 900],
          [-30, -60, -90],
        ],
      })
    )
    expect(decoded.channels).toBe(3)
    expect(readInt16s(decoded.pcm16)).toEqual([600, -60])
  })

  it('converts 32-bit float: scaled, clamped, NaN and infinities become silence', () => {
    const values = [0, 0.5, -0.5, 1, -1, 2, -2, Number.NaN, Number.POSITIVE_INFINITY]
    const decoded = decodeWavToPcm16(
      makeWav({ format: 'float32', sampleRate: 48000, frames: values.map((v) => [v]) })
    )
    expect(decoded).toMatchObject({ sampleRate: 48000, channels: 1, frames: 9 })
    expect(readInt16s(decoded.pcm16)).toEqual([
      0, 16384, -16384, 32767, -32768, 32767, -32768, 0, 0,
    ])
  })

  it('downmixes float32 stereo before scaling', () => {
    const decoded = decodeWavToPcm16(
      makeWav({
        format: 'float32',
        frames: [
          [0.5, -0.5],
          [1, 1],
          [0.25, 0.75],
        ],
      })
    )
    expect(readInt16s(decoded.pcm16)).toEqual([0, 32767, 16384])
  })

  it('reads WAVE_FORMAT_EXTENSIBLE files by their sub-format', () => {
    const pcm = decodeWavToPcm16(makeWav({ extensible: true, frames: [[100], [-200]] }))
    expect(readInt16s(pcm.pcm16)).toEqual([100, -200])
    const float = decodeWavToPcm16(
      makeWav({ extensible: true, format: 'float32', frames: [[0.5], [-1]] })
    )
    expect(readInt16s(float.pcm16)).toEqual([16384, -32768])
  })

  it('skips other chunks, including odd-sized ones that are padded', () => {
    const wav = makeWav({
      frames: [[7], [8], [9]],
      extraChunks: [
        { id: 'LIST', bytes: asciiBytes('abc') }, // 3 bytes + 1 pad byte
        { id: 'junk', bytes: asciiBytes('xy') },
      ],
    })
    expect(readInt16s(decodeWavToPcm16(wav).pcm16)).toEqual([7, 8, 9])
  })

  it('accepts a streamed file whose data size is unknown or too large, and drops a partial last frame', () => {
    const streamed = makeWav({ frames: [[1], [2], [3]], dataSizeField: 0xffffffff })
    expect(readInt16s(decodeWavToPcm16(streamed).pcm16)).toEqual([1, 2, 3])
    const lying = makeWav({ frames: [[1], [2], [3]], dataSizeField: 1_000_000 })
    expect(decodeWavToPcm16(lying).frames).toBe(3)
    const cut = makeWav({ frames: [[1], [2], [3]], truncateBy: 1 }) // the last sample is incomplete
    expect(readInt16s(decodeWavToPcm16(cut).pcm16)).toEqual([1, 2])
    const cutStereo = makeWav({
      frames: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      truncateBy: 3,
    })
    expect(decodeWavToPcm16(cutStereo).frames).toBe(2)
  })

  it('works on a view into a larger buffer and returns an independent copy', () => {
    const wav = makeWav({ frames: [[10], [20]] })
    const padded = new Uint8Array(wav.byteLength + 9)
    padded.set(wav, 9)
    const decoded = decodeWavToPcm16(padded.subarray(9))
    expect(readInt16s(decoded.pcm16)).toEqual([10, 20])
    padded.fill(0)
    expect(readInt16s(decoded.pcm16)).toEqual([10, 20])
    expect(decoded.pcm16.byteOffset).toBe(0)
  })

  it.each([
    ['24-bit PCM', { tag: 1, bits: 24 }],
    ['8-bit PCM', { tag: 1, bits: 8 }],
    ['32-bit integer PCM', { tag: 1, bits: 32 }],
    ['64-bit float', { tag: 3, bits: 64 }],
    ['ADPCM', { tag: 2, bits: 16 }],
    ['A-law', { tag: 6, bits: 16 }],
  ])('rejects %s with a message that names the supported formats', (_name, format) => {
    const wav = makeWav({ format, frames: [[1], [2]] })
    expect(() => decodeWavToPcm16(wav)).toThrow(WavError)
    expect(() => decodeWavToPcm16(wav)).toThrow(/only 16-bit PCM and 32-bit float/)
  })

  it.each([
    ['nothing', () => new Uint8Array(0), /too short/],
    ['a few bytes', () => new Uint8Array(11), /too short/],
    ['noise', () => Uint8Array.from({ length: 300 }, (_, i) => (i * 97 + 13) & 0xff), /RIFF\/WAVE/],
    [
      'a RIFF file that is not WAVE',
      () => riff([['fmt ', fmtChunk(1, 1, 16000, 16)]], 'AVI '),
      /RIFF\/WAVE/,
    ],
    ['a WAVE file without chunks', () => riff([]), /no fmt chunk/],
    [
      'data before fmt',
      () =>
        riff([
          ['data', new Uint8Array(4)],
          ['fmt ', fmtChunk(1, 1, 16000, 16)],
        ]),
      /no fmt chunk before/,
    ],
    ['no data chunk', () => riff([['fmt ', fmtChunk(1, 1, 16000, 16)]]), /no data chunk/],
    [
      'a truncated fmt chunk',
      () => riff([['fmt ', new Uint8Array([1, 0, 1, 0])]]),
      /fmt chunk is truncated/,
    ],
    [
      'a truncated extensible fmt chunk',
      () =>
        riff([
          [
            'fmt ',
            (() => {
              const b = fmtChunk(0xfffe, 1, 16000, 16)
              return b
            })(),
          ],
          ['data', new Uint8Array(4)],
        ]),
      /extensible fmt chunk is truncated/,
    ],
    [
      'zero samples',
      () =>
        riff([
          ['fmt ', fmtChunk(1, 1, 16000, 16)],
          ['data', new Uint8Array(0)],
        ]),
      /no audio samples/,
    ],
    [
      'a single byte of data',
      () =>
        riff([
          ['fmt ', fmtChunk(1, 1, 16000, 16)],
          ['data', new Uint8Array(1)],
        ]),
      /no audio samples/,
    ],
    [
      'zero channels',
      () =>
        riff([
          ['fmt ', fmtChunk(1, 0, 16000, 16)],
          ['data', new Uint8Array(4)],
        ]),
      /zero channels/,
    ],
    [
      'a zero sample rate',
      () =>
        riff([
          ['fmt ', fmtChunk(1, 1, 0, 16)],
          ['data', new Uint8Array(4)],
        ]),
      /zero sample rate/,
    ],
  ])('rejects %s', (_name, make, message) => {
    expect(() => decodeWavToPcm16(make())).toThrow(WavError)
    expect(() => decodeWavToPcm16(make())).toThrow(message)
  })

  it('does not run away on a chunk that claims to be huge', () => {
    const wav = riff([
      ['fmt ', fmtChunk(1, 1, 16000, 16)],
      ['LIST', new Uint8Array(8)],
    ])
    new DataView(wav.buffer).setUint32(12 + 8 + 16 + 4, 0xfffffff0, true) // the LIST size field
    expect(() => decodeWavToPcm16(wav)).toThrow(/no data chunk/)
  })
})

// ───────────────────────────── scenario ─────────────────────────────

describe('parseScenario', () => {
  const baseDir = path.resolve('scenario-dir')
  const minimal = {
    libraries: { models: 'models', motions: 'motions' },
    model: 'a.vrm',
    utterances: [{ wav: 'wavs/a.wav' }],
  }

  it('accepts a minimal scenario, fills every default and makes paths absolute', () => {
    const s = parseScenario(minimal, baseDir)
    expect(s.libraries).toEqual({
      models: path.join(baseDir, 'models'),
      motions: path.join(baseDir, 'motions'),
    })
    expect(s.utterances).toEqual([{ wav: path.join(baseDir, 'wavs', 'a.wav'), emotion: 'neutral' }])
    expect(s.gapMs).toEqual([200, 900])
    expect(s.dances).toEqual([])
    expect(s.browser).toBeUndefined()
    expect(s.expect).toEqual({
      maxAudioContexts: 1,
      maxTposeFrames: 0,
      maxUnderrunsPerMinute: 3,
      maxDisconnects: 0,
    })
  })

  it('accepts the full example from the tool description', () => {
    const s = parseScenario(
      {
        libraries: { models: 'C:/models', motions: 'C:/motions' },
        model: 'model.vrm',
        browser: {
          executable: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
          profileDir: 'C:/data/animatus-stage-profile',
          windowSize: [1280, 720],
        },
        utterances: [
          { wav: 'C:/wavs/line-001.wav', text: 'Hello there.', emotion: 'happy', motion: 'nod' },
        ],
        gapMs: [200, 900],
        dances: [{ atSeconds: 600, name: 'some-dance' }],
        expect: { maxAudioContexts: 1, maxTposeFrames: 0, maxUnderrunsPerMinute: 3 },
      },
      baseDir
    )
    expect(s.browser?.windowSize).toEqual([1280, 720])
    expect(s.browser?.executable).toBe('C:/Program Files/Google/Chrome/Application/chrome.exe') // a command, not resolved
    expect(s.utterances[0]).toMatchObject({ text: 'Hello there.', emotion: 'happy', motion: 'nod' })
    expect(s.dances).toEqual([{ atSeconds: 600, name: 'some-dance' }])
    expect(s.expect.maxDisconnects).toBe(0)
  })

  it('defaults the window size and passes extra libraries through', () => {
    const s = parseScenario(
      {
        ...minimal,
        libraries: { ...minimal.libraries, lipsync: 'lip' },
        browser: { executable: 'chrome', profileDir: 'p/animatus-stage' },
      },
      baseDir
    )
    expect(s.browser?.windowSize).toEqual([1280, 720])
    expect(s.browser?.profileDir).toBe(path.join(baseDir, 'p', 'animatus-stage'))
    expect(s.libraries.lipsync).toBe(path.join(baseDir, 'lip'))
  })

  it('keeps absolute paths as they are', () => {
    const abs = path.resolve('somewhere', 'else')
    const s = parseScenario({ ...minimal, libraries: { models: abs, motions: abs } }, baseDir)
    expect(s.libraries.models).toBe(abs)
  })

  it.each([
    ['an unknown top-level key', { ...minimal, gapsMs: [1, 2] }, /gapsMs/],
    [
      'an unknown key in an utterance',
      { ...minimal, utterances: [{ wav: 'a.wav', volume: 2 }] },
      /volume/,
    ],
    [
      'a missing models library',
      { ...minimal, libraries: { motions: 'm' } },
      /"models" and "motions"/,
    ],
    [
      'a missing motions library',
      { ...minimal, libraries: { models: 'm' } },
      /"models" and "motions"/,
    ],
    ['an empty library path', { ...minimal, libraries: { models: '', motions: 'm' } }, /libraries/],
    ['no model', { libraries: minimal.libraries, utterances: minimal.utterances }, /model/],
    ['no utterances', { ...minimal, utterances: [] }, /utterances/],
    [
      'an unknown emotion',
      { ...minimal, utterances: [{ wav: 'a.wav', emotion: 'whisper' }] },
      /emotion/,
    ],
    ['an utterance without a wav', { ...minimal, utterances: [{ text: 'hi' }] }, /wav/],
    ['gapMs with min above max', { ...minimal, gapMs: [900, 200] }, /min <= max/],
    ['gapMs with a negative value', { ...minimal, gapMs: [-1, 5] }, /gapMs/],
    ['gapMs with one value', { ...minimal, gapMs: [5] }, /gapMs/],
    ['a negative dance time', { ...minimal, dances: [{ atSeconds: -1, name: 'x' }] }, /atSeconds/],
    ['a dance without a name', { ...minimal, dances: [{ atSeconds: 1 }] }, /name/],
    [
      'a tiny window',
      { ...minimal, browser: { executable: 'c', profileDir: 'p', windowSize: [10, 10] } },
      /windowSize/,
    ],
    [
      'a browser without a profile directory',
      { ...minimal, browser: { executable: 'c' } },
      /profileDir/,
    ],
    [
      'a negative expectation',
      { ...minimal, expect: { maxAudioContexts: -1 } },
      /maxAudioContexts/,
    ],
    [
      'a fractional context limit',
      { ...minimal, expect: { maxAudioContexts: 1.5 } },
      /maxAudioContexts/,
    ],
    ['an unknown expectation', { ...minimal, expect: { maxFoo: 1 } }, /maxFoo/],
    [
      'a text that is far too long',
      { ...minimal, utterances: [{ wav: 'a.wav', text: 'x'.repeat(2001) }] },
      /text/,
    ],
    ['null', null, /invalid scenario/],
    ['an array', [], /invalid scenario/],
    ['a string', 'scenario', /invalid scenario/],
  ])('rejects %s with a ScenarioError that says where', (_name, value, message) => {
    expect(() => parseScenario(value, baseDir)).toThrow(ScenarioError)
    expect(() => parseScenario(value, baseDir)).toThrow(message)
  })

  it('lists every problem at once', () => {
    let message = ''
    try {
      parseScenario({ libraries: { models: 'm' }, utterances: [] }, baseDir)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/libraries/)
    expect(message).toMatch(/model/)
    expect(message).toMatch(/utterances/)
  })

  it('the schema itself is exported for tooling', () => {
    expect(ReplayScenario.safeParse(minimal).success).toBe(true)
  })
})

describe('loadUtterances', () => {
  it('decodes every file, keeps text and motion, and computes the duration', async () => {
    const tmp = makeTempDir()
    cleanup.add(() => tmp.remove())
    writeTree(tmp.dir, {
      'a.wav': makeWav({ sampleRate: 16000, frames: Array.from({ length: 16000 }, () => [100]) }),
      'b.wav': makeWav({
        sampleRate: 24000,
        format: 'float32',
        frames: Array.from({ length: 12000 }, () => [0.1, 0.1]),
      }),
    })
    const scenario = parseScenario(
      {
        libraries: { models: 'm', motions: 'x' },
        model: 'a.vrm',
        utterances: [
          { wav: 'a.wav', text: 'first', emotion: 'happy', motion: 'nod' },
          { wav: 'b.wav' },
        ],
      },
      tmp.dir
    )
    const loaded = await loadUtterances(scenario.utterances)
    expect(loaded).toHaveLength(2)
    expect(loaded[0]).toMatchObject({
      text: 'first',
      emotion: 'happy',
      motion: 'nod',
      sampleRate: 16000,
      durationMs: 1000,
    })
    expect(loaded[0]?.pcm16.byteLength).toBe(32000)
    expect(loaded[1]).toMatchObject({ emotion: 'neutral', sampleRate: 24000, durationMs: 500 })
    expect(loaded[1]?.text).toBeUndefined()
    expect(loaded[1]?.motion).toBeUndefined()
  })

  it('fails early with the file name for a missing or bad WAV', async () => {
    const tmp = makeTempDir()
    cleanup.add(() => tmp.remove())
    writeTree(tmp.dir, { 'bad.wav': 'this is not a wav file at all', 'ok.wav': makeToneWav(20) })
    const missing = path.join(tmp.dir, 'nothing.wav')
    await expect(loadUtterances([{ wav: missing, emotion: 'neutral' }])).rejects.toThrow(
      ScenarioError
    )
    await expect(loadUtterances([{ wav: missing, emotion: 'neutral' }])).rejects.toThrow(
      /nothing\.wav/
    )
    const bad = path.join(tmp.dir, 'bad.wav')
    await expect(loadUtterances([{ wav: bad, emotion: 'neutral' }])).rejects.toThrow(
      /bad\.wav: not a WAV file/
    )
    await expect(
      loadUtterances([
        { wav: path.join(tmp.dir, 'ok.wav'), emotion: 'neutral' },
        { wav: bad, emotion: 'neutral' },
      ])
    ).rejects.toThrow(/bad\.wav/)
  })

  it('refuses sample rates the protocol cannot carry', async () => {
    const tmp = makeTempDir()
    cleanup.add(() => tmp.remove())
    writeTree(tmp.dir, {
      'low.wav': makeWav({ sampleRate: 4000, frames: [[1], [2]] }),
      'high.wav': makeWav({ sampleRate: 192000, frames: [[1], [2]] }),
      'edge-low.wav': makeWav({ sampleRate: 8000, frames: [[1], [2]] }),
      'edge-high.wav': makeWav({ sampleRate: 96000, frames: [[1], [2]] }),
    })
    for (const name of ['low.wav', 'high.wav']) {
      await expect(
        loadUtterances([{ wav: path.join(tmp.dir, name), emotion: 'neutral' }])
      ).rejects.toThrow(/outside the supported 8000\.\.96000/)
    }
    for (const name of ['edge-low.wav', 'edge-high.wav']) {
      await expect(
        loadUtterances([{ wav: path.join(tmp.dir, name), emotion: 'neutral' }])
      ).resolves.toHaveLength(1)
    }
  })
})

// ───────────────────────────── pass / fail ─────────────────────────────

describe('evaluateReplay', () => {
  const good: ReplayObservations = {
    elapsedMs: 10 * 60_000,
    utterancesEnded: 100,
    endReasons: { done: 100 },
    underrunsFromEnded: 0,
    statsReports: 100,
    audioContextsCreated: 1,
    tposeFrames: 0,
    underrunsTotal: 0,
    disconnects: 0,
    stageErrors: 0,
    dancesPlayed: 1,
    danceFailures: 0,
  }
  const limits: ReplayExpect = {
    maxAudioContexts: 1,
    maxTposeFrames: 0,
    maxUnderrunsPerMinute: 3,
    maxDisconnects: 0,
  }
  const failing = (over: Partial<ReplayObservations>, expected: ReplayExpect = limits) =>
    evaluateReplay({ ...good, ...over }, expected)
      .checks.filter((c) => !c.ok)
      .map((c) => c.name)

  it('passes a clean run and reports every check', () => {
    const r = evaluateReplay(good, limits)
    expect(r.pass).toBe(true)
    expect(r.checks.map((c) => c.name)).toEqual([
      'utterances played',
      'stats reported',
      'audio contexts created',
      'T-pose frames',
      'underruns per minute',
      'playback end reasons',
      'stage stayed connected',
      'dances completed',
    ])
    for (const c of r.checks) expect(c.detail).toBeTruthy()
  })

  it.each([
    ['too many audio contexts', { audioContextsCreated: 2 }, 'audio contexts created'],
    ['audio contexts never reported', { audioContextsCreated: null }, 'audio contexts created'],
    ['a T-pose frame', { tposeFrames: 1 }, 'T-pose frames'],
    ['T-pose frames never reported', { tposeFrames: null }, 'T-pose frames'],
    ['too many underruns (stats counter)', { underrunsTotal: 31 }, 'underruns per minute'],
    ['too many underruns (playback reports)', { underrunsFromEnded: 40 }, 'underruns per minute'],
    [
      'an utterance that ended with an error',
      { endReasons: { done: 99, error: 1 } },
      'playback end reasons',
    ],
    [
      'an utterance that timed out on the stage side',
      { endReasons: { done: 99, timeout: 1 } },
      'playback end reasons',
    ],
    [
      'an utterance the run gave up on',
      { endReasons: { done: 99, harness_timeout: 1 } },
      'playback end reasons',
    ],
    ['an aborted send', { endReasons: { done: 99, send_aborted: 1 } }, 'playback end reasons'],
    ['a disconnect', { disconnects: 1 }, 'stage stayed connected'],
    ['a failed dance', { danceFailures: 1 }, 'dances completed'],
    ['no stats at all', { statsReports: 0 }, 'stats reported'],
    ['no utterance played', { utterancesEnded: 0 }, 'utterances played'],
  ] as Array<[string, Partial<ReplayObservations>, string]>)(
    'fails on %s, and only on that',
    (_name, over, check) => {
      expect(failing(over)).toEqual([check])
    }
  )

  it('fails closed when nothing was reported', () => {
    const names = failing({
      statsReports: 0,
      audioContextsCreated: null,
      tposeFrames: null,
      underrunsTotal: null,
    })
    expect(names).toEqual(['stats reported', 'audio contexts created', 'T-pose frames'])
  })

  it('computes underruns per minute over the run and allows exactly the limit', () => {
    expect(failing({ underrunsTotal: 30 })).toEqual([]) // 30 in 10 minutes = 3 per minute
    expect(failing({ underrunsTotal: 31 })).toEqual(['underruns per minute'])
    expect(failing({ underrunsTotal: 7, elapsedMs: 2 * 60_000 })).toEqual(['underruns per minute']) // 3.5 per minute
    expect(failing({ underrunsTotal: 6, elapsedMs: 2 * 60_000 })).toEqual([]) // exactly 3 per minute
    // the larger of the two counters is used
    expect(failing({ underrunsTotal: 0, underrunsFromEnded: 31 })).toEqual(['underruns per minute'])
    expect(failing({ underrunsTotal: null, underrunsFromEnded: 5 })).toEqual([])
  })

  it('does not blow up short runs: the rate is taken over at least one minute', () => {
    expect(failing({ elapsedMs: 10_000, underrunsTotal: 3 })).toEqual([])
    expect(failing({ elapsedMs: 10_000, underrunsTotal: 4 })).toEqual(['underruns per minute'])
    expect(failing({ elapsedMs: 0, underrunsTotal: 0 })).toEqual([])
  })

  it('honours the scenario limits', () => {
    expect(failing({ audioContextsCreated: 2 }, { ...limits, maxAudioContexts: 2 })).toEqual([])
    expect(failing({ tposeFrames: 5 }, { ...limits, maxTposeFrames: 5 })).toEqual([])
    expect(failing({ tposeFrames: 6 }, { ...limits, maxTposeFrames: 5 })).toEqual(['T-pose frames'])
    expect(failing({ underrunsTotal: 100 }, { ...limits, maxUnderrunsPerMinute: 10 })).toEqual([])
    expect(failing({ disconnects: 2 }, { ...limits, maxDisconnects: 2 })).toEqual([])
  })

  it('ignores end reasons with a zero count and only checks stage errors when a limit is set', () => {
    expect(failing({ endReasons: { done: 5, error: 0 } })).toEqual([])
    expect(failing({ stageErrors: 50 })).toEqual([])
    expect(failing({ stageErrors: 1 }, { ...limits, maxStageErrors: 0 })).toEqual(['stage errors'])
    expect(failing({ stageErrors: 2 }, { ...limits, maxStageErrors: 2 })).toEqual([])
    expect(
      evaluateReplay(good, { ...limits, maxStageErrors: 0 }).checks.map((c) => c.name)
    ).toContain('stage errors')
  })

  it('names the offending reasons in the detail', () => {
    const r = evaluateReplay({ ...good, endReasons: { done: 90, error: 2, cancelled: 1 } }, limits)
    const check = r.checks.find((c) => c.name === 'playback end reasons')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('error x2')
    expect(check?.detail).toContain('cancelled x1')
    expect(check?.detail).not.toContain('done')
  })
})

describe('small helpers', () => {
  it('createShuffleBag yields every index once per round, shuffled, never repeating across rounds', () => {
    const next = createShuffleBag(5, seededRandom(1))
    const draws = Array.from({ length: 5 * 200 }, () => next())
    const orders = new Set<string>()
    for (let round = 0; round < 200; round++) {
      const block = draws.slice(round * 5, round * 5 + 5)
      expect([...block].sort()).toEqual([0, 1, 2, 3, 4])
      orders.add(block.join(''))
    }
    for (let i = 1; i < draws.length; i++) expect(draws[i]).not.toBe(draws[i - 1])
    expect(orders.size).toBeGreaterThan(20) // really shuffled, not the same order every time
  })

  it('createShuffleBag with one or two items', () => {
    const one = createShuffleBag(1, seededRandom(2))
    expect([one(), one(), one()]).toEqual([0, 0, 0])
    const two = createShuffleBag(2, seededRandom(3))
    const draws = Array.from({ length: 10 }, () => two())
    for (let i = 1; i < draws.length; i++) expect(draws[i]).not.toBe(draws[i - 1])
    expect(() => createShuffleBag(0, Math.random)).toThrow(RangeError)
    expect(() => createShuffleBag(1.5, Math.random)).toThrow(RangeError)
  })

  it('createShuffleBag survives an RNG that returns the extremes', () => {
    for (const value of [0, 0.999999999, 1]) {
      const next = createShuffleBag(4, () => value)
      const draws = Array.from({ length: 12 }, () => next())
      for (let i = 1; i < draws.length; i++) expect(draws[i]).not.toBe(draws[i - 1])
      expect(draws.every((d) => d >= 0 && d < 4)).toBe(true)
    }
  })

  it('formatElapsed', () => {
    expect(formatElapsed(0)).toBe('00:00:00')
    expect(formatElapsed(59_999)).toBe('00:00:59')
    expect(formatElapsed(61_000)).toBe('00:01:01')
    expect(formatElapsed(3_723_000)).toBe('01:02:03')
    expect(formatElapsed(-5)).toBe('00:00:00')
  })

  it('formatStats prints the counters a soak run is judged by', () => {
    const line = formatStats({
      type: 'stats',
      fps: 59.94,
      frame_ms_p95: 17.26,
      audio_contexts_created: 1,
      audio_contexts_open: 1,
      underruns_total: 2,
      tpose_frames: 0,
      frames_total: 1234,
      models_loaded: 1,
      js_heap_mb: 210.4,
    })
    expect(line).toBe(
      'fps=59.9 p95=17.3ms audio_ctx=1/1 underruns=2 tpose=0/1234 models=1 heap=210MB'
    )
    expect(
      formatStats({
        type: 'stats',
        fps: 60,
        frame_ms_p95: 16,
        audio_contexts_created: 1,
        audio_contexts_open: 0,
        underruns_total: 0,
        tpose_frames: 0,
        frames_total: 1,
        models_loaded: 1,
      })
    ).not.toContain('heap')
  })
})

// ───────────────────────────── the run, against a scripted stage ─────────────────────────────

interface Env {
  dir: string
  raw: Record<string, unknown>
  scenario: ReturnType<typeof parseScenario>
  wavA: Uint8Array
  wavB: Uint8Array
}

function buildEnv(override: Record<string, unknown> = {}): Env {
  const tmp = makeTempDir()
  cleanup.add(() => tmp.remove())
  const wavA = makeToneWav(120, 16000)
  const wavB = makeWav({
    sampleRate: 24000,
    format: 'float32',
    frames: Array.from({ length: 2400 }, (_, i) => [
      Math.sin(i / 10) * 0.5,
      Math.cos(i / 10) * 0.25,
    ]),
  })
  writeTree(tmp.dir, {
    'models/test.vrm': 'placeholder model',
    'motions/idle_loop.vrma': 'x',
    'motions/talk/talk_01.vrma': 'x',
    'motions/poses/nod.vrma': 'x',
    'motions/poses/nod_2.vrma': 'x',
    'motions/dance/x/motion.vrma': 'x',
    'motions/dance/x/music.ogg': 'x',
    'motions/dance/x/meta.json': JSON.stringify({
      title: 'X dance',
      offset: 0.5,
      credit: 'test credit',
    }),
    'wavs/a.wav': wavA,
    'wavs/b.wav': wavB,
  })
  const raw = {
    libraries: { models: 'models', motions: 'motions' },
    model: 'test.vrm',
    utterances: [
      { wav: 'wavs/a.wav', text: 'first line', emotion: 'happy', motion: 'nod' },
      { wav: 'wavs/b.wav', text: 'second line', emotion: 'sad' },
    ],
    gapMs: [5, 10],
    dances: [{ atSeconds: 0.3, name: 'x' }],
    ...override,
  }
  return { dir: tmp.dir, raw, scenario: parseScenario(raw, tmp.dir), wavA, wavB }
}

interface RunExtras {
  fakes?: FakeStage[]
  /** Called when the server is listening; `attach` connects another scripted stage. */
  onServer?: (server: StageServer, attach: (opts?: FakeStageOptions) => Promise<FakeStage>) => void
  /** Do not connect a stage automatically. */
  noStage?: boolean
}

async function run(
  env: Env,
  fakeOpts: FakeStageOptions = {},
  runOpts: Partial<ReplayRunOptions> = {},
  extras: RunExtras = {}
) {
  const out: string[] = []
  const fakes = extras.fakes ?? []
  let server: StageServer | undefined
  let attached: Promise<unknown> = Promise.resolve()
  const attach = (opts: FakeStageOptions = fakeOpts) =>
    FakeStage.connect((server as StageServer).url, opts).then((fake) => {
      fakes.push(fake)
      cleanup.add(() => fake.close())
      return fake
    })
  try {
    const result = await runReplay({
      scenario: env.scenario,
      durationS: 1.2,
      port: 0,
      launch: false,
      stageDir: null,
      out: (line) => out.push(line),
      statsEveryMs: 150,
      random: seededRandom(5),
      timeouts: {
        connectMs: 3000,
        modelMs: 3000,
        endedSlackMs: 1500,
        danceMs: 3000,
        finalStatsMs: 500,
      },
      onServerReady: (s) => {
        server = s
        if (!extras.noStage) attached = attach()
        extras.onServer?.(s, attach)
      },
      ...runOpts,
    })
    await attached
    return { result, error: undefined, out, fakes, server }
  } catch (error) {
    await attached.catch(() => undefined)
    return { result: undefined, error, out, fakes, server }
  }
}

describe('runReplay against a healthy stage', () => {
  it('plays the utterances and the dance, and passes', async () => {
    const env = buildEnv()
    const { result, out, fakes, server, error } = await run(env)
    expect(error).toBeUndefined()
    const fake = fakes[0] as FakeStage
    const r = result as NonNullable<typeof result>

    expect(r.pass).toBe(true)
    expect(r.interrupted).toBe(false)
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(r.observations.utterancesEnded).toBeGreaterThanOrEqual(5)
    expect(r.observations.endReasons).toEqual({ done: r.observations.utterancesEnded })
    expect(r.observations).toMatchObject({
      audioContextsCreated: 1,
      tposeFrames: 0,
      disconnects: 0,
      stageErrors: 0,
      dancesPlayed: 1,
      danceFailures: 0,
    })
    expect(r.observations.statsReports).toBeGreaterThan(3)
    expect(r.checks.every((c) => c.ok)).toBe(true)

    // the stage got the snapshots first: scene, library, look
    expect(fake.stage.jsonTypes().slice(0, 4)).toEqual([
      'welcome',
      'scene.set',
      'library.set',
      'look.set',
    ])
    const scene = fake.stage.json().find((m) => m.type === 'scene.set')
    expect(scene).toMatchObject({
      model: { url: '/asset/models/test.vrm', name: 'test.vrm' },
      layout: { char: { x: 0, y: 0, scale: 1 } },
    })
    const library = fake.stage.json().find((m) => m.type === 'library.set') as unknown as {
      idle: { url: string }
      talk: unknown[]
    }
    expect(library.idle.url).toBe('/asset/motions/idle_loop.vrma')
    expect(library.talk).toHaveLength(1)

    // every utterance: right emotion / text / sample rate, audio bytes identical to the decoded WAV
    const expectedA = decodeWavToPcm16(env.wavA)
    const expectedB = decodeWavToPcm16(env.wavB)
    const begins = fake.begins
    expect(begins.length).toBe(r.observations.utterancesEnded)
    begins.forEach((begin, i) => {
      expect(begin.seq).toBe(i)
      expect(begin.utterance_id).toBe(`replay-${i}`)
      const isA = begin.subtitle === 'first line'
      const source = isA ? expectedA : expectedB
      expect(begin).toMatchObject(
        isA
          ? {
              emotion: 'happy',
              audio: {
                codec: 'pcm16',
                sample_rate: 16000,
                channels: 1,
                total_samples: source.frames,
              },
            }
          : {
              emotion: 'sad',
              motion: null,
              audio: { sample_rate: 24000, total_samples: source.frames },
            }
      )
      expect(
        Buffer.compare(
          Buffer.from(fake.audio.get(`replay-${i}`) as Uint8Array),
          Buffer.from(source.pcm16)
        )
      ).toBe(0)
    })

    // "random order": each line comes up equally often
    const firstCount = begins.filter((b) => b.subtitle === 'first line').length
    expect(Math.abs(firstCount - (begins.length - firstCount))).toBeLessThanOrEqual(1)

    // the motion tag was resolved to a clip url, and the two variants alternate
    const withMotion = begins.filter((b) => b.subtitle === 'first line')
    const motionIds = withMotion.map((b) => (b.motion as { id: string; url: string }).id)
    expect(new Set(motionIds)).toEqual(new Set(['poses:nod', 'poses:nod_2']))
    for (let i = 1; i < motionIds.length; i++) expect(motionIds[i]).not.toBe(motionIds[i - 1])
    for (const b of withMotion)
      expect((b.motion as { url: string }).url).toMatch(/^\/asset\/motions\/poses\/nod(_2)?\.vrma$/)

    // the dance: one dance.play built from the folder and its meta.json, after some speech, followed by more speech
    expect(fake.dances).toHaveLength(1)
    expect(fake.dances[0]).toMatchObject({
      type: 'dance.play',
      dance_id: 'replay-dance-1',
      name: 'x',
      title: 'X dance',
      motion_url: '/asset/motions/dance/x/motion.vrma',
      music_url: '/asset/motions/dance/x/music.ogg',
      offset: 0.5,
      credit: 'test credit',
    })
    const order = fake.stage.received.map((m) => (m.kind === 'json' ? m.msg.type : 'bin'))
    const danceAt = order.indexOf('dance.play')
    expect(
      order.slice(0, danceAt).filter((t) => t === 'utterance.begin').length
    ).toBeGreaterThanOrEqual(2)
    expect(
      order.slice(danceAt).filter((t) => t === 'utterance.begin').length
    ).toBeGreaterThanOrEqual(2)
    // nothing is spoken while the dance runs: the next begin comes after the dance's last state
    expect(fake.cancels.filter((c) => c.scope === 'utterance')).toHaveLength(0)

    // the printed report
    const text = out.join('\n')
    expect(text).toContain('stage server: http://127.0.0.1:')
    expect(text).toContain('model ready, starting the replay')
    expect(text).toContain('stage connected: fake-stage/1.0')
    expect(text).toMatch(/\[\d\d:\d\d:\d\d\] #0 (happy|sad)/)
    expect(text).toContain('dance "x" started')
    expect(text).toContain('dance "x" ended (finished)')
    expect(text).toMatch(
      /stats fps=60\.0 p95=17\.0ms audio_ctx=1\/1 underruns=0 tpose=0\/\d+ models=1/
    )
    expect(text).toMatch(/final stats: fps=60\.0/)
    expect(text).toMatch(/ {2}ok {3}utterances played: \d+ ended/)
    expect(out.at(-1)).toMatch(/^PASS after 00:00:0\d$/)

    // and the server is gone afterwards
    await expect(rawRequest((server as StageServer).port, '/')).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    })
  })

  it('a scenario without dances or motion tags works too, and stops on time', async () => {
    const env = buildEnv({ dances: [], utterances: [{ wav: 'wavs/b.wav' }], gapMs: [0, 0] })
    const started = Date.now()
    const { result, fakes } = await run(env, {}, { durationS: 0.5 })
    expect(result?.pass).toBe(true)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(fakes[0]?.dances).toHaveLength(0)
    expect(fakes[0]?.begins.every((b) => b.motion === null && b.emotion === 'neutral')).toBe(true)
    // a single utterance is never picked twice in a row, but there is nothing else to pick: it repeats
    expect(fakes[0]?.begins.length).toBeGreaterThan(2)
  })

  it('warns once about a motion tag that has no clips and still speaks', async () => {
    const env = buildEnv({ dances: [], utterances: [{ wav: 'wavs/a.wav', motion: 'no-such-tag' }] })
    const { result, out, fakes } = await run(env, {}, { durationS: 0.5 })
    expect(result?.pass).toBe(true)
    expect(out.filter((l) => l.includes('no motion clips for tag "no-such-tag"'))).toHaveLength(1)
    expect(fakes[0]?.begins.every((b) => b.motion === null)).toBe(true)
  })

  it('reports a dance that is scheduled after the end of the run', async () => {
    const env = buildEnv({ dances: [{ atSeconds: 60, name: 'x' }] })
    const { result, out, fakes } = await run(env, {}, { durationS: 0.5 })
    expect(result?.pass).toBe(true)
    expect(out.join('\n')).toContain('will not be played')
    expect(fakes[0]?.dances).toHaveLength(0)
  })

  it('stops cleanly when aborted, and says the run was partial', async () => {
    const env = buildEnv()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 400)
    const started = Date.now()
    const { result, out } = await run(env, {}, { durationS: 60, signal: controller.signal })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(result?.interrupted).toBe(true)
    expect(out.at(-1)).toMatch(/^(PASS|FAIL) \(interrupted, partial run\)/)
  })

  it('an already aborted signal ends the run at once, before anything is started', async () => {
    const env = buildEnv()
    const controller = new AbortController()
    controller.abort()
    let serverStarted = false
    const { result, error, out } = await run(
      env,
      {},
      { durationS: 60, signal: controller.signal },
      { onServer: () => void (serverStarted = true), noStage: true }
    )
    expect(error).toBeUndefined()
    expect(serverStarted).toBe(false)
    expect(result).toMatchObject({ interrupted: true, pass: false, checks: [] })
    expect(out).toEqual(['interrupted before the replay started'])
  })

  it('Ctrl+C while waiting for the stage to connect is a clean stop, not a failure', async () => {
    const env = buildEnv()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const started = Date.now()
    const { result, error, out } = await run(
      env,
      {},
      { durationS: 60, signal: controller.signal },
      { noStage: true }
    )
    expect(error).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result).toMatchObject({ interrupted: true, pass: false, checks: [] })
    expect(out.at(-1)).toBe('interrupted before the replay started')
  })

  it('survives the stage page reloading mid-run: snapshots are re-sent and speaking continues', async () => {
    const env = buildEnv({ dances: [], expect: { maxDisconnects: 1 } })
    const fakes: FakeStage[] = []
    const { result, out } = await run(
      env,
      {},
      { durationS: 1.8 },
      {
        fakes,
        onServer: (_server, attach) => {
          void (async () => {
            await waitUntil(
              () => (fakes[0]?.ended ?? 0) >= 2,
              5000,
              'two utterances on the first page'
            )
            fakes[0]?.terminate() // the page dies without a close frame
            await attach()
          })()
        },
      }
    )
    expect(fakes).toHaveLength(2)
    expect(result?.observations.disconnects).toBe(1)
    expect(result?.pass).toBe(true)
    expect(out.join('\n')).toContain('stage disconnected')
    // the second page got everything a fresh page needs, and carried on speaking
    expect(fakes[1]?.stage.jsonTypes().slice(0, 4)).toEqual([
      'welcome',
      'scene.set',
      'library.set',
      'look.set',
    ])
    expect(fakes[1]?.begins.length).toBeGreaterThan(0)
    // per-session counters: one audio context per page is fine
    expect(result?.observations.audioContextsCreated).toBe(1)
  })

  it('a reload fails the run when the scenario does not allow disconnects', async () => {
    const env = buildEnv({ dances: [] })
    const fakes: FakeStage[] = []
    const { result } = await run(
      env,
      {},
      { durationS: 1.5 },
      {
        fakes,
        onServer: (_server, attach) => {
          void (async () => {
            await waitUntil(() => (fakes[0]?.ended ?? 0) >= 1, 5000, 'an utterance')
            fakes[0]?.terminate()
            await attach()
          })()
        },
      }
    )
    expect(result?.pass).toBe(false)
    expect(result?.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'stage stayed connected',
    ])
  })
})

describe('runReplay against a stage that misbehaves', () => {
  const failedChecks = (r: Awaited<ReturnType<typeof run>>['result']) =>
    (r?.checks ?? []).filter((c) => !c.ok).map((c) => c.name)

  it('FAILs when an utterance ends with anything but done', async () => {
    const { result, out } = await run(
      buildEnv({ dances: [] }),
      { endReason: 'error' },
      { durationS: 0.6 }
    )
    expect(result?.pass).toBe(false)
    expect(failedChecks(result)).toEqual(['playback end reasons'])
    expect(out.join('\n')).toMatch(/FAIL playback end reasons: error x\d+/)
    expect(out.at(-1)).toMatch(/^FAIL after/)
  })

  it('FAILs on T-pose frames', async () => {
    const { result } = await run(
      buildEnv({ dances: [] }),
      { stats: { tpose_frames: 5 } },
      { durationS: 0.6 }
    )
    expect(failedChecks(result)).toEqual(['T-pose frames'])
  })

  it('FAILs on extra audio contexts', async () => {
    const { result } = await run(
      buildEnv({ dances: [] }),
      { stats: { audio_contexts_created: 3 } },
      { durationS: 0.6 }
    )
    expect(failedChecks(result)).toEqual(['audio contexts created'])
  })

  it('FAILs on underruns', async () => {
    const { result } = await run(
      buildEnv({ dances: [] }),
      { underruns: 40, stats: { underruns_total: 100 } },
      { durationS: 0.6 }
    )
    expect(failedChecks(result)).toEqual(['underruns per minute'])
  })

  it('FAILs when a dance ends with an error', async () => {
    const { result, out } = await run(buildEnv(), { danceReason: 'error' }, { durationS: 1 })
    expect(failedChecks(result)).toEqual(['dances completed'])
    expect(out.join('\n')).toContain('dance "x" failed: the fake dance failed')
  })

  it('FAILs when the stage never reports stats (the counters cannot be verified)', async () => {
    const { result } = await run(
      buildEnv({ dances: [] }),
      { sendStats: false },
      { durationS: 0.5, timeouts: { finalStatsMs: 100 } }
    )
    expect(result?.pass).toBe(false)
    expect(failedChecks(result)).toEqual([
      'stats reported',
      'audio contexts created',
      'T-pose frames',
    ])
  })

  it('reports stage error frames, and fails on them only when the scenario says so', async () => {
    const lenient = await run(
      buildEnv({ dances: [] }),
      {},
      { durationS: 0.5 },
      {
        onServer: (_s, attach) => {
          void attach().then((f) =>
            setTimeout(
              () =>
                f.stage.send({
                  type: 'error',
                  code: 'lipsync_profile_missing',
                  message: 'no profile',
                }),
              100
            )
          )
        },
        noStage: true,
      }
    )
    expect(lenient.result?.pass).toBe(true)
    expect(lenient.result?.observations.stageErrors).toBe(1)
    expect(lenient.out.join('\n')).toContain('stage error lipsync_profile_missing: no profile')

    const strict = await run(
      buildEnv({ dances: [], expect: { maxStageErrors: 0 } }),
      {},
      { durationS: 0.5 },
      {
        onServer: (_s, attach) => {
          void attach().then((f) =>
            setTimeout(() => f.stage.send({ type: 'error', code: 'x', message: 'y' }), 100)
          )
        },
        noStage: true,
      }
    )
    expect(failedChecks(strict.result)).toEqual(['stage errors'])
  })

  it('gives up with a clear error when the model cannot be loaded', async () => {
    const { error, result } = await run(buildEnv(), { model: 'error' })
    expect(result).toBeUndefined()
    expect(error).toBeInstanceOf(ReplayError)
    expect((error as Error).message).toMatch(
      /could not load the model: the fake stage could not load the model/
    )
  })

  it('gives up when the model never becomes ready', async () => {
    const { error } = await run(
      buildEnv(),
      { model: 'never' },
      { timeouts: { modelMs: 250, connectMs: 3000 } }
    )
    expect(error).toBeInstanceOf(ReplayError)
    expect((error as Error).message).toMatch(/model was not ready within 0\.25 s/)
  })

  it('gives up when no stage connects', async () => {
    const { error, out } = await run(
      buildEnv(),
      {},
      { timeouts: { connectMs: 200 } },
      { noStage: true }
    )
    expect(error).toBeInstanceOf(ReplayError)
    expect((error as Error).message).toMatch(/did not connect within 0\.2 s/)
    expect(out.join('\n')).toContain('open http://127.0.0.1:')
  })

  it('gives up after three utterances in a row that the stage never finished', async () => {
    const started = Date.now()
    const { error, out, fakes } = await run(
      buildEnv({ dances: [] }),
      { answerUtterances: false },
      { durationS: 30, timeouts: { endedSlackMs: 100 } }
    )
    expect(error).toBeInstanceOf(ReplayError)
    expect((error as Error).message).toMatch(/3 utterances in a row failed \(last: harness_timeout/)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(out.filter((l) => l.includes('harness_timeout'))).toHaveLength(3)
    // each failure cancels what the stage may still be holding
    expect(fakes[0]?.cancels.filter((c) => c.scope === 'all').length).toBeGreaterThanOrEqual(3)
  })

  it('a single missed playback.ended does not end the run, but it fails the verdict', async () => {
    const env = buildEnv({ dances: [] })
    let skipped = 0
    const fakes: FakeStage[] = []
    const { result, error } = await run(
      env,
      {},
      { durationS: 1.5, timeouts: { endedSlackMs: 150 } },
      {
        fakes,
        onServer: (_s, attach) => {
          void attach().then((fake) => {
            // swallow the answer to the first utterance only
            const original = fake.stage.send.bind(fake.stage)
            fake.stage.send = (msg: unknown) => {
              const m = msg as { type?: string }
              if (m.type === 'playback.ended' && skipped === 0) {
                skipped++
                return
              }
              original(msg)
            }
          })
        },
        noStage: true,
      }
    )
    expect(error).toBeUndefined()
    expect(skipped).toBe(1)
    expect(result?.observations.endReasons.harness_timeout).toBe(1)
    expect(result?.observations.utterancesEnded).toBeGreaterThan(2)
    expect(failedChecks(result)).toEqual(['playback end reasons'])
    expect(fakes[0]).toBeDefined()
  })
})

describe('runReplay validates before it starts anything', () => {
  const rejects = async (env: Env, runOpts: Partial<ReplayRunOptions> = {}) => {
    let started = false
    const r = await run(env, {}, runOpts, { onServer: () => void (started = true), noStage: true })
    expect(started, 'the server must not have been started').toBe(false)
    return r.error as Error
  }

  it('a dance that does not exist', async () => {
    const err = await rejects(buildEnv({ dances: [{ atSeconds: 1, name: 'nope' }] }))
    expect(err).toBeInstanceOf(ScenarioError)
    expect(err.message).toMatch(/dance "nope" not found/)
    expect(err.message).toMatch(/found: x/)
  })

  it('a model that is not in the library, or a path that tries to leave it', async () => {
    const missing = await rejects(buildEnv({ model: 'other.vrm' }))
    expect(missing).toBeInstanceOf(ScenarioError)
    expect(missing.message).toMatch(/model file not found/)
    for (const model of [
      '../secret.vrm',
      '..\\secret.vrm',
      '/etc/passwd',
      'C:\\x.vrm',
      'a//b.vrm',
      '.hidden.vrm',
    ]) {
      const err = await rejects(buildEnv({ model }))
      expect(err, model).toBeInstanceOf(ScenarioError)
      expect(err.message, model).toMatch(/not a safe relative path/)
    }
  })

  it('a motions folder that does not exist', async () => {
    const env = buildEnv()
    fs.rmSync(path.join(env.dir, 'motions'), { recursive: true, force: true })
    const err = await rejects(env)
    expect(err).toBeInstanceOf(ScenarioError)
    expect(err.message).toMatch(/motion library folder not found/)
  })

  it('a WAV that cannot be decoded', async () => {
    const env = buildEnv()
    fs.writeFileSync(path.join(env.dir, 'wavs', 'b.wav'), 'garbage')
    const err = await rejects(env)
    expect(err).toBeInstanceOf(ScenarioError)
    expect(err.message).toMatch(/b\.wav/)
  })

  it('a browser profile without the marker, when launching', async () => {
    const env = buildEnv({ browser: { executable: process.execPath, profileDir: 'plain-profile' } })
    const err = await rejects(env, { launch: true })
    expect(err).toBeInstanceOf(ScenarioError)
    expect(err.message).toMatch(/animatus-stage/)
    // not launching: the browser section is ignored
    const ok = await run(env, {}, { launch: false, durationS: 0.3 })
    expect(ok.error).toBeUndefined()
  })

  it('a duration that is not positive', async () => {
    const err = await rejects(buildEnv(), { durationS: 0 })
    expect(err).toBeInstanceOf(ScenarioError)
    expect((await rejects(buildEnv(), { durationS: -1 })).message).toMatch(/greater than zero/)
  })

  it('a port that is already taken', async () => {
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    cleanup.add(() => new Promise<void>((resolve) => blocker.close(() => resolve())))
    const port = (blocker.address() as net.AddressInfo).port
    const { error } = await run(buildEnv(), {}, { port }, { noStage: true })
    expect(error).toBeInstanceOf(ReplayError)
    expect((error as Error).message).toMatch(new RegExp(`port ${port} is already in use`))
  })
})

// ───────────────────────────── the command line ─────────────────────────────

function captureConsole() {
  const lines: string[] = []
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')))
  const err = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')))
  cleanup.add(() => {
    log.mockRestore()
    err.mockRestore()
  })
  return lines
}

describe('main (the command line)', () => {
  it('prints the usage for --help and exits 0', async () => {
    const lines = captureConsole()
    expect(await main(['--help'])).toBe(0)
    expect(lines.join('\n')).toMatch(/usage: npm run replay/)
    expect(lines.join('\n')).toMatch(/--duration/)
    expect(lines.join('\n')).toMatch(/--no-launch/)
    expect(lines.join('\n')).toMatch(/--port/)
  })

  it.each([
    ['no scenario', []],
    ['two scenarios', ['a.json', 'b.json']],
    ['an unknown flag', ['a.json', '--bogus']],
    ['a duration that is not a number', ['a.json', '--duration', 'abc']],
    ['a zero duration', ['a.json', '--duration', '0']],
    ['a negative duration', ['a.json', '--duration', '-5']],
    ['a port that is too large', ['a.json', '--port', '70000']],
    ['a port that is not a number', ['a.json', '--port', 'abc']],
    ['a fractional port', ['a.json', '--port', '1.5']],
  ])('exits 2 for %s', async (_name, argv) => {
    const lines = captureConsole()
    expect(await main(argv)).toBe(2)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('exits 2 with a message for an unreadable file, bad JSON, a bad scenario and a missing library folder', async () => {
    const tmp = makeTempDir()
    cleanup.add(() => tmp.remove())
    writeTree(tmp.dir, {
      'bad.json': '{ not json',
      'invalid.json': JSON.stringify({ libraries: {} }),
      'nofolder.json': JSON.stringify({
        libraries: { models: 'nope-models', motions: 'nope-motions' },
        model: 'a.vrm',
        utterances: [{ wav: 'a.wav' }],
      }),
    })
    const cases: Array<[string, RegExp]> = [
      [path.join(tmp.dir, 'missing.json'), /cannot read/],
      [path.join(tmp.dir, 'bad.json'), /cannot read/],
      [path.join(tmp.dir, 'invalid.json'), /invalid scenario/],
      [path.join(tmp.dir, 'nofolder.json'), /library "models" is not a folder/],
    ]
    for (const [file, message] of cases) {
      const lines = captureConsole()
      expect(await main([file])).toBe(2)
      expect(lines.join('\n')).toMatch(message)
    }
  })

  it('finds a relative scenario path from the folder the command was typed in (INIT_CWD under npm)', async () => {
    const tmp = makeTempDir()
    cleanup.add(() => tmp.remove())
    writeTree(tmp.dir, { 'here.json': JSON.stringify({ libraries: {} }) })
    vi.stubEnv('INIT_CWD', tmp.dir)
    cleanup.add(() => void vi.unstubAllEnvs())
    const lines = captureConsole()
    expect(await main(['here.json'])).toBe(2)
    // it was found (and then rejected as an invalid scenario), not reported as unreadable
    expect(lines.join('\n')).toMatch(/invalid scenario/)
    expect(lines.join('\n')).not.toMatch(/cannot read/)
  })

  it('runs a scenario end to end: prints the URL, waits for the stage, exits 0 on PASS', async () => {
    const env = buildEnv({ dances: [] })
    const file = path.join(env.dir, 'scenario.json')
    fs.writeFileSync(file, JSON.stringify(env.raw))
    const lines = captureConsole()

    const exit = main([file, '--no-launch', '--port', '0', '--duration', '0.6'])
    await waitUntil(
      () => lines.some((l) => l.startsWith('stage server: ')),
      5000,
      'the server URL to be printed'
    )
    const url = (lines.find((l) => l.startsWith('stage server: ')) as string)
      .slice('stage server: '.length)
      .trim()
    const fake = await FakeStage.connect(url)
    cleanup.add(() => fake.close())

    expect(await exit).toBe(0)
    expect(lines.join('\n')).toMatch(/PASS after/)
    expect(fake.begins.length).toBeGreaterThan(0)
  })

  it('exits 1 when the run FAILs', async () => {
    const env = buildEnv({ dances: [] })
    const file = path.join(env.dir, 'scenario.json')
    fs.writeFileSync(file, JSON.stringify(env.raw))
    const lines = captureConsole()

    const exit = main([file, '--no-launch', '--port', '0', '--duration', '0.6'])
    await waitUntil(
      () => lines.some((l) => l.startsWith('stage server: ')),
      5000,
      'the server URL to be printed'
    )
    const url = (lines.find((l) => l.startsWith('stage server: ')) as string)
      .slice('stage server: '.length)
      .trim()
    const fake = await FakeStage.connect(url, { endReason: 'error' })
    cleanup.add(() => fake.close())

    expect(await exit).toBe(1)
    expect(lines.join('\n')).toMatch(/FAIL after/)
  })
})
