import type { TtsAdapter, TtsRequest, TtsStream } from '@animatus/protocol'
import { TtsError } from './gptsovits.ts'

/**
 * The speech director is built once and lives as long as the program; the speech service behind it starts,
 * stops and restarts. This adapter is the seam: it forwards to whatever backend is attached right now and
 * fails loudly (a retryable `unavailable` error) when there is none, so a sentence is never silently lost.
 */
export class SwitchableTts implements TtsAdapter {
  private backend: TtsAdapter | null = null

  get attached(): boolean {
    return this.backend !== null
  }

  attach(backend: TtsAdapter | null): void {
    this.backend = backend
  }

  synthesize(req: TtsRequest): Promise<TtsStream> {
    const b = this.backend
    if (!b)
      return Promise.reject(new TtsError('the speech service is not ready', 'unavailable', true))
    return b.synthesize(req)
  }

  async styles(): Promise<string[]> {
    return this.backend ? this.backend.styles() : []
  }
}
