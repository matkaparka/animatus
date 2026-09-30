import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiClientError, createApi } from './api.ts'
import type { Api } from './api.ts'
import { Approvals } from './Approvals.tsx'
import { Pill } from './components.tsx'
import { Keys } from './Keys.tsx'
import { Memory } from './Memory.tsx'
import { createLive } from './live.ts'
import type { Live, LiveOptions } from './live.ts'
import { Modes } from './Modes.tsx'
import { Plugins } from './Plugins.tsx'
import { Run } from './Run.tsx'
import { Settings } from './Settings.tsx'
import { initialState, reducer } from './state.ts'

type TabId = 'run' | 'plugins' | 'modes' | 'approvals' | 'memory' | 'settings' | 'keys'

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'run', label: 'Run' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'modes', label: 'Modes' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'memory', label: 'Memory' },
  { id: 'settings', label: 'Settings' },
  { id: 'keys', label: 'Keys' },
]

/** `loading`: first contact. `live`: the socket is up. `offline`: it is not, and it is being retried. */
export type Connection = 'loading' | 'live' | 'offline' | 'rejected' | 'blocked'

export interface AppProps {
  /** The token from the address, or null when the page was opened without one. */
  token: string | null
  /** For tests: a stand-in for the HTTP client. */
  api?: Api
  /** For tests: a stand-in for the live connection. */
  createLive?: (options: LiveOptions) => Live
  /** Called when the server no longer accepts the token, so it can be forgotten. */
  onTokenRejected?: () => void
}

function Explainer({ children }: { children: ReactNode }) {
  return (
    <main className="explainer">
      <h1>Animatus console</h1>
      {children}
    </main>
  )
}

export function NoToken({ rejected = false }: { rejected?: boolean }) {
  return (
    <Explainer>
      {rejected ? (
        <p role="alert">
          The orchestrator did not accept this console's token. It was most likely restarted, and
          every start makes a new one.
        </p>
      ) : (
        <p>This page needs the address the orchestrator printed when it started.</p>
      )}
      <p>
        That address ends in <code>#token=</code> followed by a long code. Open the whole address in
        this browser and the console loads. If the terminal has scrolled away, restart the
        orchestrator to get a fresh one.
      </p>
      <p className="muted">
        The code sits after the <code>#</code>, the one part of an address that a browser never
        sends to a server. It is kept in this tab only and removed from the address bar as soon as
        the console has read it.
      </p>
    </Explainer>
  )
}

const connectionLabel: Record<Connection, string> = {
  loading: 'connecting',
  live: 'live',
  offline: 'offline',
  rejected: 'rejected',
  blocked: 'blocked',
}

function Console({
  token,
  api,
  createLiveFn,
  onTokenRejected,
}: {
  token: string
  api: Api
  createLiveFn: (options: LiveOptions) => Live
  onTokenRejected?: () => void
}) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [conn, setConn] = useState<Connection>('loading')
  const [tab, setTab] = useState<TabId>('run')
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set<TabId>(['run']))
  const live = useRef<Live | null>(null)
  const helloSeen = useRef(false)
  const lastProbe = useRef(0)
  const rejected = useRef(false)

  const reject = useCallback(() => {
    if (rejected.current) return
    rejected.current = true
    live.current?.close()
    setConn('rejected')
    onTokenRejected?.()
  }, [onTokenRejected])

  const classify = useCallback(
    (err: unknown) => {
      if (!(err instanceof ApiClientError)) return
      if (err.status === 401) reject()
      else if (err.status === 429) setConn((c) => (c === 'rejected' ? c : 'blocked'))
    },
    [reject]
  )

  /**
   * Reads the status, then the recent events and traces. The status goes first and alone: with a token the
   * server does not know, that is one refused request and not three (the server locks an address out after
   * ten refusals in a minute, and a person pasting a stale address should be nowhere near that).
   */
  const load = useCallback(async () => {
    try {
      dispatch({ type: 'status', status: await api.status() })
    } catch (err) {
      classify(err)
      if (err instanceof ApiClientError && err.status === 401) return
    }
    const [events, traces] = await Promise.allSettled([api.events(200), api.traces(50)])
    dispatch({
      type: 'history',
      events: events.status === 'fulfilled' ? events.value : [],
      traces: traces.status === 'fulfilled' ? traces.value : [],
    })
    for (const result of [events, traces]) if (result.status === 'rejected') classify(result.reason)
  }, [api, classify])

  useEffect(() => {
    let cancelled = false
    let connection: Live | null = null
    rejected.current = false
    helloSeen.current = false
    void (async () => {
      await load()
      // A token the server refused gets no socket either: that would be one more refused request.
      if (cancelled || rejected.current) return
      connection = createLiveFn({
        token,
        onEvent: (event) => {
          if (cancelled) return
          if (event.type === 'hello') {
            // A reconnect may have missed things: read the history again.
            if (helloSeen.current) void load()
            helloSeen.current = true
            setConn('live')
          }
          dispatch({ type: 'event', event })
        },
        onState: (liveState) => {
          if (cancelled || liveState !== 'waiting') return
          setConn((c) => (c === 'rejected' || c === 'blocked' ? c : 'offline'))
          // A socket that cannot connect might be up against a token the server no longer knows: ask once,
          // and no more than every few seconds, so a stale token costs the server one refusal and not a stream.
          const now = Date.now()
          if (now - lastProbe.current < 5000) return
          lastProbe.current = now
          api.status().then(
            (status) => {
              if (!cancelled) dispatch({ type: 'status', status })
            },
            (err: unknown) => {
              if (!cancelled) classify(err)
            }
          )
        },
      })
      live.current = connection
    })()
    return () => {
      cancelled = true
      connection?.close()
      live.current = null
    }
  }, [api, token, createLiveFn, load, classify])

  const select = (id: TabId) => {
    setTab(id)
    setVisited((set) => (set.has(id) ? set : new Set(set).add(id)))
  }

  if (conn === 'rejected') return <NoToken rejected />

  const waiting = state.status?.approvals_pending ?? 0

  const pages: Record<TabId, ReactNode> = {
    run: (
      <Run
        api={api}
        status={state.status}
        events={state.events}
        traces={state.traces}
        alarms={state.alarms}
      />
    ),
    plugins: (
      <Plugins
        api={api}
        plugins={state.status?.plugins ?? []}
        onChange={(plugin) => dispatch({ type: 'plugin', plugin })}
        onRefresh={(plugins) => dispatch({ type: 'plugins', plugins })}
      />
    ),
    modes: (
      <Modes
        api={api}
        modes={state.status?.modes ?? []}
        onChange={(mode) => dispatch({ type: 'mode', mode })}
        onRefresh={(modes) => dispatch({ type: 'modes', modes })}
        {...(state.status?.stage.url ? { assetBase: state.status.stage.url } : {})}
      />
    ),
    approvals: (
      <Approvals
        api={api}
        changes={state.approvalsSeen}
        onCount={(pending) => dispatch({ type: 'approvals', pending })}
      />
    ),
    memory: <Memory api={api} />,
    settings: <Settings api={api} />,
    keys: <Keys api={api} />,
  }

  return (
    <div className="app">
      <header className="app-head">
        <h1>Animatus console</h1>
        <div className="app-meta">
          {state.status ? <span className="muted small">v{state.status.version}</span> : null}
          <Pill
            tone={conn === 'live' ? 'ok' : conn === 'loading' ? 'info' : 'warn'}
            title="State of the live connection"
          >
            {connectionLabel[conn]}
          </Pill>
        </div>
      </header>
      <nav className="tabs" role="tablist" aria-label="Console sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className={tab === t.id ? 'tab tab-active' : 'tab'}
            onClick={() => select(t.id)}
          >
            {t.label}
            {t.id === 'approvals' && waiting > 0 ? (
              <span className="tab-count" title="Waiting for your yes">
                {waiting}
              </span>
            ) : null}
          </button>
        ))}
      </nav>
      {conn === 'offline' ? (
        <p className="banner banner-warn" role="status">
          The live connection is down and is being retried. What you see may be out of date.
        </p>
      ) : null}
      {conn === 'blocked' ? (
        <p className="banner banner-bad" role="alert">
          Too many failed attempts from this computer. The orchestrator is refusing requests for
          about a minute.
        </p>
      ) : null}
      <main>
        {TABS.map((t) =>
          visited.has(t.id) ? (
            <section
              key={t.id}
              role="tabpanel"
              id={`panel-${t.id}`}
              aria-labelledby={`tab-${t.id}`}
              hidden={tab !== t.id}
            >
              {pages[t.id]}
            </section>
          ) : null
        )}
      </main>
    </div>
  )
}

export function App({ token, api, createLive: createLiveProp, onTokenRejected }: AppProps) {
  const client = useMemo(() => api ?? (token ? createApi({ token }) : null), [api, token])
  if (!token || !client) return <NoToken />
  // Keyed by the token: a new one starts a fresh console, with nothing left over from the old one.
  return (
    <Console
      key={token}
      token={token}
      api={client}
      createLiveFn={createLiveProp ?? createLive}
      onTokenRejected={onTokenRejected}
    />
  )
}
