// The record's rules (docs/factory-loop/v2/SPEC.md 3, 4, 5, 11, 14.1): H1 renews and re-claims
// (rules-claim.ts); for each record, S3 plans its seq's entry actions (rules-entry.ts), then the
// one event that changes it this pass, the first present in 4.1's order (pr-merged, issue-closed,
// claim-lost, drop, pr-closed, the step's result, unpark), through the table (table.ts rowFor): a
// changing row is one `transition` action (S3 for a step result, S4 the unknown path, S5 triage,
// S6 the owner's and GitHub's events), and the rows that change nothing (E6's tell, E7's log line)
// run beside it and never stop it; S2 starts the record's step through its plan when nothing else
// takes the record (rules-agent.ts, and each unit's own step plans); then S0 and S1 make records
// and claim new work (rules-claim.ts). And O1's counts, which the title and the decision log show.
//
// - A running step past its timeout is unknown (timeout), in every state; a waiting record's
//   timeout is its tell period (E6); a held step has no clock (4.4).
// - GitHub events are edges (4.1): pr-closed compares GitHub's closedAt with the record's
//   prClosedAt, a drop and an unpark compare the op's time with the life's claim and the park.
// - 4.1's order holds across sources: the PRs are read every pass, the issue less often, so a
//   PR's close waits for a read of its issue made after it (observe makes that read due), and an
//   issue closed with its PR closes rather than parks.
// - The next transition waits until the seq's `transition` event is logged (3.3), and an effect
//   that used up its attempts holds the record's step (4.5).
// - Every record that is not closed ends a pass with a running step, a planned action or a skip
//   line naming why it waits (property 3).
//
// Pure: the time is state.now.
import { skip, wake, want } from '../foundation'
import type { Ms } from '../types'
import { entryKey, hiddenKey, lifeAt, transitionKey } from './keys'
import { ticksOf, tickNote } from './park-text'
import { agentPlan, causeOf, leaseOf, leaseStep, lifeEntries, notBuiltStep, triggerOf } from './rules-agent'
import type { StepPlan, StepRead } from './rules-agent'
import { claimRules, heartbeatRules, reclaimLost } from './rules-claim'
import { dualWriteRules } from './rules-dualwrite'
import { shadowRules } from './rules-shadow'
import { ensureActions, entryDone, entryItems, parkedTell, stalledOf, stalledTell, transitionLogged } from './rules-entry'
import type { EntryItem } from './rules-entry'
import { PLANS as QUEUE, dontMergeOf } from './rules-queue'
import { PLANS as REVIEW, lifePr } from './rules-review'
import { PLANS as WORK } from './rules-work'
import { waitKey } from './sources-waits'
import { mayHaveMerged } from './steps-queue'
import { nextRecord, normalize, rowFor, viaOf } from './table'
import { FACTORY_LABELS } from './types'
import { workspaceHold } from './workspace'
import type { IssueRecord, Row, StepKind, TableEvent, Trigger, V2Ctx, WaitCondition } from './types'

const HOUR = 3_600_000
// The title's M: issues merged in this window (D-23).
const MERGED_WINDOW_MS = 6 * HOUR
const NOTE_MAX = 2000

// Each step's plan: the generic agent step and the lease here, each unit's own over them (U5's
// work steps, U6's review, U7's merge queue), triage always the generic agent step.
const PLANS: Readonly<Record<StepKind, StepPlan>> = {
  lease: leaseStep,
  design: agentPlan('design'),
  build: agentPlan('build'),
  fix: agentPlan('fix'),
  review: notBuiltStep('review', 'U6'),
  queue: notBuiltStep('queue', 'U7'),
  ...WORK,
  ...REVIEW,
  ...QUEUE,
  triage: agentPlan('triage'),
}

// An event present for a record this pass, and what its transition re-checks; wait: why the
// record holds instead, when an event before it in 4.1's order may not be read yet.
type Present = { event: TableEvent; trigger: Trigger; wait?: string }

const fact = (f: string): Trigger => ({ kind: 'fact', fact: f })

// ruleOf: the rule id a row's transition is planned under (14.1).
function ruleOf(row: Row): string {
  if (row.id === 'S0') return 'S1'
  if (row.id.startsWith('U')) return 'S4'
  if (row.id.startsWith('X')) return 'S5'
  return row.id.startsWith('T') ? 'S3' : 'S6'
}

function describe(e: TableEvent): string {
  const tail = e.choice ?? e.why ?? e.reason
  const text = `${e.kind}${tail === undefined ? '' : ` (${tail})`}`
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

const sameSha = (a: string | null, b: string | null) => a !== null && b !== null && (a.startsWith(b) || b.startsWith(a))

// --- the owner's and GitHub's events (4.1) ---------------------------------------------------------------

// loopMerged: a queue-merge of this life merged, or may have (running or lost), at this head when
// one is given: the merge is the queue step's own result, never a hand merge (4.1). A refusal,
// done but not merged, is not one.
function loopMerged(ctx: V2Ctx, r: IssueRecord, head: string | null): boolean {
  return lifeEntries(ctx, r, 'queue-merge').some(e => mayHaveMerged(e) && (head === null || sameSha(e.head, head)))
}

// earlyEvents: the events present before the step's result, in 4.1's order.
function earlyEvents(ctx: V2Ctx, r: IssueRecord): Present[] {
  const out: Present[] = []
  const n = r.issue
  const born = lifeAt(r.life) ?? 0
  // the life's PR: the record's, else the one the review step's ensure named (8.1), so a PR merged
  // or closed by hand during its first review round is seen too
  const known = lifePr(ctx.state.ledger, r)
  const pr = known === null ? undefined : ctx.v2.prs.prs.find(p => p.pr === known)
  if (pr?.state === 'merged' && !loopMerged(ctx, r, pr.mergedHead)) {
    out.push({ event: { kind: 'pr-merged', data: { pr: pr.pr, ...(pr.mergedHead === null ? {} : { head: pr.mergedHead }) } }, trigger: fact(`pr-merged:${pr.pr}@${pr.mergedHead ?? 'unknown'}`) })
  }
  const read = ctx.v2.reads[n]
  const closedByLoop = loopMerged(ctx, r, null) || ctx.state.ledger.some(e => e.kind === 'close-issue' && e.issue === n && e.startedAt >= born && e.status !== 'failed')
  if (read !== undefined && read.open === false && read.at > born && !closedByLoop) out.push({ event: { kind: 'issue-closed' }, trigger: fact(`issue-closed:${n}@${read.at}`) })
  const lost = reclaimLost(ctx, r)
  if (lost !== null) out.push({ event: { kind: 'claim-lost', reason: lost.summary ?? 'another device holds a live claim' }, trigger: triggerOf(lost) })
  const drop = ctx.state.control.dropped.filter(d => d.issue === n && d.at > born).sort((a, b) => a.at - b.at).at(-1)
  if (drop !== undefined) out.push({ event: { kind: 'drop' }, trigger: fact(`drop:${n}@${drop.at}`) })
  if (pr?.state === 'closed' && pr.closedAt !== null && (r.prClosedAt === null || pr.closedAt > r.prClosedAt)) {
    const since = ctx.v2.changed[n]
    const wait = since !== undefined && (read === undefined || read.at <= since) ? { wait: `issue #${n} is not read since PR #${pr.pr} closed` } : {}
    out.push({ event: { kind: 'pr-closed', data: { pr: pr.pr, closedAt: pr.closedAt } }, trigger: fact(`pr-closed:${pr.pr}@${pr.closedAt}`), ...wait })
  }
  return out
}

// unparkOf: a parked or waiting record's unpark (4.1, 11): a `/factory resume N` newer than the park, with
// its note; or a read of the issue made after the park's label write that lacks `factory:parked`,
// with the owner's tick in the park's comment (the one of this seq) and the trusted comments
// posted after it as the note. 'wait': the label is
// gone, but those comments are not read yet.
function unparkOf(ctx: V2Ctx, r: IssueRecord): Present | 'wait' | null {
  const n = r.issue
  const pr = r.pr === null ? undefined : ctx.v2.prs.prs.find(p => p.pr === r.pr)
  const closedAt = pr?.state === 'closed' && pr.closedAt !== null ? { closedAt: pr.closedAt } : {}
  const ops = ctx.state.control.resumed.filter(x => x.subject === `issue:${n}` && x.at > r.since).sort((a, b) => a.at - b.at)
  const op = ops.at(-1)
  if (op !== undefined) {
    const note = ops.flatMap(x => (x.note === undefined ? [] : [x.note])).join('\n')
    return { event: { kind: 'unpark', reason: 'op', data: { ...closedAt, ...(note === '' ? {} : { note: clip(note) }) } }, trigger: fact(`unpark:${n}@${op.at}`) }
  }
  // a waiting record is resumed by the owner's op alone: a removed factory:waiting label is not one (11)
  if (r.state === 'waiting') return null
  const label = ctx.byKey.get(entryKey(r, 'label'))
  const read = ctx.v2.reads[n]
  if (label?.status !== 'done' || label.endedAt === null || read === undefined || read.at <= label.endedAt || read.labels === null) return null
  if (read.labels.some(l => l.toLowerCase() === FACTORY_LABELS.parked.name)) return null
  const comments = ctx.v2.comments[n]
  if (comments === undefined) return 'wait'
  const after = ctx.byKey.get(entryKey(r, 'comment'))?.endedAt ?? r.since
  // the owner's tick in this seq's park comment, current body, comes first; the factory's other
  // comments never become notes
  const marker = hiddenKey(entryKey(r, 'comment'))
  const parkComment = comments.find(c => c.body.includes(marker))
  const tick = parkComment === undefined ? null : tickNote(ticksOf(parkComment.body))
  const note = [...(tick === null ? [] : [tick]), ...comments.filter(c => c.at > after && !c.body.includes('<!-- factory-loop:')).map(c => c.body.trim())].join('\n\n')
  return { event: { kind: 'unpark', reason: 'label', data: { ...closedAt, ...(note === '' ? {} : { note: clip(note) }) } }, trigger: fact(`unpark-label:${n}@${read.at}`) }
}

function clip(text: string): string {
  return text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 3)}...` : text
}

// --- E6: the waiting states' tells (4.4) ---------------------------------------------------------------

// periodOf: a waiting state's tell period: queued, the merge queue behind its head, parked, waiting.
function periodOf(ctx: V2Ctx, r: IssueRecord): Ms {
  const t = ctx.config.stateTimeoutMs
  return r.state === 'parked' ? t.parked : r.state === 'waiting' ? t.waiting : r.state === 'queued' ? t.queued : t.queueWait
}

// openOf: the conditions of a waiting record no read has shown to hold (4.4): a condition not read,
// or whose read failed or was skipped, is open.
function openOf(ctx: V2Ctx, r: IssueRecord): WaitCondition[] {
  return (r.wait ?? []).filter(c => ctx.v2.waits?.[waitKey(c)]?.held !== true)
}

// clearedData: the tag the record's tag-contains reads compared against, for the cleared note.
function clearedData(ctx: V2Ctx, r: IssueRecord): { tag: string } | undefined {
  for (const c of r.wait ?? []) {
    const tag = c.kind === 'tag-contains' ? ctx.v2.waits?.[waitKey(c)]?.tag : undefined
    if (tag !== undefined) return { tag }
  }
  return undefined
}

// openText: the open conditions in words, for the skip line and E6's tell.
function openText(open: readonly WaitCondition[]): string {
  return open.map(c => (c.kind === 'issue-closed' ? `#${c.issue} (still open)` : c.kind === 'pr-merged' ? `PR #${c.pr} (not merged yet)` : `no release tag contains ${c.sha} yet`)).join(', ')
}

// waitingRules: a waiting record's events after the early ones (4.1): C1 when every condition
// holds, else E6's tell once a period has passed, and the owner's resume (P1).
function waitingRules(ctx: V2Ctx, r: IssueRecord, logged: boolean): void {
  const n = r.issue
  const open = openOf(ctx, r)
  if (open.length === 0 && (r.wait ?? []).length > 0) {
    if (take(ctx, r, { event: { kind: 'cleared', data: clearedData(ctx, r) }, trigger: fact(`cleared:${n}@${r.seq}`) }, logged, '')) return
  }
  if (ctx.state.now - r.since >= periodOf(ctx, r)) take(ctx, r, { event: { kind: 'timeout' }, trigger: fact(`waiting:${n}`) }, logged, `waiting for ${openText(open)}`)
  const u = unparkOf(ctx, r)
  if (u === null || u === 'wait') skip(ctx, 'S6', n, `waiting: for ${open.length === 0 ? 'its clear' : openText(open)}`)
  else take(ctx, r, u, logged, '')
}

// waitTell: E6, once per period: tell(waiting), or tell(parked) as the daily reminder (an owner
// item, counted once per record).
function waitTell(ctx: V2Ctx, r: IssueRecord, why: string): void {
  const k = Math.floor((ctx.state.now - r.since) / periodOf(ctx, r))
  if (k < 1) return
  if (r.state === 'parked') {
    want(ctx, parkedTell(r, k))
    ctx.owner.delete(entryKey(r, 'tell'))
    return
  }
  const hours = Math.floor((ctx.state.now - r.since) / HOUR)
  want(ctx, wake('tell', 'waiting', `${entryKey(r, 'tell')}/waiting/${k}`, 'S6', r.issue, { issue: r.issue, state: r.state, hours }, [why]))
}

// --- one record ----------------------------------------------------------------------------------------------

// take: the row for this event. A changing row plans its transition, once the seq's transition
// event is logged; E6 tells and E7 logs, and neither stops the next event. True when the record
// is taken this pass.
function take(ctx: V2Ctx, r: IssueRecord, p: Present, logged: boolean, why: string): boolean {
  const row = rowFor(r, p.event, ctx.config)
  if (row.id === 'E7') {
    skip(ctx, 'S6', r.issue, `E7: ${describe(p.event)} means nothing in ${r.state}${r.step === null ? '' : `/${r.step}`}`)
    return false
  }
  if (row.id === 'E6') {
    waitTell(ctx, r, why)
    return false
  }
  const rule = ruleOf(row)
  if (!logged || p.wait !== undefined) {
    skip(ctx, rule, r.issue, `${row.id} waits: ${p.wait ?? `the transition event of seq ${r.seq} is not logged yet`}`)
    return true
  }
  const ev = normalize(r, p.event)
  const next = nextRecord(r, row, p.event, ctx.state.now)
  const key = transitionKey(next)
  const g = want(ctx, {
    kind: 'transition',
    key,
    class: 'free',
    rule,
    reason: `${row.id}: ${describe(ev)}`,
    issue: r.issue,
    row: row.id,
    event: p.event.kind,
    from: { issue: r.issue, life: r.life, seq: r.seq },
    fromState: r.state,
    fromStep: r.step,
    next,
    trigger: p.trigger,
    cause: ev.cause ?? null,
    via: viaOf(row, ev),
  })
  if (g === 'exhausted') {
    const e = ctx.byKey.get(key)
    skip(ctx, rule, r.issue, `stalled: ${key}: ${e?.summary ?? 'used up its attempts'}`)
    want(ctx, stalledTell(r, key, e?.summary ?? 'used up its attempts', e?.endedAt ?? 0))
  }
  return true
}

// stepRead: the record's step this pass, through its plan.
function stepRead(ctx: V2Ctx, r: IssueRecord, start: boolean, hold: string | null): StepRead | null {
  if (r.step === null) return null
  return PLANS[r.step]({ ctx, r, slot: leaseOf(ctx, r), start, hold })
}

function recordRules(ctx: V2Ctx, r: IssueRecord, items: readonly EntryItem[]): void {
  const { state } = ctx
  const n = r.issue
  const mark = { out: ctx.out.length, skipped: ctx.skipped.length }
  for (const item of items) {
    // a best-effort action that ended is done with, however it ended
    const e = item.soft ? ctx.byKey.get(item.action.key) : undefined
    if (e === undefined || e.status === 'running') want(ctx, item.action)
  }
  const stalled = stalledOf(ctx, r)
  if (stalled !== null) {
    skip(ctx, 'S3', n, `stalled: ${stalled.key}: ${stalled.error}`)
    want(ctx, stalledTell(r, stalled.key, stalled.error, stalled.at))
  }
  if (r.state === 'closed') return
  const logged = transitionLogged(ctx, r)
  for (const p of earlyEvents(ctx, r)) if (take(ctx, r, p, logged, '')) return
  let running = false
  if (r.state === 'waiting') {
    waitingRules(ctx, r, logged)
  } else if (r.state === 'parked') {
    if (state.now - r.since >= periodOf(ctx, r)) take(ctx, r, { event: { kind: 'timeout' }, trigger: fact(`parked:${n}`) }, logged, 'parked')
    const u = unparkOf(ctx, r)
    if (u === 'wait') skip(ctx, 'S6', n, 'unpark: the label is off; waits for the trusted comments to be read')
    else if (u === null) skip(ctx, 'S6', n, 'parked: waits on the owner')
    else take(ctx, r, u, logged, '')
  } else {
    const hold = !logged ? `its transition event of seq ${r.seq} is not logged yet` : stalled !== null ? `stalled: ${stalled.key}` : !entryDone(ctx, items) ? 'its entry actions run first' : workspaceHold(ctx, r.step)
    const read = stepRead(ctx, r, hold === null, hold)
    if (read?.kind === 'running') {
      running = true
      if (state.now - read.since > read.timeoutMs) {
        const entry = ctx.byKey.get(read.key) ?? null
        const reason = `${r.step ?? 'the step'} ran past its ${Math.round(read.timeoutMs / 60_000)} min`
        // a running step's timeout is its unknown, whatever the state: E6's tell is only for a
        // record that waits (below), so a hung merge-queue head takes U1 to U4 (4.3, 4.4)
        const event: TableEvent = { kind: 'unknown', why: 'timeout', reason, cause: causeOf(ctx, r, entry, 'timeout') ?? undefined }
        take(ctx, r, { event, trigger: entry === null ? fact(`timeout:${read.key}`) : triggerOf(entry) }, logged, '')
      }
    } else if (read?.kind === 'result') {
      if (stalled === null) take(ctx, r, { event: read.event, trigger: read.trigger }, logged, '')
    } else if (read?.kind === 'waiting') {
      if (state.now - r.since >= periodOf(ctx, r)) take(ctx, r, { event: { kind: 'timeout' }, trigger: fact(`waiting:${n}`) }, logged, read.why)
      skip(ctx, 'S2', n, read.why)
    } else if (read?.kind === 'held' && read.why !== '') {
      skip(ctx, r.step === 'triage' ? 'S5' : 'S2', n, read.why)
    }
  }
  // property 3: no record is silent
  const acted = ctx.out.slice(mark.out).some(a => a.issue === n)
  const said = ctx.skipped.slice(mark.skipped).some(s => s.issue === n)
  if (!acted && !said && !running) skip(ctx, 'S2', n, `${r.state}${r.step === null ? '' : `/${r.step}`}: its planned work runs`)
}

// stateRules: H1, then each record (S2 to S6), then S0 and S1. The seven labels are made first on a
// pass that writes one (3.4).
export function stateRules(ctx: V2Ctx): void {
  heartbeatRules(ctx)
  dualWriteRules(ctx)
  shadowRules(ctx)
  const records = [...ctx.v2.records].sort((a, b) => a.issue - b.issue || (lifeAt(a.life) ?? 0) - (lifeAt(b.life) ?? 0))
  const items = records.map(r => entryItems(ctx, r, leaseOf(ctx, r)))
  const labels = items.some(list => list.some(i => i.action.kind === 'label' && ctx.byKey.get(i.action.key)?.status !== 'done'))
  if (labels) for (const a of ensureActions(ctx)) want(ctx, a)
  records.forEach((r, i) => recordRules(ctx, r, items[i] ?? []))
  claimRules(ctx)
}

// The records by where they are: queued, in flight (designing to merge-queue) and parked.
export type StateCounts = { queued: number; flight: number; parked: number; waiting: number }

export function stateCounts(records: readonly IssueRecord[]): StateCounts {
  const out: StateCounts = { queued: 0, flight: 0, parked: 0, waiting: 0 }
  for (const r of records) {
    if (r.state === 'queued') out.queued += 1
    else if (r.state === 'parked') out.parked += 1
    else if (r.state === 'waiting') out.waiting += 1
    else if (r.state !== 'closed') out.flight += 1
  }
  return out
}

// stateTitle: the title's counts, Q (the ready queue and the queued records), D (in flight) and M
// (merged in the last 6 hours), and its words of the layer's own: parked <n>, waiting <n>, held <n>.
export function stateTitle(ctx: V2Ctx): { counts: string; after: string[] } {
  const c = stateCounts(ctx.v2.records)
  // held: the queue records the owner's `don't-merge` label holds (they are in flight as well)
  const held = ctx.v2.records.filter(r => r.state === 'merge-queue' && r.step === 'queue' && dontMergeOf(ctx, r) !== null).length
  const merged = ctx.v2.records.filter(r => r.state === 'closed' && (r.why === 'merged' || r.why === 'merged-by-hand') && ctx.state.now - r.since <= MERGED_WINDOW_MS).length
  return { counts: `Q:${ctx.state.queue.length + c.queued} - D:${c.flight} - M:${merged}`, after: [...(c.parked > 0 ? [`parked ${c.parked}`] : []), ...(c.waiting > 0 ? [`waiting ${c.waiting}`] : []), ...(held > 0 ? [`held ${held}`] : [])] }
}
