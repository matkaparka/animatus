import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LlmRequest } from '../../src/llm/types.ts'
import { danmaku, installCleanup, rig, tempDir, until } from './rig.ts'
import type { RigOptions } from './rig.ts'

installCleanup()

const MODES = path.resolve(__dirname, '../../../../modes')
const NO_FLAGS = { replace: false, force: false }

const lastText = (req: LlmRequest) => String(req.messages.at(-1)?.content ?? '')
const systemText = (req: LlmRequest) => String(req.messages[0]?.content ?? '')
const isOutro = (req: LlmRequest) => lastText(req).includes('just finished a dance')

/** A rig with two dances in the library, the dance mode on, and a gift that means "dance". */
function danceRig(
  over: { enabled?: boolean; settings?: Record<string, unknown>; dances?: string[] } = {}
): RigOptions {
  return {
    app: { modesDirs: [MODES] },
    prepare: async (dir) => {
      for (const name of over.dances ?? ['aipao', 'otagei']) {
        const d = path.join(dir, 'motions', 'dance', name)
        await mkdir(d, { recursive: true })
        await writeFile(path.join(d, 'motion.vrma'), 'x')
        await writeFile(path.join(d, 'music.ogg'), 'x')
        await writeFile(
          path.join(d, 'meta.json'),
          JSON.stringify({ title: name.toUpperCase(), bpm: 128 })
        )
      }
      return {
        modes: {
          dance: {
            enabled: over.enabled ?? true,
            config: { cooldown_sec: 0, outro_window_sec: 1, ...over.settings },
          },
        },
        inbox: {
          dance: { gifts: ['flower'], merge_sec: 0.05 },
          pacer: { idle_settle_sec: 0.05, min_interval_sec: 0.05, busy_timeout_sec: 5 },
        },
      }
    },
  }
}

describe('the dance mode, through the whole program', () => {
  it('a dance gift: the model is told what will happen and thanks first, then the dance plays with the voice held, then the closing line, then chat goes on', async () => {
    const r = await rig(danceRig())
    r.llm.reply = (req) =>
      isOutro(req)
        ? ['[happy]That was fun, thank you all.']
        : lastText(req).includes('nice moves')
          ? ['[neutral]Thanks!']
          : ['[happy]Thank you ann, here we go!']
    const stage = await r.connect({ danceMs: 600 })
    await until(() => r.app.stage.hub.connected, 2000, 'stage hello')

    r.app.inject({ kind: 'gift', name: 'ann', text: '', gift: 'flower', count: 1 })

    await until(() => r.llm.requests.length >= 1, 5000, 'the first model call')
    expect(systemText(r.llm.requests[0]!)).toContain('You are about to dance')
    expect(lastText(r.llm.requests[0]!)).toContain('flower')

    // she thanks first ...
    await until(() => stage.begins.length >= 1, 5000, 'the thank-you line')
    // ... and the dance starts only once that has been spoken
    await until(() => stage.dances.length >= 1, 8000, 'dance.play')
    expect(stage.ended).toBeGreaterThanOrEqual(1)
    expect(stage.dances[0]).toMatchObject({
      type: 'dance.play',
      motion_url: expect.stringMatching(/^\/asset\/motions\/dance\/(aipao|otagei)\/motion\.vrma$/),
      music_url: expect.stringMatching(/^\/asset\/motions\/dance\/(aipao|otagei)\/music\.ogg$/),
    })
    await until(() => r.app.modes.state('dance') === 'ACTIVE', 2000, 'dance mode active')
    expect(r.app.flags.dancing).toBe(true)
    expect(r.app.modeViews().find((m) => m.id === 'dance')?.state).toBe('ACTIVE')

    // chat that arrives during the dance waits for it
    r.bili.emit(danmaku('nice moves'))
    await new Promise((res) => setTimeout(res, 250))
    expect(r.llm.requests.some((q) => lastText(q).includes('nice moves'))).toBe(false)

    // the dance ends: the model is told, says a closing line, and only then is chat served again
    await until(() => r.llm.requests.some(isOutro), 8000, 'the closing-line request')
    const outro = r.llm.requests.find(isOutro)!
    expect(lastText(outro)).toMatch(/finished a dance "(AIPAO|OTAGEI)" \(requested by ann\)/)
    await until(
      () => stage.begins.some((b) => String(b.text ?? '').includes('That was fun')),
      5000,
      'the closing line at the stage'
    ).catch(() => undefined)
    await until(
      () => r.llm.requests.some((q) => lastText(q).includes('nice moves')),
      8000,
      'the waiting chat'
    )
    const order = r.llm.requests.map((q) =>
      isOutro(q) ? 'outro' : lastText(q).includes('nice moves') ? 'chat' : 'gift'
    )
    expect(order).toEqual(['gift', 'outro', 'chat'])

    await until(() => !r.app.flags.dancing, 4000, 'the audience queue released')
    expect(r.app.modes.state('dance')).toBe('IDLE')
    expect(r.app.alarms.list()).toEqual([])
    expect(
      r.app.runLog
        .recent(80)
        .some((e) => e.kind === 'mode' && e.text.includes('dance gift from ann -> ok'))
    ).toBe(true)
  })

  it("the model's tag: [motion:dance:<name>] on the last sentence starts that dance after the reply is spoken, and no second dance follows from the closing line", async () => {
    const r = await rig(danceRig({ settings: { cooldown_sec: 0 } }))
    r.llm.reply = (req) =>
      isOutro(req)
        ? ['[happy][motion:dance:otagei]Done.']
        : ['[happy][motion:dance:otagei]Watch closely.']
    const stage = await r.connect({ danceMs: 200 })
    await until(() => r.app.stage.hub.connected)
    // the advertisement is in the prompt while dancing is possible
    r.bili.emit(danmaku('please dance for us'))
    await until(() => stage.dances.length >= 1, 8000, 'dance.play')
    expect(systemText(r.llm.requests[0]!)).toContain('[motion:dance]')
    expect(systemText(r.llm.requests[0]!)).toContain('otagei (OTAGEI)')
    expect(stage.dances[0]).toMatchObject({ name: 'otagei' })
    expect(stage.ended).toBeGreaterThanOrEqual(1) // the sentence was spoken before the dance went out
    await until(() => r.llm.requests.some(isOutro), 8000, 'the closing-line request')
    await until(() => !r.app.flags.dancing, 8000, 'released')
    // the closing line itself asked for a dance again; with no cooldown that is allowed (the model chose it), but it
    // must be one request, not a loop within this test's time
    expect(stage.dances.length).toBeLessThanOrEqual(2)
  })

  it('a dance during the cooldown is declined in the prompt, not started; a gift then gets the cooldown line', async () => {
    const r = await rig(danceRig({ settings: { cooldown_sec: 600, outro_window_sec: 1 } }))
    r.llm.reply = (req) => (isOutro(req) ? ['[happy]Phew.'] : ['[happy][motion:dance]Here we go.'])
    const stage = await r.connect({ danceMs: 100 })
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('dance please'))
    await until(() => stage.dances.length >= 1, 8000, 'the first dance')
    await until(() => r.llm.requests.some(isOutro), 8000, 'outro')
    await until(() => !r.app.flags.dancing, 8000, 'released')

    r.llm.reply = () => ['[neutral]Not now.']
    r.bili.emit(danmaku('again again'))
    await until(
      () => r.llm.requests.some((q) => lastText(q).includes('again again')),
      8000,
      'the next chat'
    )
    const later = r.llm.requests.find((q) => lastText(q).includes('again again'))!
    expect(systemText(later)).toContain('Dancing is not possible right now')
    expect(systemText(later)).not.toContain('Dances you can do now')

    r.app.inject({ kind: 'gift', name: 'bob', text: '', gift: 'flower', count: 1 })
    await until(
      () => r.llm.requests.some((q) => systemText(q).includes('danced a moment ago')),
      8000,
      'gift during cooldown'
    )
    await new Promise((res) => setTimeout(res, 300))
    expect(stage.dances).toHaveLength(1)
  })

  it('the console can start a dance and stop it; a stop skips the closing line', async () => {
    const r = await rig(danceRig())
    const stage = await r.connect({ danceMs: 5000 })
    await until(() => r.app.stage.hub.connected)
    const views = r.app.modeViews()
    expect(views.map((v) => v.id)).toEqual(['dance'])
    expect(views[0]).toMatchObject({ state: 'IDLE' })

    const started = await r.app.modeAction('dance', 'enter', NO_FLAGS)
    expect(started.id).toBe('dance')
    await until(() => stage.dances.length >= 1, 5000, 'dance.play')
    await until(() => r.app.modes.state('dance') === 'ACTIVE', 2000)

    const stopped = await r.app.modeAction('dance', 'exit', NO_FLAGS)
    expect(stopped.state).toBe('IDLE')
    await until(() => stage.danceStops.length >= 1, 2000, 'dance.stop at the stage')
    await new Promise((res) => setTimeout(res, 300))
    expect(r.llm.requests.some(isOutro)).toBe(false)
    expect(r.app.flags.dancing).toBe(false)
  })

  it('the console picks a dance by name, tunes it while it runs, and the numbers are remembered', async () => {
    const r = await rig(danceRig())
    const stage = await r.connect({ danceMs: 5000 })
    await until(() => r.app.stage.hub.connected)
    await r.app.modeAction('dance', 'enter', { ...NO_FLAGS, params: { name: 'otagei' } })
    await until(() => stage.dances.length >= 1, 5000)
    expect(stage.dances[0]).toMatchObject({ name: 'otagei' })
    await until(() => r.app.modes.state('dance') === 'ACTIVE', 2000)
    const acted = await r.app.modeAction('dance', 'act', {
      ...NO_FLAGS,
      params: { action: 'tune', offset: 1.5, speed: 0.9 },
    })
    expect(acted.state).toBe('ACTIVE')
    await until(() => stage.danceTunes.length >= 1, 2000)
    expect(stage.danceTunes[0]).toMatchObject({ offset: 1.5, speed: 0.9 })
    await r.app.modeAction('dance', 'exit', NO_FLAGS)
    await r.app.modeAction('dance', 'enter', { ...NO_FLAGS, params: { name: 'otagei' } })
    await until(() => stage.dances.length >= 2, 5000)
    expect(stage.dances[1]).toMatchObject({ name: 'otagei', offset: 1.5, speed: 0.9 })
  })

  it('what the console asks that cannot be done is a refusal that says why', async () => {
    const r = await rig(danceRig())
    await r.connect({ danceMs: 5000 })
    await until(() => r.app.stage.hub.connected)
    await expect(
      r.app.modeAction('dance', 'enter', { ...NO_FLAGS, params: { name: 'ghost' } })
    ).rejects.toMatchObject({ httpStatus: 409, message: 'notfound' })
    await expect(
      r.app.modeAction('dance', 'act', { ...NO_FLAGS, params: { action: 'tune', speed: 2 } })
    ).rejects.toMatchObject({ httpStatus: 409, message: 'no dance is playing' })
  })

  it('a stage that reports the dance failed: an alarm with its words, nothing left held, chat still works', async () => {
    const r = await rig(danceRig())
    r.llm.reply = () => ['[neutral]Okay.']
    const stage = await r.connect({ danceFailsToLoad: true })
    await until(() => r.app.stage.hub.connected)
    await expect(r.app.modeAction('dance', 'enter', NO_FLAGS)).resolves.toBeTruthy()
    await until(() => r.app.alarms.list().some((a) => a.code === 'dance_failed'), 5000, 'the alarm')
    expect(r.app.alarms.list().find((a) => a.code === 'dance_failed')?.message).toContain(
      'the fake dance failed'
    )
    expect(r.app.flags.dancing).toBe(false)
    expect(stage.dances).toHaveLength(1)
    r.bili.emit(danmaku('still there?'))
    await until(() => stage.begins.length >= 1, 5000, 'a reply after the failure')
  })

  it('with the mode switched off (the default) a dance gift is only a gift, nothing plays, and the prompt does not mention dancing', async () => {
    const r = await rig(danceRig({ enabled: false }))
    r.llm.reply = () => ['[happy]Thanks for the flower!']
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.app.inject({ kind: 'gift', name: 'ann', text: '', gift: 'flower', count: 1 })
    await until(() => r.llm.requests.length >= 1, 5000)
    await until(() => stage.begins.length >= 1, 5000)
    await new Promise((res) => setTimeout(res, 300))
    expect(systemText(r.llm.requests[0]!)).not.toContain('motion:dance')
    expect(systemText(r.llm.requests[0]!)).not.toContain('about to dance')
    expect(stage.dances).toEqual([])
    expect(r.app.modeViews()[0]?.admission?.reasons[0]).toContain(
      'switched off in the configuration'
    )
    await expect(r.app.modeAction('dance', 'enter', NO_FLAGS)).rejects.toMatchObject({
      httpStatus: 409,
    })
  })

  it('a mode named in the configuration that has no pack, and a pack that cannot be read, are alarms, not silence; a mode that is off is left alone', async () => {
    const extra = await tempDir('modes')
    await mkdir(path.join(extra, 'oops'), { recursive: true })
    await writeFile(path.join(extra, 'oops', 'mode.yaml'), 'id: oops\ntitle: ""\n')
    const r = await rig({
      app: { modesDirs: [MODES, extra] },
      config: { modes: { dnace: { enabled: true }, sleep: { enabled: false } } },
    })
    const alarms = r.app.alarms.list()
    expect(alarms.find((a) => a.code === 'mode_unknown')?.message).toContain('modes.dnace')
    expect(alarms.find((a) => a.code === 'mode_pack_invalid')?.message).toContain('"oops"')
    expect(alarms.filter((a) => a.code === 'mode_unknown')).toHaveLength(1)
  })

  it('a shutdown in the middle of a dance is prompt, and leaves nothing behind', async () => {
    const r = await rig(danceRig())
    const stage = await r.connect({ danceMs: 60_000 })
    await until(() => r.app.stage.hub.connected)
    await r.app.modeAction('dance', 'enter', NO_FLAGS)
    await until(() => stage.dances.length >= 1, 5000)
    await until(() => r.app.modes.state('dance') === 'ACTIVE', 2000)
    const t0 = Date.now()
    await r.app.stop()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.app.modes.state('dance')).toBe('IDLE')
  })

  it('a shutdown while a dance is still waiting to start does not start it afterwards', async () => {
    const r = await rig(danceRig())
    const stage = await r.connect({ danceMs: 100 })
    await until(() => r.app.stage.hub.connected)
    // something is being said, so the dance has to wait
    r.app.say({ text: 'A long sentence that is still being spoken.', emotion: 'neutral' })
    expect(await r.app.modes.consoleRequest('dance', {})).toEqual({ ok: true })
    await r.app.stop()
    await new Promise((res) => setTimeout(res, 600))
    expect(stage.dances).toEqual([])
  })
})
