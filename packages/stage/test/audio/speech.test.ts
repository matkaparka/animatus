import {
  FrameKind,
  type MediaFrame,
  type StageUpstream,
  type UtteranceBegin,
} from '@animatus/protocol'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../../src/audio/engine.ts'
import { SpeechPlayer, type EndReason } from '../../src/audio/speech.ts'

const SR = 16000

class FakeSource {
  buffer: { duration: number; length: number } | null = null
  startedAt: number | null = null
  stoppedAt: number | null = null
  onended: (() => void) | null = null
  connect() {
    return this
  }
  disconnect() {}
  start(t: number) {
    this.startedAt = t
  }
  stop(t?: number) {
    this.stoppedAt = t ?? 0
  }
}

class FakeCtx {
  currentTime = 0
  sources: FakeSource[] = []
  createBuffer(_ch: number, length: number, sr: number) {
    return { length, duration: length / sr, copyToChannel() {} }
  }
  createBufferSource() {
    const s = new FakeSource()
    this.sources.push(s)
    return s
  }
  createGain() {
    return {
      gain: {
        value: 1,
        cancelScheduledValues() {},
        setValueAtTime() {},
        linearRampToValueAtTime() {},
      },
      connect() {},
      disconnect() {},
    }
  }
}

const setup = (opts: { running?: boolean; ensure?: boolean } = {}) => {
  const ctx = new FakeCtx()
  const engine = {
    ctx,
    speechBus: {},
    running: opts.running ?? true,
    heardTime: () => ctx.currentTime,
    ensureRunning: async () => opts.ensure ?? opts.running ?? true,
  } as unknown as AudioEngine
  const reports: StageUpstream[] = []
  const events: string[] = []
  const vrma: Uint8Array[] = []
  const player = new SpeechPlayer(
    engine,
    {
      onVrma: (u, bytes) => {
        events.push(`vrma:${u.id}`)
        vrma.push(bytes)
      },
      onStart: (u) => events.push(`start:${u.id}`),
      onEnd: (u, r: EndReason) => events.push(`end:${u.id}:${r}`),
    },
    (m) => reports.push(m)
  )
  return { ctx, player, reports, events, vrma }
}

let nextHandle = 1
const begin = (id: string, extra: Partial<UtteranceBegin> = {}): UtteranceBegin => ({
  type: 'utterance.begin',
  utterance_id: id,
  seq: 0,
  handle: nextHandle++,
  emotion: 'neutral',
  motion: null,
  live_motion: false,
  audio: { codec: 'pcm16', sample_rate: SR, channels: 1 },
  ...extra,
})

const pcm = (sec: number) => new Uint8Array(Math.round(sec * SR) * 2).fill(1)
const audioFrame = (handle: number, index: number, sec: number, last: boolean): MediaFrame => ({
  kind: FrameKind.Audio,
  handle,
  index,
  last,
  payload: pcm(sec),
})
const kinds = (r: StageUpstream[]) =>
  r.map((x) => (x.type === 'playback.ended' ? `ended:${x.reason}` : x.type))

describe('SpeechPlayer', () => {
  it('plays an utterance: schedules audio, reports start when heard, reports end when the audio is over', () => {
    const { ctx, player, reports, events } = setup()
    const b = begin('u1')
    player.begin(b, 0)
    for (let i = 0; i < 3; i++) player.feed(audioFrame(b.handle, i, 0.15, i === 2))
    player.update(0)
    expect(ctx.sources).toHaveLength(3)
    expect(ctx.sources[0]!.startedAt).toBeCloseTo(0.03, 9)
    expect(events).toEqual([]) // not audible yet
    expect(player.isSpeaking()).toBe(false)

    ctx.currentTime = 0.05
    player.update(50)
    expect(events).toEqual(['start:u1'])
    expect(player.isSpeaking()).toBe(true)

    ctx.currentTime = 0.4
    player.update(400)
    expect(player.isSpeaking()).toBe(true)
    ctx.currentTime = 0.49
    player.update(490)
    expect(events).toEqual(['start:u1', 'end:u1:done'])
    expect(player.isSpeaking()).toBe(false)
    expect(kinds(reports)).toEqual(['playback.started', 'ended:done'])
    const ended = reports[1] as Extract<StageUpstream, { type: 'playback.ended' }>
    expect(ended.underruns).toBe(0)
  })

  it('waits for the pre-roll when the audio streams in', () => {
    const { ctx, player, events } = setup()
    const b = begin('u1')
    player.begin(b, 0)
    player.feed(audioFrame(b.handle, 0, 0.05, false))
    player.update(0)
    expect(ctx.sources).toHaveLength(0)
    player.feed(audioFrame(b.handle, 1, 0.2, false))
    ctx.currentTime = 0.1
    player.update(100)
    expect(ctx.sources.length).toBeGreaterThan(0)
    player.feed(audioFrame(b.handle, 2, 0.1, true))
    ctx.currentTime = 0.2
    player.update(200)
    expect(events).toContain('start:u1')
  })

  it('cancel stops the audio, reports cancelled, and drops later frames of that utterance', () => {
    const { ctx, player, reports, events } = setup()
    const b = begin('u1')
    player.begin(b, 0)
    player.feed(audioFrame(b.handle, 0, 0.5, false))
    player.update(0)
    ctx.currentTime = 0.1
    player.update(100)
    player.cancel('utterance', 'u1', 60)
    expect(events).toEqual(['start:u1', 'end:u1:cancelled'])
    expect(ctx.sources[0]!.stoppedAt).not.toBeNull()
    expect(kinds(reports)).toEqual(['playback.started', 'ended:cancelled'])
    player.feed(audioFrame(b.handle, 1, 0.1, true))
    expect(player.dropped).toBe(1)
  })

  it('cancel "all" ends queued utterances too', () => {
    const { player, events } = setup()
    const a = begin('a')
    const b = begin('b')
    player.begin(a, 0)
    player.begin(b, 0)
    player.feed(audioFrame(a.handle, 0, 0.2, true))
    player.update(0)
    player.cancel('all', undefined, 60)
    expect(events.filter((e) => e.startsWith('end:')).sort()).toEqual([
      'end:a:cancelled',
      'end:b:cancelled',
    ])
  })

  it('holds utterances while a dance or song runs, then plays them', () => {
    const { ctx, player, events } = setup()
    player.hold('dance', true)
    const b = begin('u1')
    player.begin(b, 0)
    player.feed(audioFrame(b.handle, 0, 0.2, true))
    player.update(0)
    ctx.currentTime = 1
    player.update(1000)
    expect(ctx.sources).toHaveLength(0)
    expect(events).toEqual([])
    player.hold('dance', false)
    player.update(1010)
    expect(ctx.sources).toHaveLength(1)
    ctx.currentTime = 1.05
    player.update(1050)
    expect(events).toEqual(['start:u1'])
  })

  it('two holds need two releases', () => {
    const { player, ctx } = setup()
    player.hold('dance', true)
    player.hold('sing', true)
    const b = begin('u1')
    player.begin(b, 0)
    player.feed(audioFrame(b.handle, 0, 0.2, true))
    player.hold('dance', false)
    player.update(0)
    expect(ctx.sources).toHaveLength(0)
    player.hold('sing', false)
    player.update(10)
    expect(ctx.sources).toHaveLength(1)
  })

  it('chains the next utterance gaplessly when its audio is already here', () => {
    const { ctx, player } = setup()
    const a = begin('a')
    const b = begin('b')
    player.begin(a, 0)
    player.begin(b, 0)
    player.feed(audioFrame(a.handle, 0, 0.3, true))
    player.feed(audioFrame(b.handle, 0, 0.2, true))
    player.update(0)
    // one update activates a, hands out all its audio, then activates b right behind it
    const aEnd = ctx.sources[0]!.startedAt! + 0.3
    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[1]!.startedAt).toBeCloseTo(aEnd, 9)
  })

  it('completes silently when the audio context cannot run', async () => {
    const { player, reports, events } = setup({ running: false, ensure: false })
    const b = begin('u1')
    player.begin(b, 0)
    player.feed(audioFrame(b.handle, 0, 0.5, true))
    player.update(0)
    await Promise.resolve()
    await Promise.resolve()
    player.update(10)
    expect(events).toEqual(['start:u1']) // the body still gets its start
    player.update(300)
    expect(events).toEqual(['start:u1']) // 0.5 s of "speech" has not passed
    player.update(600)
    expect(events).toEqual(['start:u1', 'end:u1:audio_suspended'])
    expect(kinds(reports)).toEqual(['playback.started', 'ended:audio_suspended'])
  })

  it('an utterance with no audio reports start and end together', () => {
    const { player, events, reports } = setup()
    const b = begin('u1')
    player.begin(b, 0)
    player.feed({
      kind: FrameKind.Audio,
      handle: b.handle,
      index: 0,
      last: true,
      payload: new Uint8Array(0),
    })
    player.update(0)
    expect(events).toEqual(['start:u1', 'end:u1:done'])
    expect(kinds(reports)).toEqual(['playback.started', 'ended:done'])
  })

  it('rejects a duplicate handle or id and keeps the first', () => {
    const { player, reports } = setup()
    const a = begin('a')
    player.begin(a, 0)
    player.begin({ ...begin('b'), handle: a.handle }, 0)
    player.begin({ ...begin('a') }, 0)
    expect(reports.filter((r) => r.type === 'error')).toHaveLength(2)
  })

  it('drops frames for handles it does not know', () => {
    const { player } = setup()
    player.feed(audioFrame(999, 0, 0.1, true))
    expect(player.dropped).toBe(1)
  })

  it('joins VRMA parts and delivers them once, before the audio', () => {
    const { player, events, vrma } = setup()
    const b = begin('u1', { live_motion: true })
    player.begin(b, 0)
    player.feed({
      kind: FrameKind.Vrma,
      handle: b.handle,
      index: 0,
      last: false,
      payload: Uint8Array.from([1, 2, 3]),
    })
    expect(vrma).toHaveLength(0)
    player.feed({
      kind: FrameKind.Vrma,
      handle: b.handle,
      index: 1,
      last: true,
      payload: Uint8Array.from([4, 5]),
    })
    expect(events).toEqual(['vrma:u1'])
    expect([...vrma[0]!]).toEqual([1, 2, 3, 4, 5])
  })

  it('times out an utterance whose audio never completes', () => {
    const { player, events } = setup()
    const b = begin('u1')
    player.begin(b, 0)
    player.feed(audioFrame(b.handle, 0, 0.05, false)) // never gets a last frame, below the pre-roll
    player.update(1000)
    expect(events).toEqual([])
    player.update(91_000)
    expect(events).toEqual(['end:u1:timeout'])
  })

  it('counts underruns from the scheduler into the total', () => {
    const { ctx, player } = setup()
    const b = begin('u1')
    player.begin(b, 0)
    player.feed(audioFrame(b.handle, 0, 0.3, false))
    player.update(0)
    ctx.currentTime = 5 // the stream stalled far past the scheduled audio
    player.update(5000)
    player.feed(audioFrame(b.handle, 1, 0.5, true))
    ctx.currentTime = 5.1
    player.update(5100)
    ctx.currentTime = 20
    player.update(20_000)
    expect(player.underruns).toBeGreaterThanOrEqual(1)
  })
})
