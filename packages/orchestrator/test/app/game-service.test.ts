/**
 * The game mode against the REAL Python demo worker (`plugins/game-demo`), started and stopped by the real supervisor from
 * the manifest that ships (with three changes, see `manifestCopy`), inside the real App: the two languages meet here. What
 * the worker reports is read by the TypeScript client and turned into comments; what the character decides goes back as
 * directives that the Python side validates; the worker is a process that starts paused, is resumed by the mode, is paused
 * and stopped when the mode ends, and, killed, is restarted by the supervisor under the same address, which the mode notices
 * and answers by resuming it. The model, the voice and the stage page are scripted.
 *
 * Needs the repository's light Python environment (or one named in ANIMATUS_TEST_PYTHON); skipped without it.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LlmRequest } from '../../src/llm/types.ts'
import { LIGHT_PYTHON, pidAlive, waitFor } from '../plugins/helpers.ts'
import { danmaku, installCleanup, rig, until } from './rig.ts'
import type { Rig } from './rig.ts'

installCleanup()

const PYTHON = LIGHT_PYTHON ?? process.env.ANIMATUS_TEST_PYTHON
const CAN_RUN = PYTHON !== undefined && existsSync(PYTHON)
const REPO = path.resolve(__dirname, '../../../..')
const DEMO_DIR = path.join(REPO, 'plugins', 'game-demo')
const MODES = path.join(REPO, 'modes')
const NO_FLAGS = { replace: false, force: false }
const FENCE = '`'.repeat(3)
const call = (tool: string, args: unknown = {}) =>
  `${FENCE}tool\n${JSON.stringify({ tool, args })}\n${FENCE}`
const fwd = (p: string) => p.replaceAll('\\', '/')

const lastText = (req: LlmRequest): string => {
  const c = req.messages.at(-1)?.content
  return typeof c === 'string'
    ? c
    : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')
}
const isNews = (req: LlmRequest) =>
  req.tag === 'chat' && lastText(req).includes('News from the game agent')

/**
 * The manifest that ships, changed in the only ways a test needs: the interpreter comes from the plugin config (no virtual
 * environment inside the temporary project), no job guard (its own tests cover it), the plugin's own folder as the working
 * directory (the copy lives in the temporary project), and a quick tick, so that turns are events within a second.
 */
async function manifestCopy(): Promise<string> {
  let text = await readFile(path.join(DEMO_DIR, 'plugin.yaml'), 'utf8')
  const swap = (from: string, to: string) => {
    if (!text.includes(from))
      throw new Error(`plugins/game-demo/plugin.yaml no longer has "${from}": update this test`)
    text = text.replace(from, to)
  }
  swap('env: light', 'env: external')
  swap('guard: true', 'guard: false')
  swap('cwd: "{plugin_dir}"', `cwd: ${JSON.stringify(fwd(DEMO_DIR))}`)
  swap('  port: auto', '  port: auto\n  env_vars: { GAME_DEMO_TICK: "0.15" }')
  return text
}

async function demoRig(settings: Record<string, unknown> = {}): Promise<Rig> {
  const r = await rig({
    app: { modesDirs: [MODES] },
    prepare: async (dir) => {
      await mkdir(path.join(dir, 'plugins', 'game-demo'), { recursive: true })
      await writeFile(path.join(dir, 'plugins', 'game-demo', 'plugin.yaml'), await manifestCopy())
      return {
        plugins: { 'game-demo': { enabled: true, config: { python: fwd(PYTHON as string) } } },
        modes: {
          game: { enabled: true, config: { poll_sec: 0.5, comment_gap_sec: 0, ...settings } },
        },
      }
    },
  })
  await r.connect()
  await until(() => r.app.stage.hub.connected, 3000, 'the stage page')
  return r
}

const status = (r: Rig) => r.app.supervisor.getStatus('game-demo')
const workerState = async (r: Rig) => {
  const res = await fetch(`${status(r).url}/worker/state`)
  return (await res.json()) as {
    epoch: string
    paused: boolean
    latest_seq: number
    summary: string
    facts: Record<string, unknown>
  }
}

describe.runIf(CAN_RUN)('the game mode with the real demo worker', { timeout: 90_000 }, () => {
  it('the mode starts the worker, resumes it, comments on its milestones, steers it, pauses and stops it', async () => {
    const r = await demoRig()
    let told = 0
    r.llm.reply = (req) => {
      if (!isNews(req)) return ['[neutral]Okay.']
      told++
      return told === 1
        ? ['[happy]A new district, lovely. ', call('game_command', { text: 'focus on gold' })]
        : ['[neutral]Another one.']
    }
    await r.app.modeAction('game', 'enter', NO_FLAGS)
    await until(
      () => r.app.modes.state('game') === 'ACTIVE',
      60_000,
      'the mode (and the worker) to be on'
    )
    expect(status(r).status).toBe('ready')
    const pid = status(r).pid as number
    expect(pidAlive(pid)).toBe(true)
    expect((await workerState(r)).paused).toBe(false) // it started paused; the mode resumed it

    // the fifth turn is a milestone, `immediate`: the character says something about it
    await until(() => r.llm.requests.some(isNews), 30_000, 'the first comment')
    const first = r.llm.requests.find(isNews)!
    expect(lastText(first)).toMatch(
      /- milestone \(\d+ s ago\): "Turn 5: \d+ gold, a new district is ready"/
    )

    // and steers it: the directive reaches the Python side, which keeps it and shows it in its summary
    await waitFor(
      async () => (await workerState(r)).summary.includes('focus on gold'),
      20_000,
      'the directive'
    )
    expect(
      r.app.runLog
        .recent(300)
        .some((e) => e.text === 'ran game_command (sent to the game agent) from system')
    ).toBe(true)
    expect(r.app.tools.pending()).toEqual([])

    // what the worker reports is in the prompt of every reply (the mode reads it every half second: wait until it has)
    await until(
      () =>
        r.app
          .modeViews()
          .find((m) => m.id === 'game')
          ?.panel?.facts.some(
            (f) => f.label === 'Situation' && f.value.includes('following: focus on gold')
          ) === true,
      10_000,
      'the mode to have read the summary'
    )
    r.bili.emit(danmaku('how is it going?'))
    await until(() => r.llm.requests.some((q) => lastText(q).includes('how is it going')), 8000)
    const chat = r.llm.requests.find((q) => lastText(q).includes('how is it going'))!
    expect(String(chat.messages[0]?.content)).toContain('You are playing game-demo on stream')
    expect(String(chat.messages[0]?.content)).toMatch(
      /Situation: Turn \d+, \d+ gold, following: focus on gold/
    )
    expect(String(chat.messages[0]?.content)).toMatch(/- gold: \d+/)

    // the operator's buttons reach it: pause stops the turns, resume starts them, forget drops its notes
    await r.app.modeAction('game', 'act', { ...NO_FLAGS, params: { action: 'pause' } })
    await new Promise((res) => setTimeout(res, 500))
    const paused = (await workerState(r)).latest_seq
    await new Promise((res) => setTimeout(res, 700))
    expect((await workerState(r)).latest_seq).toBe(paused)
    await r.app.modeAction('game', 'act', { ...NO_FLAGS, params: { action: 'resume' } })
    await waitFor(
      async () => (await workerState(r)).latest_seq > paused,
      10_000,
      'the turns to go on'
    )
    await r.app.modeAction('game', 'act', { ...NO_FLAGS, params: { action: 'forget' } })
    await waitFor(async () => (await workerState(r)).facts.notes === 0, 10_000, 'the notes to go')
    expect(r.app.alarms.list()).toEqual([])

    // leaving the mode: the mode pauses the worker, then the manager stops the process it started
    const stopped = await r.app.modeAction('game', 'exit', NO_FLAGS)
    expect(stopped.state).toBe('IDLE')
    expect(r.app.runLog.recent(300).some((e) => e.text.includes('could not be paused'))).toBe(false)
    await waitFor(() => status(r).status === 'stopped', 20_000, 'the worker to stop')
    await waitFor(() => !pidAlive(pid), 10_000, 'the process to be gone')
    expect(r.app.tools.tierOf('game_command')).toBeUndefined()
    expect(r.app.alarms.list()).toEqual([])
  })

  it('a worker that is killed is restarted by the supervisor; the mode raises an alarm, notices the new run, and resumes it', async () => {
    const r = await demoRig({ start_timeout_sec: 30 })
    r.llm.reply = (req) => (isNews(req) ? ['[neutral]Something changed.'] : ['[neutral]Okay.'])
    await r.app.modeAction('game', 'enter', NO_FLAGS)
    await until(() => r.app.modes.state('game') === 'ACTIVE', 60_000, 'the mode to be on')
    await until(() => r.llm.requests.some(isNews), 30_000, 'the first comment')
    const before = await workerState(r)
    const pid = status(r).pid as number

    process.kill(pid) // the game agent dies
    await until(
      () => r.app.alarms.list().some((a) => a.code === 'game_worker'),
      30_000,
      'the alarm'
    )
    expect(r.app.alarms.list().find((a) => a.code === 'game_worker')!.message).toMatch(
      /cannot reach|did not answer/
    )
    expect(r.app.modes.state('game')).toBe('ACTIVE') // the mode stays on and keeps trying

    // the supervisor starts it again, on the same address
    await waitFor(
      () => status(r).status === 'ready' && status(r).pid !== pid,
      40_000,
      'the worker to be back'
    )
    await until(
      () => !r.app.alarms.list().some((a) => a.code === 'game_worker'),
      30_000,
      'the alarm to go'
    )
    const after = await workerState(r)
    expect(after.epoch).not.toBe(before.epoch)

    // the mode noticed the new run: it said so, and the worker (which starts paused) plays again
    await until(
      () => r.app.runLog.recent(300).some((e) => e.text.includes('the game agent was restarted')),
      30_000,
      'the restart to be noticed'
    )
    await waitFor(async () => !(await workerState(r)).paused, 20_000, 'the worker to be resumed')
    const told = r.llm.requests.filter(isNews).map(lastText)
    await until(
      () =>
        r.llm.requests
          .filter(isNews)
          .some((q) => lastText(q).includes('The game agent was just restarted')),
      30_000,
      'the comment that tells the model'
    )
    expect(told.length).toBeGreaterThanOrEqual(1)
    await r.app.modeAction('game', 'exit', NO_FLAGS)
    await waitFor(() => status(r).status === 'stopped', 20_000, 'the worker to stop')
  })

  it('entered again after it ended, the worker is a new process and the mode starts from what it reports then', async () => {
    const r = await demoRig()
    await r.app.modeAction('game', 'enter', NO_FLAGS)
    await until(() => r.app.modes.state('game') === 'ACTIVE', 60_000, 'the mode to be on')
    const firstPid = status(r).pid as number
    const firstEpoch = (await workerState(r)).epoch
    await r.app.modeAction('game', 'exit', NO_FLAGS)
    await waitFor(() => !pidAlive(firstPid), 10_000, 'the first process to be gone')
    r.llm.requests.length = 0
    await r.app.modeAction('game', 'enter', NO_FLAGS)
    await until(() => r.app.modes.state('game') === 'ACTIVE', 60_000, 'the mode to be on again')
    expect(status(r).pid).not.toBe(firstPid)
    expect((await workerState(r)).epoch).not.toBe(firstEpoch)
    expect((await workerState(r)).paused).toBe(false)
    await r.app.modeAction('game', 'exit', NO_FLAGS)
  })
})
