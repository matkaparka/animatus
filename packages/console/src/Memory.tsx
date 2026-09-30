import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type {
  MemoryCommit,
  MemoryFileView,
  MemoryLineView,
  MemoryProposal,
  MemoryStatusView,
  MemoryTreeEntry,
} from '@animatus/protocol'
import type { Api } from './api.ts'
import { Notice, Pill, messageOf } from './components.tsx'
import type { Tone } from './components.tsx'
import { formatAgo } from './format.ts'

/**
 * What the character remembers, as the streamer sees and edits it: the files, line by line, with where each line
 * came from; a line can be changed, removed or locked (a locked line is safe from the program); every file that has
 * a history can be rolled back; the program's own proposals wait here for a yes or a no.
 *
 * Whatever is saved here is the streamer's own edit and is in effect for the very next reply.
 */
export interface MemoryProps {
  api: Api
  /** How often the file list and the status are refreshed by themselves, ms. Default 5000; 0 for never. */
  refreshMs?: number
}

const SECTIONS = [
  'persona',
  'viewers',
  'stream',
  'world',
  'search-cache',
  'proposals',
  'inbox',
] as const
const SECTION_NOTE: Record<(typeof SECTIONS)[number], string> = {
  persona: 'Who the character is. Only you change this; the program can only propose.',
  viewers: 'What viewers said about themselves. Not versioned, so "forget" can erase it for good.',
  stream: 'Notes about streams.',
  world: 'Memes, settings, what the community knows.',
  'search-cache': 'Results of web searches. Untrusted, and they expire.',
  proposals: 'Changes the program would like you to approve (see below).',
  inbox: 'Raw events of the stream, waiting for the next consolidation.',
}
/** Sections the console shows but does not edit line by line. */
const READ_ONLY = new Set(['proposals', 'inbox'])

const sourceTone = (source: string | undefined): Tone =>
  source === 'human' ? 'ok' : source === 'viewer' ? 'info' : 'idle'

function LineRow({
  line,
  editable,
  busy,
  onSave,
  onRemove,
  onLock,
}: {
  line: MemoryLineView
  editable: boolean
  busy: boolean
  onSave(text: string): void
  onRemove(): void
  onLock(locked: boolean): void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) field.current?.focus()
  }, [editing])

  if (line.text.trim() === '') return null
  if (editing) {
    return (
      <li className="mem-line mem-line-editing">
        <input
          ref={field}
          className="mem-edit"
          aria-label="Edit line"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || draft.trim() === ''}
          onClick={() => {
            // a fact keeps its date; whoever edits it here makes it the streamer's own
            const text = line.kind === 'fact' ? `[human] ${line.date} ${draft.trim()}` : draft
            onSave(text)
            setEditing(false)
          }}
        >
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </li>
    )
  }
  return (
    <li className={line.kind === 'fact' ? 'mem-line' : 'mem-line mem-note'}>
      <span className="mem-what">
        {line.kind === 'fact' ? (
          <>
            <Pill tone={sourceTone(line.source)}>{line.source}</Pill>
            {line.locked ? <Pill tone="warn">locked</Pill> : null}
            <span className="muted small">{line.date}</span>{' '}
            <span className="mem-body">{line.body}</span>
          </>
        ) : (
          <span className="mem-body">{line.text}</span>
        )}
      </span>
      {editable ? (
        <span className="mem-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(line.kind === 'fact' ? (line.body ?? '') : line.text)
              setEditing(true)
            }}
          >
            Edit
          </button>
          {line.kind === 'fact' && line.source === 'human' ? (
            <button type="button" disabled={busy} onClick={() => onLock(!line.locked)}>
              {line.locked ? 'Unlock' : 'Lock'}
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        </span>
      ) : null}
    </li>
  )
}

function History({
  api,
  path,
  onRestored,
  onProblem,
}: {
  api: Api
  path: string
  onRestored(): void
  onProblem(message: string): void
}) {
  const [commits, setCommits] = useState<MemoryCommit[] | null>(null)
  const [shown, setShown] = useState<{ hash: string; diff: string } | null>(null)

  useEffect(() => {
    let alive = true
    setShown(null)
    api
      .memoryHistory(path)
      .then((c) => alive && setCommits(c))
      .catch((e) => alive && onProblem(messageOf(e)))
    return () => {
      alive = false
    }
  }, [api, path, onProblem])

  if (commits === null) return <p className="muted">Reading the history...</p>
  if (commits.length === 0) return <p className="muted">This file has no history yet.</p>
  return (
    <div className="mem-history">
      <ul className="plain">
        {commits.map((c, i) => {
          const parent = commits[i + 1]
          return (
            <li key={c.hash} className="mem-commit">
              <span>
                <Pill tone={c.author === 'human' ? 'ok' : 'idle'}>{c.author}</Pill>{' '}
                <strong>{c.subject.replace(/^(?:human|agent|system): /, '')}</strong>{' '}
                <span className="muted small">{formatAgo(c.time)}</span>
              </span>
              <span className="mem-actions">
                <button
                  type="button"
                  onClick={() =>
                    void api
                      .memoryDiff(path, parent ? parent.hash : c.hash, parent ? c.hash : undefined)
                      .then((diff) => setShown({ hash: c.hash, diff }))
                      .catch((e) => onProblem(messageOf(e)))
                  }
                >
                  Changes
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!window.confirm(`Put this file back as it was in "${c.subject}"?`)) return
                    void api
                      .memoryRollback(path, c.hash)
                      .then(onRestored)
                      .catch((e) => onProblem(messageOf(e)))
                  }}
                >
                  Restore this version
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      {shown ? (
        <pre className="mem-diff" aria-label="Changes">
          {shown.diff.trim() === '' ? '(no difference)' : shown.diff}
        </pre>
      ) : null}
    </div>
  )
}

export function Memory({ api, refreshMs = 5000 }: MemoryProps) {
  const ids = useId()
  const [status, setStatus] = useState<MemoryStatusView | null>(null)
  const [tree, setTree] = useState<MemoryTreeEntry[]>([])
  const [proposals, setProposals] = useState<MemoryProposal[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<MemoryFileView | null>(null)
  const [tab, setTab] = useState<'lines' | 'history'>('lines')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newFact, setNewFact] = useState('')
  const [newLocked, setNewLocked] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [forgetId, setForgetId] = useState('')

  const problem = useCallback((message: string) => setError(message), [])

  const load = useCallback(async () => {
    try {
      const s = await api.memoryStatus()
      setStatus(s)
      if (!s.enabled) return
      const [t, p] = await Promise.all([api.memoryTree(), api.memoryProposals()])
      setTree(t)
      setProposals(p)
    } catch (e) {
      setError(messageOf(e))
    }
  }, [api])

  useEffect(() => {
    void load()
    if (refreshMs <= 0) return
    const timer = setInterval(() => void load(), refreshMs)
    return () => clearInterval(timer)
  }, [load, refreshMs])

  const open = useCallback(
    async (path: string) => {
      setSelected(path)
      setTab('lines')
      setNote(null)
      try {
        setFile(await api.memoryFile(path))
        setError(null)
      } catch (e) {
        setFile(null)
        setError(messageOf(e))
      }
    },
    [api]
  )

  /** Run a change, then show what is on disk. A conflict is said in words and the file is read again. */
  async function change(action: () => Promise<unknown>, done?: string) {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await action()
      if (done) setNote(done)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      if (selected) {
        try {
          setFile(await api.memoryFile(selected))
        } catch {
          setFile(null)
        }
      }
      await load()
      setBusy(false)
    }
  }

  if (status === null && !error) return <p className="muted">Reading memory...</p>
  if (status && !status.enabled) {
    return (
      <div className="page">
        <div className="page-head">
          <h2>Memory</h2>
        </div>
        <Notice kind="info">
          Memory is switched off. It keeps what viewers say about themselves, so it is off until you
          turn it on: set <code>memory.enabled: true</code> in the configuration and restart.
        </Notice>
      </div>
    )
  }
  const s = status && status.enabled ? status : null
  const editable = selected !== null && !READ_ONLY.has(selected.split('/')[0] ?? '')
  const bySection = (section: string) => tree.filter((t) => t.section === section)

  return (
    <div className="page memory">
      <div className="page-head">
        <h2>Memory</h2>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {note ? <Notice kind="ok">{note}</Notice> : null}

      {s ? (
        <section className="card" aria-label="Memory status">
          <p className="muted small">
            {s.files} files, {s.facts} facts · {s.inboxEvents} events waiting in the inbox ·{' '}
            {s.git ? 'history on' : 'history off (git is not installed)'}
            {s.recall
              ? ` · recall ${s.recall.p50.toFixed(2)} ms median, ${s.recall.p95.toFixed(2)} ms at the 95th percentile (${s.recall.n} lookups)`
              : ''}
          </p>
          <p className="muted small">
            Folder: <code>{s.root}</code>
          </p>
          <div className="row buttons">
            <button
              type="button"
              disabled={busy || s.consolidating}
              onClick={() =>
                void change(async () => {
                  const r = await api.memoryConsolidate()
                  setNote(
                    `Consolidation: ${r.viewersAsked} viewers read, ${r.factsAdded} facts added, ${r.streamNotes} notes about the stream, ${r.expired} web results expired${r.failures.length ? `; ${r.failures.length} problem(s): ${r.failures[0]}` : ''}.`
                  )
                })
              }
            >
              {s.consolidating ? 'Consolidating...' : 'Consolidate now'}
            </button>
          </div>
          {s.consolidation ? (
            <p className="muted small">
              Last consolidation {formatAgo(s.consolidation.at)}:{' '}
              {s.consolidation.report.factsAdded} facts added
              {s.consolidation.report.failures.length
                ? `, ${s.consolidation.report.failures.length} problem(s)`
                : ''}
              .
            </p>
          ) : null}
        </section>
      ) : null}

      {proposals.length > 0 ? (
        <section className="card" aria-label="Proposals">
          <h3 className="card-title">The program asks you to approve</h3>
          <ul className="plain">
            {proposals.map((p) => (
              <li key={p.id} className="mem-proposal">
                <p>
                  <strong>{p.target}</strong> <span className="muted small">{formatAgo(p.at)}</span>
                </p>
                <p className="small">{p.reason}</p>
                <pre className="mem-diff">{p.content.split('\n').slice(0, 8).join('\n')}</pre>
                <div className="row buttons">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void change(
                        () => api.memoryResolve(p.id, true),
                        `Approved: ${p.target} is changed.`
                      )
                    }
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void change(() => api.memoryResolve(p.id, false), 'Refused.')}
                  >
                    Refuse
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mem-layout">
        <nav className="mem-tree" aria-label="Files">
          {SECTIONS.map((section) => (
            <div key={section} className="mem-section">
              <h3 title={SECTION_NOTE[section]}>{section}</h3>
              <ul className="plain">
                {bySection(section).map((t) => (
                  <li key={t.path}>
                    <button
                      type="button"
                      className={t.path === selected ? 'mem-file mem-file-on' : 'mem-file'}
                      aria-current={t.path === selected ? 'true' : undefined}
                      onClick={() => void open(t.path)}
                    >
                      {t.path.slice(section.length + 1)}{' '}
                      <span className="muted small">{t.facts > 0 ? `(${t.facts})` : ''}</span>
                    </button>
                  </li>
                ))}
                {bySection(section).length === 0 ? <li className="muted small">empty</li> : null}
              </ul>
            </div>
          ))}
          <form
            className="form inline-form"
            aria-label="New file"
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
              const p = newPath.trim()
              if (!p) return
              void change(async () => {
                await api.memoryWrite({ path: p, content: '' })
                setNewPath('')
                await open(p)
              }, `Created ${p}.`)
            }}
          >
            <label htmlFor={`${ids}-new`}>New file</label>
            <input
              id={`${ids}-new`}
              value={newPath}
              placeholder="world/memes.md"
              onChange={(e) => setNewPath(e.target.value)}
            />
            <button type="submit" disabled={busy || newPath.trim() === ''}>
              Create
            </button>
          </form>
        </nav>

        <section className="mem-file-view" aria-label="File">
          {file && selected ? (
            <>
              <div className="row">
                <h3 className="card-title">{file.path}</h3>
                <span className="muted small">
                  {file.versioned ? 'versioned' : 'no history (on purpose)'}
                </span>
              </div>
              <div className="tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'lines'}
                  onClick={() => setTab('lines')}
                >
                  Lines
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'history'}
                  disabled={!file.versioned}
                  onClick={() => setTab('history')}
                >
                  History
                </button>
              </div>
              {tab === 'lines' ? (
                <>
                  {editable ? (
                    <p className="muted small">
                      What you save here is yours: it is in effect for the very next reply, and the
                      program cannot change it. Lock a line to keep it safe from the program for
                      good.
                    </p>
                  ) : (
                    <p className="muted small">
                      This file is shown as it is; it is not edited here.
                    </p>
                  )}
                  <ul className="plain mem-lines">
                    {file.lines.map((line) => (
                      <LineRow
                        key={`${line.index}-${line.text}`}
                        line={line}
                        editable={editable}
                        busy={busy}
                        onSave={(text) =>
                          void change(() =>
                            api.memoryLine({
                              op: 'edit',
                              path: file.path,
                              index: line.index,
                              expect: line.text,
                              text,
                            })
                          )
                        }
                        onRemove={() => {
                          if (!window.confirm('Remove this line?')) return
                          void change(() =>
                            api.memoryLine({
                              op: 'remove',
                              path: file.path,
                              index: line.index,
                              expect: line.text,
                            })
                          )
                        }}
                        onLock={(locked) =>
                          void change(() =>
                            api.memoryLine({
                              op: locked ? 'lock' : 'unlock',
                              path: file.path,
                              index: line.index,
                              expect: line.text,
                            })
                          )
                        }
                      />
                    ))}
                    {file.lines.length === 0 ? <li className="muted">The file is empty.</li> : null}
                  </ul>
                  {editable ? (
                    <form
                      className="form inline-form"
                      aria-label="Add a fact"
                      onSubmit={(e: FormEvent) => {
                        e.preventDefault()
                        const text = newFact.trim()
                        if (!text) return
                        void change(async () => {
                          await api.memoryLine({
                            op: 'add',
                            path: file.path,
                            text,
                            locked: newLocked,
                          })
                          setNewFact('')
                          setNewLocked(false)
                        })
                      }}
                    >
                      <label htmlFor={`${ids}-fact`}>Add a fact</label>
                      <input
                        id={`${ids}-fact`}
                        value={newFact}
                        placeholder="one fact, in your own words"
                        onChange={(e) => setNewFact(e.target.value)}
                      />
                      <span className="check">
                        <input
                          id={`${ids}-lock`}
                          type="checkbox"
                          checked={newLocked}
                          onChange={(e) => setNewLocked(e.target.checked)}
                        />
                        <label htmlFor={`${ids}-lock`}>Lock it</label>
                      </span>
                      <button type="submit" disabled={busy || newFact.trim() === ''}>
                        Add
                      </button>
                    </form>
                  ) : null}
                </>
              ) : (
                <History
                  api={api}
                  path={file.path}
                  onProblem={problem}
                  onRestored={() => void change(async () => undefined, 'Restored.')}
                />
              )}
            </>
          ) : (
            <p className="muted">Pick a file on the left.</p>
          )}
        </section>
      </div>

      <section className="card" aria-label="Forget a viewer">
        <h3 className="card-title">Forget a viewer</h3>
        <p className="muted small">
          Deletes everything kept about one viewer, for good. The viewer can also write "忘记我" in
          the chat.
        </p>
        <form
          className="form inline-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            const uid = Number(forgetId)
            if (!Number.isSafeInteger(uid) || uid <= 0)
              return setError('A viewer id is a whole number.')
            if (!window.confirm(`Delete everything kept about viewer ${uid}?`)) return
            void change(async () => {
              const existed = await api.memoryForget(uid)
              setForgetId('')
              setNote(
                existed
                  ? `Viewer ${uid} is forgotten.`
                  : `There was nothing kept about viewer ${uid}.`
              )
            })
          }}
        >
          <label htmlFor={`${ids}-uid`}>Viewer id</label>
          <input
            id={`${ids}-uid`}
            inputMode="numeric"
            value={forgetId}
            onChange={(e) => setForgetId(e.target.value)}
          />
          <button type="submit" disabled={busy || forgetId.trim() === ''}>
            Forget
          </button>
        </form>
      </section>
    </div>
  )
}
