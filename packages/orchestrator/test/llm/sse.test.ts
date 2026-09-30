import { describe, expect, it } from 'vitest'
import { SseLimitError, SseParser } from '../../src/llm/sse.ts'
import type { SseEvent } from '../../src/llm/sse.ts'
import { seededRandom } from './support/mocks.ts'

const enc = new TextEncoder()

function parseAll(chunks: (string | Uint8Array)[]): SseEvent[] {
  const parser = new SseParser()
  const out: SseEvent[] = []
  for (const c of chunks)
    out.push(...(typeof c === 'string' ? parser.push(c) : parser.pushBytes(c)))
  out.push(...parser.flush())
  return out
}

/** Comment, CRLF, LF and lone-CR line ends, multi-line data, a named event, ids, multi-byte text. */
const SAMPLE = [
  ': comment line\r\n',
  'data: {"a":1}\r\n\r\n',
  'event: ping\ndata:no-space\n\n',
  'data: line one\ndata: line two\n\n',
  'id: 7\nretry: 1500\ndata: with id\r\n\r\n',
  'data: 日本語 😀 émoji\r\r',
  'data\n\n',
  'data: last\n\n',
].join('')

const EXPECTED: SseEvent[] = [
  { event: 'message', data: '{"a":1}' },
  { event: 'ping', data: 'no-space' },
  { event: 'message', data: 'line one\nline two' },
  { event: 'message', data: 'with id', id: '7', retry: 1500 },
  { event: 'message', data: '日本語 😀 émoji' },
  { event: 'message', data: '' },
  { event: 'message', data: 'last' },
]

describe('SseParser', () => {
  it('parses the reference sample in one piece', () => {
    expect(parseAll([SAMPLE])).toEqual(EXPECTED)
  })

  it('gives the same events when the bytes are cut at any single position', () => {
    const bytes = enc.encode(SAMPLE)
    for (let i = 0; i <= bytes.length; i++) {
      expect(parseAll([bytes.subarray(0, i), bytes.subarray(i)]), `cut at byte ${i}`).toEqual(
        EXPECTED
      )
    }
  })

  it('gives the same events one byte at a time', () => {
    const bytes = enc.encode(SAMPLE)
    expect(parseAll(Array.from(bytes, (_b, i) => bytes.subarray(i, i + 1)))).toEqual(EXPECTED)
  })

  it('gives the same events for many seeded random slicings', () => {
    const bytes = enc.encode(SAMPLE)
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = seededRandom(seed)
      const chunks: Uint8Array[] = []
      for (let i = 0; i < bytes.length;) {
        const n = 1 + Math.floor(rnd() * 9)
        chunks.push(bytes.subarray(i, i + n))
        i += n
      }
      expect(parseAll(chunks), `seed ${seed}`).toEqual(EXPECTED)
    }
  })

  it('treats a CRLF split between two chunks as one line end', () => {
    // If CR and LF were two line ends, the LF would be a blank line and cut this event in two.
    expect(parseAll(['data: a\r', '\ndata: b\r\n\r\n'])).toEqual([
      { event: 'message', data: 'a\nb' },
    ])
    expect(parseAll(['data: a\r', '\r\n'])).toEqual([{ event: 'message', data: 'a' }])
  })

  it('decodes a multi-byte character split across chunks', () => {
    const bytes = enc.encode('data: 😀\n\n')
    const cut = bytes.indexOf(0xf0) + 2 // inside the four-byte emoji
    expect(parseAll([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual([
      { event: 'message', data: '😀' },
    ])
  })

  it('ignores a byte-order mark, comments, unknown fields and bad retry/id values', () => {
    expect(parseAll(['﻿data: a\n\n'])).toEqual([{ event: 'message', data: 'a' }])
    expect(parseAll([Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode('data: b\n\n')])])).toEqual([
      { event: 'message', data: 'b' },
    ])
    expect(parseAll([':x\n:data: nope\nfoo: bar\nretry: soon\nid: a\0b\ndata: c\n\n'])).toEqual([
      { event: 'message', data: 'c' },
    ])
  })

  it('does not carry the event name or id over to the next event', () => {
    expect(parseAll(['event: a\nid: 1\ndata: x\n\ndata: y\n\n'])).toEqual([
      { event: 'a', data: 'x', id: '1' },
      { event: 'message', data: 'y' },
    ])
  })

  it('emits nothing for blank lines without data', () => {
    expect(parseAll(['\n\n\r\n\r\nevent: x\n\n'])).toEqual([])
  })

  it('delivers an event at the end of the stream even without its blank line', () => {
    expect(parseAll(['data: x\n'])).toEqual([{ event: 'message', data: 'x' }])
    expect(parseAll(['data: x'])).toEqual([{ event: 'message', data: 'x' }])
    expect(parseAll(['data: x\n\ndata: y'])).toEqual([
      { event: 'message', data: 'x' },
      { event: 'message', data: 'y' },
    ])
    expect(parseAll([])).toEqual([])
  })

  it('accepts a value without the optional space after the colon', () => {
    expect(parseAll(['data:{"k":1}\n\ndata:  two spaces\n\n'])).toEqual([
      { event: 'message', data: '{"k":1}' },
      { event: 'message', data: ' two spaces' },
    ])
  })

  it('refuses an event or a line beyond the size limit', () => {
    expect(() =>
      new SseParser({ maxEventChars: 100 }).push(`data: ${'x'.repeat(200)}\n\n`)
    ).toThrow(SseLimitError)
    expect(() => new SseParser({ maxEventChars: 100 }).push('data: '.padEnd(300, 'y'))).toThrow(
      SseLimitError
    )
    const many = new SseParser({ maxEventChars: 100 })
    expect(() =>
      many.push(
        'data: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ndata: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
      )
    ).toThrow(SseLimitError)
  })
})
