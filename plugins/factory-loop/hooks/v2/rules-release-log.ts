// The release log's two rules (docs/factory-loop/v2/SPEC.md 11, 14.1: O4, O5): they give the
// `released` and `milestone_state` events (docs/metrics.md section 10) their producers. Both opt in
// with the Next release milestone, as O3 does: a repo without one logs nothing. Pure.
//
// O4 logs each new release tag once, through `callum-flow-released` (act-release-log.ts), saying whether
// the loop's own release task made the release or a workflow did. The tag is the newest one the
// milestone reads hold (V2State.tag); the ledger's `released:<repo>:<tag>` entry makes it once.
//
// O5 logs one `milestone_state` event each time the milestone's reading differs from the last one
// logged. Its key, `milestone-state/<fingerprint>/<end of the last entry>`, makes each change once and
// logs a reading that comes back (A, B, A is three events); the fingerprint of the last reading
// logged is the middle segment of the newest done entry.
import { gate, isoOf, skip, want } from '../foundation'
import type { LedgerEntry } from '../types'
import { oneLine } from './events'
import type { MilestoneStateData } from './event-data'
import { milestoneStateKey, releasedKey } from './keys'
import { fnv1a } from './rules-main'
import type { V2Ctx } from './types'

const STATE = 'milestone-state/'

// doneOf: the done entries of a kind, newest end first.
function doneOf(ctx: V2Ctx, pick: (e: LedgerEntry) => boolean): LedgerEntry[] {
  return ctx.state.ledger.filter(e => e.status === 'done' && e.endedAt !== null && pick(e)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
}

const tagOf = (key: string): string => key.split(':')[2] ?? 'unknown'

// releaseTasks: the done release-task entries (the judge's review), newest first.
const releaseTasks = (ctx: V2Ctx) => doneOf(ctx, e => e.kind === 'task' && e.wake === 'release' && e.outcome?.kind === 'wake')

// sourceOf: `loop` when the release task that started the previous release answered done: the previous tag is
// the newest logged one, else the newest done/done task's tag that is not this one. Otherwise `workflow`.
export function sourceOf(ctx: V2Ctx, tag: string): 'loop' | 'workflow' {
  const done = releaseTasks(ctx).filter(e => e.outcome?.kind === 'wake' && e.outcome.decision === 'done')
  const logged = doneOf(ctx, e => e.kind === 'released' && e.key !== releasedKey(ctx.state.repo, tag))[0]
  const other = done.find(e => tagOf(e.key) !== tag)
  const previous = logged === undefined ? (other === undefined ? undefined : tagOf(other.key)) : tagOf(logged.key)
  return previous !== undefined && done.some(e => tagOf(e.key) === previous) ? 'loop' : 'workflow'
}

// releasedRule: O4.
function releasedRule(ctx: V2Ctx): void {
  const tag = ctx.v2.tag
  if (tag == null || ctx.state.milestone === null) return
  const key = releasedKey(ctx.state.repo, tag)
  const source = sourceOf(ctx, tag)
  const g = gate(ctx, key, 'released')
  if (g === 'go') want(ctx, { kind: 'released', key, class: 'free', rule: 'O4', reason: `release ${tag} logged (source ${source})`, issue: null, tag, source })
  else if (g === 'exhausted') skip(ctx, 'O4', null, `exhausted: ${key}: the release ${tag} is not logged`)
}

// readingOf: the milestone's data for the event.
export function readingOf(ctx: V2Ctx): MilestoneStateData | null {
  const { milestone: m, release } = ctx.state
  const lastTag = ctx.v2.tag
  if (m === null || lastTag === undefined) return null
  const hold = releaseTasks(ctx)[0]
  const holding = hold?.outcome?.kind === 'wake' && hold.outcome.decision === 'hold' && tagOf(hold.key) === (lastTag ?? 'none')
  return {
    milestone_closed: m.closed,
    milestone_open: m.open,
    oldest_closed_at: m.oldestClosedAt ?? null,
    last_tag: lastTag,
    oldest_unreleased_merge_at: release !== null && release.tag === lastTag && release.oldest !== null ? isoOf(release.oldest) : null,
    expected: m.expected,
    holding,
    hold_reason: holding && hold?.outcome?.kind === 'wake' && hold.outcome.reason !== null ? oneLine(hold.outcome.reason) : null,
  }
}

// fingerprintOf: the reading's change test: its counts, oldest closed, tag, size and hold, not the merge time.
export function fingerprintOf(d: MilestoneStateData): string {
  return fnv1a(JSON.stringify([d.milestone_closed, d.milestone_open, d.oldest_closed_at, d.last_tag, d.expected, d.holding]))
}

// milestoneRule: O5.
function milestoneRule(ctx: V2Ctx): void {
  if (ctx.state.milestone !== null && ctx.v2.tag === undefined) return skip(ctx, 'O5', null, 'the release tag is not read yet')
  const data = readingOf(ctx)
  if (data === null) return
  const last = doneOf(ctx, e => e.kind === 'event' && e.key.startsWith(STATE))[0]
  const fp = fingerprintOf(data)
  if (last !== undefined && last.key.split('/')[1] === fp) return
  const key = milestoneStateKey(fp, last?.endedAt ?? 0)
  const g = gate(ctx, key, 'event')
  if (g === 'go') want(ctx, { kind: 'event', key, class: 'free', rule: 'O5', reason: `milestone: ${data.milestone_closed} closed, ${data.milestone_open} open${data.holding ? ', holding' : ''}`, issue: null, event: { state: 'milestone_state', data } })
  else if (g === 'exhausted') skip(ctx, 'O5', null, `exhausted: ${key}: the milestone state is not logged`)
}

export function releaseLogRules(ctx: V2Ctx): void {
  releasedRule(ctx)
  milestoneRule(ctx)
}
