/**
 * What goes wrong, and what the mode does about it: black pictures, a capture service that is down or answers
 * nonsense, a model that fails, answers that cannot be read; leaving the mode in the middle of a pass; a pack that is
 * incomplete; the modes it excludes.
 */
import { describe, expect, it, vi } from 'vitest'
import { createCommentaryController } from '../../src/modes/controllers/commentary.ts'
import { ConfigError } from '../../src/config.ts'
import { jpegBase64, notFound, win } from './fakeCapture.ts'
import { fakeHost } from './fakeHost.ts'
import { analysis, commentaryRig, identification, useCommentaryRig } from './commentaryRig.ts'
import type { Rig } from './commentaryRig.ts'

useCommentaryRig()

const alarm = (
  r: { f: { alarms: { code: string; message: string; level: string }[] } },
  code: string
) => r.f.alarms.find((a) => a.code === code)

describe('black pictures', () => {
  it('are skipped without a model call, counted, and reported after three in a row; the first lit picture clears the alarm', async () => {
    const r = await commentaryRig()
    r.fake.script = [
      { kind: 'frame', black: true },
      { kind: 'frame', black: true },
      { kind: 'frame', black: true },
    ]
    await r.enter()
    await r.tick(1500)
    expect(r.f.llm.requests).toHaveLength(0)
    expect(r.f.told).toHaveLength(0)
    expect(r.ctl.status()).toMatchObject({ blackFrames: 1, blackStreak: 1 })
    expect(r.alarms()).toEqual([]) // one black picture can be a loading screen
    expect(r.panel()?.status).toBe(
      'the window is black: exclusive fullscreen? (this picture is skipped)'
    )

    await r.tick(8000)
    expect(r.alarms()).toEqual([])
    await r.tick(8000)
    expect(r.f.llm.requests).toHaveLength(0)
    expect(alarm(r, 'commentary_black')).toMatchObject({ level: 'warn', subject: 'commentary' })
    expect(alarm(r, 'commentary_black')?.message).toContain(
      '"Some Game - World 1" has been black for 3 pictures in a row'
    )
    expect(alarm(r, 'commentary_black')?.message).toContain('exclusive-fullscreen')
    expect(alarm(r, 'commentary_black')?.message).toContain('windowed or borderless')
    expect(r.ctl.status()).toMatchObject({ blackFrames: 3, blackStreak: 3 })

    await r.tick(8000)
    expect(r.alarms()).toEqual([])
    expect(r.ctl.status()).toMatchObject({ blackFrames: 3, blackStreak: 0, problem: null })
    expect(r.f.told).toHaveLength(1)
    expect(r.f.told[0]?.opts?.images?.[0]?.base64).toBe(jpegBase64(4))
  })

  it('are looked at again after the usual interval, not after a back-off', async () => {
    const r = await commentaryRig()
    r.fake.otherwise = () => ({ kind: 'frame', black: true })
    await r.enter()
    for (let i = 0; i < 6; i++) await r.tick(i === 0 ? 1500 : 8000)
    expect(r.fake.calls).toHaveLength(6)
    expect(r.f.alarms.filter((a) => a.code === 'commentary_black')).toHaveLength(1) // one alarm, kept up to date
  })

  it('raise the alarm at once when the setting says so', async () => {
    const r = await commentaryRig({ settings: { black_alarm_after: 1 } })
    r.fake.script = [{ kind: 'frame', black: true }]
    await r.enter()
    await r.tick(1500)
    expect(r.alarms()).toEqual(['commentary_black'])
  })

  it('cost nothing when the check is turned off: the model is asked about a dark picture like any other', async () => {
    const r = await commentaryRig({ settings: { black_threshold: 0 } })
    await r.enter()
    await r.tick(1500)
    expect(r.fake.calls[0]?.blackThreshold).toBe(0)
  })

  it('go away with the window: choosing another window clears the alarm and looks again at once', async () => {
    const r = await commentaryRig({ settings: { black_alarm_after: 1, window: null } })
    r.fake.otherwise = () => ({ kind: 'frame', black: true })
    r.fake.windows = [win('101', 'Overlay'), win('102', 'Game')]
    await r.enter()
    await r.act({ action: 'use_window', row: '101' })
    await r.tick(0)
    expect(r.alarms()).toEqual(['commentary_black'])
    r.fake.otherwise = () => ({ kind: 'frame' })
    await r.act({ action: 'use_window', row: '102' })
    expect(r.alarms()).toEqual([])
    await r.tick(0)
    expect(r.f.told).toHaveLength(1)
  })
})

describe('a capture that fails', () => {
  it('says so when the capture service is not running, and tries again at the usual interval, without asking the model', async () => {
    const r = await commentaryRig()
    await r.enter()
    r.svc.status = 'failed'
    await r.tick(1500)
    expect(alarm(r, 'commentary_capture')?.message).toBe(
      'cannot capture "Some Game": the screen capture service is not running: it starts with the mode'
    )
    expect(r.f.llm.requests).toHaveLength(0)
    expect(r.f.told).toHaveLength(0)
    expect(r.panel()?.status).toContain('the screen capture service is not running')
    await r.tick(20_000)
    expect(r.alarms()).toEqual(['commentary_capture']) // still one, not one per try
    r.svc.status = 'ready'
    await r.tick(8000)
    expect(r.alarms()).toEqual([]) // no back-off: it was looked at again within one interval
    expect(r.f.told).toHaveLength(1)
    expect(r.panel()?.status).not.toContain('not running')
  })

  it('says which window it could not find, and finds it again when it is back', async () => {
    const r = await commentaryRig()
    r.fake.windows = []
    await r.enter()
    await r.tick(1500)
    expect(alarm(r, 'commentary_capture')?.message).toContain(
      'cannot capture "Some Game": no visible window matches "Some Game"'
    )
    await r.tick(8000)
    expect(r.f.llm.requests).toHaveLength(0)
    r.fake.windows = [win('101', 'Some Game - World 1')]
    await r.tick(8000)
    expect(r.alarms()).toEqual([])
    expect(r.f.told).toHaveLength(1)
  })

  it('says when the window is minimised, and what the service reported', async () => {
    const r = await commentaryRig()
    r.fake.script = [
      {
        kind: 'error',
        status: 409,
        code: 'window_minimized',
        message: 'the window is minimised: restore it so it can be captured',
      },
    ]
    await r.enter()
    await r.tick(1500)
    expect(alarm(r, 'commentary_capture')?.message).toContain('the window is minimised: restore it')
  })

  it('says when the service answers nonsense or fails', async () => {
    const r = await commentaryRig()
    r.fake.script = [{ kind: 'garbage', body: 'x' }]
    await r.enter()
    await r.tick(1500)
    expect(alarm(r, 'commentary_capture')?.message).toContain('answered nonsense')
    r.fake.script = [
      {
        kind: 'error',
        status: 500,
        code: 'capture_failed',
        message: 'PrintWindow failed (Windows error 5)',
      },
    ]
    await r.tick(8000)
    expect(alarm(r, 'commentary_capture')?.message).toContain(
      'PrintWindow failed (Windows error 5)'
    )
    expect(r.f.alarms.filter((a) => a.code === 'commentary_capture')).toHaveLength(1)
    await r.tick(8000)
    expect(r.alarms()).toEqual([])
  })

  it('keeps a failing capture out of the model: nothing is read, nothing is said', async () => {
    const r = await commentaryRig()
    r.fake.otherwise = () => notFound('Some Game')
    await r.enter()
    await r.tick(1500)
    for (let i = 0; i < 5; i++) await r.tick(8000)
    expect(r.fake.calls).toHaveLength(6)
    expect(r.f.llm.requests).toHaveLength(0)
    expect(r.f.told).toHaveLength(0)
  })

  it('does not raise an alarm for a capture that was cancelled because the mode was left', async () => {
    const r = await commentaryRig()
    r.fake.script = [{ kind: 'hang' }]
    await r.enter()
    await r.tick(1500)
    expect(r.fake.calls).toHaveLength(1)
    await r.exit()
    expect(r.fake.calls[0]?.signal?.aborted).toBe(true)
    await r.tick(0)
    expect(r.alarms()).toEqual([])
  })
})

describe('a model that fails', () => {
  const failing = () => {
    throw new Error('quota exceeded')
  }

  it('is waited on longer each time, up to a limit, and the alarm says why', async () => {
    const r = await commentaryRig()
    r.model.identify = failing
    await r.enter()
    await r.tick(1500)
    expect(r.fake.calls).toHaveLength(1)
    expect(alarm(r, 'commentary_model')).toMatchObject({ level: 'warn', subject: 'commentary' })
    expect(alarm(r, 'commentary_model')?.message).toBe(
      'the model did not answer (quota exceeded): commentary waits longer between tries until it does'
    )
    expect(r.panel()?.status).toBe(
      'the model is not answering (quota exceeded); trying again in 16 s'
    )
    expect(r.ctl.status().modelFailures).toBe(1)
    expect(r.f.told).toHaveLength(0) // nothing is asked of a model that cannot be reached

    // the tries come 16 s, 32 s, 64 s after the one before, then every 120 s (the limit)
    const started = r.f.clock.now - 1500 // when the mode was entered
    const upTo = (ms: number) => r.tick(started + ms - r.f.clock.now)
    const tries = [1500 + 16_000, 1500 + 16_000 + 32_000, 1500 + 16_000 + 32_000 + 64_000]
    tries.push(tries[2]! + 120_000, tries[2]! + 240_000)
    for (const [i, at] of tries.entries()) {
      await upTo(at - 100)
      expect(r.fake.calls, `just before try ${i + 2}`).toHaveLength(i + 1)
      await upTo(at + 100)
      expect(r.fake.calls, `just after try ${i + 2}`).toHaveLength(i + 2)
    }
    expect(r.ctl.status().modelFailures).toBe(6)
    expect(r.f.alarms.filter((a) => a.code === 'commentary_model')).toHaveLength(1)
  })

  it('is forgiven at the first answer: the alarm goes and the rounds go back to the usual interval', async () => {
    const r = await commentaryRig()
    let failures = 2
    r.model.identify = () => {
      if (failures-- > 0) throw new Error('the model is overloaded')
      return identification('Some Game')
    }
    await r.enter()
    await r.tick(1500) // fails
    await r.tick(16_000) // fails
    expect(r.alarms()).toEqual(['commentary_model'])
    await r.tick(32_000) // answers
    expect(r.alarms()).toEqual([])
    expect(r.ctl.status()).toMatchObject({ modelFailures: 0, problem: null, game: 'Some Game' })
    expect(r.f.told).toHaveLength(1)
    await r.tick(7900)
    expect(r.f.told).toHaveLength(1)
    await r.tick(200)
    expect(r.f.told).toHaveLength(2) // the usual 8 s again
  })

  it('backs off no further than the limit in the settings', async () => {
    const r = await commentaryRig({ settings: { max_backoff_sec: 30 } })
    r.model.identify = failing
    await r.enter()
    await r.tick(1500)
    await r.tick(16_000) // second try
    expect(r.fake.calls).toHaveLength(2)
    await r.tick(29_900)
    expect(r.fake.calls).toHaveLength(2)
    await r.tick(200) // 30 s, not 32
    expect(r.fake.calls).toHaveLength(3)
    await r.tick(30_100)
    expect(r.fake.calls).toHaveLength(4)
  })

  it('is handled when it is the screen-reading call that fails, and the comment call', async () => {
    const r = await commentaryRig()
    await r.enter()
    await r.tick(1500)
    expect(r.f.told).toHaveLength(1)
    r.model.analyze = () => {
      throw new Error('HTTP 503')
    }
    await r.tick(8000)
    expect(alarm(r, 'commentary_model')?.message).toContain('HTTP 503')
    expect(r.f.told).toHaveLength(1)
    r.model.analyze = () => analysis('recovered')
    await r.tick(16_000)
    expect(r.alarms()).toEqual([])
    expect(r.f.told).toHaveLength(2)

    r.f.brain.failTell = true
    await r.tick(8000)
    expect(r.f.told).toHaveLength(3) // asked, and it failed
    expect(alarm(r, 'commentary_model')?.message).toContain('the model is away')
    r.f.brain.failTell = false
    await r.tick(16_000)
    expect(r.alarms()).toEqual([])
    expect(r.f.told).toHaveLength(4)
  })

  it('does not wait out a back-off when the operator picks a window: that is a fresh start', async () => {
    const r = await commentaryRig({ settings: { window: null } })
    r.model.identify = failing
    r.fake.windows = [win('101', 'Game A'), win('102', 'Game B')]
    await r.enter()
    await r.act({ action: 'use_window', row: '101' })
    await r.tick(0)
    expect(r.fake.calls).toHaveLength(1) // failed: 16 s to the next try
    r.model.identify = () => identification('Game B')
    await r.act({ action: 'use_window', row: '102' })
    await r.tick(0)
    expect(r.fake.calls).toHaveLength(2)
    expect(r.f.told).toHaveLength(1)
    expect(r.alarms()).toEqual([])
  })

  it('cannot be reached at all: nothing is held, nothing is left on, and the stage is left alone', async () => {
    const r = await commentaryRig()
    r.model.identify = failing
    await r.enter()
    await r.tick(1500)
    await r.tick(60_000)
    expect(r.f.held).toEqual([])
    expect(r.f.voiceStyles).toEqual([])
    expect(r.f.said).toEqual([])
    expect(r.f.hub.sent).toEqual([])
    expect(r.f.hub.overlays).toEqual([])
    expect(r.f.hub.looks).toEqual([])
    expect(r.f.hub.scenes).toEqual([])
    expect(r.f.flags).toEqual({ dancing: false, singing: false, sleeping: false })
    await r.exit()
    expect(r.alarms()).toEqual([]) // leaving the mode takes its alarms with it
  })
})

describe('answers that cannot be read', () => {
  it('do not stop the commentary; after three in a row they are reported, and a good one clears the report', async () => {
    const r = await commentaryRig()
    let bad = 3
    r.model.identify = () =>
      bad-- > 0 ? 'I think this is probably some kind of game.' : identification('Some Game')
    await r.enter()
    await r.tick(1500)
    await r.tick(8000)
    expect(r.f.told).toHaveLength(2) // still commenting
    expect(r.alarms()).toEqual([])
    expect(r.ctl.status().game).toBe('')
    await r.tick(8000)
    expect(alarm(r, 'commentary_analysis')?.message).toContain('could not be read 3 times in a row')
    expect(alarm(r, 'commentary_analysis')?.message).toContain('game memory is not being updated')
    expect(r.f.logs.filter((l) => l.msg.includes('could not be read'))).toHaveLength(3)
    await r.tick(8000)
    expect(r.alarms()).toEqual([])
    expect(r.ctl.status().game).toBe('Some Game')
  })

  it('is the same for the notes on the screen', async () => {
    const r = await commentaryRig()
    r.model.analyze = () => 'nothing to report'
    await r.enter()
    await r.tick(1500)
    for (let i = 0; i < 3; i++) await r.tick(8000)
    expect(r.alarms()).toEqual(['commentary_analysis'])
    expect(r.f.told).toHaveLength(4)
    expect(r.ctl.status().scene).toBe('a forest at dusk') // what was known before is kept
  })
})

describe('leaving the mode in the middle of a pass', () => {
  it('cancels the question to the model, says nothing more, and raises no alarm for the cancellation', async () => {
    const r = await commentaryRig()
    r.model.identify = () => new Promise<string>(() => undefined) // the model never answers
    await r.enter()
    await r.tick(1500)
    expect(r.llm('commentary-identify')).toHaveLength(1)
    const request = r.llm('commentary-identify')[0]
    expect(request?.signal?.aborted).toBe(false)
    await r.exit()
    expect(request?.signal?.aborted).toBe(true)
    expect(r.service.state('commentary')).toBe('IDLE')
    await r.tick(120_000)
    expect(r.f.told).toHaveLength(0)
    expect(r.llm('commentary-identify')).toHaveLength(1)
    expect(r.fake.calls).toHaveLength(1)
    expect(r.alarms()).toEqual([])
    expect(vi.getTimerCount()).toBe(0) // nothing of it is left running
  })

  it('does not wait for a comment that is being written', async () => {
    const r = await commentaryRig()
    let release!: () => void
    r.gates.tell = new Promise<void>((resolve) => (release = resolve))
    await r.enter()
    await r.tick(1500)
    expect(r.f.told).toHaveLength(1)
    await r.exit() // returns at once
    expect(r.service.state('commentary')).toBe('IDLE')
    release()
    await r.tick(60_000)
    expect(r.f.told).toHaveLength(1)
    expect(r.ctl.status()).toMatchObject({ running: false, rounds: 0 })
    expect(r.alarms()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is the same when the whole program shuts down', async () => {
    const r = await commentaryRig()
    r.model.identify = () => new Promise<string>(() => undefined)
    await r.enter()
    await r.tick(1500)
    await r.service.dispose()
    expect(r.service.state('commentary')).toBe('IDLE')
    await r.tick(120_000)
    expect(r.f.told).toHaveLength(0)
    expect(r.fake.calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(r.svc.stopped).toBe(1) // and the capture service goes with it
  })

  it('leaves a pass that was cut off from changing what is remembered, even when the mode is entered again at once', async () => {
    const r = await commentaryRig()
    let calls = 0
    let firstAnswer!: (text: string) => void
    r.model.identify = () =>
      ++calls === 1
        ? new Promise<string>((resolve) => (firstAnswer = resolve))
        : identification('Game B')
    await r.enter()
    await r.tick(1500) // the first pass waits for the model
    await r.exit()
    await r.enter()
    await r.tick(1500)
    expect(r.ctl.status()).toMatchObject({ game: 'Game B', rounds: 1 })
    firstAnswer(identification('Game A')) // too late: that pass was cancelled
    await r.tick(0)
    expect(r.ctl.status()).toMatchObject({ game: 'Game B', rounds: 1 })
    expect((await r.saved()).game).toBe('Game B')
    expect(r.f.told).toHaveLength(1)
  })

  it('does not start when it is told to leave while it is still starting', async () => {
    const r = await commentaryRig()
    const controller = r.ctl
    expect(controller).toBeDefined()
    const ctl = new AbortController()
    ctl.abort()
    await r.ctl.enter({
      id: 'commentary',
      manifest: r.service.manifest('commentary') as never,
      signal: ctl.signal,
      log: () => {},
    })
    expect(r.ctl.status().running).toBe(false)
    await r.tick(60_000)
    expect(r.fake.calls).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is stopped by the abort of the context it was started with, without exit being called: a start that failed leaves no loop behind', async () => {
    const r = await commentaryRig()
    const teardown = new AbortController()
    await r.ctl.enter({
      id: 'commentary',
      manifest: r.service.manifest('commentary') as never,
      signal: teardown.signal,
      log: () => {},
    })
    await r.tick(1500)
    expect(r.f.told).toHaveLength(1)
    expect(r.ctl.status().running).toBe(true)
    teardown.abort() // what the manager does when the mode is torn down, whether or not the start finished
    expect(r.ctl.status().running).toBe(false)
    await r.tick(60_000)
    expect(r.f.told).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is not stopped by the abort of an earlier start, when it has been entered again since', async () => {
    const r = await commentaryRig()
    const first = new AbortController()
    const enterWith = (signal: AbortSignal) =>
      r.ctl.enter({
        id: 'commentary',
        manifest: r.service.manifest('commentary') as never,
        signal,
        log: () => {},
      })
    await enterWith(first.signal)
    const second = new AbortController()
    await enterWith(second.signal) // replaces the first run
    first.abort() // the old context is torn down late
    expect(r.ctl.status().running).toBe(true)
    await r.tick(1500)
    expect(r.f.told).toHaveLength(1)
    second.abort()
    expect(r.ctl.status().running).toBe(false)
  })

  it('can be entered again and works as new', async () => {
    const r = await commentaryRig({ settings: { analysis_every: 0 } })
    await r.enter()
    await r.tick(1500)
    await r.exit()
    await r.enter()
    await r.tick(1500)
    await r.tick(8000)
    expect(r.f.told).toHaveLength(3)
    expect(r.ctl.status().rounds).toBe(3)
    expect(r.svc.stopped).toBe(1) // the capture service went with the first run and came back with the second
    expect(r.svc.started).toBe(1)
  })
})

describe('a pack that is not complete', () => {
  it('stops the mode from starting, says which files are missing, and lets go of the capture service', async () => {
    const r = await commentaryRig({
      pack: (real) => {
        const prompts = new Map(real.prompts)
        prompts.delete('round')
        prompts.delete('analyze')
        return { ...real, prompts }
      },
    })
    const alarms: string[] = []
    r.service.on('alarm', (code, message) => alarms.push(`${code}: ${message}`))
    r.svc.status = 'stopped'
    await expect(r.enter()).rejects.toMatchObject({
      httpStatus: 409,
      message: expect.stringContaining('no prompts/round.md, prompts/analyze.md'),
    })
    expect(alarms.join()).toContain('mode_start_failed')
    expect(alarms.join()).toContain('the commentary pack is incomplete')
    expect(r.service.state('commentary')).toBe('IDLE')
    expect(r.svc.stopped).toBe(1)
    await r.tick(60_000)
    expect(r.fake.calls).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('has every prompt file the controller asks for', async () => {
    const r = await commentaryRig()
    await r.enter()
    // every fragment renders with no placeholder left over
    for (const [name, vars] of [
      ['round', {}],
      ['identify', { game: 'G', language: 'L' }],
      ['analyze', { game: 'G', scene: 'S', language: 'L' }],
      ['summarize', { game: 'G', summary: 'S', scenes: '1. x', language: 'L', limit: '300' }],
      ['screen_known', { game: 'G', seen: 'x' }],
      ['screen_unsure', {}],
      ['seen', { scene: 'S' }],
      ['progress', { summary: 'S' }],
    ] as const) {
      const text = r.f.host.prompt('commentary', name, { ...vars })
      expect(text, name).not.toBeNull()
      expect(text, name).not.toMatch(/\{\{/)
      expect(text?.trim().length, name).toBeGreaterThan(5)
    }
  })
})

describe('the modes it excludes', () => {
  const others = ['dance', 'sing', 'draw', 'game']

  it.each(others)('is refused while %s is active, and replaces it when told to', async (other) => {
    const r = await commentaryRig({ others: true })
    await r.service.enter(other)
    await expect(r.enter()).rejects.toMatchObject({ httpStatus: 409, code: 'excluded' })
    await expect(r.enter()).rejects.toThrow(other)
    expect(r.service.state('commentary')).toBe('IDLE')
    expect(await r.act({ action: 'start' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('excludes'),
    })
    expect(await r.act({ action: 'start', replace: true })).toEqual({ ok: true })
    expect(r.service.state(other)).toBe('IDLE')
    expect(r.service.state('commentary')).toBe('ACTIVE')
    await r.tick(1500)
    expect(r.f.told).toHaveLength(1)
  })

  it.each(others)(
    'refuses %s while it is active, and is left when %s replaces it',
    async (other) => {
      const r = await commentaryRig({ others: true })
      await r.enter()
      await r.tick(1500)
      await expect(r.service.enter(other)).rejects.toMatchObject({
        httpStatus: 409,
        code: 'excluded',
      })
      expect(r.service.state('commentary')).toBe('ACTIVE')
      await r.service.enter(other, { replace: true })
      expect(r.service.state('commentary')).toBe('IDLE')
      expect(r.ctl.status().running).toBe(false)
      expect(r.alarms()).toEqual([])
      const told = r.f.told.length
      await r.tick(60_000)
      expect(r.f.told).toHaveLength(told)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('is interrupted by sleep, which preempts everything, and cannot be entered while it lasts', async () => {
    const r = await commentaryRig({ others: true })
    await r.enter()
    await r.tick(1500)
    await r.service.enter('sleep')
    expect(r.service.state('commentary')).toBe('IDLE')
    expect(r.service.state('sleep')).toBe('ACTIVE')
    await expect(r.enter()).rejects.toMatchObject({ httpStatus: 409, code: 'blocked' })
    await r.service.exit('sleep')
    await r.enter()
    await r.tick(1500)
    expect(r.f.told).toHaveLength(2)
  })

  it('may be entered next to nothing else, and only once', async () => {
    const r = await commentaryRig({ others: true })
    const [first, second] = await Promise.all([
      r.act({ action: 'start' }),
      r.act({ action: 'start' }),
    ])
    expect([first, second]).toEqual([{ ok: true }, { ok: true }])
    expect(r.service.state('commentary')).toBe('ACTIVE')
    await r.tick(1500)
    expect(r.f.told).toHaveLength(1) // one loop, not two
    expect(r.fake.calls).toHaveLength(1)
  })
})

describe('leaving the mode takes every alarm of it away', () => {
  const cases: {
    code: string
    settings?: Record<string, unknown>
    arrange: (r: Rig) => void
    ticks: number[]
  }[] = [
    {
      code: 'commentary_black',
      settings: { black_alarm_after: 1 },
      arrange: (r) => void (r.fake.otherwise = () => ({ kind: 'frame', black: true })),
      ticks: [1500],
    },
    { code: 'commentary_capture', arrange: (r) => void (r.fake.windows = []), ticks: [1500] },
    {
      code: 'commentary_model',
      arrange: (r) =>
        void (r.model.identify = () => {
          throw new Error('quota exceeded')
        }),
      ticks: [1500],
    },
    {
      code: 'commentary_analysis',
      arrange: (r) => void (r.model.identify = () => 'no json at all'),
      ticks: [1500, 8000, 8000],
    },
    { code: 'commentary_window', settings: { window: null }, arrange: () => {}, ticks: [1500] },
  ]

  it.each(cases)('$code, when the mode is left', async ({ code, settings, arrange, ticks }) => {
    const r = await commentaryRig(settings ? { settings } : {})
    arrange(r)
    await r.enter()
    for (const t of ticks) await r.tick(t)
    expect(r.alarms()).toEqual([code])
    await r.exit()
    expect(r.alarms()).toEqual([])
  })

  it.each(cases)(
    '$code, when the program shuts down',
    async ({ code, settings, arrange, ticks }) => {
      const r = await commentaryRig(settings ? { settings } : {})
      arrange(r)
      await r.enter()
      for (const t of ticks) await r.tick(t)
      expect(r.alarms()).toEqual([code])
      await r.service.dispose()
      expect(r.alarms()).toEqual([])
    }
  )
})

describe('the settings', () => {
  it('stop the program at start-up when they are wrong, naming the setting', async () => {
    const f = await fakeHost({
      config: { modes: { commentary: { enabled: true, config: { interval_sec: 1, window: 5 } } } },
    })
    expect(() => createCommentaryController(f.host)).toThrow(ConfigError)
    expect(() => createCommentaryController(f.host)).toThrow('modes.commentary.config.interval_sec')
    expect(() => createCommentaryController(f.host)).toThrow('modes.commentary.config.window')
  })

  it('reach the service and the model as they were given', async () => {
    const r = await commentaryRig({
      settings: {
        capture_width: 512,
        capture_quality: 60,
        capture_method: 'screen',
        black_threshold: 20,
        model_timeout_sec: 45,
        language: 'Chinese',
      },
    })
    await r.enter()
    await r.tick(1500)
    expect(r.fake.calls[0]).toMatchObject({
      maxWidth: 512,
      quality: 60,
      method: 'screen',
      blackThreshold: 20,
    })
    expect(r.llm('commentary-identify')[0]?.timeoutMs).toBe(45_000)
    expect(JSON.stringify(r.llm('commentary-identify')[0]?.user)).toContain('Chinese')
  })

  it('name the capture service the mode talks to (the pack has to require the same one)', async () => {
    const r = await commentaryRig({ settings: { service: 'elsewhere' } })
    const asked: string[] = []
    const real = r.f.host.serviceUrl
    r.f.host.serviceUrl = (name) => (asked.push(name), real(name))
    await r.enter()
    await r.tick(1500)
    expect(new Set(asked)).toEqual(new Set(['elsewhere']))
    // nothing provides that service here, so there is nothing to capture with, and the operator is told
    expect(r.alarms()).toEqual(['commentary_capture'])
    expect(r.f.told).toHaveLength(0)
  })
})
