import { describe, expect, it } from 'vitest'
import * as inbox from '../../src/inbox/index.ts'

describe('the inbox module surface', () => {
  it('exports the router, pacer, blocklist, formats, text helpers and types', () => {
    for (const name of [
      'Router',
      'Pacer',
      'Blocklist',
      'emptyBlocklist',
      'FORMATS',
      'PRIORITY',
      'DROP_REASONS',
      'InboxConfigSchema',
      'defaultInboxConfig',
      'cleanViewerText',
      'meaningfulChars',
      'normKey',
    ]) {
      expect(inbox, name).toHaveProperty(name)
    }
  })

  it('priorities are the legacy numbers', () => {
    expect(inbox.PRIORITY).toEqual({ SC: 0, GUARD: 1, DANCE: 2, GIFT: 3, DANMAKU: 4, SONG: 5 })
  })

  it('a router and a pacer can be built from the exported pieces alone', () => {
    let now = 0
    const router = new inbox.Router({}, inbox.emptyBlocklist, { now: () => now })
    const pacer = new inbox.Pacer(router)
    router.onDanmaku({ uid: 1, uname: 'alice', msg: 'hello there', dmType: 0 })
    const idle = {
      connected: true,
      speaking: false,
      processing: false,
      dancing: false,
      singing: false,
      sleeping: false,
      queued: 0,
    }
    expect(pacer.decide(idle, now)).toEqual({ action: 'wait', reason: 'settling' })
    now = 1500
    const decision = pacer.decide(idle, now)
    expect(decision).toMatchObject({ action: 'send', text: '【弹幕】alice：hello there' })
  })
})
