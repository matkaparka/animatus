import {
  Blocklist,
  Pacer,
  Router,
  type BlocklistSource,
  type DanmakuInput,
  type DropInfo,
  type DropReason,
  type InboxConfigInput,
  type InboxLogLevel,
  type PacerState,
  type SongCommand,
} from '../../src/inbox/index.ts'

export const SEC = 1000
export const MIN = 60_000

/** A clock the test moves by hand. */
export class FakeClock {
  t: number
  constructor(start = 1_000_000) {
    this.t = start
  }
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
  set(ms: number): void {
    this.t = ms
  }
}

/** A blocklist whose file is a variable: change `file.content` / `file.mtimeMs`, or set content to null. */
export function fakeBlockFile(content: string | null = '') {
  const file: { content: string | null; mtimeMs: number } = { content, mtimeMs: 1 }
  const source: BlocklistSource = () =>
    file.content === null ? null : { mtimeMs: file.mtimeMs, content: file.content }
  return { file, source }
}

export interface Logged {
  level: InboxLogLevel
  msg: string
  extra: Record<string, unknown> | undefined
}

export interface Harness {
  clock: FakeClock
  router: Router
  block: Blocklist
  /** The word list's file: change it and advance the clock past 5 s for the router to see it. */
  file: { content: string | null; mtimeMs: number }
  drops: { reason: DropReason; info: DropInfo }[]
  commands: SongCommand[]
  logs: Logged[]
  /** Reasons only, in order. */
  reasons(): DropReason[]
}

/** A router with a fake clock, a word list and recorders for drops, song commands and log lines. */
export function setup(
  config: InboxConfigInput = {},
  words: string[] = [],
  start = 1_000_000
): Harness {
  const clock = new FakeClock(start)
  const drops: Harness['drops'] = []
  const commands: SongCommand[] = []
  const logs: Logged[] = []
  const { source, file } = fakeBlockFile(words.join('\n'))
  const block = new Blocklist(source, { now: clock.now })
  const router = new Router(config, block, {
    now: clock.now,
    log: (level, msg, extra) => logs.push({ level, msg, extra }),
    onDrop: (reason, info) => drops.push({ reason, info }),
    onSongCommand: (cmd) => commands.push(cmd),
  })
  return {
    clock,
    router,
    block,
    file,
    drops,
    commands,
    logs,
    reasons: () => drops.map((d) => d.reason),
  }
}

/** A chat message from a viewer. */
export function chat(
  h: Harness,
  uid: number,
  uname: string,
  msg: string,
  extra: Partial<DanmakuInput> = {}
): void {
  h.router.onDanmaku({ uid, uname, msg, dmType: 0, ...extra })
}

/** A gift; paid by default. `total` is in gold seeds, 1000 to the yuan. */
export function gift(
  h: Harness,
  uid: number,
  uname: string,
  giftName: string,
  num: number,
  total: number,
  coinType = 'gold'
): void {
  h.router.onGift({ uid, uname, gift: giftName, num, coinType, totalCoin: total })
}

export const idle: PacerState = {
  connected: true,
  speaking: false,
  processing: false,
  dancing: false,
  singing: false,
  sleeping: false,
  queued: 0,
}

export function state(over: Partial<PacerState> = {}): PacerState {
  return { ...idle, ...over }
}

/** A router and a pacer sharing one fake clock. */
export function pacerSetup(config: InboxConfigInput = {}, words: string[] = [], start = 1_000_000) {
  const h = setup(config, words, start)
  const pacer = new Pacer(h.router, config)
  return { ...h, pacer }
}
