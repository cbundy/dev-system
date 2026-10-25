// The merge train (docs/factory-loop/v2/SPEC.md 9.8): while the head is in CI, the record right
// behind it is tested on a train branch, the head's updated commit H' merged with the record's head N
// in a commit the loop pushes as `factory-train/...` (act-train.ts); CI runs on that commit like on
// any push. When the head merges and main's tree is H''s, N merges at once with `--tested-tree` the
// train's tree, with no update of its own and no new CI run. Every mismatch drops the train and N
// takes Q1, its own CI and Q2 as it always did. It ships behind the `mergeTrain` setting, off by default.
//
// - Q3 (build): the setting is on, no train is live, the head has been updated onto main by a
//   queue-update of its seq and its CI runs or is green, and the next record is open, on its
//   approved patch, not dirty, with its own checks green: one `queue-train` build, keyed by the three
//   heads and the record's seq. Depth 2: only the record right behind the head, and one live train.
// - A live train is a done build with a train commit and no delete entry. endOf reads the facts it
//   rests on every pass and returns how it ended, or null while it stands (a train's ends are facts,
//   so a restart loses none): the record's head moved, main moved to something other than the head's
//   tree, the train's CI is red (or never started, or never ends), the head left the queue other than by
//   merging, or the guard or GitHub refused the train merge (the merge try's `drop`).
// - Q2 for the record, now the head (trainStateOf): `ready` when main is the head's merge with H''s
//   tree and the train's CI is green; openHead then plans no Q1 although the base is behind, and
//   merges with `--tested-tree`. `waiting` when the trees or the train's CI are not read yet.
// - trainRules (the queue's whole-queue hook): the builds, the delete of each train branch that
//   ended (its key names how it ended), and the sweep of `factory-train/*` refs no live train names
//   (a crash leaves them; with the setting off a train built before still gets its branch removed).
// - trainDroppedOf: why the record's train was dropped, for `--train-dropped` on its later merge.
//
// Pure: the time is state.now.
import { want } from '../foundation'
import type { LedgerEntry, Ms } from '../types'
import { short, trainDeleteKey, trainKey, trainKeyParts, trainSweepKey } from './keys'
import type { CheckRun, PrView } from './sources-prs'
import { ciOf, headFacts } from './steps-queue'
import { TRAIN_DROPS } from './train-types'
import type { TrainDrop, TrainEnd } from './train-types'
import type { IssueRecord, V2Ctx } from './types'

// How often the sweep of stale train refs runs (once per window of this length).
export const SWEEP_MS = 15 * 60_000

const sameSha = (a: string | null, b: string | null) => a !== null && b !== null && (a.startsWith(b) || b.startsWith(a))

// A live train: a done build that made a train commit.
export type LiveTrain = { key: string; issue: number; life: string; seq: number; endedAt: Ms; tree: string; train: string; branch: string; headIssue: number; head: string; rider: string; main: string }

function liveOf(e: LedgerEntry): LiveTrain | null {
  const o = e.outcome
  const p = trainKeyParts(e.key)
  if (e.kind !== 'queue-train' || e.status !== 'done' || o?.kind !== 'train' || o.op !== 'build' || p === null || p.end !== null || e.issue === null) return null
  if (o.tree === null || o.train === null || o.branch === null) return null
  const life = /^i\d+\/l([0-9a-z]+)\//.exec(e.key)?.[1]
  if (life === undefined) return null
  return { key: e.key, issue: e.issue, life, seq: p.seq, endedAt: e.endedAt ?? e.startedAt, tree: o.tree, train: o.train, branch: o.branch, headIssue: o.headIssue, head: o.head, rider: o.rider, main: o.main }
}

const deleted = (ledger: readonly LedgerEntry[], key: string) => ledger.some(e => e.kind === 'queue-train' && e.key.startsWith(`${key}/del/`))

// trainsOf: the live trains in the ledger: a train commit built and its branch not yet deleted.
export function trainsOf(ledger: readonly LedgerEntry[]): LiveTrain[] {
  return ledger.flatMap(e => {
    const t = liveOf(e)
    return t === null || deleted(ledger, t.key) ? [] : [t]
  })
}

const viewOf = (ctx: V2Ctx, issue: number, pr: number | null): PrView | undefined => (pr === null ? undefined : ctx.v2.prs.prs.find(p => p.pr === pr && p.issue === issue))

// trainCi: what the train commit's checks say, as ciOf reads a head's, without the one re-run (a red
// train only drops the train; the record's own checks have theirs): red, pending (or not started),
// green; null when the checks are not read.
export function trainCi(ctx: V2Ctx, t: LiveTrain): 'red' | 'pending' | 'green' | null {
  const checks: CheckRun[] | null | undefined = ctx.v2.train?.checks[t.train]
  if (checks === undefined || checks === null) return null
  if (checks.some(c => c.bucket === 'fail' || c.bucket === 'cancel')) return 'red'
  if (checks.length === 0 || checks.some(c => c.bucket === 'pending' || c.bucket === 'refused')) return 'pending'
  return 'green'
}

// trainStale: the train's CI is past its bound: nothing started ciStartMs after the build (or its checks
// could not be read for that long), or it has run past ciRunMs more. A repo whose CI does not run on `factory-train/**` pushes drops every train
// this way, and the record goes on its own path.
function trainStale(ctx: V2Ctx, t: LiveTrain, ci: 'red' | 'pending' | 'green' | null): boolean {
  const age = ctx.state.now - t.endedAt
  const checks = ctx.v2.train?.checks[t.train] ?? []
  if (ci === 'pending') return age > ctx.config.ciStartMs + (checks.length === 0 ? 0 : ctx.config.ciRunMs)
  // checks that cannot be read for that long are no hold on the record either
  return ci === null && age > ctx.config.ciStartMs
}

// endOf: how a live train ended, or null while it stands.
export function endOf(ctx: V2Ctx, queue: readonly IssueRecord[], t: LiveTrain): TrainEnd | null {
  const r = ctx.v2.records.find(x => x.issue === t.issue && x.life === t.life)
  const merges = r === undefined ? [] : mergesOf(ctx, r, t.seq)
  if (merges.some(e => e.status === 'done' && e.outcome?.kind === 'queue' && e.outcome.merged)) return 'merged'
  if (!ctx.config.mergeTrain) return 'left-queue'
  const refused = merges.flatMap(e => (e.outcome?.kind === 'queue' && e.outcome.drop !== undefined ? [e.outcome.drop] : [])).at(-1)
  if (refused !== undefined) return refused
  if (r === undefined || r.state !== 'merge-queue' || r.seq !== t.seq) return 'left-queue'
  const at = queue.findIndex(x => x.issue === r.issue && x.life === r.life)
  if (at < 0 || at > 1) return 'left-queue'
  const view = viewOf(ctx, r.issue, r.pr)
  if (view !== undefined && (view.state !== 'open' || (view.head !== null && !sameSha(view.head, t.rider)))) return view.state === 'open' ? 'head-moved' : 'left-queue'
  const ci = trainCi(ctx, t)
  if (ci === 'red' || trainStale(ctx, t, ci)) return 'train-red'
  const main = ctx.v2.prs.main?.sha ?? null
  if (main === null) return null
  const head = at === 1 ? queue[0] : undefined
  if (sameSha(main, t.main)) {
    // the head has not merged: it must still be the head, on the commit the train rests on
    if (head === undefined || head.issue !== t.headIssue) return 'left-queue'
    const hv = viewOf(ctx, head.issue, head.pr)
    return hv?.head != null && !sameSha(hv.head, t.head) ? 'head-moved' : null
  }
  // main moved: it must be the head's merge, with the head's tree
  const trees = ctx.v2.train?.trees ?? {}
  const tm = trees[main]
  const th = trees[t.head]
  if (tm == null || th == null) return null
  if (tm !== th) return 'outside-merge'
  return at === 0 || head?.issue === t.headIssue ? null : 'left-queue'
}

// The record's live train and its state in Q2.
export type TrainState =
  | { kind: 'none' }
  | { kind: 'riding'; train: LiveTrain }
  | { kind: 'waiting'; train: LiveTrain; why: string }
  | { kind: 'ready'; train: LiveTrain }
  | { kind: 'ended'; train: LiveTrain; end: TrainEnd }

// trainStateOf: the record's train, if the setting is on and one is live.
export function trainStateOf(ctx: V2Ctx, queue: readonly IssueRecord[], r: IssueRecord): TrainState {
  if (!ctx.config.mergeTrain) return { kind: 'none' }
  const t = trainsOf(ctx.state.ledger).find(x => x.issue === r.issue && x.life === r.life && x.seq === r.seq)
  if (t === undefined) return { kind: 'none' }
  const end = endOf(ctx, queue, t)
  if (end !== null) return { kind: 'ended', train: t, end }
  if (queue[0]?.issue !== r.issue) return { kind: 'riding', train: t }
  const main = ctx.v2.prs.main?.sha ?? null
  const trees = ctx.v2.train?.trees ?? {}
  if (main === null || trees[main] == null || trees[t.head] == null) return { kind: 'waiting', train: t, why: `main's tree is not read yet, for the train ${short(t.train)}` }
  const ci = trainCi(ctx, t)
  if (ci !== 'green') return { kind: 'waiting', train: t, why: ci === null ? `the checks of the train ${short(t.train)} are not read yet` : `CI runs on the train ${short(t.train)}` }
  return { kind: 'ready', train: t }
}

// mergesOf: the record's merge tries of one seq, oldest first.
function mergesOf(ctx: V2Ctx, r: Pick<IssueRecord, 'issue' | 'life'>, seq: number): LedgerEntry[] {
  return ctx.state.ledger
    .filter(e => e.kind === 'queue-merge' && e.issue === r.issue && new RegExp(`^i${r.issue}/l${r.life}/queue/merge/[0-9a-f]+/s${seq}/m\\d+$`).test(e.key))
    .sort((a, b) => a.startedAt - b.startedAt)
}

// trainDroppedOf: why the record's train was dropped in this seq, for `--train-dropped` on its merge;
// null when it had none, or the setting is off.
export function trainDroppedOf(ctx: V2Ctx, queue: readonly IssueRecord[], r: IssueRecord): TrainDrop | null {
  if (!ctx.config.mergeTrain) return null
  const live = trainStateOf(ctx, queue, r)
  if (live.kind === 'ended' && live.end !== 'merged') return live.end
  const mine = ctx.state.ledger.filter(e => e.kind === 'queue-train' && e.issue === r.issue && trainKeyParts(e.key)?.seq === r.seq && e.key.startsWith(`i${r.issue}/l${r.life}/`))
  const newest = (es: LedgerEntry[]) => es.sort((a, b) => b.startedAt - a.startedAt)[0]
  const ends = mine.flatMap(e => {
    const end = trainKeyParts(e.key)?.end
    const drop = TRAIN_DROPS.find(d => d === end)
    return drop === undefined ? [] : [{ e, drop }]
  })
  const hit = newest(ends.map(x => x.e))
  if (hit !== undefined) return ends.find(x => x.e === hit)?.drop ?? null
  const tried = newest(mergesOf(ctx, r, r.seq).filter(e => e.outcome?.kind === 'queue' && e.outcome.drop !== undefined))
  if (tried?.outcome?.kind === 'queue' && tried.outcome.drop !== undefined) return tried.outcome.drop
  const built = newest(mine.filter(e => e.status === 'done' && e.outcome?.kind === 'train' && e.outcome.op === 'build' && e.outcome.drop !== null))
  return built?.outcome?.kind === 'train' && built.outcome.op === 'build' ? built.outcome.drop : null
}

// --- the whole-queue rules ------------------------------------------------------------------------------

// trainRules (Q3): the builds, the deletes of ended trains, the sweep. queue: the queue, head first.
export function trainRules(ctx: V2Ctx, queue: readonly IssueRecord[]): void {
  const live = trainsOf(ctx.state.ledger)
  const standing: LiveTrain[] = []
  for (const t of live) {
    const end = endOf(ctx, queue, t)
    if (end === null) {
      standing.push(t)
      continue
    }
    const key = trainDeleteKey(t.key, end)
    want(ctx, { kind: 'queue-train', op: 'delete', branch: t.branch, end, key, class: 'free', rule: 'Q3', reason: `delete the train branch ${t.branch}: ${end}`, issue: t.issue, maxAttempts: 3 })
  }
  const building = ctx.config.mergeTrain && standing.length === 0 ? buildTrain(ctx, queue) : false
  // the sweep: with the setting on once per window; off, only while a train was built that no delete
  // or sweep cleaned. Never beside a build that may be pushing, nor while one runs.
  const running = ctx.state.ledger.some(e => e.kind === 'queue-train' && e.status === 'running')
  if (building || running || (!ctx.config.mergeTrain && owedBy(ctx.state.ledger) === 0)) return
  const keep = standing.map(t => t.branch)
  want(ctx, { kind: 'queue-train', op: 'sweep', keep, key: trainSweepKey(Math.floor(ctx.state.now / SWEEP_MS)), class: 'free', rule: 'Q3', reason: `delete the train branches on origin that no live train names (${keep.length} kept)`, issue: null, maxAttempts: 1 })
}

// owedBy: the builds in the ledger whose branch no delete and no later sweep cleaned.
function owedBy(ledger: readonly LedgerEntry[]): number {
  const sweeps = ledger.filter(e => e.kind === 'queue-train' && e.key.startsWith('train/sweep/') && e.status === 'done' && e.outcome?.kind === 'train' && e.outcome.op === 'sweep')
  return ledger.filter(e => {
    const p = trainKeyParts(e.key)
    if (e.kind !== 'queue-train' || p === null || p.end !== null || deleted(ledger, e.key)) return false
    const branch = e.outcome?.kind === 'train' && e.outcome.op === 'build' ? e.outcome.branch : null
    if (e.status === 'done' && e.outcome?.kind === 'train' && e.outcome.op === 'build' && e.outcome.train === null) return false
    const since = e.endedAt ?? e.startedAt
    return !sweeps.some(s => s.startedAt > since && (branch === null || (s.outcome?.kind === 'train' && s.outcome.op === 'sweep' && !s.outcome.kept.includes(branch))))
  }).length
}

// buildTrain (Q3): plans the one build, if every condition holds; whether it did.
function buildTrain(ctx: V2Ctx, queue: readonly IssueRecord[]): boolean {
  const head = queue[0]
  const rider = queue[1]
  const main = ctx.v2.prs.main?.sha ?? null
  if (head === undefined || rider === undefined || main === null || head.pr === null || rider.pr === null) return false
  const hv = viewOf(ctx, head.issue, head.pr)
  const rv = viewOf(ctx, rider.issue, rider.pr)
  if (hv === undefined || rv === undefined || hv.state !== 'open' || rv.state !== 'open' || hv.head === null || rv.head === null) return false
  // the head: updated onto main by an update of its seq, on its approved patch, its CI running or green
  if (hv.patch !== head.approvedPatch || hv.mergeable === 'dirty' || hv.base === null || !sameSha(hv.base, main)) return false
  const facts = headFacts(ctx, head)
  const updated = facts.updates.some(e => e.status === 'done' && e.outcome?.kind === 'queue' && sameSha(e.outcome.head, hv.head))
  const hci = ciOf(head, hv.checks, facts.reruns).kind
  if (!updated || (hci !== 'pending' && hci !== 'green')) return false
  // the record: its approved patch, not conflicting, its own checks green, no train merge tried in this seq
  if (rv.patch !== rider.approvedPatch || rv.mergeable === 'dirty' || ciOf(rider, rv.checks, []).kind !== 'green') return false
  if (mergesOf(ctx, rider, rider.seq).some(e => e.outcome?.kind === 'queue' && e.outcome.drop !== undefined)) return false
  const key = trainKey(rider, hv.head, rv.head, main)
  const g = want(ctx, { kind: 'queue-train', op: 'build', key, class: 'free', rule: 'Q3', reason: `test PR #${rv.pr} on the head #${hv.pr} (${short(hv.head)}) and main ${short(main)}`, issue: rider.issue, pr: rv.pr, branch: rider.branch, rider: rv.head, headIssue: head.issue, headPr: hv.pr, headBranch: head.branch, head: hv.head, main, maxAttempts: 1 })
  return g === 'go'
}
