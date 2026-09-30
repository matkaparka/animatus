/**
 * The game mode inside the real mode service, talking to the reference fake of the Worker protocol over a real socket:
 * what entering and leaving do and leave behind, what happens when the agent is the wrong one, gone, slow or answers
 * nonsense at the start, the plugin's part, the modes it excludes, and shutdown in the middle of every phase.
 * Sockets need real time (see gameRig.ts): the loops' waits are made shorter and a test waits with `until`.
 */
import { describe, expect, it } from 'vitest'
import { gameRig, pause, until, useGameRig } from './gameRig.ts'
import type { Rig } from './gameRig.ts'

useGameRig({ fakeTimers: false })

const eventReads = (r: Rig) => r.http!.s.requests.filter((q) => q.includes('/worker/events')).length
const allRequests = (r: Rig) => r.http!.s.requests.length

/** The alarms the mode manager raises on its own account (a start that failed), which the host never sees. */
function managerAlarms(r: Rig) {
  const seen: { code: string; message: string; id?: string }[] = []
  r.service.on('alarm', (code, message, id) => seen.push({ code, message, ...(id ? { id } : {}) }))
  return seen
}

/** What a mode that ended must have left: nothing held, no flag, no voice style, no stage change, no tool, no alarm. */
function expectNothingLeft(r: Rig) {
  expect(r.f.tools).toEqual([])
  expect(r.f.alarms).toEqual([])
  expect(r.f.held).toEqual([])
  expect(r.f.voiceStyles).toEqual([])
  expect(r.f.stopped).toEqual([])
  expect(r.f.said).toEqual([])
  expect(r.f.flags).toEqual({ dancing: false, singing: false, sleeping: false })
  expect(r.f.hub.sent).toEqual([])
  expect(r.f.hub.looks).toEqual([])
  expect(r.f.hub.overlays).toEqual([])
  expect(r.f.hub.scenes).toEqual([])
}

describe('entering', () => {
  it('reads the agent, resumes it, registers the tool and starts polling', async () => {
    const r = await gameRig()
    expect(r.http!.s.paused).toBe(true) // a worker starts paused
    await r.enter()
    expect(r.service.state('game')).toBe('ACTIVE')
    expect(r.http!.s.paused).toBe(false)
    expect(r.f.tools.map((t) => t.name)).toEqual(['game_command'])
    expect(r.ctl.status()).toMatchObject({ running: true, phase: 'running', online: true })
    const first = r.http!.s.requests[0]
    expect(first).toBe('GET /worker/state')
    await until(() => eventReads(r) >= 3, 5000, 'the polls')
    expect(r.f.events[0]).toBe('game mode on (fakegame, worker protocol)')
    expect(r.alarms()).toEqual([])
  })

  it('what happened before it started is not news, and what happens after is', async () => {
    const r = await gameRig()
    r.push('death', 'you died long ago', 'immediate')
    r.push('turn', 'an old turn', 'soon')
    await r.enter()
    await until(() => eventReads(r) >= 4, 5000, 'a few polls')
    await pause(50)
    expect(r.f.told).toEqual([])
    r.push('fight', 'a new fight', 'immediate')
    await until(() => r.f.told.length === 1, 5000, 'a comment on the new event')
    expect(r.f.told[0]!.text).toContain('a new fight')
    expect(r.f.told[0]!.text).not.toContain('long ago')
    expect(r.f.told[0]!.text).not.toContain('an old turn')
  })

  it('takes the name of the game from the agent, or from the settings when they say so', async () => {
    const r = await gameRig({ workerOver: { worker: 'civ6' } })
    await r.enter()
    expect(r.f.events[0]).toContain('(civ6,')
    expect(r.prompt()).toContain('You are playing civ6 on stream')
    const titled = await gameRig({ settings: { title: 'Civilization VI' } })
    await titled.enter()
    expect(titled.prompt()).toContain('You are playing Civilization VI on stream')
  })

  it('a second entry while it is on is the same run: nothing is started twice', async () => {
    const r = await gameRig()
    await Promise.all([r.enter(), r.enter()])
    expect(r.service.state('game')).toBe('ACTIVE')
    expect(r.f.tools).toHaveLength(1)
    expect(r.f.events.filter((e) => e.startsWith('game mode on'))).toHaveLength(1)
  })

  it('can be entered again after it was left, and starts from the agent as it is then', async () => {
    const r = await gameRig()
    await r.enter()
    await r.exit()
    r.push('death', 'died while the mode was off', 'immediate')
    await r.enter()
    await until(() => eventReads(r) >= 3, 5000, 'polls of the second run')
    await pause(50)
    expect(r.f.told).toEqual([])
    expect(r.http!.s.paused).toBe(false)
    expect(r.f.tools).toHaveLength(1)
  })
})

describe('leaving', () => {
  it('pauses the agent, takes the tool away, clears every alarm, and leaves nothing else behind', async () => {
    const r = await gameRig()
    await r.enter()
    r.http!.s.misbehave.status = 503
    await until(() => r.alarms().includes('game_worker'), 5000, 'the alarm')
    delete r.http!.s.misbehave.status
    await until(() => r.alarms().length === 0, 5000, 'the alarm to go')
    r.f.brain.failTell = true
    r.push('death', 'dead', 'immediate')
    await until(() => r.alarms().includes('game_model'), 5000, 'the model alarm')
    await r.exit()
    expect(r.service.state('game')).toBe('IDLE')
    expect(r.http!.s.paused).toBe(true)
    expectNothingLeft(r)
    expect(r.ctl.status()).toMatchObject({ running: false, phase: 'off' })
    expect(r.f.events.at(-1)).toBe('game mode over (console)')
  })

  it('stops asking: nothing reaches the agent after the exit', async () => {
    const r = await gameRig()
    await r.enter()
    await until(() => eventReads(r) >= 2, 5000, 'polls')
    await r.exit()
    const seen = allRequests(r)
    await pause(150)
    expect(allRequests(r)).toBe(seen)
  })

  it('leaves the agent playing when pause_on_exit is off', async () => {
    const r = await gameRig({ settings: { pause_on_exit: false } })
    await r.enter()
    await r.exit()
    expect(r.http!.s.paused).toBe(false)
    expect(r.http!.s.requests.some((q) => q.includes('/worker/pause'))).toBe(true) // only the resume at the start
    expectNothingLeft(r)
  })

  it('a worker that is gone does not hold the exit, and the run log says the agent may keep playing', async () => {
    const r = await gameRig()
    await r.enter()
    r.http!.s.misbehave.hang = true
    const t0 = Date.now()
    await r.exit()
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.service.state('game')).toBe('IDLE')
    expect(r.f.events.some((e) => e.includes('could not be paused'))).toBe(true)
    expectNothingLeft(r)
  })

  it('a worker that is closed does not hold it either', async () => {
    const r = await gameRig()
    await r.enter()
    await r.http!.close()
    await r.exit()
    expect(r.service.state('game')).toBe('IDLE')
    expectNothingLeft(r)
  })

  it('writes nothing to disk: there is nothing to restore after a restart of the program', async () => {
    const r = await gameRig()
    await r.enter()
    r.push('death', 'x', 'immediate')
    await until(() => r.f.told.length === 1, 5000, 'a comment')
    await r.exit()
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(r.f.dataDir).catch(() => [] as string[])
    expect(files.filter((f) => f.toLowerCase().includes('game'))).toEqual([])
  })
})

describe('a start that cannot happen', () => {
  it('the wrong worker: refused with the setting named, the agent never resumed, nothing registered', async () => {
    const r = await gameRig({ settings: { name: 'civ6' } })
    const alarms = managerAlarms(r)
    await expect(r.enter()).rejects.toThrow(
      /modes\.game\.config\.name asks for: this is the worker "fakegame", not "civ6"/
    )
    expect(r.service.state('game')).toBe('IDLE')
    expect(r.http!.s.paused).toBe(true)
    expect(alarms).toEqual([
      {
        code: 'mode_start_failed',
        message: expect.stringContaining('this is the worker "fakegame", not "civ6"'),
        id: 'game',
      },
    ])
    expectNothingLeft(r)
    const seen = allRequests(r)
    await pause(100)
    expect(allRequests(r)).toBe(seen)
  })

  it('an agent that is not there answers nothing within start_timeout_sec: the start fails and says why', async () => {
    const r = await gameRig({ down: true, settings: { start_timeout_sec: 1 } })
    const alarms = managerAlarms(r)
    const t0 = Date.now()
    await expect(r.enter()).rejects.toThrow(
      /the game agent did not answer within 1 s \(cannot reach the worker/
    )
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(r.service.state('game')).toBe('IDLE')
    expect(alarms.map((a) => a.code)).toEqual(['mode_start_failed'])
    expectNothingLeft(r)
  })

  it('an agent that answers too slowly is asked again until the time is up, then the start fails', async () => {
    const r = await gameRig({
      workerOver: { misbehave: { hang: true } },
      settings: { start_timeout_sec: 1 },
    })
    await expect(r.enter()).rejects.toThrow(/did not answer within 1 s \(the worker did not answer/)
    expect(allRequests(r)).toBeGreaterThanOrEqual(2)
    expect(r.http!.s.paused).toBe(true)
    expectNothingLeft(r)
  })

  it('an agent that is slow to come up gets its chance: the first answer may take a few tries', async () => {
    const r = await gameRig({
      workerOver: { misbehave: { hang: true } },
      settings: { start_timeout_sec: 10 },
    })
    const entering = r.enter()
    await until(() => allRequests(r) >= 2, 5000, 'two attempts')
    r.http!.s.misbehave.hang = false
    await entering
    expect(r.service.state('game')).toBe('ACTIVE')
    expect(r.http!.s.paused).toBe(false)
  })

  it('an agent that answers nonsense is refused with what is wrong with the answer', async () => {
    for (const [fault, words] of [
      ['badJson', /is not JSON/],
      ['huge', /very large answer/],
      ['badState', /not what the protocol says \(epoch/],
    ] as const) {
      const r = await gameRig({ settings: { start_timeout_sec: 1 } })
      r.http!.s.misbehave[fault] = true
      await expect(r.enter(), fault).rejects.toThrow(words)
      expectNothingLeft(r)
    }
  })

  it('a refusal in the agent’s own words is passed on', async () => {
    const r = await gameRig({ settings: { start_timeout_sec: 1 } })
    r.http!.s.misbehave.status = 503
    await expect(r.enter()).rejects.toThrow('refused for a test')
    expect(r.http!.s.paused).toBe(true)
  })

  it('the game service is not ready: the manager says so, and the mode never starts', async () => {
    const r = await gameRig({ plugin: 'game-demo' })
    r.svc.status = 'stopped'
    r.svc.failStart = 'port already in use'
    const alarms = managerAlarms(r)
    await expect(r.enter()).rejects.toThrow(/did not become ready \(failed: port already in use\)/)
    expect(alarms[0]?.code).toBe('mode_start_failed')
    expect(allRequests(r)).toBe(0)
    expectNothingLeft(r)
  })

  it('no plugin provides the game service: the manager says what to enable, and the mode never starts', async () => {
    const r = await gameRig({ config: { plugins: {} } })
    const alarms = managerAlarms(r)
    await expect(r.enter()).rejects.toThrow(
      'the "game" service is not set up: enable a plugin that provides it'
    )
    expect(alarms.map((a) => a.code)).toEqual(['mode_start_failed'])
    expect(allRequests(r)).toBe(0)
    expectNothingLeft(r)
  })

  it('a pack that lacks a prompt file stops the start instead of guessing', async () => {
    for (const missing of ['comment', 'restarted', 'steering', 'active']) {
      const r = await gameRig({
        pack: (real) => {
          const prompts = new Map(real.prompts)
          prompts.delete(missing)
          return { ...real, prompts }
        },
      })
      await expect(r.enter(), missing).rejects.toThrow(
        `the game pack is incomplete: no prompts/${missing}.md`
      )
      expect(allRequests(r)).toBe(0)
      expect(r.http!.s.paused).toBe(true)
    }
  })

  it('every failed start can be tried again once the cause is gone', async () => {
    const r = await gameRig({ settings: { name: 'civ6', start_timeout_sec: 1 } })
    await expect(r.enter()).rejects.toThrow()
    r.http!.s.worker = 'civ6'
    await r.enter()
    expect(r.service.state('game')).toBe('ACTIVE')
    expect(r.http!.s.paused).toBe(false)
  })
})

describe('the plugin behind the service', () => {
  it('a worker the program starts is started with the mode and stopped when it ends; one you started yourself is left alone', async () => {
    const owned = await gameRig({ plugin: 'game-demo' })
    owned.svc.status = 'stopped'
    await owned.enter()
    expect(owned.svc.started).toBe(1)
    await owned.exit()
    // the agent is asked to pause first, then the plugin is stopped
    expect(owned.http!.s.paused).toBe(true)
    expect(owned.svc.stopped).toBe(1)

    const external = await gameRig({ plugin: 'game-attach' })
    await external.enter()
    await external.exit()
    expect(external.svc.started).toBe(0)
    expect(external.svc.stopped).toBe(0)
  })

  it('a plugin that is already up is not started again', async () => {
    const r = await gameRig({ plugin: 'game-demo' })
    await r.enter()
    expect(r.svc.started).toBe(0)
    await r.exit()
    expect(r.svc.stopped).toBe(1)
  })
})

describe('the other modes', () => {
  it('sing, draw and commentary cannot start while the game is on; the dance can', async () => {
    const r = await gameRig({ others: true })
    await r.enter()
    for (const id of ['sing', 'draw', 'commentary'])
      await expect(r.service.enter(id), id).rejects.toMatchObject({ code: 'excluded' })
    expect(r.service.state('game')).toBe('ACTIVE')
    await r.service.enter('dance')
    expect(r.service.active().sort()).toEqual(['dance', 'game'])
    expect(r.http!.s.paused).toBe(false)
  })

  it('the game cannot start while one of them is on, unless it is asked to replace it', async () => {
    const r = await gameRig({ others: true })
    await r.service.enter('sing')
    await expect(r.enter()).rejects.toMatchObject({ code: 'excluded' })
    expect(r.f.tools).toEqual([])
    expect(allRequests(r)).toBe(0)
    await r.service.enter('game', { replace: true })
    expect(r.service.active()).toEqual(['game'])
    expect(r.http!.s.paused).toBe(false)
  })

  it('sleep preempts the game: it ends cleanly, and the game cannot start during sleep', async () => {
    const r = await gameRig({ others: true })
    await r.enter()
    await r.service.enter('sleep')
    expect(r.service.state('game')).toBe('IDLE')
    expect(r.http!.s.paused).toBe(true)
    expect(r.f.tools).toEqual([])
    expect(r.alarms()).toEqual([])
    await expect(r.enter()).rejects.toMatchObject({ code: 'blocked' })
  })

  it('a dance is an interlude: while it lasts nothing is said about the game, and afterwards the newest is', async () => {
    const r = await gameRig({ others: true })
    await r.enter()
    await r.service.enter('dance')
    r.push('turn', 'turn 1 during the dance', 'soon')
    r.push('turn', 'turn 2 during the dance', 'soon')
    r.push('death', 'died during the dance', 'immediate')
    await until(() => r.ctl.status().waiting.immediate === 1, 5000, 'the events to be read')
    await pause(100)
    expect(r.f.told).toEqual([])
    expect(r.ctl.status().doing).toBe('blocked')
    await r.service.exit('dance')
    await until(() => r.f.told.length === 1, 5000, 'the comment after the dance')
    const text = r.f.told[0]!.text
    expect(text).toContain('died during the dance')
    expect(text).toContain('turn 2 during the dance')
    expect(text).not.toContain('turn 1 during the dance')
    expect(r.ctl.status().doing).not.toBe('blocked')
  })
})

describe('shutdown in the middle of anything', () => {
  it('while the first answer is awaited: prompt, not a failure, nothing registered or resumed', async () => {
    const r = await gameRig({
      workerOver: { misbehave: { hang: true } },
      settings: { start_timeout_sec: 60 },
    })
    const alarms = managerAlarms(r)
    const entering = r.service.enter('game').catch((e: unknown) => e)
    await until(() => allRequests(r) >= 1, 5000, 'the first request')
    const t0 = Date.now()
    await r.service.dispose()
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(await entering).toMatchObject({ message: 'cancelled while starting' })
    expect(alarms).toEqual([])
    expect(r.http!.s.paused).toBe(true)
    expectNothingLeft(r)
    const seen = allRequests(r)
    await pause(150)
    expect(allRequests(r)).toBe(seen)
  })

  it('the operator pressing stop while it starts is not an alarm, and it starts again afterwards', async () => {
    const r = await gameRig({
      workerOver: { misbehave: { hang: true } },
      settings: { start_timeout_sec: 60 },
    })
    const alarms = managerAlarms(r)
    const entering = r.service.enter('game').catch((e: unknown) => e)
    await until(() => allRequests(r) >= 1, 5000, 'the first request')
    await r.exit()
    expect(await entering).toMatchObject({ message: 'cancelled while starting' })
    expect(r.service.state('game')).toBe('IDLE')
    expect(alarms).toEqual([])
    r.http!.s.misbehave.hang = false
    await r.enter()
    expect(r.service.state('game')).toBe('ACTIVE')
  })

  it('while it is on and idle: the agent is paused, nothing is asked afterwards', async () => {
    const r = await gameRig()
    await r.enter()
    await until(() => eventReads(r) >= 2, 5000, 'polls')
    await r.service.dispose()
    expect(r.http!.s.paused).toBe(true)
    expectNothingLeft(r)
    const seen = allRequests(r)
    await pause(150)
    expect(allRequests(r)).toBe(seen)
  })

  it('while a poll is waiting for a hung agent: prompt, and the pause it sends is bounded too', async () => {
    const r = await gameRig()
    await r.enter()
    r.http!.s.misbehave.hang = true
    const before = allRequests(r)
    await until(() => allRequests(r) > before, 5000, 'a poll that hangs')
    const t0 = Date.now()
    await r.service.dispose()
    expect(Date.now() - t0).toBeLessThan(2000)
    expectNothingLeft(r)
  })

  it('while a comment waits for the voice: nothing is said after it, and the voice is not touched', async () => {
    const r = await gameRig()
    let release!: () => void
    r.f.quiet.wait = new Promise<void>((res) => (release = res))
    await r.enter()
    r.push('death', 'dead', 'immediate')
    await until(() => r.ctl.status().doing === 'voice', 5000, 'the wait for the voice')
    await r.service.dispose()
    release()
    await pause(150)
    expect(r.f.told).toEqual([])
    expectNothingLeft(r)
  })

  it('while a comment is being written: what its answer says changes nothing afterwards', async () => {
    const r = await gameRig()
    let release!: () => void
    r.gates.tell = new Promise<void>((res) => (release = res))
    r.brain.answer = async () => ({ status: 'failed', sentences: 0, error: 'too late to matter' })
    await r.enter()
    r.push('death', 'dead', 'immediate')
    await until(() => r.f.told.length === 1, 5000, 'the comment to be handed over')
    await r.service.dispose()
    release()
    await pause(150)
    expect(r.alarms()).toEqual([])
    expectNothingLeft(r)
    expect(r.f.events.some((e) => e.includes('commented'))).toBe(false)
  })

  it('the leave that follows a start that was given up does not find a second run', async () => {
    const r = await gameRig()
    await Promise.all([r.service.enter('game').catch(() => undefined), r.exit()])
    await r.enter()
    expect(r.service.state('game')).toBe('ACTIVE')
    expect(r.f.tools).toHaveLength(1)
    await r.exit()
    expectNothingLeft(r)
  })
})
