/**
 * Automations: "when this happens, do that", written in the configuration (docs/automations.md).
 *
 * A rule names an event and a short list of things to do. What it may do is the same small set the rest of the program
 * uses: say a fixed line, ask the model to say something, call a tool through the tool gate, run the memory
 * consolidation. There is no way to run a command or reach the network from a rule.
 */
import { z } from 'zod'

export const AUTOMATION_EVENTS = [
  'timer',
  'cold_start',
  'stream_start',
  'stream_end',
  'guard',
  'superchat',
  'mode_entered',
  'mode_exited',
] as const
export type AutomationEventType = (typeof AUTOMATION_EVENTS)[number]

/**
 * Events made from what a member of the audience did: the name and the words in them are theirs. A reply or a tool call
 * that comes of such an event is judged as the audience's, whatever the rule says.
 */
export const AUDIENCE_EVENTS: ReadonlySet<AutomationEventType> = new Set(['guard', 'superchat'])

/** What each event offers to the texts of a rule as `{placeholder}`. */
export const PLACEHOLDERS: Readonly<Record<AutomationEventType, readonly string[]>> = {
  timer: [],
  cold_start: ['minutes'],
  stream_start: [],
  stream_end: [],
  guard: ['name', 'title', 'months'],
  superchat: ['name', 'yuan', 'text'],
  mode_entered: ['mode'],
  mode_exited: ['mode'],
}

const PLACEHOLDER = /\{([A-Za-z_]\w*)\}/g

/** The placeholder names used in a text. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string)
}

/** Replace `{name}` with `vars[name]`; a name that is not there is left as written. */
export function fill(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (m, name: string) => (name in vars ? (vars[name] as string) : m))
}

const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,47}$/, 'a rule id is lower case letters, digits, - and _')
const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)

export const Action = z.union([
  z.strictObject({ say: z.string().min(1).max(300) }),
  z.strictObject({ tell: z.string().min(1).max(500) }),
  z.strictObject({
    tool: z.strictObject({ name: ToolName, args: z.record(z.string(), z.unknown()).default({}) }),
  }),
  z.strictObject({ consolidate_memory: z.literal(true) }),
])
export type Action = z.infer<typeof Action>

const Rule = z
  .strictObject({
    id: Id,
    enabled: z.boolean().default(true),
    on: z.enum(AUTOMATION_EVENTS),
    /** `timer` only: every this many minutes. */
    every_min: z.number().min(1).max(1440).optional(),
    /** `mode_entered` and `mode_exited` only: this mode; without it, any. */
    mode: z.string().min(1).max(64).optional(),
    /** `superchat` only: at least this many yuan. */
    min_yuan: z.number().min(0).optional(),
    /** The rule does not run again within this long after it ran. Default 30 s for an audience event, none otherwise. */
    cooldown_sec: z.number().min(0).max(86_400).optional(),
    do: z.array(Action).min(1).max(5),
  })
  .superRefine((rule, ctx) => {
    const bad = (message: string) =>
      ctx.addIssue({ code: 'custom', message: `rule "${rule.id}": ${message}` })
    if (rule.on === 'timer' && rule.every_min === undefined) bad('a timer needs every_min')
    if (rule.on !== 'timer' && rule.every_min !== undefined) bad('every_min belongs to a timer')
    if (rule.on !== 'mode_entered' && rule.on !== 'mode_exited' && rule.mode !== undefined)
      bad('mode belongs to mode_entered and mode_exited')
    if (rule.on !== 'superchat' && rule.min_yuan !== undefined) bad('min_yuan belongs to superchat')
    const offered = PLACEHOLDERS[rule.on]
    const check = (text: string) => {
      for (const name of placeholdersIn(text))
        if (!offered.includes(name))
          bad(
            `{${name}} is not offered by ${rule.on}` +
              (offered.length > 0
                ? ` (it offers ${offered.map((o) => `{${o}}`).join(', ')})`
                : ' (it offers nothing)')
          )
    }
    const walk = (value: unknown): void => {
      if (typeof value === 'string') check(value)
      else if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') Object.values(value).forEach(walk)
    }
    for (const a of rule.do)
      walk('say' in a ? a.say : 'tell' in a ? a.tell : 'tool' in a ? a.tool.args : '')
  })

export const AutomationsConfig = z
  .strictObject({
    /** All rules stop when this is false. */
    enabled: z.boolean().default(true),
    rules: z.array(Rule).max(50).default([]),
    /** Actions across all rules per minute; the rest are dropped. */
    max_per_minute: z.number().int().min(1).max(600).default(12),
    /** How long a line waits for the voice to be free before the rule gives up on it. */
    quiet_wait_sec: z.number().min(1).max(600).default(20),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>()
    for (const r of c.rules) {
      if (seen.has(r.id))
        ctx.addIssue({ code: 'custom', message: `two rules are called "${r.id}"` })
      seen.add(r.id)
    }
  })
export type AutomationsConfig = z.infer<typeof AutomationsConfig>
export type AutomationRule = AutomationsConfig['rules'][number]
