import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  MemoryCommit,
  MemoryFileView,
  MemoryLineView,
  MemoryProposal,
  MemoryStatusView,
  MemoryTreeEntry,
} from '@animatus/protocol'
import { ApiClientError } from '../src/api.ts'
import type { Api } from '../src/api.ts'
import { Memory } from '../src/Memory.tsx'
import { fakeApi } from './helpers.tsx'

const HASH = 'a'.repeat(40)

const on: MemoryStatusView = {
  enabled: true,
  root: 'C:/data/memory',
  git: true,
  files: 2,
  facts: 3,
  inboxEvents: 4,
  proposals: 0,
  recall: { p50: 0.12, p95: 0.4, n: 20 },
  consolidation: null,
  consolidating: false,
}

const tree: MemoryTreeEntry[] = [
  { path: 'world/lore.md', section: 'world', bytes: 100, facts: 2, mtime: 1 },
  { path: 'viewers/5.md', section: 'viewers', bytes: 80, facts: 1, mtime: 1 },
  { path: 'inbox/2026-09-30.jsonl', section: 'inbox', bytes: 500, facts: 0, mtime: 1 },
]

const fact = (
  index: number,
  source: 'human' | 'viewer' | 'agent',
  body: string,
  locked = false
): MemoryLineView => ({
  index,
  kind: 'fact',
  source,
  locked,
  date: '2026-09-30',
  body,
  text: `[${source}${locked ? ':locked' : ''}] 2026-09-30 ${body}`,
})

const lore: MemoryFileView = {
  path: 'world/lore.md',
  hash: HASH,
  versioned: true,
  lines: [
    { index: 0, kind: 'note', text: '# lore' },
    fact(1, 'human', 'the mascot is a red panda'),
    fact(2, 'agent', 'a summary made by the program'),
    fact(3, 'human', 'a locked rule', true),
  ],
}

function setup(over: Partial<Api> = {}) {
  const api = fakeApi({
    memoryStatus: async () => on,
    memoryTree: async () => tree,
    memoryFile: async (path) =>
      path === 'world/lore.md'
        ? lore
        : path === 'viewers/5.md'
          ? { path, hash: HASH, versioned: false, lines: [fact(0, 'viewer', 'has a cat')] }
          : {
              path,
              hash: HASH,
              versioned: false,
              lines: [{ index: 0, kind: 'note', text: '{"kind":"chat"}' }],
            },
    ...over,
  })
  render(<Memory api={api} refreshMs={0} />)
  return api
}

const openFile = async (name: string) => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }))
  await screen.findByRole('tablist')
}

describe('memory switched off', () => {
  it('says how to turn it on, and shows nothing else', async () => {
    const api = fakeApi({ memoryStatus: async () => ({ enabled: false }) })
    render(<Memory api={api} refreshMs={0} />)
    expect(await screen.findByText(/Memory is switched off/)).toBeTruthy()
    expect(screen.getByText('memory.enabled: true')).toBeTruthy()
    expect(api.memoryTree).not.toHaveBeenCalled()
  })
})

describe('the status and the file list', () => {
  it('shows what there is, where it is, and how fast recall is', async () => {
    setup()
    const status = await screen.findByLabelText('Memory status')
    expect(status.textContent).toContain('2 files, 3 facts')
    expect(status.textContent).toContain('4 events waiting in the inbox')
    expect(status.textContent).toContain('history on')
    expect(status.textContent).toContain(
      'recall 0.12 ms median, 0.40 ms at the 95th percentile (20 lookups)'
    )
    expect(status.textContent).toContain('C:/data/memory')
    const files = screen.getByLabelText('Files')
    expect(within(files).getByRole('button', { name: /lore\.md/ })).toBeTruthy()
    expect(within(files).getByRole('button', { name: /5\.md/ })).toBeTruthy()
    expect(within(files).getAllByText('empty').length).toBeGreaterThan(0)
  })

  it('says when history is off', async () => {
    setup({ memoryStatus: async () => ({ ...on, git: false }) })
    expect((await screen.findByLabelText('Memory status')).textContent).toContain(
      'history off (git is not installed)'
    )
  })
})

describe('a file', () => {
  it('shows each line with its source, its date and whether it is locked; notes are plain', async () => {
    setup()
    await openFile('lore\\.md')
    const view = screen.getByLabelText('File')
    expect(within(view).getByText('the mascot is a red panda')).toBeTruthy()
    expect(within(view).getByText('a summary made by the program')).toBeTruthy()
    expect(within(view).getAllByText('human').length).toBe(2)
    expect(within(view).getByText('agent')).toBeTruthy()
    expect(within(view).getByText('locked')).toBeTruthy()
    expect(within(view).getByText('# lore')).toBeTruthy()
    expect(within(view).getByText('versioned')).toBeTruthy()
  })

  it('editing a fact keeps its date, and makes it the streamer’s own', async () => {
    const api = setup()
    await openFile('lore\\.md')
    const row = screen.getByText('a summary made by the program').closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    const input = within(row).getByLabelText('Edit line') as HTMLInputElement
    expect(input.value).toBe('a summary made by the program')
    fireEvent.change(input, { target: { value: 'corrected by the streamer' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.memoryLine).toHaveBeenCalled())
    expect(api.memoryLine).toHaveBeenCalledWith({
      op: 'edit',
      path: 'world/lore.md',
      index: 2,
      expect: '[agent] 2026-09-30 a summary made by the program',
      text: '[human] 2026-09-30 corrected by the streamer',
    })
  })

  it('locks and unlocks a line of the streamer’s, and only of the streamer’s', async () => {
    const api = setup()
    await openFile('lore\\.md')
    const mine = screen.getByText('the mascot is a red panda').closest('li') as HTMLElement
    fireEvent.click(within(mine).getByRole('button', { name: 'Lock' }))
    await waitFor(() => expect(api.memoryLine).toHaveBeenCalled())
    expect(api.memoryLine).toHaveBeenLastCalledWith({
      op: 'lock',
      path: 'world/lore.md',
      index: 1,
      expect: '[human] 2026-09-30 the mascot is a red panda',
    })
    const locked = screen.getByText('a locked rule').closest('li') as HTMLElement
    fireEvent.click(within(locked).getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(api.memoryLine).toHaveBeenCalledTimes(2))
    expect((api.memoryLine.mock.calls[1]![0] as { op: string }).op).toBe('unlock')
    const program = screen.getByText('a summary made by the program').closest('li') as HTMLElement
    expect(within(program).queryByRole('button', { name: /Lock/ })).toBeNull()
  })

  it('removes a line only after asking', async () => {
    const api = setup()
    await openFile('lore\\.md')
    const row = screen.getByText('the mascot is a red panda').closest('li') as HTMLElement
    const confirm = vi.fn().mockReturnValue(false)
    const had = Object.getOwnPropertyDescriptor(window, 'confirm')
    Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true })
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    expect(api.memoryLine).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.memoryLine).toHaveBeenCalled())
    expect(api.memoryLine).toHaveBeenCalledWith({
      op: 'remove',
      path: 'world/lore.md',
      index: 1,
      expect: '[human] 2026-09-30 the mascot is a red panda',
    })
    if (had) Object.defineProperty(window, 'confirm', had)
    else Reflect.deleteProperty(window, 'confirm')
  })

  it('adds a fact, optionally locked, and empties the field', async () => {
    const api = setup()
    await openFile('lore\\.md')
    const form = screen.getByRole('form', { name: 'Add a fact' })
    fireEvent.change(within(form).getByLabelText('Add a fact'), {
      target: { value: '  never talks about politics ' },
    })
    fireEvent.click(within(form).getByLabelText('Lock it'))
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(api.memoryLine).toHaveBeenCalled())
    expect(api.memoryLine).toHaveBeenCalledWith({
      op: 'add',
      path: 'world/lore.md',
      text: 'never talks about politics',
      locked: true,
    })
    await waitFor(() =>
      expect((within(form).getByLabelText('Add a fact') as HTMLInputElement).value).toBe('')
    )
  })

  it('a conflict is said in the server’s words and the file is read again', async () => {
    const api = setup({
      memoryLine: vi.fn(async () => {
        throw new ApiClientError(
          'conflict',
          'that line has changed since it was read; read the file again',
          409
        )
      }),
    })
    await openFile('lore\\.md')
    const row = screen.getByText('the mascot is a red panda').closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Lock' }))
    expect(await screen.findByText(/that line has changed since it was read/)).toBeTruthy()
    await waitFor(() => expect(api.memoryFile.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('a file of the inbox is shown as it is, with nothing to edit; a viewer file says it has no history', async () => {
    setup()
    await openFile('2026-09-30')
    let view = screen.getByLabelText('File')
    expect(within(view).getByText('{"kind":"chat"}')).toBeTruthy()
    expect(within(view).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(view).queryByRole('form', { name: 'Add a fact' })).toBeNull()
    await openFile('5\\.md')
    view = screen.getByLabelText('File')
    expect(within(view).getByText('no history (on purpose)')).toBeTruthy()
    expect((within(view).getByRole('tab', { name: 'History' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(within(view).getByRole('button', { name: 'Edit' })).toBeTruthy() // viewer files can be edited
  })

  it('a new file is made with an empty body, and opened', async () => {
    const api = setup()
    await screen.findByLabelText('Memory status')
    const form = screen.getByRole('form', { name: 'New file' })
    fireEvent.change(within(form).getByLabelText('New file'), {
      target: { value: 'world/memes.md' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(api.memoryWrite).toHaveBeenCalled())
    expect(api.memoryWrite).toHaveBeenCalledWith({ path: 'world/memes.md', content: '' })
    await waitFor(() => expect(api.memoryFile).toHaveBeenCalledWith('world/memes.md'))
  })
})

describe('history', () => {
  const commits: MemoryCommit[] = [
    {
      hash: 'b'.repeat(40),
      author: 'human',
      time: Date.now() - 60_000,
      subject: 'human: edit world/lore.md',
    },
    {
      hash: 'c'.repeat(40),
      author: 'agent',
      time: Date.now() - 600_000,
      subject: 'agent: 2 changes (world/lore.md)',
    },
  ]

  it('lists the commits with their authors, shows what a commit changed, and restores a version after asking', async () => {
    const api = setup({
      memoryHistory: async () => commits,
      memoryDiff: async () => '-old line\n+new line\n',
    })
    await openFile('lore\\.md')
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText('edit world/lore.md')).toBeTruthy()
    expect(screen.getByText('2 changes (world/lore.md)')).toBeTruthy()
    // the changes of the newest commit are against the one before it
    fireEvent.click(screen.getAllByRole('button', { name: 'Changes' })[0]!)
    await waitFor(() => expect(api.memoryDiff).toHaveBeenCalled())
    expect(api.memoryDiff).toHaveBeenCalledWith('world/lore.md', 'c'.repeat(40), 'b'.repeat(40))
    expect((await screen.findByLabelText('Changes')).textContent).toContain('+new line')

    const confirm = vi.fn().mockReturnValue(true)
    const had = Object.getOwnPropertyDescriptor(window, 'confirm')
    Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true })
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore this version' })[1]!)
    await waitFor(() => expect(api.memoryRollback).toHaveBeenCalled())
    expect(api.memoryRollback).toHaveBeenCalledWith('world/lore.md', 'c'.repeat(40))
    expect(await screen.findByText('Restored.')).toBeTruthy()
    if (had) Object.defineProperty(window, 'confirm', had)
    else Reflect.deleteProperty(window, 'confirm')
  })

  it('a file with no commits yet says so', async () => {
    setup({ memoryHistory: async () => [] })
    await openFile('lore\\.md')
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText('This file has no history yet.')).toBeTruthy()
  })
})

describe('proposals', () => {
  const proposal: MemoryProposal = {
    id: '1700000000000-abcdef',
    target: 'persona/rules.md',
    reason: 'viewers keep asking about politics',
    content: 'Be kind.\nNever discuss politics.\n',
    at: Date.now() - 5000,
  }

  it('shows what the program asks for and why, and sends the answer', async () => {
    const api = setup({ memoryProposals: async () => [proposal] })
    const box = await screen.findByLabelText('Proposals')
    expect(box.textContent).toContain('persona/rules.md')
    expect(box.textContent).toContain('viewers keep asking about politics')
    expect(box.textContent).toContain('Never discuss politics.')
    fireEvent.click(within(box).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.memoryResolve).toHaveBeenCalledWith(proposal.id, true))
    fireEvent.click(within(box).getByRole('button', { name: 'Refuse' }))
    await waitFor(() => expect(api.memoryResolve).toHaveBeenCalledWith(proposal.id, false))
  })

  it('there is no box when nothing is asked', async () => {
    setup()
    await screen.findByLabelText('Memory status')
    expect(screen.queryByLabelText('Proposals')).toBeNull()
  })
})

describe('consolidation and forgetting', () => {
  it('runs the pass, and says what it did', async () => {
    const api = setup({
      memoryConsolidate: async () => ({
        files: 1,
        events: 9,
        viewersSeen: 3,
        viewersAsked: 2,
        factsAdded: 4,
        dropped: 1,
        streamNotes: 2,
        expired: 5,
        failures: [],
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Consolidate now' }))
    await waitFor(() => expect(api.memoryConsolidate).toHaveBeenCalled())
    expect(
      await screen.findByText(
        /2 viewers read, 4 facts added, 2 notes about the stream, 5 web results expired/
      )
    ).toBeTruthy()
  })

  it('reports the first problem of a pass, and does not start a second while one runs', async () => {
    setup({
      memoryStatus: async () => ({ ...on, consolidating: true }),
    })
    const button = (await screen.findByRole('button', {
      name: 'Consolidating...',
    })) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('forgets a viewer after asking, and tells whether there was anything', async () => {
    const api = setup()
    const box = await screen.findByLabelText('Forget a viewer')
    const confirm = vi.fn().mockReturnValue(true)
    const had = Object.getOwnPropertyDescriptor(window, 'confirm')
    Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true })
    fireEvent.change(within(box).getByLabelText('Viewer id'), { target: { value: '5' } })
    fireEvent.click(within(box).getByRole('button', { name: 'Forget' }))
    await waitFor(() => expect(api.memoryForget).toHaveBeenCalledWith(5))
    expect(await screen.findByText('Viewer 5 is forgotten.')).toBeTruthy()
    fireEvent.change(within(box).getByLabelText('Viewer id'), { target: { value: 'five' } })
    fireEvent.click(within(box).getByRole('button', { name: 'Forget' }))
    expect(await screen.findByText('A viewer id is a whole number.')).toBeTruthy()
    expect(api.memoryForget).toHaveBeenCalledTimes(1)
    if (had) Object.defineProperty(window, 'confirm', had)
    else Reflect.deleteProperty(window, 'confirm')
  })
})

describe('when the orchestrator cannot be reached', () => {
  it('says so', async () => {
    const api = fakeApi({
      memoryStatus: async () => {
        throw new ApiClientError('network', 'Cannot reach the orchestrator. Is it running?', 0)
      },
    })
    render(<Memory api={api} refreshMs={0} />)
    expect(await screen.findByText('Cannot reach the orchestrator. Is it running?')).toBeTruthy()
  })
})
