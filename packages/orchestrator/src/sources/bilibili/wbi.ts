import { createHash } from 'node:crypto'

/**
 * Request signing ("WBI") that the platform requires on some endpoints, notably the one that hands out
 * the live-room connection token. The two key halves come from the `wbi_img` URLs of the nav response;
 * they rotate, so they are read again for every connection attempt.
 *
 * `blive-message-listener` signs its own token request too, but caches the answer for the life of the
 * process; signing here lets the source ask for a token that belongs to the cookie it is about to use.
 */

/** Fixed permutation that mixes the two key halves into the signing key. */
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

export interface WbiKeys {
  imgKey: string
  subKey: string
}

const KEY_PATTERN = /^[0-9a-f]{32}$/i

/** A key is the file name, without extension, of the image URL. Null if either URL does not hold one. */
export function parseWbiKeys(imgUrl: string, subUrl: string): WbiKeys | null {
  const imgKey = keyFromUrl(imgUrl)
  const subKey = keyFromUrl(subUrl)
  if (imgKey === null || subKey === null) return null
  return { imgKey, subKey }
}

function keyFromUrl(url: string): string | null {
  const name = url.slice(url.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const key = dot < 0 ? name : name.slice(0, dot)
  return KEY_PATTERN.test(key) ? key : null
}

export function wbiMixinKey(keys: WbiKeys): string {
  const joined = keys.imgKey + keys.subKey
  return MIXIN_TABLE.map((index) => joined[index] ?? '')
    .join('')
    .slice(0, 32)
}

/**
 * Query string for `params` plus the signing fields: `wts` (seconds since the epoch) and `w_rid`
 * (MD5 of the sorted, percent-encoded query followed by the mixin key).
 */
export function signWbi(
  params: Record<string, string | number>,
  keys: WbiKeys,
  nowSec: number
): string {
  const all: Record<string, string | number> = { ...params, wts: nowSec }
  const query = Object.keys(all)
    .sort()
    .map((key) => {
      const value = String(all[key] ?? '').replace(/[!'()*]/g, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')
  const wRid = createHash('md5')
    .update(query + wbiMixinKey(keys))
    .digest('hex')
  return `${query}&w_rid=${wRid}`
}
