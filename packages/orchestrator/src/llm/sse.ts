/**
 * Incremental Server-Sent Events parser (WHATWG "event stream interpretation").
 *
 * Robust against everything a real network does to a stream: an event or a line ending split at any
 * byte, a multi-byte character split across chunks, CRLF / LF / lone CR line ends (including a CRLF
 * split between two chunks), comment lines, fields without a value and `data:` split over several
 * lines. One deliberate leniency: an event that was terminated by the end of the stream instead of a
 * blank line is still delivered (some servers close right after the last `data:` line).
 */

export interface SseEvent {
  /** Event name; `message` when the stream did not name it. */
  event: string
  /** The `data` lines joined with `\n`. */
  data: string
  id?: string
  retry?: number
}

/** A single event grew beyond the limit: a broken or hostile server. */
export class SseLimitError extends Error {}
Object.defineProperty(SseLimitError.prototype, 'name', {
  value: 'SseLimitError',
  writable: true,
  configurable: true,
})

/** Larger than any real event (an inline image in a reply is a few MB of base64). */
const DEFAULT_MAX_EVENT_CHARS = 32 * 1024 * 1024

const LF = 10
const CR = 13
const COLON = 58
const SPACE = 32
const BOM = 0xfeff

export class SseParser {
  readonly #decoder = new TextDecoder('utf-8')
  readonly #max: number
  #partial = ''
  #skipLf = false
  #atStart = true
  #data: string[] = []
  #dataChars = 0
  #eventName = ''
  #id: string | undefined
  #retry: number | undefined

  constructor(opts: { maxEventChars?: number } = {}) {
    this.#max = opts.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS
  }

  /** Feed raw bytes; multi-byte characters may be split across calls. */
  pushBytes(bytes: Uint8Array): SseEvent[] {
    return this.push(this.#decoder.decode(bytes, { stream: true }))
  }

  /** Feed decoded text. Returns the events completed by this chunk. */
  push(text: string): SseEvent[] {
    const events: SseEvent[] = []
    if (text === '') return events
    if (this.#atStart) {
      this.#atStart = false
      if (text.charCodeAt(0) === BOM) text = text.slice(1)
    }
    let i = 0
    if (this.#skipLf) {
      this.#skipLf = false
      if (text.charCodeAt(0) === LF) i = 1
    }
    let start = i
    for (; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c !== LF && c !== CR) continue
      this.#line(this.#partial + text.slice(start, i), events)
      this.#partial = ''
      if (c === CR) {
        if (i + 1 < text.length) {
          if (text.charCodeAt(i + 1) === LF) i++
        } else {
          this.#skipLf = true // the LF of a CRLF may open the next chunk
        }
      }
      start = i + 1
    }
    this.#partial += text.slice(start)
    if (this.#partial.length > this.#max) throw new SseLimitError('SSE line exceeds the size limit')
    return events
  }

  /** End of stream: flush a trailing partial line and deliver an event that lacks its blank line. */
  flush(): SseEvent[] {
    const tail = this.#decoder.decode()
    const events = tail ? this.push(tail) : []
    if (this.#partial !== '') {
      this.#line(this.#partial, events)
      this.#partial = ''
    }
    this.#dispatch(events)
    return events
  }

  #line(line: string, events: SseEvent[]): void {
    if (line === '') {
      this.#dispatch(events)
      return
    }
    if (line.charCodeAt(0) === COLON) return // comment
    const colon = line.indexOf(':')
    let field = line
    let value = ''
    if (colon !== -1) {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      if (value.charCodeAt(0) === SPACE) value = value.slice(1)
    }
    switch (field) {
      case 'data':
        this.#dataChars += value.length + 1
        if (this.#dataChars > this.#max) throw new SseLimitError('SSE event exceeds the size limit')
        this.#data.push(value)
        break
      case 'event':
        this.#eventName = value
        break
      case 'id':
        if (!value.includes('\0')) this.#id = value
        break
      case 'retry':
        if (/^\d+$/.test(value)) this.#retry = Number(value)
        break
      default:
        break // unknown fields are ignored
    }
  }

  #dispatch(events: SseEvent[]): void {
    if (this.#data.length > 0) {
      const event: SseEvent = { event: this.#eventName || 'message', data: this.#data.join('\n') }
      if (this.#id !== undefined) event.id = this.#id
      if (this.#retry !== undefined) event.retry = this.#retry
      events.push(event)
    }
    this.#data = []
    this.#dataChars = 0
    this.#eventName = ''
    this.#id = undefined
    this.#retry = undefined
  }
}
