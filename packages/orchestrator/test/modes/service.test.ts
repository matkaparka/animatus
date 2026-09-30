import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModeManifest, VerdictView, type VramMeasurement } from '@animatus/protocol'
import { AppError } from '../../src/app/errors.ts'
import { parseConfig } from '../../src/config.ts'
import type { AppConfigInput } from '../../src/config.ts'
import { hashConfig } from '../../src/modes/admission.ts'
import type { ModeControllerFull, ModeHost } from '../../src/modes/host.ts'
import type { LoadedMode } from '../../src/modes/loader.ts'
import { ModeService } from '../../src/modes/service.ts'
import type { ModeServiceDeps } from '../../src/modes/service.ts'
import { PluginRegistry } from '../../src/plugins/registry.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function plugins(
  defs: {
    id: string
    service: string
    gpu: boolean
    est: number | null
    keys?: string[]
    runtime?: 'external' | 'process'
  }[]
) {
  const root = await mkdtemp(path.join(tmpdir(), 'animatus-svc-'))
  dirs.push(root)
  for (const d of defs) {
    const dir = path.join(root, d.id)
    await mkdir(dir, { recursive: true })
    const runtime =
      d.runtime === 'process'
        ? "  type: process\n  env: node\n  command: ['{python}', 'x.js']\n  port: auto"
        : '  type: external\n  url: http://127.0.0.1:9'
    await writeFile(
      path.join(dir, 'plugin.yaml'),
      `id: ${d.id}\ntitle: ${d.id}\nkind: custom\nservice: ${d.service}\nruntime:\n${runtime}\nhealth:\n  http: { path: /health }\nresources:\n  gpu: ${d.gpu}\n  vram_mb_est: ${d.est}\n  config_keys: [${(d.keys ?? []).join(', ')}]\n`
    )
  }
  return PluginRegistry.scan(root)
}

const pack = (
  id: string,
  extra: Record<string, unknown> = {},
  prompts: Record<string, string> = {},
  active: string | null = null
): LoadedMode => ({
  manifest: ModeManifest.parse({ id, title: id, ...extra }),
  dir: '/nowhere',
  prompts: new Map(Object.entries(prompts)),
  activePrompt: active,
})

const measurement = (key: string, hash: string, peak: number): VramMeasurement => ({
  key,
  config_hash: hash,
  peak_mb: peak,
  steady_mb: peak,
  measured_at: 'test',
})

interface Rig {
  service: ModeService
  calls: string[]
  supervisor: {
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    getStatus: ReturnType<typeof vi.fn>
  }
  statuses: Record<string, { status: string; url?: string; lastError?: string }>
  pluginConfig: Record<string, Record<string, unknown>>
  measurements: VramMeasurement[]
  gpu: { used: number | null; total: number | null }
}

async function rig(opts: {
  modes: { pack: LoadedMode; controller?: Partial<ModeControllerFull> | false; enabled?: boolean }[]
  plugins?: Parameters<typeof plugins>[0]
  config?: AppConfigInput
  measurements?: VramMeasurement[]
  resident?: string[]
  pluginConfig?: Record<string, Record<string, unknown>>
}): Promise<Rig> {
  const registry = await plugins(opts.plugins ?? [])
  const calls: string[] = []
  const modesCfg = Object.fromEntries(
    opts.modes.map((m) => [m.pack.manifest.id, { enabled: m.enabled ?? true }])
  )
  const pluginsCfg = Object.fromEntries(
    (opts.plugins ?? []).map((p) => [
      p.id,
      { enabled: true, config: opts.pluginConfig?.[p.id] ?? {} },
    ])
  )
  const config = parseConfig(
    {
      modes: modesCfg,
      plugins: pluginsCfg,
      vram: { budget_mb: 12000, margin_mb: 512, resident: opts.resident ?? [] },
      ...opts.config,
    },
    { root: '/x' }
  )
  const statuses: Rig['statuses'] = {}
  const supervisor = {
    start: vi.fn(async (id: string) => {
      calls.push(`start ${id}`)
      statuses[id] = {
        ...statuses[id],
        status: statuses[id]?.status === 'failed' ? 'failed' : 'ready',
        url: `http://x/${id}`,
      }
      return statuses[id]
    }),
    stop: vi.fn(async (id: string) => {
      calls.push(`stop ${id}`)
      statuses[id] = { status: 'stopped' }
      return statuses[id]
    }),
    getStatus: vi.fn((id: string) => statuses[id] ?? { status: 'stopped' }),
  }
  const host = { log: () => {}, now: () => 1 } as unknown as ModeHost
  const controllers: Record<string, () => ModeControllerFull> = {}
  for (const m of opts.modes) {
    if (m.controller === false) continue
    controllers[m.pack.manifest.id] = () => ({
      async enter() {
        calls.push(`enter ${m.pack.manifest.id}`)
      },
      async exit(_c, reason) {
        calls.push(`exit ${m.pack.manifest.id} (${reason})`)
      },
      ...m.controller,
    })
  }
  const r: Rig = {
    service: undefined as unknown as ModeService,
    calls,
    supervisor,
    statuses,
    pluginConfig: opts.pluginConfig ?? {},
    measurements: opts.measurements ?? [],
    gpu: { used: null, total: 12000 },
  }
  r.service = new ModeService({
    config,
    packs: opts.modes.map((m) => m.pack),
    registry,
    supervisor: supervisor as unknown as ModeServiceDeps['supervisor'],
    pluginConfig: (id) => (r.pluginConfig[id] ?? {}) as Record<string, unknown>,
    host,
    controllers,
    gpu: { usedMb: () => r.gpu.used, totalMb: () => r.gpu.total },
    measurements: () => r.measurements,
    resident: opts.resident ?? [],
    startTimeoutMs: 2000,
    stopTimeoutMs: 2000,
    settleTimeoutMs: 50,
  })
  return r
}

const failure = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    return e as AppError
  }
  throw new Error('expected an AppError')
}

describe('views', () => {
  it('lists every pack, says why a disabled one cannot be entered, and reports the admission of an enabled one', async () => {
    const r = await rig({
      modes: [
        {
          pack: pack('dance', {
            requires: { services: [], vram_mb_est: 0 },
            priority: 60,
            triggers: { hotkey: 'ctrl+alt+d' },
          }),
        },
        { pack: pack('sleep'), enabled: false },
        { pack: pack('karaoke'), controller: false },
      ],
    })
    const views = r.service.views()
    expect(views.map((v) => v.id)).toEqual(['dance', 'karaoke', 'sleep'])
    const dance = views.find((v) => v.id === 'dance')!
    expect(dance).toMatchObject({ state: 'IDLE', priority: 60, hotkey: 'ctrl+alt+d' })
    expect(VerdictView.parse(dance.admission).ok).toBe(true)
    const sleep = views.find((v) => v.id === 'sleep')!
    expect(sleep.admission?.ok).toBe(false)
    expect(sleep.admission?.reasons[0]).toContain(
      'switched off in the configuration (modes.sleep.enabled)'
    )
    expect(views.find((v) => v.id === 'karaoke')!.admission?.reasons[0]).toContain(
      'no code for the mode'
    )
  })

  it('changing a setting that costs memory changes the verdict at once, without a restart', async () => {
    const r = await rig({
      plugins: [
        { id: 'gsv', service: 'tts', gpu: true, est: 3000, keys: ['weights'] },
        { id: 'forgesvc', service: 'forge', gpu: true, est: 9000, keys: ['max_long_side'] },
      ],
      modes: [{ pack: pack('draw', { requires: { services: ['tts', 'forge'] } }) }],
      resident: ['tts'],
      pluginConfig: { gsv: { weights: 'v2pro' }, forgesvc: { max_long_side: 1024 } },
      measurements: [
        measurement('tts', hashConfig({ weights: 'v2pro' }, ['weights']), 2760),
        measurement('forge', hashConfig({ max_long_side: 1024 }, ['max_long_side']), 7280),
      ],
    })
    let v = r.service.views()[0]!
    expect(v.admission).toMatchObject({ ok: true, measured: true, totalMb: 2760 + 7280 })

    // the operator lowers the size: nothing was measured at 896, so the estimate applies (and does not fit)
    r.pluginConfig.forgesvc = { max_long_side: 896 }
    v = r.service.views()[0]!
    expect(v.admission?.measured).toBe(false)
    expect(v.admission?.ok).toBe(false)
    expect(v.admission?.reasons.join(' ')).toContain('not measured')

    // a measurement at the new size arrives (the probe wrote it) and the verdict follows it
    r.measurements = [
      ...r.measurements,
      measurement('forge', hashConfig({ max_long_side: 896 }, ['max_long_side']), 6900),
    ]
    v = r.service.views()[0]!
    expect(v.admission).toMatchObject({ ok: true, measured: true, totalMb: 2760 + 6900 })
  })

  it('shows which other modes cannot run together with this one because of memory', async () => {
    const r = await rig({
      plugins: [
        { id: 'a', service: 'forge', gpu: true, est: 7000 },
        { id: 'b', service: 'llm', gpu: true, est: 6000 },
      ],
      modes: [
        { pack: pack('draw', { requires: { services: ['forge'] } }) },
        { pack: pack('game', { requires: { services: ['llm'] } }) },
      ],
    })
    const [draw, game] = r.service.views()
    expect(draw!.admission?.ok).toBe(true)
    expect(game!.admission?.ok).toBe(true)
    expect(Object.keys(draw!.pairs)).toEqual(['game'])
    expect(draw!.pairs.game!.ok).toBe(false)
    expect(draw!.pairs.game!.reasons[0]).toContain('needed')
  })
})

describe('entering and leaving', () => {
  it('starts the services a mode needs, runs its controller, and releases only what it started itself', async () => {
    const r = await rig({
      plugins: [
        { id: 'own', service: 'motion', gpu: false, est: 0, runtime: 'process' },
        { id: 'theirs', service: 'forge', gpu: false, est: 0, runtime: 'external' },
      ],
      modes: [{ pack: pack('draw', { requires: { services: ['motion', 'forge'] } }) }],
    })
    r.statuses.theirs = { status: 'ready', url: 'http://theirs' }
    const view = await r.service.enter('draw')
    expect(view.state).toBe('ACTIVE')
    expect(r.calls).toEqual(['start own', 'enter draw'])
    await r.service.exit('draw', 'test')
    expect(r.calls).toEqual(['start own', 'enter draw', 'exit draw (test)', 'stop own'])
  })

  it('refuses in words the operator can read, with the right status', async () => {
    const r = await rig({
      modes: [
        { pack: pack('a', { exclusive_with: ['b'] }) },
        { pack: pack('b') },
        { pack: pack('needs', { requires: { services: ['ghost'] } }) },
        { pack: pack('off'), enabled: false },
      ],
    })
    expect((await failure(r.service.enter('nope'))).httpStatus).toBe(404)
    const off = await failure(r.service.enter('off'))
    expect([off.code, off.httpStatus]).toEqual(['not_enabled', 409])
    await r.service.enter('a')
    const ex = await failure(r.service.enter('b'))
    expect([ex.code, ex.httpStatus]).toEqual(['excluded', 409])
    expect(ex.message).toContain('excludes')
    expect((await r.service.enter('b', { replace: true })).state).toBe('ACTIVE')
    expect(r.service.state('a')).toBe('IDLE')
    const missing = await failure(r.service.enter('needs'))
    expect(missing.message).toContain('the "ghost" service is not set up')
    expect(r.service.state('needs')).toBe('IDLE')
  })

  it('a service that does not become ready fails the entry and says which', async () => {
    const r = await rig({
      plugins: [{ id: 'own', service: 'motion', gpu: false, est: 0, runtime: 'process' }],
      modes: [{ pack: pack('m', { requires: { services: ['motion'] } }) }],
    })
    r.statuses.own = { status: 'failed', lastError: 'port in use' }
    const e = await failure(r.service.enter('m'))
    expect(e.message).toContain('did not become ready')
    expect(e.message).toContain('port in use')
    expect(r.calls).not.toContain('enter m')
  })

  it('does not fit: the refusal carries the memory reasoning', async () => {
    const r = await rig({
      plugins: [{ id: 'big', service: 'forge', gpu: true, est: 20000 }],
      modes: [{ pack: pack('draw', { requires: { services: ['forge'] } }) }],
    })
    const e = await failure(r.service.enter('draw'))
    expect([e.code, e.httpStatus]).toEqual(['no_fit', 409])
    expect(e.message).toContain('needed')
    expect((await r.service.tryEnter('draw')).ok).toBe(false)
    expect(await r.service.tryEnter('draw', { force: true })).toEqual({ ok: true })
  })

  it('emits a change for every state and an alarm when a mode fails to start', async () => {
    const r = await rig({
      modes: [
        { pack: pack('bad'), controller: { enter: async () => Promise.reject(new Error('boom')) } },
      ],
    })
    const changes: string[] = []
    const alarms: string[] = []
    r.service.on('change', (id) => changes.push(`${id}:${r.service.state(id)}`))
    r.service.on('alarm', (code, message) => alarms.push(`${code}: ${message}`))
    await failure(r.service.enter('bad'))
    expect(changes).toEqual(['bad:STARTING', 'bad:STOPPING', 'bad:IDLE'])
    expect(alarms[0]).toContain('mode_start_failed')
  })
})

describe('panels', () => {
  it('shows what the controller gives, with the defaults filled in, and nothing for a mode that gives none', async () => {
    const r = await rig({
      modes: [
        {
          pack: pack('a'),
          controller: {
            panel: () => ({
              status: 'ready',
              actions: [{ id: 'stop', label: 'Stop' }],
              sections: [{ title: 'Songs', rows: [{ id: '1', text: 'one' }] }],
            }),
          },
        },
        { pack: pack('b'), controller: {} },
        { pack: pack('c'), enabled: false },
      ],
    })
    const [a, b, c] = r.service.views()
    expect(a!.panel).toMatchObject({
      status: 'ready',
      facts: [],
      actions: [{ id: 'stop', inputs: [] }],
    })
    expect(a!.panel!.sections[0]!.rows[0]).toMatchObject({ id: '1', active: false, actions: [] })
    expect(b!.panel).toBeUndefined()
    expect(c!.panel).toBeUndefined()
  })

  it('a controller whose panel is nonsense or throws shows no panel, and the views still come', async () => {
    const r = await rig({
      modes: [
        {
          pack: pack('a'),
          controller: { panel: () => ({ actions: [{ id: 'Not An Id', label: 'x' }] }) as never },
        },
        {
          pack: pack('b'),
          controller: {
            panel: () => {
              throw new Error('panel broke')
            },
          },
        },
        { pack: pack('c'), controller: { panel: () => null } },
      ],
    })
    const views = r.service.views()
    expect(views.map((v) => v.panel)).toEqual([undefined, undefined, undefined])
    expect(views).toHaveLength(3)
  })
})

describe('prompts and hooks', () => {
  it('sends the active prompt of a running mode, and the advertisement of an idle one with its variables filled in', async () => {
    const r = await rig({
      modes: [
        {
          pack: pack(
            'dance',
            {},
            { available: 'You may dance: {{dances}}.', cooldown: 'Wait {{minutes}} minutes.' },
            null
          ),
          controller: {
            advertise: () => ({ prompt: 'available', vars: { dances: 'aipao, otagei' } }),
          },
        },
        { pack: pack('sleep', {}, {}, 'Speak softly.'), controller: {} },
        { pack: pack('quiet'), controller: { advertise: () => null } },
      ],
    })
    expect(r.service.prompts()).toEqual([
      { id: 'dance:available', text: 'You may dance: aipao, otagei.' },
    ])
    await r.service.enter('sleep')
    expect(r.service.prompts()).toEqual([
      { id: 'sleep', text: 'Speak softly.' },
      { id: 'dance:available', text: 'You may dance: aipao, otagei.' },
    ])
    await r.service.enter('dance')
    // a running mode no longer advertises itself; its own active prompt (none here) takes over
    expect(r.service.prompts().map((p) => p.id)).toEqual(['sleep'])
  })

  it('an advertisement that names a missing prompt file or throws is left out, not fatal', async () => {
    const r = await rig({
      modes: [
        { pack: pack('a'), controller: { advertise: () => ({ prompt: 'nothing-here' }) } },
        {
          pack: pack('b'),
          controller: {
            advertise: () => {
              throw new Error('nope')
            },
          },
        },
      ],
    })
    expect(r.service.prompts()).toEqual([])
  })

  it('lets every controller look at a batch first, isolating the one that fails', async () => {
    const r = await rig({
      modes: [
        { pack: pack('a'), controller: { onBatch: async () => ['line from a'] } },
        {
          pack: pack('b'),
          controller: {
            onBatch: () => {
              throw new Error('b broke')
            },
          },
        },
        { pack: pack('c'), controller: { onBatch: () => ['line from c'] } },
        { pack: pack('d'), controller: {} },
      ],
    })
    const lines = await r.service.batchExtras({ text: 'x', parts: [] })
    expect(lines.sort()).toEqual(['line from a', 'line from c'])
  })

  it('routes a request from the model and a request from the console, falling back to a plain entry', async () => {
    const asked: unknown[] = []
    const r = await rig({
      modes: [
        {
          pack: pack('dance'),
          controller: {
            onModelRequest: (q) => void asked.push(q),
            onConsoleRequest: async (q) => (asked.push(q), { ok: true }),
          },
        },
        { pack: pack('plain') },
      ],
    })
    await r.service.modelRequest('dance', { name: 'aipao' })
    await r.service.modelRequest('nothing', {})
    expect(await r.service.consoleRequest('dance', { action: 'play' })).toEqual({ ok: true })
    expect(asked).toEqual([{ name: 'aipao' }, { action: 'play' }])
    expect(await r.service.consoleRequest('plain', {})).toEqual({ ok: true })
    expect(r.service.state('plain')).toBe('ACTIVE')
  })

  it('a plain console entry keeps what the operator chose: replace and force', async () => {
    const r = await rig({
      modes: [{ pack: pack('a', { exclusive_with: ['b'] }) }, { pack: pack('b') }],
    })
    await r.service.enter('a')
    expect(await r.service.consoleRequest('b', {})).toMatchObject({ ok: false })
    expect(r.service.state('a')).toBe('ACTIVE')
    expect(await r.service.consoleRequest('b', { replace: true })).toEqual({ ok: true })
    expect(r.service.state('a')).toBe('IDLE')
    expect(r.service.state('b')).toBe('ACTIVE')
  })

  it('a chat command goes to an ACTIVE mode that declares the word, the longest word first, and only when the mode takes it', async () => {
    const seen: string[] = []
    const r = await rig({
      modes: [
        {
          pack: pack('draw', { triggers: { danmaku_prefix: ['画', '/画'] } }),
          controller: {
            onChatCommand: (c) => (
              seen.push(`draw:${c.prefix}|${c.argument}`),
              c.argument !== 'no'
            ),
          },
        },
        {
          pack: pack('other', { triggers: { danmaku_prefix: ['画龙'] } }),
          controller: {
            onChatCommand: (c) => (seen.push(`other:${c.prefix}|${c.argument}`), false),
          },
        },
        { pack: pack('plain'), controller: {} },
      ],
    })
    const cmd = (text: string) =>
      r.service.chatCommand({ uid: 1, uname: 'ann', text, admin: false, owner: false })
    expect(cmd('画 一条龙')).toBe(false) // nothing is active: it stays chat
    await r.service.enter('draw')
    expect(cmd('画 一条龙')).toBe(true)
    expect(cmd('/画   一条龙  ')).toBe(true)
    expect(cmd('画 no')).toBe(false) // the mode declined it
    expect(cmd('hello')).toBe(false)
    expect(seen).toEqual(['draw:画|一条龙', 'draw:/画|一条龙', 'draw:画|no'])
    await r.service.enter('other')
    seen.length = 0
    expect(cmd('画龙 x')).toBe(true) // the longer word is asked first (it declines), then the shorter word's mode takes it
    expect(seen).toEqual(['other:画龙|x', 'draw:画|龙 x'])
  })

  it('a chat command handler that throws is logged and the message stays chat', async () => {
    const r = await rig({
      modes: [
        {
          pack: pack('draw', { triggers: { danmaku_prefix: ['画'] } }),
          controller: {
            onChatCommand: () => {
              throw new Error('broke')
            },
          },
        },
      ],
    })
    await r.service.enter('draw')
    expect(
      r.service.chatCommand({ uid: 1, uname: 'a', text: '画 x', admin: false, owner: false })
    ).toBe(false)
  })

  it('renders a pack prompt on request', async () => {
    const r = await rig({
      modes: [{ pack: pack('dance', {}, { outro: 'Finished "{{title}}"{{who}}.' }) }],
    })
    expect(r.service.prompt('dance', 'outro', { title: 'Aipao', who: ' (by Ann)' })).toBe(
      'Finished "Aipao" (by Ann).'
    )
    expect(r.service.prompt('dance', 'missing')).toBeNull()
    expect(r.service.prompt('nothing', 'outro')).toBeNull()
  })

  it('serviceUrl answers only for a ready plugin that is enabled', async () => {
    const r = await rig({
      plugins: [{ id: 'own', service: 'motion', gpu: false, est: 0 }],
      modes: [],
    })
    expect(r.service.serviceUrl('motion')).toBeNull()
    r.statuses.own = { status: 'ready', url: 'http://own' }
    expect(r.service.serviceUrl('motion')).toBe('http://own')
    expect(r.service.serviceUrl('nothing')).toBeNull()
  })
})
