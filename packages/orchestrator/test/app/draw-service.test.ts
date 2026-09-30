/**
 * The draw mode against the REAL image service: the service of plugins/forge runs as a process, started and stopped by
 * the real supervisor from the manifest that ships (with three changes, see `manifestCopy`), talking to a fake Forge on
 * a real port; only the rating model is a fake (the service's own test entry point), because the real one is a
 * 400 MB download. This is where the two languages meet: the request the planner builds is checked by the service's
 * strict validation, and what the service answers is read by the client.
 *
 * Needs the repository's light Python environment (or one named in ANIMATUS_TEST_PYTHON); skipped without it.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LlmRequest } from '../../src/llm/types.ts'
import type { FakeStage } from '../_stage-support/fake-stage.ts'
import type { Json } from '../_stage-support/stage-client.ts'
import {
  FakeForgeApi,
  drawConfig,
  makePng,
  selectAnswer,
  writeAnswer,
} from '../modes/draw-support.ts'
import { LIGHT_PYTHON, pidAlive, waitFor } from '../plugins/helpers.ts'
import { danmaku, installCleanup, onCleanup, rig, until } from './rig.ts'
import type { Rig } from './rig.ts'

installCleanup()

const PYTHON = LIGHT_PYTHON ?? process.env.ANIMATUS_TEST_PYTHON
const CAN_RUN = PYTHON !== undefined && existsSync(PYTHON)
const REPO = path.resolve(__dirname, '../../../..')
const FORGE_DIR = path.join(REPO, 'plugins', 'forge')
const MODES = path.join(REPO, 'modes')
const NO_FLAGS = { replace: false, force: false }

/**
 * The manifest that ships, changed in the only ways a test needs: the interpreter comes from the plugin config
 * (no virtual environment inside the temporary project), no job guard (its own tests cover it), and the service is
 * started through its test entry point, which swaps the rating model for a fake. Everything else (arguments,
 * placeholders, health, stop request) is the shipped text, so a change to it that breaks the service breaks this test.
 */
async function manifestCopy(): Promise<string> {
  let text = await readFile(path.join(FORGE_DIR, 'plugin.yaml'), 'utf8')
  const swap = (from: string, to: string) => {
    if (!text.includes(from))
      throw new Error(`plugins/forge/plugin.yaml no longer has "${from}": update this test`)
    text = text.replace(from, to)
  }
  swap('env: light', 'env: external')
  swap('guard: true', 'guard: false')
  swap('    - service.py', '    - run_with_fake_tagger.py')
  swap('cwd: "{plugin_dir}"', `cwd: ${JSON.stringify(FORGE_DIR.replaceAll('\\', '/'))}`)
  return text
}

const fwd = (p: string) => p.replaceAll('\\', '/')

const SETTINGS = (forgeUrl: string, families: string) => `forge_url: ${forgeUrl}
blocklist_files: ["${fwd(path.join(FORGE_DIR, 'blocklist.default.txt'))}"]
families:
${families}
lora_allowlist: [sword-lora, self-lora, photo-lora]
allow_sensitive_routes: [self]
limits: { generate_timeout_sec: 30 }
forge_check_sec: 2
`
const FAMILIES = `  anime: { match: [anime-model, furry-model, self-model], arch: sdxl, rating_tag: general, extra_negative: "(sensitive, questionable:1.2)" }
  pony: { match: [photo-model], arch: sdxl, rating_tag: rating_safe }`

const tagOf = (req: LlmRequest) => req.tag ?? ''
const frames = (s: FakeStage): Json[] =>
  s.stage.received.flatMap((x) =>
    x.kind === 'json' && x.msg.type === 'overlay.set' && x.msg.id === 'frame' ? [x.msg] : []
  )
const overlayText = (m: Json) => `${m.visible ? 'on' : 'off'}:${String(m.text ?? '')}`

async function serviceRig(opts: { families?: string; select?: string } = {}) {
  const forge = new FakeForgeApi()
  await forge.start()
  onCleanup(() => forge.stop())
  const r = await rig({
    app: { modesDirs: [MODES] },
    prepare: async (dir) => {
      await mkdir(path.join(dir, 'plugins', 'forge'), { recursive: true })
      await writeFile(path.join(dir, 'plugins', 'forge', 'plugin.yaml'), await manifestCopy())
      const settings = path.join(dir, 'forge-settings.yaml')
      await writeFile(settings, SETTINGS(forge.url, opts.families ?? FAMILIES))
      return {
        plugins: {
          forge: {
            enabled: true,
            config: {
              python: fwd(PYTHON as string),
              settings_file: fwd(settings),
              max_long_side: 1024,
            },
          },
        },
        modes: { draw: { enabled: true, config: drawConfig() } },
      }
    },
  })
  r.llm.reply = (req) =>
    tagOf(req) === 'draw-select'
      ? [
          opts.select ??
            selectAnswer({ loras: [{ name: 'sword-lora', weight: 0.9 }], orientation: 'portrait' }),
        ]
      : tagOf(req) === 'draw-write'
        ? [writeAnswer('1girl, armor, (nude:1.2), <lora:smuggled:1>', 'blurry')]
        : ['[happy]What a fine dragon.']
  const stage = await r.connect()
  await until(() => r.app.stage.hub.connected, 2000, 'the stage page')
  return { r, forge, stage }
}

const status = (r: Rig) => r.app.supervisor.getStatus('forge')
const enter = (r: Rig) => r.app.modeAction('draw', 'enter', NO_FLAGS)

describe.runIf(CAN_RUN)('the draw mode with the real image service', { timeout: 60_000 }, () => {
  it('the service is started by the mode, draws under its own rules, and is stopped when the mode is left', async () => {
    const { r, forge, stage } = await serviceRig()
    await enter(r)
    await until(
      () => r.app.modes.state('draw') === 'ACTIVE',
      45_000,
      'the mode (and the service) to be ready'
    )
    expect(status(r).status).toBe('ready')
    const pid = status(r).pid as number
    expect(pidAlive(pid)).toBe(true)

    r.bili.emit(danmaku('画 一条龙'))
    await until(() => frames(stage).length === 3, 20_000, 'the picture in the frame')
    expect(frames(stage).map(overlayText)).toEqual([
      'on:弹幕发送「画 + 内容」召唤作品',
      'on:作画中 · ann：一条龙',
      'on:点图：ann',
    ])
    const picture = String(frames(stage).at(-1)!.image)
    const res = await fetch(new URL(picture, r.app.stage.url))
    expect(Buffer.from(await res.arrayBuffer()).equals(makePng())).toBe(true)

    // what Forge was asked: built by the service from the planner's request, with its own layers in
    expect(forge.txt2img).toHaveLength(1)
    const asked = forge.txt2img[0]!
    expect(String(asked.prompt)).toMatch(
      /^general, clothed, masterpiece, best quality, sword_style, 1girl, armor <lora:sword-lora:0\.9>$/
    )
    expect(String(asked.prompt)).not.toContain('nude') // the tag the model wrote that is on the blocklist
    expect(String(asked.prompt)).not.toContain('smuggled') // and the LoRA it wrote into the text
    expect(String(asked.negative_prompt)).toMatch(
      /^\(nsfw, explicit, nude, naked, nipples, genitals, sex:1\.4\), \(sensitive, questionable:1\.2\), lowres, blurry$/
    )
    expect(asked).toMatchObject({
      steps: 30,
      cfg_scale: 5,
      sampler_name: 'Euler a',
      scheduler: 'Automatic',
      // the planner asked for 832x1216; the service keeps the long side within max_long_side (1024)
      width: 640,
      height: 1024,
      enable_hr: false,
      save_images: false,
      do_not_save_samples: true,
      override_settings: { sd_model_checkpoint: 'anime-model.safetensors [11111111]' },
      override_settings_restore_afterwards: false,
    })

    // the comment, made after the picture
    await until(
      () => stage.begins.some((b) => b.subtitle === 'What a fine dragon.'),
      12_000,
      'the comment'
    )
    expect(r.app.alarms.list()).toEqual([])
    expect(await readdir(path.join(r.dir, 'data', 'generated'))).toHaveLength(1)

    // leaving the mode stops the service, and the service asked Forge to free its memory on the way out
    const stopped = await r.app.modeAction('draw', 'exit', NO_FLAGS)
    expect(stopped.state).toBe('IDLE')
    await waitFor(() => status(r).status === 'stopped', 20_000, 'the service to stop')
    await waitFor(() => !pidAlive(pid), 10_000, 'the process to be gone')
    expect(forge.unloads).toBe(1)
  })

  it('Forge not running: the service says so in its own words, the operator gets them in an alarm, the page is fine', async () => {
    const { r, forge, stage } = await serviceRig()
    await enter(r)
    await until(() => r.app.modes.state('draw') === 'ACTIVE', 45_000)
    await forge.stop()
    r.bili.emit(danmaku('画 一条龙'))
    await until(
      () => r.app.alarms.list().some((a) => a.code === 'draw_failed'),
      20_000,
      'the alarm'
    )
    const alarm = r.app.alarms.list().find((a) => a.code === 'draw_failed')!
    expect(alarm.message).toMatch(/cannot reach Forge|Forge is not reachable/)
    expect(alarm.message).toContain('--api')
    await until(() => stage.begins.length >= 1, 12_000, 'the fault line')
    expect(stage.closed).toBe(false)
    expect(frames(stage).map(overlayText)).toEqual(['on:弹幕发送「画 + 内容」召唤作品'])
  })

  it('a model no family covers is refused before anything is drawn, with the reason the service gave', async () => {
    const { r, forge } = await serviceRig({
      families: '  other: { match: [nothing-matches-this], arch: sdxl, rating_tag: general }',
    })
    await enter(r)
    await until(() => r.app.modes.state('draw') === 'ACTIVE', 45_000)
    r.bili.emit(danmaku('画 一条龙'))
    await until(
      () => r.app.alarms.list().some((a) => a.code === 'draw_failed'),
      20_000,
      'the alarm'
    )
    expect(r.app.alarms.list().find((a) => a.code === 'draw_failed')!.message).toMatch(
      /anime-model.*no family.*no safe tags/
    )
    expect(forge.txt2img).toEqual([])
    expect(r.llm.requests.filter((q) => tagOf(q).startsWith('draw-'))).toEqual([])
  })

  it('stopping the mode while Forge is drawing tells Forge to stop', async () => {
    const { r, forge } = await serviceRig()
    let open!: () => void
    forge.hold = { wait: new Promise<void>((res) => (open = res)), open: () => open() }
    await enter(r)
    await until(() => r.app.modes.state('draw') === 'ACTIVE', 45_000)
    r.bili.emit(danmaku('画 一条龙'))
    await until(() => forge.txt2img.length === 1, 20_000, 'Forge to start drawing')
    await r.app.modeAction('draw', 'exit', NO_FLAGS)
    await until(() => forge.interrupts >= 1, 10_000, 'the interrupt')
    await waitFor(() => status(r).status === 'stopped', 20_000, 'the service to stop')
    expect(r.app.alarms.list()).toEqual([])
  })

  it('the longest side set from the panel reaches the service, the next picture and the next start', async () => {
    const { r, forge, stage } = await serviceRig()
    await enter(r)
    await until(() => r.app.modes.state('draw') === 'ACTIVE', 45_000)
    await r.app.modeAction('draw', 'act', {
      ...NO_FLAGS,
      params: { action: 'set_max_long_side', max_long_side: 768 },
    })
    const fact = () =>
      r.app
        .modeViews()
        .find((m) => m.id === 'draw')!
        .panel!.facts.find((f) => f.label === 'Longest side')?.value
    expect(fact()).toBe('768 px')
    const saved = path.join(r.dir, 'data', 'forge', 'state.json')
    expect(JSON.parse(await readFile(saved, 'utf8'))).toEqual({
      max_long_side: 768,
      config_value: 1024,
    })

    r.bili.emit(danmaku('画 一条龙'))
    await until(() => forge.txt2img.length === 1, 20_000)
    expect(forge.txt2img[0]).toMatchObject({ width: 512, height: 768 })
    await until(() => frames(stage).length === 3, 20_000)

    await r.app.modeAction('draw', 'exit', NO_FLAGS)
    await waitFor(() => status(r).status === 'stopped', 20_000)
    await enter(r)
    await until(() => r.app.modes.state('draw') === 'ACTIVE', 45_000)
    await until(() => fact() === '768 px', 10_000, 'the saved size after a restart')
  })
})
