#!/usr/bin/env node
// Keeps assets and big files out of the repository (see rules.mjs for why).
//
//   node tools/asset-scan/scan.mjs            every tracked file plus untracked, non-ignored ones
//   node tools/asset-scan/scan.mjs --staged   what is about to be committed (the pre-commit hook)
//   node tools/asset-scan/scan.mjs --history  every file that was ever committed, on any branch: the history is clean or it is not
//
// `.assetscanignore` (tracked, optional): one glob per line for files that are allowed on purpose (a tiny test fixture,
// an icon that is ours). Exit code 1 when anything is found.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, globToRegExp } from './rules.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024, ...opts })
const lines = (args, sep = '\0') => git(args, { encoding: 'utf8' }).split(sep).filter(Boolean)

function loadIgnore() {
  const p = resolve(root, '.assetscanignore')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(globToRegExp)
}

const args = process.argv.slice(2)
const ignore = loadIgnore()
const allowed = (path) => ignore.some((re) => re.test(path.replace(/\\/g, '/')))

/** @type {{ path: string, size: number | null, where?: string }[]} */
let items
let what
if (args.includes('--history')) {
  what = 'every file in the history'
  // every blob that was ever reachable, with its size and one path it had
  const listing = lines(['rev-list', '--objects', '--all'], '\n')
  const paths = new Map()
  for (const l of listing) {
    const space = l.indexOf(' ')
    if (space > 0) paths.set(l.slice(0, space), l.slice(space + 1))
  }
  const batch = execFileSync(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    {
      cwd: root,
      input: [...paths.keys()].join('\n') + '\n',
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    }
  )
  items = []
  for (const l of batch.split('\n')) {
    const [name, type, size] = l.split(' ')
    if (type === 'blob' && name && paths.has(name))
      items.push({ path: paths.get(name), size: Number(size), where: name.slice(0, 8) })
  }
} else if (args.includes('--staged')) {
  what = 'the staged files'
  items = lines(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).map((path) => {
    let size = null
    try {
      size = Number(git(['cat-file', '-s', `:${path}`], { encoding: 'utf8' }).trim())
    } catch {
      // not readable: the name alone decides
    }
    return { path, size }
  })
} else {
  what = 'the tracked and untracked files'
  const names = [
    ...lines(['ls-files', '-z']),
    ...lines(['ls-files', '-z', '--others', '--exclude-standard']),
  ]
  items = names.map((path) => {
    let size = null
    try {
      const st = statSync(resolve(root, path))
      size = st.isFile() ? st.size : null
    } catch {
      // gone: only its name counts
    }
    return { path, size }
  })
}

let scanned = 0
let bad = 0
for (const it of items) {
  if (allowed(it.path)) continue
  scanned++
  const c = classify(it.path, it.size)
  if (!c) continue
  bad++
  console.error(`${it.path}${it.where ? ` (blob ${it.where})` : ''}  [${c.rule}] ${c.description}`)
}

if (bad > 0) {
  console.error(`\nasset-scan: ${bad} finding(s) in ${what}. Nothing was committed.`)
  console.error(
    'Assets and big files stay out of the repository. A file that is meant to be here (a tiny fixture, an icon of ours): add its path to .assetscanignore.'
  )
  process.exit(1)
}
console.log(`asset-scan: clean (${scanned} file(s) in ${what}).`)
