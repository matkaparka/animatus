import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { danmaku, installCleanup, rig, until } from './rig.ts'

installCleanup()

type Json = { type: string; [k: string]: unknown }
type Page = { stage: { json(): Json[] } }

const scenes = (page: Page) => page.stage.json().filter((m) => m.type === 'scene.set')
const overlays = (page: Page) => page.stage.json().filter((m) => m.type === 'overlay.set')
const cameraOf = (m: Json | undefined) =>
  m?.camera as { adjust: Record<string, unknown>; locked: boolean }

describe('the spoken subtitle', () => {
  it('is switched on for the stage when it connects, with the configured style and name', async () => {
    const r = await rig({ config: { stage: { subtitle: { name: 'Nova', style: 'plain' } } } })
    const page = await r.connect()
    await until(() => overlays(page).length > 0, 3000, 'the overlay snapshot')
    expect(overlays(page).find((m) => m.id === 'subtitle')).toMatchObject({
      visible: true,
      variant: 'plain',
      text: 'Nova',
    })
  })

  it('is on with a bubble and no name by default, and can be switched off', async () => {
    const on = await rig()
    const p1 = await on.connect()
    await until(() => overlays(p1).length > 0, 3000)
    const m = overlays(p1).find((o) => o.id === 'subtitle') as Json
    expect(m).toMatchObject({ visible: true, variant: 'bubble' })
    expect('text' in m).toBe(false)

    const off = await rig({ config: { stage: { subtitle: { enabled: false } } } })
    const p2 = await off.connect()
    await until(() => overlays(p2).length > 0, 3000)
    expect(overlays(p2).find((o) => o.id === 'subtitle')).toMatchObject({ visible: false })
  })

  it('every sentence goes to the stage with its words, without the tags', async () => {
    const r = await rig()
    r.llm.reply = () => ['[happy][motion:nod]Hello there, friend. ', '[sad]Goodbye for now.']
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('say hi and bye'))
    await until(() => stage.begins.length >= 3, 5000, 'the utterances')
    const words = stage.begins.map((b) => b.subtitle)
    expect(words.join(' ')).toContain('Hello there,')
    expect(words.join(' ')).toContain('Goodbye for now.')
    for (const w of words) {
      expect(w).toBeTypeOf('string')
      expect(w as string).not.toMatch(/\[|\]|motion/)
    }
  })

  it('a word the voice replaces is replaced on screen too', async () => {
    const r = await rig({
      prepare: async (dir) => {
        const list = path.join(dir, 'words.txt')
        await writeFile(list, 'darn\n')
        return { speech: { sensitive_words_file: list } }
      },
    })
    r.llm.reply = () => ['[angry]Oh darn it all.']
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('scold something'))
    await until(() => stage.begins.length >= 1, 5000)
    expect(stage.begins[0]?.subtitle).toBe('Oh 哔 it all.')
    expect(r.tts.requests[0]?.text).toBe('Oh 哔 it all.')
  })
})

describe('the operator moves the camera with the mouse', () => {
  const adjust = { yaw: 0.6, pitch: -0.2, zoom: 0.7, pan: [0.1, -0.05, 0] }

  it('the report is kept, echoed back in the scene, and written to disk', async () => {
    const r = await rig()
    const page = await r.connect()
    await until(() => scenes(page).length >= 1, 3000, 'the first scene')
    expect(cameraOf(scenes(page)[0]).adjust.zoom).toBe(1)

    page.stage.send({ type: 'camera.adjusted', adjust })
    await until(() => scenes(page).length >= 2, 3000, 'the scene with the adjustment')
    expect(cameraOf(scenes(page).at(-1)).adjust).toEqual(adjust)
    expect(
      r.app.runLog
        .recent(20)
        .some((e) => e.kind === 'stage' && e.text.includes('camera moved by hand'))
    ).toBe(true)

    const file = path.join(r.app.config.paths.data_dir, 'stage-state.json')
    await until(
      () => {
        try {
          return JSON.parse(readFileSync(file, 'utf8')).camera_adjust.zoom === 0.7
        } catch {
          return false
        }
      },
      3000,
      'the state file'
    )
  })

  it('is still there after a restart: the first snapshot of the next page carries it', async () => {
    const r = await rig()
    const page = await r.connect()
    await until(() => r.app.stage.hub.connected)
    page.stage.send({ type: 'camera.adjusted', adjust })
    await until(() => scenes(page).length >= 2)
    const dataDir = r.app.config.paths.data_dir
    await r.app.stop() // writes what is pending

    const again = await rig({
      config: { paths: { data_dir: dataDir, motions: path.join(r.dir, 'motions') } },
    })
    const next = await again.connect()
    await until(() => scenes(next).length >= 1, 3000, 'the scene after a restart')
    expect(cameraOf(scenes(next)[0]).adjust).toEqual(adjust)
  })

  it('an out-of-range report is dropped and changes nothing', async () => {
    const r = await rig()
    const page = await r.connect()
    await until(() => scenes(page).length >= 1)
    page.stage.send({ type: 'camera.adjusted', adjust: { ...adjust, zoom: 100 } })
    await new Promise((res) => setTimeout(res, 200))
    expect(scenes(page)).toHaveLength(1)
    expect(r.app.runLog.recent(20).some((e) => e.text.includes('camera moved by hand'))).toBe(false)
  })

  it('resetting the framing goes back to what the configuration says', async () => {
    const r = await rig()
    const page = await r.connect()
    await until(() => r.app.stage.hub.connected)
    page.stage.send({ type: 'camera.adjusted', adjust })
    await until(() => scenes(page).length >= 2)
    r.app.resetCamera()
    await until(() => scenes(page).length >= 3)
    expect(cameraOf(scenes(page).at(-1)).adjust).toMatchObject({ zoom: 1, yaw: 0 })
  })

  it('a locked composition is announced to the stage', async () => {
    const r = await rig({ config: { stage: { camera: { locked: true } } } })
    const page = await r.connect()
    await until(() => scenes(page).length >= 1)
    expect(cameraOf(scenes(page)[0]).locked).toBe(true)
  })

  it('an adjustment in the configuration file is the starting point until the mouse changes it', async () => {
    const r = await rig({ config: { stage: { camera: { adjust: { zoom: 0.5 } } } } })
    const page = await r.connect()
    await until(() => scenes(page).length >= 1)
    expect(cameraOf(scenes(page)[0]).adjust.zoom).toBe(0.5)
  })
})
