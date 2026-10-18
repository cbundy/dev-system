// What v2 reads (docs/factory-loop/v2/SPEC.md 2.4), beside what observe.ts reads for both layers:
// the records (the store's, else a rebuild from events, 3.3), the heads first seen, the pool's
// leases by holder (no reflog reads, 10.1), the newest read of each issue, the trusted comments of
// a parked record whose label a person removed (11), the facts the event log holds as logged (from
// observe.ts's read of the log, 7.2), and the source modules: the PRs
// (sources-prs.ts) and the interventions' facts (sources-interventions.ts). observe.ts calls
// observeV2 every pass; register.ts keeps the store keys
// records:<repo> and heads:<repo> with the codecs here. Commands run through observe's own `run`,
// so they join the pass's command list and, outside act mode, send their events to the sink.
import type { FactoryEvent } from '../derive'
import type { Cache, Io, Runtime } from '../observe'
import type { LedgerEntry, Ms, Source, State } from '../types'
import { onceKey } from './events'
import { checkoutBaseOf } from './reconcile'
import type { CheckoutBase } from './reconcile'
import { readDualWrite } from './sources-dualwrite'
import type { DualWriteRead } from './sources-dualwrite'
import { EMPTY_RELEASE, readReleasePrs } from './sources-release'
import type { ReleaseCache } from './sources-release'
import { readWaits } from './sources-waits'
import { readInterventions } from './sources-interventions'
import type { FilesSeen } from './sources-interventions'
import { EMPTY_PRS, readPrs } from './sources-prs'
import type { PrView, PrsRead, PrUnread } from './sources-prs'
import { readRecords } from './sources-records'
import type { RecordsShadow } from './sources-records'
import { readWorkspace } from './sources-workspace'
import { windDownPaths } from './wind-down'
import type { WindDownRead } from './wind-down'
import { previousOf, requestOf } from './wind-down-files'
import { CLOSED_WHYS, FACTORY_LABELS, ISSUE_STATES, STEP_KINDS } from './types'
import type { HeadSeen, IssueComment, IssueRead, IssueRecord, Lease, V2SourceName, V2State, WaitRead } from './types'

const DAY = 86_400_000
// a closed record goes this long after it closed, as ledger entries do (3.3, v2 SPEC 13.7.1)
export const RECORD_KEEP_MS = 7 * DAY

// What a source module gets (sources-*.ts): the pass's time and runtime, observe's read (its
// commands logged), the State observe built, the records and heads, the records whose PR it may
// read this pass (prBudget: K, a budget of its own beside v1's issue reads; none during a GitHub
// backoff or after a rate limit this pass), whether a rate limit met this pass ends its reads, the
// PRs the last pass tried that did not read (sources-prs.ts, PrUnread.since), and the views of
// earlier passes whose read is not due, which stand for this pass's (observeV2).
export type SourceCtx = {
  now: Ms
  rt: Runtime
  run: (argv: string[], stdin?: string, timeoutMs?: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  readFile: Io['readFile']
  state: State
  records: readonly IssueRecord[]
  heads: Record<string, HeadSeen>
  prBudget: number
  limited: () => boolean
  unread: readonly PrUnread[]
  kept: readonly PrView[]
  // the newest read of each issue, which the queue's hold on a label reads; absent: none known
  reads?: Record<number, IssueRead>
  // the newest release tag observe read (observe-milestone.ts); null when none is known
  tag: string | null
}

// What the store holds for v2, as register.ts passes it (v2/store.ts): records null when the key
// holds none (a rebuild may fill it); error when the store could not be read or holds no stored
// records under the key, so nothing is known of the records; files: the owner's files as the loop
// last read or wrote them (7.2), absent or null when none are kept.
export type V2Stored = { records: IssueRecord[] | null; heads: Record<string, HeadSeen> | null; files?: FilesSeen | null; error: string | null }

// What survives between passes in the module: the heads (an observe pass keeps none in the store),
// the last rebuild, the comments read per issue read, the checkout R1's tripwire last settled on
// (reconcile.ts checkoutBaseOf), and the last pass's PR read: its views, which stand until their
// read is due, and the PRs it tried that did not read, so a run of failed reads keeps its start (a
// new session starts both afresh).
export type V2Cache = {
  heads: Record<string, HeadSeen>
  rebuilt: { at: Ms; records: IssueRecord[] } | null
  // the last compare of the record rebuild's two stores (sources-records.ts); null: none this load
  shadow: RecordsShadow | null
  comments: Map<number, { readAt: Ms; comments: IssueComment[] }>
  checkoutBase: CheckoutBase | null
  // the last pass's V2State.changed: a read of an issue older than its entry is due (observe.ts)
  changed: Record<number, Ms>
  prs: PrsRead
  // the wait conditions' last reads (sources-waits.ts)
  waits: Record<string, WaitRead>
  // the release bump PRs the merge queue holds for (sources-release.ts)
  release: ReleaseCache
  // the dual-write probe and the new log's read, once per load; null: not yet read
  dualWrite: { at: Ms; read: DualWriteRead } | null
}

export function emptyV2Cache(): V2Cache {
  return { heads: {}, rebuilt: null, shadow: null, comments: new Map(), checkoutBase: null, changed: {}, prs: EMPTY_PRS, waits: {}, release: EMPTY_RELEASE, dualWrite: null }
}

// --- the store's records and heads (3.3, 2.4) -------------------------------------------------------

export const recordsKey = (repo: string) => `records:${repo}`
export const headsKey = (repo: string) => `heads:${repo}`

export type StoredRecords = { v: 1; savedAt: Ms; records: IssueRecord[] }

// recordsToStore: what the store keeps: every record but those closed more than RECORD_KEEP_MS ago.
export function recordsToStore(records: readonly IssueRecord[], now: Ms): StoredRecords {
  return { v: 1, savedAt: now, records: records.filter(r => r.state !== 'closed' || now - r.since <= RECORD_KEEP_MS) }
}

// recordsFromStore: the stored records, each checked field by field (one that does not read is
// dropped); null when the value is not stored records at all.
export function recordsFromStore(raw: unknown): IssueRecord[] | null {
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (o === null || o.v !== 1 || !Array.isArray(o.records)) return null
  return o.records.map(recordOf).filter((r): r is IssueRecord => r !== null)
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

// recordOf: one record as the store or an event holds it, every field checked; null when one does
// not read.
export function recordOf(raw: unknown): IssueRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const state = ISSUE_STATES.find(s => s === o.state)
  const resumeTo = o.resumeTo === null ? null : ISSUE_STATES.find(s => s === o.resumeTo)
  const step = o.step === null ? null : STEP_KINDS.find(s => s === o.step)
  const why = o.why === null ? null : CLOSED_WHYS.find(w => w === o.why)
  if (state === undefined || resumeTo === undefined || step === undefined || why === undefined) return null
  if (!isInt(o.issue, 1) || !isStr(o.life) || o.life === '' || !isInt(o.seq, 0) || !isNum(o.seqAt) || !isNum(o.since)) return null
  if (!isStr(o.branch) || o.branch === '' || !(o.pr === null || isInt(o.pr, 1)) || !strOrNull(o.head) || !strOrNull(o.approvedPatch) || !strOrNull(o.brief)) return null
  if (!isInt(o.attempt, 0) || typeof o.cut !== 'boolean' || !isInt(o.triages, 0) || !isInt(o.fixes, 0) || !isInt(o.round, 0)) return null
  const wait = waitOf(o.wait)
  if (wait === undefined) return null
  if (!strOrNull(o.question) || !Array.isArray(o.notes) || !o.notes.every(isStr) || !strOrNull(o.prClosedAt)) return null
  // a record stored before the field carries no count: its life is read as a first one
  const lives = o.lives === undefined ? 1 : o.lives
  if (!isInt(lives, 1)) return null
  return {
    issue: o.issue,
    life: o.life,
    seq: o.seq,
    seqAt: o.seqAt,
    state,
    since: o.since,
    resumeTo,
    branch: o.branch,
    pr: o.pr as number | null,
    head: o.head,
    approvedPatch: o.approvedPatch,
    brief: o.brief,
    step,
    attempt: o.attempt,
    cut: o.cut,
    triages: o.triages,
    fixes: o.fixes,
    round: o.round,
    question: o.question,
    wait,
    why,
    notes: [...o.notes],
    prClosedAt: o.prClosedAt,
    lives,
  }
}

// waitOf: a stored record's wait conditions; null when absent or null (a record stored before the
// field); undefined when it does not read.
function waitOf(raw: unknown): IssueRecord['wait'] | undefined {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return undefined
  const out: NonNullable<IssueRecord['wait']> = []
  for (const c of raw) {
    const o = c !== null && typeof c === 'object' ? (c as Record<string, unknown>) : {}
    const repo = o.repo === undefined || o.repo === null ? undefined : typeof o.repo === 'string' && /^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(o.repo) ? o.repo : null
    if (repo === null) return undefined
    const r = repo === undefined ? {} : { repo }
    if (o.kind === 'issue-closed' && isInt(o.issue, 1)) out.push({ kind: 'issue-closed', issue: o.issue, ...r })
    else if (o.kind === 'pr-merged' && isInt(o.pr, 1) && repo === undefined) out.push({ kind: 'pr-merged', pr: o.pr })
    else if (o.kind === 'tag-contains' && typeof o.sha === 'string' && /^[0-9a-f]{7,40}$/.test(o.sha)) out.push({ kind: 'tag-contains', sha: o.sha, ...r })
    else return undefined
  }
  return out
}

// headsToStore and headsFromStore: the heads first seen, { v: 1, heads: { <sha>: { pr, at } } }.
export function headsToStore(heads: Record<string, HeadSeen>): { v: 1; heads: Record<string, HeadSeen> } {
  return { v: 1, heads }
}

export function headsFromStore(raw: unknown): Record<string, HeadSeen> | null {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const heads = o !== null && o.v === 1 && o.heads !== null && typeof o.heads === 'object' ? (o.heads as Record<string, unknown>) : null
  if (heads === null) return null
  const out: Record<string, HeadSeen> = {}
  for (const [sha, v] of Object.entries(heads)) {
    const h = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
    if (/^[0-9a-f]{7,64}$/.test(sha) && h !== null && isInt(h.pr, 1) && isNum(h.at)) out[sha] = { pr: h.pr, at: h.at }
  }
  return out
}

// --- leases (10.1) ------------------------------------------------------------------------------------

// The holder the loop leases a slot with: factory-loop:<N>:<life>.
export function holderOf(issue: number, life: string): string {
  return `factory-loop:${issue}:${life}`
}

const HOLDER = /^factory-loop:([1-9]\d*):([0-9a-z]+)$/

// leasesOf: the pool's leased slots from `treehouse status --json`, by holder: the loop finds its
// own by `factory-loop:<N>:<life>` and never infers an owner from a reflog. null when it does not
// read.
export function leasesOf(json: string): Lease[] | null {
  try {
    const list: unknown = JSON.parse(json)
    if (!Array.isArray(list)) return null
    const out: Lease[] = []
    for (const raw of list) {
      const w = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const lease = typeof w.lease_id === 'string' ? w.lease_id : ''
      if (lease === '' || typeof w.path !== 'string') continue
      const holder = typeof w.lease_holder === 'string' ? w.lease_holder : ''
      const m = HOLDER.exec(holder)
      out.push({
        path: w.path,
        lease,
        holder,
        issue: m?.[1] === undefined ? null : Number(m[1]),
        life: m?.[2] ?? null,
        status: typeof w.status === 'string' ? w.status : 'unknown',
        busy: Array.isArray(w.processes) && w.processes.length > 0,
      })
    }
    return out
  } catch {
    return null
  }
}

// --- the read cadence and order (2.4) ------------------------------------------------------------------

// readDue: a read is due when there is none, it is everyMs old, or something the loop knows
// changed what it read at or after it was taken (changedAt). The queue, issue and PR reads all
// take this one rule (2.4).
export function readDue(at: Ms | undefined, now: Ms, everyMs: Ms, changedAt: Ms): boolean {
  return at === undefined || now - at >= everyMs || changedAt >= at
}

// lastEnded: when the newest ledger entry `pick` takes ended; -Infinity when none has.
export function lastEnded(ledger: readonly LedgerEntry[], pick: (e: LedgerEntry) => boolean): Ms {
  return Math.max(-Infinity, ...ledger.flatMap(e => (pick(e) && e.endedAt !== null ? [e.endedAt] : [])))
}

// readOrder: the records' issues in the order GitHub reads take them: the merge queue's head, the
// other records in reviewing and merge-queue, parked records, then the other live ones. The
// queue's head is the merge-queue record whose step is `queue` with the oldest seqAt (9.1).
export function readOrder(records: readonly IssueRecord[]): number[] {
  const live = records.filter(r => r.state !== 'closed')
  const byAge = (a: IssueRecord, b: IssueRecord) => a.seqAt - b.seqAt || a.issue - b.issue
  const head = live.filter(r => r.state === 'merge-queue' && r.step === 'queue').sort(byAge)[0]
  const rank = (r: IssueRecord) => (r === head ? 0 : r.state === 'reviewing' || r.state === 'merge-queue' ? 1 : r.state === 'parked' || r.state === 'waiting' ? 2 : 3)
  return [...new Set([...live].sort((a, b) => rank(a) - rank(b) || byAge(a, b)).map(r => r.issue))]
}

// --- one pass's v2 reads ---------------------------------------------------------------------------------

// The source modules' reads, a test's own in place of the real ones.
export type V2Readers = { prs: typeof readPrs; interventions: typeof readInterventions }
const READERS: V2Readers = { prs: readPrs, interventions: readInterventions }

export type ObserveV2Input = {
  io: Io
  rt: Runtime
  cache: V2Cache
  // observe's own run, which logs each command and runs it with the environment it is given
  run: (argv: string[], stdin?: string, timeoutMs?: number, env?: Record<string, string>) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  state: State
  // the newest release tag (observe-milestone.ts); none or null when unknown
  tag?: string | null
  // the store's, as register.ts read it; undefined when it read none
  stored: V2Stored | undefined
  // `treehouse status --json` as observe read it this pass; null when it did not
  poolJson: string | null
  github: Cache['github']
  // the pass's read of the event log (observe.ts: the rebuild's week on the pass it ran, else the
  // facts read); none when the caller has none
  events?: readonly FactoryEvent[]
  // a GitHub backoff holds this pass's reads; limited: a rate limit met this pass ends them
  backoff: boolean
  limited: () => boolean
  readers?: V2Readers
}

const NOT_READ = (why: string): Source => ({ ok: false, at: null, error: why })

// observeV2: the State fields v2 reads (2.4), and the heads to keep. Its GitHub reads go in 2.4's
// order with budgets of their own: the PRs of the queue's head, then of the other records in
// reviewing and merge-queue (sources-prs.ts, at most K records), then the comments of parked
// records a person unparked; v1's issue reads before them took the records' issues first
// (observe.ts, readOrder).
export async function observeV2(input: ObserveV2Input): Promise<{ v2: V2State; heads: Record<string, HeadSeen> }> {
  const { rt, cache, state } = input
  const readers = input.readers ?? READERS
  const now = state.now
  const sources = {} as Record<V2SourceName, Source>
  const blocked = () => input.backoff || input.limited()
  const run: SourceCtx['run'] = (argv, stdin, t) => input.run(argv, stdin, t)

  // the records: the store's, else a rebuild from this device's transition events (3.3); none
  // when the store could not be read, which the planner reads as blind for them
  const stored = input.stored
  let records: IssueRecord[] = stored?.records ?? []
  let recordsFrom: V2State['recordsFrom'] = stored?.records !== null && stored?.records !== undefined ? 'store' : 'none'
  sources.store = stored?.error ? NOT_READ(stored.error) : { ok: true, at: now }
  // the rebuild (when the store holds none) and the shadow compare of the two stores (sources-records.ts)
  const storeEmpty = recordsFrom === 'none' && !stored?.error
  const rebuildError = await readRecords({ now, rt, run }, cache, storeEmpty)
  if (rebuildError !== null) sources.store = { ok: false, at: cache.rebuilt?.at ?? null, error: rebuildError }
  if (storeEmpty && cache.rebuilt !== null && cache.rebuilt.records.length > 0) {
    records = cache.rebuilt.records
    recordsFrom = 'events'
  }

  // the newest read of each issue observe holds
  const reads: Record<number, IssueRead> = {}
  for (const [n, c] of input.github) reads[n] = { at: c.at, open: c.value.facts?.open ?? null, labels: c.value.facts?.labels ?? null }

  // the leases, by holder
  const leases = input.poolJson === null ? null : leasesOf(input.poolJson)
  sources.leases = leases === null ? NOT_READ(input.poolJson === null ? 'the pool was not read' : 'treehouse status did not read') : { ok: true, at: now }

  // the PRs first: the queue's head, then reviewing and merge-queue, at most K records (2.4); a
  // view stands until its read is due: prEveryMs, or its record's transition or an action of the
  // loop's own on its PR since
  const heads = input.stored?.heads ?? cache.heads
  const kept = cache.prs.prs.filter(v => {
    const r = records.find(x => x.issue === v.issue)
    return r !== undefined && !readDue(v.readAt, now, rt.config.prEveryMs, Math.max(r.seqAt, lastEnded(state.ledger, e => e.pr === v.pr)))
  })
  const ctx: SourceCtx = {
    now,
    rt,
    run,
    readFile: input.io.readFile,
    state,
    records,
    heads,
    prBudget: blocked() ? 0 : (rt.config.maxInFlightIssues ?? rt.poolSize),
    limited: input.limited,
    unread: cache.prs.unread ?? [],
    kept,
    reads,
    tag: input.tag ?? null,
  }
  const prs = await readers.prs(ctx)
  sources.prs = prs.source
  cache.heads = prs.heads
  cache.prs = prs.read
  cache.changed = {}
  for (const p of prs.read.prs) if (p.state !== 'open' && p.closedAt !== null) cache.changed[p.issue] = Date.parse(p.closedAt)

  // the wait conditions of waiting records (sources-waits.ts): none read during a GitHub backoff
  const waited = await readWaits(ctx, cache.waits, rt.config.githubEveryMs)
  cache.waits = waited.waits

  // the release bump PRs the merge queue holds for (sources-release.ts)
  const release = await readReleasePrs(ctx, cache.release)
  cache.release = release.read
  sources.releasePrs = release.source

  // then parked records whose label a read newer than their park lacks: their trusted comments,
  // once per read, for the resume's note (11)
  const comments: Record<number, IssueComment[]> = {}
  let commentsOk = true
  for (const r of records.filter(x => x.state === 'parked')) {
    const read = reads[r.issue]
    if (read === undefined || read.at <= r.since || read.labels === null || read.labels.includes(FACTORY_LABELS.parked.name)) continue
    const kept = cache.comments.get(r.issue)
    if (kept !== undefined && kept.readAt === read.at) {
      comments[r.issue] = kept.comments
      continue
    }
    if (blocked()) {
      commentsOk = false
      continue
    }
    try {
      const c = await run(['callum-flow-issue-read', '--json', String(r.issue), '--comments'])
      const parsed = c.exitCode === 0 ? commentsOf(c.stdout) : null
      if (parsed === null) commentsOk = false
      else {
        cache.comments.set(r.issue, { readAt: read.at, comments: parsed })
        comments[r.issue] = parsed
      }
    } catch {
      commentsOk = false
    }
  }
  for (const n of [...cache.comments.keys()]) if (!records.some(r => r.issue === n && r.state === 'parked')) cache.comments.delete(n)
  sources.comments = commentsOk ? { ok: true, at: now } : NOT_READ(blocked() ? 'GitHub rate limit' : 'a comment read failed')

  const facts = await readers.interventions({ ...ctx, heads: prs.heads })
  sources.interventions = facts.source

  // dual write (4.1): act mode only, once per load; a failed read retries when due
  let dualWrite: V2State['dualWrite'] = null
  sources.dualWrite = { ok: true, at: now }
  if (rt.mode === 'act') {
    if (cache.dualWrite === null || (cache.dualWrite.read.error !== null && now - cache.dualWrite.at >= rt.config.githubEveryMs)) {
      cache.dualWrite = { at: now, read: await readDualWrite(ctx) }
    }
    dualWrite = cache.dualWrite.read.dualWrite
    if (cache.dualWrite.read.error !== null) sources.dualWrite = { ok: false, at: null, error: cache.dualWrite.read.error }
  }

  // the tripwire's base moves only past a read with nothing left untold (10.7)
  cache.checkoutBase = checkoutBaseOf(cache.checkoutBase, state.checkout, state.ledger, now)
  // the workspace rail: does the companion run in this session and process (10.9)
  const workspace = rt.workspace === undefined ? undefined : await readWorkspace(input.io, rt.loopDir, rt.workspace.session, rt.workspace.process, now)
  const v2: V2State = {
    sources,
    records,
    recordsFrom,
    heads: prs.heads,
    leases: leases ?? [],
    reads,
    comments,
    prs: prs.read,
    waits: cache.waits,
    releasePrs: { prs: cache.release.prs, left: cache.release.left },
    changed: cache.changed,
    interventions: { ...facts.read, seen: stored?.files ?? null },
    logged: [...new Set((input.events ?? []).flatMap(e => (e.device === null || e.device === rt.device ? (onceKey(e) ?? []) : [])))],
    checkoutBase: cache.checkoutBase,
    dualWrite,
    ...(cache.shadow === null ? {} : { recordsShadow: cache.shadow }),
  }
  if (workspace !== undefined) v2.workspace = workspace
  v2.windDown = await readWindDown(input.io, rt, now)
  return { v2, heads: prs.heads }
}

// readWindDown: the request, the stop-now file and last pass's status (wind-down.ts). A missing
// request is none; one that is there but unreadable or malformed is a request at the file's
// mtime (now when that does not read), so a bad write never leaves the loop starting work.
async function readWindDown(io: Io, rt: Runtime, now: Ms): Promise<WindDownRead> {
  const paths = windDownPaths(rt.loopDir)
  const text = async (path: string) => io.readFile(path).catch(() => null)
  const requestText = await text(paths.request)
  // stat reads the modification time and, when the request did not read, tells a missing file (no
  // request) from one there but unreadable (a mode 000 file, a directory): that one is a request too
  let mtime: Ms | null = null
  try {
    const r = await io.run(['stat', '-c', '%Y', paths.request], { cwd: rt.cwd, env: rt.env, timeoutMs: 10_000 })
    const secs = Number(r.stdout.trim())
    if (r.exitCode === 0 && r.stdout.trim() !== '' && Number.isFinite(secs)) mtime = secs * 1000
  } catch {
    // now stands
  }
  const request: WindDownRead['request'] = requestText !== null ? requestOf(requestText, mtime ?? now) : mtime !== null ? requestOf('', mtime) : null
  if (request === null) return { request, stopNow: false, previous: null }
  return { request, stopNow: (await text(paths.stopNow)) !== null, previous: previousOf(await text(paths.status)) }
}

// commentsOf: the trusted comments of `callum-flow-issue-read --json N --comments`, oldest first;
// null when it does not read.
export function commentsOf(json: string): IssueComment[] | null {
  try {
    const list: unknown = (JSON.parse(json) as { comments?: unknown }).comments
    if (!Array.isArray(list)) return null
    const out: IssueComment[] = []
    for (const raw of list) {
      const c = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const at = typeof c.created_at === 'string' ? Date.parse(c.created_at) : Number.NaN
      if (typeof c.body !== 'string' || Number.isNaN(at)) continue
      out.push({ body: c.body, at, url: typeof c.html_url === 'string' ? c.html_url : null })
    }
    return out.sort((a, b) => a.at - b.at)
  } catch {
    return null
  }
}

// emptyV2State: a V2State with nothing read, for a state built outside a pass (the replay harness).
export function emptyV2State(now: Ms, records: IssueRecord[] = []): V2State {
  const off: Source = { ok: false, at: null, error: 'not read' }
  return {
    sources: { store: { ok: true, at: now }, leases: off, prs: off, interventions: off, comments: off, dualWrite: { ok: true, at: now }, releasePrs: { ok: true, at: now } },
    records,
    recordsFrom: records.length > 0 ? 'store' : 'none',
    heads: {},
    leases: [],
    reads: {},
    comments: {},
    prs: { prs: [] },
    changed: {},
    interventions: { companion: [], gates: [], controlDigest: null, configDigest: null },
    logged: [],
    checkoutBase: null,
    dualWrite: null,
  }
}
