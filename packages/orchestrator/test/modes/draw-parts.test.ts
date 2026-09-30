import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Cooldowns, cooldownKey } from '../../src/modes/draw/cooldown.ts'
import { frameMessages } from '../../src/modes/draw/frame.ts'
import type { FrameTexts } from '../../src/modes/draw/frame.ts'
import { parseLines, pickLine } from '../../src/modes/draw/lines.ts'
import { isPng, prunePictures, savePicture } from '../../src/modes/draw/pictures.ts'
import {
  cleanPrompt,
  dropAmbiguous,
  orientationOf,
  parseJsonObject,
  sizeFor,
} from '../../src/modes/draw/promptText.ts'
import { GenerationParams, parseDrawSettings } from '../../src/modes/draw/settings.ts'
import { flushJson } from '../../src/modes/jsonfile.ts'
import { drawConfig, makePng } from './draw-support.ts'

const dirs: string[] = []
afterEach(async () => {
  await flushJson()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'animatus-draw-'))
  dirs.push(d)
  return d
}

describe('the settings', () => {
  it('everything but the routes has a default, and the routes must be there', () => {
    const s = parseDrawSettings({ routes: { default: { checkpoints: [{ name: 'm' }] } } }, '/root')
    expect(s).toMatchObject({
      service: 'forge',
      cooldown_sec: 300,
      owner_skips_cooldown: true,
      queue_max: 3,
      max_chars: 60,
      refusal: 'canned',
      send_image: true,
      keep_pictures: 50,
      show_sec: 600,
      max_loras: 2,
      frame: { text_overlay: 'frame', rect: null, max_name_chars: 16, max_request_chars: 30 },
    })
    expect(s.routes.default.checkpoints[0]).toMatchObject({
      guide: 'sdxl',
      params: {
        steps: 30,
        cfg_scale: 5,
        sampler_name: 'Euler a',
        scheduler: 'Automatic',
        width: 1024,
      },
    })
    expect(s.blocklist_paths).toEqual([
      path.resolve('/root', 'plugins/forge/blocklist.default.txt'),
    ])
    expect(() => parseDrawSettings({}, '/root')).toThrow(/modes\.draw\.config\.routes/)
    expect(() => parseDrawSettings(undefined, '/root')).toThrow(/routes/)
  })

  it('a typo, a bound and a wrong type are each named with their key, all at once', () => {
    let message = ''
    try {
      parseDrawSettings(
        {
          cooldown_secs: 5,
          queue_max: 0,
          refusal: 'sometimes',
          frame: { text_overlay: 'banner' },
          routes: { default: { checkpoints: [{ name: 'm', params: { steps: 500 } }] }, spare: {} },
        },
        '/root'
      )
    } catch (e) {
      message = (e as Error).message
    }
    for (const part of [
      'Unrecognized key: "cooldown_secs"',
      'modes.draw.config.queue_max',
      'modes.draw.config.refusal',
      'modes.draw.config.frame.text_overlay',
      'routes.default.checkpoints.0.params.steps',
      'Unrecognized key: "spare"',
    ])
      expect(message, part).toContain(part)
  })

  it('a sampler name cannot carry anything but a name, and a route needs a model', () => {
    expect(GenerationParams.safeParse({ sampler_name: 'Euler a; rm -rf' }).success).toBe(false)
    expect(() => parseDrawSettings({ routes: { default: { checkpoints: [] } } }, '/r')).toThrow()
  })

  it('the configuration the tests use is valid', () => {
    const s = parseDrawSettings(drawConfig(), '/root')
    expect(Object.keys(s.routes)).toEqual(['default', 'self', 'photo', 'furry'])
    expect(s.routes.self?.fixed).toBe(true)
  })
})

describe('reading what the model wrote', () => {
  it('finds the first JSON object, in prose or in a code fence', () => {
    expect(parseJsonObject('{"a": 1}')).toEqual({ a: 1 })
    expect(parseJsonObject('Sure!\n```json\n{"a": {"b": [1, 2]}, "c": "}"}\n```\nDone')).toEqual({
      a: { b: [1, 2] },
      c: '}',
    })
    expect(parseJsonObject('{not json} then {"ok": true}')).toEqual({ ok: true })
  })

  it('a single backslash that is not an escape (a danbooru tag) does not break it', () => {
    expect(parseJsonObject('{"prompt": "hair ornament \\(flower\\), 1girl"}')).toEqual({
      prompt: 'hair ornament \\(flower\\), 1girl',
    })
  })

  it('nothing, or no object, is null', () => {
    for (const text of ['', 'no braces', '[1, 2]', '{"unclosed": ', '{"a": 1', 'null'])
      expect(parseJsonObject(text), text).toBeNull()
  })
})

describe('tidying a prompt', () => {
  it('takes out LoRA tags, quality words and remarks about trigger words', () => {
    expect(
      cleanPrompt(
        'masterpiece, best quality, (absurdres:1.2), score_9, score_8_up, rating_safe, 1girl, <lora:x:1>, <lyco:y:0.5>, armor'
      )
    ).toBe('1girl, armor')
    // the remark runs to the end of the sentence, as in the legacy planner
    expect(cleanPrompt('1girl, armor, incorporating the trigger words foo, bar')).toBe(
      '1girl, armor'
    )
  })

  it('leaves a tag that only contains a quality word', () => {
    expect(cleanPrompt('1girl, best quality armor, high quality')).toBe('1girl, best quality armor')
  })
})

describe('ambiguous tags', () => {
  const table = { husky: ['husky', '哈士奇'] }
  it('are dropped unless the request asks for them', () => {
    expect(dropAmbiguous('1boy, husky, armor', '一个壮汉', table)).toBe('1boy, armor')
    expect(dropAmbiguous('1boy, Husky, armor', '画一只哈士奇', table)).toBe('1boy, Husky, armor')
    expect(dropAmbiguous('1boy, huskylike', 'x', table)).toBe('1boy, huskylike')
  })
})

describe('sizes', () => {
  const params = GenerationParams.parse({})
  it('a square is the model size, the other shapes keep the area, all in steps of 64', () => {
    expect(sizeFor(params, 'square')).toEqual([1024, 1024])
    const [pw, ph] = sizeFor(params, 'portrait')
    const [lw, lh] = sizeFor(params, 'landscape')
    expect([pw, ph]).toEqual([lh, lw])
    expect(pw).toBeLessThan(ph)
    for (const n of [pw, ph]) expect(n % 64).toBe(0)
    expect(Math.abs(pw * ph - 1024 * 1024) / (1024 * 1024)).toBeLessThan(0.1)
  })

  it('a named size wins', () => {
    const named = GenerationParams.parse({ sizes: { portrait: [832, 1216] } })
    expect(sizeFor(named, 'portrait')).toEqual([832, 1216])
  })

  it('an unknown orientation is a square', () => {
    expect(orientationOf('wide')).toBe('square')
    expect(orientationOf(undefined)).toBe('square')
    expect(orientationOf('landscape')).toBe('landscape')
  })
})

describe('the frame on the stage', () => {
  const texts: FrameTexts = {
    idle: 'send a request',
    generating: (u, r) => `drawing for ${u}: ${r}`,
    showing: (u) => `for ${u}`,
  }
  const rect = { left: 3, top: 12, width: 56, height: 78 }

  it('with the words on the frame: one message per state, each with the whole state of the overlay', () => {
    const v = { textOverlay: 'frame', rect: null } as const
    expect(frameMessages({ kind: 'idle' }, v, texts)).toEqual([
      { type: 'overlay.set', id: 'frame', visible: true, text: 'send a request' },
    ])
    expect(
      frameMessages({ kind: 'generating', user: 'ann', request: 'a dragon' }, v, texts)
    ).toEqual([
      { type: 'overlay.set', id: 'frame', visible: true, text: 'drawing for ann: a dragon' },
    ])
    expect(
      frameMessages(
        { kind: 'showing', user: 'ann', image: '/asset/generated/a.png', at: 1 },
        v,
        texts
      )
    ).toEqual([
      {
        type: 'overlay.set',
        id: 'frame',
        visible: true,
        text: 'for ann',
        image: '/asset/generated/a.png',
      },
    ])
    expect(frameMessages({ kind: 'hidden' }, v, texts)).toEqual([
      { type: 'overlay.set', id: 'frame', visible: false, text: '' },
    ])
  })

  it('the rectangle from the settings goes into every message; without it the layout of the pack decides', () => {
    const v = { textOverlay: 'frame', rect } as const
    for (const s of [{ kind: 'idle' }, { kind: 'hidden' }] as const)
      expect(frameMessages(s, v, texts)[0]).toMatchObject({ rect })
  })

  it('with the words on the banner: the frame carries the picture only and is hidden without one', () => {
    const v = { textOverlay: 'notice', rect: null } as const
    expect(frameMessages({ kind: 'idle' }, v, texts)).toEqual([
      { type: 'overlay.set', id: 'frame', visible: false },
      { type: 'overlay.set', id: 'notice', visible: true, text: 'send a request' },
    ])
    expect(
      frameMessages(
        { kind: 'showing', user: 'ann', image: '/asset/generated/a.png', at: 1 },
        v,
        texts
      )
    ).toEqual([
      { type: 'overlay.set', id: 'frame', visible: true, image: '/asset/generated/a.png' },
      { type: 'overlay.set', id: 'notice', visible: true, text: 'for ann' },
    ])
    expect(frameMessages({ kind: 'hidden' }, v, texts)).toEqual([
      { type: 'overlay.set', id: 'frame', visible: false },
      { type: 'overlay.set', id: 'notice', visible: false, text: '' },
    ])
  })
})

describe('the pictures on disk', () => {
  it('a picture is written whole under a name of numbers only, and a PNG is told from other bytes', async () => {
    const dir = path.join(await tmp(), 'generated')
    const name = await savePicture(dir, makePng(), 1_700_000_000_123, 4)
    expect(name).toBe('draw-1700000000123-4.png')
    expect(isPng(await readFile(path.join(dir, name)))).toBe(true)
    expect(await readdir(dir)).toEqual([name])
    expect(isPng(Buffer.from('GIF89a......'))).toBe(false)
    expect(isPng(Buffer.alloc(0))).toBe(false)
  })

  it('only the newest few are kept, ordered by time and then by number, and other files are left alone', async () => {
    const dir = await tmp()
    for (const [stamp, seq] of [
      [9, 1],
      [10, 1],
      [10, 2],
      [100, 1],
    ] as const)
      await savePicture(dir, makePng(), stamp, seq)
    await writeFile(path.join(dir, 'mine.png'), 'not ours')
    expect(await prunePictures(dir, 2)).toBe(2)
    expect((await readdir(dir)).sort()).toEqual(['draw-10-2.png', 'draw-100-1.png', 'mine.png'])
    expect(await prunePictures(dir, 5)).toBe(0)
  })

  it('a folder that is not there is nothing to prune', async () => {
    expect(await prunePictures(path.join(await tmp(), 'nope'), 3)).toBe(0)
  })
})

describe('the cooldown of a viewer', () => {
  const setup = async (over: { cooldownMs?: number } = {}) => {
    const dir = await tmp()
    const file = path.join(dir, 'draw-state.json')
    const clock = { now: 1_000_000 }
    const make = () =>
      new Cooldowns(
        file,
        () => over.cooldownMs ?? 60_000,
        () => clock.now,
        () => {}
      )
    return { file, clock, make }
  }

  it('viewers are told apart by user id, or by name when there is none', () => {
    expect(cooldownKey(1001, 'ann')).toBe('u1001')
    expect(cooldownKey(0, 'ann')).toBe('n:ann')
  })

  it('a viewer waits, another does not, and the time runs out', async () => {
    const { clock, make } = await setup()
    const c = make()
    await c.load()
    expect(c.left('u1')).toBe(0)
    c.start('u1')
    expect(c.left('u1')).toBe(60_000)
    expect(c.left('u2')).toBe(0)
    clock.now += 45_000
    expect(c.left('u1')).toBe(15_000)
    clock.now += 15_000
    expect(c.left('u1')).toBe(0)
  })

  it('a refund gives the turn back', async () => {
    const { make } = await setup()
    const c = make()
    await c.load()
    c.start('u1')
    c.refund('u1')
    expect(c.left('u1')).toBe(0)
  })

  it('it survives a restart, and a changed length applies to the ones already waiting', async () => {
    const { file, clock, make } = await setup()
    const first = make()
    await first.load()
    first.start('u1')
    await flushJson()
    clock.now += 20_000
    const second = make()
    await second.load()
    expect(second.left('u1')).toBe(40_000)
    const shorter = new Cooldowns(
      file,
      () => 10_000,
      () => clock.now,
      () => {}
    )
    await shorter.load()
    expect(shorter.left('u1')).toBe(0)
  })

  it('a file that is torn, or holds something else, or has nonsense in it, is ignored', async () => {
    for (const content of [
      '{oops',
      'null',
      '[1, 2]',
      '{"asked": "soon"}',
      '{"asked": {"u1": "yesterday", "u2": null, "u3": 1e999}}',
    ]) {
      const { file, make } = await setup()
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content)
      const c = make()
      await c.load()
      expect(c.left('u1'), content).toBe(0)
      c.start('u1')
      expect(c.left('u1'), content).toBe(60_000)
    }
  })

  it('entries that ran out are not kept in the file', async () => {
    const { file, clock, make } = await setup()
    const c = make()
    await c.load()
    c.start('old')
    clock.now += 61_000
    c.start('new')
    await flushJson()
    const saved = JSON.parse(await readFile(file, 'utf8')) as { asked: Record<string, number> }
    expect(Object.keys(saved.asked)).toEqual(['new'])
  })
})

describe('the fixed lines of the pack', () => {
  it('each line may start with an emotion tag; blank lines and the tag alone are skipped', () => {
    expect(parseLines('[angry]No.\n\n  [sad]Sorry.  \nplain\n[happy]\r\n')).toEqual([
      { text: 'No.', emotion: 'angry' },
      { text: 'Sorry.', emotion: 'sad' },
      { text: 'plain', emotion: 'neutral' },
    ])
  })

  it('a line is picked at random, and nothing to pick from is null', () => {
    const lines = parseLines('a\nb\nc')
    expect(pickLine(lines, () => 0)?.text).toBe('a')
    expect(pickLine(lines, () => 0.5)?.text).toBe('b')
    expect(pickLine(lines, () => 0.999999)?.text).toBe('c')
    expect(pickLine(lines, () => 1)?.text).toBe('c')
    expect(pickLine([])).toBeNull()
  })

  it('the shipped files hold lines for every case the controller has', async () => {
    const pack = path.resolve(__dirname, '../../../../modes/draw/prompts')
    for (const name of ['refusals.md', 'errors.md']) {
      const lines = parseLines(await readFile(path.join(pack, name), 'utf8'))
      expect(lines.length, name).toBeGreaterThanOrEqual(3)
      expect(lines.every((l) => l.text.length > 0)).toBe(true)
    }
  })
})
