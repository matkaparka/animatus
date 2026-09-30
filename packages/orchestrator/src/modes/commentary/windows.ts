/** The list of windows the panel offers: read from the capture service on request and when the panel is drawn. */
import type { ModeHost } from '../host.ts'
import type { WindowInfo } from './captureClient.ts'
import { firstLine } from './memory.ts'
import type { CommentarySettings } from './settings.ts'
import { SERVICE_DOWN } from './target.ts'
import type { Target } from './target.ts'

/** The list is read again when the panel is drawn and it is older than this. */
const MAX_AGE_MS = 10_000

export interface WindowList {
  windows(): readonly WindowInfo[]
  /** Why the list may be missing or out of date; null when it is fine. */
  note(): string | null
  /** Reads the list now (`force`) or when it is old. Never rejects; says why when it could not. */
  refresh(force: boolean): Promise<{ ok: boolean; reason?: string }>
}

export function createWindowList(d: {
  host: Pick<ModeHost, 'serviceUrl' | 'now'>
  cfg: CommentarySettings
  target: Target
}): WindowList {
  const { host, cfg, target } = d
  let windows: readonly WindowInfo[] = []
  let readAt = 0
  let busy = false
  let note: string | null = null

  return {
    windows: () => windows,
    note: () => note,

    async refresh(force) {
      if (host.serviceUrl(cfg.service) === null) {
        // a list from before the service went away would be shown as if it were current
        windows = []
        note = `${SERVICE_DOWN}: it starts with the mode`
        return { ok: false, reason: note }
      }
      if (busy || (!force && host.now() - readAt < MAX_AGE_MS)) return { ok: true }
      busy = true
      try {
        windows = await target.client().windows()
        note = null
        return { ok: true }
      } catch (e) {
        note = `the window list could not be read: ${firstLine(e)}`
        return { ok: false, reason: note }
      } finally {
        readAt = host.now()
        busy = false
      }
    },
  }
}
