/**
 * Mode packs on disk: `modes/<id>/mode.yaml` and `modes/<id>/prompts/*.md`.
 *
 * Packs are looked for in several folders, in order (the repository's `modes/`, then the operator's own
 * `config/modes/`). A later folder wins file by file: the operator can replace one prompt of a shipped mode,
 * or add a whole mode, without touching anything the repository ships. A folder that cannot be loaded is
 * reported and skipped; it never stops the others.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { ModeManifest } from '@animatus/protocol'
import { parse as parseYaml } from 'yaml'

export interface LoadedMode {
  manifest: ModeManifest
  /** The folder whose `mode.yaml` was used. */
  dir: string
  /** Every prompt file by name without extension (`available`, `cooldown`, ...), later folders overriding earlier ones. */
  prompts: Map<string, string>
  /** The prompt the manifest names for while the mode is active (`prompt:`), or null. */
  activePrompt: string | null
}

export interface ModePackError {
  dir: string
  error: string
}

const firstLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split(/\r?\n/, 1)[0] ?? ''

async function isDir(p: string): Promise<boolean> {
  return stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false)
}

export async function loadModePacks(
  roots: readonly string[]
): Promise<{ modes: LoadedMode[]; errors: ModePackError[] }> {
  const errors: ModePackError[] = []
  const byId = new Map<string, LoadedMode>()

  for (const root of roots) {
    if (!(await isDir(root))) continue
    const entries = (await readdir(root, { withFileTypes: true })).filter(
      (e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')
    )
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const dir = path.join(root, entry.name)
      const manifestPath = path.join(dir, 'mode.yaml')
      let manifest: ModeManifest | undefined
      try {
        const text = await readFile(manifestPath, 'utf8')
        const parsed = ModeManifest.safeParse(parseYaml(text.replace(/^\u{FEFF}/u, '')))
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join('.') || '(manifest)'}: ${i.message}`)
            .join('; ')
          throw new Error(`invalid mode.yaml: ${issues}`)
        }
        manifest = parsed.data
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          // A folder with prompts only: it overrides files of a mode defined elsewhere.
          if (!byId.has(entry.name)) errors.push({ dir, error: 'missing mode.yaml' })
        } else errors.push({ dir, error: firstLine(e) })
        if (!manifest && !byId.has(entry.name)) continue
      }
      const id = manifest?.id ?? entry.name
      if (manifest && manifest.id !== entry.name) {
        errors.push({
          dir,
          error: `the folder is called "${entry.name}" but mode.yaml says id "${manifest.id}"`,
        })
        continue
      }
      const previous = byId.get(id)
      const prompts = new Map(previous?.prompts ?? [])
      const promptDir = path.join(dir, 'prompts')
      if (await isDir(promptDir)) {
        for (const f of (await readdir(promptDir)).filter((n) => n.endsWith('.md')).sort()) {
          try {
            prompts.set(
              f.slice(0, -3),
              (await readFile(path.join(promptDir, f), 'utf8')).replace(/^\u{FEFF}/u, '').trim()
            )
          } catch (e) {
            errors.push({ dir: path.join(promptDir, f), error: firstLine(e) })
          }
        }
      }
      const chosen = manifest ?? previous?.manifest
      if (!chosen) continue
      const activeName = chosen.prompt ? path.basename(chosen.prompt).replace(/\.md$/i, '') : null
      byId.set(id, {
        manifest: chosen,
        dir: manifest ? dir : (previous?.dir ?? dir),
        prompts,
        activePrompt: activeName ? (prompts.get(activeName) ?? null) : null,
      })
    }
  }
  return {
    modes: [...byId.values()].sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1)),
    errors,
  }
}
