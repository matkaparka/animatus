import { describe, expect, it } from 'vitest'
import { InboxConfigSchema, defaultInboxConfig } from '../../src/inbox/types.ts'

describe('InboxConfigSchema', () => {
  it('the stock configuration matches the legacy example defaults', () => {
    expect(defaultInboxConfig()).toEqual({
      filter: { danmakuMaxAgeSec: 30, maxMerge: 3, minChars: 2, maxChars: 80, repeatWindowSec: 60 },
      gift: {
        mergeWindowSec: 10,
        bigGiftYuan: 10,
        smallFlushYuan: 5,
        smallFlushCount: 10,
        includeFreeGifts: false,
      },
      cold: { enabled: false, minutes: 3 },
      dance: { gifts: [], mergeSec: 3 },
      singing: { enabled: true, ownerUids: [], adminsCanSkip: true, ackMaxAgeSec: 600 },
      ignoreUids: [],
      pacer: { idleSettleSec: 1.5, busyTimeoutSec: 20, minIntervalSec: 2 },
      sleep: { enabled: true, replyIntervalSec: 90, firstReplyAfterSec: 30, maxAgeSec: 180 },
    })
  })

  it('fills the rest from a partial object', () => {
    const cfg = InboxConfigSchema.parse({
      filter: { maxMerge: 5 },
      gift: { includeFreeGifts: true },
      dance: { gifts: ['star'] },
      ignoreUids: [7],
    })
    expect(cfg.filter).toEqual({
      danmakuMaxAgeSec: 30,
      maxMerge: 5,
      minChars: 2,
      maxChars: 80,
      repeatWindowSec: 60,
    })
    expect(cfg.gift.includeFreeGifts).toBe(true)
    expect(cfg.gift.bigGiftYuan).toBe(10)
    expect(cfg.dance).toEqual({ gifts: ['star'], mergeSec: 3 })
    expect(cfg.ignoreUids).toEqual([7])
    expect(cfg.pacer.idleSettleSec).toBe(1.5)
  })

  it('does not share default arrays between parses', () => {
    const a = defaultInboxConfig()
    a.ignoreUids.push(1)
    a.dance.gifts.push('x')
    a.singing.ownerUids.push(2)
    const b = defaultInboxConfig()
    expect(b.ignoreUids).toEqual([])
    expect(b.dance.gifts).toEqual([])
    expect(b.singing.ownerUids).toEqual([])
  })

  it('rejects unknown keys, so a misspelled or snake_case field is loud rather than ignored', () => {
    expect(() => InboxConfigSchema.parse({ filter: { max_merge: 5 } })).toThrow()
    expect(() => InboxConfigSchema.parse({ filtr: {} })).toThrow()
    expect(() => InboxConfigSchema.parse({ pacer: { idleSettle: 1 } })).toThrow()
  })

  it('rejects values the router cannot work with', () => {
    expect(() => InboxConfigSchema.parse({ filter: { maxMerge: 0 } })).toThrow() // would never drain a queue
    expect(() => InboxConfigSchema.parse({ filter: { maxChars: 0 } })).toThrow()
    expect(() => InboxConfigSchema.parse({ filter: { minChars: -1 } })).toThrow()
    expect(() => InboxConfigSchema.parse({ filter: { danmakuMaxAgeSec: -5 } })).toThrow()
    expect(() => InboxConfigSchema.parse({ gift: { smallFlushCount: 1.5 } })).toThrow()
    expect(() => InboxConfigSchema.parse({ pacer: { idleSettleSec: Number.NaN } })).toThrow()
    expect(() => InboxConfigSchema.parse({ ignoreUids: ['7'] })).toThrow()
    expect(() => InboxConfigSchema.parse({ singing: { enabled: 'yes' } })).toThrow()
  })

  it('accepts zero where zero is meaningful', () => {
    const cfg = InboxConfigSchema.parse({
      filter: { minChars: 0, repeatWindowSec: 0 },
      gift: { mergeWindowSec: 0, smallFlushCount: 0 },
      pacer: { idleSettleSec: 0, minIntervalSec: 0 },
      sleep: { firstReplyAfterSec: 0 },
    })
    expect(cfg.filter.minChars).toBe(0)
    expect(cfg.pacer.idleSettleSec).toBe(0)
  })
})
