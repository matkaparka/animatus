/**
 * The draw controller through the real mode service, with a fake host (the dance tests' pattern) and a fake image
 * service on a real local port. The whole program with a stage page is in test/app/draw.test.ts.
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import { createDrawController } from '../../src/modes/controllers/draw.ts'
import type { LlmTextRequest, ModeHost, SayOptions } from '../../src/modes/host.ts'
import { flushJson } from '../../src/modes/jsonfile.ts'
import { loadModePacks } from '../../src/modes/loader.ts'
import type { LoadedMode } from '../../src/modes/loader.ts'
import { ModeService } from '../../src/modes/service.ts'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import { MemorySecretStore } from '../../src/plugins/secrets.ts'
import { assetUrl } from '../../src/stage/assets.ts'
import {
  FAKE_THUMB,
  FakeForgeService,
  drawConfig,
  gate,
  healthy,
  okPicture,
  selectAnswer,
  serviceError,
  writeAnswer,
} from './draw-support.ts'

const REPO = path.resolve(__dirname, '../../../..')
const START = 1_700_000_000_000

type Overlay = Record<string, unknown> & { id: string }
type Controller = ReturnType<typeof createDrawController>

interface Rig {
  service: ModeService
  ctl: Controller
  forge: FakeForgeService
  dir: string
  generated: string
  clock: { now: number }
  overlays: Overlay[]
  events: string[]
  logs: string[]
  alarms: { code: string; level: string; message: string; subject?: string }[]
  said: SayOptions[]
  told: { text: string; opts: { images?: { mime: string; base64: string }[] } | undefined }[]
  held: [string, boolean][]
  llm: { calls: LlmTextRequest[]; answer: (req: LlmTextRequest) => string | Promise<string> }
  quiet: { answer: boolean; wait: Promise<void> | null }
  brain: { tellFails: boolean }
  frames(): Overlay[]
  notices(): Overlay[]
  chat(text: string, who?: Partial<{ uid: number; uname: string; owner: boolean }>): boolean
  enter(): Promise<void>
  exit(reason?: string): Promise<void>
  panel(): NonNullable<ReturnType<ModeService['viewOf']>['panel']>
  /** Everything a viewer, the model or the operator could read, as one string (the model's planning calls left out unless asked). */
  haystack(withPlanning?: boolean): string
}

let pack: LoadedMode
let registry: PluginRegistry
beforeAll(async () => {
  pack = (await loadModePacks([path.join(REPO, 'modes')])).modes.find(
    (m) => m.manifest.id === 'draw'
  ) as LoadedMode
  registry = await PluginRegistry.scan(path.join(REPO, 'plugins'))
})

const rigs: Rig[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.service.dispose()
    await r.forge.stop()
  }
  await flushJson()
  for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function until(cond: () => boolean, ms = 4000, what = 'the condition'): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rig(
  opts: {
    config?: Record<string, unknown>
    dir?: string
    serviceUp?: boolean
    enter?: boolean
    /** Files whose prompt the pack "lacks". */
    withoutPrompt?: string[]
  } = {}
): Promise<Rig> {
  const dir = opts.dir ?? (await mkdtemp(path.join(tmpdir(), 'animatus-draw-')))
  if (!opts.dir) dirs.push(dir)
  const dataDir = path.join(dir, 'data')
  const generated = path.join(dataDir, 'generated')
  const forge = new FakeForgeService()
  await forge.start()
  const config = parseConfig(
    {
      paths: { data_dir: dataDir },
      plugins: {
        forge: { enabled: true, config: { settings_file: 'x.yaml', max_long_side: 1024 } },
      },
      modes: { draw: { enabled: true, config: drawConfig(opts.config) } },
    },
    { root: dir }
  )

  const overlays: Overlay[] = []
  const hub = Object.assign(new EventEmitter(), {
    setOverlay: (m: Overlay) => void overlays.push(m),
  })
  const events: string[] = []
  const logs: string[] = []
  const alarms: Rig['alarms'] = []
  const said: SayOptions[] = []
  const told: Rig['told'] = []
  const held: [string, boolean][] = []
  const llm: Rig['llm'] = {
    calls: [],
    answer: (req) => (req.tag === 'draw-select' ? selectAnswer() : writeAnswer()),
  }
  const quiet: Rig['quiet'] = { answer: true, wait: null }
  const brain: Rig['brain'] = { tellFails: false }
  const clock = { now: START }

  let service!: ModeService
  const host: ModeHost = {
    config,
    hub: hub as unknown as ModeHost['hub'],
    motions: null,
    secrets: new MemorySecretStore(),
    flags: { dancing: false, singing: false, sleeping: false },
    dataDir,
    now: () => clock.now,
    log: (level, msg) => void logs.push(`${level}: ${msg}`),
    event: (_kind, text) => void events.push(text),
    alarm: (code, level, message, subject) =>
      void alarms.push({ code, level, message, ...(subject !== undefined ? { subject } : {}) }),
    clearAlarm: (code, subject) => {
      const i = alarms.findIndex(
        (a) => a.code === code && (subject === undefined || a.subject === subject)
      )
      if (i >= 0) alarms.splice(i, 1)
    },
    stopSpeech: () => {},
    holdSpeech: (reason, on) => void held.push([reason, on]),
    setVoiceStyle: () => {},
    say: (o) => void said.push(o),
    whenQuiet: async () => {
      if (quiet.wait) await quiet.wait
      return quiet.answer
    },
    busy: () => false,
    tellBrain: async (text, o) => {
      told.push({ text, opts: o })
      if (brain.tellFails) throw new Error('the model is away')
    },
    brainBusy: () => false,
    serviceUrl: (name) => service.serviceUrl(name),
    modeState: (id) => service.state(id),
    enterMode: (id, o) => service.tryEnter(id, o),
    exitMode: async (id, reason) => void (await service.exit(id, reason)),
    prompt: (mode, name, vars) =>
      opts.withoutPrompt?.includes(name) ? null : service.prompt(mode, name, vars),
    libraryDir: (library) => (library === 'generated' ? generated : null),
    assetUrl: (library, ...parts) => assetUrl(library, ...parts),
    llmText: async (req) => {
      llm.calls.push(req)
      return llm.answer(req)
    },
    songLine: () => {},
  }
  let ctl!: Controller
  service = new ModeService({
    config,
    packs: [pack],
    registry,
    supervisor: {
      start: async () => ({ status: 'ready', url: forge.url }) as never,
      stop: async () => ({}) as never,
      getStatus: () =>
        (opts.serviceUp === false
          ? { status: 'stopped' }
          : { status: 'ready', url: forge.url }) as never,
    },
    pluginConfig: (id) => config.plugins[id]?.config ?? {},
    host,
    controllers: { draw: (h) => (ctl = createDrawController(h)) },
    gpu: { usedMb: () => null, totalMb: () => 12000 },
    measurements: () => [],
    resident: [],
    startTimeoutMs: 20_000,
    stopTimeoutMs: 20_000,
    settleTimeoutMs: 10,
    now: () => clock.now,
  })
  service.attach()
  const r: Rig = {
    service,
    ctl,
    forge,
    dir,
    generated,
    clock,
    overlays,
    events,
    logs,
    alarms,
    said,
    told,
    held,
    llm,
    quiet,
    brain,
    frames: () => overlays.filter((o) => o.id === 'frame'),
    notices: () => overlays.filter((o) => o.id === 'notice'),
    chat: (text, who = {}) =>
      service.chatCommand({ uid: 1001, uname: 'ann', admin: false, owner: false, text, ...who }),
    enter: async () => void (await service.enter('draw')),
    exit: async (reason = 'test') => void (await service.exit('draw', reason)),
    panel: () => service.viewOf('draw').panel!,
    haystack: (withPlanning = false) =>
      JSON.stringify({
        said,
        told,
        events,
        alarms,
        overlays,
        logs,
        ...(withPlanning
          ? { llm: llm.calls.map((c) => [c.system, c.user]), service: forge.calls }
          : {}),
      }),
  }
  rigs.push(r)
  if (opts.enter !== false) await r.enter()
  return r
}

/** The requests a controller made of the image service that are not the panel's health poll. */
const work = (r: Rig) => r.forge.calls.filter((c) => c.path !== '/health')
const texts = (r: Rig) =>
  r.frames().map((o) => `${o.visible ? 'on' : 'off'}:${String(o.text ?? '')}`)
const pictureFiles = async (r: Rig) => (await readdir(r.generated).catch(() => [])).sort()

describe('entering and leaving', () => {
  it('the frame shows its hint on entry and is taken away on exit; the pack prompt goes out only while the mode runs', async () => {
    const r = await rig({ enter: false })
    expect(r.service.prompts()).toEqual([])
    await r.enter()
    expect(r.service.state('draw')).toBe('ACTIVE')
    expect(r.frames()).toEqual([
      { type: 'overlay.set', id: 'frame', visible: true, text: '弹幕发送「画 + 内容」召唤作品' },
    ])
    const prompts = r.service.prompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.text).toContain('write "画"')
    await r.exit()
    expect(r.frames().at(-1)).toEqual({
      type: 'overlay.set',
      id: 'frame',
      visible: false,
      text: '',
    })
    expect(r.service.prompts()).toEqual([])
    expect(r.held).toEqual([])
  })

  it('it does not start with a safety layer missing, without the service, or with a pack file missing, and says why', async () => {
    const noList = await rig({ config: { blocklist_files: ['/nowhere/words.txt'] }, enter: false })
    await expect(noList.service.enter('draw')).rejects.toThrow(/blocklist cannot be used/)
    expect(noList.service.state('draw')).toBe('IDLE')
    expect(noList.frames()).toEqual([])

    const noService = await rig({ serviceUp: false, enter: false })
    await expect(noService.service.enter('draw')).rejects.toThrow(
      /did not become ready|not running|not set up/
    )

    const noFile = await rig({ withoutPrompt: ['refusals'], enter: false })
    await expect(noFile.service.enter('draw')).rejects.toThrow(/no prompts\/refusals\.md/)
  })

  it('the chat is not touched while the mode is off', async () => {
    const r = await rig({ enter: false })
    expect(r.chat('画 一条龙')).toBe(false)
    expect(r.llm.calls).toEqual([])
  })
})

describe('which chat messages are requests', () => {
  it('the command word with a space, a colon or a measure word, or the slash form; a remark that only starts with the word is chat', async () => {
    const r = await rig({ config: { cooldown_sec: 0 } })
    r.llm.answer = () => new Promise(() => {}) // the requests only need to be taken, not finished
    for (const text of [
      '画 一条龙',
      '画：一条龙',
      '画:一条龙',
      '画一条龙',
      '画个圈',
      '画  猫',
      '/画 龙',
      '/画龙',
    ])
      expect(r.chat(text), text).toBe(true)
    for (const text of ['画风不错', '画面好卡', '画得真好', '画', '你画得真好啊', '看画 龙'])
      expect(r.chat(text), text).toBe(false)
  })

  it('what follows the word is the request, without the separator', async () => {
    const r = await rig({ config: { cooldown_sec: 0 } })
    r.llm.answer = () => new Promise(() => {})
    r.chat('画：一只猫', { uid: 1 })
    r.chat('画一只狗', { uid: 2 })
    r.chat('/画   一条鱼', { uid: 3 })
    await until(() => r.llm.calls.length >= 1)
    expect(r.events.filter((e) => e.includes('is queued'))).toHaveLength(3)
    expect(String(r.llm.calls[0]!.user)).toContain('<<<一只猫>>>')
  })

  it('the measure words are a setting, and the slash form always counts', async () => {
    const r = await rig({ config: { measure_words: '' } })
    r.llm.answer = () => new Promise(() => {})
    expect(r.chat('画一条龙')).toBe(false)
    expect(r.chat('画 一条龙')).toBe(true)
    expect(r.chat('/画一条龙', { uid: 2 })).toBe(true)
  })

  it('the command word alone (with a slash) is taken and does nothing', async () => {
    const r = await rig()
    expect(r.chat('/画')).toBe(true)
    expect(r.chat('/画   ')).toBe(true)
    expect(r.events.filter((e) => e.includes('nothing else'))).toHaveLength(2)
    expect(work(r)).toEqual([])
  })

  it('a request is cut at max_chars', async () => {
    const r = await rig({ config: { max_chars: 10 } })
    r.chat(`画 ${'龙'.repeat(40)}`)
    await until(() => r.llm.calls.length >= 1)
    expect(String(r.llm.calls[0]!.user)).toContain(`<<<${'龙'.repeat(10)}>>>`)
  })
})

describe('a picture', () => {
  it('is planned, drawn, kept, shown, and the character comments on it with the picture in front of the model', async () => {
    const r = await rig()
    expect(r.chat('画 一条龙')).toBe(true)
    await until(() => r.told.length === 1)

    // the frame: hint, then who is being drawn for and what, then the picture and who asked
    expect(texts(r)).toEqual([
      'on:弹幕发送「画 + 内容」召唤作品',
      'on:作画中 · ann：一条龙',
      'on:点图：ann',
    ])
    const shown = r.frames().at(-1)!
    expect(shown.image).toMatch(/^\/asset\/generated\/draw-\d+-\d+\.png$/)

    // what the image service was asked
    expect(r.llm.calls.map((c) => c.tag)).toEqual(['draw-select', 'draw-write'])
    const [asked] = r.forge.generateCalls()
    expect(asked).toMatchObject({
      checkpoint: 'anime-model',
      route: 'default',
      seed: -1,
      loras: [],
      steps: 30,
      sampler_name: 'Euler a',
    })
    expect(String(asked!.prompt)).toMatch(/^masterpiece, best quality, 1girl, armor$/)

    // the picture is kept where the stage is served from
    const files = await pictureFiles(r)
    expect(files).toHaveLength(1)
    expect(shown.image).toBe(`/asset/generated/${files[0]}`)
    const bytes = await readFile(path.join(r.generated, files[0]!))
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])

    // the comment: the model sees the small picture and is told who asked and what
    expect(r.told[0]!.text).toContain('"ann"')
    expect(r.told[0]!.text).toContain('"一条龙"')
    expect(r.told[0]!.text).not.toContain('yourself')
    expect(r.told[0]!.opts?.images).toEqual([
      { mime: 'image/jpeg', base64: FAKE_THUMB.toString('base64') },
    ])
    expect(r.said).toEqual([])
    expect(r.alarms).toEqual([])
    expect(r.held).toEqual([])
    expect(r.panel().image).toBe(shown.image)
  })

  it('the comment waits for the voice to be free, and is said anyway when the wait ends', async () => {
    const r = await rig()
    const free = gate()
    r.quiet.wait = free.wait
    r.chat('画 一条龙')
    await until(() => r.frames().length === 3)
    await pause(50)
    expect(r.told).toEqual([])
    free.open()
    await until(() => r.told.length === 1)

    const late = await rig()
    late.quiet.answer = false // the voice never got free within the wait
    late.chat('画 一条龙')
    await until(() => late.told.length === 1)
  })

  it('leaving the mode before the voice is free drops the comment', async () => {
    const r = await rig()
    const free = gate()
    r.quiet.wait = free.wait
    r.chat('画 一条龙')
    await until(() => r.frames().length === 3)
    await r.exit()
    free.open()
    await pause(80)
    expect(r.told).toEqual([])
    expect(r.said).toEqual([])
  })

  it('comments come one after the other, in the order the pictures were made', async () => {
    const r = await rig({ config: { cooldown_sec: 0 } })
    r.chat('画 甲', { uid: 1, uname: 'ann' })
    r.chat('画 乙', { uid: 2, uname: 'bob' })
    await until(() => r.told.length === 2)
    expect(r.told[0]!.text).toContain('"甲"')
    expect(r.told[1]!.text).toContain('"乙"')
    expect(texts(r).at(-1)).toBe('on:点图：bob')
  })

  it('a model that cannot be told is logged and the next comment still works', async () => {
    const r = await rig({ config: { cooldown_sec: 0 } })
    r.brain.tellFails = true
    r.chat('画 甲', { uid: 1 })
    await until(() => r.told.length === 1)
    await until(() => r.logs.some((l) => l.includes('the comment could not be made')))
    r.brain.tellFails = false
    r.chat('画 乙', { uid: 2 })
    await until(() => r.told.length === 2)
  })

  it('a model that cannot see pictures is told without one, and that is what the setting is for', async () => {
    const r = await rig({ config: { send_image: false } })
    r.chat('画 一条龙')
    await until(() => r.told.length === 1)
    expect(r.told[0]!.opts).toBeUndefined()
    expect(r.told[0]!.text).toContain('you cannot see it this time')
  })

  it('the name of a viewer that hits the blocklist is never shown: the pack has a name for such viewers', async () => {
    const r = await rig()
    r.chat('画 一条龙', { uname: 'nude_fan' })
    await until(() => r.told.length === 1)
    expect(texts(r)).toContain('on:作画中 · 一位观众：一条龙')
    expect(r.told[0]!.text).toContain('"一位观众"')
    expect(r.haystack()).not.toContain('nude_fan')
  })

  it('long names and requests are cut on the stage, not in what the model is told', async () => {
    const r = await rig()
    const request = '一条在火山口睡觉的赤金色机械龙，背景是燃烧的夜空和倒悬的城市废墟'
    r.chat(`画 ${request}`, { uname: 'a-very-long-viewer-name-indeed' })
    await until(() => r.told.length === 1)
    const generating = texts(r)[1]!
    expect(generating).toContain('a-very-long-view…')
    expect(generating).toContain('…')
    expect(generating.length).toBeLessThan(request.length + 30)
    expect(r.told[0]!.text).toContain(request)
  })

  it('the picture goes away after show_sec and the hint comes back', async () => {
    const r = await rig({ config: { show_sec: 1 } })
    r.chat('画 一条龙')
    await until(() => r.told.length === 1)
    expect(texts(r).at(-1)).toBe('on:点图：ann')
    await until(() => texts(r).at(-1) === 'on:弹幕发送「画 + 内容」召唤作品', 3000, 'the hint')
    expect(r.frames().at(-1)!.image).toBeUndefined()
  })

  it('only the newest pictures are kept', async () => {
    const r = await rig({ config: { cooldown_sec: 0, keep_pictures: 2 } })
    for (let i = 1; i <= 3; i++) {
      r.clock.now += 1000
      r.chat(`画 图${i}`, { uid: i })
      await until(() => r.told.length === i)
    }
    expect(await pictureFiles(r)).toHaveLength(2)
    const shown = r.frames().at(-1)!.image as string
    expect(await pictureFiles(r)).toContain(shown.split('/').pop())
  })

  it('the words can go to the banner while the stage draws no text on the frame', async () => {
    const r = await rig({ config: { frame: { text_overlay: 'notice' } } })
    r.chat('画 一条龙')
    await until(() => r.told.length === 1)
    expect(r.notices().map((o) => `${o.visible}:${o.text}`)).toEqual([
      'true:弹幕发送「画 + 内容」召唤作品',
      'true:作画中 · ann：一条龙',
      'true:点图：ann',
    ])
    expect(r.frames().map((o) => o.visible)).toEqual([false, false, true])
    await r.exit()
    expect(r.notices().at(-1)).toEqual({
      type: 'overlay.set',
      id: 'notice',
      visible: false,
      text: '',
    })
  })
})

describe('the self-portrait', () => {
  it('a request with the words draws with the fixed model and LoRA, and the model is told the picture is of itself', async () => {
    const r = await rig()
    r.chat('画 你自己')
    await until(() => r.told.length === 1)
    expect(r.forge.generateCalls()[0]).toMatchObject({
      checkpoint: 'self-model',
      route: 'self',
      loras: [{ name: 'self-lora', weight: 0.7 }],
    })
    expect(r.told[0]!.text).toContain('This picture shows you yourself')
  })
})

describe('layer 1: a request on the blocklist', () => {
  it('is refused at once: no model, no image service, nothing on the stage; a line of the pack is said, without the request', async () => {
    const r = await rig()
    const asked = '画 一个裸体的人'
    expect(r.chat(asked)).toBe(true)
    await until(() => r.said.length === 1)
    expect(r.llm.calls).toEqual([])
    expect(work(r)).toEqual([])
    expect(texts(r)).toEqual(['on:弹幕发送「画 + 内容」召唤作品']) // the frame does not change
    const refusals = (await readFile(path.join(REPO, 'modes/draw/prompts/refusals.md'), 'utf8'))
      .split(/\r?\n/)
      .map((l) => l.replace(/^\[\w+\]/, '').trim())
    expect(refusals).toContain(r.said[0]!.text)
    expect(r.told).toEqual([])
    expect(r.haystack(true)).not.toContain('裸体')
    expect(r.alarms).toEqual([])
  })

  it('counts against the viewer: they wait like anyone else', async () => {
    const r = await rig()
    r.chat('画 nude')
    await until(() => r.said.length === 1)
    r.chat('画 一条龙')
    await pause(50)
    expect(r.llm.calls).toEqual([])
    expect(r.events.some((e) => e.includes('cooldown'))).toBe(true)
  })

  it('English words are matched as whole words and spaced-out Chinese words are caught', async () => {
    const r = await rig({ config: { cooldown_sec: 0 } })
    r.llm.answer = () => new Promise(() => {})
    r.chat('画 Essex countryside', { uid: 1 })
    await until(() => r.llm.calls.length === 1)
    expect(r.said).toEqual([])
    r.chat('画 色 情 图', { uid: 2 })
    await until(() => r.said.length === 1)
  })

  it('the model can be told to refuse in character instead: it is not told the request, and nothing is said by the pack', async () => {
    const r = await rig({ config: { refusal: 'model' } })
    r.chat('画 一个裸体的人')
    await until(() => r.told.length === 1)
    expect(r.said).toEqual([])
    expect(r.told[0]!.opts).toBeUndefined()
    expect(r.told[0]!.text).toContain('You are not told what was asked')
    expect(r.haystack(true)).not.toContain('裸体')
  })

  it('the room owner is not exempt from the blocklist, only from the cooldown', async () => {
    const r = await rig()
    r.chat('画 nude', { owner: true })
    await until(() => r.said.length === 1)
    r.chat('画 sex', { owner: true })
    await until(() => r.said.length === 2)
  })

  it('a raid of blocked requests does not keep the voice busy: only a few refusal lines wait to be said', async () => {
    const r = await rig()
    const free = gate()
    r.quiet.wait = free.wait
    for (let i = 1; i <= 10; i++) r.chat('画 nude', { uid: i, uname: `viewer${i}` })
    expect(r.events.filter((e) => e.includes('refused by the blocklist'))).toHaveLength(10)
    free.open()
    await until(() => r.said.length === 3)
    await pause(80)
    expect(r.said).toHaveLength(3)
    expect(r.logs.some((l) => l.includes('a refusal or fault line was dropped'))).toBe(true)
    r.chat('画 nude', { uid: 99 }) // the ones that were said made room
    await until(() => r.said.length === 4)
  })

  it('a request that could not be looked at still costs the viewer their turn, so they cannot flood the voice with fault lines', async () => {
    const words = path.join(await mkdtemp(path.join(tmpdir(), 'animatus-words-')), 'w.txt')
    dirs.push(path.dirname(words))
    await writeFile(words, 'nsfw\n', 'utf8')
    const r = await rig({ config: { blocklist_files: [words] } })
    await unlink(words)
    r.clock.now += 10_000
    for (let i = 0; i < 5; i++) r.chat('画 一条龙', { uid: 1 })
    await until(() => r.said.length === 1)
    await pause(60)
    expect(r.said).toHaveLength(1)
    expect(r.events.filter((e) => e.includes('cooldown'))).toHaveLength(4)
  })

  it('a blocklist that cannot be read refuses every request loudly, and reading it again mends it', async () => {
    const words = path.join(await mkdtemp(path.join(tmpdir(), 'animatus-words-')), 'w.txt')
    dirs.push(path.dirname(words))
    await writeFile(words, 'nsfw\n', 'utf8')
    const r = await rig({ config: { blocklist_files: [words], cooldown_sec: 0 } })
    await unlink(words)
    r.clock.now += 10_000 // the list is looked at again every few seconds
    r.chat('画 一条龙', { uid: 1 })
    await until(() => r.said.length === 1)
    expect(r.alarms).toHaveLength(1)
    expect(r.alarms[0]).toMatchObject({ code: 'draw_blocklist', level: 'error', subject: 'draw' })
    expect(r.alarms[0]!.message).toContain('cannot be used')
    expect(r.llm.calls).toEqual([])
    expect(work(r)).toEqual([])

    await writeFile(words, 'nsfw\n', 'utf8')
    const later = new Date(Date.now() + 20_000)
    await utimes(words, later, later)
    r.clock.now += 10_000
    r.chat('画 一条龙', { uid: 2 })
    await until(() => r.told.length === 1)
    expect(r.alarms.filter((a) => a.code === 'draw_blocklist')).toEqual([])
  })
})

describe('a request the model refuses, or the image service blocks', () => {
  it('the planner says no: the frame does not change and the request is nowhere but in the planning call', async () => {
    const r = await rig()
    r.llm.answer = () => '{"refuse": true}'
    r.chat('画 一条龙')
    await until(() => r.said.length === 1)
    expect(texts(r)).toEqual(['on:弹幕发送「画 + 内容」召唤作品'])
    expect(work(r).map((c) => c.path)).toEqual(['/catalog'])
    expect(r.haystack()).not.toContain('一条龙')
    expect(r.told).toEqual([])
  })

  it('a model that answers nothing counts as no', async () => {
    const r = await rig()
    r.llm.answer = () => ''
    r.chat('画 一条龙')
    await until(() => r.said.length === 1)
    expect(r.llm.calls).toHaveLength(2) // asked twice
  })

  it('the image service blocks the picture: the frame goes back to what it was, a refusal is said, and no picture is kept', async () => {
    const r = await rig()
    r.forge.generate = () => ({
      status: 200,
      body: { status: 'blocked', reason: 'rating', attempts: 2 },
    })
    r.chat('画 一条龙')
    await until(() => r.said.length === 1)
    expect(texts(r)).toEqual([
      'on:弹幕发送「画 + 内容」召唤作品',
      'on:作画中 · ann：一条龙',
      'on:弹幕发送「画 + 内容」召唤作品',
    ])
    expect(await pictureFiles(r)).toEqual([])
    expect(r.haystack()).not.toContain('一条龙 ')
    expect(r.told).toEqual([])
    expect(r.alarms).toEqual([])
  })

  it('a blocked picture puts the previous one back, if it is still fresh', async () => {
    const r = await rig({ config: { cooldown_sec: 0 } })
    r.chat('画 甲', { uid: 1 })
    await until(() => r.told.length === 1)
    const first = r.frames().at(-1)!
    r.forge.generate = () => ({ status: 200, body: { status: 'rejected', reason: 'empty_prompt' } })
    r.chat('画 乙', { uid: 2 })
    await until(() => r.said.length === 1)
    expect(r.frames().at(-1)).toEqual(first)
  })
})

describe('when something is broken', () => {
  it('Forge is not running: a fault line, an alarm with the reason, no model asked, and the viewer may ask again at once', async () => {
    const r = await rig()
    r.forge.health = () =>
      healthy({
        forge_reachable: false,
        forge_error: 'cannot reach Forge at http://127.0.0.1:7860 (is it running with --api?)',
      })
    r.chat('画 一条龙')
    await until(() => r.said.length === 1)
    expect(r.llm.calls).toEqual([])
    expect(r.alarms).toHaveLength(1)
    expect(r.alarms[0]).toMatchObject({ code: 'draw_failed', level: 'warn', subject: 'draw' })
    expect(r.alarms[0]!.message).toContain('Forge is not reachable')
    expect(r.alarms[0]!.message).toContain('--api')
    const errors = (await readFile(path.join(REPO, 'modes/draw/prompts/errors.md'), 'utf8'))
      .split(/\r?\n/)
      .map((l) => l.replace(/^\[\w+\]/, '').trim())
    expect(errors).toContain(r.said[0]!.text)
    expect(texts(r)).toEqual(['on:弹幕发送「画 + 内容」召唤作品'])

    // a fault is not the viewer's doing: no cooldown; and the alarm goes away with the next success
    r.forge.health = () => healthy()
    r.chat('画 一条龙')
    await until(() => r.told.length === 1)
    expect(r.alarms).toEqual([])
  })

  it('the image service is not there at all', async () => {
    const r = await rig()
    await r.forge.stop()
    r.chat('画 一条龙')
    await until(() => r.said.length === 1)
    expect(r.alarms[0]!.message).toContain('cannot reach the image service')
    expect(r.llm.calls).toEqual([])
  })

  it('the image service says it is broken', async () => {
    const r = await rig()
    r.forge.health = () => ({
      status: 503,
      body: {
        ok: false,
        ready: false,
        service: 'forge',
        detail: 'the rating model is not available: no network',
        config: {},
      },
    })
    r.chat('画 一条龙')
    await until(() => r.said.length === 1)
    expect(r.alarms[0]!.message).toContain('the rating model is not available: no network')
  })

  it('the service is not running (it stopped while the mode was active)', async () => {
    const r = await rig({ serviceUp: true })
    r.forge.health = () => {
      throw new Error('unused')
    }
    await r.forge.stop()
    r.chat('画 x')
    await until(() => r.said.length === 1)
    expect(r.alarms[0]!.code).toBe('draw_failed')
  })

  it('the model cannot be reached: an error with its words, not a refusal', async () => {
    const r = await rig()
    r.llm.answer = () => {
      throw new Error('all LLM providers failed: primary=quota (HTTP 429)')
    }
    r.chat('画 一条龙')
    await until(() => r.said.length === 1)
    expect(r.alarms[0]!.message).toContain('the model could not plan the picture')
    expect(r.alarms[0]!.message).toContain('quota')
    expect(work(r).map((c) => c.path)).toEqual(['/catalog'])
  })

  it('the image service fails while drawing: its own words in the alarm, the frame back, no picture', async () => {
    const r = await rig()
    r.forge.generate = () =>
      serviceError(
        502,
        'forge_error',
        'Forge answered 500 to POST /sdapi/v1/txt2img: CUDA out of memory',
        true
      )
    r.chat('画 一条龙')
    await until(() => r.said.length === 1)
    expect(r.alarms[0]!.message).toContain('CUDA out of memory')
    expect(texts(r).at(-1)).toBe('on:弹幕发送「画 + 内容」召唤作品')
    expect(await pictureFiles(r)).toEqual([])
  })

  it('an answer that is not a picture is an error, and nothing is written', async () => {
    const r = await rig()
    r.forge.generate = () =>
      okPicture({ image_b64: Buffer.from('GIF89a not a png').toString('base64') })
    r.chat('画 一条龙')
    await until(() => r.said.length === 1)
    expect(r.alarms[0]!.message).toContain('not a PNG')
    expect(await pictureFiles(r)).toEqual([])
  })

  it('a checkpoint the image service lacks is an error that names it, not a refusal', async () => {
    const r = await rig()
    r.forge.catalog = () => ({
      status: 200,
      body: { checkpoints: [], loras: [], families: [], max_long_side: 1024 },
    })
    r.chat('画 一条龙')
    await until(() => r.said.length === 1)
    expect(r.alarms[0]!.message).toMatch(
      /no checkpoint of the default route can be used.*anime-model/
    )
    expect(r.llm.calls).toEqual([])
  })

  it('a later success clears the alarm', async () => {
    const r = await rig({ config: { cooldown_sec: 0 } })
    r.llm.answer = () => {
      throw new Error('down')
    }
    r.chat('画 甲', { uid: 1 })
    await until(() => r.alarms.length === 1)
    r.llm.answer = (req) => (req.tag === 'draw-select' ? selectAnswer() : writeAnswer())
    r.chat('画 乙', { uid: 2 })
    await until(() => r.told.length === 1)
    expect(r.alarms).toEqual([])
  })

  it('the pack files that ship can each be read, and a stage that reconnects needs nothing from the controller', () => {
    expect(pack.prompts.size).toBeGreaterThan(20)
  })
})

describe('the queue and the cooldown', () => {
  it('one at a time, in order; at most queue_max wait; the rest are ignored without a word', async () => {
    const r = await rig({ config: { queue_max: 2, cooldown_sec: 0 } })
    const held = gate()
    r.forge.generate = async () => (await held.wait, okPicture())
    r.chat('画 一', { uid: 1, uname: 'u1' })
    await until(() => r.forge.generateCalls().length === 1)
    r.chat('画 二', { uid: 2, uname: 'u2' })
    r.chat('画 三', { uid: 3, uname: 'u3' })
    r.chat('画 四', { uid: 4, uname: 'u4' })
    expect(r.events.some((e) => e.includes('u4') && e.includes('queue is full'))).toBe(true)
    expect(r.ctl.status()).toMatchObject({ queue: 2, current: 'u1' })
    expect(r.forge.generateCalls()).toHaveLength(1)
    held.open()
    await until(() => r.told.length === 3, 8000, 'three pictures')
    expect(r.told.map((t) => /"(u\d)"/.exec(t.text)![1])).toEqual(['u1', 'u2', 'u3'])
    expect(r.forge.generateCalls()).toHaveLength(3) // the fourth never was
    expect(r.said).toEqual([])
    expect(r.ctl.status()).toMatchObject({ queue: 0, current: null })
  })

  it('a viewer waits between requests, another does not, the time runs out, and the owner may skip it', async () => {
    const r = await rig()
    r.chat('画 甲', { uid: 1 })
    await until(() => r.told.length === 1)
    r.chat('画 乙', { uid: 1 })
    r.chat('画 丙', { uid: 2, uname: 'bob' })
    await until(() => r.told.length === 2)
    expect(r.forge.generateCalls()).toHaveLength(2)
    expect(r.events.some((e) => e.includes('ann was ignored') && e.includes('cooldown'))).toBe(true)

    r.clock.now += 301_000
    r.chat('画 丁', { uid: 1 })
    await until(() => r.told.length === 3)

    r.chat('画 戊', { uid: 9, uname: 'streamer', owner: true })
    r.chat('画 己', { uid: 9, uname: 'streamer', owner: true })
    await until(() => r.told.length === 5, 8000)
  })

  it('the owner is held like anyone when owner_skips_cooldown is off', async () => {
    const r = await rig({ config: { owner_skips_cooldown: false } })
    r.chat('画 甲', { uid: 9, owner: true })
    await until(() => r.told.length === 1)
    r.chat('画 乙', { uid: 9, owner: true })
    await pause(60)
    expect(r.forge.generateCalls()).toHaveLength(1)
  })

  it('a viewer without a user id is told apart by name', async () => {
    const r = await rig()
    r.chat('画 甲', { uid: 0, uname: 'guest' })
    await until(() => r.told.length === 1)
    r.chat('画 乙', { uid: 0, uname: 'guest' })
    r.chat('画 丙', { uid: 0, uname: 'other' })
    await until(() => r.told.length === 2)
    expect(r.forge.generateCalls()).toHaveLength(2)
  })

  it('the cooldown survives a restart, and a torn state file is ignored', async () => {
    const first = await rig()
    first.chat('画 甲', { uid: 1 })
    await until(() => first.told.length === 1)
    await flushJson()
    await first.service.dispose()
    const again = await rig({ dir: first.dir })
    again.clock.now = first.clock.now + 60_000
    again.chat('画 乙', { uid: 1 })
    await pause(60)
    expect(again.llm.calls).toEqual([])

    const torn = await mkdtemp(path.join(tmpdir(), 'animatus-draw-'))
    dirs.push(torn)
    await mkdir(path.join(torn, 'data'), { recursive: true })
    await writeFile(path.join(torn, 'data', 'draw-state.json'), '{"asked": {"u1": ')
    const fresh = await rig({ dir: torn })
    fresh.chat('画 甲', { uid: 1 })
    await until(() => fresh.told.length === 1)
  })
})

describe('stopping', () => {
  it('while a picture is being drawn: the image service is told (the connection closes), nothing is shown, said or raised, the viewer may ask again', async () => {
    const r = await rig()
    const held = gate()
    r.forge.generate = async () => (await held.wait, okPicture())
    r.chat('画 一条龙')
    await until(() => r.forge.generateCalls().length === 1)
    await r.exit('console')
    expect(r.service.state('draw')).toBe('IDLE')
    await until(() => r.forge.hungUp.length === 1, 3000, 'the hang-up')
    held.open()
    await pause(80)
    expect(texts(r).at(-1)).toBe('off:')
    expect(r.frames().filter((f) => String(f.text).includes('点图'))).toEqual([])
    expect(r.told).toEqual([])
    expect(r.said).toEqual([])
    expect(r.alarms).toEqual([])
    expect(await pictureFiles(r)).toEqual([])
    expect(r.held).toEqual([])

    r.forge.generate = () => okPicture()
    await r.enter()
    r.chat('画 一条龙')
    await until(() => r.told.length === 1)
  })

  it('while the model is still planning', async () => {
    const r = await rig()
    let seen: AbortSignal | undefined
    r.llm.answer = (req) =>
      new Promise((_, reject) => {
        seen = req.signal
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    r.chat('画 一条龙')
    await until(() => seen !== undefined)
    await r.exit()
    expect(seen?.aborted).toBe(true)
    await pause(60)
    expect(work(r).filter((c) => c.path === '/generate')).toEqual([])
    expect(r.alarms).toEqual([])
    expect(r.said).toEqual([])
  })

  it('while the model is planning and takes no notice of being stopped: its late answer changes nothing', async () => {
    const r = await rig()
    const answer = gate()
    r.llm.answer = async (req) => (
      await answer.wait,
      req.tag === 'draw-select' ? selectAnswer() : writeAnswer()
    )
    r.chat('画 一条龙')
    await until(() => r.llm.calls.length === 1)
    await r.exit()
    const overlaysAfterExit = r.overlays.length
    answer.open()
    await pause(120)
    expect(r.forge.generateCalls()).toEqual([])
    expect(r.overlays).toHaveLength(overlaysAfterExit) // the frame is not put back on the stage
    expect(r.frames().at(-1)).toMatchObject({ visible: false })
    expect(r.told).toEqual([])
    expect(r.said).toEqual([])
    expect(r.alarms).toEqual([])
  })

  it('while the image service takes no notice of being stopped: its late picture is not shown, kept or commented on', async () => {
    const r = await rig()
    const held = gate()
    r.forge.generate = async () => (await held.wait, okPicture())
    r.chat('画 一条龙')
    await until(() => r.forge.generateCalls().length === 1)
    await r.exit()
    held.open()
    await pause(120)
    expect(r.told).toEqual([])
    expect(r.frames().at(-1)).toMatchObject({ visible: false })
    expect(r.alarms).toEqual([])
  })

  it('what waits in the queue is dropped, and never drawn', async () => {
    const r = await rig({ config: { cooldown_sec: 0 } })
    const held = gate()
    r.forge.generate = async () => (await held.wait, okPicture())
    r.chat('画 一', { uid: 1 })
    await until(() => r.forge.generateCalls().length === 1)
    r.chat('画 二', { uid: 2 })
    r.chat('画 三', { uid: 3 })
    await r.exit()
    held.open()
    await pause(100)
    expect(r.forge.generateCalls()).toHaveLength(1)
    expect(r.told).toEqual([])
  })

  it('a shutdown in the middle of a picture is prompt and leaves nothing behind', async () => {
    const r = await rig()
    const held = gate()
    r.forge.generate = async () => (await held.wait, okPicture())
    r.chat('画 一条龙')
    await until(() => r.forge.generateCalls().length === 1)
    const t0 = Date.now()
    await r.service.dispose()
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.service.state('draw')).toBe('IDLE')
    expect(r.frames().at(-1)).toMatchObject({ visible: false })
    await until(() => r.forge.hungUp.length === 1, 3000, 'the hang-up')
    held.open()
    await pause(60)
    expect(r.told).toEqual([])
  })

  it('a comment about a picture that is up is not said after the mode is left, and a later request is not affected by it', async () => {
    const r = await rig()
    const free = gate()
    r.quiet.wait = free.wait
    r.chat('画 一条龙')
    await until(() => r.frames().length === 3)
    await r.exit()
    await r.enter()
    r.quiet.wait = null
    free.open()
    await pause(60)
    expect(r.told).toEqual([]) // the old comment belongs to the old run
  })
})

describe('the console panel', () => {
  it('shows what the operator needs, and the buttons say why they are off while the mode is not running', async () => {
    const r = await rig({ enter: false })
    const off = r.panel()
    expect(off.status).toBe('not running')
    expect(off.actions.map((a) => [a.id, a.disabled])).toEqual([
      ['draw', 'the mode is not running'],
      ['clear', 'the mode is not running'],
      ['set_max_long_side', 'the mode is not running'],
    ])
    await r.enter()
    await until(() => r.panel().facts.some((f) => f.label === 'Forge' && f.value === 'reachable'))
    const p = r.panel()
    expect(p.status).toBe('waiting for requests')
    expect(Object.fromEntries(p.facts.map((f) => [f.label, f.value]))).toMatchObject({
      'Image service': 'ready',
      Forge: 'reachable',
      'Rating model': 'ready',
      'Longest side': '1024 px',
      Queue: '0 waiting, at most 3',
      Cooldown: '300 s for each viewer',
    })
    expect(p.actions.map((a) => [a.id, a.disabled])).toEqual([
      ['draw', undefined],
      ['clear', undefined],
      ['set_max_long_side', undefined],
    ])
    expect(p.actions[2]!.inputs[0]).toMatchObject({
      name: 'max_long_side',
      min: 512,
      max: 2048,
      step: 64,
      value: 1024,
    })
    expect(p.sections[0]).toMatchObject({ title: 'Queue', rows: [] })
  })

  it('lists the picture being made and the ones waiting, each with a cancel button, and the last picture', async () => {
    const r = await rig({ config: { cooldown_sec: 0 } })
    const held = gate()
    r.forge.generate = async () => (await held.wait, okPicture())
    r.chat('画 一', { uid: 1, uname: 'u1' })
    await until(() => r.forge.generateCalls().length === 1)
    r.chat('画 二', { uid: 2, uname: 'u2' })
    const p = r.panel()
    expect(p.status).toBe('drawing for u1: 一')
    expect(p.sections[0]!.rows.map((x) => [x.text, x.detail, x.active])).toEqual([
      ['u1: 一', 'drawing', true],
      ['u2: 二', 'waiting, number 1', false],
    ])
    expect(p.sections[0]!.rows.every((x) => x.actions.map((a) => a.id).join() === 'cancel')).toBe(
      true
    )
    expect(p.image).toBeUndefined()
    held.open()
    await until(() => r.told.length === 2)
    expect(r.panel().image).toMatch(/^\/asset\/generated\/draw-/)
  })

  it('the operator can draw a picture from the panel (no cooldown), and is told why a request cannot be taken', async () => {
    const r = await rig()
    expect(await r.service.consoleRequest('draw', { action: 'draw', request: '一条龙' })).toEqual({
      ok: true,
    })
    await until(() => r.told.length === 1)
    expect(texts(r)[1]).toBe('on:作画中 · 主播：一条龙')
    expect(await r.service.consoleRequest('draw', { action: 'draw', request: '一条龙' })).toEqual({
      ok: true,
    })
    expect(await r.service.consoleRequest('draw', { action: 'draw', request: '  ' })).toEqual({
      ok: false,
      reason: 'write what to draw',
    })
    expect(await r.service.consoleRequest('draw', { action: 'draw', request: 'nude' })).toEqual({
      ok: false,
      reason: 'the request is on the blocklist',
    })
  })

  it('the frame can be cleared, and a request can be cancelled from the queue or while it is being drawn', async () => {
    const r = await rig({ config: { cooldown_sec: 0 } })
    const held = gate()
    r.forge.generate = async () => (await held.wait, okPicture())
    r.chat('画 一', { uid: 1, uname: 'u1' })
    await until(() => r.forge.generateCalls().length === 1)
    r.chat('画 二', { uid: 2, uname: 'u2' })
    const [running, waiting] = r.panel().sections[0]!.rows
    expect(await r.service.consoleRequest('draw', { action: 'cancel', row: waiting!.id })).toEqual({
      ok: true,
    })
    expect(await r.service.consoleRequest('draw', { action: 'cancel', row: waiting!.id })).toEqual({
      ok: false,
      reason: 'that request is not waiting any more',
    })
    expect(await r.service.consoleRequest('draw', { action: 'cancel' })).toMatchObject({
      ok: false,
    })
    expect(await r.service.consoleRequest('draw', { action: 'cancel', row: running!.id })).toEqual({
      ok: true,
    })
    await until(() => r.ctl.status().current === null)
    held.open()
    await pause(60)
    expect(r.told).toEqual([])
    expect(r.said).toEqual([])
    expect(r.alarms).toEqual([])
    expect(texts(r).at(-1)).toBe('on:弹幕发送「画 + 内容」召唤作品') // put back, not left on "drawing"
    expect(r.panel().sections[0]!.rows).toEqual([])

    r.forge.generate = () => okPicture()
    r.chat('画 三', { uid: 1, uname: 'u1' }) // the cancelled viewer did not lose their turn
    await until(() => r.told.length === 1)
    expect(await r.service.consoleRequest('draw', { action: 'clear' })).toEqual({ ok: true })
    expect(texts(r).at(-1)).toBe('on:弹幕发送「画 + 内容」召唤作品')
    expect(r.frames().at(-1)!.image).toBeUndefined()
  })

  it('the longest side is set at the image service, checked here first, and the panel shows the new value', async () => {
    const r = await rig()
    let size = 1024
    r.forge.health = () => healthy({ max_long_side: size })
    r.forge.config = (body) => {
      size = body.max_long_side as number
      return { status: 200, body: { ok: true, config: { max_long_side: size } } }
    }
    expect(
      await r.service.consoleRequest('draw', { action: 'set_max_long_side', max_long_side: 768 })
    ).toEqual({ ok: true })
    expect(r.forge.calls.find((c) => c.path === '/config')?.body).toEqual({ max_long_side: 768 })
    expect(r.panel().facts.find((f) => f.label === 'Longest side')?.value).toBe('768 px')
    for (const bad of [770, 448, 4096, '768', 768.5, undefined]) {
      const result = await r.service.consoleRequest('draw', {
        action: 'set_max_long_side',
        max_long_side: bad,
      })
      expect(result.ok, String(bad)).toBe(false)
      expect(result.reason).toContain('multiple of 64')
    }
    expect(r.forge.calls.filter((c) => c.path === '/config')).toHaveLength(1)

    r.forge.config = () => ({
      status: 500,
      body: {
        error: {
          code: 'state_not_saved',
          message: 'the setting could not be saved (disk full)',
          retryable: false,
        },
      },
    })
    expect(
      await r.service.consoleRequest('draw', { action: 'set_max_long_side', max_long_side: 640 })
    ).toEqual({
      ok: false,
      reason: 'the setting could not be saved (disk full)',
    })
  })

  it('entering from the console goes through the mode service; an unknown action is refused', async () => {
    const r = await rig({ enter: false })
    expect(await r.service.consoleRequest('draw', {})).toEqual({ ok: true })
    expect(r.service.state('draw')).toBe('ACTIVE')
    expect(await r.service.consoleRequest('draw', { action: 'dance' })).toEqual({
      ok: false,
      reason: 'there is no action "dance"',
    })
    await r.exit()
    expect(await r.service.consoleRequest('draw', { action: 'clear' })).toEqual({
      ok: false,
      reason: 'the mode is not running',
    })
  })

  it('a service that is down shows in the facts', async () => {
    const r = await rig({ enter: false, serviceUp: false })
    await r.forge.stop()
    expect(r.panel().facts.find((f) => f.label === 'Image service')?.value).toBe('not asked yet')
  })
})
