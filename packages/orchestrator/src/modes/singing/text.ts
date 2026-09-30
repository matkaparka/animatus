/** Small pure helpers of the sing mode: text that reaches the model or the panel, and comparing folders. */
import path from 'node:path'
import { cleanViewerText, truncateChars } from '../../inbox/text.ts'
import type { QueueItem } from './types.ts'

/**
 * A title, an artist or a name from outside (a song's own metadata, a viewer) as it may go into a line the model
 * reads: no marker brackets, one line, bounded. A song can be called anything, so it is treated like chat.
 */
export const safeText = (text: string, max = 120): string =>
  truncateChars(cleanViewerText(text), max)

export const safeArtists = (artists: readonly string[]): string[] =>
  artists.map((a) => safeText(a, 60)).filter((a) => a !== '')

export const artistsText = (artists: readonly string[]): string => artists.join(' / ')

/** `m:ss`. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Whether two folder names are the same folder (Windows folds case and takes either slash). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/** A line of the panel for an entry that has not been sung yet. */
export function stateText(item: QueueItem): string {
  switch (item.state) {
    case 'ready':
      return 'ready'
    case 'downloading':
      return 'fetching'
    case 'processing':
      return 'being prepared'
    case 'queued':
      return 'waiting to be prepared'
    case 'playing':
      return 'being sung'
    case 'failed':
      return `failed: ${item.reason ?? item.error ?? 'unknown reason'}`
  }
}

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text
