/**
 * The shipped manifest of the capture service (`plugins/screencap`), and the real service started by the real
 * supervisor. The second half needs Windows and a Python with Pillow: the repository's light environment when it
 * has been made (`uv sync`), or the interpreter named by ANIMATUS_TEST_PYTHON; otherwise it is skipped.
 */
import { existsSync } from 'node:fs'
import { request } from 'node:http'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveProcessRuntime } from '../../src/plugins/placeholders.ts'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import type { ProcessRuntime } from '../../src/plugins/registry.ts'
import {
  GUARD_SCRIPT,
  IS_WINDOWS,
  LIGHT_PYTHON,
  REPO_ROOT,
  cleanupAll,
  makeSupervisor,
  pidAlive,
  trackPid,
  waitFor,
} from './helpers.ts'

afterEach(cleanupAll)

const PLUGINS = path.join(REPO_ROOT, 'plugins')
const PYTHON = LIGHT_PYTHON ?? process.env.ANIMATUS_TEST_PYTHON
const CAN_RUN = IS_WINDOWS && PYTHON !== undefined && existsSync(PYTHON)

async function entry() {
  const registry = await PluginRegistry.scan(PLUGINS)
  const found = registry.get('screencap')
  expect(found, 'plugins/screencap/plugin.yaml should load').toBeDefined()
  return { registry, entry: found! }
}

describe('the shipped manifest', () => {
  it('is valid: a loopback process on the light Python that needs no GPU and no secret', async () => {
    const { registry, entry: e } = await entry()
    expect(
      registry.errors().filter((x) => x.id === 'screencap' || x.dir.endsWith('screencap'))
    ).toEqual([])
    expect(e.service).toBe('screencap')
    expect(e.manifest).toMatchObject({
      kind: 'custom',
      provides: ['screen.capture'],
      resources: { gpu: false, vram_mb_est: null },
      runtime: { type: 'process', env: 'light', port: 'auto', guard: true },
      health: { http: { path: '/health', method: 'GET', ready_field: 'ready' } },
    })
    const runtime = e.manifest.runtime as ProcessRuntime
    expect(runtime.stop.http).toEqual({ method: 'POST', path: '/shutdown' })
    expect(e.manifest.secrets).toEqual([])
    expect(existsSync(path.join(e.dir, 'service.py'))).toBe(true)
  })

  it('starts the service script in its own folder on the port the supervisor allocates', async () => {
    const { entry: e } = await entry()
    const resolved = resolveProcessRuntime(e.manifest.runtime as ProcessRuntime, {
      env: 'light',
      pluginDir: e.dir,
      dataDir: 'C:/data',
      port: 5555,
      config: {},
      interpreters: { light: 'C:/python/python.exe' },
      declaredSecrets: [],
      secrets: {},
    })
    expect(resolved.command).toEqual(['C:/python/python.exe', 'service.py', '--port', '5555'])
    expect(resolved.cwd).toBe(e.dir)
    expect(resolved.envVars).toEqual({})
  })

  it('needs no setting of its own: everything is asked per request by the mode', async () => {
    const { entry: e } = await entry()
    expect(e.manifest.config_schema).toBeUndefined()
    expect(JSON.stringify(e.manifest.runtime)).not.toContain('{config.')
  })
})

interface Answer {
  status: number
  body: string
}

function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, agent: false, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8').on('data', (c: string) => (body += c))
      res.once('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.once('error', reject)
    req.end()
  })
}

describe.skipIf(!CAN_RUN)('the real service under the real supervisor', () => {
  it('starts, is healthy, lists windows, refuses web pages, and stops when asked', async () => {
    const { entry: e } = await entry()
    const supervisor = await makeSupervisor([e], {
      interpreters: { light: PYTHON as string },
      guard: { script: GUARD_SCRIPT, python: PYTHON as string },
    })
    const state = await supervisor.start('screencap')
    expect(state.status).toBe('ready')
    expect(state.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(state.health).toMatchObject({ ok: true, ready: true, service: 'screencap' })
    expect(state.health?.config?.grabber).toBe('win32')
    trackPid(state.pid)

    // the list is real: it is whatever windows this desktop has (nothing about them is looked at here)
    const list = await get(`${state.url}/windows`)
    expect(list.status).toBe(200)
    const parsed = JSON.parse(list.body) as {
      windows: { id: string; title: string; width: number }[]
      count: number
    }
    expect(Array.isArray(parsed.windows)).toBe(true)
    expect(parsed.count).toBe(parsed.windows.length)
    for (const w of parsed.windows) {
      expect(typeof w.id).toBe('string')
      expect(typeof w.title).toBe('string')
      expect(w.width).toBeGreaterThanOrEqual(0)
    }

    // a window that is not there is an error with a code, not an empty picture
    const missing = await get(
      `${state.url}/capture?window=${encodeURIComponent('no such window 5f3a9c')}`
    )
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.body).error).toMatchObject({
      code: 'window_not_found',
      retryable: true,
    })

    // what a web page could send is turned away
    const fromPage = await get(`${state.url}/windows`, { Origin: 'http://evil.example' })
    expect(fromPage.status).toBe(403)
    expect(JSON.parse(fromPage.body).error.code).toBe('forbidden_origin')
    const rebound = await get(`${state.url}/windows`, { Host: 'evil.example' })
    expect(rebound.status).toBe(403)
    expect(JSON.parse(rebound.body).error.code).toBe('forbidden_host')

    const pid = state.pid as number
    await supervisor.stop('screencap')
    expect(supervisor.getStatus('screencap').status).toBe('stopped')
    await waitFor(() => !pidAlive(pid), 8000, 'the service process to be gone')
  }, 60_000)
})
