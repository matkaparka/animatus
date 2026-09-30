import { describe, expect, it } from 'vitest'
import type { VRM } from '@pixiv/three-vrm'
import { ExpressionController } from '../../src/avatar/expression.ts'
import { makeFakeVrm } from './fakeVrm.ts'

function setup() {
  const fake = makeFakeVrm({ mouth: true, emotions: true })
  const ctl = new ExpressionController(fake.vrm)
  const value = (name: string) => fake.vrm.expressionManager!.getValue(name)
  return { fake, ctl, value }
}

describe('emotions', () => {
  it('sets the new emotion to 1 and clears the previous one', () => {
    const { ctl, value } = setup()
    expect(ctl.currentEmotion).toBe('neutral')
    ctl.playEmotion('happy')
    expect(ctl.currentEmotion).toBe('happy')
    expect(value('happy')).toBe(1)
    ctl.playEmotion('sad')
    expect(ctl.currentEmotion).toBe('sad')
    expect(value('happy')).toBe(0)
    expect(value('sad')).toBe(1)
  })

  it('neutral clears the emotion', () => {
    const { ctl, value } = setup()
    ctl.playEmotion('angry')
    ctl.playEmotion('neutral')
    expect(ctl.currentEmotion).toBe('neutral')
    expect(value('angry')).toBe(0)
    // and playing it again from neutral is fine
    ctl.playEmotion('angry')
    expect(value('angry')).toBe(1)
  })

  it('playing the same emotion twice leaves it at 1', () => {
    const { ctl, value } = setup()
    ctl.playEmotion('relaxed')
    ctl.playEmotion('relaxed')
    expect(value('relaxed')).toBe(1)
  })

  it('does not throw for an expression the model does not have', () => {
    const { ctl } = setup()
    expect(() => ctl.playEmotion('embarrassed')).not.toThrow()
    expect(ctl.currentEmotion).toBe('embarrassed')
    expect(() => ctl.playEmotion('neutral')).not.toThrow()
  })
})

describe('vowel lip sync', () => {
  it('applies the weights at x1.0 when neutral', () => {
    const { ctl, value } = setup()
    ctl.setVowels({ aa: 0.8, ih: 0.4, ou: 0.2, ee: 0.1, oh: 0.6 })
    ctl.update(1 / 60)
    expect(value('aa')).toBeCloseTo(0.8, 9)
    expect(value('ih')).toBeCloseTo(0.4, 9)
    expect(value('ou')).toBeCloseTo(0.2, 9)
    expect(value('ee')).toBeCloseTo(0.1, 9)
    expect(value('oh')).toBeCloseTo(0.6, 9)
  })

  it('applies them at x0.8 under an emotion', () => {
    const { ctl, value } = setup()
    ctl.playEmotion('happy')
    ctl.setVowels({ aa: 1, oh: 0.5 })
    ctl.update(1 / 60)
    expect(value('aa')).toBeCloseTo(0.8, 9)
    expect(value('oh')).toBeCloseTo(0.4, 9)
  })

  it('treats vowels that are left out as 0 and replaces the previous weights', () => {
    const { ctl, value } = setup()
    ctl.setVowels({ aa: 1, ee: 1 })
    ctl.update(0.016)
    ctl.setVowels({ ih: 0.5 })
    ctl.update(0.016)
    expect(value('aa')).toBe(0)
    expect(value('ee')).toBe(0)
    expect(value('ih')).toBeCloseTo(0.5, 9)
  })

  it('follows a change of emotion on the next update', () => {
    const { ctl, value } = setup()
    ctl.setVowels({ aa: 1 })
    ctl.update(0.016)
    expect(value('aa')).toBeCloseTo(1, 9)
    ctl.playEmotion('surprised')
    ctl.update(0.016)
    expect(value('aa')).toBeCloseTo(0.8, 9)
  })
})

describe('volume lip sync', () => {
  it('drives a single aa at x0.5 when neutral and x0.25 under an emotion', () => {
    const { ctl, value } = setup()
    ctl.setVolumeMouth(0.8)
    ctl.update(0.016)
    expect(value('aa')).toBeCloseTo(0.4, 9)
    expect(value('ih')).toBe(0)
    ctl.playEmotion('sad')
    ctl.update(0.016)
    expect(value('aa')).toBeCloseTo(0.2, 9)
  })

  it('clamps like the expression manager (never above 1) and ignores NaN', () => {
    const { ctl, value } = setup()
    ctl.setVolumeMouth(10)
    ctl.update(0.016)
    expect(value('aa')).toBe(1)
    ctl.setVolumeMouth(Number.NaN)
    ctl.update(0.016)
    expect(value('aa')).toBe(0)
  })
})

describe('switching between the two mouth modes', () => {
  it('zeroes the volume mouth when vowels take over, before the next update', () => {
    const { ctl, value } = setup()
    ctl.setVolumeMouth(1)
    ctl.update(0.016)
    expect(value('aa')).toBeCloseTo(0.5, 9)
    ctl.setVowels({ ih: 1 })
    expect(value('aa')).toBe(0)
    ctl.update(0.016)
    expect(value('ih')).toBeCloseTo(1, 9)
    expect(value('aa')).toBe(0)
  })

  it('zeroes every vowel when the volume mouth takes over, before the next update', () => {
    const { ctl, value } = setup()
    ctl.setVowels({ aa: 1, ih: 1, ou: 1, ee: 1, oh: 1 })
    ctl.update(0.016)
    ctl.setVolumeMouth(0.4)
    for (const v of ['aa', 'ih', 'ou', 'ee', 'oh']) expect(value(v)).toBe(0)
    ctl.update(0.016)
    expect(value('aa')).toBeCloseTo(0.2, 9)
    for (const v of ['ih', 'ou', 'ee', 'oh']) expect(value(v)).toBe(0)
  })

  it('clearMouth closes the mouth and stops driving it', () => {
    const { ctl, value } = setup()
    ctl.setVowels({ aa: 1, oh: 1 })
    ctl.update(0.016)
    ctl.clearMouth()
    expect(value('aa')).toBe(0)
    expect(value('oh')).toBe(0)
    ctl.update(0.016)
    expect(value('aa')).toBe(0)
  })
})

describe('mouthScale', () => {
  it('multiplies the opening in both modes', () => {
    const { ctl, value } = setup()
    ctl.mouthScale = 0.5
    ctl.setVowels({ aa: 1 })
    ctl.update(0.016)
    expect(value('aa')).toBeCloseTo(0.5, 9)
    ctl.setVolumeMouth(1)
    ctl.update(0.016)
    expect(value('aa')).toBeCloseTo(0.25, 9)
    ctl.mouthScale = 2
    ctl.update(0.016)
    expect(value('aa')).toBe(1) // 1 x 0.5 x 2
  })

  it('combines with the emotion factor', () => {
    const { ctl, value } = setup()
    ctl.playEmotion('happy')
    ctl.mouthScale = 0.5
    ctl.setVowels({ aa: 1 })
    ctl.update(0.016)
    expect(value('aa')).toBeCloseTo(0.4, 9) // 1 x 0.8 x 0.5
  })
})

describe('a model without an expression manager', () => {
  it('does nothing and does not throw', () => {
    const ctl = new ExpressionController({ expressionManager: undefined } as unknown as VRM)
    expect(() => {
      ctl.playEmotion('happy')
      ctl.setVowels({ aa: 1 })
      ctl.setVolumeMouth(1)
      ctl.clearMouth()
      ctl.update(0.016)
    }).not.toThrow()
    expect(ctl.currentEmotion).toBe('happy')
  })
})
