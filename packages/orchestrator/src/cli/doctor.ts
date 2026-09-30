/**
 * Is this installation ready to run?   npm run doctor [-- --config <file>] [--online]
 *
 * Prints a checklist and what to do about each problem. Exit code 1 when something must be fixed before the program can
 * run, 0 otherwise (warnings are for a look, not for stopping).
 */
import { createServer, connect } from 'node:net'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { request } from 'undici'
import {
  CompositeSecretStore,
  DpapiFileSecretStore,
  EnvFileSecretStore,
  EnvVarSecretStore,
} from '../plugins/secrets.ts'
import { WELL_KNOWN_SECRETS } from '../app/app.ts'
import { formatReport, runChecks, summarise } from './checks.ts'
import type { DoctorEnv } from './checks.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

function realEnv(root: string, dataDir: () => string): DoctorEnv {
  const store = () => {
    const stores = []
    if (process.platform === 'win32')
      stores.push(new DpapiFileSecretStore(path.join(dataDir(), 'secrets.dpapi.json')))
    stores.push(
      new EnvFileSecretStore(path.join(root, 'config', '.env'), {
        aliases: { ...WELL_KNOWN_SECRETS },
      })
    )
    stores.push(new EnvVarSecretStore({ aliases: { ...WELL_KNOWN_SECRETS } }))
    return new CompositeSecretStore(stores)
  }
  return {
    root,
    nodeVersion: process.versions.node,
    platform: process.platform,
    async exists(p) {
      try {
        const s = await stat(p)
        return s.isDirectory() ? 'dir' : 'file'
      } catch {
        return null
      }
    },
    async listDir(p) {
      try {
        return await readdir(p)
      } catch {
        return []
      }
    },
    portFree: (port) =>
      new Promise((resolve) => {
        const s = createServer()
        s.once('error', () => resolve(false))
        s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
      }),
    async httpAnswers(url, timeoutMs) {
      try {
        const r = await request(url, {
          method: 'GET',
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        })
        await r.body.dump()
        return true
      } catch {
        return false
      }
    },
    tcpOpens: (host, port, timeoutMs) =>
      new Promise((resolve) => {
        const s = connect({ host, port })
        const done = (v: boolean) => {
          s.destroy()
          resolve(v)
        }
        s.setTimeout(timeoutMs, () => done(false))
        s.once('connect', () => done(true))
        s.once('error', () => done(false))
      }),
    async secretIsSet(name) {
      try {
        return ((await store().get(name)) ?? '') !== ''
      } catch {
        return false
      }
    },
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      online: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.help) {
    console.log(
      'Usage: npm run doctor -- [--config <file>] [--online]\n\n  --online  also ask the servers the configuration points at whether they answer'
    )
    return 0
  }
  // a relative path is relative to where the person typed the command, not to the workspace npm runs the script in
  const from = process.env.INIT_CWD ?? process.cwd()
  const given = values.config ?? process.env.ANIMATUS_CONFIG
  const file = given
    ? path.resolve(from, given)
    : path.join(repoRoot, 'config', 'animatus.config.yaml')
  // the secret store lives in the configuration's data folder; before the configuration is read, the default one
  let dataDir = path.join(repoRoot, 'data')
  try {
    const { loadConfig } = await import('../config.ts')
    dataDir = (await loadConfig(file, { root: repoRoot })).paths.data_dir
  } catch {
    // the checks report it
  }
  const checks = await runChecks(
    file,
    realEnv(repoRoot, () => dataDir),
    { online: values.online }
  )
  console.log(formatReport(checks))
  return summarise(checks).fail > 0 ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e)
    process.exit(1)
  }
)
