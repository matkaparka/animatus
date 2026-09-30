/**
 * The inbox: the input side of the live-chat pipeline.
 *
 *   viewer events -> Router (filter, merge, queue, pick) -> Batch -> brain
 *                       ^                                     |
 *                       +--------- Pacer (when may we send?) -+
 *
 * `Router` turns platform events into prompt lines and picks the next batch; `Pacer` decides when the brain
 * may be handed one; `Blocklist` is the sensitive-word list; `FORMATS` holds the prompt-visible strings.
 */
export * from './blocklist.ts'
export * from './formats.ts'
export * from './pacer.ts'
export * from './router.ts'
export * from './text.ts'
export * from './types.ts'
