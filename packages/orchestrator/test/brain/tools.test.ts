import { describe, expect, it } from 'vitest'
import { makeSource } from '@animatus/protocol'
import type { EventSource } from '@animatus/protocol'
import { Brain } from '../../src/brain/brain.ts'
import type { BrainInput, DirectorLike, LlmLike } from '../../src/brain/brain.ts'
import { ChatLog } from '../../src/brain/chatlog.ts'
import { MAX_TOOL_CALLS_PER_REPLY, buildSystemPrompt, toolsBlock } from '../../src/brain/prompt.ts'
import { MAX_TOOL_BLOCK_CHARS, parseToolBlock } from '../../src/brain/toolblock.ts'
import type { LlmDelta, LlmRequest } from '../../src/llm/types.ts'

const FENCE = '`'.repeat(3)
const block = (json: string) => `${FENCE}tool\n${json}\n${FENCE}`
const call = (tool: string, args: unknown = {}) => block(JSON.stringify({ tool, args }))

describe('parseToolBlock', () => {
  it('reads a tool name and its arguments', () => {
    expect(parseToolBlock('{"tool":"enter_mode","args":{"mode":"sleep"}}')).toEqual({
      ok: true,
      tool: 'enter_mode',
      args: { mode: 'sleep' },
    })
    expect(parseToolBlock('  {"tool": "exit_mode"}\n')).toEqual({
      ok: true,
      tool: 'exit_mode',
      args: {},
    })
  })

  it('refuses everything that is not exactly one object with a tool name', () => {
    for (const raw of [
      '',
      'not json',
      '[]',
      '[{"tool":"a"}]',
      '"tool"',
      '5',
      'null',
      '{}',
      '{"tool":5}',
      '{"tool":"Enter Mode"}',
      '{"tool":"a-b"}',
      '{"tool":"_x"}',
      `{"tool":"${'a'.repeat(49)}"}`,
      '{"tool":"a","args":[1]}',
      '{"tool":"a","args":"x"}',
      '{"tool":"a","args":null}',
      '{"tool":"a"} {"tool":"b"}',
      '{"tool":"a"}\n{"tool":"b"}',
    ]) {
      const r = parseToolBlock(raw)
      expect(r.ok, raw).toBe(false)
    }
  })

  it('refuses a block that is too long, without trying to read it', () => {
    const r = parseToolBlock(`{"tool":"a","args":{"text":"${'x'.repeat(MAX_TOOL_BLOCK_CHARS)}"}}`)
    expect(r).toEqual({ ok: false, reason: 'too_big' })
  })

  it('keeps a key called __proto__ as plain data', () => {
    const r = parseToolBlock('{"tool":"a","args":{"__proto__":{"polluted":true}}}')
    expect(r.ok).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('the tools block of the prompt', () => {
  it('lists each tool with its arguments, marks the ones that wait for the streamer, and tells how many a reply may use', () => {
    const text = toolsBlock([
      {
        name: 'tell_streamer',
        description: 'Leave a note.',
        usage: '{"text": "..."}',
        approval: false,
      },
      { name: 'enter_mode', description: 'Start a mode.', usage: '{"mode": "id"}', approval: true },
    ])
    expect(text).toContain(`${FENCE}tool`)
    expect(text).toContain('- tell_streamer: Leave a note. Arguments: {"text": "..."}')
    expect(text).toContain("- enter_mode (waits for the streamer's yes): Start a mode.")
    expect(text).toContain(`At most ${MAX_TOOL_CALLS_PER_REPLY} per reply`)
    expect(text).toContain('for requests from staff only')
    expect(text).toContain('never orders for those')
    expect(text).toContain('also when a viewer asks for it')
  })

  it('sits after the mode prompts and before memory; no tools, no block', () => {
    const withTools = buildSystemPrompt({
      persona: 'PERSONA',
      modePrompts: [{ id: 'm', text: 'MODE' }],
      tools: [{ name: 'a', description: 'd', usage: '{}', approval: false }],
      memory: ['a fact'],
    }).text
    expect(withTools.indexOf('MODE')).toBeLessThan(withTools.indexOf('Tools you may ask for'))
    expect(withTools.indexOf('Tools you may ask for')).toBeLessThan(withTools.indexOf('a fact'))
    expect(buildSystemPrompt({ persona: 'P', tools: [] }).text).not.toContain(
      'Tools you may ask for'
    )
    expect(buildSystemPrompt({ persona: 'P' }).text).not.toContain('Tools you may ask for')
  })
})

// ─────────────────────────────── the brain ───────────────────────────────

function scripted(pieces: (string | Error)[]): LlmLike & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = []
  return {
    requests,
    stream(req: LlmRequest): AsyncIterable<LlmDelta> {
      requests.push(req)
      return (async function* () {
        for (const p of pieces) {
          if (req.signal?.aborted) return
          await new Promise((r) => setTimeout(r, 0))
          if (req.signal?.aborted) return
          if (p instanceof Error) throw p
          yield { type: 'text', text: p }
        }
      })()
    },
  }
}

const director = (): DirectorLike => ({
  beginTurn: () => ({ enqueue: () => true, end: () => {} }),
  cancelTurn: () => {},
})

interface Called {
  tool: string
  args: Record<string, unknown>
  origin: EventSource
}

function setup(llm: LlmLike, extra: Partial<ConstructorParameters<typeof Brain>[0]> = {}) {
  const brain = new Brain({
    llm,
    director: director(),
    chat: new ChatLog(),
    persona: () => 'You are Nova.',
    tools: () => [{ name: 'tell_streamer', description: 'note', usage: '{}', approval: false }],
    ...extra,
  })
  const calls: Called[] = []
  const ignored: string[] = []
  brain.on('tool.call', (c) => calls.push({ tool: c.tool, args: c.args, origin: c.origin }))
  brain.on('tool.ignored', (c) => ignored.push(c.reason))
  return { brain, calls, ignored }
}

const viewer = (extra: Partial<BrainInput> = {}): BrainInput => ({
  text: 'hi',
  source: 'viewer',
  trust: 'untrusted',
  name: 'ann',
  ...extra,
})

describe('a reply that asks for tools', () => {
  it('reports each finished block, in the order written, with who the reply answered', async () => {
    const llm = scripted([
      '[happy]Sure, ',
      'one moment. ',
      call('tell_streamer', { text: 'hello' }),
      ' Done. ',
      call('remember', { text: 'x' }),
    ])
    const { brain, calls } = setup(llm)
    const summary = await brain.respond(viewer())
    expect(summary.status).toBe('done')
    expect(calls.map((c) => [c.tool, c.args])).toEqual([
      ['tell_streamer', { text: 'hello' }],
      ['remember', { text: 'x' }],
    ])
    expect(calls[0]?.origin).toMatchObject({ kind: 'viewer', trust: 'untrusted', name: 'ann' })
  })

  it('the tool block is not spoken and not written into the record', async () => {
    const spoken: string[] = []
    const chat = new ChatLog()
    const { brain } = setup(scripted(['[neutral]Fine. ', call('tell_streamer', { text: 'x' })]), {
      chat,
      director: {
        beginTurn: () => ({
          enqueue: (i) => {
            spoken.push(i.text)
            return true
          },
          end: () => {},
        }),
        cancelTurn: () => {},
      },
    })
    await brain.respond(viewer())
    expect(spoken.join(' ')).toContain('Fine.')
    expect(spoken.join(' ')).not.toContain('tell_streamer')
    expect(chat.recent(5).at(-1)?.content).not.toContain('tell_streamer')
  })

  it(`takes at most ${MAX_TOOL_CALLS_PER_REPLY} blocks and says it dropped the rest`, async () => {
    const pieces = ['[neutral]Ok. ']
    for (let i = 0; i < 6; i++) pieces.push(call('tell_streamer', { text: `n${i}` }), '\n')
    const { brain, calls, ignored } = setup(scripted(pieces))
    await brain.respond(viewer())
    expect(calls).toHaveLength(MAX_TOOL_CALLS_PER_REPLY)
    expect(ignored).toEqual(['too_many', 'too_many', 'too_many'])
  })

  it('ignores a block that is not valid, one that is too big and one the stream cut short', async () => {
    const big = `{"tool":"a","args":{"t":"${'x'.repeat(MAX_TOOL_BLOCK_CHARS)}"}}`
    const { brain, calls, ignored } = setup(
      scripted([
        '[neutral]Ok. ',
        block('this is not json'),
        block(big),
        block('[{"tool":"a"}]'),
        `${FENCE}tool\n{"tool":"tell_streamer","args":{"text":"cut off"}}`, // no closing fence: the stream ended
      ])
    )
    await brain.respond(viewer())
    expect(calls).toEqual([])
    expect(ignored).toEqual(['bad_block', 'too_big', 'bad_block', 'unterminated'])
  })

  it('a block with another language word is only code', async () => {
    const { brain, calls, ignored } = setup(
      scripted([
        '[neutral]Look: ',
        `${FENCE}json\n{"tool":"tell_streamer","args":{"text":"x"}}\n${FENCE}`,
      ])
    )
    await brain.respond(viewer())
    expect(calls).toEqual([])
    expect(ignored).toEqual([])
  })

  it('asks for nothing when the reply was cancelled or failed: half a request is not a request', async () => {
    const failing = setup(
      scripted(['[neutral]Ok. ', call('tell_streamer', { text: 'x' }), new Error('boom')])
    )
    const s1 = await failing.brain.respond(viewer())
    expect(s1.status).toBe('failed')
    expect(failing.calls).toEqual([])

    const slow = scripted([
      '[neutral]Ok. ',
      call('tell_streamer', { text: 'x' }),
      ' more ',
      ' more ',
    ])
    const cancelled = setup(slow)
    const p = cancelled.brain.respond(viewer())
    await new Promise((r) => setTimeout(r, 1))
    cancelled.brain.cancelActive('test')
    const s2 = await p
    expect(s2.status).toBe('cancelled')
    expect(cancelled.calls).toEqual([])
  })

  it('is ignored altogether when the brain was given no tools', async () => {
    const llm = scripted(['[neutral]Ok. ', call('tell_streamer', { text: 'x' })])
    const brain = new Brain({ llm, director: director(), chat: new ChatLog(), persona: () => 'p' })
    const calls: unknown[] = []
    brain.on('tool.call', (c) => calls.push(c))
    await brain.respond(viewer())
    expect(calls).toEqual([])
  })
})

describe('who a reply is judged as', () => {
  const run = async (input: BrainInput) => {
    const { brain, calls } = setup(
      scripted(['[neutral]Ok. ', call('tell_streamer', { text: 'x' })])
    )
    await brain.respond(input)
    return calls[0]?.origin
  }

  it('the origin that was given, with the trust the input has', async () => {
    const mod = makeSource('moderator', { name: 'mia', uid: '77' })
    expect(await run(viewer({ source: 'moderator', trust: 'trusted', origin: mod }))).toEqual(mod)
  })

  it('an origin can never claim more than the input’s trust: it is lowered to it', async () => {
    const host = makeSource('host', { name: 'me' })
    const o = await run(viewer({ trust: 'untrusted', origin: host }))
    expect(o).toMatchObject({ kind: 'host', trust: 'untrusted', name: 'me' })
    const o2 = await run(
      viewer({ source: 'system', trust: 'trusted', origin: makeSource('system') })
    )
    expect(o2?.trust).toBe('trusted')
  })

  it('with no origin it is made from the source and the name, still capped by the trust', async () => {
    expect(await run(viewer())).toMatchObject({ kind: 'viewer', trust: 'untrusted', name: 'ann' })
    expect(await run(viewer({ source: 'system', trust: 'untrusted' }))).toMatchObject({
      kind: 'system',
      trust: 'untrusted',
    })
    expect(await run(viewer({ source: 'system', trust: 'privileged' }))).toMatchObject({
      kind: 'system',
      trust: 'privileged',
    })
  })
})

describe('what the model is told', () => {
  it('the tools come from the hook, asked with this input, and the carried notes ride along once', async () => {
    const llm = scripted(['[neutral]Ok.'])
    const asked: BrainInput[] = []
    let notes = ['tell_streamer: done']
    const { brain } = setup(llm, {
      tools: (input) => {
        asked.push(input)
        return input.trust === 'untrusted'
          ? [{ name: 'tell_streamer', description: 'note', usage: '{}', approval: false }]
          : [
              { name: 'tell_streamer', description: 'note', usage: '{}', approval: false },
              { name: 'enter_mode', description: 'go', usage: '{}', approval: true },
            ]
      },
      notes: () => {
        const n = notes
        notes = []
        return n
      },
    })
    await brain.respond(viewer())
    await brain.respond(viewer({ source: 'moderator', trust: 'trusted' }))
    expect(asked.map((a) => a.trust)).toEqual(['untrusted', 'trusted'])
    const [first, second] = llm.requests.map((r) => String(r.messages[0]?.content))
    expect(first).toContain('- tell_streamer:')
    expect(first).not.toContain('enter_mode')
    expect(first).toContain('tell_streamer: done')
    expect(second).toContain("- enter_mode (waits for the streamer's yes)")
    expect(second).not.toContain('tell_streamer: done')
  })
})
