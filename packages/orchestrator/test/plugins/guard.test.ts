import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAN_RUN_GUARD,
  GUARD_SCRIPT,
  LIGHT_PYTHON,
  cleanupAll,
  killPidTree,
  makeTempDir,
  pidAlive,
  readJsonFile,
  sleep,
  trackPid,
  waitFor,
} from './helpers.ts'

afterEach(cleanupAll)

const FIXTURE = join(import.meta.dirname, 'fixtures', 'guard-fixture.mjs')

interface GuardRun {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs `job_guard.py <args>` to completion. */
function runGuard(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<GuardRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(LIGHT_PYTHON ?? 'python', [GUARD_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: options.env ?? process.env,
      cwd: options.cwd,
    })
    trackPid(child.pid)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const guardNode = (script: string, extra: string[] = []) => [
  '--parent-pid',
  String(process.pid),
  '--',
  process.execPath,
  '-e',
  script,
  ...extra,
]

describe.runIf(CAN_RUN_GUARD)('job_guard.py', { timeout: 60_000 }, () => {
  it('exits with the exit code of the command', async () => {
    expect((await runGuard(guardNode('process.exit(0)'))).code).toBe(0)
    expect((await runGuard(guardNode('process.exit(7)'))).code).toBe(7)
    expect((await runGuard(guardNode('process.exit(255)'))).code).toBe(255)
  })

  it('passes large Windows exit codes through unchanged', async () => {
    // 0xC0000005 is what a crashing process (access violation) reports
    expect((await runGuard(guardNode('process.exit(0xC0000005)'))).code).toBe(0xc0000005)
  })

  it('gives the command its stdio, environment, working directory and exact arguments', async () => {
    const cwd = await makeTempDir()
    const script = `
      console.log('out:' + process.env.GUARD_TEST_VAR)
      console.error('err:' + process.cwd())
      console.log(JSON.stringify(process.argv.slice(1)))
    `
    const run = await runGuard(guardNode(script, ['two words', 'quote"inside', '\u4e2d\u6587']), {
      env: { ...process.env, GUARD_TEST_VAR: 'inherited' },
      cwd,
    })
    expect(run.code).toBe(0)
    const lines = run.stdout.trim().split(/\r?\n/)
    expect(lines[0]).toBe('out:inherited')
    expect(JSON.parse(lines[1] ?? '[]')).toEqual(['two words', 'quote"inside', '\u4e2d\u6587'])
    expect(run.stderr.trim().toLowerCase()).toBe(`err:${cwd}`.toLowerCase())
  })

  it('rejects bad usage with exit code 2 and does not run anything', async () => {
    expect((await runGuard(['--', process.execPath, '-e', '0'])).code).toBe(2) // no --parent-pid
    expect((await runGuard(['--parent-pid', String(process.pid)])).code).toBe(2) // no command
    expect((await runGuard(['--parent-pid', String(process.pid), '--'])).code).toBe(2)
    expect((await runGuard(['--parent-pid', '0', '--', process.execPath, '-e', '0'])).code).toBe(2)
    expect((await runGuard(['--parent-pid', 'abc', '--', process.execPath, '-e', '0'])).code).toBe(
      2
    )
  })

  it('exits with 127 when the command cannot be started', async () => {
    const run = await runGuard([
      '--parent-pid',
      String(process.pid),
      '--',
      join(await makeTempDir(), 'no-such-program.exe'),
    ])
    expect(run.code).toBe(127)
    expect(run.stderr).toContain('cannot start')
  })

  it('exits at once with a non-zero code, without starting the command, when the parent is already gone', async () => {
    const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true })
    await new Promise((resolve) => dead.once('exit', resolve))
    const marker = join(await makeTempDir(), 'ran.txt')
    const started = Date.now()
    const run = await runGuard([
      '--parent-pid',
      String(dead.pid),
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ])
    expect(run.code).toBe(3)
    expect(existsSync(marker)).toBe(false)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('kills the whole tree, grandchildren included, when the parent is force-killed', async () => {
    const dir = await makeTempDir()
    const pidFile = join(dir, 'pids.json')
    const parent = spawn(
      process.execPath,
      [FIXTURE, 'parent', LIGHT_PYTHON ?? '', GUARD_SCRIPT, pidFile],
      { stdio: 'ignore', windowsHide: true }
    )
    trackPid(parent.pid)
    const { child, grandchild } = await readJsonFile<{ child: number; grandchild: number }>(pidFile)
    const guardPid = Number(await readJsonFile<number>(`${pidFile}.launched`))
    for (const pid of [guardPid, child, grandchild]) trackPid(pid)
    await waitFor(
      () => [parent.pid ?? 0, guardPid, child, grandchild].every(pidAlive),
      5000,
      'all four processes to be running'
    )

    // taskkill /F without /T: only the parent is ended, nobody else is told
    const killed = spawnSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(parent.pid), '/F'],
      { stdio: 'ignore' }
    )
    expect(killed.status).toBe(0)
    const at = Date.now()
    await waitFor(
      () => ![guardPid, child, grandchild].some(pidAlive),
      8000,
      'the guard, its command and the grandchild to die'
    )
    expect(Date.now() - at).toBeLessThan(4000)
  })

  it('control: without the guard the same detached tree outlives a force-killed parent', async () => {
    const dir = await makeTempDir()
    const pidFile = join(dir, 'pids.json')
    const parent = spawn(process.execPath, [FIXTURE, 'parent', '-', '-', pidFile], {
      stdio: 'ignore',
      windowsHide: true,
    })
    trackPid(parent.pid)
    const { child, grandchild } = await readJsonFile<{ child: number; grandchild: number }>(pidFile)
    trackPid(child)
    trackPid(grandchild)
    spawnSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(parent.pid), '/F'],
      { stdio: 'ignore' }
    )
    await sleep(1500) // well beyond the guard's reaction time
    expect(pidAlive(child)).toBe(true)
    expect(pidAlive(grandchild)).toBe(true)
    killPidTree(child)
    killPidTree(grandchild)
  })

  it('takes down what a command leaves behind when the command itself exits', async () => {
    const dir = await makeTempDir()
    const pidFile = join(dir, 'pids.json')
    const run = await runGuard([
      '--parent-pid',
      String(process.pid),
      '--',
      process.execPath,
      FIXTURE,
      'tree',
      pidFile,
      '--exit-now',
    ])
    expect(run.code).toBe(5)
    const { child, grandchild } = await readJsonFile<{ child: number; grandchild: number }>(pidFile)
    trackPid(child)
    trackPid(grandchild)
    await waitFor(
      () => !pidAlive(grandchild),
      5000,
      'the orphaned grandchild to be reaped with the job'
    )
  })
})
