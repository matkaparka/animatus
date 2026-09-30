import { PluginManifest } from '@animatus/protocol'
import { describe, expect, it } from 'vitest'
import {
  PlaceholderError,
  resolveProcessRuntime,
  resolveTemplate,
  type PlaceholderContext,
  type PlaceholderSlot,
} from '../../src/plugins/placeholders.ts'
import type { ProcessRuntime } from '../../src/plugins/registry.ts'

const SECRET = 'test-secret-123'
const CONFIG_VALUE = 'test-config-value-456'

function context(overrides: Partial<PlaceholderContext> = {}): PlaceholderContext {
  return {
    env: 'light',
    pluginDir: 'C:/plugins/demo',
    dataDir: 'C:/data',
    port: 5123,
    config: {
      root: 'C:/tools/demo',
      nested: { deep: { key: 'deep-value' } },
      count: 7,
      flag: true,
      list: [1, 2],
      token: CONFIG_VALUE,
    },
    interpreters: { light: 'C:/py/light/python.exe', audio: 'C:/py/audio/python.exe' },
    declaredSecrets: [
      { name: 'gemini', required: true },
      { name: 'optional', required: false },
    ],
    secrets: { gemini: SECRET },
    ...overrides,
  }
}

const expand = (template: string, ctx = context(), slot: PlaceholderSlot = 'command') =>
  resolveTemplate(template, ctx, 'runtime.command[0]', slot)

function failure(
  template: string,
  ctx = context(),
  slot: PlaceholderSlot = 'command'
): PlaceholderError {
  try {
    expand(template, ctx, slot)
  } catch (err) {
    expect(err).toBeInstanceOf(PlaceholderError)
    return err as PlaceholderError
  }
  throw new Error(`expected "${template}" to fail`)
}

describe('placeholders', () => {
  it('expands {port}, {plugin_dir} and {data_dir}', () => {
    expect(expand('--port={port}')).toBe('--port=5123')
    expect(expand('{plugin_dir}/service.py')).toBe('C:/plugins/demo/service.py')
    expect(expand('{data_dir}/cache')).toBe('C:/data/cache')
  })

  it('expands several placeholders and literal text in one string', () => {
    expect(expand('{plugin_dir}:{port}:{data_dir}')).toBe('C:/plugins/demo:5123:C:/data')
  })

  it('chooses {python} from runtime.env', () => {
    expect(expand('{python}', context({ env: 'light' }))).toBe('C:/py/light/python.exe')
    expect(expand('{python}', context({ env: 'audio' }))).toBe('C:/py/audio/python.exe')
    expect(expand('{python}', context({ env: 'node' }))).toBe(process.execPath)
    expect(
      expand('{python}', context({ env: 'external', config: { python: 'D:/gsv/python.exe' } }))
    ).toBe('D:/gsv/python.exe')
  })

  it('refuses {python} when the interpreter is unknown', () => {
    expect(
      failure('{python}', context({ env: 'audio', interpreters: { light: 'x' } })).message
    ).toMatch(/audio Python interpreter is not configured/)
    expect(
      failure('{python}', context({ env: 'light', interpreters: { light: '' } })).message
    ).toMatch(/light Python interpreter is not configured/)
    expect(failure('{python}', context({ env: 'external', config: {} })).message).toMatch(
      /config\.python/
    )
    expect(
      failure('{python}', context({ env: 'external', config: { python: '' } })).message
    ).toMatch(/config\.python/)
    expect(failure('{python}', context({ env: 'native' })).message).toMatch(/"native"/)
  })

  it('expands {config.<key>} and ${config:<key>}, including dotted paths and scalars', () => {
    expect(expand('{config.root}/x')).toBe('C:/tools/demo/x')
    expect(expand('{config.nested.deep.key}')).toBe('deep-value')
    expect(expand('${config:nested.deep.key}', context(), 'env')).toBe('deep-value')
    expect(expand('${config:root}', context(), 'command')).toBe('C:/tools/demo')
    expect(expand('{config.count}')).toBe('7')
    expect(expand('{config.flag}')).toBe('true')
    expect(expand('{config.list.1}')).toBe('2')
  })

  it('accepts a key that contains a dot as a whole', () => {
    expect(expand('{config.a.b}', context({ config: { 'a.b': 'dotted' } }))).toBe('dotted')
  })

  it('accepts an empty string as a value but not a missing key', () => {
    expect(expand('[{config.proxy}]', context({ config: { proxy: '' } }))).toBe('[]')
    expect(failure('{config.proxy}', context({ config: {} })).message).toMatch(/"proxy" is not set/)
    expect(failure('{config.proxy}', context({ config: { proxy: null } })).message).toMatch(
      /"proxy" is not set/
    )
  })

  it('rejects config values that are not scalars', () => {
    expect(failure('{config.nested}').message).toMatch(/not a string, number or boolean/)
    expect(failure('{config.list}').message).toMatch(/not a string, number or boolean/)
    expect(failure('{config.nan}', context({ config: { nan: Number.NaN } })).message).toMatch(
      /not a string, number or boolean/
    )
  })

  it('does not read through the prototype chain', () => {
    expect(failure('{config.constructor}').message).toMatch(/is not set/)
    expect(failure('{config.__proto__.polluted}').message).toMatch(/is not set/)
  })

  it('resolves declared secrets in env_vars only', () => {
    expect(expand('${secret:gemini}', context(), 'env')).toBe(SECRET)
    expect(expand('Bearer ${secret:gemini}', context(), 'env')).toBe(`Bearer ${SECRET}`)
    expect(failure('${secret:gemini}', context(), 'command').message).toMatch(
      /only allowed in env_vars/
    )
    expect(failure('${secret:gemini}', context(), 'cwd').message).toMatch(
      /only allowed in env_vars/
    )
  })

  it('rejects a secret the manifest does not declare', () => {
    const err = failure(
      '${secret:other}',
      context({ secrets: { gemini: SECRET, other: 'test-other-999' } }),
      'env'
    )
    expect(err.message).toMatch(/secret "other" is not listed in the manifest's secrets/)
    expect(err.placeholder).toBe('${secret:other}')
  })

  it('rejects a required secret that is not set, and turns an optional one into an empty string', () => {
    expect(failure('${secret:gemini}', context({ secrets: {} }), 'env').message).toMatch(
      /required secret "gemini" is not set/
    )
    expect(expand('[${secret:optional}]', context(), 'env')).toBe('[]')
  })

  it('names the placeholder for unknown ones', () => {
    for (const template of [
      '{nope}',
      '${nope}',
      '${secret}',
      '{secret:gemini}',
      '{port }',
      '{}',
      '${}',
      '{config}',
    ]) {
      const err = failure(template)
      expect(err.message).toMatch(/unknown placeholder|empty config key/)
      expect(err.message).toContain(template === '{config}' ? '{config}' : template)
    }
  })

  it('requires an allocated port for {port}', () => {
    expect(failure('{port}', context({ port: undefined })).message).toMatch(/no port is allocated/)
  })

  it('rejects unterminated placeholders and lone closing braces', () => {
    expect(failure('{port').message).toMatch(/unterminated/)
    expect(failure('${secret:gemini').message).toMatch(/unterminated/)
    expect(failure('a}b').message).toMatch(/lone "\}"/)
  })

  it('writes literal braces as doubled braces and leaves a bare $ alone', () => {
    expect(expand('{{port}}')).toBe('{port}')
    expect(expand('{{"a": 1}}')).toBe('{"a": 1}')
    expect(expand('price $5 and $HOME')).toBe('price $5 and $HOME')
  })

  it('never puts a value into an error message', () => {
    const cases: [string, Partial<PlaceholderContext>, PlaceholderSlot][] = [
      ['${secret:gemini}', {}, 'command'],
      ['${secret:other}', { secrets: { gemini: SECRET, other: SECRET } }, 'env'],
      ['${secret:gemini}', { secrets: {} }, 'env'],
      [
        '{config.nested}',
        { config: { nested: { token: CONFIG_VALUE }, python: CONFIG_VALUE } },
        'command',
      ],
      ['{config.missing}', {}, 'command'],
      ['{unknown}', {}, 'command'],
      ['{python}', { env: 'native', config: { token: CONFIG_VALUE } }, 'command'],
    ]
    for (const [template, overrides, slot] of cases) {
      const err = failure(template, context(overrides), slot)
      expect(err.message).not.toContain(SECRET)
      expect(err.message).not.toContain(CONFIG_VALUE)
      expect(err.message).not.toContain('test-other-999')
    }
  })
})

describe('resolveProcessRuntime', () => {
  const runtimeOf = (yaml: Record<string, unknown>): ProcessRuntime => {
    const manifest = PluginManifest.parse({
      id: 'demo',
      title: 'Demo',
      kind: 'custom',
      runtime: { type: 'process', env: 'light', command: ['{python}'], ...yaml },
      health: { tcp: true },
    })
    return manifest.runtime as ProcessRuntime
  }

  it('resolves command, cwd and env_vars together', () => {
    const resolved = resolveProcessRuntime(
      runtimeOf({
        command: [
          '{python}',
          '{plugin_dir}/service.py',
          '--port',
          '{port}',
          '--root',
          '{config.root}',
        ],
        cwd: '{config.root}',
        env_vars: { API_KEY: '${secret:gemini}', MODE: 'fast', ROOT: '${config:root}' },
      }),
      context()
    )
    expect(resolved.command).toEqual([
      'C:/py/light/python.exe',
      'C:/plugins/demo/service.py',
      '--port',
      '5123',
      '--root',
      'C:/tools/demo',
    ])
    expect(resolved.cwd).toBe('C:/tools/demo')
    expect(resolved.envVars).toEqual({ API_KEY: SECRET, MODE: 'fast', ROOT: 'C:/tools/demo' })
  })

  it('defaults cwd to the plugin directory and resolves a relative cwd against it', () => {
    const base = context({
      pluginDir: process.platform === 'win32' ? 'C:\\plugins\\demo' : '/plugins/demo',
    })
    expect(resolveProcessRuntime(runtimeOf({}), base).cwd).toBe(base.pluginDir)
    const relative = resolveProcessRuntime(runtimeOf({ cwd: 'sub/dir' }), base).cwd
    expect(relative.replace(/\\/g, '/')).toMatch(/plugins\/demo\/sub\/dir$/)
  })

  it('names where the failing placeholder was used', () => {
    expect(() =>
      resolveProcessRuntime(runtimeOf({ command: ['{python}', '--x', '{config.nope}'] }), context())
    ).toThrow(/runtime\.command\[2\]/)
    expect(() => resolveProcessRuntime(runtimeOf({ cwd: '{config.nope}' }), context())).toThrow(
      /runtime\.cwd/
    )
    expect(() =>
      resolveProcessRuntime(runtimeOf({ env_vars: { A: '{config.nope}' } }), context())
    ).toThrow(/runtime\.env_vars\.A/)
  })

  it('refuses a command that resolves to an empty executable', () => {
    expect(() =>
      resolveProcessRuntime(
        runtimeOf({ command: ['{config.empty}', 'x'] }),
        context({ config: { empty: '' } })
      )
    ).toThrow(/empty string/)
  })
})
