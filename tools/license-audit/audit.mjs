#!/usr/bin/env node
// A licence audit of what this repository depends on.
//
//   node tools/license-audit/audit.mjs            print the summary and what needs a person to look
//   node tools/license-audit/audit.mjs --write    also rewrite the audit section of THIRD_PARTY_NOTICES.md
//   node tools/license-audit/audit.mjs --strict   exit 1 when something needs a person to look (for a release check)
//
// npm: every package in package-lock.json (its licence is in the lock file, no install needed).
// Python: every distribution installed in .venv (the light group), read from its METADATA; without a .venv, Python is
// reported as not audited. See rules.mjs for how a licence is judged.
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PYTHON_OVERRIDES, readNpmLock, readPythonMetadata, summarise } from './rules.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)

const npm = readNpmLock(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')))

/** @type {{ ecosystem: string, name: string, version: string, license: string, dev: boolean }[]} */
const python = []
const site = join(root, '.venv', 'Lib', 'site-packages')
const pythonAudited = existsSync(site)
if (pythonAudited) {
  for (const dir of readdirSync(site)) {
    if (!dir.endsWith('.dist-info')) continue
    const meta = join(site, dir, 'METADATA')
    if (!existsSync(meta)) continue
    const m = readPythonMetadata(readFileSync(meta, 'utf8'))
    if (m.name)
      python.push({
        ecosystem: 'python',
        name: m.name,
        version: m.version,
        license: PYTHON_OVERRIDES[m.name.toLowerCase()] ?? m.license,
        dev: false,
      })
  }
}

// Files that say in their first lines that they are derived from another project, and whether that project's licence text
// travels with them (the header names it: "see licenses/...").
const derived = []
const missingLicenseFiles = []
{
  const names = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
  const buf = Buffer.alloc(700)
  for (const name of names) {
    let head = ''
    try {
      const fd = openSync(join(root, name), 'r')
      const n = readSync(fd, buf, 0, buf.length, 0)
      closeSync(fd)
      head = buf.subarray(0, n).toString('utf8')
    } catch {
      continue
    }
    const m =
      /Derived from (.+?) \((https?:[^)]+)\), used under ([^;]+); see (licenses\/[\w.-]*\w)/.exec(
        head
      )
    if (!m) continue
    derived.push({ file: name, origin: m[1], url: m[2], licence: m[3].trim(), licenceFile: m[4] })
    if (!existsSync(join(root, m[4])) && !missingLicenseFiles.includes(m[4]))
      missingLicenseFiles.push(m[4])
  }
}
const derivedLines = () => {
  if (derived.length === 0) return ['No file says it is derived from another project.']
  const byOrigin = new Map()
  for (const d of derived) byOrigin.set(d.origin, [...(byOrigin.get(d.origin) ?? []), d])
  return [...byOrigin].flatMap(([origin, files]) => {
    const first = files[0]
    const missing = existsSync(join(root, first.licenceFile)) ? '' : ' **(missing)**'
    const list = files.map((f) => '`' + f.file + '`').join(', ')
    return [
      `- **${origin}** (${first.url}), used under ${first.licence}; licence text in \`${first.licenceFile}\`${missing}. ` +
        `${files.length} file(s), each with the notice and a note of what was changed: ${list}.`,
    ]
  })
}

const runtimeNpm = summarise(npm.filter((p) => !p.dev))
const devNpm = summarise(npm.filter((p) => p.dev))
const py = summarise(python)

const table = (s) =>
  [
    '| Licence | Packages | Examples |',
    '|---|---:|---|',
    ...s.licenses.map(
      (l) =>
        `| ${l.license} | ${l.count} | ${l.names.join(', ')}${l.count > l.names.length ? ', ...' : ''} |`
    ),
  ].join('\n')

const flagged = (label, s) =>
  s.review.length === 0
    ? `${label}: nothing needs a look.`
    : `${label}: ${s.review.length} need a person to look:\n` +
      s.review
        .map((r) => `- ${r.name} ${r.version}: ${r.license || '(none stated)'} (${r.why})`)
        .join('\n')

const weakLine = (label, s) =>
  s.weak.length === 0
    ? ''
    : `${label} weak copyleft (fine to depend on, keep the notice): ${[...new Set(s.weak.map((r) => r.name))].join(', ')}.`

const date = new Date().toISOString().slice(0, 10)
const section = [
  '<!-- license-audit:begin (written by tools/license-audit/audit.mjs) -->',
  `_Audit of ${date}: ${npm.length} npm packages (${runtimeNpm.total} that ship, ${devNpm.total} for building and testing only)` +
    (pythonAudited
      ? ` and ${python.length} Python distributions in the light environment._`
      : '. Python was not audited: no .venv._'),
  '',
  '### npm, what ships',
  '',
  table(runtimeNpm),
  '',
  flagged('npm, what ships', runtimeNpm),
  weakLine('npm', runtimeNpm),
  '',
  '### npm, build and test tools only (not distributed)',
  '',
  table(devNpm),
  '',
  flagged('npm, build and test tools', devNpm),
  weakLine('npm dev', devNpm),
  '',
  ...(pythonAudited
    ? [
        '### Python (light environment)',
        '',
        table(py),
        '',
        flagged('Python', py),
        weakLine('Python', py),
        '',
      ]
    : ['### Python', '', 'Not audited (no `.venv`; run `uv sync` and this again).', '']),
  '### Files derived from other projects (by their headers)',
  '',
  ...derivedLines(),
  '',
  '<!-- license-audit:end -->',
]
  .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
  .join('\n')

console.log(section)

if (args.includes('--write')) {
  const file = join(root, 'THIRD_PARTY_NOTICES.md')
  const text = readFileSync(file, 'utf8')
  const begin = text.indexOf('<!-- license-audit:begin')
  const end = text.indexOf('<!-- license-audit:end -->')
  if (begin >= 0 && end > begin)
    writeFileSync(
      file,
      text.slice(0, begin) + section + text.slice(end + '<!-- license-audit:end -->'.length)
    )
  else if (/^## To be completed before the first release[\s\S]*$/m.test(text))
    writeFileSync(
      file,
      text.replace(
        /^## To be completed before the first release[\s\S]*$/m,
        `## Dependency licence audit\n\n${section}\n`
      )
    )
  else writeFileSync(file, `${text.trimEnd()}\n\n## Dependency licence audit\n\n${section}\n`)
  console.error('THIRD_PARTY_NOTICES.md updated.')
}

const packagesToLookAt = runtimeNpm.review.length + py.review.length
if (args.includes('--strict') && packagesToLookAt + missingLicenseFiles.length > 0) {
  console.error(
    `\nlicense-audit: ${packagesToLookAt} package(s) that ship need a person to look, ${missingLicenseFiles.length} licence file(s) named in a header are missing.`
  )
  process.exit(1)
}
