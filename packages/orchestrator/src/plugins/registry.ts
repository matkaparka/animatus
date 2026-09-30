import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { PluginManifest, serviceName } from '@animatus/protocol'
import { parse as parseYaml } from 'yaml'

export type ProcessRuntime = Extract<PluginManifest['runtime'], { type: 'process' }>
export type ExternalRuntime = Extract<PluginManifest['runtime'], { type: 'external' }>

export interface RegistryEntry {
  /** Manifest id. */
  id: string
  /** Absolute path of the plugin directory. */
  dir: string
  /** Absolute path of its plugin.yaml. */
  manifestPath: string
  manifest: PluginManifest
  /** Effective service name (`service` or, when absent, the id). */
  service: string
}

/** A folder that looked like a plugin but could not be loaded. `id` is set when the YAML got that far. */
export interface RegistryError {
  id?: string
  dir: string
  error: string
}

/** One plugin's part of the user's configuration (`plugins.<id>` in the config file). */
export interface PluginConfigEntry {
  /** Anything other than `true` means disabled: nothing starts unless the user opted in. */
  enabled?: boolean
  /** The plugin's own settings, available to manifests as `{config.<key>}`. */
  config?: Record<string, unknown>
}
export type PluginConfigMap = Readonly<Record<string, PluginConfigEntry | undefined>>

const MAX_ERROR_LENGTH = 600

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.split(/\r?\n/, 1)[0] ?? text
}

function formatIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
): string {
  const text = issues
    .map((issue) => `${issue.path.map(String).join('.') || '(manifest)'}: ${issue.message}`)
    .join('; ')
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text
}

/**
 * Plugins found on disk. Loading never throws: a folder that cannot be loaded becomes an entry in
 * `errors()` so the console can show what is wrong instead of the orchestrator refusing to start.
 */
export class PluginRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  private readonly problems: RegistryError[] = []

  /**
   * Reads the plugin.yaml of every folder directly under `dir`. Folders whose name starts with `_` or
   * `.` are not plugins (the job guard lives in `_guard`). When two folders declare the same id, the
   * first in name order is kept and the others become errors.
   */
  static async scan(dir: string): Promise<PluginRegistry> {
    const registry = new PluginRegistry()
    await registry.load(resolve(dir))
    return registry
  }

  /** Loaded plugins, sorted by id. */
  list(): RegistryEntry[] {
    return [...this.entries.values()].sort((a, b) => compare(a.id, b.id))
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id)
  }

  /** Every plugin offering the service name, enabled or not, sorted by id. */
  byService(name: string): RegistryEntry[] {
    return this.list().filter((entry) => entry.service === name)
  }

  errors(): RegistryError[] {
    return [...this.problems]
  }

  isEnabled(id: string, config: PluginConfigMap): boolean {
    return this.entries.has(id) && config[id]?.enabled === true
  }

  /** Plugins the configuration turns on. */
  enabled(config: PluginConfigMap): RegistryEntry[] {
    return this.list().filter((entry) => config[entry.id]?.enabled === true)
  }

  /** Enabled plugins that offer the service. More than one is a configuration conflict. */
  enabledByService(name: string, config: PluginConfigMap): RegistryEntry[] {
    return this.byService(name).filter((entry) => config[entry.id]?.enabled === true)
  }

  /** Services offered by more than one enabled plugin (at most one may be enabled). */
  serviceConflicts(config: PluginConfigMap): { service: string; ids: string[] }[] {
    const byService = new Map<string, string[]>()
    for (const entry of this.enabled(config)) {
      byService.set(entry.service, [...(byService.get(entry.service) ?? []), entry.id])
    }
    return [...byService.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([service, ids]) => ({ service, ids }))
  }

  private async load(root: string): Promise<void> {
    let dirents: Dirent[]
    try {
      dirents = await readdir(root, { withFileTypes: true })
    } catch (err) {
      this.problems.push({
        dir: root,
        error: `cannot read the plugin directory: ${firstLine(err)}`,
      })
      return
    }
    const folders: string[] = []
    for (const dirent of dirents) {
      if (dirent.name.startsWith('_') || dirent.name.startsWith('.')) continue
      if (dirent.isDirectory()) folders.push(dirent.name)
      else if (dirent.isSymbolicLink()) {
        // a link to a directory counts (developers link plugin checkouts in)
        const target = await stat(join(root, dirent.name)).catch(() => undefined)
        if (target?.isDirectory()) folders.push(dirent.name)
      }
    }
    folders.sort(compare)
    for (const name of folders) await this.loadOne(join(root, name))
  }

  private async loadOne(dir: string): Promise<void> {
    const manifestPath = join(dir, 'plugin.yaml')
    let text: string
    try {
      text = await readFile(manifestPath, 'utf8')
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      this.problems.push({
        dir,
        error: missing ? 'missing plugin.yaml' : `cannot read plugin.yaml: ${firstLine(err)}`,
      })
      return
    }

    let raw: unknown
    try {
      raw = parseYaml(text.replace(/^\uFEFF/, ''))
    } catch (err) {
      this.problems.push({ dir, error: `plugin.yaml is not valid YAML: ${firstLine(err)}` })
      return
    }
    const rawId = isRecord(raw) && typeof raw.id === 'string' ? raw.id : undefined

    const parsed = PluginManifest.safeParse(raw)
    if (!parsed.success) {
      this.problems.push({
        id: rawId,
        dir,
        error: `invalid manifest: ${formatIssues(parsed.error.issues)}`,
      })
      return
    }
    const manifest = parsed.data
    const existing = this.entries.get(manifest.id)
    if (existing) {
      this.problems.push({
        id: manifest.id,
        dir,
        error: `duplicate plugin id "${manifest.id}" (already defined by the folder "${basename(existing.dir)}")`,
      })
      return
    }
    this.entries.set(manifest.id, {
      id: manifest.id,
      dir,
      manifestPath,
      manifest,
      service: serviceName(manifest),
    })
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
