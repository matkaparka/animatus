/**
 * Who asked for a picture and when, so that one viewer waits `cooldown_sec` between requests, also across a restart.
 * A viewer is told apart by user id (name, when the platform gives none). What is kept is when they asked, not when
 * they may ask again, so a changed `cooldown_sec` applies to the ones already waiting.
 */
import { readJson, writeJson } from '../jsonfile.ts'

export const cooldownKey = (uid: number, uname: string): string =>
  uid > 0 ? `u${uid}` : `n:${uname}`

interface Persisted {
  asked?: Record<string, unknown>
}

export class Cooldowns {
  private asked = new Map<string, number>()
  private loading: Promise<void> | null = null

  constructor(
    private readonly file: string,
    private readonly cooldownMs: () => number,
    private readonly now: () => number,
    private readonly log: (msg: string) => void
  ) {}

  /** Reads the file once; every caller waits for the same read, so nothing runs on half-loaded state. */
  load(): Promise<void> {
    return (this.loading ??= (async () => {
      const raw = await readJson<unknown>(this.file, {})
      const saved = raw && typeof raw === 'object' ? (raw as Persisted).asked : undefined
      if (!saved || typeof saved !== 'object') return
      for (const [key, at] of Object.entries(saved))
        if (typeof at === 'number' && Number.isFinite(at) && this.now() - at < this.cooldownMs())
          this.asked.set(key, at)
    })())
  }

  /** Milliseconds this viewer still has to wait; 0 when they may ask. */
  left(key: string): number {
    const at = this.asked.get(key)
    return at === undefined ? 0 : Math.max(0, at + this.cooldownMs() - this.now())
  }

  start(key: string): void {
    this.asked.set(key, this.now())
    this.save()
  }

  /** A request that failed through no fault of the viewer does not count. */
  refund(key: string): void {
    if (this.asked.delete(key)) this.save()
  }

  private save(): void {
    for (const [key, at] of this.asked)
      if (this.now() - at >= this.cooldownMs()) this.asked.delete(key)
    void writeJson(this.file, { asked: Object.fromEntries(this.asked) }, this.log)
  }
}
