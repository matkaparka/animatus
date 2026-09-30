/** What the shipped pack and the shipped image plugin declare, checked the way the program will read them. */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PlaceholderError, resolveProcessRuntime } from '../../src/plugins/placeholders.ts'
import type { PlaceholderContext } from '../../src/plugins/placeholders.ts'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import type { ProcessRuntime } from '../../src/plugins/registry.ts'
import { loadModePacks } from '../../src/modes/loader.ts'

const REPO = path.resolve(__dirname, '../../../..')

describe('plugins/forge/plugin.yaml', () => {
  it('is a valid manifest for the image service the draw mode needs', async () => {
    const registry = await PluginRegistry.scan(path.join(REPO, 'plugins'))
    expect(registry.errors()).toEqual([])
    const entry = registry.get('forge')!
    expect(entry.service).toBe('forge')
    expect(entry.manifest).toMatchObject({
      kind: 'image',
      provides: ['image.txt2img'],
      resources: { gpu: true, vram_mb_est: null, config_keys: ['max_long_side'] },
      runtime: {
        type: 'process',
        env: 'light',
        port: 'auto',
        guard: true,
        stop: { http: { method: 'POST', path: '/shutdown' } },
      },
      health: { http: { path: '/health', ready_field: 'ready' } },
    })
    // the rating model is fetched on the first start: the plugin may take a while to become ready
    expect(entry.manifest.health.start_timeout_ms).toBe(600_000)
    expect(entry.manifest.secrets).toEqual([]) // the service never holds a key: the orchestrator plans
  })

  it('turns into the command line the service parses, from the two settings the operator gives', async () => {
    const entry = (await PluginRegistry.scan(path.join(REPO, 'plugins'))).get('forge')!
    const runtime = entry.manifest.runtime as ProcessRuntime
    const ctx: PlaceholderContext = {
      env: 'light',
      pluginDir: entry.dir,
      dataDir: 'C:/path/to/data',
      port: 5555,
      config: { settings_file: 'C:/path/to/forge-settings.yaml', max_long_side: 768 },
      interpreters: { light: 'C:/path/to/python.exe' },
      declaredSecrets: [],
      secrets: {},
    }
    const resolved = resolveProcessRuntime(runtime, ctx)
    expect(resolved.command).toEqual([
      'C:/path/to/python.exe',
      'service.py',
      '--port',
      '5555',
      '--data-dir',
      'C:/path/to/data',
      '--settings',
      'C:/path/to/forge-settings.yaml',
      '--max-long-side',
      '768',
    ])
    expect(resolved.cwd).toBe(entry.dir)
  })

  it('names the setting that is missing instead of starting without it', async () => {
    const entry = (await PluginRegistry.scan(path.join(REPO, 'plugins'))).get('forge')!
    const runtime = entry.manifest.runtime as ProcessRuntime
    const base: PlaceholderContext = {
      env: 'light',
      pluginDir: entry.dir,
      dataDir: 'C:/d',
      port: 1,
      config: {},
      interpreters: { light: 'C:/p/python.exe' },
      declaredSecrets: [],
      secrets: {},
    }
    expect(() =>
      resolveProcessRuntime(runtime, { ...base, config: { max_long_side: 1024 } })
    ).toThrow(PlaceholderError)
    expect(() =>
      resolveProcessRuntime(runtime, { ...base, config: { max_long_side: 1024 } })
    ).toThrow(/\{config\.settings_file\}/)
    expect(() =>
      resolveProcessRuntime(runtime, { ...base, config: { settings_file: 'C:/s.yaml' } })
    ).toThrow(/\{config\.max_long_side\}/)
  })
})

describe('modes/draw/mode.yaml', () => {
  it('declares what the draw mode is: exclusions, priority, its command words, its service and its layout', async () => {
    const { modes, errors } = await loadModePacks([path.join(REPO, 'modes')])
    expect(errors).toEqual([])
    const pack = modes.find((m) => m.manifest.id === 'draw')!
    expect(pack.manifest).toMatchObject({
      priority: 50,
      preempts: false,
      exclusive_with: ['sing', 'game', 'sleep', 'commentary'],
      requires: { services: ['forge'], vram_mb_est: null },
      triggers: { hotkey: 'ctrl+alt+p', danmaku_prefix: ['画', '/画'] },
      prompt: 'prompts/active.md',
    })
    // the layout of the stage is in the pack itself: the character to the side, the frame on the other
    expect(pack.manifest.stage.layout).toMatchObject({
      char: { scale: expect.any(Number) },
      frame: { left: expect.any(Number), width: expect.any(Number) },
    })
    expect(pack.activePrompt).toContain('{{command}}')
  })

  it('has no name of a person, a model or a place of the operator in any of its files', async () => {
    const { modes } = await loadModePacks([path.join(REPO, 'modes')])
    const pack = modes.find((m) => m.manifest.id === 'draw')!
    const everything = [...pack.prompts.values(), JSON.stringify(pack.manifest)].join('\n')
    for (const word of ['C:\\', 'D:\\', 'safetensors', 'http://', 'https://'])
      expect(everything, word).not.toContain(word)
  })
})
