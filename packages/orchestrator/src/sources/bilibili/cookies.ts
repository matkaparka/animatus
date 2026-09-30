import type { BilibiliCookies } from './types.ts'

/** RFC 6265 cookie-octet: printable ASCII except whitespace, double quote, comma, semicolon and backslash. */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/

/** Values shorter than this are never treated as secrets when redacting text (too likely to be noise). */
export const MIN_SECRET_LENGTH = 6

export interface CleanedCookies {
  cookies: BilibiliCookies
  /** Names (never values) of the cookies that were dropped because they were not a valid cookie value. */
  rejected: string[]
}

/**
 * Trims the values and drops empty ones. A value that could not be sent in a `Cookie` header (control
 * characters, `;`, whitespace inside) is dropped rather than repaired: sending half a cookie helps nobody,
 * and a raw newline would let a bad value inject a header.
 */
export function cleanCookies(input: BilibiliCookies): CleanedCookies {
  const cookies: BilibiliCookies = {}
  const rejected: string[] = []
  const take = (name: keyof BilibiliCookies, value: unknown): void => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed === '') return
    if (!COOKIE_VALUE.test(trimmed)) {
      rejected.push(name)
      return
    }
    cookies[name] = trimmed
  }
  take('sessdata', input.sessdata)
  take('biliJct', input.biliJct)
  take('buvid3', input.buvid3)
  return { cookies, rejected }
}

/** Value of the `Cookie` header for the cookies present, or an empty string. */
export function buildCookieHeader(cookies: BilibiliCookies): string {
  const parts: string[] = []
  if (cookies.sessdata) parts.push(`SESSDATA=${cookies.sessdata}`)
  if (cookies.biliJct) parts.push(`bili_jct=${cookies.biliJct}`)
  if (cookies.buvid3) parts.push(`buvid3=${cookies.buvid3}`)
  return parts.join('; ')
}

/**
 * Reads a `Cookie` header string as copied from a browser ("SESSDATA=...; bili_jct=...; buvid3=...") into the three
 * cookies the source uses. Unknown cookies are ignored; the names are matched case-insensitively.
 */
export function parseCookieHeader(header: string): BilibiliCookies {
  const cookies: BilibiliCookies = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const name = part.slice(0, eq).trim().toLowerCase()
    const value = part.slice(eq + 1).trim()
    if (value === '') continue
    if (name === 'sessdata') cookies.sessdata = value
    else if (name === 'bili_jct') cookies.biliJct = value
    else if (name === 'buvid3') cookies.buvid3 = value
  }
  return cookies
}
