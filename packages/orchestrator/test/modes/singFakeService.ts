/**
 * A stand-in for the song service (plugins/singing) on a loopback port, speaking its HTTP contract from an in-memory
 * queue. Tests move entries along (`ready`, `fail`) and script the odd answers (a refusal, an outage, a hang); every
 * call is written down. It is not a second implementation of the service: it answers only what the tests ask.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeItem {
  qid: number
  song_id: string
  title: string
  artists: string[]
  duration: number
  requester_uid: string
  requester_name: string
  state: 'queued' | 'downloading' | 'processing' | 'ready' | 'playing' | 'failed'
  cached: boolean
  requested_at: number
  request_id?: string
  claim_id?: string
  reason?: string
  error?: string
  code?: string
  retryable?: boolean
  warnings: string[]
}

export interface Call {
  method: string
  path: string
  body: Record<string, unknown>
}

type Reply = { status: number; body: unknown } | 'hang' | 'drop'

export class FakeSongService {
  readonly calls: Call[] = []
  items: FakeItem[] = []
  failed: FakeItem[] = []
  current: FakeItem | null = null
  nextQid = 1
  songsDir: string
  halted: { reason: string } | null = null
  worker: { state: string; title?: string; step?: string } = { state: 'idle' }
  /** Seconds the fake says a claimed song lasts, and its lyrics. */
  duration = 200
  lyrics = [
    { t: 1, text: 'first line' },
    { t: 5.5, text: 'second line' },
  ]
  /** Replaces where `/claim` says a song's tracks are (by default: its own folder, the two final files). */
  filesOverride: { dir: string; vocals: string; inst: string } | null = null
  /** Answers to force, by path (a queue of them: each is used once, in order). */
  script = new Map<string, Reply[]>()
  /** What `/claim` does when nothing is scripted: give the first ready song, or nothing. */
  claimNothing = false
  delayMs = 0
  private server: Server
  private requests = new Map<string, unknown>()

  private constructor(songsDir: string) {
    this.songsDir = songsDir
    this.server = createServer((req, res) => void this.handle(req, res))
  }

  static async start(songsDir: string): Promise<FakeSongService> {
    const s = new FakeSongService(songsDir)
    await new Promise<void>((resolve) => s.server.listen(0, '127.0.0.1', resolve))
    return s
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** Answer the next call of a path with this instead of the usual. */
  answer(path: string, reply: Reply): void {
    this.script.set(path, [...(this.script.get(path) ?? []), reply])
  }

  callsTo(path: string): Call[] {
    return this.calls.filter((c) => c.path === path)
  }

  // ─────────────────────────────── the queue, for a test to arrange ───────────────────────────────

  add(title: string, over: Partial<FakeItem> = {}): FakeItem {
    const item: FakeItem = {
      qid: this.nextQid++,
      song_id: `song-${this.nextQid - 1}`,
      title,
      artists: ['Artist'],
      duration: this.duration,
      requester_uid: '1001',
      requester_name: 'ann',
      state: 'queued',
      cached: false,
      requested_at: 1_000,
      warnings: [],
      ...over,
    }
    this.items.push(item)
    return item
  }

  /** A song that is ready to be sung. */
  ready(title: string, over: Partial<FakeItem> = {}): FakeItem {
    return this.add(title, { state: 'ready', ...over })
  }

  private view(it: FakeItem) {
    const { claim_id: _claim, request_id: _request, ...rest } = it
    return rest
  }

  private queueBody() {
    return {
      current: this.current ? this.view(this.current) : null,
      items: this.items.map((i) => this.view(i)),
      failed: this.failed.map((i) => this.view(i)),
      worker: this.worker,
      source: { kind: 'fake', halted: this.halted },
      songs_dir: this.songsDir,
      limits: { max_per_user: 1, max_len: 5 },
    }
  }

  // ─────────────────────────────── HTTP ───────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    const path = (req.url ?? '/').split('?')[0] as string
    const method = req.method ?? 'GET'
    this.calls.push({ method, path, body })
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    const scripted = this.script.get(path)?.shift()
    const reply: Reply = scripted ?? this.route(method, path, body)
    if (reply === 'hang') return // never answered
    if (reply === 'drop') return void req.socket.destroy()
    const data = JSON.stringify(reply.body)
    res.writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(data),
    })
    res.end(data)
  }

  private error(status: number, code: string, message: string, retryable = false): Reply {
    return { status, body: { error: { code, message, retryable } } }
  }

  private finish(outcome: string): void {
    const it = this.current
    if (!it) return
    this.current = null
    if (outcome === 'released') {
      it.state = 'ready'
      delete it.claim_id
      this.items.unshift(it)
    } else if (outcome === 'failed') {
      this.failed.push({ ...it, state: 'failed', code: 'playback_failed', retryable: true })
    }
  }

  private route(method: string, path: string, body: Record<string, unknown>): Reply {
    const ok = (b: unknown): Reply => ({ status: 200, body: b })
    if (method === 'GET' && path === '/queue') return ok(this.queueBody())
    if (method !== 'POST') return this.error(404, 'not_found', 'no such path')
    switch (path) {
      case '/request': {
        const id = String(body.request_id ?? '')
        if (id && this.requests.has(id))
          return ok({ ...(this.requests.get(id) as object), duplicate: true })
        const keyword = String(body.keyword ?? '')
        let result: object
        if (keyword.includes('omega'))
          result = { status: 'rejected', code: 'not_found', reason: `没搜到「${keyword}」` }
        else if (keyword.includes('boom'))
          return this.error(503, 'source_down', '连不上歌曲来源，稍后再点', true)
        else {
          const it = this.add(keyword, {
            requester_uid: String(body.requester_uid ?? ''),
            requester_name: String(body.requester_name ?? ''),
            request_id: id,
          })
          result = {
            status: 'queued',
            qid: it.qid,
            song: { id: it.song_id, title: it.title, artists: it.artists, duration: it.duration },
            position: this.items.length + (this.current ? 1 : 0),
            cached: false,
          }
        }
        if (id) this.requests.set(id, result)
        return ok(result)
      }
      case '/abandon': {
        const id = String(body.request_id ?? '')
        const at = this.items.findIndex((i) => i.request_id === id)
        if (at >= 0) this.items.splice(at, 1)
        return ok({ ok: true, removed: at >= 0 })
      }
      case '/claim': {
        if (this.current && this.current.claim_id === body.claim_id)
          return ok(this.claimBody(this.current))
        if (this.current) this.finish('interrupted')
        const it = this.claimNothing ? undefined : this.items.find((i) => i.state === 'ready')
        if (!it) return ok({ item: null, pending: this.items.length })
        this.items.splice(this.items.indexOf(it), 1)
        it.state = 'playing'
        it.claim_id = String(body.claim_id)
        this.current = it
        return ok(this.claimBody(it))
      }
      case '/done': {
        if (!this.current || (body.qid !== undefined && body.qid !== this.current.qid))
          return ok({ ok: false, code: 'nothing_playing', reason: '现在没在唱歌' })
        const it = this.current
        this.finish(String(body.outcome))
        return ok({ ok: true, item: this.view(it) })
      }
      case '/skip': {
        if (!this.current) return ok({ ok: false, code: 'nothing_playing', reason: '现在没在唱歌' })
        const it = this.current
        this.finish('skipped')
        return ok({ ok: true, item: this.view(it) })
      }
      case '/cancel': {
        if (typeof body.position === 'number') {
          const it = this.items[body.position - 1]
          if (!it)
            return ok({
              ok: false,
              code: 'no_such_position',
              reason: `队列里没有第 ${body.position} 首`,
            })
          this.items.splice(body.position - 1, 1)
          return ok({ ok: true, item: this.view(it), was_playing: false })
        }
        const mine = this.items.filter((i) => i.requester_uid === body.requester_uid)
        const last = mine.at(-1)
        if (last) {
          this.items.splice(this.items.indexOf(last), 1)
          return ok({ ok: true, item: this.view(last), was_playing: false })
        }
        if (this.current && this.current.requester_uid === body.requester_uid) {
          const it = this.current
          this.finish('skipped')
          return ok({ ok: true, item: this.view(it), was_playing: true })
        }
        return ok({ ok: false, code: 'nothing_to_cancel', reason: '没有在排的歌' })
      }
      case '/remove': {
        const at = this.items.findIndex((i) => i.qid === body.qid)
        if (at < 0) return ok({ ok: false, code: 'not_in_queue', reason: '队列里没有这首歌' })
        const [it] = this.items.splice(at, 1)
        return ok({ ok: true, item: this.view(it as FakeItem) })
      }
      case '/source/resume':
        this.halted = null
        return ok({ ok: true })
      default:
        return this.error(404, 'not_found', 'no such path')
    }
  }

  private claimBody(it: FakeItem) {
    return {
      item: this.view(it),
      files: this.filesOverride ?? {
        dir: it.song_id,
        vocals: 'vocals_final.wav',
        inst: 'inst_final.wav',
      },
      lyrics: this.lyrics,
      duration: it.duration,
      transpose: 0,
      warnings: [],
    }
  }
}
