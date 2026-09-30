import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildStageBrowserArgs,
  launchStageWindow,
  stageProfileMarker,
} from '../../src/stage/launcher.ts'
import { collectLogger, createCleanup, makeTempDir, waitUntil } from '../_stage-support/fixtures.ts'

const cleanup = createCleanup()
afterEach(() => cleanup.run())

const profile = (name = 'animatus-stage-profile') =>
  path.join(path.resolve('some-root'), 'data', name)

describe('buildStageBrowserArgs', () => {
  const base = { url: 'http://127.0.0.1:5810/', profileDir: profile() }

  it('exports the marker the GPU-memory probe looks for', () => {
    expect(stageProfileMarker).toBe('animatus-stage')
  })

  it('produces the flags of the previous live window, with the profile and the app url first', () => {
    const args = buildStageBrowserArgs({ ...base, windowSize: [1920, 1080] })
    expect(args.slice(0, 3)).toEqual([
      `--user-data-dir=${profile()}`,
      '--app=http://127.0.0.1:5810/',
      '--window-size=1920,1080',
    ])
    for (const flag of [
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
    ]) {
      expect(args, flag).toContain(flag)
    }
    expect(args).toHaveLength(10)
    expect(new Set(args).size).toBe(args.length)
  })

  it('leaves out the window size and the debugging port unless asked', () => {
    const args = buildStageBrowserArgs(base)
    expect(args.some((a) => a.startsWith('--window-size'))).toBe(false)
    expect(args.some((a) => a.startsWith('--remote-debugging'))).toBe(false)
  })

  it('binds the debugging port to loopback', () => {
    const args = buildStageBrowserArgs({ ...base, debugPort: 9222 })
    expect(args).toContain('--remote-debugging-port=9222')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
  })

  it('resolves a relative profile directory, so the marker is checked on the real path', () => {
    const args = buildStageBrowserArgs({
      ...base,
      profileDir: path.join('data', 'animatus-stage-profile'),
    })
    expect(args[0]).toBe(`--user-data-dir=${path.resolve('data', 'animatus-stage-profile')}`)
  })

  describe('profile marker', () => {
    it.each([
      path.join('C:', 'data', 'animatus-stage'),
      path.join('C:', 'data', 'animatus-stage-profile'),
      path.join('C:', 'animatus-stage', 'profile'),
      path.join('C:', 'data', 'My-ANIMATUS-STAGE-profile'), // the probe matches case-insensitively
    ])('accepts %s', (dir) => {
      expect(() => buildStageBrowserArgs({ ...base, profileDir: dir })).not.toThrow()
    })

    it.each([
      path.join('C:', 'data', 'chrome-profile'),
      path.join('C:', 'data', 'animatus', 'stage'),
      path.join('C:', 'data', 'animatus_stage'),
      path.join('C:', 'data', 'animatusstage'),
    ])('throws a clear error for %s', (dir) => {
      expect(() => buildStageBrowserArgs({ ...base, profileDir: dir })).toThrow(/animatus-stage/)
      expect(() => buildStageBrowserArgs({ ...base, profileDir: dir })).toThrow(/GPU-memory probe/)
    })

    it('requires a profile directory at all', () => {
      expect(() => buildStageBrowserArgs({ ...base, profileDir: '' })).toThrow(/profileDir/)
      expect(() => buildStageBrowserArgs({ ...base, profileDir: '   ' })).toThrow(/profileDir/)
    })
  })

  describe('url', () => {
    it.each([
      'http://127.0.0.1:5810/',
      'http://localhost:5173/',
      'http://[::1]:5810/',
      'https://localhost/',
      'http://127.0.0.1:1/stage',
    ])('accepts %s', (url) => {
      expect(buildStageBrowserArgs({ ...base, url })).toContain(`--app=${url}`)
    })

    it.each([
      'https://example.com/',
      'http://evil.example:5810/',
      'http://127.0.0.1.evil.example/',
      'http://127.0.0.1@evil.example/',
      'http://localhost.evil.example/',
      'file:///C:/stage/index.html',
      'javascript:alert(1)',
      'data:text/html,hi',
      'about:blank',
      'chrome://settings',
      'ftp://127.0.0.1/',
      '127.0.0.1:5810',
      '',
      'not a url',
    ])('rejects %s: the window only ever shows the local stage', (url) => {
      expect(() => buildStageBrowserArgs({ ...base, url })).toThrow(/stage url/)
    })
  })

  it('validates the window size and the debugging port', () => {
    for (const windowSize of [
      [0, 100],
      [100, 0],
      [-1, 100],
      [1.5, 100],
      [20000, 100],
      [Number.NaN, 100],
    ] as Array<[number, number]>) {
      expect(() => buildStageBrowserArgs({ ...base, windowSize })).toThrow(RangeError)
    }
    for (const debugPort of [0, -1, 70000, 1.5, Number.NaN]) {
      expect(() => buildStageBrowserArgs({ ...base, debugPort })).toThrow(RangeError)
    }
    expect(() =>
      buildStageBrowserArgs({ ...base, windowSize: [1, 1], debugPort: 65535 })
    ).not.toThrow()
  })

  it('keeps every argument a single element, whatever the paths contain', () => {
    const dir = path.join(path.resolve('a path with spaces'), 'animatus-stage', 'quote"s & more')
    const args = buildStageBrowserArgs({ ...base, profileDir: dir })
    expect(args[0]).toBe(`--user-data-dir=${dir}`) // no shell is involved, so no quoting is added or needed
  })
})

describe('launchStageWindow', () => {
  const stageUrl = 'http://127.0.0.1:5810/'

  it('spawns the executable with the built arguments, without a shell, and returns the child', async () => {
    const tmp = makeTempDir()
    cleanup.add(() => tmp.remove())
    const dir = path.join(tmp.dir, 'animatus-stage-profile')
    const { logger, has } = collectLogger()
    // node stands in for the browser: it rejects the unknown flags and exits at once, which is enough to
    // prove that a process was started with our arguments
    const child = launchStageWindow({
      executable: process.execPath,
      url: stageUrl,
      profileDir: dir,
      windowSize: [800, 600],
      logger,
    })
    cleanup.add(() => {
      child.kill()
    })
    expect(child.pid).toBeGreaterThan(0)
    expect(child.spawnfile).toBe(process.execPath)
    expect(child.spawnargs.slice(1)).toEqual(
      buildStageBrowserArgs({ url: stageUrl, profileDir: dir, windowSize: [800, 600] })
    )
    await waitUntil(() => child.exitCode !== null, 10_000, 'the stand-in browser to exit')
    expect(has('info', 'launched')).toBe(true)
    expect(has('info', 'exited')).toBe(true)
  })

  it('enforces the profile marker and the url rule before spawning anything', () => {
    expect(() =>
      launchStageWindow({
        executable: process.execPath,
        url: stageUrl,
        profileDir: profile('plain-profile'),
      })
    ).toThrow(/animatus-stage/)
    expect(() =>
      launchStageWindow({
        executable: process.execPath,
        url: 'https://example.com/',
        profileDir: profile(),
      })
    ).toThrow(/stage url/)
  })

  it('throws for an absolute executable path that does not exist', () => {
    const missing = path.join(makeTempDir().dir, 'no-browser.exe')
    expect(fs.existsSync(missing)).toBe(false)
    expect(() =>
      launchStageWindow({ executable: missing, url: stageUrl, profileDir: profile() })
    ).toThrow(/not found/)
  })

  it('logs a missing command instead of crashing the process with an unhandled error event', async () => {
    const { logger, has } = collectLogger()
    const child = launchStageWindow({
      executable: 'definitely-not-a-browser-xyz',
      url: stageUrl,
      profileDir: profile(),
      logger,
    })
    await waitUntil(
      () => has('error', 'could not be started'),
      10_000,
      'the spawn error to be logged'
    )
    expect(child.pid).toBeUndefined()
  })
})
