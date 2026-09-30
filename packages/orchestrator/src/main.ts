/**
 * Start the orchestrator:  npm start  (or  npx tsx packages/orchestrator/src/main.ts --config <file>)
 *
 * Exit codes: 0 clean stop, 2 the configuration could not be used, 1 anything else.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { App } from './app/app.ts'
import { ConfigError, loadConfig } from './config.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const USAGE = `Usage: npm start -- [--config <file>] [--no-browser] [--dev]

  --config <file>  configuration file (default: config/animatus.config.yaml, or $ANIMATUS_CONFIG)
  --no-browser     do not open the stage window even if the configuration names a browser
  --dev            let the stage answer debug requests`

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      'no-browser': { type: 'boolean', default: false },
      dev: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const file =
    values.config ??
    process.env.ANIMATUS_CONFIG ??
    path.join(repoRoot, 'config', 'animatus.config.yaml')

  let app: App
  try {
    const config = await loadConfig(file, { root: repoRoot })
    app = await App.create({ config, noBrowser: values['no-browser'], dev: values.dev })
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      return 2
    }
    throw e
  }

  let stopping: Promise<void> | null = null
  const shutdown = (signal: string) => {
    stopping ??= (async () => {
      console.error(`${signal}: shutting down`)
      await app.stop()
      process.exit(0)
    })()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await app.start()
  return -1 // keep running
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code)
  },
  (e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e)
    process.exit(1)
  }
)
