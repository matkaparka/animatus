/** The memory of the stream and the file it lives in (`data/commentary-state.json`). */
import { readJson, writeJson } from '../jsonfile.ts'
import { emptyMemory, memoryFileContent, parseMemory } from './memory.ts'
import type { MemoryState } from './memory.ts'

export class MemoryStore {
  state: MemoryState = emptyMemory()
  /** Bumped when the memory is cleared or the game changes: a model answer that was asked before is about something else. */
  epoch = 0
  private loading: Promise<void> | null = null

  constructor(
    private readonly file: string,
    private readonly summaryMax: number,
    private readonly warn: (message: string) => void
  ) {}

  /** Reads the saved state once; every caller waits for the same read, so nothing runs on half-loaded state. */
  load(): Promise<void> {
    return (this.loading ??= (async () => {
      this.state = parseMemory(await readJson<unknown>(this.file, null), this.summaryMax)
    })())
  }

  /** Writes it down. Writes to one file run one after the other, so the last call wins. */
  save(): void {
    void writeJson(this.file, memoryFileContent(this.state), this.warn)
  }

  /** Forgets the game and the story. The window and the interval are the operator's settings and stay. */
  clear(): void {
    this.state = { ...emptyMemory(), window: this.state.window, interval: this.state.interval }
    this.epoch++
    this.save()
  }
}
