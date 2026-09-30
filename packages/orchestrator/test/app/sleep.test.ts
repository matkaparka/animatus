import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FORMATS } from '../../src/inbox/formats.ts'
import type { LlmRequest } from '../../src/llm/types.ts'
import type { FakeStage } from '../_stage-support/fake-stage.ts'
import { danmaku, installCleanup, rig, tempDir, until } from './rig.ts'
import type { Rig, RigOptions } from './rig.ts'
import { answerSleep } from './sleepStage.ts'

installCleanup()

const MODES = path.resolve(__dirname, '../../../../modes')
const NO_FLAGS = { replace: false, force: false }

const lastText = (req: LlmRequest) => String(req.messages.at(-1)?.content ?? '')
const systemText = (req: LlmRequest) => String(req.messages[0]?.content ?? '')
const jsonOf = (stage: FakeStage, type: string) =>
  stage.stage.json().filter((m) => m.type === type) as Record<string, any>[] // eslint-disable-line @typescript-eslint/no-explicit-any

/** Two tracks: "aa-rain" in two formats with timings, and "bb-ocean"; a draft folder that must not be played. */
const TRACKS: Record<string, string> = {
  'aa-rain.mp3': 'not really audio',
  'aa-rain.wav': 'not really audio, and bigger',
  'aa-rain.json': JSON.stringify({
    duration_s: 60,
    lines: [
      { n: 1, text: 'close your eyes', start: 1.5, end: 4 },
      { n: 2, text: 'slowly', start: 6, end: 8 },
    ],
  }),
  'bb-ocean.wav': 'not really audio',
  '_drafts/skip-me.mp3': 'not really audio',
}

interface SleepRigOptions {
  /** Leave `paths.asmr` out. */
  noLibrary?: boolean
  noWhisper?: boolean
  settings?: Record<string, unknown>
  dances?: boolean
  /** More mode packs (folders holding `<id>/mode.yaml` or just prompts). */
  extraModes?: string[]
}

/** A rig with the sleep mode on, an asmr folder, a whisper voice, a night background, and chat replies that come quickly. */
function sleepRig(over: SleepRigOptions = {}): RigOptions {
  return {
    app: { modesDirs: [MODES, ...(over.extraModes ?? [])] },
    prepare: async (dir) => {
      const asmr = path.join(dir, 'asmr')
      for (const [name, body] of Object.entries(TRACKS)) {
        await mkdir(path.dirname(path.join(asmr, name)), { recursive: true })
        await writeFile(path.join(asmr, name), body)
      }
      const motions = path.join(dir, 'motions')
      if (over.dances) {
        const d = path.join(motions, 'dance', 'aipao')
        await mkdir(d, { recursive: true })
        await writeFile(path.join(d, 'motion.vrma'), 'x')
        await writeFile(path.join(d, 'music.ogg'), 'x')
      }
      return {
        paths: {
          data_dir: path.join(dir, 'data'),
          ...(over.noLibrary ? {} : { asmr }),
          ...(over.dances ? { motions } : {}),
        },
        tts: {
          styles: {
            neutral: { ref_audio: 'C:/ref/neutral.wav', ref_text: 'normal speech' },
            ...(over.noWhisper ? {} : { whisper: { ref_audio: 'C:/ref/w.wav', ref_text: 'hush' } }),
          },
          default_style: 'neutral',
        },
        stage: { presets: { backgrounds: { night: { kind: 'color', color: '#0a1020' } } } },
        modes: {
          sleep: {
            enabled: true,
            config: {
              fade_s: 0.05,
              fade_in_s: 0.05,
              reply_resume_delay_s: 0.1,
              ...over.settings,
            },
          },
          ...(over.dances
            ? { dance: { enabled: true, config: { cooldown_sec: 0, outro_window_sec: 1 } } }
            : {}),
        },
        inbox: {
          sleep: { first_reply_after_sec: 0.05, reply_interval_sec: 0.6 },
          pacer: { idle_settle_sec: 0.05, min_interval_sec: 0.05, busy_timeout_sec: 5 },
          gift: { merge_window_sec: 0.05 },
        },
      }
    },
  }
}

/** The status line of the mode's panel, as the console reads it. */
const statusOf = (r: Rig) => r.app.modeViews().find((m) => m.id === 'sleep')?.panel?.status

/** Connects a stage page that answers `sleep.*`, and waits until the program sees it. */
async function page(r: Rig, opts?: Parameters<typeof answerSleep>[1]) {
  const stage = await r.connect({ danceMs: 60_000 })
  const probe = answerSleep(stage, opts)
  await until(() => r.app.stage.hub.connected, 2000, 'the stage page')
  return { stage, probe }
}

describe('sleep mode, through the whole program', () => {
  it('entering from the console: the first track goes to the page, from a URL the asset route serves; the calm look, the night background and the flag are in place', async () => {
    const r = await rig(sleepRig())
    const { stage, probe } = await page(r)
    await until(() => jsonOf(stage, 'look.set').length >= 1, 3000, 'the first look')

    const view = await r.app.modeAction('sleep', 'enter', NO_FLAGS)
    expect(view.id).toBe('sleep')
    await until(() => probe.ofType('sleep.play').length >= 1, 3000, 'sleep.play')
    await until(() => probe.model.phase === 'playing', 2000, 'the track playing')

    const play = probe.ofType('sleep.play')[0]!
    expect(play).toMatchObject({
      url: '/asset/asmr/aa-rain.mp3', // the mp3 of the two formats, and not the draft folder's file
      volume: 1,
      fade_in_s: 0.05,
      captions: [
        { text: 'close your eyes', start: 1.5, end: 4 },
        { text: 'slowly', start: 6, end: 8 },
      ],
    })
    expect(r.app.modes.state('sleep')).toBe('ACTIVE')
    expect(r.app.flags.sleeping).toBe(true)

    // the look and the background come from the pack and the operator's presets
    await until(() => jsonOf(stage, 'look.set').at(-1)?.calm === 1, 3000, 'the calm look')
    expect(jsonOf(stage, 'look.set').at(-1)).toMatchObject({
      calm: 1,
      motion_scale: 1,
      mouth_scale: 0.4,
      lip_range: { min: -2.6, max: -1 },
      light: 0.6,
    })
    await until(() => jsonOf(stage, 'scene.set').at(-1)?.background.kind === 'color', 3000)
    expect(jsonOf(stage, 'scene.set').at(-1)!.background).toEqual({
      kind: 'color',
      color: '#0a1020',
    })

    // the page really can fetch what it was told to play, in pieces
    const asset = new URL(String(play.url), r.app.stage.url)
    const whole = await fetch(asset)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('audio/mpeg')
    const part = await fetch(asset, { headers: { Range: 'bytes=0-3' } })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('not ')
    expect((await fetch(new URL('/asset/asmr/_drafts/skip-me.mp3', r.app.stage.url))).status).toBe(
      200
    ) // served if asked for, but never played
    expect(r.app.alarms.list()).toEqual([])
  })

  it('a chat line is answered in a whisper: the track fades out first, the model is given the reply line and the marked message, the track comes back after the voice is quiet', async () => {
    const r = await rig(sleepRig())
    r.llm.reply = () => ['[relaxed]Sleep well, ann.']
    const { stage, probe } = await page(r)
    await r.app.modeAction('sleep', 'enter', NO_FLAGS)
    await until(() => probe.model.phase === 'playing', 3000, 'the track')

    r.bili.emit(danmaku('good night everyone'))
    await until(() => r.llm.requests.length >= 1, 5000, 'the model call')
    const req = r.llm.requests[0]!
    expect(lastText(req)).toBe(`${FORMATS.sleepPrefix}ann：good night everyone`)
    expect(systemText(req)).toContain('It is sleep time') // the mode's own prompt
    expect(systemText(req)).toContain('Sleep time. The latest message') // the reply line, for this reply only
    expect(systemText(req)).not.toContain('good night everyone') // the viewer's words are only the user message

    await until(() => stage.begins.length >= 1, 5000, 'the whisper at the stage')
    await until(() => probe.ofType('sleep.resume').length >= 1, 8000, 'the track coming back')
    expect(r.tts.requests[0]!.style).toBe('whisper')
    expect(stage.ended).toBeGreaterThanOrEqual(1) // the resume came after the whisper was over

    const order = stage.stage.json().map((m) => m.type)
    const at = (type: string) => order.indexOf(type)
    expect(at('sleep.pause')).toBeGreaterThan(-1)
    expect(at('sleep.pause')).toBeLessThan(at('utterance.begin'))
    expect(at('utterance.begin')).toBeLessThan(at('sleep.resume'))
    expect(probe.ofType('sleep.play')).toHaveLength(1) // the same track, not a new one
    await until(() => probe.model.phase === 'playing', 2000, 'playing again')
    expect(
      r.app.runLog
        .recent(80)
        .some((e) => e.kind === 'mode' && e.text.includes('whispering a reply'))
    ).toBe(true)
    expect(r.app.alarms.list()).toEqual([])
  })

  it('only chat is answered while she sleeps: a gift waits for the mode to end, and when it is answered the voice is the usual one again', async () => {
    const r = await rig(sleepRig())
    const { stage, probe } = await page(r)
    await r.app.modeAction('sleep', 'enter', NO_FLAGS)
    await until(() => probe.model.phase === 'playing', 3000)

    r.app.inject({ kind: 'gift', name: 'bob', text: '', gift: 'rose', count: 1, price: 30 })
    await new Promise((res) => setTimeout(res, 800))
    expect(r.llm.requests).toEqual([])
    expect(r.app.router.stats().queued[3]).toBe(1) // waiting in the gift queue

    const stopped = await r.app.modeAction('sleep', 'exit', NO_FLAGS)
    expect(stopped.state).toBe('IDLE')
    expect(r.app.flags.sleeping).toBe(false)
    await until(() => probe.ofType('sleep.stop').length >= 1, 3000, 'sleep.stop at the page')
    expect(probe.ofType('sleep.stop')[0]).toMatchObject({ fade_s: 0.05 })

    await until(
      () => r.llm.requests.some((q) => lastText(q).includes('rose')),
      8000,
      'the gift reply'
    )
    const gift = r.llm.requests.find((q) => lastText(q).includes('rose'))!
    expect(systemText(gift)).not.toContain('It is sleep time') // the mode's prompt went with the mode
    await until(() => r.tts.requests.length >= 1, 5000)
    expect(r.tts.requests.at(-1)!.style).not.toBe('whisper')

    // and the stage is back to what the configuration says
    await until(() => jsonOf(stage, 'look.set').at(-1)?.calm === 0, 3000, 'the look restored')
    await until(() => jsonOf(stage, 'scene.set').at(-1)?.background.kind === 'none', 3000)
  })

  it('a program that had no page when the mode started plays the track when one connects, and a page that replaces it gets the track from the start', async () => {
    const r = await rig(sleepRig())
    await r.app.modeAction('sleep', 'enter', NO_FLAGS)
    expect(r.app.modes.state('sleep')).toBe('ACTIVE')
    const first = await page(r)
    await until(
      () => first.probe.ofType('sleep.play').length >= 1,
      3000,
      'the track for the first page'
    )
    await until(() => first.probe.model.phase === 'playing', 2000)

    const second = await page(r)
    await until(
      () => second.probe.ofType('sleep.play').length >= 1,
      3000,
      'the track for the second page'
    )
    expect(second.probe.ofType('sleep.play')[0]).toMatchObject({ url: '/asset/asmr/aa-rain.mp3' })
    await until(() => second.probe.model.phase === 'playing', 2000)
    expect(first.probe.ofType('sleep.play')).toHaveLength(1)
    expect(r.app.alarms.list()).toEqual([])
  })

  it('every track failing to play is an alarm, and the whispers still work without a track to fade', async () => {
    const r = await rig(sleepRig())
    const { stage, probe } = await page(r, { mode: 'error' })
    await r.app.modeAction('sleep', 'enter', NO_FLAGS)
    await until(() => r.app.alarms.list().some((a) => a.code === 'sleep_tracks'), 5000, 'the alarm')
    expect(r.app.alarms.list().find((a) => a.code === 'sleep_tracks')).toMatchObject({
      level: 'error',
    })
    expect(probe.ofType('sleep.play')).toHaveLength(2) // both were tried
    expect(r.app.modes.state('sleep')).toBe('ACTIVE')

    r.bili.emit(danmaku('anyone here?'))
    await until(() => stage.begins.length >= 1, 5000, 'a whisper anyway')
    expect(r.tts.requests[0]!.style).toBe('whisper')
    expect(probe.ofType('sleep.pause')).toHaveLength(0) // nothing was playing
    expect(probe.ofType('sleep.resume')).toHaveLength(0)
  })

  it('with no asmr folder the mode still runs and whispers; the alarm says why nothing plays', async () => {
    const r = await rig(sleepRig({ noLibrary: true }))
    const { stage, probe } = await page(r)
    await r.app.modeAction('sleep', 'enter', NO_FLAGS)
    expect(r.app.modes.state('sleep')).toBe('ACTIVE')
    const alarm = r.app.alarms.list().find((a) => a.code === 'sleep_tracks')!
    expect(alarm.message).toContain('paths.asmr is not set')
    expect(probe.received).toEqual([])
    const panel = r.app.modeViews().find((m) => m.id === 'sleep')!.panel!
    expect(panel.status).toBe('no tracks: only whispered replies')
    expect(panel.sections[0]!.empty).toContain('paths.asmr')

    r.bili.emit(danmaku('hello there'))
    await until(() => stage.begins.length >= 1, 5000, 'a whisper')
    expect(r.tts.requests[0]!.style).toBe('whisper')
    // the reply is over a moment after the voice: the panel is back to its standing line
    await until(() => statusOf(r) === 'no tracks: only whispered replies', 5000, 'the reply to end')
    expect(probe.received).toEqual([]) // there was never a track to pause or bring back
  })

  it('a missing whisper voice is an alarm from the moment the mode starts, and it is gone when the mode ends', async () => {
    const r = await rig(sleepRig({ noWhisper: true }))
    const { probe } = await page(r)
    await r.app.modeAction('sleep', 'enter', NO_FLAGS)
    await until(() => probe.model.phase === 'playing', 3000)
    const alarm = r.app.alarms.list().find((a) => a.code === 'sleep_whisper_style')!
    expect(alarm.level).toBe('warn')
    expect(alarm.message).toContain('"whisper"')
    await r.app.modeAction('sleep', 'exit', NO_FLAGS)
    expect(r.app.alarms.list().some((a) => a.code === 'sleep_whisper_style')).toBe(false)
  })

  it('the console lists the tracks and steers the mode: next, volume, a test line, stop; what cannot be done is a refusal that says why', async () => {
    const r = await rig(sleepRig())
    const { stage, probe } = await page(r)
    const act = (params: Record<string, string | number>) =>
      r.app.modeAction('sleep', 'act', { ...NO_FLAGS, params })

    const idle = r.app.modeViews().find((m) => m.id === 'sleep')!
    expect(idle.state).toBe('IDLE')
    expect(idle.panel!.sections[0]!.rows.map((x) => x.id)).toEqual(['aa-rain', 'bb-ocean'])
    await expect(act({ action: 'next' })).rejects.toMatchObject({
      httpStatus: 409,
      message: 'sleep mode is not running',
    })

    await r.app.modeAction('sleep', 'enter', { ...NO_FLAGS, params: { track: 'bb-ocean' } })
    await until(() => statusOf(r) === 'playing "bb-ocean" (2 of 2)', 3000, 'the track playing')
    expect(probe.ofType('sleep.play')[0]).toMatchObject({ url: '/asset/asmr/bb-ocean.wav' })
    const running = r.app.modeViews().find((m) => m.id === 'sleep')!
    expect(running.panel!.sections[0]!.rows.find((x) => x.id === 'bb-ocean')!.active).toBe(true)

    await act({ action: 'next' })
    await until(() => probe.ofType('sleep.play').length >= 2, 3000, 'the next track')
    expect(probe.ofType('sleep.play')[1]).toMatchObject({ url: '/asset/asmr/aa-rain.mp3' })
    await until(() => probe.model.phase === 'playing', 3000)

    await act({ action: 'volume', volume: 0.4 })
    await until(() => probe.ofType('sleep.resume').length >= 1, 3000, 'the volume change')
    expect(probe.ofType('sleep.resume')[0]).toMatchObject({ volume: 0.4 })
    await expect(act({ action: 'volume', volume: 'loud' })).rejects.toMatchObject({
      httpStatus: 409,
    })

    await act({ action: 'whisper_test' })
    await until(() => stage.begins.length >= 1, 5000, 'the test line at the page')
    expect(r.tts.requests.at(-1)!.style).toBe('whisper')
    expect(r.tts.requests.at(-1)!.text).toContain('晚安') // the pack's default line
    await until(
      () => probe.ofType('sleep.resume').length >= 2,
      8000,
      'the track back after the test line'
    )

    await act({ action: 'stop' })
    expect(r.app.modes.state('sleep')).toBe('IDLE')
    await until(() => probe.ofType('sleep.stop').length >= 1, 3000)
    expect(r.app.flags.sleeping).toBe(false)
  })

  it('sleep interrupts a dance that is running, and then no dance can start', async () => {
    const r = await rig(sleepRig({ dances: true }))
    const { stage } = await page(r)
    await r.app.modeAction('dance', 'enter', NO_FLAGS)
    await until(() => stage.dances.length >= 1, 5000, 'dance.play')
    await until(() => r.app.modes.state('dance') === 'ACTIVE', 2000)

    await r.app.modeAction('sleep', 'enter', NO_FLAGS)
    await until(() => stage.danceStops.length >= 1, 3000, 'dance.stop')
    expect(r.app.modes.state('dance')).toBe('IDLE')
    expect(r.app.modes.state('sleep')).toBe('ACTIVE')
    expect(r.app.flags.dancing).toBe(false)

    await r.app.modeAction('dance', 'enter', NO_FLAGS).catch(() => undefined)
    await new Promise((res) => setTimeout(res, 300))
    expect(stage.dances).toHaveLength(1)
    expect(r.app.modes.state('dance')).toBe('IDLE')
  })

  it('a shutdown in the middle of a reply is prompt and leaves the mode off, the flag down, nothing held', async () => {
    const r = await rig(sleepRig())
    const { probe } = await page(r)
    await r.app.modeAction('sleep', 'enter', NO_FLAGS)
    await until(() => probe.model.phase === 'playing', 3000)
    r.bili.emit(danmaku('good night'))
    await until(() => probe.ofType('sleep.pause').length >= 1, 5000, 'the pause')
    const t0 = Date.now()
    await r.app.stop()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.app.modes.state('sleep')).toBe('IDLE')
    expect(r.app.flags.sleeping).toBe(false)
    expect(r.app.director.held).toBe(false)
  })

  it('an operator can replace a prompt of the pack by a file of the same name, and the rest stays as shipped', async () => {
    const mine = await tempDir('modes')
    await mkdir(path.join(mine, 'sleep', 'prompts'), { recursive: true })
    await writeFile(
      path.join(mine, 'sleep', 'prompts', 'reply.md'),
      '(Answer in two words, softly.)'
    )
    const r = await rig(sleepRig({ extraModes: [mine] }))
    const { stage } = await page(r)
    await r.app.modeAction('sleep', 'enter', NO_FLAGS)
    r.bili.emit(danmaku('good night'))
    await until(() => r.llm.requests.length >= 1, 5000, 'the model call')
    expect(systemText(r.llm.requests[0]!)).toContain('(Answer in two words, softly.)')
    expect(systemText(r.llm.requests[0]!)).toContain('It is sleep time') // the shipped active prompt
    await until(() => stage.begins.length >= 1, 5000)
  })
})
