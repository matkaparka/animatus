/**
 * The approval routes of the console API (see `@animatus/protocol` approvals.ts): what waits for the streamer's yes,
 * and the two answers. They are here and nowhere else: the stage has no way to send a command, and text from the
 * audience can never put a call in the list.
 */
import { ApprovalView, ApprovalsResponse } from '@animatus/protocol'
import type { z } from 'zod'
import { ApiFailure } from './backend.ts'
import { BackendContractError } from './routes.ts'
import type { Route, RouteResult } from './routes.ts'

const json = (body: unknown): RouteResult => ({ kind: 'json', body })

function checked<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new BackendContractError(what, result.error)
  return result.data as z.infer<S>
}

/** What `ToolGate` makes: `ap-` and twelve hex digits. Anything else is refused before the backend is asked. */
const APPROVAL_ID = /^ap-[0-9a-f]{12}$/

export const APPROVAL_ROUTES: readonly Route[] = [
  {
    method: 'GET',
    pattern: '/api/approvals',
    async handle(_req, backend) {
      const list = backend.approvals ? await backend.approvals.list() : { pending: [], recent: [] }
      return json(checked(ApprovalsResponse, list, 'approvals'))
    },
  },
  ...(['approve', 'deny'] as const).map((action): Route => ({
    method: 'POST',
    pattern: `/api/approvals/:id/${action}`,
    async handle({ params }, backend) {
      const id = params.id ?? ''
      if (!APPROVAL_ID.test(id)) throw new ApiFailure('invalid_id', 'not a valid request id', 400)
      if (!backend.approvals)
        throw new ApiFailure('approvals_off', 'there is nothing to decide', 409)
      return json(
        checked(ApprovalView, await backend.approvals.decide(id, action), 'approvals.decide')
      )
    },
  })),
]
