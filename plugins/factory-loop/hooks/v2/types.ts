// The v2 rule layer's vocabulary (docs/factory-loop/v2/SPEC.md): the issue record and its states
// (section 3), the transition table's events and rows (4), the action kinds of appendix B with
// their outcomes, the State fields v2 reads (2.4), the labels and notices of appendix D and the
// rule ids of 14.1. Each closed list is a frozen array here, and its type is derived from it, so
// a value read from text is checked against the same list the code is typed by. Types and
// constants only: the pure planner imports this, so nothing here may run a command or read a
// clock.
import type { PlanCtx } from '../foundation'
import type { Snapshot } from '../settings-snapshot'
import type { ActionBase, ActionClass, Config, LedgerEntry, LedgerStatus, Ms, Source } from '../types'
import type { V2Event } from './events'
import type { CheckoutBase } from './reconcile'
import type { InterventionFacts } from './sources-interventions'
import type { PrsRead } from './sources-prs'
import type { FactsShadow } from './sources-facts'
import type { FlakesRead } from './sources-flakes'
import type { RecordsShadow } from './sources-records'
import type { WindDownRead } from './wind-down'
import type { CapInfo } from './capacity'
import type { WorkspaceRead } from './workspace'
import type { StampOwned, StampTries, Stamps } from './stamps'
import type { QueueView } from './queue-view'
import type { MainReading } from './types-facts'
import type { ReleasePrsRead } from './release-hold-types'
import type { TrainAction, TrainDrop, TrainOutcome, TrainRead } from './train-types'

export { LOOP_CAUSES, PERSON_CAUSES } from './types-facts'
export type { InterventionWho, MainDeployment, MainReading, MainRun, MainWorkflow } from './types-facts'

// --- states, steps and the record (v2 SPEC 3.1, 3.2) ------------------------------------------------

export const ISSUE_STATES = ['queued', 'designing', 'building', 'reviewing', 'fixing', 'merge-queue', 'parked', 'waiting', 'closed'] as const
export type IssueState = (typeof ISSUE_STATES)[number]

export const STEP_KINDS = ['lease', 'design', 'build', 'review', 'fix', 'queue', 'triage'] as const
export type StepKind = (typeof STEP_KINDS)[number]

export const CLOSED_WHYS = ['merged', 'merged-by-hand', 'dropped', 'split', 'closed-on-github', 'claim-lost', 'done'] as const
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

// The parts of a structured question for the owner (3.2, 11): what the agent gave before the loop
// rendered them into `question`. `decision` is the one sentence; options are 2 to 6 closed, with a
// null detail when none was given; `recommended` names one of the options, `recommendation` is why.
export type OptionKey = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
export type ParkParts = {
  decision: string
  context: string | null
  options: { key: OptionKey; title: string; detail: string | null }[] | null
  recommended: OptionKey | null
  recommendation: string | null
}

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
  // entries to fixing in this life for a round not caused by other merges, at most reviewFixCap
  fixes: number
  // entries to fixing in this life for a round caused by other merges (a conflict, or red CI in
  // the merge queue), at most conflictFixCap
  conflicts: number
  // fixing: the environment-blocker reasons of the previous fix round in this life (one clipped line,
  // at most 1000 characters), null when that round had none; a second round with one parks (T19, T20)
  envBlocked: string | null
  // entries to reviewing in this life
  round: number
  // parked: the question for the owner
  question: string | null
  // parked: the parts of that question when an agent structured it, else null (always null in any
  // other state); `question` is their rendering
  parts: ParkParts | null
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
// (a 429, or the usage window); api is any other API error (a 5xx, overloaded); stopped is a step
// whose agent the loop itself stopped (a stop-agent names it) and that gave no answer: no free
// re-run by itself, and not a death (agent-dead).
export const UNKNOWN_WHYS = ['timeout', 'agent-dead', 'bad-answer', 'api', 'rate-limited', 'spawn', 'cli', 'github-wait', 'stopped'] as const
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

// The reused event states a seq logs beside its `transition` (4.5, 7.1): a drop's `abandoned`.
export const EMIT_STATES = ['abandoned'] as const
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
  // an upstream request: the issue raised in another repo, made now or found by its marker
  | { kind: 'upstream'; repo: string; issue: number; made: boolean }
  // F1: the flake bug filed or found, with what its tell says (rules-flake-bugs.ts)
  | { kind: 'flake-bug'; issue: number; made: boolean; ready: boolean; test: string; flakes: number; windowDays: number; firstFlakeAt: string; reason: string }
  // a close-tracker check: the split parent found (null: the issue is no split child), whether it was closed, and the sub-issues still open
  | { kind: 'close-tracker'; parent: number | null; closed: boolean; open: number[] }
  // leftovers: the patch file a prepare or a free saved the slot's leftovers to (10.2): its uncommitted
  // work and its commits not on origin, against the commit the next step starts from; a retry's
  // prompt names it (5.1), and a resumed life finds a free's through rules-agent.ts leftoversOf; null
  // when nothing would have been lost. skipped: the untracked files it left out and removed unsaved
  // (over the size cap, or core dumps), which are not lost work
  | { kind: 'slot'; op: SlotOp; path: string | null; lease: string | null; head: string | null; killed: number | null; leftovers?: string | null; skipped?: { path: string; size: number; why: string }[] }
  // drop: a train merge that fell back to the queue's own path, with why (9.8); the try is not counted toward the unknown
  | { kind: 'queue'; op: 'update' | 'merge'; merged: boolean; head: string | null; failClass: GuardClass | null; lines: string[]; drop?: TrainDrop }
  | TrainOutcome
  // an open PR adopted at claim (3.5)
  | { kind: 'adopt'; branch: string; pr: number | null; others: number[] }

// --- the action kinds (appendix B) ----------------------------------------------------------------

// How deep trackers nest: observe reads sub-issues this many levels down, and a close-tracker chain
// checks this many trackers up (state.ts re-exports it).
export const TRACKER_DEPTH = 3

export const V2_ACTION_KINDS = ['transition', 'label', 'comment', 'event', 'pr', 'split', 'agent-step', 'ci-rerun', 'queue-update', 'queue-merge', 'queue-train', 'slot', 'link', 'close-tracker', 'flake-bug', 'released', 'intake-stamp', 'upstream'] as const
// What F1 asks of the flake-bug executor: the test and its hash (the marker's), the bug's title and
// body (without its markers; flakeIds are the flakes it lists), whether `ready` is allowed, the epic to link under, and what the bug's tell records.
export type FlakeBugSpec = { hash: string; test: string; title: string; body: string; flakeIds: string[]; ready: boolean; epic: number | null; flakes: number; windowDays: number; firstFlakeAt: string; reason: string }

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
export type SplitChild = { key: string; title: string; why: string; body: string; blockedBy: string[]; ready: boolean; decision: string | null; decisionParts?: ParkParts | null }

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
  | (ActionBase & { kind: 'event'; event: V2Event; logged?: true })
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
  // F1: one bug for a flaky test, found again by its hidden marker or filed; ready: the cap allowed `ready` (rules-flake-bugs.ts)
  | (ActionBase & { kind: 'flake-bug'; bug: FlakeBugSpec })
  // O4: log a release tag (fabriek-released); source: the loop's own release task made it, or the workflow
  | (ActionBase & { kind: 'released'; tag: string; source: 'loop' | 'workflow' })
  // one child per action; blockedBy: the issue numbers it waits on: siblings made, or existing issues
  | (ActionBase & { kind: 'split'; parent: number; child: SplitChild; blockedBy: number[] })
  // a design's upstream request: one issue in target (a repo of UPSTREAM_REPOS), found by its marker or made (act-upstream.ts); authority: what the designer rested it on; fields: the decision log's view of it
  | (ActionBase & { kind: 'upstream'; target: string; request: 'bug' | 'need'; title: string; body: string; marker: string; authority: { kind: 'owner' | 'bug'; source?: string }; fields: Record<string, string> })
  // I1: the intake reader on one issue's body version. run: record the try, spawn the reader; settle: a run
  // that timed out or was lost ends failed (why), its agent stopped. The key names the version (act-intake.ts)
  | (ActionBase & { kind: 'intake-stamp'; op: 'run' | 'settle'; version: string; why?: string })
  | (ActionBase & { kind: 'agent-step'; step: AgentStep; life: string; seq: number; attempt: number; branch: string; slot: string | null; notes: string[] })
  | (ActionBase & { kind: 'ci-rerun'; pr: number; runId: string; round: number })
  // base: main's head at plan time (the key's); head: the PR's head as observe read it
  | (ActionBase & { kind: 'queue-update'; pr: number; base: string; head: string })
  // testedTree: the tree the train's CI passed (fabriek-merge --tested-tree); trainDropped: why the record's train was dropped (--train-dropped); at most one
  | (ActionBase & { kind: 'queue-merge'; issue: number; pr: number; head: string; patch: string; testedTree?: string; trainDropped?: TrainDrop })
  | TrainAction
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

// The notice (TELL) kinds v2 adds; the owner items (V2_OWNER_TELLS) go out before any other
// wake (O2); blind, the foundation's own, is one of them under v2. The foundation's others (runaway, heartbeat-other, old-watcher, schema-behind, pass-error) stay.
export const V2_OWNER_TELLS = ['parked', 'breaker', 'stalled', 'checkout', 'workspace', 'rejected', 'keep-open-blocks', 'reopened', 'records-shadow', 'facts-shadow', 'wait-unreadable', 'starved', 'actions-refused', 'blind', 'reader-behind', 'release-hold'] as const
export const V2_TELLS = [...V2_OWNER_TELLS, 'waiting', 'task-timeout', 'wind-down-stale', 'done', 'flake-bug', 'actions-resumed', 'capacity'] as const
export type V2Tell = (typeof V2_TELLS)[number]

// --- rule ids (v2 SPEC 14.1) -------------------------------------------------------------------------

export const V2_RULES = [
  'G1', 'G2', 'G3', 'G4', 'H1', 'H2', 'R1', 'R2', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'Q1', 'Q2', 'Q3', 'W1', 'W2', 'O1', 'O2', 'O3', 'O4', 'O5', 'M1', 'F1', 'I1',
] as const
export type V2Rule = (typeof V2_RULES)[number]

// --- what v2 reads (v2 SPEC 2.4) ---------------------------------------------------------------------

// A pool slot's lease, by its holder (10.1): `factory-loop:<N>:<life>` names the loop's own.
export type Lease = { path: string; lease: string; holder: string; issue: number | null; life: string | null; status: string; busy: boolean }

// The newest issue read observe holds, and when it was taken: the parked label's absence in a
// read newer than the park is the unpark signal (3.4).
export type IssueRead = { at: Ms; open: boolean | null; labels: string[] | null }

// One wait condition as the last successful read showed it, and when that read was taken (4.4).
// `tag`: the release tag a tag-contains read compared against, so it is read again only when the tag changes.
export type WaitRead = { at: Ms; held: boolean; tag?: string }

// A condition the loop cannot read, since when: its read failed, or (tag-contains) its repo has no release tag.
export type WaitUnread = { since: Ms; why: 'read-failed' | 'no-release' }

// A trusted comment on an issue (fabriek-issue-read --comments), for a resume's note (11).
export type IssueComment = { body: string; at: Ms; url: string | null }

// When observe first saw a PR head (2.4): it bounds the waits on GitHub (4.4).
export type HeadSeen = { pr: number; at: Ms }

export const V2_SOURCES = ['store', 'leases', 'prs', 'interventions', 'comments', 'dualWrite', 'releasePrs', 'main', 'flakes'] as const
// What the new event log holds, read once per load when dual write is on (sources-dualwrite.ts): when it
// was read and the "<issue>:<life>:<seq>" of this device's transitions it holds.
export type DualWrite = { readAt: Ms; seen: ReadonlySet<string> }

export type V2SourceName = (typeof V2_SOURCES)[number]

// One issue of the blocker tree (sources-blockers.ts): what its single read showed. `blockers` are its
// open blockers in this repo, `foreign` its open blockers elsewhere (`owner/name#N`, never read);
// `read` is how its read ended: refused (an untrusted author, exit 3) or failed.
export type BlockerNode = { open: boolean; labels: string[]; title: string | null; blockers: number[]; foreign: string[]; read: 'ok' | 'refused' | 'failed' }

// The blockers of the queue's blocked issues, read for one starved spell and one 24 h period of it.
// `nodes` are by issue number; a blocker that has no node was not read (the cap stopped the walk).
export type BlockerTree = { since: Ms; period: number; readAt: Ms; nodes: Record<number, BlockerNode>; truncated: boolean; error: string | null }

// What S1 says of a pass (rules-claim.ts): `starved` is true when the queue is not empty, nothing is
// queued or in flight, no owner hold or stopping tier applies and every queue issue was skipped by a claim
// filter; null when a source failed (unknown). `skips`: each queue issue's filter reason, `blocked`: those
// skipped for their blockers.
export type StarvedVerdict = { starved: boolean | null; skips: Map<number, string>; blocked: number[] }

// The State fields v2 adds (2.4), as State.v2: observeV2 reads them every pass; absent in a state
// built outside a pass.
export type V2State = {
  sources: Record<V2SourceName, Source>
  // the newest release tag; null: the reads show no release; absent: no tag read held yet
  tag?: string | null
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
  // the conditions that cannot be read, by key, and since when; absent: none
  waitsUnread?: Record<string, WaitUnread>
  // the open release bump PRs (sources-release.ts) the merge queue holds for; absent: none read
  releasePrs?: ReleasePrsRead
  // the live trains' checks and the trees the rules compare (sources-train.ts); absent: none read
  train?: TrainRead
  // the default branch as the last read that succeeded showed it (sources-main.ts); absent: none this pass
  main?: MainReading
  // the flakes in the window and the open flake bugs (sources-flakes.ts); absent: not read this pass
  flakes?: FlakesRead
  // when the PR reads showed each issue's PR closed or merged (GitHub's closedAt), by issue number:
  // an older read of the issue is due at once, and pr-closed waits for it (4.1)
  changed: Record<number, Ms>
  // the intake stamps and each live record's in-flight paths (null: the read failed); present only while intakeStamp is on
  stamps?: Stamps
  // the tries and the owner-owned label groups of the intake stamp (stamps.ts); present only while intakeStamp is on
  stampTries?: StampTries
  stampOwned?: StampOwned
  inFlightPaths?: Record<number, string[] | null>
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
  // the last compare of the facts' and ledger rebuild's two stores (sources-facts.ts); absent: none made this load
  factsShadow?: FactsShadow
  // the workspace rail: the companion's handshake for this session (10.9; workspace.ts); absent
  // when not read, which holds nothing
  workspace?: WorkspaceRead
  // the container's memory in bytes (config.ts gateLimits); null: not readable; absent: not read (capacity.ts)
  memoryBytes?: number | null
  // the wind-down request, stop-now file and last status (10.11; wind-down.ts); absent when not read
  windDown?: WindDownRead
  // when the current starved spell began (the store's `starved:<repo>`); absent: no spell (S1)
  starvedSince?: Ms
  // the blocker tree read for the spell and its current period (sources-blockers.ts); absent: not read
  blockers?: BlockerTree
  // the settings in force now, the last snapshot kept in the store (null: none valid) and the config ops that landed since (rules-settings.ts); absent: not read
  settings?: { now: Snapshot; nowAt: Ms; before: Snapshot | null; beforeAt: Ms | null; ops: SettingsOp[] }
}

// a config op that landed (driver-controls.ts), kept in the store until the snapshot after it
export type SettingsOp = { key: string; by: 'person' | 'judge'; at: Ms }

// The pure planner's context: the foundation's, with the v2 fields every rule reads.
export type V2Ctx = PlanCtx & { v2: V2State; starved?: StarvedVerdict; cap?: CapInfo; queue?: QueueView }

// --- what the executors may change beside the ledger (v2 SPEC 3.3, 4.6) -------------------------------

// The live records: only the transition executor updates them, under the act lock. update applies
// fn to the records as they are now (null: no change), saves them to the store, and resolves once
// saved; changed is false when fn changed nothing or the store refused the write.
export type V2Io = {
  records: () => readonly IssueRecord[]
  // the live ledger, which the transition executor re-checks its trigger against (3.3)
  ledger?: () => readonly LedgerEntry[]
  updateRecords: (fn: (records: readonly IssueRecord[]) => IssueRecord[] | null) => Promise<{ changed: boolean; saved: boolean }>
  // stamps:<repo> changed by fn, which gets the value as the store holds it and returns the whole value to store
  // (null: no change): a read-modify-write that keeps keys it does not know (stamps.ts withTry, withStamp, withOwned)
  updateStamps?: (fn: (raw: unknown) => unknown) => Promise<{ changed: boolean; saved: boolean }>
  // asks the driver for the next pass at once: a transition's next event is taken without delay
  ping: (why: string) => void
}

// --- settings (appendix A) ------------------------------------------------------------------------

// the model aliases the agent tool accepts; a setting named *Model takes one of them
export const MODELS = ['sonnet', 'opus', 'haiku', 'fable'] as const
export type Model = (typeof MODELS)[number]

// The timeouts and tell periods of 4.4, by step and waiting state.
export type StateTimeouts = { design: Ms; build: Ms; review: Ms; fix: Ms; triage: Ms; queued: Ms; queueWait: Ms; parked: Ms; waiting: Ms }
