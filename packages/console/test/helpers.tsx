/** Shared test helpers: sample data, a stand-in for the HTTP client, a stand-in for a WebSocket. */
import { afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { cleanup } from '@testing-library/react'
import { ModeView, PluginView, StatusView } from '@animatus/protocol'
import type { Alarm, SecretView } from '@animatus/protocol'
import type { Api } from '../src/api.ts'
import type { SocketLike } from '../src/live.ts'

// The test runner has no globals, so Testing Library cannot register its own clean-up.
afterEach(() => {
  cleanup()
})

/** A value that must never be rendered, stored in state or put in an error message. */
export const SECRET_VALUE = 'test-secret-123'

export const TOKEN = ['unit', 'test', 'token', '0123456789abcdef'].join('-')

// ───────────────────────────── sample data ─────────────────────────────

export const plugin = (over: Record<string, unknown> = {}): PluginView =>
  PluginView.parse({
    id: 'speech',
    title: 'Speech synthesis',
    kind: 'tts',
    service: 'tts',
    enabled: true,
    status: 'ready',
    ...over,
  })

export const mode = (over: Record<string, unknown> = {}): ModeView =>
  ModeView.parse({
    id: 'dance',
    title: 'Dance',
    state: 'IDLE',
    since: 1_000,
    priority: 50,
    exclusive_with: [],
    services: ['tts'],
    ...over,
  })

export const verdict = (
  ok: boolean,
  reasons: string[] = [],
  over: Record<string, unknown> = {}
) => ({
  ok,
  totalMb: 3400,
  budgetMb: 8000,
  measured: true,
  reasons,
  ...over,
})

export const status = (over: Record<string, unknown> = {}): StatusView =>
  StatusView.parse({
    api: 1,
    version: '0.1.0',
    startedAt: 1_000,
    now: 1_000_000,
    stage: {
      connected: true,
      model: { status: 'ready' },
      audio: { state: 'running', contexts_created: 1, contexts_open: 1 },
      fps: 60,
      underruns_total: 2,
      tpose_frames: 0,
      lastReportAt: 999_000,
    },
    speech: { speaking: false, pending: 0, held: false },
    plugins: [],
    modes: [],
    llm: { providers: [], order: [] },
    alarms: [],
    ...over,
  })

export const alarm = (over: Partial<Alarm> = {}): Alarm => ({
  id: 'a1',
  ts: 1_000,
  level: 'warn',
  code: 'demo',
  message: 'something',
  ...over,
})

// ───────────────────────────── a stand-in for the API ─────────────────────────────

export type MockedApi = { [K in keyof Api]: Mock<Api[K]> }

/** Every method is a spy that answers with something valid; pass overrides for what a test cares about. */
export function fakeApi(over: Partial<Api> = {}): MockedApi {
  const api: Api = {
    status: async () => status(),
    plugins: async () => [],
    pluginAction: async (id, action) =>
      plugin({ id, status: action === 'stop' ? 'stopped' : 'ready' }),
    pluginLogs: async () => [],
    modes: async () => [],
    modeAction: async (id, action) => mode({ id, state: action === 'enter' ? 'ACTIVE' : 'IDLE' }),
    secrets: async () => [],
    putSecret: async (name): Promise<SecretView> => ({ name, set: true, source: 'dpapi' }),
    deleteSecret: async (name): Promise<SecretView> => ({ name, set: false, source: 'dpapi' }),
    say: async () => undefined,
    inject: async () => undefined,
    stopSpeech: async () => undefined,
    events: async () => [],
    traces: async () => [],
    config: async () => ({}),
    memoryStatus: async () => ({ enabled: false }),
    memoryTree: async () => [],
    memoryFile: async (path) => ({ path, hash: 'h'.repeat(40), lines: [], versioned: true }),
    memoryWrite: async () => 'h'.repeat(40),
    memoryLine: async () => 'h'.repeat(40),
    memoryHistory: async () => [],
    memoryDiff: async () => '',
    memoryRollback: async () => undefined,
    memoryForget: async () => true,
    memoryConsolidate: async () => ({
      files: 0,
      events: 0,
      viewersSeen: 0,
      viewersAsked: 0,
      factsAdded: 0,
      dropped: 0,
      streamNotes: 0,
      expired: 0,
      failures: [],
    }),
    memoryProposals: async () => [],
    memoryResolve: async () => undefined,
    ...over,
  }
  return Object.fromEntries(
    Object.entries(api).map(([name, fn]) => [name, vi.fn(fn as never)])
  ) as unknown as MockedApi
}

// ───────────────────────────── a stand-in for a WebSocket ─────────────────────────────

export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = []
  static reset(): void {
    FakeSocket.instances = []
  }
  static latest(): FakeSocket {
    const last = FakeSocket.instances[FakeSocket.instances.length - 1]
    if (!last) throw new Error('no socket was created')
    return last
  }

  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  closedWith: number | undefined
  closeCalls = 0

  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    FakeSocket.instances.push(this)
  }

  /** The server accepted the connection. */
  open(): void {
    this.onopen?.({})
  }
  /** The server sent an event. */
  message(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  }
  /** The connection went away, or never came up. */
  drop(code = 1006): void {
    this.onclose?.({ code })
  }
  close(code?: number): void {
    this.closeCalls++
    this.closedWith = code
  }
}

export const fakeSocketFactory = (url: string, protocols: string[]): SocketLike =>
  new FakeSocket(url, protocols)

export const hello = { type: 'hello', api: 1, now: 1 } as const
