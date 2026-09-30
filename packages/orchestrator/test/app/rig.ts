/** Shared pieces of the application tests: a fully wired App with a real stage server and scripted stand-ins. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import type { TtsAdapter, TtsRequest, TtsStream } from '@animatus/protocol'
import { App } from '../../src/app/app.ts'
import type { AppOptions, BilibiliLike } from '../../src/app/app.ts'
import { parseConfig } from '../../src/config.ts'
import type { AppConfigInput } from '../../src/config.ts'
import type { LlmLike } from '../../src/brain/brain.ts'
import type { LlmDelta, LlmRequest } from '../../src/llm/types.ts'
import { getFreePort } from '../../src/plugins/ports.ts'
import { MemorySecretStore } from '../../src/plugins/secrets.ts'
import { FakeStage } from '../_stage-support/fake-stage.ts'
import type { FakeStageOptions } from '../_stage-support/fake-stage.ts'

const cleanups: (() => Promise<void> | void)[] = []

/** Call once at the top of a test file. */
export function installCleanup(): void {
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })
}

export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn)
}

export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `animatus-${prefix}-`))
  onCleanup(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 0.2 s of a 440 Hz tone at 16 kHz, as PCM16 little-endian. */
export function tone(seconds = 0.2): Uint8Array {
  const n = Math.round(16000 * seconds)
  const buf = new Uint8Array(n * 2)
  const view = new DataView(buf.buffer)
  for (let i = 0; i < n; i++)
    view.setInt16(i * 2, Math.round(Math.sin((i / 16000) * 2 * Math.PI * 440) * 8000), true)
  return buf
}

export class FakeTts implements TtsAdapter {
  readonly requests: TtsRequest[] = []
  failWith: Error | null = null
  async styles() {
    return ['neutral']
  }
  async synthesize(req: TtsRequest): Promise<TtsStream> {
    this.requests.push(req)
    if (this.failWith) throw this.failWith
    return {
      sampleRate: 16000,
      chunks: (async function* () {
        yield tone()
      })(),
    }
  }
}

export class FakeLlm implements LlmLike {
  readonly requests: LlmRequest[] = []
  reply: (req: LlmRequest) => (string | Error)[] = () => ['[neutral]Okay.']
  stream(req: LlmRequest): AsyncIterable<LlmDelta> {
    this.requests.push(req)
    const pieces = this.reply(req)
    return (async function* () {
      for (const p of pieces) {
        if (req.signal?.aborted) return
        await new Promise((r) => setTimeout(r, 1))
        if (p instanceof Error) throw p
        yield { type: 'text', text: p }
      }
    })()
  }
}

export class FakeBilibili implements BilibiliLike {
  handler: ((e: unknown) => void) | null = null
  started = false
  stopped = false
  on(_event: 'event', fn: (e: never) => void) {
    this.handler = fn as (e: unknown) => void
    return this
  }
  async start() {
    this.started = true
  }
  async stop() {
    this.stopped = true
  }
  emit(e: unknown) {
    this.handler?.(e)
  }
}

export interface Rig {
  app: App
  llm: FakeLlm
  tts: FakeTts
  bili: FakeBilibili
  dir: string
  connect(opts?: FakeStageOptions): Promise<FakeStage>
}

export interface RigOptions {
  config?: AppConfigInput
  app?: Partial<AppOptions>
  /** Do not give the app a speech backend of its own: it has to get one from a plugin. */
  noTts?: boolean
  /** Directory of plugin folders. Default: an empty one. */
  pluginsDir?: string
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const dir = await tempDir('app')
  const persona = path.join(dir, 'persona')
  await mkdir(persona, { recursive: true })
  await writeFile(
    path.join(persona, 'persona.md'),
    '# Test persona\nShort answers. Start sentences with an emotion tag.\n'
  )
  const motions = path.join(dir, 'motions')
  await mkdir(path.join(motions, 'poses'), { recursive: true })
  await writeFile(path.join(motions, 'poses', 'nod.vrma'), 'x')
  const pluginsDir = options.pluginsDir ?? path.join(dir, 'plugins')
  await mkdir(pluginsDir, { recursive: true })

  const config = parseConfig(
    {
      servers: { stage_port: await getFreePort(), console_port: await getFreePort() },
      paths: { data_dir: path.join(dir, 'data'), motions },
      persona,
      inbox: { pacer: { idle_settle_sec: 0.05, min_interval_sec: 0.05, busy_timeout_sec: 5 } },
      sources: { bilibili: { enabled: true, room_id: 1234 } },
      ...options.config,
    },
    { root: dir }
  )
  const llm = new FakeLlm()
  const tts = new FakeTts()
  const bili = new FakeBilibili()
  const app = await App.create({
    config,
    secrets: new MemorySecretStore(),
    llm,
    ...(options.noTts ? {} : { tts }),
    makeBilibili: () => bili,
    noBrowser: true,
    inboxTickMs: 15,
    pluginsDir,
    stageDir: path.join(dir, 'no-stage-build'),
    logger: () => {},
    ...options.app,
  })
  await app.start()
  onCleanup(() => app.stop())
  return {
    app,
    llm,
    tts,
    bili,
    dir,
    async connect(opts) {
      const s = await FakeStage.connect(app.stage.url, opts)
      onCleanup(() => s.close())
      return s
    },
  }
}

export async function until(cond: () => boolean, ms = 4000, what = 'condition'): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

export const danmaku = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'danmaku',
  uid: 1001,
  uname: 'ann',
  text,
  dmType: 0,
  admin: false,
  roomOwnerUid: 1,
  ts: Date.now(),
  ...extra,
})
