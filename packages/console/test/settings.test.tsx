import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiClientError } from '../src/api.ts'
import { Settings } from '../src/Settings.tsx'
import { fakeApi } from './helpers.tsx'

const CONFIG = {
  version: '0.1.0',
  llm: {
    order: ['primary', 'fallback'],
    providers: [
      {
        id: 'primary',
        kind: 'openai-compatible',
        model: 'example-model',
        max_tokens: 400,
        api_key: '[redacted]',
      },
      { id: 'fallback', kind: 'gemini' },
    ],
  },
  vram: { budget_mb: 8000, margin_mb: 512 },
  flags: { enabled: true, note: null },
}

async function renderSettings(config: Record<string, unknown> = CONFIG) {
  const api = fakeApi({ config: async () => config })
  render(<Settings api={api} />)
  await screen.findByLabelText('Configuration')
  return api
}

describe('the settings page', () => {
  it('says it is read-only for now and that editing comes later', async () => {
    await renderSettings()
    expect(screen.getByText(/read-only for now/)).toBeTruthy()
    expect(screen.getByText(/Editing settings from the console comes later/)).toBeTruthy()
    // read-only means there is nothing to type into
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  })

  it('shows the configuration as collapsible groups, the top level open and the rest folded', async () => {
    await renderSettings()
    const tree = screen.getByLabelText('Configuration')
    const groups = [...tree.querySelectorAll('details')]
    const top = groups.filter((d) => d.parentElement === tree)
    expect(top.map((d) => d.querySelector('summary')?.firstChild?.textContent?.trim())).toEqual([
      'llm',
      'vram',
      'flags',
    ])
    expect(top.every((d) => d.open)).toBe(true)
    const nested = groups.filter((d) => d.parentElement !== tree)
    expect(nested.length).toBeGreaterThan(0)
    expect(nested.every((d) => !d.open)).toBe(true)
    // "order" and "providers" are lists of two
    expect(within(tree).getAllByText('list of 2', { exact: false })).toHaveLength(2)
  })

  it('leaf values are shown as they are: strings quoted, numbers, booleans and null plain', async () => {
    await renderSettings()
    const tree = screen.getByLabelText('Configuration')
    const row = (name: string) =>
      [...tree.querySelectorAll('.kv')]
        .find((kv) => kv.querySelector('.k')?.textContent === name)
        ?.querySelector('.v')?.textContent
    expect(row('version')).toBe('"0.1.0"')
    expect(row('budget_mb')).toBe('8000')
    expect(row('enabled')).toBe('true')
    expect(row('note')).toBe('null')
    expect(row('model')).toBe('"example-model"')
  })

  it('a masked value is shown as the mask', async () => {
    await renderSettings()
    expect(screen.getByText('"[redacted]"')).toBeTruthy()
  })

  it('markup in a value is text, not markup', async () => {
    await renderSettings({
      banner: '<img src=x onerror="window.__pwned = true">',
      nested: { html: '<script>window.__pwned = true</script>' },
    })
    const tree = screen.getByLabelText('Configuration')
    expect(tree.querySelector('img')).toBeNull()
    expect(tree.querySelector('script')).toBeNull()
    expect(within(tree).getByText('"<img src=x onerror=\\"window.__pwned = true\\">"')).toBeTruthy()
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('a very large list is cut off with a note', async () => {
    await renderSettings({ big: Array.from({ length: 250 }, (_, i) => i) })
    expect(screen.getByText('50 more not shown.')).toBeTruthy()
    expect(screen.getAllByText(/^\d+$/, { selector: '.v' })).toHaveLength(200)
  })

  it('a very deep object is cut off with a note', async () => {
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 12; i++) deep = { next: deep }
    await renderSettings({ deep })
    expect(screen.getByText('Nested too deeply to show here.')).toBeTruthy()
  })

  it('says so when the configuration is empty', async () => {
    await renderSettings({})
    expect(screen.getByText('The configuration is empty.')).toBeTruthy()
  })

  it('a failure to load is shown, and Refresh tries again', async () => {
    const config = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError(
          'internal_error',
          'The orchestrator could not complete the request.',
          500
        )
      )
      .mockResolvedValue({ a: 1 })
    render(<Settings api={fakeApi({ config })} />)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The orchestrator could not complete the request.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    await screen.findByText('"a"', { exact: false }).catch(() => undefined)
    expect(config).toHaveBeenCalledTimes(2)
    expect(screen.getByText('a')).toBeTruthy()
  })

  it('reads the configuration once on opening', async () => {
    const api = await renderSettings()
    expect(api.config).toHaveBeenCalledTimes(1)
  })
})
