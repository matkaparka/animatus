/** Small formatting helpers. Everything returns plain strings for React text nodes. */

export const NOT_MEASURED = 'not measured'

/** A memory figure in MiB; `null` (never measured) says so instead of inventing a number. */
export function formatMb(mb: number | null | undefined): string {
  return mb === null || mb === undefined ? NOT_MEASURED : `${Math.round(mb)} MiB`
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** "12 s ago", "3 min ago", "2 h ago". */
export function formatAgo(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}

export function formatMs(ms: number | undefined): string {
  return ms === undefined ? '-' : `${Math.round(ms)} ms`
}

export function formatSeconds(sec: number | undefined): string {
  return sec === undefined ? '-' : `${sec.toFixed(1)} s`
}

/** Log lines from services may carry ANSI colour codes; the console shows plain text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}
