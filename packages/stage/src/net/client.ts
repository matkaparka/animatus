import {
  PROTOCOL_VERSION,
  STAGE_SUBPROTOCOL,
  decodeFrame,
  parseDownstream,
  type MediaFrame,
  type StageDownstream,
  type StageUpstream,
} from '@animatus/protocol'

export interface ClientHandlers {
  onOpen(): void
  onClose(): void
  onMessage(msg: StageDownstream): void
  onFrame(frame: MediaFrame): void
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 5000]

/**
 * The stage's single WebSocket to the orchestrator. It reconnects with backoff, validates every
 * downstream frame (unknown or malformed frames are dropped and counted, never acted on), and can only
 * send reports.
 */
export class StageClient {
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: number | null = null
  private closedByUs = false
  invalidFrames = 0

  constructor(
    private readonly url: string,
    private readonly handlers: ClientHandlers
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(): void {
    this.closedByUs = false
    this.open()
  }

  close(): void {
    this.closedByUs = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.ws?.close(1000, 'stage closing')
  }

  send(report: StageUpstream): boolean {
    if (!this.connected) return false
    this.ws!.send(JSON.stringify(report))
    return true
  }

  /** Called by the stage after `welcome` so the next reconnect starts from the short delay again. */
  resetBackoff(): void {
    this.attempt = 0
  }

  private open(): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url, [STAGE_SUBPROTOCOL])
    } catch (e) {
      console.error('[stage] cannot open WebSocket', e)
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => this.handlers.onOpen()
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.handlers.onClose()
      if (!this.closedByUs) this.scheduleReconnect()
    }
    ws.onerror = () => {
      // the close event follows; nothing to do here
    }
    ws.onmessage = (ev: MessageEvent) => {
      const data = ev.data
      if (typeof data === 'string') {
        const msg = parseDownstream(data)
        if (!msg) {
          this.invalidFrames++
          console.warn('[stage] dropped an invalid downstream frame')
          return
        }
        this.handlers.onMessage(msg)
      } else if (data instanceof ArrayBuffer) {
        try {
          this.handlers.onFrame(decodeFrame(data))
        } catch (e) {
          this.invalidFrames++
          console.warn('[stage] dropped a malformed media frame', e)
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.timer !== null) return
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] as number
    this.attempt++
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.open()
    }, delay)
  }
}

export const helloMessage = (
  stageId: string,
  caps: { webgl2: boolean; audio_context: boolean; output_latency_api: boolean }
): StageUpstream => ({
  type: 'hello',
  protocol: PROTOCOL_VERSION,
  stage_id: stageId,
  ua: navigator.userAgent.slice(0, 400),
  capabilities: caps,
  perf_now_ms: performance.now(),
})
