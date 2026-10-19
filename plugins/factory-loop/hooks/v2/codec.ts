// The note's value codec (events.ts, park-parts.ts): a value with no space in it, and `none` for null.

export const NONE = 'none'

// enc: a value with no space in it: `%` and whitespace percent-encoded, so URLs stay readable.
export function enc(v: string): string {
  return v.replace(/[%\s]/g, c => encodeURIComponent(c))
}

export function dec(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

// A string, or `none` for null. A string that is literally `none` has its first letter encoded,
// so it reads back as itself.
export function str(v: string | null): string {
  if (v === null) return NONE
  return v === NONE ? '%6Eone' : enc(v)
}

export function unstr(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined
  return v === NONE ? null : dec(v)
}

