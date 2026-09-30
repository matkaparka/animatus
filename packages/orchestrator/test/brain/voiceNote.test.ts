import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../../src/brain/prompt.ts'
import { voiceNote } from '../../src/brain/voiceNote.ts'

describe('what the model is told about the language of the voice', () => {
  it('names the language, and only the Chinese-and-English mode allows English words', () => {
    expect(voiceNote('zh')).toBe(
      'Your voice is a Chinese voice: write every sentence in Chinese, whatever language the chat uses (a few English words are fine).'
    )
    expect(voiceNote('en')).toBe(
      'Your voice is an English voice: write every sentence in English, whatever language the chat uses.'
    )
    for (const [code, language] of [
      ['all_zh', 'Chinese'],
      ['ja', 'Japanese'],
      ['all_ja', 'Japanese'],
      ['ko', 'Korean'],
      ['yue', 'Cantonese'],
      [' ZH ', 'Chinese'],
    ] as const)
      expect(voiceNote(code)).toContain(`in ${language}`)
    expect(voiceNote('all_zh')).not.toContain('English words')
  })

  it('says nothing for a code that mixes or detects languages, or one that is not known', () => {
    for (const code of ['auto', 'auto_yue', '', 'klingon']) expect(voiceNote(code)).toBeUndefined()
  })

  it('comes right after the persona, before the motion tags and everything else', () => {
    const { text } = buildSystemPrompt({
      persona: 'You are Nova.',
      voiceNote: 'Your voice is a Chinese voice.',
      motionTags: ['nod'],
      modePrompts: [{ id: 'm', text: 'A mode prompt.' }],
    })
    const at = (s: string) => text.indexOf(s)
    expect(at('You are Nova.')).toBe(0)
    expect(at('Your voice is a Chinese voice.')).toBeGreaterThan(at('You are Nova.'))
    expect(at('nod')).toBeGreaterThan(at('Your voice is'))
    expect(at('A mode prompt.')).toBeGreaterThan(at('nod'))
    expect(buildSystemPrompt({ persona: 'You are Nova.' }).text).toBe('You are Nova.')
  })
})
