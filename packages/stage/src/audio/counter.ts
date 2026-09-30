/**
 * Counts AudioContext creations and closures, whoever makes them (this code, wlipsync, anything else).
 * The soak test asserts the numbers do not grow: the legacy stage created two contexts per model load
 * and never closed them. Install before anything else touches Web Audio.
 */
interface Counters {
  created: number
  open: number
}

const counters: Counters = { created: 0, open: 0 }

export const audioContextStats = (): Readonly<Counters> => counters

export function installAudioContextCounter(g: typeof globalThis = globalThis): void {
  const w = g as unknown as { AudioContext?: typeof AudioContext; __animatusAudioCounter?: boolean }
  const Native = w.AudioContext
  if (!Native || w.__animatusAudioCounter) return
  w.__animatusAudioCounter = true

  class CountedAudioContext extends Native {
    #closed = false
    constructor(options?: AudioContextOptions) {
      super(options)
      counters.created++
      counters.open++
    }
    override close(): Promise<void> {
      if (!this.#closed) {
        this.#closed = true
        counters.open--
      }
      return super.close()
    }
  }
  w.AudioContext = CountedAudioContext
}
