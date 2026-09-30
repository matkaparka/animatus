import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import { AutomationsConfig, fill, placeholdersIn } from '../../src/automation/rules.ts'

const parse = (rules: unknown[], extra: Record<string, unknown> = {}) =>
  AutomationsConfig.safeParse({ rules, ...extra })
const message = (r: ReturnType<typeof parse>): string =>
  r.success ? '' : r.error.issues.map((i) => i.message).join(' | ')

describe('the shape of a rule', () => {
  it('a stock configuration has no rules and is on', () => {
    const c = AutomationsConfig.parse({})
    expect(c).toEqual({ enabled: true, rules: [], max_per_minute: 12, quiet_wait_sec: 20 })
  })

  it('accepts a rule of each kind', () => {
    const r = parse([
      { id: 'follow', on: 'timer', every_min: 20, do: [{ say: 'follow' }] },
      { id: 'quiet', on: 'cold_start', do: [{ tell: 'a topic, after {minutes} minutes' }] },
      {
        id: 'crew',
        on: 'guard',
        do: [{ tool: { name: 'tell_streamer', args: { text: '{name} joined' } } }],
      },
      { id: 'sc', on: 'superchat', min_yuan: 30, do: [{ say: '{name}: {yuan}' }] },
      { id: 'bye', on: 'stream_end', do: [{ consolidate_memory: true }] },
      { id: 'night', on: 'mode_entered', mode: 'sleep', do: [{ say: 'good night' }] },
    ])
    expect(message(r)).toBe('')
  })

  it('refuses what is not in the language of a rule: another action, two actions in one, an empty list, too many', () => {
    expect(parse([{ id: 'a', on: 'stream_end', do: [{ run: 'del *' }] }]).success).toBe(false)
    expect(parse([{ id: 'a', on: 'stream_end', do: [{ say: 'x', tell: 'y' }] }]).success).toBe(
      false
    )
    expect(parse([{ id: 'a', on: 'stream_end', do: [] }]).success).toBe(false)
    expect(
      parse([{ id: 'a', on: 'stream_end', do: Array.from({ length: 6 }, () => ({ say: 'x' })) }])
        .success
    ).toBe(false)
    expect(parse([{ id: 'a', on: 'nothing', do: [{ say: 'x' }] }]).success).toBe(false)
    expect(parse([{ id: 'a', on: 'stream_end', do: [{ say: '' }] }]).success).toBe(false)
    expect(parse([{ id: 'a', on: 'stream_end', do: [{ say: 'x' }], surprise: 1 }]).success).toBe(
      false
    )
    expect(parse([{ id: 'A b', on: 'stream_end', do: [{ say: 'x' }] }]).success).toBe(false)
    expect(
      parse([{ id: 'a', on: 'stream_end', do: [{ tool: { name: 'Not A Tool' } }] }]).success
    ).toBe(false)
  })

  it('a timer needs every_min, and every_min, mode and min_yuan belong only to their events', () => {
    expect(message(parse([{ id: 'a', on: 'timer', do: [{ say: 'x' }] }]))).toContain(
      'a timer needs every_min'
    )
    expect(message(parse([{ id: 'a', on: 'guard', every_min: 5, do: [{ say: 'x' }] }]))).toContain(
      'every_min belongs to a timer'
    )
    expect(message(parse([{ id: 'a', on: 'guard', mode: 'x', do: [{ say: 'x' }] }]))).toContain(
      'mode belongs to'
    )
    expect(message(parse([{ id: 'a', on: 'guard', min_yuan: 5, do: [{ say: 'x' }] }]))).toContain(
      'min_yuan belongs to superchat'
    )
    expect(parse([{ id: 'a', on: 'timer', every_min: 0.5, do: [{ say: 'x' }] }]).success).toBe(
      false
    )
  })

  it('a placeholder the event does not offer is an error that says what it does offer', () => {
    expect(message(parse([{ id: 'a', on: 'guard', do: [{ say: 'hi {nmae}' }] }]))).toBe(
      'rule "a": {nmae} is not offered by guard (it offers {name}, {title}, {months})'
    )
    expect(message(parse([{ id: 'a', on: 'stream_end', do: [{ tell: 'hi {name}' }] }]))).toContain(
      'it offers nothing'
    )
    expect(
      message(
        parse([{ id: 'a', on: 'guard', do: [{ tool: { name: 't', args: { x: ['{oops}'] } } }] }])
      )
    ).toContain('{oops}')
  })

  it('two rules with one id are an error', () => {
    const r = parse([
      { id: 'a', on: 'stream_end', do: [{ say: 'x' }] },
      { id: 'a', on: 'stream_start', do: [{ say: 'y' }] },
    ])
    expect(message(r)).toContain('two rules are called "a"')
  })

  it('is part of the configuration file, in snake_case like the rest', () => {
    const c = parseConfig(
      {
        automations: {
          max_per_minute: 5,
          rules: [{ id: 'a', on: 'stream_end', do: [{ say: 'bye' }] }],
        },
      },
      { root: 'C:/x' }
    )
    expect(c.automations.max_per_minute).toBe(5)
    expect(c.automations.rules[0]?.id).toBe('a')
    expect(() =>
      parseConfig(
        { automations: { rules: [{ id: 'a', on: 'timer', do: [{ say: 'x' }] }] } },
        { root: 'C:/x' }
      )
    ).toThrow(/a timer needs every_min/)
  })
})

describe('placeholders', () => {
  it('are found and filled; one that is not there is left as written', () => {
    expect(placeholdersIn('{name} and {title}, {name}')).toEqual(['name', 'title', 'name'])
    expect(placeholdersIn('no braces, or {1bad}, or { name }')).toEqual([])
    expect(fill('hi {name}, {other}', { name: 'ann' })).toBe('hi ann, {other}')
  })
})
