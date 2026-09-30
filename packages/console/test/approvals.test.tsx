import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ApprovalView, ApprovalsResponse } from '@animatus/protocol'
import { ApiClientError } from '../src/api.ts'
import { Approvals } from '../src/Approvals.tsx'
import { fakeApi } from './helpers.tsx'

const view = (over: Partial<ApprovalView> = {}): ApprovalView => ({
  id: 'ap-000000000001',
  tool: 'enter_mode',
  summary: 'Start the mode "sleep"',
  args: { mode: 'sleep' },
  origin: { kind: 'moderator', trust: 'trusted', name: 'mia' },
  status: 'pending',
  requested_at: Date.now() - 30_000,
  expires_at: Date.now() + 570_000,
  ...over,
})

const list = (over: Partial<ApprovalsResponse> = {}): ApprovalsResponse => ({
  pending: [],
  recent: [],
  ...over,
})

function setup(responses: ApprovalsResponse[], over: Parameters<typeof fakeApi>[0] = {}) {
  let n = 0
  const api = fakeApi({
    approvals: async () => responses[Math.min(n++, responses.length - 1)] as ApprovalsResponse,
    ...over,
  })
  const onCount = vi.fn()
  const ui = (changes: number) => <Approvals api={api} changes={changes} onCount={onCount} />
  const r = render(ui(0))
  return { api, onCount, rerender: (changes: number) => r.rerender(ui(changes)) }
}

describe('the approvals page', () => {
  it('says so when nothing waits, and tells the app how many wait', async () => {
    const { api, onCount } = setup([list()])
    expect(await screen.findByText('Nothing is waiting.')).toBeTruthy()
    expect(api.approvals).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(0))
    // it explains what this page is for, and that the audience cannot reach it
    expect(screen.getByText(/only this page can say it/)).toBeTruthy()
    expect(screen.getByText(/refused before it is listed/)).toBeTruthy()
  })

  it('shows what each request will do in the tool’s own words, who asked, and the arguments as they will be run', async () => {
    const { onCount } = setup([
      list({
        pending: [
          view(),
          view({
            id: 'ap-000000000002',
            tool: 'remember',
            summary: 'Remember: the mascot is a red panda',
            args: { text: 'the mascot is a red panda' },
            origin: { kind: 'host', trust: 'privileged', name: 'me' },
          }),
        ],
      }),
    ])
    const waiting = await screen.findByRole('region', { name: 'Waiting for your yes' })
    const items = within(waiting).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]!).getByText('Start the mode "sleep"')).toBeTruthy()
    expect(items[0]!.textContent).toContain('enter_mode')
    expect(items[0]!.textContent).toContain('asked by moderator mia')
    expect(within(items[0]!).getByText('trusted')).toBeTruthy()
    expect(items[0]!.textContent).toContain('"mode": "sleep"')
    expect(items[1]!.textContent).toContain('asked by host me')
    expect(within(items[1]!).getByText('privileged')).toBeTruthy()
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(2))
  })

  it('what a request says is shown as text, never as markup', async () => {
    setup([
      list({
        pending: [
          view({
            summary: 'Remember: <img src=x onerror=alert(1)>',
            args: { text: '<b>bold</b>' },
          }),
        ],
      }),
    ])
    expect(await screen.findByText('Remember: <img src=x onerror=alert(1)>')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('.approval-args b')).toBeNull()
  })

  it('approving asks the server with that request’s id, reads the list again and says what came of it', async () => {
    const decided = view({ status: 'approved', decided_at: Date.now(), result: 'sleep is ACTIVE' })
    const { api } = setup([list({ pending: [view()] }), list({ recent: [decided] })], {
      approvalDecide: async () => decided,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Approve: Start the mode "sleep"' }))
    expect(
      await screen.findByText('Approved: Start the mode "sleep" (sleep is ACTIVE)')
    ).toBeTruthy()
    expect(api.approvalDecide).toHaveBeenCalledWith('ap-000000000001', 'approve')
    expect(api.approvals).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('Nothing is waiting.')).toBeTruthy()
    const done = screen.getByRole('region', { name: 'Decided' })
    expect(within(done).getByText('approved')).toBeTruthy()
  })

  it('denying is a separate button and calls the other route', async () => {
    const { api } = setup([list({ pending: [view()] }), list()], {
      approvalDecide: async () => view({ status: 'denied' }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Deny: Start the mode "sleep"' }))
    expect(await screen.findByText('Denied: Start the mode "sleep"')).toBeTruthy()
    expect(api.approvalDecide).toHaveBeenCalledWith('ap-000000000001', 'deny')
  })

  it('a request that expired or was decided elsewhere shows the server’s reason, and the list is read again', async () => {
    const { api } = setup([list({ pending: [view()] }), list()], {
      approvalDecide: async () => {
        throw new ApiClientError(
          'approval_expired',
          'that request waited too long and expired',
          409
        )
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: /^Approve/ }))
    expect(await screen.findByText('that request waited too long and expired')).toBeTruthy()
    expect(await screen.findByText('Nothing is waiting.')).toBeTruthy()
    expect(api.approvals).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/^Approved:/)).toBeNull()
  })

  it('reads the list again when the server says it changed', async () => {
    const { api, rerender, onCount } = setup([list(), list({ pending: [view()] })])
    await screen.findByText('Nothing is waiting.')
    rerender(1)
    expect(await screen.findByText('Start the mode "sleep"')).toBeTruthy()
    expect(api.approvals).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1))
  })

  it('the buttons are off while a decision is on its way, so a double click decides once', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { api } = setup([list({ pending: [view()] }), list()], {
      approvalDecide: async () => {
        await gate
        return view({ status: 'approved' })
      },
    })
    const button = await screen.findByRole('button', { name: /^Approve/ })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))
    release()
    await screen.findByText(/^Approved:/)
    expect(api.approvalDecide).toHaveBeenCalledTimes(1)
  })

  it('an answer of the wrong shape is reported and nothing is listed', async () => {
    setup([list()], {
      approvals: async () => {
        throw new ApiClientError(
          'bad_response',
          'Unexpected answer from /api/approvals (pending: Required).',
          200
        )
      },
    })
    expect(await screen.findByText(/Unexpected answer from \/api\/approvals/)).toBeTruthy()
    expect(screen.queryByText('Nothing is waiting.')).toBeNull()
  })
})
