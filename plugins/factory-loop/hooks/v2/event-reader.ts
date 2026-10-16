// The shared reader of factory events (docs/factory-events/README.md "Versioning"). Pure: it reads
// only event-schemas.ts, which scripts/build-event-docs.js generates from docs/factory-events/schemas/.
//
// readEvent checks the type, version, required fields and their JSON types, ignores unknown fields,
// gives absent optional fields as null and upgrades an older version to the current one.
// validateStrict returns every violation of the supported keywords (tests and the translator use it).
import { CURRENT, SCHEMAS, type Shape } from "./event-schemas"

export type Data = Record<string, unknown>
export type Upgrade = (data: Data) => Data
export interface Event {
  type: string
  type_version: number
  data: Data
}

// One pure step per "<type>.v<N>", from v<N> to v<N+1>. scripts/build-event-docs.js --check fails
// when an older version has no step. A step receives the data with every property of v<N> (absent
// optional ones null) and returns the data of v<N+1>; the reader fills in the rest with null.
// Keep one step per line, quoted, so the check can find it.
export const UPGRADES: Record<string, Upgrade> = {}

const ISO_DATE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/

const isObject = (v: unknown): v is Data => v !== null && typeof v === "object" && !Array.isArray(v)

const jsonTypeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v)

function matchesType(want: string, v: unknown): boolean {
  if (want === "integer") return typeof v === "number" && Number.isInteger(v)
  if (want === "number") return typeof v === "number" && Number.isFinite(v)
  return jsonTypeOf(v) === want
}

const wantedTypes = (s: Shape): string[] => (s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type])

// Every violation of the supported keywords by value, as "<path>: <what>" lines.
function violations(s: Shape, v: unknown, path: string, out: string[]): void {
  const at = (msg: string) => out.push(`${path}: ${msg}`)
  const want = wantedTypes(s)
  if (want.length > 0 && !want.some((t) => matchesType(t, v))) {
    at(`must be ${want.join(" or ")}, got ${jsonTypeOf(v)}`)
    return
  }
  if (s.const !== undefined && v !== s.const) at(`must be ${JSON.stringify(s.const)}`)
  if (s.enum !== undefined && !s.enum.includes(v)) at(`must be one of ${s.enum.map((x) => JSON.stringify(x)).join(", ")}`)
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) at(`must be at least ${s.minimum}`)
    if (s.maximum !== undefined && v > s.maximum) at(`must be at most ${s.maximum}`)
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) at(`must be at least ${s.minLength} characters`)
    if (s.maxLength !== undefined && v.length > s.maxLength) at(`must be at most ${s.maxLength} characters`)
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(v)) at(`must match ${s.pattern}`)
    if (s.format === "date-time" && !(ISO_DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)))) at("must be a date-time")
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) at(`must have at least ${s.minItems} items`)
    if (s.maxItems !== undefined && v.length > s.maxItems) at(`must have at most ${s.maxItems} items`)
    if (s.items !== undefined) v.forEach((item, i) => violations(s.items as Shape, item, `${path}[${i}]`, out))
  }
  if (isObject(v)) {
    const props = s.properties ?? {}
    for (const r of s.required ?? []) if (!(r in v)) out.push(`${path ? `${path}.` : ""}${r}: is required`)
    for (const [k, val] of Object.entries(v)) {
      const sub = props[k]
      const p = path ? `${path}.${k}` : k
      if (sub !== undefined) violations(sub, val, p, out)
      else if (s.additionalProperties === false) out.push(`${p}: unknown field`)
    }
  }
}

// The reader over a catalogue: the real one below, or a synthetic one in tests.
export function createReader(schemas: Record<string, Shape>, current: Record<string, number>, upgrades: Record<string, Upgrade>) {
  const unknown = (type: unknown, version: unknown) => new Error(`unknown factory event: ${String(type)} v${String(version)}`)

  function shapeOf(type: unknown, version: unknown): Shape {
    const shape =
      typeof type === "string" && typeof version === "number" && Object.prototype.hasOwnProperty.call(current, type) && Number.isInteger(version)
        ? schemas[`${type}.v${version}`]
        : undefined
    if (shape === undefined) throw unknown(type, version)
    return shape
  }

  // Every property of the shape, absent ones null, unknown ones dropped.
  const project = (shape: Shape, data: Data): Data => {
    const out: Data = {}
    for (const k of Object.keys(shape.properties ?? {})) out[k] = k in data && data[k] !== undefined ? data[k] : null
    return out
  }

  function readEvent(event: unknown): Event {
    if (!isObject(event)) throw new Error("factory event is not an object")
    if ("envelope" in event && event.envelope !== 1) throw new Error(`unknown factory event envelope: ${JSON.stringify(event.envelope)}`)
    const { type, type_version: version, data } = event
    const shape = shapeOf(type, version)
    const label = `factory event ${String(type)} v${String(version)}`
    if (!isObject(data)) throw new Error(`${label}: data must be an object`)
    for (const r of shape.required ?? []) {
      if (!(r in data) || data[r] === undefined) throw new Error(`${label}: field ${r} is missing`)
    }
    for (const [name, sub] of Object.entries(shape.properties ?? {})) {
      const want = wantedTypes(sub)
      if (name in data && want.length > 0 && !want.some((t) => matchesType(t, data[name]))) {
        throw new Error(`${label}: field ${name} must be ${want.join(" or ")}, got ${jsonTypeOf(data[name])}`)
      }
    }
    let v = version as number
    let out = project(shape, data)
    const newest = current[type as string]
    while (v < newest) {
      const step = upgrades[`${type as string}.v${v}`]
      if (step === undefined) throw new Error(`${label}: no upgrade step from v${v} to v${v + 1}`)
      v += 1
      out = project(shapeOf(type, v), step(out))
    }
    return { type: type as string, type_version: newest, data: out }
  }

  function validateStrict(type: string, version: number, value: unknown): string[] {
    const shape = schemas[`${type}.v${version}`]
    if (shape === undefined) return [`unknown factory event: ${type} v${version}`]
    const out: string[] = []
    violations(shape, value, "", out)
    return out.map((line) => (line.startsWith(": ") ? line.slice(2) : line))
  }

  return { readEvent, validateStrict }
}

export const { readEvent, validateStrict } = createReader(SCHEMAS, CURRENT, UPGRADES)
