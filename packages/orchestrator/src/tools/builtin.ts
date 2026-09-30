/**
 * The tools that ship with the program. Each is small on purpose: what a tool may do is what an injected
 * instruction could do with it, so a tool that changes anything is `approval` with a floor (the operator can switch it
 * off but never make it free), and the one free tool only leaves a private note.
 */
import { z } from 'zod'
import { ModeId } from '@animatus/protocol'
import type { EventSource } from '@animatus/protocol'
import type { ToolRegistry } from './registry.ts'

export interface BuiltinDeps {
  /** Puts a private note where only the streamer sees it (the console). Never spoken, never shown on the stage. */
  noteToStreamer(text: string, origin: EventSource): void
  /** Writes one line into the character's own notes in memory; absent when memory is off. */
  remember?: (text: string) => Promise<'written' | 'already there'>
  modes: {
    has(id: string): boolean
    /** The modes that are switched on: what `enter_mode` can name. */
    ids(): string[]
    /** Enter a mode the way the console does. Resolves with what happened in a few words, rejects with the reason. */
    enter(id: string): Promise<string>
    exit(id: string): Promise<string>
  }
}

const text = (max: number) => z.string().trim().min(1).max(max)

export function registerBuiltinTools(registry: ToolRegistry, deps: BuiltinDeps): void {
  registry.register({
    name: 'tell_streamer',
    description:
      'Pass a message to the streamer privately, in the console (nothing is spoken or shown on stream). Use it when a viewer asks you to tell the streamer something, or when you notice something the streamer should know.',
    usage: '{"text": "the note, up to 200 characters"}',
    tier: 'free',
    schema: z.object({ text: text(200) }),
    summarize: (a) => `Note for the streamer: ${a.text}`,
    run: async (a, ctx) => {
      deps.noteToStreamer(a.text, ctx.origin)
      return 'noted'
    },
  })

  if (deps.remember) {
    const remember = deps.remember
    registry.register({
      name: 'remember',
      description:
        'Write down one fact you want to keep for later streams. Use it when staff ask you to remember something or say something worth keeping (a running joke, a decision). Only facts someone stated, never guesses.',
      usage: '{"text": "one short fact"}',
      tier: 'approval',
      floor: 'approval',
      schema: z.object({ text: text(300) }),
      summarize: (a) => `Remember: ${a.text}`,
      run: async (a) => remember(a.text),
    })
  }

  const mode = ModeId.refine((id) => deps.modes.has(id), 'no such mode')
  const modeList = () => deps.modes.ids().join(', ')
  registry.register({
    name: 'enter_mode',
    get description() {
      return `Start a mode when staff ask for one. Modes you can start: ${modeList()}.`
    },
    usage: '{"mode": "the mode id"}',
    tier: 'approval',
    floor: 'approval',
    available: () => deps.modes.ids().length > 0,
    schema: z.object({ mode }),
    summarize: (a) => `Start the mode "${a.mode}"`,
    run: async (a) => deps.modes.enter(a.mode),
  })
  registry.register({
    name: 'exit_mode',
    get description() {
      return `End a mode that is running when staff ask you to. Modes: ${modeList()}.`
    },
    usage: '{"mode": "the mode id"}',
    tier: 'approval',
    floor: 'approval',
    available: () => deps.modes.ids().length > 0,
    schema: z.object({ mode }),
    summarize: (a) => `End the mode "${a.mode}"`,
    run: async (a) => deps.modes.exit(a.mode),
  })
}
