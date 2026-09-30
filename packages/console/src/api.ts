/**
 * The console's HTTP client. Every call carries the bearer token, goes to the page's own origin only, and
 * checks the answer with the schema from `@animatus/protocol`: a body of the wrong shape is reported as
 * such instead of being rendered. Error bodies (`ApiError`) become `ApiClientError`s with the server's own
 * code and message. Request bodies are never echoed into an error, so a key being saved cannot leak
 * through a message.
 */
import type { z } from 'zod'
import {
  ApiError,
  ApprovalView,
  ApprovalsResponse,
  ConfigResponse,
  EventsResponse,
  MemoryConsolidateReport,
  MemoryFileView,
  MemoryForgetResponse,
  MemoryHashResponse,
  MemoryHistoryResponse,
  MemoryProposalsResponse,
  MemoryStatusView,
  MemoryTreeResponse,
  ModeView,
  ModesResponse,
  OkResponse,
  PluginView,
  PluginsResponse,
  SecretView,
  SecretsResponse,
  StatusView,
  TracesResponse,
} from '@animatus/protocol'
import type {
  InjectRequest,
  MemoryCommit,
  MemoryLineRequest,
  MemoryProposal,
  MemoryTreeEntry,
  MemoryWriteRequest,
  ModeAction,
  ModeRequest,
  PluginAction,
  RunEvent,
  SayRequest,
  SpeechTraceView,
} from '@animatus/protocol'

/** What went wrong, for the page to show. `status` is the HTTP status, 0 when there was no answer. */
export class ApiClientError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
  }
}

export interface Api {
  status(): Promise<StatusView>
  plugins(): Promise<PluginView[]>
  pluginAction(id: string, action: PluginAction): Promise<PluginView>
  pluginLogs(id: string, lines?: number): Promise<string[]>
  modes(): Promise<ModeView[]>
  modeAction(id: string, action: ModeAction, request?: Partial<ModeRequest>): Promise<ModeView>
  secrets(): Promise<SecretView[]>
  putSecret(name: string, value: string): Promise<SecretView>
  deleteSecret(name: string): Promise<SecretView>
  say(request: SayRequest): Promise<void>
  inject(request: InjectRequest): Promise<void>
  stopSpeech(): Promise<void>
  events(limit?: number): Promise<RunEvent[]>
  traces(limit?: number): Promise<SpeechTraceView[]>
  config(): Promise<Record<string, unknown>>

  // approvals: tool calls that wait for the streamer's yes
  approvals(): Promise<ApprovalsResponse>
  approvalDecide(id: string, action: 'approve' | 'deny'): Promise<ApprovalView>

  // memory (the routes answer `memory_off` when it is switched off, except the status)
  memoryStatus(): Promise<MemoryStatusView>
  memoryTree(): Promise<MemoryTreeEntry[]>
  memoryFile(path: string): Promise<MemoryFileView>
  memoryWrite(request: MemoryWriteRequest): Promise<string>
  memoryLine(request: MemoryLineRequest): Promise<string>
  memoryHistory(path: string | null): Promise<MemoryCommit[]>
  memoryDiff(path: string, from: string, to?: string): Promise<string>
  memoryRollback(path: string, rev: string): Promise<void>
  memoryForget(uid: number): Promise<boolean>
  memoryConsolidate(): Promise<MemoryConsolidateReport>
  memoryProposals(): Promise<MemoryProposal[]>
  memoryResolve(id: string, approve: boolean): Promise<void>
}

export interface ApiOptions {
  token: string
  /** For tests. Defaults to the global `fetch`, looked up at call time. */
  fetch?: typeof fetch
  /** Prefix for every path. Default '' (the page's own origin). */
  baseUrl?: string
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'body'}: ${issue.message}`)
    .join('; ')
}

export function createApi(options: ApiOptions): Api {
  const baseUrl = options.baseUrl ?? ''

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    const headers: Record<string, string> = { Authorization: `Bearer ${options.token}` }
    const init: RequestInit = {
      method,
      headers,
      // Only ever the console's own server, never with cookies, never followed elsewhere.
      mode: 'same-origin',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let res: Response
    try {
      res = await doFetch(`${baseUrl}${path}`, init)
    } catch {
      throw new ApiClientError('network', 'Cannot reach the orchestrator. Is it running?', 0)
    }
    if (!res.ok) throw await failure(res)
    return res
  }

  async function failure(res: Response): Promise<ApiClientError> {
    let text = ''
    try {
      text = await res.text()
    } catch {
      // fall through to the generic message
    }
    try {
      const parsed = ApiError.safeParse(JSON.parse(text))
      if (parsed.success)
        return new ApiClientError(parsed.data.error.code, parsed.data.error.message, res.status)
    } catch {
      // not JSON
    }
    return new ApiClientError(
      'bad_error_shape',
      `The orchestrator answered ${res.status} with a body the console does not understand.`,
      res.status
    )
  }

  async function json<S extends z.ZodType>(
    schema: S,
    method: string,
    path: string,
    body?: unknown
  ): Promise<z.infer<S>> {
    const res = await send(method, path, body)
    let data: unknown
    try {
      data = await res.json()
    } catch {
      throw new ApiClientError('bad_response', `The answer to ${path} is not JSON.`, res.status)
    }
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      throw new ApiClientError(
        'bad_response',
        `Unexpected answer from ${path} (${issueSummary(parsed.error)}).`,
        res.status
      )
    }
    return parsed.data as z.infer<S>
  }

  const enc = encodeURIComponent

  return {
    status: () => json(StatusView, 'GET', '/api/status'),
    async plugins() {
      return (await json(PluginsResponse, 'GET', '/api/plugins')).plugins
    },
    pluginAction: (id, action) => json(PluginView, 'POST', `/api/plugins/${enc(id)}/${action}`),
    async pluginLogs(id, lines) {
      const query = lines === undefined ? '' : `?lines=${lines}`
      const res = await send('GET', `/api/plugins/${enc(id)}/logs${query}`)
      const text = await res.text()
      return text === '' ? [] : text.replace(/\n$/, '').split('\n')
    },
    async modes() {
      return (await json(ModesResponse, 'GET', '/api/modes')).modes
    },
    modeAction: (id, action, request = {}) =>
      json(ModeView, 'POST', `/api/modes/${enc(id)}/${action}`, {
        replace: request.replace ?? false,
        force: request.force ?? false,
        // what the mode's own panel sent (which action, which row, the inputs)
        ...(request.params ? { params: request.params } : {}),
      }),
    async secrets() {
      return (await json(SecretsResponse, 'GET', '/api/secrets')).secrets
    },
    putSecret: (name, value) => json(SecretView, 'PUT', `/api/secrets/${enc(name)}`, { value }),
    deleteSecret: (name) => json(SecretView, 'DELETE', `/api/secrets/${enc(name)}`),
    async say(request) {
      await json(OkResponse, 'POST', '/api/say', request)
    },
    memoryStatus: () => json(MemoryStatusView, 'GET', '/api/memory'),
    async memoryTree() {
      return (await json(MemoryTreeResponse, 'GET', '/api/memory/tree')).files
    },
    memoryFile: (path) => json(MemoryFileView, 'GET', `/api/memory/file?path=${enc(path)}`),
    async memoryWrite(request) {
      return (await json(MemoryHashResponse, 'PUT', '/api/memory/file', request)).hash ?? ''
    },
    async memoryLine(request) {
      return (await json(MemoryHashResponse, 'POST', '/api/memory/line', request)).hash ?? ''
    },
    async memoryHistory(path) {
      const q = path === null ? '' : `?path=${enc(path)}`
      return (await json(MemoryHistoryResponse, 'GET', `/api/memory/history${q}`)).commits
    },
    async memoryDiff(path, from, to) {
      const q = `?path=${enc(path)}&from=${enc(from)}${to ? `&to=${enc(to)}` : ''}`
      return await (await send('GET', `/api/memory/diff${q}`)).text()
    },
    async memoryRollback(path, rev) {
      await json(MemoryHashResponse, 'POST', '/api/memory/rollback', { path, rev })
    },
    async memoryForget(uid) {
      return (await json(MemoryForgetResponse, 'POST', '/api/memory/forget', { uid })).existed
    },
    memoryConsolidate: () => json(MemoryConsolidateReport, 'POST', '/api/memory/consolidate'),
    async memoryProposals() {
      return (await json(MemoryProposalsResponse, 'GET', '/api/memory/proposals')).proposals
    },
    async memoryResolve(id, approve) {
      await json(
        OkResponse,
        'POST',
        `/api/memory/proposals/${enc(id)}/${approve ? 'approve' : 'reject'}`
      )
    },
    async inject(request) {
      await json(OkResponse, 'POST', '/api/inject', request)
    },
    async stopSpeech() {
      await json(OkResponse, 'POST', '/api/stop')
    },
    async events(limit) {
      return (
        await json(
          EventsResponse,
          'GET',
          `/api/events${limit === undefined ? '' : `?limit=${limit}`}`
        )
      ).events
    },
    async traces(limit) {
      return (
        await json(
          TracesResponse,
          'GET',
          `/api/traces${limit === undefined ? '' : `?limit=${limit}`}`
        )
      ).traces
    },
    async config() {
      return (await json(ConfigResponse, 'GET', '/api/config')).config
    },
    approvals: () => json(ApprovalsResponse, 'GET', '/api/approvals'),
    approvalDecide: (id, action) =>
      json(ApprovalView, 'POST', `/api/approvals/${enc(id)}/${action}`),
  }
}
