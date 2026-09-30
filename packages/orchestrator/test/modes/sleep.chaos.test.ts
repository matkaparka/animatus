/**
 * Sleep mode under random events. Each seed builds a rig with random settings and then does a few dozen random things
 * (enter, leave, both at once, entering while the folder is still being read, replies that start and end speech, the
 * page going away and coming back, console buttons, the folder changing or failing, a stage that reports odd things about
 * the track, time passing), checking after every step what must always be true:
 *
 *  - the flag, the voice style, the holds and the alarms agree with whether the mode is running;
 *  - nothing is put on top of a whisper (no `sleep.play`, no `sleep.resume` while a reply has the track waiting), and a
 *    mode that is not running sends nothing but the one stop;
 *  - every message is valid for the protocol, and the console's panel is always one the console can show;
 *
 * and at the end, once the world is healthy again: the track is playing (the track always comes back), and after leaving
 * nothing is left, not a timer, a hold or a flag. A failing seed is named in the message with the steps that led to it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Rig } from './sleepRig.ts'
import { file, installSleepRig, rig, sleepBatch, tick } from './sleepRig.ts'

installSleepRig()

/** `SLEEP_CHAOS_SEEDS=5000` looks harder; `SLEEP_CHAOS_SEED=26` runs one seed and prints what the stage was sent. */
const SEEDS = Number(process.env.SLEEP_CHAOS_SEEDS) || 120
const STEPS = 80
const POOL = ['a', 'b', 'c', 'd', 'night/e']

/** mulberry32: any fixed sequence will do, and a seed reproduces a run. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
type Dice = () => number
const pick = <T>(list: readonly T[], dice: Dice): T => list[Math.floor(dice() * list.length)] as T
const int = (from: number, to: number, dice: Dice) => from + Math.floor(dice() * (to - from + 1))
const noop = () => undefined

interface Chaos {
  r: Rig
  dice: Dice
  loop: boolean
  /** Something is being said until `endSpeech`. */
  startSpeech(): void
  endSpeech(): void
  /** Set while the folder is being read and the read waits to be answered. */
  openFolder?: () => void
  /** Calls that were made while the folder was being read; they finish when it answers. */
  pending: Promise<unknown>[]
  /** Waits for a call that goes through the mode manager, unless the folder is being read: it would wait for that. */
  settle(call: Promise<unknown>): Promise<void> | undefined
  /** The folder answers, and what waited for it finishes. */
  answerFolder(): Promise<void>
  violations: string[]
}

interface Action {
  name: string
  weight: number
  run(c: Chaos): Promise<unknown> | unknown
}

const enter = (c: Chaos) => c.r.service.enter('sleep').then(noop, noop)
const leave = (c: Chaos) => c.r.service.exit('sleep', 'chaos').then(noop, noop)
const viaConsole = (c: Chaos, req: Record<string, unknown>) =>
  c.settle(c.r.ctl.onConsoleRequest!(req))

const ACTIONS: Action[] = [
  { name: 'enter', weight: 5, run: (c) => c.settle(enter(c)) },
  { name: 'exit', weight: 2, run: (c) => c.settle(leave(c)) },
  {
    name: 'enter-twice-at-once',
    weight: 1,
    run: (c) => c.settle(Promise.all([enter(c), enter(c)])),
  },
  {
    name: 'enter-and-exit-at-once',
    weight: 2,
    run: (c) => c.settle(Promise.all([enter(c), leave(c)])),
  },
  {
    name: 'exit-and-enter-at-once',
    weight: 1,
    run: (c) => c.settle(Promise.all([leave(c), enter(c)])),
  },
  {
    name: 'folder-is-slow',
    weight: 2,
    run: (c) => {
      if (c.openFolder) return
      let open!: () => void
      c.r.library.gate = new Promise<void>((res) => (open = res))
      c.openFolder = () => {
        c.r.library.gate = null
        open()
      }
      c.pending.push(enter(c)) // entering while the folder is being read
    },
  },
  { name: 'folder-answers', weight: 3, run: (c) => c.answerFolder() },
  {
    name: 'reply',
    weight: 7,
    run: async (c) => {
      c.startSpeech()
      await c.r.service.batchExtras(sleepBatch() as never)
    },
  },
  {
    name: 'reply-nobody-speaks',
    weight: 2,
    run: (c) => c.r.service.batchExtras(sleepBatch() as never),
  },
  { name: 'speech-ends', weight: 7, run: (c) => c.endSpeech() },
  { name: 'speech-starts', weight: 2, run: (c) => c.startSpeech() },
  {
    name: 'speech-times-out',
    weight: 1,
    run: (c) => void (c.r.speech.answer = !c.r.speech.answer),
  },
  {
    name: 'old-report',
    weight: 2,
    run: (c) =>
      c.r.hub.emit('sleep.state', {
        type: 'sleep.state',
        track_id: 'sleep-99999',
        phase: pick(['ended', 'error', 'playing', 'paused', 'off'], c.dice),
      }),
  },
  {
    // a stage that says things about the current track that did not happen
    name: 'odd-report',
    weight: 3,
    run: (c) => {
      const id = c.r.hub.attempted.filter((m) => m.type === 'sleep.play').at(-1)?.track_id
      c.r.hub.emit('sleep.state', {
        type: 'sleep.state',
        ...(id && c.dice() < 0.9 ? { track_id: id } : {}),
        phase: pick(['loading', 'playing', 'paused', 'ended', 'error', 'off'], c.dice),
        ...(c.dice() < 0.5 ? { error: 'odd' } : {}),
      })
    },
  },
  { name: 'page-away', weight: 2, run: (c) => c.r.hub.connected && c.r.hub.disconnectStage() },
  {
    name: 'page-back',
    weight: 3,
    run: (c) => {
      if (c.r.hub.connected) return
      if (c.r.ctl.status().replying) REACHED.add('a reply and a page that came back')
      c.r.hub.connectStage()
    },
  },
  { name: 'console-next', weight: 3, run: (c) => viaConsole(c, { action: 'next' }) },
  {
    name: 'console-play',
    weight: 3,
    run: (c) => viaConsole(c, { action: 'play', row: pick([...POOL, 'nothing'], c.dice) }),
  },
  { name: 'console-start', weight: 2, run: (c) => viaConsole(c, {}) },
  {
    name: 'console-volume',
    weight: 3,
    run: (c) => {
      const st = c.r.ctl.status()
      const volume = pick([0, 0.2, 0.5, 1, 1.5, -1, 'x'], c.dice)
      if (st.running && st.stage === 'playing' && !st.replying && typeof volume === 'number')
        REACHED.add('a volume that changed under a playing track')
      return viaConsole(c, { action: 'volume', volume })
    },
  },
  { name: 'console-test-line', weight: 2, run: (c) => viaConsole(c, { action: 'whisper_test' }) },
  { name: 'console-stop', weight: 1, run: (c) => viaConsole(c, { action: 'stop' }) },
  { name: 'view-panel', weight: 2, run: (c) => c.r.service.viewOf('sleep') },
  {
    name: 'library-changes',
    weight: 2,
    run: (c) => {
      c.r.library.tracks = POOL.filter(() => c.dice() < 0.6).map((k) => file(k))
      c.r.clock.now += 20_000
      c.r.service.viewOf('sleep') // looking at the panel is what reads the folder again
    },
  },
  {
    name: 'library-fails',
    weight: 1,
    run: (c) => void (c.r.library.fails = c.r.library.fails ? null : 'EPERM'),
  },
  {
    name: 'stage-mode',
    weight: 2,
    run: (c) =>
      void (c.r.hub.stage.opts.mode = pick(
        ['auto', 'auto', 'auto', 'error', 'silent', 'stuck'],
        c.dice
      )),
  },
  {
    name: 'stage-cannot-play',
    weight: 1,
    run: (c) => {
      const broken = c.r.hub.stage.opts.broken
      broken.clear()
      for (const k of POOL) if (c.dice() < 0.3) broken.add(`${k.split('/').at(-1)}.mp3`)
    },
  },
  { name: 'tick-short', weight: 8, run: (c) => tick(int(1, 400, c.dice)) },
  { name: 'tick-long', weight: 4, run: (c) => tick(int(1_000, 12_000, c.dice)) },
]
const TOTAL = ACTIONS.reduce((n, a) => n + a.weight, 0)
const choose = (dice: Dice): Action => {
  let at = dice() * TOTAL
  for (const a of ACTIONS) if ((at -= a.weight) < 0) return a
  return ACTIONS[0] as Action
}

/**
 * What the seeds have got to so far. A random test that quietly stops reaching the interesting states proves nothing, so
 * the test at the end insists that every one of these was seen at least once.
 */
const REACHED = new Set<string>()
const MUST_REACH = [
  'running',
  'entering while the folder is being read',
  'a reply while the track is playing',
  'a reply that paused the track',
  'a reply with no track to pause',
  'a reply and a page that came back',
  'a track that ended',
  'a track that could not be played',
  'no track could be played',
  'the playlist ended',
  'no tracks at all',
  'a stage that never answers a track',
  'a reply that was cut off at the longest wait',
  'a page that was waiting for the stage',
  'a volume that changed under a playing track',
  'a shuffled round',
]

/** What must be true after every step. */
function check(c: Chaos, where: string): void {
  const { r } = c
  const st = r.ctl.status()
  const ctx = `${where}\n`
  if (st.running) REACHED.add('running')
  if (st.running && st.replying && st.stage === 'paused')
    REACHED.add('a reply that paused the track')
  if (st.running && st.replying && st.idle !== null) REACHED.add('a reply with no track to pause')
  if (st.running && st.replying && st.stage === 'playing')
    REACHED.add('a reply while the track is playing')
  if (r.service.state('sleep') === 'STARTING')
    REACHED.add('entering while the folder is being read')
  if (st.idle === 'failed') REACHED.add('no track could be played')
  if (st.idle === 'finished') REACHED.add('the playlist ended')
  if (st.idle === 'empty') REACHED.add('no tracks at all')
  expect(r.flags.sleeping, `${ctx}the flag`).toBe(st.running)
  expect(r.service.state('sleep') === 'ACTIVE', `${ctx}the manager agrees`).toBe(st.running)
  expect(r.styles.at(-1) === 'whisper', `${ctx}the voice style`).toBe(st.running)
  const held = r.held.reduce((n, [, on]) => n + (on ? 1 : -1), 0)
  expect([0, 1], `${ctx}holds (${held})`).toContain(held)
  if (!st.running) {
    expect(held, `${ctx}nothing held while not running`).toBe(0)
    expect(r.alarms, `${ctx}no alarms while not running`).toEqual([])
  }
  for (const a of r.alarms) expect(['sleep_tracks', 'sleep_whisper_style'], ctx).toContain(a.code)
  expect(c.violations, ctx).toEqual([])
  expect(
    r.logs.filter((l) => l.includes('was refused') || l.includes('could not be finished')),
    `${ctx}no message refused, no wait that failed`
  ).toEqual([])
  expect(
    r.events.filter((e) => e.includes('protocol refused')),
    ctx
  ).toEqual([])
  const view = r.service.viewOf('sleep')
  expect(view.panel, `${ctx}the panel`).toBeDefined()
  expect(view.panel!.status!.length).toBeGreaterThan(0)
}

/** The world is healthy again: what must then hold. */
async function healAndCheck(c: Chaos, where: string): Promise<void> {
  const { r } = c
  await c.answerFolder()
  c.endSpeech()
  r.speech.answer = true
  r.hub.stage.opts.mode = 'auto'
  r.hub.stage.opts.broken.clear()
  r.library.fails = null
  r.library.tracks = ['a', 'b', 'c'].map((k) => file(k))
  if (!r.hub.connected) r.hub.connectStage()
  r.clock.now += 60_000
  r.service.viewOf('sleep')
  await tick(500)
  // a page that has just connected is what gives a playlist that gave up another chance
  r.hub.disconnectStage()
  r.hub.connectStage()
  await tick(120_000)
  const st = r.ctl.status()
  const ctx = `${where}\nafter healing: ${JSON.stringify(st)}\n`
  if (!st.running) return
  expect(st.replying, `${ctx}the reply is over`).toBe(false)
  if (st.idle === null) {
    // a short track is loading for part of every round, so give it a moment rather than look at one instant
    let waited = 0
    while (r.hub.stage.phase !== 'playing' && waited < 3_000) {
      await tick(5)
      waited += 5
    }
    expect(r.hub.stage.phase, `${ctx}the track came back`).toBe('playing')
  } else {
    expect(st.idle, ctx).toBe('finished')
    expect(c.loop, `${ctx}only a playlist that does not repeat may be over`).toBe(false)
  }
  check(c, `${where}\nafter healing`)
}

async function scenario(seed: number): Promise<void> {
  const dice = seeded(seed)
  const loop = dice() < 0.7
  const shuffle = dice() < 0.4
  const r = await rig({
    settings: {
      shuffle,
      loop,
      fade_s: pick([0, 0.3, 1], dice),
      fade_in_s: pick([0, 1.5], dice),
      reply_resume_delay_s: pick([0, 0.3, 1.5], dice),
      reply_max_wait_s: pick([5, 12, 120], dice),
      start_timeout_s: pick([5, 20], dice),
      captions: dice() < 0.8,
    },
    stage: { trackMs: pick([300, 1_000, 6_000], dice), loadMs: pick([5, 20, 250], dice) },
    tracks: POOL.filter(() => dice() < 0.7).map((k) => file(k)),
    random: dice,
  })
  let release: (() => void) | undefined
  const violations: string[] = []
  const c: Chaos = {
    r,
    dice,
    loop,
    violations,
    pending: [],
    startSpeech() {
      if (r.speech.busy) return
      r.speech.busy = true
      r.speech.wait = new Promise<void>((res) => {
        release = () => {
          r.speech.busy = false
          r.speech.wait = null
          res()
        }
      })
    },
    endSpeech() {
      release?.()
      release = undefined
    },
    settle(call) {
      const done = call.then(noop, noop)
      if (!c.openFolder) return done
      c.pending.push(done)
      return undefined
    },
    async answerFolder() {
      if (!c.openFolder) return
      c.openFolder()
      c.openFolder = undefined
      await Promise.all(c.pending.splice(0))
    },
  }
  // what the stage was sent and told, to follow a failing seed by eye
  const trace: string[] = []
  let step = -1
  const note = (line: string) => trace.push(`[${step}] ${line}`)
  r.hub.on('sleep.state', (m: Record<string, unknown>) => note(`< ${m.phase} ${m.track_id}`))
  // nothing may be put on top of a whisper, and a mode that is not running only ever sends its one stop
  const send = r.hub.send.bind(r.hub)
  r.hub.send = (m) => {
    const track =
      String(m.url ?? '')
        .split('/')
        .at(-1) ?? ''
    note(`> ${m.type} ${m.track_id ?? ''} ${track}`)
    const st = r.ctl.status()
    if ((m.type === 'sleep.play' || m.type === 'sleep.resume') && st.replying)
      violations.push(`${m.type} while a reply has the track waiting`)
    if (m.type.startsWith('sleep.') && !st.running && m.type !== 'sleep.stop')
      violations.push(`${m.type} while the mode is not running`)
    return send(m)
  }

  const done: string[] = []
  try {
    for (let i = 0; i < STEPS; i++) {
      step = i
      const action = choose(dice)
      done.push(action.name)
      const where = `seed ${seed}, step ${i}: ${done.slice(-12).join(' > ')}`
      await action.run(c)
      await tick(0)
      check(c, where)
    }
    step = STEPS
    await healAndCheck(c, `seed ${seed}: ${done.slice(-12).join(' > ')}`)

    // leaving leaves nothing
    c.endSpeech()
    await r.service.exit('sleep', 'chaos')
    await tick(60_000)
    const end = `seed ${seed} at the end`
    expect(r.flags.sleeping, end).toBe(false)
    expect(r.styles.at(-1) ?? null, `${end}: the voice style`).toBeNull()
    expect(
      r.held.reduce((n, [, on]) => n + (on ? 1 : -1), 0),
      `${end}: holds`
    ).toBe(0)
    expect(r.alarms, end).toEqual([])
    r.hub.stage.reset()
    expect(vi.getTimerCount(), `${end}: timers left`).toBe(0)

    const saw = (label: string, found: boolean) => found && REACHED.add(label)
    saw(
      'a track that ended',
      trace.some((l) => l.includes('< ended sleep-'))
    )
    saw(
      'a track that could not be played',
      r.events.some((e) => e.includes('cannot read the track'))
    )
    saw(
      'a stage that never answers a track',
      r.events.some((e) => e.includes('did not start it within'))
    )
    saw(
      'a reply that was cut off at the longest wait',
      r.logs.some((l) => l.includes('kept the track waiting for'))
    )
    saw(
      'a page that was waiting for the stage',
      r.events.some((e) => e.includes('waiting for a stage page to connect'))
    )
    saw('a shuffled round', shuffle && r.plays().length >= 3)
  } catch (e) {
    const flow = trace.slice(-80).join('\n')
    const log = r.events.slice(-25).join('\n')
    throw new Error(
      `${(e as Error).message}\n--- the stage (last 80):\n${flow}\n--- the run log (last 25):\n${log}`,
      { cause: e }
    )
  }
}

const only = Number(process.env.SLEEP_CHAOS_SEED)

describe('sleep mode under random events', () => {
  it(
    `keeps its promises for ${SEEDS} seeds of ${STEPS} steps`,
    { timeout: 60_000 + SEEDS * 200 },
    async () => {
      if (only) return void (await scenario(only))
      for (let seed = 1; seed <= SEEDS; seed++) await scenario(seed)
      expect(
        MUST_REACH.filter((s) => !REACHED.has(s)),
        'states the random steps never got to (the test would prove nothing about them)'
      ).toEqual([])
    }
  )
})
