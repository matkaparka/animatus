/**
 * The order in which one round of the playlist is played. Pure: the dice come in as a function.
 *
 *  - in order, from the top, or from `first` to the end (the rest of the round after the operator picked a track);
 *  - shuffled, each track once, starting with `first` when there is one; without one a round never opens with the
 *    track that was heard last (`avoid`), so shuffling never repeats itself across the seam of two rounds.
 */
export interface RoundOptions<T> {
  shuffle: boolean
  /** The track the round starts with. */
  first?: T
  /** The key of the track heard last, or null. */
  avoid?: string | null
  /** Like `Math.random`: at least 0, below 1. */
  random: () => number
}

/** A pick from 0 to `n - 1`, whatever the dice say (a broken `random` must not index out of range). */
const pick = (random: () => number, n: number): number => {
  const x = random()
  return Math.min(n - 1, Math.max(0, Number.isFinite(x) ? Math.floor(x * n) : 0))
}

export function planRound<T extends { key: string }>(
  tracks: readonly T[],
  { shuffle, first, avoid, random }: RoundOptions<T>
): T[] {
  let list = [...tracks]
  if (shuffle) {
    // Fisher-Yates
    for (let i = list.length - 1; i > 0; i--) {
      const j = pick(random, i + 1)
      ;[list[i], list[j]] = [list[j] as T, list[i] as T]
    }
  }
  if (first) {
    const i = list.findIndex((t) => t.key === first.key)
    if (shuffle) list = [first, ...list.filter((t) => t.key !== first.key)]
    else list = i >= 0 ? list.slice(i) : [first, ...list]
  } else if (shuffle && list.length > 1 && list[0]?.key === avoid) {
    const j = 1 + pick(random, list.length - 1)
    ;[list[0], list[j]] = [list[j] as T, list[0] as T]
  }
  return list
}
