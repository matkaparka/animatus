import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalView } from '@animatus/protocol'
import type { Api } from './api.ts'
import { Notice, Pill, useAction } from './components.tsx'
import type { Tone } from './components.tsx'
import { formatAgo, formatTime } from './format.ts'

export interface ApprovalsProps {
  api: Api
  /** Moves whenever the server says the list changed: the page reads it again. */
  changes: number
  /** Called with how many are waiting, after this page read or changed the list. */
  onCount(pending: number): void
}

const REFRESH_MS = 30_000

const whoOf = (o: ApprovalView['origin']): string => (o.name ? `${o.kind} ${o.name}` : o.kind)

const statusTone = (status: ApprovalView['status']): Tone =>
  status === 'approved'
    ? 'ok'
    : status === 'denied'
      ? 'idle'
      : status === 'expired'
        ? 'warn'
        : 'info'

function inTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`
}

/**
 * Tool calls the character asked for that change something. Nothing on this page runs until you say yes, and this is the
 * only place that can say it. What the audience wrote never gets here: such a request is refused before it is listed.
 */
export function Approvals({ api, changes, onCount }: ApprovalsProps) {
  const [pending, setPending] = useState<ApprovalView[]>([])
  const [recent, setRecent] = useState<ApprovalView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [done, setDone] = useState<string | null>(null)
  const { run: runLoad, error: loadError } = useAction()
  const { run: runDecide, busy, error: decideError } = useAction()
  const countRef = useRef(onCount)
  countRef.current = onCount

  const refresh = useCallback(async () => {
    const r = await runLoad(() => api.approvals())
    if (!r) return
    setPending(r.pending)
    setRecent(r.recent)
    setLoaded(true)
    setNow(Date.now())
    countRef.current(r.pending.length)
  }, [api, runLoad])

  useEffect(() => {
    void refresh()
  }, [refresh, changes])

  useEffect(() => {
    // the countdowns, and a read now and then in case the live connection missed something
    const tick = setInterval(() => setNow(Date.now()), 5000)
    const poll = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [refresh])

  const decide = async (p: ApprovalView, action: 'approve' | 'deny') => {
    setDone(null)
    const view = await runDecide(() => api.approvalDecide(p.id, action))
    // whatever happened (it may have expired meanwhile), the list shows what is true now
    await refresh()
    if (view)
      setDone(
        `${action === 'approve' ? 'Approved' : 'Denied'}: ${view.summary}${view.result ? ` (${view.result})` : ''}`
      )
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Approvals</h2>
      </div>
      <p className="muted small">
        Things the character asked to do that change something. Nothing here runs until you say yes,
        and only this page can say it. What the audience writes never gets into this list: a request
        that comes from it is refused before it is listed.
      </p>
      {loadError ? <Notice kind="error">{loadError}</Notice> : null}
      {decideError ? <Notice kind="error">{decideError}</Notice> : null}
      {done ? <Notice kind="ok">{done}</Notice> : null}

      <section className="card" aria-label="Waiting for your yes">
        <h3 className="card-title">Waiting for your yes</h3>
        {pending.length === 0 ? (
          <p className="muted">{loaded ? 'Nothing is waiting.' : 'Loading…'}</p>
        ) : (
          <ul className="plain approvals">
            {pending.map((p) => (
              <li key={p.id} className="approval">
                <p>
                  <strong>{p.summary}</strong>
                </p>
                <p className="muted small">
                  {p.tool} · asked by {whoOf(p.origin)}{' '}
                  <Pill tone={p.origin.trust === 'privileged' ? 'ok' : 'info'}>
                    {p.origin.trust}
                  </Pill>{' '}
                  · {formatAgo(p.requested_at, now)} · waits {inTime(p.expires_at - now)} more
                </p>
                <pre className="approval-args">{JSON.stringify(p.args, null, 2)}</pre>
                <div className="row buttons">
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Approve: ${p.summary}`}
                    onClick={() => void decide(p, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Deny: ${p.summary}`}
                    onClick={() => void decide(p, 'deny')}
                  >
                    Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {recent.length > 0 ? (
        <section className="card" aria-label="Decided">
          <h3 className="card-title">Decided</h3>
          <ul className="plain approvals">
            {recent.map((p) => (
              <li key={p.id} className="approval approval-done">
                <p className="small">
                  <span className="muted">{formatTime(p.decided_at ?? p.requested_at)}</span>{' '}
                  <Pill tone={statusTone(p.status)}>{p.status}</Pill> <strong>{p.summary}</strong>{' '}
                  <span className="muted">
                    · asked by {whoOf(p.origin)}
                    {p.result ? ` · ${p.result}` : ''}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
