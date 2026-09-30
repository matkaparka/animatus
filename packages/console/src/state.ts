/**
 * What the console knows about the orchestrator, and how each thing it hears changes that. A pure reducer,
 * so the rules (what is kept, what is merged, what is capped) are testable without a page.
 */
import type {
  Alarm,
  ConsoleEvent,
  ModeView,
  PluginView,
  RunEvent,
  SpeechTraceView,
  StatusView,
} from '@animatus/protocol'

export const EVENTS_KEPT = 500
export const TRACES_KEPT = 100
export const ALARMS_KEPT = 50

export interface ConsoleState {
  status: StatusView | null
  /** Oldest first. */
  events: RunEvent[]
  /** Oldest first; a trace is updated in place as its sentence progresses. */
  traces: SpeechTraceView[]
  /** Newest first. */
  alarms: Alarm[]
  /** How many times the server said the approval list changed: a page that shows it reads it again when this moves. */
  approvalsSeen: number
}

export const initialState: ConsoleState = {
  status: null,
  events: [],
  traces: [],
  alarms: [],
  approvalsSeen: 0,
}

export type Action =
  | { type: 'event'; event: ConsoleEvent }
  | { type: 'status'; status: StatusView }
  | { type: 'plugins'; plugins: PluginView[] }
  | { type: 'plugin'; plugin: PluginView }
  | { type: 'modes'; modes: ModeView[] }
  | { type: 'mode'; mode: ModeView }
  | { type: 'history'; events: RunEvent[]; traces: SpeechTraceView[] }
  /** How many tool calls wait for the streamer's yes, as the approvals page has just read it. */
  | { type: 'approvals'; pending: number }

const eventKey = (e: RunEvent): string => `${e.ts}|${e.kind}|${e.text}`

/** Newest alarms first, one per id (a later copy wins), at most `ALARMS_KEPT`. */
export function mergeAlarms(current: readonly Alarm[], incoming: readonly Alarm[]): Alarm[] {
  const byId = new Map<string, Alarm>()
  for (const alarm of current) byId.set(alarm.id, alarm)
  for (const alarm of incoming) byId.set(alarm.id, alarm)
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, ALARMS_KEPT)
}

/** Appends to a bounded list, dropping the oldest. */
function capped<T>(list: readonly T[], item: T, max: number): T[] {
  const next = [...list, item]
  return next.length > max ? next.slice(next.length - max) : next
}

/** Replaces the entry with the same id, or appends. */
function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id)
  if (index === -1) return [...list, item]
  const next = [...list]
  next[index] = item
  return next
}

function withStatus(state: ConsoleState, change: (status: StatusView) => StatusView): ConsoleState {
  return state.status ? { ...state, status: change(state.status) } : state
}

export function reducer(state: ConsoleState, action: Action): ConsoleState {
  switch (action.type) {
    case 'status':
      return {
        ...state,
        status: action.status,
        alarms: mergeAlarms(state.alarms, action.status.alarms),
      }
    case 'plugins':
      return withStatus(state, (s) => ({ ...s, plugins: action.plugins }))
    case 'plugin':
      return withStatus(state, (s) => ({ ...s, plugins: upsertById(s.plugins, action.plugin) }))
    case 'modes':
      return withStatus(state, (s) => ({ ...s, modes: action.modes }))
    case 'mode':
      return withStatus(state, (s) => ({ ...s, modes: upsertById(s.modes, action.mode) }))
    case 'approvals':
      // the page reads the list every so often: the same number again must not redraw everything
      if (!state.status || state.status.approvals_pending === action.pending) return state
      return { ...state, status: { ...state.status, approvals_pending: action.pending } }
    case 'history': {
      // What arrived over the socket while the history was loading is newer and must survive.
      const seen = new Set(state.events.map(eventKey))
      const older = action.events.filter((e) => !seen.has(eventKey(e)))
      const events = [...older, ...state.events].slice(-EVENTS_KEPT)
      const known = new Set(state.traces.map((t) => t.id))
      const traces = [...action.traces.filter((t) => !known.has(t.id)), ...state.traces].slice(
        -TRACES_KEPT
      )
      return { ...state, events, traces }
    }
    case 'event':
      return applyEvent(state, action.event)
  }
}

function applyEvent(state: ConsoleState, event: ConsoleEvent): ConsoleState {
  switch (event.type) {
    case 'hello':
      return state
    case 'status':
      return reducer(state, { type: 'status', status: event.status })
    case 'run':
      return { ...state, events: capped(state.events, event.event, EVENTS_KEPT) }
    case 'trace': {
      const index = state.traces.findIndex((t) => t.id === event.trace.id)
      if (index === -1) return { ...state, traces: capped(state.traces, event.trace, TRACES_KEPT) }
      const traces = [...state.traces]
      traces[index] = event.trace
      return { ...state, traces }
    }
    case 'alarm':
      return { ...state, alarms: mergeAlarms(state.alarms, [event.alarm]) }
    case 'plugin':
      return reducer(state, { type: 'plugin', plugin: event.plugin })
    case 'mode':
      return reducer(state, { type: 'mode', mode: event.mode })
    case 'approvals':
      return {
        ...withStatus(state, (s) => ({ ...s, approvals_pending: event.pending })),
        approvalsSeen: state.approvalsSeen + 1,
      }
  }
}
