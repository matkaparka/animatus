#!/usr/bin/env node
// Makes a linked git worktree usable without a second `npm install`.
//
//   git worktree add ../animatus-work -b work
//   cd ../animatus-work
//   node scripts/link-worktree-deps.mjs            (the main checkout is found through git)
//
// The worktree gets its own node_modules whose entries are directory junctions to the main checkout's installed
// packages, except `@animatus/*`, which point at THIS worktree's packages: an edit to packages/protocol here is
// what the tests of packages/orchestrator here see. Each package's own node_modules is linked the same way.
// Windows: junctions need no privileges. Elsewhere: plain symlinks.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: here, encoding: 'utf8' }).trim()
const main = resolve(here, common, '..')

if (realpathSync(main) === realpathSync(here)) {
  console.log('This is the main checkout: nothing to link.')
  process.exit(0)
}

const link = (target, at) => {
  if (existsSync(at) || isLink(at)) rmSync(at, { recursive: false, force: true })
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
}
const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

const mainModules = join(main, 'node_modules')
if (!existsSync(mainModules)) {
  console.error(`The main checkout has no node_modules (${mainModules}). Run \`npm install\` there first.`)
  process.exit(1)
}

// root node_modules
const nm = join(here, 'node_modules')
mkdirSync(nm, { recursive: true })
let linked = 0
for (const e of readdirSync(mainModules, { withFileTypes: true })) {
  if (e.name === '@animatus') continue
  if (!e.isDirectory() && !e.isSymbolicLink()) continue
  link(join(mainModules, e.name), join(nm, e.name))
  linked++
}

// @animatus/*: this worktree's own packages
const scope = join(nm, '@animatus')
if (isLink(scope)) rmSync(scope, { force: true })
mkdirSync(scope, { recursive: true })
const packagesDir = join(here, 'packages')
for (const d of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue
  const pj = join(packagesDir, d.name, 'package.json')
  if (!existsSync(pj)) continue
  const name = JSON.parse(readFileSync(pj, 'utf8')).name
  if (typeof name === 'string' && name.startsWith('@animatus/')) {
    link(join(packagesDir, d.name), join(scope, name.slice('@animatus/'.length)))
    // packages keep dependencies of their own that were not hoisted
    const own = join(main, 'packages', d.name, 'node_modules')
    if (existsSync(own)) link(own, join(packagesDir, d.name, 'node_modules'))
  }
}
console.log(`Linked ${linked} installed packages from ${mainModules}; @animatus/* point at ${packagesDir}.`)
