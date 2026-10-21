// Readers behind the loop (docs/factory-loop/v2/SPEC.md 13.9.2, G2): the image's callum-flow-factory-state
// skipped events of a type or version it cannot read, none of them in the derivation behind the
// report (observe.ts makes the pass blind for those). The owner item `reader-behind` goes out once
// per set of skipped types (key tell:reader-behind:<types>), and again when the set changes. Pure.
import { wake, want } from '../foundation'
import type { V2Ctx } from './types'

export function readerRules(ctx: V2Ctx): void {
  // a factory value cached before the field existed has none
  const skipped = ctx.state.factory?.skipped ?? []
  if (skipped.length === 0 || skipped.some(s => s.derived)) return
  const types = [...new Set(skipped.map(s => `${s.type} v${s.version}`))].sort().join(',')
  const count = skipped.reduce((n, s) => n + s.count, 0)
  want(ctx, wake('tell', 'reader-behind', `tell:reader-behind:${types}`, 'G2', null, { types, count }))
}
