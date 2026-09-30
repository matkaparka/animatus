/**
 * Binary media frames on the stage WebSocket (orchestrator → stage).
 *
 * Layout, little endian, 16-byte header followed by the payload:
 *
 *   offset size field
 *   0      1    magic 'A' (0x41)
 *   1      1    magic 'N' (0x4E)
 *   2      1    version (1)
 *   3      1    kind: 1 = audio (PCM16 LE mono), 2 = vrma (a .vrma file, may span frames)
 *   4      4    handle: u32 chosen by the orchestrator in `utterance.begin`
 *   8      4    index: u32 chunk index within this stream, starts at 0
 *   12     1    flags: bit0 = last chunk of this stream
 *   13     3    reserved, zero
 *   16     n    payload
 *
 * A VRMA stream (kind 2) for an utterance completes before that utterance's audio stream
 * starts. An audio stream always ends with a frame carrying the `last` flag; that frame may
 * have an empty payload (an utterance with no audio, e.g. fully filtered text).
 *
 * Only Uint8Array / DataView are used so the same code runs in Node and in the browser.
 */

export const FRAME_HEADER_BYTES = 16
export const FRAME_MAGIC_0 = 0x41
export const FRAME_MAGIC_1 = 0x4e
export const FRAME_VERSION = 1

export const FrameKind = {
  Audio: 1,
  Vrma: 2,
} as const
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind]

export const FLAG_LAST = 0x01

export interface MediaFrame {
  kind: FrameKind
  handle: number
  index: number
  last: boolean
  /** View into the received buffer (not a copy). */
  payload: Uint8Array
}

export function encodeFrame(
  kind: FrameKind,
  handle: number,
  index: number,
  payload: Uint8Array,
  last: boolean
): Uint8Array {
  if (!Number.isInteger(handle) || handle < 0 || handle > 0xffffffff) {
    throw new RangeError(`handle out of range: ${handle}`)
  }
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new RangeError(`index out of range: ${index}`)
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength)
  const dv = new DataView(out.buffer)
  out[0] = FRAME_MAGIC_0
  out[1] = FRAME_MAGIC_1
  out[2] = FRAME_VERSION
  out[3] = kind
  dv.setUint32(4, handle, true)
  dv.setUint32(8, index, true)
  out[12] = last ? FLAG_LAST : 0
  out.set(payload, FRAME_HEADER_BYTES)
  return out
}

export const encodeAudioFrame = (handle: number, index: number, pcm16: Uint8Array, last: boolean) =>
  encodeFrame(FrameKind.Audio, handle, index, pcm16, last)

export const encodeVrmaFrame = (handle: number, index: number, bytes: Uint8Array, last: boolean) =>
  encodeFrame(FrameKind.Vrma, handle, index, bytes, last)

export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/** Decode one binary frame. Throws FrameError for anything malformed. */
export function decodeFrame(buf: ArrayBuffer | Uint8Array): MediaFrame {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (u8.byteLength < FRAME_HEADER_BYTES) throw new FrameError(`frame too short: ${u8.byteLength} bytes`)
  if (u8[0] !== FRAME_MAGIC_0 || u8[1] !== FRAME_MAGIC_1) throw new FrameError('bad magic')
  if (u8[2] !== FRAME_VERSION) throw new FrameError(`unsupported frame version ${u8[2]}`)
  const kind = u8[3]
  if (kind !== FrameKind.Audio && kind !== FrameKind.Vrma) throw new FrameError(`unknown frame kind ${kind}`)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  return {
    kind,
    handle: dv.getUint32(4, true),
    index: dv.getUint32(8, true),
    last: ((u8[12] ?? 0) & FLAG_LAST) !== 0,
    payload: u8.subarray(FRAME_HEADER_BYTES),
  }
}

/** Split a PCM16 buffer into frames of at most `chunkBytes` (rounded down to whole samples). */
export function* chunkPcm16(
  handle: number,
  pcm16: Uint8Array,
  chunkBytes = 9600
): Generator<Uint8Array> {
  const step = Math.max(2, chunkBytes - (chunkBytes % 2))
  if (pcm16.byteLength === 0) {
    yield encodeAudioFrame(handle, 0, pcm16, true)
    return
  }
  let index = 0
  for (let off = 0; off < pcm16.byteLength; off += step) {
    const end = Math.min(off + step, pcm16.byteLength)
    yield encodeAudioFrame(handle, index++, pcm16.subarray(off, end), end >= pcm16.byteLength)
  }
}
