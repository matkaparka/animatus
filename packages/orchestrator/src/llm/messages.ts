/**
 * Message clean-up shared by the providers: validate parts, drop empty ones and (optionally) merge
 * neighbours with the same role. Several servers reject empty text and some chat templates reject two
 * user turns in a row, so a caller that keeps a plain history should not have to care.
 */
import { LlmError } from './types.ts'
import type { ChatMessage, ChatPart, ChatRole } from './types.ts'

export interface NormalizedMessage {
  role: ChatRole
  parts: ChatPart[]
}

export interface NormalizeOptions {
  providerId: string
  /** Merge neighbours with the same role into one message. */
  mergeAdjacent: boolean
}

const ROLES: readonly string[] = ['system', 'user', 'assistant']
const IMAGE_MIME = /^image\/[A-Za-z0-9.+-]+$/

function fail(providerId: string, message: string): never {
  throw new LlmError('bad_request', message, { providerId })
}

function cleanBase64(value: string): string {
  const withoutPrefix = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value
  return withoutPrefix.replace(/\s+/g, '')
}

/** Validated copies of the parts of one message; empty text is dropped, images are cleaned. */
function cleanParts(content: unknown, providerId: string): ChatPart[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content))
    return fail(providerId, 'message content must be a string or an array of parts')
  const out: ChatPart[] = []
  for (const part of content as unknown[]) {
    const p = part as Partial<ChatPart> | null
    if (p?.type === 'text' && typeof p.text === 'string') {
      if (p.text !== '') out.push({ type: 'text', text: p.text })
    } else if (p?.type === 'image' && typeof p.mime === 'string' && typeof p.base64 === 'string') {
      const base64 = cleanBase64(p.base64)
      if (!IMAGE_MIME.test(p.mime)) return fail(providerId, 'image part needs an image/* mime type')
      if (base64 === '') return fail(providerId, 'image part has no data')
      out.push({ type: 'image', mime: p.mime, base64 })
    } else {
      return fail(providerId, 'unsupported message part')
    }
  }
  return out
}

export function normalizeMessages(
  messages: readonly ChatMessage[],
  opts: NormalizeOptions
): NormalizedMessage[] {
  if (!Array.isArray(messages)) return fail(opts.providerId, 'messages must be an array')
  const out: NormalizedMessage[] = []
  for (const message of messages) {
    if (!message || !ROLES.includes(message.role))
      return fail(opts.providerId, 'unknown message role')
    const parts = cleanParts(message.content, opts.providerId)
    if (parts.length === 0) continue
    const last = out[out.length - 1]
    if (opts.mergeAdjacent && last && last.role === message.role) last.parts.push(...parts)
    else out.push({ role: message.role, parts })
  }
  return out
}

/** The text parts of a message joined with newlines. */
export function joinText(parts: readonly ChatPart[]): string {
  return parts
    .filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

export function hasImage(parts: readonly ChatPart[]): boolean {
  return parts.some((p) => p.type === 'image')
}
