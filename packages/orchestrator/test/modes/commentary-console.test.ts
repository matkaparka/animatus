/** What the operator sees and does: the panel in every state, and the buttons behind it. */
import { describe, expect, it } from 'vitest'
import type { ModePanel } from '@animatus/protocol'
import { CaptureError } from '../../src/modes/commentary/captureClient.ts'
import { win } from './fakeCapture.ts'
import { commentaryRig, identification, useCommentaryRig } from './commentaryRig.ts'

useCommentaryRig()

const fact = (panel: ModePanel | undefined, label: string) =>
  panel?.facts.find((f) => f.label === label)?.value
const button = (panel: ModePanel | undefined, id: string) => panel?.actions.find((a) => a.id === id)
const windowList = (panel: ModePanel | undefined) =>
  panel?.sections.find((s) => s.title === 'Windows')

describe('the panel', () => {
  it('is there before the mode is entered, says it is not running, and lists the windows once the service answers', async () => {
    const r = await commentaryRig()
    const before = r.panel()
    expect(before?.status).toBe('not running')
    expect(fact(before, 'Capture service')).toBe('running') // the plugin is up from the start of the program
    expect(button(before, 'pause')?.disabled).toBe('the mode is not running')
    expect(windowList(before)?.rows).toEqual([]) // asking for the panel started reading the list
    await r.tick(0)
    const after = r.panel()
    expect(windowList(after)?.rows.map((x) => x.id)).toEqual(['101'])
    expect(windowList(after)?.rows[0]?.text).toBe('Some Game - World 1')
    expect(button(after, 'use_window')?.inputs[0]?.options?.map((o) => o.value)).toEqual([
      '',
      '101',
    ])
  })

  it('says when the capture service is not running, switches off what needs it, and forgets the list', async () => {
    const r = await commentaryRig()
    r.panel()
    await r.tick(0)
    expect(windowList(r.panel())?.rows).toHaveLength(1)
    r.svc.status = 'stopped'
    const p = r.panel()
    expect(fact(p, 'Capture service')).toBe('not running')
    expect(button(p, 'refresh')?.disabled).toContain('not running')
    expect(button(p, 'test')?.disabled).toContain('not running')
    expect(windowList(p)?.rows).toEqual([]) // an out-of-date list is not shown as if it were current
    expect(windowList(p)?.empty).toContain('not running')
  })

  it('counts down to the next look while it watches', async () => {
    const r = await commentaryRig({ settings: { analysis_every: 0 } })
    await r.enter()
    expect(r.panel()?.status).toMatch(/^watching; the next look is in about \d+ s$/)
    await r.tick(1500)
    expect(r.panel()?.status).toBe('watching; the next look is in about 8 s')
    await r.tick(3000)
    expect(r.panel()?.status).toBe('watching; the next look is in about 5 s')
  })

  it('shows the game, what was seen, the story and the counts', async () => {
    const r = await commentaryRig({ settings: { summary_every: 3 } })
    await r.enter()
    await r.tick(1500)
    await r.tick(8000)
    const p = r.panel()
    expect(fact(p, 'Game')).toMatch(/^Some Game \(confidence 0\.90, \d+ s ago\)$/)
    expect(fact(p, 'Window')).toBe('Some Game')
    expect(fact(p, 'Interval')).toBe('8 s after each comment')
    expect(fact(p, 'Comments so far')).toBe('2, the story is renewed in 1')
    expect(fact(p, 'Black pictures skipped')).toBe('0')
    expect(fact(p, 'Last capture')).toMatch(
      /^1280x720 sent as 768x432, brightness 60, printwindow, \d+ s ago$/
    )
    expect(p?.sections[0]?.rows[0]?.text).toBe('note 1')
    expect(p?.sections[1]?.rows).toEqual([])
    await r.tick(8000)
    const later = r.panel()
    expect(fact(later, 'Comments so far')).toBe('3, the story is renewed in 3')
    expect(later?.sections[1]?.rows[0]?.text).toBe('They explored a forest and began to build.')
  })

  it('says what is wrong in words: a black window, a capture that fails, a stage that is away, no window', async () => {
    const black = await commentaryRig()
    black.fake.script = [{ kind: 'frame', black: true }]
    await black.enter()
    await black.tick(1500)
    expect(black.panel()?.status).toBe(
      'the window is black: exclusive fullscreen? (this picture is skipped)'
    )
    expect(fact(black.panel(), 'Black pictures skipped')).toBe('1')
    expect(fact(black.panel(), 'Last capture')).toContain('(black)')

    const down = await commentaryRig()
    await down.enter()
    down.svc.status = 'failed'
    await down.tick(1500)
    expect(down.panel()?.status).toBe(
      'cannot capture "Some Game": the screen capture service is not running: it starts with the mode'
    )

    const away = await commentaryRig()
    ;(away.f.hub as unknown as { connected: boolean }).connected = false
    await away.enter()
    await away.tick(1500)
    expect(away.panel()?.status).toBe('waiting for the stage page to connect')

    const none = await commentaryRig({ settings: { window: null } })
    await none.enter()
    await none.tick(1500)
    expect(none.panel()?.status).toBe('waiting: no window is chosen')
    expect(none.f.alarms.find((a) => a.code === 'commentary_window')).toMatchObject({
      level: 'info',
      message: expect.stringContaining('no window is chosen'),
    })
    expect(fact(none.panel(), 'Window')).toBe('none chosen yet')
  })

  it('stays a valid panel whatever the window list and the model contain', async () => {
    const r = await commentaryRig()
    r.fake.windows = [
      win('1', 'x'.repeat(1500), { process: 'p'.repeat(300) }),
      win('2', '', { process: '' }),
      win('3', 'line\nbreak [brackets] {{braces}} 【全角】 😀'.repeat(20)),
      ...Array.from({ length: 300 }, (_, i) =>
        win(String(1000 + i), `Window ${i}`, { minimized: i % 2 === 0, overlay: i % 3 === 0 })
      ),
    ]
    r.model.identify = () => identification('G'.repeat(200), 0.9, 'S'.repeat(400))
    await r.enter()
    await r.tick(1500)
    r.panel()
    await r.tick(0)
    const p = r.panel() // the service drops a panel that breaks the schema, so it being there is the check
    expect(p).toBeDefined()
    expect(windowList(p)?.rows).toHaveLength(40)
    expect(button(p, 'use_window')?.inputs[0]?.options).toHaveLength(41)
  })
})

describe('choosing the window', () => {
  const twoWindows = () => [
    win('101', 'Some Game - World 1', { process: 'javaw.exe' }),
    win('102', 'Notes', { process: 'notepad.exe' }),
  ]

  it('watches the one picked from the list, remembers its three names, and marks it in the list', async () => {
    const r = await commentaryRig({ settings: { window: null } })
    r.fake.windows = twoWindows()
    await r.enter()
    await r.tick(1500)
    expect(r.alarms()).toEqual(['commentary_window'])
    expect(await r.act({ action: 'use_window', row: '101' })).toEqual({ ok: true })
    expect(r.alarms()).toEqual([])
    expect((await r.saved()).window).toEqual({
      id: '101',
      title: 'Some Game - World 1',
      process: 'javaw.exe',
    })
    await r.tick(0) // and it looks at once, without waiting for the next look
    expect(r.f.told).toHaveLength(1)
    expect(r.fake.calls[0]?.window).toBe('101')
    const p = r.panel()
    expect(windowList(p)?.rows.map((x) => [x.id, x.active])).toEqual([
      ['101', true],
      ['102', false],
    ])
    expect(fact(p, 'Window')).toBe('Some Game - World 1 (javaw.exe)')
    expect(button(p, 'use_window')?.inputs[0]?.value).toBe('101')
    expect(r.f.events.join('\n')).toContain('now watching "Some Game - World 1"')
  })

  it('takes the window from the select input, and a name that was typed wins over it', async () => {
    const r = await commentaryRig({ settings: { window: null } })
    r.fake.windows = twoWindows()
    await r.enter()
    r.panel()
    await r.tick(0)
    expect(await r.act({ action: 'use_window', window: '102', title: '' })).toEqual({ ok: true })
    expect((await r.saved()).window).toEqual({ id: '102', title: 'Notes', process: 'notepad.exe' })
    expect(await r.act({ action: 'use_window', window: '102', title: '  exe:javaw.exe ' })).toEqual(
      {
        ok: true,
      }
    )
    expect((await r.saved()).window).toEqual({ id: null, title: 'exe:javaw.exe', process: '' })
  })

  it('keeps a typed name as typed, even when it finds a window', async () => {
    const r = await commentaryRig({ settings: { window: null } })
    r.fake.windows = twoWindows()
    await r.enter()
    await r.act({ action: 'use_window', title: 'some game' })
    await r.tick(0)
    expect(r.f.told).toHaveLength(1)
    expect((await r.saved()).window).toEqual({ id: null, title: 'some game', process: '' })
  })

  it('cleans what is typed into one bounded line', async () => {
    const r = await commentaryRig({ settings: { window: null } })
    await r.act({ action: 'use_window', title: `first\nsecond\t${'z'.repeat(400)}` })
    const saved = (await r.saved()).window as { title: string }
    expect(saved.title.startsWith('first second z')).toBe(true)
    expect([...saved.title]).toHaveLength(300)
    expect(saved.title.endsWith('…')).toBe(true)
  })

  it('takes a number that is in no list as a window id, and other text as a title', async () => {
    const r = await commentaryRig({ settings: { window: null } })
    expect(await r.act({ action: 'use_window', window: '999' })).toEqual({ ok: true })
    expect((await r.saved()).window).toEqual({ id: '999', title: '', process: '' })
    expect(await r.act({ action: 'use_window', window: 'Some text' })).toEqual({ ok: true })
    expect((await r.saved()).window).toEqual({ id: null, title: 'Some text', process: '' })
  })

  it('needs a window or a name, and says so', async () => {
    const r = await commentaryRig({ settings: { window: null } })
    const reason = 'choose a window from the list, or type part of its title'
    expect(await r.act({ action: 'use_window' })).toEqual({ ok: false, reason })
    expect(await r.act({ action: 'use_window', window: '', title: '   ' })).toEqual({
      ok: false,
      reason,
    })
    expect(await r.act({ action: 'use_window', title: 5 })).toEqual({ ok: false, reason })
  })

  it('is remembered across a restart, and used by the first look', async () => {
    const first = await commentaryRig({ settings: { window: null } })
    first.fake.windows = twoWindows()
    await first.enter()
    first.panel()
    await first.tick(0)
    await first.act({ action: 'use_window', row: '101' })
    await first.saved()

    const second = await commentaryRig({
      dataDir: first.f.host.dataDir,
      settings: { window: null },
    })
    second.fake.windows = twoWindows()
    await second.enter()
    expect(fact(second.panel(), 'Window')).toBe('Some Game - World 1 (javaw.exe)')
    await second.tick(1500)
    expect(second.fake.calls[0]?.window).toBe('101')
    expect(second.f.told).toHaveLength(1)
    expect(second.alarms()).toEqual([])
  })

  it('wins over the window in the settings', async () => {
    const r = await commentaryRig({ settings: { window: 'Some Game' } })
    r.fake.windows = twoWindows()
    await r.act({ action: 'use_window', window: '102' })
    await r.enter()
    await r.tick(1500)
    expect(r.fake.calls[0]?.window).toBe('102')
  })
})

describe('the list of windows', () => {
  it('is read again on request, and shows what the service lists now', async () => {
    const r = await commentaryRig()
    r.panel()
    await r.tick(0)
    r.fake.windows = [win('7', 'Other Game')]
    expect(await r.act({ action: 'refresh' })).toEqual({ ok: true })
    expect(windowList(r.panel())?.rows.map((x) => x.text)).toEqual(['Other Game'])
  })

  it('cannot be read while the service is not running, and says so', async () => {
    const r = await commentaryRig()
    r.svc.status = 'stopped'
    const answer = await r.act({ action: 'refresh' })
    expect(answer).toMatchObject({ ok: false })
    expect((answer as { reason: string }).reason).toContain('not running')
    expect(r.fake.windowListCalls).toBe(0)
  })

  it('says why it cannot be read when the service fails, and leaves the rest of the panel alone', async () => {
    const r = await commentaryRig()
    r.fake.windowsFail = new CaptureError(
      'capture_failed',
      'the window list could not be read',
      true,
      500
    )
    const answer = await r.act({ action: 'refresh' })
    expect(answer).toEqual({
      ok: false,
      reason: 'the window list could not be read: the window list could not be read',
    })
    const p = r.panel()
    expect(windowList(p)?.rows).toEqual([])
    expect(windowList(p)?.empty).toContain('the window list could not be read')
    expect(fact(p, 'Capture service')).toBe('running')
    r.fake.windowsFail = null
    expect(await r.act({ action: 'refresh' })).toEqual({ ok: true })
    expect(windowList(r.panel())?.rows).toHaveLength(1)
  })

  it('is read by one request at a time', async () => {
    const r = await commentaryRig()
    let release!: () => void
    r.fake.windowsGate = new Promise<void>((resolve) => (release = resolve))
    await r.enter() // reads the list, which is slow
    expect(r.fake.windowListCalls).toBe(1)
    expect(await r.act({ action: 'refresh' })).toEqual({ ok: true })
    r.panel()
    r.panel()
    expect(r.fake.windowListCalls).toBe(1)
    release()
    await r.tick(0)
    expect(windowList(r.panel())?.rows).toHaveLength(1)
  })

  it('is not read again and again by a console that keeps asking for the panel', async () => {
    const r = await commentaryRig()
    r.panel()
    await r.tick(0)
    for (let i = 0; i < 5; i++) {
      r.panel()
      await r.tick(1000)
    }
    expect(r.fake.windowListCalls).toBe(1)
    await r.tick(10_000)
    r.panel()
    await r.tick(0)
    expect(r.fake.windowListCalls).toBe(2)
  })
})

describe('the interval', () => {
  it('is a number of seconds between 3 and 600, kept for the next run, and shown in the panel', async () => {
    const r = await commentaryRig()
    expect(await r.act({ action: 'set_interval', interval: '15' })).toEqual({ ok: true }) // typed text is a number too
    expect((await r.saved()).interval).toBe(15)
    expect(fact(r.panel(), 'Interval')).toBe('15 s after each comment')
    expect(button(r.panel(), 'set_interval')?.inputs[0]?.value).toBe(15)
    await r.act({ action: 'set_interval', interval: 1 })
    expect((await r.saved()).interval).toBe(3)
    await r.act({ action: 'set_interval', interval: 9999 })
    expect((await r.saved()).interval).toBe(600)
    await r.act({ action: 'set_interval', interval: 7.5 })
    expect((await r.saved()).interval).toBe(7.5)
  })

  it('is refused when it is not a number, and an empty field is not "zero seconds"', async () => {
    const r = await commentaryRig()
    await r.act({ action: 'set_interval', interval: 20 })
    for (const bad of [
      'abc',
      '',
      '   ',
      undefined,
      null,
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(await r.act({ action: 'set_interval', interval: bad }), String(bad)).toEqual({
        ok: false,
        reason: 'the interval has to be a number of seconds',
      })
    }
    expect((await r.saved()).interval).toBe(20)
  })

  it('outlives the mode being left and entered, and the memory being cleared', async () => {
    const r = await commentaryRig({ settings: { analysis_every: 0 } })
    await r.act({ action: 'set_interval', interval: 30 })
    await r.enter()
    await r.tick(1500)
    await r.act({ action: 'clear_memory' })
    await r.exit()
    await r.enter()
    await r.tick(1500)
    expect(r.f.told).toHaveLength(2)
    await r.tick(29_900)
    expect(r.f.told).toHaveLength(2)
    await r.tick(200)
    expect(r.f.told).toHaveLength(3)
  })
})

describe('pause and resume', () => {
  it('stop the looking and start it again at once, and the panel follows', async () => {
    const r = await commentaryRig({ settings: { analysis_every: 0 } })
    await r.enter()
    expect(await r.act({ action: 'pause' })).toEqual({ ok: true })
    await r.tick(0)
    expect(r.panel()?.status).toBe('paused')
    expect(button(r.panel(), 'resume')?.label).toBe('Resume')
    expect(button(r.panel(), 'pause')).toBeUndefined()
    await r.tick(60_000)
    expect(r.fake.calls).toHaveLength(0)
    expect(r.f.llm.requests).toHaveLength(0)
    expect(r.alarms()).toEqual([])

    expect(await r.act({ action: 'resume' })).toEqual({ ok: true })
    await r.tick(0)
    expect(r.f.told).toHaveLength(1)
    expect(button(r.panel(), 'pause')?.label).toBe('Pause')
  })

  it('finish the comment in progress, and a pause in the middle of a wait holds the next look', async () => {
    const r = await commentaryRig({ settings: { analysis_every: 0 } })
    await r.enter()
    await r.tick(1500)
    expect(r.f.told).toHaveLength(1)
    await r.tick(3000)
    await r.act({ action: 'pause' })
    await r.tick(30_000)
    expect(r.f.told).toHaveLength(1)
  })

  it('are refused when the mode is not running, and the pause does not outlive the run', async () => {
    const r = await commentaryRig()
    expect(await r.act({ action: 'pause' })).toEqual({
      ok: false,
      reason: 'the mode is not running',
    })
    expect(await r.act({ action: 'resume' })).toEqual({
      ok: false,
      reason: 'the mode is not running',
    })
    await r.enter()
    await r.act({ action: 'pause' })
    await r.exit()
    await r.enter()
    await r.tick(1500)
    expect(r.f.told).toHaveLength(1)
    expect(r.ctl.status().paused).toBe(false)
  })
})

describe('the test picture', () => {
  it('takes a picture now, without the model, and the panel says how it turned out', async () => {
    const r = await commentaryRig()
    expect(await r.act({ action: 'test' })).toEqual({ ok: true }) // the service is up even though the mode is not
    expect(r.fake.calls).toHaveLength(1)
    expect(r.f.llm.requests).toHaveLength(0)
    expect(r.f.told).toHaveLength(0)
    expect(fact(r.panel(), 'Last test picture')).toMatch(
      /^1280x720 sent as 768x432, brightness 60, printwindow, \d+ s ago$/
    )
    expect(fact(r.panel(), 'Last capture')).toBeUndefined() // that is the loop's own
  })

  it('shows a black picture as black and leaves the counters and alarms of the loop alone', async () => {
    const r = await commentaryRig({ settings: { black_alarm_after: 1 } })
    r.fake.script = [{ kind: 'frame', black: true }]
    await r.enter()
    r.fake.script = [{ kind: 'frame', black: true }]
    expect(await r.act({ action: 'test' })).toEqual({ ok: true })
    expect(fact(r.panel(), 'Last test picture')).toContain('(black)')
    expect(r.ctl.status().blackFrames).toBe(0)
    expect(r.alarms()).toEqual([])
  })

  it('says what went wrong when the picture cannot be taken', async () => {
    const r = await commentaryRig()
    r.fake.windows = []
    const answer = (await r.act({ action: 'test' })) as { ok: boolean; reason: string }
    expect(answer.ok).toBe(false)
    expect(answer.reason).toContain('no visible window matches "Some Game"')
    expect(fact(r.panel(), 'Last test picture')).toContain('failed: no visible window matches')
    expect(r.alarms()).toEqual([]) // the operator asked and was told; nothing is left on the alarm board

    r.svc.status = 'stopped'
    expect(await r.act({ action: 'test' })).toMatchObject({ ok: false })
  })

  it('needs a window to look at', async () => {
    const r = await commentaryRig({ settings: { window: null } })
    expect(await r.act({ action: 'test' })).toEqual({
      ok: false,
      reason: 'no window is chosen yet',
    })
  })

  it('works while the mode is paused', async () => {
    const r = await commentaryRig()
    await r.enter()
    await r.act({ action: 'pause' })
    expect(await r.act({ action: 'test' })).toEqual({ ok: true })
  })
})

describe('looking again, and forgetting', () => {
  it('asks for the game again at the next picture, also when the mode is not yet entered', async () => {
    const first = await commentaryRig({ settings: { analysis_every: 0 } })
    await first.enter()
    await first.tick(1500)
    await first.saved()

    const r = await commentaryRig({
      dataDir: first.f.host.dataDir,
      settings: { analysis_every: 0 },
    })
    expect(await r.act({ action: 'reidentify' })).toEqual({ ok: true })
    await r.enter()
    await r.tick(1500)
    // the game was known and recent, and it still asked
    expect(r.llm('commentary-identify')).toHaveLength(1)
    expect(r.f.events.join('\n')).toContain('identify the game again')
  })

  it('forgets the game and the story while the mode is not entered too, and keeps the window and the interval', async () => {
    const first = await commentaryRig({ settings: { summary_every: 2 } })
    await first.enter()
    await first.tick(1500)
    await first.tick(8000)
    await first.act({ action: 'use_window', title: 'exe:javaw.exe' })
    await first.act({ action: 'set_interval', interval: 12 })
    await first.saved()

    const r = await commentaryRig({ dataDir: first.f.host.dataDir })
    expect(await r.act({ action: 'clear_memory' })).toEqual({ ok: true })
    const saved = await r.saved()
    expect(saved).toMatchObject({ game: '', summary: '', rounds: 0, pending: [], interval: 12 })
    expect(saved.window).toEqual({ id: null, title: 'exe:javaw.exe', process: '' })
    expect(button(r.panel(), 'clear_memory')?.confirm).toContain('Forget')
  })
})

describe('what the console asks for', () => {
  it('starts the mode with the Enter button, and again does no harm', async () => {
    const r = await commentaryRig()
    expect(await r.act({ replace: false, force: false })).toEqual({ ok: true })
    expect(r.service.state('commentary')).toBe('ACTIVE')
    expect(await r.act({ action: 'start' })).toEqual({ ok: true })
    await r.tick(1500)
    expect(r.f.told).toHaveLength(1)
  })

  it('says why the mode could not be started', async () => {
    const r = await commentaryRig({
      pack: (real) => {
        const prompts = new Map(real.prompts)
        prompts.delete('identify')
        return { ...real, prompts }
      },
    })
    const answer = (await r.act({ action: 'start' })) as { ok: boolean; reason: string }
    expect(answer.ok).toBe(false)
    expect(answer.reason).toContain('the commentary pack is incomplete: no prompts/identify.md')
  })

  it('answers an action it does not know with a reason, without doing anything', async () => {
    const r = await commentaryRig()
    expect(await r.act({ action: 'dance' })).toEqual({
      ok: false,
      reason: 'the commentary mode has no action "dance"',
    })
    const long = (await r.act({ action: 'x'.repeat(100) })) as { reason: string }
    expect(long.reason).toBe(`the commentary mode has no action "${'x'.repeat(40)}"`)
    expect(r.fake.calls).toHaveLength(0)
  })
})
