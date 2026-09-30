/**
 * The shipped singing plugin, as the supervisor starts it: the real manifest, the real Python service (in the
 * repository's light environment), the real typed client reading its answers. What the client's schemas expect is checked
 * against what the service really sends, so the two cannot drift apart unnoticed.
 *
 * No GPU, no model and no network is used: the song source is a folder of one tiny file, and the pipeline's first tool
 * is missing in the light environment, so an accepted song ends as a failed entry with that tool's own words.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SongServiceClient } from '../../src/modes/singing/client.ts'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import {
  LIGHT_PYTHON,
  REPO_ROOT,
  cleanupAll,
  makeSupervisor,
  makeTempDir,
  pidAlive,
  trackPid,
  waitFor,
} from './helpers.ts'

const hasAudioSeparator = () =>
  LIGHT_PYTHON !== undefined &&
  spawnSync(LIGHT_PYTHON, ['-c', 'import audio_separator'], { stdio: 'ignore' }).status === 0

/**
 * A setup the service accepts: the tools' folders and files exist (empty), the music folder has one file. `settings`
 * replaces the whole settings file; `model` names the voice model the file points at.
 */
async function setup(options: { settings?: string; model?: string } = {}) {
  const dir = await makeTempDir('singing-plugin-')
  const at = (...p: string[]) => join(dir, ...p)
  for (const d of ['applio', 'music', 'songs']) await mkdir(at(d), { recursive: true })
  for (const f of [
    'applio/core.py',
    'applio/py.exe',
    'voice.pth',
    'ffmpeg.exe',
    'music/Artist - Title.mp3',
  ])
    await writeFile(at(...f.split('/')), 'x')
  const settings = at('singing.yaml')
  await writeFile(
    settings,
    options.settings ??
      [
        'source: local',
        'paths:',
        '  local_music: music',
        '  applio: applio',
        '  applio_python: applio/py.exe',
        '  ffmpeg: ./ffmpeg.exe',
        'rvc:',
        `  model_pth: ${options.model ?? 'voice.pth'}`,
        'retry:',
        '  max_attempts: 1',
      ].join('\n')
  )
  const registry = await PluginRegistry.scan(join(REPO_ROOT, 'plugins'))
  const entry = registry.get('singing')
  if (!entry) throw new Error('plugins/singing/plugin.yaml was not found')
  // the schema's minimums (a 500 ms health interval) would make every test slow
  entry.manifest.health.interval_ms = 100
  entry.manifest.health.timeout_ms = 3000
  entry.manifest.health.start_timeout_ms = 60_000
  const supervisor = await makeSupervisor([entry], {
    dataDir: at('data'),
    pluginConfig: {
      singing: {
        enabled: true,
        config: { python: LIGHT_PYTHON, songs_dir: at('songs'), settings },
      },
    },
  })
  return { dir, at, entry, supervisor }
}

describe.skipIf(LIGHT_PYTHON === undefined)('the singing plugin under the real supervisor', () => {
  // These tests share one service, because starting it is what takes the time. They run in the order written, and the
  // last one ends the service.
  describe('with a setup that works', () => {
    let rig: Awaited<ReturnType<typeof setup>>
    let client: SongServiceClient
    let url: string
    let pid: number

    beforeAll(async () => {
      rig = await setup()
      const state = await rig.supervisor.start('singing')
      trackPid(state.pid)
      expect(state.status).toBe('ready')
      url = state.url as string
      pid = state.pid as number
      client = new SongServiceClient({ baseUrl: () => url, callTimeoutMs: 5000 })
    }, 90_000)

    afterAll(cleanupAll)

    it('is ready from its manifest, on the local loopback, and says what it is', () => {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(rig.supervisor.getStatus('singing').health).toMatchObject({
        ok: true,
        ready: true,
        service: 'singing',
        config: { source: 'local', max_per_user: 1, max_len: 5 },
      })
      expect(rig.supervisor.logs('singing').join('\n')).toContain('listening on 127.0.0.1')
    })

    it('answers what the typed client expects, call by call', async () => {
      const empty = await client.queue()
      expect(empty).toMatchObject({
        current: null,
        items: [],
        failed: [],
        limits: { max_per_user: 1, max_len: 5 },
      })
      expect(empty.source.kind).toBe('local')
      expect(empty.songs_dir).toBe(rig.at('songs'))

      const none = await client.request({
        requestId: 'r-0',
        keyword: 'nothing like it',
        uid: '1',
        name: 'ann',
        waitSec: 5,
        slackSec: 5,
      })
      expect(none).toMatchObject({ status: 'rejected', code: 'not_found' })
      expect((none as { reason: string }).reason).toContain('nothing like it')

      expect(await client.claim('c-1')).toMatchObject({ item: null, pending: 0 })
      expect(await client.done({ outcome: 'done' })).toMatchObject({
        ok: false,
        code: 'nothing_playing',
      })
      expect(await client.skip()).toMatchObject({ ok: false, code: 'nothing_playing' })
      expect(await client.cancel({ uid: '1' })).toMatchObject({
        ok: false,
        code: 'nothing_to_cancel',
      })
      expect(await client.cancel({ position: 3 })).toMatchObject({
        ok: false,
        code: 'no_such_position',
      })
      expect(await client.remove(42)).toMatchObject({ ok: false, code: 'not_in_queue' })
      expect(await client.abandon('r-never-seen')).toEqual({ ok: true, removed: false })
      expect(await client.resumeSource()).toEqual({ ok: true })
    })

    it.skipIf(hasAudioSeparator())(
      "a song from the folder is accepted, copied, and fails in the missing separation tool with the tool's own words",
      async () => {
        const ask = () =>
          client.request({
            requestId: 'r-1',
            keyword: 'title artist',
            uid: '1001',
            name: 'ann',
            waitSec: 10,
            slackSec: 5,
          })
        const answer = await ask()
        expect(answer).toMatchObject({ status: 'queued', qid: 1, position: 1, cached: false })
        expect((answer as { song: { title: string; artists: string[] } }).song).toMatchObject({
          title: 'Title',
          artists: ['Artist'],
        })
        // asking again with the same id is the same entry, not a second one
        expect(await ask()).toMatchObject({ status: 'queued', qid: 1, duplicate: true })

        let failed = (await client.queue()).failed
        await waitFor(
          async () => (failed = (await client.queue()).failed).length === 1,
          60_000,
          'the entry to fail'
        )
        expect(failed[0]).toMatchObject({
          qid: 1,
          title: 'Title',
          state: 'failed',
          code: 'step_failed',
          retryable: false,
          requester_name: 'ann',
        })
        expect(failed[0]!.error).toContain('audio_separator') // what the operator sees
        expect(failed[0]!.reason).not.toContain('audio_separator') // what the audience may be told
        expect(failed[0]!.reason).toBeTruthy()
        // it was copied into the songs library, under an id that is a safe folder name
        const folders = await readdir(rig.at('songs'))
        expect(folders).toHaveLength(1)
        expect(folders[0]).toMatch(/^local_[0-9a-f]{12}$/)
        expect(await readdir(rig.at('songs', folders[0] as string))).toContain('meta.json')
      }
    )

    it('stops politely when asked, and nothing is left running', async () => {
      const t0 = Date.now()
      await rig.supervisor.stop('singing')
      expect(Date.now() - t0).toBeLessThan(8000)
      expect(rig.supervisor.getStatus('singing').status).toBe('stopped')
      await waitFor(() => !pidAlive(pid), 5000, 'the service process to be gone')
    })
  })

  // A setup that cannot work leaves the service up, answering its health check with the reasons, so that the console
  // shows them. Waiting for the supervisor to give up would take its whole start timeout, so these tests read what the
  // supervisor shows while it waits.
  describe('with a setup that cannot work', () => {
    afterEach(cleanupAll)

    async function reasonShown(rig: Awaited<ReturnType<typeof setup>>): Promise<string> {
      const settled = rig.supervisor.start('singing')
      let detail = ''
      await waitFor(
        () => {
          const health = rig.supervisor.getStatus('singing').health
          detail = health?.detail ?? ''
          return health !== undefined
        },
        30_000,
        'the service to answer its health check'
      )
      trackPid(rig.supervisor.getStatus('singing').pid)
      expect(rig.supervisor.getStatus('singing').status).toBe('starting')
      expect(rig.supervisor.getStatus('singing').health).toMatchObject({ ok: false })
      await rig.supervisor.stop('singing')
      await settled
      return detail
    }

    it('a voice model that is not there keeps it out of ready, and the health says which setting', async () => {
      const rig = await setup({ model: 'no-such-model.pth' })
      expect(await reasonShown(rig)).toContain('rvc.model_pth')
    })

    it('a settings file with a typo is named by its key, and the process stays up to say so', async () => {
      const rig = await setup({ settings: 'queue:\n  max_lenght: 5\n' })
      expect(await reasonShown(rig)).toContain('queue.max_lenght')
    })
  })
})
