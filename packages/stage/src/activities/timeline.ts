/** Pure helpers for the timed activities (song, sleep). No Web Audio, no DOM. */

export interface LyricLine {
  /** Seconds from the start of the song. */
  t: number
  text: string
}

/** Index of the lyric line active at time `t` (binary search); -1 before the first line. */
export function lyricIndexAt(lines: readonly LyricLine[], t: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid]!.t <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

export interface Caption {
  text: string
  start: number
  end: number
}

/**
 * The caption to show at time `t` of a whispered track: from just before a line starts until 1.5 s
 * after it ends (or until the next line begins, if that is sooner).
 */
export function captionAt(captions: readonly Caption[], t: number): string {
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i]!
    const until = Math.min(c.end + 1.5, captions[i + 1]?.start ?? Infinity)
    if (t >= c.start - 0.1 && t < until) return c.text
  }
  return ''
}

export interface VoiceActivityOptions {
  /** Envelope frame length (s). */
  frame: number
  /** A frame counts as singing when within this many dB of the loud part (95th percentile RMS). */
  rangeDb: number
  /** After a phrase ends, keep counting as singing this long (s). */
  hold: number
  /** Gaps shorter than this between phrases are filled (s). */
  bridge: number
}

export const DEFAULT_VOICE_ACTIVITY: VoiceActivityOptions = {
  frame: 0.05,
  rangeDb: 30,
  hold: 0.5,
  bridge: 0.8,
}

/**
 * Vocal track to "is the character singing at frame i". Relative threshold, short breaths bridged,
 * tail held: so the body stays in its speaking motion through a phrase and only returns to idle in
 * real instrumental breaks, instead of twitching between words.
 */
export function voiceActivity(
  samples: Float32Array,
  sampleRate: number,
  opts: VoiceActivityOptions = DEFAULT_VOICE_ACTIVITY
): Uint8Array {
  const hop = Math.max(1, Math.round(opts.frame * sampleRate))
  const n = Math.floor(samples.length / hop)
  const rms = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = i * hop, e = j + hop; j < e; j++) s += samples[j]! * samples[j]!
    rms[i] = Math.sqrt(s / hop)
  }
  const sorted = Float32Array.from(rms).sort()
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
  const thr = Math.max(p95 * Math.pow(10, -opts.rangeDb / 20), 1e-4)
  const act = new Uint8Array(n)
  for (let i = 0; i < n; i++) act[i] = rms[i]! > thr ? 1 : 0

  const bridge = Math.round(opts.bridge / opts.frame)
  let last = -1
  for (let i = 0; i < n; i++) {
    if (!act[i]) continue
    if (last >= 0 && i - last - 1 > 0 && i - last - 1 <= bridge) {
      for (let k = last + 1; k < i; k++) act[k] = 1
    }
    last = i
  }

  const hold = Math.round(opts.hold / opts.frame)
  const out = Uint8Array.from(act)
  for (let i = 0; i < n; i++) {
    if (act[i] && (i + 1 >= n || !act[i + 1])) {
      for (let k = i + 1; k <= Math.min(n - 1, i + hold); k++) out[k] = 1
    }
  }
  return out
}
