import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ModeView } from '@animatus/protocol'
import { ApiClientError } from '../src/api.ts'
import { Modes, verdictReason } from '../src/Modes.tsx'
import { fakeApi, mode, verdict } from './helpers.tsx'
import type { MockedApi } from './helpers.tsx'

const DRAW_REASON = 'draw: about 9800 MiB needed, 7488 MiB usable of 8000 (not measured)'

const MODES: ModeView[] = [
  mode({
    id: 'dance',
    title: 'Dance',
    admission: verdict(true, ['dance: fits on estimates only; not measured'], { measured: false }),
    hotkey: 'ctrl+alt+d',
    exclusive_with: ['sing'],
    services: ['tts', 'motion'],
  }),
  mode({
    id: 'draw',
    title: 'Draw on request',
    admission: verdict(false, [DRAW_REASON], { totalMb: 9800, measured: false }),
    hotkey: 'ctrl+alt+p',
    services: ['tts', 'image'],
  }),
  mode({
    id: 'sing',
    title: 'Sing',
    state: 'ACTIVE',
    admission: verdict(true),
    pairs: { draw: verdict(false, ['sing and draw exclude each other']), dance: verdict(true) },
  }),
  mode({ id: 'sleep', title: 'Sleep', priority: 100, preempts: true, admission: verdict(true) }),
]

function renderModes(
  over: {
    api?: MockedApi
    modes?: ModeView[]
    onChange?: (m: ModeView) => void
    onRefresh?: (m: ModeView[]) => void
  } = {}
) {
  const api = over.api ?? fakeApi()
  const onChange = over.onChange ?? vi.fn()
  const onRefresh = over.onRefresh ?? vi.fn()
  render(<Modes api={api} modes={over.modes ?? MODES} onChange={onChange} onRefresh={onRefresh} />)
  return { api, onChange, onRefresh }
}

const card = (title: string) => within(screen.getByRole('article', { name: title }))

describe('a mode that does not fit', () => {
  it('has its Enter button disabled, with the reason as its tooltip and as visible text', () => {
    renderModes()
    const draw = card('Draw on request')
    const button = draw.getByRole('button', { name: /Enter/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe(DRAW_REASON)
    // visible text, in the card, and tied to the button for screen readers
    const why = draw.getByText(DRAW_REASON)
    expect(why.textContent).toContain(DRAW_REASON)
    expect(button.getAttribute('aria-describedby')).toBe(why.closest('[id]')?.id)
    expect(draw.getByText('Blocked:')).toBeTruthy()
  })

  it('cannot be entered by clicking the disabled button', () => {
    const { api } = renderModes()
    fireEvent.click(card('Draw on request').getByRole('button', { name: /Enter/ }))
    expect(api.modeAction).not.toHaveBeenCalled()
  })

  it('still says why when the verdict came with no reasons', () => {
    renderModes({ modes: [mode({ id: 'x', title: 'Mystery', admission: verdict(false, []) })] })
    const button = card('Mystery').getByRole('button', { name: /Enter/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('This mode does not fit in GPU memory right now.')
    expect(card('Mystery').getByText(/does not fit in GPU memory/)).toBeTruthy()
    expect(verdictReason(verdict(false, ['a', 'b']))).toBe('a b')
  })

  it('a mode that fits has an enabled button and no tooltip', () => {
    renderModes()
    const button = card('Dance').getByRole('button', { name: /Enter/ }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.title).toBe('')
    expect(button.getAttribute('aria-describedby')).toBeNull()
  })

  it('a mode with no verdict yet is not blocked, and says it was not checked', () => {
    renderModes({ modes: [mode({ id: 'x', title: 'Unchecked' })] })
    expect(
      (card('Unchecked').getByRole('button', { name: /Enter/ }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(card('Unchecked').getByText(/has not been checked/)).toBeTruthy()
  })
})

describe('what a card shows', () => {
  it('state, priority, services, exclusions, shortcut and the verdict', () => {
    renderModes()
    const dance = card('Dance')
    expect(dance.getByText('IDLE')).toBeTruthy()
    expect(dance.getByText('50')).toBeTruthy()
    expect(dance.getByText('tts, motion')).toBeTruthy()
    expect(dance.getByText('sing')).toBeTruthy()
    expect(dance.getByText('ctrl+alt+d').tagName).toBe('KBD')
    expect(dance.getByText(/Fits:/)).toBeTruthy()
    expect(dance.getByText(/about 3400 of 8000 MiB, not measured/)).toBeTruthy()
    expect(dance.getByText('dance: fits on estimates only; not measured')).toBeTruthy()
    expect(card('Sleep').getByText(/interrupts everything else/)).toBeTruthy()
    expect(card('Sing').getByText('ACTIVE')).toBeTruthy()
  })

  it("lists the pairs that do not fit, by the other mode's title, and leaves out the ones that do", () => {
    renderModes()
    const sing = card('Sing')
    expect(sing.getByText('Does not fit together with:')).toBeTruthy()
    const item = sing.getByText('Draw on request').closest('li') as HTMLElement
    expect(item.textContent).toContain('sing and draw exclude each other')
    expect(sing.queryByText('Dance')).toBeNull()
    expect(card('Dance').queryByText('Does not fit together with:')).toBeNull()
  })

  it('an active mode offers Exit instead of Enter', () => {
    renderModes()
    expect(card('Sing').queryByRole('button', { name: /Enter/ })).toBeNull()
    expect((card('Sing').getByRole('button', { name: 'Exit' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it('a mode on its way in or out cannot be entered again', () => {
    renderModes({
      modes: [
        mode({ id: 'a', title: 'Coming', state: 'STARTING' }),
        mode({ id: 'b', title: 'Going', state: 'STOPPING' }),
      ],
    })
    expect(
      (card('Coming').getByRole('button', { name: 'Starting...' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (card('Going').getByRole('button', { name: 'Stopping...' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('says so when there are no modes', () => {
    renderModes({ modes: [] })
    expect(screen.getByText('No modes are installed.')).toBeTruthy()
  })
})

describe('entering and leaving', () => {
  it('Enter asks the orchestrator, plain by default, and hands the result on', async () => {
    const { api, onChange } = renderModes()
    fireEvent.click(card('Dance').getByRole('button', { name: /Enter/ }))
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    expect(api.modeAction).toHaveBeenCalledWith('dance', 'enter', { replace: false, force: false })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'dance', state: 'ACTIVE' }))
  })

  it('never sends force: there is no way round the admission check from this page', async () => {
    const { api } = renderModes()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(card('Dance').getByRole('button', { name: /Enter/ }))
    await waitFor(() => expect(api.modeAction).toHaveBeenCalled())
    for (const call of api.modeAction.mock.calls) expect(call[2]).toMatchObject({ force: false })
  })

  it('the replace option is off by default, and turns into replace: true when ticked', async () => {
    const { api } = renderModes()
    const box = screen.getByRole('checkbox', {
      name: /Replace conflicting modes/,
    }) as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(box.checked).toBe(true)
    expect(card('Dance').getByRole('button', { name: 'Enter (replace)' })).toBeTruthy()
    fireEvent.click(card('Dance').getByRole('button', { name: /Enter/ }))
    await waitFor(() =>
      expect(api.modeAction).toHaveBeenCalledWith('dance', 'enter', { replace: true, force: false })
    )
  })

  it('Exit asks to leave', async () => {
    const { api, onChange } = renderModes()
    fireEvent.click(card('Sing').getByRole('button', { name: 'Exit' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(api.modeAction).toHaveBeenCalledWith('sing', 'exit', { replace: false, force: false })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'sing', state: 'IDLE' }))
  })

  it("a refusal by the orchestrator is shown with the mode's name, in its own words", async () => {
    const modeAction = vi
      .fn()
      .mockRejectedValue(new ApiClientError('excluded', 'sing excludes dance (active)', 409))
    const { onChange } = renderModes({ api: fakeApi({ modeAction }) })
    fireEvent.click(card('Dance').getByRole('button', { name: /Enter/ }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Dance: sing excludes dance (active)'
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('only one request at a time: every button waits while one is running', async () => {
    let release: (view: ModeView) => void = () => undefined
    const modeAction = vi.fn(() => new Promise<ModeView>((resolve) => (release = resolve)))
    renderModes({ api: fakeApi({ modeAction }) })
    fireEvent.click(card('Dance').getByRole('button', { name: /Enter/ }))
    await waitFor(() =>
      expect(
        (card('Sleep').getByRole('button', { name: /Enter/ }) as HTMLButtonElement).disabled
      ).toBe(true)
    )
    expect((card('Sing').getByRole('button', { name: 'Exit' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    release(mode({ id: 'dance', state: 'ACTIVE' }))
    await waitFor(() =>
      expect(
        (card('Sleep').getByRole('button', { name: /Enter/ }) as HTMLButtonElement).disabled
      ).toBe(false)
    )
  })

  it('Refresh reads the list again and hands it on', async () => {
    const fresh = [mode({ id: 'only', title: 'Only' })]
    const { api, onRefresh } = renderModes({ api: fakeApi({ modes: async () => fresh }) })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(fresh))
    expect(api.modes).toHaveBeenCalledTimes(1)
  })
})

describe('what a mode shows and offers by itself', () => {
  const PANEL = {
    status: 'dancing "Aipao"',
    facts: [{ label: 'Cooldown', value: '180 s after each dance' }],
    actions: [
      { id: 'stop', label: 'Stop the dance', inputs: [], confirm: 'Stop it?' },
      {
        id: 'tune',
        label: 'Tune',
        inputs: [
          {
            name: 'offset',
            label: 'Motion offset (s)',
            kind: 'number' as const,
            min: -30,
            max: 30,
            step: 0.05,
            value: 1,
          },
          { name: 'speed', label: 'Speed', kind: 'number' as const, value: 1.2 },
        ],
      },
    ],
    sections: [
      {
        title: 'Dances',
        empty: 'No dance folders.',
        rows: [
          {
            id: 'aipao',
            text: 'Aipao',
            detail: '141 BPM',
            active: true,
            actions: [
              { id: 'play', label: 'Play', inputs: [], disabled: 'a dance is already running' },
              { id: 'trial', label: 'Trial run', inputs: [] },
            ],
          },
          {
            id: 'otagei',
            text: 'Otagei',
            active: false,
            actions: [{ id: 'play', label: 'Play', inputs: [] }],
          },
        ],
      },
    ],
  }
  const withPanel = (panel: unknown = PANEL) => [
    mode({ id: 'dance', title: 'Dance', state: 'ACTIVE', admission: verdict(true), panel }),
  ]

  it('draws the status, the facts, the buttons and the rows, and marks the row that is current', () => {
    renderModes({ modes: withPanel() })
    const dance = card('Dance')
    expect(dance.getByText('dancing "Aipao"')).toBeTruthy()
    expect(dance.getByText('180 s after each dance')).toBeTruthy()
    expect(dance.getByRole('button', { name: 'Stop the dance' })).toBeTruthy()
    expect(dance.getByText('Aipao').closest('li')?.className).toContain('panel-row-active')
    expect(dance.getByText('now')).toBeTruthy()
    expect(dance.getByText('141 BPM')).toBeTruthy()
  })

  it('a button that is off says why, as its tooltip and as visible text, and does nothing when clicked', () => {
    const { api } = renderModes({ modes: withPanel() })
    const play = card('Dance').getAllByRole('button', { name: 'Play' })[0] as HTMLButtonElement
    expect(play.disabled).toBe(true)
    expect(play.title).toBe('a dance is already running')
    expect(card('Dance').getByText('a dance is already running')).toBeTruthy()
    fireEvent.click(play)
    expect(api.modeAction).not.toHaveBeenCalled()
  })

  it('a row button sends the action, the row and nothing else', async () => {
    const { api, onChange } = renderModes({ modes: withPanel() })
    fireEvent.click(card('Dance').getByRole('button', { name: 'Trial run' }))
    await waitFor(() => expect(api.modeAction).toHaveBeenCalled())
    expect(api.modeAction).toHaveBeenCalledWith('dance', 'act', {
      replace: false,
      force: false,
      params: { action: 'trial', row: 'aipao' },
    })
    await waitFor(() => expect(onChange).toHaveBeenCalled())
  })

  it('a button with inputs sends what the fields hold, numbers as numbers', async () => {
    const { api } = renderModes({ modes: withPanel() })
    const dance = card('Dance')
    fireEvent.change(dance.getByLabelText('Motion offset (s)'), { target: { value: '2.5' } })
    fireEvent.change(dance.getByLabelText('Speed'), { target: { value: '0.9' } })
    fireEvent.click(dance.getByRole('button', { name: 'Tune' }))
    await waitFor(() => expect(api.modeAction).toHaveBeenCalled())
    expect(api.modeAction).toHaveBeenCalledWith('dance', 'act', {
      replace: false,
      force: false,
      params: { action: 'tune', offset: 2.5, speed: 0.9 },
    })
  })

  it('asks before something that says it must be confirmed, and does nothing on no', async () => {
    const { api } = renderModes({ modes: withPanel() })
    // happy-dom has no window.confirm
    const ask = vi.fn().mockReturnValue(false)
    const had = Object.getOwnPropertyDescriptor(window, 'confirm')
    Object.defineProperty(window, 'confirm', { value: ask, configurable: true, writable: true })
    fireEvent.click(card('Dance').getByRole('button', { name: 'Stop the dance' }))
    expect(ask).toHaveBeenCalledWith('Stop it?')
    expect(api.modeAction).not.toHaveBeenCalled()
    ask.mockReturnValue(true)
    fireEvent.click(card('Dance').getByRole('button', { name: 'Stop the dance' }))
    await waitFor(() => expect(api.modeAction).toHaveBeenCalled())
    expect(api.modeAction).toHaveBeenCalledWith('dance', 'act', {
      replace: false,
      force: false,
      params: { action: 'stop' },
    })
    if (had) Object.defineProperty(window, 'confirm', had)
    else Reflect.deleteProperty(window, 'confirm')
  })

  it('a refusal from the mode is shown, and an empty list says what it is waiting for', async () => {
    const api = fakeApi({
      modeAction: vi.fn(async () => {
        throw new ApiClientError('refused', 'no dance is running', 409)
      }),
    })
    renderModes({
      api,
      modes: withPanel({
        ...PANEL,
        sections: [{ title: 'Dances', empty: 'No dance folders.', rows: [] }],
      }),
    })
    expect(card('Dance').getByText('No dance folders.')).toBeTruthy()
    fireEvent.click(card('Dance').getByRole('button', { name: 'Tune' }))
    expect(await screen.findByText(/no dance is running/)).toBeTruthy()
  })

  it('selects, toggles and text fields send their values; a picture is fetched from the stage server', async () => {
    const api = fakeApi()
    render(
      <Modes
        api={api}
        modes={withPanel({
          image: '/asset/generated/a%20b.png',
          actions: [
            {
              id: 'pick',
              label: 'Apply',
              inputs: [
                {
                  name: 'window',
                  label: 'Window',
                  kind: 'select',
                  options: [
                    { value: 'w1', label: 'Game' },
                    { value: 'w2', label: 'Chat' },
                  ],
                  value: 'w1',
                },
                { name: 'pause', label: 'Pause', kind: 'toggle', value: false },
                { name: 'note', label: 'Note', kind: 'text', value: '' },
              ],
            },
          ],
        })}
        onChange={vi.fn()}
        onRefresh={vi.fn()}
        assetBase="http://127.0.0.1:5810"
      />
    )
    const dance = card('Dance')
    const img = dance.getByRole('img', { name: /shows now/ }) as HTMLImageElement
    expect(img.src).toBe('http://127.0.0.1:5810/asset/generated/a%20b.png')
    fireEvent.change(dance.getByLabelText('Window'), { target: { value: 'w2' } })
    fireEvent.click(dance.getByLabelText('Pause'))
    fireEvent.change(dance.getByLabelText('Note'), { target: { value: 'hi' } })
    fireEvent.click(dance.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(api.modeAction).toHaveBeenCalled())
    expect(api.modeAction).toHaveBeenCalledWith('dance', 'act', {
      replace: false,
      force: false,
      params: { action: 'pick', window: 'w2', pause: true, note: 'hi' },
    })
  })

  it('a mode with no panel shows none', () => {
    renderModes({ modes: [mode({ id: 'x', title: 'Plain', admission: verdict(true) })] })
    expect(card('Plain').queryByLabelText('Mode details')).toBeNull()
  })
})
