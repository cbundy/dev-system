// The shadow compares' equality (sources-records.ts, sources-facts.ts): two values are the same when
// their JSON is, with object keys in sorted order at every depth, so a different key order is no
// difference. Array order, value types and missing keys still are (JSON semantics: undefined drops).
const sorted = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sorted)
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().map(k => [k, sorted(o[k])]))
  }
  return v
}

export const canonicalJson = (v: unknown): string | undefined => JSON.stringify(sorted(v))

export const sameValue = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)
