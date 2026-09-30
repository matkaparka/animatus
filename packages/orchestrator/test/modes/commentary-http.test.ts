/**
 * The controller through the real mode service, with the real HTTP client talking to the fake capture service over a
 * real socket (the other files of this folder use the same fake in-process, so that fake timers stay deterministic).
 * Sockets need real time: the loop's waits are a hundred times shorter and a test waits with `until`.
 */
import { describe, expect, it } from 'vitest'
import { jpegBase64, win } from './fakeCapture.ts'
import { commentaryRig, until, useCommentaryRig } from './commentaryRig.ts'
import type { Rig } from './commentaryRig.ts'

useCommentaryRig({ fakeTimers: false })

const captureAlarm = (r: Rig) => r.f.alarms.find((a) => a.code === 'commentary_capture')?.message

describe('over a real socket', () => {
  it('the picture the service sent is the picture the model is shown, and the request says what was configured', async () => {
    const r = await commentaryRig({ http: true, settings: { analysis_every: 0 } })
    await r.enter()
    await until(() => r.f.told.length >= 1, 5000, 'the first comment')
    expect(r.fake.calls[0]).toMatchObject({
      window: 'Some Game',
      maxWidth: 768,
      quality: 80,
      blackThreshold: 10,
      method: 'auto',
    })
    expect(r.f.told[0]?.opts?.images).toEqual([{ mime: 'image/jpeg', base64: jpegBase64(1) }])
    expect(JSON.stringify(r.llm('commentary-identify')[0]?.user)).toContain(jpegBase64(1))
    expect(r.ctl.status()).toMatchObject({ game: 'Some Game', sure: true })
    expect(r.alarms()).toEqual([])
  })

  it('the window list feeds the panel, a window picked from it is asked for by its id, and its names survive the wire', async () => {
    const r = await commentaryRig({ http: true, settings: { window: null } })
    r.fake.windows = [
      win('101', 'Some Game - 游戏', { process: 'javaw.exe', width: 1600, height: 900 }),
      win('102', 'Notes', { process: 'notepad.exe' }),
    ]
    expect(await r.act({ action: 'refresh' })).toEqual({ ok: true })
    const rows = r.panel()?.sections.find((s) => s.title === 'Windows')?.rows
    expect(rows?.map((x) => [x.id, x.text])).toEqual([
      ['101', 'Some Game - 游戏'],
      ['102', 'Notes'],
    ])
    expect(rows?.[0]?.detail).toBe('javaw.exe, 1600x900')
    await r.enter()
    expect(await r.act({ action: 'use_window', row: '101' })).toEqual({ ok: true })
    await until(() => r.f.told.length >= 1, 5000, 'a comment on the window that was picked')
    expect(r.fake.calls[0]?.window).toBe('101')
    expect((await r.saved()).window).toEqual({
      id: '101',
      title: 'Some Game - 游戏',
      process: 'javaw.exe',
    })
  })

  it('every way the service can fail becomes an alarm in its own words, and the alarm goes when a picture comes', async () => {
    const r = await commentaryRig({ http: true, settings: { analysis_every: 0 } })
    r.fake.script = [
      { kind: 'drop' },
      { kind: 'garbage', body: '<html>captive portal</html>', type: 'text/html' },
      {
        kind: 'error',
        status: 409,
        code: 'window_minimized',
        message: 'the window is minimised: restore it',
      },
      {
        kind: 'error',
        status: 500,
        code: 'capture_failed',
        message: 'PrintWindow failed (Windows error 5)',
      },
    ]
    await r.enter()
    const expected = [
      /not answering|could not be reached|closed the connection/,
      /answered 200 with text\/html instead of a JPEG/,
      /the window is minimised: restore it/,
      /PrintWindow failed \(Windows error 5\)/,
    ]
    for (const [i, pattern] of expected.entries()) {
      await until(() => r.fake.calls.length >= i + 1, 5000, `capture ${i + 1}`)
      await until(() => pattern.test(captureAlarm(r) ?? ''), 5000, `the alarm for capture ${i + 1}`)
    }
    expect(r.f.alarms.filter((a) => a.code === 'commentary_capture')).toHaveLength(1)
    await until(() => r.f.told.length >= 1, 5000, 'a comment once the service answers')
    expect(r.alarms()).toEqual([])
  })

  it('a black picture arrives as black over the wire, and is skipped', async () => {
    const r = await commentaryRig({ http: true, settings: { black_alarm_after: 2 } })
    r.fake.script = [
      { kind: 'frame', black: true },
      { kind: 'frame', black: true },
    ]
    await r.enter()
    await until(() => r.alarms().includes('commentary_black'), 5000, 'the black alarm')
    expect(r.f.llm.requests).toHaveLength(0)
    await until(() => r.f.told.length >= 1, 5000, 'a comment on the first lit picture')
    expect(r.alarms()).toEqual([])
    expect(r.ctl.status().blackFrames).toBe(2)
  })

  it('gives up on a service that does not answer in time, says so, and goes on', async () => {
    const r = await commentaryRig({ http: true, settings: { capture_timeout_sec: 2 } })
    r.fake.script = [{ kind: 'hang' }]
    await r.enter()
    await until(
      () => /did not answer within 2000 ms/.test(captureAlarm(r) ?? ''),
      6000,
      'the timeout alarm'
    )
    await until(() => r.f.told.length >= 1, 5000, 'a comment once the service answers')
    expect(r.alarms()).toEqual([])
  })

  it('cancels a capture that is in progress when the mode is left, at once and without an alarm', async () => {
    const r = await commentaryRig({ http: true })
    r.fake.script = [{ kind: 'hang' }]
    await r.enter()
    await until(() => r.fake.calls.length === 1, 5000, 'the capture')
    const t0 = Date.now()
    await r.exit()
    expect(Date.now() - t0).toBeLessThan(2000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(r.fake.calls).toHaveLength(1)
    expect(r.alarms()).toEqual([])
    expect(r.f.told).toHaveLength(0)
  })
})
