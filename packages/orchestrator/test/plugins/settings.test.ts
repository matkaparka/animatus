import { describe, expect, it } from 'vitest'
import { describeMissingSettings, missingSettings } from '../../src/plugins/settings.ts'

const schema = {
  type: 'object',
  required: ['root', 'python', 'tts_config', 'size'],
  properties: {
    root: { type: 'string', title: 'Folder', description: 'The folder that holds the server.' },
    python: { type: 'string', title: 'Interpreter' },
    tts_config: { type: 'string' },
    size: { type: 'integer', default: 1024 },
  },
}

describe('settings a plugin requires', () => {
  it('names each required setting that is left out or empty, with what the manifest says about it', () => {
    expect(
      missingSettings({ config_schema: schema }, { root: 'C:/x', python: '   ', tts_config: null })
    ).toEqual([
      { key: 'python', about: 'Interpreter' },
      { key: 'tts_config', about: '' },
    ])
  })

  it('a setting with a default is not missing; a setting that is set is not missing, whatever its type', () => {
    expect(
      missingSettings(
        { config_schema: schema },
        { root: 'C:/x', python: 'py', tts_config: 'c.yaml', size: 0 }
      )
    ).toEqual([])
    expect(
      missingSettings({ config_schema: schema }, { root: 'a', python: 'b', tts_config: 'c' })
    ).toEqual([])
  })

  it('a manifest with no schema, or a schema that says nothing is required, misses nothing', () => {
    expect(missingSettings({}, {})).toEqual([])
    expect(missingSettings({ config_schema: { type: 'object' } }, {})).toEqual([])
    expect(missingSettings({ config_schema: { required: 'root' } }, {})).toEqual([])
    expect(missingSettings({ config_schema: { required: [3, 'a'] } }, {})).toEqual([
      { key: 'a', about: '' },
    ])
  })

  it('is described in the words of the configuration file', () => {
    expect(describeMissingSettings('gptsovits', { config_schema: schema }, { python: 'p' })).toBe(
      'plugins.gptsovits.config.root is not set: The folder that holds the server; plugins.gptsovits.config.tts_config is not set'
    )
    expect(
      describeMissingSettings(
        'gptsovits',
        { config_schema: schema },
        { root: 'a', python: 'b', tts_config: 'c' }
      )
    ).toBeNull()
  })
})
