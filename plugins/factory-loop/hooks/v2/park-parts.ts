// The parts of a structured park question and how each place holds them (docs/factory-loop/v2/SPEC.md
// 3.2, 7.1): the transition note's five tokens (events.ts), the new log's payload (record.ts) and a
// stored record (observe.ts). One option validator serves all three. Imports only the note codec.
import { NONE, dec, str, unstr } from './codec'
import type { OptionKey, ParkParts } from './types'

const KEYS: readonly OptionKey[] = ['A', 'B', 'C', 'D', 'E', 'F']
type Option = NonNullable<ParkParts['options']>[number]

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const keyOf = (v: unknown): OptionKey | undefined => KEYS.find(k => k === v)

// optionsOf: 2 to 6 options with distinct keys, each {key, title, detail}; an absent detail reads as
// null. null when absent; undefined when it does not read.
function optionsOf(v: unknown): Option[] | null | undefined {
  if (v === undefined || v === null) return null
  if (!Array.isArray(v) || v.length < 2 || v.length > 6) return undefined
  const out: Option[] = []
  for (const x of v) {
    if (!isRec(x)) return undefined
    const key = keyOf(x.key)
    if (key === undefined || out.some(o => o.key === key) || typeof x.title !== 'string') return undefined
    if (x.detail !== undefined && x.detail !== null && typeof x.detail !== 'string') return undefined
    out.push({ key, title: x.title, detail: typeof x.detail === 'string' ? x.detail : null })
  }
  return out
}

const textOrNull = (v: unknown): string | null | undefined => (v === undefined || v === null ? null : typeof v === 'string' ? v : undefined)

// build: the parts from already-typed fields, undefined when `recommended` names no option.
function build(decision: string, context: string | null, options: Option[] | null, recommended: unknown, recommendation: string | null): ParkParts | undefined {
  const rec = recommended === undefined || recommended === null ? null : keyOf(recommended)
  if (rec === undefined || (rec !== null && !(options ?? []).some(o => o.key === rec))) return undefined
  return { decision, context, options, recommended: rec, recommendation }
}

// partsTokens: the five note tokens, all `none` when there are no parts.
export function partsTokens(p: ParkParts | null): string[] {
  return [
    `decision=${str(p === null ? null : p.decision)}`,
    `context=${str(p === null ? null : p.context)}`,
    `options=${p === null || p.options === null ? NONE : encodeURIComponent(JSON.stringify(p.options))}`,
    `recommended=${str(p === null ? null : p.recommended)}`,
    `recommendation=${str(p === null ? null : p.recommendation)}`,
  ]
}

// partsOfTokens: the parts a note's tokens hold. null: an older note without `decision=`, or
// `decision=none`; undefined: the tokens do not read.
export function partsOfTokens(get: (key: string) => string | undefined): ParkParts | null | undefined {
  const decision = unstr(get('decision'))
  if (decision === undefined || decision === null) return null
  const o = get('options')
  let json: unknown = null
  if (o !== undefined && o !== NONE) {
    try {
      json = JSON.parse(dec(o))
    } catch {
      return undefined
    }
    if (json === null) return undefined
  }
  const options = optionsOf(json)
  if (options === undefined) return undefined
  return build(decision, unstr(get('context')) ?? null, options, unstr(get('recommended')), unstr(get('recommendation')) ?? null)
}

// partsOfData: the parts a new-log transition payload holds; null when its decision is absent or null.
export function partsOfData(d: Record<string, unknown>): ParkParts | null {
  if (typeof d.decision !== 'string') return null
  const options = optionsOf(d.options)
  const p = build(d.decision, textOrNull(d.context) ?? null, options ?? null, d.recommended, textOrNull(d.recommendation) ?? null)
  return p ?? null
}

// partsOfStored: the parts a stored record holds, checked field by field. null: absent or null;
// undefined: it does not read.
export function partsOfStored(v: unknown): ParkParts | null | undefined {
  if (v === undefined || v === null) return null
  if (!isRec(v) || typeof v.decision !== 'string') return undefined
  const context = textOrNull(v.context)
  const recommendation = textOrNull(v.recommendation)
  const options = optionsOf(v.options)
  if (context === undefined || recommendation === undefined || options === undefined) return undefined
  return build(v.decision, context, options, v.recommended, recommendation)
}

// partsOfAnswer: the parts of a checked question answer (question.mjs shapes: `recommendation` is
// {key, reason}) whose decision sentence is `decision`. null when the optional fields do not read.
export function partsOfAnswer(decision: string, a: Record<string, unknown>): ParkParts | null {
  const options = optionsOf(a.options)
  const rec = isRec(a.recommendation) ? a.recommendation : null
  const context = textOrNull(a.context)
  const reason = rec === null ? null : textOrNull(rec.reason)
  if (options === undefined || context === undefined || reason === undefined) return null
  return build(decision.trim(), context, options, rec === null ? null : rec.key, reason) ?? null
}
