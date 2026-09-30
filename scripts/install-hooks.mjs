// Points git at the repo's own hooks (.githooks). Runs from `npm install` (prepare).
// Silent no-op when this is not a git checkout (for example an unpacked release).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' })
} catch {
  process.exit(0)
}

if (existsSync(resolve(root, '.githooks'))) {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' })
}
