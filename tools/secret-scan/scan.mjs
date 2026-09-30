#!/usr/bin/env node
// Secret / privacy scanner for this repo.
//
//   node tools/secret-scan/scan.mjs            scan every tracked file plus untracked, non-ignored files
//   node tools/secret-scan/scan.mjs --staged   scan the staged versions of files (pre-commit hook)
//   node tools/secret-scan/scan.mjs <paths>    scan the given files
//
// Extra inputs (both optional):
//   .secretscanignore            tracked; one glob per line for files to skip (false positives)
//   .private/deny-terms.txt      NOT tracked; one term per line, case-insensitive; a hit fails the scan.
//                                Use it for names and paths that must never appear in the public repo.
//
// Exit code 1 when anything is found. Matched values are redacted in the output.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globToRegExp, scanText } from './rules.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_BYTES = 2 * 1024 * 1024

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, ...opts })

const gitLines = (args) => git(args, { encoding: 'utf8' }).split('\0').filter(Boolean)

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0)

function loadIgnore() {
  const p = resolve(root, '.secretscanignore')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(globToRegExp)
}

/**
 * The private deny list lives in the main checkout's .private/ (untracked). A linked worktree has no .private/ of its
 * own, so fall back to the main checkout's, found through the shared git directory.
 */
function privateFile(name) {
  const local = resolve(root, '.private', name)
  if (existsSync(local)) return local
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
    const main = resolve(root, common, '..')
    const p = resolve(main, '.private', name)
    if (existsSync(p)) return p
  } catch {
    // not a git checkout: only the local path counts
  }
  return local
}

function loadDenyTerms() {
  const p = privateFile('deny-terms.txt')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

const args = process.argv.slice(2)
const staged = args.includes('--staged')
const explicit = args.filter((a) => !a.startsWith('--'))

let files
/** @type {(f: string) => Buffer | null} */
let read
if (staged) {
  files = gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
  read = (f) => {
    try {
      return git(['show', `:${f}`])
    } catch {
      return null
    }
  }
} else {
  files = explicit.length
    ? explicit.map((f) => f.replace(/\\/g, '/'))
    : [
        ...gitLines(['ls-files', '-z']),
        ...gitLines(['ls-files', '-z', '--others', '--exclude-standard']),
      ]
  read = (f) => {
    const p = resolve(root, f)
    try {
      if (!statSync(p).isFile()) return null
      return readFileSync(p)
    } catch {
      return null
    }
  }
}

const ignore = loadIgnore()
const denyTerms = loadDenyTerms()
let total = 0
let scanned = 0

for (const f of files) {
  const norm = f.replace(/\\/g, '/')
  if (ignore.some((re) => re.test(norm))) continue
  const buf = read(f)
  if (!buf || buf.length > MAX_BYTES || looksBinary(buf)) continue
  scanned++
  const hits = scanText(buf.toString('utf8'), { denyTerms })
  for (const h of hits) {
    total++
    console.error(`${norm}:${h.line}  [${h.rule}] ${h.description}  ${h.preview}`)
  }
}

if (total > 0) {
  console.error(`\nsecret-scan: ${total} finding(s) in ${scanned} file(s). Nothing was committed.`)
  console.error('Remove the value (load it from the environment or the secret store instead).')
  console.error('Real false positive? Add the file path to .secretscanignore.')
  process.exit(1)
}
console.log(
  `secret-scan: clean (${scanned} file(s) scanned${denyTerms.length ? `, ${denyTerms.length} private deny term(s)` : ''}).`
)
