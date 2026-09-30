import { describe, expect, it } from 'vitest'
import {
  AssetUrl,
  LookSet,
  MAX_UPSTREAM_BYTES,
  PROTOCOL_VERSION,
  StageDownstream,
  StageUpstream,
  parseDownstream,
  parseUpstream,
} from '../src/index.ts'

const ok = (v: unknown) => StageDownstream.safeParse(v).success

describe('AssetUrl', () => {
  it('accepts same-origin /asset/ paths', () => {
    expect(AssetUrl.safeParse('/asset/motion/nod.vrma').success).toBe(true)
    expect(AssetUrl.safeParse('/asset/dance/x/music.ogg?v=3').success).toBe(true)
  })
  it.each([
    'http://evil.example/asset/x.vrma',
    '//evil.example/asset/x',
    '/other/x.vrma',
    '/asset/',
    '/asset/../etc/passwd',
    '/asset/a/../../b',
    '/asset/a/./b',
    'asset/x',
    'file:///c:/x',
    'data:audio/wav;base64,AAAA',
  ])('rejects %s', (u) => {
    expect(AssetUrl.safeParse(u).success).toBe(false)
  })
})

describe('downstream messages', () => {
  it('accepts a minimal scene.set and fills defaults', () => {
    const r = StageDownstream.parse({
      type: 'scene.set',
      model: { url: '/asset/model/a.vrm' },
      layout: { char: { x: 0, y: 0, scale: 1 } },
      background: { kind: 'none' },
    })
    if (r.type !== 'scene.set') throw new Error('wrong type')
    expect(r.lighting.intensity).toBe(1)
    expect(r.camera.fov).toBe(20)
    expect(r.camera.follow_head).toBe(true)
    expect(r.camera.fit).toBe('none')
    expect(r.layout.frame).toBeNull()
  })

  it('camera fit is a closed set that a partial camera object can omit', () => {
    const scene = (camera: unknown) =>
      StageDownstream.safeParse({
        type: 'scene.set',
        model: null,
        layout: { char: { x: 0, y: 0, scale: 1 } },
        background: { kind: 'none' },
        camera,
      })
    const ok = scene({ fit: 'upper_body' })
    expect(ok.success && ok.data.type === 'scene.set' && ok.data.camera.fit).toBe('upper_body')
    expect(scene({ fov: 30 }).success).toBe(true)
    expect(scene({ fit: 'closeup' }).success).toBe(false)
  })

  it('look.set with no fields yields the neutral look', () => {
    expect(LookSet.parse({ type: 'look.set' })).toEqual({
      type: 'look.set',
      light: 1,
      mouth_scale: 1,
      calm: 0,
      motion_scale: 1,
      lip_range: null,
      dim: 0,
    })
  })

  it('accepts utterance.begin with and without a body motion', () => {
    const base = {
      type: 'utterance.begin',
      utterance_id: 'u-1',
      seq: 0,
      handle: 1,
      emotion: 'happy',
      audio: { codec: 'pcm16', sample_rate: 32000, channels: 1 },
    }
    expect(ok(base)).toBe(true)
    expect(ok({ ...base, motion: { id: 'nod_2', url: '/asset/motion/nod_2.vrma' } })).toBe(true)
    expect(ok({ ...base, motion: { id: 'x', url: 'https://evil/x.vrma' } })).toBe(false)
    expect(ok({ ...base, emotion: 'whisper' })).toBe(false)
    expect(ok({ ...base, audio: { ...base.audio, channels: 2 } })).toBe(false)
    expect(ok({ ...base, handle: -1 })).toBe(false)
    expect(ok({ ...base, handle: 2 ** 32 })).toBe(false)
  })

  it('accepts dance, sing and sleep commands', () => {
    expect(
      ok({
        type: 'dance.play',
        dance_id: 'd1',
        name: 'x',
        title: 'X',
        motion_url: '/asset/dance/x/motion.vrma',
        music_url: null,
      })
    ).toBe(true)
    expect(
      ok({
        type: 'sing.play',
        song_id: 's1',
        title: 'T',
        vocals_url: '/asset/song/1/v.wav',
        inst_url: '/asset/song/1/i.wav',
        lyrics: [{ t: 1.5, text: 'la' }],
      })
    ).toBe(true)
    expect(ok({ type: 'sleep.play', track_id: 't1', url: '/asset/asmr/a.mp3' })).toBe(true)
    expect(ok({ type: 'sleep.stop' })).toBe(true)
  })

  it('rejects unknown message types and bad values', () => {
    expect(ok({ type: 'eval', code: '1+1' })).toBe(false)
    expect(ok({ type: 'dance.stop', fade_s: 99 })).toBe(false)
    expect(ok({ type: 'overlay.set', id: 'unknown', visible: true })).toBe(false)
    expect(ok({ type: 'overlay.set', id: 'credit', visible: true, text: 'x'.repeat(2001) })).toBe(
      false
    )
  })

  it('parseDownstream returns null instead of throwing', () => {
    expect(parseDownstream('not json')).toBeNull()
    expect(parseDownstream('{"type":"nope"}')).toBeNull()
    expect(parseDownstream('{"type":"ping","t":1}')).toEqual({ type: 'ping', t: 1 })
  })
})

describe('upstream is a closed set of reports', () => {
  it('accepts playback reports', () => {
    expect(
      parseUpstream(
        JSON.stringify({
          type: 'playback.started',
          utterance_id: 'u1',
          seq: 0,
          audio_time_s: 1.2,
          perf_ms: 5,
        })
      )
    ).not.toBeNull()
    expect(
      parseUpstream(
        JSON.stringify({
          type: 'playback.ended',
          utterance_id: 'u1',
          seq: 0,
          reason: 'done',
          underruns: 0,
          played_ms: 1800,
        })
      )
    ).not.toBeNull()
  })

  it('accepts hello and fills capabilities', () => {
    const h = parseUpstream(
      JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, stage_id: 'abc' })
    )
    expect(h).not.toBeNull()
    expect(h?.type).toBe('hello')
  })

  it('rejects every downstream command shape (a stage can never command the orchestrator)', () => {
    const commands = [
      {
        type: 'dance.play',
        dance_id: 'd',
        name: 'n',
        title: 't',
        motion_url: '/asset/x.vrma',
        music_url: null,
      },
      { type: 'utterance.cancel', scope: 'all' },
      {
        type: 'scene.set',
        model: null,
        layout: { char: { x: 0, y: 0, scale: 1 } },
        background: { kind: 'none' },
      },
      { type: 'sleep.stop' },
      { type: 'debug.request', request_id: 'r', op: 'stats' },
      { type: 'exec', cmd: 'calc' },
    ]
    for (const c of commands) expect(StageUpstream.safeParse(c).success).toBe(false)
  })

  it('drops oversized frames and invalid json without throwing', () => {
    expect(parseUpstream('x'.repeat(MAX_UPSTREAM_BYTES + 1))).toBeNull()
    expect(parseUpstream('{oops')).toBeNull()
    expect(parseUpstream('null')).toBeNull()
  })

  it('validates stats counters', () => {
    const good = {
      type: 'stats',
      fps: 60,
      frame_ms_p95: 17,
      audio_contexts_created: 1,
      audio_contexts_open: 1,
      underruns_total: 0,
      tpose_frames: 0,
      frames_total: 1000,
      models_loaded: 1,
    }
    expect(StageUpstream.safeParse(good).success).toBe(true)
    expect(StageUpstream.safeParse({ ...good, tpose_frames: -1 }).success).toBe(false)
  })
})
