// The slots (docs/factory-loop/v2/SPEC.md 10.1, 3.5, 5.1, appendix A, appendix C): W2 frees a loop
// slot no record holds, then W1 leases one for each record that needs one, as far as capacity, the
// pool's reserve and the tier allow. The loop finds its slots only by their lease holder,
// `factory-loop:<N>:<life>` (observe.ts holderOf), in the pool's own listing; it never infers a
// slot's owner from a reflog or a branch.
//
// - W2, free: a slot leased by the loop for an issue's life is freed when no record of that life
//   is queued or in a slot state (designing to merge-queue) and nothing of that life still runs in
//   it (an agent step, or a slot op). A queued record keeps the lease its step is about to take
//   (row T1). So a slot is freed however its issue left: parked, dropped, merged, closed by hand,
//   lost to another device, released by R1, or a record pruned. A second lease of a live life (a
//   lease whose answer was lost, taken again) is freed too, once nothing of the life runs: the
//   record holds the one rules-agent.ts leaseOf names. Keyed by the lease (keys.ts freeKey), so one
//   lease is freed once; from the free's start the lease counts as gone (rules-agent.ts freeing),
//   so a record resumed meanwhile never steps onto a slot being reset and returned.
//   A free of a life with a parked record keeps the life's scratch folders (keepScratch, the
//   tool's --keep-scratch): a resume continues the life; a later free removes them, and the tool
//   prunes any older than 7 days.
// - W1, lease: first each record in a slot state whose lease vanished (it already counts in
//   flight; its running step ends unknown with the cause `slot` at once, rules-agent.ts agentStep,
//   and the lease waits until the stopped step no longer runs), then each queued record with no
//   lease: resumes first, by the time they parked, then new claims, by claim time. A record whose
//   life's old slot is being freed waits for the free: the tool would hand that slot back. A
//   queued record is leased only while the records in flight (designing to merge-queue, a queued
//   record that holds or is taking a lease) number fewer than K (`maxInFlightIssues`), the pool's
//   free slots exceed `worktreeReserve`, and the tier allows the class of the step the lease leads
//   to; a vanished one needs one free slot and the tier.
// - A lease is keyed by its number in the life (keys.ts leaseKey): a failed one runs again under
//   its own key; once one is done and a pool read after it no longer shows it, the next number is
//   taken. A done lease the pool was read before is not leased again: the next pass sees it.
// - W2 is planned before W1, so for one issue the old life's slot goes back first (totality/T-19).
//
// Pure: the time is state.now.
import { ALLOWED, gate, skip, want } from '../foundation'
import type { ActionClass, LedgerEntry, Ms } from '../types'
import { freeKey, keyParts, leaseKey, lifeAt, lifeKey } from './keys'
import { freeing, leaseOf, lifeEntries } from './rules-agent'
import { AGENT_STEPS, SLOT_STATES, STATE_STEP, STEP_CLASS } from './types'
import type { AgentStep, IssueRecord, IssueState, Lease, V2Ctx } from './types'

// The attempts of each op that W1 and W2 plan (appendix B).
export const LEASE_ATTEMPTS = 3
export const FREE_ATTEMPTS = 2

// The entry kinds of a life that run in its slot: while one runs, the slot is in use.
const IN_SLOT: readonly LedgerEntry['kind'][] = ['agent-step', 'slot']

const isAgentStep = (s: string | null): s is AgentStep => s !== null && (AGENT_STEPS as readonly string[]).includes(s)

// classOf: the class of the step a state runs (appendix B): an agent step's own, else free (the
// merge queue's head runs commands, no agent).
export function classOf(state: IssueState): ActionClass {
  const step = STATE_STEP[state]
  return isAgentStep(step) ? STEP_CLASS[step] : 'free'
}

// --- the life's leases --------------------------------------------------------------------------------

const LEASE_N = /^lease\/([1-9]\d*)$/

// leaseEntries: the life's lease attempts (W1), by their number, oldest first.
export function leaseEntries(ctx: V2Ctx, r: Pick<IssueRecord, 'issue' | 'life'>): { n: number; entry: LedgerEntry }[] {
  const out: { n: number; entry: LedgerEntry }[] = []
  for (const e of lifeEntries(ctx, r, 'slot')) {
    const p = keyParts(e.key)
    const m = p === null || p.seq !== null ? null : LEASE_N.exec(p.rest)
    if (m?.[1] !== undefined) out.push({ n: Number(m[1]), entry: e })
  }
  return out.sort((a, b) => a.n - b.n)
}

// What W1 knows of a record's lease beside the pool: its next key; or that one is under way (its
// lease runs, or ended after the pool was read), so it takes its place and its slot already.
type LeaseNext = { kind: 'key'; key: string } | { kind: 'pending'; why: string }

function nextLease(ctx: V2Ctx, r: IssueRecord): LeaseNext {
  // the tool keeps a slot that carries the life's holder, so a new lease waits for the old one to go
  const old = ctx.v2.leases.find(l => l.issue === r.issue && l.life === r.life && freeing(ctx, l))
  if (old !== undefined) return { kind: 'pending', why: `its old slot ${old.path} is being freed (${freeKey(old.lease)})` }
  const last = leaseEntries(ctx, r).at(-1)
  if (last === undefined) return { kind: 'key', key: leaseKey(r, 1) }
  const e = last.entry
  if (e.status === 'running') return { kind: 'pending', why: `its lease ${last.n} runs` }
  if (e.status !== 'done') return { kind: 'key', key: e.key }
  const readAt = ctx.v2.sources.leases.at ?? 0
  if ((e.endedAt ?? e.startedAt) >= readAt) return { kind: 'pending', why: `lease ${last.n} is newer than the pool's read` }
  return { kind: 'key', key: leaseKey(r, last.n + 1) }
}

// runningIn: something of the life still runs in its slot (an agent step, a prepare, a kill).
function runningIn(ctx: V2Ctx, life: Pick<IssueRecord, 'issue' | 'life'>): LedgerEntry | null {
  return lifeEntries(ctx, life).find(e => e.status === 'running' && IN_SLOT.includes(e.kind)) ?? null
}

// parkedAt: when a resumed record parked or began to wait: the newest transition of its life into either, before
// its current seq; else when it entered queued.
function parkedAt(ctx: V2Ctx, r: IssueRecord): Ms {
  let at: Ms | null = null
  let seq = -1
  for (const e of lifeEntries(ctx, r, 'transition')) {
    const s = keyParts(e.key)?.seq ?? null
    if (s === null || s >= r.seq || s <= seq || e.outcome?.kind !== 'transition' || (e.outcome.to !== 'parked' && e.outcome.to !== 'waiting')) continue
    seq = s
    at = e.startedAt
  }
  return at ?? r.since
}

// --- W2: free --------------------------------------------------------------------------------------------

// holds: a record of the lease's life is queued (about to take it) or in a slot state.
function holds(ctx: V2Ctx, l: Lease): boolean {
  return ctx.v2.records.some(r => r.issue === l.issue && r.life === l.life && (r.state === 'queued' || SLOT_STATES.includes(r.state)))
}

// parked: a record of the lease's life is parked or waiting, so a resume continues the life and its
// scratch folders stay (free --keep-scratch); a later free of the life, after the resume, removes them.
function parked(ctx: V2Ctx, l: Lease): boolean {
  return ctx.v2.records.some(r => r.issue === l.issue && r.life === l.life && (r.state === 'parked' || r.state === 'waiting'))
}

function frees(ctx: V2Ctx): void {
  for (const l of [...ctx.v2.leases].sort((a, b) => a.path.localeCompare(b.path))) {
    if (l.issue === null || l.life === null) continue
    const life = { issue: l.issue, life: l.life }
    const held = holds(ctx, l)
    // a live life keeps the one lease leaseOf names; any other of it is a second lease, or one
    // whose free is under way already
    if (held && leaseOf(ctx, life)?.lease === l.lease) continue
    const busy = freeing(ctx, l) ? null : runningIn(ctx, life)
    if (busy !== null) {
      skip(ctx, 'W2', l.issue, `W2: slot ${l.path} of life ${l.life} waits: ${busy.key} still runs in it`)
      continue
    }
    want(ctx, {
      kind: 'slot',
      op: 'free',
      key: freeKey(l.lease),
      class: 'free',
      rule: 'W2',
      reason: held ? `slot ${l.path} is a second lease of #${l.issue} life ${l.life}` : `no record of #${l.issue} life ${l.life} holds slot ${l.path}`,
      issue: l.issue,
      life: l.life,
      path: l.path,
      lease: l.lease,
      branch: null,
      marker: null,
      keepScratch: parked(ctx, l),
      maxAttempts: FREE_ATTEMPTS,
    })
  }
}

// --- W1: lease ---------------------------------------------------------------------------------------------

// tierHolds: why the tier or the owner holds the step a lease leads to, or null.
function tierHolds(ctx: V2Ctx, to: IssueState): string | null {
  const cls = classOf(to)
  if (!ALLOWED[ctx.tier].includes(cls)) return `tier ${ctx.tier} holds ${STATE_STEP[to] ?? to} (${cls})`
  if (ctx.state.control.noNewWork && (cls === 'develop' || cls === 'start')) return `owner: no new work holds ${STATE_STEP[to] ?? to}`
  return null
}

function leases(ctx: V2Ctx): void {
  const { config } = ctx
  const live = ctx.v2.records.filter(r => r.state !== 'closed')
  const vanished = live.filter(r => SLOT_STATES.includes(r.state) && leaseOf(ctx, r) === null)
  const queued = live.filter(r => r.state === 'queued' && leaseOf(ctx, r) === null)
  if (vanished.length === 0 && queued.length === 0) return
  const pool = ctx.state.sources.pool.ok ? ctx.state.pool : null
  // a lease under way holds its place in flight and its slot (nextLease)
  const pending = new Map(queued.concat(vanished).map(r => [r, nextLease(ctx, r)]))
  const underWay = [...pending.values()].filter(p => p.kind === 'pending').length
  let flight = live.filter(r => SLOT_STATES.includes(r.state) || (r.state === 'queued' && (leaseOf(ctx, r) !== null || pending.get(r)?.kind === 'pending'))).length
  let free = pool === null ? null : pool.free - underWay
  const resumes = queued.filter(r => r.seq > 1).map(r => ({ r, at: parkedAt(ctx, r) }))
  const claims = queued.filter(r => r.seq <= 1).map(r => ({ r, at: lifeAt(r.life) ?? r.since }))
  const byTime = (a: { r: IssueRecord; at: Ms }, b: { r: IssueRecord; at: Ms }) => a.at - b.at || a.r.issue - b.r.issue
  const order = [...vanished.sort((a, b) => a.issue - b.issue).map(r => ({ r, at: 0 })), ...resumes.sort(byTime), ...claims.sort(byTime)].map(x => x.r)
  for (const r of order) {
    const lost = r.state !== 'queued'
    const next = pending.get(r) ?? nextLease(ctx, r)
    if (next.kind === 'pending') {
      skip(ctx, 'W1', r.issue, `W1: ${next.why}`)
      continue
    }
    if (gate(ctx, next.key, 'slot', LEASE_ATTEMPTS) === 'exhausted') {
      // the record's stall (rules-entry.ts stalledOf) tells the owner
      skip(ctx, 'W1', r.issue, `W1: stalled: ${next.key}`)
      continue
    }
    const to = lost ? r.state : (r.resumeTo ?? 'designing')
    const busy = lost ? runningIn(ctx, r) : null
    let limit: string | null = null
    if (busy !== null) limit = `its slot is gone and ${busy.key} still runs`
    else if (free === null) limit = `the pool's free slots are not known (${ctx.state.sources.pool.error ?? 'not read'})`
    else if (!lost && config.maxInFlightIssues !== null && flight >= config.maxInFlightIssues) limit = `capacity: ${flight} of ${config.maxInFlightIssues} in flight`
    else if (!lost && free <= config.worktreeReserve) limit = `no free worktree: ${free} free, ${config.worktreeReserve} kept in reserve`
    else if (lost && free <= 0) limit = 'no free worktree'
    else limit = tierHolds(ctx, to)
    if (limit !== null) {
      if (limit.startsWith('capacity')) ctx.atCap = true
      skip(ctx, 'W1', r.issue, `W1: ${limit}`)
      continue
    }
    const g = want(ctx, {
      kind: 'slot',
      op: 'lease',
      key: next.key,
      class: 'free',
      rule: 'W1',
      reason: lost ? `the slot of ${r.state} is gone (${lifeKey(r)})` : `a slot for ${to}`,
      issue: r.issue,
      life: r.life,
      path: null,
      lease: null,
      branch: null,
      marker: null,
      keepScratch: false,
      maxAttempts: LEASE_ATTEMPTS,
    })
    // planned, or waiting out its backoff: either way it takes its place and its slot
    if (g === 'go' || g === 'wait') {
      if (!lost) flight += 1
      if (free !== null) free -= 1
    }
  }
}

// slotRules (W2, then W1): nothing while the pool's leases were not read, since every loop slot
// would look gone and every record unleased.
export function slotRules(ctx: V2Ctx): void {
  if (!ctx.v2.sources.leases.ok) {
    if (ctx.v2.records.some(r => r.state !== 'closed')) skip(ctx, 'W1', null, `W1, W2: the pool's leases were not read (${ctx.v2.sources.leases.error ?? 'not read'}); no slot is leased or freed`)
    return
  }
  frees(ctx)
  leases(ctx)
}
