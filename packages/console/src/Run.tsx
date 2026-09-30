import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { z } from 'zod'
import { EMOTIONS, InjectRequest, SayRequest } from '@animatus/protocol'
import type { Alarm, Emotion, RunEvent, SpeechTraceView, StatusView } from '@animatus/protocol'
import type { Api } from './api.ts'
import { Card, Notice, Pill, useAction } from './components.tsx'
import type { Tone } from './components.tsx'
import { formatAgo, formatMb, formatMs, formatSeconds, formatTime } from './format.ts'

export interface RunProps {
  api: Api
  status: StatusView | null
  /** Oldest first. */
  events: RunEvent[]
  /** Oldest first. */
  traces: SpeechTraceView[]
  alarms: Alarm[]
}

/** The first thing wrong with a request, for a person: "field: what is wrong". Never the value. */
function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'The request is not valid.'
  return `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`
}

// ─────────────────────────────── status cards ───────────────────────────────

function StatusCards({ status }: { status: StatusView | null }) {
  if (!status)
    return <Notice kind="info">Waiting for the first status from the orchestrator.</Notice>
  const { stage, speech } = status
  const audio = stage.audio
  return (
    <div className="cards">
      <Card title="Stage" tone={stage.connected ? 'ok' : 'bad'}>
        <p>
          <Pill tone={stage.connected ? 'ok' : 'bad'}>
            {stage.connected ? 'connected' : 'not connected'}
          </Pill>
        </p>
        {stage.model ? (
          <p className="muted">
            Model: {stage.model.status}
            {stage.model.error ? ` (${stage.model.error})` : ''}
          </p>
        ) : null}
        {stage.lastReportAt !== undefined ? (
          <p className="muted">Last report {formatAgo(stage.lastReportAt, status.now)}</p>
        ) : null}
      </Card>
      <Card title="Audio">
        {audio ? (
          <>
            <p>
              <Pill tone={audio.state === 'running' ? 'ok' : 'warn'}>{audio.state}</Pill>
            </p>
            <p className="muted">
              AudioContexts: {audio.contexts_created} created, {audio.contexts_open} open
            </p>
          </>
        ) : (
          <p className="muted">No report yet</p>
        )}
      </Card>
      <Card title="Frame rate">
        <p className="big">{stage.fps === undefined ? '-' : Math.round(stage.fps)}</p>
        <p className="muted">frames per second</p>
      </Card>
      <Card title="Underruns">
        <p className="big">{stage.underruns_total ?? '-'}</p>
        <p className="muted">audio buffer underruns</p>
      </Card>
      <Card title="T-pose frames" tone={(stage.tpose_frames ?? 0) > 0 ? 'bad' : undefined}>
        <p className="big">{stage.tpose_frames ?? '-'}</p>
        <p className="muted">frames drawn without a pose</p>
      </Card>
      <Card title="Speech">
        <p>
          <Pill tone={speech.speaking ? 'info' : 'idle'}>
            {speech.speaking ? 'speaking' : 'quiet'}
          </Pill>
        </p>
        <p className="muted">
          Pending: {speech.pending} · Held: {speech.held ? 'yes' : 'no'}
        </p>
      </Card>
      {status.vram ? (
        <Card title="GPU memory">
          <p className="big">
            {status.vram.usedMb === null ? formatMb(null) : formatMb(status.vram.usedMb)}
          </p>
          <p className="muted">
            of {formatMb(status.vram.budgetMb)} on {status.vram.adapter}
          </p>
        </Card>
      ) : null}
      {status.llm.providers.length > 0 ? (
        <Card title="Language models">
          <ul className="plain">
            {status.llm.providers.map((p) => (
              <li key={p.id}>
                <strong>{p.id}</strong> <span className="muted">{p.kind}</span>
                <br />
                <span className="muted">
                  {p.successes} ok · {p.failures} failed
                  {p.lastError ? ` · last error ${p.lastError.code}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}

// ─────────────────────────────── alarms ───────────────────────────────

const levelTone: Record<Alarm['level'], Tone> = { info: 'info', warn: 'warn', error: 'bad' }

function Alarms({ alarms }: { alarms: Alarm[] }) {
  if (alarms.length === 0) return <p className="muted">No alarms.</p>
  const newestFirst = [...alarms].sort((a, b) => b.ts - a.ts)
  return (
    <ul className="alarms">
      {newestFirst.map((alarm) => (
        <li key={alarm.id} className={`alarm alarm-${alarm.level}`}>
          <Pill tone={levelTone[alarm.level]}>{alarm.level}</Pill> <strong>{alarm.code}</strong>
          {alarm.subject ? <span className="muted"> ({alarm.subject})</span> : null}{' '}
          <span>{alarm.message}</span> <time className="muted">{formatTime(alarm.ts)}</time>
        </li>
      ))}
    </ul>
  )
}

// ─────────────────────────────── event stream ───────────────────────────────

function EventStream({ events }: { events: RunEvent[] }) {
  const list = useRef<HTMLOListElement>(null)
  // Follow the newest line, unless the reader has scrolled up to look at something.
  const following = useRef(true)
  useEffect(() => {
    const el = list.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [events.length])
  const onScroll = () => {
    const el = list.current
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  }
  return (
    <ol className="stream" ref={list} onScroll={onScroll} aria-label="Live events" tabIndex={0}>
      {events.length === 0 ? <li className="muted">Nothing yet.</li> : null}
      {events.map((event, i) => (
        <li key={`${event.ts}-${i}`} className={`event event-${event.kind}`}>
          <time className="muted">{formatTime(event.ts)}</time> <Pill>{event.kind}</Pill>{' '}
          {event.trust === 'untrusted' ? (
            <Pill
              tone="warn"
              title="Written by the audience. It is never treated as an instruction."
            >
              untrusted
            </Pill>
          ) : null}{' '}
          <span className="event-text">{event.text}</span>
        </li>
      ))}
    </ol>
  )
}

// ─────────────────────────────── speech trace ───────────────────────────────

const motionTone: Record<NonNullable<SpeechTraceView['liveMotion']>, Tone> = {
  used: 'ok',
  late: 'warn',
  failed: 'bad',
  skipped: 'idle',
}

function TraceTable({ traces }: { traces: SpeechTraceView[] }) {
  if (traces.length === 0) return <p className="muted">No speech yet.</p>
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Sentence</th>
            <th scope="col">Audio</th>
            <th scope="col">Synthesis</th>
            <th scope="col">Sent</th>
            <th scope="col">Started</th>
            <th scope="col">Live motion</th>
          </tr>
        </thead>
        <tbody>
          {[...traces].reverse().map((trace) => (
            <tr key={trace.id}>
              <td className="wrap">{trace.text}</td>
              <td>{formatSeconds(trace.audioSec)}</td>
              <td>{formatMs(trace.synthMs)}</td>
              <td>{formatMs(trace.sendMs)}</td>
              <td>{formatMs(trace.startMs)}</td>
              <td>
                {trace.liveMotion ? (
                  <Pill tone={motionTone[trace.liveMotion]}>{trace.liveMotion}</Pill>
                ) : (
                  '-'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────── say ───────────────────────────────

function SayForm({ api }: { api: Api }) {
  const ids = useId()
  const [text, setText] = useState('')
  const [style, setStyle] = useState('')
  const [emotion, setEmotion] = useState<Emotion>('neutral')
  const [speed, setSpeed] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const say = useAction()
  const stop = useAction()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSent(false)
    setProblem(null)
    const candidate: Record<string, unknown> = { text: text.trim(), emotion }
    if (style.trim() !== '') candidate.style = style.trim()
    if (speed.trim() !== '') candidate.speed = Number(speed)
    const parsed = SayRequest.safeParse(candidate)
    if (!parsed.success) {
      setProblem(firstProblem(parsed.error))
      return
    }
    const done = await say.run(async () => {
      await api.say(parsed.data)
      return true
    })
    if (done) {
      setSent(true)
      setText('')
    }
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)} aria-label="Say a line">
      <h3>Say a line</h3>
      <p className="muted">Straight to speech, without the language model.</p>
      <label htmlFor={`${ids}-text`}>Text</label>
      <textarea
        id={`${ids}-text`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={500}
        rows={3}
      />
      <div className="row">
        <div>
          <label htmlFor={`${ids}-style`}>Style</label>
          <input
            id={`${ids}-style`}
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            maxLength={32}
            placeholder="optional"
          />
        </div>
        <div>
          <label htmlFor={`${ids}-emotion`}>Emotion</label>
          <select
            id={`${ids}-emotion`}
            value={emotion}
            onChange={(e) => setEmotion(e.target.value as Emotion)}
          >
            {EMOTIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-speed`}>Speed</label>
          <input
            id={`${ids}-speed`}
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
            inputMode="decimal"
            placeholder="0.5 to 2"
          />
        </div>
      </div>
      <div className="row buttons">
        <button type="submit" disabled={say.busy}>
          Say
        </button>
        <button
          type="button"
          className="danger"
          disabled={stop.busy}
          onClick={() => void stop.run(() => api.stopSpeech())}
        >
          Stop speech
        </button>
      </div>
      {problem ? <Notice kind="error">{problem}</Notice> : null}
      {say.error ? <Notice kind="error">{say.error}</Notice> : null}
      {stop.error ? <Notice kind="error">{stop.error}</Notice> : null}
      {sent ? <Notice kind="ok">Sent.</Notice> : null}
    </form>
  )
}

// ─────────────────────────────── inject ───────────────────────────────

const INJECT_KINDS = ['danmaku', 'gift', 'guard', 'superchat'] as const
type InjectKind = (typeof INJECT_KINDS)[number]

function InjectForm({ api }: { api: Api }) {
  const ids = useId()
  const [kind, setKind] = useState<InjectKind>('danmaku')
  const [name, setName] = useState('tester')
  const [text, setText] = useState('')
  const [gift, setGift] = useState('')
  const [count, setCount] = useState('1')
  const [price, setPrice] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const inject = useAction()

  const usesText = kind === 'danmaku' || kind === 'superchat'
  const usesGift = kind === 'gift' || kind === 'guard'
  const usesPrice = kind === 'gift' || kind === 'superchat'

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSent(false)
    setProblem(null)
    const candidate: Record<string, unknown> = { kind, name: name.trim(), count: Number(count) }
    if (usesText) candidate.text = text
    if (usesGift && gift.trim() !== '') candidate.gift = gift.trim()
    if (usesPrice && price.trim() !== '') candidate.price = Number(price)
    const parsed = InjectRequest.safeParse(candidate)
    if (!parsed.success) {
      setProblem(firstProblem(parsed.error))
      return
    }
    const done = await inject.run(async () => {
      await api.inject(parsed.data)
      return true
    })
    if (done) setSent(true)
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)} aria-label="Inject an audience event">
      <h3>Inject a fake audience event</h3>
      <p className="muted">
        Enters like a real one, as untrusted text from a viewer. Nothing is sent to the platform.
      </p>
      <div className="row">
        <div>
          <label htmlFor={`${ids}-kind`}>Kind</label>
          <select
            id={`${ids}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as InjectKind)}
          >
            {INJECT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-name`}>Name</label>
          <input
            id={`${ids}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
          />
        </div>
        <div>
          <label htmlFor={`${ids}-count`}>Count</label>
          <input
            id={`${ids}-count`}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            inputMode="numeric"
          />
        </div>
      </div>
      {usesText ? (
        <>
          <label htmlFor={`${ids}-text`}>Text</label>
          <input
            id={`${ids}-text`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
          />
        </>
      ) : null}
      {usesGift || usesPrice ? (
        <div className="row">
          {usesGift ? (
            <div>
              <label htmlFor={`${ids}-gift`}>
                {kind === 'guard' ? 'Guard level (1 to 3)' : 'Gift'}
              </label>
              <input
                id={`${ids}-gift`}
                value={gift}
                onChange={(e) => setGift(e.target.value)}
                maxLength={40}
              />
            </div>
          ) : null}
          {usesPrice ? (
            <div>
              <label htmlFor={`${ids}-price`}>Price (yuan)</label>
              <input
                id={`${ids}-price`}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="row buttons">
        <button type="submit" disabled={inject.busy}>
          Inject
        </button>
      </div>
      {problem ? <Notice kind="error">{problem}</Notice> : null}
      {inject.error ? <Notice kind="error">{inject.error}</Notice> : null}
      {sent ? <Notice kind="ok">Injected.</Notice> : null}
    </form>
  )
}

// ─────────────────────────────── the page ───────────────────────────────

export function Run({ api, status, events, traces, alarms }: RunProps) {
  return (
    <div className="page">
      <h2>Run</h2>
      <StatusCards status={status} />
      <section aria-labelledby="alarms-title">
        <h3 id="alarms-title">Alarms</h3>
        <Alarms alarms={alarms} />
      </section>
      <div className="two-up">
        <SayForm api={api} />
        <InjectForm api={api} />
      </div>
      <section aria-labelledby="stream-title">
        <h3 id="stream-title">Live events</h3>
        <EventStream events={events} />
      </section>
      <section aria-labelledby="trace-title">
        <h3 id="trace-title">Speech trace</h3>
        <TraceTable traces={traces} />
      </section>
    </div>
  )
}
