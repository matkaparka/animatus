import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatEntry {
  role: ChatRole
  content: string
  ts: number
  /** Display name of the audience member for user entries. */
  name?: string
  /** Where a user entry came from; used later by memory consolidation and never to grant trust. */
  source?: 'viewer' | 'moderator' | 'host' | 'system'
}

/**
 * The conversation so far: in memory for prompts, appended to a JSONL file per day for the record and for
 * the memory consolidation pass. The log is data; nothing in it is ever executed or treated as an instruction.
 */
export class ChatLog {
  private entries: ChatEntry[] = []

  constructor(
    private readonly dir?: string,
    private readonly maxInMemory = 200
  ) {}

  /** Load the tail of the most recent day files so a restart keeps the immediate context. */
  load(limit = 40): void {
    if (!this.dir || !existsSync(this.dir)) return
    const files = readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .slice(-2)
    const loaded: ChatEntry[] = []
    for (const f of files) {
      for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as ChatEntry
          if (
            typeof e.content === 'string' &&
            (e.role === 'user' || e.role === 'assistant' || e.role === 'system')
          )
            loaded.push(e)
        } catch {
          // a torn last line after a crash is skipped
        }
      }
    }
    this.entries = loaded.slice(-limit)
  }

  append(e: ChatEntry): void {
    this.entries.push(e)
    if (this.entries.length > this.maxInMemory)
      this.entries.splice(0, this.entries.length - this.maxInMemory)
    if (!this.dir) return
    try {
      mkdirSync(this.dir, { recursive: true })
      const day = new Date(e.ts).toISOString().slice(0, 10)
      appendFileSync(join(this.dir, `${day}.jsonl`), JSON.stringify(e) + '\n', 'utf8')
    } catch {
      // the log must never take the stream down
    }
  }

  recent(n: number): ChatEntry[] {
    return n <= 0 ? [] : this.entries.slice(-n)
  }

  get length(): number {
    return this.entries.length
  }

  /**
   * `role: content` lines, the format the legacy `[conversation_history]` placeholder used: the latest `n`
   * entries, not counting the last `skipLast` (the message being answered is not part of what came before it).
   */
  historyText(n: number, skipLast = 0): string {
    if (n <= 0) return ''
    return this.entries
      .slice(0, Math.max(0, this.entries.length - skipLast))
      .slice(-n)
      .map((e) => `${e.role}: ${e.content}`)
      .join('\n')
  }

  /** History as chat messages for the LLM (system entries are not replayed). */
  toMessages(n: number): { role: 'user' | 'assistant'; content: string }[] {
    return this.recent(n)
      .filter((e) => e.role !== 'system')
      .map((e) => ({ role: e.role as 'user' | 'assistant', content: e.content }))
  }
}
