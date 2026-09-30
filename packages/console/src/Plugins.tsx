import { useCallback, useEffect, useId, useState } from 'react'
import type { PluginAction, PluginStatus, PluginView } from '@animatus/protocol'
import type { Api } from './api.ts'
import { Notice, Pill, messageOf, pluginTone, useAction } from './components.tsx'
import { NOT_MEASURED, formatAgo, formatMb, stripAnsi } from './format.ts'

export interface PluginsProps {
  api: Api
  plugins: PluginView[]
  /** Called with the plugin as it is after an action. */
  onChange(plugin: PluginView): void
  /** Called with a fresh list. */
  onRefresh(plugins: PluginView[]): void
}

/** Which actions make sense in which state. A disabled plugin cannot be started from here. */
export function allowedActions(status: PluginStatus): Record<PluginAction, boolean> {
  switch (status) {
    case 'stopped':
    case 'failed':
      return { start: true, stop: false, restart: false }
    case 'ready':
    case 'unhealthy':
      return { start: false, stop: true, restart: true }
    case 'starting':
      return { start: false, stop: true, restart: false }
    default:
      return { start: false, stop: false, restart: false }
  }
}

function VramCell({ plugin }: { plugin: PluginView }) {
  if (!plugin.gpu) return <span className="muted">CPU only</span>
  return (
    <div className="vram">
      <div>
        Estimate:{' '}
        <strong className={plugin.vram_mb_est === null ? 'muted' : undefined}>
          {formatMb(plugin.vram_mb_est)}
        </strong>
      </div>
      <div>
        Measured:{' '}
        <strong className={plugin.vram_mb_measured === null ? 'muted' : undefined}>
          {formatMb(plugin.vram_mb_measured)}
        </strong>
      </div>
    </div>
  )
}

function HealthCell({ plugin }: { plugin: PluginView }) {
  const health = plugin.health
  if (!health) return <span className="muted">-</span>
  const label = !health.ok ? 'broken' : health.ready ? 'ready' : 'loading'
  return (
    <div>
      <Pill tone={!health.ok ? 'bad' : health.ready ? 'ok' : 'warn'}>{label}</Pill>
      {health.detail ? <div className="muted small">{health.detail}</div> : null}
    </div>
  )
}

const LOG_LINE_CHOICES = [100, 200, 500, 1000]

function LogsDrawer({ api, plugin, onClose }: { api: Api; plugin: PluginView; onClose(): void }) {
  const ids = useId()
  const [lines, setLines] = useState(200)
  const [text, setText] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setText(await api.pluginLogs(plugin.id, lines))
    } catch (err) {
      setText(null)
      setError(messageOf(err))
    }
  }, [api, plugin.id, lines])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="drawer" role="dialog" aria-label={`Logs of ${plugin.title}`}>
      <div className="drawer-head">
        <h3>Logs: {plugin.title}</h3>
        <div className="row buttons">
          <label htmlFor={`${ids}-lines`} className="inline">
            Lines
          </label>
          <select
            id={`${ids}-lines`}
            value={lines}
            onChange={(e) => setLines(Number(e.target.value))}
          >
            {LOG_LINE_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {text === null && !error ? <p className="muted">Loading.</p> : null}
      {text !== null ? (
        <pre className="logs">
          {text.length === 0 ? '(no log lines)' : text.map(stripAnsi).join('\n')}
        </pre>
      ) : null}
    </aside>
  )
}

export function Plugins({ api, plugins, onChange, onRefresh }: PluginsProps) {
  const [busy, setBusy] = useState<Record<string, PluginAction>>({})
  const [error, setError] = useState<string | null>(null)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const refresh = useAction()

  async function act(plugin: PluginView, action: PluginAction) {
    setError(null)
    setBusy((b) => ({ ...b, [plugin.id]: action }))
    try {
      onChange(await api.pluginAction(plugin.id, action))
    } catch (err) {
      setError(`${plugin.title}: ${messageOf(err)}`)
    } finally {
      setBusy((b) => {
        const { [plugin.id]: _done, ...rest } = b
        return rest
      })
    }
  }

  const drawerPlugin = plugins.find((p) => p.id === logsFor) ?? null

  return (
    <div className="page">
      <div className="page-head">
        <h2>Plugins</h2>
        <button
          type="button"
          disabled={refresh.busy}
          onClick={() => void refresh.run(async () => onRefresh(await api.plugins()))}
        >
          Refresh
        </button>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {refresh.error ? <Notice kind="error">{refresh.error}</Notice> : null}
      {plugins.length === 0 ? <p className="muted">No plugins are configured.</p> : null}
      {plugins.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Plugin</th>
                <th scope="col">Status</th>
                <th scope="col">PID</th>
                <th scope="col">Restarts</th>
                <th scope="col">Health</th>
                <th scope="col">GPU memory</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((plugin) => {
                const allowed = allowedActions(plugin.status)
                const working = busy[plugin.id]
                return (
                  <tr key={plugin.id}>
                    <th scope="row" className="wrap">
                      {plugin.title}
                      <div className="muted small">
                        {plugin.id} · {plugin.kind}
                        {plugin.enabled ? '' : ' · disabled in the configuration'}
                      </div>
                    </th>
                    <td>
                      <Pill tone={pluginTone(plugin.status)}>{plugin.status}</Pill>
                      {plugin.startedAt !== undefined && plugin.status === 'ready' ? (
                        <div className="muted small">up since {formatAgo(plugin.startedAt)}</div>
                      ) : null}
                      {plugin.lastError ? (
                        <div className="error-text small">{plugin.lastError}</div>
                      ) : null}
                    </td>
                    <td>{plugin.pid ?? '-'}</td>
                    <td>{plugin.restarts}</td>
                    <td>
                      <HealthCell plugin={plugin} />
                    </td>
                    <td>
                      <VramCell plugin={plugin} />
                    </td>
                    <td>
                      <div className="row buttons">
                        {(['start', 'stop', 'restart'] as const).map((action) => (
                          <button
                            key={action}
                            type="button"
                            aria-label={`${action} ${plugin.title}`}
                            disabled={!allowed[action] || working !== undefined}
                            onClick={() => void act(plugin, action)}
                          >
                            {working === action ? `${action}...` : action}
                          </button>
                        ))}
                        <button
                          type="button"
                          aria-label={`logs of ${plugin.title}`}
                          onClick={() => setLogsFor(plugin.id)}
                        >
                          logs
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="muted small">
        GPU memory reads "{NOT_MEASURED}" until the probe has measured the service with its current
        settings.
      </p>
      {drawerPlugin ? (
        <LogsDrawer api={api} plugin={drawerPlugin} onClose={() => setLogsFor(null)} />
      ) : null}
    </div>
  )
}
