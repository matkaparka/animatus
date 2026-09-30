import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { renderTemplate } from '../../src/brain/prompt.ts'
import type { ForgeCatalog } from '../../src/modes/draw/client.ts'
import { PlanError, createPlanner, detectRoute, findInstalled } from '../../src/modes/draw/plan.ts'
import { parseDrawSettings } from '../../src/modes/draw/settings.ts'
import type { ModeHost } from '../../src/modes/host.ts'
import type { LlmTextRequest } from '../../src/modes/host.ts'
import { loadModePacks } from '../../src/modes/loader.ts'
import type { LoadedMode } from '../../src/modes/loader.ts'
import { defaultCatalog, drawConfig } from './draw-support.ts'

const MODES = path.resolve(__dirname, '../../../../modes')
let pack: LoadedMode
beforeAll(async () => {
  pack = (await loadModePacks([MODES])).modes.find((m) => m.manifest.id === 'draw') as LoadedMode
})

const select = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    style: 'anime',
    subject: 'a knight',
    checkpoint: 'anime-model',
    loras: [],
    orientation: 'portrait',
    self: false,
    note: 'fits',
    ...over,
  })
const write = (prompt = '1girl, armor', negative = '') => JSON.stringify({ prompt, negative })

interface Rig {
  calls: LlmTextRequest[]
  logs: string[]
  answers: (string | Error)[]
  plan(
    request: string,
    catalog?: ForgeCatalog,
    signal?: AbortSignal
  ): ReturnType<ReturnType<typeof createPlanner>['plan']>
}

function rig(
  config: Record<string, unknown> = drawConfig(),
  answers: (string | Error)[] = []
): Rig {
  const calls: LlmTextRequest[] = []
  const logs: string[] = []
  const host = {
    prompt: (_mode: string, name: string, vars: Record<string, string> = {}) => {
      const t = pack.prompts.get(name)
      return t === undefined ? null : renderTemplate(t, vars)
    },
    llmText: async (req: LlmTextRequest) => {
      calls.push(req)
      const a = r.answers.shift()
      if (a === undefined) throw new Error('the test gave the model nothing to say')
      if (a instanceof Error) throw a
      return a
    },
    log: (_level: string, msg: string) => void logs.push(msg),
  } as unknown as ModeHost
  const planner = createPlanner(host, parseDrawSettings(config, '/root'))
  const r: Rig = {
    calls,
    logs,
    answers,
    plan: (request, catalog = defaultCatalog(), signal = new AbortController().signal) =>
      planner.plan(request, catalog, signal),
  }
  return r
}

const userOf = (c: LlmTextRequest) => String(c.user)

describe('which route a request takes by its words', () => {
  const routes = parseDrawSettings(drawConfig(), '/root').routes
  it('self, then photo, then furry, else default', () => {
    expect(detectRoute('画一张你自己', routes)).toBe('self')
    expect(detectRoute('你', routes)).toBe('self')
    expect(detectRoute('你好', routes)).toBe('default') // exact words match the whole request only
    expect(detectRoute('画一张真人照片', routes)).toBe('photo')
    expect(detectRoute('一个兽人战士', routes)).toBe('furry')
    expect(detectRoute('真人兽人', routes)).toBe('photo')
    expect(detectRoute('一个真人，画你自己', routes)).toBe('self')
    expect(detectRoute('一条龙', routes)).toBe('default')
    expect(detectRoute('A FURRY wolf', routes)).toBe('furry')
  })

  it('a route that is not configured is never taken', () => {
    const s = parseDrawSettings({ routes: { default: { checkpoints: [{ name: 'm' }] } } }, '/root')
    expect(detectRoute('你自己 真人 兽人', s.routes)).toBe('default')
  })
})

describe('finding what the image service has', () => {
  const list = defaultCatalog().checkpoints
  it('by name, title or file name, and by a fragment that means one', () => {
    expect(findInstalled(list, 'anime-model')?.name).toBe('anime-model')
    expect(findInstalled(list, 'ANIME-MODEL.safetensors [aaaa1111]')?.name).toBe('anime-model')
    expect(findInstalled(list, 'photo')?.name).toBe('photo-model')
    expect(findInstalled(list, 'model')).toBeUndefined() // matches several
    expect(findInstalled(list, 'nothing')).toBeUndefined()
  })
})

describe('a picture on the default route', () => {
  it('two calls: the choice, then the prompt; the request that goes to the service is built from both', async () => {
    const r = rig()
    r.answers.push(
      select({
        loras: [{ name: 'sword-lora', weight: 0.9 }],
        orientation: 'portrait',
      }),
      write('masterpiece, 1girl, armor, <lora:x:1>, sword', 'blurry, best quality')
    )
    const planned = await r.plan('一个拿剑的骑士')
    expect(planned.kind).toBe('ok')
    if (planned.kind !== 'ok') return
    expect(planned.route).toBe('default')
    expect(planned.self).toBe(false)
    expect(planned.payload).toEqual({
      checkpoint: 'anime-model',
      // what the model wrote, without its quality words and the LoRA tag it slipped in ...
      prompt: '1girl, armor, sword',
      // ... and, apart from it, what the configuration adds: the model's quality words and the LoRA's trigger word
      prefix: 'masterpiece, best quality, sword_style',
      negative_prompt: 'lowres, blurry',
      width: expect.any(Number),
      height: expect.any(Number),
      steps: 30,
      cfg_scale: 5,
      sampler_name: 'Euler a',
      scheduler: 'Automatic',
      seed: -1,
      loras: [{ name: 'sword-lora', weight: 0.9 }],
      route: 'default',
    })
    expect(planned.payload.width).toBeLessThan(planned.payload.height)
    expect(r.calls.map((c) => c.tag)).toEqual(['draw-select', 'draw-write'])
  })

  it('what the model is asked carries the rules of a public broadcast, the request as a topic, and the notes', async () => {
    const r = rig()
    r.answers.push(select(), write())
    await r.plan('一个壮熊')
    const [choose, compose] = r.calls
    for (const c of [choose!, compose!]) {
      expect(c.system).toContain('public live broadcast')
      expect(c.system).toContain('{"refuse": true}')
      expect(c.temperature).toBe(0.2)
      expect(c.timeoutMs).toBe(30_000)
      expect(userOf(c)).toContain('<<<一个壮熊>>>')
      expect(userOf(c)).toContain('"熊" means a large, bearlike man')
    }
    expect(userOf(choose!)).toContain('- anime-model | style any')
    expect(userOf(choose!)).toContain('- sword-lora | recommended weight 0.7 | swords and blades')
    expect(userOf(choose!)).toContain('At most 2.')
    // the guide of the chosen model's family, and the LoRAs that will be attached
    expect(userOf(compose!)).toContain('Illustrious / NoobAI family')
    expect(userOf(compose!)).toContain('Chosen model: anime-model')
  })

  it('the model that is asked is told to stop when the caller does', async () => {
    const r = rig()
    r.answers.push(select(), write())
    const ctl = new AbortController()
    await r.plan('x', undefined, ctl.signal)
    expect(r.calls.every((c) => c.signal === ctl.signal)).toBe(true)
  })

  it('a shape from the model, weights and LoRAs are checked: unknown or repeated LoRAs go, weights are kept in range', async () => {
    const config = drawConfig()
    ;(config.routes as Record<string, { loras: unknown[] }>).default!.loras.push({
      name: 'photo-lora',
    })
    const r = rig(config)
    r.answers.push(
      select({
        loras: [
          { name: 'ghost-lora', weight: 1 },
          { name: 'SWORD-LORA', weight: 9 },
          { name: 'sword-lora', weight: 0.3 },
          { name: 'photo-lora', weight: 'heavy' },
        ],
        orientation: 'sideways',
      }),
      write()
    )
    const planned = await r.plan('x')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.payload.loras).toEqual([
      { name: 'sword-lora', weight: 1.5 },
      { name: 'photo-lora', weight: 0.8 },
    ])
    expect(planned.payload.width).toBe(planned.payload.height) // an unknown shape is a square
  })

  it('no more LoRAs than max_loras', async () => {
    const config = drawConfig({ max_loras: 1 })
    ;(config.routes as Record<string, { loras: unknown[] }>).default!.loras.push({
      name: 'photo-lora',
    })
    const r = rig(config)
    r.answers.push(select({ loras: [{ name: 'sword-lora' }, { name: 'photo-lora' }] }), write())
    const planned = await r.plan('x')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.payload.loras.map((l) => l.name)).toEqual(['sword-lora'])
  })

  it('a trigger word that is already in the prompt is not added again; a quality word in the middle stops the prefix', async () => {
    const r = rig()
    r.answers.push(
      select({ loras: [{ name: 'sword-lora' }] }),
      write('1girl, Sword_Style, worst quality lowres, absurdres armor')
    )
    const planned = await r.plan('x')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.payload.prompt).toBe('1girl, Sword_Style, worst quality lowres, absurdres armor')
    expect(planned.payload).not.toHaveProperty('prefix') // nothing left to add
  })

  it('a prompt of nothing but quality words and LoRA tags is not a prompt: the writer has said nothing', async () => {
    const r = rig()
    r.answers.push(select(), write('masterpiece, best quality, <lora:x:1>'))
    expect(await r.plan('x')).toEqual({ kind: 'refused', reason: 'writer_empty' })
  })

  it('a tag that means something else in the models vocabulary is dropped unless the request asked for it', async () => {
    const r = rig()
    r.answers.push(select(), write('1boy, husky, armor'), select(), write('1boy, husky, armor'))
    const plain = await r.plan('一个壮汉')
    const asked = await r.plan('一只husky')
    if (plain.kind !== 'ok' || asked.kind !== 'ok') throw new Error('expected plans')
    expect(plain.payload.prompt).not.toContain('husky')
    expect(asked.payload.prompt).toContain('husky')
  })

  it('a model that answers with an invalid escape (a danbooru tag) is still understood', async () => {
    const r = rig()
    r.answers.push(select(), '{"prompt": "hair ornament \\(flower\\), 1girl", "negative": ""}')
    const planned = await r.plan('x')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.payload.prompt).toContain('hair ornament \\(flower\\), 1girl')
  })

  it('a scheduler left out of the model settings is not sent', async () => {
    const config = drawConfig()
    ;(
      config.routes as Record<string, { checkpoints: Record<string, unknown>[] }>
    ).default!.checkpoints[0]!.params = {
      scheduler: null,
    }
    const r = rig(config)
    r.answers.push(select(), write())
    const planned = await r.plan('x')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.payload).not.toHaveProperty('scheduler')
  })

  it('with several models the one the model names is used, by name or by a fragment, else the first', async () => {
    const config = drawConfig()
    ;(config.routes as Record<string, { checkpoints: unknown[] }>).default!.checkpoints.push({
      name: 'furry-model',
      desc: 'wolves and such',
    })
    for (const [asked, used] of [
      ['furry-model', 'furry-model'],
      ['FURRY', 'furry-model'],
      ['something-else', 'anime-model'],
      ['', 'anime-model'],
    ] as const) {
      const r = rig(config)
      r.answers.push(select({ checkpoint: asked }), write())
      const planned = await r.plan('x')
      if (planned.kind !== 'ok') throw new Error('expected a plan')
      expect(planned.payload.checkpoint, asked).toBe(used)
    }
  })
})

describe('a refusal', () => {
  it('the model says no in the first step: nothing else is asked', async () => {
    const r = rig()
    r.answers.push('{"refuse": true}')
    expect(await r.plan('x')).toEqual({ kind: 'refused', reason: 'planner_refused' })
    expect(r.calls).toHaveLength(1)
  })

  it('or in the second', async () => {
    const r = rig()
    r.answers.push(select(), '```json\n{"refuse": true}\n```')
    expect(await r.plan('x')).toEqual({ kind: 'refused', reason: 'writer_refused' })
  })

  it('an answer that is not JSON is asked for once more and then counts as a refusal (a provider filter answers nothing)', async () => {
    const r = rig()
    r.answers.push('', 'Sorry, I cannot help with that.')
    expect(await r.plan('x')).toEqual({ kind: 'refused', reason: 'planner_no_json' })
    expect(r.calls).toHaveLength(2)

    const s = rig()
    s.answers.push(select(), '', '{"prompt": "  ", "negative": ""}')
    expect(await s.plan('x')).toEqual({ kind: 'refused', reason: 'writer_no_json' })
    expect(s.calls.map((c) => c.tag)).toEqual(['draw-select', 'draw-write', 'draw-write'])
  })

  it('a second try that works is used', async () => {
    const r = rig()
    r.answers.push('oops', select(), write())
    expect((await r.plan('x')).kind).toBe('ok')
  })

  it('a model that cannot be reached is not a refusal: the failure goes up', async () => {
    const r = rig()
    r.answers.push(new Error('all LLM providers failed: primary=quota'))
    await expect(r.plan('x')).rejects.toThrow('all LLM providers failed')
    const s = rig()
    s.answers.push(select(), new Error('timed out'))
    await expect(s.plan('x')).rejects.toThrow('timed out')
  })
})

describe('the self-portrait route', () => {
  it('a fixed model and LoRA, whatever the model suggests, with the character note in both steps', async () => {
    const r = rig()
    r.answers.push(
      select({ checkpoint: 'anime-model', loras: [{ name: 'sword-lora' }] }),
      write('solo, standing, night sky')
    )
    const planned = await r.plan('画一张你自己')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.route).toBe('self')
    expect(planned.self).toBe(true)
    expect(planned.payload).toMatchObject({
      checkpoint: 'self-model',
      prompt: 'solo, standing, night sky',
      // the model's prefix, then the trigger words in the order written
      prefix: 'masterpiece, self_trigger, mecha dragon',
      loras: [{ name: 'self-lora', weight: 0.7 }],
      route: 'self',
    })
    const [choose, compose] = r.calls
    expect(userOf(choose!)).toContain("the streamer's own character: a red-gold mechanical dragon")
    expect(userOf(choose!)).toContain('(none: the program attaches them)')
    expect(userOf(compose!)).toContain('Do not describe the character')
    expect(userOf(compose!)).toContain('- self-lora: (no description)')
  })

  it('the model can notice it: a self-portrait it finds in a request without the words moves to the route, with no extra call', async () => {
    const r = rig()
    r.answers.push(select({ self: true, orientation: 'landscape' }), write('solo'))
    const planned = await r.plan('给我们看看你长什么样')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.route).toBe('self')
    expect(planned.payload.checkpoint).toBe('self-model')
    expect(planned.payload.width).toBeGreaterThan(planned.payload.height) // the shape it chose stays
    expect(r.calls).toHaveLength(2)
    expect(userOf(r.calls[0]!)).toContain('add "self": true')
  })

  it('without a self route the rule is not offered and the flag is ignored', async () => {
    const config = drawConfig()
    delete (config.routes as Record<string, unknown>).self
    const r = rig(config)
    r.answers.push(select({ self: true }), write())
    const planned = await r.plan('画你自己')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.route).toBe('default')
    expect(userOf(r.calls[0]!)).not.toContain('"self": true to the JSON')
  })
})

describe('the photo route', () => {
  it('by its words: its model, its LoRAs and its notes', async () => {
    const r = rig()
    r.answers.push(
      select({ checkpoint: 'photo-model', loras: [{ name: 'photo-lora' }] }),
      write('a man in a suit, photo')
    )
    const planned = await r.plan('一张真人照片')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.route).toBe('photo')
    expect(planned.payload).toMatchObject({
      checkpoint: 'photo-model',
      prompt: 'a man in a suit, photo',
      prefix: 'score_9, score_8_up',
      loras: [{ name: 'photo-lora', weight: 0.8 }],
    })
    expect(userOf(r.calls[0]!)).toContain('photographic picture')
    expect(userOf(r.calls[1]!)).toContain('photographic style')
    expect(userOf(r.calls[1]!)).toContain('Pony family')
  })

  it('by what the model found out: the choice is made again among the photo models', async () => {
    const r = rig()
    r.answers.push(
      select({ style: 'photo' }),
      select({ style: 'photo', checkpoint: 'photo-model', orientation: 'landscape' }),
      write('a street at night')
    )
    const planned = await r.plan('夜晚的街道，像相机拍的')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.route).toBe('photo')
    expect(planned.payload.checkpoint).toBe('photo-model')
    expect(planned.payload.width).toBeGreaterThan(planned.payload.height)
    expect(r.calls.map((c) => c.tag)).toEqual(['draw-select', 'draw-select', 'draw-write'])
    expect(userOf(r.calls[1]!)).toContain('photographic picture')
  })

  it('the model refusing the second choice is a refusal', async () => {
    const r = rig()
    r.answers.push(select({ style: '照片' }), '{"refuse": true}')
    expect(await r.plan('x')).toEqual({ kind: 'refused', reason: 'planner_refused' })
  })
})

describe('the furry route', () => {
  it('by its words', async () => {
    const r = rig()
    r.answers.push(select({ checkpoint: 'furry-model' }), write('anthro wolf'))
    const planned = await r.plan('一个兽人战士')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.route).toBe('furry')
    expect(planned.payload.checkpoint).toBe('furry-model')
    expect(userOf(r.calls[0]!)).toContain('furry / anthro')
  })

  it('by the subject the model saw, without another call, and the LoRAs of the other route are left behind', async () => {
    const r = rig()
    r.answers.push(
      select({ subject: 'an anthro wolf furry warrior', loras: [{ name: 'sword-lora' }] }),
      write('wolf')
    )
    const planned = await r.plan('一头狼战士')
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.route).toBe('furry')
    expect(planned.payload.checkpoint).toBe('furry-model')
    expect(planned.payload.loras).toEqual([])
    expect(r.calls).toHaveLength(2)
  })
})

describe('what the image service has decides what can be planned', () => {
  it('a model that is not installed, or not allowed, is an error that says which, not a refusal', async () => {
    const missing = defaultCatalog()
    missing.checkpoints = missing.checkpoints.filter((c) => c.name !== 'anime-model')
    const r = rig()
    await expect(r.plan('x', missing)).rejects.toThrow(PlanError)
    await expect(r.plan('x', missing)).rejects.toThrow(
      /no checkpoint of the default route can be used: the checkpoint "anime-model" is not in Forge/
    )

    const blocked = defaultCatalog()
    blocked.checkpoints = blocked.checkpoints.map((c) =>
      c.name === 'anime-model' ? { ...c, allowed: false, why_not: 'not allowed here' } : c
    )
    await expect(rig().plan('x', blocked)).rejects.toThrow(/not allowed here/)
    expect(r.calls).toHaveLength(0)
  })

  it('a fixed route with a LoRA that is missing is an error: it would draw something else', async () => {
    const catalog = defaultCatalog()
    catalog.loras = catalog.loras.filter((l) => l.name !== 'self-lora')
    await expect(rig().plan('画你自己', catalog)).rejects.toThrow(
      /self route cannot be used as configured: the LoRA "self-lora" is not in Forge/
    )
    const off = defaultCatalog()
    off.loras = off.loras.map((l) => (l.name === 'self-lora' ? { ...l, allowed: false } : l))
    await expect(rig().plan('画你自己', off)).rejects.toThrow(/allowlist/)
  })

  it('a LoRA that cannot be used is left out of what the model may choose, and the operator is told once', async () => {
    const catalog = defaultCatalog()
    catalog.loras = catalog.loras.map((l) =>
      l.name === 'sword-lora' ? { ...l, allowed: false } : l
    )
    const r = rig()
    r.answers.push(select({ loras: [{ name: 'sword-lora' }] }), write(), select(), write())
    const planned = await r.plan('x', catalog)
    await r.plan('y', catalog)
    if (planned.kind !== 'ok') throw new Error('expected a plan')
    expect(planned.payload.loras).toEqual([])
    expect(userOf(r.calls[0]!)).not.toContain('sword-lora')
    expect(r.logs.filter((l) => l.includes('sword-lora'))).toHaveLength(1)
  })

  it('a pack that lacks a prompt file is an error, not an empty prompt', async () => {
    const host = {
      prompt: () => null,
      llmText: async () => '',
      log: () => {},
    } as unknown as ModeHost
    const planner = createPlanner(host, parseDrawSettings(drawConfig(), '/root'))
    await expect(planner.plan('x', defaultCatalog(), new AbortController().signal)).rejects.toThrow(
      /the draw pack has no prompts\/\w+\.md/
    )
  })
})
