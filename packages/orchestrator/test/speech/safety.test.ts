import { describe, expect, it } from 'vitest'
import { SafetyObserver } from '../../src/speech/safety.ts'
import type { SafetyEvent } from '../../src/speech/safety.ts'

const make = (opts: ConstructorParameters<typeof SafetyObserver>[0] = {}) => {
  const events: SafetyEvent[] = []
  return { safety: new SafetyObserver({ ...opts, onEvent: (e) => events.push(e) }), events }
}

describe('what must not be read out', () => {
  const cases: [string, string, string][] = [
    ['a mainland phone number', '我的手机号是13812345678，记一下', '我的手机号是哔，记一下'],
    ['a phone number with spaces', 'call 138 1234 5678 now', 'call 哔 now'],
    ['a phone number with hyphens', 'call 138-1234-5678 now', 'call 哔 now'],
    ['a QQ-length number', '加我 QQ 123456789 吧', '加我 QQ 哔 吧'],
    ['a link', '去看 https://example.com/a/b?c=1 这个页面', '去看 哔 这个页面'],
    ['a link with www', '打开 www.example.com/x 看看', '打开 哔 看看'],
    [
      'a link at the end of a sentence in Chinese',
      '网址是https://example.com/abc。谢谢',
      '网址是哔。谢谢',
    ],
    ['an email address', 'write to first.last+tag@mail.example.org please', 'write to 哔 please'],
    // built from pieces: a whole personal path in a source file is what the secret scan is there to catch
    [
      'a Windows path',
      `文件在 C:${'\\'}Users${'\\'}someone${'\\'}Documents${'\\'}notes.txt 里`,
      '文件在 哔 里',
    ],
    ['a Unix path', 'it is in /home/me/.config/app.yaml', 'it is in 哔'],
    [
      'a key with a well-known start',
      `the key is ${['AIza', 'SyD-0123456789abcdefghijklmnop'].join('')}, keep it`,
      'the key is 哔, keep it',
    ],
    ['an sk- key', `use ${['sk', 'abcdefghijklmnopqrstuvwx123456'].join('-')}`, 'use 哔'],
    ['a long token', 'token 0123456789abcdef0123456789abcdef0123 end', 'token 哔 end'],
  ]
  for (const [what, said, spoken] of cases)
    it(`replaces ${what}`, () => {
      const { safety, events } = make()
      expect(safety.sanitize(said)).toBe(spoken)
      expect(events).toHaveLength(1)
      expect(events[0]?.kind).toBe('replaced')
    })

  const fine = [
    '今天是2026-09-30，天气不错',
    '一共有12345678个观众吗，不是，只有五个',
    '版本 3.14 已经发布',
    '价格是 100 元',
    '我们已经直播了 2 小时 30 分钟',
    'the year 2026 was big',
    'nothing to hide here, just words',
    '我喜欢这首歌，它叫《夜曲》',
    'a short id like abc-123 is fine',
  ]
  for (const text of fine)
    it(`leaves alone: ${text}`, () => {
      const { safety, events } = make()
      expect(safety.sanitize(text)).toBe(text)
      expect(events).toEqual([])
    })

  it('says which classes were replaced, never what was in them', () => {
    const { safety, events } = make()
    safety.sanitize('mail a@b.co or see https://x.example/y or call 13812345678')
    expect(events).toEqual([{ kind: 'replaced', classes: ['link', 'email', 'number'] }])
    expect(JSON.stringify(events)).not.toContain('13812345678')
  })

  it('one report per sentence when the same text is sanitised for the screen too, without reporting', () => {
    const { safety, events } = make()
    const said = safety.sanitize('call 13812345678')
    const shown = safety.sanitize('call 13812345678', false)
    expect(said).toBe(shown)
    expect(events).toHaveLength(1)
  })

  it('the stand-in is a setting, and the whole check can be switched off', () => {
    expect(make({ replacement: '[hidden]' }).safety.sanitize('call 13812345678')).toBe(
      'call [hidden]'
    )
    const off = make({ personalInfo: false })
    expect(off.safety.sanitize('call 13812345678')).toBe('call 13812345678')
    expect(off.events).toEqual([])
  })
})

describe('a stuck model', () => {
  const said = (safety: SafetyObserver, ...sentences: string[]) =>
    sentences.map((s) => safety.admit(s))

  it('a sentence is spoken twice, and not the third time within the last few sentences', () => {
    const { safety, events } = make()
    expect(
      said(safety, '好的，我明白了。', '好的，我明白了。', '好的，我明白了！', '好的，我明白了。')
    ).toEqual([true, true, false, false])
    expect(events).toEqual([{ kind: 'loop_start' }])
  })

  it('it is over as soon as something else is said: one start, one end', () => {
    const { safety, events } = make()
    said(safety, 'same words here', 'same words here', 'same words here', 'same words here')
    expect(safety.admit('and now something different')).toBe(true)
    expect(events).toEqual([{ kind: 'loop_start' }, { kind: 'loop_end' }])
  })

  it('punctuation, spacing and case do not make a repeat a new sentence', () => {
    const { safety } = make()
    expect(
      said(safety, 'Hello there, friend.', 'hello there friend', 'HELLO THERE... FRIEND!')
    ).toEqual([true, true, false])
  })

  it('short interjections are never a loop, and old sentences fall out of the window', () => {
    const { safety } = make()
    expect(said(safety, '哈哈哈', '哈哈哈', '哈哈哈', '哈哈哈')).toEqual([true, true, true, true])
    const { safety: s2 } = make()
    const results = [
      ...said(s2, 'the repeated line, twice'),
      ...said(s2, 'the repeated line, twice'),
      // eight other sentences push the first two out of the window
      ...Array.from({ length: 8 }, (_, i) => s2.admit(`another different sentence number ${i}`)),
      ...said(s2, 'the repeated line, twice'),
    ]
    expect(results.every(Boolean)).toBe(true)
  })

  it('can be switched off', () => {
    const { safety, events } = make({ repetition: false })
    expect(said(safety, 'same words here', 'same words here', 'same words here')).toEqual([
      true,
      true,
      true,
    ])
    expect(events).toEqual([])
  })
})
