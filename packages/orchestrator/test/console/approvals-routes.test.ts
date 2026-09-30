import { afterEach, describe, expect, it } from 'vitest'
import {
  ApprovalView,
  ApprovalsResponse,
  ConsoleEvent,
  StatusView,
  makeSource,
} from '@animatus/protocol'
import { AppBackend } from '../../src/console/appBackend.ts'
import { installCleanup, rig } from '../app/rig.ts'
import { TestSocket, createCleanup, errorCode, startConsole } from './support.ts'

const cleanup = createCleanup()
installCleanup()
afterEach(() => cleanup.run())

const start = () => startConsole(cleanup)
const list = async (run: Awaited<ReturnType<typeof start>>) =>
  ApprovalsResponse.parse((await run.call('GET', '/api/approvals')).json())

const WRONG = ['not', 'the', 'server', 'token'].join('-')
const FIRST = 'ap-0000000000a1'
const SECOND = 'ap-0000000000a2'

describe('the approval routes', () => {
  it('list what waits and the last decisions in the shape the contract says, and the status counts what waits', async () => {
    const run = await start()
    const res = await run.call('GET', '/api/approvals')
    expect(res.status).toBe(200)
    const body = ApprovalsResponse.parse(res.json())
    expect(body.pending.map((p) => [p.id, p.tool, p.origin.kind, p.origin.trust])).toEqual([
      [FIRST, 'enter_mode', 'moderator', 'trusted'],
      [SECOND, 'remember', 'host', 'privileged'],
    ])
    expect(body.recent).toEqual([])
    const status = StatusView.parse((await run.call('GET', '/api/status')).json())
    expect(status.approvals_pending).toBe(2)
  })

  it('need the token: a refused call never reaches the backend', async () => {
    const run = await start()
    for (const [method, path] of [
      ['GET', '/api/approvals'],
      ['POST', `/api/approvals/${FIRST}/approve`],
      ['POST', `/api/approvals/${FIRST}/deny`],
    ] as const) {
      expect((await run.call(method, path, { token: null })).status, `${method} ${path}`).toBe(401)
      expect((await run.call(method, path, { token: WRONG })).status).toBe(401)
    }
    expect(run.backend.audit.filter((a) => a.op.startsWith('approvals'))).toEqual([])
    expect(run.backend.approvals.list()).toMatchObject({ pending: [{ id: FIRST }, { id: SECOND }] })
  })

  it('a page from another origin, or another host name, cannot decide anything', async () => {
    const run = await start()
    const foreign = await run.call('POST', `/api/approvals/${FIRST}/approve`, {
      origin: 'http://evil.example',
    })
    expect([403, 401]).toContain(foreign.status)
    const rebound = await run.call('POST', `/api/approvals/${FIRST}/approve`, {
      host: 'evil.example',
    })
    expect([403, 421, 400]).toContain(rebound.status)
    expect((await list(run)).pending).toHaveLength(2)
  })

  it('approve decides once: the second answer says it was already decided, and the first one is on the recent list', async () => {
    const run = await start()
    const res = await run.call('POST', `/api/approvals/${FIRST}/approve`)
    expect(res.status).toBe(200)
    expect(ApprovalView.parse(res.json())).toMatchObject({ id: FIRST, status: 'approved' })
    const again = await run.call('POST', `/api/approvals/${FIRST}/approve`)
    expect([again.status, errorCode(again)]).toEqual([409, 'approval_not_pending'])
    const flip = await run.call('POST', `/api/approvals/${FIRST}/deny`)
    expect([flip.status, errorCode(flip)]).toEqual([409, 'approval_not_pending'])
    const after = await list(run)
    expect(after.pending.map((p) => p.id)).toEqual([SECOND])
    expect(after.recent.map((p) => [p.id, p.status])).toEqual([[FIRST, 'approved']])
  })

  it('deny drops it', async () => {
    const run = await start()
    const res = await run.call('POST', `/api/approvals/${SECOND}/deny`)
    expect(ApprovalView.parse(res.json())).toMatchObject({ id: SECOND, status: 'denied' })
    expect((await list(run)).recent.map((p) => p.status)).toEqual(['denied'])
  })

  it('an id nobody made is not found; one that is not an id at all is refused before the backend is asked', async () => {
    const run = await start()
    const missing = await run.call('POST', '/api/approvals/ap-ffffffffffff/approve')
    expect([missing.status, errorCode(missing)]).toEqual([404, 'approval_not_found'])
    for (const id of [
      'nope',
      'AP-0000000000A1',
      'ap-000000000a1',
      'ap-0000000000a1x',
      'ap-0000000000g1',
      '%2e%2e',
    ]) {
      const res = await run.call('POST', `/api/approvals/${id}/approve`)
      expect(res.status, id).toBeGreaterThanOrEqual(400)
      expect(res.status, id).toBeLessThan(500)
    }
    expect(run.backend.audit.filter((a) => a.op === 'approvals.approve')).toEqual([
      { op: 'approvals.approve', target: 'ap-ffffffffffff' },
    ])
  })

  it('only the methods that make sense: the list is a GET, a decision is a POST', async () => {
    const run = await start()
    expect((await run.call('POST', '/api/approvals')).status).toBe(405)
    expect((await run.call('GET', `/api/approvals/${FIRST}/approve`)).status).toBe(405)
    expect((await run.call('PUT', `/api/approvals/${FIRST}/approve`)).status).toBe(405)
    expect((await run.call('DELETE', `/api/approvals/${FIRST}`)).status).toBe(404)
    expect((await list(run)).pending).toHaveLength(2)
  })

  it('a decision is pushed to every open console as an approvals event, with how many still wait', async () => {
    const run = await start()
    run.backend.onEvent((e) => run.server.publish(e))
    const socket = await TestSocket.connect(run)
    cleanup.add(() => socket.close())
    await socket.waitForType('status')
    await run.call('POST', `/api/approvals/${FIRST}/approve`)
    const event = await socket.waitForType('approvals')
    expect(ConsoleEvent.parse(event)).toEqual({ type: 'approvals', pending: 1 })
  })
})

describe('over the real program', () => {
  const open = async () => {
    const r = await rig({ config: { memory: { enabled: true } } })
    const run = await startConsole(cleanup, { backend: new AppBackend(r.app) as never })
    return { r, run }
  }

  it('a call the gate queued is listed with the tool’s own summary, and approving it through the route runs it once', async () => {
    const { r, run } = await open()
    const queued = await r.app.tools.request({
      tool: 'remember',
      args: { text: 'the mascot is a red panda' },
      origin: makeSource('moderator', { name: 'mia', uid: '9' }),
    })
    expect(queued.status).toBe('queued')
    const before = await list(run)
    expect(before.pending).toHaveLength(1)
    expect(before.pending[0]).toMatchObject({
      tool: 'remember',
      summary: 'Remember: the mascot is a red panda',
      args: { text: 'the mascot is a red panda' },
      origin: { kind: 'moderator', trust: 'trusted', name: 'mia' },
      status: 'pending',
    })
    expect(await r.app.memory!.store.read('world/agent-notes.md')).toBeNull()

    const id = before.pending[0]!.id
    const res = await run.call('POST', `/api/approvals/${id}/approve`)
    expect(res.status).toBe(200)
    expect(ApprovalView.parse(res.json())).toMatchObject({ status: 'approved', result: 'written' })
    const file = await r.app.memory!.store.read('world/agent-notes.md')
    expect(file?.content).toMatch(/\[agent] \d{4}-\d\d-\d\d the mascot is a red panda/)
    const again = await run.call('POST', `/api/approvals/${id}/approve`)
    expect([again.status, errorCode(again)]).toEqual([409, 'approval_not_pending'])
    expect(
      (await r.app.memory!.store.read('world/agent-notes.md'))?.content.match(/red panda/g)
    ).toHaveLength(1)
  })

  it('what the audience asks for never appears in the list, however it is asked for', async () => {
    const { r, run } = await open()
    for (const origin of [
      makeSource('viewer', { name: 'ann', uid: '5' }),
      makeSource('web'),
      makeSource('agent'),
      makeSource('plugin'),
    ])
      expect(
        (await r.app.tools.request({ tool: 'remember', args: { text: 'x' }, origin })).status
      ).toBe('rejected')
    expect(await list(run)).toEqual({ pending: [], recent: [] })
    const status = StatusView.parse((await run.call('GET', '/api/status')).json())
    expect(status.approvals_pending).toBe(0)
  })

  it('the console hears about a queued call and about its decision', async () => {
    const { r, run } = await open()
    const backend = new AppBackend(r.app)
    const seen: unknown[] = []
    const off = backend.onEvent((e) => e.type === 'approvals' && seen.push(e))
    cleanup.add(off)
    const q = await r.app.tools.request({
      tool: 'remember',
      args: { text: 'a fact' },
      origin: makeSource('host'),
    })
    if (q.status !== 'queued') throw new Error('not queued')
    await run.call('POST', `/api/approvals/${q.id}/deny`)
    expect(seen).toEqual([
      { type: 'approvals', pending: 1 },
      { type: 'approvals', pending: 0 },
    ])
  })
})
