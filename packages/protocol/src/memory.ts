/**
 * Memory, as the console sees it: a folder of Markdown files with one fact per line (see the orchestrator's
 * `memory/` module for the format), edited by the streamer here and by the program on its own.
 *
 *   GET  /api/memory                        status
 *   GET  /api/memory/tree                   the files
 *   GET  /api/memory/file?path=             one file, line by line, with its hash
 *   PUT  /api/memory/file                   replace a whole file (needs the hash it was based on)
 *   POST /api/memory/line                   add, edit, remove, lock or unlock one line
 *   GET  /api/memory/history?path=          the commits of a file (or of everything)
 *   GET  /api/memory/diff?path=&from=&to=   what changed between two commits (plain text)
 *   POST /api/memory/rollback               put a file back as it was in a commit
 *   POST /api/memory/forget                 delete a viewer's file
 *   POST /api/memory/consolidate            run the consolidation pass now
 *   GET  /api/memory/proposals              changes the program asks the streamer to approve
 *   POST /api/memory/proposals/:id/{approve|reject}
 *
 * Everything the console writes is the streamer's edit: it wins over the program's, and can lock a line.
 */
import { z } from 'zod'

export const MemorySection = z.enum([
  'persona',
  'viewers',
  'stream',
  'world',
  'search-cache',
  'proposals',
  'inbox',
])
export type MemorySection = z.infer<typeof MemorySection>

/** A path inside the memory folder, `section/file.md`. */
export const MemoryPath = z.string().min(3).max(200)

export const MemoryTreeEntry = z.object({
  path: MemoryPath,
  section: MemorySection,
  bytes: z.number().int().min(0),
  /** Fact lines in the file. */
  facts: z.number().int().min(0),
  mtime: z.number(),
})
export type MemoryTreeEntry = z.infer<typeof MemoryTreeEntry>
export const MemoryTreeResponse = z.object({ files: z.array(MemoryTreeEntry) })

export const MemorySource = z.enum(['human', 'viewer', 'agent'])
export type MemorySource = z.infer<typeof MemorySource>

export const MemoryLineView = z.object({
  index: z.number().int().min(0),
  /** The whole line as it is in the file. */
  text: z.string(),
  kind: z.enum(['fact', 'note']),
  source: MemorySource.optional(),
  locked: z.boolean().optional(),
  date: z.string().optional(),
  /** The words of a fact, without the tag and the date. */
  body: z.string().optional(),
})
export type MemoryLineView = z.infer<typeof MemoryLineView>

export const MemoryFileView = z.object({
  path: MemoryPath,
  /** The hash of the file as read: a write says which version it is based on. */
  hash: z.string().max(64),
  lines: z.array(MemoryLineView),
  /** Whether the file has a history (viewer files and the inbox have none, on purpose). */
  versioned: z.boolean(),
})
export type MemoryFileView = z.infer<typeof MemoryFileView>

export const MemoryWriteRequest = z.object({
  path: MemoryPath,
  /** Whole-file writes are for small files: the console's request body is limited to 64 KB. Line edits have no such limit. */
  content: z.string().max(60_000),
  /** The hash the content is based on; leave out only for a new file. */
  expected_hash: z.string().max(64).optional(),
})
export type MemoryWriteRequest = z.infer<typeof MemoryWriteRequest>

export const MemoryHashResponse = z.object({ hash: z.string().max(64).nullable() })

const Row = { path: MemoryPath, index: z.number().int().min(0), expect: z.string().max(2000) }
export const MemoryLineRequest = z.discriminatedUnion('op', [
  /** Append a fact the streamer writes (`[human]`), optionally locked. */
  z.object({
    op: z.literal('add'),
    path: MemoryPath,
    text: z.string().min(1).max(400),
    locked: z.boolean().default(false),
  }),
  /** Replace a line; `expect` is the line as it was read, `text` the whole new line. */
  z.object({ op: z.literal('edit'), ...Row, text: z.string().max(2000) }),
  z.object({ op: z.literal('remove'), ...Row }),
  z.object({ op: z.literal('lock'), ...Row }),
  z.object({ op: z.literal('unlock'), ...Row }),
])
export type MemoryLineRequest = z.infer<typeof MemoryLineRequest>

/**
 * The same request as it is first checked on the wire: one flat object (the console server checks the fields of a
 * body against a plain object schema), which the route then reads as `MemoryLineRequest` for the rules of each
 * operation.
 */
export const MemoryLineWire = z.object({
  op: z.enum(['add', 'edit', 'remove', 'lock', 'unlock']),
  path: MemoryPath,
  text: z.string().max(2000).optional(),
  locked: z.boolean().optional(),
  index: z.number().int().min(0).optional(),
  expect: z.string().max(2000).optional(),
})

export const MemoryCommit = z.object({
  hash: z.string().max(64),
  author: z.enum(['human', 'agent', 'system']),
  time: z.number(),
  subject: z.string().max(300),
})
export type MemoryCommit = z.infer<typeof MemoryCommit>
export const MemoryHistoryResponse = z.object({ commits: z.array(MemoryCommit) })

export const MemoryRollbackRequest = z.object({
  path: MemoryPath,
  rev: z.string().regex(/^[0-9a-f]{7,40}$/),
})
export const MemoryForgetRequest = z.object({
  uid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
})
export const MemoryForgetResponse = z.object({ existed: z.boolean() })

export const MemoryProposal = z.object({
  id: z.string().max(80),
  target: MemoryPath,
  reason: z.string().max(400),
  content: z.string(),
  at: z.number(),
})
export type MemoryProposal = z.infer<typeof MemoryProposal>
export const MemoryProposalsResponse = z.object({ proposals: z.array(MemoryProposal) })

export const MemoryConsolidateReport = z.object({
  files: z.number(),
  events: z.number(),
  viewersSeen: z.number(),
  viewersAsked: z.number(),
  factsAdded: z.number(),
  dropped: z.number(),
  streamNotes: z.number(),
  expired: z.number(),
  failures: z.array(z.string().max(400)),
})
export type MemoryConsolidateReport = z.infer<typeof MemoryConsolidateReport>

export const MemoryStatusView = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    /** Where the folder is, so the streamer can open it. */
    root: z.string().max(500),
    git: z.boolean(),
    files: z.number(),
    facts: z.number(),
    inboxEvents: z.number(),
    proposals: z.number(),
    recall: z.object({ p50: z.number(), p95: z.number(), n: z.number() }).nullable(),
    consolidation: z.object({ at: z.number(), report: MemoryConsolidateReport }).nullable(),
    consolidating: z.boolean(),
  }),
])
export type MemoryStatusView = z.infer<typeof MemoryStatusView>
