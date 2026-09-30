import { describe, expect, it } from 'vitest'
import { BilibiliSource, type BilibiliSourceEvent } from '../../src/sources/bilibili/index.ts'
import { eventSchema } from './bilibili-helpers.ts'

/**
 * Optional smoke test against the real service. It is skipped unless ANIMATUS_TEST_BILI_ROOM holds a
 * room id (a busy public room makes it more telling). It connects anonymously for about 15 s and checks
 * only that the connection opens and that every event it received has a valid shape. It prints how many
 * events of each type arrived, and never a message text, a user name or the room id.
 */
const room = Number(process.env.ANIMATUS_TEST_BILI_ROOM)
const enabled = Number.isSafeInteger(room) && room > 0
const LISTEN_MS = 15_000

describe.skipIf(!enabled)('live smoke test (anonymous; needs ANIMATUS_TEST_BILI_ROOM)', () => {
  it(
    'opens a connection and emits only events of a valid shape',
    async () => {
      const source = new BilibiliSource({ roomId: room })
      const events: BilibiliSourceEvent[] = []
      source.on('event', (event) => events.push(event))

      await source.start()
      await new Promise((resolve) => setTimeout(resolve, LISTEN_MS))
      await source.stop()

      const counts: Record<string, number> = {}
      for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
      console.log(`[live smoke] events by type: ${JSON.stringify(counts)}`)

      expect(events.some((event) => event.type === 'status' && event.state === 'open')).toBe(true)
      const invalid = events
        .filter((event) => !eventSchema.safeParse(event).success)
        .map((event) => event.type)
      expect(invalid).toEqual([])
      expect(events.at(-1)).toEqual({ type: 'status', state: 'closed' })
    },
    LISTEN_MS + 25_000
  )
})
