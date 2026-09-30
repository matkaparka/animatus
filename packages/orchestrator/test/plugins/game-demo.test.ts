/**
 * The shipped manifest of the demo worker (`plugins/game-demo`), and the real service started by the real supervisor,
 * driven through the worker client and the events feed: the Worker protocol against a real process, restart included.
 * The second half needs Windows and a Python (the repository's light environment, or ANIMATUS_TEST_PYTHON).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import type { ProcessRuntime } from '../../src/plugins/registry.ts'
import { WorkerClient, WorkerFeed } from '../../src/workers/index.ts'
import {
  GUARD_SCRIPT,
  IS_WINDOWS,
  LIGHT_PYTHON,
  REPO_ROOT,
  cleanupAll,
  makeSupervisor,
  trackPid,
  waitFor,
} from './helpers.ts'

afterEach(cleanupAll)

const PYTHON = LIGHT_PYTHON ?? process.env.ANIMATUS_TEST_PYTHON
const CAN_RUN = IS_WINDOWS && PYTHON !== undefined && existsSync(PYTHON)

async function entry() {
  const registry = await PluginRegistry.scan(path.join(REPO_ROOT, 'plugins'))
  const found = registry.get('game-demo')
  expect(found, 'plugins/game-demo/plugin.yaml should load').toBeDefined()
  return { registry, entry: found! }
}

describe('the shipped manifest', () => {
  it('is a loopback process that provides the game service, needs no GPU and no secret, and stops politely', async () => {
    const { registry, entry: e } = await entry()
    expect(registry.errors().filter((x) => x.dir.endsWith('game-demo'))).toEqual([])
    expect(e.service).toBe('game')
    expect(e.manifest).toMatchObject({
      kind: 'custom',
      provides: ['game.worker'],
      resources: { gpu: false },
      runtime: { type: 'process', env: 'light', port: 'auto', guard: true },
    })
    expect((e.manifest.runtime as ProcessRuntime).stop.http).toEqual({
      method: 'POST',
      path: '/shutdown',
    })
    expect(e.manifest.secrets).toEqual([])
  })

  it('the shared kit is not taken for a plugin', async () => {
    const registry = await PluginRegistry.scan(path.join(REPO_ROOT, 'plugins'))
    expect(registry.get('_worker')).toBeUndefined()
    expect(registry.errors().filter((x) => x.dir.includes('_worker'))).toEqual([])
  })
})

describe.skipIf(!CAN_RUN)('the real demo worker under the real supervisor', () => {
  it('is paused when it starts, plays when told, takes a directive, forgets on request, and a restart is a new epoch', async () => {
    process.env.GAME_DEMO_TICK = '0.05'
    const { entry: e } = await entry()
    const supervisor = await makeSupervisor([e], {
      interpreters: { light: PYTHON as string },
      guard: { script: GUARD_SCRIPT, python: PYTHON as string },
    })
    const started = await supervisor.start('game-demo')
    expect(started.status).toBe('ready')
    expect(started.health).toMatchObject({
      ok: true,
      ready: true,
      service: 'game',
      config: { worker: 'game-demo' },
    })
    trackPid(started.pid)
    const client = new WorkerClient({
      baseUrl: started.url as string,
      expect: 'game-demo',
      timeoutMs: 3000,
    })

    // it starts paused, and online (the pretend game is always there)
    const first = await client.state()
    expect(first).toMatchObject({ protocol: 1, worker: 'game-demo', paused: true, online: true })
    const feed = new WorkerFeed(client)
    feed.startFrom(first)

    // told to play, it plays: turns are events
    expect(await client.pause(false)).toBe(false)
    await waitFor(async () => (await client.state()).latest_seq >= 3, 10_000, 'three events')
    const polled = await feed.poll()
    expect(polled.reset).toBe(false)
    expect(polled.events.map((x) => x.kind)).toContain('turn')
    for (const ev of polled.events) expect(['immediate', 'soon', 'later']).toContain(ev.urgency)

    // a directive is picked up on the next turn and shows in the summary
    await client.command('focus on gold')
    await waitFor(
      async () => (await client.state()).summary.includes('focus on gold'),
      10_000,
      'the directive'
    )
    expect((await client.state()).last_command?.text).toBe('focus on gold')
    expect((await feed.poll()).events.some((x) => x.kind === 'plan')).toBe(true)

    // forgetting drops what it carries and leaves the numbers alone
    const before = (await client.state()).latest_seq
    await client.forget()
    await waitFor(async () => (await client.state()).facts.notes === 0, 10_000, 'the notes to go')
    expect((await client.state()).latest_seq).toBeGreaterThanOrEqual(before)

    // paused again, it stops
    expect(await client.pause(true)).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    const paused = (await client.state()).latest_seq
    await new Promise((r) => setTimeout(r, 400))
    expect((await client.state()).latest_seq).toBe(paused)

    // a restart: another process, another epoch; the reader is told to start over
    const oldEpoch = (await client.state()).epoch
    const restarted = await supervisor.restart('game-demo')
    expect(restarted.status).toBe('ready')
    trackPid(restarted.pid)
    const again = new WorkerClient({
      baseUrl: restarted.url as string,
      expect: 'game-demo',
      timeoutMs: 3000,
    })
    const second = await again.state()
    expect(second.epoch).not.toBe(oldEpoch)
    expect(second.paused).toBe(true) // and it starts paused again
    const afterRestart = await new WorkerFeed(again).poll()
    expect(afterRestart.reset).toBe(false)
    // the old reader, pointed at the new process, is told the numbers it had are void
    const stale = await again.events(paused, oldEpoch)
    expect(stale.reset).toBe(true)
    expect(stale.epoch).toBe(second.epoch)
  }, 60_000)
})
