// The v2 rule layer's vocabulary (docs/factory-loop/v2/SPEC.md): the issue record and its states
// (section 3), the transition table's events and rows (4), the action kinds of appendix B with
// their outcomes, the State fields v2 reads (2.4), the labels and notices of appendix D and the
// rule ids of 14.1. Each closed list is a frozen array here, and its type is derived from it, so
// a value read from text is checked against the same list the code is typed by. Types and
// constants only: the pure planner imports this, so nothing here may run a command or read a
// clock.
import type { PlanCtx } from '../foundation'
import type { ActionBase, ActionClass, Config, LedgerEntry, LedgerStatus, Ms, Source } from '../types'
import type { V2Event } from './events'
import type { CheckoutBase } from './reconcile'
import type { InterventionFacts } from './sources-interventions'
import type { PrsRead } from './sources-prs'
import type { RecordsShadow } from './sources-records'
import type { WindDownRead } from './wind-down'
import type { WorkspaceRead } from './workspace'

// --- states, steps and the record (v2 SPEC 3.1, 3.2) ------------------------------------------------

export const ISSUE_STATES = ['queued', 'designing', 'building', 'reviewing', 'fixing', 'merge-queue', 'parked', 'waiting', 'closed'] as const
export type IssueState = (typeof ISSUE_STATES)[number]

export const STEP_KINDS = ['lease', 'design', 'build', 'review', 'fix', 'queue', 'triage'] as const
export type StepKind = (typeof STEP_KINDS)[number]

export const CLOSED_WHYS = ['merged', 'merged-by-hand', 'dropped', 'split', 'closed-on-github', 'claim-lost'] as const
export type ClosedWhy = (typeof CLOSED_WHYS)[number]

// The states that hold a slot and count in flight (3.1): designing to merge-queue.
export const SLOT_STATES: readonly IssueState[] = ['designing', 'building', 'reviewing', 'fixing', 'merge-queue']

// The step each state runs (4.2). Parked, waiting and closed run none; a merge-queue record runs `queue`
// only while it is the queue's head (9.1).
export const STATE_STEP: Readonly<Record<IssueState, StepKind | null>> = {
  queued: 'lease',
  designing: 'design',
  building: 'build',
  reviewing: 'review',
  fixing: 'fix',
  'merge-queue': 'queue',
  parked: null,
  waiting: null,
  closed: null,
}

// The steps an agent runs (4.2), each in the issue's slot.
export const AGENT_STEPS = ['design', 'build', 'review', 'fix', 'triage'] as const
export type AgentStep = (typeof AGENT_STEPS)[number]

// Writers may write only inside their slot and push only the record's branch; readers may not
// write inside the repository (4.2, 10.4).
export type Role = 'writer' | 'reader'
export const STEP_ROLE: Readonly<Record<AgentStep, Role>> = { design: 'reader', build: 'writer', review: 'reader', fix: 'writer', triage: 'reader' }

// The class of an agent step (appendix B): develop for design and build, drive for the rest.
export const STEP_CLASS: Readonly<Record<AgentStep, ActionClass>> = { design: 'develop', build: 'develop', review: 'drive', fix: 'drive', triage: 'drive' }

// The loop-owned agent type each step spawns (5.2, 8.3, 8.7). The model is never offered them
// (register.ts agent.offer). designer-v2 is renamed designer at the delete wave.
export const STEP_AGENT: Readonly<Record<AgentStep, `factory-loop:${string}`>> = {
  design: 'factory-loop:designer-v2',
  build: 'factory-loop:builder',
  review: 'factory-loop:reviewer',
  fix: 'factory-loop:fixer',
  triage: 'factory-loop:triage',
}

// One condition a waiting record waits on (3.2, 8.7): an issue closed, a PR merged or a release
// tag that carries a commit. A record waits until every one holds. `repo` (owner/name, lower-case) names
// another repository for issue-closed and tag-contains; absent means the loop's own repo.
export type WaitCondition = { kind: 'issue-closed'; issue: number; repo?: string } | { kind: 'pr-merged'; pr: number } | { kind: 'tag-contains'; sha: string; repo?: string }

// The record (3.2). The slot is not a field: a record holds the slot whose lease holder is
// `factory-loop:<N>:<life>` (10.1).
export type IssueRecord = {
  issue: number
  // the claim's start time in base-36 seconds: unique per life (3.3, keys.ts lifeOf)
  life: string
  // +1 on every transition; part of every per-seq key
  seq: number
  // when this seq's transition happened
  seqAt: Ms
  state: IssueState
  // when it entered this state
  since: Ms
  // queued: where a lease leads (default designing); parked and waiting: where a resume leads
  resumeTo: IssueState | null
  // fixed for the life (3.5)
  branch: string
  // adopted at claim, or set when reviewing ends (8.1)
  pr: number | null
  // the head a writer step last confirmed on origin
  head: string | null
  // the patch id the reviewer approved (8.4)
  approvedPatch: string | null
  // the design brief comment URL
  brief: string | null
  // the step this seq runs: the state's own, or 'triage'; null when waiting
  step: StepKind | null
  // attempt of that step: 1 or 2 (5.1)
  attempt: number
  // this attempt already had its one free re-run (row U1)
  cut: boolean
  // triage calls in this life, at most maxTriages
  triages: number
  // entries to fixing in this life, at most fixCap
  fixes: number
  // entries to reviewing in this life
  round: number
  // parked: the question for the owner
  question: string | null
  // waiting: the conditions it waits on, every one of which must hold; null in any other state
  wait: WaitCondition[] | null
  // closed: why
  why: ClosedWhy | null
  // owner, triage and decline notes for the step of this seq
  notes: string[]
  // GitHub's closedAt of the newest hand close the record has handled (E4, P1)
  prClosedAt: string | null
  // this life's number among the issue's lives since its count last started (6.4, lives.ts): 1
  // for the first claim, and again for the first claim after the owner lifts factory:rejected
  lives: number
}

// A record's identity at one seq: what the transition executor compares before it stores (3.3).
export type RecordRef = { issue: number; life: string; seq: number }

// --- the table's input and rows (v2 SPEC 4.1, 4.6, 5) -------------------------------------------------

export const EVENT_KINDS = ['ok', 'not-ok', 'unknown', 'triage', 'drop', 'cleared', 'unpark', 'issue-closed', 'pr-merged', 'pr-closed', 'claim-lost', 'timeout'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

// The causes outside the issue that earn one free re-run per attempt (5.1, row U1).
export const OUTSIDE_CAUSES = ['load', 'usage', 'breaker', 'slot'] as const
export type OutsideCause = (typeof OUTSIDE_CAUSES)[number]

// Why a step ended unknown (7.2, intervention `unknown:<why>`). rate-limited is an API rate limit
// (a 429, or the usage window); api is any other API error (a 5xx, overloaded).
export const UNKNOWN_WHYS = ['timeout', 'agent-dead', 'bad-answer', 'api', 'rate-limited', 'spawn', 'cli', 'github-wait'] as const
export type UnknownWhy = (typeof UNKNOWN_WHYS)[number]

// The outside cause an unknown's why is by itself (5.1): a rate limit is `usage`, a free re-run
// that the step-unknown breaker does not count (5.3). Every other why is unexplained unless a fact
// plan holds (the load, the tier, the breaker, the lease) says otherwise.
export const WHY_CAUSE: Readonly<Partial<Record<UnknownWhy, OutsideCause>>> = { 'rate-limited': 'usage' }

// The triage menu (5.2).
export const TRIAGE_CHOICES = ['retry', 'fix', 'redesign', 'park', 'drop'] as const
export type TriageChoice = (typeof TRIAGE_CHOICES)[number]

// One event for a record (4.6): its kind and what the row's guard and change read.
export type TableEvent = { kind: EventKind; reason?: string; cause?: OutsideCause; why?: UnknownWhy; choice?: TriageChoice; data?: unknown }

// The reused event states a seq logs beside its `transition` on entry to a state (4.5, 7.1).
export const EMIT_STATES = ['delegated', 'fix_requested', 'merge_ready', 'abandoned'] as const
export type EmitState = (typeof EMIT_STATES)[number]

// One row of the table (4.6). `rowFor` in table.ts is the only lookup.
export type Row = {
  id: string
  states: readonly IssueState[]
  on: EventKind
  // pure guard: the guards on one (state, step, event) are exclusive and exhaustive
  when?: (r: IssueRecord, e: TableEvent, c: Config) => boolean
  next: IssueState | 'same' | 'resumeTo'
  // pure: the fields the row changes
  change: (r: IssueRecord, e: TableEvent, now: Ms) => Partial<IssueRecord>
  // the transition note's `via` code
  via: string
}

// --- what a step reports (v2 SPEC 4.2, 5.1, 10.8) -----------------------------------------------------

// A step's result, as steps.ts records it on the step's ledger entry and plan reads it: ok,
// not-ok with a reason, or unknown with why. head: a writer's head, read on origin. choice: a
// triage's. data: the checked answer the step's contract gave (contracts-*.mjs).
export type StepResult = {
  event: 'ok' | 'not-ok' | 'unknown'
  reason: string | null
  why: UnknownWhy | null
  head: string | null
  choice: TriageChoice | null
  data: unknown
}

// unknownResult: a step's unknown, with why and a short reason.
export function unknownResult(why: UnknownWhy, reason: string): StepResult {
  return { event: 'unknown', reason: reason.length > 200 ? `${reason.slice(0, 197)}...` : reason, why, head: null, choice: null, data: null }
}

// The guard's FAIL classes in --patch mode (9.3, 9.4).
export const GUARD_CLASSES = ['behind', 'conflict', 'checks', 'patch', 'linkage', 'read', 'policy'] as const
export type GuardClass = (typeof GUARD_CLASSES)[number]

export const SLOT_OPS = ['lease', 'prepare', 'kill', 'free'] as const
export type SlotOp = (typeof SLOT_OPS)[number]

// The outcomes the v2 executors record (one member of types.ts Outcome each).
export type V2Outcome =
  | { kind: 'step'; step: AgentStep; result: StepResult }
  // what a transition did, so the breaker and the interventions read it from the ledger (5.3, 7.2)
  | {
      kind: 'transition'
      row: string
      event: EventKind
      cause: OutsideCause | null
      from: IssueState | null
      to: IssueState
      step: StepKind | null
      // false from the entry's start until the executor stored the record (a lost entry may carry
      // false: the seq is the record's when the store holds it at that seq)
      stored: boolean
      // the transition note's via code (table.ts viaOf), carried from the entry's start (ledger.ts
      // start): the row's own code, with the detail its event gave where the row takes one:
      // `free:<cause>` (U1), `unknown:<why>` (U2 to U4), `fix:<review|ci|conflict>` (T9),
      // `triage:<choice>` (X1 to X5), `unpark:<op|label>` (P1). The seq's entry actions log it and
      // the interventions read it (rules-interventions.ts), so nothing is inferred from other entries.
      via: string
    }
  | { kind: 'pr'; pr: number; created: boolean; reopened: boolean }
  | { kind: 'split'; child: number }
  // a close-tracker check: the split parent found (null: the issue is no split child), whether it was closed, and the sub-issues still open
  | { kind: 'close-tracker'; parent: number | null; closed: boolean; open: number[] }
  // leftovers: the patch file a prepare or a free saved the slot's leftovers to (10.2): its uncommitted
  // work and its commits not on origin, against the commit the next step starts from; a retry's
  // prompt names it (5.1), and a resumed life finds a free's through rules-agent.ts leftoversOf; null
  // when nothing would have been lost
  | { kind: 'slot'; op: SlotOp; path: string | null; lease: string | null; head: string | null; killed: number | null; leftovers?: string | null }
  | { kind: 'queue'; op: 'update' | 'merge'; merged: boolean; head: string | null; failClass: GuardClass | null; lines: string[] }
  // an open PR adopted at claim (3.5)
  | { kind: 'adopt'; branch: string; pr: number | null; others: number[] }

// --- the action kinds (appendix B) ----------------------------------------------------------------

// How deep trackers nest: observe reads sub-issues this many levels down, and a close-tracker chain
// checks this many trackers up (state.ts re-exports it).
export const TRACKER_DEPTH = 3

export const V2_ACTION_KINDS = ['transition', 'label', 'comment', 'event', 'pr', 'split', 'agent-step', 'ci-rerun', 'queue-update', 'queue-merge', 'slot', 'link', 'close-tracker'] as const
export type V2ActionKind = (typeof V2_ACTION_KINDS)[number]

// What the transition executor re-checks against the live ledger and records before it stores
// (3.3): the life's claim entry (row S0), a step's entry as plan saw it, or an owner or GitHub
// fact (an edge whose time the record already carries).
export type Trigger =
  | { kind: 'claim'; key: string }
  | { kind: 'entry'; key: string; status: LedgerStatus; startedAt: Ms }
  | { kind: 'fact'; fact: string }

// The step marker the slot carries in its git dir (10.2), which the companion reads.
export type StepMarker = {
  v: 1
  repo: string
  issue: number
  life: string
  seq: number
  step: AgentStep
  role: Role
  branch: string
  // the issue's PR, when it has one (the companion's notes carry it); an older marker has none
  pr: number | null
  gateCommands: string[]
  gateTimeoutMs: Ms
  loopDir: string
  // the step attempt's scratch folder (keys.ts scratchOf), which the companion exports as TMPDIR; the
  // slot executor fills it, like loopDir
  scratch: string
  // the stop gates the companion runs at once, resolved from the config and the CPU count by the slot
  // executor (the planner does not know the CPUs); absent: no limit, as an older loop wrote it
  gateConcurrency?: number
  // the longest a finished writer waits for its gate's turn, set by the slot executor
  gateWaitTimeoutMs?: Ms
}

// The four reasons of a designer's split (8.7; contracts-work.mjs REASON_KEYS).
export type SplitReasons = { why_split: string; why_count: string; why_parts: string; why_order: string }

// A child a designer's split asks for (8.7).
export type SplitChild = { key: string; title: string; why: string; body: string; blockedBy: string[]; ready: boolean }

export type V2Action =
  // cause: the outside cause of an unknown (5.1), which the breaker reads; via: the note's code;
  // fromState and fromStep: the state and step the record leaves, which the entry carries from its
  // start (ledger.ts start), so a crash before it is saved done loses none of them (3.3)
  | (ActionBase & {
      kind: 'transition'
      row: string
      event: EventKind
      from: RecordRef | null
      next: IssueRecord
      trigger: Trigger
      cause?: OutsideCause | null
      via?: string
      fromState?: IssueState | null
      fromStep?: StepKind | null
    })
  // set: add the state's label and remove the other six; ensure: create the eight; clear: remove
  // the seven state labels (3.4); requeue: the seven off and `ready` on (ready: the repo's ready
  // label); reject: the seven off and factory:rejected on (both R1's release, 6.4)
  | (ActionBase & { kind: 'label'; op: LabelOp; label: FactoryLabel | null; ready?: string })
  // the body carries the hidden key <!-- factory-loop:<ledger key> --> (4.5)
  | (ActionBase & { kind: 'comment'; on: 'issue' | 'pr'; number: number; body: string })
  // built only by events.ts (7.1); logged: the event log already holds it (events.ts logOnce), so
  // the executor settles it done with no second write
  | (ActionBase & { kind: 'event'; event: V2Event; logged?: true; target?: 'new' })
  | (ActionBase & {
      kind: 'pr'
      op: 'ensure' | 'body'
      branch: string
      base: string
      pr: number | null
      title: string
      summary: string
      evidence: string | null
      brief: string | null
    })
  // a waiting record's issue linked as blocked by an issue it waits on (blocker): the GitHub dependency
  // link, once per condition; a closed blocker is skipped, a pull request is no blocker (act-split.ts)
  | (ActionBase & { kind: 'link'; blocker: number })
  // a merged split child's check upward: issue is the one to check from; its split parent is closed when every sub-issue is closed (act-tracker.ts)
  | (ActionBase & { kind: 'close-tracker' })
  // one child per action; blockedBy: the issue numbers it waits on: siblings made, or existing issues
  | (ActionBase & { kind: 'split'; parent: number; child: SplitChild; blockedBy: number[] })
  | (ActionBase & { kind: 'agent-step'; step: AgentStep; life: string; seq: number; attempt: number; branch: string; slot: string | null; notes: string[] })
  | (ActionBase & { kind: 'ci-rerun'; pr: number; runId: string; round: number })
  // base: main's head at plan time (the key's); head: the PR's head as observe read it
  | (ActionBase & { kind: 'queue-update'; pr: number; base: string; head: string })
  | (ActionBase & { kind: 'queue-merge'; issue: number; pr: number; head: string; patch: string })
  | (ActionBase & { kind: 'slot'; op: SlotOp; life: string; path: string | null; lease: string | null; branch: string | null; marker: StepMarker | null; keepScratch: boolean })

// --- labels and notices (appendix D) ---------------------------------------------------------------

export const LABEL_OPS = ['set', 'ensure', 'clear', 'requeue', 'reject'] as const
export type LabelOp = (typeof LABEL_OPS)[number]

export const FACTORY_LABEL_PREFIX = 'factory:'

export type FactoryLabel = `factory:${Exclude<IssueState, 'closed'>}`

// Each state's label (closed has none), with its colour and description (appendix D).
export const FACTORY_LABELS: Readonly<Record<Exclude<IssueState, 'closed'>, { name: FactoryLabel; color: string; description: string }>> = {
  queued: { name: 'factory:queued', color: 'c5def5', description: 'Factory loop: claimed, waiting for a slot' },
  designing: { name: 'factory:designing', color: 'bfd4f2', description: 'Factory loop: the designer is at work' },
  building: { name: 'factory:building', color: '0e8a16', description: 'Factory loop: the implementer is at work' },
  reviewing: { name: 'factory:reviewing', color: 'fbca04', description: 'Factory loop: review and CI on the PR' },
  fixing: { name: 'factory:fixing', color: 'd93f0b', description: 'Factory loop: a fixer is at work' },
  'merge-queue': { name: 'factory:merge-queue', color: '5319e7', description: 'Factory loop: approved and green, waiting to merge' },
  parked: { name: 'factory:parked', color: 'b60205', description: 'Factory loop: waits on the owner; remove this label to resume' },
  waiting: { name: 'factory:waiting', color: 'fef2c0', description: 'Factory loop: waits on a condition the loop checks; it resumes by itself' },
}

// resumeStep: how the owner resumes a parked issue (11), one text for every message that says so:
// the park comment, its tell and reminders, and the triage prompt's park choice.
export function resumeStep(issue: number): string {
  return `answer on the issue and ${resumeAction(issue)}; a comment alone does not resume`
}

// resumeAction: the two things that resume, which the park comment's numbered list (park-text.ts)
// says after its first step.
export function resumeAction(issue: number): string {
  return `remove the \`factory:parked\` label, or run \`/factory resume ${issue} "your answer"\``
}

// The label of an issue R1 released at its last life (6.4): not a state, since the issue is out of
// the factory. S1 never claims an issue carrying it; the owner removing it and adding `ready`
// brings the issue back with its life count started again.
export const REJECTED_LABEL: { name: 'factory:rejected'; color: string; description: string } = {
  name: 'factory:rejected',
  color: '6a737d',
  description: 'Factory loop: its last life ended without a merge; remove this label and add ready to try again',
}

// The owner's hold on a merge (9.1): set on the issue or its PR, the loop reads it and never makes,
// adds or removes it, so it is not in ALL_FACTORY_LABELS. It is a hold, not a state.
export const DONT_MERGE_LABEL = "don't-merge"

// sameLabel: label names are equal ignoring case.
export const sameLabel = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// Every label the loop makes (op ensure): the seven state labels, then factory:rejected.
export const ALL_FACTORY_LABELS: readonly { name: string; color: string; description: string }[] = [...Object.values(FACTORY_LABELS), REJECTED_LABEL]

// labelOf: a state's label, or null for closed.
export function labelOf(state: IssueState): FactoryLabel | null {
  return state === 'closed' ? null : FACTORY_LABELS[state].name
}

// The notice (TELL) kinds v2 adds; the first seven are owner items, which go out before any other
// wake (O2). The foundation's own (runaway, blind, heartbeat-other, old-watcher, pass-error) stay.
export const V2_OWNER_TELLS = ['parked', 'breaker', 'stalled', 'checkout', 'workspace', 'rejected', 'keep-open-blocks', 'reopened', 'records-shadow'] as const
export const V2_TELLS = [...V2_OWNER_TELLS, 'waiting', 'task-timeout', 'wind-down-stale'] as const
export type V2Tell = (typeof V2_TELLS)[number]

// --- rule ids (v2 SPEC 14.1) -------------------------------------------------------------------------

export const V2_RULES = [
  'G1', 'G2', 'G3', 'G4', 'H1', 'H2', 'R1', 'R2', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'Q1', 'Q2', 'W1', 'W2', 'O1', 'O2', 'O3',
] as const
export type V2Rule = (typeof V2_RULES)[number]

// --- interventions (v2 SPEC 7.2) ---------------------------------------------------------------------

export type InterventionWho = 'person' | 'loop'

// The cause families; `op:<name>`, `unknown:<why>`, `free:<cause>`, `fix:<what>`, `queue:<what>`
// and `guard:<what>` take their suffix from the lists above or the op's name.
export const PERSON_CAUSES = ['op', 'unpark', 'push', 'hand-merge', 'pr-closed', 'issue-closed', 'control-file', 'config-file', 'restart', 'reconcile', 'unreject', 'rescue', 'hold'] as const
export const LOOP_CAUSES = [
  'triage', 'unknown', 'free', 'park', 'fix', 'ci-rerun', 'queue', 'guard', 'gate-unknown', 'prompt-denied', 'tripwire', 'breaker', 'stalled', 'workspace', 'reconcile', 'rejected', 'reclaim', 'wake',
] as const

// --- what v2 reads (v2 SPEC 2.4) ---------------------------------------------------------------------

// A pool slot's lease, by its holder (10.1): `factory-loop:<N>:<life>` names the loop's own.
export type Lease = { path: string; lease: string; holder: string; issue: number | null; life: string | null; status: string; busy: boolean }

// The newest issue read observe holds, and when it was taken: the parked label's absence in a
// read newer than the park is the unpark signal (3.4).
export type IssueRead = { at: Ms; open: boolean | null; labels: string[] | null }

// One wait condition as the last successful read showed it, and when that read was taken (4.4).
// `tag`: the release tag a tag-contains read compared against, so it is read again only when the tag changes.
export type WaitRead = { at: Ms; held: boolean; tag?: string }

// An open release bump PR (sources-release.ts): its branch and GitHub's creation time, which the
// merge queue's hold window runs from (9.1).
export type ReleasePr = { pr: number; branch: string; createdAt: Ms }
// What the merge queue's release hold reads: the open bump PRs, and how the ones that left the list
// ended (merged or closed), until their end is logged.
export type ReleasePrsRead = { prs: ReleasePr[]; left: Record<number, 'merged' | 'closed'> }

// A trusted comment on an issue (callum-flow-issue-read --comments), for a resume's note (11).
export type IssueComment = { body: string; at: Ms; url: string | null }

// When observe first saw a PR head (2.4): it bounds the waits on GitHub (4.4).
export type HeadSeen = { pr: number; at: Ms }

export const V2_SOURCES = ['store', 'leases', 'prs', 'interventions', 'comments', 'dualWrite', 'releasePrs'] as const
// What the new event log holds, read once per load when dual write is on (sources-dualwrite.ts): when it
// was read and the "<issue>:<life>:<seq>" of this device's transitions it holds.
export type DualWrite = { readAt: Ms; seen: ReadonlySet<string> }

export type V2SourceName = (typeof V2_SOURCES)[number]

// The State fields v2 adds (2.4), as State.v2: observeV2 reads them every pass; absent in a state
// built outside a pass.
export type V2State = {
  sources: Record<V2SourceName, Source>
  records: IssueRecord[]
  // where the records came from: the store (act mode's), the event log (a rebuild), or neither
  recordsFrom: 'store' | 'events' | 'none'
  // by head sha
  heads: Record<string, HeadSeen>
  leases: Lease[]
  // the newest read of each issue observe holds, by issue number
  reads: Record<number, IssueRead>
  // trusted comments of parked records whose label a person removed, by issue number
  comments: Record<number, IssueComment[]>
  prs: PrsRead
  // the conditions waiting records wait on, by key (`issue:57`, `pr:812`, `tag:35bb655`): the last read that
  // showed one; a condition with no entry was not read, or its read failed, and stays open
  waits?: Record<string, WaitRead>
  // the open release bump PRs (sources-release.ts) the merge queue holds for; absent: none read
  releasePrs?: ReleasePrsRead
  // when the PR reads showed each issue's PR closed or merged (GitHub's closedAt), by issue number:
  // an older read of the issue is due at once, and pr-closed waits for it (4.1)
  changed: Record<number, Ms>
  interventions: InterventionFacts
  // the onceKeys (events.ts) of this device's events in the pass's read of the event log (the facts
  // read, 2.4, or the rebuild's week): which facts are logged, when a wiped store lost their ledger
  // keys (7.2)
  logged: string[]
  // the main checkout the tripwire last settled on, which R1 compares this pass's read with
  // (10.7; reconcile.ts checkoutBaseOf); null before the first read that did not fail
  checkoutBase: CheckoutBase | null
  // the new log's transitions; null when dual write is off or not read (act mode, planner v2 only)
  dualWrite: DualWrite | null
  // the last compare of the record rebuild's two stores (sources-records.ts), as of the pass that made it; absent: none made this load
  recordsShadow?: RecordsShadow
  // the workspace rail: the companion's handshake for this session (10.9; workspace.ts); absent
  // when not read, which holds nothing
  workspace?: WorkspaceRead
  // the wind-down request, stop-now file and last status (10.11; wind-down.ts); absent when not read
  windDown?: WindDownRead
}

// The pure planner's context: the foundation's, with the v2 fields every rule reads.
export type V2Ctx = PlanCtx & { v2: V2State }

// --- what the executors may change beside the ledger (v2 SPEC 3.3, 4.6) -------------------------------

// The live records: only the transition executor updates them, under the act lock. update applies
// fn to the records as they are now (null: no change), saves them to the store, and resolves once
// saved; changed is false when fn changed nothing or the store refused the write.
export type V2Io = {
  records: () => readonly IssueRecord[]
  // the live ledger, which the transition executor re-checks its trigger against (3.3)
  ledger?: () => readonly LedgerEntry[]
  updateRecords: (fn: (records: readonly IssueRecord[]) => IssueRecord[] | null) => Promise<{ changed: boolean; saved: boolean }>
  // asks the driver for the next pass at once: a transition's next event is taken without delay
  ping: (why: string) => void
}

// --- settings (appendix A) ------------------------------------------------------------------------

// the model aliases the agent tool accepts; a setting named *Model takes one of them
export const MODELS = ['sonnet', 'opus', 'haiku', 'fable'] as const
export type Model = (typeof MODELS)[number]

// The timeouts and tell periods of 4.4, by step and waiting state.
export type StateTimeouts = { design: Ms; build: Ms; review: Ms; fix: Ms; triage: Ms; queued: Ms; queueWait: Ms; parked: Ms; waiting: Ms }
