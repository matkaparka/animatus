/**
 * Who a reply is answering, for the tool gate.
 *
 * A batch is a handful of lines, each written by someone. The reply to it is judged as its least trusted author: one
 * line from the audience among a moderator's lines makes the whole reply an audience reply, because the model reads
 * all of them together and cannot tell which line an instruction came from. Trust is decided from where a line
 * came from (the platform's own flags, the program), never from what it says.
 */
import { makeSource } from '@animatus/protocol'
import type { EventSource, TrustLevel } from '@animatus/protocol'
import type { BatchPart } from '../inbox/types.ts'

const RANK: Record<TrustLevel, number> = { untrusted: 0, trusted: 1, privileged: 2 }

/** The part with the lowest trust (the first of them when several tie); a line with no role counts as the audience. */
export function originOfBatch(parts: readonly BatchPart[]): EventSource {
  let weakest: BatchPart | undefined
  let weakestRank = Infinity
  for (const p of parts) {
    const rank = RANK[makeSource(p.role ?? 'viewer').trust]
    if (rank < weakestRank) {
      weakest = p
      weakestRank = rank
    }
  }
  return makeSource(weakest?.role ?? 'viewer', {
    ...(weakest?.uid !== undefined && weakest.uid > 0 ? { uid: String(weakest.uid) } : {}),
    ...(weakest?.uname !== undefined ? { name: weakest.uname.slice(0, 100) } : {}),
  })
}
