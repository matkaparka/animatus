/** The alarms of the commentary mode: one per code, refreshed when its words change, all withdrawn together. */
import type { ModeHost } from '../host.ts'

export type AlarmLevel = 'info' | 'warn' | 'error'

export function createAlarms(host: Pick<ModeHost, 'alarm' | 'clearAlarm'>, subject: string) {
  const raised = new Map<string, string>()
  return {
    /** Raises the alarm, or refreshes its words; true when this changed what the operator sees. */
    raise(code: string, level: AlarmLevel, message: string): boolean {
      if (raised.get(code) === message) return false
      if (raised.has(code)) host.clearAlarm(code, subject)
      host.alarm(code, level, message, subject)
      raised.set(code, message)
      return true
    },

    /** The problem is over. */
    clear(code: string): void {
      if (raised.delete(code)) host.clearAlarm(code, subject)
    },

    /** The mode ends: nothing of it stays on the alarm board. */
    clearAll(): void {
      for (const code of [...raised.keys()]) {
        raised.delete(code)
        host.clearAlarm(code, subject)
      }
    },
  }
}

export type Alarms = ReturnType<typeof createAlarms>
