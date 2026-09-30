import { z } from 'zod'

/**
 * Stage protocol version. Bumped only for breaking changes; additive changes
 * (new optional fields, new message types the peer may ignore) keep the number.
 */
export const PROTOCOL_VERSION = 1 as const

/** WebSocket subprotocol the stage offers and the orchestrator selects. */
export const STAGE_SUBPROTOCOL = 'animatus.stage.v1'

/** Visual emotions the stage understands. TTS-level styles (whisper, ...) are not stage emotions. */
export const EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const
export const Emotion = z.enum(EMOTIONS)
export type Emotion = z.infer<typeof Emotion>

/** Opaque identifier (utterance, turn, dance, song, request ...). */
export const Id = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9._:@-]+$/, 'id may only contain letters, digits and . _ : @ -')
export type Id = z.infer<typeof Id>

/**
 * A file the orchestrator serves to the stage. Always a same-origin absolute path under
 * /asset/, with no dot segments; the stage never fetches from any other origin.
 */
export const AssetUrl = z
  .string()
  .min(8)
  .max(2048)
  .refine((u) => /^\/asset\/[^?#]+(\?[^#]*)?$/.test(u), 'asset url must look like /asset/<path>')
  .refine(
    (u) => !/(^|\/)\.\.?(\/|$|\?)/.test(u.split('?')[0] ?? ''),
    'asset url must not contain dot segments'
  )
export type AssetUrl = z.infer<typeof AssetUrl>

/** Unsigned 32-bit integer (used for binary frame handles). */
export const U32 = z.number().int().min(0).max(0xffffffff)

/** Rectangle in percent of the viewport. */
export const Rect = z.object({
  left: z.number().min(-100).max(200),
  top: z.number().min(-100).max(200),
  width: z.number().min(0).max(300),
  height: z.number().min(0).max(300),
})
export type Rect = z.infer<typeof Rect>

export const Vec3 = z.tuple([z.number(), z.number(), z.number()])
export type Vec3 = z.infer<typeof Vec3>

/** Text shown on the stage. Rendered with textContent only, never as HTML. */
export const StageText = z.string().max(2000)
