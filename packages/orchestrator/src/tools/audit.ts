/**
 * The trail of every tool call the program was asked to make: who asked, what for, and what the gate decided. One JSON
 * object per line in a file under `data/`; when it grows past a megabyte the old one is kept as `.1` and a new one starts.
 * Writing never throws and never blocks a decision.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ToolAuditEntry } from '@animatus/protocol'

const MAX_BYTES = 1_000_000

export interface AuditSink {
  write(entry: ToolAuditEntry): void
  /** Resolves when everything written so far is on disk. */
  flush(): Promise<void>
}

export function createAuditSink(
  file: string,
  log: (level: 'warn', msg: string) => void = () => {}
): AuditSink {
  let chain: Promise<unknown> = Promise.resolve()
  let made = false
  return {
    write(entry) {
      const line = `${JSON.stringify(entry)}\n`
      chain = chain.then(async () => {
        try {
          if (!made) {
            await mkdir(path.dirname(file), { recursive: true })
            made = true
          }
          const size = (await stat(file).catch(() => null))?.size ?? 0
          if (size > MAX_BYTES) await rename(file, `${file}.1`)
          await appendFile(file, line, 'utf8')
        } catch (e) {
          log('warn', `tool audit: could not write: ${(e as Error).message.split('\n')[0]}`)
        }
      })
    },
    flush: async () => {
      await chain
    },
  }
}
