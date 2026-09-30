import { describe, expect, it } from 'vitest'
import { planRound } from '../../src/modes/controllers/sleepRound.ts'

const t = (key: string) => ({ key })
const tracks = ['a', 'b', 'c', 'd', 'e'].map(t)
const keys = (list: { key: string }[]) => list.map((x) => x.key)

/** A fixed sequence of dice. */
const dice = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length] as number
}

describe('planRound in order', () => {
  it('is the tracks as they are, or from the picked one to the end', () => {
    expect(keys(planRound(tracks, { shuffle: false, random: Math.random }))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ])
    expect(keys(planRound(tracks, { shuffle: false, first: t('c'), random: Math.random }))).toEqual(
      ['c', 'd', 'e']
    )
  })

  it('a picked track that is not in the list is played first, then the list', () => {
    expect(
      keys(planRound(tracks, { shuffle: false, first: t('zzz'), random: Math.random }))
    ).toEqual(['zzz', 'a', 'b', 'c', 'd', 'e'])
  })

  it('does not change what it is given, and an empty list is an empty round', () => {
    const before = [...tracks]
    planRound(tracks, { shuffle: true, random: Math.random })
    expect(tracks).toEqual(before)
    expect(planRound([], { shuffle: true, random: Math.random })).toEqual([])
    expect(planRound([], { shuffle: false, random: Math.random })).toEqual([])
  })
})

describe('planRound shuffled', () => {
  it('has every track once, whatever the dice say', () => {
    for (const random of [
      Math.random,
      dice(0),
      dice(0.999),
      dice(0.2, 0.9, 0.5),
      dice(1), // not below 1
      dice(-1), // not above 0
      dice(Number.NaN),
    ])
      for (let n = 0; n < 20; n++)
        expect(keys(planRound(tracks, { shuffle: true, random })).sort()).toEqual([
          'a',
          'b',
          'c',
          'd',
          'e',
        ])
  })

  it('starts with the picked track when there is one, and the rest follow in some order', () => {
    const list = planRound(tracks, { shuffle: true, first: t('d'), random: Math.random })
    expect(list[0]!.key).toBe('d')
    expect(keys(list).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('never starts with the track that was heard last, when it can help it', () => {
    // dice that leave the list as it is: without the rule it would start with "a" again
    expect(keys(planRound(tracks, { shuffle: true, avoid: 'a', random: dice(0.999) }))[0]).not.toBe(
      'a'
    )
    for (let n = 0; n < 200; n++)
      expect(
        planRound(tracks, { shuffle: true, avoid: 'c', random: Math.random })[0]!.key
      ).not.toBe('c')
    // a list of one has no choice
    expect(
      keys(planRound([t('only')], { shuffle: true, avoid: 'only', random: Math.random }))
    ).toEqual(['only'])
  })

  it('the avoided track may start the round when the operator picked it', () => {
    expect(
      planRound(tracks, { shuffle: true, first: t('a'), avoid: 'a', random: Math.random })[0]!.key
    ).toBe('a')
  })

  it('in order, the avoided track does not matter', () => {
    expect(planRound(tracks, { shuffle: false, avoid: 'a', random: Math.random })[0]!.key).toBe('a')
  })
})
