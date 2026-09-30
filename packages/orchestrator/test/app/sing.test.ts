/**
 * The sing mode through the whole program: chat in, the model's lines, `sing.play` out to a scripted stage page, skip,
 * cancel, a service and a stage that fail, a restart. The real App with a real stage server, the real router and pacer,
 * the real supervisor (an external plugin that points at the fake song service), the real pack and controller.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LlmRequest } from '../../src/llm/types.ts'
import { FakeSongService } from '../modes/singFakeService.ts'
import { danmaku, onCleanup, rig, tempDir, until } from './rig.ts'
import type { Rig } from './rig.ts'
import { installCleanup } from './rig.ts'
import { SingStageScript } from './singStage.ts'
import type { SingStageOptions } from './singStage.ts'

installCleanup()

const MODES = path.resolve(__dirname, '../../../../modes')
const lastText = (req: LlmRequest) => String(req.messages.at(-1)?.content ?? '')
const systemText = (req: LlmRequest) => String(req.messages[0]?.content ?? '')
const isOutro = (req: LlmRequest) => lastText(req).includes('finished singing')
const isCutOff = (req: LlmRequest) => lastText(req).includes('cut off before the end')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 0.05 s of silence as a WAV file: enough for the asset route to have something to serve. */
function tinyWav(): Buffer {
  const data = Buffer.alloc(800)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(8000, 24)
  head.writeUInt32LE(16000, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

const MANIFEST = `id: singing
title: Fake singing service
kind: singing
service: singing
runtime:
  type: external
  url: "{config.url}"
health:
  http: { path: /queue, method: GET, expect_status: 200, ready_field: null }
  start_timeout_ms: 5000
  interval_ms: 500
`

interface SingApp {
  r: Rig
  fake: FakeSongService
  songsDir: string
}

/** A whole program with the sing mode on and its plugin pointing at a fake song service. */
async function singApp(
  over: {
    enabled?: boolean
    settings?: Record<string, unknown>
    shared?: { fake: FakeSongService; songsDir: string }
  } = {}
): Promise<SingApp> {
  let fake!: FakeSongService
  let songsDir!: string
  const r = await rig({
    app: { modesDirs: [MODES] },
    prepare: async (dir) => {
      songsDir = over.shared?.songsDir ?? path.join(dir, 'songs')
      if (!over.shared) {
        for (const id of ['song-1', 'song-2', 'song-3']) {
          await mkdir(path.join(songsDir, id), { recursive: true })
          for (const name of ['vocals_final.wav', 'inst_final.wav'])
            await writeFile(path.join(songsDir, id, name), tinyWav())
        }
      }
      fake = over.shared?.fake ?? (await FakeSongService.start(songsDir))
      if (!over.shared) onCleanup(() => fake.close())
      await mkdir(path.join(dir, 'plugins', 'singing'), { recursive: true })
      await writeFile(path.join(dir, 'plugins', 'singing', 'plugin.yaml'), MANIFEST)
      return {
        paths: {
          data_dir: path.join(dir, 'data'),
          motions: path.join(dir, 'motions'),
          songs: songsDir,
        },
        plugins: { singing: { enabled: true, config: { url: fake.url } } },
        modes: {
          sing: {
            enabled: over.enabled ?? true,
            config: {
              poll_sec: 0.1,
              request_timeout_sec: 2,
              call_timeout_sec: 1,
              quiet_timeout_sec: 5,
              start_timeout_sec: 2,
              outro_window_sec: 1,
              retry_after_sec: 1,
              ...over.settings,
            },
          },
        },
        inbox: { pacer: { idle_settle_sec: 0.05, min_interval_sec: 0.05, busy_timeout_sec: 5 } },
      }
    },
  })
  return { r, fake, songsDir }
}

/** Connects a stage page that plays songs the way the real one does, and waits until the service is up. */
async function stageFor(app: SingApp, opts: SingStageOptions = {}) {
  const stage = await app.r.connect()
  const script = new SingStageScript(stage, opts)
  await until(() => app.r.app.stage.hub.connected, 3000, 'stage hello')
  await until(
    () => app.r.app.modes.serviceUrl('singing') !== null,
    8000,
    'the singing service to be ready'
  )
  return { stage, script }
}

describe('the sing mode, through the whole program', () => {
  it('a request in chat: the model is told, the song is prepared, it is sung on the stage while chat waits, the model says a closing line, then chat goes on', async () => {
    const app = await singApp()
    const { r, fake, songsDir } = app
    r.llm.reply = (req) =>
      isOutro(req)
        ? ['[happy]That was for you all.']
        : lastText(req).includes('nice singing')
          ? ['[neutral]Thanks!']
          : lastText(req).includes('点了《')
            ? ['[happy]Good pick, ann.']
            : ['[neutral]Okay.']
    const { stage, script } = await stageFor(app, { playMs: 700 })

    r.bili.emit(danmaku('点歌 晴天'))
    await until(() => r.llm.requests.length >= 1, 8000, 'the model told about the request')
    const first = r.llm.requests[0]!
    expect(lastText(first)).toContain(
      '【点歌】ann 点了《晴天》（Artist），排在第 1 首，要准备几分钟'
    )
    expect(systemText(first)).toContain('点歌 <song name>') // the model is told how to treat these lines
    expect(fake.callsTo('/request')[0]!.body).toMatchObject({
      keyword: '晴天',
      requester_name: 'ann',
    })
    await until(() => stage.begins.length >= 1, 5000, 'the reply to the request')

    // the service prepares it; the mode sees it ready, waits for the reply to be spoken, and sings
    fake.items[0]!.state = 'ready'
    await until(() => script.plays.length === 1, 8000, 'sing.play at the stage')
    const play = script.plays[0]!
    expect(play).toMatchObject({
      type: 'sing.play',
      title: '晴天',
      artists: ['Artist'],
      requester: 'ann',
      vocals_url: '/asset/songs/song-1/vocals_final.wav',
      inst_url: '/asset/songs/song-1/inst_final.wav',
    })
    expect(stage.ended).toBeGreaterThanOrEqual(1) // the reply was spoken before the song started
    // the files the stage is told to fetch are served, from the songs library
    const res = await fetch(new URL(play.vocals_url as string, r.app.stage.url))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/wav')
    expect((await res.arrayBuffer()).byteLength).toBe(844)
    // and the lyrics and credit are shown
    const overlay = (id: string) =>
      stage.stage.json().filter((m) => m.type === 'overlay.set' && m.id === id)
    expect(overlay('lyrics').at(-1)).toMatchObject({ visible: true })
    expect(overlay('credit').at(-1)).toMatchObject({
      visible: true,
      text: '♪ 晴天  — Artist  点歌：ann',
    })
    await until(() => r.app.modes.state('sing') === 'ACTIVE', 3000)
    expect(r.app.flags.singing).toBe(true)

    // chat that arrives during the song waits for it
    r.bili.emit(danmaku('nice singing', { uid: 1002, uname: 'bob' }))
    await sleep(300)
    expect(r.llm.requests.some((q) => lastText(q).includes('nice singing'))).toBe(false)

    // the song ends: the model is told, says a closing line, and only then is chat served again
    await until(() => r.llm.requests.some(isOutro), 8000, 'the closing-line request')
    expect(lastText(r.llm.requests.find(isOutro)!)).toBe(
      '【系统】You have just finished singing "晴天" (requested by ann). Say one closing line in character.'
    )
    await until(
      () => r.llm.requests.some((q) => lastText(q).includes('nice singing')),
      8000,
      'the waiting chat'
    )
    const order = r.llm.requests.map((q) =>
      isOutro(q) ? 'outro' : lastText(q).includes('nice singing') ? 'chat' : 'request'
    )
    expect(order).toEqual(['request', 'outro', 'chat'])
    expect(fake.callsTo('/done')[0]!.body).toMatchObject({ qid: 1, outcome: 'done' })
    await until(() => !r.app.flags.singing, 5000, 'the audience queue released')
    expect(r.app.modes.state('sing')).toBe('IDLE')
    expect(r.app.alarms.list()).toEqual([])
    expect(
      r.app.runLog
        .recent(80)
        .some((e) => e.kind === 'mode' && e.text.includes('singing "晴天" for ann'))
    ).toBe(true)
    void songsDir
  })

  it("a moderator's skip cuts the song, the model says a line about it, and the next song follows; a viewer's skip does nothing", async () => {
    const app = await singApp()
    const { r, fake } = app
    r.llm.reply = () => ['[neutral]Okay.']
    const { script } = await stageFor(app, { playMs: 5000 })
    fake.ready('one', { requester_name: 'ann' })
    fake.ready('two', { requester_name: 'bob' })
    await until(() => script.plays.length === 1, 8000, 'the first song')

    r.bili.emit(danmaku('切歌', { uid: 3003, uname: 'viewer' })) // may not
    await sleep(400)
    expect(script.stops).toEqual([])

    r.bili.emit(danmaku('切歌', { uid: 2002, uname: 'mod', admin: true }))
    await until(() => script.stops.length === 1, 4000, 'sing.stop')
    await until(() => r.llm.requests.some(isCutOff), 8000, 'the cut-off line')
    expect(fake.callsTo('/done')[0]!.body).toMatchObject({ outcome: 'skipped' })
    await until(() => script.plays.length === 2, 8000, 'the next song')
    expect(script.plays[1]).toMatchObject({ title: 'two' })
  })

  it('a viewer cancelling their own request while it waits, and asking for the list', async () => {
    const app = await singApp()
    const { r, fake } = app
    r.llm.reply = () => ['[neutral]Okay.']
    await stageFor(app, { playMs: 200 })
    r.bili.emit(danmaku('点歌 晴天'))
    await until(() => r.llm.requests.length >= 1, 8000)
    await until(
      () => !r.app.flags.singing && r.llm.requests.length >= 1 && fake.items.length === 1,
      3000
    )
    r.bili.emit(danmaku('歌单', { uid: 1002, uname: 'bob' }))
    await until(
      () => r.llm.requests.some((q) => lastText(q).includes('bob 问现在的点歌队列')),
      8000,
      'the list line'
    )
    expect(
      lastText(r.llm.requests.find((q) => lastText(q).includes('问现在的点歌队列'))!)
    ).toContain('1.《晴天》（ann 点的，还在准备）')
    r.bili.emit(danmaku('取消点歌'))
    await until(
      () => r.llm.requests.some((q) => lastText(q).includes('取消了自己点的《晴天》')),
      8000,
      'the cancel line'
    )
    expect(fake.items).toEqual([])
  })

  it('a service that is not there: the model is told the song system is off, and nothing hangs', async () => {
    const app = await singApp()
    const { r, fake } = app
    r.llm.reply = () => ['[neutral]Sorry, no songs right now.']
    const { stage } = await stageFor(app)
    await fake.close()
    r.bili.emit(danmaku('点歌 晴天'))
    await until(() => r.llm.requests.length >= 1, 10_000, 'the model told')
    expect(lastText(r.llm.requests[0]!)).toContain('点歌系统现在没开')
    await until(() => stage.begins.length >= 1, 5000, 'the reply is spoken')
  })

  it('a stage that fails the song: an alarm with its words, nothing left held, and chat still works', async () => {
    const app = await singApp()
    const { r, fake } = app
    r.llm.reply = () => ['[neutral]Okay.']
    const { stage, script } = await stageFor(app, { fail: 'the fake page cannot decode it' })
    fake.ready('晴天')
    await until(() => script.plays.length === 1, 8000)
    await until(() => r.app.alarms.list().some((a) => a.code === 'sing_failed'), 5000, 'the alarm')
    expect(r.app.alarms.list().find((a) => a.code === 'sing_failed')!.message).toContain(
      'cannot decode'
    )
    await until(() => !r.app.flags.singing && r.app.modes.state('sing') === 'IDLE', 4000)
    expect(fake.callsTo('/done')[0]!.body).toMatchObject({ outcome: 'failed' })
    r.bili.emit(danmaku('still there?'))
    await until(() => stage.begins.length >= 1, 8000, 'a reply after the failure')
  })

  it('the operator can look at, pause and stop it from the console', async () => {
    const app = await singApp()
    const { r, fake } = app
    r.llm.reply = () => ['[neutral]Okay.']
    const { script } = await stageFor(app, { playMs: 5000 })
    const view = () => r.app.modeViews().find((m) => m.id === 'sing')!
    expect(view()).toMatchObject({ state: 'IDLE', hotkey: 'ctrl+alt+s', priority: 60 })
    await until(
      () => view().panel?.facts.some((f) => f.label === 'Song source') === true,
      3000,
      'the panel'
    )

    await r.app.modeAction('sing', 'act', {
      replace: false,
      force: false,
      params: { action: 'pause' },
    })
    fake.ready('晴天')
    await sleep(500)
    expect(script.plays).toEqual([])
    expect(view().panel!.status).toContain('paused by the operator')

    // "enter" from the console is "sing the next ready song now"
    await r.app.modeAction('sing', 'enter', { replace: false, force: false })
    await until(() => script.plays.length === 1, 8000, 'the song sung from the console')
    await until(() => view().state === 'ACTIVE', 3000)
    expect(view().panel!.sections[0]!.rows[0]).toMatchObject({ active: true })

    const stopped = await r.app.modeAction('sing', 'exit', { replace: false, force: false })
    expect(stopped.state).toBe('IDLE')
    await until(() => script.stops.length >= 1, 3000)
    await sleep(300)
    expect(r.llm.requests.some((q) => isCutOff(q) || isOutro(q))).toBe(false) // an operator's stop has no closing line
    expect(r.app.flags.singing).toBe(false)
    await expect(
      r.app.modeAction('sing', 'act', { replace: false, force: false, params: { action: 'skip' } })
    ).rejects.toMatchObject({ httpStatus: 409, message: 'no song is being sung' })
  })

  it('a shutdown in the middle of a song is prompt and leaves nothing behind', async () => {
    const app = await singApp()
    const { r, fake } = app
    r.llm.reply = () => ['[neutral]Okay.']
    const { script } = await stageFor(app, { playMs: 60_000 })
    fake.ready('晴天')
    await until(() => script.plays.length === 1, 8000)
    await until(() => r.app.modes.state('sing') === 'ACTIVE', 3000)
    const t0 = Date.now()
    await r.app.stop()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.app.modes.state('sing')).toBe('IDLE')
    expect(r.app.flags.singing).toBe(false)
    expect(fake.callsTo('/done')[0]!.body).toMatchObject({
      outcome: 'interrupted',
      reason: 'shutdown',
    })
  })

  it("a restart in the middle: the song the stage lost is reported, and the queue that is the service's goes on", async () => {
    const songsDir = await tempDir('songs')
    for (const id of ['song-1', 'song-2']) {
      await mkdir(path.join(songsDir, id), { recursive: true })
      for (const name of ['vocals_final.wav', 'inst_final.wav'])
        await writeFile(path.join(songsDir, id, name), tinyWav())
    }
    const fake = await FakeSongService.start(songsDir)
    onCleanup(() => fake.close())
    const first = await singApp({ shared: { fake, songsDir } })
    first.r.llm.reply = () => ['[neutral]Okay.']
    const one = await stageFor(first, { playMs: 60_000 })
    fake.ready('one')
    fake.ready('two')
    await until(() => one.script.plays.length === 1, 8000)
    await until(() => first.r.app.modes.state('sing') === 'ACTIVE', 3000, 'the song playing')
    await first.r.app.stop() // the program goes down in the middle of "one"
    expect(fake.callsTo('/done')[0]!.body).toMatchObject({ qid: 1, outcome: 'interrupted' })

    const second = await singApp({ shared: { fake, songsDir } })
    second.r.llm.reply = () => ['[neutral]Okay.']
    const again = await stageFor(second, { playMs: 200 })
    await until(() => again.script.plays.length === 1, 8000, 'the next song after the restart')
    expect(again.script.plays[0]).toMatchObject({ title: 'two' })
  })

  it('with the mode off (the default) a song request is only noted, and the model is not told about songs', async () => {
    const app = await singApp({ enabled: false })
    const { r } = app
    r.llm.reply = () => ['[neutral]Okay.']
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('点歌 晴天'))
    await until(
      () => r.app.runLog.recent(50).some((e) => e.text.includes('song command "request" ignored')),
      3000,
      'the ignored note'
    )
    r.bili.emit(danmaku('hello there'))
    await until(() => stage.begins.length >= 1, 8000)
    expect(systemText(r.llm.requests[0]!)).not.toContain('【点歌】')
    expect(r.app.modeViews().find((m) => m.id === 'sing')?.admission?.reasons[0]).toContain(
      'switched off'
    )
  })
})
