/**
 * The strings the brain reads.
 *
 * Every line the inbox hands to the brain starts with a marker such as `【弹幕】` (chat message) or
 * `【SC ¥30】` (paid message), and the persona prompts refer to those markers by name. The strings below
 * are therefore PROMPT-VISIBLE product behaviour, not display text: change one only together with the
 * prompts that mention it, and keep them byte-identical otherwise.
 *
 * Viewer-controlled parts (names, message text, keywords) must go through `cleanViewerText` before they
 * reach these functions; that is what stops a viewer from typing a marker of their own.
 */

const DANMAKU_PREFIX = '【弹幕】'
const SLEEP_PREFIX = '【助眠】'

/** Guard (subscription tier) titles by platform level; anything else is the lowest tier. */
const GUARD_TITLES: Readonly<Record<number, string>> = { 1: '总督', 2: '提督', 3: '舰长' }
const GUARD_TITLE_DEFAULT = '舰长'

export const FORMATS = {
  /** Shown in place of a viewer name that matched the blocklist. */
  anonymousViewer: '一位观众',

  /** Prefix of an ordinary chat message line. */
  danmakuPrefix: DANMAKU_PREFIX,
  /** Prefix that replaces `danmakuPrefix` when a chat message is answered in sleep mode. */
  sleepPrefix: SLEEP_PREFIX,

  danmaku: (name: string, text: string): string => `${DANMAKU_PREFIX}${name}：${text}`,

  superChat: (price: number, name: string, text: string): string =>
    `【SC ¥${price}】${name}：${text}`,
  /** Replaces the content of a paid message that matched the blocklist: thank, but do not repeat it. */
  superChatRedacted: '（留言内容已被过滤，只道谢，不要提内容）',

  /** A guard subscription; `months` above one is spelled out. */
  guard: (name: string, level: number, months: number): string => {
    const title = GUARD_TITLES[level] ?? GUARD_TITLE_DEFAULT
    const span = months > 1 ? `（${months}个月）` : ''
    return `【上舰】${name} 开通了${title}${span}`
  },

  gift: (name: string, count: number, giftName: string): string =>
    `【礼物】${name} 送了 ${count} 个 ${giftName}`,

  /** A gift that asks the streamer to dance. */
  dance: (name: string, count: number, giftName: string): string =>
    `【点舞】${name} 送了 ${count} 个 ${giftName}，点名要看你跳舞`,

  /** Nobody has said anything for a while. `minutes` is whole minutes. */
  cold: (minutes: number): string => `【冷场】已经${minutes}分钟没有人发弹幕了`,

  // ---- song requests. The router does not produce these: whatever talks to the song service does,
  // and hands the finished line to `Router.addSongLine`. They live here so that every prompt-visible
  // string is in one table.

  /** A request was accepted. `cached` means the song is already prepared. */
  songQueued: (
    who: string,
    title: string,
    artists: readonly string[],
    position: number,
    cached: boolean
  ): string =>
    `【点歌】${who} 点了《${title}》（${artists.join('/')}），排在第 ${position} 首，${
      cached ? '已经准备好了' : '要准备几分钟'
    }`,

  songFailed: (who: string, keyword: string, reason: string): string =>
    `【点歌】${who} 想点「${keyword}」，没点成：${reason}`,

  /** The service could not be reached. */
  songUnavailable: (who: string, keyword: string): string =>
    `【点歌】${who} 想点「${keyword}」，但点歌系统现在没开`,

  /** A moderator removed an entry from the queue. */
  songRemoved: (who: string, title: string): string =>
    `【点歌】${who} 把队列里的《${title}》删掉了`,

  songCancelled: (who: string, title: string): string =>
    `【点歌】${who} 取消了自己点的《${title}》`,

  /** The requester cancelled the song that is being sung right now. */
  songCancelledWhilePlaying: (who: string, title: string): string =>
    `【点歌】${who} 取消了自己点的《${title}》，正在唱的这首停了`,

  /** Somebody asked what is in the queue; `body` comes from `songListBody`. */
  songList: (who: string, body: string): string => `【歌单】${who} 问现在的点歌队列：${body}`,

  /** The queue as read aloud: the current song first, then the numbered entries. */
  songListBody: (
    current: string | null,
    items: readonly { title: string; requester: string; ready: boolean }[]
  ): string => {
    const head = current ? `正在唱《${current}》；` : ''
    const entries = items.map(
      (item, i) =>
        `${i + 1}.《${item.title}》（${item.requester} 点的，${item.ready ? '准备好了' : '还在准备'}）`
    )
    return head + (entries.length > 0 ? entries.join('；') : '后面没有排队的歌')
  },
} as const
