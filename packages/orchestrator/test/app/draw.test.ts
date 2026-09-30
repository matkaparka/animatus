/**
 * The draw mode through the whole program: a real stage server with a scripted stage page, the real router, brain and
 * speech director, the real supervisor (the image service is an external plugin, a fake on a real local port) and the
 * mode service. The controller alone, with a fake host, is in test/modes/draw.test.ts.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LlmRequest } from '../../src/llm/types.ts'
import type { FakeStage } from '../_stage-support/fake-stage.ts'
import type { Json } from '../_stage-support/stage-client.ts'
import {
  FakeForgeService,
  drawConfig,
  gate,
  healthy,
  makePng,
  okPicture,
  selectAnswer,
  writeAnswer,
} from '../modes/draw-support.ts'
import { danmaku, installCleanup, onCleanup, rig, until } from './rig.ts'
import type { Rig } from './rig.ts'

installCleanup()

const REPO = path.resolve(__dirname, '../../../..')
const MODES = path.join(REPO, 'modes')
const NO_FLAGS = { replace: false, force: false }

const PLUGIN = `manifest_version: 1
id: forge
title: Image generation (test)
kind: image
service: forge
runtime:
  type: external
  url: "{config.url}"
health:
  http: { path: /health }
  start_timeout_ms: 10000
  interval_ms: 500
resources:
  gpu: true
  vram_mb_est: 0
  config_keys: [max_long_side]
`

const tagOf = (req: LlmRequest) => req.tag ?? ''
const lastText = (req: LlmRequest) => {
  const c = req.messages.at(-1)?.content
  return typeof c === 'string' ? c : JSON.stringify(c)
}

/** The whole program with the draw mode switched on, a fake image service and a model that plans and comments. */
async function drawRig(over: Record<string, unknown> = {}) {
  const forge = new FakeForgeService()
  await forge.start()
  onCleanup(() => forge.stop())
  const r = await rig({
    app: { modesDirs: [MODES] },
    prepare: async (dir) => {
      await mkdir(path.join(dir, 'plugins', 'forge'), { recursive: true })
      await writeFile(path.join(dir, 'plugins', 'forge', 'plugin.yaml'), PLUGIN)
      return {
        plugins: { forge: { enabled: true, config: { url: forge.url } } },
        modes: { draw: { enabled: true, config: drawConfig(over) } },
      }
    },
  })
  r.llm.reply = (req) =>
    tagOf(req) === 'draw-select'
      ? [selectAnswer()]
      : tagOf(req) === 'draw-write'
        ? [writeAnswer('a dragon asleep in a crater')]
        : ['[happy]What a fine dragon.']
  const stage = await r.connect()
  await until(() => r.app.stage.hub.connected, 2000, 'the stage page')
  return { r, forge, stage }
}

const enter = (r: Rig) => r.app.modeAction('draw', 'enter', NO_FLAGS)
const frames = (s: FakeStage, id = 'frame'): Json[] =>
  s.stage.received.flatMap((x) =>
    x.kind === 'json' && x.msg.type === 'overlay.set' && x.msg.id === id ? [x.msg] : []
  )
const spoken = (s: FakeStage) => s.begins.map((b) => String(b.subtitle ?? ''))
const chatRequests = (r: Rig) => r.llm.requests.filter((q) => tagOf(q) === 'chat')
const overlayText = (m: Json) => `${m.visible ? 'on' : 'off'}:${String(m.text ?? '')}`

describe('the draw mode, through the whole program', () => {
  it('a request in chat becomes a picture in the frame and a comment from the character who has seen it', async () => {
    const { r, forge, stage } = await drawRig()
    await enter(r)
    await until(() => r.app.modes.state('draw') === 'ACTIVE', 5000, 'the mode to be active')
    await until(() => frames(stage).length === 1, 2000, 'the hint')

    r.bili.emit(danmaku('画 一条龙'))
    await until(() => frames(stage).length === 3, 8000, 'the picture in the frame')

    // the frame, in order: the hint, who is being drawn for and what, the picture and who asked
    const seen = frames(stage)
    expect(seen.map(overlayText)).toEqual([
      'on:弹幕发送「画 + 内容」召唤作品',
      'on:作画中 · ann：一条龙',
      'on:点图：ann',
    ])
    expect(seen[0]).not.toHaveProperty('image')
    const picture = String(seen[2]!.image)
    expect(picture).toMatch(/^\/asset\/generated\/draw-\d+-\d+\.png$/)

    // the stage can fetch what it was told to show
    const res = await fetch(new URL(picture, r.app.stage.url))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).equals(makePng())).toBe(true)
    expect(await readdir(path.join(r.dir, 'data', 'generated'))).toEqual([picture.split('/').pop()])

    // planned by the model (two calls), drawn by the service, and only then commented on
    expect(r.llm.requests.map(tagOf).slice(0, 2)).toEqual(['draw-select', 'draw-write'])
    expect(forge.generateCalls()).toHaveLength(1)
    expect(forge.generateCalls()[0]).toMatchObject({ checkpoint: 'anime-model', route: 'default' })
    await until(() => spoken(stage).includes('What a fine dragon.'), 8000, 'the comment')
    const comment = chatRequests(r).at(-1)!
    const content = comment.messages.at(-1)!.content
    expect(Array.isArray(content)).toBe(true)
    expect(content).toEqual([
      { type: 'text', text: expect.stringContaining('"ann"') },
      { type: 'image', mime: 'image/jpeg', base64: expect.any(String) },
    ])
    expect((content as { text: string }[])[0]!.text).toContain('"一条龙"')

    // the message never was chat: nothing the model got as chat carries the command
    expect(chatRequests(r).some((q) => lastText(q).includes('画 一条龙'))).toBe(false)
    expect(r.app.alarms.list()).toEqual([])
    expect(r.app.flags).toEqual({ dancing: false, singing: false, sleeping: false })

    // the model knows about the frame while the mode runs, and only then
    expect(String(comment.messages[0]!.content)).toContain('A picture frame stands on the stage')
    await r.app.modeAction('draw', 'exit', NO_FLAGS)
    r.bili.emit(danmaku('好看', { uid: 1002, uname: 'bob' }))
    await until(
      () => chatRequests(r).some((q) => lastText(q).includes('好看')),
      8000,
      'a chat reply'
    )
    const after = chatRequests(r).find((q) => lastText(q).includes('好看'))!
    expect(String(after.messages[0]!.content)).not.toContain('A picture frame stands on the stage')
  })

  it('while the mode is not running, 画 is only chat; once it runs the same words are a request and not chat', async () => {
    const { r, forge } = await drawRig()
    r.bili.emit(danmaku('画 一只猫'))
    await until(() => chatRequests(r).length === 1, 8000, 'a chat reply')
    expect(lastText(chatRequests(r)[0]!)).toContain('画 一只猫')
    expect(forge.generateCalls()).toEqual([])

    await enter(r)
    r.bili.emit(danmaku('画 一只狗', { uid: 1002, uname: 'bob' }))
    await until(() => forge.generateCalls().length === 1, 8000, 'the request')
    expect(chatRequests(r).some((q) => lastText(q).includes('画 一只狗'))).toBe(false)
  })

  it('a remark that only starts with the word (画风不错) is still chat while the mode runs', async () => {
    const { r, forge } = await drawRig()
    await enter(r)
    r.bili.emit(danmaku('画风不错啊'))
    await until(() => chatRequests(r).length === 1, 8000, 'a chat reply')
    expect(lastText(chatRequests(r)[0]!)).toContain('画风不错啊')
    expect(forge.generateCalls()).toEqual([])
  })

  it('a request on the blocklist gets a refusal that says nothing of it: no model is asked, nothing is drawn, the frame stays', async () => {
    const { r, forge, stage } = await drawRig()
    await enter(r)
    await until(() => frames(stage).length === 1)
    r.bili.emit(danmaku('画 一个裸体的人'))
    await until(() => stage.begins.length >= 1, 8000, 'the refusal')
    const refusals = [
      '这个题材我不画，换一个吧。',
      '这种要求就免了，驳回。',
      '不画。下一位。',
      '抱歉，这一张我画不了，换个别的吧。',
      '这单我不接，换个题材再来。',
      '换一个，这个不行。',
    ]
    expect(refusals).toContain(spoken(stage)[0])
    expect(r.llm.requests).toEqual([])
    expect(forge.generateCalls()).toEqual([])
    expect(frames(stage)).toHaveLength(1)
    // whatever the stage or the model was ever sent, the request is not in it
    const everything = JSON.stringify([
      stage.stage.received.filter((x) => x.kind === 'json').map((x) => (x as { msg: Json }).msg),
      r.llm.requests,
      r.tts.requests,
      // the operator's log of what viewers typed (kind "viewer") is the program's own and is not shown to anyone
      r.app.runLog.recent(200).filter((e) => e.kind !== 'viewer'),
      r.app.alarms.list(),
    ])
    expect(everything).not.toContain('裸体')
  })

  it('the planner refusing is a refusal too, and the picture is never made', async () => {
    const { r, forge, stage } = await drawRig()
    r.llm.reply = (req) => (tagOf(req) === 'draw-select' ? ['{"refuse": true}'] : ['[neutral]ok'])
    await enter(r)
    r.bili.emit(danmaku('画 一条龙'))
    await until(() => stage.begins.length >= 1, 8000, 'the refusal')
    expect(forge.generateCalls()).toEqual([])
    expect(frames(stage)).toHaveLength(1)
    expect(spoken(stage)[0]).not.toContain('龙')
    expect(chatRequests(r)).toEqual([])
  })

  it('the image service blocking the picture: the frame goes back, a refusal is said, nothing is kept', async () => {
    const { r, forge, stage } = await drawRig()
    forge.generate = () => ({
      status: 200,
      body: { status: 'blocked', reason: 'rating', attempts: 2 },
    })
    await enter(r)
    r.bili.emit(danmaku('画 一条龙'))
    await until(() => stage.begins.length >= 1, 8000, 'the refusal')
    await until(() => frames(stage).length === 3)
    expect(frames(stage).map(overlayText)).toEqual([
      'on:弹幕发送「画 + 内容」召唤作品',
      'on:作画中 · ann：一条龙',
      'on:弹幕发送「画 + 内容」召唤作品',
    ])
    expect(await readdir(path.join(r.dir, 'data', 'generated'))).toEqual([])
    expect(spoken(stage)[0]).not.toContain('龙')
  })

  it('Forge not running: a fault line is said, the operator gets an alarm with the reason, and the page is fine', async () => {
    const { r, forge, stage } = await drawRig()
    forge.health = () =>
      healthy({
        forge_reachable: false,
        forge_error: 'cannot reach Forge at http://127.0.0.1:7860 (is it running with --api?)',
      })
    await enter(r)
    r.bili.emit(danmaku('画 一条龙'))
    await until(() => stage.begins.length >= 1, 8000, 'the fault line')
    await until(() => r.app.alarms.list().some((a) => a.code === 'draw_failed'), 4000, 'the alarm')
    const alarm = r.app.alarms.list().find((a) => a.code === 'draw_failed')!
    expect(alarm.message).toContain('Forge is not reachable')
    expect(alarm.message).toContain('--api')
    expect(r.llm.requests).toEqual([])
    expect(stage.closed).toBe(false)
    expect(frames(stage)).toHaveLength(1)

    // Forge comes back: the next request works and the alarm goes
    forge.health = () => healthy()
    r.bili.emit(danmaku('画 一条龙'))
    await until(() => frames(stage).length === 3, 8000, 'the picture')
    expect(r.app.alarms.list().some((a) => a.code === 'draw_failed')).toBe(false)
  })

  it('the image service gone altogether is the same story', async () => {
    const { r, forge, stage } = await drawRig()
    await enter(r)
    await forge.stop()
    r.bili.emit(danmaku('画 一条龙'))
    await until(() => r.app.alarms.list().some((a) => a.code === 'draw_failed'), 8000, 'the alarm')
    await until(() => stage.begins.length >= 1)
    expect(stage.closed).toBe(false)
  })

  it('one request a viewer per cooldown, and a queue that is bounded: what does not fit is ignored', async () => {
    const { r, forge, stage } = await drawRig({ queue_max: 1, cooldown_sec: 600 })
    const held = gate()
    forge.generate = async () => (await held.wait, okPicture())
    await enter(r)
    r.bili.emit(danmaku('画 一', { uid: 1, uname: 'u1' }))
    await until(() => forge.generateCalls().length === 1, 8000, 'the first picture to start')
    r.bili.emit(danmaku('画 又一', { uid: 1, uname: 'u1' })) // the same viewer: cooling down
    r.bili.emit(danmaku('画 二', { uid: 2, uname: 'u2' })) // waits
    r.bili.emit(danmaku('画 三', { uid: 3, uname: 'u3' })) // the queue is full
    await until(
      () => r.app.runLog.recent(100).some((e) => e.text.includes('queue is full')),
      4000,
      'the queue to say it is full'
    )
    held.open()
    await until(() => frames(stage).filter((f) => f.image).length === 2, 12_000, 'two pictures')
    await until(
      () => spoken(stage).filter((s) => s === 'What a fine dragon.').length === 2,
      12_000,
      'both comments'
    )
    expect(forge.generateCalls()).toHaveLength(2)
  })

  it('a stage that connects while a picture is up gets it straight away', async () => {
    const { r, stage } = await drawRig()
    await enter(r)
    r.bili.emit(danmaku('画 一条龙'))
    await until(() => frames(stage).length === 3, 8000)
    const late = await r.connect()
    await until(() => frames(late).length >= 1, 3000, 'the frame on the new page')
    expect(overlayText(frames(late).at(-1)!)).toBe('on:点图：ann')
    expect(frames(late).at(-1)!.image).toBe(frames(stage).at(-1)!.image)
  })

  it('stopping the mode while a picture is being drawn: the service is told, the frame goes, nothing is said', async () => {
    const { r, forge, stage } = await drawRig()
    const held = gate()
    forge.generate = async () => (await held.wait, okPicture())
    await enter(r)
    r.bili.emit(danmaku('画 一条龙'))
    await until(() => forge.generateCalls().length === 1, 8000)
    const stopped = await r.app.modeAction('draw', 'exit', NO_FLAGS)
    expect(stopped.state).toBe('IDLE')
    await until(() => forge.hungUp.length === 1, 4000, 'the connection to close')
    held.open()
    await new Promise((res) => setTimeout(res, 400))
    expect(frames(stage).at(-1)).toMatchObject({ visible: false })
    expect(frames(stage).some((f) => f.image)).toBe(false)
    expect(stage.begins).toEqual([])
    expect(chatRequests(r)).toEqual([])
    expect(r.app.alarms.list()).toEqual([])
    expect(await readdir(path.join(r.dir, 'data', 'generated'))).toEqual([])
  })

  it('a shutdown in the middle of a picture is prompt and leaves nothing behind', async () => {
    const { r, forge } = await drawRig()
    const held = gate()
    forge.generate = async () => (await held.wait, okPicture())
    await enter(r)
    r.bili.emit(danmaku('画 一条龙'))
    await until(() => forge.generateCalls().length === 1, 8000)
    const t0 = Date.now()
    await r.app.stop()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.app.modes.state('draw')).toBe('IDLE')
    held.open()
  })

  it('the operator can draw from the console panel, and the panel says what is going on', async () => {
    const { r, forge, stage } = await drawRig()
    await enter(r)
    await until(() => r.app.modeViews().find((m) => m.id === 'draw')?.panel !== undefined)
    const held = gate()
    forge.generate = async () => (await held.wait, okPicture())
    await r.app.modeAction('draw', 'act', {
      ...NO_FLAGS,
      params: { action: 'draw', request: '一条龙' },
    })
    await until(() => forge.generateCalls().length === 1, 8000)
    const busy = r.app.modeViews().find((m) => m.id === 'draw')!.panel!
    expect(busy.status).toBe('drawing for 主播: 一条龙')
    expect(busy.sections[0]!.rows).toHaveLength(1)
    held.open()
    await until(() => frames(stage).some((f) => f.image), 8000, 'the picture')
    const done = r.app.modeViews().find((m) => m.id === 'draw')!.panel!
    expect(done.image).toBe(frames(stage).at(-1)!.image)
    expect(done.status).toBe('waiting for requests')
    await expect(
      r.app.modeAction('draw', 'act', {
        ...NO_FLAGS,
        params: { action: 'set_max_long_side', max_long_side: 770 },
      })
    ).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('multiple of 64') })
  })

  it('a mode with nothing set up says so instead of starting: no routes is a configuration error at start-up', async () => {
    await expect(
      rig({
        app: { modesDirs: [MODES] },
        config: { modes: { draw: { enabled: true, config: {} } } },
      })
    ).rejects.toThrow(/invalid configuration of the draw mode[\s\S]*routes/)
  })

  it('the image service that is not enabled is a refusal to start the mode that says why', async () => {
    const r = await rig({
      app: { modesDirs: [MODES] },
      config: { modes: { draw: { enabled: true, config: drawConfig() } } },
    })
    await expect(enter(r)).rejects.toMatchObject({ httpStatus: 409 })
    await expect(r.app.modes.enter('draw')).rejects.toThrow(/forge/)
    expect(r.app.modes.state('draw')).toBe('IDLE')
  })
})
