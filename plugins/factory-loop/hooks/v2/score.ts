// The claim score (docs/factory-loop/v2/SPEC.md 3.5, row S1): after the owner's `only` or
// `priority` list, S1 claims the ready issue with the highest score. A score is the sum of the
// factors in FACTORS, each a pure function of the issue's facts that gives its points under a
// stable name, or null when its facts are not read. The names are what the claimed event, the S1
// reason and the metrics queries use. Adding a factor is adding one entry to the list.
//
// Pure: the time is ctx.now, and everything else is passed in.
import type { IssueView, Ms } from '../types'
import type { Stamp } from './stamps'
import { sameLabel } from './types'

// The weights (config.queueScore): whole numbers of at least 0; penalties are magnitudes.
export type QueueScoreWeights = {
  priorityLabel: number
  bug: number
  unblocksDirect: number
  unblocksTransitive: number
  unblocksCap: number
  closesEpic: number
  nearlyClosesEpic: number
  epicStarted: number
  waitingPerHour: number
  waitingCap: number
  failedLife: number
  failedLivesCap: number
  areaFactory: number
  needsOwner: number
  overlap: number
}

// The intake stamp's facts (epic #995), given only while config.intakeStamp is on: the issue's
// stamp (null: none), and the top-level paths of each live record's pushed head, by issue (a null
// entry: the read failed; no entry: nothing in flight).
export type IntakeCtx = {
  stamp: (n: number) => Stamp | null
  inFlightPaths: Readonly<Record<number, readonly string[] | null>>
}

export type ScoreCtx = {
  now: Ms
  weights: QueueScoreWeights
  priorityLabel: string
  // issues with a record that is not closed, or a claim in flight
  held: ReadonlySet<number>
  // a read issue's open blocked issues; null when the issue was not read
  blocking: (n: number) => number[] | null
  // the issue's earlier lives that did not end merged, counted from the start of the current count
  failedLives: (n: number) => number
  // absent: the switch is off, and the intake factors score nothing
  intake?: IntakeCtx
}

export type ScoredFactor = { name: string; points: number }
export type ScoreResult = { score: number; factors: ScoredFactor[] }
export type Factor = (issue: IssueView, ctx: ScoreCtx) => ScoredFactor | null

const HOUR = 3_600_000

// claimableAt: when the issue became claimable, the later of its `ready` event and its newest
// closed blocker; null when neither is known.
export function claimableAt(issue: Pick<IssueView, 'readyAt' | 'blockersClosedAt'>): Ms | null {
  const times = [issue.readyAt, issue.blockersClosedAt].filter((t): t is Ms => t !== null)
  return times.length === 0 ? null : Math.max(...times)
}

// transitive: the open issues reached from the direct ones through ctx.blocking, breadth first,
// each once, leaving out the issue itself and the direct ones.
function transitive(issue: number, direct: readonly number[], ctx: ScoreCtx): number {
  const seen = new Set<number>([issue, ...direct])
  const queue = [...direct]
  let count = 0
  for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
    for (const m of ctx.blocking(n) ?? []) {
      if (seen.has(m)) continue
      seen.add(m)
      count += 1
      queue.push(m)
    }
  }
  return count
}

export const FACTORS: Factor[] = [
  (issue, ctx) => (issue.labels === null ? null : { name: 'priority-label', points: issue.labels.some(l => sameLabel(l, ctx.priorityLabel)) ? ctx.weights.priorityLabel : 0 }),
  (issue, ctx) => (issue.labels === null ? null : { name: 'bug', points: issue.labels.some(l => sameLabel(l, 'bug')) ? ctx.weights.bug : 0 }),
  (issue, ctx) => {
    if (issue.blockingList === null) return null
    const w = ctx.weights
    const direct = issue.blockingList.length
    if (direct === 0) return { name: 'unblocks', points: 0 }
    return { name: 'unblocks', points: Math.min(w.unblocksCap, w.unblocksDirect * direct + w.unblocksTransitive * transitive(issue.number, issue.blockingList, ctx)) }
  },
  (issue, ctx) => {
    if (issue.parent === null || issue.siblings === null) return null
    const open = issue.siblings.filter(s => s.open).length
    if (open === 0) return { name: 'closes-epic', points: ctx.weights.closesEpic }
    return { name: 'nearly-closes-epic', points: open === 1 ? ctx.weights.nearlyClosesEpic : 0 }
  },
  (issue, ctx) => {
    if (issue.parent === null || issue.siblings === null) return null
    return { name: 'epic-started', points: issue.siblings.some(s => !s.open || ctx.held.has(s.number)) ? ctx.weights.epicStarted : 0 }
  },
  (issue, ctx) => {
    const at = claimableAt(issue)
    if (at === null) return null
    return { name: 'waiting', points: Math.min(ctx.weights.waitingCap, Math.floor((ctx.weights.waitingPerHour * Math.max(0, ctx.now - at)) / HOUR)) }
  },
  (issue, ctx) => ({ name: 'failed-lives', points: -Math.min(ctx.weights.failedLivesCap, ctx.weights.failedLife * ctx.failedLives(issue.number)) }),
  (issue, ctx) => (ctx.intake === undefined || issue.labels === null || ctx.intake.stamp(issue.number) === null ? null : { name: 'area-factory', points: issue.labels.some(l => sameLabel(l, 'area:factory')) ? ctx.weights.areaFactory : 0 }),
  (issue, ctx) => (ctx.intake === undefined || issue.labels === null || ctx.intake.stamp(issue.number) === null ? null : { name: 'needs-owner', points: issue.labels.some(l => sameLabel(l, 'needs-decision')) ? -ctx.weights.needsOwner : 0 }),
  (issue, ctx) => {
    const stamp = ctx.intake?.stamp(issue.number) ?? null
    if (ctx.intake === undefined || stamp === null) return null
    const others = Object.entries(ctx.intake.inFlightPaths).filter(([n]) => Number(n) !== issue.number)
    // a record whose paths did not read says nothing; with none read the factor is not known
    const read = others.flatMap(([, paths]) => (paths === null ? [] : [paths]))
    if (read.length === 0) return null
    const mine = new Set(stamp.touches.map(t => t.split('/')[0]))
    return { name: 'overlap', points: read.some(paths => paths.some(p => mine.has(p.split('/')[0]))) ? -ctx.weights.overlap : 0 }
  },
]

// score: the sum of the factors' points, and the factors that scored, in list order.
export function score(issue: IssueView, ctx: ScoreCtx, factors: readonly Factor[] = FACTORS): ScoreResult {
  const scored: ScoredFactor[] = []
  for (const f of factors) {
    const r = f(issue, ctx)
    if (r !== null && r.points !== 0) scored.push(r)
  }
  return { score: scored.reduce((sum, f) => sum + f.points, 0), factors: scored }
}

export type Ranked = { issue: number; score: number; claimableAt: Ms | null }

// compareRanked: the S1 order of the issues the owner's lists leave: the higher score first, then
// the oldest claimable time (none sorts after any time), then the lowest number.
export function compareRanked(a: Ranked, b: Ranked): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.claimableAt !== b.claimableAt) {
    if (a.claimableAt === null) return 1
    if (b.claimableAt === null) return -1
    return a.claimableAt - b.claimableAt
  }
  return a.issue - b.issue
}

// scoreReason: the S1 reason's order text, `score 55: priority-label +30, bug +25`.
export function scoreReason(r: ScoreResult): string {
  if (r.factors.length === 0) return `score ${r.score}`
  return `score ${r.score}: ${r.factors.map(f => `${f.name} ${f.points > 0 ? '+' : '-'}${Math.abs(f.points)}`).join(', ')}`
}
