import { describe, expect, it } from 'vitest'
import { Blocklist, Router } from '../../src/inbox/index.ts'
import type { ChatCommandInput } from '../../src/inbox/index.ts'
import { FakeClock, chat, fakeBlockFile } from './helpers.ts'
import type { Harness } from './helpers.ts'

// A mode can claim chat messages that start with its command words (the draw mode's "画 …"). The router asks a
// hook before the ordinary filters; true means the message is the mode's now.

function setup(take: (c: ChatCommandInput) => boolean, throwing = false) {
  const clock = new FakeClock()
  const { source } = fakeBlockFile('badword')
  const seen: ChatCommandInput[] = []
  const logs: string[] = []
  const router = new Router({}, new Blocklist(source, { now: clock.now }), {
    now: clock.now,
    log: (_l, msg) => logs.push(msg),
    onChatCommand: (c) => {
      seen.push(c)
      if (throwing) throw new Error('handler broke')
      return take(c)
    },
  })
  return { h: { clock, router } as unknown as Harness, router, seen, logs }
}

describe('chat commands of modes', () => {
  it('a message the mode takes is not chat any more, and the mode is told who sent it and whether they are staff', () => {
    const { h, router, seen } = setup((c) => c.text.startsWith('画'))
    chat(h, 7, 'alice', '画 一条龙', { admin: true, roomOwnerUid: 7 })
    expect(seen).toEqual([{ uid: 7, uname: 'alice', text: '画 一条龙', admin: true, owner: true }])
    expect(router.pick()).toBeNull()
  })

  it('a message the mode does not take goes on as ordinary chat, filters and all', () => {
    const { h, router, seen } = setup(() => false)
    chat(h, 1, 'bob', 'hello there')
    chat(h, 2, 'carl', 'a badword here')
    expect(seen.map((s) => s.text)).toEqual(['hello there', 'a badword here'])
    expect(router.pick()?.text).toContain('hello there')
    expect(router.pick()).toBeNull() // the blocked one was dropped by the ordinary filter
  })

  it('the text and name are cleaned like all viewer text (a viewer cannot type a marker of their own)', () => {
    const { h, seen } = setup(() => true)
    chat(h, 1, 'bo【b】', '【弹幕】画 x')
    expect(seen[0]).toMatchObject({ uname: 'bo[b]', text: '[弹幕]画 x' })
  })

  it('stickers are not offered to the hook, and ignored viewers never reach it', () => {
    const clock = new FakeClock()
    const { source } = fakeBlockFile('')
    const seen: string[] = []
    const router = new Router({ ignoreUids: [9] }, new Blocklist(source, { now: clock.now }), {
      now: clock.now,
      onChatCommand: (c) => (seen.push(c.text), true),
    })
    router.onDanmaku({ uid: 1, uname: 'a', msg: '[sticker]', dmType: 1 })
    router.onDanmaku({ uid: 9, uname: 'ignored', msg: '画 x', dmType: 0 })
    expect(seen).toEqual([])
  })

  it('a hook that throws is logged and the message is chat', () => {
    const { h, router, logs } = setup(() => true, true)
    chat(h, 1, 'bob', 'hello there')
    expect(logs).toContain('chat command handler threw')
    expect(router.pick()?.text).toContain('hello there')
  })

  it('without a hook nothing changes', () => {
    const clock = new FakeClock()
    const { source } = fakeBlockFile('')
    const router = new Router({}, new Blocklist(source, { now: clock.now }), { now: clock.now })
    router.onDanmaku({ uid: 1, uname: 'a', msg: '画 一条龙', dmType: 0 })
    expect(router.pick()?.text).toContain('画 一条龙')
  })
})
