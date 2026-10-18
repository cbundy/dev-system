// The record rebuild's shadow compare (docs/factory-loop/v2/SPEC.md 3.3, sources-records.ts): each
// compare is logged once as a `shadow_read` event (keyed by the time it was made, free), and a compare
// that found settled differences tells the owner once per distinct set of differing issues, with the
// first difference and the way back. Runs for every pass that holds a compare: the keys make it once.
import { want, wake } from '../foundation'
import type { V2Ctx } from './types'

export function shadowRules(ctx: V2Ctx): void {
  const s = ctx.v2.recordsShadow
  if (s === undefined) return
  want(ctx, {
    kind: 'event',
    key: `records-shadow:${s.at}`,
    class: 'free',
    rule: 'H1',
    reason: `records shadow: ${s.data.differences} differences in ${s.data.compared} issues`,
    issue: null,
    event: { state: 'shadow_read', data: s.data },
  })
  if (s.data.differences === 0) return
  const issues = s.diffs.map(d => d.issue).sort((a, b) => a - b)
  const list = issues.map(n => `#${n}`).join(', ')
  want(
    ctx,
    wake('tell', 'records-shadow', `tell:records-shadow:${issues.join(',')}`, 'H1', null, { issues: list, differences: s.data.differences }, [
      `issues: ${list}`,
      `first: ${s.data.detail ?? 'none'}`,
      'meaning: the new event store rebuilds different records than the old one, so it is not safe to read yet; the loop still uses the old one',
      'back: /factory config set eventsSource old',
    ]),
  )
}
