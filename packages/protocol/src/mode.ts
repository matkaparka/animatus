/**
 * Mode packs.
 *
 * Every feature that takes over the stream for a while (dance, sing, sleep, draw, commentary, game,
 * reaction, ...) is a mode pack: a manifest plus Markdown prompts. The mode manager is the only thing
 * that enters and leaves modes; exclusions, priorities and resource needs live here, not in code.
 *
 *   modes/<id>/mode.yaml
 *   modes/<id>/prompts/*.md
 */
import { z } from 'zod'
import { Id } from './common.ts'
import { PluginId } from './plugin.ts'
import { Background, LayoutOverride, LookOverride } from './stage.ts'

export const ModeId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)
export type ModeId = z.infer<typeof ModeId>

/** The name of a stage preset in the configuration. */
export const PresetName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)

export const ModeManifest = z.object({
  manifest_version: z.literal(1).default(1),
  id: ModeId,
  title: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  requires: z
    .object({
      /** Service names (see PluginManifest.service) that must be ready. */
      services: z.array(PluginId).default([]),
      /** Extra VRAM the mode needs on top of the resident set (MiB). null = unmeasured. */
      vram_mb_est: z.number().min(0).nullable().default(null),
      ram_mb_est: z.number().min(0).nullable().default(null),
    })
    .default({ services: [], vram_mb_est: null, ram_mb_est: null }),
  /** Modes that cannot be active together with this one. Symmetric: either side declaring it is enough. */
  exclusive_with: z.array(ModeId).default([]),
  /** Higher wins when two modes want the stage. */
  priority: z.number().int().min(0).max(100).default(50),
  /** Entering this mode interrupts everything else (sleep). */
  preempts: z.boolean().default(false),
  /** Markdown prompt file, relative to the mode directory; loaded on enter, dropped on exit. */
  prompt: z.string().optional(),
  /** Tool names made available while the mode is active. */
  tools: z.array(z.string().min(1)).default([]),
  triggers: z
    .object({
      /** Shown as a shortcut on the console's mode page (works while that window has focus). */
      hotkey: z.string().optional(),
      danmaku_prefix: z.array(z.string().min(1)).default([]),
      gift: z.array(z.string().min(1)).default([]),
      events: z.array(z.string().min(1)).default([]),
    })
    .default({ danmaku_prefix: [], gift: [], events: [] }),
  /**
   * What the stage should look like while the mode is active. Each field is either the name of a preset in the
   * operator's configuration (`stage.presets`) or the values themselves. Leaving the mode puts the stage back;
   * with several modes active the one with the higher priority wins where they disagree.
   */
  stage: z
    .object({
      layout: z.union([PresetName, LayoutOverride]).optional(),
      background: z.union([PresetName, Background]).optional(),
      look: z.union([PresetName, LookOverride]).optional(),
    })
    .default({}),
})
export type ModeManifest = z.infer<typeof ModeManifest>

/** Mode manager states. Any step that times out goes back to IDLE with an alarm. */
export const ModeState = z.enum(['IDLE', 'STARTING', 'ACTIVE', 'STOPPING'])
export type ModeState = z.infer<typeof ModeState>

/** A measured VRAM figure, written by the probe and read by the admission check. */
export const VramMeasurement = z.object({
  /** Service name or mode id. */
  key: Id,
  /** Hash of the settings that were active when it was measured (Forge size, checkpoint, precision ...). */
  config_hash: z.string().max(64),
  /** Peak dedicated GPU memory above the baseline, MiB. */
  peak_mb: z.number().min(0),
  /** Settled figure after warm-up, MiB. */
  steady_mb: z.number().min(0),
  measured_at: z.string(),
  note: z.string().optional(),
})
export type VramMeasurement = z.infer<typeof VramMeasurement>
