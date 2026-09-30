/** Rolling frame-time statistics for the periodic `stats` report. */
export class FrameStats {
  private ring: Float32Array
  private i = 0
  private n = 0

  constructor(size = 300) {
    this.ring = new Float32Array(size)
  }

  /** Record one frame's duration in milliseconds. */
  frame(dtMs: number): void {
    this.ring[this.i] = dtMs
    this.i = (this.i + 1) % this.ring.length
    this.n = Math.min(this.n + 1, this.ring.length)
  }

  snapshot(): { fps: number; frame_ms_p95: number } {
    if (this.n === 0) return { fps: 0, frame_ms_p95: 0 }
    const xs = Array.from(this.ring.subarray(0, this.n)).sort((a, b) => a - b)
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const p95 = xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] ?? 0
    return {
      fps: mean > 0 ? Math.round(10000 / mean) / 10 : 0,
      frame_ms_p95: Math.round(p95 * 10) / 10,
    }
  }
}
