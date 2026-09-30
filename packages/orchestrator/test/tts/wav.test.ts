import { describe, expect, it } from 'vitest'
import { WavError, decodeWav, encodeWav, peakPcm16 } from '../../src/tts/wav.ts'

const pcm = (samples: number[]) => {
  const b = new Uint8Array(samples.length * 2)
  const dv = new DataView(b.buffer)
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true))
  return b
}

/** Hand-built WAV: format 1 or 3, any bit depth and channel count, optional extra chunk and odd sizes. */
function wav(opts: {
  format: number
  bits: number
  channels: number
  rate: number
  data: Uint8Array
  extra?: boolean
  dataSize?: number
}) {
  const parts: Uint8Array[] = []
  const u32 = (n: number) =>
    Uint8Array.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255])
  const u16 = (n: number) => Uint8Array.from([n & 255, (n >> 8) & 255])
  const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)))
  const fmt = Uint8Array.from([
    ...u16(opts.format),
    ...u16(opts.channels),
    ...u32(opts.rate),
    ...u32((opts.rate * opts.channels * opts.bits) / 8),
    ...u16((opts.channels * opts.bits) / 8),
    ...u16(opts.bits),
  ])
  const chunks: Uint8Array[] = [ascii('fmt '), u32(fmt.length), fmt]
  if (opts.extra)
    chunks.push(ascii('LIST'), u32(3), Uint8Array.from([1, 2, 3]), Uint8Array.from([0])) // odd size + pad byte
  chunks.push(ascii('data'), u32(opts.dataSize ?? opts.data.length), opts.data)
  const body = Uint8Array.from(chunks.flatMap((c) => [...c]))
  parts.push(ascii('RIFF'), u32(4 + body.length), ascii('WAVE'), body)
  return Uint8Array.from(parts.flatMap((c) => [...c]))
}

describe('decodeWav', () => {
  it('round-trips 16-bit mono', () => {
    const src = pcm([0, 1000, -1000, 32767, -32768])
    const d = decodeWav(encodeWav(src, 32000))
    expect(d.sampleRate).toBe(32000)
    expect([...d.pcm16]).toEqual([...src])
    expect(d.duration).toBeCloseTo(5 / 32000, 9)
  })

  it('skips unknown chunks, including odd-sized ones with a pad byte', () => {
    const src = pcm([10, 20, 30, 40])
    const d = decodeWav(
      wav({ format: 1, bits: 16, channels: 1, rate: 16000, data: src, extra: true })
    )
    expect([...d.pcm16]).toEqual([...src])
  })

  it('averages stereo to mono', () => {
    const d = decodeWav(
      wav({ format: 1, bits: 16, channels: 2, rate: 8000, data: pcm([1000, 3000, -2000, 2000]) })
    )
    const dv = new DataView(d.pcm16.buffer)
    expect(dv.getInt16(0, true)).toBe(2000)
    expect(dv.getInt16(2, true)).toBe(0)
  })

  it('converts float32 and 24/32-bit PCM', () => {
    const f = new Uint8Array(8)
    const fdv = new DataView(f.buffer)
    fdv.setFloat32(0, 0.5, true)
    fdv.setFloat32(4, -1, true)
    const df = decodeWav(wav({ format: 3, bits: 32, channels: 1, rate: 24000, data: f }))
    const dv = new DataView(df.pcm16.buffer)
    expect(dv.getInt16(0, true)).toBeCloseTo(16384, -1)
    expect(dv.getInt16(2, true)).toBe(-32768)

    const p24 = Uint8Array.from([0x00, 0x00, 0x40]) // +0.5 in 24-bit
    const d24 = decodeWav(wav({ format: 1, bits: 24, channels: 1, rate: 24000, data: p24 }))
    expect(new DataView(d24.pcm16.buffer).getInt16(0, true)).toBeCloseTo(16384, -1)

    const p32 = new Uint8Array(4)
    new DataView(p32.buffer).setInt32(0, -1073741824, true) // -0.5
    const d32 = decodeWav(wav({ format: 1, bits: 32, channels: 1, rate: 24000, data: p32 }))
    expect(new DataView(d32.pcm16.buffer).getInt16(0, true)).toBeCloseTo(-16384, -1)
  })

  it('reads a streamed WAV whose data size is 0 or 0xFFFFFFFF to the end', () => {
    const src = pcm([1, 2, 3, 4, 5, 6])
    for (const size of [0, 0xffffffff]) {
      const d = decodeWav(
        wav({ format: 1, bits: 16, channels: 1, rate: 16000, data: src, dataSize: size })
      )
      expect(d.pcm16.length).toBe(src.length)
    }
  })

  it('rejects garbage with a clear WavError', () => {
    expect(() => decodeWav(new Uint8Array(10))).toThrow(WavError)
    expect(() => decodeWav(new Uint8Array(100))).toThrow(/RIFF/)
    const noData = wav({ format: 1, bits: 16, channels: 1, rate: 8000, data: new Uint8Array(0) })
    // chop the data chunk header off
    expect(() => decodeWav(noData.subarray(0, 36 + 4))).toThrow(WavError)
    expect(() =>
      decodeWav(wav({ format: 2, bits: 4, channels: 1, rate: 8000, data: new Uint8Array(4) }))
    ).toThrow(/unsupported/)
  })
})

describe('peakPcm16', () => {
  it('reports the peak as a fraction of full scale', () => {
    expect(peakPcm16(pcm([0, 0]))).toBe(0)
    expect(peakPcm16(pcm([16384, -8192]))).toBeCloseTo(0.5, 3)
    expect(peakPcm16(pcm([-32768]))).toBe(1)
  })
})
