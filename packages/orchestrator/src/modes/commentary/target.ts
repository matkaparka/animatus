/** The window being watched: what it is called, the ways to find it again, and taking its picture. */
import type { ModeHost } from '../host.ts'
import { CaptureError, createCaptureClient } from './captureClient.ts'
import type { CaptureClient, CapturedFrame } from './captureClient.ts'
import { cleanTitle } from './memory.ts'
import type { WindowPick } from './memory.ts'
import type { CommentarySettings } from './settings.ts'
import type { MemoryStore } from './store.ts'

export const SERVICE_DOWN = 'the screen capture service is not running'

/** What a capture was like, in a line for the panel. */
export function describeShot(f: CapturedFrame): string {
  return `${f.sourceWidth}x${f.sourceHeight} sent as ${f.width}x${f.height}, brightness ${Math.round(f.brightness)}${
    f.black ? ' (black)' : ''
  }, ${f.method}`
}

export interface Target {
  /** The capture service's client; throws `service_down` while the service is not running. */
  client(): CaptureClient
  /** The window as the operator would name it; null when none is chosen. */
  label(): string | null
  /** The ways to name the window, most exact first; empty when none is chosen. */
  queries(): string[]
  /** One picture of the window. */
  capture(signal?: AbortSignal): Promise<CapturedFrame>
}

export function createTarget(d: {
  host: Pick<ModeHost, 'serviceUrl'>
  cfg: CommentarySettings
  store: MemoryStore
  makeClient?: (baseUrl: string, opts: { timeoutMs: number }) => CaptureClient
}): Target {
  const { host, cfg, store } = d
  const makeClient = d.makeClient ?? createCaptureClient
  let cached: { url: string; api: CaptureClient } | null = null

  const client = (): CaptureClient => {
    const url = host.serviceUrl(cfg.service)
    if (!url)
      throw new CaptureError('service_down', `${SERVICE_DOWN}: it starts with the mode`, true)
    if (cached?.url !== url)
      cached = { url, api: makeClient(url, { timeoutMs: cfg.capture_timeout_sec * 1000 }) }
    return cached.api
  }

  const label = (): string | null => {
    const pick = store.state.window
    if (pick) return pick.title || (pick.process ? `exe:${pick.process}` : `window ${pick.id}`)
    return cfg.window
  }

  /** The operator's pick by id, by title, by program; or the window of the settings. */
  const queries = (): string[] => {
    const pick = store.state.window
    if (pick) {
      const names = [pick.id, pick.title, pick.process ? `exe:${pick.process}` : null]
      return [...new Set(names.filter((q): q is string => q !== null && q !== ''))]
    }
    return cfg.window ? [cfg.window] : []
  }

  /** After a capture by a fallback name worked, keep what the window is called now, so the next pass finds it at once. */
  const remember = (w: CapturedFrame['window']) => {
    const pick = store.state.window
    // a window the operator typed the name of stays as typed ("part of a title" would not survive being made exact)
    if (!pick || pick.id === null) return
    const next: WindowPick = {
      id: w.id,
      title: cleanTitle(w.title),
      process: cleanTitle(w.process, 260),
    }
    if (pick.id === next.id && pick.title === next.title && pick.process === next.process) return
    store.state.window = next
    store.save()
  }

  /** Only "no such window" moves on to the next way of naming it; anything else would fail the same way. */
  const capture = async (signal?: AbortSignal): Promise<CapturedFrame> => {
    const names = queries()
    if (names.length === 0) throw new CaptureError('no_window', 'no window is chosen yet', false)
    const api = client()
    let last: unknown
    for (const name of names) {
      try {
        const frame = await api.capture({
          window: name,
          maxWidth: cfg.capture_width,
          quality: cfg.capture_quality,
          blackThreshold: cfg.black_threshold,
          method: cfg.capture_method,
          ...(signal ? { signal } : {}),
        })
        remember(frame.window)
        return frame
      } catch (e) {
        last = e
        if (!(e instanceof CaptureError) || e.code !== 'window_not_found') throw e
      }
    }
    throw last
  }

  return { client, label, queries, capture }
}
