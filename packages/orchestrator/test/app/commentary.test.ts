/**
 * The commentary mode through the whole program: the real application, the real mode pack, a real stage server with
 * a scripted page, the real HTTP client of the capture service against a fake one (registered as an `external`
 * plugin), and a scripted model. What the tests in test/modes check with fakes for everything is checked here on the
 * real wiring: pictures reaching the model, what is spoken, alarms on the board, exclusion, restarts, shutdown.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LlmRequest } from '../../src/llm/types.ts'
import { createCommentaryController } from '../../src/modes/controllers/commentary.ts'
import { builtinControllers } from '../../src/modes/controllers/index.ts'
import { flushJson } from '../../src/modes/jsonfile.ts'
import { FakeCapture, jpegBase64, notFound } from '../modes/fakeCapture.ts'
import { danmaku, installCleanup, onCleanup, rig, tempDir, until } from './rig.ts'
import type { Rig } from './rig.ts'

installCleanup()

const MODES = path.resolve(__dirname, '../../../../modes')
const NO_FLAGS = { replace: false, force: false }

/** The capture plugin the tests register: the real one starts a Python process, this one is somebody else's server. */
const MANIFEST = `manifest_version: 1
id: screencap
title: Screen capture (test)
kind: custom
service: screencap
runtime:
  type: external
  url: "{config.url}"
health:
  http: { path: /health }
  start_timeout_ms: 5000
  interval_ms: 500
  timeout_ms: 1000
resources:
  gpu: false
`

/** The loop's waits, a hundred times shorter, so that a test does not wait for the real ones. */
const fast = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, Math.max(1, ms / 100))
    signal.addEventListener('abort', done, { once: true })
  })

interface Script {
  identify: () => string | Error
  analyze: () => string | Error
  summary: () => string | Error
  /** What the character says (the model's reply to a comment or to a viewer). */
  chat: (req: LlmRequest) => string[]
}

const contentText = (req: LlmRequest): string => {
  const c = req.messages.at(-1)?.content
  return Array.isArray(c)
    ? ((c.find((p) => p.type === 'text') as { text: string } | undefined)?.text ?? '')
    : (c ?? '')
}
const systemText = (req: LlmRequest) => String(req.messages[0]?.content ?? '')
/** The model's requests that are the character speaking (a comment, or a reply to a viewer). */
const speeches = (r: Rig) => r.llm.requests.filter((q) => q.tag === 'chat')
const isComment = (q: LlmRequest) => contentText(q).startsWith('【系统】')

interface Setup {
  r: Rig
  fake: FakeCapture
  script: Script
  stage: Awaited<ReturnType<Rig['connect']>>
  url: string
}

async function setup(
  opts: {
    settings?: Record<string, unknown>
    /** Files the program should find at start-up. */
    prepare?: (dir: string) => Promise<void>
    dance?: boolean
    pluginEnabled?: boolean
    modeEnabled?: boolean
    stage?: Parameters<Rig['connect']>[0]
  } = {}
): Promise<Setup> {
  const fake = new FakeCapture()
  const served = await fake.serve()
  onCleanup(served.close)
  const plugins = await tempDir('plugins')
  await mkdir(path.join(plugins, 'screencap'), { recursive: true })
  await writeFile(path.join(plugins, 'screencap', 'plugin.yaml'), MANIFEST)

  const script: Script = {
    identify: () =>
      JSON.stringify({ game: 'Some Game', scene: 'a forest at dusk', confidence: 0.9 }),
    analyze: () => JSON.stringify({ scene: 'the player mines stone', switch: false }),
    summary: () => 'They explored a forest and began to build.',
    chat: () => ['[happy]That was a clean jump.'],
  }
  const r = await rig({
    pluginsDir: plugins,
    app: {
      modesDirs: [MODES],
      controllers: {
        ...builtinControllers,
        commentary: (h) => createCommentaryController(h, { sleep: fast }),
      },
    },
    prepare: async (dir) => {
      if (opts.dance) {
        const d = path.join(dir, 'motions', 'dance', 'aipao')
        await mkdir(d, { recursive: true })
        await writeFile(path.join(d, 'motion.vrma'), 'x')
        await writeFile(path.join(d, 'music.ogg'), 'x')
        await writeFile(path.join(d, 'meta.json'), JSON.stringify({ title: 'AIPAO', bpm: 128 }))
      }
      await opts.prepare?.(dir)
      return {}
    },
    config: {
      plugins: { screencap: { enabled: opts.pluginEnabled ?? true, config: { url: served.url } } },
      modes: {
        commentary: {
          enabled: opts.modeEnabled ?? true,
          config: { window: 'Some Game', summary_every: 2, ...opts.settings },
        },
        ...(opts.dance
          ? { dance: { enabled: true, config: { cooldown_sec: 0, outro_window_sec: 1 } } }
          : {}),
      },
    },
  })
  r.llm.reply = (req) => {
    switch (req.tag) {
      case 'commentary-identify':
        return [script.identify()]
      case 'commentary-analyze':
        return [script.analyze()]
      case 'commentary-summary':
        return [script.summary()]
      default:
        return script.chat(req)
    }
  }
  const stage = await r.connect(opts.stage)
  await until(() => r.app.stage.hub.connected, 3000, 'the stage page')
  return { r, fake, script, stage, url: served.url }
}

const enter = (r: Rig) => r.app.modeAction('commentary', 'enter', NO_FLAGS)
const alarmed = (r: Rig, code: string) => r.app.alarms.has(code, 'commentary')

describe('the commentary mode, through the whole program', () => {
  it('names the game before the first comment, shows the model the picture, and never speaks or shows the notes', async () => {
    const { r, fake, script, stage } = await setup()
    script.identify = () =>
      JSON.stringify({
        game: 'Some Game',
        scene: 'SECRET-SCENE [switch] [scene] more',
        confidence: 0.9,
      })
    script.analyze = () => JSON.stringify({ scene: 'SECRET-NOTE', switch: false })
    script.chat = () => ['[happy]That was a clean jump. ', '[angry]Do it again.']
    await enter(r)
    await until(() => stage.begins.length >= 2, 8000, 'the first comment at the stage')

    expect(fake.calls[0]).toMatchObject({ window: 'Some Game', maxWidth: 768, quality: 80 })
    const [first] = speeches(r)
    // the game was identified first, in the same pass, so the very first comment already knows it
    expect(r.llm.requests[0]?.tag).toBe('commentary-identify')
    expect(isComment(first!)).toBe(true)
    expect(systemText(first!)).toContain('You are watching the streamer')
    expect(systemText(first!)).toContain('the game or program on the screen is Some Game')
    // the picture goes with the instruction, as an image part
    const content = first!.messages.at(-1)!.content as {
      type: string
      mime?: string
      base64?: string
    }[]
    expect(content.map((p) => p.type)).toEqual(['text', 'image'])
    expect(content[1]).toMatchObject({ mime: 'image/jpeg', base64: jpegBase64(1) })
    // ...and only for that reply: the record has the instruction and the answer, never the picture
    const record = JSON.stringify(r.app.chat.recent(20))
    expect(record).toContain('new screenshot of the streamer') // the instruction is there
    expect(record).not.toContain(jpegBase64(1))
    expect(record).toContain('That was a clean jump.')

    // what was spoken is what the character said, and nothing the model wrote about the picture
    await until(() => r.tts.requests.length >= 2, 5000, 'speech synthesis')
    const spoken = JSON.stringify([
      r.tts.requests.map((q) => q.text),
      stage.begins.map((b) => b.subtitle),
    ])
    expect(spoken).toContain('clean jump')
    expect(spoken).not.toContain('SECRET')
    expect(spoken).not.toContain('[switch]')
    expect(spoken).not.toContain('[scene]')
    expect(r.app.alarms.list()).toEqual([])
    expect(r.app.modes.state('commentary')).toBe('ACTIVE')
    // it never holds the voice, and never touches the stage beyond the layout its pack asks for
    expect(r.app.flags).toEqual({ dancing: false, singing: false, sleeping: false })
  })

  it('takes the character to the corner, and puts it back when the mode is left', async () => {
    const { r, stage } = await setup()
    // the scene messages the page received, loosely typed (the test looks at a few fields)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scenes = (): any[] =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stage.stage.received.flatMap((x: { kind: string; msg?: any }) =>
        x.kind === 'json' && x.msg.type === 'scene.set' ? [x.msg] : []
      )
    await until(() => scenes().length >= 1, 3000, 'the first scene')
    await enter(r)
    await until(() => scenes().at(-1)?.layout.char.scale === 0.45, 3000, 'the corner layout')
    expect(scenes().at(-1)?.layout.char).toEqual({ x: 0, y: 0, scale: 0.45 })
    await r.app.modeAction('commentary', 'exit', NO_FLAGS)
    await until(() => scenes().at(-1)?.layout.char.scale === 1, 3000, 'the layout back')
  })

  it('answers a viewer who asks what game this is from what it knows, and goes on commenting afterwards', async () => {
    const { r, script, stage } = await setup()
    await enter(r)
    await until(() => stage.ended >= 1, 8000, 'the first comment')
    await until(
      () => r.llm.requests.filter((q) => q.tag === 'commentary-summary').length >= 1,
      8000,
      'the story'
    )

    script.chat = (req) =>
      contentText(req).includes('what game is this')
        ? ['[neutral]It is Some Game, and they just started building.']
        : ['[happy]Look at that.']
    r.bili.emit(danmaku('what game is this?'))
    await until(
      () => speeches(r).some((q) => contentText(q).includes('what game is this')),
      8000,
      'the viewer reply'
    )
    const reply = speeches(r).find((q) => contentText(q).includes('what game is this'))!
    const prompt = systemText(reply)
    expect(prompt).toContain('the game or program on the screen is Some Game')
    expect(prompt).toContain('What has happened so far this stream')
    expect(prompt).toContain('They explored a forest and began to build.')
    expect(prompt).toContain('if they ask what game or program this is')
    expect(contentText(reply)).toContain('what game is this') // the viewer's words, as an ordinary message
    expect(isComment(reply)).toBe(false)
    await until(
      () => stage.begins.some((b) => String(b.subtitle).includes('just started building')),
      8000,
      'the answer at the stage'
    )

    const before = speeches(r).filter(isComment).length
    await until(
      () => speeches(r).filter(isComment).length > before,
      10_000,
      'commenting again after the viewer'
    )
  })

  it('skips black pictures without asking the model, reports them, and clears the report at the first lit one', async () => {
    const { r, fake, stage } = await setup({ settings: { black_alarm_after: 2 } })
    fake.script = [
      { kind: 'frame', black: true },
      { kind: 'frame', black: true },
    ]
    await enter(r)
    await until(() => alarmed(r, 'commentary_black'), 8000, 'the alarm')
    expect(r.llm.requests).toEqual([])
    expect(stage.begins).toHaveLength(0)
    expect(r.app.alarms.list().find((a) => a.code === 'commentary_black')?.message).toContain(
      'exclusive-fullscreen'
    )
    await until(() => stage.begins.length >= 1, 8000, 'the first comment')
    expect(alarmed(r, 'commentary_black')).toBe(false)
    expect(fake.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the game and the story across a restart of the program', async () => {
    const first = await setup()
    await enter(first.r)
    await until(
      () => first.r.llm.requests.some((q) => q.tag === 'commentary-summary'),
      10_000,
      'the story'
    )
    const stateFile = path.join(first.r.dir, 'data', 'commentary-state.json')
    await vi.waitFor(
      async () => {
        await flushJson()
        expect(await readFile(stateFile, 'utf8')).toMatch(/"summary": "They explored/)
      },
      { timeout: 5000, interval: 50 }
    )
    const saved = await readFile(stateFile, 'utf8')
    await first.r.app.stop()

    const second = await setup({
      prepare: async (dir) => {
        await mkdir(path.join(dir, 'data'), { recursive: true })
        await writeFile(path.join(dir, 'data', 'commentary-state.json'), saved)
      },
    })
    await enter(second.r)
    await until(() => speeches(second.r).length >= 1, 8000, 'the first comment after the restart')
    const [comment] = speeches(second.r)
    // it knew the game and the story from the first moment, and did not have to ask which game it was
    expect(systemText(comment!)).toContain('the game or program on the screen is Some Game')
    expect(systemText(comment!)).toContain('They explored a forest and began to build.')
    expect(second.r.llm.requests.some((q) => q.tag === 'commentary-identify')).toBe(false)
  })

  it('says when the capture fails and when the model fails, backs off, and recovers by itself', async () => {
    const { r, fake, script, stage } = await setup()
    fake.script = [notFound('Some Game'), notFound('Some Game')]
    let failures = 2
    script.identify = () =>
      failures-- > 0
        ? new Error('quota exceeded')
        : JSON.stringify({ game: 'Some Game', scene: 'a forest', confidence: 0.9 })
    await enter(r)
    await until(() => alarmed(r, 'commentary_capture'), 5000, 'the capture alarm')
    expect(r.app.alarms.list().find((a) => a.code === 'commentary_capture')?.message).toContain(
      'cannot capture "Some Game": no visible window matches'
    )
    await until(() => alarmed(r, 'commentary_model'), 8000, 'the model alarm')
    expect(alarmed(r, 'commentary_capture')).toBe(false) // the picture was taken by then; the model is what fails
    expect(r.app.alarms.list().find((a) => a.code === 'commentary_model')?.message).toContain(
      'quota exceeded'
    )
    expect(stage.begins).toHaveLength(0)
    await until(() => stage.begins.length >= 1, 15_000, 'the first comment once the model answers')
    expect(alarmed(r, 'commentary_model')).toBe(false)
    expect(r.app.alarms.list().filter((a) => a.subject === 'commentary')).toEqual([])
  })

  it('is excluded by dance, and excludes it, in both directions', async () => {
    const { r, stage } = await setup({ dance: true, stage: { danceMs: 60_000 } })
    await enter(r)
    await until(() => stage.begins.length >= 1, 8000, 'a first comment')

    // a dance is asked for while commentary is on: it cannot start, and says why
    await r.app.modeAction('dance', 'enter', { ...NO_FLAGS, params: { name: 'aipao' } })
    await until(
      () =>
        r.app.runLog
          .recent(80)
          .some((e) => e.kind === 'mode' && e.text.includes('excludes commentary')),
      10_000,
      'the dance turned down'
    )
    expect(stage.dances).toEqual([])
    expect(r.app.modes.state('commentary')).toBe('ACTIVE')
    await until(() => !r.app.flags.dancing, 3000, 'the dancing flag released')

    // the other way round: with the dance on, commentary is refused
    await r.app.modeAction('commentary', 'exit', NO_FLAGS)
    await r.app.modeAction('dance', 'enter', { ...NO_FLAGS, params: { name: 'aipao' } })
    await until(() => stage.dances.length >= 1, 10_000, 'the dance')
    await until(() => r.app.modes.state('dance') === 'ACTIVE', 3000, 'the dance mode')
    await expect(enter(r)).rejects.toMatchObject({
      httpStatus: 409,
      message: expect.stringContaining('excludes dance'),
    })
    expect(r.app.modes.state('commentary')).toBe('IDLE')
    // with "replace" the console may leave the dance for it
    await r.app.modeAction('commentary', 'enter', { replace: true, force: false })
    expect(r.app.modes.state('dance')).toBe('IDLE')
    expect(r.app.modes.state('commentary')).toBe('ACTIVE')
  })

  it('looks at nothing while the stage page is away, and goes on when it is back', async () => {
    const { r, fake, stage } = await setup()
    await enter(r)
    await until(() => stage.ended >= 1, 8000, 'the first comment')
    stage.close()
    await until(() => !r.app.stage.hub.connected, 3000, 'the disconnect')
    await new Promise((res) => setTimeout(res, 400)) // let a pass that was already under way finish
    const seen = fake.calls.length
    await new Promise((res) => setTimeout(res, 800))
    expect(fake.calls.length).toBe(seen)
    const back = await r.connect()
    await until(() => back.begins.length >= 1, 10_000, 'a comment on the new page')
    expect(fake.calls.length).toBeGreaterThan(seen)
  })

  it('shuts down promptly in the middle of a capture that never answers, and in the middle of a model call', async () => {
    const capture = await setup()
    capture.fake.script = [{ kind: 'hang' }]
    await enter(capture.r)
    await until(() => capture.fake.calls.length === 1, 5000, 'the capture')
    let t0 = Date.now()
    await capture.r.app.stop()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(capture.r.app.modes.state('commentary')).toBe('IDLE')
    expect(capture.fake.calls).toHaveLength(1)

    const model = await setup()
    model.r.llm.stream = (req) => {
      model.r.llm.requests.push(req)
      return (async function* () {
        await new Promise(() => undefined) // the model never answers
      })()
    }
    await enter(model.r)
    await until(() => model.r.llm.requests.length === 1, 5000, 'the model call')
    t0 = Date.now()
    await model.r.app.stop()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(model.r.app.modes.state('commentary')).toBe('IDLE')
    await new Promise((res) => setTimeout(res, 300))
    expect(model.r.llm.requests).toHaveLength(1)
    expect(model.r.app.alarms.list().filter((a) => a.subject === 'commentary')).toEqual([])
  })

  it('is run from the console: the panel is there, its buttons act, and what cannot be done is a refusal that says why', async () => {
    const { r } = await setup({ settings: { window: null } })
    const view = () => r.app.modeViews().find((m) => m.id === 'commentary')!
    expect(view()).toMatchObject({
      state: 'IDLE',
      services: ['screencap'],
      priority: 40,
      hotkey: 'ctrl+alt+g',
      exclusive_with: ['dance', 'sing', 'draw', 'sleep', 'game'],
    })
    expect(view().admission?.ok).toBe(true)
    expect(view().panel?.status).toBe('not running')
    expect(r.app.alarms.list().some((a) => a.code === 'mode_pack_invalid')).toBe(false)

    await enter(r)
    await until(() => alarmed(r, 'commentary_window'), 5000, 'the note that no window is chosen')
    await until(() => (view().panel?.sections[2]?.rows.length ?? 0) === 1, 5000, 'the window list')
    // choosing the window from the list, as the row button does
    const acted = await r.app.modeAction('commentary', 'act', {
      ...NO_FLAGS,
      params: { action: 'use_window', row: '101' },
    })
    expect(acted.state).toBe('ACTIVE')
    await until(() => !alarmed(r, 'commentary_window'), 5000, 'the note gone')
    await until(() => speeches(r).length >= 1, 8000, 'a comment on the chosen window')

    await r.app.modeAction('commentary', 'act', {
      ...NO_FLAGS,
      params: { action: 'set_interval', interval: 12 },
    })
    await flushJson()
    const saved = JSON.parse(
      await readFile(path.join(r.dir, 'data', 'commentary-state.json'), 'utf8')
    )
    expect(saved).toMatchObject({
      interval: 12,
      window: { id: '101', title: 'Some Game - World 1', process: 'javaw.exe' },
    })
    expect(view().panel?.facts.find((f) => f.label === 'Interval')?.value).toBe(
      '12 s after each comment'
    )

    await expect(
      r.app.modeAction('commentary', 'act', { ...NO_FLAGS, params: { action: 'nope' } })
    ).rejects.toMatchObject({
      httpStatus: 409,
      message: 'the commentary mode has no action "nope"',
    })
    await expect(
      r.app.modeAction('commentary', 'act', {
        ...NO_FLAGS,
        params: { action: 'set_interval', interval: 'soon' },
      })
    ).rejects.toMatchObject({
      httpStatus: 409,
      message: 'the interval has to be a number of seconds',
    })
    await r.app.modeAction('commentary', 'exit', NO_FLAGS)
    expect(view().state).toBe('IDLE')
    expect(r.app.alarms.list().filter((a) => a.subject === 'commentary')).toEqual([])
  })

  it('does nothing while it is switched off, which is how it ships, and the operator is told why', async () => {
    const { r, fake } = await setup({ modeEnabled: false, pluginEnabled: false })
    const view = r.app.modeViews().find((m) => m.id === 'commentary')!
    expect(view.admission?.reasons[0]).toContain(
      'switched off in the configuration (modes.commentary.enabled)'
    )
    await expect(enter(r)).rejects.toMatchObject({ httpStatus: 409 })
    await new Promise((res) => setTimeout(res, 300))
    expect(fake.calls).toEqual([])
    expect(r.llm.requests).toEqual([])
  })

  it('needs the capture plugin, and says which one when it is not switched on', async () => {
    const { r } = await setup({ pluginEnabled: false })
    await expect(enter(r)).rejects.toMatchObject({ httpStatus: 409 })
    expect(r.app.modes.state('commentary')).toBe('IDLE')
    expect(r.app.alarms.list().find((a) => a.code === 'mode_start_failed')?.message).toContain(
      'the "screencap" service is not set up'
    )
  })
})

describe('the shipped registration', () => {
  it('has a controller for the pack, so the console does not call it "no code yet"', () => {
    expect(builtinControllers.commentary).toBe(createCommentaryController)
  })
})
