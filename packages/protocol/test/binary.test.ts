import { describe, expect, it } from 'vitest'
import {
  FRAME_HEADER_BYTES,
  FrameError,
  FrameKind,
  chunkPcm16,
  decodeFrame,
  encodeAudioFrame,
  encodeFrame,
  encodeVrmaFrame,
} from '../src/binary.ts'

const bytes = (...n: number[]) => Uint8Array.from(n)

describe('binary media frames', () => {
  it('round-trips an audio frame', () => {
    const payload = bytes(1, 2, 3, 4)
    const f = decodeFrame(encodeAudioFrame(7, 3, payload, false))
    expect(f.kind).toBe(FrameKind.Audio)
    expect(f.handle).toBe(7)
    expect(f.index).toBe(3)
    expect(f.last).toBe(false)
    expect([...f.payload]).toEqual([1, 2, 3, 4])
  })

  it('round-trips a vrma frame with the last flag', () => {
    const f = decodeFrame(encodeVrmaFrame(0xffffffff, 0xfffffffe, bytes(9), true))
    expect(f.kind).toBe(FrameKind.Vrma)
    expect(f.handle).toBe(0xffffffff)
    expect(f.index).toBe(0xfffffffe)
    expect(f.last).toBe(true)
  })

  it('allows an empty last frame (utterance with no audio)', () => {
    const buf = encodeAudioFrame(1, 0, new Uint8Array(0), true)
    expect(buf.byteLength).toBe(FRAME_HEADER_BYTES)
    const f = decodeFrame(buf)
    expect(f.last).toBe(true)
    expect(f.payload.byteLength).toBe(0)
  })

  it('decodes from an ArrayBuffer and from a Uint8Array view with an offset', () => {
    const inner = encodeAudioFrame(5, 1, bytes(10, 11), true)
    const padded = new Uint8Array(inner.byteLength + 5)
    padded.set(inner, 5)
    const f = decodeFrame(padded.subarray(5))
    expect(f.handle).toBe(5)
    expect([...f.payload]).toEqual([10, 11])
    const g = decodeFrame(inner.buffer.slice(inner.byteOffset, inner.byteOffset + inner.byteLength) as ArrayBuffer)
    expect(g.index).toBe(1)
  })

  it('rejects malformed frames', () => {
    expect(() => decodeFrame(new Uint8Array(15))).toThrow(FrameError)
    const good = encodeAudioFrame(1, 0, bytes(1, 2), false)

    const badMagic = good.slice()
    badMagic[0] = 0x00
    expect(() => decodeFrame(badMagic)).toThrow(/magic/)

    const badVersion = good.slice()
    badVersion[2] = 9
    expect(() => decodeFrame(badVersion)).toThrow(/version/)

    const badKind = good.slice()
    badKind[3] = 42
    expect(() => decodeFrame(badKind)).toThrow(/kind/)
  })

  it('rejects out-of-range handle and index when encoding', () => {
    expect(() => encodeFrame(FrameKind.Audio, -1, 0, new Uint8Array(0), true)).toThrow(RangeError)
    expect(() => encodeFrame(FrameKind.Audio, 0, 2 ** 32, new Uint8Array(0), true)).toThrow(RangeError)
    expect(() => encodeFrame(FrameKind.Audio, 1.5, 0, new Uint8Array(0), true)).toThrow(RangeError)
  })

  it('chunkPcm16 splits on whole samples and flags only the final frame', () => {
    const pcm = new Uint8Array(1000)
    pcm.forEach((_, i) => (pcm[i] = i & 0xff))
    const frames = [...chunkPcm16(3, pcm, 301)].map(decodeFrame)
    // chunkBytes is rounded down to an even number: 300
    expect(frames.length).toBe(4)
    expect(frames.map((f) => f.index)).toEqual([0, 1, 2, 3])
    expect(frames.map((f) => f.last)).toEqual([false, false, false, true])
    for (const f of frames.slice(0, -1)) expect(f.payload.byteLength % 2).toBe(0)
    const joined = new Uint8Array(frames.reduce((n, f) => n + f.payload.byteLength, 0))
    let o = 0
    for (const f of frames) {
      joined.set(f.payload, o)
      o += f.payload.byteLength
    }
    expect([...joined]).toEqual([...pcm])
  })

  it('chunkPcm16 yields one empty last frame for empty audio', () => {
    const frames = [...chunkPcm16(9, new Uint8Array(0))].map(decodeFrame)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.last).toBe(true)
  })

  it('chunkPcm16 marks a single exact-size chunk as last', () => {
    const frames = [...chunkPcm16(1, new Uint8Array(600), 600)].map(decodeFrame)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.last).toBe(true)
  })
})
