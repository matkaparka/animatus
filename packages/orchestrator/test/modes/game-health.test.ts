/**
 * The agent while the mode runs: one that goes away, is slow or answers nonsense (an alarm with the reason, waits that grow,
 * the alarm gone when it is back, the mode never leaves), one that is restarted (a new epoch: the mode notices, drops what it
 * knew, says so once, and puts the agent back to playing), and the older link through the adapter. Real sockets, real time.
 */
import { describe, expect, it } from 'vitest'
import { gameRig, pause, until, useGameRig } from './gameRig.ts'
import type { Rig } from './gameRig.ts'

useGameRig({ fakeTimers: false })

const running = async (over: Parameters<typeof gameRig>[0] = {}): Promise<Rig> => {
  const r = await gameRig(over)
  await r.enter()
  return r
}

const gameAlarm = (r: Rig) => r.f.alarms.find((a) => a.code === 'game_worker')
const raised = (r: Rig) => r.f.alarms.filter((a) => a.code === 'game_worker').length
const polls = (r: Rig) => r.http!.s.requests.filter((q) => q.includes('/worker/state')).length

/** Waits for this many more polls, whatever they find. */
const morePolls = async (r: Rig, n: number) => {
  const target = polls(r) + n
  await until(() => polls(r) >= target, 5000, `${n} more polls`)
}

describe('an agent that stops answering', () => {
  const faults: [string, (r: Rig) => void, RegExp][] = [
    ['refuses', (r) => void (r.http!.s.misbehave.status = 503), /refused for a test/],
    [
      'hangs',
      (r) => void (r.http!.s.misbehave.hang = true),
      /did not answer \/worker\/state within/,
    ],
    [
      'answers with something that is not JSON',
      (r) => void (r.http!.s.misbehave.badJson = true),
      /is not JSON/,
    ],
    [
      'answers with a huge body',
      (r) => void (r.http!.s.misbehave.huge = true),
      /very large answer/,
    ],
    [
      'answers with a state that is not the protocol',
      (r) => void (r.http!.s.misbehave.badState = true),
      /not what the protocol says/,
    ],
  ]
  for (const [what, cause, words] of faults)
    it(`${what}: one alarm with the reason, the mode stays on, and the alarm goes when it is back`, async () => {
      const r = await running()
      cause(r)
      await until(() => gameAlarm(r) !== undefined, 5000, 'the alarm')
      expect(gameAlarm(r)).toMatchObject({ level: 'warn', subject: 'game' })
      expect(gameAlarm(r)!.message).toMatch(words)
      expect(gameAlarm(r)!.message).toContain('The game mode is still on and keeps trying')
      expect(r.service.state('game')).toBe('ACTIVE')
      expect(r.ctl.status()).toMatchObject({
        failures: expect.any(Number),
        down: expect.stringMatching(words),
      })
      await morePolls(r, 2)
      expect(raised(r)).toBe(1) // not raised again for the same words at every try
      expect(r.f.events.filter((e) => e.includes('does not answer'))).toHaveLength(1)

      r.http!.s.misbehave = {}
      await until(() => gameAlarm(r) === undefined, 5000, 'the alarm to go')
      expect(r.ctl.status()).toMatchObject({ failures: 0, down: null })
      expect(r.f.events).toContain('game: the game agent answers again')
      // and it is heard again
      r.push('death', 'dead after the outage', 'immediate')
      await until(() => r.f.told.length === 1, 5000, 'a comment')
    })

  it('an agent that is gone (the port is closed) is unreachable, and the mode keeps trying', async () => {
    const r = await running()
    await r.http!.close()
    await until(() => gameAlarm(r) !== undefined, 5000, 'the alarm')
    expect(gameAlarm(r)!.message).toMatch(/cannot reach the worker/)
    expect(r.service.state('game')).toBe('ACTIVE')
    expect(r.f.tools).toHaveLength(1)
  })

  it('a different worker on the same address (the name is set) is an alarm that says so', async () => {
    const r = await running({ settings: { name: 'fakegame' } })
    r.http!.s.worker = 'somebody-else'
    await until(() => gameAlarm(r) !== undefined, 5000, 'the alarm')
    expect(gameAlarm(r)!.message).toContain('this is the worker "somebody-else", not "fakegame"')
    r.http!.s.worker = 'fakegame'
    await until(() => gameAlarm(r) === undefined, 5000, 'the alarm to go')
  })

  it('the wait between tries doubles with every failure, up to max_backoff_sec, and is short again once it answers', async () => {
    const r = await running({ settings: { poll_sec: 3, max_backoff_sec: 30 } })
    r.http!.s.misbehave.status = 503
    // waits of the poll loop (3000 ms and its multiples); the other loop's waits are shorter than that
    const waits = () => r.sleeps.filter((ms) => ms >= 3000)
    await until(() => waits().length >= 7, 8000, 'seven waits')
    expect(waits().slice(0, 7)).toEqual([3000, 6000, 12000, 24000, 30000, 30000, 30000])
    delete r.http!.s.misbehave.status
    await until(() => waits().slice(7).includes(3000), 8000, 'a short wait again')
  })

  it('a poll that fails while the panel is watched says how long until the next try', async () => {
    const r = await running({ settings: { poll_sec: 3, max_backoff_sec: 30 } })
    r.http!.s.misbehave.status = 503
    await until(() => r.ctl.status().down !== null, 5000, 'the failure')
    const status = r.panel()!.status!
    expect(status).toMatch(
      /^the game agent does not answer \(refused for a test\); trying again in about \d+ s$/
    )
    const dir = r.panel()!.actions.find((a) => a.id === 'directive')!
    expect(dir.disabled).toBe('the game agent does not answer')
    expect(r.prompt()).toContain('Agent: not answering right now')
  })

  it('while it does not answer, what was said before is still there, and nothing is invented', async () => {
    const r = await running()
    r.push('note', 'a note from before', 'later')
    await until(() => (r.prompt() ?? '').includes('a note from before'), 5000, 'the note')
    r.http!.s.misbehave.status = 503
    await until(() => gameAlarm(r) !== undefined, 5000, 'the alarm')
    expect(r.prompt()).toContain('a note from before')
    await pause(100)
    expect(r.f.told).toEqual([])
  })
})

describe('an agent that was restarted', () => {
  it('is noticed once: the run log says so, the notes go, the agent is resumed, and the next comment tells the model', async () => {
    const r = await running()
    r.push('note', 'a note about the old run', 'later')
    await until(() => (r.prompt() ?? '').includes('a note about the old run'), 5000, 'the note')
    r.http!.restart() // a new epoch, the numbers begin again, and it starts paused
    expect(r.http!.s.paused).toBe(true)
    r.push('fight', 'a fight in the new run', 'immediate')
    await until(() => r.f.told.length === 1, 5000, 'the comment')
    const text = r.f.told[0]!.text
    expect(text).toContain('The game agent was just restarted')
    expect(text).toContain('a fight in the new run')
    expect(r.prompt()).not.toContain('a note about the old run')
    expect(r.http!.s.paused).toBe(false) // put back to playing
    expect(
      r.f.events.filter(
        (e) => e === 'game: the game agent was restarted; what was known about the game is dropped'
      )
    ).toHaveLength(1)
    expect(r.f.events).toContain('game: the game agent was resumed')
    expect(r.f.events).toContain('game: commented on 1 event(s) (fight) and the restart')
    // it is said once
    r.push('fight', 'another fight', 'immediate')
    await until(() => r.f.told.length === 2, 5000, 'the next comment')
    expect(r.f.told[1]!.text).not.toContain('was just restarted')
    expect(r.alarms()).toEqual([])
  })

  it('a restart with nothing to report is still told, at the next quiet moment', async () => {
    const r = await running()
    r.http!.restart()
    await until(() => r.f.told.length === 1, 5000, 'the comment about the restart')
    expect(r.f.told[0]!.text).toContain('The game agent was just restarted')
    expect(r.f.told[0]!.text).toContain('(nothing else was reported)')
    expect(r.http!.s.paused).toBe(false)
  })

  it('what was waiting to be said about the old run is not said about the new one', async () => {
    const r = await running()
    let release!: () => void
    r.f.quiet.wait = new Promise<void>((res) => (release = res))
    r.push('death', 'died in the old run', 'immediate')
    r.push('turn', 'a turn of the old run', 'soon')
    await until(() => r.panel()!.sections[0]!.rows.length === 2, 5000, 'the events')
    r.http!.restart()
    r.push('start', 'the new run began', 'soon')
    await until(() => r.panel()!.sections[0]!.rows.length === 3, 5000, 'the new event')
    r.f.quiet.wait = null
    release()
    await until(() => r.f.told.length === 1, 5000, 'the comment')
    const text = r.f.told[0]!.text
    expect(text).toContain('the new run began')
    expect(text).not.toContain('died in the old run')
    expect(text).not.toContain('a turn of the old run')
  })

  it('is put back to what the operator wants: playing, or paused if the operator paused it', async () => {
    const pauses = (r: Rig) => r.http!.s.requests.filter((q) => q.includes('/worker/pause')).length
    const r = await running()
    const atStart = pauses(r) // the resume when the mode started
    r.http!.restart()
    await until(() => pauses(r) === atStart + 1, 5000, 'the resume after the restart')
    expect(r.http!.s.paused).toBe(false)

    const operator = await running()
    expect(await operator.act({ action: 'pause' })).toEqual({ ok: true })
    const before = pauses(operator)
    operator.http!.restart()
    await until(() => pauses(operator) === before + 1, 5000, 'the pause after the restart')
    await pause(100)
    expect(operator.http!.s.paused).toBe(true)
    expect(pauses(operator)).toBe(before + 1) // said once, not at every poll
  })

  it('a backlog of the new run larger than one page is read whole', async () => {
    const r = await running()
    r.http!.restart()
    for (let i = 1; i <= 70; i++) r.push('note', `new note ${i}`, 'later')
    await until(() => (r.prompt() ?? '').includes('new note 70'), 5000, 'the notes')
    expect(r.f.events.filter((e) => e.includes('was restarted'))).toHaveLength(1)
    expect(r.panel()!.sections[0]!.rows).toHaveLength(30) // the panel shows the newest thirty
    expect(r.panel()!.sections[0]!.rows[0]!.text).toContain('new note 70')
  })
})

describe('an older agent behind the adapter', () => {
  it('is read through the older link, resumed on entering, told its directives, and paused on leaving', async () => {
    const r = await gameRig({
      worker: 'legacy',
      legacyOver: {
        paused: true,
        status: { game: 'civ6', turn: 7, summary: 'Turn 7, ahead in science' },
      },
    })
    await r.enter()
    expect(r.legacy!.s.paused).toBe(false)
    expect(r.legacy!.s.requests[0]).toBe('GET /status')
    expect(r.f.events[0]).toBe('game mode on (civ6, older link)')
    expect(r.prompt()).toContain('You are playing civ6 on stream')
    expect(r.prompt()).toContain('Situation: Turn 7, ahead in science')
    expect(r.prompt()).toContain('- turn: 7')
    r.push('turn', 'Turn 8 finished', 'soon')
    await until(() => r.f.told.length === 1, 5000, 'the comment')
    expect(r.f.told[0]!.text).toContain('Turn 8 finished')
    await r.callTool({ text: 'go for science' })
    expect(r.legacy!.s.commands).toEqual(['go for science'])
    await r.exit()
    expect(r.legacy!.s.paused).toBe(true)
    expect(r.f.tools).toEqual([])
    expect(r.f.alarms).toEqual([])
  })

  it('a Minecraft bot that does not name its game is called what the settings say', async () => {
    const r = await gameRig({
      worker: 'legacy',
      settings: { name: 'minecraft', title: 'Minecraft' },
      legacyOver: { status: { health: 18, food: 15, isDay: true } },
    })
    await r.enter()
    expect(r.f.events[0]).toBe('game mode on (Minecraft, older link)')
    expect(r.prompt()).toContain('You are playing Minecraft on stream')
    expect(r.prompt()).toContain('- health: 18')
    const untitled = await gameRig({
      worker: 'legacy',
      settings: { name: 'minecraft' },
      legacyOver: { status: { health: 18 } },
    })
    await untitled.enter()
    expect(untitled.prompt()).toContain('You are playing minecraft on stream')
  })

  it('an agent that is not in a game: offline, and the directive is refused in its own words', async () => {
    const r = await gameRig({ worker: 'legacy', legacyOver: { online: false } })
    await r.enter()
    expect(r.prompt()).toContain('Agent: offline')
    expect(r.tool()!.available!()).toBe(false)
    await expect(r.callTool({ text: 'go north' })).rejects.toThrow('game not connected') // the agent's own words
    expect(r.legacy!.s.commands).toEqual([])
  })

  it('goes away and comes back like any other: an alarm with the reason, gone when it answers', async () => {
    const r = await gameRig({ worker: 'legacy' })
    await r.enter()
    r.legacy!.s.misbehave.hang = true
    await until(() => gameAlarm(r) !== undefined, 5000, 'the alarm')
    expect(gameAlarm(r)!.message).toMatch(/did not answer \/status within/)
    r.legacy!.s.misbehave.hang = false
    await until(() => gameAlarm(r) === undefined, 5000, 'the alarm to go')
  })

  it('a restart that shows in its event numbers (they go backwards) is noticed', async () => {
    const r = await gameRig({ worker: 'legacy', legacyOver: { paused: true } })
    await r.enter()
    for (let i = 1; i <= 5; i++) r.push('note', `old ${i}`, 'later')
    await until(() => (r.prompt() ?? '').includes('old 5'), 5000, 'the old notes')
    r.legacy!.restart() // the numbers begin again at 1, and the agent starts paused
    r.push('fight', 'a fight after the restart', 'immediate')
    await until(() => r.f.told.length === 1, 5000, 'the comment')
    expect(r.f.told[0]!.text).toContain('The game agent was just restarted')
    expect(r.f.told[0]!.text).toContain('a fight after the restart')
    expect(r.prompt()).not.toContain('old 5')
    expect(r.legacy!.s.paused).toBe(false)
  })
})
