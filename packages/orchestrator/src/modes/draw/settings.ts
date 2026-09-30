/**
 * The settings of the draw mode (`modes.draw.config`), checked strictly.
 *
 * Everything has a default except `routes`: which checkpoints and LoRAs to draw with is the operator's own (nothing in
 * this repository names a model). A route is a name from a fixed list (self, photo, furry, default, tried in that
 * order) with the models and LoRAs it may use, and the words in a request that select it.
 */
import path from 'node:path'
import { z } from 'zod'
import { PluginId, Rect } from '@animatus/protocol'

const Text = (max: number) => z.string().trim().min(1).max(max)
const Words = (max: number, count: number) => z.array(Text(max)).max(count).default([])
/** Sampler and scheduler names go into a request the image service checks; keep them to what Forge names use. */
const SamplerName = z.string().regex(/^[A-Za-z0-9+ ._-]{1,64}$/, 'letters, digits and + . _ - only')
const Size = z.tuple([z.number().int().min(512).max(2048), z.number().int().min(512).max(2048)])

export const ROUTE_NAMES = ['self', 'photo', 'furry', 'default'] as const
export type RouteName = (typeof ROUTE_NAMES)[number]

export const GenerationParams = z.strictObject({
  steps: z.number().int().min(1).max(100).default(30),
  cfg_scale: z.number().min(0).max(30).default(5),
  sampler_name: SamplerName.default('Euler a'),
  /** null sends none: Forge's own default. */
  scheduler: SamplerName.nullable().default('Automatic'),
  /** The size of a square picture; the other shapes are made from its area unless `sizes` names them. */
  width: z.number().int().min(512).max(2048).default(1024),
  height: z.number().int().min(512).max(2048).default(1024),
  sizes: z
    .strictObject({
      portrait: Size.optional(),
      landscape: Size.optional(),
      square: Size.optional(),
    })
    .default({}),
})
export type GenerationParams = z.infer<typeof GenerationParams>

export const CheckpointEntry = z.strictObject({
  /** As Forge knows it: the name, or a fragment that matches one checkpoint. */
  name: Text(300),
  /** Shown to the planner, so it can choose between several. */
  desc: z.string().trim().max(300).default(''),
  style: z.enum(['photo', 'realistic-art', '2.5d', 'anime', 'any']).default('any'),
  /** Which `guide_<name>.md` of the pack tells the model how to write prompts for it. */
  guide: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/)
    .default('sdxl'),
  /** Quality tags put in front (left out when the prompt already has quality words). */
  prefix: z.string().max(300).default(''),
  negative: z.string().max(1000).default(''),
  params: GenerationParams.prefault({}),
})
export type CheckpointEntry = z.infer<typeof CheckpointEntry>

export const LoraEntry = z.strictObject({
  /** As Forge knows it, and as the image service's allowlist spells it. */
  name: Text(200),
  weight: z.number().min(0.1).max(1.5).default(0.8),
  /** Words that switch the LoRA on; put in front of the prompt. */
  trigger: z.array(Text(100)).max(8).default([]),
  desc: z.string().trim().max(300).default(''),
})
export type LoraEntry = z.infer<typeof LoraEntry>

export const RouteEntry = z.strictObject({
  checkpoints: z.array(CheckpointEntry).min(1).max(10),
  loras: z.array(LoraEntry).max(50).default([]),
  /** A request that contains one of these words takes this route. */
  keywords: Words(40, 100),
  /** A request that is exactly one of these takes this route (a bare "you"). */
  exact: Words(40, 20),
  /** Use the first checkpoint and every LoRA as written; the planner chooses neither (the self-portrait route). */
  fixed: z.boolean().default(false),
  /** What the route draws, for the planner's notes (the self route: who the character is). */
  description: z.string().trim().max(300).default('an invented character'),
})
export type RouteEntry = z.infer<typeof RouteEntry>

const Frame = z.strictObject({
  /**
   * Where the words on the frame (the hint, "drawing ...", the requester) are shown. `frame` puts them in the frame
   * overlay's own text; the stage draws nothing there yet, so `notice` (the banner at the top) is the choice until it does.
   */
  text_overlay: z.enum(['frame', 'notice']).default('frame'),
  /** Where the frame is, in percent of the window; leave out to use the layout of the pack. */
  rect: Rect.nullable().default(null),
  max_name_chars: z.number().int().min(4).max(40).default(16),
  max_request_chars: z.number().int().min(10).max(120).default(30),
})

export const DrawSettings = z.strictObject({
  /** The service name of the image plugin. */
  service: PluginId.default('forge'),
  /** After a request (accepted or refused) the same viewer waits this long. */
  cooldown_sec: z.number().min(0).max(86_400).default(300),
  /** The room owner may ask again at once. */
  owner_skips_cooldown: z.boolean().default(true),
  /** Requests that may wait behind the picture being drawn; more are ignored. */
  queue_max: z.number().int().min(1).max(20).default(3),
  /** Longer requests are cut. */
  max_chars: z.number().int().min(5).max(500).default(60),
  /** A command word that does not start with "/" needs a space or colon after it, or one of these (画一只猫), so 画风不错 stays chat. */
  measure_words: z.string().max(60).default('一两个只条张幅位头匹棵朵把座艘辆群对副'),
  /** Layer 1, before any model is asked. Relative paths are relative to the project root. Keep them the same as the image service's. */
  blocklist_files: z.array(Text(500)).min(1).default(['plugins/forge/blocklist.default.txt']),
  /** `canned`: a line from prompts/refusals.md; `model`: the model says one in character without being told the request. */
  refusal: z.enum(['canned', 'model']).default('canned'),
  /** Show the model the picture. Turn off for a model that cannot see images. */
  send_image: z.boolean().default(true),
  /** Pictures kept in data/generated (the newest). */
  keep_pictures: z.number().int().min(1).max(1000).default(50),
  /** A picture stays in the frame this long, then the frame goes back to its hint. */
  show_sec: z.number().min(1).max(86_400).default(600),
  /** One planning call to the model. */
  plan_timeout_sec: z.number().min(5).max(300).default(30),
  /** One picture at the image service; keep it at least as long as the service's generate_timeout_sec. */
  generate_timeout_sec: z.number().min(10).max(3600).default(300),
  /** How long the character's comment waits for the voice to be free before it is said anyway. */
  reaction_wait_sec: z.number().min(0).max(600).default(90),
  /** How long what the image service has (checkpoints, LoRAs) is remembered. */
  catalog_ttl_sec: z.number().min(0).max(3600).default(60),
  /** LoRAs the planner may attach to one picture. */
  max_loras: z.number().int().min(0).max(4).default(2),
  frame: Frame.prefault({}),
  /** Vocabulary and preferences of the stream, told to the planner. */
  planner_notes: z.string().max(2000).default(''),
  /** A tag that means something else in the models' vocabulary is dropped unless the request contains one of its words. */
  ambiguous_tags: z.record(Text(80), z.array(Text(80)).min(1).max(20)).default({}),
  routes: z.strictObject({
    default: RouteEntry,
    self: RouteEntry.optional(),
    photo: RouteEntry.optional(),
    furry: RouteEntry.optional(),
  }),
})
export type DrawSettings = z.infer<typeof DrawSettings> & {
  /** `blocklist_files` made absolute. */
  blocklist_paths: string[]
}

/** Reads `modes.draw.config`. A problem is an Error that lists every issue with its key, ready to show at start-up. */
export function parseDrawSettings(raw: unknown, root: string): DrawSettings {
  const parsed = DrawSettings.safeParse(raw ?? {})
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${['modes.draw.config', ...i.path.map(String)].join('.')}: ${i.message}`
    )
    throw new Error(`invalid configuration of the draw mode:\n${lines.join('\n')}`)
  }
  return {
    ...parsed.data,
    blocklist_paths: parsed.data.blocklist_files.map((f) => path.resolve(root, f)),
  }
}
