// The shadow compares of the event-log reads (docs/factory-loop/v2/SPEC.md 3.3, sources-records.ts,
// sources-facts.ts): each compare is logged once as a `shadow_read` event (keyed by the time it was
// made, free), and a compare that found settled differences tells the owner once per distinct set of
// differing keys, with the first difference and the way back. Runs for every pass that holds a compare:
// the keys make it once. The records' compare differs by issue, the facts' by key.
import { want, wake } from '../foundation'
import type { ShadowReadData } from './events'
import type { V2Ctx } from './types'

type Shadow = { at: number; data: ShadowReadData }

// What differs between the two compares: the wake and key prefix, what a difference names, and what it means.
type Kind = { name: string; noun: string; unit: string; meaning: string }

const RECORDS: Kind = {
  name: 'records-shadow',
  noun: 'issues',
  unit: 'issues',
  meaning: 'the new event store rebuilds different records than the old one, so it is not safe to read yet; the loop still uses the old one',
}
const FACTS: Kind = {
  name: 'facts-shadow',
  noun: 'keys',
  unit: 'compared items',
  meaning: 'the new event store gives different facts, ledger entries or logged keys than the old one, so it is not safe to read yet; the loop still uses the old one',
}

export function shadowRules(ctx: V2Ctx): void {
  const r = ctx.v2.recordsShadow
  if (r !== undefined) {
    const issues = r.diffs.map(d => d.issue).sort((a, b) => a - b)
    run(ctx, RECORDS, r, issues.map(n => `#${n}`), issues.join(','))
  }
  const f = ctx.v2.factsShadow
  if (f !== undefined) {
    const keys = f.diffs.map(d => d.key).slice(0, 50)
    run(ctx, FACTS, f, keys, keys.join(',').replace(/\s+/g, '_'))
  }
}

// run: the compare's event, then its tell when it found differences. names: what each difference is
// called to the owner; tellKey: the distinct set it is told once for.
function run(ctx: V2Ctx, kind: Kind, s: Shadow, names: string[], tellKey: string): void {
  want(ctx, {
    kind: 'event',
    key: `${kind.name}:${s.at}`,
    class: 'free',
    rule: 'H1',
    reason: `${kind.name.replace('-', ' ')}: ${s.data.differences} differences in ${s.data.compared} ${kind.unit}`,
    issue: null,
    event: { state: 'shadow_read', data: s.data },
  })
  if (s.data.differences === 0) return
  const list = names.join(', ')
  want(
    ctx,
    wake('tell', kind.name, `tell:${kind.name}:${tellKey}`, 'H1', null, { [kind.noun]: list, differences: s.data.differences }, [
      `${kind.noun}: ${list}`,
      `first: ${s.data.detail ?? 'none'}`,
      `meaning: ${kind.meaning}`,
      'back: /factory config set eventsSource old',
    ]),
  )
}
