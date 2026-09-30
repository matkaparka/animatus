import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Alarm, RunEvent, SpeechTraceView, StatusView } from '@animatus/protocol'
import { ApiClientError } from '../src/api.ts'
import { Run } from '../src/Run.tsx'
import { alarm, fakeApi, status } from './helpers.tsx'
import type { MockedApi } from './helpers.tsx'

interface Over {
  api?: MockedApi
  status?: StatusView | null
  events?: RunEvent[]
  traces?: SpeechTraceView[]
  alarms?: Alarm[]
}

function renderRun(over: Over = {}) {
  const api = over.api ?? fakeApi()
  render(
    <Run
      api={api}
      status={over.status === undefined ? status() : over.status}
      events={over.events ?? []}
      traces={over.traces ?? []}
      alarms={over.alarms ?? []}
    />
  )
  return { api }
}

const card = (title: string) =>
  within(screen.getByRole('heading', { name: title, level: 3 }).closest('section') as HTMLElement)

describe('status cards', () => {
  it('stage, audio and counters as reported', () => {
    renderRun({
      status: status({
        stage: {
          connected: true,
          model: { status: 'ready' },
          audio: { state: 'running', contexts_created: 3, contexts_open: 1 },
          fps: 59.6,
          underruns_total: 7,
          tpose_frames: 0,
          lastReportAt: 990_000,
        },
      }),
    })
    expect(card('Stage').getByText('connected')).toBeTruthy()
    expect(card('Stage').getByText('Model: ready')).toBeTruthy()
    expect(card('Stage').getByText('Last report 10 s ago')).toBeTruthy()
    expect(card('Audio').getByText('running')).toBeTruthy()
    expect(card('Audio').getByText('AudioContexts: 3 created, 1 open')).toBeTruthy()
    expect(card('Frame rate').getByText('60')).toBeTruthy()
    expect(card('Underruns').getByText('7')).toBeTruthy()
    expect(card('T-pose frames').getByText('0')).toBeTruthy()
  })

  it('a stage that is not connected, and T-pose frames, are flagged', () => {
    renderRun({ status: status({ stage: { connected: false, tpose_frames: 12 } }) })
    expect(card('Stage').getByText('not connected')).toBeTruthy()
    expect(card('T-pose frames').getByText('12')).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: 'T-pose frames' }).closest('section')?.className
    ).toContain('card-bad')
    // what the stage has not reported is shown as missing, not as zero
    expect(card('Audio').getByText('No report yet')).toBeTruthy()
    expect(card('Frame rate').getByText('-')).toBeTruthy()
    expect(card('Underruns').getByText('-')).toBeTruthy()
  })

  it('speech: pending, speaking, held', () => {
    renderRun({ status: status({ speech: { speaking: true, pending: 2, held: true } }) })
    expect(card('Speech').getByText('speaking')).toBeTruthy()
    expect(card('Speech').getByText('Pending: 2 · Held: yes')).toBeTruthy()
  })

  it('GPU memory and the language models appear when the status has them', () => {
    renderRun({
      status: status({
        vram: { adapter: 'Example GPU', budgetMb: 8000, usedMb: null },
        llm: {
          providers: [
            {
              id: 'primary',
              kind: 'openai-compatible',
              requests: 4,
              successes: 3,
              failures: 1,
              lastError: { code: 'timeout', at: 1 },
            },
          ],
          order: ['primary'],
        },
      }),
    })
    expect(card('GPU memory').getByText('not measured')).toBeTruthy()
    expect(card('GPU memory').getByText('of 8000 MiB on Example GPU')).toBeTruthy()
    expect(card('Language models').getByText('primary')).toBeTruthy()
    expect(card('Language models').getByText('3 ok · 1 failed · last error timeout')).toBeTruthy()
  })

  it('waits politely for the first status', () => {
    renderRun({ status: null })
    expect(screen.getByText(/Waiting for the first status/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Stage' })).toBeNull()
  })
})

describe('alarms', () => {
  it('newest first, each with its level', () => {
    renderRun({
      alarms: [
        alarm({
          id: 'old',
          ts: 1_000,
          level: 'warn',
          code: 'vram_not_measured',
          message: 'draw has never been measured',
          subject: 'draw',
        }),
        alarm({
          id: 'new',
          ts: 9_000,
          level: 'error',
          code: 'plugin_failed',
          message: 'singing exited',
        }),
        alarm({ id: 'mid', ts: 5_000, level: 'info', code: 'note', message: 'just so you know' }),
      ],
    })
    const items = screen.getAllByRole('listitem').filter((li) => li.className.startsWith('alarm '))
    expect(items.map((li) => li.querySelector('strong')?.textContent)).toEqual([
      'plugin_failed',
      'note',
      'vram_not_measured',
    ])
    expect(within(items[0] as HTMLElement).getByText('error')).toBeTruthy()
    expect(within(items[1] as HTMLElement).getByText('info')).toBeTruthy()
    expect(within(items[2] as HTMLElement).getByText('warn')).toBeTruthy()
    expect(within(items[2] as HTMLElement).getByText('(draw)')).toBeTruthy()
    expect(items[0]?.className).toContain('alarm-error')
  })

  it('says so when there are none', () => {
    renderRun()
    expect(screen.getByText('No alarms.')).toBeTruthy()
  })
})

describe('the live event stream', () => {
  const events: RunEvent[] = [
    {
      ts: Date.UTC(2026, 0, 1, 12, 0, 0),
      kind: 'viewer',
      text: 'amber_fox: hello!',
      trust: 'untrusted',
    },
    { ts: Date.UTC(2026, 0, 1, 12, 0, 1), kind: 'llm', text: 'reply generated' },
    {
      ts: Date.UTC(2026, 0, 1, 12, 0, 2),
      kind: 'viewer',
      text: 'a moderator says hi',
      trust: 'trusted',
    },
    {
      ts: Date.UTC(2026, 0, 1, 12, 0, 3),
      kind: 'system',
      text: 'the host changed a setting',
      trust: 'privileged',
    },
  ]

  it("renders every line, and marks the audience's lines as untrusted (only those)", () => {
    renderRun({ events })
    const stream = screen.getByRole('list', { name: 'Live events' })
    const lines = within(stream).getAllByRole('listitem')
    expect(lines).toHaveLength(4)
    const fox = lines[0] as HTMLElement
    expect(within(fox).getByText('untrusted')).toBeTruthy()
    expect(within(fox).getByText('amber_fox: hello!')).toBeTruthy()
    expect(within(fox).getByText('viewer')).toBeTruthy()
    for (const line of lines.slice(1)) expect(within(line).queryByText('untrusted')).toBeNull()
    expect(within(stream).getAllByText('untrusted')).toHaveLength(1)
  })

  it('text is text: markup in a line is shown, not run', () => {
    const nasty =
      '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>'
    renderRun({ events: [{ ts: 1, kind: 'viewer', text: nasty, trust: 'untrusted' }] })
    const stream = screen.getByRole('list', { name: 'Live events' })
    expect(within(stream).getByText(nasty)).toBeTruthy()
    expect(stream.querySelector('img')).toBeNull()
    expect(stream.querySelector('script')).toBeNull()
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('an empty stream says so', () => {
    renderRun()
    expect(screen.getByText('Nothing yet.')).toBeTruthy()
  })

  it('follows the newest line while the reader is at the bottom, and leaves them alone when they have scrolled up', () => {
    const { rerender } = render(
      <Run api={fakeApi()} status={status()} events={events.slice(0, 2)} traces={[]} alarms={[]} />
    )
    const stream = screen.getByRole('list', { name: 'Live events' })
    let scrollHeight = 1000
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(stream, 'clientHeight', { configurable: true, get: () => 300 })
    stream.scrollTop = 700 // at the bottom
    fireEvent.scroll(stream)
    scrollHeight = 1100
    rerender(
      <Run api={fakeApi()} status={status()} events={events.slice(0, 3)} traces={[]} alarms={[]} />
    )
    expect(stream.scrollTop).toBe(1100)
    // now the reader scrolls up
    stream.scrollTop = 100
    fireEvent.scroll(stream)
    scrollHeight = 1200
    rerender(<Run api={fakeApi()} status={status()} events={events} traces={[]} alarms={[]} />)
    expect(stream.scrollTop).toBe(100)
  })
})

describe('the speech trace table', () => {
  const traces: SpeechTraceView[] = [
    {
      id: 't1',
      turn: 'u1',
      text: 'Hello there',
      audioSec: 1.2,
      synthMs: 180,
      sendMs: 195,
      startMs: 330,
      liveMotion: 'used',
    },
    { id: 't2', turn: 'u1', text: 'Still working on it' },
    {
      id: 't3',
      turn: 'u2',
      text: 'Third one',
      audioSec: 2,
      synthMs: 90,
      sendMs: 100,
      startMs: 210,
      liveMotion: 'failed',
    },
  ]

  it('one row per sentence, newest first: text, audio seconds, the three latencies and the live-motion result', () => {
    renderRun({ traces })
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    const [third, second, first] = rows.map((r) => within(r))
    expect(third?.getByText('Third one')).toBeTruthy()
    expect(third?.getByText('failed')).toBeTruthy()
    expect(third?.getByText('90 ms')).toBeTruthy()
    expect(first?.getByText('Hello there')).toBeTruthy()
    expect(first?.getByText('1.2 s')).toBeTruthy()
    expect(first?.getByText('180 ms')).toBeTruthy()
    expect(first?.getByText('195 ms')).toBeTruthy()
    expect(first?.getByText('330 ms')).toBeTruthy()
    expect(first?.getByText('used')).toBeTruthy()
    // a sentence still in progress shows dashes for what is not known yet
    expect(second?.getAllByText('-')).toHaveLength(5)
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['Sentence', 'Audio', 'Synthesis', 'Sent', 'Started', 'Live motion'])
  })

  it('says so when nothing has been said', () => {
    renderRun()
    expect(screen.getByText('No speech yet.')).toBeTruthy()
  })
})

describe('the say form', () => {
  const form = () => within(screen.getByRole('form', { name: 'Say a line' }))

  it('calls the API with a valid body and clears the text', async () => {
    const { api } = renderRun()
    fireEvent.change(form().getByLabelText('Text'), { target: { value: '  Hello, chat!  ' } })
    fireEvent.change(form().getByLabelText('Emotion'), { target: { value: 'happy' } })
    fireEvent.change(form().getByLabelText('Speed'), { target: { value: '1.25' } })
    fireEvent.change(form().getByLabelText('Style'), { target: { value: 'whisper' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Say a line' }))
    await waitFor(() => expect(api.say).toHaveBeenCalledTimes(1))
    expect(api.say).toHaveBeenCalledWith({
      text: 'Hello, chat!',
      emotion: 'happy',
      speed: 1.25,
      style: 'whisper',
    })
    expect(await screen.findByText('Sent.')).toBeTruthy()
    expect((form().getByLabelText('Text') as HTMLTextAreaElement).value).toBe('')
    // the other fields stay for the next line
    expect((form().getByLabelText('Emotion') as HTMLSelectElement).value).toBe('happy')
  })

  it('leaves out what was not filled in: no style, no speed, a neutral emotion', async () => {
    const { api } = renderRun()
    fireEvent.change(form().getByLabelText('Text'), { target: { value: 'Just text' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Say a line' }))
    await waitFor(() =>
      expect(api.say).toHaveBeenCalledWith({ text: 'Just text', emotion: 'neutral' })
    )
  })

  it('offers exactly the emotions the stage understands', () => {
    renderRun()
    const options = within(form().getByLabelText('Emotion'))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toEqual(['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'])
  })

  it.each([
    ['empty text', { text: '' }, /text/],
    ['text of spaces', { text: '   ' }, /text/],
    ['speed out of range', { text: 'x', speed: '3' }, /speed/],
    ['speed that is not a number', { text: 'x', speed: 'fast' }, /speed/],
  ])('refuses %s here, without calling the API', async (_label, fields, pattern) => {
    const { api } = renderRun()
    if ('text' in fields)
      fireEvent.change(form().getByLabelText('Text'), { target: { value: fields.text } })
    if ('speed' in fields)
      fireEvent.change(form().getByLabelText('Speed'), { target: { value: fields.speed } })
    fireEvent.submit(screen.getByRole('form', { name: 'Say a line' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(pattern)
    expect(api.say).not.toHaveBeenCalled()
  })

  it("shows the orchestrator's refusal and keeps the text so it is not lost", async () => {
    const say = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(
          'internal_error',
          'The orchestrator could not complete the request.',
          500
        )
      )
    renderRun({ api: fakeApi({ say }) })
    fireEvent.change(form().getByLabelText('Text'), { target: { value: 'keep me' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Say a line' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The orchestrator could not complete the request.'
    )
    expect((form().getByLabelText('Text') as HTMLTextAreaElement).value).toBe('keep me')
    expect(screen.queryByText('Sent.')).toBeNull()
  })

  it('Stop speech calls the API and does not touch the form', async () => {
    const { api } = renderRun()
    fireEvent.change(form().getByLabelText('Text'), { target: { value: 'half written' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop speech' }))
    await waitFor(() => expect(api.stopSpeech).toHaveBeenCalledTimes(1))
    expect(api.say).not.toHaveBeenCalled()
    expect((form().getByLabelText('Text') as HTMLTextAreaElement).value).toBe('half written')
  })

  it('a failed stop is reported', async () => {
    const stopSpeech = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError('network', 'Cannot reach the orchestrator. Is it running?', 0)
      )
    renderRun({ api: fakeApi({ stopSpeech }) })
    fireEvent.click(screen.getByRole('button', { name: 'Stop speech' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Cannot reach/)
  })
})

describe('the inject form', () => {
  const form = () => within(screen.getByRole('form', { name: 'Inject an audience event' }))
  const submit = () =>
    fireEvent.submit(screen.getByRole('form', { name: 'Inject an audience event' }))

  it('a plain danmaku: the defaults are a plausible viewer, and the body is valid', async () => {
    const { api } = renderRun()
    fireEvent.change(form().getByLabelText('Text'), { target: { value: 'hello from a test' } })
    submit()
    await waitFor(() => expect(api.inject).toHaveBeenCalledTimes(1))
    expect(api.inject).toHaveBeenCalledWith({
      kind: 'danmaku',
      name: 'tester',
      count: 1,
      text: 'hello from a test',
    })
    expect(await screen.findByText('Injected.')).toBeTruthy()
  })

  it('a gift shows the gift, count and price fields and sends them', async () => {
    const { api } = renderRun()
    fireEvent.change(form().getByLabelText('Kind'), { target: { value: 'gift' } })
    expect(form().queryByLabelText('Text')).toBeNull()
    fireEvent.change(form().getByLabelText('Name'), { target: { value: 'amber_fox' } })
    fireEvent.change(form().getByLabelText('Gift'), { target: { value: 'rocket' } })
    fireEvent.change(form().getByLabelText('Count'), { target: { value: '3' } })
    fireEvent.change(form().getByLabelText('Price (yuan)'), { target: { value: '9.9' } })
    submit()
    await waitFor(() => expect(api.inject).toHaveBeenCalledTimes(1))
    // text is not part of a gift; the schema's default (an empty string) goes along
    expect(api.inject).toHaveBeenCalledWith({
      kind: 'gift',
      name: 'amber_fox',
      text: '',
      count: 3,
      gift: 'rocket',
      price: 9.9,
    })
  })

  it('a guard takes a level, a superchat text and a price', async () => {
    const { api } = renderRun()
    fireEvent.change(form().getByLabelText('Kind'), { target: { value: 'guard' } })
    fireEvent.change(form().getByLabelText('Guard level (1 to 3)'), { target: { value: '2' } })
    expect(form().queryByLabelText('Price (yuan)')).toBeNull()
    submit()
    await waitFor(() =>
      expect(api.inject).toHaveBeenCalledWith({
        kind: 'guard',
        name: 'tester',
        text: '',
        count: 1,
        gift: '2',
      })
    )
    fireEvent.change(form().getByLabelText('Kind'), { target: { value: 'superchat' } })
    fireEvent.change(form().getByLabelText('Text'), { target: { value: 'nice stream' } })
    fireEvent.change(form().getByLabelText('Price (yuan)'), { target: { value: '30' } })
    submit()
    await waitFor(() =>
      expect(api.inject).toHaveBeenLastCalledWith({
        kind: 'superchat',
        name: 'tester',
        count: 1,
        text: 'nice stream',
        price: 30,
      })
    )
  })

  it.each([
    ['an empty name', { Name: '' }, /name/],
    ['a count of zero', { Count: '0' }, /count/],
    ['a count that is not a number', { Count: 'many' }, /count/],
    ['a count that is too high', { Count: '1000' }, /count/],
  ])('refuses %s here, without calling the API', async (_label, fields, pattern) => {
    const { api } = renderRun()
    for (const [label, value] of Object.entries(fields))
      fireEvent.change(form().getByLabelText(label), { target: { value } })
    submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(pattern)
    expect(api.inject).not.toHaveBeenCalled()
  })

  it('says the event is untrusted, like the real ones', () => {
    renderRun()
    expect(screen.getByText(/as untrusted text from a viewer/)).toBeTruthy()
  })

  it("shows the orchestrator's refusal", async () => {
    const inject = vi
      .fn()
      .mockRejectedValue(new ApiClientError('invalid_request', 'name: Too small', 400))
    renderRun({ api: fakeApi({ inject }) })
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe('name: Too small')
  })
})
