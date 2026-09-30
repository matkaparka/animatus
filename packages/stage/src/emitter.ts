/** Minimal typed event emitter (the stage has no framework and no state container). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => void

export class Emitter<Events extends { [K in keyof Events]: unknown[] }> {
  private handlers = new Map<keyof Events, Set<Handler>>()

  on<K extends keyof Events>(type: K, fn: (...args: Events[K]) => void): () => void {
    let set = this.handlers.get(type)
    if (!set) this.handlers.set(type, (set = new Set()))
    set.add(fn)
    return () => set.delete(fn)
  }

  emit<K extends keyof Events>(type: K, ...args: Events[K]): void {
    const set = this.handlers.get(type)
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(...args)
      } catch (e) {
        console.error(`[stage] handler for "${String(type)}" threw`, e)
      }
    }
  }
}
