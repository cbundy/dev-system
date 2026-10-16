# Factory loop v2: specification

**Status.** Revised in workflow 1, 2026-10-15, after three critics and three spikes, then updated
the same day with the owner's answers to its ten open questions (section 15) and two structural
decisions: the module layout with a size guard (2.5), and structured event payloads (7.1), which
the owner later withdrew: v2 writes today's event format (section 15). What changed and why, finding by finding, is in [BUILD-NOTES-W1.md](BUILD-NOTES-W1.md). The spike
answers are in [SPIKES.md](SPIKES.md). Workflow 2 builds from this version.

**Sources and short names.**

- OB: the owner brief, `/persist/claude/factory-loop-v2-build/OWNER-BRIEF.md`. Where it and this
  spec differ, the brief wins (OB:4-5).
- V: the verdict, `/persist/claude/factory-loop-review/2026-10-14-verdict.md`.
- C3, C4, G1, G2, G4: the review reports in the same folder.
- DB: the original brief, `/persist/claude/factory-loop-review/2026-10-14-deep-dive-brief.md`
  (the 12 failure types, DB:77-95).
- FM: the foundation map, [FOUNDATION-MAP.md](FOUNDATION-MAP.md).
- W1: the workflow 1 critic and spike reports in `/persist/claude/factory-loop-v2-build/w1/`.
  Findings are named `failures/F<n>`, `totality/T-<nn>` and `simplicity/F<n>`, as in
  BUILD-NOTES-W1.md.
- v1 SPEC, D-nn: `docs/factory-loop/SPEC.md` and `docs/factory-loop/DECISIONS.md`.

Code paths are under `plugins/factory-loop/` unless they start with `docs/`, `tests/`,
`scripts/`, `images/`, `features/`, `coder/` or `plugins/`. Line numbers are at `d633030`. Times
are UTC.

**How to read it.** Sections 3 to 6 are the core: the record, the transition table, the unknown
path and reconcile. Section 10 is the workspace design the spikes chose. Appendices A to E list the
vocabulary (settings, action kinds, key families, labels and notices, owner ops).

## 1. Goals and non-goals

Goals:

- One issue goes from claim to merge untouched most of the time: no intervention by a person or
  by the loop is attached to it (7.2). The bar: at least 7 of the first 10 claims merge within 3
  hours untouched (OB:115-116; 17.5).
- Every issue has one explicit state with a timeout. Every step ends ok, not ok or unknown, and
  unknown has one path (OB:33-46).
- The loop owns what it reconciles: the record, the branch, the PR, the slot and the merge. It
  never mirrors another tool's private state (V:16-23).
- Fewer mechanisms: 21 rule ids against 46 (OB:95-102). Section 14 counts the layer like for like
  against C3's estimates.
- Every intervention is an event: each time a person, or the loop with unplanned judgement or
  recovery, had to step in. So "untouched", operator interventions and judgement calls can be
  read from factory data alone (OB:57-58; issue #632, metrics 1 and 2).

Non-goals:

- no-mistakes anywhere in the loop's path: not in its sources, its guard calls, its agent
  definitions or its prompts. It stays for people and other repos; `.no-mistakes.yaml` is not
  changed (OB:69-75).
- Release sequencing in the merge path (OB:89-91).
- Running tests in the loop. GitHub CI is the test gate (OB:83-85).
- Changing the foundation beyond the couplings FM section 4 names.
- A GitHub merge queue: it needs an organisation-owned repo, and dev-system is user-owned (C4
  (d5)).

## 2. The foundation, and how v2 plugs in

### 2.1 What stays

The foundation stays (OB:22-23; V:13). v2 uses it through the interfaces FM section 2 maps.

| Part | Where (FM) | In v2 |
|---|---|---|
| Pass driver, clock, pings, scheduler, phases | `register.ts:611-1050`, `rails.ts:451-530` (FM 2.1) | unchanged; the plan call is switched (2.3) |
| Rails, act lock, kill switch | `rails.ts`, `register.ts:1233`, `act.ts:214-240` (FM 2.4) | one more rail: the workspace plugin is loaded (10.9) |
| Executor contract and dispatcher | `exec.ts`, `act.ts:31-63` (FM 2.4) | v2 kinds register in `EXECUTORS` |
| Ledger | `ledger.ts` (FM 2.5) | same API; v2 key families (appendix C) |
| Usage tiers and action classes | `plan.ts:133` `tierOf`, `rails.ts:399-432` (FM 2.7) | unchanged; v2 classes in appendix B |
| Breakers and rate caps | v1 SPEC 11.4 | one more breaker bucket: step unknowns across issues (5.3) |
| Owner controls | `control.ts`, `control.json` (FM 2.8) | kept; some ops change (appendix E) |
| Wakes and one wake at a time | `wake.ts` (FM 2.11) | `tell` and `task release` only |
| Answer channel and repair message | `contract.mjs`, `bin/factory-answer`, `act-agents.ts:365`, `register.ts:1320` (FM 2.10) | the `script` channel only; new contracts |
| Event emitter | `act.ts:89-102` `ctx.event` (FM 2.6) | unchanged; three new states (7.1) |
| Decision log, trace, daily prune | `register.ts:968-1050`, `trace.ts`, `exec.ts:143` (FM 2.9) | unchanged; new fields `planner`, `shadow` |
| Store | `$.store` (FM 2.12) | new keys `records:<repo>` (3.3) and `heads:<repo>` (2.4) |
| Settings layers | `register.ts:238-284`, `config.ts` (FM 2.12) | new keys (appendix A) |

### 2.2 The seam

- **Plan.** `planV2(state: State, config: Config): PlanResult` in `hooks/v2/plan.ts`. It has the
  signature of v1's `plan` (`plan.ts:178`; FM 2.3) and is pure: it imports types,
  `hooks/v2/*.ts` and `hooks/foundation.ts` only. The purity test
  (`tests/factory-loop-plan.test.js`) covers `hooks/v2/`.
- **Foundation helpers.** `hooks/foundation.ts` holds the generic plan code v2 needs: the tier
  (re-exporting `tierOf`), the class matrix, `gate` and `want`, the generic admission filters
  (control, tier, GitHub backoff, breakers, rate caps), `oneWake` and the title frame. These are
  copies of private code in `plan.ts:98`, `:288-332` and `:2378-2541` (FM coupling C1), because
  `plan.ts` stays untouched until the delete wave (OB:107-109). A parity test runs both copies
  on v1's property fixtures. At the delete wave `foundation.ts` becomes the only copy.
- **Observe.** `observe()` (`observe.ts:153`) calls `observeV2()` (`hooks/v2/observe.ts`) when
  the planner is v2 or the v2 shadow is on. It adds the State fields in 2.4. With `planner: v2`
  it skips the `runs` source (`pipeline-watch.sh`) and the slot reflog inference
  (`observe.ts:208-224`, `:418-472`).
- **Act.** v2 executors live in `hooks/v2/act-*.ts` and join `EXECUTORS` (`act.ts:31`) through
  `hooks/v2/registry.ts`.
- **Events.** Every v2 event is built by one module, `hooks/v2/events.ts`, and written through
  `ctx.event` (`act.ts:102`). `callum-flow-event` gains three states (7.1).
- **Wakes.** `tell` and `task release` through `wake.ts`. Triage is a spawned agent, not a wake
  (section 15).
- **Store.** `records:<repo>` (3.3) and `heads:<repo>` (2.4).
- **Controls.** `control.json` keeps its shape; the ops are in appendix E.

### 2.3 v1 and v2 side by side

Two settings, in the repo-local `.claude/factory-loop.json` or the workspace `config.json`, which
wins:

| Key | Values | Default until cutover | Meaning |
|---|---|---|---|
| `planner` | `v1`, `v2` | `v1` | the layer whose plan the act step executes |
| `shadow` | `off`, `v2` | `off` | with `planner: v1`, v2 also plans each pass on the same State; its result is logged, never executed |

- Only the planner acts. The shadow never executes, never writes the store and never writes an
  event; its commands get the observe sink (v1 SPEC 11.1, D-10). There is no v1 shadow of v2
  (`simplicity/F13`).
- `mode` (`off`, `observe`, `act`) keeps its meaning (D-03). Observe mode with `planner: v2` runs
  v2's plan and logs it.
- The two plan call sites, `act.ts:456` (an acting pass) and `register.ts:921` (a pass that does
  not act), call the planner's function, then the v2 shadow when it is on.
- The decision log line gains `planner` and, with the shadow, `shadow: { actions, skipped,
  transitions }`. `/factory status` names both.
- v2's records are read, never written, in an observe or shadow pass: the stored records when act
  mode wrote them, else a rebuild from events (3.3). While v1 acts there are no v2 records, so the
  shadow shows R1's release proposals for v1's issues (6.2) and the claims v2 would make.
- A change of `planner` applies from the next pass. The cutover runbook (17.5) runs the one-shot
  migration (6.3) first.
- v2's ledger keys never collide with v1's: v2 keys are slash-separated and scoped to an issue's
  life (appendix C); v1 keys are colon-separated (v1 SPEC 5).
- `scripts/factory-loop-replay.js` gains `--planner v1|v2`.
- `plan.ts`, v1's rules and their tests stay untouched until the delete wave (OB:107-109).

### 2.4 What v2 reads

v2 reads the same ten kinds of source as v1, with `runs` out and `prs` in (`simplicity/F9`):

| Source | Command | Cadence | In v2 |
|---|---|---|---|
| `factory` | `callum-flow-factory-state --format json --github off` | every pass | kept (G2): claims, their holders and lapses. `nomistakes.runs` becomes optional in that tool (U4), so no-mistakes data can never blind v2 (`simplicity/F3`) |
| `facts` | `dev-query` with `EVENTS_SQL` | every pass | kept; gains the three new states (7.1), and says which facts are logged (7.2) |
| `queue` | `queue-watch.sh --once` | `queueEveryMs`, and on the next pass after any `label` action of the loop's own ended done | kept |
| `github` | `callum-flow-issue-read --json N` | `githubEveryMs`, and on the next pass after a `label` action of the loop's own on the issue ended done (so the loop sees what GitHub took, not its cached view) or a `prs` read showed its PR closed or merged after the issue's last read (4.1) | kept; the read set is the records' issues (their state, for `issue-closed`; for a parked record its labels, the unpark signal, 4.1), the queue and `only` |
| `usage` | `usage-check.sh` + `$.session.usage()` | as v1 | kept |
| `leases` | `treehouse status --json`, holders only; no reflog reads | every pass | v1's `pool` without inference |
| `checkout` | `git status --porcelain=v2 --branch --untracked-files=no` of the main checkout, and HEAD | `checkoutEveryMs` | a tripwire only (10.7) |
| `milestone` | `callum-flow-milestone show next` | as v1 | kept (the release task) |
| store | `ledger:<repo>`, `records:<repo>`, `heads:<repo>` | every pass | records are new (3.3) |
| `prs` | for each record in reviewing or merge-queue whose life has a PR (the record's, else the one the life's done ensure named, 8.1): `callum-flow-issue-read --json --pr <n>` (state, merged, merged head, `closedAt`, head sha, `mergeable_state`, author, base sha) and `gh pr checks <n> --repo R --json name,state,bucket,startedAt,completedAt,link` (with the run id from the link) and the head's workflow runs, `gh api repos/R/actions/runs?head_sha=<head>&per_page=100` (8.5); the head's patch id (8.4) when the head moved | `prEveryMs`, and on the next pass after its record's transition or an action of the loop's own on the PR ended; a PR whose last read failed, every pass | new |

- **Heads first seen.** Observe keeps, in the store key `heads:<repo>`, the time it first saw each
  PR head. Plan uses it to bound waits on GitHub (4.4). Entries go when their PR closes.
- **The PR cadence.** A PR read costs about two GitHub calls, so at a 10 s pass a PR read every
  pass took about 720 calls an hour, and K PRs most of the account's shared 5,000 (drill run 3).
  A PR's read stands, with its own time, until it is due: `prEveryMs` (30 s) after it, or at once
  when something the loop knows changed it, its record's transition (any change of the record) or
  an action of the loop's own on the PR (an ensure, an update, a merge, a CI re-run) that ended
  after it. The queue and the issue reads take the same rule with their own cadences and signals
  (a label write, a PR's close). Main's head on origin (9.2) is read every pass a merge-queue PR
  is open, whatever the PR's cadence, so Q1 sees main move at once; its update is an action on the
  PR, so the head's read is due on the next pass. A wait on GitHub is judged at the read (4.4).
- **Read order.** GitHub reads are taken in this order until the pass's budget is spent: the merge
  queue's head, the other records in reviewing and merge-queue, parked records, the other
  records, then the queue and the rest. The PR reads are bounded by K records; the issue reads
  keep v1's 12 per pass (`observe.ts:35`). All are skipped during a GitHub backoff, as v1's are
  (v1 SPEC 10.2) (`totality/T-26`).
- **The companion's log** (`<loop dir>/companion.jsonl`, 7.2) is read each pass with the loop
  dir's answer files (10.8), not as a source of its own.
- **Not read** (each was in the draft): a mirror of every `factory:*` label, a 5-minute scan of
  open PRs, main's check runs and the session environment. Their rules are gone (3.4, 3.5, 9.5,
  10.5).

### 2.5 Module layout

v1's rule layer is a few large files: `plan.ts` 2,541 lines, `register.ts` 1,600, `act-merge.ts`
722, `act.ts` 704, `act-agents.ts` 646, `control.ts` 603. v2 is laid out so that cannot recur:

- **One module per area and kind** under `hooks/v2/`: `rules-*` (what to plan), `steps-*` (how a
  step runs and reads its answer), `act-*` (executors), `contracts-*` (answer checks),
  `prompts-*` (agent prompts), plus `events.ts`, `record.ts`, `reconcile.ts`, `release.ts` and
  `lives.ts`.
- **The pure planner is a thin composer.** `hooks/v2/plan.ts` calls the `rules-*` modules in a
  fixed order and merges their actions. It holds no rule of its own.
- **The table is data** (`table.ts`, 4.6), not code paths.
- **No module is shared by two parallel build units** (16). Where v2 must touch a foundation file,
  it adds a call into a v2 module, not logic.
- **The size guard.** `npm run lint` (`scripts/lint.sh`) fails when any file under
  `plugins/factory-loop/hooks/` is over 600 lines. An explicit allowlist names today's six
  oversized v1 files, each with a cap: its line count when U1 set it. Both only ever shrink: a
  listed file over its cap fails (a call into a v2 module goes in, and the logic it replaces comes
  out), a listed file at or under 600 lines also fails the check, so its entry must go, and nothing
  is ever added. A cap may be lowered when its file shrinks, never raised. It must be empty after
  the delete wave (U10). U1 builds the guard.

## 3. The record and the labels

### 3.1 States

The owner's label set, exactly (OB:33-41):

| State | Label | Meaning | Holds a slot | In flight |
|---|---|---|---|---|
| queued | `factory:queued` | claimed, no slot yet | no | no (but it limits claims, S1) |
| designing | `factory:designing` | the designer works in the slot | yes | yes |
| building | `factory:building` | the implementer (the builder) works in the slot | yes | yes |
| reviewing | `factory:reviewing` | the reviewer and CI on the PR | yes | yes |
| fixing | `factory:fixing` | a fixer on review findings, red CI or a conflict | yes | yes |
| merge-queue | `factory:merge-queue` | approved and green, waiting to merge | yes | yes |
| parked | `factory:parked` | waits on the owner; frees its slot and leaves the in-flight count | no | no |
| closed | no label | done or dropped; terminal | no | no |

Retries and triage are steps inside a state. The label does not change while they run.

### 3.2 The record

```ts
type IssueState = 'queued' | 'designing' | 'building' | 'reviewing' | 'fixing' | 'merge-queue' | 'parked' | 'closed'
type StepKind = 'lease' | 'design' | 'build' | 'review' | 'fix' | 'queue' | 'triage'
type ClosedWhy = 'merged' | 'merged-by-hand' | 'dropped' | 'split' | 'closed-on-github' | 'claim-lost'

type IssueRecord = {
  issue: number
  life: string                 // the claim's start time in base-36 seconds: unique per life (3.3)
  seq: number                  // +1 on every transition; part of every per-seq key
  seqAt: Ms                    // when this seq's transition happened
  state: IssueState
  since: Ms                    // when it entered this state
  resumeTo: IssueState | null  // queued: where a lease leads (default designing); parked: where an unpark leads
  branch: string               // fixed for the life (3.5)
  pr: number | null            // adopted at claim, or set when reviewing ends; until then the ensure's (8.1)
  head: string | null          // the head a writer step last confirmed on origin
  approvedPatch: string | null // the patch id the reviewer approved (8.4)
  brief: string | null         // the design brief comment URL
  step: StepKind | null        // the step this seq runs: the state's own, or 'triage'; null when waiting
  attempt: number              // attempt of that step: 1 or 2 (5.1)
  cut: boolean                 // this attempt already had its one free re-run (U1)
  triages: number              // triage calls in this life, at most maxTriages
  fixes: number                // entries to fixing in this life, at most fixCap
  round: number                // entries to reviewing in this life
  question: string | null      // parked: the question for the owner
  why: ClosedWhy | null        // closed: why
  notes: string[]              // owner, triage and decline notes for the step of this seq
  prClosedAt: string | null    // GitHub's closedAt of the newest hand close the record has handled (E4, P1)
  lives: number                // this life's number since the issue's count last started (6.4): 1 for the first
}
```

- Step, attempt, round and the approved patch live in the record (OB:42-43).
- Each claim of an issue is one life, and the record counts lives (owner, 2026-10-15). S0 sets
  `lives` from the issue's earlier lives (6.4, "Lives"); the count starts again with the first
  claim after a rejection.
- The slot is not a record field. A record holds the slot whose lease holder is
  `factory-loop:<N>:<life>` in the `leases` source (10.1).
- A step's ledger keys follow from the record (appendix C). Their status and start time are the
  ledger entry's, so starting a step does not change the record.
- Notes belong to a seq. A same-state row keeps them and adds its own; a row that changes the state
  replaces them with its own.
- A record that parks from queued keeps queued's own `resumeTo`, so "resumeTo same state" in the
  rows below means that target, never queued itself.

### 3.3 Where it lives, and how it changes

- **Store.** `records:<repo>` = `{ v: 1, savedAt, records: IssueRecord[] }` in `$.store`, beside
  the ledger (FM 2.12, coupling C2).
- **One writer.** Only an acting pass under the act lock writes it. Observe and shadow passes only
  read it.
- **Only the `transition` executor changes a record** (4.6). It does two things:
  1. it re-checks the row's trigger against the live ledger and records (the step entry and the
     status the plan saw, or the GitHub fact). When the trigger no longer holds, for example
     because an answer arrived after the plan, it does nothing and the next pass plans again
     (`totality/T-17`);
  2. it stores the next record with a compare on `(issue, life, seq)`.
- **The ledger is the outbox.** Every effect of a transition is an entry action of the new seq
  with its own key (4.5): the `transition` event, stopping the old step, the label and the rest.
  A crash after the store write leaves the entry actions planned on the next pass, so no event is
  lost (`failures/F12`, `totality/T-05`). The `transition` entry carries its row, the state and
  step it leaves and its via code from its start, so an entry the reload marks lost still names
  them: the row's events, the park's comment and the breaker read them from there. The next transition of a record waits until its current
  seq's `transition` event is logged, so the trail has no gaps.
- **A record is made from a done claim.** S1's `claim` action runs `callum-flow-claim`; once its
  ledger entry is done, the next pass plans row S0, which makes the queued record. A crash in
  between leaves the done entry, so S0 is planned again. A claim that may already hold the issue
  (the claim tool posted, then the adoption's reads failed; or a reload lost it mid-claim) runs
  again under its own key whatever the queue says, since `ready` is gone, and holds its place
  under the cap until it is done. A retry is safe: `callum-flow-claim` keeps its own live claim once `claimed` is logged and
  otherwise makes it fresh.
  A v2 claim never becomes a ghost (`totality/T-14`).
- **Life.** The start time of the claim action, in base-36 seconds: unique, and needs no counter
  that pruning could reset (`totality/T-14`).
- **Pruning.** A closed record goes 7 days after it closed, as ledger entries do (v1 SPEC 7.1).
- **Rebuild.** With no records in the store (a new device, a wiped config), act mode rebuilds them
  from this device's `transition` events: the newest per issue over 90 days. The event's note
  carries every record field (7.1); `recordsFromEvents` in `hooks/v2/record.ts` parses it with
  `events.ts`. A step in flight is not rebuilt: S2 starts the same attempt again, and an
  agent step first looks for an answer already recorded for its key (10.8).

### 3.4 Labels

- **Names.** `factory:queued`, `factory:designing`, `factory:building`, `factory:reviewing`,
  `factory:fixing`, `factory:merge-queue`, `factory:parked` (OB:33-41). Colours and descriptions
  are in appendix D.
- **`factory:rejected`** (owner, 2026-10-15) is an eighth label and no state: the issue is out of
  the factory. R1 sets it in place of `ready` when it releases an issue at its `maxLives`-th life
  (6.4). S1 never claims an issue that carries it, whatever else it carries. The owner removing
  it and adding `ready` brings the issue back as a first life (a person intervention, `unreject`,
  7.2). The factory tools take it as no stage (3.6).
- **Exactly one** `factory:*` state label on the issue of an active or parked record; none on a
  closed one.
- **One writer.** The loop is the only writer, except that the owner removing `factory:parked` is
  the resume signal (OB:42-44).
- **The record is the authority and the label its mirror** (OB:42-43). A state change's entry
  action `label` writes it in one call: `gh issue edit <N> --repo R --add-label <new>
  --remove-label <the other six>`. The loop does not read labels back to correct them: there is no
  mirror check and no label-drift intervention. Stale label reads made such a check undo parks
  and log false touches (`totality/T-01`, `simplicity/F6`, `simplicity/F9`).
- **The one label read.** For a parked record, the `github` source reads the issue directly. A
  read made after the park's `label` action finished (it comes on the next pass, 2.4) that lacks
  `factory:parked` is the unpark signal (4.1). Older reads are ignored. The label list is not used, because it lags behind
  edits (`images/base/callum-flow-sweep:37`, `:142`).
- **Creation.** Action `label` with op `ensure` once per module load, and again after a label write
  fails with a missing label: `gh label create <name> --repo R --color <c> --description <d>
  --force` for each of the eight (the seven state labels and `factory:rejected`). `--force`
  updates a label that exists.
- **No claim label.** v2 neither writes nor reads `In development` (owner, 2026-10-15). The claim
  is the claim comment and its `claimed` and `renewed` events; the `factory:*` label shows the
  state. The claim tools change to match (3.6). A closed record's `label` op `clear` removes every
  `factory:*` label, unless another device holds a live claim on the issue: then it removes none,
  because the winner owns the labels (`callum-flow-claim:18-21`; `totality/T-02`).
- **Migration.** No issue has a `factory:*` label before cutover. The owner's own `parked` label
  convention (`skipLabels`, D-17) is unrelated and unchanged.
- **Rollback.** Before the delete wave, `planner: v1`; after it, the previous release (OB:117). The
  runbook (17.5) first stops new work and lets v2's records reach parked or closed, because v1
  ignores v2's records, slot holders and labels (`totality/T-27`). It then deletes the eight
  labels with `gh label delete <name> --repo R --yes`, after re-adding `ready` to any rejected
  issue the owner still wants.

### 3.5 One branch, one PR, one slot per life

- **The branch is `issue-<N>`, for every life** (OB:65-66; `simplicity/F14`):
  - At claim, the `claim` executor lists open PRs once (`gh pr list --repo R --state open --limit
    1000 --json number,headRefName`; gh lists 30 without a limit). An open PR by a trusted author on a branch matching
    `(^|/)issue-<N>(-|$)` is adopted: the branch is that PR's head branch, `pr` is set, and
    `resumeTo` is `reviewing` (the review reads the whole diff, 8.3). With several, the newest is
    adopted and the others are named in the transition note and left alone.
  - Otherwise the branch is `issue-<N>`. When origin already has it, from an earlier life or a
    released ghost, the work continues from its head: the slot is prepared from it and the builder
    merges main when it needs to (`totality/T-28`). Nothing on origin is ever reset.
- **No `-vN` branches, no superseded PRs.** The loop never force-pushes, never rebases a pushed
  branch and never closes a PR, and the write guard stops agents doing any of these (10.4).
- **The PR** is opened, adopted or reopened by the loop on each entry to reviewing (8.1).
- **The slot** is leased when the record leaves queued and freed when it parks or closes (10.1).

### 3.6 The claim tools without `In development`

The owner dropped `In development` now (section 15). Today the claim, heartbeat and sweep tools
use it as the fleet's claim marker (`images/base/callum-flow-claim:21`, `:126`;
`images/base/callum-flow-sweep:9-21`, `:82`), and the factory-state view checks it
(`images/base/callum-flow-factory-state:63`, `:343-345`, `:412`). U4 changes all of them, so no
tool the loop calls writes or reads the label:

- **`callum-flow-claim <N>`.** The winner removes `ready` and assigns @me. It no longer adds
  `In development`. A device's own live claim after a restart does the same while this device's
  event log shows it held (its last claim event is `claimed`). Any other own live claim (one
  interrupted before its event, or left behind by `ready`, `reclaimed`, `merged`, `closed` or
  `abandoned`) is deleted and the claim made fresh, so every life starts with one `claimed` event.
- **`callum-flow-claim --heartbeat`** with no numbers renews this device's live claims on the open
  issues that `callum-flow-factory-state --github off` lists live with this device as the holder,
  not the label list. v2's H1 passes numbers, as now (14.1).
- **`callum-flow-sweep`.** Its candidates are the issues the event log and factory-state list as
  live, the list its closed-issue pass already reads (`callum-flow-sweep:224-236`), not the label
  list. Rules: a closed issue logs `closed` when its latest event is not final; an open issue with
  a PR merged on its branch after the newest claim is left alone; an open issue whose last claim
  event (`claimed`, `ready`, `reclaimed`, `merged`, `closed` or `abandoned`) is not `claimed` is
  left alone, and no other event revives an ended claim; an open issue whose newest claim expired
  gets `ready` back, is unassigned, gets a comment and logs `reclaimed`; an open issue with no
  claim comment is left alone. It never touches `factory:*` labels: the loop is their only
  writer, and a record whose claim lapsed is claimed again onto itself (4.1).
- **`callum-flow-factory-state`.** For an issue whose life has a `transition` event, the label
  check expects the `factory:*` label of its state. For other issues it checks `ready` only. The
  "GitHub label only" list takes an open issue with a `factory:*` state label (its stage from the
  label) or `ready`, and no events. `factory:rejected` names no stage, and is not flagged on a
  closed record's issue.
- Both tools drop `CALLUM_FLOW_IN_DEV_LABEL`. The old orchestrator's skill lines that name the
  label (`plugins/callum-flow/skills/issue-orchestrator/SKILL.md:22`, `:77`) are updated.
- **`derive.ts`** reads no label: `EVENTS_SQL` and the derivation use events only
  (`derive.ts:38-50`), and v2's records come from events (3.3). Nothing changes there for this.
- **The migration** (6.3) removes `In development` from the issues it touches.
- **v1 is unaffected.** Before the delete wave, v1 runs in the same release with the new tools. No
  v1 rule reads the label (`plan.ts:2214-2217` reads `ready` and skip labels only), and v1's
  removals of it (`act-cli.ts:63-69`) become no-ops. They go at the delete wave with `inDevLabel`
  (`config.ts:13`, `register.ts:263`). The label stays defined in each repo, so a removal never
  fails. Rollback to v1 after the delete wave is running the previous release (v0.38.x), which
  still carries the old tools, so v1 is unaffected there too. An issue v2 claimed has no
  `In development`; the rollback runbook (17.5) brings it back by re-adding `ready`, and v1 labels
  it again at its claim.

## 4. Steps and the transition table

### 4.1 Events

The table's input. Each pass, a record takes at most one event that changes it: the first present
in this order. Rows that change nothing (E6, E7) run beside it and never stop it
(`totality/T-03`). A transition pings the driver, so the next event is taken at once (4.6).

1. `pr-merged`
2. `issue-closed`
3. `claim-lost`
4. `drop`
5. `pr-closed`
6. the step's result: `ok`, `not-ok`, `unknown` (a timeout included) or `triage`
7. `unpark`

`pr-merged` comes first because a merge cannot be undone, and before `issue-closed` because a merge
with `Closes #N` closes the issue in the same instant (`failures/F14`).

The order holds across sources. The PRs are read more often than the issue, so a
`pr-closed` waits while the issue's last read is older than the PR's `closedAt`; that read is due on
the next pass (2.4). An issue closed with its PR then closes (E2) and never parks first.

| Event | Raised by | Meaning |
|---|---|---|
| `ok` | the step | the step did what it is for (4.2) |
| `not-ok` | the step | the step answered, and the answer says the work cannot go on as it is; it carries a reason |
| `unknown` | the step | no usable answer (4.2, 5.1), including a timeout of a running step (4.4) |
| `triage` | the triage step | the triage answer's choice (5.2) |
| `drop` | owner | a `control.dropped` entry for the issue newer than the life's claim (an edge: it applies to that life only, `failures/F10`) |
| `unpark` | owner | a `/factory resume N` entry newer than the park, or a direct read after the park label write that lacks `factory:parked` (3.4) |
| `issue-closed` | GitHub | the issue closed, and no loop merge or `close-issue` of this life is done, running or lost |
| `pr-merged` | GitHub | the record's PR merged at a head that no `queue-merge` entry of this life names (done, running or lost). A merge the loop made is the queue step's `ok` instead (`totality/T-05`) |
| `pr-closed` | GitHub | the record's PR is closed unmerged, and its `closedAt` is newer than the record's `prClosedAt` (an edge on GitHub's own timestamp) |
| `claim-lost` | claims | another device holds a live claim on the issue, or a re-claim exits 3 |
| `timeout` | the clock | a running step passed its timeout (read as `unknown`), or a waiting state passed its tell period (E6) (4.4) |

GitHub events are edges, not conditions. `issue-closed`, `pr-merged` and `claim-lost` end the
record, so they fire once. `pr-closed` compares GitHub's `closedAt` with the record's
`prClosedAt`. `drop` and `unpark` compare the op's time with the life's claim and the park
(`totality/T-03`).

A CI result is not an event of its own. CI belongs to two steps, reviewing and the merge-queue
head. Its result arrives as that step's `ok`, `not-ok` or `unknown` (4.2, 8.5).

**What else runs each pass beside the table:**

- **Re-claim.** H1 renews the claim of every record that is not closed. A record whose claim lapsed
  (the `factory` source shows this device's claim lapsed, or a `reclaimed` event was logged, after
  the record's last claim; never the `ready` label list, which lags, 3.4) is claimed again with
  `callum-flow-claim N`. That keeps the record and its state; exit 3 is `claim-lost`. The re-claim
  logs the record's current `transition` event again, so readers see the stage at once
  (`failures/F16`, `totality/T-14`).
- **Pushes by a person.** A head on the record's branch that no loop step produced is a person
  intervention (`push`, 7.2). The loop's own heads are known: the heads that writer steps confirmed,
  and those that `queue-update` produced (9.2). The state's own keys handle the new head: review is
  keyed by patch (8.4).

### 4.2 The step of each state

| State | Step | Who | Role | ok | not-ok | unknown |
|---|---|---|---|---|---|---|
| queued | `lease` | W1's `slot` op `lease` (10.1) | - | a lease with the record's holder exists | - | - (a lease is an effect: it retries, then holds the record as `stalled`, 4.5) |
| designing | `design` | the designer agent in the slot, then the loop posts the brief or creates the children (8.7) | reader | a brief, posted | a question; or a split, its children created | the generic agent unknown (below) |
| building | `build` | the builder agent in the slot | writer | a valid answer, and origin's branch, read directly, has commits beyond the base at or past the answered head | the answer says it cannot (with a reason); or origin's branch has no commit beyond the base (`no-commit`) | the generic agent unknown, or the direct read of origin failed |
| reviewing | `review` | `pr` ensure (8.1), then the reviewer agent and CI on the head (8.3, 8.5) | reader | the reviewer approved the head's patch in this round, every check on the head passed or was skipped, and the PR does not conflict | the reviewer asked for changes; a check failed after its one re-run; the PR conflicts (`dirty`), which ends the step at once | the reviewer's generic agent unknown; a GitHub wait past its bound (4.4) |
| fixing | `fix` | the fixer agent in the slot | writer | a new head on origin's branch, read directly | every finding declined with reasons, and no new head | the generic agent unknown, or the direct read of origin failed |
| merge-queue, the head | `queue` | Q1 and Q2 (9) | - | the PR merged at a head that a `queue-merge` entry of this life names | `conflict`, `ci-red` (a failed check after its one re-run), `patch` (the head's patch is not `approvedPatch`), `policy` (9.3) | a Q1 or Q2 CLI failure; a guard FAIL of class `read`; a refusal GitHub gives no reason for; a GitHub wait past its bound |
| a step state | `triage` | the triage agent (5.2) | reader | a valid answer: its choice is the `triage` event | - | the generic agent unknown |
| merge-queue, not the head; parked; closed | none | - | - | - | - | - |

- **The generic agent unknown.** No valid answer after one repair message; the turn ended in
  error, aborted or refused; the agent failed or was lost; the step's timeout (4.4).
- Readers may not write inside the repository. Writers may write only inside their slot and push
  only the record's branch (10.4).
- When the usage pre-check skips a spawn, the step has not started and no attempt counts (v1
  SPEC 10.7).

### 4.3 The table

Held as data in `hooks/v2/table.ts` (4.6). The guards on one (state, step, event) are exclusive
and exhaustive. `fixCap` is 3 (`reviewFixCap`, `config.ts:32`). `maxTriages` is 2 (C3:85). "Step
states" are designing, building, reviewing, fixing and the merge-queue head. 33 rows. The Events
column names what a row's seq logs; a state's own entry event (`delegated`, `fix_requested`,
`merge_ready`) is logged by every row that enters the state, T1 included (4.5).

**A record is made (S1).**

| Id | From | Event | Next | Record |
|---|---|---|---|---|
| S0 | no record | the life's `claim` entry is done | queued | life, branch, `pr` and `resumeTo` from the claim's result (3.5); step `lease` |

**Step results (S3).**

| Id | State | Event | Guard | Next | Record change | Events |
|---|---|---|---|---|---|---|
| T1 | queued | ok | - | `resumeTo` (default designing) | round +1 when it leads to reviewing; queued's notes (S0's, P1's) kept: the lease reads none, so they are for the step T1 leads to | transition |
| T2 | designing | ok | - | building | brief set | transition, `delegated` |
| T3 | designing | not-ok | a question | parked | question; resumeTo designing | transition |
| T4 | designing | not-ok | a split | closed | why split | transition, `abandoned` (split into ...) |
| T5 | building | ok | - | reviewing | head set; round +1 | transition |
| T6 | building | not-ok | triages < max | building, step triage | attempt 1; triages +1; cut cleared | transition |
| T7 | building | not-ok | triages = max | parked | question (the builder's reason); resumeTo building | transition |
| T8 | reviewing | ok | - | merge-queue | approvedPatch and pr set | transition, `merge_ready` |
| T9 | reviewing, merge-queue | not-ok | changes, `ci-red` or `conflict`; fixes < fixCap | fixing | fixes +1; pr set; findings, failed checks or the conflict to notes | transition, `fix_requested` |
| T10 | reviewing, merge-queue | not-ok | changes, `ci-red` or `conflict`; fixes = fixCap | parked | question (the fix cap, with the findings); resumeTo fixing; pr set | transition |
| T11 | fixing | ok | - | reviewing | head set; round +1 | transition |
| T12 | fixing | not-ok | - | reviewing | decline reasons to notes; round +1 | transition |
| T13 | merge-queue | ok | - | closed | why merged | transition |
| T14 | merge-queue | not-ok | `patch` | reviewing | approvedPatch cleared; round +1 | transition |
| T15 | merge-queue | not-ok | `policy` | parked | question (the guard's FAIL lines); resumeTo merge-queue | transition |

**Unknown (S4, section 5).** Every step state, every step, triage and the queue head included:

| Id | Event | Guard | Next | Record change | Events |
|---|---|---|---|---|---|
| U1 | unknown | the cause is outside the issue (5.1), and not `cut` | same state, same step | attempt unchanged; cut set | transition (`via=free:<cause>`) |
| U2 | unknown | not U1; attempt 1 | same state, same step | attempt 2; cut cleared | transition |
| U3 | unknown | not U1; attempt 2; step is not triage; triages < max | same state, step triage | attempt 1; triages +1; cut cleared | transition |
| U4 | unknown | not U1; attempt 2; step is triage, or triages = max | parked | question (the last two results); resumeTo same state | transition |

**Triage answers (S5).** Any step state whose step is triage:

| Id | Choice | Guard | Next | Record change | Events |
|---|---|---|---|---|---|
| X1 | retry | - | same state, the state's own step | attempt 2; instructions to notes | transition |
| X2 | fix | the branch has commits beyond the base, and fixes < fixCap | fixing | fixes +1; instructions to notes | transition, `fix_requested` (triage) |
| X3 | redesign | - | designing | instructions to notes; branch and commits kept | transition |
| X4 | park, or fix when X2's guard fails | - | parked | the triage's question, or why fix was not possible with the triage's reason; resumeTo same state | transition |
| X5 | drop | - | closed | why dropped | transition, `abandoned` (triage) |

A triage answer that names a state enters it, even the state the record is in: X3 from designing
runs the designer and X2 from fixing runs the fixer, at attempt 1 with no cut. Triage never
answers into triage again, so a triage that keeps answering redesign still runs a designer each
time.

**Owner and GitHub events (S6).** Every state but closed, unless the row says otherwise:

| Id | Event | Guard | Next | Record change | Events |
|---|---|---|---|---|---|
| E1 | drop | - | closed | why dropped | transition, `abandoned` (dropped) |
| E2 | issue-closed | - | closed | why closed-on-github | transition |
| E3 | pr-merged | the life has a PR | closed | why merged-by-hand | transition |
| E4 | pr-closed | the life has a PR; not parked | parked | question ("PR #p was closed by hand; a resume reopens it"); resumeTo same state; prClosedAt set | transition |
| E5 | claim-lost | - | closed | why claim-lost | transition |
| E6 | timeout | a waiting state: queued (6 h), the merge queue behind its head (2 h), parked (24 h) | same state | - | `tell(waiting)`, or `tell(parked)` as the daily reminder; once per period |
| E7 | any event with no meaning in the state | - | same state | - | logged in the decision log |

E7 covers, for example: a late result of a step whose seq has ended; `pr-closed` while parked;
`unpark` of a record that is not parked (the op answers "not parked; use `/factory note N`");
`pr-merged` or `pr-closed` with no PR; and every event in closed.

**Parked (S6).**

| Id | Event | Next | Record change | Events |
|---|---|---|---|---|
| P1 | unpark | queued | resumeTo kept; attempt 1, triages 0, fixes 0, cut cleared; prClosedAt set to the PR's `closedAt` when it is closed, so the resumed step reopens it (8.1); notes += the op's note, or the trusted comments posted after the park comment | transition |

Interventions (7.2) are not listed per row. `rules-interventions.ts` derives them from each done
`transition` entry (its row and event) and other facts, so the rows above stay as they are.

**Totality.** Every cell names its rows. "-" never appears.

| State | ok | not-ok | unknown | triage | drop | unpark | issue-closed | pr-merged | pr-closed | claim-lost | timeout |
|---|---|---|---|---|---|---|---|---|---|---|---|
| queued | T1 | E7 | E7 | E7 | E1 | E7 | E2 | E3 or E7 | E4 or E7 | E5 | E6 |
| designing | T2 | T3, T4 | U1-U4 | X1-X5 | E1 | E7 | E2 | E3 or E7 | E4 or E7 | E5 | U1-U4 |
| building | T5 | T6, T7 | U1-U4 | X1-X5 | E1 | E7 | E2 | E3 or E7 | E4 or E7 | E5 | U1-U4 |
| reviewing | T8 | T9, T10 | U1-U4 | X1-X5 | E1 | E7 | E2 | E3 or E7 | E4 or E7 | E5 | U1-U4 |
| fixing | T11 | T12 | U1-U4 | X1-X5 | E1 | E7 | E2 | E3 or E7 | E4 or E7 | E5 | U1-U4 |
| merge-queue | T13 | T9, T10, T14, T15 | U1-U4 | X1-X5 | E1 | E7 | E2 | E3 | E4 | E5 | U1-U4 (a running step) or E6 (waiting) |
| parked | E7 | E7 | E7 | E7 | E1 | P1 | E2 | E3 | E7 | E5 | E6 |
| closed | E7 | E7 | E7 | E7 | E7 | E7 | E7 | E7 | E7 | E7 | E7 |

A step-state `timeout` exists only while a step runs (4.4), so a held step raises none. A running
step's timeout reaches the table as that step's unknown (why `timeout`), so the merge queue's head
takes U1 to U4; only a record behind the head takes E6.

### 4.4 Timeouts

A step's clock counts only the time the step actually runs: from the start of its running ledger
entry (the agent step or the step's own action). A step that admission holds (`noNewWork`,
`serial`, a rate cap, a tier, the breaker, a pause, a GitHub backoff, a stalled effect) has no
running entry, so it cannot time out and spends no attempt. Its skip line names the filter
(`failures/F1`, `totality/T-07`). Waiting states have a tell period instead.

| State, step | Timeout | Counted from | On expiry | Why this value |
|---|---|---|---|---|
| queued (waiting for capacity) | 6 h | entry | `tell(waiting)`; stays | waiting for capacity is not a fault; 6 h means the factory was full or held for most of a working session |
| designing, design | 45 min | step start | unknown | v1 allowed 60 (`config.ts:41`); C3 proposes 30 (C3:76); a healthy design takes about 4 (C3:292); designers that ended with an async explorer running lost 53 issue-minutes (G1:123) |
| building, build | 90 min | step start | unknown | v1 allowed 120 (`config.ts:41`). Old-regime delegation to first merge-ready was p50 33.4, p90 79.0 min (C3:280-282), including about 19 min of pipeline (V:139), so a build's p90 is about 60; 90 is 1.5 times that. No one command holds longer than 10 minutes (10.5) |
| reviewing, the reviewer | 30 min | the reviewer's start | unknown | no-mistakes' review took a median 3.4 and at most 25.9 min (C3:272) |
| fixing, fix | 60 min | step start | unknown | about 14 min for a healthy fix round (C3:292); v1's 120 kept stuck fixers too long (`config.ts:41`) |
| a step state, triage | 15 min | step start | unknown | one bounded call; v1's judge wake had 30 (`config.ts:42`) for a wider job |
| merge-queue (behind the head) | 2 h | entry | `tell(waiting)`; stays | a PR waits behind at most K - 1 heads |
| parked | 24 h | entry, then each reminder | `tell(parked)` reminder; stays | one reminder a day |
| closed | none | - | - | terminal |

**Waits on GitHub** have their own bound, the same in reviewing and at the merge queue's head. A
step waiting on GitHub, with nothing of its own running, is unknown when either holds:

- no check has started on its head `ciStartMs` (10 min) after the latest of: the head's first
  sighting (2.4), the end of the step's last action, and the last check's completion;
- a check has been running for longer than `ciRunMs` (30 min). CI's p90 is 3.0 min (C3:276).

Both are judged at the PR's read, not at the pass: a read an earlier pass took (2.4) cannot show
a check that started since it, so the bound counts to the read's time.

This also bounds a head whose PR shows `blocked`, `unknown` or `draft` with nothing to run
(`totality/T-10`). In reviewing, the PR's own read is bounded the same way: a PR not in the
pass's read (a PR whose read, checks or patch id failed is left out: its own record's wait, never
another's), a read older than the seq, no head or no patch id is unknown `ciStartMs` after the
latest of the seq's start, the end of the PR's ensure and, for a PR whose reads fail, the first
of the passes in a row that tried it and failed: one failed read holds, a read that keeps failing
ends the step. The `prs` source not read at all (a GitHub rate limit cut the reads), and a GitHub
backoff, are admission holds with no clock; the backoff starts in the pass that met the limit,
the PR reads included. At the merge queue's head it bounds a PR that did not read too, counted
the same way: only a GitHub rate limit holds it with no clock. A PR the reader refuses for an
untrusted author (exit 3) is a fact, not a missing read: `not-ok(policy)` (9.3).

The values are settings (`stateTimeoutMs`, `ciStartMs`, `ciRunMs`; appendix A).

### 4.5 Entry actions

S3 plans these for the record's current seq until each is done. Keys are
`i<N>/l<L>/s<seq>/<action>` (appendix C).

| On | Actions, in order |
|---|---|
| every new seq | `event transition` (first, after a close's `merged`); then, when steps of an earlier seq still run (the life's running agent steps that started before this seq's transition, whatever their key's shape), one `stop-agent` (TaskStop of its agent) for each, and `slot` op `kill` (10.8), all best effort: a gone agent or a refused kill is logged, never a failure (`failures/F12`, `totality/T-06`) |
| a change of state, except to closed | `label` |
| building | event `delegated --note "brief <url>"` |
| fixing | event `fix_requested --note review\|ci\|conflict\|triage`: the life's last fix reason (a resume's is the one it parked with) |
| merge-queue | event `merge_ready --pr <p> --head <h>` |
| parked | `comment` on the issue: the question, what parked it, and how to resume (remove the label, or `/factory resume N "note"`); `tell(parked)` |
| closed | `label` op `clear` (3.4); then by why. dropped: event `abandoned`. merged and merged-by-hand: event `merged` when the factory view at the close has none for the life (a merge whose log was lost, `totality/T-05`), planned before the seq's `event transition`: read only while that transition is not yet planned, so a later `closed` never logs the merge again, and once planned it is kept until done; then `rollout`, then `close-issue` when the rollout says `close_issue`, and `milestone-later` for a `run-it` or `keep-open` rollout (D-29). split: `release-parent` |

- A seq's step starts only after its entry actions are done, `tell` excepted.
- **Comments carry a hidden key**, `<!-- factory-loop:<ledger key> -->`. The `comment` executor
  reads the issue's or PR's comments for that key before posting, so a retry never posts twice
  (`totality/T-05`).
- **An effect that uses up its attempts holds its record.** The record's skip line reads
  `stalled: <key>: <error>`, the owner hears once (`tell(stalled)`, an owner item), and
  `/factory retry N` clears it (D-38). A retry of the step could not fix a failing effect, so the
  record is not sent down the unknown path (`totality/T-06`).
- The slot is freed by W2, not by an entry action, so it is freed however the record parked or
  closed (10.1).

### 4.6 The table as data

```ts
type EventKind = 'ok' | 'not-ok' | 'unknown' | 'triage' | 'drop' | 'unpark' | 'issue-closed'
               | 'pr-merged' | 'pr-closed' | 'claim-lost' | 'timeout'
type TableEvent = { kind: EventKind; reason?: string; cause?: OutsideCause; choice?: TriageChoice; data?: unknown }
type Row = {
  id: string                                       // 'T1', 'U3', ...
  states: readonly IssueState[]                    // where the row applies
  on: EventKind
  when?: (r: IssueRecord, e: TableEvent, c: Config) => boolean   // pure guard
  next: IssueState | 'same' | 'resumeTo'
  change: (r: IssueRecord, e: TableEvent, now: Ms) => Partial<IssueRecord>   // pure
  via: string                                      // the transition note's `via` code
}
export const TABLE: readonly Row[]
export const ENTRY_EVENTS: Partial<Record<IssueState, EmitState>>   // a state's entry event (4.5)
export function rowFor(r: IssueRecord, e: TableEvent, c: Config): Row   // exactly one row, or it throws
```

- `rowFor` is the only lookup. Plan calls it; tests enumerate it. It throws when zero or two rows
  match. That is a test failure, never a runtime path: the totality test (17.1) covers every
  (state, step, event, guard input).
- A matched row that changes the record gives one action `transition`, keyed
  `i<N>/l<L>/s<seq>/t`. It carries the next record and its trigger (3.3). Its executor re-checks
  the trigger, stores the record and pings the driver. Everything else is an entry action of the
  new seq (4.5).
- Same-state rows that change the record (U1, U2, U3, T6, X1) are transitions too: they bump `seq`
  and log a `transition` event, so the trail is complete.
- A row whose next names a state enters it, even when it is the state the record is in (X2 from
  fixing, X3 from designing): the state's own step starts at attempt 1 with no cut and the row's
  notes alone. `since` and the label change only with the state.
- Rows that change nothing (E6, E7) plan only their tell or their log line. They make no
  `transition` and never end a running step.

## 5. Unknown: one path

### 5.1 The path

1. A first unknown whose cause is outside the issue runs the step again for free, once per
   attempt (U1).
2. Otherwise the first unknown in a step runs it again (U2).
3. The second runs one triage call (U3), unless this life already had `maxTriages` triage calls,
   or the step was triage itself (U4 parks).
4. After a triage `retry`, the step gets exactly one more attempt (X1 sets attempt 2), so its next
   unknown goes to step 3.

- **What is unknown.** No answer; the timeout of a running step; a dead or lost agent; a turn that
  ended in error, aborted or refused; an API error, a 429 included; an answer that fails its
  contract after its repair message; a CLI result outside the step's known outcomes; a GitHub
  wait past its bound (4.4).
- **A GitHub blip is not a result.** Under planner v2, an action whose attempt fails on a
  transient GitHub error runs again inside the attempt, after 5 s and then 15 s, before its
  failure counts (`registry.ts` `executorOf`): a 5xx, GraphQL's "Something went wrong", a gateway
  or connection timeout. A rate limit is not retried there, since its 15-minute backoff holds
  GitHub (v1 SPEC 10.2), and neither are credentials, a 404, a validation error or a refusal. So a
  blip never ends a step unknown or holds an effect, and logs no intervention (drill finding
  R2-F4: one `gh pr update-branch` error made the head's step unknown). The result must carry the
  error's text: a command's output, or the merge guard's FAIL reason, which names what its read
  printed (9.4). Running an action again is safe: each reads what a try before it did before it
  acts or records, as the ledger's own retries need (an update found up to date reads its head
  back, since GitHub may have made it before its error, 9.2).
- **Causes outside the issue** (U1), each from a fact the loop already holds, never inferred
  (`failures/F2`, `totality/T-12`, `totality/T-13`):
  - `load`: the step's entry started before this module load and ended `lost` (the loop
    restarted, for whatever reason);
  - `usage`: the step's entry ended rate-limited (why `rate-limited`: a 429), or the tier was
    `stop-new` or `stop-all` when it ended;
  - `breaker`: the step-unknown breaker (5.3) was open when the step ended, or this unknown trips
    it;
  - `slot`: the record's lease vanished while the step ran (10.1). The step ends then, not at its
    timeout: a running agent is stopped by the next seq's entry actions, and a prepare counts only
    for the lease it ran in, so no agent starts in a slot that was not prepared for it.

  Each is free once per attempt (`cut`), so a step that itself brings the session down meets U2
  on its second cut, and work stays bounded (property 7).
- **Usage limits.** A free re-run waits until its class is allowed. The pre-check skips a spawn
  without counting while the tier stops it (v1 SPEC 10.7). So a step killed by the usage window
  runs again after the window resets, at no cost to the issue (C3:201).
- **Clean retries.** Every attempt starts in a freshly prepared slot (10.2): its processes killed,
  its leftovers saved, and the slot reset to origin's branch head. A retry's prompt names the
  previous attempt's result and its leftovers file, so uncommitted work can be applied and side
  effects are not repeated (`totality/T-13`, `totality/T-18`).
- **Bounds.** Per life: one free re-run per attempt, at most two attempts of a step per triage
  grant, `maxTriages` triage calls and `fixCap` fix rounds. An owner resume resets them (P1).
  Property 7 checks the bound (17.1).

### 5.2 The triage agent

- **Agent.** `factory-loop:triage`, a new loop-owned definition (`agents/triage.md`). It is
  spawned as a step in the issue's slot, as a reader. Model `triageModel` (default `opus`).
  Timeout 15 minutes. One repair message on a bad answer (D-68).
- **Inputs.** Ids and pointers in the prompt; free text is keyword-rewritten (D-56):
  - the issue number and title, the brief URL, the branch, the head and the PR;
  - the state, the step kind, the attempt, `triages`, `fixes` and `round`;
  - the last two step results: status, the executor's summary, an error excerpt of up to 2 000
    characters, the ledger key, and the paths of their spawn records, answers, stop-gate results
    and leftovers in the loop dir (`spawns/`, `answers/`, `leftovers/`; v1 SPEC 6.3);
  - for reviewing and merge-queue: the head's check runs (name, conclusion, link), the latest
    review answer's path, the PR's `mergeable_state` and the guard's FAIL lines;
  - the owner's notes for the issue;
  - the menu, with what each choice does in this state.
- **The menu** is fixed (OB:44-46):

  | Choice | Effect | Valid when |
  |---|---|---|
  | `retry` | the step runs once more, with `instructions` as a note | always |
  | `fix` | to fixing, with `instructions` for the fixer | the branch has commits beyond the base, and `fixes < fixCap` |
  | `redesign` | to designing, with `instructions` for the designer; branch and commits kept | always |
  | `park` | to parked, with `question` for the owner | always |
  | `drop` | to closed (dropped), with `reason` | always |

  A `fix` that is not valid parks the issue, with the triage's reason in the question (X4).
- **Output contract** `triage`, recorded with the answer script only (D-74; the loop's own tools
  never reach agents it spawns from its timer, SPIKES.md):

  ```json
  { "choice": "retry | fix | redesign | park | drop",
    "reason": "one line, at most 500 characters",
    "instructions": "required for retry, fix and redesign; at most 4 000 characters",
    "question": "required for park; at most 2 000 characters" }
  ```

- **Checks** in `hooks/v2/contracts-triage.mjs`, which `contract.mjs` imports, so the script and
  the loop check alike (D-74): the choice is one of the five, the field it needs is present, each
  text is within its limit, and there is no other field. The answer is kept in `answers/`; the
  transition note carries `via=triage:<choice>`.
- **What it may do.** Read anything: issues and PRs through `callum-flow-issue-read`, the loop
  dir, the slot, and CI logs with `gh run view --log-failed`. It may not write in the repository,
  push, comment or change labels (the reader role, 10.4).

### 5.3 The step-unknown breaker

- **Trip.** Three unexplained unknowns of agent steps, on two or more records, within 15 minutes.
  Unexplained means not caused by `load`, `usage` or `slot` (5.1), so a restart that cuts every
  agent at once does not trip it. An unknown that ends while the breaker holds is the breaker's
  own (cause `breaker`, 5.1) and counts toward no trip, so a trip holds 30 minutes from the
  unknown that tripped it, never longer, and is told once.
- **Effect.** It closes the `start`, `develop` and `drive` classes for 30 minutes: no claims, no
  agent steps, no triage. The held steps show the skip line `breaker` and cannot time out (4.4).
  The owner hears once, on the first pass after the trip, whether or not that pass asks for
  anything the breaker holds (`tell(breaker)`, an owner item); its tell logs the trip (7.2).
- **Why.** An outage (an API failure, a token expiry, an Actions incident) would otherwise spend
  every issue's retries and triages, then park them all (C3:112; `failures/F2`,
  `totality/T-12`). It replaces the draft's park bucket, which acted only after the damage.
- **Where.** It is the foundation's executor breaker (v1 SPEC 11.4) with one more bucket, in the
  admission filters that `foundation.ts` copies.

## 6. Reconcile

### 6.1 The rule

Every issue that shows as active must have a live step (OB:48-55). An issue that shows as active
but has had no live agent, slot lease, pipeline or PR activity within its state's timeout is
released. A release puts the issue back in the queue by re-adding `ready` (owner, 2026-10-15),
where S1 claims it as a new life, with two exceptions:

- the owner dropped it, or the issue is closed: it leaves the factory;
- it was the issue's `maxLives`-th life (default 3): it is rejected. It gets `factory:rejected`
  instead of `ready`, and leaves (6.4).

The owner's first rule, "still labelled `ready` goes back to the queue, otherwise it leaves",
never put an issue back: claiming removes `ready` (`callum-flow-claim:21`), so every claimed
issue read as not labelled `ready`. The one-shot migration (6.3) requeues nothing: every issue it
releases leaves (owner, 2026-10-15).

Events are append-only. A release writes a closing event with reason `reconcile` and deletes
nothing (OB:51-54).

v2 applies the rule in two places (`simplicity/F1`, `failures/F11`, `totality/T-16`):

- **R1, on every pass**, over v2's own facts. It has no mode, no approval and no hold on claims.
- **The one-shot migration** (6.3), for what v1 left behind. This is the reconcile that "runs in
  observe mode and lists the proposed releases before acting" (OB:54).

### 6.2 R1: every pass

R1 is pure, in `hooks/v2/reconcile.ts`. It runs on every pass, before S1 and S2. On the first pass
after a load or a rebuild, S1 and S2 start nothing until R1 has run.

1. **Records are never released.** The table keeps them live by construction: every record has a
   running step, a planned action, or a skip line that names why it waits (property 3), and every
   running step and waiting state has a timeout (4.4). A stuck record goes down the unknown path
   to a park with a question. It is not dropped from the factory.
2. **A live claim with no record is a ghost.** This covers an issue that the `factory` source shows
   live with this device as the holder, that has no non-closed record and no `claim` action in
   flight. In act mode R1 releases it at once (6.4); the decision log and the closing event name
   it. In observe mode and in the shadow, the release is planned and logged, not executed.
   After the migration, a ghost can only come from a bug or a lost store with no events, because
   S0 makes every record from its done claim (3.3). The release goes back to the queue unless the
   owner dropped the issue since its claim (`control.dropped`), and unless this was its
   `maxLives`-th life; a requeue waits for a read that shows the issue open (a closed one is the
   sweep's, H2). The cap is what stops such a bug from claiming and releasing one issue forever.
3. **Only this device's claims.** R1 never looks at another device's claims or labels
   (`totality/T-02`).
4. **The main-checkout tripwire** (10.7) also runs here: it compares the loop's own record of the
   main checkout with what it now sees.

One owner of ghost claims: R1 releases ghosts at once, so no ghost's claim can lapse while it waits
and be brought back by the sweep. H1 renews only records' claims (`totality/T-15`).

### 6.3 The one-shot migration

`bin/factory-reconcile` in the factory-loop plugin, built in wave 1. It applies the owner's rule to
the issues v1 left behind, with v1's evidence, so v2's every-pass rule never has to read
v1-only facts.

- **Observe by default.** `factory-reconcile --repo R` lists this device's live claims (from
  `callum-flow-factory-state`) that have no v2 record, and the issues the view shows as live with
  no live claim and no `ready` label (owner, 2026-10-15): those with no holder at all, in a live
  stage or queued, and those queued after their claim ended or lapsed, whoever made it. No device
  holds them, so nothing else would ever end them (#286, #289, #290, #468 and #469 on dev-system
  showed as queued for 3 to 6 days with no holder; #590 there, and #54 and #57 on plant-console,
  as queued after the loops' claims lapsed). One labelled `ready` is in the queue and is left out,
  and so is a v2 record's queued state, which is live work. For each it looks for live evidence within `T`, the timeout of the v2 state its
  factory-state stage maps to (designing to designing, implementing to building, in pipeline and
  parked to reviewing, ready to merge to merge-queue; any other stage, queued among them, 2 h):
  - a no-mistakes run of the issue's branch updated within `T`, as the `factory` source reports it;
  - the open PR's head pushed, a check run started or finished, or a review within `T`;
  - a v1 slot checked out on the issue's branch whose tree or HEAD changed within `T`.

  It also lists the pool's other slots, those with no `factory-loop:` holder. A slot checked out
  on an issue branch whose issue has no live claim and no record is proposed for freeing. A slot
  on no branch is only listed: v1 implementers detached theirs (#563), and the tool does not guess
  owners from reflogs.

  It prints the report and writes it to `<loop dir>/reconcile-<date>.md`. Each issue or slot gets
  one line: why it shows as active, what was checked, and the proposal. The proposal is `leave the
  factory`, `free the slot`, `remove the label`, or `live: check again later`, and the line names
  the issue's open PR and its v1 slot.
- **Nothing is requeued** (owner, 2026-10-15). Every issue the migration releases leaves the
  factory, whatever its labels, and the report says so: the owner re-adds `ready` for any issue
  still wanted, and S1 adopts its open PR (3.5). R1's requeue (6.4) is for v2's own releases.
- **Act on approval.** `factory-reconcile --repo R --act <N...>|all`. It checks each named issue
  again and releases those that still qualify (6.4). It also frees a v1 slot on the issue's
  branch: the slot's processes are killed, its leftovers saved (10.2) and it is returned. Approval
  is by issue, so a proposal that changes between the report and the approval is checked again,
  and there is no digest to go stale (`totality/T-16`). `--act all` leaves every live proposal
  alone; a live issue named in `--act` is released all the same, since the owner has judged it
  stalled (the report lists these as "released only when named").
- **`In development`.** It removes the label from each issue it releases. The report also lists
  the issues that still carry it with no live claim, open or closed, with the proposal `remove
  the label`, approved by issue like the rest (3.6).
- **When.** In wave 1, while both live loops stay in observe mode (the owner's choice, section
  15). Again just before cutover (17.5). The act run comes after U4 lands on
  `feat/factory-loop-v2`: `--act` fails closed, refusing with exit 1 and changing nothing until
  `events.ts` writes and reads back the release's and the intervention's note fields and the
  `callum-flow-event` in use logs an `intervention` (the branch's `images/base/callum-flow-event`,
  through `CALLUM_FLOW_EVENT_BIN`, until the base image ships it).
- **Nothing is lost.** A slot is returned only once its leftovers are saved or its tree is clean;
  else its issue fails and the slot is left for the owner. Each event is looked for in the log
  after it is written, since `callum-flow-event` exits 0 when a write fails. One that is not there
  fails its issue (exit 1), and its argv is kept in `<loop dir>/unlogged-events.jsonl` to log
  again.
- **Deleted** at the delete wave, once both repos' loops have cut over.

### 6.4 Release

| Outcome | When | Actions, in order | Event |
|---|---|---|---|
| requeue | R1's default | stop any agent of the loop on it; in one call, `ready` on and the seven state labels off (`label` op `requeue`); W2 frees a `factory-loop:` slot leased for it | `reclaimed`, with the release fields (7.1) |
| leave | R1, when the owner dropped the issue since its claim; the migration, always | stop any agent; the seven off (op `clear`); the slot freed. The migration removes every `factory:*` label and `In development`, and frees the v1 slot on the issue's branch | `abandoned`, with the release fields |
| reject | R1, at the issue's `maxLives`-th life | stop any agent; in one call, `factory:rejected` on and the seven off (op `reject`); one comment on the issue and one owner tell (`rejected`, appendix D), each listing why every life ended and how to bring it back; the slot freed | `abandoned`, with the release fields and outcome `reject` |

- The event is logged last, so it is never logged for a release that did not happen (the order
  D-48 set for `abandon`): after the labels, a rejection's comment and tell, and the slot. R1's
  release is keyed `i<N>/reconcile/<claim time>/<op>`, and a done key never runs again. Its label
  action's op is the outcome (`requeue`, `leave` or `reject`), so a release once begun keeps the
  outcome it began with, whatever changes after.
- Each release is an intervention (7.2): by the loop for R1's, cause `rejected` for a rejection
  and `reconcile` for any other; by a person for the migration's (`reconcile`), which act on the
  owner's approval. The migration tool is not the loop, so it writes its events itself, in the
  same note encoding (7.1); its tests parse them with `events.ts`.
- **Lives** (owner, 2026-10-15; `hooks/v2/lives.ts`). Each claim of an issue is one life, and
  `maxLives` (default 3, appendix A) is how many it gets. The record counts them (3.2): S0 sets
  `lives` to one more than the issue's earlier lives since its count last started. The loop knows
  an issue's earlier lives from its records and from R1's releases in the ledger, whose ghost
  lives have no record, each dated by its claim: a record's count stands as it is, and each
  release after it counts one more. The newest rejection ends the old count, so the first claim
  after it (the owner lifted `factory:rejected` and added `ready`) is life 1 again, and its S0
  transition's via is `unreject`, the owner's intervention. A closed record and a ledger entry go
  7 days after they end, so a life older than both is no longer counted; the cap still catches
  churn, which comes within hours, and the rejection's comment names the lives that were pruned.
- After a release the issue no longer shows as active: its labels are off, and its newest decision
  event is `reclaimed` or `abandoned`, which every factory reader takes as the end of a claim
  (`docs/metrics.md:225-247`; `docs/factory-state.md`, "Stages"). No new kind is needed
  (OB:52-54).
- The release's free-text field reads `no live step in <stage>: <what was checked>`.
- The issue's open PR is never updated or closed. A requeued issue's next claim adopts it (3.5),
  and the report names it, so the owner can re-add `ready` for an issue that left.

### 6.5 Today's ghosts

At 09:30 on 2026-10-15 the factory-state view showed 17 live issues on dev-system, at least 7 of
them ghosts (OB:54-55). G1's end states at the 07:25 snapshot (G1:69-85) fall into these cases for
the migration:

| Case (G1) | What the migration sees | Proposal |
|---|---|---|
| Limbo: the implementer stopped with no commit and no rule moved it (#613) | in-dev label, no run, no PR | leave (`abandoned`) |
| Stuck on a refused respond or a dead run, told `agent-failed` (#589, #620, #591) | in-dev label; #589's PR #626 open; no activity since 02:35 | leave; the report names PR #626 |
| An owner decision (#590) | in-dev label, no step | leave; the report says the decision was asked at 02:24 and that re-adding `ready` with an answer brings it back |
| Merge holds on clean PRs (#467 with PR #621; #571 with PR #631) | in-dev label, open PR, no activity | #571 has merged since (`dd73ce2`), so it no longer shows as active. #467's run looks live (no-mistakes' CI monitor keeps touching it), so the owner names it in `--act` and it leaves; re-adding `ready` brings it back and S1 adopts PR #621 |
| Dropped and re-queued (#533), labelled `ready` | queued with `ready`: no live claim | not a ghost: S1 claims it and adopts any open PR on an `issue-533` branch |
| Queued for days with no holder and no `ready` (#286, #289, #290, #468, #469) | the view shows them queued; no device holds them | leave (`abandoned`) |
| Abandoned with a dirty slot (#602, slot 8) | no labels; a v1 slot | the slot is freed if it is on #602's branch (its leftovers saved), else listed for the owner |

Whatever the view shows when the tool runs, the same rule applies.

## 7. Events

### 7.1 What v2 emits

**The format.** v2 writes its events in today's format (owner, 2026-10-15; section 15):
`callum-flow-event` states with their existing fields (issue, run, branch, pr, head, note,
actor), and v2's extra fields as `key=value` tokens in the note, in the encoding today's `loop`
notes use (`loopNote` and its inverse `entryFromLoop`, `derive.ts:369` and `:445`;
`docs/metrics.md`, "loop"):

- Tokens are separated by single spaces. A value holds no spaces: `%` and whitespace are
  percent-encoded (`enc`, `derive.ts:352`). A missing value is `none`, a list is comma-joined, a
  flag is `yes` or `no`.
- The identifying tokens come first and free text (a reason, a question, notes) last. Nothing is
  clipped: each field is bounded where it is made (the table keeps a question to 2000
  characters and at most 8 notes of 1000; a reason is one line of 200), and `callum-flow-event`
  and `factory.events` put no bound on a note. So a note carries every field whole.
- `callum-flow-event` checks each new state's identifying tokens, as it checks `kind=`, `key=`
  and `status=` for `loop` (`images/base/callum-flow-event:147-155`): `transition` needs `life=`,
  `seq=`, `from=` and `to=`; `reviewed` needs `verdict=` and `round=`; `intervention` needs
  `who=` and `cause=`.
- **One seam.** `hooks/v2/events.ts` builds every event v2 writes: the state, the columns, the
  note and the argv, and holds the note's parser. The `event` executor and `act-events.ts` call
  only it, so a later format change touches one module.

Three new states in `callum-flow-event`, whose vocabulary is closed
(`images/base/callum-flow-event:27-30`; the last addition was `loop`, D-09):

| State | When | Columns | Note fields |
|---|---|---|---|
| `transition` | every record change (4.6), and again after a re-claim (4.1) | issue, branch, pr, head | the row id, `from`, `to`, `via`, and every record field (3.2), so a record can be rebuilt from it (3.3) |
| `reviewed` | each review result (8.3) | issue, branch, pr, head | `verdict` (`approve`, `changes` or `unknown`), `round`, `patch`, the counts of error, warning and info findings, the reviewer's id, the answer's path |
| `intervention` | each intervention (7.2) | issue (when there is one), pr | `who` (`person` or `loop`), `cause` (a code of 7.2), `reason` (one line, at most 200 characters), the life when there is one, and the key of the fact it records |

- `transition` sets a stage for the factory tools (7.3). `reviewed` and `intervention` set no
  stage and are not progress for the stuck test.
- The companion writes two more states, `prompt_denied` and `prompt_waiting` (10.10), through
  `callum-flow-event` itself, not through `events.ts`: `--issue` required, a `key=value` note with no
  required token. They set no stage, are not progress for the stuck test and never decide whether an
  issue is final. The loop does not read them: it reads the companion's log (7.2 `prompt-denied`).
- A retried event can be logged twice (a crash between the CLI's exit and the ledger's save).
  `transition` notes carry `life` and `seq`, and `intervention` notes their fact's key, so
  readers count one per (issue, life, seq) or per key, as they already count identical
  consecutive rows once (`callum-flow-sweep` header).

Reused states, each with the meaning it already has. v2 writes them through `events.ts` too, with
the note today's queries read:

| State | Logged by | In v2 |
|---|---|---|
| `claimed`, `renewed`, `claim_lost` | `callum-flow-claim` | S1 and H1, unchanged |
| `ready` | `queue-watch.sh --once` | unchanged |
| `reclaimed`, `closed` | `callum-flow-sweep`; R1 for `reclaimed` | unchanged; a release to the queue. A release adds the release fields to the note: reason `reconcile`, its `outcome` (`requeue`, `leave` or `reject`), `lives` (the released life's number; `none` for the migration's), the stage, what was checked, the open PR |
| `abandoned` | v2 executors; the migration | drop, split, a triage drop, a release out of the factory or a rejection (with the release fields) |
| `delegated` | entry to building, `--note "brief <url>"` | keeps the metrics' design stage (`docs/metrics.md:108-113`) |
| `fix_requested` | entry to fixing, `--note review\|ci\|conflict\|triage` | keeps the first-pass query (`docs/metrics.md:120-143`) |
| `merge_ready` | entry to merge-queue | keeps the merge-ready point of lead time and the waiting split |
| `verdict` | after a fix step, one per finding the fixer handled, actor `fixer`: `CORRECT: <id> <reason>` (fixed) or `WRONG: <id> <reason>` (declined) | keeps the reviewer false-positive query (`docs/metrics.md:145-159`) |
| `merged` | `callum-flow-merge`; the loop for a merge whose log was lost (4.5) | unchanged |
| `implementer_routed` | `callum-flow-implementer-route` before a build | unchanged (`docs/metrics.md` section 8) |
| `loop` | agent and wake entries, rate caps, breakers, owner operations; a `kind=passes` pass summary once a minute while the loop acts (#680) | unchanged (D-09). The summary is bookkeeping, never a stage or progress; the reader does any weighting |

The loop no longer logs `superseded`, `rebased_behind` or `run_started`, and no watcher states
(there are no pipeline runs).

### 7.2 Interventions

An intervention is any point where someone had to step in that the plan did not foresee: a person
(`who=person`), or the loop with unplanned judgement or recovery (`who=loop`). The owner chose
this broad meaning so that these signals are never lost (section 15; issue #632, metrics 1 and 2).
Each gets one `intervention` event, keyed by the fact it records, so it is logged once.

**By a person** (`who=person`). Anything a person did:

| Cause | When | Issue |
|---|---|---|
| `op:<name>` | every `/factory` op but `status` and `help`: the work ops (`resume`, `drop`, `note`, `skip`, `noskip`, `priority`, `only`, `pause`, `unpause`, `serial`, `new`, `override`, `retry`), and `mode`, `trace`, `planner` and `update`. `ownerOp` (`register.ts:1389`) logs it after the op lands, when planner v2 in act mode is in force before or after the op, so the ops that turn the loop on (`mode act`, `planner v2`) and off are logged too | the issues the op names, else none |
| `unpark` | `factory:parked` removed by hand (P1 by label) | the issue |
| `push` | a head on the record's branch that no loop step produced (4.1) | the issue |
| `hand-merge` | E3 | the issue |
| `pr-closed` | E4 | the issue |
| `issue-closed` | E2 | the issue |
| `control-file` | `control.json` or the `OFF` file changed with no op (against the last version the loop read or wrote, kept as `files:<repo>` beside the records; each change found, by an acting pass or by an op that finds its file already changed, is kept there as an edit to log, keyed by when it was found, so a change back to an earlier version is logged too; the loop never writes `OFF`, so the pass that finds it keeps its use as an edit) | the issues whose entries changed, else none |
| `config-file` | the workspace `config.json` or the repo-local `.claude/factory-loop.json` changed other than by an op: capacity (K) and every other setting. While the loop does not act under v2 (mode off or observe, or planner v1), the workspace file it reads each tick is kept in memory, and the first tick that acts makes it the version compared against, so a hand edit that turns the loop on (`mode`, `planner`) is one too | none |
| `restart` | a module load after an earlier run of the loop (its ledger holds an entry from before the load) with no `restart-self` in flight. The first start of a loop with no ledger restarts nothing | none |
| `reconcile` | the migration's releases, approved by the owner (6.4) | the issue |
| `unreject` | the first claim after a rejection: the owner removed `factory:rejected` and added `ready` (S0's via `unreject`, 6.4) | the issue |
| `rescue` | recorded by hand, for what the loop cannot see: patching a trust file, killing a process, editing a file in the workspace, a hand release. `callum-flow-event intervention [--issue N] --note 'who=person cause=rescue reason=<what, spaces as %20>'` (the encoding of 7.1), which the operator playbook adds to each rescue recipe | the issue, when given |

**By the loop** (`who=loop`). Each comes from a fact the loop already holds:

| Cause | When | Issue |
|---|---|---|
| `triage` | every triage call (T6, U3) | the issue |
| `unknown:<why>` | every step that ended unknown and is not a free re-run. `why` is `timeout`, `agent-dead` (the agent failed, was lost or crashed, or its turn ended in error, aborted or refused), `bad-answer` (no valid answer after the repair message), `api` (an API error other than a rate limit: a 5xx, overloaded), `rate-limited` (a 429 or the usage window; a free re-run, cause `usage`, so it is logged as `unknown:rate-limited` only once its attempt's free re-run is spent), `spawn` (the companion refused the spawn), `cli` (a CLI result outside the step's known outcomes, a failed origin read, a failed prepare, a guard FAIL of class `read`) or `github-wait` (a wait past its bound) | the issue |
| `free:<cause>` | every free re-run (U1): `load` (after a restart), `usage` (a usage-limit kill), `slot` (a lost slot) or `breaker` | the issue |
| `park` | every entry to parked: a question to the owner | the issue |
| `fix:ci`, `fix:conflict` | a fixer sent for red CI or a conflict, in reviewing or the merge queue (T9). Something did not merge as it should | the issue |
| `ci-rerun` | a failed or cancelled check re-run (8.5) | the issue |
| `queue:patch`, `queue:linkage` | the queue's head went back to review because its patch changed (T14), or its body was re-rendered after a `linkage` FAIL (9.3) | the issue |
| `guard:write`, `guard:push`, `guard:command` | the companion refused a file write, a push, a command, or a call in the background (10.4). An agent did something strange | the issue |
| `gate-unknown` | a stop gate that could not run (10.6) | the issue |
| `prompt-denied` | the companion refused a call that would have waited on a prompt nobody answers (10.10). The agent was told to find another way | the issue |
| `tripwire` | the main-checkout tripwire fired (10.7) | none |
| `breaker` | the step-unknown breaker or the foundation's executor breaker tripped (5.3) | none |
| `stalled` | an effect used up its attempts and holds its record (4.5) | the issue |
| `workspace` | the rail held agent steps because the companion is not loaded (10.9) | none |
| `reconcile` | R1 released a ghost (6.2) back to the queue or out of the factory: once, from its done release event, the pass after it | the issue |
| `rejected` | R1 released a ghost at its `maxLives`-th life (6.4): once, from its done release event | the issue |
| `reclaim` | H1 claimed a lapsed claim again (4.1) | the issue |
| `wake` | any wake or task that is not a planned step: anything but a `tell` or the release task (O3) | the issue, when there is one |

**Not interventions.** The planned work: the designer, builder and reviewer doing their normal
work; a fixer for review findings (T9 with changes); a fixer chosen by triage (X2, already counted
as `triage`); Q1's updates of the head, Q2's merges, the release task, heartbeats, sweeps, leases
and frees; tells for waiting states (E6); a held step's skip line; `claim-lost` (E5), which is
another device's work; `status` and `help`. Each owner item (`parked`, `breaker`, `stalled`,
`checkout`, `workspace`, `rejected`; appendix D) has its intervention.

**How they are made.** One unit (U4) owns them, so no other unit emits one:

- Loop interventions and the detected person ones are derived, never emitted ad hoc.
  `hooks/v2/rules-interventions.ts` plans one `intervention` event for each fact in the ledger
  (a done `transition` entry, by its row and event; a `ci-rerun`, a release, a re-claim, a body
  re-render, an exhausted effect), the records, the State (heads, control and config digests, the
  module load, the rail, the tripwire, the breaker) and the companion's log. Its key is
  `iv/<the fact's key>`, so each is logged once.
- **Logged once is the event log's to say.** A wiped store loses the ledger's keys, but not the
  facts in the loop dir (the companion's log, the recorded answers). So an `intervention` (by its
  cause and fact) or a `reviewed` event (by its answer file) that the pass's read of the event log
  shows logged is settled with no second write (`events.ts` `logOnce`), and its key is in the
  ledger again. That read is the week of events the ledger is rebuilt from on the pass after a
  wipe, else the facts read (2.4), so every fact judged (6 days) is in the ledger or in the read.
- **The companion's log.** The companion appends one JSON line per refusal and per stop gate run
  to `<loop dir>/companion.jsonl` (`loopDir` is in the step marker, 10.2), with the issue, life,
  seq, cause and reason. Its causes of this table are interventions; a gate that passed or failed
  (`gate-pass`, `gate-fail`, 10.6) is not. It writes no event itself.
- Ops are logged by `ownerOp` through `act-events.ts`; hand-recorded rescues through
  `callum-flow-event`.

**Fleet-level interventions** (a mode change, a restart, a capacity change, a breaker trip) name
no issue. They are attached to no issue: their effect on each issue shows as that issue's own
interventions (a restart's cut steps each log `free:load`). An intervention is attached to an
issue exactly when it names the issue.

### 7.3 Readers

Every reader parses v2's fields from the note's `key=value` tokens (7.1), as it parses today's
`loop` and `implementer_routed` notes (for example `substring(e.note FROM 'model=([^ ]+)')`,
`docs/metrics.md:433`), and decodes percent-encoded values.

- **`callum-flow-factory-state`** (`docs/factory-state.md`, "Source precedence"). Three changes in
  U4:
  - A new step between 2 and 3: an issue whose current life has a `transition` event takes its
    stage from the newest one's `to`. queued maps to `queued`, designing to `designing`, building to
    `implementing`, reviewing and fixing to `in pipeline`, merge-queue to `ready to merge`, parked
    to `parked`, and closed to `merged` or `closed without merge` by its `why`. The detail column
    shows the v2 state, the step and the attempt. Mirror runs no longer set the stage of such an
    issue. Stuck rules S1 to S5 stay as they are.
  - `nomistakes.runs` becomes an optional source, shown as `n/a` when missing, as
    `factory.workers_status` already is (`images/base/callum-flow-factory-state:532`;
    `simplicity/F3`);
  - the label checks without `In development` (3.6).
- **`callum-flow-evaluate`** (`docs/metrics.md`, "Offline computation"). New sections, each also
  a saved query in `docs/metrics.md`:
  - interventions per merged issue and per day, by `who` and `cause` (#632 metric 1 is
    `who=person`), with the fleet-level ones per day. A merged issue is **untouched** when no
    `intervention` names its merged work: one whose life began by its `merged`, whenever it was
    logged (a derived intervention comes a pass or more after its fact), or one with no life logged
    from its first `claimed` to its closing `transition` plus 30 minutes (`docs/metrics.md`,
    section 9);
  - judgement calls per merged issue, by kind and outcome (#632 metric 2): `reviewed` events,
    `intervention` events with cause `triage`, `transition` events whose fields show a designer
    question or split, and fixer `verdict` events. A judgement is overridden when a person
    intervention names the issue within an hour after it;
  - claim completion (#632 metric 3): per issue and life, the first `claimed`, then the first of
    `merged`, `abandoned` (dropped, split, triage, reconcile), `closed`, a `transition` to parked,
    or still open (censored, not a failure);
  - review rounds and fix rounds per merged issue, from `reviewed` and `fix_requested`;
  - time in flight leaves out time parked.
- **Existing queries** keep working for v2 issues through the reused states (7.1): first-pass rate
  (query 2), reviewer false positives (query 3), merges per device (query 4), double claims and
  stuck issues (query 6). Lead time (query 1) has no `run` stage for v2 issues; its v2 twin uses
  the first `transition` to reviewing.
- **The loop** reads `transition` events only to rebuild records (3.3). `EVENTS_SQL`
  (`derive.ts:38-50`) gains the three states; `record.ts` parses their notes with `events.ts`.

## 8. Design briefs and review

### 8.1 The PR

- **Ensure.** The reviewing step's first part, action `pr` op `ensure`, keyed per seq:
  1. `gh pr list --repo R --head <branch> --state all --json number,state,headRefOid`;
  2. an open PR is used; a closed, unmerged one is reopened (`gh pr reopen <p> --repo R`); with
     none, it creates one (`gh pr create --repo R --base <default> --head <branch> --title <title>
     --body-file -`);
  3. it writes the loop's body when the PR's body differs from it (`gh pr edit <p> --repo R
     --body-file -`), so an adopted PR's linkage is the loop's own. With no done build of the life
     to describe the work (an adopted PR, or a record rebuilt from events, 3.3), the body keeps the
     PR's own summary, and its own evidence unless a fix gave newer.

  A re-run never makes a second PR (`totality/T-04`). The PR's number is in the done `pr` entry, so
  plan sees it at once, and the row that ends the reviewing step (T8, T9, T10) writes it to the
  record.
- **The life's PR** is the record's `pr`, else the PR the life's newest done ensure named
  (`lifePr` in `hooks/v2/rules-review.ts`). Every reader of a life's PR goes through it: the `prs`
  source, which so reads a PR the ensure just opened on the next pass (2.4); GitHub's PR events
  (E3, E4); the push check (7.2); and the triage and work prompts. No reader takes the record's
  field alone: in the first review round it is still empty. (Fault drill 1, 2026-10-15: the `prs`
  source read only the record's field, so a new PR was never read and the review waited until
  its GitHub bound.)
- **Title:** the builder's answer `title`, one line of at most 72 characters, closing keywords
  rewritten (D-56).
- **Body**, written only by the loop (OB:71):

  ```text
  <summary from the builder's answer>

  Closes #N            ("Refs #N" when callum-flow-rollout says run-it or keep-open)

  Design brief: <brief URL>

  ## Evidence
  <the newest evidence a build or a fix gave, when one did>

  Opened by the factory loop for #N.
  ```

  Every free-text part goes through `neutral()` (`prompts.ts:47-73`), which caps it at 4 000
  characters and rewrites closing keywords (D-56). So only the loop's own line links an issue. A
  stray reference in evidence text once broke linkage for 80 minutes (G1:116).
- **The body follows the Rollout.** The guard derives linkage from the issue's current Rollout. A
  `linkage` FAIL at Q2 re-renders the body once per queue attempt (`pr` op `body`), then Q2 runs
  again (9.3; `totality/T-21`).
- **A PR closed by a person** parks the issue (E4). On resume, the ensure step reopens it.

### 8.2 The reviewer interface

Swappable (OB:72-74):

```ts
interface Reviewer {
  id: string                                   // 'adjudicator' is the interim one
  spawn(input: ReviewInput): AgentSpec         // pure: agent type, model and prompt inputs
  read(answer: unknown): ReviewResult | null   // pure: the contract-checked answer, or null
}
type ReviewInput = {
  issue: number; brief: string | null; pr: number; base: string; head: string; patch: string
  round: number; prior: { round: number; answerPath: string; fixerPath?: string }[]; notes: string[]
}
type ReviewResult = { verdict: 'approve' | 'changes'; findings: Finding[]; summary: string; bump: Bump }
type Finding = { id: string; severity: 'error' | 'warning' | 'info'; file: string; line: number | null; text: string }
```

- `reviewer` (setting) picks the implementation from the registry in `hooks/v2/reviewer.ts`. The
  owner's A/B test can run any implementation on frozen base and head pairs (V:305-308) outside
  the loop.
- `changes` needs at least one `error` finding. `approve` may carry warnings and infos. The
  contract (`hooks/v2/contracts-review.mjs`) refuses anything else. Finding ids are
  `r<round>-<k>`.

### 8.3 The interim reviewer

The existing merge adjudicator's judgement, given the brief and the whole diff (OB:72), in a
definition of its own: `agents/reviewer.md`, agent type `factory-loop:reviewer`
(`simplicity/F4`). The v1 adjudicator's definition is a no-mistakes gate adjudicator with another
output contract (`agents/adjudicator.md:3`, `:20`, `:35`), and it must stay unchanged while v1 can
still plan.

- **Model** `reviewerModel` (default `opus`; V:194). It runs in the issue's slot as a reader, on
  the PR head.
- **The definition** carries the merge adjudicator's rules that still apply: judge against the
  brief's acceptance criteria and test plan; reproduce a claimed defect before reporting it; no
  test weakened. It has no no-mistakes text.
- **Its prompt** (`hooks/v2/prompts-review.ts`) gives:
  - the issue and brief URLs, and the PR;
  - the diff to review (`origin/<default>...<head>`, three dots: the PR's own change);
  - the TEST POLICY sentence (`plugins/callum-flow/agents/fixer.md`);
  - the instruction to run `callum-flow-test-weakening origin/<default>..HEAD` and judge its
    output;
  - its own earlier rounds and the fixer's dispositions, so it does not repeat itself (V:194);
  - the owner's notes.
- **It checks** that every acceptance criterion and owner requirement in the brief is met, nothing
  unrelated was added, no test was weakened, and a visual change has UI evidence. It constructs a
  failing case for any defect it reports.
- **Answer.** It answers with the `review` contract (8.2) through the answer script.
- **What the loop does with it.** It posts each result as one PR comment with a hidden key
  (`gh pr comment <p> --body-file -`): the verdict, the findings and the summary. It also logs one
  `reviewed` event per result (7.1).

After the owner's A/B test, this slot may take no-mistakes' review or its prompt (OB:73-75). That
is a new `Reviewer` implementation and a setting, nothing more.

### 8.4 Approval keyed by patch identity

- **Patch id** of a head: `git diff -U0 --no-color --no-ext-diff $(git merge-base
  origin/<default> <head>) <head> | git patch-id --stable`, first field. A new image script,
  `callum-flow-patch-id <branch|sha> <base>`, computes it for both the loop and the guard. A head
  that changes nothing against main (main already has its change) has the zero id: `--stable` adds
  up one hash per file. It goes through review like any other patch.
- `-U0` leaves context lines out, so a clean `gh pr update-branch`, which only brings in main's
  changes around the PR's lines, keeps the id. With context lines, git's patch id changes whenever
  main touched a line within three lines of a hunk (C3:441).
- The record keeps `approvedPatch` from the approving review. A head whose patch equals it is
  approved; any other is not, and merge-queue sends it back to reviewing (T14).
- **A review is keyed by patch and round**: `i<N>/l<L>/review/<patch7>/r<round>/a<k>`. A done
  review of the head's patch in the current round is used, whatever the attempt or the head
  (`totality/T-11`):
  - a head that moved without changing the patch, such as a person's merge from main, keeps its
    review, and CI runs on the new head;
  - an unknown CI result does not re-run the reviewer;
  - a review of a patch the head no longer has is simply not the current patch's review, so the
    step plans the review of the new patch with no transition. When the old patch's reviewer
    still runs (a push during review), the step stops it first (`stop-agent`, keyed as 4.5's
    stops, so the seq's entry actions wait for it) and holds, on that reviewer's clock, until it
    has ended: one reviewer per record at a time (property 6). The new reviewer gets the slot
    prepared again. A reviewer the loop stopped gives no review: its `reviewed` event is
    `unknown` and nothing is posted on the PR.

### 8.5 The CI half

- **The checks.** Every check run on the head counts, required or not. Non-required checks matter
  here: `publish-base-image.yml` runs the image tests on PRs that change `images/base/` (CLAUDE.md,
  "No Docker in the dev environment").
- **Workflow runs.** A workflow run whose jobs have no check run yet, for example one queued on a
  `concurrency` group, is in no `gh pr checks` view, so the `prs` source also reads the head's
  workflow runs (`gh api repos/R/actions/runs?head_sha=<head>&per_page=100`). Only the latest run per
  workflow and event counts (the highest run id), so a run a newer one replaced, for example one
  concurrency cancelled, is ignored. A latest run not completed (or completed with another
  conclusion than the ones below) is pending, one completed with `success`, `skipped` or `neutral`
  is done, with `failure`, `timed_out` or `startup_failure` is failed, with `cancelled` is
  cancelled. When no visible check of a pending run is pending, or none of a failed or cancelled run
  is failed or cancelled, the source adds one synthetic check named `<workflow> (workflow run, no
  job yet)` with the run's id, link and start time, so the one re-run, the pending wait and the
  `ciRunMs` bound apply to it as to any check. The read fails closed: a failed or unparseable call,
  or a list shorter than `total_count`, leaves the PR unread like a failed `gh pr checks`.
- **One re-run.** A check that fails or is cancelled gets one re-run before it counts as failed:
  action `ci-rerun`, `gh run rerun <run id> --failed --repo R`, keyed by round and run id
  (`failures/F6`, `totality/T-09`). A flaky check then passes without a fixer. A new round, after
  a fixer, gets its own re-run. A run is re-run only once it has finished: GitHub refuses to
  re-run a run with a job still going. The key keeps it once per round, but the call itself is
  retried: a GitHub blip inside the attempt (5.1), and a `gh` timeout or a restart during the call
  with backoff (3 attempts), so none of them is a failed check. Only GitHub's own refusal of the re-run counts the check as failed at once.
  A re-run whose answer was lost, or a failed call GitHub took anyway (a check of the run ended
  since), is awaited, within `ciStartMs`. In reviewing, one that uses up its attempts on transient
  errors holds the record as a stalled effect (4.5). At the merge queue's head it makes the step
  `unknown`, never `ci-red`, as any queue action that used up its attempts does, so the queue
  moves past a head that cannot move (9.1).
- **A conflict.** GitHub does not run `pull_request` workflows for a PR with a merge conflict, and
  `ci.yml` triggers only on `pull_request` for branches (`.github/workflows/ci.yml:24-27`). So a
  `dirty` PR is `not-ok(conflict)` at once and goes to a fixer. It does not wait out `ciStartMs`.
  The GitHub rule is from GitHub's documentation and was not re-verified in this workflow.
- **Waits** are bounded by `ciStartMs` and `ciRunMs` (4.4).

### 8.6 Rounds and the cap

- `round` counts entries to reviewing in the life. `fixes` counts entries to fixing.
- Each reviewing, fixing, reviewing cycle adds one fix. At `fixCap` (3; `config.ts:32`) the next
  not-ok parks instead (T10; OB:63-65).
- A fixer that declines every finding sends the PR back to reviewing with its reasons (T12). The
  new round's reviewer judges the declines, and a failed check gets the new round's re-run. That
  costs a round, not a fix.
- An owner resume resets `fixes` (P1).
- Rounds have no cap of their own. Without outside pushes they are bounded by `fixCap` and
  `maxTriages` (property 7).

### 8.7 The design brief

The designer is a reader: it writes nothing to GitHub (`totality/T-18`).

- **Agent.** `factory-loop:designer-v2` (`agents/designer-v2.md`): the v1 designer's method (read
  the issue with `callum-flow-issue-read`, reproduce a bug first, spawn `callum-flow:explorer` in
  the foreground, the brief's fixed shape with its `## Rollout` line), with the v2 command rule
  (10.4) and no GitHub writes. It is renamed `designer` at the delete wave, when v1's goes.
- **Contract** `design`, through the answer script: `{ kind: "brief" | "question" | "split",
  brief, question?, children?: [{ key, title, body, blockedBy: [key | "#N"], ready: boolean }] }`.
- **The loop posts** the brief as an issue comment with a hidden key (4.5), and the step is ok
  once it is posted. Its URL is the record's `brief`.
- **A split.** The loop creates the children with action `split`, one keyed effect per child
  (`i<N>/l<L>/s<seq>/child/<key>`). Each child's body carries the hidden key, so a retry finds it
  instead of making a second one. The effect links the child as a sub-issue, adds its `blocked_by`
  links (to a sibling, or to an existing open issue of the repo named as `#N`; a closed one is skipped, a pull request refused), then labels `ready` the children whose `ready` is true. The step is not-ok(split) once
  every child exists, and T4 closes the record, keeping the parent open as the tracking epic
  (`agents/designer.md:71-77`).

## 9. The merge queue

### 9.1 Order

- The queue is the records in merge-queue whose step is `queue`, oldest `seqAt` first (ties by
  issue number). Paused issues are skipped. A record whose step is triage is not in the queue.
- Every transition sets `seqAt`. So a head whose step ends other than ok (an unknown, a retry, a
  triage's retry) goes to the back, and the next PR becomes the head (`failures/F4`,
  `totality/T-10`; OB:62-63).
- The head is the first. Only the head is ever touched: updated, checked or merged (OB:60-62). A
  PR behind the head waits untouched, however far behind main it falls.
- No other open PR is ever updated or rebased, by any rule (OB:65-66). The safety tests check that
  `queue-update` names only the head's PR and that no rebase exists (17.1 property 8).

### 9.2 Q1: update the head

- **When:** the head is behind, and no queue action of the head is running. Behind is read from
  facts the loop has: the PR's base commit (`base.sha`) is not main's head on origin, or GitHub
  shows `mergeable_state` `behind`. GitHub computes mergeability lazily and shows `unknown` for up
  to two minutes after main moves, so the loop does not wait for it (drill run 3, R3-O1). A
  conflict (`dirty`) is still GitHub's to say.
- **Action** `queue-update`: `gh pr update-branch <p> --repo R`. GitHub merges main into the
  branch; no history is rewritten (OB:61).
- **Key:** `i<N>/l<L>/queue/update/<base7>`, where `<base7>` is main's head at plan time. Each
  outside merge moves main and so earns one more update; the patch-keyed draft key could never
  update twice (`failures/F4`).
- **Outcomes:** GitHub's update is asynchronous, so the executor reads the PR's head until it
  moves (30 s bound) and records the new head in its ledger entry. That makes it a head the loop
  produced (4.1). An update GitHub finds needless (already up to date) records the head it reads
  back, never the head planned at: an earlier try of the attempt may have made it (5.1). A refusal
  for a conflict is `not-ok(conflict)`; a head that did not move or was not read back, or any
  other failure, is `unknown`, once a GitHub blip has been tried again (5.1).
- A head that already shows `dirty` is `not-ok(conflict)` without an update.

### 9.3 Q2: merge the head

- **When:** the head shows `clean`, every check on its head passed or was skipped (after re-runs,
  8.5), its patch equals `approvedPatch`, and no queue action of the head is running.
- **Action** `queue-merge`: `callum-flow-merge <p> --patch <approvedPatch> --issue <N>`, keyed
  `i<N>/l<L>/queue/merge/<head7>`. The guard runs inside it, and the merge uses
  `--match-head-commit`, so a push in between makes GitHub refuse
  (`images/base/callum-flow-merge:14-17`). `--issue` is the record's issue: the guard never has
  to read it from the branch name. `check-pr-linkage.sh` reads `issue-<N>` from the branch too
  (the number followed by `-` or the end of the name), so the linkage is checked, never skipped
  (factory drill 1 of run 2 parked two green, approved PRs on that skip).
- **Outcomes.** Merged is `ok` (T13). A FAIL line of the guard carries a class (9.4), and each
  class has one outcome (`failures/F3`):

  | Class | Guard clauses | Outcome |
  |---|---|---|
  | `behind` | mergeable: behind | no transition; next pass Q1 updates from the new base |
  | `conflict` | mergeable: dirty or conflicting | `not-ok(conflict)` (T9, T10) |
  | `checks` | checks: a check failed | no transition; next pass reads the checks and re-runs or ends as `ci-red` |
  | `patch` | patch | `not-ok(patch)` (T14) |
  | `linkage` | linkage | re-render the body once per attempt (8.1), then Q2 again; a second `linkage` is `policy` |
  | `read` | any "cannot read", "cannot verify", "cannot derive" or "not computed" line; `blocked` with checks pending | `unknown`: no answer about the PR, so a failed try, its reason naming the read's error (a GitHub blip is tried again, 5.1) |
  | `policy` | author not trusted; base not the default branch; draft | `not-ok(policy)` (T15): parked with the FAIL lines, since only the owner can change these |

  A refusal GitHub gives no reason for, or a CLI failure, is `unknown`, once a GitHub blip has
  been tried again (5.1).

### 9.4 The guard

`callum-flow-merge-guard` gains `--patch <id>`, which `callum-flow-merge` passes through. With it
the guard checks only facts the loop owns (V:217; OB:60-66):

| Guard | Check | With `--patch` |
|---|---|---|
| author | the PR's author is trusted | kept |
| rollout | the issue's Rollout derives | kept |
| linkage | `check-pr-linkage.sh` reports MATCH for the Rollout's expectation (it reads the issue from `issue-<N>` or `issue-<N>-...`; the loop also passes `--issue <N>`) | kept |
| base | the PR targets the default branch | kept |
| checks | at least one check, all passed or skipped, on the PR head; and the head's latest workflow run per workflow and event (`gh api repos/{owner}/{repo}/actions/runs?head_sha=<head>`) completed with success, skipped or neutral (a run with no job yet is in no check list); a failed, unparseable or truncated read is class `read` | kept |
| mergeable | open, not a draft, not conflicting, not behind, branch rules met | kept |
| patch | the head's patch id (8.4) equals `--patch` | new |
| head | the run's head against origin, the PR and every worktree | not run |
| gates | the no-mistakes run has no parked step | not run |
| test-weakening | advisory WARN lines | printed; not acted on, because the reviewer judges the detector (8.3) |

- **No no-mistakes call.** With `--patch` the guard skips its run lookup, which today calls
  `pipeline-watch.sh --resolve` and `no-mistakes axi status` before any clause
  (`images/base/callum-flow-merge-guard:215-227`). Its test asserts that `--patch` mode calls
  neither (`simplicity/F3`).
- **Classes.** In `--patch` mode each FAIL line ends with `class=<class>`, one of `behind`,
  `conflict`, `checks`, `patch`, `linkage`, `read` and `policy` (9.3). So the loop never parses
  the reasons' wording (`failures/F3`). A `read` reason ends with what the read printed on
  stderr, so a GitHub blip in it is tried again like any other (5.1).
- Without `--patch` the guard behaves as today, for people and the old orchestrator
  (`images/base/callum-flow-merge-guard:20-43`).

### 9.5 No hold while main is red

The queue never holds for a red main, and the loop does not read main's checks
(`simplicity/F5`, `failures/F5`, `totality/T-08`):

- With "Require branches to be up to date" on, every PR's CI after its update runs on main plus
  the PR, so the head's own checks already carry main's state.
- A flake on main shows on the head as a failed check, and its one re-run clears it (8.5).
- A real break on main shows as `ci-red` on the head. The owner's rule then applies: the PR leaves
  the queue for a fixer, and the queue moves on (OB:62-64). A fixer may fix the break in the PR
  or decline it; the fix cap and the step-unknown breaker bound the cost.
- The draft's hold came from the strict-off design (C3:102; V:268). Here it would have made the
  queue wait on a person while holding K slots (OB:92), and its failed-workflow signal included
  the scheduled and release workflows, which would have let a failed release hold merges (OB
  decision 7).

The owner confirmed this (section 15).

### 9.6 Throughput

- A merge needs at most one update, one CI run and one merge: about 4 to 5 minutes, so 12 to 15
  merges an hour against a demand of about 1 (V:260; OB:66-67; CI median 2.8 min, max 3.0).
- An outside merge during the head's CI wait makes the head `behind` again. Q1 then updates once
  more, under the new base's key. If main keeps moving, the GitHub wait bound and the unknown path
  bound it, and an unknown head goes to the back of the queue.

### 9.7 Fixer rounds

- A conflict or red CI goes to fixing with `fixes + 1` (T9), up to `fixCap`, then the issue parks
  (T10).
- For a conflict, the fixer merges `origin/<default>` into the branch and resolves it. It never
  rebases or force-pushes (10.4). For red CI it gets the failed checks' names and links and reads
  the logs with `gh run view --log-failed`.
- After a fix the PR goes back through reviewing: a fix changes the patch, and approval is keyed
  by patch (OB:63-64).

## 10. Workspaces

The loop owns each agent's workspace (OB:77-87). The spikes decided the design (SPIKES.md): a
small companion plugin, `factory-loop-workspace`, starts each agent in its slot and carries the
write guard, the Bash timeout and the stop gate. It must be a plugin of its own, because the
engine skips a plugin's own hooks for everything its own code starts, and the loop starts its
agents from its timer (`spikes/agent-folder.md`; `spikes/hooks.md`, run-settings debug.log:266-268).

### 10.1 Slots: W1 leases, W2 frees

- **Pool.** The treehouse pool of the main checkout, as today (`poolSize` 16, v1 SPEC 4.1). The
  loop leases with the holder `factory-loop:<N>:<life>` and finds its leases again by holder in
  `treehouse status --json`. It never infers a slot's owner from reflogs (FM 2.2, the `pool`
  row).
- **W1, lease.** A record that needs a slot and has none: a queued record (resumes first, by park
  time, then new claims, by claim time) when the records in designing to merge-queue number fewer
  than `maxInFlightIssues` (K), free slots exceed `worktreeReserve`, and the tier allows the class
  of the state the lease leads to; or a record in a slot state whose lease vanished (it already
  counts in flight). The action is `slot` op `lease`: `factory-slot lease <N> <life>`, which runs
  `treehouse get --lease --lease-holder factory-loop:<N>:<life> --base <default> --json` and
  prints `LEASED path=<p> lease=<id>`. The branch is checked out by `prepare` (10.2).
- **W2, free.** A slot with a `factory-loop:<N>:<life>` holder is freed when no record of that
  issue and life is in a slot state and no step entry of it runs. Action `slot` op `free`:
  `factory-slot free <path> <lease>` kills the slot's processes (10.8), saves leftovers (10.2)
  and prints their file, runs `git reset --hard` and `git clean -fd`, then `treehouse return
  <path> --if-lease-id <lease>`, which also ends lingering processes. It is done when the slot
  shows available. From the free's start the lease counts as gone, so a record resumed meanwhile
  waits for it to go back rather than step onto it. A second lease of a live life (a lease whose
  answer was lost, taken again) is freed the same way once nothing of the life runs. For one
  issue, W2 runs before W1 (`totality/T-19`).
- **Budgets.** The executor gives the tool its op's timeout less a margin (`--budget-ms`), and
  the tool ends its own commands inside it, so no `treehouse get` it started can finish later and
  take a second slot.
- W2 is a rule over the pool, not an entry action, so a slot is freed however its issue left:
  parked, dropped, merged, closed by hand or lost to another device (DB:81, #601).

### 10.2 Preparing a slot for a step

Before every agent step (each attempt and each triage included), action `slot` op `prepare`:
`factory-slot prepare <path> <lease> <branch> <marker json>`:

1. kill the slot's processes (10.8);
2. `git fetch origin`;
3. save leftovers: tracked changes, untracked files and, while the slot is on the branch, its
   commits that origin has under no ref, as one binary patch against the merge base of HEAD and the
   step's start (`origin/<branch>`, else `origin/<default>`), so it applies onto the start:
   `<loop dir>/leftovers/<N>-<life>-s<seq>-<ts>.patch`, pruned with the loop's other files after
   7 days (D-46);
4. `git reset --hard`, `git clean -fd`, then `git switch
   --ignore-other-worktrees -C <branch> origin/<branch>` (or `origin/<default>` when origin has no
   such branch). A stale slot or a person's worktree that still has the branch checked out no
   longer blocks the step. Checked locally on git 2.56.0: without the option the switch fails with
   "is already used by worktree", exit 128 (`totality/T-19`);
5. write the step marker `factory-step.json` into the slot's own git dir (`git rev-parse
   --git-dir`), never into the tree, so it cannot be committed: `{ v: 1, repo, issue, life, seq,
   step, role: 'writer' | 'reader', branch, gateCommands, gateTimeoutMs, loopDir }`;
6. print `PREPARED head=<sha>`, `KILLED <n>` (step 1's count), and `LEFTOVERS file=<f>` when it
   saved any.

The builder and fixer start from origin's branch head. Committed and pushed work always survives a
retry. Uncommitted work of a failed attempt, and work it committed but never pushed, survives in
its leftovers file, which the retry's prompt names (5.1). A `prepare` that fails is the attempt's
`unknown`: it is part of the attempt, keyed with it.

### 10.3 Starting the agent in its slot

- The loop spawns as today (`register.ts:351`). The prompt's first line is `factory-slot:
  <absolute slot path>`. The loop also passes `cwd`, so it keeps working once the engine honours
  that argument, which on 2.1.300 it drops (SPIKES.md).
- The companion's `agent.spawn` hook reads that line and the slot's step marker. It checks that
  they match the spawn (issue and seq; D-11 puts the issue in the agent's name), calls
  `next({ ...e, cwd: slot })`, and records `agentId -> marker` from the result. It refuses the
  spawn (`deny`) when the marker is missing or does not match, and the refused spawn is the step's
  `unknown`.
- Children the agent starts (the designer's explorer) inherit the folder, and the companion maps
  them through `parentAgentId` (`spikes/agent-folder.md`, run 8).
- Proven on Claude Code 2.1.300 for a spawn from a frameless timer, headless and interactive:
  `pwd`, relative Bash and Write paths, Read, `git` and the agent's system prompt all resolve to
  the slot. A `cd` elsewhere is reset to the slot on the next call (runs 5, 7 and 8).

### 10.4 The write guard

The companion's `tool.call` hook, for agents in its map and their children. A second plugin's
hooks fire and block for timer-spawned agents (`spikes/hooks.md`, run-guard):

- **File tools** (Edit, Write, MultiEdit, NotebookEdit): the path, resolved against the slot
  because Write's `file_path` can arrive relative, must be inside the slot for a writer. A reader
  may not write anywhere in the repository. Both may write outside the repository (for example a
  scratch file in `/tmp`). The deny reason names the slot.
- **Refused for every loop agent:**
  - in Bash, `gh pr create|edit|merge|close|reopen|review|update-branch`,
    `gh issue create|edit|close|comment`, `gh label` and `gh api` with a write method or field
    flags: the loop owns these. The companion's list (`hooks/guard.ts` `GH_WRITES`) also holds
    their aliases (`gh pr new`, `gh issue new`) and the other GitHub writes (`gh pr revert`,
    `gh repo edit`, `gh secret`, `gh variable`, `gh run rerun` and the like);
  - in Bash, `no-mistakes`, `axi` and a push to any remote but `origin` (`simplicity/F2`);
  - any call with `run_in_background: true`, `Bash` and `Agent` alike: a loop agent works in the
    foreground, a command under its 10-minute timeout (10.5), so it neither ends its turn while
    work it started runs (`failures/F13`) nor sits polling for it (drill run 4, R4-O4). The
    reason tells it to run the call in the foreground with a timeout;
  - an `Agent` call with any `isolation` (`"remote"` always runs in the background, and
    `"worktree"` makes a git worktree).
- **Bash, refused for a writer** (`failures/F7`):
  - `git push` to any ref but `origin <branch>`;
  - any force push (`-f`, `--force`, `--force-with-lease`, a `+ref`);
  - branch creation (`git switch -c|-C`, `git checkout -b|-B`, `git branch <name>`) and
    `git worktree`.
- **Bash, refused for a reader:** `git commit` and `git push`.
- **The main checkout.** callum-flow's `forbid-main-checkout-write.sh` already refuses a
  sub-agent's writes there, Bash included, and it fires for these agents
  (`plugins/callum-flow/hooks/forbid-main-checkout-write.sh:1-55`; `spikes/agent-folder.md`,
  run3-debug.log:278-286). v2 relies on it and leaves callum-flow's `hooks.json` alone.
- **Each refusal** is appended to the companion's log, and the loop logs it as an intervention
  (`guard:*`, 7.2).
- **Command lines.** The rules apply to every simple command a line runs, through separators,
  subshells, wrappers (`env`, `timeout`, `bash -c`, `eval` and the like) and command
  substitutions, those inside double quotes and unquoted here-documents included.
- **Limits.** The Bash rules match commands, not effects. A Bash write into another slot is not
  refused. The tripwire (10.7) covers the main checkout, and each slot is reset at its next
  prepare.

### 10.5 The 10-minute Bash timeout

Every agent the loop starts runs with a 10-minute Bash timeout (OB:80-82), set two independent
ways inside the plugins. No image or template change is needed (`simplicity/F11`):

- the loop's `session.start` calls `$.env.set('BASH_DEFAULT_TIMEOUT_MS', '600000')` and
  `$.env.set('BASH_MAX_TIMEOUT_MS', '600000')` (spike run A3);
- the companion's `tool.call` hook gives a loop agent's Bash call with no `timeout` the value
  `600000` (spike run A4's rewrite, moved into the companion, whose hooks reach these agents).

A foreground test run then finishes instead of being moved to the background after 120 seconds,
which is what led agents to write polling loops that matched themselves (G4:222; V E15). The
prompts keep v1's `FOREGROUND_RULE` (`prompts.ts:140`) and a v2 `COMMAND_RULE` without the
no-mistakes exception that v1's has (`prompts.ts:148`; `simplicity/F2`).

### 10.6 The stop gate

The companion's `classic.SubagentStop` hook, for a writer whose marker lists `gateCommands`
(OB:83-85):

- It runs the commands in the slot, joined with `&&`, through `$.process.run` with one total
  budget, `gateTimeoutMs` (10 minutes). The gates take about 58 s serially on the 16-CPU container
  (`spikes/timeout-and-stop-gate.md`, Q2).
- **On failure** it returns `{ block }` with the failing command, its exit code and the last 150
  lines of its output. The agent carries on with them, and is refused again while they fail. There
  is no cap. The step's own timeout (90 or 60 minutes) and the unknown path bound it
  (`simplicity/F8`).
- **When the gate cannot run** (the budget runs out, or the run fails to start), the hook lets
  the agent finish and records the gate as unknown. CI stays the authority (OB:83) and decides in
  reviewing. A gate is never passed silently (`totality/T-25`): it is appended to the companion's
  log, an intervention (`gate-unknown`, 7.2).
- **Each run** is one line of the companion's log (`<loop dir>/companion.jsonl`, 7.2) with the
  slot's HEAD, its duration and, for a fail, the command and its exit code: cause `gate-pass`,
  `gate-fail` or `gate-unknown`. Only `gate-unknown` is an intervention; the loop skips the other
  two, so the log is the audit of every run. The last result is also written to
  `<slot git dir>/factory-gate.json`, which the next run overwrites.
- **Gate commands** are repo settings: `gateCommands` in `.claude/factory-loop.json`. dev-system
  sets `["npm run lint", "npm test"]` (CLAUDE.md, "Canonical commands"). Empty means no gate. The
  plugin ships no repo-specific values (CLAUDE.md, "This repo").

### 10.7 The main checkout

Nothing in v2 runs or reads in the main checkout, so a dirty main checkout holds no issue. Two
safeguards remain:

- callum-flow's guard refuses sub-agents' writes there (10.4);
- **the tripwire.** R1 compares the `checkout` source with the checkout it last settled on: the
  newest read with nothing left untold. A change (new tracked changes or a moved HEAD) sends
  `tell(checkout)` once, with the paths and the steps that ran in that window. The notice stays
  planned on every pass until it is told, so a pass that holds it back (one wake at a time, a rate
  cap, a store-blind pass, a failed read) loses nothing. After a restart, changes not told before
  are told. No step's outcome changes: a writer's ok already needs its commits on origin, and
  failing every step that overlapped would charge other issues for one agent's mistake
  (`failures/F8`). The loop never cleans the main checkout.

### 10.8 Ending a step, and reading answers

- **An answer ends the step when it is read.** The loop reads each running agent step's answer
  file on every pass, not only at the agent's `turn.complete` (`failures/F15`). A valid answer
  ends the step at once. The one exception is a writer's `ok`, which is read when the agent's turn
  ends, so the stop gate has its say first.
- **Before an agent step treats its agent as lost,** and before it spawns, it looks for a valid
  answer already recorded for its key (`answers/<key>.a*`). One that is there is the result, as
  v1 does before marking an agent lost (`act.ts:417-422`; `totality/T-13`).
- **A writer's answer is confirmed on origin.** On a builder's or fixer's answer, the loop reads
  `git ls-remote origin refs/heads/<branch>` directly and attaches the head to the result. A failed
  read makes the result unknown, never not-ok (`totality/T-20`).
- **Stopping.** At the next seq the entry actions stop the old step: TaskStop for its agent when
  it is still listed at work (v1 SPEC 6.1, `stop-agent`), then `factory-slot kill <path>`, both best
  effort (4.5). There is no grace period and no inference from a listed status (D-71 and D-75
  are retired).
- **`factory-slot kill`** sends SIGTERM to every process whose working directory is the slot or
  inside it, and SIGKILL to survivors after 5 seconds. It prints `KILLED <n>`, as `prepare` and
  `free` do when they end a slot's processes; the slot action's outcome keeps n and its summary
  names it, so an agent that left processes behind shows in the decision log. It refuses a path
  outside the pool and a lease whose holder is not `factory-loop:`-prefixed. A process that moved
  its working directory out of the slot survives it until W2's `treehouse return`, which ends
  lingering processes. The 10-minute timeout removes the reason agents left pollers behind
  (`totality/T-24`).

### 10.9 The rail, and the fallbacks

- **The rail.** From its `session.start` the companion writes
  `<CLAUDE_CONFIG_DIR>/factory-loop/workspace/<session>.json` = `{ v, session, process, version,
  at }`, and again every minute. It is one file per session, so a second session with the
  companion never writes over the loop's. `process` is this process's id, `<pid>:<start time>`
  from `/proc/self/stat`, which the loop, a plugin of the same process, reads the same way. No
  other process has it: a child has its own, and a later process given the same pid has another
  start time. When this session's file is missing, names another session or another process, or
  is stale (its `at` more than 3 minutes old), the loop's rails hold every agent step, with the
  skip line `workspace`, and tell the owner once for each process (`tell(workspace)`, keyed by
  session and process). The process check catches a session resumed under the same id without the
  companion: the old process's file names the old process, and each such restart is told. The age check catches a companion that stopped in this process. Without the companion,
  agents would start in the main checkout, unguarded. The orchestrator-loop template's plugin list
  (`coder/push.sh:79`) gains `factory-loop-workspace`, pushed at cutover (section 15).
- **Re-probe.** U9 re-runs the spikes' frameless checks before it builds. Two points are proven
  only in nearby shapes: a long `$.process.run` inside a second plugin's `classic.SubagentStop`,
  and `$.env.set` with no hook frame open. The probe stays in the repo and is re-run on each
  Claude Code upgrade (SPIKES.md).
- **Fallbacks**, stated and not built:
  - if the companion's long gate run proves unreliable: the same gate as a classic command hook
    in the companion's `hooks/hooks.json` (`timeout` 900, the gate's own budget 600 s), keyed by
    agent id through a map file the companion writes at spawn. This shape is proven (spike runs B
    and run-plugincmd);
  - if a future engine stops applying a `cwd` set by a hook: start each agent as a separate
    `claude -p` process in its slot (spike run 0). That is a large change for the owner to decide;
  - if no hook route fires at all: the owner's fallback (OB:86-87). The loop runs the gates after
    the answer, resumes the agent with the failures, and fails a step that leaves the main
    checkout dirty.

### 10.10 Prompts nobody answers

A loop agent runs unattended, so a call Claude Code would put to a person waits for ever. The
companion's `tool.check` hook calls `next(e)` once. When the call is from an agent in its map (a
loop agent or its child) and the result is `ask`, it returns `{ decision: 'deny', reason }`. Any
other result, and any caller not in the map (no `agentId`, an unmapped id: the owner's own session),
gets `next(e)`'s result unchanged. The engine ignores a plugin's allow but always honours a deny.

- **The reason** starts `factory-loop-workspace:`, says the call would wait on a person nobody
  watches, quotes Claude Code's own `reason`, `rule` or `decider` when there is one, names the safe
  rewrite for a Bash `rm` of a glob under a variable (`"${VAR:?}"/*` or the literal path), and ends
  by telling the agent to find another way or, failing that, to end its step saying what it needed.
- **Each deny** writes one `prompt_denied` event (`callum-flow-event prompt_denied --issue N --branch B
  [--pr P] --note <tokens>`) and one line of `companion.jsonl`, cause `prompt-denied`, which is an
  intervention (7.2). Note tokens are `key=value` encoded as `events.ts` `enc`, `none` when unknown:
  `life`, `seq`, `step`, `attempt`, `agent`, `agent_type`, `tool`, `input` (a Bash command, else the
  JSON input, clipped to 2000 characters), `why`, `slot`, `session` and `transcript` (the agent's
  own: `<session transcript without .jsonl>/subagents/agent-<id>.jsonl`, learned from
  `classic.SubagentStart`). Writing either never throws out of the hook and never turns the deny back
  into an ask: an image whose `callum-flow-event` does not know the state still gets the deny and the
  log line. A hook that fails for a mapped agent after `next` returned `ask` still denies.
- **`classic.Notification`** with `notification_type` `permission_prompt` or
  `worker_permission_prompt` and an `agent_id` in the map writes one `prompt_waiting` event with the
  same columns and tokens (`input` is the message). Without an `agent_id`, or with an unmapped one,
  it writes nothing. It always returns `next(e)`. There is no `prompt_answered`: the engine shows a
  mapped agent's answer to its prompt through no hook the companion could tie to the prompt.
- **The map** keeps what the note needs: `agentType` (per agent, children included), `attempt` (the
  name's `a<k>`), `pr` (the step marker's, `null` when the issue has none or an older loop wrote the
  marker) and `transcript`. A record kept before this change logs `none` for them.
- **The rule.** The v2 command rule gains: "Never `rm` a glob under an unguarded variable: use
  `"${VAR:?}"/*` or a literal path.", in every v2 prompt and agent definition.

## 11. Releases and parking

- **Merges never wait for releases.** No rule holds a green, reviewed PR for a release, a bump, a
  Run it or a template change (OB:89-91). v1's sequencing call (M5) and run-it hold (D-52) are
  deleted (13).
- **Releases** are cut by the release task (O3, kept). When the Next milestone has no open item and
  at least one closed, `task(release)` wakes the judge, which cuts the release with its standing
  authority (OB:89-90; PR #634, `27a13ce`). "A Run it change ships alone" belongs to that task: it
  chooses the commit to tag, then does the Run its of the milestone's run-it issues, which v1 did
  one `task(run-it)` at a time (M7).
- **The release task never waits on the owner inside its wake.** A Run it that needs the owner
  (a workspace restart still needs asking) becomes an owner item, a comment and a tell, and the
  task ends. A wake held for the owner would hold every tell behind it (D-26, D-44;
  `failures/F17`).
- **Parking frees capacity.** A parked issue leaves the in-flight count at once, and W2 frees its
  slot (OB:92). Its claim stays live (H1 renews it), so no other device takes it.
- **One way to resume** (OB:92-93): remove `factory:parked`, or `/factory resume N ["note"]` (a
  list of numbers is allowed). Both are the `unpark` event (P1). The note is the op's note or,
  for a label removal, the trusted comments posted after the loop's park comment (read with
  `callum-flow-issue-read --comments`). So an owner who answers on GitHub and removes the label is
  heard (DB:93, #591). The daily reminder says that a comment alone does not resume.
- **Resume** goes through queued, because a slot is needed again, and resets the attempt, triage
  and fix budgets. It resumes the state the issue parked from, with the note for that state's
  step; a park at the fix cap resumes fixing (T10).
- **Drop, and bringing an issue back.** `/factory drop N` closes the current life (E1, `abandoned`
  with note `dropped`) and removes its labels. The issue stays open on GitHub (section 15).
  To bring it back, add `ready`: S1 claims it as a new life, and the old drop does not apply to it
  (4.1). No edit of `control.json` is needed (`failures/F10`). A drop also keeps R1 from putting
  a ghost of that claim back in the queue (6.4).
- **Rejected, and bringing an issue back.** An issue R1 released at its `maxLives`-th life carries
  `factory:rejected`, a comment and an owner tell that list why each life ended (6.4). It waits on
  the owner but holds no capacity: it is out of the factory, with no record and no slot. To bring
  it back, remove `factory:rejected` and add `ready`: S1 claims it as life 1, and the claim is
  logged as the owner's intervention (`unreject`, 7.2). S1 never claims it while the label is
  there, so adding `ready` alone does nothing.

## 12. The failures, by generic path

"Avoided": the mechanism no longer exists. "Generic": a table row or the unknown path handles it,
with no rule of its own. "Environment": a one-time fix outside the loop's rules.

| # | Failure (evidence) | v2 | How |
|---|---|---|---|
| 1 | Agents that had answered but were still listed at work held the main-checkout update and branch writes for up to 2 h; processes killed by hand at 18:30:21 and 19:16:52 (DB:77; G1:49-50) | avoided, and generic | An answer ends the step when it is read, every pass (10.8); the next seq stops the agent and kills the slot's processes. Nothing waits on another issue's agent: no step reads the main checkout, and each branch has one writer by structure and by the write guard. A step that never answers meets its timeout. Bash calls end at 10 minutes (10.5) |
| 2 | The guard failed `head` after the loop's own update-behind, then judge, fixer and `-vN` PRs: 8 supersedes (DB:78; V E4) | avoided | No update of non-head PRs, no head or worktree clause, no new branches (3.5, 9.4), and agents cannot make branches (10.4) |
| 3 | A resumed escalation with an owner note reran the old head (#596; DB:79) | generic | One unpark path: the parked state's step runs with the note (P1) |
| 4 | A run killed by a workspace restart was never recovered (#600; DB:80) | avoided, and generic | No daemon runs. A step cut by a restart runs again free, once (U1), after the loop looks for its recorded answer (10.8). Review is keyed by patch and round, CI by head |
| 5 | Dropping an issue never returned its slot (#601; DB:81) | generic | W2 frees every loop slot whose record is not in a slot state (10.1) |
| 6 | no-mistakes' fix agents in untrusted repo copies (#613; DB:82) | avoided | no-mistakes is out of the loop's path, and the write guard refuses it (10.4); every agent runs in a loop slot |
| 7 | no-mistakes 1.84's PR body budget, body compare and self-abort; the `--closes` and `--ignore` adaptations (DB:83-87) | avoided | The loop writes the PR body through `neutral()` and its linkage (8.1); there are no gate responses |
| 8 | An inconclusive test gate was answered "fix" twice, then quiet for 80 minutes (#620; DB:88) | avoided, and generic | No no-mistakes test gate; CI is the authority. The stop gate refuses while the gates fail, within the step's timeout; a gate that cannot run lets CI decide (10.6). A flaky check gets one re-run (8.5) |
| 9 | Implementers wrote to the main checkout (#624; DB:89, DB:160) | generic | Agents start in their slot, the companion confines file writes to it, and callum-flow's guard refuses writes to the main checkout (10.3, 10.4). The tripwire tells the owner of anything that gets past them (10.7). No other issue waits on the main checkout |
| 10 | `maxInFlightIssues` in the workspace file ignored; restart-self with no Coder token (#590); claims swept after 2 h offline (#589); an owner answer on GitHub released no hold (#591); the judge could not finish a release (#592) (DB:90-93) | mixed | Settings: the workspace file may set every key, and both files are read every pass (section 15). Token: environment; R2 tells the owner once when a restart fails, as v1's H4 did. A lapsed claim is claimed again onto the same record (4.1). An owner answer on GitHub plus the label removal resumes with that answer as the note (11). Release: the judge's standing authority (PR #634); releases are out of the merge path |
| 11 | Usage tier stop-all for 42 and 197 minutes (DB:94; G1:54, :59) | kept, and generic | The foundation's tiers. A step killed by the window is a free re-run (U1), held until the tier allows it, so it costs the issue nothing. Merges are class `free` and go on in stop-all |
| 12 | Strict protection put every PR behind on every merge: 27 update-behinds for 4 merges (DB:95; V E4) | avoided | Only the head is updated: once per merge, plus once per outside merge during its CI wait (9.2) |
| E9 | #613's implementer stopped with no commit and no rule moved it for 549 minutes; #591's run died on a 429 and was answered as live (V:407-417) | generic | No commit is `not-ok` (T6), so triage runs at once. Every record has a running step, a planned action or a named wait (property 3). A step killed by a 429 is a free re-run after the window (U1) |
| E10 | 282 passes from 02:41 at cap 7 of 7 with 4 queued and nothing moving (V:420-426) | avoided | The seven were two merge holds (no such thing in v2), an owner decision and a limbo (both parked, freeing capacity) and three no-mistakes refusals (no no-mistakes). Parked issues do not count, so the queued issues would have started (C3:244). No wait on the owner holds capacity: there is no main-red hold and no reconcile hold |
| E20 | A gap in release authority held two green PRs for 583 issue-minutes (V:513-519) | avoided | Merges never wait for releases, and the judge has standing release authority (11) |
| E21 | The usage window cost 1,119 issue-minutes (V:521-526) | kept, and generic | Tiers unchanged. Steps killed by the window re-run free when it resets (U1). The step-unknown breaker stops an outage from spending every issue's budget (5.3). With no gate adjudicators and no churn re-runs the loop starts fewer agents, though the reviewer draws much of what no-mistakes' review did (C4 section 3, an estimate) |

C3's other overnight failures (C3:196-208) are generic too:

- A designer that ended its turn with an async explorer running gave no answer. That is the U
  rows, and the guard now refuses background agents (10.4).
- `abandon` removing `ready` gives way to one owner interface: drop, then `ready` to bring it back
  (11).
- A misleading update failure is unknown, then triage, never a new branch.
- A fixer sent to an issue closed by a hand merge cannot happen, because `pr-merged` closes the
  record (E3).

## 13. What is deleted

At the delete wave (workflow 4), after cutover. Until then everything here stays as it is
(OB:107-109).

### 13.1 Rule ids: 37 of v1's 46 go, 9 stay

| v1 id | Fate | Why |
|---|---|---|
| G1 | kept | off and kill switch |
| G2 | kept | blind pass |
| G3 | kept | usage tier |
| G4 | kept | control filters; the update-drain clause goes with H4 |
| G5 | deleted | the main-checkout hold: no agent starts in or reads the main checkout (10.3, 10.7) |
| H1 | kept | heartbeat; it renews the claim of every record that is not closed, and re-claims a lapsed one |
| H2 | kept | sweep |
| H3 | deleted | slot return by reflog inference: W2 frees by the loop's own lease holder |
| H4 | deleted | restart after a drain: R2, with no drain |
| H5 | deleted | main-checkout update and reader drain: nothing reads the main checkout |
| P1 | deleted | review cap per no-mistakes run: the fix cap (T10) |
| P2 | deleted | gate adjudicator: no gates to drive |
| P2a | deleted | env-retry on resume |
| P2b | deleted | resume fixer: one unpark path (P1) |
| P3 | deleted | respond |
| P3a | deleted | respond retry and the stuck-respond task |
| P4 | deleted | re-drive of unknown runs |
| P4a | deleted | waiting for the loop's own fixer or re-drive |
| P5 | deleted | the cancelled-run judge: a cancelled check gets one re-run (8.5) |
| P6 | deleted | no-CI-workflow hold: the GitHub wait bound, then the unknown path (4.4) |
| P6a | deleted | PR close and reopen to start CI |
| P6b | deleted | CI trigger hold |
| M1 | deleted | guard freshness: Q2 runs the guard inside the merge |
| M2 | deleted | guard FAIL routing, fast-forward, update-behind and linkage repair: Q1, Q2, the guard's classes and the table |
| M2a | deleted | the re-gate fixer after a failed update-behind |
| M2b | deleted | update-behind retries |
| M3 | deleted | the test-weakening adjudicator: the reviewer judges the detector (8.3) |
| M4 | deleted | the merge adjudicator: the review step (8.3) |
| M5 | deleted | merge with sequencing: Q2, with no sequencing (11) |
| M5a | deleted | merge hold: no holds; the issue parks instead |
| M5b | deleted | the review fixer: T9 |
| M6 | deleted | a refused merge: the guard's classes and the unknown path |
| M7 | deleted | rollout follow-ups: closed's entry actions (4.5) |
| M8 | deleted | closing superseded PRs: no supersedes |
| D1 | deleted | claim: S1 |
| D2 | deleted | designer spawn: S2 |
| D3 | deleted | designer result routing: T2 to T4 |
| D4 | deleted | delegation: S2 for building |
| D4b | deleted | re-delegation: U2 |
| D5 | deleted | the ungated-handoff judge: nothing is gated |
| D6 | deleted | drop: S6 |
| A1 | deleted | agent timeout and stop: the step timeouts (4.4) |
| A2 | deleted | stopping agents past their answer or of ended issues: every new seq stops the old step (4.5) |
| O1 | kept | title |
| O2 | kept | one wake |
| O3 | kept | the release task, now with the Run its (11) |

### 13.2 Mechanisms

| Mechanism | v1 code | Why it goes |
|---|---|---|
| Updating every open PR when main moves, and the rebased-head record | `plan.ts:1464-1495` (`prHead`, `updateBehind`); the update-behind executor in `act-merge.ts`; `rebased_behind` events | only the head is updated (9) |
| The guard's run-head and worktree checks, and the fast-forward that serves them | `plan.ts:1220-1272` (`fastForward`, `worktreeLag`, `lagForward`); `act-merge.ts` `FF_SCRIPT` | `--patch` replaces them (9.4) |
| `-vN` branches, M8 and regate | `plan.ts:1414-1463` (`supersededPrs`, `replacement`); `act-cli.ts` `pr-close`; the loop's use of `callum-flow-regate` | one branch per issue (3.5) |
| Driving no-mistakes one gate at a time | `plan.ts:725-1087`; respond and env-retry in `act-merge.ts`; `contract.mjs:213-235` (`--ignore`); `replies.ts`' handoff parsing; linkage repair (`fix-linkage`); the `runs` source (`pipeline-watch.sh --once`) | no-mistakes is out of the path (OB decision 5) |
| Inferring agents' and slots' state | `plan.ts:363-380` (`answeredLive`, `heldBy`); `act.ts:357-394` (repair grace); `act-agents.ts:326-337` (`stillAtWork`, `interim`); `observe.ts:418-472` (reflogs); `plan.ts:625-724` (drain, checkout readers) | the loop owns agents and slots (10) |
| Release sequencing in the merge path, and per-round resume keys | `plan.ts:1591-1815` (`rounds`, `holdEnd`, `mergeRound`, `runItWaiting`, `mergeOrSequence`); the 11 key families with `:r<n>` | merges never wait; one resume path (11) |
| Five judge kinds and four task kinds | `wake.ts:133-143`; the judge skill's JUDGE and TASK sections | the triage agent; `task release` stays |
| Exact-key tests | `plugins/factory-loop/tests/plan.test.ts`: 324 exact-key and 56 skip-string assertions (G2 section 5) | property tests over the table (17.1) |

### 13.3 Files

Deleted whole:

| File | Lines | Why |
|---|---|---|
| `plugins/factory-loop/hooks/plan.ts` | 2,541 | v1's rules; its generic part lives on in `foundation.ts` |
| `plugins/factory-loop/hooks/act-merge.ts` | 722 | respond, env-retry, update-behind, fast-forward, update-checkout, fix-linkage; the `rollout` executor v2 reuses moves to `hooks/v2/act-state.ts` (`close-issue`, `release-parent` and `milestone-later` stay in `act-cli.ts:21-82`) |
| `plugins/factory-loop/hooks/replies.ts` | 366 | gate adjudication, handoff parsing and the v1 designer `RESULT` parser |
| `plugins/factory-loop/agents/adjudicator.md`, `agents/designer.md` | 97, 81 | v1's definitions; `designer-v2.md` is renamed `designer.md` |
| `plugins/factory-loop/tests/plan.test.ts` | 2,736 | exact keys; its property block (`:62-98`) moves to `tests/v2-plan.test.ts` |
| `plugins/factory-loop/tests/act-merge.test.ts` | 1,030 | its merge and rollout cases (`:591-699`) move to `tests/v2-queue.test.ts` |
| `plugins/factory-loop/tests/replies.test.ts` | 549 | v1 contracts |
| `tests/factory-loop-respond-launch.test.js` | 110 | respond |
| `tests/factory-loop-fast-forward.test.js` | 213 | fast-forward |
| `tests/factory-loop-update-checkout.test.js` | 180 | H5 |
| `pipeline-watch.sh`'s `--once` mode (`features/src/callum-tools/`) and `features/test/callum-tools/pipeline-watch-once.test.sh` | part of 738 | only the loop used it (D-20, D-45); the streaming modes stay for people |
| `plugins/factory-loop/bin/factory-reconcile` | new in wave 1 | the one-shot migration, once both loops have cut over (6.3) |
| `docs/factory-loop/PLAN.md`, `STATUS.md`, `INVENTORY.md`, `REPLAY-REPORT.md`, `SHADOW-REPORT.md`, `TESTBED-RUN2.md`, `TESTBED-RUN3.md`, `TESTBED-RUN5.md`, `TESTBED-RUN6.md`, `replay/` | - | v1's build records; git keeps them, and the new SPEC names the last commit that has them |

Cut in part, the v1 halves FM section 1 names:

- **Hook files:**
  - `register.ts`: drain restart, the v1 plan call, the hidden-agent offer list;
  - `act.ts`: `GITHUB_KINDS`, `reconcilable`'s grace, `updateDone`;
  - `ledger.ts`: `foldRecheck`, the A1 stop case, the env-retry and update-behind retries (FM C3);
  - `observe.ts`: `runs`, reflogs, the `task:run-it:` read;
  - `parse.ts`: `parsePipelineLine`, `parsePipelineOnce`, `parseReflog`;
  - `state.ts`: `seenRuns`, `runsFromWatch`;
  - `derive.ts`: `deriveLedger`, `runsFromEvents`, the pipeline states in `EVENTS_SQL`;
  - `act-cli.ts`: `pr-close`, `pr-reopen`;
  - `act-agents.ts`: v1 purposes, the no-mistakes half of `delegate`, `verdict` and `superseded`
    events;
  - `wake.ts`: the judge and task kinds but release, the respond-stuck details;
  - `prompts.ts`: v1 templates, `CHECKOUT_RULE`, v1's `COMMAND_RULE`;
  - `contract.mjs`: `ACTIONS_FOR`, `declinedFindings`, the handoff shapes;
  - `agent-tools.ts`: v1 schemas;
  - `types.ts` and `config.ts`: v1 kinds, purposes and keys;
  - `trace.ts`: `sourceOf` for pipeline-watch and reflogs;
  - `control.ts`: `resume <run id>`.
- **Skill:** `skills/judge/SKILL.md`, JUDGE and TASK but release.
- **Tests that lose the matching cases:** `ledger.test.ts`, `observe.test.ts`, `act-cli.test.ts`,
  `act-agents.test.ts`, `prompts.test.ts`, `wake.test.ts`, `act.test.ts` (the claim-to-merge path
  rewritten for v2, D-60), `fixtures.ts`, the `driver.test.ts` fixtures, `agent-tools.test.ts`,
  `answer-cases.mjs`, `tests/factory-loop-judge-skill.test.js` and
  `tests/factory-loop-agents.test.js`.

Image scripts stay: `callum-flow-regate`, `callum-flow-fix-linkage`, the guard's `--update-behind`
and the streaming watchers serve people and the old orchestrator (C4:209). The loop stops calling
them.

### 13.4 DECISIONS entries

All 76. Kept and changed entries become unnumbered entries in the rewritten DECISIONS.md
(OB:111-113).

| Entry | Fate | Why |
|---|---|---|
| D-01 Work documents in `docs/factory-loop/` | kept | |
| D-02 Out of the marketplace until cutover | retired | done: listed in v0.37.0 (`ef2a576`) |
| D-03 Plan does not know the mode | kept | |
| D-04 Wakes answered with a text block | kept | TELL and the release task |
| D-05 The adjudicator reviews each merge; the model sequences releases | changed | the review step reviews the whole diff; no sequencing (8, 11) |
| D-06 Usage from `usage-check.sh` and the session | kept | |
| D-07 Slow means one claim per pass, a 10-minute gap, none in a pass with merge work | changed | the merge clause goes: merges are `free` |
| D-08 Stop new also holds design and build | kept | |
| D-09 The `loop` event state | kept | |
| D-10 Observe sends side-effect events to a sink | kept | |
| D-11 The issue in the agent's name and description | kept | |
| D-12 Every conflict gets a fixer | kept | T9 |
| D-13 Re-drives stay model tasks | retired | triage |
| D-14 The designer owns its `RESULT` line | changed | the designer answers through the script; the loop posts the brief and creates sub-issues (8.7) |
| D-15 Restart after a drain | changed | no drain; R2 waits only for queue actions and the release task |
| D-16 Owner directives are control state | kept | |
| D-17 Trackers never claimed; skip labels | kept | |
| D-18 Holds are derived, not stored | retired | parked is an explicit state |
| D-19 `blocked_by` from the dependency summary | kept | |
| D-20 Pipeline classification in `pipeline-watch.sh --once` | retired | no runs |
| D-21 Shadow and replay read pipeline states from events | retired | no runs |
| D-22 Each agent type has its memory file | changed | builder, fixer, reviewer, triage and designer-v2 types |
| D-23 The title shows counts | changed | counted by v2 states, plus `parked <n>` |
| D-24 Rate caps | kept | the per-issue cap counts agent steps by step kind |
| D-25 Owner notices wake the model | kept | |
| D-26 One wake at a time | kept | |
| D-27 Stuck rules in the title only | kept | |
| D-28 Act needs the orchestrator role and no old watcher | kept | |
| D-29 Rollout follow-ups for every merge, hand merges too | changed | without `task(run-it)`, which the release task absorbs (11) |
| D-30 The flaky heartbeat test | retired | done |
| D-31 The judge skill lives in the plugin | kept | |
| D-32 The shadow cannot judge claims | retired | superseded on 2026-10-12 |
| D-33 Settings and directives are plain JSON files | kept | |
| D-34 A shadow does not heartbeat on its own restarts | kept | |
| D-35 "Only these issues" | kept | |
| D-36 A claim counts as its lease's renewal | kept | |
| D-37 A stuck respond becomes a task | retired | no responds |
| D-38 The owner clears exhausted actions | changed | `retry` clears exhausted effects, which hold a record as `stalled` (4.5); steps go through triage and parking |
| D-39 A ping storm falls back to the timer | kept | |
| D-40 The ledger in memory, one writer | kept | records follow the same rule |
| D-41 Act reads through the `--once` watchers and a week of events | changed | the queue's `--once` stays; records rebuild from `transition` events |
| D-42 A testbed runs a checkout's own tools | kept | |
| D-43 The rails fail safe | kept | |
| D-44 Notices from outside plan wait for the open wake | kept | |
| D-45 The `--once` modes and the loop event, as built | changed | the pipeline half goes |
| D-46 The loop's files stay bounded | changed | `respond/` goes; `leftovers/` joins the daily prune |
| D-47 Retries and their counts | changed | a step key is one attempt; the table retries steps (5.1) |
| D-48 Executors keep their writes narrow | changed | label, comment, PR, split, update-branch, run re-run and slot writes join the allowlist, one argv each |
| D-49 A respond is done once launched | retired | no responds |
| D-50 Merges follow the loop's own bookkeeping | retired | no update-behind; a failed rollout read retries under its own key |
| D-51 A resume starts a fresh review round | retired | one resume path |
| D-52 A held Run it holds the next run-it merge | retired | merges never wait for releases |
| D-53 The update drain ends at the next load | retired | no drain |
| D-54 The agent list decides what still runs | changed | only a successful read marks agents lost or failed; nothing more is inferred |
| D-55 Wakes never spend an attempt the engine dropped | kept | |
| D-56 Prompts rewrite closing keywords; handoffs end in a `RESULT` line | changed | the rewrite stays; the handoff contracts are v2's |
| D-57 Plan details settled in code | changed | the claim-counting and tracker-depth details stay; the merge details go |
| D-58 Owner controls as built | changed | `resume`, `drop` and `note` change meaning; `planner` is added |
| D-59 The judge skill's own choices | changed | TELL format stays; JUDGE and TASK go except release |
| D-60 The claim-to-merge test beside the engine host | changed | it walks v2's path |
| D-61 Only an interactive session runs the loop | kept | |
| D-62 Prose before an adjudicator's contract is skipped | retired | v2 contracts use the answer script only |
| D-63 One writer per branch | changed | structural: one step per record, and the write guard |
| D-64 A resumed environment escalation reruns the head once | retired | no gates |
| D-65 A guard failure is judged once; the guard expires | retired | no guard judge |
| D-66 The loop fast-forwards lagging worktrees | retired | no head clause |
| D-67 An agent's own `running` is no proof it works | retired | no interim-answer inference: an answer ends the step |
| D-68 Validated answers and one repair message | kept | |
| D-69 Trace mode | kept | |
| D-70 The loop owns copies of the adjudicator and designer | changed | loop-owned designer-v2, builder, fixer, reviewer and triage definitions, and a companion plugin |
| D-71 Supervision and repair grace after an answer | retired | an answer ends the step |
| D-72 An issue closed on GitHub is finished | changed | it is the `issue-closed` event; the read order stays |
| D-73 Agents are asked for text until the tools work | retired | superseded by D-74 |
| D-74 Agents answer through a checked script | kept | |
| D-75 An agent at work past its answer is stopped after a grace | retired | stopped at once at the next seq (10.8) |
| D-76 A resumed escalation sends a fixer unless all ENV | retired | no escalations to resume |

Totals: 32 kept, 22 changed, 22 retired.

## 14. Rule ids, and the count

### 14.1 Rule ids

21, the verdict's estimate (V:168; OB:100-102).

| Id | Name | When | Then |
|---|---|---|---|
| G1 | off | mode off, or the kill switch exists | the driver does nothing (foundation) |
| G2 | blind | the `factory` source fails | title only; `tell(blind)` after `blindNoticeAfterMs` (foundation) |
| G3 | tier | always | the tier from usage (foundation) |
| G4 | controls | always | the admission filters: pause, no new work, skip, priority, only, serial, rate caps and the breakers (5.3); a held record's skip line names the filter (foundation) |
| H1 | heartbeat | a record not closed, and a lease due; or a record's claim lapsed | `callum-flow-claim --heartbeat <N...>`; a lapsed claim is claimed again onto the same record (4.1) |
| H2 | sweep | every `sweepEveryMs`, and once a close's entry actions are done and the last of them ended after the last sweep began | `callum-flow-sweep`, which ends a closed record's claim (3.6) |
| R1 | reconcile | every pass | a live claim of this device with no record is released (6.2): back to the queue, unless the owner dropped it (it leaves) or it was its `maxLives`-th life (rejected, 6.4); the main-checkout tripwire (10.7) |
| R2 | restart | `updateDue` is set, no `queue-update`, `queue-merge` or release task runs, and the pass admitted no other action | `restart-self`, last in the pass; a failed restart is told once and not retried until the update is set again, as v1's H4 did. Cut agent steps re-run free (U1) |
| S1 | claim | a queue issue passes the claim filters (v1 D1's: open, trusted, `ready`, no skip label, not blocked, not a tracker, not skipped or paused, `only` and `priority` order; and no `factory:rejected`, 3.4), has no non-closed record, queued plus in-flight records are fewer than K, the tier allows `start`, and Slow's gap holds; or the life's claim is done and no record exists | `claim` (which also lists open PRs for adoption, 3.5); then row S0 |
| S2 | step | a record in designing, building, reviewing or fixing, or with a triage due, whose step is not running, whose entry actions are done and which holds its slot; or a failed check on a head in reviewing or at the queue's head | `slot` op `prepare`, then `agent-step`; in reviewing `pr` ensure first; `ci-rerun` for a failed check (8.5) |
| S3 | transition | a step result, or an owner or GitHub event, for a record | the table row: `transition`, then the entry actions |
| S4 | unknown | an unknown result, a running step's timeout, or a GitHub wait past its bound | U1 to U4 |
| S5 | triage | U3 or T6 | the triage step; its answer through X1 to X5 |
| S6 | owner and GitHub | drop, unpark, issue-closed, pr-merged, pr-closed, claim-lost, a waiting state's period | E1 to E7, P1 |
| Q1 | update | the merge queue's head is behind | `queue-update` keyed by main's head |
| Q2 | merge | the head is clean, green and approved | `queue-merge` keyed by its head |
| W1 | lease | a queued record with capacity, or a record in a slot state with no lease | `slot` op `lease` |
| W2 | free | a loop slot whose record holds none | `slot` op `free` |
| O1 | title | always, last | `title` |
| O2 | one wake | wakes are planned | at most one, owner items first |
| O3 | release | the Next milestone has no open item and one closed | `task(release)` |

### 14.2 Like for like against C3's estimates

The id count alone no longer measures the layer: conditions now live in the table's rows
(`simplicity/F10`). So this is the full count, against C3's sizing (C3:145-157). Counted on this
revision.

| Measure | v1 (G2 section 1) | C3's estimate | Draft | Now | The difference |
|---|---|---|---|---|---|
| Rule ids | 46 | about 21 | 21 | 21 | none |
| Table rows | inside rule code | the table as one mechanism | 47, plus 3 side events | 33, plus 2 side checks (re-claim, push intervention) | rows are where conditions live; counted from here on |
| Action kinds | 29 | about 15 | 23 | 23: 11 new, 12 reused (appendix B) | C3's list has no events, no CI re-run and no split. v2 logs its own state events (OB decision 3), re-runs flaky checks, and owns briefs and sub-issues so retries cannot repeat them |
| Key families | about 62 | about 12 | 17 | 13 new, plus the foundation's 5 (appendix C) | the extra families are the CI re-run, the split children and the intervention key |
| Guard checks | 10 failure classes | 6 | 7 with `--patch` | 7 with `--patch` (9.4) | rollout and linkage check the loop's own Closes or Refs line, which the owner's rule needs (OB:71) |
| Notice kinds of the new layer | about 24 in all | about 5: parked, breaker, blind, untrusted PR, main red | 9 | 7: parked, breaker, stalled, waiting, checkout, workspace, rejected | main red and untrusted PR are gone (no hold; a policy park asks the question). stalled makes an exhausted effect visible; waiting gives waiting states their timeout (OB:44); checkout and workspace are the owner's backstop and the companion's rail; rejected tells the owner the lives cap was reached (6.4) |
| Sources | 10 | 6, counted differently, and fewer than 10 | about 15 | 10 (2.4) | `runs` out, `prs` in. The rest are the foundation's, and C3's 6 folds several of them together |
| Intervention causes | 0 | - | 12 detected touch kinds | 12 person and 17 loop cause families (7.2) | the owner widened the measure to every unplanned step-in, by a person or the loop (section 15). Each cause is an exact fact the loop already holds, derived in one module; none adds a rule id, a row or a source |
| New settings | - | - | 12 | 12 (appendix A) | `maxLives`, the owner's cap on lives (6.4) |

Text, by `wc -w`: about 28,500 words in all, against the draft's 21,400 and v1's whole spec at its
build, 14,003 (`b5f40da`; `simplicity/F10`). The rules themselves, sections 3 to 11, are about
14,800 words; sections 13 to 15 (what is deleted, this count and the decisions) are about 6,600.
The growth is citations and the reasons for each change, not rules: the row, rule, kind, family,
notice and source counts above all went down or stayed level. The owner's decisions added about
2,800 words, mostly the intervention causes (7.2), the claim tools (3.6) and the decisions
themselves; they added no rule id, row, action kind or source.

## 15. Decisions

Unnumbered, so parallel work cannot collide (OB:111-113). Each records a choice this spec makes
that the owner brief does not. BUILD-NOTES-W1.md gives the critic finding behind each change.

The first entries are the owner's answers of 2026-10-15 to the ten questions workflow 1 asked,
and the owner's two structural decisions. They are settled.

### A drop does not close the GitHub issue (owner)

- **Decision:** a drop closes the record and removes the labels; the issue stays open, and
  re-adding `ready` brings it back (4.1, 11).
- **Why:** the issue is the owner's; a drop is the factory stepping away.

### The reconcile migration runs now (owner)

- **Decision:** `factory-reconcile` is built in wave 1 (U3). Its report goes to the owner, and the
  releases the owner approves run while both live loops stay in observe mode (6.3).
- **Why:** the ghosts are a big gap now (OB:48), and the tool needs nothing from waves 2 and 3.

### The migration's ghosts leave the factory (owner)

- **Decision:** every issue the one-shot migration releases leaves the factory, whatever its
  labels, and the report names each open PR, so re-adding `ready` brings one back with its PR
  adopted (3.5, 6.3). Nothing is requeued (owner, 2026-10-15, superseding "still labelled
  `ready` goes back to the queue").
- **Why:** the owner's first rule never requeued anything (claiming removes `ready`), and for
  what v1 left behind the owner chooses what comes back.

### A release puts the issue back in the queue (owner, 2026-10-15)

- **Decision:** R1's release re-adds `ready` (`reclaimed`), unless the owner dropped the issue or
  the issue is closed, when it leaves; and unless the lives cap is reached (below). The seven
  state labels go and `ready` comes back in one call (`label` op `requeue`), the one place the
  loop adds `ready` but a split's ready child (6.4, appendix B).
- **Alternatives:** "still labelled `ready` goes back to the queue, otherwise it leaves" (OB:51).
- **Why:** that rule never fired, because claiming removes `ready`; a ghost of v2's own is a loop
  bug, not the owner's judgement that the issue is unwanted.

### Three lives, then `factory:rejected` (owner, 2026-10-15)

- **Decision:** each claim of an issue is one life, and the record counts lives (3.2). When an
  issue's `maxLives`-th life (default 3) ends in a release, the release does not re-add `ready`:
  the issue gets `factory:rejected`, its factory labels go, and the loop posts one comment and
  one owner tell listing why each life ended, and logs it as an intervention (`rejected`). The
  owner removing `factory:rejected` and adding `ready` brings it back as life 1, logged as a
  person intervention (`unreject`). `factory:rejected` is a label, not a state: the issue is out
  of the factory, and S1 never claims it (3.4, 6.4).
- **Alternatives:** no cap (a bug that loses records would claim and release one issue forever);
  park the issue (a parked record holds a claim and a slot on resume, and a ghost has no record).
- **Why:** requeueing by default needs a bound, and the owner decides after three tries.

### The migration lists ghosts no device holds (owner, 2026-10-15)

- **Decision:** `factory-reconcile` also lists the issues the factory-state view shows as live
  with no live claim and no `ready` label (no holder at all, or queued after a claim ended or
  lapsed), and proposes that they leave (6.3). A live issue named in `--act` is released all the
  same.
- **Why:** #286, #289, #290, #468 and #469 showed as queued for days with no holder, and #590,
  #54 and #57 as queued after their claims lapsed, with nothing that would ever end them; the
  owner wants the view to start clean. #467's run looked live only because a monitor touched it,
  so the owner names it.

### A red main does not hold the merge queue (owner)

- **Decision:** no hold. A failed check on the head gets one re-run, then a fixer, and the queue
  moves on (9.5).
- **Why:** the owner's rule (OB:62-64). With "up to date" on, the head's own CI carries main's
  state; a hold would make the queue wait on a person while holding K slots.

### Interventions, by a person or by the loop (owner)

- **Decision:** the measure is every unplanned step-in, not only a person's touch (7.2). An
  `intervention` event names who (`person` or `loop`), a cause code, a one-line reason and the
  issue when there is one. An issue is untouched only when no intervention of either kind names
  it. Issues that change the loop itself are no longer left out of the cutover's ten (17.5).
- **Alternatives:** count only what a person did (the recommendation workflow 1 made).
- **Why:** the owner's words: "I would like it to include any point where the orchestrator had to
  unexpectedly step in with judgement. For example, something is not merging correctly, or an
  agent does something strange or crashes. Otherwise these signals are lost." Every cause is an
  exact fact the loop holds, so the happy path logs none and the bar stays fair.

### The companion plugin is enabled through the Coder template (owner)

- **Decision:** `factory-loop-workspace` joins the orchestrator-loop template's plugin list
  (`coder/push.sh:79`), pushed at cutover. The operator or the owner may push it (10.9, 17.5).
- **Why:** one place, and the rail holds agent steps and tells the owner if it is missing.

### Capacity is 2 at cutover, then 3 (owner)

- **Decision:** K = 2 for the first 5 claims, then 3; v2's `maxInFlightIssues` default is 3 (v1's
  is 5, `config.ts:30`).
- **Why:** C3's model meets the baseline of 12 to 22 merges a day from K = 2 (C3:299-303).

### The release task stays in the loop (owner)

- **Decision:** O3 is kept; `task(run-it)` goes into it, and it never waits on the owner inside its
  wake (11).
- **Why:** the judge has standing release authority (OB:89), and a merge never waits on it.

### `fixCap` 3 and `maxTriages` 2 per life (owner)

- **Decision:** both, as settings (appendix A).
- **Why:** 3 is today's review cap (`config.ts:32`) and 2 is C3's.

### `In development` is dropped now (owner)

- **Decision:** v2 neither writes nor reads `In development`. The claim, heartbeat, sweep and
  factory-state tools use the claim comments, the claim events and the `factory:*` labels instead
  (3.6, U4). The migration removes `In development` from the issues it touches (6.3, U3).
- **Alternatives:** keep it until the old orchestrator is retired (the recommendation workflow 1
  made).
- **Why:** one label set per issue. v1 is unaffected: no v1 rule reads the label, and rollback is
  running the previous release (v0.38.x), which still carries the old tools.

### Small modules, and a size guard (owner)

- **Decision:** the layout of 2.5: one module per area and kind, the planner a thin composer, the
  table as data, no module shared by two parallel units. `npm run lint` fails on any file under
  `plugins/factory-loop/hooks/` over 600 lines, outside an allowlist of today's six v1 files that
  only shrinks and is empty after the delete wave (U1, U10); each listed file is capped at its
  size when listed, so it can only shrink too.
- **Why:** today's loop grew into a few large files (`plan.ts` alone is 2,541 lines). A check
  keeps v2 from doing the same.

### v2's events use today's format (owner)

- **Decision:** on 2026-10-15 the owner withdrew the decision to use issue #534's structured
  event format, and the idea of a new database table: "it's going to be too complex to add". v2
  writes today's format: existing `callum-flow-event` states and fields, with its extra fields as
  `key=value` tokens in the note, encoded as `loop` notes are. `hooks/v2/events.ts` is the one
  seam, so a later format change touches one module (7.1).

### The table is data, with one lookup

- **Decision:** the transition table is an array of rows in `hooks/v2/table.ts`; `rowFor` is the
  only reader, and it throws when zero or two rows match.
- **Alternatives:** transitions coded in rule functions, as v1 did.
- **Why:** totality and exclusivity become testable properties (17.1), and a new case is a row a
  reviewer can see, not a branch in code.

### A step's clock counts only running time

- **Decision:** a step times out on its running ledger entry's age; a held step has no clock; its
  skip line names the filter (4.4).
- **Alternatives:** count from state entry and list the holds that pause it.
- **Why:** any list of holds misses one (`noNewWork`, `serial` and rate caps were missed), and each
  miss parks healthy work. Counting only running time needs no list.

### GitHub events are edges; rows that change nothing never block

- **Decision:** 4.1.
- **Alternatives:** conditions with a fixed priority.
- **Why:** a closed PR stayed "present" and outranked every unpark, and a pending reminder did the
  same (`totality/T-03`).

### The ledger is the outbox

- **Decision:** a transition only stores the record; its effects are keyed entry actions of the new
  seq; a record is made from its done claim (3.3).
- **Alternatives:** do everything inside the transition executor; keep a `loggedSeq` field.
- **Why:** the ledger already retries keyed actions, so no lost write needs a rule of its own.

### Triage is a spawned agent, not a wake

- **Decision:** the one bounded triage call is a `factory-loop:triage` agent with the answer
  script.
- **Alternatives:** a JUDGE wake to the main session (FM 2.11's suggestion).
- **Why:** wakes go one at a time (D-26) and queue behind tells and owner chat. An agent has its
  own timeout, its own model and no claim on the main session's context, and it uses the same
  checked answer path as every other step.

### Free re-runs for causes outside the issue, once per attempt

- **Decision:** U1, with four causes the loop holds as facts (5.1).
- **Alternatives:** no free re-runs (`simplicity/F12`); free re-runs without a bound (the draft).
- **Why:** two restarts and two usage windows in one night (G1:52, :56; V:523) would otherwise
  spend issues' retries and triages on the environment. The bound keeps work finite.

### The breaker counts step unknowns across issues

- **Decision:** 5.3.
- **Alternatives:** count parks (the draft); no breaker.
- **Why:** counting parks acts after every in-flight issue has spent its budget. C3's breaker
  counted same-kind failures across issues (C3:112).

### Every record change is a transition event, self-transitions included

- **Decision:** retries, triage starts and free re-runs bump `seq` and log `transition`.
- **Alternatives:** log only state changes.
- **Why:** the record can then be rebuilt from events alone (3.3), and judgement calls and retries
  can be counted from factory data (#632).

### Records have their own store key

- **Decision:** `records:<repo>`, written only by the `transition` executor, rebuilt from events.
- **Alternatives:** records as a ledger entry kind (FM coupling C2).
- **Why:** the record is state, not an action; keeping it apart keeps the ledger's prune, fit and
  retry rules away from it.

### A step key is one attempt; the table retries steps

- **Decision:** each step attempt has its own key, `maxAttempts` 1. Effects (labels, comments,
  events, PR writes) keep the ledger's retries.
- **Alternatives:** the ledger's same-key retries for steps, as v1 did.
- **Why:** one retry mechanism per thing. A step's second attempt is the table's decision (U2),
  visible in the record and the events.

### A GitHub blip is retried inside the attempt

- **Decision:** 5.1: one rule for every action, in the dispatcher, read from the attempt's result.
- **Alternatives:** retry each command (a comment or a child issue GitHub made before its 5xx
  would be made twice); more ledger attempts for the queue's actions (minutes of hold, and a head
  that cannot move would hold the queue longer).
- **Why:** a blip says nothing about the issue, so it must not cost a triage or count as an
  intervention; the whole action runs again because each action already reads what it did.

### An exhausted effect holds its record and tells the owner

- **Decision:** 4.5.
- **Alternatives:** send it down the step's unknown path (`totality/T-06`).
- **Why:** a retry of the step cannot fix a failing label or comment write; the owner's `retry`
  can, once the cause is fixed.

### A build that answers "cannot" goes to triage

- **Decision:** T6.
- **Alternatives:** park at once; retry.
- **Why:** "cannot" is often a fixable misunderstanding (C3:77); triage can redesign, instruct or
  park, and it is bounded.

### Patch identity has no context lines

- **Decision:** `git diff -U0 ... | git patch-id --stable`.
- **Alternatives:** git's default context; the PR's commit list.
- **Why:** a clean update keeps approval, which the serial queue relies on (OB:63-64); C3:441 shows
  the context form would re-review after harmless updates.

### Review is keyed by patch and round

- **Decision:** 8.4.
- **Alternatives:** by attempt (the draft).
- **Why:** a CI problem or a retry must not buy a second opus review of the same patch, and a new
  round must let the reviewer judge a fixer's declines.

### A failed check is re-run once per round

- **Decision:** 8.5.
- **Alternatives:** no re-run (the draft); a special path for a fixer's decline of a red check.
- **Why:** a flake should not spend a fix round; one re-run is the generic retry for CI, as C3's
  check step had (C3:78).

### Rounds have no cap of their own

- **Decision:** only `fixCap` and `maxTriages` bound work; `round` is counted, not capped.
- **Alternatives:** a separate review-round cap.
- **Why:** every loop into reviewing goes through a fix, a triage or an outside push, so the bound
  already exists; one cap fewer.

### The queue moves past a head that did not merge

- **Decision:** order by `seqAt`; a head's non-ok result sends it to the back (9.1).
- **Alternatives:** keep the head through its retries and triage.
- **Why:** one stuck head could block every merge for about 150 minutes (`totality/T-10`), against
  OB:62-63.

### The interim reviewer has its own definition

- **Decision:** `agents/reviewer.md`, built from the merge adjudicator's judgement rules (8.3).
- **Alternatives:** the v1 adjudicator with a review purpose (the draft).
- **Why:** that definition is a no-mistakes gate adjudicator with another contract, and it must
  stay as it is while v1 can plan.

### The designer is a reader

- **Decision:** the designer returns the brief or the split; the loop posts and creates them
  (8.7).
- **Alternatives:** the designer writes to GitHub, as in v1.
- **Why:** a retried designer made duplicate sub-issues, and the write guard would block the labels
  a split needs. Keyed effects make both idempotent.

### A fixer's dispositions are `verdict` events

- **Decision:** fixed is `CORRECT`, declined is `WRONG`, actor `fixer`.
- **Alternatives:** a new event kind.
- **Why:** the reviewer false-positive query keeps working unchanged (`docs/metrics.md:145-159`).

### An open PR is adopted at claim

- **Decision:** 3.5.
- **Alternatives:** always design from scratch.
- **Why:** released ghosts and hand-made PRs come back with their work. The review reads the whole
  diff, so nothing is trusted that was not reviewed.

### One branch name per issue, across lives

- **Decision:** `issue-<N>`, continued from its origin head (3.5).
- **Alternatives:** `issue-<N>-<k>` for a new life (the draft).
- **Why:** the owner's "one branch and one PR per issue for life" (OB:65-66). Continuing needs no
  force-push, and it keeps a released ghost's work.

### The issue keeps one slot from designing to merge-queue

- **Decision:** the designer and the reviewer read in the issue's slot too.
- **Alternatives:** a slot only for writers; readers in the main checkout.
- **Why:** no agent reads the main checkout (V:276), and one slot per life needs no hand-over.

### Leftovers are saved as a patch file

- **Decision:** 10.2.
- **Alternatives:** push a `park/issue-N` ref (C3:118); discard them.
- **Why:** no extra branches on origin; the work is still recoverable for 7 days, and the retry's
  prompt names it.

### A companion plugin owns the agent's folder, its guard, its timeout and its stop gate

- **Decision:** `factory-loop-workspace` (10.3 to 10.6).
- **Alternatives:** the loop's own hooks; command hooks in callum-flow (the draft); a separate
  `claude -p` process per agent.
- **Why:** the spikes showed that the loop's own hooks never see agents it starts from its timer,
  and that a second plugin's hooks do. callum-flow must stay generic (CLAUDE.md, "This repo"). A
  separate process loses the agent id, `turn.complete` and TaskStop.

### The stop gate refuses while the gates fail

- **Decision:** no cap; a gate that cannot run lets CI decide (10.6).
- **Alternatives:** refuse twice, then let the answer stand (the draft).
- **Why:** it is the owner's rule (OB:84-85). The step's timeout and the unknown path bound it.

### Gate commands are repo settings

- **Decision:** `gateCommands`, empty by default.
- **Alternatives:** read them from `.no-mistakes.yaml`; hard-code npm.
- **Why:** shared plugins stay generic (CLAUDE.md), and no-mistakes is out of the path.

### The loop sets the Bash timeout itself

- **Decision:** `$.env.set` at session start, and the companion's per-call value (10.5).
- **Alternatives:** an export in `dev-remote-control` (an image release); the Coder template.
- **Why:** both proven routes live in the plugins, need no release on the cutover path, and cover
  the plant-console loop too.

### Reconcile has no mode

- **Decision:** R1 acts on v2's own facts every pass; the one-shot migration observes first and
  acts on approval by issue (6).
- **Alternatives:** an observe mode for R1 with approval sets and a hold on claims (the draft).
- **Why:** the owner asked for the first reconcile in observe mode (OB:54), not a permanent one.
  The hold made one ghost stop every claim, a wait on the owner holding capacity (OB:92).

### Releases reuse `reclaimed` and `abandoned`

- **Decision:** 6.4: `reclaimed` for a requeue, `abandoned` for a release that leaves or rejects,
  each with the release fields (`outcome` and `lives` among them, 7.1).
- **Alternatives:** a new `released` kind; a new `rejected` kind.
- **Why:** every reader already ends a claim on them (OB:52-54), and the note's `outcome` tells a
  rejection apart for the metrics.

### Three new event states; everything else reused

- **Decision:** `transition`, `reviewed`, `intervention` (7.1).
- **Alternatives:** a new kind per v2 state; carry state changes in `loop` notes.
- **Why:** `loop` is never a stage (D-09), so state changes need their own kind; reusing
  `delegated`, `fix_requested`, `merge_ready` and `verdict` keeps every existing query working.

### No label mirror

- **Decision:** labels are written, not read back, except the parked label (3.4).
- **Alternatives:** rewrite drifted labels each pass (the draft).
- **Why:** the record is the authority (OB:43); the label list lags, and the rewrite undid parks.

### A drop applies to the life it closed

- **Decision:** 4.1, 11.
- **Alternatives:** a drop list that never expires (v1).
- **Why:** bringing an issue back needed a hand edit of `control.json` (#602, G1:375).

### Waiting states tell; running steps go unknown

- **Decision:** queued, parked and a waiting merge-queue record tell on their period and stay.
- **Alternatives:** unknown for every timeout.
- **Why:** nothing is running to retry in a waiting state; the owner needs to know, not a triage.

### Restart without a drain

- **Decision:** R2 restarts at once except during a queue action or the release task, on a pass
  that admits nothing else (what it would start would only be cut); a running step it cuts
  re-runs free (U1).
- **Alternatives:** v1's drain (D-15, D-53); waiting for agent steps.
- **Why:** steps are re-runnable and pushed work survives; the drain held the factory for hours.

### Foundation helpers are copied, not moved, until the delete wave

- **Decision:** `foundation.ts` copies them with a parity test.
- **Alternatives:** move them out of `plan.ts` now.
- **Why:** `plan.ts` stays untouched until the delete wave (OB:107-109).

### A resume resets the budgets and hears GitHub answers

- **Decision:** P1 resets attempt, triages and fixes, and takes the owner's trusted comments since
  the park as the note.
- **Alternatives:** keep the counters; notes only through `/factory`.
- **Why:** a resume is the owner's decision to try again; #591 showed answers on GitHub must count.

### Slow keeps one claim per pass and drops the merge clause

- **Decision:** D-07 changed: in Slow, one claim per pass and none within `slowGapMs` of the last;
  merge work no longer holds a claim back.
- **Alternatives:** keep D-07 whole; drop Slow's extra rule.
- **Why:** merges are free CLI work in v2 and must never wait, while the gap still spaces new work
  as the owner chose (D-07).

### Both settings files are read every pass; the workspace file may set any key

- **Decision:** the repo-local file is read from origin's default branch with `git show` every
  `githubEveryMs`; the workspace file, read every pass, may set any key and wins.
- **Alternatives:** v1's reading (the repo file at session start; the workspace file for a few
  keys).
- **Why:** DB:91 (`maxInFlightIssues` silently ignored). Nothing in v2 keeps the main checkout up
  to date, so the repo file is read from the branch, not the tree.

## 16. Build units

Units in one wave must not share a file unless the order is stated. Waves 2 and 3 run side by side
in workflow 3, so their units must not share files with each other either. U1 pre-wires every
shared registry (action kinds, executor registry, source modules, contract modules, safety
allowlists), so later units only fill their own files.

| Unit | Wave | Creates | Changes | Depends on | Effort |
|---|---|---|---|---|---|
| U1 Skeleton, switch and vocabulary | 1 (first) | `hooks/foundation.ts` (with the breaker's step-unknown bucket); `hooks/v2/types.ts`, `plan.ts`, `observe.ts`, `registry.ts`, `steps.ts`; stub modules for U2 to U9 (`rules-state.ts`, `reconcile.ts`, `release.ts`, `rules-queue.ts`, `rules-slots.ts`, `rules-interventions.ts`, `sources-prs.ts`, `sources-interventions.ts`, `events.ts` (its types and signatures), `act-state.ts`, `act-events.ts`, `act-pr.ts`, `act-split.ts`, `act-review.ts`, `act-ci.ts`, `act-queue.ts`, `act-slots.ts`, `steps-work.ts`, `steps-review.ts`, `steps-queue.ts`, `steps-triage.ts`, `contracts-work.mjs`, `contracts-review.mjs`, `contracts-triage.mjs`), each failing `noRetry` until built; `tests/foundation.test.ts` (parity); `tests/v2-switch.test.ts` | `hooks/types.ts`, `config.ts` (v2 kinds and keys; the workspace file may set every key), `act.ts` (planner switch, registry), `register.ts` (planner and shadow, the records and heads keys, transition pings, decision-log fields, `ownerOp` calls `act-events.ts`), `control.ts` (ops of appendix E), `contract.mjs` (imports the v2 contract modules), `observe.ts` (calls `observeV2`), `scripts/factory-loop-replay.js` (`--planner`), `tests/factory-loop-plan.test.js` (purity over `hooks/v2/`), `tests/factory-loop-safety.test.js` and `plugins/factory-loop/tests/safety.test.ts` (every v2 argv of appendix B, `gh run rerun` among them), `plugins/factory-loop/tests/control.test.ts`; `scripts/lint.sh` (the size guard and its allowlist, 2.5) and a test of the guard | - | xhigh |
| U2 State model, table and triage | 1 | `hooks/v2/table.ts`, `record.ts`; fills `rules-state.ts` (S0 to S6, H1 with the re-claim, O1's counts), `act-state.ts` (`transition` with its trigger, `label`, `comment` with the hidden key, `event` through `events.ts`, follow-ups reusing v1's `rollout`, `close-issue`, `release-parent` and `milestone-later` executors), `steps-triage.ts`, `contracts-triage.mjs`; `hooks/v2/prompts-triage.ts`; `agents/triage.md`; `plugins/factory-loop/tests/v2-table.test.ts`, `v2-state.test.ts`, `v2-record.test.ts` | `hooks/derive.ts` (v2 states in `EVENTS_SQL`; `recordsFromEvents` lives in `record.ts`, so `derive.ts` stays under the size budget), `skills/judge/SKILL.md` (v2 TELL kinds and the release task with Run its, beside the v1 sections), `tests/factory-loop-judge-skill.test.js`, `tests/factory-loop-agents.test.js` (triage) | U1 | xhigh |
| U3 Reconcile | 1 | fills `reconcile.ts` (R1 and the tripwire), `release.ts` (the release actions of 6.4, shared); `bin/factory-reconcile` (the one-shot migration, 6.3, which also removes `In development` from the issues it touches); `plugins/factory-loop/tests/v2-reconcile.test.ts`; `tests/factory-loop-reconcile.test.js` (the tool over fixtures) | - | U1; U4 for one test: the migration's event notes are parsed with `events.ts`, which U4 fills, so that test lands with or after U4 | xhigh |
| U4 Events, interventions and the claim tools | 1 | fills `hooks/v2/events.ts` (the one seam: every v2 event's state, columns, `key=value` note, argv and the note's parser, 7.1), `rules-interventions.ts` and `sources-interventions.ts` (every intervention of 7.2, the push detection, the companion's log, the control and config digests), `act-events.ts`; `plugins/factory-loop/tests/v2-events.test.ts`, `v2-interventions.test.ts` | `images/base/callum-flow-event` (three states and their required note tokens) and its test; `images/base/callum-flow-claim` (no `In development`; the heartbeat's own claims from factory-state, 3.6) and `features/test/callum-tools/claim.test.sh`; `images/base/callum-flow-sweep` (candidates from events, no `In development`, and the merged-PR pattern `(^\|/)issue-<N>(-\|$)`, `totality/T-27`) and its test; `images/base/callum-flow-factory-state` (the v2 stage from the `transition` note; `nomistakes.runs` optional; the label checks of 3.6), `tests/factory-state.test.js`, `tests/fixtures/factory-state/` (new fixtures), `docs/factory-state.md`; `images/base/callum-flow-evaluate` (interventions and judgement calls from the notes) and its tests; `docs/metrics.md`; `images/base/README.md` (event log and claim tool reference); `plugins/callum-flow/skills/issue-orchestrator/SKILL.md` (its two `In development` lines) | U1 | xhigh |
| U5 Designer, builder, fixer and the PR | 2 | `agents/designer-v2.md`, `agents/builder.md`, `agents/fixer.md`; `hooks/v2/prompts-work.ts` (the three prompts, `FOREGROUND_RULE`, the v2 `COMMAND_RULE`, the slot line, the retry context); fills `contracts-work.mjs` (design, build, fix), `steps-work.ts` (design, build, fix, the direct origin read), `act-pr.ts` (ensure, body), `act-split.ts` (children); `plugins/factory-loop/tests/v2-work.test.ts`, `v2-pr.test.ts`; a test that no v2 prompt or loop-owned definition names `axi`, `no-mistakes` or `implement-issue` | `tests/factory-loop-agents.test.js` (the new types); the synced `Two ways work gets done` section of `templates/CLAUDE.md` (and its baseline and this repo's copy) says what a loop agent leaves to the loop and which text is the manual path. It is synced, so `callum-dev update` merges it without conflict, and the repo-owned block is left alone apart from its heading | U1, U2 | high |
| U6 Reviewer and CI | 2 | `agents/reviewer.md`; `hooks/v2/reviewer.ts`, `prompts-review.ts`; fills `contracts-review.mjs`, `steps-review.ts` (the review and CI halves), `act-review.ts` (PR comment, `reviewed` and fixer `verdict` events), `act-ci.ts` (`ci-rerun`); `plugins/factory-loop/tests/v2-review.test.ts` | - | U1, U2 | high |
| U7 Merge queue | 2 | fills `rules-queue.ts` (order, Q1, Q2), `steps-queue.ts`, `act-queue.ts`, `sources-prs.ts` (PRs, checks, patch ids, heads first seen); `images/base/callum-flow-patch-id` and its test; `plugins/factory-loop/tests/v2-queue.test.ts`; `tests/factory-loop-v2-patch-id.test.js` (real git) | `images/base/callum-flow-merge-guard` (`--patch`: no run lookup, class tokens) and `images/base/callum-flow-merge` (passes it), their tests; `images/base/README.md` (the guard mode) | U1, U2 | xhigh |
| U8 Slots | 3 | fills `rules-slots.ts` (W1, W2), `act-slots.ts`; `bin/factory-slot` (`lease`, `prepare`, `kill`, `free`); `plugins/factory-loop/tests/v2-slots.test.ts`; `tests/factory-loop-v2-slot.test.js` (real git, a fake treehouse, a branch held by another worktree) | - | U1, U2 | high |
| U9 The companion plugin | 3 | first, the frameless re-probe (10.9) as `docs/factory-loop/probes/workspace-probe/`; then `plugins/factory-loop-workspace/` (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts`: the folder, the map, the write guard, the timeout, the stop gate, the handshake file, and the refusal and gate lines it appends to `<loop dir>/companion.jsonl`, 7.2) and its tests (`claude plugin test`) | `plugins/factory-loop/hooks/register.ts` (`$.env.set` at session start, the slot line in spawns, `cwd` in the spawn arguments), `hooks/rails.ts` (the workspace rail), `hooks/exec.ts` (`SpawnInput.cwd`); `.claude-plugin/marketplace.json`; `coder/push.sh` and `coder/test/push.test.sh` (the orchestrator-loop plugin list) | U1, U8 | high |
| U10 Delete v1 | 4 | `tests/v2-plan.test.ts` and `v2-queue.test.ts` receive the moved cases | deletes and cuts per 13.3; renames `designer-v2` to `designer`; moves the reused executors into `hooks/v2/`; removes `planner` and `shadow` (a `planner: v1` setting is then named in the decision log's `config` problems); removes `inDevLabel` and `CALLUM_FLOW_IN_DEV_LABEL` (`config.ts:13`, `register.ts:263`); splits the kept `register.ts` into the engine wiring and the pass driver, and splits any other kept file still over 600 lines (`act.ts`, `act-agents.ts` and `control.ts` are over today), so the size guard's allowlist in `scripts/lint.sh` is empty | the cutover bar met (17.5) | xhigh |
| U11 Docs | 4 (after U10) | - | `docs/factory-loop/SPEC.md` (this spec, as built), `docs/factory-loop/DECISIONS.md` (unnumbered: 32 kept, 22 changed and section 15's), `plugins/factory-loop/README.md`, `skills/judge/SKILL.md` and `tests/factory-loop-judge-skill.test.js` (v1 sections out), `docs/architecture.md`; deletes the v1 documents of 13.3 | U10 | high |

Notes:

- Workflow 2 runs U1 first, then U2, U3 and U4 in parallel. They share no file: U2 and U3 write
  events only by calling `events.ts`, which U1 stubs and U4 fills. U4 alone changes the image's
  event, claim, sweep and factory-state tools.
- U4 runs beside U2 and U3 after U1. It waits on nothing outside the branch: v2 writes today's
  event format (7.1).
- Workflow 3 runs U5, U6 and U7 beside U8 and U9. Only U9 touches `register.ts`, `rails.ts`,
  `exec.ts`, the marketplace and `coder/`. Only U7 touches `images/base/README.md` in that
  workflow.
- U9 starts with the re-probe. If it fails, U9 builds the stated fallback for that point (10.9) and
  notes it in its PR.
- Image changes (U4, U7) reach the loop through a base image release, or earlier on the scratch
  repo through `binDir` (D-42). The companion reaches the orchestrator-loop workspace through the
  template's plugin list (U9), pushed at cutover.

## 17. Test plan

### 17.1 Properties of the table and the plan

In `plugins/factory-loop/tests/v2-table.test.ts` and `v2-plan.test.ts`, over generated records
(every state, step, attempt, counter, cut flag and event), configs and admission filters. They run
on every `planV2` call the tests make. No test asserts an exact ledger key except the key codec's
own test.

1. **Totality.** `rowFor` finds exactly one row for every (state, step, event, guard input) in the
   domain. Every state but closed has a timeout or a tell period. Closed is absorbing.
2. **Reachability.** Every state is reachable from queued, and closed from every state.
3. **Liveness.** After one pass, every non-closed record has a running step, a planned action, or
   a skip line naming why it waits: the admission filter that held it, capacity, its queue
   position, the owner, or a stalled effect. Generated with each admission filter on. No record is
   silent.
4. **One label.** The label of every reachable record is exactly one `factory:*` state label, or
   none when closed. `factory:rejected` is set only by R1's rejection.
5. **Capacity.** After admission, records in slot states number at most K; parked records never
   count; a claim never takes queued plus in-flight records above K.
6. **One writer.** At most one step per record; never an agent step and a queue action on one
   record at once; no two records share a slot.
7. **Bounded work.** On any event sequence without outside events (unpark, outside pushes), agent
   steps per life stay under the bound computed from `fixCap`, `maxTriages` and one free re-run
   per attempt.
8. **Head only.** No plan has a `queue-update` or `queue-merge` for a record that is not the head;
   no argv has `--rebase` or a force push; no action makes a branch other than the record's; no
   action closes a PR.
9. **Patch-keyed approval.** Q2 never plans a merge when the head's patch is not `approvedPatch`.
10. **The unknown path.** From any unknown the next steps are a free re-run at most once, then
    retry, then triage, then park, in that order and bounded; an invalid triage answer parks.
11. **Held steps never time out.** A record whose step admission holds, for any number of passes,
    spends no attempt.
12. **Edges.** From every reachable parked record, `unpark` reaches queued within one pass,
    whatever else is present (`totality/T-03`). A resumed record whose PR a person closed is not
    parked again for that same close.
13. **Interventions are exact.** Replaying any interleaving of the loop's writes and delayed
    reads gives no `unpark` and no person intervention without a person's action
    (`totality/T-01`). A happy-path life (design, build, an approving review, green CI, merge)
    logs no intervention. Each loop intervention of 7.2 is logged exactly once for its fact.
14. **The queue moves.** A head whose step ends other than ok is not the head on the next pass
    while another record waits.
15. **Review reuse.** No plan starts a reviewer for a (patch, round) that already has a done review.
16. **The foundation's properties** (v1 SPEC 5.9): determinism, idempotence (planning again with
    the planned actions running adds nothing but the title), purity, tier safety, control safety,
    one wake and the claim limits.
17. **Reconcile.** A done release begins nothing again: the next pass plans only its intervention
    (`reconcile`, or `rejected` for a rejection, 7.2), once; R1 never releases an issue with a
    record, a claim in flight, or another device's claim; observe mode executes nothing. Each
    release ends by its outcome: back in the queue (`ready` on, `reclaimed`) by default and only
    once the issue reads as open; out of the factory (`abandoned`) when the owner dropped it since
    its claim; rejected (`factory:rejected` on, its comment and owner tell done, then `abandoned`)
    at its `maxLives`-th life. A release keeps the outcome it began with.
18. **Events.** Every transition's seq logs exactly one `transition` event before the next
    transition, and rebuilding from any history of them gives back the records. Every note
    `events.ts` builds parses back to the same fields, whole.
19. **Size.** No file under `plugins/factory-loop/hooks/` is over 600 lines outside the
    allowlist, no listed file is over its cap, and no listed file is at or under 600 (2.5;
    `npm run lint`).
20. **Lives.** S0's record counts one more than the issue's earlier lives since its count last
    started (a record's count, then one per R1 release after it), and the first claim after a
    rejection is life 1, logged as `unreject`. S1 never claims an issue that carries
    `factory:rejected`. No release re-adds `ready` at or past `maxLives`.

### 17.2 Replay of 2026-10-14/15

A harness, `scripts/factory-loop-v2-replay.js` (built in workflow 5), makes a timeline per issue
from `evidence/decisions-2026-10-14.jsonl` and `-15.jsonl` (claims, agent starts, answers and
their contents), `factory.events` (ready, merged, closures), PR and check metadata, the control
file and the tier changes. It drives `planV2` pass by pass in a simulated world where steps take
their recorded time. A run that went green maps to an approving review and green CI; refusals and
limbo map as G1 records them. Checks:

- each of the 17 claims ends merged, parked with a question, or closed, and is never silent past a
  timeout;
- after 02:41 no pass sits at the cap with queued work while records are parked;
- zero updates of non-head PRs, zero new branches, zero PR closes;
- #613 reaches triage within one build timeout of 22:13:51;
- #591's 429 becomes a free re-run after the 02:20 reset;
- the 21:27 `noNewWork` and the 22:27:44 rate cap spend no attempt (G1:500; V:479);
- #467's and #571's merge holds do not happen;
- triage calls and parks are counted against v1's 13 judge wakes and its escalations.

The existing replay harness also runs with `--planner v2` on the recorded windows in
`docs/factory-loop/replay/`, for claims and titles.

### 17.3 Fault drills on cbundy/dev-system-scratch

The scratch repo is public, with "up to date before merging" on and `ci` required (OB:113-114).
Each drill passes when its expected events appear in `factory.events`, its expected
interventions are logged, and no other intervention is.

| Drill | Expected |
|---|---|
| A conflict pair: two issues edit the same lines | the second head's update conflicts, a fixer merges main and resolves, reviewing, then merged |
| A PR that conflicts while in reviewing | `not-ok(conflict)` at once, a fixer, then reviewing; no wait for CI |
| An outside merge during the head's CI wait | the head goes behind, one more update under the new base, merged; no other PR touched |
| A flaky check (fails once, then passes) | one `ci-rerun` (intervention `ci-rerun`), then merged; no fixer |
| A restart in the middle of a build | the step runs again free (U1; interventions `restart` and `free:load`); with the store wiped, records rebuild from events |
| A usage-limit error (thresholds lowered during a build) | a free re-run held until the tier allows it (`free:usage`); merges go on |
| Three steps failing with an API error on two issues | the breaker closes agent steps for 30 minutes and tells the owner (`unknown:api`, `breaker`); no issue parks |
| `/factory new off` for 2 hours with work in flight | no attempt spent; steps resume when it is turned on |
| A parked question (a brief that needs a decision) | parked, comment, tell; the label removed with an answer comment resumes designing with the answer (`park`, then person `unpark`) |
| A PR closed by hand | parked; on resume the PR is reopened and review runs; not parked again |
| A merge by hand of the record's PR with `Closes #N` | closed `merged-by-hand`, rollout follow-ups run, intervention (person, `hand-merge`) |
| An issue closed by hand during a build | closed, slot freed, intervention (person, `issue-closed`) |
| A hand push to a branch in reviewing | intervention (person, `push`); the new patch is reviewed |
| A hung process (`sleep 3600 &` left by a builder) | killed at the next seq (`KILLED 1`) |
| An agent told to write in the main checkout, or push to another branch | refused by the guard, the reason fed back (`guard:write`, `guard:push`) |
| The companion plugin disabled | agent steps held with the skip line `workspace`; `tell(workspace)` once |
| A ghost (a claim of this device with no record) | released at once, with the right closing event |
| Two v2 loops on two devices, with a forced lease lapse | neither releases or relabels the other's claim (`totality/T-02`) |
| A reviewer that always asks for changes | parked after 3 fix rounds; the only intervention is the `park` |
| A triage that times out | one retry of the triage, then parked (`triage`, `unknown:timeout` twice, `park`) |

### 17.4 Shadow day on dev-system

v2 as `shadow: v2` (or in observe mode) for 24 hours. Measured, in
`docs/factory-loop/v2/SHADOW-DAY.md`:

- R1's release proposals, against the migration tool's report;
- v2's planned claims, against the queue filters;
- no planned update of a non-head PR;
- no flapping: no planned transition reversed within 3 passes;
- pass time within twice v1's;
- no plan error.

### 17.5 Cutover, its bar and rollback

- **Before:** the migration tool's report (6.3), the owner's approval, and its act run; the
  companion plugin in the orchestrator-loop template's plugin list, pushed at cutover, and the
  workspace restarted onto it (a restart the owner is asked for); the shadow day.
- **K** = 2 for the first 5 claims, then 3 (section 15). The change is a fleet-level person
  intervention (`config-file` or `op`); it names no issue, so it is attached to none (7.2).
- **The bar** (OB:115-116): at least 7 of the first 10 claims merge within 3 hours of their claim
  untouched: no intervention of either kind names the issue (7.2). Every claim counts, those that
  change the loop itself included (section 15). A restart to ship a loop fix during cutover shows
  as `free:load` on each issue whose step it cut.
- **Also required:** no update of a non-head PR, no new branch, a question comment on every park,
  no record without a running step, a planned action or a named wait (from the decision log), and
  no new rule needed.
- **A miss** is classified. A miss that needs a new rule goes to the owner as a design question
  (V:555, "the new layer's first-contact bugs do not settle").
- **Rollback runbook:**
  1. `/factory new off`;
  2. let in-flight records reach parked or closed, or drop them;
  3. remove the `factory:*` labels;
  4. switch: `planner: v1` before the delete wave, or the previous release after it (OB:117).

  A parked v2 issue comes back to v1 by re-adding `ready`.

## 18. Open questions for the owner

None. The owner answered all ten on 2026-10-15; the answers are in section 15.

## Appendix A. Settings

New keys, in the repo-local file or the workspace file (which wins). Durations take `60s`, `5m`,
`2h` as v1's do (v1 SPEC 4.2).

| Key | Default | Meaning |
|---|---|---|
| `planner` | `v1` until cutover | 2.3 |
| `shadow` | `off` | 2.3 |
| `stateTimeoutMs` | design 45m, build 90m, review 30m, fix 60m, triage 15m, queued 6h, queueWait 2h, parked 24h | 4.4 |
| `ciStartMs` | `10m` | 4.4 |
| `ciRunMs` | `30m` | 4.4 |
| `prEveryMs` | `30s` | 2.4: how long a PR's read stands before it is read again, unless the loop's own doings make it due sooner |
| `maxTriages` | 2 | 5.1 |
| `maxLives` | 3 | 6.4: a release at this life rejects the issue instead of putting it back in the queue |
| `triageModel` | `opus` | 5.2 |
| `reviewer` | `adjudicator` | 8.2 |
| `reviewerModel` | `opus` | 8.3 |
| `gateCommands` | `[]` | 10.6 |
| `gateTimeoutMs` | `10m` in all | 10.6 |

Reused with their v1 meaning: `maxInFlightIssues` (K; default 3, and 2 for the first 5 claims at cutover, section 15), `worktreeReserve`,
`poolSize`, `reviewFixCap` (`fixCap`), `retryBackoffMs` and `maxAttempts` (for effects),
`rateCaps`, the usage thresholds, the read cadences, `heartbeatEveryMs`, `sweepEveryMs`,
`checkoutEveryMs`, `slowGapMs`, `maxStartsPerPass`, `answerChannel` (`script`), `trace`,
`traceMaxBytes`. v1-only keys (`guardRecheckMs`, `guardTtlMs`, `respondSettleMs`,
`updateBehindRetryMs`, `updateBehindRetries`, `ciStallRecheckMs`, `agentTimeoutMs`) go at the
delete wave.

## Appendix B. Action kinds

| Kind | Class | Executor and argv | Attempts |
|---|---|---|---|
| `transition` | free | re-checks its trigger, stores the record, pings | 3 |
| `label` | free | `gh issue edit <N> --repo R --add-label <l> --remove-label <l,...>`; op `ensure`: `gh label create <name> --repo R --color <c> --description <d> --force` for the eight; op `clear` (3.4); R1's op `requeue`: `--add-label <ready> --remove-label <the seven>`, and op `reject`: `--add-label factory:rejected --remove-label <the seven>` (6.4) | 3 |
| `comment` | free | reads comments for its hidden key, then `gh issue comment <N> --repo R --body-file -` or `gh pr comment <p> --repo R --body-file -`; also R1's rejection comment (6.4) | 3 |
| `event` | free | `callum-flow-event <state> --note <key=value tokens> ...`, built only by `events.ts` (7.1), for `transition`, `delegated`, `fix_requested`, `merge_ready`, `abandoned`, `reclaimed`, `merged`, `reviewed`, `verdict`, `intervention`; an action marked logged (7.2, `events.ts` `logOnce`) is settled done with no command | 3 |
| `pr` | free | op `ensure`: `gh pr list --repo R --head <b> --state all ...`, then `gh pr reopen <p> --repo R` or `gh pr create --repo R --base <d> --head <b> --title <t> --body-file -`, and `gh pr edit <p> --repo R --body-file -`; op `body`: the edit alone | 3 |
| `split` | free | per child: find it by its hidden key, else `gh issue create --repo R --title <t> --body-file -`; link it as a sub-issue and add `blocked_by` (`gh api` with the sub-issue and dependency endpoints); `gh issue edit <c> --repo R --add-label ready` for a ready child | 3 |
| `agent-step` | develop (design, build) or drive (review, fix, triage) | `$.agent.spawn` with the step's agent type, through v1's spawn half (`act-agents.ts:538`), after looking for a recorded answer (10.8) | 1 per key |
| `ci-rerun` | free | `gh run rerun <run id> --failed --repo R` | 3 per key, with backoff, in reviewing and at the queue's head; GitHub's own refusal is never retried (8.5) |
| `queue-update` | free | `gh pr update-branch <p> --repo R`, then reads the PR head until it moves | 1 per key |
| `queue-merge` | free | `callum-flow-merge <p> --patch <id> --issue <N>` | 1 per key |
| `slot` | free | `factory-slot lease\|prepare\|kill\|free ...` | lease 3; prepare 1 per key (part of the attempt); kill 1 (best effort); free 2 |
| `claim`, `heartbeat`, `sweep`, `stop-agent`, `rollout`, `close-issue`, `release-parent`, `milestone-later`, `restart-self`, `task`, `tell`, `title` | as v1 | as v1 (v1 SPEC 6.1); `claim` also lists open PRs for adoption (3.5) | as v1 |

11 new kinds, 12 reused. The per-issue rate cap (D-24) counts `agent-step` by step kind. Every `gh`
command carries `--repo`. The safety tests allow exactly these argv shapes and keep every other v1
ban (FM coupling C10). `rerun` is banned there today, so `gh run rerun` is allowed deliberately,
as one argv.

## Appendix C. Key families

| Family | Example |
|---|---|
| claim | `i571/claim/ss1x2k`; a re-claim `i571/lss1x2k/claim/ss2a9q` |
| transition | `i571/lss1x2k/s7/t` |
| entry action | `i571/lss1x2k/s7/label`, `.../s7/stop`, `.../s7/kill`, `.../s7/comment`, `.../s7/event/transition` |
| step attempt | `i571/lss1x2k/s7/build/a1`, `.../s7/prepare/a1`, `.../s9/triage/a1` |
| review | `i571/lss1x2k/review/3fa2c1d/r2/a1` |
| PR | `i571/lss1x2k/s8/pr/ensure`, `.../s12/pr/body/a1` |
| split child | `i600/lss0q1z/s3/child/b` |
| CI re-run | `i571/lss1x2k/rerun/r2/18342299123` |
| queue | `i571/lss1x2k/queue/update/9e01b77`, `.../queue/merge/4c2d8aa` |
| slot | `i571/lss1x2k/lease/1`, `slot/<lease id>/free` |
| follow-up | `i571/lss1x2k/follow/rollout` |
| reconcile | `i571/reconcile/ss1x2k/requeue` (the label op is the outcome: `requeue`, `leave` or `reject`), `.../comment`, `.../stop/<agent>`, `.../event`; a rejection's tell `tell:rejected:i571/reconcile/ss1x2k/reject` |
| intervention | `iv/` plus the key of the fact it records: `iv/i571/lss1x2k/s7/t`, `iv/i571/lss1x2k/rerun/r2/18342299123`; for a fact with no key of its own, `iv/<cause>/<subject>/<at>`, as in `iv/push/i571/ss3b0c` |
| heartbeat, sweep, tell, restart, release task | as v1 |

13 new families, plus the foundation's 5, against about 62 (G2 section 1).

## Appendix D. Labels and notices

| Label | Colour | Description |
|---|---|---|
| `factory:queued` | `c5def5` | Factory loop: claimed, waiting for a slot |
| `factory:designing` | `bfd4f2` | Factory loop: the designer is at work |
| `factory:building` | `0e8a16` | Factory loop: the implementer is at work |
| `factory:reviewing` | `fbca04` | Factory loop: review and CI on the PR |
| `factory:fixing` | `d93f0b` | Factory loop: a fixer is at work |
| `factory:merge-queue` | `5319e7` | Factory loop: approved and green, waiting to merge |
| `factory:parked` | `b60205` | Factory loop: waits on the owner; remove this label to resume |
| `factory:rejected` | `6a737d` | Factory loop: its last life ended without a merge; remove this label and add ready to try again. Not a state (3.4, 6.4) |

Notices (TELL kinds), owner items first:

| Kind | Owner item | When |
|---|---|---|
| `parked` | yes | a park, and its daily reminder |
| `breaker` | yes | 5.3, and the foundation's executor breaker |
| `stalled` | yes | an effect used up its attempts (4.5) |
| `checkout` | yes | the main-checkout tripwire (10.7) |
| `workspace` | yes | the companion plugin is not loaded (10.9) |
| `rejected` | yes | R1 rejected an issue at its `maxLives`-th life, with why each life ended (6.4) |
| `waiting` | no | E6: queued 6 h, or behind the queue's head 2 h |
| `task-timeout` | no | the release task timed out |
| `runaway`, `blind`, `heartbeat-other`, `old-watcher`, `pass-error` | no | foundation, unchanged |

7 new kinds, 6 of them owner items, plus the foundation's.

## Appendix E. Owner ops

| Op | v2 meaning |
|---|---|
| `resume <N...> ["note"]` | unpark (P1). On an issue that is not parked it changes nothing and answers "not parked; use `/factory note N`". `resume <run id>` is v1-only |
| `drop <N>` | E1, for the current life only (4.1) |
| `note [N] <text>` | a note for the issue's next step (or every issue's) |
| `planner v1\|v2` | writes the workspace file, as `mode` does |
| `retry <N>` | clears the issue's exhausted effects (4.5) |
| `status`, `pause`, `unpause`, `skip`, `noskip`, `priority`, `only`, `serial`, `new`, `override`, `update`, `mode`, `trace`, `help` | unchanged (v1 SPEC 4.3) |

Every op but `status` and `help` is logged as a person intervention (7.2). Rescues the loop cannot
see are recorded by hand with `callum-flow-event intervention` (7.2); there is no `/factory touch`
op.
