/** Shared test fixtures: temp folders, WAV / PCM builders, raw HTTP requests, log collection, polling. */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Logger, LogLevel } from '../../src/stage/logger.ts'

// ───────────────────────────── cleanup ─────────────────────────────

export function createCleanup() {
  const tasks: Array<() => void | Promise<void>> = []
  return {
    add(task: () => void | Promise<void>): void {
      tasks.push(task)
    },
    async run() {
      const pending = tasks.splice(0).reverse()
      for (const task of pending) {
        try {
          await task()
        } catch {
          // best effort
        }
      }
    },
  }
}

/** A fresh temp folder; remove it with the returned `remove()`. */
export function makeTempDir(prefix = 'animatus-test-'): { dir: string; remove: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  return {
    dir,
    remove: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  }
}

/** Writes files (relative path -> content) below `root`, creating folders. */
export function writeTree(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

// ───────────────────────────── polling ─────────────────────────────

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Small seeded generator (mulberry32) so "random" tests are repeatable. */
export function seededRandom(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export async function waitUntil(
  cond: () => boolean,
  timeoutMs = 3000,
  what = 'condition'
): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await delay(5)
  }
}

// ───────────────────────────── logging ─────────────────────────────

export interface LogEntry {
  level: LogLevel
  msg: string
  extra?: Record<string, unknown>
}

export function collectLogger(): {
  logger: Logger
  entries: LogEntry[]
  has: (level: LogLevel, part: string) => boolean
} {
  const entries: LogEntry[] = []
  const logger: Logger = (level, msg, extra) => {
    entries.push(extra ? { level, msg, extra } : { level, msg })
  }
  return {
    logger,
    entries,
    has: (level, part) => entries.some((e) => e.level === level && e.msg.includes(part)),
  }
}

// ───────────────────────────── binary builders ─────────────────────────────

/** Deterministic PCM16-looking bytes (even length). */
export function pcmPattern(bytes: number, seed = 7): Uint8Array {
  const out = new Uint8Array(bytes - (bytes % 2))
  for (let i = 0; i < out.length; i++) out[i] = (i * 31 + seed) & 0xff
  return out
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

export interface WavSpec {
  /** Default 16000. */
  sampleRate?: number
  channels?: number
  /** `tag` and `bits` are written as given, so unsupported formats can be produced. */
  format?: 'pcm16' | 'float32' | { tag: number; bits: number }
  /** One array of per-channel samples per frame: `frames[i][c]`. For pcm16 integers, for float32 numbers. */
  frames: number[][]
  /** Use WAVE_FORMAT_EXTENSIBLE with the real format in the sub-format GUID. */
  extensible?: boolean
  /** Chunks written between fmt and data (e.g. an odd-sized LIST chunk to test padding). */
  extraChunks?: Array<{ id: string; bytes: Uint8Array }>
  /** Overrides the data chunk size field (e.g. 0xffffffff for streamed files). */
  dataSizeField?: number
  /** Cuts this many bytes off the end of the data. */
  truncateBy?: number
}

export function makeWav(spec: WavSpec): Uint8Array {
  const channels = spec.channels ?? spec.frames[0]?.length ?? 1
  const sampleRate = spec.sampleRate ?? 16000
  const format = spec.format ?? 'pcm16'
  const tag = format === 'pcm16' ? 1 : format === 'float32' ? 3 : format.tag
  const bits = format === 'pcm16' ? 16 : format === 'float32' ? 32 : format.bits
  const sampleBytes = bits / 8

  const data = new Uint8Array(spec.frames.length * channels * sampleBytes)
  const dv = new DataView(data.buffer)
  spec.frames.forEach((frame, i) => {
    frame.forEach((value, c) => {
      const at = (i * channels + c) * sampleBytes
      if (bits === 16) dv.setInt16(at, value, true)
      else if (bits === 32 && tag === 3) dv.setFloat32(at, value, true)
      else if (bits === 32) dv.setInt32(at, value, true)
      else if (bits === 64) dv.setFloat64(at, value, true)
      else if (bits === 8) dv.setUint8(at, value)
      else if (bits === 24) {
        dv.setUint8(at, value & 0xff)
        dv.setUint8(at + 1, (value >> 8) & 0xff)
        dv.setUint8(at + 2, (value >> 16) & 0xff)
      }
    })
  })

  const fmtSize = spec.extensible ? 40 : 16
  const fmt = new Uint8Array(fmtSize)
  const f = new DataView(fmt.buffer)
  f.setUint16(0, spec.extensible ? 0xfffe : tag, true)
  f.setUint16(2, channels, true)
  f.setUint32(4, sampleRate, true)
  f.setUint32(8, sampleRate * channels * sampleBytes, true)
  f.setUint16(12, channels * sampleBytes, true)
  f.setUint16(14, bits, true)
  if (spec.extensible) {
    f.setUint16(16, 22, true) // cbSize
    f.setUint16(18, bits, true) // valid bits
    f.setUint32(20, 0, true) // channel mask
    f.setUint16(24, tag, true) // sub-format GUID starts with the format code
    fmt.set(
      [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71],
      26
    )
  }

  const chunk = (id: string, body: Uint8Array, sizeField?: number) => {
    const pad = body.byteLength % 2
    const out = new Uint8Array(8 + body.byteLength + pad)
    out.set(
      [...id].map((ch) => ch.charCodeAt(0)),
      0
    )
    new DataView(out.buffer).setUint32(4, sizeField ?? body.byteLength, true)
    out.set(body, 8)
    return out
  }
  const cut = spec.truncateBy ? data.subarray(0, data.byteLength - spec.truncateBy) : data
  const chunks = [
    chunk('fmt ', fmt),
    ...(spec.extraChunks ?? []).map((c) => chunk(c.id, c.bytes)),
    chunk('data', cut, spec.dataSizeField),
  ]
  const body = concatBytes(chunks)
  const riff = new Uint8Array(12 + body.byteLength)
  riff.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  new DataView(riff.buffer).setUint32(4, 4 + body.byteLength, true)
  riff.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  riff.set(body, 12)
  return riff
}

/** A tone as mono 16-bit WAV: convenient for replay fixtures. */
export function makeToneWav(ms: number, sampleRate = 16000): Uint8Array {
  const n = Math.round((ms / 1000) * sampleRate)
  return makeWav({
    sampleRate,
    frames: Array.from({ length: n }, (_, i) => [
      Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 8000),
    ]),
  })
}

// ───────────────────────────── raw HTTP ─────────────────────────────

export interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/**
 * One HTTP request with the path sent exactly as given (no URL normalisation, unlike fetch), on its
 * own connection. The Host header defaults to the right loopback name and can be overridden.
 */
export function rawRequest(
  port: number,
  rawPath: string,
  opts: { method?: string; headers?: Record<string, string>; host?: string } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: rawPath,
        headers: { Host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers },
        setHost: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** Sends literal bytes over TCP and returns everything the server answers until it closes the socket. */
export function rawSocket(port: number, text: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(Buffer.concat(chunks).toString('latin1'))
    }, timeoutMs)
    socket.on('connect', () => socket.write(text))
    socket.on('data', (c) => chunks.push(c))
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('latin1'))
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
