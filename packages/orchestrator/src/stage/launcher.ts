/**
 * Starts the stage in its own browser window (the window a capture tool grabs).
 *
 * The flags are the ones the previous live window used: a dedicated profile, app mode, and no
 * background throttling or window occlusion handling, so timers and audio keep running while the
 * window is covered or minimised.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { noopLogger } from './logger.ts'
import type { Logger } from './logger.ts'

/**
 * The GPU-memory probe finds the stage's browser processes by this substring of their command line,
 * so the profile directory path must contain it.
 */
export const stageProfileMarker = 'animatus-stage'

export interface StageBrowserArgsOptions {
  /** Must be an http(s) URL on a loopback host: the window only ever shows the local stage. */
  url: string
  /** Browser profile directory; the path must contain `stageProfileMarker`. */
  profileDir: string
  windowSize?: [number, number]
  /** Adds a DevTools port bound to 127.0.0.1. */
  debugPort?: number
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function assertStageUrl(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`stage url is not a valid URL: ${JSON.stringify(raw)}`)
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    throw new Error(
      `stage url must be an http(s) URL on a loopback host (127.0.0.1, localhost), got ${JSON.stringify(raw)}`
    )
  }
}

export function buildStageBrowserArgs(opts: StageBrowserArgsOptions): string[] {
  assertStageUrl(opts.url)
  if (!opts.profileDir || opts.profileDir.trim() === '') throw new Error('profileDir is required')
  const profileDir = path.resolve(opts.profileDir)
  if (!profileDir.toLowerCase().includes(stageProfileMarker)) {
    throw new Error(
      `the browser profile directory must contain "${stageProfileMarker}" in its path ` +
        `(the GPU-memory probe finds the stage's processes by it), got ${JSON.stringify(profileDir)}`
    )
  }
  const args = [`--user-data-dir=${profileDir}`, `--app=${opts.url}`]
  if (opts.windowSize) {
    const [w, h] = opts.windowSize
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 16384 || h > 16384) {
      throw new RangeError(`windowSize must be two positive integers up to 16384, got [${w}, ${h}]`)
    }
    args.push(`--window-size=${w},${h}`)
  }
  args.push(
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check'
  )
  if (opts.debugPort !== undefined) {
    if (!Number.isInteger(opts.debugPort) || opts.debugPort < 1 || opts.debugPort > 65535) {
      throw new RangeError(
        `debugPort must be an integer between 1 and 65535, got ${opts.debugPort}`
      )
    }
    args.push(`--remote-debugging-port=${opts.debugPort}`, '--remote-debugging-address=127.0.0.1')
  }
  return args
}

export interface LaunchStageWindowOptions extends StageBrowserArgsOptions {
  /** Path of the browser executable (Chrome or another Chromium). */
  executable: string
  logger?: Logger
}

/**
 * Spawns the browser (no shell, not detached) and returns the child process. A spawn failure is
 * logged rather than thrown asynchronously; callers can still attach their own 'error' / 'exit'
 * listeners.
 */
export function launchStageWindow(opts: LaunchStageWindowOptions): ChildProcess {
  const logger = opts.logger ?? noopLogger
  const args = buildStageBrowserArgs(opts)
  if (path.isAbsolute(opts.executable) && !existsSync(opts.executable)) {
    throw new Error(`browser executable not found: ${opts.executable}`)
  }
  const child = spawn(opts.executable, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.on('error', (err) => logger('error', 'the stage browser could not be started', { err }))
  child.on('exit', (code, signal) => logger('info', 'the stage browser exited', { code, signal }))
  logger('info', 'stage window launched', { pid: child.pid, url: opts.url })
  return child
}
