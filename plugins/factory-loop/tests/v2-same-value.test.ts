// sameValue (v2/same-value.ts): JSON equality that ignores object key order at any depth.
import { describe, expect, test } from 'claude-code/testing'

import { sameValue } from '../hooks/v2/same-value'

describe('sameValue', () => {
  test('key order is ignored in nested objects and in objects inside arrays', () => {
    expect(sameValue({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true)
    expect(sameValue([{ kind: 'pr-merged', pr: 997 }], [{ pr: 997, kind: 'pr-merged' }])).toBe(true)
  })
  test('array order, types and missing keys differ', () => {
    expect(sameValue([1, 2], [2, 1])).toBe(false)
    expect(sameValue({ a: 1 }, { a: '1' })).toBe(false)
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(true)
  })
  test('primitives and null', () => {
    expect(sameValue(null, null)).toBe(true)
    expect(sameValue(null, undefined)).toBe(false)
    expect(sameValue(1, 1)).toBe(true)
    expect(sameValue('a', 'b')).toBe(false)
  })
})
