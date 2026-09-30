import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SecretView } from '@animatus/protocol'
import { ApiClientError, createApi } from '../src/api.ts'
import { Keys } from '../src/Keys.tsx'
import { SECRET_VALUE, TOKEN, fakeApi } from './helpers.tsx'

const LIST: SecretView[] = [
  { name: 'gemini', set: true, source: 'dpapi' },
  { name: 'openai_compat', set: false, source: 'dpapi' },
  { name: 'search_api', set: true, source: 'environment' },
]

async function renderKeys(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({ secrets: async () => LIST, ...over })
  const view = render(<Keys api={api} />)
  await screen.findByText('gemini')
  return { api, ...view }
}

/** Opens the form of one key and returns its (password) input. */
async function openForm(name: string, verb: 'set' | 'replace' = 'set') {
  fireEvent.click(screen.getByRole('button', { name: `${verb} ${name}` }))
  return (await screen.findByLabelText(`New value for ${name}`)) as HTMLInputElement
}

/** Everything a person could see or a script could read from the page, in one string. */
function pageDump(): string {
  const values = [...document.querySelectorAll('input, textarea, select')].map(
    (el) => (el as HTMLInputElement).value
  )
  const attributes = [...document.querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].map((a) => `${a.name}=${a.value}`)
  )
  return [document.body.innerHTML, document.body.textContent, ...values, ...attributes].join('\n')
}

function submit(input: HTMLInputElement) {
  fireEvent.submit(input.form as HTMLFormElement)
}

describe('the list', () => {
  it('shows each key with whether it is set and where it lives', async () => {
    await renderKeys()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    const gemini = within(rows[0] as HTMLElement)
    expect(gemini.getByText('gemini')).toBeTruthy()
    expect(gemini.getByText('set')).toBeTruthy()
    expect(gemini.getByText('dpapi')).toBeTruthy()
    const openai = within(rows[1] as HTMLElement)
    expect(openai.getByText('not set')).toBeTruthy()
    expect(within(rows[2] as HTMLElement).getByText('environment')).toBeTruthy()
  })

  it('says, in words, that values are write-only and never shown', async () => {
    await renderKeys()
    expect(screen.getByText(/Values are write-only/)).toBeTruthy()
    expect(screen.getByText(/never shown again/)).toBeTruthy()
  })

  it('a key that is not set offers Set, one that is offers Replace and Delete', async () => {
    await renderKeys()
    expect(screen.getByRole('button', { name: 'set openai_compat' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'delete openai_compat' })).toBeNull()
    expect(screen.getByRole('button', { name: 'replace gemini' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'delete gemini' })).toBeTruthy()
  })

  it('reports a failure to load, and Refresh tries again', async () => {
    const secrets = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError('network', 'Cannot reach the orchestrator. Is it running?', 0)
      )
      .mockResolvedValue(LIST)
    render(<Keys api={fakeApi({ secrets })} />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/Cannot reach the orchestrator/)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByText('gemini')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(secrets).toHaveBeenCalledTimes(2)
  })

  it('an empty list says so', async () => {
    render(<Keys api={fakeApi({ secrets: async () => [] })} />)
    expect(await screen.findByText(/No keys are known yet/)).toBeTruthy()
  })
})

describe('setting a key', () => {
  it('uses a password field that the browser is told not to remember', async () => {
    await renderKeys()
    const input = await openForm('openai_compat')
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('new-password')
    expect(input.getAttribute('value')).toBeNull()
    expect(input.form?.getAttribute('autocomplete')).toBe('off')
  })

  it('sends exactly what was typed, then shows the new state and no trace of the value', async () => {
    const { api } = await renderKeys()
    const input = await openForm('openai_compat')
    fireEvent.change(input, { target: { value: SECRET_VALUE } })
    expect(input.value).toBe(SECRET_VALUE) // still there while it is being typed
    submit(input)
    await screen.findByText(/Saved openai_compat/)

    expect(api.putSecret).toHaveBeenCalledTimes(1)
    expect(api.putSecret).toHaveBeenCalledWith('openai_compat', SECRET_VALUE)
    // the row now says set, the form is gone, and nowhere on the page is the value
    const row = screen.getByText('openai_compat').closest('tr') as HTMLElement
    expect(within(row).getByText('set')).toBeTruthy()
    expect(screen.queryByLabelText('New value for openai_compat')).toBeNull()
    expect(pageDump()).not.toContain(SECRET_VALUE)
    expect(screen.getByText(/cannot be read back/)).toBeTruthy()
  })

  it('wipes the field the moment it is submitted, before the answer is in', async () => {
    let answer: (view: SecretView) => void = () => undefined
    const putSecret = vi.fn(() => new Promise<SecretView>((resolve) => (answer = resolve)))
    await renderKeys({ putSecret })
    const input = await openForm('openai_compat')
    fireEvent.change(input, { target: { value: SECRET_VALUE } })
    submit(input)
    expect(input.value).toBe('')
    expect(pageDump()).not.toContain(SECRET_VALUE)
    expect(putSecret).toHaveBeenCalledWith('openai_compat', SECRET_VALUE)
    answer({ name: 'openai_compat', set: true, source: 'dpapi' })
    await screen.findByText(/Saved openai_compat/)
  })

  it("a refusal is shown in the server's words; the field stays empty and the value appears nowhere", async () => {
    const putSecret = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(
          'read_only',
          'this key comes from the process environment and cannot be changed here',
          409
        )
      )
    await renderKeys({ putSecret })
    const input = await openForm('search_api', 'replace')
    fireEvent.change(input, { target: { value: SECRET_VALUE } })
    submit(input)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'this key comes from the process environment and cannot be changed here'
    )
    expect(input.value).toBe('')
    expect(pageDump()).not.toContain(SECRET_VALUE)
    // the form is still open for another try
    expect(screen.getByLabelText('New value for search_api')).toBe(input)
  })

  it('a failure that is not an ApiClientError gets a generic message, never the raw error', async () => {
    const putSecret = vi.fn().mockRejectedValue(new Error(`boom with ${SECRET_VALUE}`))
    await renderKeys({ putSecret })
    const input = await openForm('openai_compat')
    fireEvent.change(input, { target: { value: SECRET_VALUE } })
    submit(input)
    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong.')
    expect(pageDump()).not.toContain(SECRET_VALUE)
  })

  it('an empty submit asks for a value and sends nothing', async () => {
    const { api } = await renderKeys()
    const input = await openForm('openai_compat')
    submit(input)
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a value first.')
    expect(api.putSecret).not.toHaveBeenCalled()
  })

  it('a value over the limit is refused here, without repeating it', async () => {
    const { api } = await renderKeys()
    const input = await openForm('openai_compat')
    const huge = `${SECRET_VALUE}${'x'.repeat(4100)}`
    fireEvent.change(input, { target: { value: huge } })
    submit(input)
    expect((await screen.findByRole('alert')).textContent).toMatch(/too long/)
    expect(api.putSecret).not.toHaveBeenCalled()
    expect(input.value).toBe('')
    expect(pageDump()).not.toContain(SECRET_VALUE)
  })

  it('cancel closes the form and forgets what was typed', async () => {
    const { api } = await renderKeys()
    const input = await openForm('openai_compat')
    fireEvent.change(input, { target: { value: SECRET_VALUE } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('New value for openai_compat')).toBeNull()
    expect(pageDump()).not.toContain(SECRET_VALUE)
    expect(api.putSecret).not.toHaveBeenCalled()
    // opening it again starts empty
    expect((await openForm('openai_compat')).value).toBe('')
  })

  it('only one form is open at a time', async () => {
    await renderKeys()
    await openForm('openai_compat')
    await openForm('gemini', 'replace')
    expect(screen.queryByLabelText('New value for openai_compat')).toBeNull()
    expect(screen.getByLabelText('New value for gemini')).toBeTruthy()
  })
})

describe('through the real client', () => {
  it('an answer that carries the value in a field nobody asked for cannot put it on the page', async () => {
    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT')
        return respond({
          name: 'openai_compat',
          set: true,
          source: 'dpapi',
          value: SECRET_VALUE,
          echo: SECRET_VALUE,
        })
      return respond({ secrets: LIST.map((s) => ({ ...s, value: SECRET_VALUE })) })
    })
    render(<Keys api={createApi({ token: TOKEN, fetch: fetchMock as unknown as typeof fetch })} />)
    await screen.findByText('gemini')
    expect(pageDump()).not.toContain(SECRET_VALUE)
    const input = await openForm('openai_compat')
    fireEvent.change(input, { target: { value: SECRET_VALUE } })
    submit(input)
    await screen.findByText(/Saved openai_compat/)
    expect(pageDump()).not.toContain(SECRET_VALUE)
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(put?.[0]).toBe('/api/secrets/openai_compat')
    expect(JSON.parse(put?.[1]?.body as string)).toEqual({ value: SECRET_VALUE })
  })
})

describe('deleting a key', () => {
  it('asks first; keeping it changes nothing', async () => {
    const { api } = await renderKeys()
    fireEvent.click(screen.getByRole('button', { name: 'delete gemini' }))
    expect(screen.getByText('Delete gemini?')).toBeTruthy()
    expect(api.deleteSecret).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByText('Delete gemini?')).toBeNull()
    expect(api.deleteSecret).not.toHaveBeenCalled()
  })

  it('confirming deletes it and the row shows the state afterwards', async () => {
    const { api } = await renderKeys()
    fireEvent.click(screen.getByRole('button', { name: 'delete gemini' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    await waitFor(() =>
      expect(
        within(screen.getByText('gemini').closest('tr') as HTMLElement).getByText('not set')
      ).toBeTruthy()
    )
    expect(api.deleteSecret).toHaveBeenCalledWith('gemini')
    expect(screen.queryByText('Delete gemini?')).toBeNull()
  })

  it('a key that is still set from the environment afterwards says so', async () => {
    const deleteSecret = vi.fn(async (name: string): Promise<SecretView> => ({
      name,
      set: true,
      source: 'environment',
    }))
    await renderKeys({ deleteSecret })
    fireEvent.click(screen.getByRole('button', { name: 'delete gemini' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    await waitFor(() =>
      expect(
        within(screen.getByText('gemini').closest('tr') as HTMLElement).getByText('environment')
      ).toBeTruthy()
    )
  })

  it('a refusal is shown', async () => {
    const deleteSecret = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(
          'read_only',
          'this key comes from the process environment and cannot be deleted here',
          409
        )
      )
    await renderKeys({ deleteSecret })
    fireEvent.click(screen.getByRole('button', { name: 'delete search_api' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'search_api: this key comes from the process environment and cannot be deleted here'
    )
    expect(screen.queryByText('Delete search_api?')).toBeNull()
  })
})
