// The interventions (docs/factory-loop/v2/SPEC.md 7.2), derived, never emitted ad hoc: one
// `intervention` event for each fact, keyed iv/<the fact's key>, so each is logged once however
// often its fact is seen; one the event log already holds (a wiped store lost its key, events.ts
// logOnce) is settled with no second write. The facts, each one the loop already holds:
// - the ledger: a done, stored `transition` by its row and event (triage, an unknown, a free
//   re-run, a park, a fixer for red CI or a conflict, a head sent back from the queue, a hand
//   merge, a hand close of the PR or the issue, an unpark by label, the first claim after the
//   owner lifted factory:rejected), a CI re-run, a PR body re-rendered for its linkage, R1's
//   release of a ghost (a rejection among them), H1's re-claim of a lapsed claim, an owner item
//   told (breaker, stalled, checkout, workspace) and any wake that is not a planned step;
// - the records and the PRs: the owner's `don't-merge` hold on a merge-queue record and its release;
//   a head on a record's branch that no loop step produced (4.1);
// - the State: a module load, after an earlier run of the loop, with no restart of the loop's own
//   in flight; the companion's refusals and the stop gates that could not run
//   (sources-interventions.ts); and the hand edits of control.json, the OFF file and the settings,
//   against the versions the loop last read or wrote (fileFacts, below).
// A transition's own detail comes with it, in its via code (table.ts viaOf: `unknown:<why>`,
// `fix:<review|ci|conflict>`, `unpark:<op|label>`, S0's `unreject`), so nothing is inferred from
// other entries.
// Owner ops are logged when they land (act-events.ts), not here. Not interventions: the planned
// work, a fixer for review findings, a fixer chosen by triage (counted as the triage), claim-lost
// (another device's work), tells for waiting states, and status and help. Pure.
import { gate, skip } from '../foundation'
import type { LedgerEntry, Ms } from '../types'
import { decisionOf } from './park-text'
import { intervention, logOnce } from './events'
import type { InterventionEvent } from './events'
import { factKey, interventionKey, keyParts, lifeAt, refusedKeyOf, short } from './keys'
import { isReleaseEntry, releaseClaimOf, releaseOutcomeOf } from './release'
import { fromReleaseHold } from './rules-release-hold'
import { holdOf } from './rules-queue'
import { lifePr } from './rules-review'
import type { FileEdit, FilesSeen, InterventionFacts } from './sources-interventions'
import type { IssueState, UnknownWhy, V2Ctx, V2Outcome } from './types'
import { DONT_MERGE_LABEL, UNKNOWN_WHYS } from './types'

const MIN = 60_000
const HOUR = 60 * MIN
// a restart-self that ended this close to the load was the loop's own (D-15: dev-restart-self
// returns minutes before the container is replaced; one cut by the reload ends lost at the load)
const OWN_RESTART_MS = 30 * MIN
// a load is an intervention only on passes this soon after it, so a loop that starts acting long
// after it loaded does not log a stale restart
const RESTART_PLAN_MS = HOUR
// facts older than this are left alone: the ledger keeps an intervention's key 7 days (ledger.ts
// KEEP_MS), and a wiped store's rebuild reads 7 days of the event log (observe.ts REBUILD_DAYS,
// events.ts logOnce), so an older fact would be logged again
export const FACT_WINDOW_MS = 6 * 24 * HOUR

// One intervention to plan: its event, its ledger key and the rule its fact came from.
export type Planned = { key: string; rule: string; event: InterventionEvent }

type TransitionOutcome = Extract<V2Outcome, { kind: 'transition' }>
export type Fact = { entry: LedgerEntry; o: TransitionOutcome; issue: number; life: string; seq: number }

// --- the transitions --------------------------------------------------------------------------------

function transitions(ctx: V2Ctx): Fact[] {
  const out: Fact[] = []
  for (const entry of ctx.state.ledger) {
    const o = entry.outcome
    if (entry.kind !== 'transition' || entry.status !== 'done' || o?.kind !== 'transition' || !o.stored) continue
    const p = keyParts(entry.key)
    if (p === null || p.seq === null || p.rest !== 't') continue
    out.push({ entry, o, issue: p.issue, life: p.life, seq: p.seq })
  }
  return out
}

// whyOf: why the step a transition ended went unknown (7.2), as its via code `unknown:<why>` records
// it (a running step's timeout reaches the table as the unknown `unknown:timeout`; a timeout event
// says so itself). null when it records none.
export function whyOf(o: TransitionOutcome): UnknownWhy | null {
  if (o.event === 'timeout') return 'timeout'
  const via = o.via ?? ''
  return via.startsWith('unknown:') ? (UNKNOWN_WHYS.find(w => w === via.slice('unknown:'.length)) ?? null) : null
}

// What T9's via code says a fixer was sent for (table.ts FIX_REASONS): red CI or a conflict are
// interventions, review findings are planned work (7.2). Any other via is a transition that
// recorded none.
const FIX_FOR: ReadonlyMap<string, 'fix:ci' | 'fix:conflict' | null> = new Map([
  ['fix:ci', 'fix:ci'],
  ['fix:conflict', 'fix:conflict'],
  ['fix:review', null],
])

// How P1's via code says the record was unparked: by the parked label's removal (a person's), or by
// `/factory resume`, whose op is its own intervention (act-events.ts).
const UNPARK_BY: ReadonlyMap<string, 'label' | 'op'> = new Map([
  ['unpark:label', 'label'],
  ['unpark:op', 'op'],
])

const stepName = (o: TransitionOutcome) => o.step ?? 'the step'

// gap: a recent transition that lacks the detail its intervention needs (a loop bug in the
// transition executor), named in the decision log while it is recent rather than lost unseen.
function gap(ctx: V2Ctx, f: Fact, why: string): void {
  if (ctx.state.now - f.entry.startedAt < HOUR) skip(ctx, f.entry.rule, f.issue, `${f.entry.key} (${f.o.row}) ${why}`)
}

// fromTransition: the interventions one transition is. The first takes the fact's own key
// (iv/<transition key>), each further one the key and its cause.
export function fromTransition(ctx: V2Ctx, f: Fact): Planned[] {
  const { o, entry } = f
  const record = ctx.v2.records.find(r => r.issue === f.issue && r.life === f.life)
  const pr = record?.pr ?? entry.pr
  const at = { issue: f.issue, life: f.life, pr }
  const out: { who: InterventionEvent['who']; cause: string; reason: string }[] = []
  const loop = (cause: string, reason: string) => out.push({ who: 'loop', cause, reason })
  const person = (cause: string, reason: string) => out.push({ who: 'person', cause, reason })
  const from = o.from ?? 'none'
  switch (o.row) {
    case 'S0':
      if (o.via === 'unreject') person('unreject', 'factory:rejected was removed and ready added by hand: the issue is back, its life count started again')
      break
    case 'U1':
      loop(`free:${o.cause ?? 'load'}`, `${stepName(o)} in ${from} runs again free after ${o.cause ?? 'a cause outside the issue'}`)
      break
    case 'U2':
    case 'U3':
    case 'U4': {
      // an unknown is an intervention whatever its why; one the transition did not record is
      // logged as cli, the generic why, and named in the decision log
      const why = whyOf(o)
      if (why === null) gap(ctx, f, `recorded no why (via ${o.via ?? 'none'}): its unknown is logged as unknown:cli`)
      loop(`unknown:${why ?? 'cli'}`, `${stepName(o)} in ${from} ended unknown (${why ?? 'no why recorded'})`)
      if (o.row === 'U3') loop('triage', `a triage call after the second unknown in ${from}`)
      break
    }
    case 'T6':
      loop('triage', 'a triage call: the builder said it cannot')
      break
    case 'T9': {
      const cause = FIX_FOR.get(o.via ?? '')
      if (cause === undefined) gap(ctx, f, `recorded no via (${o.via ?? 'none'}): whether its fixer is for red CI or a conflict is not known`)
      if (cause === 'fix:ci') loop(cause, `a fixer for red CI${pr === null ? '' : ` on PR #${pr}`}, from ${from}`)
      if (cause === 'fix:conflict') loop(cause, `a fixer for a merge conflict${pr === null ? '' : ` on PR #${pr}`}, from ${from}`)
      break
    }
    case 'T14':
      loop('queue:patch', `the queue's head went back to review: its patch is not the approved one`)
      break
    case 'E2':
      person('issue-closed', `the issue was closed on GitHub in ${from}`)
      break
    case 'E3':
      person('hand-merge', `PR${pr === null ? '' : ` #${pr}`} was merged by hand in ${from}`)
      break
    case 'E4':
      person('pr-closed', `PR${pr === null ? '' : ` #${pr}`} was closed by hand in ${from}`)
      break
    case 'P1': {
      const by = UNPARK_BY.get(o.via ?? '')
      if (by === undefined) gap(ctx, f, `recorded no via (${o.via ?? 'none'}): whether factory:parked was removed by hand is not known`)
      if (by === 'label') person('unpark', 'factory:parked was removed by hand')
      break
    }
  }
  if (o.to === 'parked') {
    const question = record !== undefined && record.seq === f.seq && record.question !== null ? `: ${decisionOf(record.question)}` : ''
    loop('park', `parked from ${from} (${o.row})${question}`)
  }
  const fact = entry.key
  return out.map((iv, i) => ({ key: interventionKey(i === 0 ? fact : `${fact}/${iv.cause}`), rule: entry.rule, event: intervention(iv.who, iv.cause, fact, iv.reason, at) }))
}

// --- the other facts in the ledger ---------------------------------------------------------------------

// The owner items told, by their notice (appendix D): each has its intervention. parked is the
// transition's own (above).
const TOLD: ReadonlyMap<string, string> = new Map([
  ['breaker', 'breaker'],
  ['stalled', 'stalled'],
  ['checkout', 'tripwire'],
  ['workspace', 'workspace'],
])

// eraOf: when v2 began acting on this ledger: its first transition. Facts v1 could also have left
// (a notice, a wake) count only from then, so a switch from v1 logs none of v1's.
function eraOf(ctx: V2Ctx): Ms | null {
  let era: Ms | null = null
  for (const e of ctx.state.ledger) if (e.kind === 'transition' && (era === null || e.startedAt < era)) era = e.startedAt
  return era
}

// the causes of a refused run's re-runs (rules-refused.ts)
const REFUSED_CAUSE = { probe: 'ci-refused:probe', go: 'ci-refused:rerun' } as const

function fromLedger(ctx: V2Ctx): Planned[] {
  const out: Planned[] = []
  const era = eraOf(ctx)
  const add = (entry: LedgerEntry, who: InterventionEvent['who'], cause: string, reason: string, life: string | null) =>
    out.push({ key: interventionKey(entry.key), rule: entry.rule, event: intervention(who, cause, entry.key, reason, { issue: entry.issue, life, pr: entry.pr }) })
  for (const entry of ctx.state.ledger) {
    const p = keyParts(entry.key)
    const done = entry.status === 'done'
    if (entry.kind === 'ci-rerun' && done && p !== null) {
      const refused = refusedKeyOf(p.rest)
      if (refused !== null) add(entry, 'loop', REFUSED_CAUSE[refused], refused === 'probe' ? `a run GitHub refused to start was re-run to probe whether Actions runs again (${p.rest})` : `a run GitHub refused to start was re-run once Actions ran again (${p.rest})`, p.life)
      else add(entry, 'loop', 'ci-rerun', `a failed check re-run (${p.rest.replace(/^rerun\//, '')})`, p.life)
    } else if (entry.kind === 'restart-self' && entry.status === 'failed') {
      add(entry, 'loop', 'update-failed', (entry.summary ?? 'the restart failed').slice(0, 300), null)
    } else if (entry.kind === 'pr' && done && p !== null && /^pr\/body\/a\d+$/.test(p.rest)) {
      add(entry, 'loop', 'queue:linkage', 'the PR body was written again after a linkage FAIL', p.life)
    } else if (entry.kind === 'claim' && done && p !== null && p.rest.startsWith('claim/')) {
      add(entry, 'loop', 'reclaim', 'a lapsed claim was claimed again onto its record', p.life)
    } else if (done && isReleaseEntry(entry)) {
      const claim = releaseClaimOf(entry.issue ?? 0, entry.key)
      const outcome = claim === null ? null : releaseOutcomeOf(key => ctx.byKey.has(key), entry.issue ?? 0, claim)
      if (outcome === 'reject') add(entry, 'loop', 'rejected', 'R1 released a live claim with no record at its last life: factory:rejected', null)
      else add(entry, 'loop', 'reconcile', `R1 released a live claim with no record${outcome === 'requeue' ? ': back in the queue' : outcome === 'leave' ? ': out of the factory' : ''}`, null)
    } else if (era !== null && entry.startedAt >= era && entry.kind === 'tell' && TOLD.has(entry.wake ?? '') && !entry.key.includes('iv/')) {
      add(entry, 'loop', TOLD.get(entry.wake ?? '') as string, `the owner was told: ${entry.key}`, null)
    } else if (era !== null && entry.startedAt >= era && (entry.kind === 'judge' || (entry.kind === 'task' && entry.wake !== 'release'))) {
      add(entry, 'loop', 'wake', `a wake that is not a planned step: ${entry.key}`, null)
    }
  }
  return out
}

// --- the records, the PRs and the State ------------------------------------------------------------------

// The writer steps, whose result carries the head they left on origin (4.2).
const WRITERS: readonly string[] = ['build', 'fix']

// One write of the loop's to an issue's branch: a writer agent step or a queue update (4.1, 9.2),
// with the head its result read on origin; null while it runs, or when it ended with none read
// (an unknown, a lost agent, a failed update).
type Write = { startedAt: Ms; endedAt: Ms | null; head: string | null }

function loopWrites(ctx: V2Ctx, issue: number): Write[] {
  const out: Write[] = []
  for (const e of ctx.state.ledger) {
    if (e.issue !== issue) continue
    const o = e.outcome
    const endedAt = e.status === 'running' ? null : e.endedAt
    if (e.kind === 'agent-step' && (WRITERS.includes(e.step ?? '') || (o?.kind === 'step' && WRITERS.includes(o.step)))) {
      out.push({ startedAt: e.startedAt, endedAt, head: o?.kind === 'step' ? o.result.head : null })
    } else if (e.kind === 'queue-update') {
      out.push({ startedAt: e.startedAt, endedAt, head: o?.kind === 'queue' ? o.head : null })
    }
  }
  return out
}

// loopMayHaveMade: whether a head first seen at `at` may be one of the loop's own writes that
// read no head: a write still running, or one that ended with no head read, may have pushed any
// head seen after it started, until a later write that read its head ended (with slack for a read
// that lags it). The heads that writes read are the loop's own outright.
function loopMayHaveMade(writes: readonly Write[], at: Ms, slack: Ms): boolean {
  return writes.some(w => {
    if (w.head !== null || w.startedAt > at) return false
    if (w.endedAt === null) return true
    return !writes.some(l => l.head !== null && l.startedAt > w.startedAt && l.endedAt !== null && l.endedAt + slack < at)
  })
}

// The states whose PR head no loop step is moving: a writer's own push is confirmed when its step
// ends, so building and fixing are never read for pushes.
const STILL: readonly IssueState[] = ['reviewing', 'merge-queue', 'parked']

// fromPushes: a head on a record's PR (its life's, lifePr) that no loop step produced, first seen
// after the life began, is a person's push (4.1). Judged only on a head observe saw first (heads
// first seen, 2.4), within FACT_WINDOW_MS; a head that was there before the life began is not this
// life's touch. A record that adopted its PR, with no head of its own, takes the first head seen in
// its life as the loop's start. The loop's own heads are the record's, those its writes read, and
// any a write that read none may have made (loopMayHaveMade).
function fromPushes(ctx: V2Ctx): Planned[] {
  const out: Planned[] = []
  const slack = Math.max(ctx.config.passEveryMs, ctx.config.githubEveryMs)
  for (const r of ctx.v2.records) {
    const pr = lifePr(ctx.state.ledger, r)
    if (pr === null || !STILL.includes(r.state)) continue
    const view = ctx.v2.prs.prs.find(v => v.pr === pr && v.issue === r.issue)
    if (view === undefined || view.state !== 'open' || view.head === null) continue
    const head = view.head
    const seen = ctx.v2.heads[head]
    const began = lifeAt(r.life) ?? 0
    if (seen === undefined || seen.at <= began || ctx.state.now - seen.at > FACT_WINDOW_MS || head === r.head) continue
    const writes = loopWrites(ctx, r.issue)
    if (writes.some(w => w.head === head) || loopMayHaveMade(writes, seen.at, slack)) continue
    if (r.head === null) {
      const first = Object.entries(ctx.v2.heads)
        .filter(([, h]) => h.pr === pr && h.at > began)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (first === undefined || first[0] === head) continue
    }
    const fact = factKey('push', `i${r.issue}`, short(head))
    out.push({
      key: interventionKey(fact),
      rule: 'S6',
      event: intervention('person', 'push', fact, `head ${short(head)} on ${r.branch} was pushed by no loop step`, { issue: r.issue, life: r.life, pr }),
    })
  }
  return out
}

// fromHolds: the owner's `don't-merge` hold on a merge-queue record (9.1). A hold is `hold:dont-merge`
// and its release `hold:released`, each logged once per toggle: the fact key holds the issue, the
// life and the count of the life's earlier hold events (k0 a hold, k1 its release, k2 the next hold).
// The count is of those logged, so one that failed is planned again. A read that failed (labels not
// read) is no person's choice: it writes nothing and leaves the hold as it was.
function fromHolds(ctx: V2Ctx): Planned[] {
  const out: Planned[] = []
  for (const r of ctx.v2.records) {
    if (r.state !== 'merge-queue') continue
    const h = holdOf(ctx.v2.reads, ctx.v2.prs.prs, r)
    if (h?.kind === 'unread') continue
    const base = `i${r.issue}/l${r.life}`
    const done = (n: number) => {
      const fact = factKey('hold', base, `k${n}`)
      return ctx.byKey.get(interventionKey(fact))?.status === 'done' || ctx.v2.logged.some(k => k.endsWith(` ${fact}`))
    }
    let n = 0
    while (done(n)) n += 1
    const open = n % 2 === 1
    if ((h !== null) === open) continue
    const fact = factKey('hold', base, `k${n}`)
    const where = h === null ? '' : h.where === 'issue' ? 'the issue' : `PR #${h.pr}`
    const cause = h === null ? 'hold:released' : 'hold:dont-merge'
    const reason = h === null ? `the ${DONT_MERGE_LABEL} label is gone from the issue and the PR` : `the ${DONT_MERGE_LABEL} label is on ${where}`
    out.push({ key: interventionKey(fact), rule: 'S6', event: intervention('person', cause, fact, reason, { issue: r.issue, life: r.life, pr: r.pr }) })
  }
  return out
}

// fromSessionHold: a stopped main session holds the loop's work (session-hold.ts). One event when the
// hold starts (its fact keyed on the start time, however many refusals it holds) and one when it ends.
function fromSessionHold(ctx: V2Ctx): Planned[] {
  const hold = ctx.state.hold
  if (hold === undefined) return []
  const at = { issue: null, life: null, pr: null }
  const out: Planned[] = []
  const start = hold.held ?? hold.resumed
  if (start === null) return out
  const fact = factKey('hold', 'session', Math.trunc(start.since).toString(36))
  if (hold.held !== null) {
    out.push({ key: interventionKey(factKey('hold', 'session-stopped', Math.trunc(start.since).toString(36))), rule: 'H2', event: intervention('loop', 'hold:session-stopped', fact, `the session is stopped: ${hold.held.what}`, at) })
  }
  if (hold.resumed !== null) {
    const r = hold.resumed
    const stopped = interventionKey(factKey('hold', 'session-stopped', Math.trunc(r.since).toString(36)))
    // a hold that ended inside one pass was never logged as started: log both
    out.push({ key: stopped, rule: 'H2', event: intervention('loop', 'hold:session-stopped', fact, 'the session was stopped', at) })
    const mins = Math.round((r.until - r.since) / MIN)
    out.push({ key: interventionKey(factKey('hold', 'session-resumed', Math.trunc(r.since).toString(36))), rule: 'H2', event: intervention('loop', 'hold:session-resumed', fact, `held ${mins} min, ${r.spawns} agent starts and ${r.wakes} wakes held`, at) })
  }
  return out
}

// fromRestart: a module load that restarted the loop, with no restart-self of the loop's own around
// it (R2's, or v1's H4). A load is a restart only when the loop ran before it: the ledger it loaded
// holds an entry from before the load. The first start of a loop with no ledger restarts nothing
// (the ops that turn it on are logged as ops).
function fromRestart(ctx: V2Ctx): Planned[] {
  const loaded = ctx.state.loadedAt
  if (ctx.state.now - loaded >= RESTART_PLAN_MS) return []
  if (!ctx.state.ledger.some(e => e.startedAt < loaded)) return []
  const own = ctx.state.ledger.some(e => e.kind === 'restart-self' && e.endedAt !== null && e.endedAt >= loaded - OWN_RESTART_MS && e.endedAt <= loaded + OWN_RESTART_MS && e.status !== 'failed')
  if (own) return []
  const fact = factKey('restart', 'fleet', Math.trunc(loaded).toString(36))
  return [{ key: interventionKey(fact), rule: 'R2', event: intervention('person', 'restart', fact, 'the loop loaded with no restart of its own in flight', { issue: null, life: null, pr: null }) }]
}

// fromSources: the companion's lines, and the hand edits of the owner's files (fileFacts).
function fromSources(ctx: V2Ctx): Planned[] {
  const out: Planned[] = []
  const facts = ctx.v2.interventions
  for (const line of facts.companion) {
    const fact = factKey(line.cause, line.issue === null ? 'fleet' : `i${line.issue}`, Math.trunc(line.at).toString(36))
    const reason = line.reason === '' ? `the companion: ${line.cause}` : line.reason
    out.push({ key: interventionKey(fact), rule: 'S2', event: intervention('loop', line.cause, fact, reason, { issue: line.issue, life: line.life, pr: null }) })
  }
  for (const f of fileFacts(facts)) out.push({ key: interventionKey(f.fact), rule: 'G4', event: intervention('person', f.cause, f.fact, f.detail, { issue: f.issue, life: null, pr: null }) })
  return out
}

// --- the owner's files (7.2: control-file, config-file) ----------------------------------------------
//
// A hand edit is a difference, that no op explains, between an owner's file and the last version
// the loop read (an acting pass under planner v2) or wrote (an owner op, the clearing of a done
// update), which files:<repo> keeps (store.ts). The comparison is of the parsed files, so a change
// of layout alone is none. Every edit is kept in the same record, with the version it found, until
// it is logged, and keyed by when it was found, so each change is logged once, an edit back to an
// earlier version too: the acting read's (sources-interventions.ts keepFiles), an op that found its
// file already changed, and the kill switch (store.ts).

// One intervention a file gives: its fact, its cause, the issue it names (none: fleet-level) and
// its one-line detail.
export type FileFact = { fact: string; cause: 'control-file' | 'config-file'; issue: number | null; detail: string }

// digest: a short FNV-1a hash of a text: the key of a version of a file.
export function digest(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function objectOf(text: string | null): Record<string, unknown> {
  if (text === null) return {}
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// keysDiff: the top-level keys whose values differ between two JSON object texts, sorted.
export function keysDiff(before: string, after: string): string[] {
  const [b, a] = [objectOf(before), objectOf(after)]
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].sort().filter(k => !same(b[k], a[k]))
}

// The issues one control field's entries name: numbers, `issue:<N>` subjects, `{ issue }` entries.
function issuesIn(v: unknown): Map<string, number | null> {
  const out = new Map<string, number | null>()
  if (!Array.isArray(v)) return out
  for (const item of v) {
    let n: number | null = null
    if (typeof item === 'number') n = item
    else if (item !== null && typeof item === 'object') {
      const o = item as Record<string, unknown>
      if (typeof o.issue === 'number') n = o.issue
      else if (typeof o.subject === 'string' && /^issue:\d+$/.test(o.subject)) n = Number(o.subject.slice(6))
    }
    out.set(JSON.stringify(item), Number.isInteger(n) ? n : null)
  }
  return out
}

// controlDiff: the fields that changed between two control.json texts, and the issues whose
// entries came or went; null when none did. An update cleared after its restart ran is the loop's
// own write (register.ts clearUpdate), never a person's.
export function controlDiff(before: string, after: string): { fields: string[]; issues: number[] } | null {
  const [b, a] = [objectOf(before), objectOf(after)]
  const fields: string[] = []
  const issues = new Set<number>()
  for (const k of keysDiff(before, after)) {
    if (k === 'updateDue' && (a[k] === null || a[k] === undefined)) continue
    // the loop's failure write sets updateFailed as it clears updateDue
    if (k === 'updateFailed' && typeof a[k] === 'object' && a[k] !== null && b.updateDue !== null && b.updateDue !== undefined && (a.updateDue === null || a.updateDue === undefined)) continue
    fields.push(k)
    const [bx, ay] = [issuesIn(b[k]), issuesIn(a[k])]
    for (const [item, n] of [...bx, ...ay]) if (n !== null && bx.has(item) !== ay.has(item)) issues.add(n)
  }
  return fields.length === 0 ? null : { fields, issues: [...issues].sort((m, n) => m - n) }
}

// editOf: what a person changed in a file, from the version the loop last read or wrote to the
// one found; null when nothing.
export function editOf(part: 'control' | 'workspace', before: string, found: string, at: Ms): FileEdit | null {
  if (part === 'control') {
    const d = controlDiff(before, found)
    return d === null ? null : { what: 'control', at, issues: d.issues, detail: `control.json changed with no op: ${d.fields.join(', ')}` }
  }
  const keys = keysDiff(before, found)
  return keys.length === 0 ? null : { what: 'config', at, issues: [], detail: `settings changed with no op: config.json ${keys.join(', ')}` }
}

// The facts of one change, one per issue it names, else one for the fleet.
function factsOf(cause: FileFact['cause'], issues: readonly number[], version: string, detail: string): FileFact[] {
  return (issues.length === 0 ? [null] : [...new Set(issues)]).map(issue => ({ fact: factKey(cause, issue === null ? 'fleet' : `i${issue}`, version), cause, issue, detail }))
}

// editFacts: a kept edit's facts, keyed by its time.
export function editFacts(e: FileEdit): FileFact[] {
  return factsOf(e.what === 'control' ? 'control-file' : 'config-file', e.issues, Math.trunc(e.at).toString(36), e.detail)
}

// editsOf: the hand edits from the versions kept to those taken, found at `at`; a part either
// lacks is not compared.
export function editsOf(kept: Pick<FilesSeen, 'control' | 'workspace' | 'settings'>, taken: Pick<FilesSeen, 'control' | 'workspace' | 'settings'>, at: Ms): FileEdit[] {
  const control = kept.control === null || taken.control === null ? null : editOf('control', kept.control.text, taken.control.text, at)
  const keys: string[] = []
  if (kept.workspace !== null && taken.workspace !== null) keys.push(...keysDiff(kept.workspace.text, taken.workspace.text).map(k => `config.json ${k}`))
  if (kept.settings !== null && taken.settings !== null) keys.push(...keysDiff(kept.settings.text, taken.settings.text))
  const config: FileEdit | null = keys.length === 0 ? null : { what: 'config', at, issues: [], detail: `settings changed with no op: ${keys.join(', ')}` }
  return [control, config].filter((e): e is FileEdit => e !== null)
}

// fileFacts: every hand edit of the owner's files the State holds, kept to log.
export function fileFacts(facts: InterventionFacts): FileFact[] {
  return (facts.seen?.edits ?? []).flatMap(editFacts)
}

// --- the rule ---------------------------------------------------------------------------------------

// interventionsOf: every intervention the facts hold, done or not; the gate leaves out the done.
export function interventionsOf(ctx: V2Ctx): Planned[] {
  return [...transitions(ctx).flatMap(f => fromTransition(ctx, f)), ...fromLedger(ctx), ...fromPushes(ctx), ...fromHolds(ctx), ...fromReleaseHold(ctx), ...fromRestart(ctx), ...fromSessionHold(ctx), ...fromSources(ctx)]
}

// interventionRules: one `event` action per intervention the ledger has not logged, marked logged
// when the event log holds it (logOnce). One that used up its attempts (fabriek-event refused its
// note: a loop bug) holds no record and is no owner item: its skip line says so, and the executor
// breaker catches a run of them.
export function interventionRules(ctx: V2Ctx): void {
  const seen = new Set<string>()
  for (const p of interventionsOf(ctx)) {
    if (seen.has(p.key)) continue
    seen.add(p.key)
    const g = gate(ctx, p.key, 'event')
    if (g === 'go') ctx.out.push({ kind: 'event', key: p.key, class: 'free', rule: p.rule, reason: `intervention: ${p.event.who} ${p.event.cause}`, issue: p.event.issue, ...logOnce(ctx.v2.logged, p.event) })
    else if (g === 'exhausted') skip(ctx, p.rule, p.event.issue, `exhausted: ${p.key}: the intervention ${p.event.who} ${p.event.cause} is not logged`)
  }
}
