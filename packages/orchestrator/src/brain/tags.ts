// Derived from AITuberKit (https://github.com/tegnike/aituber-kit), used under its Non-Commercial Use License; see licenses/AITuberKit-LICENSE.txt.
// Changed: comments translated to English; splitSentence comes from the legacy messages module; added parseEmotion and parseMotionTag; extractMotionTag guards its capture group for noUncheckedIndexedAccess.

import { EMOTIONS } from '@animatus/protocol'
import type { Emotion } from '@animatus/protocol'
import type { MotionRequest } from './types.ts'

/*
 * Emotion tags, motion tags and sentence extraction (pure functions).
 *
 * The regular expressions are byte-identical to the legacy ones and the legacy tests pin them.
 * If one ever has to change, that is a deliberate behaviour change: say so in the commit message.
 */

/**
 * Extracts a leading emotion tag `[...]` from the text.
 * @param text input text
 * @returns the tag and the remaining text
 */
export const extractEmotion = (text: string): { emotionTag: string; remainingText: string } => {
  // Ignore leading whitespace when looking for the emotion tag.
  const emotionMatch = text.match(/^\s*\[(.*?)\]/)
  if (emotionMatch?.[0]) {
    // A motion tag is never treated as an emotion tag.
    if (/^\s*\[motion:/i.test(text)) {
      return { emotionTag: '', remainingText: text }
    }
    return {
      emotionTag: emotionMatch[0].trim(), // drop whitespace around the tag itself
      // Cut the tag together with the leading whitespace, then drop the whitespace after it.
      remainingText: text.slice(text.indexOf(emotionMatch[0]) + emotionMatch[0].length).trimStart(),
    }
  }
  return { emotionTag: '', remainingText: text }
}

/**
 * Extracts a leading motion tag `[motion:xxx]` from the text.
 * @param text input text
 * @returns the tag (without the `motion:` part) and the remaining text
 */
export const extractMotionTag = (text: string): { motionTag: string; remainingText: string } => {
  const motionMatch = text.match(/^\s*\[motion:([^\]\s]+)\]/i)
  if (motionMatch?.[0]) {
    return {
      motionTag: motionMatch[1] ?? '',
      remainingText: text.slice(text.indexOf(motionMatch[0]) + motionMatch[0].length).trimStart(),
    }
  }
  return { motionTag: '', remainingText: text }
}

/**
 * Extracts one sentence that ends at a natural break from the text.
 * @param text input text
 * @returns the sentence and the remaining text
 */
export const extractSentence = (
  text: string,
  { commaMinChars = 10 }: { commaMinChars?: number } = {}
): { sentence: string; remainingText: string } => {
  const normalizedCommaMinChars = Math.max(2, Math.floor(commaMinChars))
  const sentencePattern = new RegExp(
    `^(.{1,${normalizedCommaMinChars - 1}}?(?:[。．!?！？\\n]|(?<!\\d)\\.|\\.(?=[^\\d])|(?=\\[))|.{${normalizedCommaMinChars},}?(?:[、。．!?！？\\n]|(?<!\\d)[,.]|[,.](?=[^\\d])|(?=\\[)))`
  )
  const sentenceMatch = text.match(sentencePattern)
  if (sentenceMatch?.[0]) {
    return {
      sentence: sentenceMatch[0],
      remainingText: text.slice(sentenceMatch[0].length).trimStart(),
    }
  }
  return { sentence: '', remainingText: text }
}

/**
 * Whether the text is worth speaking (rejects strings made only of symbols and whitespace).
 * The check the legacy speech handler applied before handing a sentence to the TTS.
 */
export const isSpeakableText = (text: string): boolean => {
  if (text === '') return false
  return (
    text.replace(
      /^[\s\u3000\t\n\r\[\(\{「［（【『〈《〔｛«‹〘〚〛〙›»〕》〉』】）］」\}\)\]'"''""・、。,.!?！？:：;；\-_=+~～*＊@＠#＃$＄%％^＾&＆|｜\\＼/／`｀]+$/gu,
      ''
    ) !== ''
  )
}

/**
 * Splits text after each sentence-ending mark (。．！？ or a newline), keeping the mark.
 * Used for completed texts; the streaming path uses the segmenter instead.
 */
export const splitSentence = (text: string): string[] => {
  const splitMessages = text.split(/(?<=[。．！？\n])/g)
  return splitMessages.filter((msg) => msg !== '')
}

const EMOTION_NAMES: ReadonlySet<string> = new Set(EMOTIONS)

/**
 * Maps an emotion tag as found in model output (`[Happy]`) to a stage emotion.
 * Matching is case-insensitive and tolerates spaces inside the brackets. A bare name (`happy`) is
 * accepted too. Anything that is not one of the protocol's emotions (`[whisper]`, `[scene]`, a
 * malformed tag) and the empty tag map to `neutral`.
 */
export function parseEmotion(tag: string): Emotion {
  const inner = /^\s*\[(.*?)\]\s*$/.exec(tag)?.[1] ?? tag
  const name = inner.trim().toLowerCase()
  return EMOTION_NAMES.has(name) ? (name as Emotion) : 'neutral'
}

/** `dance` or `dance:<name>`; the same pattern the legacy stage used after lower-casing the tag. */
const DANCE_TAG = /^dance(?::([\w-]+))?$/

/**
 * Classifies the tag carried by `[motion:<tag>]`.
 *
 * `dance` and `dance:<name>` (case-insensitive) are a dance request, not a clip: the orchestrator
 * decides whether a dance may start and which one. Any other non-empty tag names a motion clip and
 * comes back lower-cased and trimmed. Empty or missing tags give null.
 */
export function parseMotionTag(tag: string | undefined): MotionRequest | null {
  const id = tag?.trim().toLowerCase()
  if (!id) return null
  const dance = DANCE_TAG.exec(id)
  if (dance) {
    const name = dance[1]
    return name ? { kind: 'dance', name } : { kind: 'dance' }
  }
  return { kind: 'clip', tag: id }
}
