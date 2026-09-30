/**
 * Emotion and mouth expressions.
 *
 * Keeps track of which expression is switched on for the current emotion and which lip-sync mode is
 * active, so that the next one can clear the previous one first. Blinking is not handled here: the
 * procedural layer owns it (it needs irregular timing and has to keep working under an emotion).
 *
 * Call `update` once per frame before the procedural layer and `vrm.update`.
 */
import type { VRM, VRMExpressionManager } from '@pixiv/three-vrm'

export type Vowel = 'aa' | 'ih' | 'ou' | 'ee' | 'oh'
export type VowelWeights = Partial<Record<Vowel, number>>

const VOWELS: readonly Vowel[] = ['aa', 'ih', 'ou', 'ee', 'oh']

/** Mouth opening factors: the same as the volume-driven mouth of the original viewer. */
const VOWEL_SCALE = { neutral: 1.0, emotion: 0.8 }
const VOLUME_SCALE = { neutral: 0.5, emotion: 0.25 }

const finite = (x: number) => (Number.isFinite(x) ? x : 0)

export class ExpressionController {
  private em: VRMExpressionManager | undefined
  private emotion = 'neutral'
  private mode: 'none' | 'vowels' | 'volume' = 'none'
  private vowels: Record<Vowel, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }
  private volume = 0

  /** Multiplier on the mouth opening; 1 = normal speech, lower for a quiet, calm look. */
  mouthScale = 1

  constructor(vrm: VRM) {
    this.em = vrm.expressionManager ?? undefined
  }

  get currentEmotion(): string {
    return this.emotion
  }

  /**
   * Switch to an emotion: the previous emotion expression is cleared and the new one set to weight 1.
   * `neutral` only clears. (The procedural layer fades emotions in and out on top of this when it is
   * running; without it the expression changes at once.)
   */
  playEmotion(name: string) {
    if (this.emotion !== 'neutral') this.em?.setValue(this.emotion, 0)
    this.emotion = name
    if (name !== 'neutral') this.em?.setValue(name, 1)
  }

  /** Lip sync from per-vowel weights (0..1). Vowels that are not listed count as 0. */
  setVowels(weights: VowelWeights) {
    if (this.mode === 'volume') this.em?.setValue('aa', 0)
    this.mode = 'vowels'
    for (const v of VOWELS) this.vowels[v] = finite(weights[v] ?? 0)
  }

  /** Fallback lip sync: a single `aa` opening from the volume (0..1). */
  setVolumeMouth(volume: number) {
    if (this.mode === 'vowels') for (const v of VOWELS) this.em?.setValue(v, 0)
    this.mode = 'volume'
    this.volume = finite(volume)
  }

  /** Close the mouth and stop driving it until the next `setVowels` / `setVolumeMouth`. */
  clearMouth() {
    if (this.mode === 'vowels') for (const v of VOWELS) this.em?.setValue(v, 0)
    else if (this.mode === 'volume') this.em?.setValue('aa', 0)
    this.mode = 'none'
  }

  update(_delta: number) {
    const em = this.em
    if (!em) return
    const neutral = this.emotion === 'neutral'
    if (this.mode === 'vowels') {
      const k = (neutral ? VOWEL_SCALE.neutral : VOWEL_SCALE.emotion) * this.mouthScale
      for (const v of VOWELS) em.setValue(v, this.vowels[v] * k)
    } else if (this.mode === 'volume') {
      const k = (neutral ? VOLUME_SCALE.neutral : VOLUME_SCALE.emotion) * this.mouthScale
      em.setValue('aa', this.volume * k)
    }
  }
}
