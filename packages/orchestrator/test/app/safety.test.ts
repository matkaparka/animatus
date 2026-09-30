import { describe, expect, it } from 'vitest'
import type { AppConfigInput } from '../../src/config.ts'
import { danmaku, installCleanup, rig, until } from './rig.ts'

installCleanup()

async function say(sentences: string[], config: AppConfigInput = {}) {
  const r = await rig({ config })
  r.llm.reply = () => sentences
  const stage = await r.connect()
  await until(() => r.app.stage.hub.connected, 3000, 'the stage')
  r.bili.emit(danmaku('please say something'))
  await until(
    () => r.app.brain.currentTurn === null && r.llm.requests.length > 0,
    6000,
    'the reply'
  )
  await new Promise((res) => setTimeout(res, 300))
  const subtitles = () =>
    stage.begins.map((b) => String((b as { subtitle?: string }).subtitle ?? '')).filter(Boolean)
  return { r, stage, subtitles, spoken: () => r.tts.requests.map((q) => q.text) }
}

const log = (r: Awaited<ReturnType<typeof say>>['r']) => r.app.runLog.recent(500).map((e) => e.text)

describe('the last check before a sentence is spoken', () => {
  it('a phone number, a link and an email in a sentence: the voice and the words on screen both get the bleep', async () => {
    const { r, subtitles, spoken } = await say([
      '[neutral]我的手机号是13812345678。',
      '[neutral]看 https://example.com/x 这里。',
      '[neutral]写信给 a.b@mail.example.org 吧。',
    ])
    expect(spoken()).toEqual(['我的手机号是哔。', '看 哔 这里。', '写信给 哔 吧。'])
    expect(subtitles()).toEqual(['我的手机号是哔。', '看 哔 这里。', '写信给 哔 吧。'])
    const safety = log(r).filter((l) => l.startsWith('safety:'))
    expect(safety).toEqual([
      'safety: replaced number in a sentence before it was spoken',
      'safety: replaced link in a sentence before it was spoken',
      'safety: replaced email in a sentence before it was spoken',
    ])
    // the safety lines name the class of thing and never the thing (the run log elsewhere is the streamer's own view of what the model wrote)
    expect(safety.join(' | ')).not.toContain('13812345678')
  })

  it('an ordinary sentence with numbers in it is spoken as it is', async () => {
    const { spoken } = await say(['[neutral]今天是2026-09-30，已经直播了2小时。'])
    expect(spoken()).toEqual(['今天是2026-09-30，已经直播了2小时。'])
  })

  it('a stuck model: the third time is not spoken, an alarm says so, and it clears when something else is said', async () => {
    const { r, spoken } = await say([
      '[neutral]好的，我明白了。',
      '[neutral]好的，我明白了。',
      '[neutral]好的，我明白了。',
      '[neutral]好的，我明白了。',
      '[neutral]那我们说点别的吧。',
    ])
    expect(spoken()).toEqual(['好的，我明白了。', '好的，我明白了。', '那我们说点别的吧。'])
    expect(log(r)).toContain('safety: a sentence is being repeated; the repeats are not spoken')
    expect(r.app.alarms.list().map((a) => a.code)).not.toContain('speech_loop') // cleared by the last sentence
  })

  it('can be switched off in the configuration', async () => {
    const { spoken } = await say(['[neutral]我的手机号是13812345678。'], {
      speech: { safety: { personal_info: false, repetition: false } },
    })
    expect(spoken()).toEqual(['我的手机号是13812345678。'])
  })

  it('the bleep is a setting', async () => {
    const { spoken } = await say(['[neutral]call 13812345678 now.'], {
      speech: { safety: { replacement: 'beep' } },
    })
    expect(spoken()).toEqual(['call beep now.'])
  })
})
