import { ModeManifest } from '@animatus/protocol'
import { describe, expect, it } from 'vitest'
import type { Matrix, Verdict } from '../../src/modes/admission.ts'
import { ModeManager, type ModeController, type ModeManagerDeps } from '../../src/modes/manager.ts'

const mode = (id: string, extra: Record<string, unknown> = {}, services: string[] = []) =>
  ModeManifest.parse({ id, title: id, requires: { services }, ...extra })

const ok: Verdict = { ok: true, totalMb: 0, budgetMb: 12000, measured: true, reasons: [] }
const bad = (msg: string): Verdict => ({
  ok: false,
  totalMb: 13000,
  budgetMb: 12000,
  measured: false,
  reasons: [msg],
})

const matrix = (
  alone: Record<string, Verdict> = {},
  pairs: Record<string, Record<string, Verdict>> = {}
): Matrix => ({
  resident: { mb: 0, measured: true, parts: [] },
  alone,
  pairs,
})

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function setup(
  manifests: ModeManifest[],
  over: Partial<ModeManagerDeps> = {},
  mx: Matrix = matrix()
) {
  const log: string[] = []
  const controllers: Record<string, ModeController> = {}
  for (const m of manifests) {
    controllers[m.id] = {
      enter: async () => void log.push(`enter:${m.id}`),
      exit: async (_c, reason) => void log.push(`exit:${m.id}:${reason}`),
    }
  }
  const marks: string[] = []
  const deps: ModeManagerDeps = {
    manifests,
    controllers,
    resident: ['tts'],
    ensureServices: async (n) => void log.push(`ensure:${n.join(',')}`),
    releaseServices: async (n) => void log.push(`release:${n.join(',')}`),
    matrix: () => mx,
    mark: (l) => marks.push(l),
    startTimeoutMs: 200,
    stopTimeoutMs: 200,
    settleTimeoutMs: 100,
    ...over,
  }
  const mm = new ModeManager(deps)
  const states: string[] = []
  const alarms: string[] = []
  mm.on('state', (id, s) => states.push(`${id}:${s}`))
  mm.on('alarm', (code) => alarms.push(code))
  return { mm, log, marks, states, alarms, controllers }
}

describe('ModeManager: lifecycle', () => {
  it('IDLE -> STARTING -> ACTIVE -> STOPPING -> IDLE, with services and probe marks', async () => {
    const { mm, log, marks, states } = setup([mode('draw', {}, ['tts', 'forge'])])
    expect(await mm.enter('draw')).toEqual({ ok: true })
    expect(mm.state('draw')).toBe('ACTIVE')
    expect(mm.active()).toEqual(['draw'])
    await mm.exit('draw', 'user')
    expect(mm.state('draw')).toBe('IDLE')
    expect(states).toEqual(['draw:STARTING', 'draw:ACTIVE', 'draw:STOPPING', 'draw:IDLE'])
    expect(log).toEqual(['ensure:tts,forge', 'enter:draw', 'exit:draw:user', 'release:forge']) // resident tts is never released
    expect(marks).toEqual(['enter:draw', 'exit:draw'])
  })

  it('entering an active mode is idempotent; exiting an idle one is a no-op', async () => {
    const { mm, log } = setup([mode('a')])
    await mm.enter('a')
    expect(await mm.enter('a')).toEqual({ ok: true, already: true })
    await mm.exit('a')
    await mm.exit('a')
    expect(log.filter((l) => l.startsWith('enter:')).length).toBe(1)
    expect(log.filter((l) => l.startsWith('exit:')).length).toBe(1)
  })

  it('unknown mode and missing controller are refused', async () => {
    const { mm } = setup([mode('a')], { controllers: {} })
    expect(await mm.enter('nope')).toMatchObject({ ok: false, code: 'unknown_mode' })
    expect(await mm.enter('a')).toMatchObject({ ok: false, code: 'no_controller' })
  })

  it('a service shared with another active mode is not released', async () => {
    const { mm, log } = setup([mode('a', {}, ['forge']), mode('b', {}, ['forge'])])
    await mm.enter('a')
    await mm.enter('b')
    await mm.exit('a')
    expect(log.filter((l) => l.startsWith('release:'))).toEqual([])
    await mm.exit('b')
    expect(log.filter((l) => l.startsWith('release:'))).toEqual(['release:forge'])
  })
})

describe('ModeManager: rules', () => {
  it('refuses a mode that excludes an active one; replace switches; the exclusion is symmetric', async () => {
    const { mm, log } = setup([mode('draw'), mode('sing', { exclusive_with: ['draw'] })])
    await mm.enter('draw')
    expect(await mm.enter('sing')).toMatchObject({
      ok: false,
      code: 'excluded',
      conflicts: ['draw'],
    })
    expect(mm.state('draw')).toBe('ACTIVE')
    const r = await mm.enter('sing', { replace: true })
    expect(r).toEqual({ ok: true })
    expect(mm.state('draw')).toBe('IDLE')
    expect(log).toContain('exit:draw:replaced by sing')
    expect(await mm.enter('draw')).toMatchObject({ ok: false, code: 'excluded' }) // draw did not list sing, sing lists draw
  })

  it('a preempting mode interrupts everything, and blocks other modes while it is active', async () => {
    const { mm, log } = setup([
      mode('draw'),
      mode('game'),
      mode('sleep', { preempts: true, priority: 100 }),
    ])
    await mm.enter('draw')
    await mm.enter('game')
    expect(await mm.enter('sleep')).toEqual({ ok: true })
    expect(mm.active()).toEqual(['sleep'])
    expect(log).toContain('exit:draw:preempted by sleep')
    expect(log).toContain('exit:game:preempted by sleep')
    expect(await mm.enter('draw')).toMatchObject({ ok: false, code: 'blocked', blockedBy: 'sleep' })
    expect(await mm.enter('draw', { force: true })).toEqual({ ok: true })
    await mm.exit('sleep')
    expect(await mm.enter('game')).toEqual({ ok: true })
  })

  it('admission: refuses when the mode alone does not fit, or a pair with an active mode does not', async () => {
    const mx = matrix(
      { big: bad('big alone: too large') },
      { game: { draw: bad('game + draw: 14 GB') }, draw: { game: bad('game + draw: 14 GB') } }
    )
    const { mm } = setup([mode('big'), mode('draw'), mode('game')], {}, mx)
    expect(await mm.enter('big')).toMatchObject({
      ok: false,
      code: 'no_fit',
      reasons: ['big alone: too large'],
    })
    await mm.enter('draw')
    expect(await mm.enter('game')).toMatchObject({
      ok: false,
      code: 'no_fit',
      reasons: ['game + draw: 14 GB'],
    })
    expect(await mm.enter('game', { force: true })).toEqual({ ok: true })
  })

  it('the matrix is read at entry, so a settings change takes effect without a restart', async () => {
    let mx = matrix({ draw: bad('too big at 1024') })
    const { mm } = setup([mode('draw')], { matrix: () => mx })
    expect(await mm.enter('draw')).toMatchObject({ ok: false, code: 'no_fit' })
    mx = matrix({ draw: ok }) // the operator lowered the image size
    expect(await mm.enter('draw')).toEqual({ ok: true })
  })

  it('serialises concurrent requests', async () => {
    const order: string[] = []
    const { mm, controllers } = setup([mode('a'), mode('b')])
    controllers.a = {
      enter: async () => {
        order.push('a:start')
        await sleep(30)
        order.push('a:end')
      },
      exit: async () => {},
    }
    controllers.b = {
      enter: async () => {
        order.push('b:start')
        order.push('b:end')
      },
      exit: async () => {},
    }
    await Promise.all([mm.enter('a'), mm.enter('b')])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })
})

describe('ModeManager: failures and timeouts', () => {
  it('a failing service start leaves the mode IDLE with an alarm and releases what it started', async () => {
    const { mm, log, alarms, states } = setup([mode('draw', {}, ['forge'])], {
      ensureServices: async () => {
        throw new Error('forge did not become ready')
      },
    })
    const r = await mm.enter('draw')
    expect(r).toMatchObject({ ok: false, code: 'failed', reason: 'forge did not become ready' })
    expect(mm.state('draw')).toBe('IDLE')
    expect(alarms).toEqual(['mode_start_failed'])
    expect(log).toContain('release:forge')
    expect(states).toEqual(['draw:STARTING', 'draw:STOPPING', 'draw:IDLE'])
  })

  it('a start that hangs times out, aborts the controller and returns to IDLE', async () => {
    let aborted = false
    const { mm, alarms, controllers } = setup([mode('a')], { startTimeoutMs: 40 })
    controllers.a = {
      enter: (ctx) =>
        new Promise<void>(() => {
          ctx.signal.addEventListener('abort', () => (aborted = true))
        }),
      exit: async () => {},
    }
    const r = await mm.enter('a')
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    expect((r as { reason: string }).reason).toContain('timed out')
    expect(aborted).toBe(true)
    expect(mm.state('a')).toBe('IDLE')
    expect(alarms).toEqual(['mode_start_failed'])
  })

  it('a stop that hangs still ends in IDLE, with an alarm', async () => {
    const { mm, alarms, controllers } = setup([mode('a')], { stopTimeoutMs: 40 })
    await mm.enter('a')
    controllers.a = { enter: async () => {}, exit: () => new Promise<void>(() => {}) }
    await mm.exit('a')
    expect(mm.state('a')).toBe('IDLE')
    expect(alarms).toEqual(['mode_stop_failed'])
  })

  it('waits for GPU memory to fall back after leaving, and alarms if it does not', async () => {
    let vram = 3000
    const { mm, alarms } = setup([mode('draw')], { vramNow: () => vram, settleTimeoutMs: 120 })
    await mm.enter('draw')
    vram = 10000 // the mode loaded a lot
    const leaving = mm.exit('draw')
    setTimeout(() => (vram = 3100), 60) // released shortly after
    await leaving
    expect(alarms).toEqual([])

    await mm.enter('draw')
    vram = 10000
    await mm.exit('draw') // never released
    expect(alarms).toEqual(['vram_not_released'])
  })

  it('exitAll leaves every active mode', async () => {
    const { mm } = setup([mode('a'), mode('b')])
    await mm.enter('a')
    await mm.enter('b')
    await mm.exitAll()
    expect(mm.active()).toEqual([])
  })
})
