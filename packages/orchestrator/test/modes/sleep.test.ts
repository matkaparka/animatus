import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { ModePanel } from '@animatus/protocol'
import { parseConfig } from '../../src/config.ts'
import { FORMATS } from '../../src/inbox/formats.ts'
import { defaultInboxConfig } from '../../src/inbox/types.ts'
import { SleepSettings } from '../../src/modes/controllers/sleep.ts'
import {
  MODES,
  NEUTRAL,
  SHORT,
  WHISPER,
  enterAndPlay,
  file,
  installSleepRig,
  panel,
  rig,
  rowOf,
  sleepBatch,
  tempDir,
  tick,
  untilRead,
  urls,
} from './sleepRig.ts'

installSleepRig()

// ─────────────────────────────── entering and leaving ───────────────────────────────

describe('entering and leaving', () => {
  it('entering: the flag, the whisper voice, what is being said stops, and the first track goes to the stage with the settings', async () => {
    const r = await rig({ settings: { volume: 0.7, fade_in_s: 2 } })
    await r.service.enter('sleep')
    expect(r.flags.sleeping).toBe(true)
    expect(r.styles).toEqual(['whisper'])
    expect(r.stopped).toEqual(['sleep mode'])
    expect(r.plays()).toHaveLength(1)
    expect(r.lastPlay()).toMatchObject({
      type: 'sleep.play',
      url: '/asset/asmr/rain.mp3',
      volume: 0.7,
      fade_in_s: 2,
      captions: [{ text: 'rain line', start: 1, end: 3 }],
    })
    await tick(50)
    expect(r.ctl.status()).toMatchObject({ running: true, track: 'rain', stage: 'playing' })
    expect(r.service.state('sleep')).toBe('ACTIVE')
    expect(r.alarms).toEqual([])
  })

  it('the pack asks for what the legacy mode measured: preempts, the calm look, the night background, the hotkey', async () => {
    const r = await rig()
    expect(r.service.manifest('sleep')).toMatchObject({
      id: 'sleep',
      priority: 100,
      preempts: true,
      prompt: 'prompts/active.md',
      requires: { services: [], vram_mb_est: 0 },
      triggers: { hotkey: 'ctrl+alt+n' },
      stage: {
        background: 'night',
        look: {
          calm: 1,
          motion_scale: 1,
          mouth_scale: 0.4,
          lip_range: { min: -2.6, max: -1 },
        },
      },
    })
    // it costs nothing on the card, so it is always admitted
    expect(r.service.viewOf('sleep').admission).toMatchObject({ ok: true, totalMb: 0 })
  })

  it('leaving: the track is stopped with a fade, the voice and the flag are back, nothing is held, and leaving twice is harmless', async () => {
    const r = await rig({ settings: { fade_s: 2.5 } })
    await enterAndPlay(r)
    await r.service.exit('sleep', 'console')
    expect(r.hub.delivered.find((m) => m.type === 'sleep.stop')).toMatchObject({ fade_s: 2.5 })
    expect(r.styles).toEqual(['whisper', null])
    expect(r.flags.sleeping).toBe(false)
    expect(r.held).toEqual([])
    expect(r.alarms).toEqual([])
    expect(r.ctl.status()).toMatchObject({ running: false, track: null })
    expect(r.events.at(-1)).toBe('sleep mode over (console)')
    await r.service.exit('sleep', 'again')
    expect(r.hub.delivered.filter((m) => m.type === 'sleep.stop')).toHaveLength(1)
    expect(r.styles).toEqual(['whisper', null])
    await tick(30_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaving and entering again starts a clean run', async () => {
    const r = await rig()
    await enterAndPlay(r)
    await r.service.exit('sleep', 'console')
    await tick(50)
    await enterAndPlay(r)
    expect(r.flags.sleeping).toBe(true)
    expect(r.ctl.status()).toMatchObject({ running: true, stage: 'playing' })
    expect(r.plays()).toHaveLength(2)
  })

  it('stopped while the folder is still being read: nothing is set, nothing is sent, even when the read finishes later', async () => {
    const r = await rig()
    let open!: () => void
    r.library.gate = new Promise<void>((res) => (open = res))
    const entering = r.service.enter('sleep').catch((e: Error) => e)
    await tick(10)
    await r.service.exit('sleep', 'console')
    expect(await entering).toBeInstanceOf(Error)
    open()
    await tick(50)
    expect(r.service.state('sleep')).toBe('IDLE')
    expect(r.flags.sleeping).toBe(false)
    expect(r.styles).toEqual([])
    expect(r.stopped).toEqual([])
    expect(r.hub.attempted).toEqual([])
  })

  it('a shutdown in the middle of a reply leaves nothing behind: no hold, no flag, the voice back, no timer', async () => {
    const r = await rig()
    await enterAndPlay(r)
    await r.reply()
    await tick(100)
    expect(r.held).toEqual([['sleep', true]])
    await r.service.dispose()
    expect(r.held).toEqual([
      ['sleep', true],
      ['sleep', false],
    ])
    expect(r.flags.sleeping).toBe(false)
    expect(r.styles).toEqual(['whisper', null])
    expect(r.stopped).toEqual(['sleep mode', 'sleep mode ended']) // the half-said whisper is cut, not finished in the normal voice
    expect(r.alarms).toEqual([])
    expect(r.hub.listenerCount('sleep.state')).toBe(0)
    expect(r.hub.listenerCount('connected')).toBe(0)
    expect(r.hub.listenerCount('disconnected')).toBe(0)
    await tick(10) // the stage's own report of the stop
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ─────────────────────────────── the stage coming and going ───────────────────────────────

describe('the stage page', () => {
  it('none connected when the mode starts: it starts anyway, and the track is sent when a page connects', async () => {
    const r = await rig({ stage: { connected: false } })
    await r.service.enter('sleep')
    expect(r.service.state('sleep')).toBe('ACTIVE')
    expect(r.hub.delivered).toEqual([])
    expect(panel(r).status).toContain('waiting for the stage page')
    expect(r.alarms).toEqual([])
    r.hub.connectStage()
    await tick(50)
    expect(urls(r)).toEqual(['rain.mp3'])
    expect(r.ctl.status().stage).toBe('playing')
  })

  it('a page that connects later has no track, so the current one starts again from its beginning; what the old page reports is ignored', async () => {
    const r = await rig()
    await enterAndPlay(r)
    const first = r.lastPlay().track_id
    r.hub.disconnectStage()
    r.hub.connectStage()
    await tick(50)
    expect(urls(r)).toEqual(['rain.mp3', 'rain.mp3'])
    expect(r.lastPlay().track_id).not.toBe(first)
    r.hub.emit('sleep.state', { type: 'sleep.state', track_id: first, phase: 'ended' })
    await tick(50)
    expect(urls(r)).toEqual(['rain.mp3', 'rain.mp3']) // the old page's news moved nothing
    expect(r.ctl.status().stage).toBe('playing')
  })

  it('the page goes away in the middle of a reply and is back before it ends: the track is played again, not resumed', async () => {
    const r = await rig()
    await enterAndPlay(r)
    const reply = await r.reply()
    await tick(100)
    r.hub.disconnectStage()
    r.hub.connectStage()
    await tick(100)
    expect(urls(r)).toEqual(['rain.mp3']) // nothing goes on top of the whisper
    reply.finish()
    await tick(3000)
    expect(urls(r)).toEqual(['rain.mp3', 'rain.mp3'])
    expect(r.types()).not.toContain('sleep.resume')
    expect(r.ctl.status()).toMatchObject({ stage: 'playing', replying: false })
  })

  it('the page is still away when the reply ends: nothing is lost, the track is sent when it comes back', async () => {
    const r = await rig()
    await enterAndPlay(r)
    const reply = await r.reply()
    r.hub.disconnectStage()
    reply.finish()
    await tick(3000)
    expect(r.ctl.status().replying).toBe(false)
    expect(urls(r)).toEqual(['rain.mp3'])
    r.hub.connectStage()
    await tick(100)
    expect(urls(r)).toEqual(['rain.mp3', 'rain.mp3'])
    expect(r.ctl.status().stage).toBe('playing')
  })

  it('a stage that never answers a track: it counts as failed after the timeout and the next one is tried', async () => {
    const r = await rig({ stage: { mode: 'silent' }, settings: { start_timeout_s: 5 } })
    await r.service.enter('sleep')
    await tick(4_900)
    expect(urls(r)).toEqual(['rain.mp3'])
    await tick(200)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3'])
    expect(r.events.join('\n')).toContain('the stage did not start it within 5 s')
  })

  it('a stage that says loading and never plays is treated the same way', async () => {
    const r = await rig({ stage: { mode: 'stuck' }, settings: { start_timeout_s: 5 } })
    await r.service.enter('sleep')
    await tick(5_100)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3'])
  })

  it('every track failing, one after the other, is one alarm with the last reason, and the mode stays up', async () => {
    const r = await rig({ stage: { mode: 'silent' }, settings: { start_timeout_s: 5 } })
    await r.service.enter('sleep')
    await tick(16_000)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3', 'waves.mp3'])
    expect(r.alarms).toHaveLength(1)
    expect(r.alarms[0]).toMatchObject({ code: 'sleep_tracks', level: 'error' })
    expect(r.alarms[0]!.message).toContain('none of the 3 track(s) could be played')
    expect(r.alarms[0]!.message).toContain('"waves": the stage did not start it')
    expect(r.service.state('sleep')).toBe('ACTIVE')
    expect(r.ctl.status().idle).toBe('failed')
    expect(panel(r).status).toContain('no track could be played')
    await tick(60_000)
    expect(r.plays()).toHaveLength(3) // it does not keep trying
  })

  it('a new page gets another chance after every track failed', async () => {
    const r = await rig({ stage: { mode: 'silent' }, settings: { start_timeout_s: 5 } })
    await r.service.enter('sleep')
    await tick(16_000)
    expect(r.ctl.status().idle).toBe('failed')
    r.hub.stage.opts.mode = 'auto'
    r.hub.disconnectStage()
    r.hub.connectStage()
    await tick(100)
    expect(r.ctl.status()).toMatchObject({ idle: null, stage: 'playing' })
    expect(r.alarms).toEqual([])
  })

  it('a page that comes while a reply is being whispered still gets its chance once the reply is over', async () => {
    const r = await rig({ stage: { mode: 'error' } })
    await r.service.enter('sleep')
    await tick(200)
    expect(r.ctl.status().idle).toBe('failed')
    const reply = await r.reply()
    r.hub.stage.opts.mode = 'auto'
    r.hub.disconnectStage()
    r.hub.connectStage()
    await tick(200)
    expect(r.ctl.status()).toMatchObject({ replying: true, idle: null })
    expect(r.plays()).toHaveLength(3) // nothing is put on top of the whisper
    reply.finish()
    await tick(3_000)
    expect(r.ctl.status()).toMatchObject({ replying: false, idle: null, stage: 'playing' })
    expect(r.alarms).toEqual([])
  })
})

// ─────────────────────────────── the playlist ───────────────────────────────

describe('the playlist', () => {
  it('plays the tracks in turn when each ends, and starts over', async () => {
    const r = await rig({ stage: SHORT })
    await r.service.enter('sleep')
    await tick(4_200) // a track takes 1021 ms here: 20 to load, 1000 to play, 1 for the report
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3', 'waves.mp3', 'rain.mp3', 'ocean.mp3'])
    expect(r.alarms).toEqual([])
  })

  it('does not loop when told not to: the playlist ends, the mode stays up for the whispers, "next" starts it again', async () => {
    const r = await rig({ settings: { loop: false }, stage: SHORT })
    await r.service.enter('sleep')
    await tick(1_100 * 3 + 500)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3', 'waves.mp3'])
    expect(r.ctl.status().idle).toBe('finished')
    expect(panel(r).status).toContain('the playlist has ended')
    expect(r.service.state('sleep')).toBe('ACTIVE')
    expect(await r.ctl.onConsoleRequest!({ action: 'next' })).toEqual({ ok: true })
    await tick(50)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3', 'waves.mp3', 'rain.mp3'])
  })

  it('shuffled: every track once per round, and a round never starts with the track that ended the last', async () => {
    let seed = 7
    const random = () => {
      // mulberry32: any fixed sequence will do
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const keys = ['a', 'b', 'c', 'd', 'e']
    const r = await rig({
      tracks: keys.map((k) => file(k)),
      settings: { shuffle: true },
      stage: SHORT,
      random,
    })
    await r.service.enter('sleep')
    await tick(1_100 * 5 * 8)
    const played = urls(r).map((u) => (u as string).replace('.mp3', ''))
    expect(played.length).toBeGreaterThanOrEqual(30)
    for (let round = 0; round + 5 <= played.length; round += 5)
      expect([...played.slice(round, round + 5)].sort()).toEqual(keys)
    for (let i = 1; i < played.length; i++) expect(played[i]).not.toBe(played[i - 1])
  })

  it('a track the stage cannot play is skipped, the next one plays, and it is tried again next round', async () => {
    const r = await rig({ stage: { ...SHORT, broken: new Set(['ocean.mp3']) } })
    await r.service.enter('sleep')
    await tick(1_050) // ocean has just failed, waves has not started playing yet
    expect(r.events.join('\n')).toContain('"ocean": cannot read the track (fake)')
    expect(panel(r).facts.find((f) => f.label === 'Last problem')!.value).toContain('"ocean"')
    await tick(2_100)
    expect(urls(r).slice(0, 4)).toEqual(['rain.mp3', 'ocean.mp3', 'waves.mp3', 'rain.mp3'])
    expect(r.alarms).toEqual([]) // one bad file among good ones is not an alarm
    expect(panel(r).facts.find((f) => f.label === 'Last problem')).toBeUndefined() // a track played since
  })

  it('every track failing to load is one alarm; playing one from the console clears it', async () => {
    const r = await rig({ stage: { mode: 'error' } })
    await r.service.enter('sleep')
    await tick(200)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3', 'waves.mp3'])
    expect(r.alarms).toHaveLength(1)
    expect(r.alarms[0]!.message).toContain('cannot read the track (fake)')
    r.hub.stage.opts.mode = 'auto'
    expect(await r.ctl.onConsoleRequest!({ action: 'play', row: 'ocean' })).toEqual({ ok: true })
    await tick(100)
    expect(r.ctl.status()).toMatchObject({ track: 'ocean', stage: 'playing', idle: null })
    expect(r.alarms).toEqual([])
  })

  it('a track the stage refuses to be sent (a caption too long for the protocol) is a failure of that track, not of the mode', async () => {
    const r = await rig({
      tracks: [
        file('bad', { captions: [{ text: 'x'.repeat(3000), start: 0, end: 1 }] }),
        file('good'),
      ],
    })
    await r.service.enter('sleep')
    await tick(100)
    expect(urls(r)).toEqual(['good.mp3'])
    expect(r.events.join('\n')).toContain('"bad": the stage protocol refused it')
    expect(r.service.state('sleep')).toBe('ACTIVE')
  })

  it('captions can be left out of what is sent', async () => {
    const r = await rig({ settings: { captions: false } })
    await r.service.enter('sleep')
    expect(r.lastPlay()).toMatchObject({ captions: [] })
  })

  it('a name the stage cannot fetch is left out of the list and said so on the panel', async () => {
    const r = await rig({ tracks: [file('fine'), file('a:b')] })
    await r.service.enter('sleep')
    expect(urls(r)).toEqual(['fine.mp3'])
    const left = panel(r).facts.find((f) => f.label === 'Left out')!
    expect(left.value).toContain('a:b')
    expect(left.value).toContain('not a safe asset path segment')
  })
})

describe('no tracks', () => {
  it('no library folder configured: the mode still starts, says so, and answers chat without a track to pause', async () => {
    const r = await rig({ noLibrary: true })
    await r.service.enter('sleep')
    expect(r.service.state('sleep')).toBe('ACTIVE')
    expect(r.flags.sleeping).toBe(true)
    expect(r.ctl.status().idle).toBe('empty')
    expect(r.hub.attempted).toEqual([])
    expect(panel(r).status).toContain('only whispered replies')
    expect(panel(r).facts.find((f) => f.label === 'Tracks')!.value).toContain(
      'paths.asmr is not set'
    )
    expect(r.alarms).toHaveLength(1)
    expect(r.alarms[0]).toMatchObject({ code: 'sleep_tracks', level: 'warn' })
    expect(r.alarms[0]!.message).toContain('paths.asmr is not set')

    const reply = await r.reply()
    expect(reply.lines).toHaveLength(1)
    expect(r.types()).toEqual([]) // nothing to pause
    expect(r.held).toEqual([])
    reply.finish()
    await tick(3000)
    expect(r.ctl.status().replying).toBe(false)
  })

  it('an empty folder is the same, and a track that appears later starts playing', async () => {
    const r = await rig({ tracks: [] })
    await r.service.enter('sleep')
    expect(r.ctl.status().idle).toBe('empty')
    expect(r.alarms[0]!.message).toContain('no audio files were found')
    expect(panel(r).sections[0]!.empty).toContain('No audio files')
    r.library.tracks = [file('rain')]
    r.clock.now += 20_000
    r.service.viewOf('sleep') // the console looking at the panel is what checks the folder again
    await tick(50)
    expect(urls(r)).toEqual(['rain.mp3'])
    expect(r.ctl.status()).toMatchObject({ idle: null, stage: 'playing' })
    expect(r.alarms).toEqual([])
  })

  it('a folder that cannot be read keeps the list it had and says why', async () => {
    const r = await rig()
    await enterAndPlay(r)
    r.library.fails = 'EPERM: operation not permitted'
    r.clock.now += 20_000
    r.service.viewOf('sleep')
    await tick(50)
    expect(r.ctl.status().tracks).toBe(3)
    const folder = panel(r).facts.find((f) => f.label === 'Folder')!
    expect(folder.value).toContain('cannot be read')
    expect(folder.value).toContain('EPERM')
    r.library.fails = null
    r.clock.now += 20_000
    r.service.viewOf('sleep')
    await tick(50)
    expect(panel(r).facts.find((f) => f.label === 'Folder')).toBeUndefined()
  })

  it('a folder that never answers does not hold the mode up for longer than a moment', async () => {
    const r = await rig({ tracks: [] })
    r.library.hangs = true
    r.clock.now += 20_000
    const reads = r.library.reads
    const entering = r.service.enter('sleep')
    await untilRead(r, reads + 1) // the read has begun, and so has the wait for it
    await tick(10_100)
    await entering
    expect(r.service.state('sleep')).toBe('ACTIVE')
    expect(r.alarms[0]!.message).toContain('reading the folder took too long')
  })
})

// ─────────────────────────────── replies ───────────────────────────────

describe('a reply', () => {
  it('the track fades out, the voice waits for the fade, the model gets the reply line, and the track comes back after everything has been quiet', async () => {
    const r = await rig({
      settings: { fade_s: 1, fade_in_s: 1.5, reply_resume_delay_s: 1.5, volume: 0.6 },
    })
    await enterAndPlay(r)
    const reply = await r.reply()
    expect(reply.lines).toHaveLength(1)
    expect(r.hub.delivered.at(-1)).toMatchObject({ type: 'sleep.pause', fade_s: 1 })
    expect(r.held).toEqual([['sleep', true]])
    expect(r.ctl.status().replying).toBe(true)
    await tick(1_100)
    expect(r.held).toEqual([
      ['sleep', true],
      ['sleep', false],
    ]) // the fade is over: the whisper may be sent
    await tick(10_000)
    expect(r.types()).not.toContain('sleep.resume') // the reply is still being spoken
    reply.finish()
    await tick(1_400)
    expect(r.types()).not.toContain('sleep.resume') // not before the quiet has lasted
    await tick(200)
    expect(r.hub.delivered.at(-1)).toMatchObject({ type: 'sleep.resume', fade_s: 1.5, volume: 0.6 })
    await tick(50)
    expect(r.ctl.status()).toMatchObject({ stage: 'playing', replying: false })
    expect(r.plays()).toHaveLength(1) // the same track, from where it was
  })

  it("the line the model gets is the pack's reply prompt and never carries the viewer's words", async () => {
    const r = await rig()
    await enterAndPlay(r)
    const reply = await r.reply()
    expect(reply.lines[0]).toContain(FORMATS.sleepPrefix)
    expect(reply.lines[0]).toBe(r.service.prompt('sleep', 'reply'))
    expect(reply.lines[0]).not.toContain('Zed42')
    expect(reply.lines[0]).not.toContain('moonbeam')
    expect(reply.lines[0]).not.toMatch(/\{\{/)
    reply.finish()
  })

  it('a reply the model never gave (no speech at all) still lets the track come back', async () => {
    const r = await rig()
    await enterAndPlay(r)
    await r.service.batchExtras(sleepBatch() as never) // nothing is busy afterwards: the model failed, or was cancelled
    await tick(3_000)
    expect(r.hub.delivered.at(-1)).toMatchObject({ type: 'sleep.resume' })
    await tick(50)
    expect(r.ctl.status().stage).toBe('playing')
  })

  it('a wait that runs out (the speech was not finished in time) lets the track come back anyway', async () => {
    const r = await rig()
    await enterAndPlay(r)
    r.speech.answer = false
    await r.service.batchExtras(sleepBatch() as never)
    await tick(50)
    expect(r.hub.delivered.at(-1)).toMatchObject({ type: 'sleep.resume' })
    expect(r.logs.join('\n')).toContain('not finished in time')
  })

  it('a reply that never ends is cut off at the longest wait: the track comes back, and the stuck wait changes nothing later', async () => {
    const r = await rig({ settings: { reply_max_wait_s: 10 } })
    await enterAndPlay(r)
    const reply = await r.reply()
    await tick(9_900)
    expect(r.types()).not.toContain('sleep.resume')
    await tick(200)
    expect(r.hub.delivered.at(-1)).toMatchObject({ type: 'sleep.resume' })
    expect(r.ctl.status().replying).toBe(false)
    reply.finish() // the wait that was abandoned finishes late
    await tick(5_000)
    expect(r.types().filter((t) => t === 'sleep.resume')).toHaveLength(1)
    expect(r.types().filter((t) => t === 'sleep.pause')).toHaveLength(1)
  })

  it('two replies at once are one pause and one resume, and the voice is held once', async () => {
    const r = await rig()
    await enterAndPlay(r)
    const first = await r.reply()
    const second = await r.service.batchExtras(sleepBatch() as never)
    expect(second).toHaveLength(1)
    await tick(1_200)
    first.finish()
    await tick(3_000)
    expect(r.types().filter((t) => t === 'sleep.pause')).toHaveLength(1)
    expect(r.types().filter((t) => t === 'sleep.resume')).toHaveLength(1)
    expect(r.held.filter(([, on]) => on)).toHaveLength(1)
  })

  it('something starts talking again while the track is about to come back: it waits for that too', async () => {
    const r = await rig({ settings: { reply_resume_delay_s: 2 } })
    await enterAndPlay(r)
    const first = await r.reply()
    first.finish()
    await tick(1_000)
    // a second reply begins inside the quiet time
    r.speech.busy = true
    let done!: () => void
    r.speech.wait = new Promise<void>((res) => (done = () => ((r.speech.busy = false), res())))
    await tick(1_500)
    expect(r.types()).not.toContain('sleep.resume')
    done()
    await tick(2_500)
    expect(r.types().filter((t) => t === 'sleep.resume')).toHaveLength(1)
  })

  it('a quick reply that is over before the stage has said it paused still resumes the track', async () => {
    const r = await rig({ settings: { reply_resume_delay_s: 0 } })
    await enterAndPlay(r)
    await r.service.batchExtras(sleepBatch() as never)
    await tick(0) // the reply is over at once, the stage's "paused" is still on its way
    expect(r.ctl.status().stage).toBe('playing')
    expect(r.hub.delivered.at(-1)).toMatchObject({ type: 'sleep.resume' })
    await tick(50)
    expect(r.ctl.status()).toMatchObject({ stage: 'playing', replying: false })
    expect(r.hub.stage.phase).toBe('playing')
  })

  it('a reply that comes while the track is still loading: the pause the stage ignored is sent again once it plays', async () => {
    const r = await rig({ stage: { loadMs: 500 } })
    await r.service.enter('sleep')
    await tick(100)
    const reply = await r.reply()
    await tick(600) // the track started playing over the pause
    expect(r.hub.stage.phase).toBe('paused')
    expect(r.types().filter((t) => t === 'sleep.pause').length).toBeGreaterThanOrEqual(2)
    reply.finish()
    await tick(3_000)
    expect(r.hub.stage.phase).toBe('playing')
  })

  it('a batch that is not a sleep reply, or that comes when the mode is not running, changes nothing', async () => {
    const r = await rig()
    expect(await r.service.batchExtras(sleepBatch() as never)).toEqual([]) // not running
    await enterAndPlay(r)
    const chat = { text: 'hi', parts: [{ prio: 4, kind: 'danmaku', text: 'hi' }] }
    expect(await r.service.batchExtras(chat as never)).toEqual([])
    expect(r.types()).toEqual(['sleep.play'])
    expect(r.ctl.status().replying).toBe(false)
  })

  it('the track ending during a reply does not start the next one on top of it: the next track comes after the reply', async () => {
    const r = await rig()
    await enterAndPlay(r)
    const reply = await r.reply()
    await tick(100)
    r.report('ended') // it ended just as the reply began
    await tick(100)
    expect(urls(r)).toEqual(['rain.mp3'])
    reply.finish()
    await tick(3_000)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3'])
    expect(r.types()).not.toContain('sleep.resume')
  })

  it('a track failing during a reply is skipped after it', async () => {
    const r = await rig()
    await enterAndPlay(r)
    const reply = await r.reply()
    await tick(100)
    r.report('error', { error: 'the file went away' })
    await tick(100)
    expect(urls(r)).toEqual(['rain.mp3'])
    reply.finish()
    await tick(3_000)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3'])
  })

  it('leaving in the middle of a reply cuts the whisper, and the track never comes back', async () => {
    const r = await rig()
    await enterAndPlay(r)
    const reply = await r.reply()
    await tick(100)
    await r.service.exit('sleep', 'console')
    expect(r.stopped).toEqual(['sleep mode', 'sleep mode ended'])
    expect(r.styles).toEqual(['whisper', null])
    reply.finish()
    await tick(60_000)
    expect(r.types().filter((t) => t === 'sleep.resume' || t === 'sleep.play')).toEqual([
      'sleep.play',
    ])
    expect(r.held.at(-1)).toEqual(['sleep', false])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a fade of no length holds nothing', async () => {
    const r = await rig({ settings: { fade_s: 0 } })
    await enterAndPlay(r)
    const reply = await r.reply()
    expect(r.held).toEqual([])
    expect(r.hub.delivered.at(-1)).toMatchObject({ type: 'sleep.pause', fade_s: 0 })
    reply.finish()
    await tick(3_000)
    expect(r.hub.stage.phase).toBe('playing')
  })

  it('a reply when the track has already ended pauses nothing and starts the next after it', async () => {
    const r = await rig({ tracks: [file('rain')], settings: { loop: false }, stage: SHORT })
    await r.service.enter('sleep')
    await tick(1_100)
    expect(r.ctl.status().idle).toBe('finished')
    const reply = await r.reply()
    expect(r.types()).toEqual(['sleep.play'])
    expect(r.held).toEqual([])
    reply.finish()
    await tick(3_000)
    expect(r.types()).toEqual(['sleep.play']) // a finished playlist stays finished
  })
})

// ─────────────────────────────── the console ───────────────────────────────

describe('the console', () => {
  it('starting from the console enters the mode, from a track when one is named; the button of a row on a running mode jumps to it', async () => {
    const r = await rig()
    expect(await r.ctl.onConsoleRequest!({ action: 'play', row: 'waves' })).toEqual({ ok: true })
    await tick(50)
    expect(r.service.state('sleep')).toBe('ACTIVE')
    expect(urls(r)).toEqual(['waves.mp3'])
    expect(await r.ctl.onConsoleRequest!({ action: 'play', row: 'ocean' })).toEqual({ ok: true })
    await tick(50)
    expect(urls(r)).toEqual(['waves.mp3', 'ocean.mp3'])
    expect(await r.ctl.onConsoleRequest!({})).toEqual({ ok: true }) // already running: nothing to do
    expect(urls(r)).toHaveLength(2)
  })

  it('the API can name the track, or start with none; a name that is no track is refused with the reason', async () => {
    const r = await rig()
    expect(await r.service.consoleRequest('sleep', { track: 'nothing' })).toEqual({
      ok: false,
      reason: 'there is no track "nothing"',
    })
    expect(r.service.state('sleep')).toBe('IDLE')
    expect(await r.service.consoleRequest('sleep', { track: 'OCEAN' })).toEqual({ ok: true })
    await tick(50)
    expect(urls(r)).toEqual(['ocean.mp3'])
  })

  it('a track that plays continues in order from the one the operator picked', async () => {
    const r = await rig({ stage: SHORT })
    await enterAndPlay(r)
    await r.ctl.onConsoleRequest!({ action: 'play', row: 'ocean' })
    await tick(1_100)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3', 'waves.mp3'])
  })

  it('"next" moves on, and while a reply is being whispered it waits for the reply to be over', async () => {
    const r = await rig()
    await enterAndPlay(r)
    expect(await r.ctl.onConsoleRequest!({ action: 'next' })).toEqual({ ok: true })
    await tick(50)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3'])
    const reply = await r.reply()
    await tick(100)
    await r.ctl.onConsoleRequest!({ action: 'next' })
    await tick(100)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3'])
    reply.finish()
    await tick(3_000)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3', 'waves.mp3'])
    expect(r.types()).not.toContain('sleep.resume')
  })

  it('skip: the track that plays is moved past, one that is still to come is left out of the rest of this round and is back in the next', async () => {
    const r = await rig({ stage: SHORT })
    await enterAndPlay(r) // rain plays, ocean and waves are to come
    const row = (key: string) => rowOf(r, key).actions.find((a) => a.id === 'skip')!
    expect(row('rain').disabled).toBeUndefined()
    expect(row('waves').disabled).toBeUndefined()

    expect(await r.ctl.onConsoleRequest!({ action: 'skip', row: 'ocean' })).toEqual({ ok: true })
    expect(urls(r)).toEqual(['rain.mp3']) // nothing moved: ocean is only left out
    expect(row('ocean').disabled).toBe('it is not coming up in this round')
    expect(r.events).toContain('sleep: "ocean" is left out of the rest of this round')
    expect(await r.ctl.onConsoleRequest!({ action: 'skip', row: 'ocean' })).toEqual({
      ok: false,
      reason: '"ocean" is not coming up in this round',
    })

    await tick(1_100) // rain ends: waves is next, not ocean
    expect(urls(r)).toEqual(['rain.mp3', 'waves.mp3'])
    await tick(1_100) // the round is over: ocean is back
    expect(urls(r)).toEqual(['rain.mp3', 'waves.mp3', 'rain.mp3'])
    expect(row('ocean').disabled).toBeUndefined()

    // the button of the row that plays, or none at all, skips what plays
    expect(await r.ctl.onConsoleRequest!({ action: 'skip', row: 'rain' })).toEqual({ ok: true })
    await tick(50)
    expect(urls(r).at(-1)).toBe('ocean.mp3')
    expect(await r.ctl.onConsoleRequest!({ action: 'skip' })).toEqual({ ok: true })
    await tick(50)
    expect(urls(r).at(-1)).toBe('waves.mp3')
  })

  it('skip is refused with the reason when there is nothing to skip: not running, no such track, nothing playing', async () => {
    const r = await rig({ settings: { loop: false }, stage: SHORT })
    expect(await r.ctl.onConsoleRequest!({ action: 'skip', row: 'rain' })).toEqual({
      ok: false,
      reason: 'sleep mode is not running',
    })
    await enterAndPlay(r)
    expect(await r.ctl.onConsoleRequest!({ action: 'skip', row: 'nothing' })).toEqual({
      ok: false,
      reason: 'there is no track "nothing"',
    })
    await tick(3_500) // the playlist is over
    expect(r.ctl.status().idle).toBe('finished')
    expect(await r.ctl.onConsoleRequest!({ action: 'skip', row: 'waves' })).toEqual({
      ok: false,
      reason: 'nothing is playing',
    })
    expect(await r.ctl.onConsoleRequest!({ action: 'skip' })).toEqual({
      ok: false,
      reason: 'nothing is playing',
    })
  })

  it('skipping the track that plays while a reply is being whispered waits for the reply to be over', async () => {
    const r = await rig()
    await enterAndPlay(r)
    const reply = await r.reply()
    await tick(100)
    expect(await r.ctl.onConsoleRequest!({ action: 'skip', row: 'rain' })).toEqual({ ok: true })
    await tick(100)
    expect(urls(r)).toEqual(['rain.mp3'])
    reply.finish()
    await tick(3_000)
    expect(urls(r)).toEqual(['rain.mp3', 'ocean.mp3'])
    expect(r.types()).not.toContain('sleep.resume')
  })

  it('the volume: applied to a playing track by a pause and a resume with a short fade, kept for the next start otherwise, refused when it is no number', async () => {
    const r = await rig({ settings: { volume: 0.5 } })
    expect(await r.ctl.onConsoleRequest!({ action: 'volume', volume: 0.8 })).toEqual({ ok: true })
    expect(r.hub.attempted).toEqual([]) // not running: only remembered
    await enterAndPlay(r)
    expect(r.lastPlay()).toMatchObject({ volume: 0.8 })
    expect(await r.ctl.onConsoleRequest!({ action: 'volume', volume: '0.3' })).toEqual({ ok: true })
    expect(r.hub.delivered.slice(-2)).toMatchObject([
      { type: 'sleep.pause', fade_s: 0 },
      { type: 'sleep.resume', fade_s: 0.5, volume: 0.3 },
    ])
    await tick(50)
    expect(r.ctl.status()).toMatchObject({ volume: 0.3, stage: 'playing' })
    await r.ctl.onConsoleRequest!({ action: 'volume', volume: 7 })
    expect(r.ctl.status().volume).toBe(1)
    await r.ctl.onConsoleRequest!({ action: 'volume', volume: -1 })
    expect(r.ctl.status().volume).toBe(0)
    for (const bad of [undefined, 'loud', Number.NaN, null, {}])
      expect(await r.ctl.onConsoleRequest!({ action: 'volume', volume: bad })).toMatchObject({
        ok: false,
        reason: 'the volume must be a number from 0 to 1',
      })
  })

  it('a volume set during a reply is used when the track comes back', async () => {
    const r = await rig()
    await enterAndPlay(r)
    const reply = await r.reply()
    await tick(100)
    await r.ctl.onConsoleRequest!({ action: 'volume', volume: 0.2 })
    reply.finish()
    await tick(3_000)
    expect(r.hub.delivered.at(-1)).toMatchObject({ type: 'sleep.resume', volume: 0.2 })
  })

  it('a volume set while the track is still loading is applied as soon as it plays, once', async () => {
    const r = await rig({ stage: { loadMs: 500 } })
    await r.service.enter('sleep')
    await tick(100)
    expect(r.ctl.status().stage).toBe('loading')
    await r.ctl.onConsoleRequest!({ action: 'volume', volume: 0.3 })
    expect(r.types()).toEqual(['sleep.play']) // nothing to fade yet
    await tick(600)
    expect(r.hub.delivered.slice(-2)).toMatchObject([
      { type: 'sleep.pause', fade_s: 0 },
      { type: 'sleep.resume', fade_s: 0.5, volume: 0.3 },
    ])
    await tick(3_000)
    expect(r.types().filter((t) => t === 'sleep.pause')).toHaveLength(1) // not again and again
    expect(r.ctl.status()).toMatchObject({ stage: 'playing', volume: 0.3 })
    expect(r.hub.stage.phase).toBe('playing')
  })

  it('a test line is whispered in the whisper voice through the same pause and resume, and only one at a time', async () => {
    const r = await rig()
    await enterAndPlay(r)
    let done!: () => void
    r.speech.busy = true
    r.speech.wait = new Promise<void>((res) => (done = () => ((r.speech.busy = false), res())))
    expect(await r.ctl.onConsoleRequest!({ action: 'whisper_test' })).toEqual({ ok: true })
    expect(r.said).toEqual([{ text: r.service.prompt('sleep', 'whisper_test'), style: 'whisper' }])
    expect(r.hub.delivered.at(-1)).toMatchObject({ type: 'sleep.pause' })
    expect(await r.ctl.onConsoleRequest!({ action: 'whisper_test' })).toEqual({
      ok: false,
      reason: 'something is being whispered right now',
    })
    expect(panel(r).actions.find((a) => a.id === 'whisper_test')!.disabled).toContain('right now')
    done()
    await tick(3_000)
    expect(r.hub.delivered.at(-1)).toMatchObject({ type: 'sleep.resume' })
    expect(
      await r.ctl.onConsoleRequest!({ action: 'whisper_test', text: '  sleep well  ' })
    ).toEqual({
      ok: true,
    })
    expect(r.said.at(-1)!.text).toBe('sleep well')
  })

  it('stopping leaves the mode; what cannot be done because the mode is not running says so', async () => {
    const r = await rig()
    for (const action of ['next', 'whisper_test', 'stop'])
      expect(await r.ctl.onConsoleRequest!({ action })).toEqual({
        ok: false,
        reason: 'sleep mode is not running',
      })
    await enterAndPlay(r)
    expect(await r.ctl.onConsoleRequest!({ action: 'stop' })).toEqual({ ok: true })
    expect(r.service.state('sleep')).toBe('IDLE')
    expect(r.flags.sleeping).toBe(false)
    expect(await r.ctl.onConsoleRequest!({ action: 'dance' })).toEqual({
      ok: false,
      reason: 'sleep mode has no action "dance"',
    })
  })

  it('goes through the service the way the console does (act and enter both reach the controller)', async () => {
    const r = await rig()
    expect(await r.service.consoleRequest('sleep', {})).toEqual({ ok: true })
    await tick(50)
    expect(r.service.state('sleep')).toBe('ACTIVE')
    expect(await r.service.consoleRequest('sleep', { action: 'stop' })).toEqual({ ok: true })
    expect(r.service.state('sleep')).toBe('IDLE')
  })
})

describe('the console panel', () => {
  it('lists the tracks with a button each, and offers next, volume, a test line and stop; only volume works before the mode runs', async () => {
    const r = await rig({
      tracks: [
        file('rain', { durationS: 565.6 }),
        file('night/ocean', { captions: [], durationS: null }),
      ],
    })
    const p = panel(r)
    expect(p.status).toBe('not running; 2 track(s) ready')
    expect(p.sections[0]!.title).toBe('Tracks')
    expect(p.sections[0]!.rows.map((x) => x.id)).toEqual(['rain', 'night/ocean'])
    expect(rowOf(r, 'rain').detail).toBe('9.4 min, 1 line, mp3')
    expect(rowOf(r, 'night/ocean').detail).toBe('no captions, mp3')
    expect(rowOf(r, 'rain').actions).toMatchObject([
      { id: 'play', label: 'Play now' },
      { id: 'skip', label: 'Skip', disabled: 'sleep mode is not running' },
    ])
    expect(p.actions.map((a) => [a.id, a.disabled])).toEqual([
      ['next', 'sleep mode is not running'],
      ['volume', undefined],
      ['whisper_test', 'sleep mode is not running'],
      ['stop', 'sleep mode is not running'],
    ])
    expect(p.actions.find((a) => a.id === 'stop')!.confirm).toContain('Stop sleep mode')
    expect(p.actions.find((a) => a.id === 'volume')!.inputs[0]).toMatchObject({
      name: 'volume',
      kind: 'number',
      min: 0,
      max: 1,
      value: 1,
    })
    expect(p.actions.find((a) => a.id === 'whisper_test')!.inputs[0]).toMatchObject({
      name: 'text',
      value: r.service.prompt('sleep', 'whisper_test'),
    })
  })

  it('while it runs: the playing track is marked, the state is on the status line, the buttons work', async () => {
    const r = await rig()
    await enterAndPlay(r)
    const p = panel(r)
    expect(p.status).toBe('playing "rain" (1 of 3)')
    expect(rowOf(r, 'rain').active).toBe(true)
    expect(rowOf(r, 'ocean').active).toBe(false)
    expect(p.actions.map((a) => a.disabled)).toEqual([undefined, undefined, undefined, undefined])
    const reply = await r.reply()
    expect(panel(r).status).toContain('whispering')
    reply.finish()
  })

  it('facts: the tracks, the whisper voice, the volume, when chat is answered, the order', async () => {
    const r = await rig({
      config: { inbox: { sleep: { first_reply_after_sec: 40, reply_interval_sec: 120 } } },
      settings: { shuffle: true, loop: false, volume: 0.65 },
    })
    const facts = Object.fromEntries(panel(r).facts.map((f) => [f.label, f.value]))
    expect(facts['Tracks']).toBe('3 in C:/path/to/asmr')
    expect(facts['Whisper voice']).toBe('tts.styles.whisper is set')
    expect(facts['Volume']).toBe('65 %')
    expect(facts['Chat replies']).toBe(
      'a whisper, the first 40 s after the start, then one every 120 s'
    )
    expect(facts['Order']).toBe('shuffled, once through')
  })

  it('chat replies switched off in the inbox are said to be off', async () => {
    const r = await rig({ config: { inbox: { sleep: { enabled: false } } } })
    expect(panel(r).facts.find((f) => f.label === 'Chat replies')!.value).toContain('off')
  })

  it('a library of hundreds of tracks with the longest names still gives a panel the console can show', async () => {
    const tracks = Array.from({ length: 250 }, (_, i) =>
      file(`${'n'.repeat(100)}${i}`, { notes: ['a note '.repeat(60)] })
    )
    const r = await rig({ tracks })
    const view = r.service.viewOf('sleep')
    expect(view.panel).toBeDefined()
    expect(ModePanel.safeParse(view.panel).success).toBe(true)
    expect(view.panel!.sections[0]!.rows).toHaveLength(100)
    expect(view.panel!.sections[0]!.title).toBe('Tracks (the first 100 of 250)')
    expect(view.panel!.actions.length).toBeLessThanOrEqual(12)
  })

  it('a panel that is nonsense-proof: a folder path of any length fits', async () => {
    const r = await rig({ noLibrary: false })
    r.library.fails = 'x'.repeat(1_000)
    r.clock.now += 20_000
    r.service.viewOf('sleep')
    await tick(50)
    expect(ModePanel.safeParse(r.service.viewOf('sleep').panel).success).toBe(true)
  })
})

describe('the whisper voice', () => {
  it('a missing whisper reference is an alarm the moment the mode starts, and on the panel, and gone when it ends; the mode still runs', async () => {
    const r = await rig({
      config: { tts: { styles: { neutral: NEUTRAL }, default_style: 'neutral' } },
    })
    expect(panel(r).facts.find((f) => f.label === 'Whisper voice')!.value).toContain('MISSING')
    await enterAndPlay(r)
    expect(r.alarms).toHaveLength(1)
    expect(r.alarms[0]).toMatchObject({ code: 'sleep_whisper_style', level: 'warn' })
    expect(r.alarms[0]!.message).toContain('"whisper"')
    expect(r.alarms[0]!.message).toContain('normal voice')
    expect(r.styles).toEqual(['whisper']) // still asked for: the operator may add the recording
    expect(r.service.state('sleep')).toBe('ACTIVE')
    await r.service.exit('sleep', 'console')
    expect(r.alarms).toEqual([])
  })

  it('another key can be the whisper voice', async () => {
    const r = await rig({
      settings: { whisper_style: 'hush' },
      config: { tts: { styles: { neutral: NEUTRAL, hush: WHISPER }, default_style: 'neutral' } },
    })
    await enterAndPlay(r)
    expect(r.styles).toEqual(['hush'])
    expect(r.alarms).toEqual([])
    await r.service.exit('sleep', 'x')
    const missing = await rig({ settings: { whisper_style: 'hush' } })
    await enterAndPlay(missing)
    expect(missing.alarms[0]!.message).toContain('"hush"')
  })
})

describe('what the model is told', () => {
  it("the mode's own prompt goes out while it is active and nothing while it is not; it names the marker and says no motion tags", async () => {
    const r = await rig()
    expect(r.service.prompts()).toEqual([])
    await enterAndPlay(r)
    const [p] = r.service.prompts()
    expect(p!.id).toBe('sleep')
    expect(p!.text).toContain(FORMATS.sleepPrefix)
    expect(p!.text).toContain('[motion:...]')
    expect(p!.text).not.toMatch(/\{\{/)
    await r.service.exit('sleep', 'x')
    expect(r.service.prompts()).toEqual([])
  })

  it('the prompts of the pack are persona-free: nothing but the situation, no names', async () => {
    const r = await rig()
    for (const name of ['active', 'reply', 'whisper_test']) {
      const text = r.service.prompt('sleep', name)!
      expect(text, name).toBeTruthy()
      expect(text, name).not.toMatch(/\{\{/)
    }
    expect(r.service.prompt('sleep', 'reply')).toContain(FORMATS.sleepPrefix)
  })
})

// ─────────────────────────────── settings and memory ───────────────────────────────

describe('settings', () => {
  it('have the documented defaults', () => {
    expect(SleepSettings.parse({})).toEqual({
      volume: 1,
      fade_in_s: 1.5,
      fade_s: 1,
      reply_resume_delay_s: 1.5,
      reply_max_wait_s: 120,
      start_timeout_s: 20,
      shuffle: false,
      loop: true,
      captions: true,
      whisper_style: 'whisper',
    })
  })

  it('the configuration in the doc is valid, and the numbers it shows for the mode are the defaults', async () => {
    const doc = await readFile(path.resolve(MODES, '..', 'docs', 'mode-sleep.md'), 'utf8')
    const block = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1]
    expect(block).toBeTruthy()
    const config = parseConfig(parseYaml(block as string), { root: '/x' })
    expect(SleepSettings.parse(config.modes.sleep?.config)).toEqual(SleepSettings.parse({}))
    expect(config.modes.sleep?.enabled).toBe(true)
    // what the doc says about the pacer's side is what the inbox defaults are
    expect(config.inbox.sleep).toEqual(defaultInboxConfig().sleep)
    expect(config.tts.styles).toHaveProperty('whisper')
    expect(config.stage.presets.backgrounds).toHaveProperty('night')
  })

  it('reject what is out of bounds or unknown, at start-up, with a message that names the setting', async () => {
    for (const [bad, needle] of [
      [{ volume: 2 }, 'volume'],
      [{ fade_s: -1 }, 'fade_s'],
      [{ reply_max_wait_s: 1 }, 'reply_max_wait_s'],
      [{ shuffle: 'yes' }, 'shuffle'],
      [{ whisper_style: '' }, 'whisper_style'],
      [{ voume: 1 }, 'voume'],
    ] as const) {
      await expect(rig({ settings: bad }), JSON.stringify(bad)).rejects.toThrow(
        new RegExp(`modes\\.sleep\\.config.*${needle}`)
      )
    }
  })
})

describe('remembering across restarts', () => {
  it('the next start goes on with the track after the one that played last', async () => {
    const first = await rig({ stage: SHORT })
    await enterAndPlay(first)
    await tick(1_100) // ocean now
    expect(first.ctl.status().track).toBe('ocean')
    vi.useRealTimers() // the file is written by real I/O
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(path.join(first.dir, 'sleep-state.json'), 'utf8'))).toEqual({
        last_track: 'ocean',
      })
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

    const second = await rig({ dir: first.dir })
    await enterAndPlay(second)
    expect(urls(second)).toEqual(['waves.mp3'])
  })

  it('a track that is gone, or a state file that is torn, nonsense or of another shape, starts from the top', async () => {
    for (const content of [
      '{oops',
      'null',
      '"a string"',
      '[1,2]',
      '{"last_track": 7}',
      '{"last_track": ""}',
      `{"last_track": "${'x'.repeat(500)}"}`,
      '{"last_track": "a track that was deleted"}',
    ]) {
      const dir = await tempDir()
      await writeFile(path.join(dir, 'sleep-state.json'), content)
      const r = await rig({ dir })
      await enterAndPlay(r)
      expect(urls(r), content).toEqual(['rain.mp3'])
    }
  })

  it('a named track wins over what was remembered; not looping starts at the top; shuffling avoids repeating the last one', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, 'sleep-state.json'), '{"last_track":"rain"}')
    const named = await rig({ dir })
    await named.ctl.onConsoleRequest!({ row: 'rain' })
    await tick(50)
    expect(urls(named)).toEqual(['rain.mp3'])
    const once = await rig({ dir, settings: { loop: false } })
    await enterAndPlay(once)
    expect(urls(once)).toEqual(['rain.mp3'])
    // a shuffle that would put "rain" first again is turned into one that does not
    const mixed = await rig({ dir, settings: { shuffle: true }, random: () => 0.999 })
    await enterAndPlay(mixed)
    expect(urls(mixed)).toEqual(['waves.mp3'])
  })
})
