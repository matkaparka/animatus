import { describe, expect, it } from 'vitest'
import { ASSET_EXTENSIONS, MAX_BYTES, classify, extensionOf, globToRegExp } from './rules.mjs'

describe('classify', () => {
  it('refuses every kind of asset by its extension, in any case, at any depth', () => {
    for (const [kind, exts] of Object.entries(ASSET_EXTENSIONS))
      for (const ext of exts) {
        const c = classify(`some/dir/File.${ext.toUpperCase()}`, 10)
        expect(c?.rule, `${kind} .${ext}`).toBe('asset')
      }
    expect(classify('models/character.vrm', 10)?.description).toContain('model')
    expect(classify('motions/poses/wave.vrma', 10)?.description).toContain('motion')
    expect(classify('dance/music.mp3', 10)?.description).toContain('audio')
    expect(classify('weights/voice.pth', 10)?.description).toContain('weights')
  })

  it('takes source, configuration and text as they are', () => {
    for (const p of [
      'packages/orchestrator/src/app/app.ts',
      'plugins/forge/service.py',
      'config.example/animatus.config.yaml',
      'docs/tools.md',
      'package.json',
      'LICENSE',
      '.gitignore',
      'tools/asset-scan/scan.mjs',
      'a.png.md',
      'vrm',
      '.vrm',
      'notes.txt',
    ])
      expect(classify(p, 100), p).toBeNull()
  })

  it('refuses a big file, but not the lock files, and does not judge a size it does not know', () => {
    expect(classify('data.json', MAX_BYTES + 1)?.rule).toBe('large-file')
    expect(classify('data.json', MAX_BYTES)).toBeNull()
    expect(classify('data.json', null)).toBeNull()
    expect(classify('uv.lock', 5_000_000)).toBeNull()
    expect(classify('deep/package-lock.json', 5_000_000)).toBeNull()
  })

  it('a path that uses backslashes is read the same way', () => {
    expect(classify('models\\a.vrm', 1)?.rule).toBe('asset')
    expect(extensionOf('a\\b\\c.TXT')).toBe('txt')
  })
})

describe('globToRegExp', () => {
  it('matches like the other scanner: * inside a segment, ** across', () => {
    expect(globToRegExp('fixtures/*.png').test('fixtures/a.png')).toBe(true)
    expect(globToRegExp('fixtures/*.png').test('fixtures/deep/a.png')).toBe(false)
    expect(globToRegExp('**/tiny.png').test('a/b/tiny.png')).toBe(true)
    expect(globToRegExp('**/tiny.png').test('tiny.png')).toBe(true)
    expect(globToRegExp('docs/logo.svg').test('docs/logo-svg')).toBe(false)
  })
})
