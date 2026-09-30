import { describe, expect, it } from 'vitest'
import { FORMATS } from '../../src/inbox/formats.ts'

// The expected strings are written out in full on purpose: the persona prompts depend on them byte for
// byte, so the test must not be built from the same table it checks.

describe('FORMATS (prompt-visible strings)', () => {
  it('chat lines', () => {
    expect(FORMATS.danmaku('alice', 'hello there')).toBe('【弹幕】alice：hello there')
    expect(FORMATS.danmakuPrefix).toBe('【弹幕】')
    expect(FORMATS.sleepPrefix).toBe('【助眠】')
    expect(FORMATS.anonymousViewer).toBe('一位观众')
  })

  it('paid message lines use the yen sign U+00A5 and a full-width colon', () => {
    const line = FORMATS.superChat(30, 'carol', 'thanks')
    expect(line).toBe('【SC ¥30】carol：thanks')
    expect(line.codePointAt(4)).toBe(0xa5)
    expect(line.includes('：')).toBe(true)
    expect(FORMATS.superChatRedacted).toBe('（留言内容已被过滤，只道谢，不要提内容）')
  })

  it('guard lines name the tier and spell out months above one', () => {
    expect(FORMATS.guard('dave', 1, 1)).toBe('【上舰】dave 开通了总督')
    expect(FORMATS.guard('dave', 2, 1)).toBe('【上舰】dave 开通了提督')
    expect(FORMATS.guard('dave', 3, 1)).toBe('【上舰】dave 开通了舰长')
    expect(FORMATS.guard('dave', 3, 3)).toBe('【上舰】dave 开通了舰长（3个月）')
    expect(FORMATS.guard('dave', 3, 2)).toBe('【上舰】dave 开通了舰长（2个月）')
    expect(FORMATS.guard('dave', 3, 0)).toBe('【上舰】dave 开通了舰长')
  })

  it('an unknown guard level is the lowest tier', () => {
    expect(FORMATS.guard('dave', 0, 1)).toBe('【上舰】dave 开通了舰长')
    expect(FORMATS.guard('dave', 4, 1)).toBe('【上舰】dave 开通了舰长')
    expect(FORMATS.guard('dave', 1.5, 1)).toBe('【上舰】dave 开通了舰长')
  })

  it('gift, dance and cold-start lines', () => {
    expect(FORMATS.gift('erin', 3, 'rose')).toBe('【礼物】erin 送了 3 个 rose')
    expect(FORMATS.dance('erin', 3, 'star')).toBe('【点舞】erin 送了 3 个 star，点名要看你跳舞')
    expect(FORMATS.cold(5)).toBe('【冷场】已经5分钟没有人发弹幕了')
  })

  it('song request results', () => {
    expect(FORMATS.songQueued('frank', 'Song A', ['One', 'Two'], 2, true)).toBe(
      '【点歌】frank 点了《Song A》（One/Two），排在第 2 首，已经准备好了'
    )
    expect(FORMATS.songQueued('frank', 'Song A', [], 1, false)).toBe(
      '【点歌】frank 点了《Song A》（），排在第 1 首，要准备几分钟'
    )
    expect(FORMATS.songFailed('frank', 'some song', 'not found')).toBe(
      '【点歌】frank 想点「some song」，没点成：not found'
    )
    expect(FORMATS.songUnavailable('frank', 'some song')).toBe(
      '【点歌】frank 想点「some song」，但点歌系统现在没开'
    )
    expect(FORMATS.songRemoved('gina', 'Song A')).toBe('【点歌】gina 把队列里的《Song A》删掉了')
    expect(FORMATS.songCancelled('frank', 'Song A')).toBe('【点歌】frank 取消了自己点的《Song A》')
    expect(FORMATS.songCancelledWhilePlaying('frank', 'Song A')).toBe(
      '【点歌】frank 取消了自己点的《Song A》，正在唱的这首停了'
    )
  })

  it('the queue as read aloud', () => {
    expect(FORMATS.songListBody(null, [])).toBe('后面没有排队的歌')
    expect(FORMATS.songListBody('Song A', [])).toBe('正在唱《Song A》；后面没有排队的歌')
    expect(
      FORMATS.songListBody('Song A', [
        { title: 'Song B', requester: 'bob', ready: true },
        { title: 'Song C', requester: 'carol', ready: false },
      ])
    ).toBe(
      '正在唱《Song A》；1.《Song B》（bob 点的，准备好了）；2.《Song C》（carol 点的，还在准备）'
    )
    expect(FORMATS.songListBody(null, [{ title: 'Song B', requester: 'bob', ready: false }])).toBe(
      '1.《Song B》（bob 点的，还在准备）'
    )
    expect(FORMATS.songList('alice', '后面没有排队的歌')).toBe(
      '【歌单】alice 问现在的点歌队列：后面没有排队的歌'
    )
  })
})
