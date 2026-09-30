/** The typed client against a fake song service (and against servers that misbehave). */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SongServiceClient, SongServiceError } from '../../src/modes/singing/client.ts'
import { FakeSongService } from './singFakeService.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
})

async function fake() {
  const svc = await FakeSongService.start('C:/path/to/songs')
  closers.push(() => svc.close())
  const client = new SongServiceClient({ baseUrl: () => svc.url, callTimeoutMs: 800 })
  return { svc, client }
}

/** A server that answers every call with `handler`'s status and text. */
async function odd(handler: () => { status: number; text: string }) {
  const server: Server = createServer((req, res) => {
    req.resume()
    const { status, text } = handler()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(text)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      })
  )
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return new SongServiceClient({ baseUrl: () => url, callTimeoutMs: 500 })
}

const error = async (p: Promise<unknown>) =>
  (await p.then(
    () => null,
    (e: unknown) => e
  )) as SongServiceError

describe('the song service client', () => {
  it('reads the queue', async () => {
    const { svc, client } = await fake()
    svc.ready('晴天')
    svc.add('Second', { requester_name: 'bob' })
    const q = await client.queue()
    expect(q.items.map((i) => [i.title, i.state, i.requester_name])).toEqual([
      ['晴天', 'ready', 'ann'],
      ['Second', 'queued', 'bob'],
    ])
    expect(q.current).toBeNull()
    expect(q.songs_dir).toBe('C:/path/to/songs')
    expect(q.limits).toEqual({ max_per_user: 1, max_len: 5 })
  })

  it('sends a request with its id, who asked, and how long the caller will wait', async () => {
    const { svc, client } = await fake()
    const r = await client.request({
      requestId: 'r-1',
      keyword: '晴天',
      uid: '1001',
      name: 'ann',
      waitSec: 20,
      slackSec: 5,
    })
    expect(r).toMatchObject({ status: 'queued', qid: 1, position: 1, cached: false })
    expect(svc.callsTo('/request')[0]!.body).toEqual({
      request_id: 'r-1',
      keyword: '晴天',
      requester_uid: '1001',
      requester_name: 'ann',
      wait_s: 20,
    })
    // the same id again: the service says it is the same request
    const again = await client.request({
      requestId: 'r-1',
      keyword: '晴天',
      uid: '1001',
      name: 'ann',
      waitSec: 20,
      slackSec: 5,
    })
    expect(again).toMatchObject({ status: 'queued', qid: 1, duplicate: true })
  })

  it('reads a refusal as an answer, not an error', async () => {
    const { client } = await fake()
    const r = await client.request({
      requestId: 'r',
      keyword: 'omega',
      uid: '1',
      name: 'a',
      waitSec: 5,
      slackSec: 1,
    })
    expect(r).toEqual({ status: 'rejected', code: 'not_found', reason: '没搜到「omega」' })
  })

  it('claims, reports and cancels', async () => {
    const { svc, client } = await fake()
    svc.ready('晴天')
    const claim = await client.claim('c-1')
    expect(claim.item?.title).toBe('晴天')
    expect(claim.files).toEqual({
      dir: 'song-1',
      vocals: 'vocals_final.wav',
      inst: 'inst_final.wav',
    })
    expect(claim.lyrics[0]).toEqual({ t: 1, text: 'first line' })
    expect(claim.duration).toBe(200)
    expect((await client.done({ qid: 1, outcome: 'done' })).ok).toBe(true)
    expect((await client.done({ qid: 1, outcome: 'done' })).code).toBe('nothing_playing')

    svc.add('Other', { requester_uid: '2' })
    expect((await client.cancel({ uid: '2' })).item?.title).toBe('Other')
    expect((await client.cancel({ uid: '2' })).ok).toBe(false)
    svc.add('Another')
    expect((await client.cancel({ position: 1 })).ok).toBe(true)
    svc.add('Removable')
    expect((await client.remove(svc.items[0]!.qid)).ok).toBe(true)
    expect((await client.skip()).code).toBe('nothing_playing')
    svc.halted = { reason: 'code=-460' }
    expect((await client.queue()).source.halted?.reason).toBe('code=-460')
    expect(await client.resumeSource()).toEqual({ ok: true })
    expect(svc.callsTo('/abandon')).toEqual([])
    expect(await client.abandon('r-9')).toEqual({ ok: true, removed: false })
  })

  it('leaves out what it was not given', async () => {
    const { svc, client } = await fake()
    svc.ready('x')
    await client.claim('c')
    await client.done({ outcome: 'stopped' })
    await client.cancel({ uid: '5' })
    const bodies = [svc.callsTo('/done')[0]!.body, svc.callsTo('/cancel')[0]!.body]
    expect(bodies[0]).toEqual({ outcome: 'stopped' })
    expect(bodies[1]).toEqual({ requester_uid: '5' })
  })

  describe('trouble', () => {
    it('no URL is "not running", asked afresh at every call', async () => {
      let url: string | null = null
      const svc = await FakeSongService.start('C:/x')
      closers.push(() => svc.close())
      const client = new SongServiceClient({ baseUrl: () => url, callTimeoutMs: 500 })
      const e = await error(client.queue())
      expect(e).toBeInstanceOf(SongServiceError)
      expect(e).toMatchObject({
        kind: 'unreachable',
        message: 'the singing service is not running',
      })
      url = svc.url
      expect((await client.queue()).items).toEqual([])
    })

    it('a refused connection is unreachable', async () => {
      const svc = await FakeSongService.start('C:/x')
      const url = svc.url
      await svc.close()
      const e = await error(
        new SongServiceClient({ baseUrl: () => url, callTimeoutMs: 500 }).queue()
      )
      expect(e.kind).toBe('unreachable')
    })

    it('an answer that does not come is a timeout, and the connection is not left waiting', async () => {
      const { svc, client } = await fake()
      svc.answer('/queue', 'hang')
      const t0 = Date.now()
      const e = await error(client.queue())
      expect(e.kind).toBe('timeout')
      expect(Date.now() - t0).toBeLessThan(3000)
    })

    it("a request may take longer than the other calls: the caller's wait plus the slack", async () => {
      const { svc, client } = await fake()
      svc.delayMs = 1200 // longer than the 0.8 s of an ordinary call
      const ok = await client.request({
        requestId: 'r',
        keyword: 'x',
        uid: '1',
        name: 'a',
        waitSec: 2,
        slackSec: 1,
      })
      expect(ok.status).toBe('queued')
      svc.answer('/request', 'hang')
      const e = await error(
        client.request({
          requestId: 'r2',
          keyword: 'y',
          uid: '1',
          name: 'a',
          waitSec: 0.3,
          slackSec: 0.3,
        })
      )
      expect(e.kind).toBe('timeout')
    })

    it('a connection that is dropped is unreachable', async () => {
      const { svc, client } = await fake()
      svc.answer('/queue', 'drop')
      expect((await error(client.queue())).kind).toBe('unreachable')
    })

    it("an error answer carries the service's own code, words and advice", async () => {
      const { client } = await fake()
      const e = await error(
        client.request({
          requestId: 'r',
          keyword: 'boom',
          uid: '1',
          name: 'a',
          waitSec: 5,
          slackSec: 1,
        })
      )
      expect(e).toMatchObject({
        kind: 'http',
        status: 503,
        code: 'source_down',
        message: '连不上歌曲来源，稍后再点',
        retryable: true,
      })
    })

    it('an error status without the documented body is garbage, an unparseable success is garbage', async () => {
      expect(
        await error((await odd(() => ({ status: 500, text: '<html>oops</html>' }))).queue())
      ).toMatchObject({
        kind: 'garbage',
        status: 500,
      })
      expect(
        await error((await odd(() => ({ status: 500, text: '{"nope": 1}' }))).queue())
      ).toMatchObject({
        kind: 'garbage',
        status: 500,
      })
      expect(
        (await error((await odd(() => ({ status: 200, text: 'not json' }))).queue())).kind
      ).toBe('garbage')
    })

    it('a success whose shape is wrong says which field', async () => {
      const client = await odd(() => ({
        status: 200,
        text: '{"current":null,"items":[{"qid":"x"}]}',
      }))
      const e = await error(client.queue())
      expect(e.kind).toBe('garbage')
      expect(e.message).toContain('items.0.qid')
    })

    it('fields the service adds later are ignored', async () => {
      const client = await odd(() => ({
        status: 200,
        text: JSON.stringify({
          current: null,
          items: [],
          failed: [],
          worker: { state: 'idle', extra: 1 },
          source: { kind: 'local', files: 3 },
          songs_dir: 'C:/x',
          limits: { max_per_user: 1, max_len: 5, future: true },
          something_new: true,
        }),
      }))
      expect((await client.queue()).source.kind).toBe('local')
    })

    it('a caller that gives up (its signal) is told it was cancelled, not that the service is slow', async () => {
      const { svc, client } = await fake()
      svc.answer('/claim', 'hang')
      const ctl = new AbortController()
      const pending = error(client.claim('c', ctl.signal))
      setTimeout(() => ctl.abort(), 50)
      const e = await pending
      expect(e.kind).toBe('unreachable')
      expect(e.message).toBe('the call was cancelled')
    })
  })
})
