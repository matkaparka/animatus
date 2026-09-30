import { describe, expect, it } from 'vitest'
import { Pcm16Decoder, pcm16ToFloat32 } from '../../src/audio/pcm.ts'

const toBytes = (samples: number[]) => {
  const b = new Uint8Array(samples.length * 2)
  const dv = new DataView(b.buffer)
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true))
  return b
}

describe('pcm16ToFloat32', () => {
  it('maps the full range to [-1, 1]', () => {
    const f = pcm16ToFloat32(toBytes([0, 32767, -32768, 16384, -16384]))
    expect(f[0]).toBe(0)
    expect(f[1]).toBe(1)
    expect(f[2]).toBe(-1)
    expect(f[3]).toBeCloseTo(0.5, 3)
    expect(f[4]).toBeCloseTo(-0.5, 3)
  })

  it('ignores a trailing odd byte and handles subarray views', () => {
    const b = toBytes([1000, -1000])
    const withOdd = new Uint8Array(b.length + 1)
    withOdd.set(b)
    expect(pcm16ToFloat32(withOdd)).toHaveLength(2)
    const padded = new Uint8Array(b.length + 4)
    padded.set(b, 3)
    const f = pcm16ToFloat32(padded.subarray(3, 3 + b.length))
    expect(f[0]).toBeCloseTo(1000 / 32767, 6)
    expect(f[1]).toBeCloseTo(-1000 / 32768, 6)
  })
})

describe('Pcm16Decoder', () => {
  it('reassembles samples split across chunk boundaries', () => {
    const all = toBytes([100, -200, 300, -400, 500])
    const whole = pcm16ToFloat32(all)
    const d = new Pcm16Decoder()
    const parts = [all.subarray(0, 3), all.subarray(3, 4), all.subarray(4, 9), all.subarray(9)]
    const out: number[] = []
    for (const p of parts) out.push(...d.push(p))
    expect(out).toHaveLength(5)
    out.forEach((v, i) => expect(v).toBeCloseTo(whole[i]!, 9))
  })

  it('handles empty chunks', () => {
    const d = new Pcm16Decoder()
    expect(d.push(new Uint8Array(0))).toHaveLength(0)
    expect(d.push(toBytes([7]))).toHaveLength(1)
  })
})
