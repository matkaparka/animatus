// Secret and privacy scanner rules. No dependencies.
//
// Findings never carry the matched value; `redact()` keeps at most the first 3 characters.
// Sample secrets in tests are assembled from pieces so this repo never contains a full one.

/** @typedef {{ id: string, description: string, regex: RegExp, group?: number, minEntropy?: number }} Rule */

const PLACEHOLDER =
  /^(your|xxx|example|changeme|change-me|placeholder|todo|dummy|sample|test|<|\$\{|\$\(|process\.env|import\.meta|null$|undefined$|none$|false$|true$|\*+$|x+$)/i

/** @type {Rule[]} */
export const RULES = [
  { id: 'google-api-key', description: 'Google API key', regex: /AIza[0-9A-Za-z_-]{35}/g },
  { id: 'anthropic-key', description: 'Anthropic API key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    id: 'openai-style-key',
    description: 'sk- style API key',
    regex: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{24,}/g,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g,
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key id',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  { id: 'slack-token', description: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    id: 'private-key-block',
    description: 'private key block',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'bilibili-cookie',
    description: 'Bilibili cookie value',
    regex: /\b(?:SESSDATA|bili_jct|buvid3|DedeUserID__ckMd5)\s*[=:]\s*["']?([A-Za-z0-9%_.~-]{8,})/g,
    group: 1,
    minEntropy: 2.5,
  },
  {
    id: 'generic-secret-assignment',
    description: 'secret-looking value assigned to a key/token/password',
    regex:
      /\b(?:api[_-]?key|secret|token|passwd|password|access[_-]?key|auth[_-]?key)\b["']?\s*[:=]\s*["']([A-Za-z0-9_\-/+=.]{20,})["']/gi,
    group: 1,
    minEntropy: 3.2,
  },
  {
    id: 'personal-path',
    description: 'personal Windows user path',
    regex:
      /[A-Za-z]:[\\/]+Users[\\/]+(?!<|%|Public\b|Default\b|\.\.\.|\$|\{|USERNAME|user\b|you\b|name\b)([^\\/\s"'`]+)/g,
    group: 1,
  },
]

export function entropy(s) {
  if (!s) return 0
  const freq = new Map()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

export function redact(value) {
  const v = String(value)
  return v.length <= 3
    ? '***'
    : `${v.slice(0, 3)}${'*'.repeat(Math.min(v.length - 3, 8))} (${v.length} chars)`
}

/**
 * Scan one file's text.
 * @param {string} text
 * @param {{ denyTerms?: string[], rules?: Rule[] }} [opts]
 * @returns {{ line: number, rule: string, description: string, preview: string }[]}
 */
export function scanText(text, opts = {}) {
  const rules = opts.rules ?? RULES
  const deny = (opts.denyTerms ?? []).map((t) => t.toLowerCase()).filter(Boolean)
  const findings = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length > 4000) continue // minified blobs: not worth the false positives
    for (const rule of rules) {
      rule.regex.lastIndex = 0
      let m
      while ((m = rule.regex.exec(line)) !== null) {
        const value = rule.group ? m[rule.group] : m[0]
        if (rule.group && PLACEHOLDER.test(value)) continue
        if (rule.minEntropy && entropy(value) < rule.minEntropy) continue
        findings.push({
          line: i + 1,
          rule: rule.id,
          description: rule.description,
          preview: redact(value),
        })
        if (m[0].length === 0) rule.regex.lastIndex++
      }
    }
    if (deny.length) {
      const lower = line.toLowerCase()
      for (const term of deny) {
        if (lower.includes(term)) {
          findings.push({
            line: i + 1,
            rule: 'deny-term',
            description: 'term from the private deny list',
            preview: '(private term)',
          })
        }
      }
    }
  }
  return findings
}

/** Glob-ish matcher for .secretscanignore: `*` within a segment, `**` across segments. */
export function globToRegExp(glob) {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*'
        i++
        if (g[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if ('\\^$+?.()|{}[]'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp(`^${re}$`)
}
