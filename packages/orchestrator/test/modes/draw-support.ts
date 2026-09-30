/**
 * Stand-ins for the tests of the draw mode: a tiny PNG made in code, a fake image service on a real local port
 * (the contract of docs/mode-draw.md), and a configuration for the mode. No picture is kept anywhere.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

/** The blocklist that ships with the image service, which the mode's default points at (relative to the project root). */
export const REPO_BLOCKLIST = path.resolve(
  __dirname,
  '../../../../plugins/forge/blocklist.default.txt'
)

/** What the model answers to the first planning call. */
export const selectAnswer = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    style: 'anime',
    subject: 'a knight',
    checkpoint: 'anime-model',
    loras: [],
    orientation: 'portrait',
    self: false,
    note: 'fits',
    ...over,
  })

/** What the model answers to the second. */
export const writeAnswer = (prompt = '1girl, armor', negative = ''): string =>
  JSON.stringify({ prompt, negative })

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A valid PNG of one colour, a few dozen bytes. */
export function makePng(
  width = 2,
  height = 2,
  rgb: [number, number, number] = [200, 30, 30]
): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Not a real JPEG, only bytes the model layer passes on untouched. */
export const FAKE_THUMB = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
])

export interface Reply {
  status: number
  body: unknown
}

export interface ServiceCall {
  method: string
  path: string
  body: unknown
}

export function okPicture(over: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      status: 'ok',
      image_b64: makePng().toString('base64'),
      thumb_b64: FAKE_THUMB.toString('base64'),
      width: 1024,
      height: 1024,
      seed: 42,
      attempts: 1,
      checkpoint: 'anime-model.safetensors [aaaa1111]',
      family: 'anime',
      ...over,
    },
  }
}

export const serviceError = (
  status: number,
  code: string,
  message: string,
  retryable = false
): Reply => ({
  status,
  body: { status: 'error', reason: code, error: { code, message, retryable } },
})

export const defaultCatalog = () => ({
  checkpoints: [
    {
      name: 'anime-model',
      title: 'anime-model.safetensors [aaaa1111]',
      family: 'anime',
      allowed: true,
    },
    {
      name: 'photo-model',
      title: 'photo-model.safetensors [bbbb2222]',
      family: 'pony',
      allowed: true,
    },
    {
      name: 'furry-model',
      title: 'furry-model.safetensors [cccc3333]',
      family: 'anime',
      allowed: true,
    },
    {
      name: 'self-model',
      title: 'self-model.safetensors [dddd4444]',
      family: 'anime',
      allowed: true,
    },
    {
      name: 'heavy-model',
      title: 'heavy-model.safetensors [eeee5555]',
      family: 'heavy',
      allowed: false,
      why_not: 'its family is architecture flux1, which is not allowed',
    },
  ],
  loras: [
    { name: 'sword-lora', alias: 'SwordStyle', allowed: true },
    { name: 'self-lora', allowed: true },
    { name: 'photo-lora', allowed: true },
    { name: 'off-list-lora', allowed: false },
  ],
  families: ['anime', 'pony', 'heavy'],
  max_long_side: 1024,
})

export const healthy = (config: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    ok: true,
    ready: true,
    service: 'forge',
    config: {
      max_long_side: 1024,
      forge_reachable: true,
      forge_error: null,
      rating_model: 'ready',
      queue_waiting: 0,
      queue_max: 3,
      busy: false,
      last_error: null,
      ...config,
    },
  },
})

/** The image service on a real local port. Fields can be changed between calls: they are read on every request. */
export class FakeForgeService {
  readonly calls: ServiceCall[] = []
  /** Bodies of `/generate` requests whose connection was closed by the caller before an answer was sent. */
  readonly hungUp: unknown[] = []
  health: () => Reply = () => healthy()
  catalog: () => Reply = () => ({ status: 200, body: defaultCatalog() })
  /** Answers one `/generate`; may wait (a gate) before answering. */
  generate: (body: Record<string, unknown>) => Promise<Reply> | Reply = () => okPicture()
  config: (body: Record<string, unknown>) => Reply = () => ({
    status: 200,
    body: { ok: true, config: {} },
  })
  private server: Server | null = null
  url = ''

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    )
    this.server = null
  }

  generateCalls(): Record<string, unknown>[] {
    return this.calls
      .filter((c) => c.path === '/generate')
      .map((c) => c.body as Record<string, unknown>)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    const path = req.url ?? ''
    this.calls.push({ method: req.method ?? '', path, body })
    let answered = false
    res.on('close', () => {
      if (!answered && path === '/generate') this.hungUp.push(body)
    })
    let reply: Reply
    if (path === '/health') reply = this.health()
    else if (path === '/catalog') reply = this.catalog()
    else if (path === '/config') reply = this.config(body as Record<string, unknown>)
    else if (path === '/generate') reply = await this.generate(body as Record<string, unknown>)
    else
      reply = {
        status: 404,
        body: { error: { code: 'not_found', message: 'no such path', retryable: false } },
      }
    answered = true
    if (res.destroyed) return
    const raw = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(raw)
  }
}

/**
 * A Forge server (the A1111 API the image service talks to) on a real local port, for the tests that run the real
 * image service as a process.
 */
export class FakeForgeApi {
  readonly txt2img: Record<string, unknown>[] = []
  interrupts = 0
  unloads = 0
  models = ['anime-model', 'photo-model', 'furry-model', 'self-model'].map((name, i) => ({
    title: `${name}.safetensors [${String(i + 1).repeat(8)}]`,
    model_name: name,
  }))
  loras = [
    { name: 'sword-lora', alias: 'SwordStyle' },
    { name: 'self-lora', alias: null },
    { name: 'photo-lora', alias: null },
    { name: 'off-list-lora', alias: null },
  ]
  /** Set to hold every picture until it opens (an interrupt opens it too, as Forge stopping would). */
  hold: { wait: Promise<void>; open: () => void } | null = null
  private server: Server | null = null
  url = ''

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    )
    this.server = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    const send = (body: unknown, status = 200) => {
      if (res.destroyed) return
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const url = req.url ?? ''
    if (url === '/sdapi/v1/options') return send({ sd_model_checkpoint: 'anime-model' })
    if (url === '/sdapi/v1/sd-models') return send(this.models)
    if (url === '/sdapi/v1/loras') return send(this.loras)
    if (url === '/sdapi/v1/interrupt') {
      this.interrupts++
      this.hold?.open()
      return send({})
    }
    if (url === '/sdapi/v1/unload-checkpoint') {
      this.unloads++
      return send({})
    }
    if (url === '/sdapi/v1/txt2img') {
      this.txt2img.push(JSON.parse(text) as Record<string, unknown>)
      if (this.hold) await this.hold.wait
      return send({ images: [makePng().toString('base64')], info: '{}' })
    }
    send({ detail: 'Not Found' }, 404)
  }
}

/** A gate: `wait()` blocks until `open()`. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => (open = resolve))
  return { wait, open }
}

const route = (over: Record<string, unknown> = {}) => ({
  checkpoints: [
    {
      name: 'anime-model',
      guide: 'illustrious',
      prefix: 'masterpiece, best quality',
      negative: 'lowres',
    },
  ],
  ...over,
})

/** `modes.draw.config` for the tests: four routes, the shipped blocklist, short times. */
export function drawConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    blocklist_files: [REPO_BLOCKLIST],
    cooldown_sec: 300,
    show_sec: 600,
    reaction_wait_sec: 5,
    plan_timeout_sec: 30,
    generate_timeout_sec: 10,
    ambiguous_tags: { husky: ['husky', '哈士奇'] },
    planner_notes: '"熊" means a large, bearlike man, not the animal.',
    routes: {
      default: route({
        loras: [
          { name: 'sword-lora', weight: 0.7, trigger: ['sword_style'], desc: 'swords and blades' },
        ],
      }),
      self: route({
        checkpoints: [{ name: 'self-model', guide: 'illustrious', prefix: 'masterpiece' }],
        loras: [{ name: 'self-lora', weight: 0.7, trigger: ['self_trigger', 'mecha dragon'] }],
        keywords: ['自画像', '你自己'],
        exact: ['你'],
        fixed: true,
        description: 'a red-gold mechanical dragon',
      }),
      photo: route({
        checkpoints: [{ name: 'photo-model', guide: 'pony', prefix: 'score_9, score_8_up' }],
        loras: [{ name: 'photo-lora', weight: 0.8 }],
        keywords: ['真人', '照片'],
      }),
      furry: route({
        checkpoints: [{ name: 'furry-model', guide: 'illustrious' }],
        keywords: ['兽人', 'furry'],
      }),
    },
    ...over,
  }
}
