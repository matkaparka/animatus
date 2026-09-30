/** The pictures the mode drew, kept in `data/generated` (a library the stage is always served) and pruned to the newest few. */
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const NAME = /^draw-(\d+)-(\d+)\.png$/

export const isPng = (bytes: Buffer): boolean =>
  bytes.length > PNG_SIGNATURE.length &&
  bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)

/** Writes the picture under a name made of numbers only (safe to serve and to put in a URL). Returns the file name. */
export async function savePicture(
  dir: string,
  png: Buffer,
  stamp: number,
  seq: number
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const name = `draw-${Math.trunc(stamp)}-${seq}.png`
  // written under a hidden name first: the stage never sees half a picture
  const partial = path.join(dir, `.${name}.part`)
  await writeFile(partial, png)
  await rename(partial, path.join(dir, name))
  return name
}

/** Deletes all but the newest `keep` pictures of the mode. Returns how many went. */
export async function prunePictures(dir: string, keep: number): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  const drawn = names
    .flatMap((n) => {
      const m = NAME.exec(n)
      return m ? [{ name: n, stamp: Number(m[1]), seq: Number(m[2]) }] : []
    })
    .sort((a, b) => a.stamp - b.stamp || a.seq - b.seq)
  const old = drawn.slice(0, Math.max(0, drawn.length - keep))
  for (const f of old) await rm(path.join(dir, f.name), { force: true }).catch(() => undefined)
  return old.length
}
