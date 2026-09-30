import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginDisabledError, UnknownPluginError } from '../../src/plugins/supervisor.ts'
import {
  cleanupAll,
  externalEntry,
  fakeEntry,
  inprocessEntry,
  makeSupervisor,
  makeTempDir,
  pidAlive,
  readInfo,
  recordStatuses,
  sleep,
  statusNames,
  trackPid,
  waitFor,
  waitForGone,
  waitForStatus,
  type FakeOptions,
  type MakeSupervisorOptions,
} from './helpers.ts'

afterEach(cleanupAll)

/** One fake service under a fresh supervisor, with an info file for its pids. */
async function setup(options: FakeOptions & { supervisor?: MakeSupervisorOptions } = {}) {
  const dir = await makeTempDir()
  const infoFile = join(dir, 'info.json')
  const runsFile = join(dir, 'runs.txt')
  const { supervisor: supervisorOptions, ...fake } = options
  const entry = fakeEntry(dir, {
    ...fake,
    args: ['--info-file', infoFile, '--state-file', runsFile, ...(fake.args ?? [])],
  })
  const supervisor = await makeSupervisor([entry], supervisorOptions)
  const events = recordStatuses(supervisor, entry.id)
  const runs = async () => Number(await readFile(runsFile, 'utf8').catch(() => '0'))
  return { dir, infoFile, runsFile, runs, entry, supervisor, events, id: entry.id }
}

async function control(url: string | undefined, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${url}/control`, { method: 'POST', body: JSON.stringify(body) })
  expect(response.status).toBe(200)
}

describe('starting and stopping', () => {
  it('starts a service, waits for a healthy answer, and stops it', async () => {
    const { supervisor, events, infoFile, id } = await setup()
    expect(supervisor.getStatus(id)).toEqual({ status: 'stopped', restarts: 0 })

    const state = await supervisor.start(id)
    expect(state.status).toBe('ready')
    expect(state.pid).toBeTypeOf('number')
    expect(state.port).toBeGreaterThanOrEqual(1024)
    expect(state.url).toBe(`http://127.0.0.1:${state.port}`)
    expect(state.restarts).toBe(0)
    expect(state.lastError).toBeUndefined()
    expect(Math.abs((state.startedAt ?? 0) - Date.now())).toBeLessThan(15_000)
    expect(state.health).toMatchObject({
      ok: true,
      ready: true,
      service: 'fake',
      version: '1.2.3',
      config: { flavour: 'test' },
    })
    expect((await readInfo(infoFile)).pid).toBe(state.pid) // no guard: the pid is the service itself
    expect((await fetch(`${state.url}/health`)).status).toBe(200)
    expect(
      supervisor.logs(id).some((line) => line.startsWith('[supervisor] started process'))
    ).toBe(true)

    const stopped = await supervisor.stop(id)
    expect(stopped).toEqual({ status: 'stopped', restarts: 0 })
    await waitForGone(state.pid ?? 0)
    expect(
      events.map(({ id: eventId, status, previous }) => ({ eventId, status, previous }))
    ).toEqual([
      { eventId: id, status: 'starting', previous: 'stopped' },
      { eventId: id, status: 'ready', previous: 'starting' },
      { eventId: id, status: 'stopping', previous: 'ready' },
      { eventId: id, status: 'stopped', previous: 'stopping' },
    ])
  })

  it('joins a start that is already in progress, and returns at once when the service is ready', async () => {
    const { supervisor, events, id } = await setup()
    const [a, b] = await Promise.all([supervisor.start(id), supervisor.start(id)])
    expect(a.status).toBe('ready')
    expect(b.pid).toBe(a.pid)
    expect(statusNames(events)).toEqual(['starting', 'ready']) // one spawn
    expect((await supervisor.start(id)).pid).toBe(a.pid)
    expect(statusNames(events)).toEqual(['starting', 'ready'])
  })

  it('stopping a stopped service is harmless, and a service can be started again after stop', async () => {
    const { supervisor, id } = await setup()
    expect((await supervisor.stop(id)).status).toBe('stopped')
    const first = await supervisor.start(id)
    await supervisor.stop(id)
    const second = await supervisor.start(id)
    expect(second.status).toBe('ready')
    expect(second.pid).not.toBe(first.pid)
    await waitForGone(first.pid ?? 0)
  })

  it('restart() replaces the process and keeps the port', async () => {
    const { supervisor, id } = await setup()
    const first = await supervisor.start(id)
    const second = await supervisor.restart(id)
    expect(second.status).toBe('ready')
    expect(second.pid).not.toBe(first.pid)
    expect(second.port).toBe(first.port)
    await waitForGone(first.pid ?? 0)
  })

  it('fails and kills the process when it does not become healthy within start_timeout_ms', async () => {
    const { supervisor, events, infoFile, id } = await setup({
      args: ['--never-ready'],
      health: { start_timeout_ms: 500 },
    })
    const started = Date.now()
    const state = await supervisor.start(id)
    expect(state.status).toBe('failed')
    expect(state.lastError).toMatch(
      /^did not become ready within 500 ms: the service reports ready=false$/
    )
    expect(state.pid).toBeUndefined()
    expect(state.url).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(480)
    expect(Date.now() - started).toBeLessThan(8000)
    const info = await readInfo(infoFile)
    await waitForGone(info.pid, 2000)
    expect(statusNames(events)).toEqual(['starting', 'failed'])
    expect(events[1]?.detail).toBe(state.lastError)
  })

  it('fails when the service reports ok:false from the start', async () => {
    const { supervisor, id } = await setup({
      args: ['--health-mode', 'ok-false'],
      health: { start_timeout_ms: 2500 },
    })
    const state = await supervisor.start(id)
    expect(state.status).toBe('failed')
    expect(state.lastError).toContain('the service reports ok=false: ok is false')
  })

  it('fails when the process cannot be created at all', async () => {
    const dir = await makeTempDir()
    const entry = fakeEntry(dir, { env: 'native', command: [join(dir, 'no-such-program.exe')] })
    const supervisor = await makeSupervisor([entry])
    const state = await supervisor.start('fake')
    expect(state.status).toBe('failed')
    expect(state.lastError).toMatch(/^cannot start the process: /)
  })

  it('fails without spawning when the working directory does not exist', async () => {
    const dir = await makeTempDir()
    const entry = fakeEntry(dir, {
      cwd: join(dir, 'not-there'),
      args: ['--info-file', join(dir, 'info.json')],
    })
    const supervisor = await makeSupervisor([entry])
    const state = await supervisor.start('fake')
    expect(state.status).toBe('failed')
    expect(state.lastError).toMatch(/the working directory does not exist/)
    expect(state.pid).toBeUndefined()
  })

  it('fails before anything is spawned when a setting the manifest requires is not set, and says which', async () => {
    const dir = await makeTempDir()
    const infoFile = join(dir, 'info.json')
    const entry = fakeEntry(dir, { args: ['--info-file', infoFile] })
    entry.manifest.config_schema = {
      type: 'object',
      required: ['weights', 'level'],
      properties: {
        weights: { type: 'string', description: 'The file that names the weights.' },
        level: { type: 'integer', default: 3 },
      },
    }
    const supervisor = await makeSupervisor([entry])
    const state = await supervisor.start('fake')
    expect(state.status).toBe('failed')
    expect(state.lastError).toBe(
      'plugins.fake.config.weights is not set: The file that names the weights'
    )
    expect(state.pid).toBeUndefined()
    await expect(readFile(infoFile, 'utf8')).rejects.toThrow()

    // with the setting given, the same plugin starts
    const given = await makeSupervisor([entry], {
      pluginConfig: { fake: { enabled: true, config: { weights: 'w.yaml' } } },
    })
    expect((await given.start('fake')).status).toBe('ready')
  })

  it('cancels a start that is still waiting for its first answer when stop is called', async () => {
    const { supervisor, infoFile, id } = await setup({ args: ['--ready-after', '60000'] })
    const pending = supervisor.start(id)
    await readInfo(infoFile) // listening, but never ready
    const stopped = await supervisor.stop(id)
    expect(stopped.status).toBe('stopped')
    expect((await pending).status).toBe('stopped') // the waiting start() resolves with what happened
    await waitForGone((await readInfo(infoFile)).pid)
  })

  it('stopAll() stops every plugin, grandchildren included', async () => {
    const dir = await makeTempDir()
    const one = fakeEntry(dir, {
      id: 'one',
      args: ['--grandchild', '--info-file', join(dir, 'one.json')],
    })
    const two = fakeEntry(dir, {
      id: 'two',
      args: ['--grandchild', '--info-file', join(dir, 'two.json')],
    })
    const supervisor = await makeSupervisor([one, two])
    await Promise.all([supervisor.start('one'), supervisor.start('two')])
    const infos = [await readInfo(join(dir, 'one.json')), await readInfo(join(dir, 'two.json'))]
    expect(supervisor.snapshot().map((s) => s.status)).toEqual(['ready', 'ready'])

    await supervisor.stopAll()
    expect(supervisor.snapshot().map((s) => s.status)).toEqual(['stopped', 'stopped'])
    for (const info of infos) {
      await waitForGone(info.pid)
      await waitForGone(info.grandchildPid ?? 0)
    }
  })

  it('stopAll() also cancels plugins that are still starting or waiting to restart', async () => {
    const dir = await makeTempDir()
    // still starting when stopAll runs, even on a machine so busy that the other plugin takes seconds to start and exit
    const slow = fakeEntry(dir, { id: 'slow', args: ['--startup-delay', '6000'] })
    const crashing = fakeEntry(dir, {
      id: 'crashing',
      args: ['--exit-after', '10'],
      restart: { policy: 'always', max_restarts: 5, backoff_ms: [60_000] },
    })
    const supervisor = await makeSupervisor([slow, crashing])
    const startSlow = supervisor.start('slow')
    void supervisor.start('crashing')
    await waitFor(
      () => supervisor.getStatus('crashing').lastError?.includes('exited') === true,
      10_000,
      'the crashing plugin to exit once'
    )
    await supervisor.stopAll()
    expect(supervisor.snapshot().map((s) => s.status)).toEqual(['stopped', 'stopped'])
    expect((await startSlow).status).toBe('stopped')
  })

  it('stopping during a restart backoff prevents the restart', async () => {
    const { supervisor, runs, id } = await setup({
      args: ['--exit-after', '10'],
      restart: { policy: 'on-failure', max_restarts: 3, backoff_ms: [400] },
    })
    void supervisor.start(id)
    await waitFor(
      () => supervisor.getStatus(id).lastError?.includes('exited with code 1') === true,
      10_000,
      'the first crash'
    )
    const stopped = await supervisor.stop(id)
    expect(stopped.status).toBe('stopped')
    await sleep(700) // longer than the backoff
    expect(supervisor.getStatus(id).status).toBe('stopped')
    expect(await runs()).toBe(1)
  })
})

describe('crashes and restarts', () => {
  it('restarts a crashed service after the backoff and keeps its port', async () => {
    const { supervisor, events, runs, id } = await setup({
      args: ['--crash-first', '1', '--crash-after', '400'],
      restart: { policy: 'on-failure', max_restarts: 3, backoff_ms: [300] },
    })
    const first = await supervisor.start(id)
    expect(first.status).toBe('ready')
    await waitFor(
      () => statusNames(events).filter((s) => s === 'ready').length === 2,
      15_000,
      'the second ready'
    )

    expect(statusNames(events)).toEqual(['starting', 'ready', 'starting', 'ready'])
    const crash = events[2]
    expect(crash?.previous).toBe('ready')
    expect(crash?.detail).toBe('exited with code 1; restarting in 300 ms (attempt 1 of 3)')
    expect((events[3]?.at ?? 0) - (crash?.at ?? 0)).toBeGreaterThanOrEqual(280)
    const state = supervisor.getStatus(id)
    expect(state.status).toBe('ready')
    expect(state.restarts).toBe(1)
    expect(state.port).toBe(first.port) // the URL an adapter was given stays valid
    expect(state.pid).not.toBe(first.pid)
    expect(state.lastError).toBe('exited with code 1')
    expect(await runs()).toBe(2)
  })

  it('walks the backoff list by attempt and gives up after max_restarts', async () => {
    const { supervisor, events, runs, infoFile, id } = await setup({
      args: ['--ready-after', '600000', '--exit-after', '40', '--exit-code', '3'],
      restart: { policy: 'on-failure', max_restarts: 2, backoff_ms: [30, 90] },
    })
    void supervisor.start(id)
    await waitForStatus(supervisor, id, 'failed', 15_000)

    const state = supervisor.getStatus(id)
    expect(state.status).toBe('failed')
    expect(state.restarts).toBe(2)
    expect(state.lastError).toBe('exited with code 3; gave up after 2 restarts')
    expect(state.pid).toBeUndefined()
    expect(await runs()).toBe(3) // the first start and two restarts
    // The service never got ready, so the status stayed `starting` through both restarts: no transition, no event.
    expect(statusNames(events)).toEqual(['starting', 'failed'])
    expect(events.at(-1)?.detail).toBe('exited with code 3; gave up after 2 restarts')
    // the log tells the story, and shows the second backoff entry used for the second restart
    expect(supervisor.logs(id).filter((line) => line.includes('restarting in'))).toEqual([
      '[supervisor] exited with code 3; restarting in 30 ms (attempt 1 of 2)',
      '[supervisor] exited with code 3; restarting in 90 ms (attempt 2 of 2)',
    ])
    await waitForGone((await readInfo(infoFile)).pid)
  })

  it('reuses the last backoff entry when there are more attempts than entries', async () => {
    const { supervisor, id } = await setup({
      args: ['--ready-after', '600000', '--exit-after', '20'],
      restart: { policy: 'on-failure', max_restarts: 3, backoff_ms: [10] },
    })
    void supervisor.start(id)
    await waitForStatus(supervisor, id, 'failed', 15_000)
    expect(
      supervisor
        .logs(id)
        .filter((line) => line.includes('restarting in'))
        .map((line) => line.match(/in (\d+) ms/)?.[1])
    ).toEqual(['10', '10', '10'])
  })

  it('policy never: a crash is final', async () => {
    const { supervisor, events, runs, id } = await setup({
      args: ['--exit-after', '300'],
      restart: { policy: 'never' },
    })
    await supervisor.start(id)
    await waitForStatus(supervisor, id, 'failed')
    expect(statusNames(events)).toEqual(['starting', 'ready', 'failed'])
    expect(supervisor.getStatus(id).lastError).toBe('exited with code 1')
    await sleep(200)
    expect(await runs()).toBe(1)
  })

  it('max_restarts 0: the first crash is final even with on-failure', async () => {
    const { supervisor, id } = await setup({
      args: ['--exit-after', '300'],
      restart: { policy: 'on-failure', max_restarts: 0 },
    })
    await supervisor.start(id)
    await waitForStatus(supervisor, id, 'failed')
    expect(supervisor.getStatus(id).lastError).toBe('exited with code 1; gave up after 0 restarts')
  })

  it('policy on-failure: a clean exit with code 0 is not restarted', async () => {
    const { supervisor, events, runs, id } = await setup({
      args: ['--exit-after', '300', '--exit-code', '0'],
      restart: { policy: 'on-failure' },
    })
    await supervisor.start(id)
    await waitForStatus(supervisor, id, 'stopped')
    expect(statusNames(events)).toEqual(['starting', 'ready', 'stopped'])
    expect(supervisor.getStatus(id).lastError).toBeUndefined()
    expect(events.at(-1)?.detail).toBe('exited with code 0')
    await sleep(200)
    expect(await runs()).toBe(1)
  })

  it('policy on-failure: exiting with code 0 before ever being ready counts as a failure', async () => {
    const { supervisor, runs, id } = await setup({
      args: ['--ready-after', '600000', '--exit-after', '30', '--exit-code', '0'],
      restart: { policy: 'on-failure', max_restarts: 1, backoff_ms: [10] },
    })
    void supervisor.start(id)
    await waitForStatus(supervisor, id, 'failed', 15_000)
    expect(await runs()).toBe(2)
  })

  it('policy always: even a clean exit is restarted', async () => {
    const { supervisor, events, runs, id } = await setup({
      args: ['--exit-after', '300', '--exit-code', '0'],
      restart: { policy: 'always', max_restarts: 1, backoff_ms: [20] },
    })
    await supervisor.start(id)
    await waitForStatus(supervisor, id, 'failed', 15_000)
    expect(await runs()).toBe(2)
    expect(supervisor.getStatus(id).lastError).toBe('exited with code 0; gave up after 1 restart')
    expect(statusNames(events)).toEqual(['starting', 'ready', 'starting', 'ready', 'failed'])
  })

  it('resets the restart counter once the service has stayed ready long enough', async () => {
    const { supervisor, id } = await setup({
      args: ['--crash-first', '1', '--crash-after', '200'],
      restart: { policy: 'on-failure', max_restarts: 3, backoff_ms: [20] },
      supervisor: { restartResetMs: 500 },
    })
    await supervisor.start(id)
    await waitFor(
      () => supervisor.getStatus(id).restarts === 1 && supervisor.getStatus(id).status === 'ready',
      15_000,
      'the restarted service to be ready'
    )
    const readyAt = Date.now()
    await waitFor(
      () => supervisor.getStatus(id).restarts === 0,
      5000,
      'the restart counter to reset'
    )
    expect(Date.now() - readyAt).toBeGreaterThanOrEqual(400)
  })

  it('a manual start resets the restart counter', async () => {
    const { supervisor, id } = await setup({
      args: ['--ready-after', '600000', '--exit-after', '20'],
      restart: { policy: 'on-failure', max_restarts: 1, backoff_ms: [10] },
    })
    void supervisor.start(id)
    await waitForStatus(supervisor, id, 'failed', 15_000)
    expect(supervisor.getStatus(id).restarts).toBe(1)
    void supervisor.start(id)
    expect(supervisor.getStatus(id)).toMatchObject({ status: 'starting', restarts: 0 })
    expect(supervisor.getStatus(id).lastError).toBeUndefined()
    await waitForStatus(supervisor, id, 'failed', 15_000)
  })
})

describe('health while running', () => {
  it('goes unhealthy after fail_threshold failed checks and back to ready when they pass again', async () => {
    const { supervisor, events, id } = await setup()
    const { url } = await supervisor.start(id)
    await control(url, { mode: 'broken' })
    await waitForStatus(supervisor, id, 'unhealthy')
    const unhealthy = events.find((event) => event.status === 'unhealthy')
    expect(unhealthy?.previous).toBe('ready')
    expect(unhealthy?.detail).toBe(
      '2 failed health checks in a row: expected HTTP 200, got 503: broken on purpose'
    )
    expect(supervisor.getStatus(id).health?.ok).toBe(false)

    await control(url, { mode: 'ok' })
    await waitForStatus(supervisor, id, 'ready')
    expect(statusNames(events)).toEqual(['starting', 'ready', 'unhealthy', 'ready'])
    expect(events.at(-1)?.detail).toBe('health check recovered')
    expect(supervisor.getStatus(id).health?.ok).toBe(true)
  })

  it('treats every kind of bad answer as a failure while running', async () => {
    const { supervisor, events, id } = await setup({ health: { timeout_ms: 100 } })
    const { url } = await supervisor.start(id)
    for (const mode of ['loading', 'ok-false', 'garbage', 'hang', 'broken']) {
      await control(url, { mode })
      await waitFor(
        () => supervisor.getStatus(id).status === 'unhealthy',
        5000,
        `unhealthy in mode ${mode}`
      )
      await control(url, { mode: 'ok' })
      await waitForStatus(supervisor, id, 'ready')
    }
    expect(statusNames(events).filter((s) => s === 'unhealthy')).toHaveLength(5)
  })

  it('does not count a single failed check', async () => {
    const { supervisor, events, id } = await setup({
      health: { fail_threshold: 6, interval_ms: 60 },
    })
    const { url } = await supervisor.start(id)
    await control(url, { mode: 'broken' })
    await sleep(150) // two or three failed checks: fewer than six
    await control(url, { mode: 'ok' })
    await sleep(300)
    expect(supervisor.getStatus(id).status).toBe('ready')
    expect(statusNames(events)).toEqual(['starting', 'ready'])
  })

  it('an unhealthy service that then dies follows the restart policy', async () => {
    const { supervisor, events, id } = await setup({ restart: { policy: 'never' } })
    const { url } = await supervisor.start(id)
    await control(url, { mode: 'broken' })
    await waitForStatus(supervisor, id, 'unhealthy')
    await control(url, { exit: 9 })
    await waitForStatus(supervisor, id, 'failed')
    expect(statusNames(events)).toEqual(['starting', 'ready', 'unhealthy', 'failed'])
    expect(supervisor.getStatus(id).lastError).toBe('exited with code 9')
  })

  it('accepts a page that is not JSON when the manifest sets ready_field to null', async () => {
    // a third-party server with no health endpoint, probed through its docs page
    const { supervisor, id } = await setup({ http: { path: '/docs', ready_field: null } })
    const state = await supervisor.start(id)
    expect(state.status).toBe('ready')
    expect(state.health).toBeUndefined() // the body is never read
  })

  it('needs JSON with a ready field by default, so the same page never becomes ready', async () => {
    const { supervisor, id } = await setup({
      http: { path: '/docs' },
      health: { start_timeout_ms: 400 },
    })
    const state = await supervisor.start(id)
    expect(state.status).toBe('failed')
    expect(state.lastError).toContain('the health response is not JSON')
  })

  it('reads a custom ready_field', async () => {
    const { supervisor, id } = await setup({ http: { path: '/health', ready_field: 'version' } })
    expect((await supervisor.start(id)).status).toBe('ready') // "version" is a truthy field of the fake's answer
    const missing = await setup({
      http: { path: '/health', ready_field: 'nothing_here' },
      health: { start_timeout_ms: 400 },
    })
    const state = await missing.supervisor.start(missing.id)
    expect(state.status).toBe('failed')
    expect(state.lastError).toContain('nothing_here=null')
  })

  it('supports a tcp-only health check', async () => {
    const { supervisor, id } = await setup({ tcp: true, args: ['--health-mode', 'loading'] })
    expect((await supervisor.start(id)).status).toBe('ready') // the port is open; nothing else is asked
  })

  it('uses a HEAD request, which has no body to read', async () => {
    const { supervisor, id } = await setup({ http: { method: 'HEAD' } })
    const state = await supervisor.start(id)
    expect(state.status).toBe('ready')
    expect(state.health).toBeUndefined()
  })
})

describe('stopping a service', () => {
  it('asks politely first and does not kill a service that leaves within the grace period', async () => {
    const dir = await makeTempDir()
    const marker = join(dir, 'graceful.txt')
    const { supervisor, infoFile, id } = await setup({
      args: ['--grandchild', '--marker-file', marker, '--stop-delay', '50'],
      stop: { http: { method: 'POST', path: '/shutdown' }, grace_ms: 5000 },
    })
    await supervisor.start(id)
    const info = await readInfo(infoFile)
    const started = Date.now()
    expect((await supervisor.stop(id)).status).toBe('stopped')
    expect(Date.now() - started).toBeLessThan(3500) // well inside the 5 s grace period
    expect(await readFile(marker, 'utf8')).toBe('graceful\n') // the service handled the request itself
    await waitForGone(info.pid)
    await waitForGone(info.grandchildPid ?? 0)
    const logs = supervisor.logs(id)
    expect(logs).toContain('[supervisor] asked the service to stop (POST /shutdown)')
    expect(logs.some((line) => line.includes('killing process tree'))).toBe(false)
    expect(logs).toContain('[supervisor] exited with code 0')
  })

  it('kills a service that ignores the polite request after grace_ms, and its grandchild with it', async () => {
    const { supervisor, infoFile, id } = await setup({
      args: ['--grandchild', '--ignore-stop'],
      stop: { http: { method: 'POST', path: '/shutdown' }, grace_ms: 500 },
    })
    await supervisor.start(id)
    const info = await readInfo(infoFile)
    expect(info.grandchildPid).toBeTypeOf('number')
    expect(pidAlive(info.grandchildPid ?? 0)).toBe(true)

    const started = Date.now()
    expect((await supervisor.stop(id)).status).toBe('stopped')
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(480) // it waited out the grace period
    expect(took).toBeLessThan(8000)
    await waitForGone(info.pid)
    await waitForGone(info.grandchildPid ?? 0)
    expect(
      supervisor.logs(id).some((line) => line.startsWith('[supervisor] killing process tree'))
    ).toBe(true)
  })

  it('kills at once when the manifest has no polite stop, grandchildren included', async () => {
    const { supervisor, infoFile, id } = await setup({
      args: ['--grandchild'],
      stop: { grace_ms: 30_000 },
    })
    await supervisor.start(id)
    const info = await readInfo(infoFile)
    const started = Date.now()
    await supervisor.stop(id)
    expect(Date.now() - started).toBeLessThan(8000) // it did not sit out the 30 s grace period
    await waitForGone(info.pid)
    await waitForGone(info.grandchildPid ?? 0)
    expect(supervisor.logs(id).some((line) => line.includes('asked the service to stop'))).toBe(
      false
    )
  })

  it('kills the whole tree when startup fails, too', async () => {
    const { supervisor, infoFile, id } = await setup({
      args: ['--grandchild', '--never-ready'],
      health: { start_timeout_ms: 400 },
    })
    expect((await supervisor.start(id)).status).toBe('failed')
    const info = await readInfo(infoFile)
    await waitForGone(info.pid)
    await waitForGone(info.grandchildPid ?? 0)
  })
})

describe('external and in-process plugins', () => {
  async function externalServer(handlerStatus = { code: 200 }) {
    let mode = handlerStatus
    const server: Server = createServer((_req, res) => {
      res.writeHead(mode.code, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ ok: mode.code === 200, ready: mode.code === 200, service: 'external' })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      server,
      setCode: (code: number) => (mode = { code }),
      close: () =>
        new Promise<void>(
          (resolve) => (server.closeAllConnections(), server.close(() => resolve()))
        ),
    }
  }

  it('only watches an external service: never starts it, never stops it', async () => {
    const dir = await makeTempDir()
    const external = await externalServer()
    try {
      const supervisor = await makeSupervisor([externalEntry(dir, external.url)])
      const events = recordStatuses(supervisor, 'ext')
      const state = await supervisor.start('ext')
      expect(state).toMatchObject({ status: 'ready', url: external.url })
      expect(state.pid).toBeUndefined()
      expect(state.port).toBeUndefined()
      expect(state.health).toMatchObject({ service: 'external' })

      external.setCode(503)
      await waitForStatus(supervisor, 'ext', 'unhealthy')
      external.setCode(200)
      await waitForStatus(supervisor, 'ext', 'ready')

      expect((await supervisor.stop('ext')).status).toBe('stopped')
      expect((await fetch(`${external.url}/health`)).status).toBe(200) // still up: it was never ours to stop
      expect(statusNames(events)).toEqual([
        'starting',
        'ready',
        'unhealthy',
        'ready',
        'stopping',
        'stopped',
      ])
    } finally {
      await external.close()
    }
  })

  it('takes the address of an external service from the plugin settings', async () => {
    const dir = await makeTempDir()
    const external = await externalServer()
    try {
      const supervisor = await makeSupervisor([externalEntry(dir, '{config.url}')], {
        pluginConfig: { ext: { enabled: true, config: { url: `${external.url}/` } } },
      })
      const state = await supervisor.start('ext')
      expect(state).toMatchObject({ status: 'ready', url: external.url })
    } finally {
      await external.close()
    }
  })

  it('fails clearly when the address setting is missing or is not an http(s) URL', async () => {
    const dir = await makeTempDir()
    const missing = await makeSupervisor([externalEntry(dir, '{config.url}')], {
      pluginConfig: { ext: { enabled: true, config: {} } },
    })
    const a = await missing.start('ext')
    expect(a.status).toBe('failed')
    expect(a.lastError).toMatch(/config key "url" is not set/)

    const wrong = await makeSupervisor([externalEntry(dir, '{config.url}')], {
      pluginConfig: { ext: { enabled: true, config: { url: 'ftp://somewhere' } } },
    })
    const b = await wrong.start('ext')
    expect(b.status).toBe('failed')
    expect(b.lastError).toMatch(/must be an http\(s\) URL/)
  })

  it('waits for an external service that comes up a little later', async () => {
    const dir = await makeTempDir()
    const probe = await externalServer()
    await probe.close() // its port is free again: nothing listens there yet
    const supervisor = await makeSupervisor([
      externalEntry(dir, probe.url, { health: { start_timeout_ms: 5000 } }),
    ])
    const pending = supervisor.start('ext')
    await sleep(300)
    expect(supervisor.getStatus('ext').status).toBe('starting')
    const late = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ready: true, service: 'late' }))
    })
    await new Promise<void>((resolve) => late.listen(probe.port, '127.0.0.1', resolve))
    try {
      expect((await pending).status).toBe('ready')
    } finally {
      late.closeAllConnections()
      await new Promise<void>((resolve) => late.close(() => resolve()))
    }
  })

  it('fails when an external service never appears', async () => {
    const dir = await makeTempDir()
    const gone = await externalServer()
    await gone.close()
    const supervisor = await makeSupervisor([
      externalEntry(dir, gone.url, { health: { start_timeout_ms: 300 } }),
    ])
    const state = await supervisor.start('ext')
    expect(state.status).toBe('failed')
    expect(state.lastError).toMatch(/did not become ready within 300 ms: ECONNREFUSED/)
  })

  it('is ready at once for an in-process plugin', async () => {
    const dir = await makeTempDir()
    const supervisor = await makeSupervisor([inprocessEntry(dir)])
    const events = recordStatuses(supervisor, 'inproc')
    const state = await supervisor.start('inproc')
    expect(state).toEqual({ status: 'ready', restarts: 0 })
    expect(events.at(-1)?.detail).toBe('in-process plugin')
    await supervisor.stop('inproc')
    expect(statusNames(events)).toEqual(['starting', 'ready', 'stopping', 'stopped'])
  })
})

describe('configuration and bookkeeping', () => {
  it('keeps a plugin that the configuration does not enable disabled', async () => {
    const dir = await makeTempDir()
    const supervisor = await makeSupervisor([fakeEntry(dir, { id: 'off' })], { pluginConfig: {} })
    expect(supervisor.getStatus('off').status).toBe('disabled')
    await expect(supervisor.start('off')).rejects.toBeInstanceOf(PluginDisabledError)
    expect((await supervisor.stop('off')).status).toBe('disabled')
    const listed = makeSupervisor([fakeEntry(dir, { id: 'off' })], {
      pluginConfig: { off: { enabled: false } },
    })
    expect((await listed).getStatus('off').status).toBe('disabled')
  })

  it('enables and disables plugins at run time; disabling stops a running one', async () => {
    const dir = await makeTempDir()
    const infoFile = join(dir, 'info.json')
    const supervisor = await makeSupervisor(
      [fakeEntry(dir, { id: 'toggle', args: ['--info-file', infoFile] })],
      { pluginConfig: {} }
    )
    const events = recordStatuses(supervisor, 'toggle')
    await supervisor.configure('toggle', { enabled: true })
    expect(supervisor.getStatus('toggle').status).toBe('stopped')
    expect((await supervisor.start('toggle')).status).toBe('ready')
    const info = await readInfo(infoFile)

    await supervisor.configure('toggle', { enabled: false })
    expect(supervisor.getStatus('toggle').status).toBe('disabled')
    await waitForGone(info.pid)
    expect(statusNames(events)).toEqual([
      'stopped',
      'starting',
      'ready',
      'stopping',
      'stopped',
      'disabled',
    ])
  })

  it('reads config at each start', async () => {
    const dir = await makeTempDir()
    const infoFile = join(dir, 'info.json')
    const entry = fakeEntry(dir, {
      id: 'cfg',
      args: ['--info-file', infoFile, '--stdout-line', '{config.greeting}'],
    })
    const supervisor = await makeSupervisor([entry], {
      pluginConfig: { cfg: { enabled: true, config: { greeting: 'hello one' } } },
    })
    await supervisor.start('cfg')
    await waitFor(() => supervisor.logs('cfg').includes('hello one'), 5000, 'the first greeting')
    await supervisor.configure('cfg', { enabled: true, config: { greeting: 'hello two' } })
    await supervisor.restart('cfg')
    await waitFor(() => supervisor.logs('cfg').includes('hello two'), 5000, 'the second greeting')
  })

  it('throws a specific error for an unknown plugin', async () => {
    const { supervisor } = await setup()
    await expect(supervisor.start('nope')).rejects.toBeInstanceOf(UnknownPluginError)
    await expect(supervisor.stop('nope')).rejects.toBeInstanceOf(UnknownPluginError)
    expect(() => supervisor.getStatus('nope')).toThrow(UnknownPluginError)
    expect(() => supervisor.logs('nope')).toThrow(/unknown plugin "nope"/)
    expect(supervisor.has('nope')).toBe(false)
  })

  it('lists every plugin in a snapshot, sorted by id', async () => {
    const dir = await makeTempDir()
    const supervisor = await makeSupervisor(
      [fakeEntry(dir, { id: 'zeta' }), fakeEntry(dir, { id: 'alpha' }), inprocessEntry(dir, 'mid')],
      { pluginConfig: { zeta: { enabled: true }, mid: { enabled: true } } }
    )
    await supervisor.start('zeta')
    await supervisor.start('mid')
    const snapshot = supervisor.snapshot()
    expect(snapshot.map((s) => [s.id, s.status])).toEqual([
      ['alpha', 'disabled'],
      ['mid', 'ready'],
      ['zeta', 'ready'],
    ])
    expect(snapshot[2]?.pid).toBeTypeOf('number')
    expect(supervisor.ids()).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('hands out separate ports, and keeps automatic ports away from fixed ones', async () => {
    const dir = await makeTempDir()
    const fixed = fakeEntry(dir, {
      id: 'fixed',
      port: 47_311,
      args: ['--info-file', join(dir, 'fixed.json')],
    })
    const auto1 = fakeEntry(dir, { id: 'auto1' })
    const auto2 = fakeEntry(dir, { id: 'auto2' })
    const supervisor = await makeSupervisor([fixed, auto1, auto2])
    const states = await Promise.all(['fixed', 'auto1', 'auto2'].map((id) => supervisor.start(id)))
    expect(states.map((s) => s.status)).toEqual(['ready', 'ready', 'ready'])
    expect(states[0]?.port).toBe(47_311)
    const ports = states.map((s) => s.port)
    expect(new Set(ports).size).toBe(3)
  })

  it('uses the injected clock for startedAt', async () => {
    const { supervisor, id } = await setup({ supervisor: { now: () => Date.now() + 1_000_000 } })
    const state = await supervisor.start(id)
    expect((state.startedAt ?? 0) - Date.now()).toBeGreaterThan(990_000)
  })

  it('survives a status listener that throws', async () => {
    const dir = await makeTempDir()
    const entry = fakeEntry(dir)
    const messages: string[] = []
    const supervisor = await makeSupervisor([entry], { log: (_level, msg) => messages.push(msg) })
    supervisor.on('status', () => {
      throw new Error('listener bug')
    })
    expect((await supervisor.start('fake')).status).toBe('ready')
    expect(messages.some((msg) => msg.includes('a status listener of plugin fake threw'))).toBe(
      true
    )
  })

  it('does not leave a process behind when an instance is dropped after stopAll', async () => {
    const { supervisor, infoFile, id } = await setup({ args: ['--grandchild'] })
    await supervisor.start(id)
    const info = await readInfo(infoFile)
    trackPid(info.pid)
    await supervisor.stopAll()
    await waitForGone(info.pid)
    await waitForGone(info.grandchildPid ?? 0)
  })
})
