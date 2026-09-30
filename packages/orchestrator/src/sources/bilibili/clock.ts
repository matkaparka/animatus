/** Injectable time source: everything time-based in the source goes through it. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number
  /** Runs `fn` once after `ms` milliseconds. Returns a function that cancels the timer. */
  setTimeout(fn: () => void, ms: number): () => void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
}
