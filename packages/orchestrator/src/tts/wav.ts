/** Minimal WAV reading and writing. Enough for what speech servers return; nothing exotic. */

export class WavError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WavError'
  }
}

export interface DecodedWav {
  sampleRate: number
  /** PCM16 little-endian, mono (multi-channel input is averaged). */
  pcm16: Uint8Array
  /** Length in seconds. */
  duration: number
}

const tag = (dv: DataView, o: number) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))

/**
 * Parse a RIFF/WAVE buffer holding 16-bit PCM, 24/32-bit PCM or 32-bit float (also inside a
 * WAVE_FORMAT_EXTENSIBLE header). Unknown chunks are skipped. A `data` chunk whose declared size runs
 * past the end of the buffer (streamed WAVs often declare 0 or 0xFFFFFFFF) is read to the end.
 */
export function decodeWav(buf: Uint8Array): DecodedWav {
  if (buf.byteLength < 44) throw new WavError(`too short for a WAV file (${buf.byteLength} bytes)`)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (tag(dv, 0) !== 'RIFF' || tag(dv, 8) !== 'WAVE') throw new WavError('not a RIFF/WAVE file')

  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  let dataStart = -1
  let dataLen = 0
  let o = 12
  while (o + 8 <= buf.byteLength) {
    const id = tag(dv, o)
    let size = dv.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.byteLength) throw new WavError('truncated fmt chunk')
      let format = dv.getUint16(body, true)
      const channels = dv.getUint16(body + 2, true)
      const rate = dv.getUint32(body + 4, true)
      const bits = dv.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26 && body + 26 <= buf.byteLength)
        format = dv.getUint16(body + 24, true)
      fmt = { format, channels, rate, bits }
    } else if (id === 'data') {
      dataStart = body
      if (size === 0 || size === 0xffffffff || body + size > buf.byteLength)
        size = buf.byteLength - body
      dataLen = size
      break
    }
    o = body + size + (size & 1)
  }
  if (!fmt) throw new WavError('no fmt chunk')
  if (dataStart < 0) throw new WavError('no data chunk')
  if (fmt.channels < 1 || fmt.rate < 1) throw new WavError('invalid format fields')
  const supported =
    (fmt.format === 1 && (fmt.bits === 16 || fmt.bits === 24 || fmt.bits === 32)) ||
    (fmt.format === 3 && fmt.bits === 32)
  if (!supported)
    throw new WavError(`unsupported WAV encoding (format ${fmt.format}, ${fmt.bits} bit)`)

  const bytesPer = fmt.bits >> 3
  const frame = bytesPer * fmt.channels
  const frames = Math.floor(dataLen / frame)
  const out = new Uint8Array(frames * 2)
  const odv = new DataView(out.buffer)

  if (fmt.format === 1 && fmt.bits === 16) {
    // Already the target format: integer path, lossless for mono and exact averaging for more channels.
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let c = 0; c < fmt.channels; c++) sum += dv.getInt16(dataStart + i * frame + c * 2, true)
      odv.setInt16(i * 2, Math.round(sum / fmt.channels), true)
    }
    return { sampleRate: fmt.rate, pcm16: out, duration: frames / fmt.rate }
  }

  const read = (pos: number): number => {
    if (fmt.format === 1 && fmt.bits === 24) {
      const v = dv.getUint8(pos) | (dv.getUint8(pos + 1) << 8) | (dv.getInt8(pos + 2) << 16)
      return v / 8388608
    }
    if (fmt.format === 1) return dv.getInt32(pos, true) / 2147483648
    return dv.getFloat32(pos, true)
  }

  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) sum += read(dataStart + i * frame + c * bytesPer)
    const v = Math.max(-1, Math.min(1, sum / fmt.channels))
    odv.setInt16(i * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true)
  }
  return { sampleRate: fmt.rate, pcm16: out, duration: frames / fmt.rate }
}

/** 16-bit mono PCM to a WAV file (tests and diagnostics). */
export function encodeWav(pcm16: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm16.byteLength)
  const dv = new DataView(out.buffer)
  const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)))
  w(0, 'RIFF')
  dv.setUint32(4, 36 + pcm16.byteLength, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  w(36, 'data')
  dv.setUint32(40, pcm16.byteLength, true)
  out.set(pcm16, 44)
  return out
}

/** Peak absolute sample of PCM16, 0..1. */
export function peakPcm16(pcm16: Uint8Array): number {
  const dv = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength & ~1)
  let peak = 0
  for (let i = 0; i < dv.byteLength; i += 2) peak = Math.max(peak, Math.abs(dv.getInt16(i, true)))
  return peak / 32768
}
