// The ledger (SPEC 7): every action the loop started, under its idempotency key, with its
// status, attempts and outcome, so plan sees what is running or done and re-planning an
// unchanged state yields nothing new. Pure functions over LedgerEntry[] (no engine calls, no
// clock: the time comes in as `now`): the driver starts and finishes an entry around each
// executor, marks what a reload or the agent list proves (SPEC 7.5, 10.4), and keeps the ledger
// in $.store through the thin StoreIo below. The other half, the ledger rebuilt from the event
// log after a lost store, is derive.ts's deriveLedger. Every function returns a new array and
// replaces only the entries it changes, so changedEntries() can tell the driver what moved.
import { ACTION_KINDS, DEFAULT_CONFIG } from './config'
import { loopEventArgs } from './derive'
import type { Exec, ExtraEntry } from './exec'
import type {
  Action,
  ActionClass,
  ActionKind,
  AgentStatus,
  AgentType,
  Config,
  LedgerEntry,
  LedgerStatus,
  Ms,
  Outcome,
} from './types'

const DAY = 86_400_000
// Entries are kept 7 days after they end; running entries are never pruned (SPEC 7.1).
export const KEEP_MS = 7 * DAY
// The store holds 4 MiB of JSON for all of the plugin's keys together. The ledger keeps to three
// quarters of it, so the driver's few small keys always fit; a busy week needs about half of
// this, and dev-system's real weeks far less (SPEC 7.1).
export const LEDGER_MAX_BYTES = 3 * 1024 * 1024
// An executor's summary is a few words for the decision log; a longer one is cut.
const SUMMARY_MAX = 300

const WAKES: readonly ActionKind[] = ['judge', 'task', 'tell']
// Agents and wakes log a `loop` event (owner notices and rate-cap notices are tells); CLI work
// logs its own events and gets none (D-09, SPEC 7.4).
const LOOP_KINDS: readonly ActionKind[] = ['spawn', 'delegate', 'judge', 'task', 'tell']
const STATUSES: readonly LedgerStatus[] = ['running', 'done', 'failed', 'timed-out', 'lost']
const CLASSES: readonly ActionClass[] = ['free', 'owner', 'drive', 'develop', 'start']
const AGENT_TYPES: readonly AgentType[] = ['designer', 'implementer', 'adjudicator', 'fixer']

// --- one attempt: start and finish -------------------------------------------------------

export type Started = { ledger: LedgerEntry[]; entry: LedgerEntry; prev: LedgerEntry | null }

// start: the entry for this attempt (SPEC 5.1: a retry keeps the key and adds an attempt). A
// new key starts at attempt 1; a key that failed, timed out or was lost runs again as attempt
// n + 1, its last outcome, agent and wake cleared. A done key started again (only the title,
// which plan compares rather than keys) starts its count over: success resets it. The subject's
// fields come from the action. prev is the entry as it stood, so a pre-check that refuses the
// attempt can put it back (finish with status skipped). A wake records the session submitting it.
export function start(ledger: readonly LedgerEntry[], action: Action, now: Ms, session = ''): Started {
  const prev = ledger.find(e => e.key === action.key) ?? null
  const entry: LedgerEntry = {
    key: action.key,
    kind: action.kind,
    class: action.class,
    rule: action.rule,
    issue: action.issue,
    run: 'run' in action && typeof action.run === 'string' ? action.run : null,
    pr: 'pr' in action && typeof action.pr === 'number' ? action.pr : null,
    head: 'head' in action && typeof action.head === 'string' ? action.head : null,
    status: 'running',
    attempts: prev === null || prev.status === 'done' ? 1 : prev.attempts + 1,
    startedAt: now,
    endedAt: null,
  }
  // a delegate spawns the implementer, so its entry is that agent's (plan reads it so)
  if (action.kind === 'spawn') entry.agent = action.agent
  else if (action.kind === 'delegate') entry.agent = 'implementer'
  if (action.kind === 'judge' || action.kind === 'task' || action.kind === 'tell') {
    entry.wake = action.wake
    if (session !== '') entry.session = session
  }
  return { ledger: put(ledger, entry), entry, prev }
}

// An end that arrives outside the pass, or a transition the driver applies itself: an agent's
// turn.complete, a wake's answer, reminder or timeout, a tell delivered.
export type Completion = {
  status: LedgerStatus
  outcome?: Outcome
  summary?: string
  agentId?: string
  wakeId?: string
  turnId?: string
  reminded?: boolean
  // the count to keep: an orphaned wake gives its attempt back (wake.ts orphanedWakes)
  attempts?: number
}

export type FinishOptions = {
  // the settings in force: a usage error (noRetry) uses up exactly its kind's attempts
  config?: Config
  // start's prev: a skipped attempt puts the entry back as it stood (null: it was new)
  prev?: LedgerEntry | null
}

// finish: apply an executor's Exec or a completion to the entry under key: its status, outcome,
// agent or wake id and summary, and endedAt (none while it runs on). A finished attempt keeps
// the last outcome when the result carries none (a respond's launch record, say).
// - skipped: no attempt is counted: the entry goes back to prev, or is dropped when it was new.
// - failed with noRetry (exit 2, a loop bug): the attempts are used up, so plan never retries
//   it and tells the owner instead (SPEC 10.1).
// - extra: each ExtraEntry is recorded as a done entry of its own (a guard FAIL that `merge`
//   printed is a guard outcome, so rule M2 handles it next pass, SPEC 5.5).
// - a stop-agent of rule A1 that ended, stopped or not, marks the agent it stopped timed-out
//   (SPEC A1; SPEC 13: an agent TaskStop could not stop is left running, marked timed-out).
// It applies whatever the entry's status; a key the ledger no longer holds (pruned, say) is left
// alone. An agent's answer is matched to its entry by agentId, which a retry clears, so the
// answer of an agent a retry replaced finds no entry.
export function finish(
  ledger: readonly LedgerEntry[],
  key: string,
  result: Exec | Completion,
  now: Ms,
  opts: FinishOptions = {},
): LedgerEntry[] {
  const current = ledger.find(e => e.key === key)
  if (current === undefined) return [...ledger]
  if (result.status === 'skipped') return unstart(ledger, current, opts.prev, now, result.summary)
  const next: LedgerEntry = { ...current, status: result.status, endedAt: result.status === 'running' ? null : now }
  if (result.outcome !== undefined) next.outcome = result.outcome
  if (result.summary !== undefined) next.summary = result.summary.slice(0, SUMMARY_MAX)
  if ('agentId' in result && result.agentId !== undefined) next.agentId = result.agentId
  if ('wakeId' in result && result.wakeId !== undefined) next.wakeId = result.wakeId
  if ('turnId' in result && result.turnId !== undefined) next.turnId = result.turnId
  if ('reminded' in result && result.reminded !== undefined) next.reminded = result.reminded
  if ('attempts' in result && result.attempts !== undefined) next.attempts = result.attempts
  if (result.status === 'failed' && 'noRetry' in result && result.noRetry === true) {
    next.attempts = Math.max(next.attempts, maxAttemptsOf(opts.config ?? DEFAULT_CONFIG, attemptsKindOf(next)))
  }
  let out = put(ledger, next)
  for (const extra of 'extra' in result ? (result.extra ?? []) : []) out = put(out, extraEntry(extra, next, now))
  if (next.kind === 'stop-agent' && next.rule === 'A1' && next.status !== 'running' && key.startsWith('stop:')) {
    const agentId = key.slice('stop:'.length)
    const why = next.status === 'done' ? 'timed out: stopped' : 'timed out: the stop failed, the agent may still run'
    out = out.map(e => (e.status === 'running' && e.agentId === agentId && !isWake(e) ? ended(e, 'timed-out', now, why) : e))
  }
  return out
}

// unstart: undo start for an attempt a pre-check refused. Without prev (the driver did not keep
// it) a retried entry keeps its count and waits a backoff: failed, ended now.
function unstart(ledger: readonly LedgerEntry[], current: LedgerEntry, prev: LedgerEntry | null | undefined, now: Ms, why: string) {
  if (prev !== undefined && prev !== null) return put(ledger, prev)
  if (prev === null || current.attempts <= 1) return ledger.filter(e => e.key !== current.key)
  return put(ledger, ended({ ...current, attempts: current.attempts - 1 }, 'failed', now, `skipped: ${why}`))
}

// extraEntry: an ExtraEntry as the done entry it records, under the rule of the action that
// printed it, started when that action started.
function extraEntry(x: ExtraEntry, parent: LedgerEntry, now: Ms): LedgerEntry {
  return {
    key: x.key,
    kind: x.kind,
    class: classOf(x.kind, parent.class),
    rule: parent.rule,
    issue: x.issue,
    run: x.run,
    pr: x.pr,
    head: x.head,
    status: 'done',
    attempts: 1,
    startedAt: parent.startedAt,
    endedAt: now,
    outcome: x.outcome,
  }
}

// classOf: an action kind's class (SPEC 6.1); a spawn's depends on its agent, so it is the
// caller's.
function classOf(kind: ActionKind, spawn: ActionClass): ActionClass {
  if (kind === 'claim') return 'start'
  if (kind === 'delegate') return 'develop'
  if (kind === 'respond' || kind === 'judge' || kind === 'task') return 'drive'
  if (kind === 'tell') return 'owner'
  return kind === 'spawn' ? spawn : 'free'
}

// --- what a reload and the agent list prove (SPEC 3.3, 7.5, 10.4) -------------------------

// onLoad: on module load, every running CLI entry (no agent id, not a wake) is lost: its process
// died with the old session or module (SPEC 7.5 step 1). Plan then re-derives what to do from
// the state. Agents wait for the agent list (reconcileAgents); wakes for their answer or timeout.
export function onLoad(ledger: readonly LedgerEntry[], now: Ms): LedgerEntry[] {
  return ledger.map(e =>
    e.status === 'running' && e.agentId === undefined && !isWake(e) ? ended(e, 'lost', now, 'lost: the loop reloaded mid-action') : e,
  )
}

// reconcileAgents: a running agent entry against the session's agent list. An id the list
// lacks is lost (SPEC 3.3, 7.5); one listed failed or killed is failed (SPEC 10.4); one listed
// completed while its entry still runs ended with no answer, so it is lost. The list must be a
// successful read: an empty list marks every running agent lost.
export function reconcileAgents(
  ledger: readonly LedgerEntry[],
  agents: readonly { id: string; status: AgentStatus }[],
  now: Ms,
): LedgerEntry[] {
  const status = new Map(agents.map(a => [a.id, a.status]))
  return ledger.map(e => {
    if (e.status !== 'running' || e.agentId === undefined || isWake(e)) return e
    const seen = status.get(e.agentId)
    if (seen === undefined) return ended(e, 'lost', now, 'lost: gone from the agent list')
    if (seen === 'failed' || seen === 'killed') return ended(e, 'failed', now, `agent ${seen}`)
    if (seen === 'completed') return ended(e, 'lost', now, 'lost: completed with no answer')
    return e
  })
}

// --- keeping it small -------------------------------------------------------------------

// prune: drop entries that ended more than KEEP_MS ago; a running entry stays whatever its age
// (SPEC 7.1). An entry with no end time ages from its start.
export function prune(ledger: readonly LedgerEntry[], now: Ms): LedgerEntry[] {
  return ledger.filter(e => e.status === 'running' || now - endOf(e) <= KEEP_MS)
}

// fit: the ledger within maxBytes of JSON, the entries that ended longest ago dropped first,
// never a running one. A safety valve only: a busy week is well below LEDGER_MAX_BYTES, and a store
// over its limit would refuse the whole save, losing every change since the last one.
export function fit(ledger: readonly LedgerEntry[], maxBytes = LEDGER_MAX_BYTES): LedgerEntry[] {
  const sized = ledger.map(entry => ({ entry, size: bytes(JSON.stringify(entry)) + 1 }))
  // the envelope: { v, savedAt, entries }
  let total = sized.reduce((sum, s) => sum + s.size, 64)
  if (total <= maxBytes) return [...ledger]
  const drop = new Set<LedgerEntry>()
  const oldest = sized.filter(s => s.entry.status !== 'running').sort((a, b) => endOf(a.entry) - endOf(b.entry))
  for (const s of oldest) {
    if (total <= maxBytes) break
    drop.add(s.entry)
    total -= s.size
  }
  return ledger.filter(e => !drop.has(e))
}

// --- the store and the derived ledger (SPEC 7.1, 7.5) -------------------------------------

export type LedgerSource = 'store' | 'events' | 'none'
export type Chosen = { ledger: LedgerEntry[]; source: LedgerSource }

// choose: the store wins whenever it holds a ledger. A missing or empty store (a new device, a
// wiped config) falls back to the ledger derive.ts rebuilt from the event log; null there means
// the log could not be read. The source goes in the decision log.
export function choose(
  stored: readonly LedgerEntry[] | null | undefined,
  derived: readonly LedgerEntry[] | null | undefined,
): Chosen {
  if (stored !== null && stored !== undefined && stored.length > 0) return { ledger: [...stored], source: 'store' }
  if (derived !== null && derived !== undefined && derived.length > 0) return { ledger: [...derived], source: 'events' }
  return { ledger: [], source: 'none' }
}

// $.store, or anything shaped like it (a test's fake).
export type StoreIo = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}

export type StoredLedger = { v: 1; savedAt: Ms; entries: LedgerEntry[] }

export function storeKey(repo: string): string {
  return `ledger:${repo}`
}

// toStored: what save writes: the ledger pruned and within its size budget.
export function toStored(ledger: readonly LedgerEntry[], now: Ms): StoredLedger {
  return { v: 1, savedAt: now, entries: fit(prune(ledger, now)) }
}

// fromStored: the entries of a stored ledger, or null when the value is none (another version,
// or not a ledger at all). An entry missing a field plan relies on is dropped, and of two
// entries under one key the later start wins, as in plan.
export function fromStored(raw: unknown): LedgerEntry[] | null {
  const o = record(raw)
  if (o === null || o.v !== 1 || !Array.isArray(o.entries)) return null
  const byKey = new Map<string, LedgerEntry>()
  for (const item of o.entries) {
    const entry = entryOf(item)
    if (entry === null) continue
    const seen = byKey.get(entry.key)
    if (seen === undefined || entry.startedAt >= seen.startedAt) byKey.set(entry.key, entry)
  }
  return [...byKey.values()]
}

// load: the ledger saved for this repo, or null when the store holds none. A failing store read
// throws: replacing a ledger the loop could not read would lose its holds.
export async function load(store: StoreIo, repo: string): Promise<LedgerEntry[] | null> {
  return fromStored(await store.get(storeKey(repo)))
}

// save: prune, keep within the budget, write; returns the entries written.
export async function save(store: StoreIo, repo: string, ledger: readonly LedgerEntry[], now: Ms): Promise<LedgerEntry[]> {
  const stored = toStored(ledger, now)
  await store.set(storeKey(repo), stored)
  return stored.entries
}

// --- /factory retry (D-38) -------------------------------------------------------------------

export type Retried = { ledger: LedgerEntry[]; cleared: string[]; notices: string[] }

// retryIssue: `/factory retry <N>` clears the attempts of the issue's entries that ran out of
// them, so their rules try again (D-38, SPEC 7.1). Exhausted is plan's own rule (gate in
// plan.ts): failed, timed-out or lost with attempts at the kind's maximum. Each such entry stays
// with its count at 0 rather than going: a rule may need the failed entry to act at all (D4b
// re-delegates from the last delegate entry), and the next attempt counts from 1. The owner
// notice each one raised (agent-failed, task-timeout, update-behind) goes, unless it is still
// open, so a retry that runs out again is told again.
export function retryIssue(ledger: readonly LedgerEntry[], issue: number, config: Config): Retried {
  const spent = ledger.filter(e => e.issue === issue && exhausted(e, config))
  const cleared = spent.map(e => e.key)
  const raised = new Set(spent.flatMap(noticesOf))
  const notices = ledger.filter(e => raised.has(e.key) && e.status !== 'running').map(e => e.key)
  const out = ledger
    .filter(e => !notices.includes(e.key))
    .map(e => (cleared.includes(e.key) ? { ...e, attempts: 0, summary: 'attempts cleared by the owner (/factory retry)' } : e))
  return { ledger: out, cleared, notices }
}

function noticesOf(entry: LedgerEntry): string[] {
  const out = [`tell:agent-failed:${entry.key}`, `tell:task-timeout:${entry.key}`]
  if (entry.kind === 'update-behind') out.push(`tell:${entry.key}`)
  return out
}

// exhausted: plan's rule exactly (gate in plan.ts): a failed, timed-out or lost entry whose
// attempts reached the maximum for its kind or agent. Heartbeat and sweep never are: they retry
// at their cadence (plan.ts cadenceOf, SPEC 6.1).
export function exhausted(entry: LedgerEntry, config: Config): boolean {
  if (entry.status === 'running' || entry.status === 'done') return false
  if (entry.kind === 'heartbeat' || entry.kind === 'sweep') return false
  return entry.attempts >= maxAttemptsOf(config, attemptsKindOf(entry))
}

// attemptsKindOf: what plan counts an entry's attempts against: a spawn's agent, the implementer
// for a delegate, otherwise its kind.
export function attemptsKindOf(entry: LedgerEntry): ActionKind | AgentType {
  if (entry.kind === 'spawn') return entry.agent ?? entry.kind
  if (entry.kind === 'delegate') return 'implementer'
  return entry.kind
}

// maxAttemptsOf: plan's maxAttempts: update-behind runs updateBehindRetries + 1 times (rule
// M2b); anything else its config.maxAttempts entry, 3 when it has none.
export function maxAttemptsOf(config: Config, kind: ActionKind | AgentType): number {
  if (kind === 'update-behind') return config.updateBehindRetries + 1
  return config.maxAttempts[kind] ?? 3
}

// --- the loop's own events (D-09, SPEC 7.4) -------------------------------------------------

// loopEvent: the callum-flow-event argv for a `loop` event about this entry, for agent and wake
// entries (owner notices and rate-cap notices are tells) at their start and end; null for CLI
// kinds, which log their own events.
export function loopEvent(entry: LedgerEntry): string[] | null {
  return LOOP_KINDS.includes(entry.kind) ? ['callum-flow-event', ...loopEventArgs(entry)] : null
}

// changedEntries: the entries `after` holds that `before` did not hold as they are: new or
// changed by a transition, for the driver's loop events.
export function changedEntries(before: readonly LedgerEntry[], after: readonly LedgerEntry[]): LedgerEntry[] {
  const had = new Set(before)
  return after.filter(e => !had.has(e))
}

// --- helpers ---------------------------------------------------------------------------------

function isWake(entry: LedgerEntry): boolean {
  return WAKES.includes(entry.kind) || entry.wakeId !== undefined
}

function ended(entry: LedgerEntry, status: LedgerStatus, now: Ms, summary: string): LedgerEntry {
  return { ...entry, status, endedAt: now, summary }
}

function endOf(entry: LedgerEntry): Ms {
  return entry.endedAt ?? entry.startedAt
}

// put: the ledger with entry under its key, in place of the one there, else at the end.
function put(ledger: readonly LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
  const i = ledger.findIndex(e => e.key === entry.key)
  if (i < 0) return [...ledger, entry]
  const out = [...ledger]
  out[i] = entry
  return out
}

// bytes: an upper bound of a string's UTF-8 size (a non-ASCII UTF-16 unit counts 3 bytes).
function bytes(text: string): number {
  let extra = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) extra += 2
  return text.length + extra
}

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

const isNumOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v))
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

// entryOf: one stored entry, checked field by field. The ledger is the loop's own writing, so an
// outcome is taken as written once it names its kind.
function entryOf(raw: unknown): LedgerEntry | null {
  const o = record(raw)
  if (o === null) return null
  const { key, rule, issue, run, pr, head, attempts, startedAt, endedAt } = o
  const kind = ACTION_KINDS.find(k => k === o.kind)
  const klass = CLASSES.find(c => c === o.class)
  const status = STATUSES.find(s => s === o.status)
  if (typeof key !== 'string' || key === '' || typeof rule !== 'string') return null
  if (kind === undefined || klass === undefined || status === undefined) return null
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || !isNumOrNull(endedAt)) return null
  if (!isNumOrNull(issue) || !isNumOrNull(pr) || !isStrOrNull(run) || !isStrOrNull(head)) return null
  const entry: LedgerEntry = { key, kind, class: klass, rule, issue, run, pr, head, status, attempts, startedAt, endedAt }
  const agent = AGENT_TYPES.find(a => a === o.agent)
  if (agent !== undefined) entry.agent = agent
  if (typeof o.wake === 'string') entry.wake = o.wake
  if (typeof o.agentId === 'string') entry.agentId = o.agentId
  if (typeof o.wakeId === 'string') entry.wakeId = o.wakeId
  if (typeof o.turnId === 'string') entry.turnId = o.turnId
  if (typeof o.reminded === 'boolean') entry.reminded = o.reminded
  if (typeof o.session === 'string') entry.session = o.session
  if (typeof o.summary === 'string') entry.summary = o.summary
  const outcome = record(o.outcome)
  if (outcome !== null && typeof outcome.kind === 'string') entry.outcome = outcome as Outcome
  return entry
}
