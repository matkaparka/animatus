/**
 * What the model is told about the language of the voice.
 *
 * A speech model speaks the languages it was set up for; a reply in another one comes out garbled or in the wrong
 * accent, and a persona file written in one language says nothing about it. So the language the voice speaks (GPT-SoVITS
 * language codes, `tts.text_lang`) becomes one sentence in the system prompt. Codes that mix or detect the language
 * (`auto`, ...) say nothing.
 */
const LANGUAGES: Readonly<Record<string, string>> = {
  zh: 'Chinese',
  all_zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  all_ja: 'Japanese',
  ko: 'Korean',
  all_ko: 'Korean',
  yue: 'Cantonese',
  all_yue: 'Cantonese',
}

export function voiceNote(textLang: string): string | undefined {
  const code = textLang.trim().toLowerCase()
  const language = LANGUAGES[code]
  if (language === undefined) return undefined
  // `zh` is GPT-SoVITS's Chinese-and-English mode
  const mixed = code === 'zh' ? ' (a few English words are fine)' : ''
  const article = /^[AEIOU]/.test(language) ? 'an' : 'a'
  return `Your voice is ${article} ${language} voice: write every sentence in ${language}, whatever language the chat uses${mixed}.`
}
