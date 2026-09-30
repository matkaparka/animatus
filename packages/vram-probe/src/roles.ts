import type { ProcInfo } from './types.ts'

/** All given fields must match; a role matches when any of its rules does. */
export interface RoleRule {
  /** Image name, case-insensitive exact match (chrome.exe). */
  name?: string
  /** Command-line substring, case-insensitive; wrap in slashes for a regular expression (/--app=.*5810/). */
  cmd?: string
  pid?: number
}
export type RoleMap = Record<string, RoleRule[]>

/**
 * Built-in matchers. They look for markers Animatus itself puts on the command lines it launches
 * (the stage's browser profile directory, the plugin runner), plus the well-known service scripts.
 * Extend or override with --role name=cmd:...
 */
export const DEFAULT_ROLES: RoleMap = {
  'gpt-sovits': [{ cmd: 'api_v2.py' }, { cmd: 'gsvi_bridge' }],
  forge: [{ cmd: 'forge-neo' }, { cmd: 'forge_neo' }],
  stage: [{ cmd: 'animatus-stage' }],
  motion: [{ cmd: 'motion_server' }],
  llm: [{ name: 'llama-server.exe' }],
}

const asRegExp = (s: string): RegExp | null => {
  const m = /^\/(.+)\/([a-z]*)$/.exec(s)
  if (!m) return null
  try {
    return new RegExp(m[1]!, m[2]!.includes('i') ? m[2] : m[2]! + 'i')
  } catch {
    return null
  }
}

function ruleMatches(rule: RoleRule, p: ProcInfo): boolean {
  if (rule.pid !== undefined && rule.pid !== p.pid) return false
  if (rule.name !== undefined && (p.name ?? '').toLowerCase() !== rule.name.toLowerCase()) return false
  if (rule.cmd !== undefined) {
    const cmd = p.cmd ?? ''
    const re = asRegExp(rule.cmd)
    if (re ? !re.test(cmd) : !cmd.toLowerCase().includes(rule.cmd.toLowerCase())) return false
  }
  return rule.pid !== undefined || rule.name !== undefined || rule.cmd !== undefined
}

/**
 * Parse `name=cmd:substring`, `name=name:image.exe`, `name=pid:1234`, or several joined by `;`
 * (all fields in one rule must match): `stage=name:chrome.exe;cmd:chrome_profile`.
 * Splitting into separate rules of one role: pass the flag more than once.
 */
export function parseRoleSpec(spec: string): { role: string; rule: RoleRule } {
  const eq = spec.indexOf('=')
  if (eq <= 0) throw new Error(`bad --role "${spec}" (expected name=cmd:text | name=name:image.exe | name=pid:123)`)
  const role = spec.slice(0, eq).trim()
  const rule: RoleRule = {}
  for (const part of spec.slice(eq + 1).split(';')) {
    const c = part.indexOf(':')
    if (c <= 0) throw new Error(`bad --role part "${part}"`)
    const key = part.slice(0, c).trim()
    const value = part.slice(c + 1)
    if (key === 'cmd') rule.cmd = value
    else if (key === 'name') rule.name = value
    else if (key === 'pid') {
      const n = Number(value)
      if (!Number.isInteger(n)) throw new Error(`bad pid in --role "${spec}"`)
      rule.pid = n
    } else throw new Error(`unknown --role key "${key}"`)
  }
  return { role, rule }
}

export function mergeRoles(base: RoleMap, extra: { role: string; rule: RoleRule }[]): RoleMap {
  const out: RoleMap = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [...v]]))
  for (const { role, rule } of extra) (out[role] ??= []).push(rule)
  return out
}

/** Maps pids to roles. A process without a matching rule inherits the role of its nearest ancestor that has one. */
export class RoleClassifier {
  readonly roles: RoleMap
  private procs = new Map<number, ProcInfo>()
  private cache = new Map<number, string>()

  constructor(roles: RoleMap) {
    this.roles = roles
  }

  setProc(info: ProcInfo): void {
    this.procs.set(info.pid, info)
    this.cache.clear()
  }

  hasProc(pid: number): boolean {
    return this.procs.has(pid)
  }

  proc(pid: number): ProcInfo | undefined {
    return this.procs.get(pid)
  }

  /** Role name, or "other" when nothing in the ancestor chain matches. */
  classify(pid: number): string {
    const hit = this.cache.get(pid)
    if (hit !== undefined) return hit
    let role = 'other'
    let cur: number | undefined = pid
    for (let depth = 0; cur !== undefined && depth < 16; depth++) {
      const info = this.procs.get(cur)
      if (!info) break
      const found = this.matchOne(info)
      if (found) {
        role = found
        break
      }
      cur = info.ppid
    }
    this.cache.set(pid, role)
    return role
  }

  private matchOne(info: ProcInfo): string | null {
    for (const [role, rules] of Object.entries(this.roles)) {
      if (rules.some((r) => ruleMatches(r, info))) return role
    }
    return null
  }
}
