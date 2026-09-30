/** PCM16 little-endian to float32 in [-1, 1]. Ignores a trailing odd byte. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const n = bytes.byteLength >> 1
  const out = new Float32Array(n)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
  for (let i = 0; i < n; i++) {
    const s = dv.getInt16(i * 2, true)
    out[i] = s < 0 ? s / 32768 : s / 32767
  }
  return out
}

/** Decodes a stream of PCM16 chunks whose boundaries may fall in the middle of a sample. */
export class Pcm16Decoder {
  private carry: number | null = null

  push(bytes: Uint8Array): Float32Array {
    if (bytes.byteLength === 0) return new Float32Array(0)
    let data = bytes
    if (this.carry !== null) {
      const joined = new Uint8Array(bytes.byteLength + 1)
      joined[0] = this.carry
      joined.set(bytes, 1)
      data = joined
      this.carry = null
    }
    if (data.byteLength & 1) {
      this.carry = data[data.byteLength - 1] ?? null
      data = data.subarray(0, data.byteLength - 1)
    }
    return pcm16ToFloat32(data)
  }
}
