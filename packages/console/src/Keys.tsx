import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { SecretPut } from '@animatus/protocol'
import type { SecretView } from '@animatus/protocol'
import type { Api } from './api.ts'
import { Notice, Pill, messageOf } from './components.tsx'

/**
 * The form that sets one key. The input is uncontrolled and the value is read at the moment of submitting
 * and wiped from the field in the same breath: it is never in component state, never in a prop, never
 * rendered. What is left of it is the local variable that goes into the request.
 */
function SecretForm({
  name,
  onSave,
  onCancel,
}: {
  name: string
  onSave(value: string): Promise<string | null>
  onCancel(): void
}) {
  const ids = useId()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const field = input.current
    if (!field) return
    const value = field.value
    field.value = ''
    if (value === '') {
      setProblem('Enter a value first.')
      return
    }
    // No message below repeats the value.
    if (!SecretPut.safeParse({ value }).success) {
      setProblem('That value is too long (at most 4096 characters).')
      return
    }
    setBusy(true)
    setProblem(null)
    const failure = await onSave(value)
    setBusy(false)
    if (failure) setProblem(failure)
  }

  return (
    <form
      className="form inline-form"
      onSubmit={(e) => void submit(e)}
      autoComplete="off"
      aria-label={`Set ${name}`}
    >
      <label htmlFor={`${ids}-value`}>New value for {name}</label>
      <input
        id={`${ids}-value`}
        ref={input}
        type="password"
        name="secret-value"
        autoComplete="new-password"
        autoCapitalize="off"
        spellCheck={false}
        disabled={busy}
      />
      <div className="row buttons">
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {problem ? <Notice kind="error">{problem}</Notice> : null}
    </form>
  )
}

export function Keys({ api }: { api: Api }) {
  const [secrets, setSecrets] = useState<SecretView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setSecrets(await api.secrets())
    } catch (err) {
      setError(messageOf(err))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const replaceRow = (view: SecretView) =>
    setSecrets((list) =>
      list === null
        ? [view]
        : list.some((s) => s.name === view.name)
          ? list.map((s) => (s.name === view.name ? view : s))
          : [...list, view]
    )

  async function save(name: string, value: string): Promise<string | null> {
    try {
      replaceRow(await api.putSecret(name, value))
    } catch (err) {
      return messageOf(err)
    }
    setEditing(null)
    setSaved(name)
    return null
  }

  async function remove(name: string) {
    setError(null)
    setSaved(null)
    setDeleting(name)
    try {
      replaceRow(await api.deleteSecret(name))
      setConfirming(null)
    } catch (err) {
      setError(`${name}: ${messageOf(err)}`)
      setConfirming(null)
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Keys</h2>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <Notice kind="info">
        Values are write-only. A key you save is stored by the orchestrator and is never shown
        again, not on this page and not through the API. To change one, set it again.
      </Notice>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {saved ? <Notice kind="ok">Saved {saved}. Its value cannot be read back.</Notice> : null}
      {secrets === null && !error ? <p className="muted">Loading.</p> : null}
      {secrets !== null && secrets.length === 0 ? (
        <p className="muted">No keys are known yet.</p>
      ) : null}
      {secrets !== null && secrets.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">State</th>
                <th scope="col">Stored in</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {secrets.map((secret) => (
                <tr key={secret.name}>
                  <th scope="row">
                    <code>{secret.name}</code>
                  </th>
                  <td>
                    <Pill tone={secret.set ? 'ok' : 'idle'}>{secret.set ? 'set' : 'not set'}</Pill>
                  </td>
                  <td>
                    {secret.set ? secret.source : <span className="muted">{secret.source}</span>}
                  </td>
                  <td>
                    {editing === secret.name ? (
                      <SecretForm
                        name={secret.name}
                        onSave={(value) => save(secret.name, value)}
                        onCancel={() => setEditing(null)}
                      />
                    ) : confirming === secret.name ? (
                      <div className="row buttons">
                        <span>Delete {secret.name}?</span>
                        <button
                          type="button"
                          className="danger"
                          disabled={deleting !== null}
                          onClick={() => void remove(secret.name)}
                        >
                          Confirm delete
                        </button>
                        <button type="button" onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </div>
                    ) : (
                      <div className="row buttons">
                        <button
                          type="button"
                          aria-label={`${secret.set ? 'replace' : 'set'} ${secret.name}`}
                          onClick={() => {
                            setSaved(null)
                            setConfirming(null)
                            setEditing(secret.name)
                          }}
                        >
                          {secret.set ? 'Replace' : 'Set'}
                        </button>
                        {secret.set ? (
                          <button
                            type="button"
                            aria-label={`delete ${secret.name}`}
                            onClick={() => {
                              setEditing(null)
                              setConfirming(secret.name)
                            }}
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
