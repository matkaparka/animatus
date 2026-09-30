// Reading and judging the licences of the packages this repository depends on.
//
// Not legal advice: it sorts what it finds into "permissive", "weak copyleft" (fine to use, worth knowing), and "needs a
// person to look" (copyleft, non-commercial, no licence, or a licence it does not know). The owner of the repository decides
// what to do about the last group before anything is published.

/** Licences that ask for a notice and nothing else. */
const PERMISSIVE = new Set(
  [
    'MIT',
    'MIT-0',
    'ISC',
    '0BSD',
    'BSD',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'BSD-2-Clause-Views',
    'Apache-2.0',
    'Apache 2.0',
    'Unlicense',
    'CC0-1.0',
    'Python-2.0',
    'PSF-2.0',
    'BlueOak-1.0.0',
    'Zlib',
    'WTFPL',
    'CC-BY-3.0',
    'CC-BY-4.0',
    'HPND',
    'X11',
    'NCSA',
    'Artistic-2.0',
    'BSL-1.0',
    'ZPL-2.1',
    'MIT-CMU',
    'PSF',
    'Python Software Foundation License',
  ].map((s) => s.toLowerCase())
)

/** Copyleft that applies to the package's own files, not to what links or calls it. Fine to depend on; keep the notice. */
const WEAK_COPYLEFT = new Set([
  'mpl-2.0',
  'lgpl-2.1',
  'lgpl-2.1-only',
  'lgpl-2.1-or-later',
  'lgpl-3.0',
  'lgpl-3.0-only',
  'lgpl-3.0-or-later',
  'epl-1.0',
  'epl-2.0',
  'cddl-1.0',
  'cddl-1.1',
])

/** Words that mean a person has to look. */
const REVIEW_PATTERNS = [
  [/\bagpl\b|affero/i, 'network copyleft'],
  [/\bgpl\b|general public/i, 'copyleft'],
  [/sspl|server side public/i, 'source-available, not open source'],
  [
    /commons clause|business source|\bbsl-1\.1\b|elastic license|\belv2\b/i,
    'source-available, not open source',
  ],
  [/(^|[-\s])nc([-\s]|$)|non-?commercial|noncommercial|polyform/i, 'non-commercial'],
  [/proprietary|commercial license|all rights reserved/i, 'proprietary'],
  [/unlicensed|no license|not specified|unknown|^$/i, 'no licence stated'],
]

/**
 * Sort a licence string (an SPDX expression, or the free text some Python packages give) into a class.
 * `A OR B`: the most permissive alternative counts; `A AND B`: the least.
 * @returns {{ class: 'permissive' | 'weak-copyleft' | 'review', why: string }}
 */
export function judge(license) {
  const text = String(license ?? '').trim()
  if (text.length > 200) {
    // free text such as a whole licence file pasted into the metadata: do not guess
    return { class: 'review', why: 'the licence field holds text, not a name' }
  }
  const norm = text.replace(/^\(|\)$/g, '').trim()
  const or = norm.split(/\s+OR\s+/i)
  if (or.length > 1) {
    const judged = or.map(judge)
    return (
      judged.find((j) => j.class === 'permissive') ??
      judged.find((j) => j.class === 'weak-copyleft') ??
      judged[0]
    )
  }
  const and = norm.split(/\s+AND\s+/i)
  if (and.length > 1) {
    const judged = and.map(judge)
    return (
      judged.find((j) => j.class === 'review') ??
      judged.find((j) => j.class === 'weak-copyleft') ??
      judged[0]
    )
  }
  const key = norm.toLowerCase().replace(/^licen[sc]e[:\s]+/, '')
  // the Lesser licences say "General Public" too: tell them apart before the copyleft words are looked for
  if (WEAK_COPYLEFT.has(key) || /lesser general public|\blgpl/.test(key))
    return { class: 'weak-copyleft', why: 'file-level copyleft' }
  for (const [re, why] of REVIEW_PATTERNS) if (re.test(key)) return { class: 'review', why }
  if (PERMISSIVE.has(key) || PERMISSIVE.has(key.replace(/\s+license$/, '')))
    return { class: 'permissive', why: '' }
  // a family name the metadata uses in words
  if (
    /^(mit|bsd|isc|apache|mozilla public license 2|\d-clause bsd|new bsd|simplified bsd)/.test(key)
  ) {
    return /mozilla/.test(key)
      ? { class: 'weak-copyleft', why: 'file-level copyleft' }
      : { class: 'permissive', why: '' }
  }
  return { class: 'review', why: `a licence this tool does not know: ${text.slice(0, 60)}` }
}

/** The packages of a package-lock.json (lockfileVersion 2 or 3): name, version, licence, and whether it is a dev-only dependency. */
export function readNpmLock(lock) {
  const out = []
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path.includes('node_modules/')) continue
    if (meta.link === true) continue // a workspace package of this repository, not a dependency
    const name = meta.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    out.push({
      ecosystem: 'npm',
      name,
      version: meta.version ?? '',
      license: licenseText(meta.license),
      dev: meta.dev === true || meta.devOptional === true,
    })
  }
  return dedupe(out)
}

function licenseText(v) {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(licenseText).join(' OR ')
  if (v && typeof v === 'object' && typeof v.type === 'string') return v.type
  return ''
}

/**
 * Distributions whose metadata does not name their licence properly, checked by hand against the project's own licence
 * file. Keep it short and say what was checked.
 */
export const PYTHON_OVERRIDES = {
  scipy: 'BSD-3-Clause', // the License field holds a copyright line; the project ships the BSD 3-clause text
}

/** The licence of a Python distribution from its METADATA file (PEP 639 expression first, then the older fields). */
export function readPythonMetadata(text) {
  const head = text.split(/\r?\n\r?\n/, 1)[0] ?? ''
  const field = (name) => {
    const m = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(head)
    return m ? m[1].trim() : ''
  }
  const classifiers = [...head.matchAll(/^Classifier:\s*License\s*::\s*(.+)$/gim)].map((m) =>
    m[1].trim()
  )
  const expression = field('License-Expression')
  const legacy = field('License')
  const fromClassifier = classifiers
    .map((c) => c.replace(/^OSI Approved\s*::\s*/i, '').replace(/\s*License$/i, ''))
    .filter((c) => !/^OSI Approved$/i.test(c))
    .join(' OR ')
  const license =
    expression || (legacy && legacy.toUpperCase() !== 'UNKNOWN' ? legacy : '') || fromClassifier
  return { name: field('Name'), version: field('Version'), license }
}

function dedupe(list) {
  const seen = new Map()
  for (const p of list) seen.set(`${p.ecosystem}:${p.name}@${p.version}`, p)
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  )
}

/** Group what was read by class, and by licence within a class. */
export function summarise(packages) {
  const rows = packages.map((p) => ({ ...p, ...judge(p.license) }))
  const byLicense = new Map()
  for (const r of rows) {
    const key = r.license || '(none stated)'
    const e = byLicense.get(key) ?? { license: key, class: r.class, count: 0, names: [] }
    e.count++
    if (e.names.length < 8) e.names.push(r.name)
    byLicense.set(key, e)
  }
  return {
    rows,
    total: rows.length,
    review: rows.filter((r) => r.class === 'review'),
    weak: rows.filter((r) => r.class === 'weak-copyleft'),
    licenses: [...byLicense.values()].sort(
      (a, b) => b.count - a.count || a.license.localeCompare(b.license)
    ),
  }
}
