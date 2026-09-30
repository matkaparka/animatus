/**
 * Runs the console against made-up data, without an orchestrator:
 *
 *   npx tsx packages/orchestrator/src/console/demo.ts
 *
 * It prints the address to open (with the token in the fragment). Build the UI first with
 * `npm run build -w @animatus/console`, or the server answers 503 with a hint.
 *
 * Environment (all optional, for development):
 *   ANIMATUS_CONSOLE_PORT           fixed port (default: a free one)
 *   ANIMATUS_CONSOLE_TOKEN          fixed token (default: random per run)
 *   ANIMATUS_CONSOLE_EXTRA_ORIGINS  comma-separated extra origins, e.g. http://127.0.0.1:5174 for the Vite dev server
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeBackend } from './fake.ts'
import { createConsoleServer } from './server.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const staticDir = path.resolve(here, '..', '..', '..', 'console', 'dist')

const backend = new FakeBackend({ realtime: true })
const extraOrigins = (process.env.ANIMATUS_CONSOLE_EXTRA_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '')

const server = createConsoleServer({
  port: Number(process.env.ANIMATUS_CONSOLE_PORT ?? 0),
  ...(process.env.ANIMATUS_CONSOLE_TOKEN ? { token: process.env.ANIMATUS_CONSOLE_TOKEN } : {}),
  staticDir,
  backend,
  extraOrigins,
  logger: (level, msg, extra) => {
    if (level === 'debug') return
    console.error(
      `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`
    )
  },
})

backend.onEvent((event) => server.publish(event))
const stopScript = backend.startScript()
await server.start()

console.log('Console demo: every number and name here is made up.')
console.log(
  existsSync(path.join(staticDir, 'index.html'))
    ? 'UI build found.'
    : 'UI build not found: run `npm run build -w @animatus/console` first.'
)
console.log(`Open: ${server.openUrl}`)
console.log('Press Ctrl+C to stop.')

let stopping = false
const shutdown = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  stopScript()
  backend.dispose()
  await server.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
