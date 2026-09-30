/**
 * The tool the model gets while the game mode is on: one short directive to the game agent.
 *
 * It is `free` on purpose: the point of the mode on many streams is that the audience suggests something and the character
 * decides. What it can do is bounded (a line of text to an agent that has its own tools and limits, inside one game), and
 * the operator can make it `approval` (only staff requests, after the streamer's yes) or `disabled` by name in `tools.tiers`.
 * There is no floor, so the configuration always has the last word.
 */
import { WORKER_MAX_COMMAND_CHARS } from '@animatus/protocol'
import { z } from 'zod'
import type { ToolSpec } from '../../tools/registry.ts'

export const COMMAND_TOOL = 'game_command'

export interface CommandToolDeps {
  /** False while there is nothing to steer (the game agent is not in a game): the tool is then left out of the prompt. */
  available(): boolean
  /** Sends the directive; resolves with a few words about what happened, rejects with the agent's own words. */
  send(text: string): Promise<string>
}

export function commandTool(deps: CommandToolDeps): ToolSpec<{ text: string }> {
  return {
    name: COMMAND_TOOL,
    description:
      'Steer the game agent that is playing the game for you with one short directive: a goal, a plan or a preference. Use it when a viewer suggests something you agree with, or when you want to change the plan. The agent works out how to do it, so say what you want, not which keys to press.',
    usage: `{"text": "one short, concrete directive, up to ${WORKER_MAX_COMMAND_CHARS} characters, for example: gather wood, then build a shelter"}`,
    tier: 'free',
    available: deps.available,
    schema: z.object({ text: z.string().trim().min(1).max(WORKER_MAX_COMMAND_CHARS) }),
    summarize: (a) => `Tell the game agent: ${a.text}`,
    run: (a) => deps.send(a.text),
  }
}
