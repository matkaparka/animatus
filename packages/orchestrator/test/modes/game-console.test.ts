/**
 * What the operator and the model can do to the agent: the `game_command` tool (only while the mode is on, checked before it
 * is run, the agent's own words when it refuses, the same directive not sent twice in a row) and the panel with its buttons
 * (pause and resume, forget, a directive, refresh, start). Real sockets, real time.
 */
import { describe, expect, it } from 'vitest'
import { ModePanel, makeSource } from '@animatus/protocol'
import { gameRig, until, useGameRig } from './gameRig.ts'
import type { Rig } from './gameRig.ts'

useGameRig({ fakeTimers: false })

const running = async (over: Parameters<typeof gameRig>[0] = {}): Promise<Rig> => {
  const r = await gameRig(over)
  await r.enter()
  return r
}

const action = (r: Rig, id: string) => r.panel()!.actions.find((a) => a.id === id)

describe('the tool', () => {
  it('exists only while the mode is on', async () => {
    const r = await gameRig()
    expect(r.tool()).toBeUndefined()
    await r.enter()
    expect(r.tool()?.name).toBe('game_command')
    await r.exit()
    expect(r.tool()).toBeUndefined()
    await r.enter()
    expect(r.f.tools).toHaveLength(1) // registered once for each run
  })

  it('is free and has no floor, so the configuration has the last word', async () => {
    const r = await running()
    expect(r.tool()).toMatchObject({ name: 'game_command', tier: 'free' })
    expect(r.tool()!.floor).toBeUndefined()
    expect(r.tool()!.description).toMatch(/viewer suggests something you agree with/)
    expect(r.tool()!.usage).toContain('300')
  })

  it('sends the directive to the agent, and says it did', async () => {
    const r = await running()
    expect(await r.callTool({ text: '  gather wood, then build a shelter  ' })).toBe(
      'sent to the game agent'
    )
    expect(r.directives()).toEqual(['gather wood, then build a shelter'])
    expect(r.f.events).toContain(
      'game: directive sent (from the character): gather wood, then build a shelter'
    )
  })

  it('what it sends is one line without control characters, whatever the model wrote', async () => {
    const r = await running()
    await r.callTool({ text: 'go\nnorth,\r\n\tthen\u0000dig' })
    expect(r.directives()).toEqual(['go north, then dig'])
  })

  it('one to three hundred characters: an empty or long directive is refused before it is sent', async () => {
    const r = await running()
    const before = r.http!.s.requests.length
    for (const bad of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(301) }, {}, { text: 4 }])
      await expect(r.callTool(bad), JSON.stringify(bad)).rejects.toThrow(/bad_args/)
    await expect(r.callTool({ text: '\u0000\u0000' })).rejects.toThrow('the directive is empty')
    expect(r.directives()).toEqual([])
    expect(r.http!.s.requests.slice(before).filter((q) => q.includes('/command'))).toEqual([])
    await r.callTool({ text: 'x'.repeat(300) })
    expect(r.directives()).toHaveLength(1)
  })

  it('when the agent refuses, the model is told in the agent’s own words', async () => {
    const r = await running()
    r.http!.s.online = false
    await expect(r.callTool({ text: 'go north' })).rejects.toThrow('the game is not connected')
    expect(r.directives()).toEqual([])
    // and while it is not in a game the tool is left out of the prompt altogether
    await until(() => r.tool()!.available!() === false, 5000, 'the agent to be seen offline')
    r.http!.s.online = true
    await until(() => r.tool()!.available!() === true, 5000, 'the agent to be seen online')
  })

  it('an agent that cannot be reached is an error with the reason, not a hang', async () => {
    const r = await running()
    r.http!.s.misbehave.hang = true
    const t0 = Date.now()
    await expect(r.callTool({ text: 'go north' })).rejects.toThrow(/did not answer/)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('the prompt tells the model about the tool only where it may be used', async () => {
    const on = await running()
    expect(on.prompt()).toContain('game_command')
    const off = await running({ config: { tools: { tiers: { game_command: 'disabled' } } } })
    expect(off.prompt()).not.toContain('game_command')
    expect(off.prompt()).toContain('You are playing') // the rest is still there
    const none = await running({ config: { tools: { enabled: false } } })
    expect(none.prompt()).not.toContain('game_command')
    // "approval" is still a way to use it (staff ask, the streamer says yes), so the words stay
    const staff = await running({ config: { tools: { tiers: { game_command: 'approval' } } } })
    expect(staff.prompt()).toContain('game_command')
  })

  it('the same directive twice in a row is sent once; a different one, or the same one later, is sent', async () => {
    const r = await running({ settings: { duplicate_command_sec: 30 } })
    expect(await r.callTool({ text: 'Gather wood' })).toBe('sent to the game agent')
    expect(await r.callTool({ text: 'gather   wood' })).toBe(
      'the same directive was sent a moment ago'
    )
    expect(r.directives()).toHaveLength(1)
    expect(await r.callTool({ text: 'build a shelter' })).toBe('sent to the game agent')
    expect(await r.callTool({ text: 'gather wood' })).toBe('sent to the game agent') // after another one, it is not a repeat
    r.jump(31_000)
    expect(await r.callTool({ text: 'gather wood' })).toBe('sent to the game agent')
    expect(r.directives()).toEqual(['Gather wood', 'build a shelter', 'gather wood', 'gather wood'])
  })

  it('with duplicate_command_sec 0 every directive is sent', async () => {
    const r = await running({ settings: { duplicate_command_sec: 0 } })
    await r.callTool({ text: 'gather wood' })
    await r.callTool({ text: 'gather wood' })
    expect(r.directives()).toHaveLength(2)
  })

  it('a refused directive is not remembered as sent', async () => {
    const r = await running()
    r.http!.s.online = false
    await expect(r.callTool({ text: 'go north' })).rejects.toThrow()
    r.http!.s.online = true
    expect(await r.callTool({ text: 'go north' })).toBe('sent to the game agent')
  })

  it('a call that arrives after the mode ended finds nothing to send to', async () => {
    const r = await running()
    const spec = r.tool()!
    await r.exit()
    await expect(
      spec.run({ text: 'late' }, { origin: makeSource('viewer'), now: () => 0 })
    ).rejects.toThrow('the game mode is not running')
    expect(r.directives()).toEqual([])
    expect(spec.available!()).toBe(false)
  })

  it('shows the streamer what it would do, when the operator made it wait for a yes', async () => {
    const r = await running()
    expect(r.tool()!.summarize({ text: 'gather wood' } as never)).toBe(
      'Tell the game agent: gather wood'
    )
  })
})

describe('the panel', () => {
  it('is valid whatever the state, and says what it is doing', async () => {
    const r = await gameRig()
    const off = r.panel()!
    expect(ModePanel.safeParse(off).success).toBe(true)
    expect(off.status).toBe('not running')
    expect(off.actions.map((a) => [a.id, a.disabled])).toEqual([
      ['pause', 'the game mode is not running'],
      ['forget', 'the game mode is not running'],
      ['directive', 'the game mode is not running'],
      ['refresh', 'the game mode is not running'],
    ])
    await r.enter()
    expect(r.panel()!.status).toBe('fakegame: idle (waiting for something to do)')
    expect(r.panel()!.actions.map((a) => a.disabled)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    await r.exit()
    expect(r.panel()!.status).toBe('not running')
  })

  it('shows what the agent reports and what waits, and the recent events, newest first', async () => {
    const r = await running()
    r.http!.s.summary = 'Turn 9, ahead in science'
    r.http!.s.facts = { turn: 9, gold: 40 }
    r.http!.s.executing = 'mining iron'
    const release = (() => {
      let done!: () => void
      r.f.quiet.wait = new Promise<void>((res) => (done = res))
      return () => {
        r.f.quiet.wait = null
        done()
      }
    })()
    r.push('turn', 'Turn 9 finished', 'soon')
    r.push('death', 'You died', 'immediate')
    r.push('note', 'a note', 'later')
    await until(() => r.panel()!.sections[0]!.rows.length === 3, 5000, 'the events')
    await until(() => r.panel()!.facts.some((f) => f.label === 'gold'), 5000, 'the state')
    const p = r.panel()!
    const facts = Object.fromEntries(p.facts.map((f) => [f.label, f.value]))
    expect(facts).toMatchObject({
      Game: 'fakegame (worker protocol)',
      Agent: 'doing: mining iron',
      Situation: 'Turn 9, ahead in science',
      Comments: '0 so far',
      'Waiting to be said': '1 immediate, 1 soon',
      turn: '9',
      gold: '40',
    })
    expect(p.status).toContain('doing: mining iron')
    expect(p.status).toContain('waiting for the voice')
    expect(p.sections[0]!.rows.map((x) => [x.text, x.detail])).toEqual([
      ['note: a note', 'later, 0 s ago'],
      ['death: You died', 'immediate, 0 s ago'],
      ['turn: Turn 9 finished', 'soon, 0 s ago'],
    ])
    release()
    await until(() => r.f.told.length === 1, 5000, 'the comment')
    await until(
      () => r.panel()!.facts.some((f) => f.label === 'Comments' && f.value.startsWith('1 so far')),
      5000
    )
  })

  it('the pause button says what it will do, and does it', async () => {
    const r = await running()
    expect(action(r, 'pause')?.label).toBe('Pause the game agent')
    expect(await r.act({ action: 'pause' })).toEqual({ ok: true })
    expect(r.http!.s.paused).toBe(true)
    expect(action(r, 'resume')?.label).toBe('Resume the game agent')
    expect(action(r, 'pause')).toBeUndefined()
    expect(r.panel()!.status).toContain('paused')
    expect(r.prompt()).toContain('Agent: paused')
    expect(await r.act({ action: 'resume' })).toEqual({ ok: true })
    expect(r.http!.s.paused).toBe(false)
    expect(action(r, 'pause')?.label).toBe('Pause the game agent')
    expect(r.f.events).toContain('game: the game agent was paused from the console')
    expect(r.f.events).toContain('game: the game agent was resumed from the console')
  })

  it('a pause the agent cannot take is an answer with the reason, and changes nothing', async () => {
    const r = await running()
    r.http!.s.misbehave.status = 503
    expect(await r.act({ action: 'pause' })).toEqual({ ok: false, reason: 'refused for a test' })
    delete r.http!.s.misbehave.status
    expect(r.http!.s.paused).toBe(false)
  })

  it('forgetting asks first, drops the agent’s directives and the mode’s notes, and leaves what is still to be said', async () => {
    const r = await running()
    expect(action(r, 'forget')?.confirm).toContain('drop its notes')
    r.push('note', 'a note the model was given', 'later')
    await until(() => (r.prompt() ?? '').includes('a note the model was given'), 5000, 'the note')
    await r.callTool({ text: 'gather wood' })
    expect(r.http!.s.directives).toEqual(['gather wood'])
    expect(await r.act({ action: 'forget' })).toEqual({ ok: true })
    expect(r.http!.s.directives).toEqual([])
    expect(r.prompt()).not.toContain('a note the model was given')
    expect(r.f.events).toContain(
      'game: the game agent and the mode forgot their notes and directives'
    )
    // a directive that was just forgotten can be given again at once
    expect(await r.callTool({ text: 'gather wood' })).toBe('sent to the game agent')
  })

  it('a forget the agent refuses keeps the notes, and says why', async () => {
    const r = await running()
    r.push('note', 'a note', 'later')
    await until(() => (r.prompt() ?? '').includes('a note'), 5000, 'the note')
    r.http!.s.misbehave.status = 503
    expect(await r.act({ action: 'forget' })).toEqual({ ok: false, reason: 'refused for a test' })
    delete r.http!.s.misbehave.status
    expect(r.prompt()).toContain('a note')
  })

  it('a directive from the panel goes to the agent directly, not through the tool’s rules', async () => {
    // the operator is not the audience: no repeat check, and it works whatever the tool's tier is
    const r = await running({ config: { tools: { tiers: { game_command: 'disabled' } } } })
    expect(await r.act({ action: 'directive', text: 'go for science' })).toEqual({ ok: true })
    expect(await r.act({ action: 'directive', text: 'go for science' })).toEqual({ ok: true })
    expect(r.directives()).toEqual(['go for science', 'go for science'])
    expect(r.f.events).toContain('game: directive sent (from the console): go for science')
  })

  it('a directive that cannot be sent is an answer with the reason', async () => {
    const r = await running()
    expect(await r.act({ action: 'directive', text: '' })).toEqual({
      ok: false,
      reason: 'the directive is empty',
    })
    expect(await r.act({ action: 'directive' })).toEqual({
      ok: false,
      reason: 'the directive is empty',
    })
    expect(await r.act({ action: 'directive', text: 'x'.repeat(301) })).toEqual({
      ok: false,
      reason: 'a directive is 1 to 300 characters',
    })
    r.http!.s.online = false
    expect(await r.act({ action: 'directive', text: 'go north' })).toEqual({
      ok: false,
      reason: 'the game is not connected',
    })
    await until(() => action(r, 'directive')?.disabled !== undefined, 5000, 'the button to go off')
    expect(action(r, 'directive')?.disabled).toBe('the game is not connected')
    expect(r.directives()).toEqual([])
  })

  it('every button but Start needs the mode to be on, and says so', async () => {
    const r = await gameRig()
    for (const req of [
      { action: 'pause' },
      { action: 'resume' },
      { action: 'forget' },
      { action: 'directive', text: 'go north' },
      { action: 'refresh' },
    ])
      expect(await r.act(req), req.action).toEqual({
        ok: false,
        reason: 'the game mode is not running',
      })
    expect(r.http!.s.requests).toEqual([])
  })

  it('Refresh reads the agent now, and says when it cannot', async () => {
    const r = await running({ settings: { poll_sec: 60, max_backoff_sec: 60 } })
    r.push('note', 'fresh news', 'later')
    expect(await r.act({ action: 'refresh' })).toEqual({ ok: true })
    expect(r.panel()!.sections[0]!.rows[0]!.text).toBe('note: fresh news') // no wait for the next poll
    r.http!.s.misbehave.status = 503
    expect(await r.act({ action: 'refresh' })).toEqual({ ok: false, reason: 'refused for a test' })
    expect(r.f.alarms.map((a) => a.code)).toContain('game_worker')
  })

  it('Refresh pressed twice at once is one poll', async () => {
    const r = await running({ settings: { poll_sec: 60, max_backoff_sec: 60 } })
    const before = r.http!.s.requests.filter((q) => q.includes('/worker/state')).length
    const [a, b] = await Promise.all([r.act({ action: 'refresh' }), r.act({ action: 'refresh' })])
    expect([a, b]).toEqual([{ ok: true }, { ok: true }])
    expect(r.http!.s.requests.filter((q) => q.includes('/worker/state')).length).toBe(before + 1)
  })

  it('no action is Start: it enters the mode, with the replace and force the console sends', async () => {
    const r = await gameRig({ others: true })
    const seen: unknown[] = []
    const enterMode = r.f.host.enterMode
    r.f.host.enterMode = (id, o) => {
      seen.push([id, o])
      return enterMode(id, o)
    }
    expect(await r.act({})).toEqual({ ok: true })
    expect(r.service.state('game')).toBe('ACTIVE')
    await r.exit()
    await r.service.enter('sing')
    expect(await r.act({ action: 'start' })).toMatchObject({ ok: false })
    expect(await r.act({ action: 'start', replace: true, force: false })).toEqual({ ok: true })
    expect(seen).toEqual([
      ['game', {}],
      ['game', {}],
      ['game', { replace: true }],
    ])
    expect(r.service.active()).toEqual(['game'])
  })

  it('an action it does not know is refused by name', async () => {
    const r = await running()
    expect(await r.act({ action: 'dance' })).toEqual({
      ok: false,
      reason: 'the game mode has no action "dance"',
    })
    expect(await r.act({ action: 'x'.repeat(100) })).toMatchObject({ ok: false })
  })

  it('goes through the service the way the console does', async () => {
    const r = await running()
    expect(
      await r.service.consoleRequest('game', { action: 'directive', text: 'go north' })
    ).toEqual({
      ok: true,
    })
    expect(r.directives()).toEqual(['go north'])
  })
})
