/** A small JSON file the program keeps for itself in `data/`: read once, written atomically, never throws. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse((await readFile(file, 'utf8')).replace(/^\u{FEFF}/u, '')) as T
  } catch {
    return fallback
  }
}

/** Writes to one file run one after the other, each with the value it was given, so the last call wins. */
const chains = new Map<string, Promise<void>>()

async function write(file: string, text: string, log?: (msg: string) => void): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  } catch (e) {
    log?.(
      `${path.basename(file)} could not be written: ${(e as Error).message.split(/\r?\n/, 1)[0]}`
    )
  }
}

export function writeJson(
  file: string,
  value: unknown,
  log?: (msg: string) => void
): Promise<void> {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch (e) {
    log?.(`${path.basename(file)} could not be written: ${(e as Error).message}`)
    return Promise.resolve()
  }
  const next = (chains.get(file) ?? Promise.resolve()).then(() => write(file, text, log))
  chains.set(file, next)
  void next.then(() => {
    if (chains.get(file) === next) chains.delete(file)
  })
  return next
}

/** Resolves when every write started so far has finished (shutdown, tests). */
export async function flushJson(): Promise<void> {
  while (chains.size) await Promise.all([...chains.values()])
}
