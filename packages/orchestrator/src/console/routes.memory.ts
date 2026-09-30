/**
 * The memory routes of the console API (see `@animatus/protocol` memory.ts). They are a separate table because
 * memory is optional: a backend without `memory` answers every one of them with `memory_off`, except the status,
 * which says so plainly.
 */
import {
  MemoryFileView,
  MemoryForgetRequest,
  MemoryForgetResponse,
  MemoryHashResponse,
  MemoryHistoryResponse,
  MemoryLineRequest,
  MemoryLineWire,
  MemoryConsolidateReport,
  MemoryPath,
  MemoryProposalsResponse,
  MemoryRollbackRequest,
  MemoryStatusView,
  MemoryTreeResponse,
  MemoryWriteRequest,
  OkResponse,
} from '@animatus/protocol'
import type { z } from 'zod'
import { ApiFailure } from './backend.ts'
import type { ConsoleBackend, MemoryBackend } from './backend.ts'
import { BackendContractError } from './routes.ts'
import type { Route, RouteResult } from './routes.ts'
import { describeIssues } from './http.ts'

const json = (body: unknown): RouteResult => ({ kind: 'json', body })

function checked<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new BackendContractError(what, result.error)
  return result.data as z.infer<S>
}

function memory(backend: ConsoleBackend): MemoryBackend {
  if (!backend.memory)
    throw new ApiFailure(
      'memory_off',
      'memory is switched off (memory.enabled in the configuration)',
      409
    )
  return backend.memory
}

function pathQuery(query: URLSearchParams, name = 'path'): string {
  const parsed = MemoryPath.safeParse(query.get(name))
  if (!parsed.success)
    throw new ApiFailure('invalid_query', `${name} must be a path inside the memory folder`, 400)
  return parsed.data
}

const REV = /^[0-9a-f]{7,40}$/
function revQuery(query: URLSearchParams, name: string, required: boolean): string | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') {
    if (required) throw new ApiFailure('invalid_query', `${name} must be a commit hash`, 400)
    return undefined
  }
  if (!REV.test(raw)) throw new ApiFailure('invalid_query', `${name} must be a commit hash`, 400)
  return raw
}

const HISTORY_DEFAULT = 50
const HISTORY_MAX = 200

export const MEMORY_ROUTES: readonly Route[] = [
  {
    method: 'GET',
    pattern: '/api/memory',
    async handle(_req, backend) {
      if (!backend.memory) return json({ enabled: false })
      return json(checked(MemoryStatusView, await backend.memory.status(), 'memory.status'))
    },
  },
  {
    method: 'GET',
    pattern: '/api/memory/tree',
    async handle(_req, backend) {
      return json(
        checked(MemoryTreeResponse, { files: await memory(backend).tree() }, 'memory.tree')
      )
    },
  },
  {
    method: 'GET',
    pattern: '/api/memory/file',
    async handle({ query }, backend) {
      return json(
        checked(MemoryFileView, await memory(backend).readFile(pathQuery(query)), 'memory.readFile')
      )
    },
  },
  {
    method: 'PUT',
    pattern: '/api/memory/file',
    body: { schema: MemoryWriteRequest, optional: false },
    async handle({ body }, backend) {
      const r = await memory(backend).writeFile(body as z.infer<typeof MemoryWriteRequest>)
      return json(checked(MemoryHashResponse, r, 'memory.writeFile'))
    },
  },
  {
    method: 'POST',
    pattern: '/api/memory/line',
    body: { schema: MemoryLineWire, optional: false },
    async handle({ body }, backend) {
      // the flat wire shape was checked; now the rules of the operation it names
      const op = MemoryLineRequest.safeParse(body)
      if (!op.success) throw new ApiFailure('invalid_request', describeIssues(op.error), 400)
      const r = await memory(backend).line(op.data)
      return json(checked(MemoryHashResponse, r, 'memory.line'))
    },
  },
  {
    method: 'GET',
    pattern: '/api/memory/history',
    async handle({ query }, backend) {
      const raw = query.get('path')
      const path = raw === null || raw === '' ? null : pathQuery(query)
      const limitRaw = query.get('limit')
      let limit = HISTORY_DEFAULT
      if (limitRaw !== null && limitRaw !== '') {
        if (!/^\d{1,4}$/.test(limitRaw))
          throw new ApiFailure('invalid_query', 'limit must be a whole number', 400)
        limit = Math.min(HISTORY_MAX, Math.max(1, Number(limitRaw)))
      }
      const commits = await memory(backend).history(path, limit)
      return json(checked(MemoryHistoryResponse, { commits }, 'memory.history'))
    },
  },
  {
    method: 'GET',
    pattern: '/api/memory/diff',
    async handle({ query }, backend) {
      const path = pathQuery(query)
      const from = revQuery(query, 'from', true) as string
      const to = revQuery(query, 'to', false)
      const text = await memory(backend).diff(path, from, to)
      if (typeof text !== 'string')
        throw new BackendContractError('memory.diff', new Error('not text') as never)
      return { kind: 'text', body: text }
    },
  },
  {
    method: 'POST',
    pattern: '/api/memory/rollback',
    body: { schema: MemoryRollbackRequest, optional: false },
    async handle({ body }, backend) {
      const b = body as z.infer<typeof MemoryRollbackRequest>
      return json(
        checked(
          MemoryHashResponse,
          await memory(backend).rollback(b.path, b.rev),
          'memory.rollback'
        )
      )
    },
  },
  {
    method: 'POST',
    pattern: '/api/memory/forget',
    body: { schema: MemoryForgetRequest, optional: false },
    async handle({ body }, backend) {
      const r = await memory(backend).forget((body as z.infer<typeof MemoryForgetRequest>).uid)
      return json(checked(MemoryForgetResponse, r, 'memory.forget'))
    },
  },
  {
    method: 'POST',
    pattern: '/api/memory/consolidate',
    async handle(_req, backend) {
      return json(
        checked(MemoryConsolidateReport, await memory(backend).consolidate(), 'memory.consolidate')
      )
    },
  },
  {
    method: 'GET',
    pattern: '/api/memory/proposals',
    async handle(_req, backend) {
      const proposals = await memory(backend).proposals()
      return json(checked(MemoryProposalsResponse, { proposals }, 'memory.proposals'))
    },
  },
  ...(['approve', 'reject'] as const).map((action): Route => ({
    method: 'POST',
    pattern: `/api/memory/proposals/:id/${action}`,
    async handle({ params }, backend) {
      const id = params.id ?? ''
      if (!/^[0-9]{6,20}-[0-9a-f]{6}$/.test(id))
        throw new ApiFailure('invalid_id', 'not a valid proposal id', 400)
      await memory(backend).resolveProposal(id, action === 'approve')
      return json(OkResponse.parse({ ok: true }))
    },
  })),
]

export { describeIssues }
