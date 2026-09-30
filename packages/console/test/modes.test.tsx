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
