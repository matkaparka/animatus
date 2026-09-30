import { describe, expect, it } from 'vitest'
import {
  ApiError,
  CONSOLE_MAX_BODY_BYTES,
  CONSOLE_STATUS_INTERVAL_MS,
  CONSOLE_SUBPROTOCOL,
  CONSOLE_TOKEN_PROTOCOL_PREFIX,
  CONSOLE_WS_PATH,
  ConfigResponse,
  ConsoleEvent,
  ConsoleToken,
  EventsResponse,
  InjectRequest,
  ModeAction,
  ModePanel,
  ModeRequest,
  ModeView,
  ModesResponse,
  OkResponse,
  PluginAction,
  PluginsResponse,
  SayRequest,
  SecretName,
  SecretPut,
  SecretsResponse,
  StatusView,
  TracesResponse,
} from '../src/index.ts'

describe('console API schemas', () => {
  it('SayRequest defaults the emotion and bounds the text and speed', () => {
    expect(SayRequest.parse({ text: 'hello' })).toEqual({ text: 'hello', emotion: 'neutral' })
    expect(SayRequest.safeParse({ text: '' }).success).toBe(false)
    expect(SayRequest.safeParse({ text: 'x'.repeat(501) }).success).toBe(false)
    expect(SayRequest.safeParse({ text: 'x', speed: 3 }).success).toBe(false)
    expect(SayRequest.safeParse({ text: 'x', emotion: 'whisper' }).success).toBe(false)
  })

  it('InjectRequest fills a plausible fake danmaku', () => {
    expect(InjectRequest.parse({})).toMatchObject({ kind: 'danmaku', name: 'tester', count: 1 })
    expect(InjectRequest.safeParse({ kind: 'nope' }).success).toBe(false)
  })

  it('secret names are constrained and values are required but never echoed by any schema here', () => {
    expect(SecretName.safeParse('gemini').success).toBe(true)
    expect(SecretName.safeParse('Gemini').success).toBe(false)
    expect(SecretName.safeParse('../x').success).toBe(false)
    expect(SecretPut.safeParse({ value: '' }).success).toBe(false)
    expect(SecretPut.safeParse({ value: 'v' }).success).toBe(true)
  })

  it('ModeRequest defaults to a plain entry', () => {
    expect(ModeRequest.parse({})).toEqual({ replace: false, force: false })
  })

  it('ModeRequest carries mode-specific details, and only scalars, a bounded few', () => {
    const ok = ModeRequest.parse({ params: { name: 'aipao', speed: 1.2, trial: true } })
    expect(ok.params).toEqual({ name: 'aipao', speed: 1.2, trial: true })
    expect(ModeRequest.safeParse({ params: { nested: { a: 1 } } }).success).toBe(false)
    expect(ModeRequest.safeParse({ params: { list: [1] } }).success).toBe(false)
    expect(ModeRequest.safeParse({ params: { text: 'x'.repeat(201) } }).success).toBe(false)
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['k' + i, i]))
    expect(ModeRequest.safeParse({ params: many }).success).toBe(false)
    expect(ModeRequest.safeParse({ params: { ['k'.repeat(41)]: 1 } }).success).toBe(false)
  })

  it('a mode panel fills in what is left out and refuses what the console cannot draw', () => {
    const p = ModePanel.parse({
      status: 'ready',
      actions: [{ id: 'stop', label: 'Stop' }],
      sections: [
        {
          title: 'Songs',
          rows: [
            {
              id: 'a',
              text: 'A song',
              actions: [{ id: 'skip', label: 'Skip', confirm: 'Skip it?' }],
            },
          ],
        },
      ],
    })
    expect(p.facts).toEqual([])
    expect(p.actions[0]).toEqual({ id: 'stop', label: 'Stop', inputs: [] })
    expect(p.sections[0]!.rows[0]).toMatchObject({ active: false })
    expect(ModePanel.parse({}).sections).toEqual([])
    const withInput = ModePanel.safeParse({
      actions: [
        {
          id: 'size',
          label: 'Set',
          inputs: [
            {
              name: 'side',
              label: 'Longest side',
              kind: 'number',
              min: 512,
              step: 64,
              value: 1024,
            },
          ],
        },
      ],
    })
    expect(withInput.success).toBe(true)
    for (const bad of [
      { actions: [{ id: 'Bad Id', label: 'x' }] },
      { actions: [{ id: 'ok', label: 'x', inputs: [{ name: 'a', label: 'a', kind: 'colour' }] }] },
      { actions: Array.from({ length: 13 }, (_, i) => ({ id: 'a' + i, label: 'x' })) },
      { sections: [{ title: 't', rows: [{ id: '', text: 'x' }] }] },
      { facts: [{ label: 'x'.repeat(61), value: 'v' }] },
    ])
      expect(ModePanel.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })

  it('a mode view carries an optional panel', () => {
    const base = {
      id: 'dance',
      title: 'Dance',
      state: 'IDLE',
      since: 1,
      priority: 60,
      exclusive_with: [],
      services: [],
    }
    expect(ModeView.parse(base).panel).toBeUndefined()
    expect(ModeView.parse({ ...base, panel: { status: 'ready' } }).panel?.status).toBe('ready')
  })

  it('StatusView accepts a minimal status', () => {
    const s = StatusView.parse({
      api: 1,
      version: '0.1.0',
      startedAt: 1,
      now: 2,
      stage: { connected: false },
      speech: { speaking: false, pending: 0, held: false },
      plugins: [],
      modes: [],
      llm: { providers: [], order: [] },
      alarms: [],
    })
    expect(s.stage.connected).toBe(false)
  })

  it('ConsoleEvent is a closed set', () => {
    expect(ConsoleEvent.safeParse({ type: 'hello', api: 1, now: 1 }).success).toBe(true)
    expect(
      ConsoleEvent.safeParse({
        type: 'run',
        event: { ts: 1, kind: 'viewer', text: 'hi', trust: 'untrusted' },
      }).success
    ).toBe(true)
    expect(ConsoleEvent.safeParse({ type: 'exec', cmd: 'x' }).success).toBe(false)
  })
})

describe('console API additions', () => {
  it('the transport constants are the ones the docs promise', () => {
    expect(CONSOLE_SUBPROTOCOL).toBe('animatus.console.v1')
    expect(CONSOLE_WS_PATH).toBe('/api/ws')
    expect(CONSOLE_TOKEN_PROTOCOL_PREFIX).toBe('token.')
    expect(CONSOLE_MAX_BODY_BYTES).toBe(65536)
    expect(CONSOLE_STATUS_INTERVAL_MS).toBe(2000)
  })

  it('ConsoleToken only allows characters that survive a URL fragment and a header token', () => {
    expect(ConsoleToken.safeParse('A'.repeat(43)).success).toBe(true)
    expect(ConsoleToken.safeParse('abc_DEF-123.~xyz').success).toBe(true)
    for (const bad of [
      '',
      'short',
      'has space in it',
      'a'.repeat(129),
      'semi;colon-token',
      'comma,token-value',
      'quote"token-value',
      'ünïcode-token-value',
    ]) {
      expect(ConsoleToken.safeParse(bad).success, bad).toBe(false)
    }
  })

  it('action enums are closed', () => {
    expect(PluginAction.options).toEqual(['start', 'stop', 'restart'])
    expect(ModeAction.options).toEqual(['enter', 'exit', 'act'])
    expect(PluginAction.safeParse('kill').success).toBe(false)
    expect(ModeAction.safeParse('force').success).toBe(false)
  })

  it('list responses are objects, never bare arrays', () => {
    expect(PluginsResponse.safeParse([]).success).toBe(false)
    expect(ModesResponse.safeParse([]).success).toBe(false)
    expect(SecretsResponse.safeParse([]).success).toBe(false)
    expect(EventsResponse.safeParse([]).success).toBe(false)
    expect(TracesResponse.safeParse([]).success).toBe(false)
    expect(PluginsResponse.parse({ plugins: [] })).toEqual({ plugins: [] })
    expect(ModesResponse.parse({ modes: [] })).toEqual({ modes: [] })
  })

  it('a secret list carries names, a set flag and a source, and drops anything else it is handed', () => {
    const parsed = SecretsResponse.parse({
      secrets: [{ name: 'gemini', set: true, source: 'dpapi', value: 'must-not-survive-parsing' }],
    })
    expect(parsed).toEqual({ secrets: [{ name: 'gemini', set: true, source: 'dpapi' }] })
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive-parsing')
  })

  it('events and traces responses validate their items', () => {
    expect(
      EventsResponse.safeParse({
        events: [{ ts: 1, kind: 'viewer', text: 'hi', trust: 'untrusted' }],
      }).success
    ).toBe(true)
    expect(
      EventsResponse.safeParse({ events: [{ ts: 1, kind: 'nope', text: 'hi' }] }).success
    ).toBe(false)
    expect(
      TracesResponse.safeParse({
        traces: [{ id: 't1', turn: 'u1', text: 'hello', liveMotion: 'used' }],
      }).success
    ).toBe(true)
    expect(
      TracesResponse.safeParse({
        traces: [{ id: 't1', turn: 'u1', text: 'hello', liveMotion: 'maybe' }],
      }).success
    ).toBe(false)
  })

  it('OkResponse is exactly { ok: true }; ConfigResponse wraps a plain object', () => {
    expect(OkResponse.parse({ ok: true })).toEqual({ ok: true })
    expect(OkResponse.safeParse({ ok: false }).success).toBe(false)
    expect(ConfigResponse.safeParse({ config: { a: 1, nested: { b: [1, 2] } } }).success).toBe(true)
    expect(ConfigResponse.safeParse({ config: [] }).success).toBe(false)
    expect(ConfigResponse.safeParse({ config: 'x' }).success).toBe(false)
  })

  it('ApiError bounds code and message so a server can always produce a valid one', () => {
    expect(
      ApiError.safeParse({ error: { code: 'x'.repeat(64), message: 'm'.repeat(600) } }).success
    ).toBe(true)
    expect(ApiError.safeParse({ error: { code: 'x'.repeat(65), message: 'm' } }).success).toBe(
      false
    )
    expect(ApiError.safeParse({ error: { code: 'x', message: 'm'.repeat(601) } }).success).toBe(
      false
    )
  })

  it('ModeRequest and SayRequest keep their defaults', () => {
    expect(ModeRequest.parse({ replace: true })).toEqual({ replace: true, force: false })
    expect(SayRequest.parse({ text: 'a', speed: 1.5 })).toEqual({
      text: 'a',
      emotion: 'neutral',
      speed: 1.5,
    })
  })
})
