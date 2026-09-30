import { afterEach, describe, expect, it } from 'vitest'
import { FrameKind, PROTOCOL_VERSION, StageDownstream } from '@animatus/protocol'
import type { StageUpstream } from '@animatus/protocol'
import { StageHub, StageSendError, StageWaitError } from '../../src/stage/hub.ts'
import type {
  Report,
  SceneSetInput,
  StageDisconnectInfo,
  StageHubOptions,
} from '../../src/stage/hub.ts'
import {
  collectLogger,
  createCleanup,
  delay,
  pcmPattern,
  waitUntil,
} from '../_stage-support/fixtures.ts'
import { TestStage, startBareHub } from '../_stage-support/stage-client.ts'
import type { BareHub, StageClientOptions } from '../_stage-support/stage-client.ts'

const cleanup = createCleanup()
afterEach(() => cleanup.run())

async function setup(
  options: StageHubOptions = {},
  onConnection?: Parameters<typeof startBareHub>[1]
): Promise<BareHub> {
  const bare = await startBareHub(options, onConnection)
  cleanup.add(() => bare.close())
  return bare
}

async function connect(bare: BareHub, opts?: StageClientOptions): Promise<TestStage> {
  const stage = await TestStage.connect(bare.url, opts)
  cleanup.add(() => stage.close())
  return stage
}

async function connectAndHello(
  bare: BareHub,
  opts: StageClientOptions & { hello?: Record<string, unknown> } = {}
): Promise<TestStage> {
  const stage = await connect(bare, opts)
  stage.hello(opts.hello)
  await stage.waitForJson('welcome')
  return stage
}

const scene: SceneSetInput = {
  type: 'scene.set',
  model: { url: '/asset/models/a.vrm' },
  layout: { char: { x: 0, y: 0, scale: 1 } },
  background: { kind: 'none' },
}

const validStats = {
  type: 'stats',
  fps: 60,
  frame_ms_p95: 17,
  audio_contexts_created: 1,
  audio_contexts_open: 1,
  underruns_total: 0,
  tpose_frames: 0,
  frames_total: 100,
  models_loaded: 1,
}

const MiB = 1024 * 1024

describe('handshake and snapshots', () => {
  it('replies to hello with welcome, then the stored snapshots in a fixed order', async () => {
    const bare = await setup({ dev: true, epoch: 3 })
    const { hub } = bare
    // stored in a deliberately scrambled order
    hub.setOverlay({ type: 'overlay.set', id: 'notice', visible: true, text: 'n' })
    hub.setTuning({ type: 'tuning.set', motion: { speed: 2 } })
    hub.setOverlay({ type: 'overlay.set', id: 'credit', visible: true, text: 'c' })
    hub.setLook({ type: 'look.set', calm: 0.25 })
    hub.setLibrary({
      type: 'library.set',
      idle: null,
      talk: [{ id: 'talk:a', url: '/asset/motions/talk/a.vrma' }],
    })
    hub.setScene(scene)

    const stage = await connect(bare)
    await stage.settle()
    expect(stage.received).toHaveLength(0) // nothing is sent before hello
    stage.hello()
    await stage.waitFor(() => stage.json().length >= 7)
    await stage.settle()

    expect(stage.jsonTypes()).toEqual([
      'welcome',
      'scene.set',
      'library.set',
      'look.set',
      'tuning.set',
      'overlay.set',
      'overlay.set',
    ])
    const [welcome, , , look, , overlayA, overlayB] = stage.json()
    expect(welcome).toMatchObject({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      epoch: 3,
      dev: true,
    })
    expect(welcome?.session_id).toMatch(/^[A-Za-z0-9._:@-]+$/)
    expect(Math.abs((welcome?.server_time_ms as number) - Date.now())).toBeLessThan(5000)
    expect(look).toMatchObject({ calm: 0.25, light: 1 })
    expect([overlayA?.id, overlayB?.id]).toEqual(['credit', 'notice'])
    for (const m of stage.json()) expect(StageDownstream.safeParse(m).success).toBe(true)
    expect(hub.state.connected).toBe(true)
    expect(hub.state.hello?.stage_id).toBe('test-stage')
    expect(hub.state.sessionId).toBe(welcome?.session_id)
  })

  it('sends only the snapshots that were stored', async () => {
    const bare = await setup()
    const stage = await connectAndHello(bare)
    await stage.settle()
    expect(stage.jsonTypes()).toEqual(['welcome'])
  })

  it('re-sends snapshots on reconnect and broadcasts updates while connected', async () => {
    const bare = await setup()
    const { hub } = bare
    hub.setScene(scene)
    hub.setLook({ type: 'look.set', calm: 0.1 })

    const first = await connectAndHello(bare)
    await first.waitFor(() => first.jsonTypes().includes('look.set'))
    hub.setLook({ type: 'look.set', calm: 0.9 }) // live update
    await first.waitFor(() => first.json().filter((m) => m.type === 'look.set').length === 2)
    expect(
      first
        .json()
        .filter((m) => m.type === 'look.set')
        .at(-1)
    ).toMatchObject({ calm: 0.9 })

    first.close()
    await waitUntil(() => !hub.state.connected, 3000, 'the first stage to disconnect')

    const second = await connectAndHello(bare)
    await second.waitFor(() => second.jsonTypes().includes('look.set'))
    await second.settle()
    expect(second.jsonTypes()).toEqual(['welcome', 'scene.set', 'look.set'])
    expect(second.json()[2]).toMatchObject({ calm: 0.9 }) // the latest value, not the first one
    expect(second.json()[0]?.session_id).not.toBe(first.json()[0]?.session_id)
  })

  it('validates snapshots, fills defaults and keeps the previous value on a bad one', async () => {
    const bare = await setup()
    const { hub } = bare
    const parsed = hub.setLook({ type: 'look.set' })
    expect(parsed).toEqual({
      type: 'look.set',
      light: 1,
      mouth_scale: 1,
      calm: 0,
      motion_scale: 1,
      lip_range: null,
      dim: 0,
    })
    expect(() => hub.setScene({ ...scene, model: { url: 'http://evil.example/a.vrm' } })).toThrow()
    expect(() =>
      hub.setLibrary({ type: 'library.set', idle: { id: 'x y', url: '/asset/a.vrma' } })
    ).toThrow()
    expect(() =>
      hub.setOverlay({ type: 'overlay.set', id: 'bogus' as never, visible: true })
    ).toThrow()
    expect(hub.snapshots.scene).toBeUndefined()
    hub.setScene(scene)
    expect(() =>
      hub.setScene({ ...scene, model: null, layout: { char: { x: 999, y: 0, scale: 1 } } })
    ).toThrow()
    expect(hub.snapshots.scene?.model?.url).toBe('/asset/models/a.vrm')
  })

  it('send() validates, reports whether a stage got the frame and routes snapshots to the store', async () => {
    const bare = await setup()
    const { hub } = bare
    expect(hub.send({ type: 'ping', t: 1 })).toBe(false) // no stage yet
    const stage = await connectAndHello(bare)
    expect(hub.send({ type: 'ping', t: 1 })).toBe(true)
    await stage.waitForJson('ping')

    expect(() => hub.send({ type: 'eval', code: '1' } as never)).toThrow()
    expect(() => hub.send({ type: 'dance.stop', fade_s: 99 })).toThrow()
    expect(() =>
      hub.send({ type: 'welcome', protocol: 1, session_id: 'x', epoch: 0, server_time_ms: 0 })
    ).toThrow(/handshake/)

    expect(hub.send({ type: 'look.set', calm: 1 })).toBe(true)
    expect(hub.snapshots.look?.calm).toBe(1) // stored, so a reloaded page gets it too
    await stage.waitForJson('look.set')
  })

  it('a second hello on a live session refreshes the state without a second welcome', async () => {
    const bare = await setup()
    const stage = await connectAndHello(bare)
    stage.hello({ ua: 'second' })
    await waitUntil(() => bare.hub.state.hello?.ua === 'second')
    await stage.settle()
    expect(stage.jsonTypes().filter((t) => t === 'welcome')).toHaveLength(1)
  })
})

describe('rejecting bad connections', () => {
  it('rejects a wrong protocol version with an error frame and 1008', async () => {
    const bare = await setup()
    const connected: unknown[] = []
    bare.hub.on('connected', (info) => connected.push(info))
    const stage = await connect(bare)
    stage.hello({ protocol: PROTOCOL_VERSION + 1 })
    const closed = await stage.waitClosed()
    expect(closed.code).toBe(1008)
    expect(stage.json()).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'protocol_mismatch',
        message: expect.stringContaining('protocol'),
      }),
    ])
    expect(bare.hub.state.connected).toBe(false)
    expect(connected).toHaveLength(0)
  })

  it.each([
    ['a report that is not hello', () => JSON.stringify({ type: 'pong', t: 1 })],
    ['invalid json', () => '{nope'],
    ['a hello without stage_id', () => JSON.stringify({ type: 'hello', protocol: 1 })],
    ['a downstream command', () => JSON.stringify({ type: 'scene.set', model: null })],
  ])('rejects %s as the first message', async (_name, payload) => {
    const bare = await setup()
    const stage = await connect(bare)
    stage.sendRaw(payload())
    const closed = await stage.waitClosed()
    expect(closed.code).toBe(1008)
    expect(stage.json()[0]).toMatchObject({ type: 'error', code: 'bad_hello' })
    expect(bare.hub.state.connected).toBe(false)
  })

  it('rejects a binary frame as the first message', async () => {
    const bare = await setup()
    const stage = await connect(bare)
    stage.sendRaw(new Uint8Array([1, 2, 3]))
    expect((await stage.waitClosed()).code).toBe(1008)
  })

  it('closes a socket that never says hello, but not one that does', async () => {
    const bare = await setup({ helloTimeoutMs: 120 })
    const silent = await connect(bare)
    const polite = await connect(bare)
    polite.hello()
    await polite.waitForJson('welcome')
    const closed = await silent.waitClosed()
    expect(closed.code).toBe(1008)
    expect(silent.json()[0]).toMatchObject({ type: 'error', code: 'hello_timeout' })
    await polite.settle(200)
    expect(polite.closeInfo).toBeNull()
    expect(bare.hub.state.connected).toBe(true)
  })

  it('a newer stage replaces the current one (1000 replaced) and gets the snapshots', async () => {
    const bare = await setup()
    const { hub } = bare
    hub.setScene(scene)
    const events: string[] = []
    const infos: StageDisconnectInfo[] = []
    hub.on('connected', () => events.push('connected'))
    hub.on('disconnected', (info) => {
      events.push('disconnected')
      infos.push(info)
    })

    const first = await connectAndHello(bare)
    const second = await connectAndHello(bare)

    const closed = await first.waitClosed()
    expect(closed).toEqual({ code: 1000, reason: 'replaced' })
    await second.waitFor(() => second.jsonTypes().includes('scene.set'))
    expect(second.jsonTypes().slice(0, 2)).toEqual(['welcome', 'scene.set'])
    expect(hub.state.connected).toBe(true)
    expect(hub.state.sessionId).toBe(second.json()[0]?.session_id)
    expect(events).toEqual(['connected', 'disconnected', 'connected'])
    expect(infos[0]).toMatchObject({ code: 1000, reason: 'replaced', replaced: true })
    expect(hub.counters.replaced).toBe(1)

    // commands now go to the new stage only
    hub.send({ type: 'ping', t: 5 })
    await second.waitForJson('ping')
    expect(first.jsonTypes()).not.toContain('ping')
  })

  it('a connection that has not said hello does not push out the current stage', async () => {
    const bare = await setup()
    const current = await connectAndHello(bare)
    const lurker = await connect(bare)
    await lurker.settle(150)
    expect(current.closeInfo).toBeNull()
    expect(bare.hub.state.sessionId).toBe(current.json()[0]?.session_id)
    lurker.close()
  })

  it('ignores attach() on a socket that is not open', async () => {
    const { logger, has } = collectLogger()
    const hub = new StageHub({ logger })
    expect(() => hub.attach({ readyState: 3 } as never)).not.toThrow()
    expect(has('warn', 'not open')).toBe(true)
  })

  it('logs socket errors instead of crashing', async () => {
    const { logger, has } = collectLogger()
    const bare = await setup({ logger })
    await connectAndHello(bare)
    expect(() =>
      bare.sockets[0]?.emit('error', new Error('synthetic socket failure'))
    ).not.toThrow()
    expect(has('warn', 'socket error')).toBe(true)
  })
})

describe('upstream reports', () => {
  it('drops invalid text frames, downstream-shaped commands and binary frames, and counts them', async () => {
    const bare = await setup()
    const { hub } = bare
    const stage = await connectAndHello(bare)
    const reports: StageUpstream[] = []
    hub.on('report', (r) => reports.push(r))

    stage.sendRaw('not json')
    stage.send({
      type: 'dance.play',
      dance_id: 'd',
      name: 'n',
      title: 't',
      motion_url: '/asset/x.vrma',
      music_url: null,
    })
    stage.send({ type: 'utterance.cancel', scope: 'all' })
    stage.send({ type: 'stats', fps: 'fast' })
    stage.sendRaw(new Uint8Array([1, 2, 3]))
    await waitUntil(
      () => hub.counters.invalidFramesIn === 4 && hub.counters.binaryFramesIn === 1,
      3000,
      'the junk to be counted'
    )
    expect(reports).toHaveLength(0)
    expect(stage.closeInfo).toBeNull()

    stage.send(validStats) // valid frames still work afterwards
    await waitUntil(() => reports.length === 1)
    expect(hub.state.stats?.fps).toBe(60)
    expect(hub.state.connected).toBe(true)
  })

  it('closes the socket with 1008 after 20 invalid frames', async () => {
    const bare = await setup()
    const infos: StageDisconnectInfo[] = []
    bare.hub.on('disconnected', (i) => infos.push(i))
    const stage = await connectAndHello(bare)
    for (let i = 0; i < 19; i++) stage.sendRaw('junk')
    await waitUntil(() => bare.hub.counters.invalidFramesIn === 19)
    await stage.settle(100)
    expect(stage.closeInfo).toBeNull()

    stage.sendRaw('junk')
    const closed = await stage.waitClosed()
    expect(closed).toEqual({ code: 1008, reason: 'too many invalid frames' })
    await waitUntil(() => infos.length === 1)
    expect(infos[0]).toMatchObject({
      code: 1008,
      reason: 'too many invalid frames',
      replaced: false,
    })
    expect(bare.hub.state.connected).toBe(false)
  })

  it('counts invalid frames per minute: old ones age out', async () => {
    let clock = 1_000_000
    const bare = await setup({ now: () => clock, pingIntervalMs: 60_000 })
    const stage = await connectAndHello(bare)
    for (let i = 0; i < 19; i++) stage.sendRaw('junk')
    await waitUntil(() => bare.hub.counters.invalidFramesIn === 19)

    clock += 61_000
    for (let i = 0; i < 19; i++) stage.sendRaw('junk')
    await waitUntil(() => bare.hub.counters.invalidFramesIn === 38)
    await stage.settle(100)
    expect(stage.closeInfo).toBeNull() // 38 invalid frames overall, but never 20 inside one minute

    stage.sendRaw('junk') // 20th inside the current minute
    expect((await stage.waitClosed()).code).toBe(1008)
  })

  it('updates the latest state and emits typed events for every report', async () => {
    let clock = 5000
    const bare = await setup({ now: () => clock })
    const { hub } = bare
    const hellos: Report<'hello'>[] = []
    hub.on('hello', (m) => hellos.push(m))
    const connectedInfo: string[] = []
    hub.on('connected', (i) => connectedInfo.push(i.hello.stage_id))

    const stage = await connectAndHello(bare, { hello: { stage_id: 'page-1', ua: 'ua-1' } })
    expect(hellos.map((h) => h.stage_id)).toEqual(['page-1'])
    expect(connectedInfo).toEqual(['page-1'])

    const got: Record<string, unknown> = {}
    hub.on('model.state', (m) => (got.model = m))
    hub.on('audio.state', (m) => (got.audio = m))
    hub.on('playback.started', (m) => (got.started = m))
    hub.on('playback.ended', (m) => (got.ended = m))
    hub.on('dance.state', (m) => (got.dance = m))
    hub.on('sing.state', (m) => (got.sing = m))
    hub.on('sleep.state', (m) => (got.sleep = m))
    hub.on('stats', (m) => (got.stats = m))
    hub.on('debug.reply', (m) => (got.debug = m))
    hub.on('stage.error', (m) => (got.stageError = m))
    const all: string[] = []
    hub.on('report', (r) => all.push(r.type))

    clock = 9000
    const frames = [
      {
        type: 'model.state',
        status: 'ready',
        url: '/asset/models/a.vrm',
        info: {
          vrm_version: '0',
          blend_shapes: 52,
          arkit_blink: true,
          vrm_blink: true,
          spring_joints: 10,
        },
      },
      {
        type: 'audio.state',
        state: 'running',
        sample_rate: 48000,
        base_latency: 0.01,
        output_latency: 0.02,
        contexts_created: 1,
        contexts_open: 1,
      },
      { type: 'playback.started', utterance_id: 'u1', seq: 0, audio_time_s: 1.5, perf_ms: 10 },
      {
        type: 'playback.ended',
        utterance_id: 'u1',
        seq: 0,
        reason: 'done',
        underruns: 0,
        played_ms: 1200,
      },
      { type: 'dance.state', dance_id: 'd1', phase: 'idle', reason: 'finished' },
      { type: 'sing.state', song_id: 's1', phase: 'playing' },
      { type: 'sleep.state', track_id: 't1', phase: 'paused' },
      validStats,
      { type: 'error', code: 'lipsync_profile_missing', message: 'no profile' },
      { type: 'debug.reply', request_id: 'r1', ok: true },
      { type: 'pong', t: 5 },
    ]
    for (const f of frames) stage.send(f)
    await waitUntil(() => all.length === frames.length, 3000, 'all reports')

    expect(all).toEqual(frames.map((f) => f.type)) // arrival order is preserved
    expect(Object.keys(got).sort()).toEqual(
      [
        'audio',
        'dance',
        'debug',
        'ended',
        'model',
        'sing',
        'sleep',
        'stageError',
        'started',
        'stats',
      ].sort()
    )
    expect(hub.state.model?.status).toBe('ready')
    expect(hub.state.audio?.contexts_created).toBe(1)
    expect(hub.state.stats?.frames_total).toBe(100)
    expect(hub.state.dance?.phase).toBe('idle')
    expect(hub.state.sing?.phase).toBe('playing')
    expect(hub.state.sleep?.phase).toBe('paused')
    expect(hub.state.lastReportAt).toBe(9000)
    expect(got.stageError).toMatchObject({ code: 'lipsync_profile_missing' })

    // a new stage session starts from a clean slate
    stage.close()
    await waitUntil(() => !hub.state.connected)
    const next = await connectAndHello(bare, { hello: { stage_id: 'page-2' } })
    expect(hub.state.hello?.stage_id).toBe('page-2')
    expect(hub.state.stats).toBeUndefined()
    expect(hub.state.model).toBeUndefined()
    next.close()
  })

  it('survives listeners that throw or reject', async () => {
    const { logger, entries } = collectLogger()
    const bare = await setup({ logger })
    const { hub } = bare
    const stage = await connectAndHello(bare)
    hub.on('stats', () => {
      throw new Error('boom in a sync listener')
    })
    hub.on('model.state', async () => {
      throw new Error('boom in an async listener')
    })
    const later: string[] = []
    hub.on('report', (r) => later.push(r.type))

    stage.send(validStats)
    stage.send({ type: 'model.state', status: 'none' })
    stage.send({ type: 'pong', t: 1 })
    await waitUntil(() => later.includes('pong'), 3000, 'reports after the failing listeners')
    await waitUntil(
      () => entries.some((e) => e.msg.includes('async listener')),
      3000,
      'the async rejection to be logged'
    )
    expect(
      entries.some((e) => e.level === 'error' && e.msg.includes("listener of 'stats' threw"))
    ).toBe(true)
    expect(hub.state.connected).toBe(true)
  })
})

describe('utterances', () => {
  it('sends utterance.begin, then audio frames that decode to the exact PCM, last flag once at the end', async () => {
    const bare = await setup()
    const stage = await connectAndHello(bare)
    const pcm = pcmPattern(25_000)

    const result = await bare.hub.beginUtterance(
      {
        utterance_id: 'u-1',
        seq: 4,
        emotion: 'happy',
        audio: { sample_rate: 32000 },
        subtitle: 'hi',
      },
      { pcm16: pcm }
    )
    expect(result).toMatchObject({ utteranceId: 'u-1', frames: 3, cancelled: false })
    await stage.waitFor(() => stage.binaries().length === 3)

    const begin = stage.json().find((m) => m.type === 'utterance.begin')
    expect(begin).toMatchObject({
      utterance_id: 'u-1',
      seq: 4,
      emotion: 'happy',
      live_motion: false,
      motion: null,
      subtitle: 'hi',
      audio: { codec: 'pcm16', sample_rate: 32000, channels: 1, total_samples: 12_500 },
    })
    expect(StageDownstream.safeParse(begin).success).toBe(true)
    const order = stage.received.map((r) => (r.kind === 'json' ? r.msg.type : 'bin'))
    expect(order.indexOf('utterance.begin')).toBeLessThan(order.indexOf('bin'))

    const frames = stage.binaries()
    expect(frames.every((f) => f.kind === FrameKind.Audio && f.handle === begin?.handle)).toBe(true)
    expect(frames.map((f) => f.index)).toEqual([0, 1, 2])
    expect(frames.map((f) => f.last)).toEqual([false, false, true])
    expect(frames.map((f) => f.payload.byteLength)).toEqual([9600, 9600, 5800])
    expect(Buffer.concat(frames.map((f) => f.payload))).toEqual(Buffer.from(pcm))
  })

  it('honours chunkBytes and keeps every chunk on a sample boundary', async () => {
    const bare = await setup()
    const stage = await connectAndHello(bare)
    const pcm = pcmPattern(10_000)
    await bare.hub.beginUtterance(
      { utterance_id: 'u-2', seq: 0, emotion: 'neutral', audio: { sample_rate: 24000 } },
      { pcm16: pcm, chunkBytes: 3001 }
    )
    await stage.waitFor(() => stage.binaries().some((f) => f.last))
    const frames = stage.binaries()
    expect(frames.length).toBe(4) // 3000 + 3000 + 3000 + 1000
    for (const f of frames.slice(0, -1)) expect(f.payload.byteLength % 2).toBe(0)
    expect(frames.filter((f) => f.last)).toHaveLength(1)
    expect(Buffer.concat(frames.map((f) => f.payload))).toEqual(Buffer.from(pcm))
  })

  it('an utterance without audio still ends its audio stream with one empty last frame', async () => {
    const bare = await setup()
    const stage = await connectAndHello(bare)
    await bare.hub.beginUtterance({
      utterance_id: 'u-3',
      seq: 0,
      emotion: 'neutral',
      audio: { sample_rate: 24000 },
    })
    await stage.waitFor(() => stage.binaries().length === 1)
    expect(stage.binaries()[0]).toMatchObject({ kind: FrameKind.Audio, index: 0, last: true })
    expect(stage.binaries()[0]?.payload.byteLength).toBe(0)
    expect(stage.json().find((m) => m.type === 'utterance.begin')).toMatchObject({
      audio: { total_samples: 0 },
    })
  })

  it('sends the VRMA stream (at most 256 KiB per frame) before the audio', async () => {
    const bare = await setup()
    const stage = await connectAndHello(bare)
    const vrma = pcmPattern(600 * 1024, 3)
    const pcm = pcmPattern(2000)
    const result = await bare.hub.beginUtterance(
      {
        utterance_id: 'u-4',
        seq: 1,
        emotion: 'happy',
        audio: { sample_rate: 32000 },
        motion: null,
        live_motion: true,
      },
      { vrma, pcm16: pcm }
    )
    expect(result.frames).toBe(4)
    await stage.waitFor(() => stage.binaries().length === 4)

    const begin = stage.json().find((m) => m.type === 'utterance.begin')
    expect(begin).toMatchObject({ live_motion: true })
    const frames = stage.binaries()
    expect(frames.map((f) => f.kind)).toEqual([
      FrameKind.Vrma,
      FrameKind.Vrma,
      FrameKind.Vrma,
      FrameKind.Audio,
    ])
    const vrmaFrames = frames.filter((f) => f.kind === FrameKind.Vrma)
    expect(vrmaFrames.map((f) => f.payload.byteLength)).toEqual([262_144, 262_144, 90_112])
    expect(vrmaFrames.map((f) => f.index)).toEqual([0, 1, 2])
    expect(vrmaFrames.map((f) => f.last)).toEqual([false, false, true])
    expect(Buffer.concat(vrmaFrames.map((f) => f.payload))).toEqual(Buffer.from(vrma))
    expect(frames[3]).toMatchObject({ index: 0, last: true })
    expect(frames.every((f) => f.handle === begin?.handle)).toBe(true)
  })

  it('allocates increasing handles for concurrent utterances', async () => {
    const bare = await setup()
    const stage = await connectAndHello(bare)
    const a = await bare.hub.beginUtterance({
      utterance_id: 'a',
      seq: 0,
      emotion: 'neutral',
      audio: { sample_rate: 24000 },
    })
    const b = await bare.hub.beginUtterance({
      utterance_id: 'b',
      seq: 1,
      emotion: 'neutral',
      audio: { sample_rate: 24000 },
    })
    expect(b.handle).toBeGreaterThan(a.handle)
    await stage.waitFor(() => stage.binaries().length === 2)
    // an explicit handle is respected
    const c = await bare.hub.beginUtterance({
      utterance_id: 'c',
      seq: 2,
      emotion: 'neutral',
      handle: 4242,
      audio: { sample_rate: 24000 },
    })
    expect(c.handle).toBe(4242)
  })

  it('rejects bad input loudly', async () => {
    const bare = await setup()
    const { hub } = bare
    const base = {
      utterance_id: 'u',
      seq: 0,
      emotion: 'neutral' as const,
      audio: { sample_rate: 24000 },
    }
    await expect(hub.beginUtterance(base)).rejects.toMatchObject({
      name: 'StageSendError',
      code: 'no_stage',
    })

    await connectAndHello(bare)
    await expect(hub.beginUtterance(base, { pcm16: new Uint8Array(3) })).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(hub.beginUtterance(base, { vrma: new Uint8Array(0) })).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(hub.beginUtterance({ ...base, live_motion: true })).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(hub.beginUtterance(base, { chunkBytes: 1 })).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(hub.beginUtterance({ ...base, utterance_id: '' })).rejects.toThrow()
    await expect(hub.beginUtterance({ ...base, emotion: 'whisper' as never })).rejects.toThrow()
    await expect(hub.beginUtterance({ ...base, audio: { sample_rate: 100 } })).rejects.toThrow()
  })

  it('nextHandle() returns increasing u32 values and wraps back to 1', () => {
    const hub = new StageHub()
    expect([hub.nextHandle(), hub.nextHandle(), hub.nextHandle()]).toEqual([1, 2, 3])
    // white-box: jump close to the end of the u32 range
    ;(hub as unknown as { handleCounter: number }).handleCounter = 0xfffffffe
    expect(hub.nextHandle()).toBe(0xffffffff)
    expect(hub.nextHandle()).toBe(1)
  })
})

describe('back-pressure', () => {
  function withBuffered(options: StageHubOptions = {}) {
    const buffered = { value: 0 }
    const setupBare = () =>
      setup(options, (ws) => {
        Object.defineProperty(ws, 'bufferedAmount', { get: () => buffered.value })
      })
    return { buffered, setupBare }
  }
  const base = {
    utterance_id: 'u-bp',
    seq: 0,
    emotion: 'neutral' as const,
    audio: { sample_rate: 24000 },
  }

  it('holds binary frames back while the socket buffer is above 1 MiB, then continues', async () => {
    const { buffered, setupBare } = withBuffered({ backpressure: { timeoutMs: 5000, pollMs: 5 } })
    const bare = await setupBare()
    const stage = await connectAndHello(bare)
    buffered.value = 2 * MiB

    let done = false
    const sending = bare.hub.beginUtterance(base, { pcm16: pcmPattern(20_000) }).then((r) => {
      done = true
      return r
    })
    await stage.waitForJson('utterance.begin') // the JSON goes out, the audio waits
    await stage.settle(150)
    expect(stage.binaries()).toHaveLength(0)
    expect(done).toBe(false)

    buffered.value = 0
    const result = await sending
    expect(result).toMatchObject({ frames: 3, cancelled: false })
    await stage.waitFor(() => stage.binaries().length === 3)
  })

  it('a buffer exactly at the high-water mark does not block', async () => {
    const { buffered, setupBare } = withBuffered()
    const bare = await setupBare()
    const stage = await connectAndHello(bare)
    buffered.value = MiB
    await bare.hub.beginUtterance(base, { pcm16: pcmPattern(4000) })
    await stage.waitFor(() => stage.binaries().length === 1)
  })

  it('aborts the utterance after the timeout: rejects, emits error and tells the stage to cancel', async () => {
    const { buffered, setupBare } = withBuffered({ backpressure: { timeoutMs: 150, pollMs: 5 } })
    const bare = await setupBare()
    const stage = await connectAndHello(bare)
    const errors: Error[] = []
    bare.hub.on('error', (e) => errors.push(e))
    buffered.value = 5 * MiB

    const started = Date.now()
    await expect(
      bare.hub.beginUtterance(base, { pcm16: pcmPattern(20_000) })
    ).rejects.toMatchObject({
      name: 'StageSendError',
      code: 'backpressure',
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(StageSendError)
    expect(errors[0]?.message).toMatch(/did not drain/)

    buffered.value = 0
    const cancel = await stage.waitForJson('utterance.cancel')
    expect(cancel).toMatchObject({ scope: 'utterance', utterance_id: 'u-bp' })
    await stage.settle(60)
    expect(stage.binaries()).toHaveLength(0)
  })

  it('without an error listener the abort is logged and never throws out of the hub', async () => {
    const { logger, has } = collectLogger()
    const { buffered, setupBare } = withBuffered({
      logger,
      backpressure: { timeoutMs: 100, pollMs: 5 },
    })
    const bare = await setupBare()
    await connectAndHello(bare)
    buffered.value = 5 * MiB
    await expect(
      bare.hub.beginUtterance(base, { pcm16: pcmPattern(20_000) })
    ).rejects.toMatchObject({ code: 'backpressure' })
    expect(has('error', 'utterance aborted')).toBe(true)
    expect(has('error', 'no listener')).toBe(true)
  })

  it('rejects with code disconnected when the stage goes away mid-send', async () => {
    const { buffered, setupBare } = withBuffered({ backpressure: { timeoutMs: 5000, pollMs: 5 } })
    const bare = await setupBare()
    const stage = await connectAndHello(bare)
    buffered.value = 5 * MiB
    const sending = bare.hub.beginUtterance(base, { pcm16: pcmPattern(20_000) })
    const outcome = expect(sending).rejects.toMatchObject({ code: 'disconnected' })
    await stage.waitForJson('utterance.begin')
    stage.close()
    await outcome
  })
})

describe('cancelling', () => {
  const opts = (id: string) => ({
    utterance_id: id,
    seq: 0,
    emotion: 'neutral' as const,
    audio: { sample_rate: 24000 },
  })

  it('cancelUtterance stops an in-flight stream and tells the stage', async () => {
    const buffered = { value: 3 * MiB }
    const bare = await setup({ backpressure: { timeoutMs: 5000, pollMs: 5 } }, (ws) => {
      Object.defineProperty(ws, 'bufferedAmount', { get: () => buffered.value })
    })
    const stage = await connectAndHello(bare)
    const sending = bare.hub.beginUtterance(opts('u-c'), { pcm16: pcmPattern(20_000) })
    await stage.waitForJson('utterance.begin')

    expect(bare.hub.cancelUtterance('u-c', { fadeMs: 10 })).toBe(true)
    const result = await sending
    expect(result).toMatchObject({ cancelled: true, frames: 0 })

    buffered.value = 0
    await stage.settle(80)
    expect(stage.binaries()).toHaveLength(0)
    expect(stage.json().find((m) => m.type === 'utterance.cancel')).toMatchObject({
      scope: 'utterance',
      utterance_id: 'u-c',
      fade_ms: 10,
    })
  })

  it('cancelAll stops every in-flight stream', async () => {
    const buffered = { value: 3 * MiB }
    const bare = await setup({ backpressure: { timeoutMs: 5000, pollMs: 5 } }, (ws) => {
      Object.defineProperty(ws, 'bufferedAmount', { get: () => buffered.value })
    })
    const stage = await connectAndHello(bare)
    const a = bare.hub.beginUtterance(opts('a'), { pcm16: pcmPattern(20_000) })
    const b = bare.hub.beginUtterance(opts('b'), { pcm16: pcmPattern(20_000) })
    await stage.waitFor(() => stage.json().filter((m) => m.type === 'utterance.begin').length === 2)

    expect(bare.hub.cancelAll()).toBe(true)
    expect(await a).toMatchObject({ cancelled: true })
    expect(await b).toMatchObject({ cancelled: true })
    expect(stage.json().find((m) => m.type === 'utterance.cancel')).toMatchObject({
      scope: 'all',
      fade_ms: 60,
    })
  })

  it('cancelling without a stage is harmless and returns false', () => {
    const hub = new StageHub()
    expect(hub.cancelUtterance('nobody')).toBe(false)
    expect(hub.cancelAll()).toBe(false)
  })
})

describe('heartbeat', () => {
  it('pings the stage and keeps it while it answers', async () => {
    const bare = await setup({ pingIntervalMs: 40, deadAfterMs: 200 })
    const stage = await connectAndHello(bare)
    await stage.waitFor(
      () => stage.jsonTypes().filter((t) => t === 'ping').length >= 3,
      3000,
      '3 pings'
    )
    expect(stage.json().find((m) => m.type === 'ping')).toMatchObject({ t: expect.any(Number) })
    await stage.settle(350) // longer than deadAfterMs: only the pongs keep the socket alive
    expect(stage.closeInfo).toBeNull()
    expect(bare.hub.state.connected).toBe(true)
  })

  it('terminates a stage that stays silent', async () => {
    const bare = await setup({ pingIntervalMs: 40, deadAfterMs: 200 })
    const infos: StageDisconnectInfo[] = []
    bare.hub.on('disconnected', (i) => infos.push(i))
    const stage = await connectAndHello(bare, { autoPong: false })
    const closed = await stage.waitClosed(3000)
    expect(closed.code).toBe(1006) // cut without a close frame
    await waitUntil(() => infos.length === 1)
    expect(infos[0]).toMatchObject({ reason: 'heartbeat timeout', replaced: false })
    expect(bare.hub.state.connected).toBe(false)
  })

  it('any upstream frame counts as a sign of life, not only pong', async () => {
    const bare = await setup({ pingIntervalMs: 40, deadAfterMs: 200 })
    const stage = await connectAndHello(bare, { autoPong: false })
    for (let i = 0; i < 10; i++) {
      stage.send(validStats)
      await delay(50)
    }
    expect(stage.closeInfo).toBeNull()
  })
})

describe('waitFor', () => {
  it('resolves with the next report of a type or matching a predicate', async () => {
    const bare = await setup()
    const { hub } = bare
    const stage = await connectAndHello(bare)

    const byType = hub.waitFor('stats', { timeoutMs: 2000 })
    stage.send(validStats)
    expect((await byType).fps).toBe(60)

    const byPredicate = hub.waitFor(
      (r): r is Report<'playback.ended'> =>
        r.type === 'playback.ended' && r.utterance_id === 'wanted',
      { timeoutMs: 2000 }
    )
    stage.send({
      type: 'playback.ended',
      utterance_id: 'other',
      seq: 0,
      reason: 'done',
      underruns: 0,
      played_ms: 1,
    })
    stage.send({
      type: 'playback.ended',
      utterance_id: 'wanted',
      seq: 1,
      reason: 'cancelled',
      underruns: 2,
      played_ms: 5,
    })
    expect(await byPredicate).toMatchObject({
      utterance_id: 'wanted',
      reason: 'cancelled',
      underruns: 2,
    })
    expect(hub.listenerCount('report')).toBe(0) // listeners are cleaned up
  })

  it('rejects on timeout, abort and (optionally) disconnect', async () => {
    const bare = await setup()
    const { hub } = bare
    const stage = await connectAndHello(bare)

    await expect(hub.waitFor('stats', { timeoutMs: 50 })).rejects.toMatchObject({
      name: 'StageWaitError',
      reason: 'timeout',
    })

    const ac = new AbortController()
    const aborted = hub.waitFor('stats', { signal: ac.signal })
    ac.abort()
    await expect(aborted).rejects.toMatchObject({ reason: 'aborted' })
    await expect(hub.waitFor('stats', { signal: ac.signal })).rejects.toBeInstanceOf(StageWaitError) // already aborted

    const leaving = hub.waitFor('stats', { rejectOnDisconnect: true, timeoutMs: 3000 })
    const stays = hub.waitFor('stats', { timeoutMs: 100 })
    const stayed = expect(stays).rejects.toMatchObject({ reason: 'timeout' }) // does not reject on disconnect
    stage.close()
    await expect(leaving).rejects.toMatchObject({ reason: 'disconnected' })
    await stayed
    expect(hub.listenerCount('report')).toBe(0)
    expect(hub.listenerCount('disconnected')).toBe(0)
  })

  it('a predicate that throws rejects the wait with that error', async () => {
    const bare = await setup()
    const stage = await connectAndHello(bare)
    const wait = bare.hub.waitFor(() => {
      throw new Error('predicate failed')
    })
    stage.send(validStats)
    await expect(wait).rejects.toThrow('predicate failed')
  })

  it('waitForConnected resolves at once when connected, otherwise with the next hello', async () => {
    const bare = await setup()
    const { hub } = bare
    const waiting = hub.waitForConnected({ timeoutMs: 3000 })
    const stage = await connectAndHello(bare, { hello: { stage_id: 'late' } })
    expect((await waiting).stage_id).toBe('late')
    expect((await hub.waitForConnected({ timeoutMs: 10 })).stage_id).toBe('late')
    stage.close()
    await waitUntil(() => !hub.state.connected)
    await expect(hub.waitForConnected({ timeoutMs: 50 })).rejects.toMatchObject({
      reason: 'timeout',
    })
  })
})

describe('shutdown', () => {
  it('close() closes every socket with 1001 and stops streaming', async () => {
    const bare = await setup()
    const stage = await connectAndHello(bare)
    const pending = await connect(bare) // never sent hello
    bare.hub.close(1001, 'test shutdown')
    expect(await stage.waitClosed()).toEqual({ code: 1001, reason: 'test shutdown' })
    expect((await pending.waitClosed()).code).toBe(1001)
    expect(bare.hub.state.connected).toBe(false)
    expect(bare.hub.send({ type: 'ping', t: 1 })).toBe(false)
  })
})
