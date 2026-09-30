/** Resolves after `ms`, or early when `signal` aborts. Resolves to true when the full time elapsed. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Lets pending I/O callbacks run (used to keep the event loop responsive in long send loops). */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Drops a UTF-8 byte order mark, which some Windows editors put at the start of JSON files. */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
