import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { guardInterpreter, ownInterpreter } from '../../src/plugins/supervisor.ts'
import {
  CAN_RUN_GUARD,
  FAKE_SERVICE,
  GUARD_SCRIPT,
  LIGHT_PYTHON,
  cleanupAll,
  fakeEntry,
  makeSupervisor,
  makeTempDir,
  readInfo,
} from './helpers.ts'

afterEach(cleanupAll)

describe('which Python runs the job guard', () => {
  const there = new Set(['C:/light/python.exe', 'C:/own/python.exe'])
  const exists = (p: string) => there.has(p)

  it('the shared light one when it is installed, else the one the plugin brings, else nothing', () => {
    expect(guardInterpreter('C:/light/python.exe', 'C:/own/python.exe', exists)).toBe(
      'C:/light/python.exe'
    )
    expect(guardInterpreter('C:/none/python.exe', 'C:/own/python.exe', exists)).toBe(
      'C:/own/python.exe'
    )
    expect(guardInterpreter('C:/none/python.exe', 'C:/gone/python.exe', exists)).toBeNull()
    expect(guardInterpreter('C:/none/python.exe', undefined, exists)).toBeNull()
  })

  it('the Python a plugin brings is what its {python} means', () => {
    const interpreters = { light: 'L', audio: 'A' }
    expect(ownInterpreter('light', {}, interpreters)).toBe('L')
    expect(ownInterpreter('audio', {}, interpreters)).toBe('A')
    expect(ownInterpreter('external', { python: 'C:/gsv/python.exe' }, interpreters)).toBe(
      'C:/gsv/python.exe'
    )
    expect(ownInterpreter('external', { python: '' }, interpreters)).toBeUndefined()
    expect(ownInterpreter('external', {}, interpreters)).toBeUndefined()
    expect(ownInterpreter('node', { python: 'x' }, interpreters)).toBeUndefined()
    expect(ownInterpreter('audio', {}, { light: 'L' })).toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'win32')('a guarded plugin without the shared Python', () => {
  it('says what is missing when neither the shared nor its own Python exists', async () => {
    const dir = await makeTempDir()
    const gone = join(dir, 'no-such', 'python.exe')
    const entry = fakeEntry(dir, {
      env: 'external',
      guard: true,
      command: [process.execPath, FAKE_SERVICE, '--port', '{port}'],
    })
    const supervisor = await makeSupervisor([entry], {
      interpreters: { light: gone },
      guard: { script: GUARD_SCRIPT, python: gone },
      pluginConfig: { fake: { enabled: true, config: { python: gone } } },
    })
    const state = await supervisor.start('fake')
    expect(state.status).toBe('failed')
    expect(state.lastError).toContain('the job guard needs a Python interpreter')
    expect(state.lastError).toContain('uv sync')
  })

  it.skipIf(!CAN_RUN_GUARD)(
    'runs its guard on its own Python, so the service starts and sits under the guard',
    async () => {
      const dir = await makeTempDir()
      const gone = join(dir, 'no-such', 'python.exe')
      const infoFile = join(dir, 'info.json')
      const entry = fakeEntry(dir, {
        env: 'external',
        guard: true,
        command: [process.execPath, FAKE_SERVICE, '--port', '{port}', '--info-file', infoFile],
      })
      const supervisor = await makeSupervisor([entry], {
        interpreters: { light: gone },
        guard: { script: GUARD_SCRIPT, python: gone },
        pluginConfig: { fake: { enabled: true, config: { python: LIGHT_PYTHON } } },
      })
      const state = await supervisor.start('fake')
      expect(state.status).toBe('ready')
      const info = await readInfo(infoFile)
      expect(info.pid).not.toBe(state.pid) // the process the supervisor holds is the guard; the service is its child
      await supervisor.stop('fake')
    }
  )
})
