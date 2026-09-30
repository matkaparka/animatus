import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import { cleanupAll, makeTempDir } from './helpers.ts'

afterEach(cleanupAll)

const manifest = (id: string, extra = '') => `
id: ${id}
title: Plugin ${id}
kind: custom
runtime:
  type: process
  env: node
  command: ["{python}", "service.mjs", "--port", "{port}"]
health:
  http: { path: /health }
${extra}
`

/** Creates `<root>/<folder>/plugin.yaml` (or just the folder when `yaml` is undefined). */
async function plugin(root: string, folder: string, yaml?: string): Promise<string> {
  const dir = join(root, folder)
  await mkdir(dir, { recursive: true })
  if (yaml !== undefined) await writeFile(join(dir, 'plugin.yaml'), yaml)
  return dir
}

describe('PluginRegistry.scan', () => {
  it('loads valid manifests, sorted by id, with defaults applied', async () => {
    const root = await makeTempDir()
    const zetaDir = await plugin(root, 'zeta', manifest('zeta'))
    await plugin(root, 'alpha', manifest('alpha', 'service: speech'))
    const registry = await PluginRegistry.scan(root)

    expect(registry.errors()).toEqual([])
    expect(registry.list().map((entry) => entry.id)).toEqual(['alpha', 'zeta'])
    const zeta = registry.get('zeta')
    expect(zeta).toBeDefined()
    expect(zeta?.dir).toBe(zetaDir)
    expect(zeta?.manifestPath).toBe(join(zetaDir, 'plugin.yaml'))
    expect(zeta?.service).toBe('zeta') // service defaults to the id
    expect(zeta?.manifest.runtime.type).toBe('process')
    expect(zeta?.manifest.restart.policy).toBe('on-failure') // schema defaults survive
    expect(registry.get('alpha')?.service).toBe('speech')
    expect(registry.get('missing')).toBeUndefined()
  })

  it('accepts a UTF-8 byte order mark', async () => {
    const root = await makeTempDir()
    await plugin(root, 'bom', `\uFEFF${manifest('bom')}`)
    const registry = await PluginRegistry.scan(root)
    expect(registry.errors()).toEqual([])
    expect(registry.get('bom')).toBeDefined()
  })

  it('records a bad manifest as an error entry and keeps loading the others', async () => {
    const root = await makeTempDir()
    const badDir = await plugin(
      root,
      'bad-kind',
      manifest('bad-kind').replace('kind: custom', 'kind: nonsense')
    )
    await plugin(root, 'good', manifest('good'))
    const registry = await PluginRegistry.scan(root)

    expect(registry.list().map((entry) => entry.id)).toEqual(['good'])
    const errors = registry.errors()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.id).toBe('bad-kind')
    expect(errors[0]?.dir).toBe(badDir)
    expect(errors[0]?.error).toMatch(/^invalid manifest: .*kind/)
    expect(registry.get('bad-kind')).toBeUndefined()
  })

  it('reports schema problems by field path', async () => {
    const root = await makeTempDir()
    await plugin(
      root,
      'no-health',
      'id: no-health\ntitle: x\nkind: custom\nruntime: { type: inprocess }\n'
    )
    await plugin(root, 'upper', manifest('Upper_Case'))
    const registry = await PluginRegistry.scan(root)
    const byFolder = Object.fromEntries(
      registry.errors().map((e) => [e.dir.split(/[\\/]/).pop(), e])
    )
    expect(byFolder['no-health']?.id).toBe('no-health')
    expect(byFolder['no-health']?.error).toMatch(/health/)
    expect(byFolder['upper']?.id).toBe('Upper_Case') // the raw id is kept so the console can name the plugin
    expect(byFolder['upper']?.error).toMatch(/id: /)
  })

  it('records YAML syntax errors, empty files, unreadable structure and missing manifests', async () => {
    const root = await makeTempDir()
    await plugin(root, 'syntax', 'id: [unclosed\n  title: x\n')
    await plugin(root, 'empty', '')
    await plugin(root, 'scalar', 'just a string\n')
    await plugin(root, 'no-manifest')
    const registry = await PluginRegistry.scan(root)

    expect(registry.list()).toEqual([])
    const errors = Object.fromEntries(
      registry.errors().map((e) => [e.dir.split(/[\\/]/).pop(), e.error])
    )
    expect(errors['syntax']).toMatch(/not valid YAML/)
    expect(errors['syntax']).not.toContain('\n')
    expect(errors['empty']).toMatch(/invalid manifest/)
    expect(errors['scalar']).toMatch(/invalid manifest/)
    expect(errors['no-manifest']).toBe('missing plugin.yaml')
  })

  it('treats a duplicate id as an error: the first folder in name order wins', async () => {
    const root = await makeTempDir()
    const firstDir = await plugin(root, 'a-first', manifest('same'))
    await plugin(root, 'b-second', manifest('same'))
    const registry = await PluginRegistry.scan(root)

    expect(registry.list()).toHaveLength(1)
    expect(registry.get('same')?.dir).toBe(firstDir)
    const errors = registry.errors()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.id).toBe('same')
    expect(errors[0]?.dir.endsWith('b-second')).toBe(true)
    expect(errors[0]?.error).toMatch(/duplicate plugin id "same".*a-first/)
  })

  it('skips folders that start with _ or . and ignores plain files', async () => {
    const root = await makeTempDir()
    await plugin(root, '_guard', manifest('guard-should-not-load'))
    await plugin(root, '_shared')
    await plugin(root, '.hidden', manifest('hidden-should-not-load'))
    await plugin(root, 'real', manifest('real'))
    await writeFile(join(root, 'README.md'), '# not a plugin\n')
    const registry = await PluginRegistry.scan(root)

    expect(registry.list().map((entry) => entry.id)).toEqual(['real'])
    expect(registry.errors()).toEqual([])
  })

  it('does not throw for a directory that does not exist', async () => {
    const root = await makeTempDir()
    const registry = await PluginRegistry.scan(join(root, 'nope'))
    expect(registry.list()).toEqual([])
    expect(registry.errors()).toHaveLength(1)
    expect(registry.errors()[0]?.error).toMatch(/cannot read the plugin directory/)
  })

  it('returns copies: changing the returned arrays does not change the registry', async () => {
    const root = await makeTempDir()
    await plugin(root, 'one', manifest('one'))
    const registry = await PluginRegistry.scan(root)
    registry.list().pop()
    registry.errors().push({ dir: 'x', error: 'y' })
    expect(registry.list()).toHaveLength(1)
    expect(registry.errors()).toHaveLength(0)
  })
})

describe('services and configuration', () => {
  async function twoSpeechPlugins() {
    const root = await makeTempDir()
    await plugin(root, 'tts-a', manifest('tts-a', 'service: tts'))
    await plugin(root, 'tts-b', manifest('tts-b', 'service: tts'))
    await plugin(root, 'image', manifest('image'))
    return PluginRegistry.scan(root)
  }

  it('lets two plugins claim one service name; byService returns all of them', async () => {
    const registry = await twoSpeechPlugins()
    expect(registry.errors()).toEqual([])
    expect(registry.byService('tts').map((entry) => entry.id)).toEqual(['tts-a', 'tts-b'])
    expect(registry.byService('image').map((entry) => entry.id)).toEqual(['image'])
    expect(registry.byService('nothing')).toEqual([])
  })

  it("exposes which plugins the caller's configuration enables", async () => {
    const registry = await twoSpeechPlugins()
    const config = {
      'tts-b': { enabled: true },
      image: { enabled: false },
      ghost: { enabled: true },
    }
    expect(registry.isEnabled('tts-b', config)).toBe(true)
    expect(registry.isEnabled('tts-a', config)).toBe(false) // not listed: off
    expect(registry.isEnabled('image', config)).toBe(false)
    expect(registry.isEnabled('ghost', config)).toBe(false) // enabled in the config but not on disk
    expect(registry.enabled(config).map((entry) => entry.id)).toEqual(['tts-b'])
    expect(registry.enabledByService('tts', config).map((entry) => entry.id)).toEqual(['tts-b'])
    expect(registry.enabledByService('image', config)).toEqual([])
    expect(registry.serviceConflicts(config)).toEqual([])
  })

  it('reports a service that more than one enabled plugin offers', async () => {
    const registry = await twoSpeechPlugins()
    const config = {
      'tts-a': { enabled: true },
      'tts-b': { enabled: true },
      image: { enabled: true },
    }
    expect(registry.serviceConflicts(config)).toEqual([{ service: 'tts', ids: ['tts-a', 'tts-b'] }])
    expect(registry.enabledByService('tts', config)).toHaveLength(2)
  })

  it('counts only enabled: true as enabled', async () => {
    const registry = await twoSpeechPlugins()
    expect(registry.enabled({ image: {} })).toEqual([])
    expect(registry.enabled({ image: { enabled: undefined, config: { a: 1 } } })).toEqual([])
    expect(registry.enabled({ image: undefined })).toEqual([])
  })
})
