import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IS_WINDOWS,
  LineSplitter,
  RingBuffer,
  batchInvocation,
  buildChildEnv,
  killTree,
  processGone,
  sleep,
} from '../../src/plugins/proc.ts'
import { cleanupAll, pidAlive, trackPid, waitForGone } from './helpers.ts'

afterEach(cleanupAll)

describe('buildChildEnv', () => {
  const base = {
    PATH: 'C:/bin',
    KEEP_ME: 'yes',
    GEMINI_API_KEY: 'test-secret-123',
    NoDefaultCurrentDirectoryInExePath: '1',
    UNSET: undefined,
  }

  it('drops stripped names (case-insensitively) and undefined values, keeps the rest', () => {
    const env = buildChildEnv({
      base,
      strip: ['gemini_api_key', 'NODEFAULTCURRENTDIRECTORYINEXEPATH'],
      envVars: {},
      secrets: {},
    })
    expect(env).toEqual({ PATH: 'C:/bin', KEEP_ME: 'yes' })
  })

  it('layers defaults, env_vars and secrets in that order', () => {
    const env = buildChildEnv({
      base: { A: 'base', B: 'base', C: 'base' },
      strip: [],
      defaults: { A: 'default', D: 'default', E: 'default' },
      envVars: { B: 'env_vars', C: 'env_vars', E: 'env_vars' },
      secrets: { C: 'secret' },
    })
    expect(env).toEqual({
      A: 'base', // a default never replaces what is already there
      B: 'env_vars',
      C: 'secret', // secrets go in last
      D: 'default',
      E: 'env_vars',
    })
  })

  it('does not modify its inputs', () => {
    const input = { base: { A: '1' }, strip: ['A'], envVars: { B: '2' }, secrets: { C: '3' } }
    const copy = structuredClone(input)
    buildChildEnv(input)
    expect(input).toEqual(copy)
  })

  it.runIf(IS_WINDOWS)('does not keep two spellings of one variable name on Windows', () => {
    const env = buildChildEnv({
      base: { Path: 'C:/bin' },
      strip: [],
      envVars: { PATH: 'C:/other' },
      secrets: {},
    })
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['PATH'])
    expect(env.PATH).toBe('C:/other')
  })

  it.runIf(IS_WINDOWS)(
    'does not let a default duplicate a variable that differs only in case',
    () => {
      const env = buildChildEnv({
        base: { pythonunbuffered: '0' },
        strip: [],
        defaults: { PYTHONUNBUFFERED: '1' },
        envVars: {},
        secrets: {},
      })
      expect(env).toEqual({ pythonunbuffered: '0' })
    }
  )
})

describe('LineSplitter', () => {
  it('joins lines that arrive in pieces and holds back an unfinished one', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('hel')).toEqual([])
    expect(splitter.push('lo\nwor')).toEqual(['hello'])
    expect(splitter.push('ld\nand more')).toEqual(['world'])
    expect(splitter.flush()).toBe('and more')
    expect(splitter.flush()).toBeUndefined()
  })

  it('accepts CRLF and treats a carriage return inside a line as an overwrite', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('one\r\ntwo\r\n')).toEqual(['one', 'two'])
    expect(splitter.push('10%\r50%\r100%\ndone\n')).toEqual(['100%', 'done'])
  })

  it('keeps empty lines', () => {
    expect(new LineSplitter().push('a\n\nb\n')).toEqual(['a', '', 'b'])
  })

  it('cuts an overlong line but holds back a tail so a value split by the cut is not lost', () => {
    const splitter = new LineSplitter(16, () => 5)
    const lines = splitter.push('0123456789'.repeat(4)) // 40 characters, no newline
    expect(lines).toEqual(['0123456789'.repeat(3) + '01234'])
    expect(splitter.flush()).toBe('56789')
    // with nothing held back the whole buffer goes
    const plain = new LineSplitter(8)
    expect(plain.push('abcdefghij')).toEqual(['abcdefghij'])
    expect(plain.flush()).toBeUndefined()
  })
})

describe('RingBuffer', () => {
  it('keeps the newest items and can return a tail', () => {
    const ring = new RingBuffer<number>(3)
    for (let i = 1; i <= 5; i++) ring.push(i)
    expect(ring.toArray()).toEqual([3, 4, 5])
    expect(ring.toArray(2)).toEqual([4, 5])
    expect(ring.toArray(0)).toEqual([])
    expect(ring.toArray(10)).toEqual([3, 4, 5])
  })

  it('returns a copy', () => {
    const ring = new RingBuffer<string>(2)
    ring.push('a')
    ring.toArray().push('b')
    expect(ring.toArray()).toEqual(['a'])
  })
})

describe('batchInvocation', () => {
  it.runIf(IS_WINDOWS)(
    'runs .bat and .cmd files through cmd.exe with every argument quoted safely',
    () => {
      const invocation = batchInvocation([
        'C:\\Program Files\\tool\\run.bat',
        '--port',
        '5000',
        'two words',
      ])
      expect(invocation).toBeDefined()
      expect(invocation?.file.toLowerCase()).toMatch(/cmd(\.exe)?$/)
      expect(invocation?.verbatim).toBe(true)
      expect(invocation?.args).toEqual([
        '/d',
        '/s',
        '/c',
        '""C:\\Program Files\\tool\\run.bat" --port 5000 "two words""',
      ])
      expect(batchInvocation(['run.CMD'])?.args[3]).toBe('"run.CMD"')
    }
  )

  it.runIf(IS_WINDOWS)('rejects arguments cmd.exe cannot take safely, without echoing them', () => {
    for (const bad of ['a"b', '100%', 'line\nbreak']) {
      expect(() => batchInvocation(['run.bat', bad])).toThrow(/cannot take safely/)
      try {
        batchInvocation(['run.bat', bad])
      } catch (err) {
        expect((err as Error).message).not.toContain(bad)
      }
    }
  })

  it('leaves executables alone', () => {
    expect(batchInvocation(['C:\\tools\\service.exe', '--x'])).toBeUndefined()
    expect(batchInvocation(['python', 'run.bat.py'])).toBeUndefined()
    expect(batchInvocation([])).toBeUndefined()
  })
})

describe('processGone', () => {
  it('is false for a running process and true once it has exited', async () => {
    expect(processGone(process.pid)).toBe(false)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const pid = child.pid ?? 0
    trackPid(pid)
    expect(processGone(pid)).toBe(false)
    await new Promise((resolve) => child.once('exit', resolve))
    for (let i = 0; i < 100 && !processGone(pid); i++) await sleep(20)
    expect(processGone(pid)).toBe(true)
  })
})

describe('killTree', () => {
  it('kills a process and its grandchild', async () => {
    const script = `
      const { spawn } = require('node:child_process')
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log(JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }))
      setInterval(() => {}, 1000)
    `
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      detached: !IS_WINDOWS,
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    for (let i = 0; i < 400 && !out.includes('\n'); i++) await sleep(25)
    const pids = JSON.parse(out) as { pid: number; grandchild: number }
    trackPid(pids.pid)
    trackPid(pids.grandchild)
    expect(pidAlive(pids.pid)).toBe(true)
    expect(pidAlive(pids.grandchild)).toBe(true)

    await killTree(pids.pid)
    await waitForGone(pids.pid)
    await waitForGone(pids.grandchild)
  })

  it('does not fail for a process that is already gone', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const pid = child.pid ?? 0
    await new Promise((resolve) => child.once('exit', resolve))
    await expect(killTree(pid)).resolves.toBeUndefined()
  })
})
