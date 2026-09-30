/**
 * The memory routes over the real memory service. Everything the console writes here is the streamer's own edit
 * (author `human`): it wins over the program's, and is a commit of its own in the history.
 */
import type {
  MemoryCommit,
  MemoryConsolidateReport,
  MemoryFileView,
  MemoryLineRequest,
  MemoryLineView,
  MemoryProposal,
  MemoryStatusView,
  MemoryTreeEntry,
  MemoryWriteRequest,
} from '@animatus/protocol'
import { joinLines, parseLine, splitLines } from '../memory/lines.ts'
import type { MemoryService } from '../memory/service.ts'
import { normalizePath } from '../memory/store.ts'
import type { FailureCode } from '../memory/store.ts'
import { ApiFailure } from './backend.ts'
import type { MemoryBackend } from './backend.ts'

const STATUS: Record<FailureCode, number> = {
  bad_path: 400,
  bad_line: 400,
  forbidden: 403,
  locked: 403,
  human_wins: 403,
  conflict: 409,
  no_line: 409,
  not_found: 404,
  too_big: 413,
}

/** Turn a refusal of the store into the API's refusal. */
function refuse(r: { code: FailureCode; message: string }): never {
  throw new ApiFailure(r.code, r.message, STATUS[r.code] ?? 400)
}

function view(path: string, content: string, hash: string, versioned: boolean): MemoryFileView {
  const lines: MemoryLineView[] = splitLines(content).map((text, index) => {
    const p = parseLine(text)
    return p.kind === 'fact'
      ? {
          index,
          text,
          kind: 'fact',
          source: p.source,
          locked: p.locked,
          date: p.date,
          body: p.text,
        }
      : { index, text, kind: 'note' }
  })
  return { path, hash, lines, versioned }
}

export function createMemoryBackend(svc: MemoryService): MemoryBackend {
  const store = svc.store
  const versioned = async (path: string): Promise<boolean> => {
    const n = normalizePath(path)
    return (
      n !== null &&
      n.section !== 'viewers' &&
      n.section !== 'inbox' &&
      (await store.git.available())
    )
  }
  const hashOf = async (path: string): Promise<string> => (await store.read(path))?.hash ?? ''

  return {
    async status(): Promise<MemoryStatusView> {
      return await svc.status()
    },

    async tree(): Promise<MemoryTreeEntry[]> {
      return await store.tree()
    },

    async readFile(path): Promise<MemoryFileView> {
      const n = normalizePath(path)
      if (!n) throw new ApiFailure('bad_path', 'not a file of the memory folder', 400)
      const f = await store.read(n.path)
      if (!f) throw new ApiFailure('not_found', 'no such file', 404)
      return view(f.path, f.content, f.hash, await versioned(f.path))
    },

    async writeFile(req: MemoryWriteRequest) {
      const r = await store.write(req.path, req.content, {
        author: 'human',
        ...(req.expected_hash !== undefined ? { expectedHash: req.expected_hash } : {}),
      })
      if (!r.ok) refuse(r)
      return { hash: r.hash }
    },

    async line(req: MemoryLineRequest) {
      switch (req.op) {
        case 'add': {
          const uid = /^viewers\/(\d+)\.md$/.exec(req.path)?.[1]
          const r = await store.append(
            req.path,
            { source: 'human', text: req.text, locked: req.locked },
            { author: 'human', ...(uid ? { header: `# viewer (uid ${uid})` } : {}) }
          )
          if (!r.ok) refuse(r)
          return { hash: await hashOf(req.path) }
        }
        case 'edit':
        case 'remove': {
          const r = await store.editLine(
            req.path,
            {
              index: req.index,
              expectText: req.expect,
              replacement: req.op === 'edit' ? req.text : null,
            },
            { author: 'human' }
          )
          if (!r.ok) refuse(r)
          return { hash: r.hash }
        }
        case 'lock':
        case 'unlock': {
          const r = await store.setLocked(req.path, req.index, req.expect, req.op === 'lock')
          if (!r.ok) refuse(r)
          return { hash: r.hash }
        }
      }
    },

    async history(path, limit): Promise<MemoryCommit[]> {
      return await store.history(path, limit)
    },

    async diff(path, from, to): Promise<string> {
      const text = await store.diff(path, from, to)
      if (text === null)
        throw new ApiFailure('not_found', 'there is no such version, or no history', 404)
      return text
    },

    async rollback(path, rev) {
      const r = await store.rollback(path, rev)
      if (!r.ok) refuse(r)
      return { hash: r.hash }
    },

    async forget(uid) {
      const r = await store.forgetViewer(uid)
      if (!r.ok) refuse(r)
      return { existed: r.existed }
    },

    async consolidate(): Promise<MemoryConsolidateReport> {
      try {
        return await svc.consolidate()
      } catch (e) {
        throw new ApiFailure(
          'consolidate_failed',
          (e as Error).message.split('\n')[0] ?? 'failed',
          502
        )
      }
    },

    async proposals(): Promise<MemoryProposal[]> {
      return await store.proposals()
    },

    async resolveProposal(id, approve) {
      const r = approve ? await store.approveProposal(id) : await store.rejectProposal(id)
      if (!r.ok) refuse(r)
    },
  }
}

export { joinLines }
