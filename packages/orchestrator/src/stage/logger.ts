import { inspect } from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Injectable logger used by the stage gateway. `extra` carries structured context (never secrets). */
export type Logger = (level: LogLevel, msg: string, extra?: Record<string, unknown>) => void

export const noopLogger: Logger = () => {}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Error instances do not survive `inspect` in a compact form; reduce them to name + message. */
function compact(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value instanceof Error ? `${value.name}: ${value.message}` : value
  }
  return out
}

/** A logger that writes one line per call to `sink` (stderr by default), dropping levels below `minLevel`. */
export function createConsoleLogger(
  minLevel: LogLevel = 'info',
  sink: (line: string) => void = (line) => console.error(line)
): Logger {
  return (level, msg, extra) => {
    if (ORDER[level] < ORDER[minLevel]) return
    const tail = extra ? ` ${inspect(compact(extra), { depth: 3, breakLength: Infinity })}` : ''
    sink(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`)
  }
}
