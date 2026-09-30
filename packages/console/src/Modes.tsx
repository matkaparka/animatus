import { useId, useState } from 'react'
import type { ModeView, VerdictView } from '@animatus/protocol'
import type { Api } from './api.ts'
import { Notice, Pill, messageOf, modeTone, useAction } from './components.tsx'
import { formatAgo } from './format.ts'
import { ModePanelView } from './ModePanel.tsx'

export interface ModesProps {
  api: Api
  modes: ModeView[]
  /** Called with the mode as it is after an action. */
  onChange(mode: ModeView): void
  /** Called with a fresh list. */
  onRefresh(modes: ModeView[]): void
  /** The stage server, where the pictures a mode shows are fetched from. */
  assetBase?: string
}

/** Why a verdict says no, as one sentence. Always something, even when the list of reasons is empty. */
export function verdictReason(verdict: VerdictView): string {
  const reason = verdict.reasons.join(' ').trim()
  return reason === '' ? 'This mode does not fit in GPU memory right now.' : reason
}

function Verdict({ id, verdict }: { id: string; verdict: VerdictView | undefined }) {
  if (!verdict) return <p className="verdict muted">Admission has not been checked.</p>
  if (!verdict.ok) {
    return (
      <p className="verdict verdict-bad" id={`why-${id}`}>
        <strong>Blocked:</strong> {verdictReason(verdict)}
      </p>
    )
  }
  return (
    <div className="verdict verdict-ok" id={`why-${id}`}>
      <p>
        <strong>Fits:</strong> about {verdict.totalMb} of {verdict.budgetMb} MiB,{' '}
        {verdict.measured ? 'measured' : 'not measured'}.
      </p>
      {verdict.reasons.length > 0 ? (
        <ul className="plain muted small">
          {verdict.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function ModeCard({
  mode,
  titles,
  replace,
  busy,
  assetBase,
  onEnter,
  onExit,
  onAct,
}: {
  mode: ModeView
  titles: Record<string, string>
  replace: boolean
  busy: boolean
  assetBase?: string
  onEnter(): void
  onExit(): void
  onAct(params: Record<string, string | number | boolean>): void
}) {
  const blocked = mode.admission !== undefined && !mode.admission.ok
  const reason = blocked && mode.admission ? verdictReason(mode.admission) : undefined
  const misfits = Object.entries(mode.pairs).filter(([, verdict]) => !verdict.ok)
  const transitional = mode.state === 'STARTING' || mode.state === 'STOPPING'
  return (
    <article className="card mode" aria-label={mode.title}>
      <header className="mode-head">
        <h3 className="card-title">{mode.title}</h3>
        <Pill tone={modeTone(mode.state)}>{mode.state}</Pill>
      </header>
      <p className="muted small">
        {mode.id} · since {formatAgo(mode.since)}
      </p>
      {mode.description ? <p>{mode.description}</p> : null}
      <dl className="facts">
        <dt>Priority</dt>
        <dd>
          {mode.priority}
          {mode.preempts ? ' (interrupts everything else)' : ''}
        </dd>
        <dt>Services</dt>
        <dd>{mode.services.length > 0 ? mode.services.join(', ') : 'none'}</dd>
        <dt>Excludes</dt>
        <dd>{mode.exclusive_with.length > 0 ? mode.exclusive_with.join(', ') : 'nothing'}</dd>
        {mode.hotkey ? (
          <>
            <dt>Shortcut</dt>
            <dd>
              <kbd>{mode.hotkey}</kbd>
            </dd>
          </>
        ) : null}
      </dl>
      <Verdict id={mode.id} verdict={mode.admission} />
      {misfits.length > 0 ? (
        <div className="misfits">
          <p className="small">
            <strong>Does not fit together with:</strong>
          </p>
          <ul className="plain small">
            {misfits.map(([other, verdict]) => (
              <li key={other}>
                <strong>{titles[other] ?? other}</strong>: {verdictReason(verdict)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="row buttons">
        {mode.state === 'ACTIVE' ? (
          <button type="button" disabled={busy} onClick={onExit}>
            Exit
          </button>
        ) : (
          <button
            type="button"
            disabled={blocked || busy || transitional}
            title={reason}
            aria-describedby={blocked ? `why-${mode.id}` : undefined}
            onClick={onEnter}
          >
            {mode.state === 'STARTING'
              ? 'Starting...'
              : mode.state === 'STOPPING'
                ? 'Stopping...'
                : replace
                  ? 'Enter (replace)'
                  : 'Enter'}
          </button>
        )}
      </div>
      {mode.panel ? (
        <ModePanelView
          panel={mode.panel}
          busy={busy}
          {...(assetBase ? { assetBase } : {})}
          onAct={onAct}
        />
      ) : null}
    </article>
  )
}

export function Modes({ api, modes, onChange, onRefresh, assetBase }: ModesProps) {
  const replaceId = useId()
  const [replace, setReplace] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useAction()
  const titles = Object.fromEntries(modes.map((m) => [m.id, m.title]))

  async function act(mode: ModeView, action: 'enter' | 'exit') {
    setError(null)
    setWorking(mode.id)
    try {
      onChange(await api.modeAction(mode.id, action, { replace, force: false }))
    } catch (err) {
      setError(`${mode.title}: ${messageOf(err)}`)
    } finally {
      setWorking(null)
    }
  }

  /** A button of the mode's own panel: what it says (which action, which row, which inputs) is the mode's business. */
  async function actPanel(mode: ModeView, params: Record<string, string | number | boolean>) {
    setError(null)
    setWorking(mode.id)
    try {
      onChange(await api.modeAction(mode.id, 'act', { replace: false, force: false, params }))
    } catch (err) {
      setError(`${mode.title}: ${messageOf(err)}`)
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Modes</h2>
        <button
          type="button"
          disabled={refresh.busy}
          onClick={() => void refresh.run(async () => onRefresh(await api.modes()))}
        >
          Refresh
        </button>
      </div>
      <div className="check">
        <input
          id={replaceId}
          type="checkbox"
          checked={replace}
          onChange={(e) => setReplace(e.target.checked)}
        />
        <label htmlFor={replaceId}>
          Replace conflicting modes: leave any active mode that excludes the one being entered
        </label>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {refresh.error ? <Notice kind="error">{refresh.error}</Notice> : null}
      {modes.length === 0 ? <p className="muted">No modes are installed.</p> : null}
      <div className="cards modes">
        {modes.map((mode) => (
          <ModeCard
            key={mode.id}
            mode={mode}
            titles={titles}
            replace={replace}
            busy={working !== null}
            {...(assetBase ? { assetBase } : {})}
            onEnter={() => void act(mode, 'enter')}
            onExit={() => void act(mode, 'exit')}
            onAct={(params) => void actPanel(mode, params)}
          />
        ))}
      </div>
    </div>
  )
}
