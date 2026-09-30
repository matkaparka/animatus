/**
 * A song from "ready" to "over", through the sing controller: what the stage is sent, what is held and released, how
 * every kind of end is reported to the service, and that a failure or a stop at any point leaves nothing behind.
 */
import { describe, expect, it } from 'vitest'
import { FORMATS } from '../../src/inbox/formats.ts'
import { until } from '../app/rig.ts'
import { singRig } from './singRig.ts'
import type { SingRig } from './singRig.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const overlays = (r: SingRig, id: string) => r.hub.overlays.filter((o) => o.id === id)
const lastOverlay = (r: SingRig, id: string) => overlays(r, id).at(-1)
const phase = (r: SingRig) => r.ctl.status().phase
const doneCalls = (r: SingRig) => r.fake.callsTo('/done').map((c) => c.body)

/** After a song, everything that must be true: the voice released (whatever was held last), no flag, no overlay, the mode left. */
function expectClean(r: SingRig) {
  expect(r.flags.singing).toBe(false)
  expect(r.held.at(-1)).toEqual(['sing', false])
  expect(lastOverlay(r, 'lyrics')).toMatchObject({ visible: false })
  expect(lastOverlay(r, 'credit')).toMatchObject({ visible: false, text: '' })
  expect(r.service.state('sing')).toBe('IDLE')
  expect(phase(r)).toBe('idle')
}

describe('a song that goes well', () => {
  it('reaches the stage with its tracks, lyrics and credit, holds the voice and the audience, and afterwards the model says a closing line', async () => {
    const r = await singRig({ stage: { playMs: 300 } })
    r.fake.ready('晴天', { artists: ['周杰伦'], requester_name: 'ann' })
    await until(() => r.sent('sing.play').length === 1, 5000, 'sing.play')

    const play = r.sent('sing.play')[0]!
    expect(play).toMatchObject({
      type: 'sing.play',
      song_id: 'song-1-1',
      title: '晴天',
      artists: ['周杰伦'],
      requester: 'ann',
      vocals_url: '/asset/songs/song-1/vocals_final.wav',
      inst_url: '/asset/songs/song-1/inst_final.wav',
      start_delay_s: 0.2,
    })
    expect(play.lyrics).toEqual(r.fake.lyrics)
    // the audience's queue is closed and the voice held from before the song is sent
    expect(r.flags.singing).toBe(true)
    expect(r.held).toContainEqual(['sing', true])
    // and the stage shows the lyrics and who it is
    expect(lastOverlay(r, 'lyrics')).toMatchObject({ visible: true })
    expect(lastOverlay(r, 'credit')).toMatchObject({
      visible: true,
      text: '♪ 晴天  — 周杰伦  点歌：ann',
    })

    await until(() => phase(r) === 'playing', 3000, 'playing')
    expect(r.service.state('sing')).toBe('ACTIVE')
    expect(r.ctl.status()).toMatchObject({ current: '晴天', serviceUp: true })
    expect(r.service.prompts().find((p) => p.id === 'sing')?.text).toBe(
      'You are singing "晴天" right now. Say nothing until it is over.'
    )

    // the song ends on the stage: the mode is left, the service told, the model asked for a closing line
    await until(() => r.told.length === 1, 4000, 'the closing line')
    expect(r.told[0]).toBe(
      '【系统】You have just finished singing "晴天" (requested by ann). Say one closing line in character.'
    )
    expect(doneCalls(r)).toEqual([{ qid: 1, outcome: 'done' }])
    expect(r.service.state('sing')).toBe('IDLE')
    expect(r.held.at(-1)).toEqual(['sing', false])
    expect(lastOverlay(r, 'lyrics')).toMatchObject({ visible: false })
    expect(lastOverlay(r, 'credit')).toMatchObject({ visible: false, text: '' })
    // the audience's queue stays closed until the model starts answering ...
    expect(r.flags.singing).toBe(true)
    r.brain.busy = true
    await until(() => !r.flags.singing, 3000, 'the audience queue released')
    expectClean(r)
    expect(r.alarms).toEqual([])
    expect(r.events.some((e) => e.includes('singing "晴天" for ann'))).toBe(true)
  })

  it('the closing line is given up on after its window even if the model never starts answering', async () => {
    const r = await singRig({ stage: { playMs: 100 }, settings: { outro_window_sec: 0.5 } })
    r.fake.ready('晴天')
    await until(() => r.told.length === 1, 5000, 'the closing line')
    expect(r.flags.singing).toBe(true)
    await until(() => !r.flags.singing, 3000, 'released by the window')
    expectClean(r)
  })

  it('without a closing line (a setting) the queue is released at once, and a model that cannot be told does not hold it either', async () => {
    const r = await singRig({ stage: { playMs: 100 }, settings: { outro: false } })
    r.fake.ready('晴天')
    await until(() => r.service.state('sing') === 'ACTIVE', 5000)
    await until(() => r.service.state('sing') === 'IDLE', 3000)
    expect(r.told).toEqual([])
    expectClean(r)
  })

  it("songs in a row: the second starts only after the first one's closing line", async () => {
    const r = await singRig({ stage: { playMs: 100 } })
    r.brain.busy = true // the model "starts answering" at once, so the queue is released at the next look
    r.fake.ready('one', { requester_name: 'ann' })
    r.fake.ready('two', { requester_name: 'bob' })
    await until(() => r.sent('sing.play').length === 2, 8000, 'both songs')
    expect(r.sent('sing.play').map((m) => m.title)).toEqual(['one', 'two'])
    expect(new Set(r.sent('sing.play').map((m) => m.song_id)).size).toBe(2)
    await until(() => r.told.length === 2, 4000)
    expect(r.told[1]).toContain('"two" (requested by bob)')
    expect(doneCalls(r).map((b) => b.outcome)).toEqual(['done', 'done'])
  })

  it("the pack's texts are the operator's to change: a credit and a closing line from files in config/modes", async () => {
    const r = await singRig({ stage: { playMs: 100 } })
    r.fake.ready('晴天', { artists: [], requester_name: '' })
    await until(() => r.sent('sing.play').length === 1, 5000)
    // no artists and nobody's name: only the title is shown
    expect(lastOverlay(r, 'credit')).toMatchObject({ visible: true, text: '♪ 晴天' })
    await until(() => r.told.length === 1, 4000)
    expect(r.told[0]).toBe(
      '【系统】You have just finished singing "晴天". Say one closing line in character.'
    )
  })

  it('a song without lyrics or a credit (settings) shows neither', async () => {
    const r = await singRig({ settings: { lyrics: false, credit: false }, stage: { playMs: 100 } })
    r.fake.ready('晴天')
    await until(() => r.told.length === 1, 5000)
    expect(overlays(r, 'lyrics').filter((o) => o.visible === true)).toEqual([])
    expect(overlays(r, 'credit').filter((o) => o.visible === true)).toEqual([])
  })
})

describe('when a song may start', () => {
  it('it waits for the reply being spoken to end, and holds nothing while it waits', async () => {
    const r = await singRig()
    let release!: () => void
    r.quiet.wait = new Promise((res) => (release = res))
    r.fake.ready('晴天')
    await until(() => phase(r) === 'pending', 3000, 'pending')
    expect(r.service.viewOf('sing').panel!.status).toContain('waiting for the voice')
    await sleep(300)
    expect(r.fake.callsTo('/claim')).toEqual([])
    expect(r.flags.singing).toBe(false)
    expect(r.held).toEqual([])
    release()
    await until(
      () => r.sent('sing.play').length === 1,
      4000,
      'sing.play after the voice went quiet'
    )
  })

  it('a voice that stays busy: no song, no flag, and it is tried again later', async () => {
    const r = await singRig()
    r.quiet.answer = false
    r.fake.ready('晴天')
    await sleep(500)
    expect(r.fake.callsTo('/claim')).toEqual([])
    expect(r.flags.singing).toBe(false)
    expect(phase(r)).toBe('idle')
    r.quiet.answer = true
    await until(() => r.sent('sing.play').length === 1, 4000, 'sing.play once the voice is free')
  })

  it('another mode that excludes it (a dance) keeps it waiting without a claim or a flag, and it sings when that ends', async () => {
    const r = await singRig({ withDance: true, settings: { retry_after_sec: 1 } })
    await r.service.enter('dance')
    r.fake.ready('晴天')
    await until(
      () => r.events.some((e) => e.includes('could not start')),
      4000,
      'the refusal noted'
    )
    expect(r.events.find((e) => e.includes('could not start'))).toContain('sing excludes dance')
    expect(r.fake.callsTo('/claim')).toEqual([])
    expect(r.flags.singing).toBe(false)
    expect(r.alarms).toEqual([])
    await r.service.exit('dance')
    await until(() => r.sent('sing.play').length === 1, 5000, 'sing.play after the dance')
  })

  it('a refusal is not repeated at every look (the audience is not held over and over)', async () => {
    const r = await singRig({ withDance: true, settings: { retry_after_sec: 5 } })
    await r.service.enter('dance')
    r.fake.ready('晴天')
    await until(() => r.entered.length >= 1, 3000)
    await sleep(600)
    expect(r.entered.length).toBe(1) // one try, then the pause
  })

  it('no stage connected: the song waits, and nothing is claimed', async () => {
    const r = await singRig()
    r.hub.connected = false
    r.fake.ready('晴天')
    await sleep(500)
    expect(r.fake.callsTo('/claim')).toEqual([])
    r.hub.connected = true
    await until(() => r.sent('sing.play').length === 1, 4000, 'sing.play with a stage')
  })

  it('two triggers at once (the watcher and a press of the button) claim one song', async () => {
    const r = await singRig({ settings: { poll_sec: 60 } })
    await until(() => r.ctl.status().serviceUp === true, 3000, 'the first look')
    r.fake.ready('晴天')
    const [a, b] = await Promise.all([
      r.ctl.onConsoleRequest!({ action: 'play' }),
      r.ctl.onConsoleRequest!({ action: 'play' }),
    ])
    expect(a).toEqual({ ok: true })
    expect(b.ok === true || b.reason?.includes('already')).toBe(true)
    await until(() => r.sent('sing.play').length === 1, 4000)
    await sleep(300)
    expect(r.fake.callsTo('/claim').length).toBe(1)
  })
})

describe('a song that does not go well', () => {
  it('the stage never answers: the start fails with an alarm, the song is given back as failed, nothing is left held', async () => {
    const r = await singRig({ stage: { mode: 'silent' }, settings: { start_timeout_sec: 1 } })
    r.fake.ready('晴天')
    await until(() => r.alarmCodes().includes('sing_failed'), 5000, 'the alarm')
    expect(r.alarms.find((a) => a.code === 'sing_failed')!.message).toContain(
      'did not answer in time'
    )
    await until(() => r.service.state('sing') === 'IDLE', 3000)
    expect(doneCalls(r)).toHaveLength(1)
    expect(doneCalls(r)[0]).toMatchObject({ qid: 1, outcome: 'failed' })
    expect(r.sent('sing.stop')).toHaveLength(1) // the stage is told to drop whatever it has
    expect(r.told).toEqual([])
    expectClean(r)
    // the song is a failed entry now, not a ready one: the watcher does not try it again and again
    await sleep(1400)
    expect(r.sent('sing.play')).toHaveLength(1)
  })

  it('the stage fails at once with a reason: the alarm carries its words', async () => {
    const r = await singRig({ stage: { mode: 'error' } })
    r.fake.ready('晴天')
    await until(() => r.alarmCodes().includes('sing_failed'), 5000)
    expect(r.alarms.find((a) => a.code === 'sing_failed')!.message).toContain('no such track')
    await until(() => r.service.state('sing') === 'IDLE', 3000)
    expect(doneCalls(r)[0]).toMatchObject({ outcome: 'failed' })
    expectClean(r)
  })

  it('the stage ends the song at once without a word: the alarm says what it reported', async () => {
    const r = await singRig({ stage: { mode: 'idle_at_once' } })
    r.fake.ready('晴天')
    await until(() => r.alarmCodes().includes('sing_failed'), 5000)
    expect(r.alarms.find((a) => a.code === 'sing_failed')!.message).toContain(
      'ended the song at once (cancelled)'
    )
    await until(() => r.service.state('sing') === 'IDLE', 3000)
    expectClean(r)
  })

  it('a success afterwards clears the alarm', async () => {
    const r = await singRig({ stage: { mode: 'error' }, settings: { retry_after_sec: 1 } })
    r.fake.ready('晴天')
    await until(() => r.alarmCodes().includes('sing_failed'), 5000)
    r.stage.mode = 'auto'
    r.fake.ready('后来')
    await until(() => r.sent('sing.play').length === 2, 5000, 'the next song')
    await until(() => phase(r) === 'playing', 3000)
    expect(r.alarmCodes()).not.toContain('sing_failed')
  })

  it('a stage that is not there when the song is sent (no answer to the send) is a failure', async () => {
    const r = await singRig()
    r.hub.connected = undefined as never // the hub does not say, and the send reports that nobody is connected
    r.fake.ready('晴天')
    await until(() => r.alarmCodes().includes('sing_failed'), 5000)
    expect(r.alarms.find((a) => a.code === 'sing_failed')!.message).toContain(
      'the stage is not connected'
    )
    await until(() => r.service.state('sing') === 'IDLE', 3000)
    expectClean(r)
  })

  it('files whose names could not be served are a failure of that song, not a crash', async () => {
    const r = await singRig()
    r.fake.filesOverride = { dir: '..', vocals: 'vocals_final.wav', inst: 'inst_final.wav' }
    r.fake.ready('晴天')
    await until(() => r.alarmCodes().includes('sing_failed'), 5000)
    expect(r.alarms.find((a) => a.code === 'sing_failed')!.message).toContain(
      'not a safe asset path segment'
    )
    expect(r.sent('sing.play')).toEqual([])
    await until(() => r.service.state('sing') === 'IDLE', 3000)
    expectClean(r)
  })

  it('a song taken off the queue between the look and the claim is not a failure', async () => {
    const r = await singRig({ settings: { retry_after_sec: 5 } })
    r.fake.claimNothing = true
    r.fake.ready('晴天')
    await until(() => r.fake.callsTo('/claim').length === 1, 4000)
    await until(() => r.service.state('sing') === 'IDLE' && r.held.length >= 2, 3000)
    expect(r.alarms).toEqual([])
    expect(r.sent('sing.play')).toEqual([])
    expectClean(r)
    await sleep(500)
    expect(r.fake.callsTo('/claim').length).toBe(1) // not tried again at every look
  })

  it('a claim that fails (the service went away between the look and the claim) raises an alarm, keeps the song, and it is tried again', async () => {
    const r = await singRig({ settings: { retry_after_sec: 1 } })
    r.fake.answer('/claim', {
      status: 500,
      body: { error: { code: 'internal', message: 'boom', retryable: false } },
    })
    r.fake.ready('晴天')
    await until(() => r.alarmCodes().includes('sing_failed'), 5000)
    expect(r.alarmCodes()).toContain('mode_start_failed')
    expect(r.fake.items[0]).toMatchObject({ title: '晴天', state: 'ready' }) // nothing was lost
    expectClean(r)
    await until(() => r.sent('sing.play').length === 1, 5000, 'the second try')
  })

  it('the operator ending the mode while the song is still loading gives the song back and is not an alarm', async () => {
    const r = await singRig({
      stage: { mode: 'silent' },
      settings: { start_timeout_sec: 10, retry_after_sec: 1 },
    })
    r.fake.ready('晴天')
    await until(() => r.sent('sing.play').length === 1, 5000)
    await r.service.exit('sing', 'console')
    await until(() => doneCalls(r).length === 1, 3000, 'the song given back')
    expect(doneCalls(r)[0]).toMatchObject({ qid: 1, outcome: 'released' })
    expect(r.fake.items[0]).toMatchObject({ title: '晴天', state: 'ready' }) // still at the front of the queue
    expect(r.alarmCodes()).not.toContain('sing_failed')
    expect(r.alarmCodes()).not.toContain('mode_start_failed')
    expectClean(r)
    expect(r.sent('sing.stop').length).toBeGreaterThanOrEqual(1)
    await sleep(500)
    expect(r.sent('sing.play')).toHaveLength(1) // not straight back on
  })
})

describe('a song that is cut short', () => {
  it('a viewer skip: the stage fades it out, the service is told "skipped", the model gets the cut-off line, and the next song follows', async () => {
    const r = await singRig({ stage: { playMs: 5000 } })
    r.fake.ready('one', { requester_name: 'ann' })
    r.fake.ready('two', { requester_name: 'bob' })
    r.brain.busy = true
    await until(() => phase(r) === 'playing', 5000)
    await r.service.songCommand({ kind: 'skip', uid: 9, name: 'mod' })
    expect(r.sent('sing.stop')[0]).toMatchObject({ fade_s: 0.6 })
    await until(() => r.told.length === 1, 4000, 'the cut-off line')
    expect(r.told[0]).toBe(
      '【系统】The song "one" (requested by ann) that you were singing was cut off before the end. Say one short line about it in character.'
    )
    expect(doneCalls(r)[0]).toMatchObject({ qid: 1, outcome: 'skipped' })
    await until(() => r.sent('sing.play').length === 2, 6000, 'the next song')
    expect(r.sent('sing.play')[1]).toMatchObject({ title: 'two' })
  })

  it('a skip while the song is still loading is done as soon as it plays', async () => {
    const r = await singRig({ stage: { loadMs: 300, playMs: 5000 } })
    r.fake.ready('晴天')
    await until(() => r.sent('sing.play').length === 1, 5000)
    expect(phase(r)).toBe('loading')
    await r.service.songCommand({ kind: 'skip', uid: 9, name: 'mod' })
    expect(r.sent('sing.stop')).toHaveLength(0) // nothing to stop yet
    await until(() => r.sent('sing.stop').length === 1, 3000, 'the stop once it plays')
    await until(() => r.told.length === 1, 4000)
    expect(doneCalls(r)[0]).toMatchObject({ outcome: 'skipped' })
  })

  it('a viewer cancelling their own song while it is sung stops it', async () => {
    const r = await singRig({ stage: { playMs: 5000 } })
    r.fake.ready('晴天', { requester_uid: '1001', requester_name: 'ann' })
    await until(() => phase(r) === 'playing', 5000)
    await r.service.songCommand({ kind: 'cancel', uid: 1001, name: 'ann' })
    expect(r.songLines).toEqual([FORMATS.songCancelledWhilePlaying('ann', '晴天')])
    await until(() => r.sent('sing.stop').length === 1, 3000)
    await until(() => r.service.state('sing') === 'IDLE', 4000)
    expect(r.told[0]).toContain('cut off before the end')
  })

  it('the stage that never says it has stopped does not hold the voice for ever', async () => {
    const r = await singRig({
      stage: { playMs: 5000, stopHangs: true },
      settings: { stop_timeout_sec: 1, stop_fade_s: 0.2 },
    })
    r.fake.ready('晴天')
    await until(() => phase(r) === 'playing', 5000)
    const t0 = Date.now()
    await r.service.songCommand({ kind: 'skip', uid: 9, name: 'mod' })
    await until(() => r.service.state('sing') === 'IDLE', 4000, 'the mode left')
    expect(Date.now() - t0).toBeLessThan(3500)
    expect(doneCalls(r)[0]).toMatchObject({ outcome: 'skipped' })
    expect(r.held.at(-1)).toEqual(['sing', false])
  })

  it('the stage reports an error in the middle: an alarm with its words, "interrupted", and no closing line', async () => {
    const r = await singRig({ stage: { playMs: 5000 } })
    r.fake.ready('晴天')
    await until(() => phase(r) === 'playing', 5000)
    r.report('idle', { reason: 'error', error: 'the decoder died' })
    await until(() => r.service.state('sing') === 'IDLE', 4000)
    expect(r.alarms.find((a) => a.code === 'sing_failed')!.message).toContain('the decoder died')
    expect(doneCalls(r)[0]).toMatchObject({ outcome: 'interrupted' })
    expect(r.told).toEqual([])
    expectClean(r)
  })

  it('the stage page going away takes the song with it: interrupted, an alarm, everything released', async () => {
    const r = await singRig({ stage: { playMs: 5000 } })
    r.fake.ready('晴天')
    await until(() => phase(r) === 'playing', 5000)
    r.hub.emit('disconnected', { sessionId: 's', code: 1006, reason: 'gone', replaced: false })
    await until(() => r.service.state('sing') === 'IDLE', 4000)
    expect(r.alarms.find((a) => a.code === 'sing_failed')!.message).toContain(
      'the stage disconnected'
    )
    expect(doneCalls(r)[0]).toMatchObject({ outcome: 'interrupted' })
    expect(r.told).toEqual([])
    expectClean(r)
  })

  it('the stage page going away while the song is loading is a failed start', async () => {
    const r = await singRig({ stage: { mode: 'silent' }, settings: { start_timeout_sec: 10 } })
    r.fake.ready('晴天')
    await until(() => r.sent('sing.play').length === 1, 5000)
    r.hub.emit('disconnected', { sessionId: 's', code: 1006, reason: 'gone', replaced: false })
    await until(() => r.alarmCodes().includes('sing_failed'), 3000)
    await until(() => r.service.state('sing') === 'IDLE', 3000)
    expect(doneCalls(r)[0]).toMatchObject({ outcome: 'failed' })
    expectClean(r)
  })

  it('a song the stage does not report the end of is given up on some time after it should have ended', async () => {
    const r = await singRig({
      stage: { playMs: 60_000 },
      settings: { watchdog_extra_sec: 1, start_delay_s: 0.2 },
    })
    r.fake.ready('晴天', { duration: 1 })
    await until(() => phase(r) === 'playing', 5000)
    const t0 = Date.now()
    await until(() => r.service.state('sing') === 'IDLE', 6000, 'the watchdog')
    expect(Date.now() - t0).toBeGreaterThan(1500)
    expect(r.alarms.find((a) => a.code === 'sing_failed')!.message).toContain(
      'did not report the end'
    )
    expect(r.sent('sing.stop').length).toBeGreaterThanOrEqual(1)
    expect(doneCalls(r)[0]).toMatchObject({ outcome: 'interrupted' })
    expectClean(r)
  })

  it('a shutdown in the middle of a song is prompt: the stage is told, the service is told, nothing is left held', async () => {
    const r = await singRig({ stage: { playMs: 60_000 } })
    r.fake.ready('晴天')
    await until(() => phase(r) === 'playing', 5000)
    const t0 = Date.now()
    await r.service.dispose()
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.sent('sing.stop')).toHaveLength(1)
    expect(doneCalls(r)[0]).toMatchObject({ outcome: 'interrupted', reason: 'shutdown' })
    expect(r.told).toEqual([])
    expect(r.service.state('sing')).toBe('IDLE')
    expect(r.flags.singing).toBe(false)
    expect(r.held.at(-1)).toEqual(['sing', false])
  })

  it('a shutdown while a song waits for the voice does not start it afterwards', async () => {
    const r = await singRig()
    let release!: () => void
    r.quiet.wait = new Promise((res) => (release = res))
    r.fake.ready('晴天')
    await until(() => phase(r) === 'pending', 3000)
    await r.service.dispose()
    expect(r.flags.singing).toBe(false)
    release()
    await sleep(400)
    expect(r.fake.callsTo('/claim')).toEqual([])
    expect(r.sent('sing.play')).toEqual([])
  })

  it('what the operator stops with the Exit button or the Stop button ends the song without a closing line and keeps the queue, paused', async () => {
    for (const how of ['exit', 'stop'] as const) {
      const r = await singRig({ stage: { playMs: 60_000 } })
      r.fake.ready('one')
      r.fake.ready('two')
      await until(() => phase(r) === 'playing', 5000)
      if (how === 'exit') await r.service.exit('sing', 'console')
      else expect(await r.ctl.onConsoleRequest!({ action: 'stop' })).toEqual({ ok: true })
      await until(() => r.service.state('sing') === 'IDLE', 4000)
      expect(doneCalls(r)[0]).toMatchObject({ qid: 1, outcome: 'stopped', reason: 'console' })
      expect(r.told).toEqual([])
      expectClean(r)
      // "two" is still queued but nothing is sung until the operator says so
      expect(r.ctl.status().paused).toBe(true)
      await sleep(500)
      expect(r.sent('sing.play')).toHaveLength(1)
      expect(r.fake.items.map((i) => i.title)).toEqual(['two'])
      expect(r.service.viewOf('sing').panel!.status).toContain('paused')
      expect(await r.ctl.onConsoleRequest!({ action: 'resume' })).toEqual({ ok: true })
      await until(() => r.sent('sing.play').length === 2, 5000, 'singing again after resume')
    }
  })
})
