import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DpapiFileSecretStore, SecretStoreError } from '../../src/plugins/secrets.ts'
import { IS_WINDOWS, cleanupAll, makeTempDir } from './helpers.ts'

afterEach(cleanupAll)

const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)
const HAS_POWERSHELL = IS_WINDOWS && existsSync(POWERSHELL)

/** Wraps `spawn` so a test can look at every PowerShell start and its arguments. */
function spy() {
  const calls: { command: string; args: string[] }[] = []
  const spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args: [...args] })
    return nodeSpawn(command, args, options)
  }
  return { spawn, calls }
}

const VALUE = 'test-secret-123'
const AWKWARD = '\u4e2d\u6587\u5bc6\u7801 "quoted" \\ back\nslash \u00e9'
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

async function secretFile(): Promise<string> {
  // neither the file nor its directory exists yet
  return join(await makeTempDir(), 'nested', 'deeper', 'secrets.json')
}

describe.runIf(HAS_POWERSHELL)(
  'DpapiFileSecretStore (Windows PowerShell 5.1)',
  { timeout: 60_000 },
  () => {
    it('round-trips secrets through DPAPI, keeps plaintext out of the file, and decrypts everything once', async () => {
      const path = await secretFile()
      const writer = spy()
      const store = new DpapiFileSecretStore(path, { spawn: writer.spawn })

      // set works although neither the file nor its directory exists; parallel sets are serialised
      await Promise.all([
        store.set('alpha', VALUE),
        store.set('beta', AWKWARD),
        store.set('gamma', 'third-value-789'),
      ])
      expect(writer.calls).toHaveLength(3)

      const fileText = await readFile(path, 'utf8')
      const onDisk = JSON.parse(fileText) as Record<string, string>
      expect(Object.keys(onDisk)).toEqual(['alpha', 'beta', 'gamma'])
      for (const protectedValue of Object.values(onDisk))
        expect(protectedValue).toMatch(/^[0-9a-f]{100,}$/i)
      for (const plain of [VALUE, AWKWARD, 'third-value-789', b64(VALUE), b64(AWKWARD)])
        expect(fileText).not.toContain(plain)

      // a new instance (a new orchestrator run) reads them back; names() and unknown names cost no PowerShell start
      const reader = spy()
      const fresh = new DpapiFileSecretStore(path, { spawn: reader.spawn })
      expect(await fresh.names()).toEqual([
        { name: 'alpha', source: 'dpapi-file' },
        { name: 'beta', source: 'dpapi-file' },
        { name: 'gamma', source: 'dpapi-file' },
      ])
      expect(await fresh.get('missing')).toBeUndefined()
      expect(reader.calls).toHaveLength(0)

      expect(await fresh.get('alpha')).toBe(VALUE)
      expect(reader.calls).toHaveLength(1) // one PowerShell start decrypted all three
      expect(await fresh.get('beta')).toBe(AWKWARD)
      expect(await fresh.get('gamma')).toBe('third-value-789')
      expect(await fresh.get('alpha')).toBe(VALUE)
      expect(reader.calls).toHaveLength(1) // and they are cached from then on
      expect(JSON.stringify(await fresh.names())).not.toContain(VALUE)
    })

    it('never puts a secret on a command line', async () => {
      const path = await secretFile()
      const recorder = spy()
      const store = new DpapiFileSecretStore(path, { spawn: recorder.spawn })
      await store.set('alpha', VALUE)
      const fresh = new DpapiFileSecretStore(path, { spawn: recorder.spawn })
      expect(await fresh.get('alpha')).toBe(VALUE)

      expect(recorder.calls).toHaveLength(2)
      for (const { command, args } of recorder.calls) {
        expect(command.toLowerCase()).toContain('powershell')
        expect(args.slice(0, 4)).toEqual([
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
        ])
        expect(args).toHaveLength(5)
        const commandLine = [command, ...args].join(' ')
        expect(commandLine).not.toContain(VALUE)
        expect(commandLine).not.toContain(b64(VALUE))
        const script = Buffer.from(args[4] ?? '', 'base64').toString('utf16le')
        expect(script).toContain('ConvertTo-SecureString')
        expect(script).toContain('ConvertFrom-SecureString')
        expect(script).not.toContain(VALUE)
      }
    })

    it('updates its cache on set, forgets on delete, and persists both', async () => {
      const path = await secretFile()
      const recorder = spy()
      const store = new DpapiFileSecretStore(path, { spawn: recorder.spawn })
      await store.set('alpha', VALUE)
      await store.set('beta', 'second-value-456')
      expect(recorder.calls).toHaveLength(2)
      expect(await store.get('alpha')).toBe(VALUE)
      expect(recorder.calls).toHaveLength(2) // served from the cache, nothing decrypted

      await store.set('alpha', 'replaced-value-000')
      expect(await store.get('alpha')).toBe('replaced-value-000')
      await store.delete('beta')
      await store.delete('never-existed') // not an error
      expect(await store.get('beta')).toBeUndefined()
      expect(recorder.calls).toHaveLength(3) // delete needs no PowerShell

      const fresh = new DpapiFileSecretStore(path)
      expect((await fresh.names()).map((entry) => entry.name)).toEqual(['alpha'])
      expect(await fresh.get('alpha')).toBe('replaced-value-000')
    })

    it('names the secret it cannot decrypt without touching the others, and can be repaired by set', async () => {
      const path = await secretFile()
      await new DpapiFileSecretStore(path).set('good', VALUE)
      const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>
      file.foreign = '01000000d08c9ddf0115d1118c7a00c04fc297eb010000000000000000000000000000'
      await writeFile(path, JSON.stringify(file))

      const recorder = spy()
      const store = new DpapiFileSecretStore(path, { spawn: recorder.spawn })
      expect(await store.get('good')).toBe(VALUE)
      const err = await store.get('foreign').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SecretStoreError)
      expect((err as SecretStoreError).code).toBe('decrypt_failed')
      expect((err as Error).message).toContain('"foreign"')
      expect((err as Error).message).not.toContain('0100000')
      await store.get('foreign').catch(() => undefined)
      expect(recorder.calls).toHaveLength(1) // the failure is remembered, PowerShell is not asked again

      await store.set('foreign', 'now-it-works-123')
      expect(await store.get('foreign')).toBe('now-it-works-123')
    })

    it('refuses bad names and values before it starts PowerShell, without echoing them', async () => {
      const recorder = spy()
      const store = new DpapiFileSecretStore(await secretFile(), { spawn: recorder.spawn })
      const badName = await store.set(`${VALUE} with spaces`, 'x-value').catch((e: unknown) => e)
      expect((badName as SecretStoreError).code).toBe('invalid_name')
      expect((badName as Error).message).not.toContain(VALUE)
      for (const value of ['', 'has\0nul']) {
        expect(
          ((await store.set('ok', value).catch((e: unknown) => e)) as SecretStoreError).code
        ).toBe('invalid_value')
      }
      expect(recorder.calls).toHaveLength(0)
    })

    it('reports a damaged file loudly', async () => {
      const path = await secretFile()
      const store = new DpapiFileSecretStore(path)
      await store.set('alpha', VALUE)
      for (const damaged of ['{not json', '[]', '{"alpha": 5}', '"text"']) {
        await writeFile(path, damaged)
        const err = await new DpapiFileSecretStore(path).names().catch((e: unknown) => e)
        expect(err).toBeInstanceOf(SecretStoreError)
        expect((err as SecretStoreError).code).toBe('corrupt')
      }
      await writeFile(path, '   \n')
      expect(await new DpapiFileSecretStore(path).names()).toEqual([]) // blank is the same as new
      await writeFile(path, `\uFEFF${JSON.stringify({})}`)
      expect(await new DpapiFileSecretStore(path).names()).toEqual([])
    })

    it('gives up on a PowerShell that does not answer in time, and writes nothing', async () => {
      const path = await secretFile()
      const store = new DpapiFileSecretStore(path, { timeoutMs: 40 })
      const err = await store.set('alpha', VALUE).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SecretStoreError)
      expect((err as SecretStoreError).code).toBe('unavailable')
      expect((err as Error).message).toMatch(/did not answer within 40 ms/)
      expect(existsSync(path)).toBe(false)
      expect(await store.get('alpha')).toBeUndefined()
    })

    it('says so when PowerShell cannot be started', async () => {
      const store = new DpapiFileSecretStore(await secretFile(), {
        powershell: join(await makeTempDir(), 'missing.exe'),
      })
      const err = await store.set('alpha', VALUE).catch((e: unknown) => e)
      expect((err as SecretStoreError).code).toBe('unavailable')
      expect((err as Error).message).toMatch(/cannot start PowerShell/)
      expect((err as Error).message).not.toContain(VALUE)
    })
  }
)
