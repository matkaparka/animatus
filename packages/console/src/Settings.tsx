import { useCallback, useEffect, useState } from 'react'
import type { Api } from './api.ts'
import { Notice, messageOf } from './components.tsx'

const MAX_DEPTH = 8
const MAX_CHILDREN = 200

function leaf(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

/** One key of the configuration: a collapsible group for objects and lists, a plain line for the rest. */
function ConfigNode({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  if (value !== null && typeof value === 'object') {
    const isList = Array.isArray(value)
    const entries: Array<[string, unknown]> = isList
      ? value.map((item, i) => [String(i), item])
      : Object.entries(value)
    return (
      <details className="node" open={depth < 1}>
        <summary>
          {name}{' '}
          <span className="muted">
            {isList
              ? `list of ${entries.length}`
              : `${entries.length} ${entries.length === 1 ? 'key' : 'keys'}`}
          </span>
        </summary>
        {depth >= MAX_DEPTH ? (
          <p className="muted small">Nested too deeply to show here.</p>
        ) : (
          <div className="children">
            {entries.slice(0, MAX_CHILDREN).map(([key, child]) => (
              <ConfigNode key={key} name={key} value={child} depth={depth + 1} />
            ))}
            {entries.length > MAX_CHILDREN ? (
              <p className="muted small">{entries.length - MAX_CHILDREN} more not shown.</p>
            ) : null}
          </div>
        )}
      </details>
    )
  }
  return (
    <div className="kv">
      <span className="k">{name}</span>
      <code className="v">{leaf(value)}</code>
    </div>
  )
}

export function Settings({ api }: { api: Api }) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setConfig(await api.config())
    } catch (err) {
      setConfig(null)
      setError(messageOf(err))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const entries = config ? Object.entries(config) : []
  return (
    <div className="page">
      <div className="page-head">
        <h2>Settings</h2>
        <button type="button" disabled={loading} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <Notice kind="info">
        This view is read-only for now. Editing settings from the console comes later.
      </Notice>
      <p className="muted small">
        Secret values are never part of it. They live on the Keys page, write-only.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {loading && config === null && !error ? <p className="muted">Loading.</p> : null}
      {config !== null && entries.length === 0 ? (
        <p className="muted">The configuration is empty.</p>
      ) : null}
      <div className="config" aria-label="Configuration">
        {entries.map(([key, value]) => (
          <ConfigNode key={key} name={key} value={value} depth={0} />
        ))}
      </div>
    </div>
  )
}
