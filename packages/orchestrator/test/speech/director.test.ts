import type { TtsAdapter, TtsRequest, TtsStream } from '@animatus/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SpeechDirector,
  type BeginArgs,
  type EndReason,
  type StageOutput,
  type StageReports,
} from '../../src/speech/director.ts'
import { TtsError } from '../../src/tts/gptsovits.ts'
import { SpeechFilter } from '../../src/tts/text.ts'

const SR = 16000
const pcm = (sec = 0.5) => new Uint8Array(Math.round(sec * SR) * 2).fill(1)
const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

class Deferred<T> {
  promise: Promise<T>
  resolve!: (v: T) => void
  reject!: (e: unknown) => void
  constructor() {
    this.promise = new Promise((res, rej) => {
      this.resolve = res
      this.reject = rej
    })
  }
}

/** TTS whose every call can be held and released by the test. */
class ManualTts implements TtsAdapter {
  calls: { req: TtsRequest; done: Deferred<TtsStream> }[] = []
  auto = false
  async styles() {
    return ['neutral']
  }
  synthesize(req: TtsRequest): Promise<TtsStream> {
    const done = new Deferred<TtsStream>()
    this.calls.push({ req, done })
    req.signal?.addEventListener('abort', () => done.reject(new TtsError('aborted', 'aborted')), {
      once: true,
    })
    if (this.auto) done.resolve(this.stream())
    return done.promise
  }
  stream(sec = 0.5): TtsStream {
    return {
      sampleRate: SR,
      chunks: (async function* () {
        yield pcm(sec)
      })(),
    }
  }
  release(i: number, sec = 0.5) {
    this.calls[i]!.done.resolve(this.stream(sec))
  }
}

class FakeStage implements StageOutput {
  connected = true
  begun: { args: BeginArgs; vrma: boolean }[] = []
  cancels: { scope: string; id?: string }[] = []
  beginDelayMs = 0
  failNext = false
  async beginUtterance(args: BeginArgs, media: { pcm16: Uint8Array; vrma?: Uint8Array }) {
    if (this.failNext) {
      this.failNext = false
      throw new Error('socket closed')
    }
    this.begun.push({ args, vrma: !!media.vrma })
    if (this.beginDelayMs) await sleep(this.beginDelayMs)
    return { cancelled: false }
  }
  cancel(scope: 'utterance' | 'all', id?: string) {
    this.cancels.push({ scope, id })
  }
  get ids() {
    return this.begun.map((b) => b.args.utterance_id)
  }
}

class FakeReports implements StageReports {
  private h: Record<string, ((...a: any[]) => void)[]> = {
    started: [],
    ended: [],
    disconnected: [],
  }
  on(event: 'started' | 'ended' | 'disconnected', fn: (...a: any[]) => void) {
    this.h[event]!.push(fn)
    return () => (this.h[event] = this.h[event]!.filter((f) => f !== fn))
  }
  started(id: string) {
    this.h.started!.forEach((f) => f(id))
  }
  ended(id: string, reason: EndReason = 'done') {
    this.h.ended!.forEach((f) => f(id, reason))
  }
  disconnected() {
    this.h.disconnected!.forEach((f) => f())
  }
}

const made: SpeechDirector[] = []
afterEach(() => {
  for (const d of made.splice(0)) d.dispose()
})

function setup(opts: Partial<ConstructorParameters<typeof SpeechDirector>[0]> = {}) {
  const tts = new ManualTts()
  const stage = new FakeStage()
  const reports = new FakeReports()
  const d = new SpeechDirector({ tts, stage, reports, ttsRetryDelayMs: 0, ...opts })
  made.push(d)
  const events: string[] = []
  d.on('started', (id) => events.push(`started:${id}`))
  d.on('ended', (id, r) => events.push(`ended:${id}:${r}`))
  d.on('failed', (id) => events.push(`failed:${id}`))
  d.on('dropped', (id, why) => events.push(`dropped:${id}:${why}`))
  return { d, tts, stage, reports, events }
}

const item = (text: string, extra = {}) => ({ text, emotion: 'neutral' as const, ...extra })

describe('SpeechDirector: ordering and flow', () => {
  it('speaks sentences in order and completes the turn', async () => {
    const { d, tts, stage, reports, events } = setup()
    const t = d.beginTurn('t1')
    expect(t.enqueue(item('First sentence.'))).toBe(true)
    expect(t.enqueue(item('Second sentence.'))).toBe(true)
    t.end()
    await tick()
    tts.release(0)
    tts.release(1)
    await tick()
    expect(stage.ids).toEqual(['t1-1', 't1-2'])
    expect(stage.begun[0]!.args).toMatchObject({
      turn_id: 't1',
      seq: 0,
      emotion: 'neutral',
      live_motion: false,
    })
    expect(stage.begun[0]!.args.audio.total_samples).toBe(SR / 2)

    reports.started('t1-1')
    reports.ended('t1-1')
    reports.started('t1-2')
    reports.ended('t1-2')
    await t.whenDone()
    expect(events).toEqual(['started:t1-1', 'ended:t1-1:done', 'started:t1-2', 'ended:t1-2:done'])
    expect(d.pending).toBe(0)
  })

  it('sends in order even when a later sentence is synthesised first', async () => {
    const { d, tts, stage } = setup()
    const t = d.beginTurn('t')
    t.enqueue(item('One.'))
    t.enqueue(item('Two.'))
    await tick()
    tts.release(1) // the second is ready first
    await tick()
    expect(stage.ids).toEqual([])
    tts.release(0)
    await tick()
    expect(stage.ids).toEqual(['t-1', 't-2'])
  })

  it('only synthesises a window ahead of playback', async () => {
    const { d, tts } = setup({ lookahead: 1, stageQueueMax: 1 })
    const t = d.beginTurn('t')
    for (let i = 0; i < 6; i++) t.enqueue(item(`Sentence number ${i}.`))
    await tick()
    expect(tts.calls.length).toBe(2) // head + 1 ahead
  })

  it('keeps at most stageQueueMax sentences at the stage', async () => {
    const { d, tts, stage, reports } = setup({ stageQueueMax: 1 })
    tts.auto = true
    const t = d.beginTurn('t')
    t.enqueue(item('One.'))
    t.enqueue(item('Two.'))
    await tick()
    expect(stage.ids).toEqual(['t-1'])
    reports.started('t-1')
    reports.ended('t-1')
    await tick()
    expect(stage.ids).toEqual(['t-1', 't-2'])
  })

  it('does not send while held and resumes on release', async () => {
    const { d, tts, stage } = setup()
    tts.auto = true
    d.hold('dance', true)
    const t = d.beginTurn('t')
    t.enqueue(item('Held sentence.'))
    await tick()
    expect(stage.ids).toEqual([])
    expect(d.held).toBe(true)
    d.hold('dance', false)
    await tick()
    expect(stage.ids).toEqual(['t-1'])
  })

  it('waits for the stage to connect', async () => {
    const { d, tts, stage } = setup()
    tts.auto = true
    stage.connected = false
    const t = d.beginTurn('t')
    t.enqueue(item('Nobody is listening yet.'))
    await tick()
    expect(stage.ids).toEqual([])
    stage.connected = true
    d.kick()
    await tick()
    expect(stage.ids).toEqual(['t-1'])
  })

  it('force-ends a sentence the stage never reports on, so the line cannot stall', async () => {
    const { d, tts, stage, events } = setup({ endGraceMs: 30, stageQueueMax: 1 })
    tts.auto = true
    const t = d.beginTurn('t')
    t.enqueue(item('Stuck one.'))
    t.enqueue(item('Behind it.'))
    await tick()
    expect(stage.ids).toEqual(['t-1'])
    await sleep(700) // 0.5 s of audio + backlog + grace
    await tick()
    expect(events).toContain('ended:t-1:timeout')
    expect(stage.ids).toEqual(['t-1', 't-2'])
  })
})

describe('SpeechDirector: text rules', () => {
  it('rejects text with nothing to say and applies the sensitive-word filter', async () => {
    const filter = new SpeechFilter(['secretword'])
    const { d, tts } = setup({ filter })
    tts.auto = true
    const t = d.beginTurn('t')
    expect(t.enqueue(item('...!?'))).toBe(false)
    expect(t.enqueue(item('😀😀'))).toBe(false)
    expect(t.enqueue(item('this has a secretword in it'))).toBe(true)
    await tick()
    expect(tts.calls[0]!.req.text).toBe('this has a 哔 in it')
  })

  it('passes style, speed and the subtitle through', async () => {
    const { d, tts, stage } = setup()
    tts.auto = true
    const t = d.beginTurn('t')
    t.enqueue(
      item('Whisper this.', {
        style: 'whisper',
        speed: 0.9,
        subtitle: 'Whisper this.',
        emotion: 'relaxed',
      })
    )
    await tick()
    expect(tts.calls[0]!.req).toMatchObject({ style: 'whisper', speed: 0.9 })
    expect(stage.begun[0]!.args).toMatchObject({ emotion: 'relaxed', subtitle: 'Whisper this.' })
  })
})

describe('SpeechDirector: cancellation and supersession', () => {
  it('cancelAll aborts synthesis, cancels the stage and discards late results; new turns still work', async () => {
    const { d, tts, stage, events } = setup()
    const t = d.beginTurn('t1')
    t.enqueue(item('In flight one.'))
    t.enqueue(item('In flight two.'))
    await tick()
    d.cancelAll('stop button')
    await tick()
    expect(stage.cancels).toContainEqual({ scope: 'all', id: undefined })
    expect(d.pending).toBe(0)
    expect(t.enqueue(item('More from the stopped reply.'))).toBe(false) // a stopped reply stays silent
    // late result of the aborted call must not reach the stage
    expect(stage.ids).toEqual([])
    await t.whenDone() // a cancelled turn never hangs its waiters
    const t2 = d.beginTurn('t2')
    tts.auto = true
    expect(t2.enqueue(item('A fresh reply.'))).toBe(true)
    await tick()
    expect(stage.ids).toEqual(['t2-3'])
    expect(events.filter((e) => e.startsWith('dropped')).length).toBe(2)
  })

  it("a new turn drops the old turn's queued sentences but lets the one being spoken finish", async () => {
    const { d, tts, stage, reports, events } = setup({ stageQueueMax: 3 })
    tts.auto = true
    const a = d.beginTurn('a')
    a.enqueue(item('A one.'))
    a.enqueue(item('A two.'))
    a.enqueue(item('A three.'))
    await tick()
    reports.started('a-1') // a-1 is audible; a-2 and a-3 are at the stage, not yet started
    const b = d.beginTurn('b')
    await tick()
    expect(
      stage.cancels
        .filter((c) => c.scope === 'utterance')
        .map((c) => c.id)
        .sort()
    ).toEqual(['a-2', 'a-3'])
    expect(a.enqueue(item('A four.'))).toBe(false)
    expect(b.enqueue(item('B one.'))).toBe(true)
    await tick()
    reports.ended('a-1')
    await tick()
    expect(stage.ids).toContain('b-4')
    expect(events).toContain('ended:a-1:done')
    expect(events.filter((e) => e.endsWith('superseded')).length).toBe(2)
  })

  it('cancelTurn stops only that turn', async () => {
    const { d, tts, stage } = setup({ stageQueueMax: 4 })
    tts.auto = true
    const a = d.beginTurn('a')
    a.enqueue(item('A one.'))
    await tick()
    d.cancelTurn('a')
    expect(stage.cancels).toContainEqual({ scope: 'utterance', id: 'a-1' })
    await a.whenDone()
    expect(d.pending).toBe(0)
  })

  it('a stage disconnect cancels everything', async () => {
    const { d, tts, stage, reports } = setup()
    tts.auto = true
    const t = d.beginTurn('t')
    t.enqueue(item('Speaking now.'))
    t.enqueue(item('Speaking next.'))
    await tick()
    reports.disconnected()
    await tick()
    expect(stage.cancels).toContainEqual({ scope: 'all', id: undefined })
    expect(d.pending).toBe(0)
  })
})

describe('SpeechDirector: failures', () => {
  it('drops a sentence whose synthesis fails, reports it, and carries on', async () => {
    const { d, tts, stage, events } = setup()
    const t = d.beginTurn('t')
    t.enqueue(item('Fails.'))
    t.enqueue(item('Works.'))
    await tick()
    tts.calls[0]!.done.reject(new TtsError('server said no', 'synth_failed', false, 400))
    tts.release(1)
    await tick()
    expect(events).toContain('failed:t-1')
    expect(stage.ids).toEqual(['t-2'])
  })

  it('retries a retryable failure once', async () => {
    const { d, tts, stage } = setup({ ttsRetryDelayMs: 1 })
    const t = d.beginTurn('t')
    t.enqueue(item('Flaky.'))
    await tick()
    tts.calls[0]!.done.reject(new TtsError('busy', 'synth_failed', true, 503))
    await sleep(15)
    await tick()
    expect(tts.calls.length).toBe(2)
    tts.release(1)
    await tick()
    expect(stage.ids).toEqual(['t-1'])
  })

  it('does not retry a non-retryable failure', async () => {
    const { d, tts, events } = setup({ ttsRetryDelayMs: 1 })
    const t = d.beginTurn('t')
    t.enqueue(item('Bad.'))
    await tick()
    tts.calls[0]!.done.reject(new TtsError('nope', 'bad_audio'))
    await sleep(15)
    await tick()
    expect(tts.calls.length).toBe(1)
    expect(events).toContain('failed:t-1')
  })

  it('drops a sentence when sending to the stage throws', async () => {
    const { d, tts, stage, events } = setup()
    tts.auto = true
    stage.failNext = true
    const t = d.beginTurn('t')
    t.enqueue(item('Lost in transit.'))
    t.enqueue(item('Delivered.'))
    await tick()
    expect(events).toContain('failed:t-1')
    expect(stage.ids).toEqual(['t-2'])
  })
})

describe('SpeechDirector: live motion', () => {
  const clip = new Uint8Array([9, 9, 9])

  function withMotion(latencyMs: number, opts: { fail?: boolean; available?: boolean } = {}) {
    const calls: number[] = []
    const motion = {
      available: () => opts.available ?? true,
      async generate(audio: { pcm16: Uint8Array; sampleRate: number }, signal?: AbortSignal) {
        calls.push(audio.pcm16.length)
        await sleep(latencyMs)
        if (signal?.aborted) throw new Error('aborted')
        if (opts.fail) throw new Error('motion service down')
        return clip
      },
    }
    return { motion, calls }
  }

  it('attaches the clip when it is ready within the wait budget', async () => {
    const { motion } = withMotion(5)
    const { d, tts, stage } = setup({ motion, liveMotion: { waitMs: 100 } })
    tts.auto = true
    const t = d.beginTurn('t')
    t.enqueue(item('With a live clip.'))
    await sleep(40)
    expect(stage.begun[0]!.vrma).toBe(true)
    expect(stage.begun[0]!.args.live_motion).toBe(true)
  })

  it('never waits longer than the budget: a slow motion service means the sentence goes without a clip', async () => {
    const { motion } = withMotion(400)
    const { d, tts, stage } = setup({ motion, liveMotion: { waitMs: 30 } })
    tts.auto = true
    const t = d.beginTurn('t')
    const t0 = Date.now()
    t.enqueue(item('Motion is slow.'))
    await sleep(120)
    expect(stage.begun).toHaveLength(1)
    expect(stage.begun[0]!.vrma).toBe(false)
    expect(Date.now() - t0).toBeLessThan(350)
  })

  it('a failing motion service is not an error for speech', async () => {
    const { motion } = withMotion(1, { fail: true })
    const { d, tts, stage } = setup({ motion })
    tts.auto = true
    const t = d.beginTurn('t')
    t.enqueue(item('Motion is down.'))
    await sleep(40)
    expect(stage.begun).toHaveLength(1)
    expect(stage.begun[0]!.vrma).toBe(false)
  })

  it('uses live motion for 3 of every 4 sentences, and never with a tag motion', async () => {
    const { motion, calls } = withMotion(1)
    const { d, tts, stage } = setup({ motion, stageQueueMax: 10, lookahead: 10 })
    tts.auto = true
    const t = d.beginTurn('t')
    for (let i = 0; i < 8; i++) t.enqueue(item(`Plain sentence ${i}.`))
    t.enqueue(item('Tagged.', { motion: { id: 'nod', url: '/asset/motions/poses/nod.vrma' } }))
    await sleep(120)
    expect(calls.length).toBe(6) // 3 of the first 4, 3 of the next 4; the tagged one is excluded
    const tagged = stage.begun.find((b) => b.args.motion)
    expect(tagged?.vrma).toBe(false)
    expect(tagged?.args.motion?.id).toBe('nod')
  })

  it('no live motion when the service reports itself unavailable', async () => {
    const { motion, calls } = withMotion(1, { available: false })
    const { d, tts, stage } = setup({ motion })
    tts.auto = true
    const t = d.beginTurn('t')
    t.enqueue(item('No motion service.'))
    await sleep(20)
    expect(calls).toHaveLength(0)
    expect(stage.begun[0]!.vrma).toBe(false)
  })
})

describe('SpeechDirector: idle and traces', () => {
  it('whenIdle resolves when everything is done, and traces carry the timings', async () => {
    const { d, tts, reports } = setup()
    tts.auto = true
    const traces: string[] = []
    d.on('trace', (tr) =>
      traces.push(
        `${tr.id}:${tr.audioSec}:${tr.startedAt !== undefined && tr.endedAt !== undefined}`
      )
    )
    const t = d.beginTurn('t')
    t.enqueue(item('Timed.'))
    t.end()
    await tick()
    const idle = d.whenIdle()
    reports.started('t-1')
    reports.ended('t-1')
    await idle
    expect(traces).toEqual(['t-1:0.5:true'])
    expect(d.speaking).toBe(false)
  })
})
