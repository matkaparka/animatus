import { describe, expect, it } from 'vitest'
import type { ClipRef } from '@animatus/protocol'
import { Brain } from '../../src/brain/brain.ts'
import type {
  BrainInput,
  DirectorLike,
  LlmLike,
  TurnSink,
  TurnSummary,
} from '../../src/brain/brain.ts'
import { ChatLog } from '../../src/brain/chatlog.ts'
import type { SpeechItem } from '../../src/speech/director.ts'
import type { LlmDelta, LlmRequest } from '../../src/llm/types.ts'

// ─────────────────────────────── fakes ───────────────────────────────

/** Streams the given pieces with a macrotask between them; honours the abort signal like a real provider. */
function scripted(
  pieces: (string | Error | { thinking: string } | { usage: number })[],
  opts: { gapMs?: number } = {}
): LlmLike & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = []
  return {
    requests,
    stream(req: LlmRequest): AsyncIterable<LlmDelta> {
      requests.push(req)
      return (async function* () {
        for (const p of pieces) {
          if (req.signal?.aborted) return
          await new Promise((r) => setTimeout(r, opts.gapMs ?? 0))
          if (req.signal?.aborted) return
          if (p instanceof Error) throw p
          if (typeof p === 'string') yield { type: 'text', text: p }
          else if ('thinking' in p) yield { type: 'thinking', text: p.thinking }
          else yield { type: 'usage', outputTokens: p.usage }
        }
      })()
    },
  }
}

/** Never produces anything until aborted. */
function stalled(): LlmLike {
  return {
    stream(req: LlmRequest): AsyncIterable<LlmDelta> {
      return (async function* () {
        await new Promise<void>((r) =>
          req.signal?.addEventListener('abort', () => r(), { once: true })
        )
        if (false as boolean) yield { type: 'text', text: '' }
      })()
    },
  }
}

interface Spoken {
  turn: string
  items: SpeechItem[]
  ended: boolean
}

function fakeDirector(
  opts: { reject?: (item: SpeechItem) => boolean } = {}
): DirectorLike & { turns: Spoken[]; cancelled: string[] } {
  const turns: Spoken[] = []
  const cancelled: string[] = []
  return {
    turns,
    cancelled,
    beginTurn(id: string): TurnSink {
      const t: Spoken = { turn: id, items: [], ended: false }
      turns.push(t)
      return {
        enqueue(item) {
          if (opts.reject?.(item) || cancelled.includes(id)) return false
          t.items.push(item)
          return true
        },
        end() {
          t.ended = true
        },
      }
    },
    cancelTurn(id) {
      cancelled.push(id)
    },
  }
}

const NOD: ClipRef = { id: 'poses:nod', url: '/asset/motions/poses/nod.vrma' }
const viewer = (text: string, extra: Partial<BrainInput> = {}): BrainInput => ({
  text,
  source: 'viewer',
  trust: 'untrusted',
  name: 'ann',
  ...extra,
})

function setup(llm: LlmLike, extra: Partial<ConstructorParameters<typeof Brain>[0]> = {}) {
  const director = fakeDirector()
  const chat = new ChatLog()
  const brain = new Brain({
    llm,
    director,
    chat,
    persona: () => 'You are Nova.',
    motionTags: () => ['nod', 'wave'],
    resolveMotion: (tag) => (tag === 'nod' ? NOD : null),
    ...extra,
  })
  const events: string[] = []
  for (const e of [
    'turn.start',
    'sentence',
    'thinking',
    'dance.request',
    'motion.unknown',
    'reply',
    'turn.end',
  ] as const) {
    brain.on(e, (info: unknown) =>
      events.push(e === 'turn.end' ? `${e}:${(info as TurnSummary).status}` : e)
    )
  }
  return { brain, director, chat, events }
}

// ─────────────────────────────── tests ───────────────────────────────

describe('a normal reply', () => {
  it('cuts the stream into sentences with their emotion and motion, and records both sides', async () => {
    const llm = scripted([
      '[happy][motion:nod]Hello there ',
      'friend. [sad]Bye',
      ' now.',
      { usage: 12 },
    ])
    const { brain, director, chat, events } = setup(llm)
    const summary = await brain.respond(viewer('【弹幕】ann: hi'))

    expect(summary.status).toBe('done')
    expect(summary.sentences).toBe(2)
    expect(summary.firstTokenMs).not.toBeNull()
    expect(summary.firstSentenceMs).not.toBeNull()
    const [turn] = director.turns
    expect(turn?.ended).toBe(true)
    expect(turn?.items.map((i) => [i.text, i.emotion, i.motion?.id ?? null, i.style])).toEqual([
      ['Hello there friend.', 'happy', 'poses:nod', 'happy'],
      // a motion tag stays in force until the next one, as in the legacy segmenter (a new emotion tag does not end it)
      ['Bye now.', 'sad', 'poses:nod', 'sad'],
    ])
    const log = chat.recent(10)
    expect(log.map((e) => e.role)).toEqual(['user', 'assistant'])
    expect(log[0]).toMatchObject({ content: '【弹幕】ann: hi', source: 'viewer', name: 'ann' })
    expect(log[1]?.content).toContain('Hello there friend.')
    expect(log[1]?.content).toContain('[sad]')
    expect(events).toEqual(['turn.start', 'sentence', 'sentence', 'reply', 'turn.end:done'])
  })

  it('an untagged sentence is neutral', async () => {
    const { brain, director } = setup(scripted(['Just words here.']))
    await brain.respond(viewer('x'))
    expect(director.turns[0]?.items[0]).toMatchObject({ emotion: 'neutral', motion: null })
  })

  it('sends the persona, the tag list, mode prompts, extras and the history to the model', async () => {
    const llm = scripted(['[neutral]ok.'])
    const { brain, chat } = setup(llm, {
      modePrompts: () => [{ id: 'sleep', text: 'Speak softly.' }],
    })
    chat.append({ role: 'user', content: 'earlier question', ts: 1 })
    chat.append({ role: 'assistant', content: '[happy]earlier answer', ts: 2 })
    await brain.respond(viewer('new question', { extras: ['A viewer sent a gift.'] }))

    const req = llm.requests[0] as LlmRequest
    const [system, ...rest] = req.messages
    expect(system?.role).toBe('system')
    const text = system?.content as string
    expect(text).toContain('You are Nova.')
    expect(text).toContain('nod, wave')
    expect(text).toContain('Speak softly.')
    expect(text).toContain('A viewer sent a gift.')
    expect(rest.map((m) => [m.role, m.content])).toEqual([
      ['user', 'earlier question'],
      ['assistant', '[happy]earlier answer'],
      ['user', 'new question'],
    ])
    expect(req.tag).toBe('chat')
    expect(req.signal).toBeInstanceOf(AbortSignal)
  })

  it('pictures go with the message just written, as parts of it, and the record keeps only its words', async () => {
    const llm = scripted(['[neutral]ok.'])
    const { brain, chat } = setup(llm)
    chat.append({ role: 'user', content: 'earlier', ts: 1 })
    chat.append({ role: 'assistant', content: 'answer', ts: 2 })
    await brain.respond(
      viewer('what is this', {
        images: [
          { mime: 'image/jpeg', base64: 'AAAA' },
          { mime: 'image/png', base64: 'BBBB' },
        ],
      })
    )
    const messages = (llm.requests[0] as LlmRequest).messages
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', mime: 'image/jpeg', base64: 'AAAA' },
        { type: 'image', mime: 'image/png', base64: 'BBBB' },
      ],
    })
    expect(messages.slice(1, -1).map((m) => m.content)).toEqual(['earlier', 'answer']) // the earlier ones stay text
    expect(chat.recent(10).map((e) => e.content)).toEqual([
      'earlier',
      'answer',
      'what is this',
      '[neutral]ok.',
    ])
    expect(JSON.stringify(chat.recent(10))).not.toContain('AAAA')

    // and a reply without pictures is plain again
    await brain.respond(viewer('next'))
    expect(
      (llm.requests[1] as LlmRequest).messages.every((m) => typeof m.content === 'string')
    ).toBe(true)
  })

  it('passes sampling limits only when they were configured', async () => {
    const a = scripted(['ok.'])
    await setup(a).brain.respond(viewer('x'))
    expect(a.requests[0]).not.toHaveProperty('temperature')
    const b = scripted(['ok.'])
    await setup(b, { temperature: 0.7, maxOutputTokens: 300, timeoutMs: 9000 }).brain.respond(
      viewer('x')
    )
    expect(b.requests[0]).toMatchObject({ temperature: 0.7, maxOutputTokens: 300, timeoutMs: 9000 })
  })

  it('limits the history to the configured number of earlier messages plus the new one', async () => {
    const llm = scripted(['ok.'])
    const { brain, chat } = setup(llm, { historyMessages: 2 })
    for (let i = 0; i < 6; i++)
      chat.append({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, ts: i })
    await brain.respond(viewer('now'))
    const contents = (llm.requests[0] as LlmRequest).messages.slice(1).map((m) => m.content)
    expect(contents).toEqual(['m4', 'm5', 'now'])
  })

  it('a persona with the history placeholder carries the earlier exchanges itself and the request does not repeat them', async () => {
    const llm = scripted(['ok.'])
    const { brain, chat } = setup(llm, {
      persona: () => 'You are Nova.\n[conversation_history]\nEnd.',
    })
    chat.append({ role: 'user', content: 'before', ts: 1 })
    chat.append({ role: 'assistant', content: 'after', ts: 2 })
    await brain.respond(viewer('current'))
    const messages = (llm.requests[0] as LlmRequest).messages
    expect(messages[0]?.content).toContain('user: before\nassistant: after')
    expect(messages[0]?.content).not.toContain('current')
    expect(messages.slice(1).map((m) => m.content)).toEqual(['current'])
  })

  it('thinking is reported and never spoken', async () => {
    const { brain, director, events } = setup(
      scripted([{ thinking: 'hmm, let me think' }, 'Answer.'])
    )
    await brain.respond(viewer('x'))
    expect(events).toContain('thinking')
    expect(director.turns[0]?.items.map((i) => i.text)).toEqual(['Answer.'])
  })
})

describe('motion tags', () => {
  it('a tag that names no clip is dropped and reported; the sentence is still spoken', async () => {
    const { brain, director, events } = setup(scripted(['[happy][motion:cartwheel]Watch this.']))
    await brain.respond(viewer('x'))
    expect(events).toContain('motion.unknown')
    expect(director.turns[0]?.items[0]).toMatchObject({ text: 'Watch this.', motion: null })
  })

  it('a dance tag is a request for the mode manager, not a clip', async () => {
    const dances: (string | undefined)[] = []
    const { brain, director } = setup(
      scripted(['[happy][motion:dance:aipao]Here we go.', ' [happy][motion:dance]Again.'])
    )
    brain.on('dance.request', (i) => dances.push(i.name))
    await brain.respond(viewer('dance please'))
    expect(dances).toEqual(['aipao', undefined])
    expect(director.turns[0]?.items.every((i) => i.motion === null)).toBe(true)
  })

  it('without a motion library no tag resolves', async () => {
    const { brain, director } = setup(scripted(['[motion:nod]Hi there.']), {
      resolveMotion: undefined,
    })
    await brain.respond(viewer('x'))
    expect(director.turns[0]?.items[0]?.motion).toBeNull()
  })
})

describe('failures', () => {
  it('a model that fails before any text leaves the reply silent, keeps the user line and reports the error', async () => {
    const { brain, director, chat, events } = setup(scripted([new Error('all providers failed')]))
    const errors: Error[] = []
    brain.on('error', (e) => errors.push(e))
    const s = await brain.respond(viewer('hello'))
    expect(s.status).toBe('failed')
    expect(s.error?.message).toContain('all providers failed')
    expect(s.sentences).toBe(0)
    expect(director.turns[0]?.items).toEqual([])
    expect(director.turns[0]?.ended).toBe(true)
    expect(chat.recent(5).map((e) => e.role)).toEqual(['user'])
    expect(errors).toHaveLength(1)
    expect(events).toEqual(['turn.start', 'turn.end:failed'])
  })

  it('what was already said before a mid-stream failure is still delivered', async () => {
    const { brain, director, chat } = setup(
      scripted(['[happy]First sentence. [sad]Second sen', new Error('connection reset')])
    )
    const s = await brain.respond(viewer('x'))
    expect(s.status).toBe('failed')
    expect(director.turns[0]?.items.map((i) => i.text)).toEqual(['First sentence.', 'Second sen'])
    expect(chat.recent(5).at(-1)?.role).toBe('assistant')
  })

  it('a failing prompt source (unreadable persona) is a failed turn, not a crash', async () => {
    const { brain } = setup(scripted(['ok.']), {
      persona: () => {
        throw new Error('persona.md is missing')
      },
    })
    const s = await brain.respond(viewer('x'))
    expect(s.status).toBe('failed')
    expect(s.error?.message).toContain('persona.md')
    // the loop still works afterwards
    const ok = setup(scripted(['ok.']))
    expect((await ok.brain.respond(viewer('x'))).status).toBe('done')
  })

  it('a listener that throws does not take the reply down', async () => {
    const { brain, director } = setup(scripted(['[happy]One. Two.']))
    brain.on('sentence', () => {
      throw new Error('bad listener')
    })
    const s = await brain.respond(viewer('x'))
    expect(s.status).toBe('done')
    expect(director.turns[0]?.items).toHaveLength(2)
  })

  it('a sentence the director refuses is not counted', async () => {
    const director = fakeDirector({ reject: (i) => i.text.includes('Skip') })
    const brain = new Brain({
      llm: scripted(['[happy]Keep this. Skip this.']),
      director,
      chat: new ChatLog(),
      persona: () => 'p',
    })
    const s = await brain.respond(viewer('x'))
    expect(s.sentences).toBe(1)
  })
})

describe('cancelling and ordering', () => {
  it('cancelActive stops the model, silences the reply and records what was shown', async () => {
    const { brain, director, chat, events } = setup(
      scripted(['[happy]First one. ', 'Second one. ', 'Third one.'], { gapMs: 15 })
    )
    const p = brain.respond(viewer('x'))
    await new Promise((r) => setTimeout(r, 25))
    expect(brain.processing).toBe(true)
    brain.cancelActive('test')
    const s = await p
    expect(s.status).toBe('cancelled')
    expect(director.cancelled).toEqual(['turn-1'])
    expect(director.turns[0]?.ended).toBe(true)
    expect(director.turns[0]?.items.length ?? 0).toBeLessThan(3)
    expect(brain.processing).toBe(false)
    expect(events.at(-1)).toBe('turn.end:cancelled')
    expect(chat.recent(5)[0]?.role).toBe('user')
  })

  it('cancelling with nothing running is a no-op', () => {
    const { brain, director } = setup(scripted(['x']))
    brain.cancelActive()
    expect(director.cancelled).toEqual([])
  })

  it('replies are generated one at a time, in submission order, and queued counts the waiting ones', async () => {
    const llm = scripted(['One reply here.'], { gapMs: 20 })
    const { brain, director } = setup(llm)
    const a = brain.respond(viewer('first'))
    const b = brain.respond(viewer('second'))
    const c = brain.respond(viewer('third'))
    expect(brain.queued).toBe(3)
    await new Promise((r) => setTimeout(r, 5))
    expect(brain.queued).toBe(2)
    expect(brain.processing).toBe(true)
    await Promise.all([a, b, c])
    expect(brain.queued).toBe(0)
    expect(director.turns.map((t) => t.turn)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    const users = llm.requests.map((r) => r.messages.at(-1)?.content)
    expect(users).toEqual(['first', 'second', 'third'])
  })

  it('a preempting message cancels the reply in progress and goes next', async () => {
    const llm = scripted(['Long answer part one. ', 'Part two. ', 'Part three.'], { gapMs: 20 })
    const { brain, director } = setup(llm)
    const a = brain.respond(viewer('slow question'))
    await new Promise((r) => setTimeout(r, 25))
    const b = brain.respond({
      text: 'host says stop',
      source: 'host',
      trust: 'privileged',
      preempt: true,
    })
    const [sa, sb] = await Promise.all([a, b])
    expect(sa.status).toBe('cancelled')
    expect(sb.status).toBe('done')
    expect(director.cancelled).toContain('turn-1')
    expect(director.cancelled).not.toContain('turn-2')
  })

  it('a stalled model is released by cancelActive', async () => {
    const { brain } = setup(stalled())
    const p = brain.respond(viewer('x'))
    await new Promise((r) => setTimeout(r, 10))
    brain.cancelActive()
    expect((await p).status).toBe('cancelled')
  })
})
