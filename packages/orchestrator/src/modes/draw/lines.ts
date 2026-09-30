/** The fixed lines of the pack (a refusal, a fault line): one per line of a prompt file, each may start with an emotion tag. */
import type { Emotion } from '@animatus/protocol'
import { extractEmotion, parseEmotion } from '../../brain/tags.ts'

export interface Line {
  text: string
  emotion: Emotion
}

export function parseLines(file: string): Line[] {
  const lines: Line[] = []
  for (const raw of file.split(/\r?\n/)) {
    const { emotionTag, remainingText } = extractEmotion(raw.trim())
    const text = remainingText.trim()
    if (text) lines.push({ text, emotion: parseEmotion(emotionTag) })
  }
  return lines
}

export function pickLine(lines: readonly Line[], random: () => number = Math.random): Line | null {
  return lines.length === 0
    ? null
    : (lines[Math.min(lines.length - 1, Math.floor(random() * lines.length))] as Line)
}
