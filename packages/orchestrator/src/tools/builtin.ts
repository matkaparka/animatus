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
      'Leave a private note for the streamer in the console (it is never spoken or shown on stream), for example about a viewer who seems to need help or something odd in chat.',
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
        'Write down one fact you want to keep for later streams (a running joke the streamer just made up, a decision they took). Only facts someone said, never guesses.',
      usage: '{"text": "one short fact"}',
      tier: 'approval',
      floor: 'approval',
      schema: z.object({ text: text(300) }),
      summarize: (a) => `Remember: ${a.text}`,
      run: async (a) => remember(a.text),
    })
  }

  const mode = ModeId.refine((id) => deps.modes.has(id), 'no such mode')
  registry.register({
    name: 'enter_mode',
    description:
      'Start a mode (singing, drawing, sleeping, ...). Use it when the streamer or a moderator asks for one.',
    usage: '{"mode": "the mode id"}',
    tier: 'approval',
    floor: 'approval',
    schema: z.object({ mode }),
    summarize: (a) => `Start the mode "${a.mode}"`,
    run: async (a) => deps.modes.enter(a.mode),
  })
  registry.register({
    name: 'exit_mode',
    description: 'End the mode that is running.',
    usage: '{"mode": "the mode id"}',
    tier: 'approval',
    floor: 'approval',
    schema: z.object({ mode }),
    summarize: (a) => `End the mode "${a.mode}"`,
    run: async (a) => deps.modes.exit(a.mode),
  })
}
