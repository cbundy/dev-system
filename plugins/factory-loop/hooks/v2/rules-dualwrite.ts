// dualWriteRules (H1, SPEC 4.1): when dual write starts, each record's current stage the new log lacks
// is logged again, once. It runs for every record, closed ones too, so it sits beside heartbeatRules
// (which returns early with no live record).
import { want } from '../foundation'
import { transitionKey } from './keys'
import type { V2Ctx } from './types'

export function dualWriteRules(ctx: V2Ctx): void {
  const dw = ctx.v2.dualWrite
  if (dw === null) return
  for (const r of ctx.v2.records) {
    // a seq after the read was written to both logs by the dual-writing image
    if (r.seqAt >= dw.readAt) continue
    const id = `${r.issue}:${r.life}:${r.seq}`
    if (dw.seen.has(id)) continue
    const t = ctx.byKey.get(transitionKey(r))
    const o = t?.outcome?.kind === 'transition' ? t.outcome : null
    want(ctx, {
      kind: 'event',
      key: `dual-write:${id}`,
      class: 'free',
      rule: 'H1',
      reason: 'dual write: its stage logged to the new log',
      issue: r.issue,
      event: { state: 'transition', record: r, row: o?.row ?? 'H1', from: o?.from ?? null, via: 'dual-write' },
    })
  }
}
