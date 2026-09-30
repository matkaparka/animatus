/**
 * The operator's side of the sing mode: its panel and buttons, the alarms that say what is wrong, what the model is told
 * about failures, a restart of the program, the pack and the settings.
 */
import { describe, expect, it } from 'vitest'
import { FORMATS } from '../../src/inbox/formats.ts'
import { until } from '../app/rig.ts'
import { MODES, singRig, tempDir } from './singRig.ts'
import type { SingRig } from './singRig.ts'
import { loadModePacks } from '../../src/modes/loader.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const panel = (r: SingRig) => r.service.viewOf('sing').panel!
const action = (r: SingRig, id: string) => panel(r).actions.find((a) => a.id === id)!
const queueRows = (r: SingRig) => panel(r).sections.find((s) => s.title === 'Queue')!.rows
const looked = (r: SingRig) =>
  until(() => r.ctl.status().serviceUp === true, 3000, 'the first look')

describe('the panel', () => {
  it('says what is going on, lists the queue with a remove button on each entry, and has the buttons with their reasons', async () => {
    const r = await singRig({ settings: { poll_sec: 0.1 } })
    r.hub.connected = false // nothing is sung while the panel is looked at
    r.fake.ready('晴天', { requester_name: 'ann', artists: ['周杰伦'] })
    r.fake.add('后来', { requester_name: 'bob', state: 'processing' })
    r.fake.worker = { state: 'working', title: '后来', step: 'separate' }
    r.fake.failed.push({
      ...r.fake.add('坏了', { requester_name: 'cy' }),
      state: 'failed',
      reason: '版权原因',
    })
    r.fake.items.pop() // the failed one is not in the queue
    await looked(r)
    await until(() => (queueRows(r).length ?? 0) === 2, 3000, 'the queue in the panel')

    const p = panel(r)
    expect(p.status).toBe('2 song(s) in the queue')
    expect(Object.fromEntries(p.facts.map((f) => [f.label, f.value]))).toMatchObject({
      'Singing service': 'reachable',
      'Song source': 'fake',
      Queue: '2 waiting, 1 ready (limit 5, 1 each)',
      Preparing: '后来 (separate)',
    })
    expect(queueRows(r).map((row) => [row.text, row.detail, row.active])).toEqual([
      ['晴天 - 周杰伦', 'ann: ready', false],
      ['后来 - Artist', 'bob: being prepared', false],
    ])
    expect(queueRows(r).every((row) => row.actions.map((a) => a.id).join() === 'remove')).toBe(true)
    expect(p.sections.find((s) => s.title === 'Failed lately')!.rows[0]).toMatchObject({
      text: '坏了',
      detail: 'cy: 版权原因',
    })
    expect(action(r, 'stop')).toMatchObject({ disabled: 'no song is being sung' })
    expect(action(r, 'pause')).toMatchObject({ label: 'Pause singing' })
    expect(action(r, 'resume_source')).toMatchObject({ disabled: 'the song source is not stopped' })
  })

  it('while a song is sung: the song is the active row with a skip button, and stop is on', async () => {
    const r = await singRig({ stage: { playMs: 5000 } })
    r.fake.ready('晴天', { requester_name: 'ann' })
    r.fake.ready('后来', { requester_name: 'bob' })
    await until(() => r.ctl.status().phase === 'playing', 5000)
    await until(() => queueRows(r).length === 2, 3000)
    const rows = queueRows(r)
    expect(rows[0]).toMatchObject({
      text: '♪ 晴天 - Artist',
      active: true,
      detail: 'asked by ann, being sung',
    })
    expect(rows[0]!.actions.map((a) => a.id)).toEqual(['skip'])
    expect(rows[1]).toMatchObject({ text: '后来 - Artist', active: false })
    expect(panel(r).status).toBe('singing "晴天" (asked by ann)')
    expect(action(r, 'stop').disabled).toBeUndefined()
  })

  it('a service that cannot be reached is the status, and the last look stays for what it is worth', async () => {
    const r = await singRig({ stage: { playMs: 60 } })
    r.hub.connected = false
    r.fake.ready('晴天')
    await looked(r)
    await until(() => queueRows(r).length === 1, 3000)
    r.serviceUp.value = false
    await until(() => r.ctl.status().serviceUp === false, 3000)
    expect(panel(r).status).toBe('the singing service cannot be reached')
    expect(panel(r).facts[0]).toEqual({ label: 'Singing service', value: 'not reachable' })
  })
})

describe('the buttons', () => {
  it('remove takes an entry off the queue, and says why when it cannot', async () => {
    const r = await singRig()
    r.hub.connected = false
    const it = r.fake.add('晴天')
    expect(await r.ctl.onConsoleRequest!({ action: 'remove', row: String(it.qid) })).toEqual({
      ok: true,
    })
    expect(r.fake.items).toEqual([])
    expect(await r.ctl.onConsoleRequest!({ action: 'remove', row: '99' })).toEqual({
      ok: false,
      reason: '队列里没有这首歌',
    })
    expect(await r.ctl.onConsoleRequest!({ action: 'remove', row: 'x' })).toEqual({
      ok: false,
      reason: 'which entry?',
    })
    r.serviceUp.value = false
    expect((await r.ctl.onConsoleRequest!({ action: 'remove', row: '1' })).ok).toBe(false)
  })

  it('pause keeps ready songs from starting, resume lets them', async () => {
    const r = await singRig()
    expect(await r.ctl.onConsoleRequest!({ action: 'pause' })).toEqual({ ok: true })
    expect(action(r, 'resume')).toMatchObject({ label: 'Resume singing' })
    r.fake.ready('晴天')
    await sleep(500)
    expect(r.fake.callsTo('/claim')).toEqual([])
    expect(panel(r).status).toBe('paused by the operator: 1 song(s) wait')
    expect(await r.ctl.onConsoleRequest!({ action: 'resume' })).toEqual({ ok: true })
    await until(() => r.sent('sing.play').length === 1, 4000, 'sing.play after resume')
  })

  it('play sings a ready song now, even when paused, and refuses when there is none or the service is away', async () => {
    const r = await singRig({ settings: { poll_sec: 60 } })
    await looked(r)
    expect(await r.ctl.onConsoleRequest!({ action: 'pause' })).toEqual({ ok: true })
    expect(await r.ctl.onConsoleRequest!({})).toEqual({ ok: false, reason: 'no song is ready' })
    r.serviceUp.value = false
    expect((await r.ctl.onConsoleRequest!({})).reason).toBe('the singing service is not running')
    r.serviceUp.value = true
    r.fake.ready('晴天')
    expect(await r.service.consoleRequest('sing', { action: 'play' })).toEqual({ ok: true })
    await until(() => r.sent('sing.play').length === 1, 4000)
    expect(r.ctl.status().paused).toBe(false)
  })

  it('skip and stop refuse politely when nothing is being sung', async () => {
    const r = await singRig()
    expect(await r.ctl.onConsoleRequest!({ action: 'skip' })).toEqual({
      ok: false,
      reason: 'no song is being sung',
    })
    expect(await r.ctl.onConsoleRequest!({ action: 'stop' })).toEqual({
      ok: false,
      reason: 'no song is being sung',
    })
  })

  it('stop withdraws a song that is still waiting for the voice', async () => {
    const r = await singRig()
    let release!: () => void
    r.quiet.wait = new Promise((res) => (release = res))
    r.fake.ready('晴天')
    await until(() => r.ctl.status().phase === 'pending', 3000)
    expect(await r.ctl.onConsoleRequest!({ action: 'stop' })).toEqual({ ok: true })
    expect(r.ctl.status()).toMatchObject({ phase: 'idle', paused: true })
    release()
    await sleep(400)
    expect(r.fake.callsTo('/claim')).toEqual([])
    expect(r.flags.singing).toBe(false)
  })

  it("the skip button cuts the song like a viewer's skip", async () => {
    const r = await singRig({ stage: { playMs: 5000 } })
    r.fake.ready('晴天')
    await until(() => r.ctl.status().phase === 'playing', 5000)
    expect(await r.ctl.onConsoleRequest!({ action: 'skip' })).toEqual({ ok: true })
    await until(() => r.told.length === 1, 4000)
    expect(r.fake.callsTo('/done')[0]!.body).toMatchObject({ outcome: 'skipped' })
  })
})

describe('what is wrong is said, and said again as fixed', () => {
  it('a service that stays away raises an alarm (not at once: it takes a while to start), and its return clears it', async () => {
    const r = await singRig({ settings: { service_alarm_after_sec: 1 } })
    await looked(r)
    r.serviceUp.value = false
    await sleep(500)
    expect(r.alarmCodes()).not.toContain('sing_service')
    await until(() => r.alarmCodes().includes('sing_service'), 4000, 'the alarm')
    expect(r.alarms.find((a) => a.code === 'sing_service')!.message).toContain(
      'the singing service is not running'
    )
    r.serviceUp.value = true
    await until(() => !r.alarmCodes().includes('sing_service'), 3000, 'the alarm cleared')
  })

  it('an answer the program does not understand is a service that is not right, not a crash', async () => {
    const r = await singRig()
    await looked(r)
    r.fake.answer('/queue', { status: 200, body: { nonsense: true } })
    await until(() => r.ctl.status().serviceUp === false, 3000)
    await until(() => r.ctl.status().serviceUp === true, 3000)
  })

  it('a stopped song source is an alarm with the reason, cleared when it is resumed from the panel', async () => {
    const r = await singRig()
    r.fake.halted = { reason: '/cloudsearch answered code=-460' }
    await until(() => r.alarmCodes().includes('sing_source'), 3000)
    expect(r.alarms.find((a) => a.code === 'sing_source')!.message).toContain('code=-460')
    expect(action(r, 'resume_source').disabled).toBeUndefined()
    expect(await r.ctl.onConsoleRequest!({ action: 'resume_source' })).toEqual({ ok: true })
    expect(r.fake.callsTo('/source/resume')).toHaveLength(1)
    await until(() => !r.alarmCodes().includes('sing_source'), 3000, 'the alarm cleared')
    r.serviceUp.value = false
    expect((await r.ctl.onConsoleRequest!({ action: 'resume_source' })).ok).toBe(false)
  })

  it('a songs folder the stage is not served is an alarm that names both folders', async () => {
    const other = await tempDir('elsewhere')
    const r = await singRig({ servedDir: other })
    await until(() => r.alarmCodes().includes('sing_songs_dir'), 3000)
    const alarm = r.alarms.find((a) => a.code === 'sing_songs_dir')!
    expect(alarm.level).toBe('error')
    expect(alarm.message).toContain(r.songsDir)
    expect(alarm.message).toContain(other)
  })

  it('the same folder is no alarm', async () => {
    const r = await singRig()
    await looked(r)
    await sleep(300)
    expect(r.alarmCodes()).not.toContain('sing_songs_dir')
  })

  it.skipIf(process.platform !== 'win32')(
    'on Windows slashes and letter case do not make a different folder',
    async () => {
      const r = await singRig()
      await looked(r)
      r.fake.songsDir = r.songsDir.replace(/\\/g, '/').toUpperCase()
      await sleep(400)
      expect(r.alarmCodes()).not.toContain('sing_songs_dir')
    }
  )

  it('no paths.songs at all is an alarm: the stage has nowhere to fetch songs from', async () => {
    const r = await singRig({ noSongsPath: true })
    await until(() => r.alarmCodes().includes('sing_songs_dir'), 3000)
    expect(r.alarms.find((a) => a.code === 'sing_songs_dir')!.message).toContain(
      'paths.songs is not set'
    )
  })
})

describe('what the model is told about failures', () => {
  it('a song that failed to be prepared is announced once, with its reason; what had failed before the start is not news', async () => {
    const r = await singRig({
      arrange: (f) => {
        f.failed.push({
          ...f.add('旧的'),
          state: 'failed',
          reason: '很久以前的原因',
          code: 'no_audio',
        })
        f.items.pop()
      },
    })
    await looked(r)
    expect(r.songLines).toEqual([])
    r.fake.failed.push({
      ...r.fake.add('晴天', { requester_name: 'ann' }),
      state: 'failed',
      reason: '这首歌唱不了',
      code: 'no_audio',
    })
    r.fake.items.pop()
    await until(() => r.songLines.length === 1, 3000, 'the announcement')
    expect(r.songLines[0]).toBe(FORMATS.songFailed('ann', '晴天', '这首歌唱不了'))
    await sleep(400)
    expect(r.songLines).toHaveLength(1) // and not again at the next look
  })

  it('a song that could not sound on the stage is not announced as "not queued"; and the announcements can be switched off', async () => {
    const r = await singRig({ settings: { announce_failures: false } })
    await looked(r)
    r.fake.failed.push({ ...r.fake.add('晴天'), state: 'failed', reason: 'x', code: 'no_audio' })
    r.fake.items.pop()
    await sleep(400)
    expect(r.songLines).toEqual([])
    const s = await singRig()
    await looked(s)
    s.fake.failed.push({
      ...s.fake.add('晴天'),
      state: 'failed',
      reason: 'x',
      code: 'playback_failed',
    })
    s.fake.items.pop()
    await sleep(400)
    expect(s.songLines).toEqual([])
  })
})

describe('a restart of the program', () => {
  it('a song the service still lists as being sung was cut off by the restart: it is reported interrupted, then the queue goes on', async () => {
    const r = await singRig({
      stage: { playMs: 100 },
      arrange: (f) => {
        f.current = { ...f.add('半途'), state: 'playing', claim_id: 'old' }
        f.items.pop()
        f.ready('后来', { requester_name: 'bob' })
      },
    })
    await until(() => r.fake.callsTo('/done').length >= 1, 4000, 'the leftover reported')
    expect(r.fake.callsTo('/done')[0]!.body).toMatchObject({
      qid: 1,
      outcome: 'interrupted',
      reason: 'the program restarted',
    })
    await until(() => r.sent('sing.play').length === 1, 4000)
    expect(r.sent('sing.play')[0]).toMatchObject({ title: '后来' })
  })

  it("the queue is the service's: a restart in the middle finds the waiting songs and sings them", async () => {
    const first = await singRig({ stage: { playMs: 60_000 } })
    first.fake.ready('one')
    first.fake.ready('two')
    await until(() => first.ctl.status().phase === 'playing', 5000)
    await first.service.dispose() // the program stops in the middle of the first song
    expect(first.fake.callsTo('/done')[0]!.body).toMatchObject({ qid: 1, outcome: 'interrupted' })
    const second = await singRig({ previous: first, stage: { playMs: 100 } })
    await until(
      () => second.sent('sing.play').length === 1,
      5000,
      'the second run sings the next song'
    )
    expect(second.sent('sing.play')[0]).toMatchObject({ title: 'two' })
  })
})

describe('what the model is told about the mode, and the pack', () => {
  it('is advertised while idle, with the markers it will see; while a song is sung the active prompt takes its place', async () => {
    const r = await singRig({ stage: { playMs: 5000 } })
    const idle = r.service.prompts()
    expect(idle).toHaveLength(1)
    expect(idle[0]!.id).toBe('sing:available')
    expect(idle[0]!.text).toContain('【点歌】')
    expect(idle[0]!.text).toContain('【歌单】')
    expect(idle[0]!.text).toContain('点歌 <song name>')
    r.fake.ready('晴天')
    await until(() => r.ctl.status().phase === 'playing', 5000)
    expect(r.service.prompts().map((p) => p.id)).toEqual(['sing'])
  })

  it('the pack: priority, exclusions, hotkey, no service (the plugin holds the queue and must stay up), and every prompt it names', async () => {
    const { modes, errors } = await loadModePacks([MODES])
    expect(errors).toEqual([])
    const pack = modes.find((m) => m.manifest.id === 'sing')!
    expect(pack.manifest).toMatchObject({
      priority: 60,
      exclusive_with: ['dance', 'draw', 'commentary', 'game'],
      preempts: false,
      prompt: 'prompts/active.md',
      triggers: { hotkey: 'ctrl+alt+s' },
      requires: { services: [], vram_mb_est: 0 },
    })
    expect([...pack.prompts.keys()].sort()).toEqual([
      'active',
      'available',
      'credit_artists',
      'credit_requester',
      'credit_title',
      'outro',
      'outro_skipped',
    ])
    // generic: a pack prompt carries no path, and speaks of "you" and "the viewer", never of a named character
    for (const text of pack.prompts.values()) expect(text).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(pack.activePrompt).toContain('{{title}}')
  })

  it('dance and sing exclude each other whichever manifest says it', async () => {
    const { modes } = await loadModePacks([MODES])
    const dance = modes.find((m) => m.manifest.id === 'dance')!.manifest
    expect(dance.exclusive_with).toContain('sing')
  })
})

describe('the settings', () => {
  it('every key has a default; a key that is not known, or out of bounds, is refused with its name', async () => {
    const ok = await singRig({ settings: {} })
    expect(ok.ctl.status().phase).toBe('idle')
    await expect(singRig({ settings: { poll_secs: 1 } })).rejects.toThrow(/poll_secs/)
    await expect(singRig({ settings: { poll_sec: 0 } })).rejects.toThrow(/poll_sec/)
    await expect(singRig({ settings: { start_timeout_sec: 500 } })).rejects.toThrow(
      /start_timeout_sec/
    )
    await expect(singRig({ settings: { outro: 'yes' } })).rejects.toThrow(/outro/)
  })
})
