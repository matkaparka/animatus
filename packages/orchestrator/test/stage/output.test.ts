import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { stageOutput, stageReports } from '../../src/stage/output.ts'
import type { HubLike } from '../../src/stage/output.ts'

function fakeHub() {
  const ee = new EventEmitter()
  const calls: {
    beginUtterance: unknown[][]
    cancelUtterance: unknown[][]
    cancelAll: unknown[][]
  } = {
    beginUtterance: [],
    cancelUtterance: [],
    cancelAll: [],
  }
  const hub = {
    connected: true,
    beginUtterance: vi.fn(async (...a: unknown[]) => {
      calls.beginUtterance.push(a)
      return { handle: 1, utteranceId: 'u', frames: 2, bytes: 4, cancelled: false }
    }),
    cancelUtterance: vi.fn((...a: unknown[]) => (calls.cancelUtterance.push(a), true)),
    cancelAll: vi.fn((...a: unknown[]) => (calls.cancelAll.push(a), true)),
    on: (e: string, f: (...a: unknown[]) => void) => ee.on(e, f),
    off: (e: string, f: (...a: unknown[]) => void) => ee.off(e, f),
  }
  return { hub: hub as unknown as HubLike & { connected: boolean }, ee, calls, raw: hub }
}

const args = {
  utterance_id: 'u-1',
  seq: 3,
  turn_id: 't-1',
  emotion: 'happy' as const,
  motion: null,
  live_motion: false,
  audio: { sample_rate: 32000, total_samples: 4 },
}

describe('stageOutput', () => {
  it('reads the connection state live', () => {
    const f = fakeHub()
    const out = stageOutput(f.hub)
    expect(out.connected).toBe(true)
    f.raw.connected = false
    expect(out.connected).toBe(false)
  })

  it('maps an utterance to the hub call and leaves live_motion to the hub', async () => {
    const f = fakeHub()
    const out = stageOutput(f.hub)
    const pcm = new Uint8Array(8)
    const r = await out.beginUtterance({ ...args, subtitle: 'hi' }, { pcm16: pcm })
    expect(r).toEqual({ cancelled: false })
    const [a, media] = f.calls.beginUtterance[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    expect(a).toMatchObject({
      utterance_id: 'u-1',
      seq: 3,
      turn_id: 't-1',
      emotion: 'happy',
      motion: null,
      subtitle: 'hi',
      audio: { sample_rate: 32000, total_samples: 4 },
    })
    expect('live_motion' in a).toBe(false)
    expect(media).toEqual({ pcm16: pcm })
  })

  it('passes a live motion stream along with the audio', async () => {
    const f = fakeHub()
    const out = stageOutput(f.hub)
    const vrma = new Uint8Array([1, 2, 3])
    await out.beginUtterance({ ...args, live_motion: true }, { pcm16: new Uint8Array(2), vrma })
    const media = f.calls.beginUtterance[0]?.[1] as { vrma?: Uint8Array }
    expect(media.vrma).toBe(vrma)
  })

  it('reports a cancelled send and lets hub errors through', async () => {
    const f = fakeHub()
    f.raw.beginUtterance.mockResolvedValueOnce({
      handle: 1,
      utteranceId: 'u',
      frames: 0,
      bytes: 0,
      cancelled: true,
    })
    expect(await stageOutput(f.hub).beginUtterance(args, { pcm16: new Uint8Array(2) })).toEqual({
      cancelled: true,
    })
    f.raw.beginUtterance.mockRejectedValueOnce(new Error('no stage'))
    await expect(
      stageOutput(f.hub).beginUtterance(args, { pcm16: new Uint8Array(2) })
    ).rejects.toThrow('no stage')
  })

  it('cancels one utterance or everything, with an optional fade', () => {
    const f = fakeHub()
    const out = stageOutput(f.hub)
    out.cancel('all')
    out.cancel('all', undefined, 120)
    out.cancel('utterance', 'u-9', 40)
    out.cancel('utterance', undefined)
    expect(f.calls.cancelAll).toEqual([[{}], [{ fadeMs: 120 }]])
    expect(f.calls.cancelUtterance).toEqual([['u-9', { fadeMs: 40 }]])
  })
})

describe('stageReports', () => {
  it('turns playback reports into id and reason callbacks and can unsubscribe', () => {
    const f = fakeHub()
    const reports = stageReports(f.hub)
    const started: string[] = []
    const ended: [string, string][] = []
    let dropped = 0
    const offs = [
      reports.on('started', (id) => started.push(id)),
      reports.on('ended', (id, reason) => ended.push([id, reason])),
      reports.on('disconnected', () => dropped++),
    ]
    f.ee.emit('playback.started', { utterance_id: 'a' })
    f.ee.emit('playback.ended', { utterance_id: 'a', reason: 'done' })
    f.ee.emit('disconnected', { code: 1006, reason: 'x', replaced: false })
    expect(started).toEqual(['a'])
    expect(ended).toEqual([['a', 'done']])
    expect(dropped).toBe(1)

    for (const off of offs) off()
    f.ee.emit('playback.started', { utterance_id: 'b' })
    f.ee.emit('playback.ended', { utterance_id: 'b', reason: 'done' })
    f.ee.emit('disconnected', {})
    expect(started).toEqual(['a'])
    expect(ended).toHaveLength(1)
    expect(dropped).toBe(1)
    expect(f.ee.listenerCount('playback.started')).toBe(0)
  })
})
