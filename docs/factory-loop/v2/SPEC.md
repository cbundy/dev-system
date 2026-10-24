# Factory loop v2: specification

This is the specification of the factory loop as built: the record each issue carries, the
transition table, the one path for an unknown result, reconcile, the events, the merge queue, the
workspaces, and the foundation the loop runs on. It states what the code does and why each rule
exists.

**How it is organised.** Sections 1 and 2 give the goals and how the parts fit. Sections 3 to 12
are the loop's design. Section 13 is the foundation: the pass driver, observe, configuration, the
ledger, safety rails and observability. Section 14.1 counts the rule layer, section 15 holds the
decisions still in force, and section 17.1 lists the properties the tests keep true. Appendices A
to E list the vocabulary (settings, action kinds, key families, labels and notices, owner ops).

**How to read it.** Sections 3 to 6 are the core: the record, the transition table, the unknown
path and reconcile. Section 10 is the workspace design. Section 13 is the base the rest plugs
into. A reference such as `13.7.4` names a section of this document; `D-nn` is an entry of
`docs/factory-loop/DECISIONS.md`.

Code paths are under `plugins/factory-loop/` unless they start with `docs/`, `tests/`,
`scripts/`, `images/`, `features/`, `coder/` or `plugins/`. Times are UTC.

## 1. Goals and non-goals

Goals:

- One issue goes from claim to merge untouched most of the time: no intervention by a person or
  by the loop is attached to it (7.2). The bar: at least 7 of the first 10 claims merge within 3
  hours untouched.
- Every issue has one explicit state with a timeout. Every step ends ok, not ok or unknown, and
  unknown has one path.
- The loop owns what it reconciles: the record, the branch, the PR, the slot and the merge. It
  never mirrors another tool's private state.
- Few mechanisms: 23 rule ids. Section 14.1 counts the layer.
- Every intervention is an event: each time a person, or the loop with unplanned judgement or
  recovery, had to step in. So "untouched", operator interventions and judgement calls can be
  read from factory data alone (issue #632, metrics 1 and 2).

- The loop readies its own work in one case only (owner, 2026-10-18): a flake bug it filed itself
  (8.5, rule F1), while fewer than `flakeBugReadyCap` flake bugs are ready or in flight. It readies
  no other issue, and never readies a flake bug it held. The owner can.

Non-goals:

- no-mistakes anywhere in the loop's path: not in its sources, its guard calls, its agent
  definitions or its prompts. It stays for people and other repos; `.no-mistakes.yaml` is not
  changed.
- Release sequencing in the merge path.
- Running tests in the loop. GitHub CI is the test gate.
- A GitHub merge queue: it needs an organisation-owned repo, and dev-system is user-owned.

## 2. The foundation, and how v2 plugs in

### 2.1 What stays

The foundation is the base the loop runs on. Section 13 describes it, and the loop uses it through the interfaces named below.

| Part | Where | In the loop |
|---|---|---|
| Pass driver, clock, pings, scheduler, phases | 13.2; `register.ts` and the `driver-*.ts` modules, `rails.ts` | the plan call is `planV2` (2.3) |
| Rails, act lock, kill switch | 13.11; `rails.ts`, `act.ts` | one more rail: the workspace plugin is loaded (10.9) |
| Executor contract and dispatcher | 13.6; `exec.ts`, `act.ts` | v2 kinds register in `EXECUTORS` |
| Ledger | 13.7.1; `ledger.ts` | same API; v2 key families (appendix C) |
| Usage tiers and action classes | 13.5.2; `foundation.ts` `tierOf` and the class matrix | the loop's classes are in appendix B |
| Breakers and rate caps | 13.11.4 | one more breaker bucket: step unknowns across issues (5.3) |
| Owner controls | 13.4.3; `control.ts`, `control.json` | the ops are in appendix E |
| Wakes and one wake at a time | 13.8; `wake.ts` | `tell` and `task release` only |
| Answer channel and repair message | 13.7.3a; `contract.mjs`, `bin/factory-answer` | the `script` channel only; new contracts |
| Event emitter | 13.7.4; `act.ts` `ctx.event` | three states of its own (7.1) |
| Decision log, trace, daily prune | 13.12, 13.11.6; `trace.ts`, `exec.ts` | the `planner` field is always `v2` |
| Store | 13.7.1; `$.store` | new keys `records:<repo>` (3.3) and `heads:<repo>` (2.4) |
| Settings layers | 13.4; `config.ts` | new keys (appendix A) |

### 2.2 The seam

- **Plan.** `planV2(state: State, config: Config): PlanResult` in `hooks/v2/plan.ts`. It is pure: it imports types, `hooks/v2/*.ts` and `hooks/foundation.ts` only. The purity test
  (`tests/factory-loop-plan.test.js`) covers `hooks/v2/`.
- **Foundation helpers.** `hooks/foundation.ts` holds the generic plan code the loop needs: the tier
  (re-exporting `tierOf`), the class matrix, `gate` and `want`, the generic admission filters
  (control, tier, GitHub backoff, breakers, rate caps), `oneWake` and the title frame. These are
  the one copy of that code.
- **Observe.** `observe()` calls `observeV2()` (`hooks/v2/observe.ts`). It adds the State fields
  in 2.4. It reads no no-mistakes run data and does no slot reflog inference.
- **Act.** The loop's executors live in `hooks/v2/act-*.ts` and join `EXECUTORS` (`act.ts`) through
  `hooks/v2/registry.ts`.
- **Events.** Every event is built by one module, `hooks/v2/events.ts`, and written through
  `ctx.event` (`act.ts`). `callum-flow-event` has three states of its own (7.1).
- **Wakes.** `tell` and `task release` through `wake.ts`. Triage is a spawned agent, not a wake
  (section 15).
- **Store.** `records:<repo>` (3.3) and `heads:<repo>` (2.4).
- **Controls.** `control.json` keeps its shape; the ops are in appendix E.

### 2.3 The loop always plans with v2

The loop plans with `planV2` alone, and there is no switch.

- The settings `planner` and `shadow` of earlier releases are retired. A settings file, repo-local
  or workspace, that still sets either one (any value, `v1` included) loads: the key is ignored,
  and `problems` reports each as retired (`planner: retired, the loop always plans with v2, and
  ignored`), which `/factory config` shows.
- `mode` (`off`, `observe`, `act`) keeps its meaning (D-03). Observe mode runs v2's plan and logs
  it; it never executes, never writes the store and never writes an event (its commands get the
  observe sink, 13.11.1, D-10).
- The two plan call sites, `act.ts` (an acting pass) and `register.ts` (a pass that does not act),
  call `planV2`.
- The decision log line and the `loop_passes` event keep their `planner` field, always `v2`.
  `/factory status` no longer names a planner, and the `planner` op is gone.
- v2's records are read, never written, in an observe pass: the stored records when act mode wrote
  them, else a rebuild from events (3.3).
- `scripts/factory-loop-replay.js` plans with v2 and takes no `--planner`.

### 2.4 What v2 reads

The loop reads these sources each pass, and no `runs` source (no-mistakes run data):

| Source | Command | Cadence | Notes |
|---|---|---|---|
| `factory` | `callum-flow-factory-state --format json --github off` | every pass | claims, their holders and lapses. `nomistakes.runs` is optional in that tool, so no-mistakes data can never blind the loop |
| `facts` | `dev-query --factory` with `NEW_EVENTS_SQL` (`eventsSource` `old`: `dev-query` with `EVENTS_SQL`, 3.3) | every pass | the facts include the three states of the emitter (7.1); which facts are logged is in 7.2 |
| `queue` | `queue-watch.sh --once` | `queueEveryMs`, and on the next pass after any `label` action of the loop's own ended done | the merge queue's view |
| `github` | one `callum-flow-issue-read --json --issues N,...` call for the issues due this pass (single `--json N` reads on an image whose reader exits 2 on `--issues`) | `githubEveryMs`, and on the next pass after a `label` action of the loop's own on the issue ended done (so the loop sees what GitHub took, not its cached view) or a `prs` read showed its PR closed or merged after the issue's last read (4.1) | the read set is the records' issues (their state, for `issue-closed`; for a parked record its labels, the unpark signal, 4.1), the queue and `only` |
| `usage` | `usage-check.sh` + `$.session.usage()`; in API-key mode (13.5.2 G3) the session's `cost.usd` and the stored tally instead | `usageEveryMs` | usage tiers (13.5.2) |
| `leases` | `treehouse status --json`, holders only; no reflog reads | every pass | the slot pool's holders, read without inference |
| `checkout` | `git status --porcelain=v2 --branch --untracked-files=no` of the main checkout, and HEAD | `checkoutEveryMs` | a tripwire only (10.7). The read also carries the branch's upstream and its ahead and behind counts (null when git prints none) |
| `milestone` | `callum-flow-milestone show next`; `gh release view --repo R --json tagName` for the newest release tag whenever the milestone exists (rule O4; also while a stored record waits on a `tag-contains` condition, even when the milestone does not qualify), and a list of the milestone's closed issues (`--json closedAt`, limit 200) for the oldest `closedAt` (null on a full list of 200 or a failed read; rule O5), both skipped in a GitHub backoff; the same for each other repo a waiting record's `tag-contains` condition names (kept per repo, dropped once no record names it) | `milestoneEveryMs` | the release task; also yields the numbers of the open issue lines (`openIssues`, PR lines not included), for the reopen case of O3; the tag view is in 8.7 |
| store | `ledger:<repo>`, `records:<repo>`, `heads:<repo>`, `files:<repo>`, `stamps:<repo>` (the intake stamps, `{ v: 1, stamps: { "<issue>": { version, area, needsOwner, touches, at, labels } }, tries?: { "<issue>": { version, outcome, at, reason? } }, owned?: { "<issue>": ["area" \| "needs-decision"] } }`; each entry checked field by field, one that does not read dropped, an absent or malformed key the empty store; written only by the intake run, 13.4.4, as a read-modify-write that keeps keys it does not know) | every pass | the records are in 3.3 |
| `prs` | for each record in reviewing or merge-queue whose life has a PR (the record's, else the one the life's done ensure named, 8.1): `callum-flow-issue-read --json --pr <n>` (state, merged, merged head, `closedAt`, head sha, `mergeable_state`, author, base sha) and `gh pr checks <n> --repo R --json name,state,bucket,startedAt,completedAt,link` (with the run id from the link) and the head's workflow runs, `gh api repos/R/actions/runs?head_sha=<head>&per_page=100` (8.5); the head's patch id (8.4) when the head moved | `prEveryMs`, and on the next pass after its record's transition or an action of the loop's own on the PR ended; a PR whose last read failed, every pass | the PR view of the records; the due records are read up to 4 at once, started in 2.4's order, with results kept in it |
| `waits` | for each distinct condition of the waiting records not yet read as held: an issue by `callum-flow-issue-read --json N` (its open or closed state), a PR by `gh pr view N --repo R --json state,mergedAt`, a release tag by `gh api repos/R/compare/<tag>...<sha> --jq .status` against the newest release tag (`gh release view --repo R --json tagName`, read on `milestoneEveryMs` while a record waits on one); no model call | `githubEveryMs` per condition (a tag condition once per tag), oldest-checked first, at most K reads a pass (the PR reads' budget); none during a GitHub backoff or after a rate limit met this pass | a failed or skipped read keeps the condition open and never clears it; a condition once read as held stays held while a record waits on it (4.4). A failed read, or a tag condition whose repo has no release tag, starts that condition's unread time (`V2State.waitsUnread`, why `read-failed` or `no-release`); a read that says held or not held, or a stored read against a known tag, clears it, and a read skipped for the budget, a rate limit or a backoff leaves it as it was |
| `blockers` | only while a starved spell (S1) is `starvedNoticeAfterMs` old: from each queue issue with open blockers, `callum-flow-issue-read --json N` for it and for each open blocker of this repo not read yet (its `blocked_by` list), breadth first, at most 40 reads and 8 levels; a blocker of another repo is named, never read | once per spell and 24 h period of it (period `k = floor((spell age - starvedNoticeAfterMs) / 24h)`); none during a GitHub backoff, and it stops at a rate limit | the tree (`V2State.blockers`: per issue its open state, labels, title, open blockers, foreign blockers, and whether its read was refused (exit 3) or failed; a `truncated` flag and an error) that rule S1's starved notice walks for the root blockers. The spell's start is the store's `starved:<repo>`, handed to the plan as `V2State.starvedSince` |
| `releasePrs` | `gh pr list --repo R --state open --limit 1000 --json number,headRefName,headRefOid,createdAt,isCrossRepository`, kept to the PRs whose `headRefName` starts with `releaseBranchPrefix` and which are not from a fork; per listed PR its head commit's time (`gh pr view N --repo R --json headRefOid,commits`, once per head) and its checks (`gh pr checks`, the bucket of each: `fail` or `cancel` is red, `pending` or none reported is pending, else green; with the earliest check start); a PR that left the list is read once with `gh pr view N --repo R --json state,mergedAt` for how its hold ended | `prEveryMs`; only while `releaseBranchPrefix` is set, `releaseHold` is above 0 and some record is in merge-queue; none during a GitHub backoff or after a rate limit met this pass | the release hold of the merge queue (9.1). A failed list read keeps the last reading and shows in `sources`; a failed head or checks read keeps the last reading of the same head, and a new head with none is held as pending, bounded by its window |
| `main` | act mode only: `gh api repos/R --jq .default_branch` (once per load), `gh api repos/R/commits/<branch> --jq .sha`, `gh api repos/R/commits/<head>/pulls` (only when the head moved), `gh api repos/R/actions/workflows?per_page=100` (the active workflows), for each `gh api repos/R/actions/workflows/<id>/runs?branch=<b>&per_page=10`, then `gh api repos/R/deployments?sha=<head>&per_page=100` (the newest of each environment) and for each `gh api repos/R/deployments/<id>/statuses?per_page=1` | `mainEveryMs`; none during a GitHub backoff or once a rate limit met this pass ends the loop's reads (checked before each call). When skipped or not yet due, the last reading stands | the `main_state` event (7.1, rule M1). Any failed call, or output not understood, fails the whole read: `sources.main` is not ok and the pass carries no reading, so a partial read is never shown as green |
| `paths` | only while `intakeStamp` is `on`, for each record that is not closed and has a `head`, and only when the default branch is known (`checkout.defaultBranch`): `git fetch` of the base ref, `git fetch origin <head>` when the head is not here (as `callum-flow-patch-id`), then `git diff --name-only --no-renames <merge-base>..<head>`; each path is cut to its first segment, de-duplicated and sorted | once per `<issue> <head>`: a successful read is cached until the head moves; a failed read is null for that record this pass and is tried again on a later pass; nothing is read during a GitHub backoff or once a rate limit ended this pass's reads | the in-flight paths the `overlap` score factor reads (3.5, S1); while `intakeStamp` is `off` no git command runs for it |
| `flakes` | act mode only: `dev-query --factory --csv -v repo=R -v since=<now - flakeWindowDays>` with the per-flake query of metrics 2d (a gate flake and a CI flake, each once; one row per flake per test with the first row's event id and the test name's hash), then, only when some test has `flakeBugMin` flakes, `callum-flow-issue-read --json --list --label flaky --state open` (the reader lists trusted authors only) for the open flake bugs: number, marker, whether labelled `ready`, the flake ids its body names | `githubEveryMs`, and at once after an action of rule F1 ended; none during a GitHub backoff or after a rate limit | rule F1 (8.5). A missing factory URL (`dev-query` exit 77) is no flakes; any other failure or an unreadable list fails the source, and F1 plans nothing (`V2State.flakes`, `sources.flakes`) |
| `dualWrite` | act mode only: `callum-flow-event --new-only --new-path --repo R` (exit 0: the image dual-writes and offers `--new-only`, and stdout is the new log's path; any other exit, an older image or one that dual-writes without `--new-only`: off, so H1 plans nothing), then a read of that log | once per load; a failed probe or read retries every `githubEveryMs` | its failure blocks nothing (4.1) |

- **Heads first seen.** Observe keeps, in the store key `heads:<repo>`, the time it first saw each
  PR head. Plan uses it to bound waits on GitHub (4.4). Entries go when their PR closes.
- **The PR cadence.** A PR read costs about two GitHub calls, so at a 10 s pass a PR read every
  pass took about 720 calls an hour, and K PRs most of the account's shared 5,000.
  A PR's read stands, with its own time, until it is due: `prEveryMs` (30 s) after it, or at once
  when something the loop knows changed it, its record's transition (any change of the record) or
  an action of the loop's own on the PR (an ensure, an update, a merge, a CI re-run) that ended
  after it. The queue and the issue reads take the same rule with their own cadences and signals
  (a label write, a PR's close). Main's head on origin (9.2) is read every pass a merge-queue PR
  is open, whatever the PR's cadence, so Q1 sees main move at once; its update is an action on the
  PR, so the head's read is due on the next pass. A wait on GitHub is judged at the read (4.4).
- **Read order.** GitHub reads are taken in this order until the pass's budget is spent: the merge
  queue's head, the other records in reviewing and merge-queue, parked and waiting records, the other
  records, then the queue and the rest. The PR reads are bounded by K records and run up to 4 at once (`PR_READ_CONCURRENCY`), started in this order, their results kept in it, and no record starts once a rate limit is met; the issue reads
  are capped at 12 per pass (`GITHUB_READS_PER_PASS` in `observe.ts`); the open issues that the
  read issues block (`blockingList`) join the read set after every other reason, so a chain never
  starves the issues the loop acts on. All are skipped during a
  GitHub backoff (13.10 item 2).
- **The companion's log** (`<loop dir>/companion.jsonl`, 7.2) is read each pass with the loop
  dir's answer files (10.8), not as a source of its own. Its gate lines also give the `gate_run`
  events (10.6).
- **Not read:** a mirror of every `factory:*` label, a 5-minute scan of open PRs (the `releasePrs` list is read only while a hold can apply)
  and the session environment. The loop has no rule that needs them. Main's check runs are read by the `main` source, only to be logged (9.5).

### 2.5 Module layout

The loop's code is split so that no file grows large. The root of `plugins/factory-loop/hooks/` holds
the foundation (section 13) and the glue:

- **Registration and passes.** `register.ts` (the plugin entry), `passes.ts`, `pass-summary.ts`
  and the `driver-*.ts` modules (`driver-pass`, `driver-state`, `driver-store`, `driver-io`,
  `driver-controls`, `driver-between`, `driver-pass-log`).
- **Observe.** `observe.ts` with `observe-github.ts` and `observe-milestone.ts`, `derive.ts`,
  `parse.ts` and `state.ts`.
- **Act.** `act.ts` (the dispatcher and `EXECUTORS`) with `act-cli.ts`, `act-merge.ts`,
  `act-between.ts` and `exec.ts`.
- **Control.** `control.ts` with `control-files.ts` and `control-help.ts`.
- **Configuration.** `config.ts` with `config-keys.ts` and `config-view.ts`.
- **Shared.** `foundation.ts`, `rails.ts`, `ledger.ts`, `wake.ts`, `prompts.ts`,
  `report.ts`, `trace.ts`, `within.ts`, `types.ts` and the answer contract (`contract.mjs`).

`hooks/v2/` holds the loop itself, one module per area and kind:

- `rules-*` (what to plan): `rules-agent`, `rules-claim`, `rules-dualwrite`, `rules-entry`,
  `rules-fleet`, `rules-gates`, `rules-interventions`, `rules-queue`, `rules-review`,
  `rules-slots`, `rules-state`, `rules-work`.
- `steps-*` (how a step runs and reads its answer): `steps`, `steps-queue`, `steps-review`,
  `steps-triage`, `steps-work`.
- `act-*` (executors): `act-ci`, `act-events`, `act-pr`, `act-queue`, `act-review`, `act-slots`,
  `act-split`, `act-state`, `act-tracker`.
- `contracts-*` (answer checks): `contracts-review`, `contracts-triage`, `contracts-work`.
- `prompts-*` (agent prompts): `prompts-review`, `prompts-triage`, `prompts-work`.
- `sources-*` (what observe reads): `sources-dualwrite`, `sources-interventions`, `sources-prs`,
  `sources-release`, `sources-waits`, `sources-workspace`. The release hold is `rules-release-hold`.
- The named singles: `plan.ts`, `observe.ts`, `registry.ts`, `table.ts`, `record.ts`,
  `reconcile.ts`, `events.ts` with `event-reader.ts` and `event-schemas.ts`, `release.ts`,
  `lives.ts`, `keys.ts`, `store.ts`, `settings.ts`, `ops.ts`, `argv.ts`, `workspace.ts`,
  `wind-down.ts` with `wind-down-files.ts`, `question.mjs`, `reviewer.ts`, `park-text.ts` and `types.ts`.

Rules for the layout:

- **The pure planner is a thin composer.** `hooks/v2/plan.ts` calls the `rules-*` modules in a
  fixed order and merges their actions. It holds no rule of its own.
- **The table is data** (`table.ts`, 4.6), not code paths.
- **A foundation file gains a call into a `hooks/v2/` module, not logic.**
- **The size guard.** `npm run lint` (`scripts/lint.sh`, through `scripts/size-guard.sh`) fails
  when any file under `plugins/factory-loop/hooks/` is over 600 lines. The allowlist
  (`HOOKS_OVERSIZED` in `scripts/lint.sh`) is empty, so every file is held to 600. A new oversized
  file is split, never listed.

## 3. The record and the labels

### 3.1 States

The owner's label set, exactly:

| State | Label | Meaning | Holds a slot | In flight |
|---|---|---|---|---|
| queued | `factory:queued` | claimed, no slot yet | no | no (but it limits claims, S1) |
| designing | `factory:designing` | the designer works in the slot | yes | yes |
| building | `factory:building` | the implementer (the builder) works in the slot | yes | yes |
| reviewing | `factory:reviewing` | the reviewer and CI on the PR | yes | yes |
| fixing | `factory:fixing` | a fixer on review findings, red CI or a conflict | yes | yes |
| merge-queue | `factory:merge-queue` | approved and green, waiting to merge | yes | yes |
| parked | `factory:parked` | waits on the owner; frees its slot and leaves the in-flight count | no | no |
| waiting | `factory:waiting` | waits on a condition the loop checks; frees its slot and leaves the in-flight count; resumes by itself | no | no |
| closed | no label | done or dropped; terminal | no | no |

Retries and triage are steps inside a state. The label does not change while they run.

**Waiting versus parked.** Both free the slot and leave the in-flight count, keep their claim (H1
renews it) and keep the life's scratch folders. Parked waits on a person: only the owner's resume
ends it. Waiting waits on facts the loop reads itself (8.7): when they all hold, the loop resumes
the record; the owner may still resume or drop it (11).

### 3.2 The record

```ts
type IssueState = 'queued' | 'designing' | 'building' | 'reviewing' | 'fixing' | 'merge-queue' | 'parked' | 'waiting' | 'closed'
type StepKind = 'lease' | 'design' | 'build' | 'review' | 'fix' | 'queue' | 'triage'
type WaitCondition = { kind: 'issue-closed'; issue: number } | { kind: 'pr-merged'; pr: number }
type ClosedWhy = 'merged' | 'merged-by-hand' | 'dropped' | 'split' | 'closed-on-github' | 'claim-lost' | 'done'  // 'done': read-only until its producer ships (#1022)

type IssueRecord = {
  issue: number
  life: string                 // the claim's start time in base-36 seconds: unique per life (3.3)
  seq: number                  // +1 on every transition; part of every per-seq key
  seqAt: Ms                    // when this seq's transition happened
  state: IssueState
  since: Ms                    // when it entered this state
  resumeTo: IssueState | null  // queued: where a lease leads (default designing); parked, waiting: where a resume leads
  branch: string               // fixed for the life (3.5)
  pr: number | null            // adopted at claim, or set when reviewing ends; until then the ensure's (8.1)
  head: string | null          // the head a writer step last confirmed on origin
  approvedPatch: string | null // the patch id the reviewer approved (8.4)
  brief: string | null         // the design brief comment URL
  step: StepKind | null        // the step this seq runs: the state's own, or 'triage'; null when waiting
  attempt: number              // attempt of that step: 1 or 2 (5.1)
  cut: boolean                 // this attempt already had its one free re-run (U1)
  triages: number              // triage calls in this life, at most maxTriages
  fixes: number                // entries to fixing in this life for a round not caused by other merges, at most fixCap (reviewFixCap)
  conflicts: number            // entries to fixing in this life for a round caused by other merges (a conflict, or red CI in the merge queue), at most conflictFixCap
  round: number                // entries to reviewing in this life
  question: string | null      // parked: the question for the owner
  parts: ParkParts | null      // parked: the parts of that question when an agent structured it (below); null in any other state
  wait: WaitCondition[] | null // waiting: 1 to 8 conditions (issue-closed and tag-contains may carry an optional repo), every one of which must hold; null in any other state
  why: ClosedWhy | null        // closed: why
  notes: string[]              // owner, triage and decline notes for the step of this seq
  prClosedAt: string | null    // GitHub's closedAt of the newest hand close the record has handled (E4, P1)
  lives: number                // this life's number since the issue's count last started (6.4): 1 for the first
}
```

- Step, attempt, round and the approved patch live in the record.
- Each claim of an issue is one life, and the record counts lives (owner, 2026-10-15). S0 sets
  `lives` from the issue's earlier lives (6.4, "Lives"); the count starts again with the first
  claim after a rejection.
- The slot is not a record field. A record holds the slot whose lease holder is
  `factory-loop:<N>:<life>` in the `leases` source (10.1).
- A step's ledger keys follow from the record (appendix C). Their status and start time are the
  ledger entry's, so starting a step does not change the record.
- Notes belong to a seq. A same-state row keeps them and adds its own; a row that changes the state
  replaces them with its own.
- A record that parks from queued or waiting keeps that state's own `resumeTo`, so "resumeTo same
  state" in the rows below means that target, never queued or waiting itself.
- `wait` is set only in waiting. The transition note carries it as the token `wait=issue:57,pr:812`
  (`issue:<n>` for an issue to be closed, `pr:<n>` for a PR to be merged, `tag:<sha>` for a release
  tag that carries a commit, comma-joined; an issue or tag condition on another repo takes the long
  form `issue:<owner>/<name>#<n>` or `tag:<owner>/<name>@<sha>`, repo lower-case) and
  `wait=none` in any other state; `parseTransition` rebuilds `wait` from it, and a note without the
  token (from before it) reads as null.
- `parts` is set only on the parks whose question an agent structured, and only while parked: T3
  (the designer's question), X4 when the triage chose `park`, and S7 for a not-ready split child with
  a checked `decision` object (a legacy child, or one whose question came from `## Open decisions`,
  has none). Every other park, and every other state, has `parts: null`; a row that sets `question`
  without `parts` clears it, so `parts` never outlives its question. `ParkParts` is
  `{ decision, context, options, recommended, recommendation }`: `decision` is the agent's own
  one-sentence question (`question` is the rendering of the whole, unchanged), `context` text or
  null, `options` null or 2 to 6 `{ key A-F, title, detail | null }` with distinct keys,
  `recommended` the key of the recommendation (only one of the options) and `recommendation` its
  reason. The transition note carries them as five tokens right after `question=`:
  `decision=`, `context=`, `recommended=` and `recommendation=` in the text encoding
  (a literal `none` is written `%6Eone`), and `options=` as the percent-encoded compact JSON of the
  list; all five are `none` when `parts` is null. `parseTransition` rebuilds `parts` from them: a note
  without `decision=` (from before) or with `decision=none` reads as null, and an `options=` that is
  not a valid list makes the note not read. The new log's transition payload carries the same five
  fields (`decision`, `context`, `options`, `recommended`, `recommendation`), and a stored record
  carries `parts`; a record or row without them reads as null.

### 3.3 Where it lives, and how it changes

- **Store.** `records:<repo>` = `{ v: 1, savedAt, records: IssueRecord[] }` in `$.store`, beside
  the ledger (13.7.1).
- **One writer.** Only an acting pass under the act lock writes it. Observe passes only
  read it.
- **Only the `transition` executor changes a record** (4.6). It does two things:
  1. it re-checks the row's trigger against the live ledger and records (the step entry and the
     status the plan saw, or the GitHub fact). When the trigger no longer holds, for example
     because an answer arrived after the plan, it does nothing and the next pass plans again;
  2. it stores the next record with a compare on `(issue, life, seq)`.
- **The ledger is the outbox.** Every effect of a transition is an entry action of the new seq
  with its own key (4.5): the `transition` event, stopping the old step, the label and the rest.
  A crash after the store write leaves the entry actions planned on the next pass, so no event is
  lost. The `transition` entry carries its row, the state and
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
  A claim never becomes a ghost.
- **Life.** The start time of the claim action, in base-36 seconds: unique, and needs no counter
  that pruning could reset.
- **Pruning.** A closed record goes 7 days after it closed, as ledger entries do (13.7.1).
- **Rebuild.** With no records in the store (a new device, a wiped config), act mode rebuilds them
  from this device's `transition` events: the newest per issue over 90 days. The event's note
  carries every record field (7.1); `recordsFromEvents` in `hooks/v2/record.ts` parses it with
  `events.ts`. A step in flight is not rebuilt: S2 starts the same attempt again, and an
  agent step first looks for an answer already recorded for its key (10.8).
- **Source switch.** The setting `eventsSource` (`old`, `new`, `shadow`; default `new`; next pass; an
  invalid value is a config problem and reads `old`) picks where the rebuild reads
  (`hooks/v2/sources-records.ts`). `old` reads `factory.events` as above. `new` reads this device's and
  repo's `transition` events from `factory.event_store` (`dev-query --factory --csv`, `NEW_REBUILD_SQL`),
  each row through the shared reader (`event-reader.ts`) into the same record: a row of an unknown type or
  version, or whose payload the reader refuses, fails the whole read (the `store` source is not ok, its
  error names the event_id and the source `new`), a missing factory URL (`dev-query` exit 77, 78) too, and
  no row is skipped. `shadow` reads both stores once per load and then at most hourly, whether or not the
  store holds records, rebuilds records from each, compares them per issue and field (object key order ignored) with both sides cut
  600 s back, and writes one `shadow_read` event (`reader` `loop-records`, `tool` `factory-loop`; rule H1,
  key `records-shadow:<time>`). The records still come from the store, else the old read; a failing new
  read never fails the pass. A compare with differences tells the owner once per distinct set of issues
  (`tell(records-shadow)`, key `tell:records-shadow:<issues>`; it names the issues, the first difference
  and the way back, `/factory config set eventsSource old`).
- **The same switch for the facts and the ledger rebuild.** `eventsSource` also picks where the `facts`
  source (every pass, 3 days) and the ledger rebuild of a lost store (7 days, 13.7.5) read
  (`hooks/v2/sources-facts.ts`), and with them the events v2's `logged` once keys come from (7.2). `old`
  is `EVENTS_SQL` through `dev-query --csv`, as above. `new` is `NEW_EVENTS_SQL` through
  `dev-query --factory --csv`: the types `requeued`, `claimed`, `claim_renewed`, `merged`, `loop_entry`,
  `intervention`, `reviewed` and `ready`, and `closed` written by the sweep, over all devices. Each row goes through
  the shared reader and becomes the `FactoryEvent` that `factsOf`, `deriveLedger` and `onceKey` read, with
  the old state name (`requeued` as `reclaimed`, `claim_renewed` as `renewed`, `loop_entry` as `loop`), the
  time cut to whole seconds as the old log stores it, and a note built with the writer's own encoders
  (`eventNote`, `loopNote`). A row of an unknown type or version, or one the reader refuses, fails the
  whole read (the `facts` source is not ok, its error names the event_id and the source `new`), a missing
  factory URL too, and no row is skipped. Under `new` the facts no v2 path reads (`briefs`, `reviewFixes`,
  `verdicts`, `superseded`, `answered`, `pipeline`: only `runsFromEvents` reads them, and only the plan
  replay and the state digest read its runs) are empty. `shadow` decides on the old read and, once per load
  and then at most hourly, also reads the new one and compares, with both sides cut 600 s back, the newest
  `reclaimed` and the newest `ready` per issue, this device's derived ledger (the entries the loop logged lose their outcome and
  their run, PR and head columns on both sides, which the new `loop_entry` does not carry) and the set of
  once keys. It writes one `shadow_read` event (`reader` `loop-facts`, `tool` `factory-loop`; rule H1, key
  `facts-shadow:<time>`; `diff_keys` are `reclaimed:#N`, `ready:#N`, `ledger:<key>` and `once:<key>`); a failing new read
  never fails the pass and is a compare with `new_ok` false. A compare with differences tells the owner once
  per distinct set of keys (`tell(facts-shadow)`, key `tell:facts-shadow:<keys>`, with the first difference
  and the way back). Before comparing, the shadow reads each device's first new-store time for the repo
  (`NEW_FLOORS_SQL`, one `dev-query --factory` read, only on the compare pass) and drops from both sides the events of
  a device older than its floor: the production new store holds only dual-written events, so the old window reaches
  back before its history begins. Events of a device with no new row, and events with no device, stay. The event
  carries `scope_floor` and `out_of_scope`; a failing floor read is a compare with `new_ok` false.

### 3.4 Labels

- **Names.** `factory:queued`, `factory:designing`, `factory:building`, `factory:reviewing`,
  `factory:fixing`, `factory:merge-queue`, `factory:parked`, `factory:waiting` (the last is
  the waiting state, 3.1). Colours and descriptions
  are in appendix D.
- **`factory:rejected`** (owner, 2026-10-15) is a ninth label and no state: the issue is out of
  the factory. R1 sets it in place of `ready` when it releases an issue at its `maxLives`-th life
  (6.4). S1 never claims an issue that carries it, whatever else it carries. The owner removing
  it and adding `ready` brings the issue back as a first life (a person intervention, `unreject`,
  7.2). The factory tools take it as no stage (3.6).
- **Exactly one** `factory:*` state label on the issue of an active or parked record; none on a
  closed one.
- **One writer.** The loop is the only writer, except that the owner removing `factory:parked` is
  the resume signal. Removing `factory:waiting` is not one: a waiting record resumes
  when its conditions hold or by `/factory resume N` (11).
- **The record is the authority and the label its mirror**. A state change's entry
  action `label` writes it in one call: `gh issue edit <N> --repo R --add-label <new>
  --remove-label <the other seven>`. The loop does not read labels back to correct them: there is no
  mirror check and no label-drift intervention. Stale label reads made such a check undo parks
  and log false touches.
- **The one label read.** For a parked record, the `github` source reads the issue directly. A
  read made after the park's `label` action finished (it comes on the next pass, 2.4) that lacks
  `factory:parked` is the unpark signal (4.1). Older reads are ignored. The label list is not used, because it lags behind
  edits (`images/base/callum-flow-sweep`).
- **Creation.** Action `label` with op `ensure` once per module load, and again after a label write
  fails with a missing label: `gh label create <name> --repo R --color <c> --description <d>
  --force` for each of the nine (the eight state labels and `factory:rejected`). `--force`
  updates a label that exists.
- **No claim label.** The loop neither writes nor reads `In development` (owner, 2026-10-15). The claim
  is the claim comment and its `claimed` and `renewed` events; the `factory:*` label shows the
  state. The claim tools change to match (3.6). A closed record's `label` op `clear` removes every
  `factory:*` label, unless another device holds a live claim on the issue: then it removes none,
  because the winner owns the labels (`images/base/callum-flow-claim`).
- **The owner's `parked` label.** The owner's own `parked` label
  convention (`skipLabels`, D-17) is unrelated and unchanged.

### 3.5 One branch, one PR, one slot per life

- **The branch is `issue-<N>`, for every life**:
  - At claim, the `claim` executor lists open PRs once (`gh pr list --repo R --state open --limit
    1000 --json number,headRefName`; gh lists 30 without a limit). An open PR by a trusted author on a branch matching
    `(^|/)issue-<N>(-|$)` is adopted: the branch is that PR's head branch, `pr` is set, and
    `resumeTo` is `reviewing` (the review reads the whole diff, 8.3). With several, the newest is
    adopted and the others are named in the transition note and left alone.
  - Otherwise the branch is `issue-<N>`. When origin already has it, from an earlier life or a
    released ghost, the work continues from its head: the slot is prepared from it and the builder
    merges main when it needs to. Nothing on origin is ever reset.
- **No `-vN` branches, no superseded PRs.** The loop never force-pushes, never rebases a pushed
  branch and never closes a PR, and the write guard stops agents doing any of these (10.4).
- **The PR** is opened, adopted or reopened by the loop on each entry to reviewing (8.1).
- **The slot** is leased when the record leaves queued and freed when it parks or closes (10.1).

### 3.6 The claim tools without `In development`

The owner dropped `In development` (section 15). The claim, heartbeat and sweep tools
(`images/base/callum-flow-claim`, `images/base/callum-flow-sweep`) and the factory-state view
(`images/base/callum-flow-factory-state`) neither write nor read it:

- **`callum-flow-claim <N>`.** The winner removes `ready` and assigns @me. It no longer adds
  `In development`. A device's own live claim after a restart does the same while this device's
  event log shows it held (its last claim event is `claimed`). Any other own live claim (one
  interrupted before its event, or left behind by `ready`, `reclaimed`, `merged`, `closed` or
  `abandoned`) is deleted and the claim made fresh, so every life starts with one `claimed` event.
- **`callum-flow-claim --heartbeat`** with no numbers renews this device's live claims on the open
  issues this device holds, not the label list and not `callum-flow-factory-state` (a `merged` issue
  stays in its list with this device as holder). "Holds" is one rule, shared by the heartbeat, the
  sweep and `callum-flow-claim <N>` (`images/base/claim-events.sh`): this device's event log plus the
  newest claim event per issue in the event store (`factory.events` with the `old` source), ordered by ts; the issue is held when its last
  claim event (`claimed`, `ready`, `reclaimed`, `merged`, `closed`, `abandoned`) is a `claimed` by this
  device. A failed or unconfigured central read falls back to this device's log. The store the rule
  reads is `CALLUM_FLOW_CLAIM_EVENTS_SOURCE`: `new`, the default (`factory.event_log` through
  `dev-query --factory` and the new log, where `reclaimed` is `requeued`), or `old` (as above; the way back). H1 passes
  numbers (14.1).
- **`callum-flow-sweep`.** Its candidates are the issues the event log and factory-state list as
  live, the list its closed-issue pass already reads (`images/base/callum-flow-sweep`), not the label
  list. Rules: a closed issue logs `closed` when its latest event is not final; an open issue with
  a PR merged on its branch after the newest claim (checked before the lease, whoever holds the
  claim) logs `merged --actor sweep` and the issue is left alone; an open issue whose last claim
  event (`claimed`, `ready`, `reclaimed`, `merged`, `closed` or `abandoned`, over this device's log and
  `factory.events`) is not `claimed` is left alone, and no other event revives an ended claim; an open issue whose newest claim expired
  gets `ready` back, is unassigned, gets a comment and logs `reclaimed`; an open issue with no
  claim comment is left alone. It never touches `factory:*` labels: the loop is their only
  writer, and a record whose claim lapsed is claimed again onto itself (4.1).
- **`callum-flow-factory-state`.** For an issue whose life has a `transition` event, the label
  check expects the `factory:*` label of its state. For other issues it checks `ready` only. The
  "GitHub label only" list takes an open issue with a `factory:*` state label (its stage from the
  label) or `ready`, and no events. `factory:rejected` names no stage, and is not flagged on a
  closed record's issue.
- Neither tool reads `CALLUM_FLOW_IN_DEV_LABEL`.
- **`derive.ts`** reads no label: `EVENTS_SQL` and the derivation use events only
  (`EVENTS_SQL` in `derive.ts`), and the records come from events (3.3).
- **The migration** (6.3) removes `In development` from the issues it touches.

## 4. Steps and the transition table

### 4.1 Events

The table's input. Each pass, a record takes at most one event that changes it: the first present
in this order. Rows that change nothing (E6, E7) run beside it and never stop it. A transition pings the driver, so the next event is taken at once (4.6).

1. `pr-merged`
2. `issue-closed`
3. `claim-lost`
4. `drop`
5. `pr-closed`
6. the step's result: `ok`, `not-ok`, `unknown` (a timeout included) or `triage`
7. `cleared`
8. `unpark`

`pr-merged` comes first because a merge cannot be undone, and before `issue-closed` because a merge
with `Closes #N` closes the issue in the same instant.

The order holds across sources. The PRs are read more often than the issue, so a
`pr-closed` waits while the issue's last read is older than the PR's `closedAt`; that read is due on
the next pass (2.4). An issue closed with its PR then closes (E2) and never parks first.

| Event | Raised by | Meaning |
|---|---|---|
| `ok` | the step | the step did what it is for (4.2) |
| `not-ok` | the step | the step answered, and the answer says the work cannot go on as it is; it carries a reason |
| `unknown` | the step | no usable answer (4.2, 5.1), including a timeout of a running step (4.4) |
| `triage` | the triage step | the triage answer's choice (5.2) |
| `drop` | owner | a `control.dropped` entry for the issue newer than the life's claim (an edge: it applies to that life only) |
| `cleared` | the loop | every condition of a waiting record holds, as the `waits` source read them (2.4), none of them failed or skipped |
| `unpark` | owner | a `/factory resume N` entry newer than the park, or a direct read after the park label write that lacks `factory:parked` (3.4); for a waiting record only the `/factory resume N` entry |
| `issue-closed` | GitHub | the issue closed, and no loop merge or `close-issue` of this life is done, running or lost |
| `pr-merged` | GitHub | the record's PR merged at a head that no `queue-merge` entry of this life names (done, running, lost or timed-out). A merge the loop made is the queue step's `ok` instead |
| `pr-closed` | GitHub | the record's PR is closed unmerged, and its `closedAt` is newer than the record's `prClosedAt` (an edge on GitHub's own timestamp) |
| `claim-lost` | claims | another device holds a live claim on the issue, or a re-claim exits 3 |
| `timeout` | the clock | a running step passed its timeout (read as `unknown`), or a waiting state passed its tell period (E6) (4.4) |

GitHub events are edges, not conditions. `issue-closed`, `pr-merged` and `claim-lost` end the
record, so they fire once. `pr-closed` compares GitHub's `closedAt` with the record's
`prClosedAt`. `drop` and `unpark` compare the op's time with the life's claim and the park.

A CI result is not an event of its own. CI belongs to two steps, reviewing and the merge-queue
head. Its result arrives as that step's `ok`, `not-ok` or `unknown` (4.2, 8.5).

**What else runs each pass beside the table:**

- **Re-claim.** H1 renews the claim of every record that is not closed. A record whose claim lapsed
  (the `factory` source shows this device's claim lapsed, or a `reclaimed` event was logged, after
  the record's last claim; never the `ready` label list, which lags, 3.4) is claimed again with
  `callum-flow-claim N`. That keeps the record and its state; exit 3 is `claim-lost`. The re-claim
  logs the record's current `transition` event again, so readers see the stage at once
  .
- **Dual write.** While the image writes the new event log (the `dualWrite` source, 2.4; act mode
  only), H1 logs a `transition` event with `via=dual-write` for every record, open or closed, whose
  current `<issue>:<life>:<seq>` the log lacks. Its key is `dual-write:<issue>:<life>:<seq>`, so
  each stage is logged once. Only a record with `seqAt` before the read counts: the log is read once
  per load, and a later transition was written to both logs by the dual-writing image. The event
  keeps the record's own seq, so a rebuild picks the same record from either log. H1 writes the new
  log only: its action carries `target: 'new'` and the event executor adds `--new-only` to
  `callum-flow-event`, so the old log gets no row (a second row would reach `factory.events` as
  `via=dual-write` and make the sweep log `closed` again for a closed issue). It runs only on an
  image that offers `--new-only` (the probe above); on an image that dual-writes without it, nothing is
  backfilled, which is better than a duplicate in the old log. No other rule sets a target.
- **Pushes by a person.** A head on the record's branch that no loop step produced is a person
  intervention (`push`, 7.2). The loop's own heads are known: the heads that writer steps confirmed,
  and those that `queue-update` produced (9.2). The state's own keys handle the new head: review is
  keyed by patch (8.4).

### 4.2 The step of each state

| State | Step | Who | Role | ok | not-ok | unknown |
|---|---|---|---|---|---|---|
| queued | `lease` | the workspace `slot` op `lease` (10.1) | - | a lease with the record's holder exists | - | - (a lease is an effect: it retries, then holds the record as `stalled`, 4.5) |
| designing | `design` | the designer agent in the slot, then the loop posts the brief or creates the children (8.7) | reader | a brief, posted | a question; a wait on conditions (`wait`); or a split, its children created | the generic agent unknown (below) |
| building | `build` | the builder agent in the slot | writer | a valid answer, and origin's branch, read directly, has commits beyond the base at or past the answered head | the answer says it cannot (with a reason); or origin's branch has no commit beyond the base (`no-commit`) | the generic agent unknown, or the direct read of origin failed |
| reviewing | `review` | `pr` ensure (8.1), then the reviewer agent and CI on the head (8.3, 8.5) | reader | the reviewer approved the head's patch in this round, every check on the head passed or was skipped, and the PR does not conflict | the reviewer asked for changes; a check failed after its one re-run; the PR conflicts (`dirty`), which ends the step once this seq's running reviewer of the head's patch has ended (at once when none runs) | the reviewer's generic agent unknown; a GitHub wait past its bound (4.4) |
| fixing | `fix` | the fixer agent in the slot | writer | a new head on origin's branch, read directly | every finding declined with reasons, and no new head (`declined`); or nothing pushed and a finding fixed outside the branch, such as on the PR description or evidence (`unchanged`) | the generic agent unknown, or the direct read of origin failed |
| merge-queue, the head | `queue` | Q1 and Q2 (9) | - | the PR merged at a head that a `queue-merge` entry of this life names | `conflict`, `ci-red` (a failed check after its one re-run), `patch` (the head's patch is not `approvedPatch`), `policy` (9.3) | a Q1 or Q2 CLI failure; a guard FAIL of class `read`; a refusal GitHub gives no reason for; a GitHub wait past its bound |
| a step state | `triage` | the triage agent (5.2) | reader | a valid answer: its choice is the `triage` event | - | the generic agent unknown |
| merge-queue, not the head; parked; waiting; closed | none | - | - | - | - | - |

- **The generic agent unknown.** No valid answer after one repair message; the turn ended in
  error, aborted or refused; the agent failed or was lost; the step's timeout (4.4). An agent the loop
  itself stopped (a stop-agent names it) that gave no answer is `stopped`, not `agent-dead`.
- Readers may not write inside the repository. Writers may write only inside their slot and push
  only the record's branch (10.4).
- When the usage pre-check skips a spawn, the step has not started and no attempt counts
  (13.10 item 7).

### 4.3 The table

Held as data in `hooks/v2/table.ts` (4.6). The guards on one (state, step, event) are exclusive
and exhaustive. `fixCap` is 3 (`reviewFixCap`, `config.ts`) and `conflictFixCap` is 5 (`config.ts`). `maxTriages` is 2. "Step
states" are designing, building, reviewing, fixing and the merge-queue head. 37 rows. The Events
column names what a row's seq logs. The loop no longer writes a state's own entry event
(`delegated`, `fix_requested`, `merge_ready`): the `transition` beside it carries the same facts (#1141, 7.1).

**A record is made (S1).**

| Id | From | Event | Next | Record |
|---|---|---|---|---|
| S0 | no record | the life's `claim` entry is done | queued | life, branch, `pr` and `resumeTo` from the claim's result (3.5); step `lease` |
| S7 | no record | the life's `claim` entry is done and its outcome carries a `park` (a split's not-ready child, 8.7) | parked | life and branch as S0; step null, `resumeTo` designing, `question` the park's question; notes = one line naming the split parent (`Split from #P: ...`). Via `split-decision`; its entry items are the park's (comment, `factory:parked`, owner tell) |

**Step results (S3).**

| Id | State | Event | Guard | Next | Record change | Events |
|---|---|---|---|---|---|---|
| T1 | queued | ok | - | `resumeTo` (default designing) | round +1 when it leads to reviewing; queued's notes (S0's, P1's) kept: the lease reads none, so they are for the step T1 leads to | transition |
| T2 | designing | ok | - | building | brief set | transition, `delegated` |
| T3 | designing | not-ok | a question | parked | question; resumeTo designing | transition |
| T4 | designing | not-ok | a split | closed | why split | transition, `abandoned` (split into ..., with the designer's reasons) |
| T16 | designing | not-ok | a wait (also an upstream request, once its issue is raised, 8.7) | waiting | `wait` set to the answer's conditions; resumeTo designing; the reason to notes | transition |
| T18 | designing | not-ok | a done close | closed | why done; the evidence line (`done: PR #N (merge <sha7>)`, `commit <sha7>`, the run-it URL) to notes | transition |
| T5 | building | ok | - | reviewing | head set; round +1 | transition |
| T6 | building | not-ok | triages < max | building, step triage | attempt 1; triages +1; cut cleared | transition |
| T7 | building | not-ok | triages = max | parked | question (the builder's reason); resumeTo building | transition |
| T8 | reviewing | ok | - | merge-queue | approvedPatch and pr set | transition, `merge_ready` |
| T9 | reviewing, merge-queue | not-ok | changes, `ci-red` or `conflict`; the counter of the not-ok's kind is under its cap (a base-caused not-ok, 8.6: conflicts < conflictFixCap; any other: fixes < fixCap) | fixing | that counter +1 (`conflicts` for a base-caused not-ok, else `fixes`); pr set; findings, failed checks or the conflict to notes | transition, `fix_requested` |
| T10 | reviewing, merge-queue | not-ok | changes, `ci-red` or `conflict`; the counter of the not-ok's kind is at its cap | parked | question (the fix cap, or for a base-caused not-ok the cap of rounds for conflicts and red CI after other merges, naming the count; with the findings); resumeTo fixing; pr set | transition |
| T11 | fixing | ok | - | reviewing | head set; round +1 | transition |
| T12 | fixing | not-ok | `declined` | reviewing | decline reasons to notes; round +1 | transition |
| T17 | fixing | not-ok | `unchanged` | reviewing | fixed and decline reasons to notes; round +1; via `unchanged` | transition |
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
| E6 | timeout | a waiting state: queued (6 h), the merge queue behind its head (2 h), parked (24 h), waiting (24 h) | same state | - | `tell(waiting)` (for a waiting record, naming the conditions still open), `tell(wait-unreadable)` (an owner item) instead of it when an open condition has been unread a whole period, or `tell(parked)` as the daily reminder; once per period |
| E7 | any event with no meaning in the state | - | same state | - | logged in the decision log |

E7 covers, for example: a late result of a step whose seq has ended; `pr-closed` while parked;
`unpark` of a record that is not parked or waiting (the op answers "not parked; use `/factory note N`"); `cleared` of a record that is not waiting;
`pr-merged` or `pr-closed` with no PR; and every event in closed.

**Waiting (S6).**

| Id | Event | Next | Record change | Events |
|---|---|---|---|---|
| C1 | cleared | queued | resumeTo kept (designing); attempt 1, triages 0, cut cleared; `wait` cleared; notes = one line naming each cleared condition (`The loop resumed this: #57 closed, PR #812 merged; every condition holds.`), which T1 carries to the designer | transition |

**Parked and waiting (S6).**

| Id | Event | Next | Record change | Events |
|---|---|---|---|---|
| P1 | unpark (a parked or waiting record) | queued | resumeTo kept; attempt 1, triages 0, fixes 0, conflicts 0, cut cleared; prClosedAt set to the PR's `closedAt` when it is closed, so the resumed step reopens it (8.1); notes += the op's note, or (label route) the owner's tick in the park comment (`Owner chose option A: <title>`, 11) followed by the trusted comments posted after the park comment | transition |

Interventions (7.2) are not listed per row. `rules-interventions.ts` derives them from each done
`transition` entry (its row and event) and other facts, so the rows above stay as they are.

**Totality.** Every cell names its rows. "-" never appears.

| State | ok | not-ok | unknown | triage | drop | cleared | unpark | issue-closed | pr-merged | pr-closed | claim-lost | timeout |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| queued | T1 | E7 | E7 | E7 | E1 | E7 | E7 | E2 | E3 or E7 | E4 or E7 | E5 | E6 |
| designing | T2 | T3, T4, T16, T18 | U1-U4 | X1-X5 | E1 | E7 | E7 | E2 | E3 or E7 | E4 or E7 | E5 | U1-U4 |
| building | T5 | T6, T7 | U1-U4 | X1-X5 | E1 | E7 | E7 | E2 | E3 or E7 | E4 or E7 | E5 | U1-U4 |
| reviewing | T8 | T9, T10 | U1-U4 | X1-X5 | E1 | E7 | E7 | E2 | E3 or E7 | E4 or E7 | E5 | U1-U4 |
| fixing | T11 | T12, T17 | U1-U4 | X1-X5 | E1 | E7 | E7 | E2 | E3 or E7 | E4 or E7 | E5 | U1-U4 |
| merge-queue | T13 | T9, T10, T14, T15 | U1-U4 | X1-X5 | E1 | E7 | E7 | E2 | E3 | E4 | E5 | U1-U4 (a running step) or E6 (waiting) |
| parked | E7 | E7 | E7 | E7 | E1 | E7 | P1 | E2 | E3 | E7 | E5 | E6 |
| waiting | E7 | E7 | E7 | E7 | E1 | C1 | P1 | E2 | E3 or E7 | E4 or E7 | E5 | E6 |
| closed | E7 | E7 | E7 | E7 | E7 | E7 | E7 | E7 | E7 | E7 | E7 | E7 |

A step-state `timeout` exists only while a step runs (4.4), so a held step raises none. A running
step's timeout reaches the table as that step's unknown (why `timeout`), so the merge queue's head
takes U1 to U4; only a record behind the head takes E6. A waiting record's `timeout` is its tell
period (E6) and `cleared` is C1; the step-state columns of waiting hold E7, for it runs no step.

### 4.4 Timeouts

A step's clock counts only the time the step actually runs: from the start of its running ledger
entry (the agent step or the step's own action). A step that admission holds (`noNewWork`,
`serial`, a rate cap, a tier, the breaker, a pause, a GitHub backoff, a stalled effect) has no
running entry, so it cannot time out and spends no attempt. Its skip line names the filter
. Waiting states have a tell period instead.

| State, step | Timeout | Counted from | On expiry | Why this value |
|---|---|---|---|---|
| queued (waiting for capacity) | 6 h | entry | `tell(waiting)`; stays | waiting for capacity is not a fault; 6 h means the factory was full or held for most of a working session |
| designing, design | 45 min | step start | unknown | a healthy design takes a few minutes; 45 leaves room for a long exploration and still catches a stuck designer |
| building, build | 90 min | step start | unknown | A build's p90 is about 60 min; 90 is 1.5 times that. No one command holds longer than 10 minutes (10.5) |
| reviewing, the reviewer | 30 min | the reviewer's start | unknown | a review takes a few minutes; 30 catches a stuck reviewer |
| fixing, fix | 60 min | step start | unknown | a healthy fix round takes about 14 min; a longer wait only keeps a stuck fixer |
| a step state, triage | 15 min | step start | unknown | one bounded call |
| merge-queue (behind the head) | 2 h | entry | `tell(waiting)`; stays | a PR waits behind at most K - 1 heads |
| parked | 24 h | entry, then each reminder | `tell(parked)` reminder; stays | one reminder a day |
| waiting | 24 h (`stateTimeoutMs.waiting`) | entry, then each tell | `tell(waiting)`, naming the conditions still open; stays | the conditions are checked every pass, so 24 h without them holding is long enough for the owner to look; one tell a day, not an owner item - except `tell(wait-unreadable)`, which is one when a condition could not be read for the whole period |
| closed | none | - | - | terminal |

**Waits on GitHub** have their own bound, the same in reviewing and at the merge queue's head. A
step waiting on GitHub, with nothing of its own running, is unknown when either holds:

- no check has started on its head `ciStartMs` (10 min) after the latest of: the head's first
  sighting (2.4), the end of the step's last action, and the last check's completion;
- a check has been running for longer than `ciRunMs` (30 min).

Both are judged at the PR's read, not at the pass: a read an earlier pass took (2.4) cannot show
a check that started since it, so the bound counts to the read's time.

This also bounds a head whose PR shows `blocked`, `unknown` or `draft` with nothing to run
. In reviewing, the PR's own read is bounded the same way: a PR not in the
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
| parked | `comment` on the issue through one template (`park-text.ts` `parkText`): `### Waiting on the owner`; `**Decision needed:**` and the record's `question`; `#### How to resume` (a numbered list: tick one option or write an answer as a comment, then remove the label or `/factory resume N "answer"`; a comment or a tick alone does not resume); one closing line with where it parked from and what a resume goes on with. Once the comment is done with a URL, a free `event comment_posted` (key `.../event/comment-posted`; `--type comment_posted --data {life, seq, to_state, comment_url} --issue N`) follows it, before the tell; a comment found with no URL logs none. An agent's structured question (a designer's `question` answer or a triage `park`: `question` the one-sentence decision, optional `context`, 2 to 6 `options` keyed A to F with a title and optional detail, optional `recommendation`) is rendered by `question.mjs` `renderQuestion` into the record's `question`, which adds `#### Context` (the context's first paragraph visible, any later paragraphs collapsed in a `<details><summary>Details</summary>` block), `#### Options` (one `- [ ] **A** - title` line each, its detail indented) and `#### Recommendation` between the decision and the resume list, each only when given; the rendered text must fit the question's 2000 characters, which the contract checks. A machine-written park reason has no options and keeps its paragraph breaks. `tell(parked)` gives the decision sentence only |
| waiting | `comment` on the issue, once (`park-text.ts` `waitText`): `### Waiting on a condition`, the conditions one per line (`issue #57 must be closed on GitHub`, `PR #812 must be merged on GitHub`, `release tag must contain commit <sha>`), `Why:` the designer's reason, and that the loop checks the conditions itself and resumes the issue when they hold; no tick boxes and no question, and no owner tell. Once the comment is done with a URL, a free `event comment_posted` (key `.../event/comment-posted`; `--type comment_posted --data {life, seq, to_state, comment_url} --issue N`) follows it, before the links; a comment found with no URL logs none. For each `issue-closed` condition, action `link` (key `.../link/<blocker>`): the issue is linked as `blocked_by` that issue, reusing the split's idempotent link (8.7); a closed blocker is skipped, and a pull request is no blocker (a wait on one is no link), so a PR condition makes none, and neither does a tag condition. The link stays after the resume |
| closed | `label` op `clear` (3.4); then by why. dropped: event `abandoned`. merged and merged-by-hand: event `merged` when the factory view at the close has none for the life (a merge whose log was lost), planned before the seq's `event transition`: read only while that transition is not yet planned, so a later `closed` never logs the merge again, and once planned it is kept until done; then `rollout`, then `close-issue` when the rollout says `close_issue`, then `close-tracker` (key `.../follow/close-tracker`) when the rollout read `merge` and the `close-issue`, when planned, is done: it checks the issue's split parent (8.7) and, when it closed that tracker, plans the same check for the tracker's own parent (key `.../follow/close-tracker/up`, then `/up/up`: `TRACKER_DEPTH` checks in all); and `milestone-later` for a `run-it` or `keep-open` rollout (D-29); a `keep-open` rollout of an issue the factory view shows blocking open issues also gets `tell(keep-open-blocks)`, once, since those issues stay unclaimable until it is closed. A merge that is later reopened (a revert) is not a closed row follow-up: rule O3 moves it off Next (14.1, Releases). split: `release-parent` (with the design's `reasons` and each child's `why`, for the `abandoned` note). done: `comment` (key `.../comment`, hidden key, no closing keyword: the evidence, the designer's reason and what becomes of the issue branch), then `close-issue` as completed (key `.../follow/close-issue`, `logClosed`: the executor logs `closed` with reason `completed` after the close), then `delete-branch` (key `.../follow/delete-branch`) once the close is done, then the `close-tracker` chain of a merge (8.7), then `tell(done)`; the branch is deleted only when it exists on origin and either has no commit beyond origin/<base> or its head is the evidence PR's head, by `git push --force-with-lease=refs/heads/<b>:<sha> origin :refs/heads/<b>` (a lease the branch no longer meets is kept as `moved`, an answer, not a failure), and is otherwise kept, which the comment and the tell say |

- A seq's step starts only after its entry actions are done, `tell` excepted.
- **The owner's tick** (`park-text.ts` `ticksOf`). On the label route of an unpark, the loop reads
  the current body of this seq's park comment (the one carrying the hidden key of the seq's
  `comment` entry; an earlier seq's is ignored) from the comments it already reads for the note.
  Exactly one ticked option (`- [x] **A**`, either case of x) in its Options section makes the
  note's first line `Owner chose option A: <title>`; several ticks, or a tick on a line naming no
  option, make a note that says so and lists them, and choose none; no tick changes nothing. The
  trusted comments after the park follow, as before. The `/factory resume N "note"` route does not
  read the comments: its note is the answer. A tick alone does not resume (it would take a poll of
  every parked issue's comment).
- **Comments carry a hidden key**, `<!-- factory-loop:<ledger key> -->`. The `comment` executor
  reads the issue's or PR's comments for that key before posting, so a retry never posts twice
 .
- **An effect that uses up its attempts holds its record.** The record's skip line reads
  `stalled: <key>: <error>`, the owner hears once (`tell(stalled)`, an owner item), and
  `/factory retry N` clears it (D-38). A retry of the step could not fix a failing effect, so the
  record is not sent down the unknown path.
- The slot is freed by W2, not by an entry action, so it is freed however the record parked or
  closed (10.1).

### 4.6 The table as data

```ts
type EventKind = 'ok' | 'not-ok' | 'unknown' | 'triage' | 'drop' | 'cleared' | 'unpark' | 'issue-closed'
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
   attempt (the free re-run).
2. Otherwise the first unknown in a step runs it again (the plain retry).
3. The second runs one triage call, unless this life already had `maxTriages` triage calls,
   or the step was triage itself (then the issue parks).
4. After a triage `retry`, the step gets exactly one more attempt (X1 sets attempt 2), so its next
   unknown goes to step 3.

- **What is unknown.** No answer; the timeout of a running step; a dead or lost agent (`stopped` when the loop stopped it); a turn that
  ended in error, aborted or refused; an API error, a 429 included; an answer that fails its
  contract after its repair message; a CLI result outside the step's known outcomes; a GitHub
  wait past its bound (4.4).
- **A GitHub blip is not a result.** An action whose attempt fails on a
  transient GitHub error runs again inside the attempt, after 5 s and then 15 s, before its
  failure counts (`registry.ts` `executorOf`): a 5xx, GraphQL's "Something went wrong", a gateway
  or connection timeout. A rate limit is not retried there, since its 15-minute backoff holds
  GitHub (13.10 item 2), and neither are credentials, a 404, a validation error or a refusal. So a
  blip never ends a step unknown or holds an effect, and logs no intervention (one
  `gh pr update-branch` error once made the head's step unknown). The result must carry the
  error's text: a command's output, or the merge guard's FAIL reason, which names what its read
  printed (9.4). Running an action again is safe: each reads what a try before it did before it
  acts or records, as the ledger's own retries need (an update found up to date reads its head
  back, since GitHub may have made it before its error, 9.2).
- **Causes outside the issue** (the free re-run), each from a fact the loop already holds, never
  inferred:
  - `load`: the step's entry started before this module load and ended `lost` (the loop
    restarted, for whatever reason);
  - `usage`: the step's entry ended rate-limited (why `rate-limited`: a 429), or the tier was
    `stop-new` or `stop-all` when it ended;
  - `breaker`: the step-unknown breaker (5.3) was open when the step ended, or this unknown trips
    it;
  - `slot`: the record's lease vanished while the step ran (10.1). The step ends then, not at its
    timeout: a running agent is stopped by the next seq's entry actions, and a prepare counts only
    for the lease it ran in, so no agent starts in a slot that was not prepared for it.

  Each is free once per attempt (`cut`), so a step that itself brings the session down meets the
  plain retry on its second cut, and work stays bounded (property 7).
- **Usage limits.** A free re-run waits until its class is allowed. The pre-check skips a spawn
  without counting while the tier stops it (13.10 item 7). So a step killed by the usage window
  runs again after the window resets, at no cost to the issue.
- **Clean retries.** Every attempt starts in a freshly prepared slot (10.2): its processes killed,
  its leftovers saved, and the slot reset to origin's branch head. A retry's prompt names the
  previous attempt's result and its leftovers file, so uncommitted work can be applied and side
  effects are not repeated.
- **Bounds.** Per life: one free re-run per attempt, at most two attempts of a step per triage
  grant, `maxTriages` triage calls, `fixCap` fix rounds and `conflictFixCap` conflict rounds. An owner resume resets them (P1).
  Property 7 checks the bound (17.1).

### 5.2 The triage agent

- **Agent.** `factory-loop:triage`, a loop-owned definition (`agents/triage.md`). It is
  spawned as a step in the issue's slot, as a reader. Model `triageModel` (default `opus`).
  Timeout 15 minutes. One repair message on a bad answer (D-68).
- **Inputs.** Ids and pointers in the prompt; free text is keyword-rewritten (D-56):
  - the issue number and title, the brief URL, the branch, the head and the PR;
  - the state, the step kind, the attempt, `triages`, `fixes`, `conflicts` and `round`;
  - the last two step results: status, the executor's summary, an error excerpt of up to 2 000
    characters, the ledger key, and the paths of their spawn records, answers, stop-gate results
    and leftovers in the loop dir (`spawns/`, `answers/`, `leftovers/`; 13.6.3);
  - for reviewing and merge-queue: the head's check runs (name, conclusion, link), the latest
    review answer's path, the PR's `mergeable_state` and the guard's FAIL lines;
  - the owner's notes for the issue;
  - the menu, with what each choice does in this state.
- **The menu** is fixed:

  | Choice | Effect | Valid when |
  |---|---|---|
  | `retry` | the step runs once more, with `instructions` as a note | always |
  | `fix` | to fixing, with `instructions` for the fixer | the branch has commits beyond the base, and `fixes < fixCap` |
  | `redesign` | to designing, with `instructions` for the designer; branch and commits kept | always |
  | `park` | to parked, with `question` for the owner | always |
  | `drop` | to closed (dropped), with `reason` | always |

  A `fix` that is not valid parks the issue, with the triage's reason in the question (X4).
- **Output contract** `triage`, recorded with the answer script only (D-74; the loop's own tools
  never reach agents it spawns from its timer, the workspace spikes, `docs/spikes/factory-loop-workspace/README.md`):

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
  every issue's retries and triages, then park them all. Holding the classes acts before the
  damage, not after it.
- **Where.** It is the foundation's executor breaker (13.11.4) with one more bucket, in the
  admission filters of `foundation.ts`.

## 6. Reconcile

### 6.1 The rule

Every issue that shows as active must have a live step. An issue that shows as active
but has had no live agent, slot lease, pipeline or PR activity within its state's timeout is
released. A release puts the issue back in the queue by re-adding `ready` (owner, 2026-10-15),
where S1 claims it as a new life, with two exceptions:

- the owner dropped it, or the issue is closed: it leaves the factory;
- it was the issue's `maxLives`-th life (default 3): it is rejected. It gets `factory:rejected`
  instead of `ready`, and leaves (6.4).

The owner's first rule, "still labelled `ready` goes back to the queue, otherwise it leaves",
never put an issue back: claiming removes `ready` (`callum-flow-claim`), so every claimed
issue read as not labelled `ready`. The one-shot migration (6.3) requeues nothing: every issue it
releases leaves (owner, 2026-10-15).

Events are append-only. A release writes a closing event with reason `reconcile` and deletes
nothing.

The loop applies the rule in two places:

- **R1, on every pass**, over the loop's own facts. It has no mode, no approval and no hold on
  claims.
- **The one-shot migration** (6.3), for what an earlier loop left behind. It runs in observe mode
  and lists the proposed releases before acting.

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
   it. In observe mode the release is planned and logged, not executed.
   After the migration, a ghost can only come from a bug or a lost store with no events, because
   S0 makes every record from its done claim (3.3). The release goes back to the queue unless the
   owner dropped the issue since its claim (`control.dropped`), and unless this was its
   `maxLives`-th life; a requeue waits for a read that shows the issue open (a closed one is the
   sweep's, H2). The cap is what stops such a bug from claiming and releasing one issue forever.
3. **Only this device's claims.** R1 never looks at another device's claims or labels.
4. **The main-checkout tripwire** (10.7) also runs here: it compares the loop's own record of the
   main checkout with what it now sees.

One owner of ghost claims: R1 releases ghosts at once, so no ghost's claim can lapse while it waits
and be brought back by the sweep. H1 renews only records' claims.

### 6.3 The one-shot migration

`bin/factory-reconcile` in the factory-loop plugin. It applies the owner's rule to
the issues an earlier loop left behind, with that loop's evidence, so the every-pass rule never
has to read facts of the earlier loop.

- **Observe by default.** `factory-reconcile --repo R` lists this device's live claims (from
  `callum-flow-factory-state`) that have no record, and the issues the view shows as live with
  no live claim and no `ready` label (owner, 2026-10-15): those with no holder at all, in a live
  stage or queued, and those queued after their claim ended or lapsed, whoever made it. No device
  holds them, so nothing else would ever end them (#286, #289, #290, #468 and #469 on dev-system
  showed as queued for 3 to 6 days with no holder; #590 there, and #54 and #57 on plant-console,
  as queued after the loops' claims lapsed). One labelled `ready` is in the queue and is left out,
  and so is a record's queued state, which is live work. For each it looks for live evidence within `T`, the timeout of the state its
  factory-state stage maps to (designing to designing, implementing to building, in pipeline and
  parked to reviewing, ready to merge to merge-queue; any other stage, queued among them, 2 h):
  - a no-mistakes run of the issue's branch updated within `T`, as the `factory` source reports it;
  - the open PR's head pushed, a check run started or finished, or a review within `T`;
  - a slot of the earlier loop checked out on the issue's branch whose tree or HEAD changed within `T`.

  It also lists the pool's other slots, those with no `factory-loop:` holder. A slot checked out
  on an issue branch whose issue has no live claim and no record is proposed for freeing. A slot
  on no branch is only listed: the earlier loop's implementers detached theirs (#563), and the tool does not guess
  owners from reflogs.

  It prints the report and writes it to `<loop dir>/reconcile-<date>.md`. Each issue or slot gets
  one line: why it shows as active, what was checked, and the proposal. The proposal is `leave the
  factory`, `free the slot`, `remove the label`, or `live: check again later`, and the line names
  the issue's open PR and its slot.
- **Nothing is requeued** (owner, 2026-10-15). Every issue the migration releases leaves the
  factory, whatever its labels, and the report says so: the owner re-adds `ready` for any issue
  still wanted, and S1 adopts its open PR (3.5). R1's requeue (6.4) is for the loop's own releases.
- **Act on approval.** `factory-reconcile --repo R --act <N...>|all`. It checks each named issue
  again and releases those that still qualify (6.4). It also frees a slot on the issue's
  branch: the slot's processes are killed, its leftovers saved (10.2) and it is returned. Approval
  is by issue, so a proposal that changes between the report and the approval is checked again,
  and there is no digest to go stale. `--act all` leaves every live proposal
  alone; a live issue named in `--act` is released all the same, since the owner has judged it
  stalled (the report lists these as "released only when named").
- **`In development`.** It removes the label from each issue it releases. The report also lists
  the issues that still carry it with no live claim, open or closed, with the proposal `remove
  the label`, approved by issue like the rest (3.6).
- **When.** Run by the owner, observe first. `--act` fails closed, refusing with exit 1 and
  changing nothing unless `events.ts` writes and reads back the release's and the intervention's
  note fields and the `callum-flow-event` in use logs an `intervention`.
- **Nothing is lost.** A slot is returned only once its leftovers are saved or its tree is clean;
  else its issue fails and the slot is left for the owner. Each event is looked for in the log
  after it is written, since `callum-flow-event` exits 0 when a write fails. One that is not there
  fails its issue (exit 1), and its argv is kept in `<loop dir>/unlogged-events.jsonl` to log
  again.

### 6.4 Release

| Outcome | When | Actions, in order | Event |
|---|---|---|---|
| requeue | R1's default | stop any agent of the loop on it; in one call, `ready` on and the eight state labels off (`label` op `requeue`); W2 frees a `factory-loop:` slot leased for it | `reclaimed`, with the release fields (7.1) |
| leave | R1, when the owner dropped the issue since its claim; the migration, always | stop any agent; the eight off (op `clear`); the slot freed. The migration removes every `factory:*` label and `In development`, and frees the slot on the issue's branch | `abandoned`, with the release fields |
| reject | R1, at the issue's `maxLives`-th life | stop any agent; in one call, `factory:rejected` on and the eight off (op `reject`); one comment on the issue and one owner tell (`rejected`, appendix D), each listing why every life ended and how to bring it back; the slot freed | `abandoned`, with the release fields and outcome `reject` |

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
  (`docs/metrics.md`, section 6; `docs/factory-state.md`, "Stages"). No new kind is needed.
- The release's free-text field reads `no live step in <stage>: <what was checked>`.
- The issue's open PR is never updated or closed. A requeued issue's next claim adopts it (3.5),
  and the report names it, so the owner can re-add `ready` for an issue that left.

### 6.5 Today's ghosts

At 09:30 on 2026-10-15 the factory-state view showed 17 live issues on dev-system, at least 7 of
them ghosts. Their end states at the 07:25 snapshot fall into these cases for the migration:

| Case | What the migration sees | Proposal |
|---|---|---|
| Limbo: the implementer stopped with no commit and no rule moved it (#613) | in-dev label, no run, no PR | leave (`abandoned`) |
| Stuck on a refused respond or a dead run, told `agent-failed` (#589, #620, #591) | in-dev label; #589's PR #626 open; no activity since 02:35 | leave; the report names PR #626 |
| An owner decision (#590) | in-dev label, no step | leave; the report says the decision was asked at 02:24 and that re-adding `ready` with an answer brings it back |
| Merge holds on clean PRs (#467 with PR #621; #571 with PR #631) | in-dev label, open PR, no activity | #571 has merged since (`dd73ce2`), so it no longer shows as active. #467's run looks live (no-mistakes' CI monitor keeps touching it), so the owner names it in `--act` and it leaves; re-adding `ready` brings it back and S1 adopts PR #621 |
| Dropped and re-queued (#533), labelled `ready` | queued with `ready`: no live claim | not a ghost: S1 claims it and adopts any open PR on an `issue-533` branch |
| Queued for days with no holder and no `ready` (#286, #289, #290, #468, #469) | the view shows them queued; no device holds them | leave (`abandoned`) |
| Abandoned with a dirty slot (#602, slot 8) | no labels; a slot | the slot is freed if it is on #602's branch (its leftovers saved), else listed for the owner |

Whatever the view shows when the tool runs, the same rule applies.

## 7. Events

### 7.1 What v2 emits

**The format.** v2 writes its events natively (epic #534; #1141): `callum-flow-event --type <type>
--data <json> [--issue N] [--actor A]`, the type and data the image translator
(`images/base/factory-event-translate.js`, `docs/factory-events/translator.md`) made from the old
lines, field for field. `transition`, `reviewed` and `intervention` keep their names; a release is
`requeued` or `abandoned`, a drop or split `abandoned`, a merge found afterwards `merged`, a closed
tracker `closed`, a fixer's disposition `finding_handled` (actor `fixer`). Nothing is written as a
note any more, and `delegated`, `fix_requested` and `merge_ready`, which the translator skipped as
covered by the `transition` beside them, are not written at all. `--new-only` is gone: a native call
writes the new log only, H1's backfill included. The data builders are in `hooks/v2/event-native.ts`
(one per event kind); `tests/factory-loop-v2-events.test.js` holds each to the translator's output
for the old line and runs it through the real writer.

The note format below is kept for what still reads the old format: the `old` source and the
reconcile and plan replay of old logs (`parseEvent`, the token codec), and the once keys
(`eventNote`, `onceKey`), which the facts read also builds from new rows. It is removed with the
`old` source (#656).

- Tokens are separated by single spaces. A value holds no spaces: `%` and whitespace are
  percent-encoded (`enc` in `derive.ts`). A missing value is `none`, a list is comma-joined, a
  flag is `yes` or `no`.
- The identifying tokens come first and free text (a reason, a question, a park's parts, notes) last. Nothing is
  clipped: each field is bounded where it is made (the table keeps a question to 2000
  characters and at most 8 notes of 1000; a reason is one line of 200), and `callum-flow-event`
  and `factory.events` put no bound on a note. So a note carries every field whole.
  The `loop` note is the exception: it stays within 500 characters (`LOOP_NOTE_MAX`), and a wake's outcome
  ends with `reason=` (one line of at most 200), shortened and then dropped to keep the note within 500
  before the outcome is dropped. The translator maps it to `loop_entry.decision_reason`.
- `callum-flow-event` checks each new state's identifying tokens, as it checks `kind=`, `key=`
  and `status=` for `loop` (`images/base/callum-flow-event`): `transition` needs `life=`,
  `seq=`, `from=` and `to=`; `reviewed` needs `verdict=` and `round=`; `intervention` needs
  `who=` and `cause=`.
- **One seam.** `hooks/v2/events.ts` builds the argv of every event v2 writes (the type and data from
  `event-native.ts`), and holds the old note's builders and parser. The `event` executor and `act-events.ts` call
  only it, so a later format change touches one module.

Three states in the old format's vocabulary, which is closed
(`images/base/callum-flow-event`; the last addition was `loop`, D-09); their native types are the same names:

| State | When | Columns | Note fields |
|---|---|---|---|
| `transition` | every record change (4.6), again after a re-claim (4.1), and once more for a record the new log lacks when dual write starts (4.1, via=dual-write) | issue, branch, pr, head | the row id, `from`, `to`, `via`, and every record field (3.2), so a record can be rebuilt from it (3.3) |
| `reviewed` | each review result (8.3) | issue, branch, pr, head | `verdict` (`approve`, `changes` or `unknown`), `round`, `patch`, the counts of error, warning and info findings, the reviewer's id, the answer's path |
| `intervention` | each intervention (7.2) | issue (when there is one), pr | `who` (`person`, `loop` or `judge`), `cause` (a code of 7.2), `reason` (one line, at most 200 characters), the life when there is one, and the key of the fact it records |

- `main_state` (main_state.v1) is written in the new format alone, for no issue, by
  `callum-flow-event --type main_state --data <json>`, by rule M1 (14.1) from the `main` source (2.4):
  once for each change of the state of the default branch (its head, each workflow's newest completed
  run, each environment's newest deployment), with `changed` naming the first part that differs
  (`first`, `head`, `workflow` or `deploy`). Its key is `main/<last>/<current>` (appendix C). It sets no
  stage and is no progress for the stuck test.
- `transition` sets a stage for the factory tools (7.3). `reviewed` and `intervention` set no
  stage and are not progress for the stuck test.
- The companion writes two more types, `prompt_denied` and `prompt_waiting` (10.10), through
  `callum-flow-event --type` itself, not through `events.ts`: native events (`--data`, `--issue`
  required). The states stay accepted by `callum-flow-event` for older companions, whose `key=value`
  note the translator reads. They set no stage, are not progress for the stuck test and never decide whether an
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
| `delegated`, `fix_requested`, `merge_ready` | no longer written (#1141); the `transition` to building (`brief_url`), fixing (`via`) and merge-queue carries each | the metrics read the transitions |
| `verdict` | after a fix step, one per finding the fixer handled, actor `fixer`: `CORRECT: <id> <reason>` (fixed) or `WRONG: <id> <reason>` (declined) | keeps the reviewer false-positive query (`docs/metrics.md`, section 3) |
| `merged` | `callum-flow-merge`; the loop for a merge whose log was lost (4.5) | unchanged |
| `implementer_routed` | `callum-flow-implementer-route` before a build | unchanged (`docs/metrics.md` section 8) |
| `designer_routed` | `callum-flow-designer-route` before a design, or the loop itself as reason `fallback` (null `sonnet_pct`) when the route could not run | the designer model comparison in `docs/metrics.md` |
| `loop` | agent and wake entries, rate caps, breakers, owner operations; a `kind=passes` pass summary once a minute while the loop acts (#680) | unchanged (D-09). The summary is bookkeeping, never a stage or progress; the reader does any weighting |

- The Coder stop script (`wind-down.sh`, 10.11) writes the native `wind_down` event, one per loop dir
  per stop, through `callum-flow-event --type wind_down` (`docs/factory-events/schemas/wind_down.v1.json`);
  the loop itself does not write or read it.
- The loop writes the native `comment_posted` (`docs/factory-events/schemas/comment_posted.v1.json`)
  through `events.ts`, as it does `gate_run` and `shadow_read`: once per park or wait seq, after its
  comment is done with a URL (4.5).
- The loop writes the native `queue_snapshot` (`docs/factory-events/schemas/queue_snapshot.v1.json`)
  from the pass driver (`hooks/queue-snapshot.ts`), only in act mode with the act lock held and the
  kill switch off, through `callum-flow-event --type queue_snapshot`. The data is S1's queue view
  (3.3): every candidate in order with its rank, score, factors, `claimable` and a why-code, the
  free slots and the owner's controls, the first 50 candidates in full and the rest counted by why.
  It is written as `changed` when the view differs (a fingerprint of the candidates' place,
  claimability and why, the free slots and the controls; never score or factors) and a minute has
  passed since the last write, so changes inside the minute are held and folded into the next write
  (`folded`); as `heartbeat` (folded 0) when nothing changed for 15 minutes; and at once as `changed`
  on a pass whose plan has an S1 claim. `taken_at` is the pass's plan time, before the claim tool's
  `claimed`, so a reader joins each `claimed` to the newest snapshot at or before it. The send is not
  awaited (60 s bound): a rejected, timed-out or non-zero send counts as written (no retry each pass)
  and leaves one `queue snapshot: write failed: <reason>` line in the next pass line's `problems`.

The loop no longer logs `superseded`, `rebased_behind` or `run_started`, and no watcher states
(there are no pipeline runs).

### 7.2 Interventions

An intervention is any point where someone had to step in that the plan did not foresee: a person
(`who=person`), the loop's judge (`who=judge`), or the loop with unplanned judgement or recovery
(`who=loop`). The owner chose
this broad meaning so that these signals are never lost (section 15; issue #632, metrics 1 and 2).
Each gets one `intervention` event, keyed by the fact it records, so it is logged once.

**By a person** (`who=person`). Anything a person did:

| Cause | When | Issue |
|---|---|---|
| `op:<name>` | (`/factory` ops only) every `/factory` op but `status`, `stamp` and `help`: the work ops (`resume`, `drop`, `note`, `skip`, `noskip`, `priority`, `only`, `pause`, `unpause`, `serial`, `new`, `override`, `retry`), and `mode`, `trace`, `stop-now` and `update`. `ownerOp` (`driver-controls.ts`) logs it after the op lands, when act mode is in force before or after the op, so the op that turns the loop on (`mode act`) and off is logged too | the issues the op names, else none |
| `unpark` | `factory:parked` removed by hand (P1 by label) | the issue |
| `push` | a head on the record's branch that no loop step produced (4.1) | the issue |
| `hand-merge` | E3 | the issue |
| `pr-closed` | E4 | the issue |
| `issue-closed` | E2 | the issue |
| `control-file` | `control.json` or the `OFF` file changed with no op (against the last version the loop read or wrote, kept as `files:<repo>` beside the records; each change found, by an acting pass or by an op that finds its file already changed, is kept there as an edit to log, keyed by when it was found, so a change back to an earlier version is logged too; the loop never writes `OFF`, so the pass that finds it keeps its use as an edit) | the issues whose entries changed, else none |
| `config-file` | the workspace `config.json` or the repo-local `.claude/factory-loop.json` changed other than by an op (a landed `config set` or `config unset` is also logged with this cause, its detail the op text): capacity (K) and every other setting. While the loop does not act (mode off or observe), the workspace file it reads each tick is kept in memory, and the first tick that acts makes it the version compared against, so a hand edit that turns the loop on (`mode`) is one too | none |
| `restart` | a module load after an earlier run of the loop (its ledger holds an entry from before the load) with no `restart-self` in flight. The first start of a loop with no ledger restarts nothing | none |
| `reconcile` | the migration's releases, approved by the owner (6.4) | the issue |
| `hold` | `hold:dont-merge` when a merge-queue record is first held by the `don't-merge` label (on its issue or PR; the reason says which), and `hold:released` when the label is gone from both. One event for each toggle within a life, keyed `hold/i<N>/l<life>/k<n>` with `n` the count of the life's earlier hold events. A failed label read (`labels not read`) writes none (9.1) | the issue |
| `hold:release` | the merge queue's start of a release hold window: a release bump PR's head is inside its window (9.1). `who=loop`, no issue, `pr` the bump PR, `head` its head; the detail names its branch, the head, the state of its checks, the end of its window and the heads held. Fact `hold/release/pr<p>/h<head12>/start` (a start in the old form `hold/release/pr<p>/start`, logged before the window was per head, is still ended once) | none |
| `hold:release-merged`, `hold:release-closed`, `hold:release-pushed`, `hold:release-failed`, `hold:release-timeout` | the end of that window: the bump PR left the list and was merged or closed (its state read once); a push made a new head (`pushed`, and the new head's window starts); a check on the head failed or was cancelled (`failed`, the detail and `failed_jobs` name them); or its window ran out while the head was still open and its checks not red (`timeout`, which also plans the owner item `release-hold`, appendix D). `who=loop`; `head` the window's head; the detail names the heads whose merge it held. Fact `hold/release/pr<p>/h<head12>/end`. Both are logged once per device, derived from the ledger's start key and GitHub, so a restart between them still logs the end | none |
| `unreject` | the first claim after a rejection: the owner removed `factory:rejected` and added `ready` (S0's via `unreject`, 6.4) | the issue |
| `rescue` | recorded by hand, for what the loop cannot see: patching a trust file, killing a process, editing a file in the workspace, a hand release. `callum-flow-event --type intervention [--issue N] --regime manual --data '{"who":"person","cause":"rescue","life":null,"fact":null,"pr":null,"detail":"<what was done>"}'` (without `--regime` the row reads `unknown`), which the operator playbook adds to each rescue recipe | the issue, when given |

**By the judge** (`who=judge`). A control op the loop's judge (the main conversation) runs:

| Cause | When | Issue |
|---|---|---|
| `op:<name>` | the main conversation runs a control op through `mcp__factory-loop__control`, owner-chat ops included (the tool cannot tell whether the owner asked) | the issues the op names, else none |

**By the loop** (`who=loop`). Each comes from a fact the loop already holds:

| Cause | When | Issue |
|---|---|---|
| `triage` | every triage call (T6) | the issue |
| `unknown:<why>` | every step that ended unknown and is not a free re-run. `why` is `timeout`, `agent-dead` (a death the loop did not cause: the agent failed, was lost or crashed, or its turn, with no stop of the loop's, ended in error, aborted or refused), `stopped` (the loop stopped the agent and it gave no answer; no free re-run by itself), `bad-answer` (no valid answer after the repair message), `api` (an API error other than a rate limit: a 5xx, overloaded), `rate-limited` (a 429 or the usage window; a free re-run, cause `usage`, so it is logged as `unknown:rate-limited` only once its attempt's free re-run is spent), `spawn` (the companion refused the spawn), `cli` (a CLI result outside the step's known outcomes, a failed origin read, a failed prepare, a guard FAIL of class `read`) or `github-wait` (a wait past its bound) | the issue |
| `free:<cause>` | every free re-run (the free re-run): `load` (after a restart), `usage` (a usage-limit kill), `slot` (a lost slot) or `breaker` | the issue |
| `park` | every entry to parked: a question to the owner | the issue |
| `fix:ci`, `fix:conflict` | a fixer sent for red CI or a conflict, in reviewing or the merge queue (T9). Something did not merge as it should | the issue |
| `ci-rerun` | a failed or cancelled check re-run (8.5); once the run settles, a second row for the same fact says whether it was a flake (`flaky`, `head`, `failed_jobs`, `failed_tests`) | the issue |
| `queue:patch`, `queue:linkage` | the queue's head went back to review because its patch changed (T14), or its body was re-rendered after a `linkage` FAIL (9.3) | the issue |
| `guard:write`, `guard:push`, `guard:command` | the companion refused a file write, a push, a command, or a call in the background (10.4). An agent did something strange | the issue |
| `gate-unknown` | a stop gate that could not run (10.6) | the issue |
| `gate-rerun`, `gate-cut` | the companion ran again a stop gate a restart cut (`gate-rerun`), or gave it up because the slot's marker had moved on (`gate-cut`, 10.6) | the issue |
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

**How they are made.** One module owns them, so no other emits one:

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
  (`gate-pass`, `gate-fail`, 10.6) is not, and neither is `gate-wait` (a gate that waited for its turn)
  or `gate-start` (a gate that began, 10.6), or `agent-gate` (an agent's own gate-command run through the container's gate slots, 10.6).
  The loop reads those gate lines for `gate_run` events (10.6, `rules-gates.ts`), not as interventions.
  The companion writes no event itself.
- Ops are logged by `ownerOp` through `act-events.ts`; hand-recorded rescues through
  `callum-flow-event`.

**Fleet-level interventions** (a mode change, a restart, a capacity change, a breaker trip) name
no issue. They are attached to no issue: their effect on each issue shows as that issue's own
interventions (a restart's cut steps each log `free:load`). An intervention is attached to an
issue exactly when it names the issue.

### 7.3 Readers

Every reader parses v2's fields from the note's `key=value` tokens (7.1), as it parses today's
`loop` and `implementer_routed` notes (for example `substring(e.note FROM 'model=([^ ]+)')`,
`docs/metrics.md`, section 8), and decodes percent-encoded values.

- **`callum-flow-factory-state`** (`docs/factory-state.md`, "Source precedence"). Three changes:
  - A new step between 2 and 3: an issue whose current life has a `transition` event takes its
    stage from the newest one's `to`. queued maps to `queued`, designing to `designing`, building to
    `implementing`, reviewing and fixing to `in pipeline`, merge-queue to `ready to merge`, parked
    to `parked`, and closed to `merged` or `closed without merge` by its `why`. The detail column
    shows the v2 state, the step and the attempt. Mirror runs no longer set the stage of such an
    issue. Stuck rules S1 to S5 stay as they are.
  - `nomistakes.runs` becomes an optional source, shown as `n/a` when missing, as
    `factory.workers_status` already is (`images/base/callum-flow-factory-state`);
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
  (in `derive.ts`) gains the three states; `record.ts` parses their notes with `events.ts`. By default (`eventsSource` `new`) it reads them from the new store, as `transition.v1` data through the
  shared reader, `old` is the way back, and under `shadow` (opt-in) it reads both and writes a `shadow_read` (3.3). The facts and the ledger rebuild
  follow the same switch (3.3).

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

  A re-run never makes a second PR. The PR's number is in the done `pr` entry, so
  plan sees it at once, and the row that ends the reviewing step (T8, T9, T10) writes it to the
  record.
- **The life's PR** is the record's `pr`, else the PR the life's newest done ensure named
  (`lifePr` in `hooks/v2/rules-review.ts`). Every reader of a life's PR goes through it: the `prs`
  source, which so reads a PR the ensure just opened on the next pass (2.4); GitHub's PR events
  (E3, E4); the push check (7.2); and the triage and work prompts. No reader takes the record's
  field alone: in the first review round it is still empty, so a source that read only the
  record's field would never read a new PR and the review would wait until its GitHub bound.
- **Title:** the builder's answer `title`, one line of at most 72 characters, closing keywords
  rewritten (D-56).
- **Body**, written only by the loop:

  ```text
  <summary from the builder's answer>

  Closes #N            ("Refs #N" when callum-flow-rollout says run-it or keep-open)

  Design brief: <brief URL>

  ## Evidence
  <the newest evidence a build or a fix gave, when one did>

  Opened by the factory loop for #N.
  ```

  Every free-text part goes through `neutral()` (`prompts.ts`), which caps it at 4 000
  characters and rewrites closing keywords (D-56). So only the loop's own line links an issue. A
  stray reference in evidence text can otherwise break linkage.
- **The body follows the Rollout.** The guard derives linkage from the issue's current Rollout. A
  `linkage` FAIL at Q2 re-renders the body once per queue attempt (`pr` op `body`), then Q2 runs
  again (9.3).
- **A PR closed by a person** parks the issue (E4). On resume, the ensure step reopens it.

### 8.2 The reviewer interface

Swappable:

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
  owner's A/B test can run any implementation on frozen base and head pairs outside
  the loop.
- `changes` needs at least one `error` finding. `approve` may carry warnings and infos. The
  contract (`hooks/v2/contracts-review.mjs`) refuses anything else. Finding ids are
  `r<round>-<k>`.

### 8.3 The interim reviewer

The existing merge adjudicator's judgement, given the brief and the whole diff, in a
definition of its own: `agents/reviewer.md`, agent type `factory-loop:reviewer`. The
v1 adjudicator definition, a no-mistakes gate adjudicator with another output contract, was
retired, and the reviewer was never an edit of it.

- **Model** `reviewerModel` (default `opus`). It runs in the issue's slot as a reader, on
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
  - its own earlier rounds and the fixer's dispositions, so it does not repeat itself;
  - the owner's notes.
- **It checks** that every acceptance criterion and owner requirement in the brief is met, nothing
  unrelated was added, no test was weakened, and a visual change has UI evidence. The UI evidence
  check follows the repo's `uiCapture` setting: unset or a capture command keeps a missing capture an
  error, and `none` (the repo has turned capture off) makes it at most a warning. The prompt names the
  policy, and the `reviewed` event records it as `ui_capture` (`command`, `none` or `unset`; absent for
  a review recorded before the field). It constructs a failing case for any defect it reports.
- **Answer.** It answers with the `review` contract (8.2) through the answer script.
- **What the loop does with it.** It posts each result as one PR comment with a hidden key
  (`gh pr comment <p> --body-file -`): the verdict, the findings and the summary. It also logs one
  `reviewed` event per result (7.1).

This slot may later take no-mistakes' review or its prompt. That
is a new `Reviewer` implementation and a setting, nothing more.

### 8.4 Approval keyed by patch identity

- **Patch id** of a head: `git diff -U0 --no-color --no-ext-diff $(git merge-base
  origin/<default> <head>) <head> | git patch-id --stable`, first field. A new image script,
  `callum-flow-patch-id <branch|sha> <base>`, computes it for both the loop and the guard. A head
  that changes nothing against main (main already has its change) has the zero id: `--stable` adds
  up one hash per file. It goes through review like any other patch.
- `-U0` leaves context lines out, so a clean `gh pr update-branch`, which only brings in main's
  changes around the PR's lines, keeps the id. With context lines, git's patch id changes whenever
  main touched a line within three lines of a hunk.
- The record keeps `approvedPatch` from the approving review. A head whose patch equals it is
  approved; any other is not, and merge-queue sends it back to reviewing (T14).
- **A review is keyed by patch and round**: `i<N>/l<L>/review/<patch7>/r<round>/a<k>`. A done
  review of the head's patch in the current round is used, whatever the attempt or the head
 :
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
  A flaky check then passes without a fixer. A new round, after
  a fixer, gets its own re-run. A run is re-run only once it has finished: GitHub refuses to
  re-run a run with a job still going. The key keeps it once per round, but the call itself is
  retried: a GitHub blip inside the attempt (5.1), and a `gh` timeout or a restart during the call
  with backoff (3 attempts), so none of them is a failed check. Only GitHub's own refusal of the re-run counts the check as failed at once.
  A re-run whose answer was lost, or a failed call GitHub took anyway (a check of the run ended
  since), is awaited, within `ciStartMs`. In reviewing, one that uses up its attempts on transient
  errors holds the record as a stalled effect (4.5). At the merge queue's head it makes the step
  `unknown`, never `ci-red`, as any queue action that used up its attempts does, so the queue
  moves past a head that cannot move (9.1).
- **The log read.** Before the re-run, the executor reads the run's failed jobs' log
  (`gh run view <run id> --log-failed --repo R`, `flake-names.ts`, at most the first 4 MB). Each line is
  `<job>\t<step>\t<timestamp> <text>`: the distinct jobs are `failedJobs`; `FAIL <name>`,
  `FAIL test isolation: <what>` and `(fail) <name>` lines give `failedTests` (the `FAIL <id> (claude
  plugin validate / test)` wrapper is dropped), at most 20 names of 200 characters each. The names
  ride the done outcome. A read that throws, times out or exits non-zero gives null names and never
  changes the re-run, its status, summary or retry class. A ledger rebuilt from the event log keeps
  the exit only, so its names are null.
- **The flake row.** `rules-flakes.ts` writes the second `ci-rerun` `intervention` row for the
  re-run's fact once the run has settled: no check of the run pending, at least one ended since the
  re-run started, and no failed or cancelled check still showing its result from before it (a re-run
  of the failed jobs only leaves the passed checks their old end time, so not every check can be
  required to have ended since). `flaky` is true when no check of the run is failed or cancelled, false
  otherwise; the row carries the head and the names. Its ledger key is `iv/<rerun key>/flake`, and
  `onceKey` adds `flake` for a note with a `flaky=` token, so it is logged once and never mistaken for
  the first row of the same fact. A push of a new head shows a new run, so nothing is written for the
  old re-run.
- **A conflict.** GitHub does not run `pull_request` workflows for a PR with a merge conflict, and
  `ci.yml` triggers on `pull_request` and on pushes to main (`.github/workflows/ci.yml`). So a
  `dirty` PR is `not-ok(conflict)` and goes to a fixer. It does not wait out `ciStartMs`, and no
  re-run is planned for it. While this seq's reviewer of the head's patch still runs, the step waits
  for it (on the reviewer's clock) so one fixer gets the merge and the findings; the fixer's notes
  carry the merge lead, then the findings when the review asked for changes. With no such reviewer
  it ends at once.
  The GitHub rule is from GitHub's documentation.
- **Waits** are bounded by `ciStartMs` and `ciRunMs` (4.4).

- **A flake bug (rule F1).** A test that flaked `flakeBugMin` (2) times in the last
  `flakeWindowDays` (7) gets exactly one bug. A flake is one of the two rows above (a gate flake, once
  per issue, life, seq and started_at; a CI flake, once per issue and fact), read by the `flakes` source;
  a test is matched by its exact name in `failed_tests`. The bug is found again by its hidden marker
  `<!-- factory-loop:flake:<sha256 of the test name, 16 hex> -->` among the open issues by trusted
  authors before it is made, so a retried action or a lost ledger files no second one. Its ledger key is
  `flake-bug/<hash>/<event id of the first flake in the window>`. Its body has the marker, the test name,
  one line per flake (issue, head, time, `gate` or `ci`), the failure lines from the flake rows (clipped,
  in a fenced block, made safe as every body is, `neutralBody`), a link to `flakeEpic` when one is set,
  the three requirements of a flake fix (reproduce under load first; fix the cause; show a run of
  consecutive passes) and a hidden per-flake marker for each flake it lists. It is labelled `flaky` (the
  executor makes the label first, `gh label create --force`) and `priorityLabel`, and linked as a
  sub-issue of `flakeEpic` (default null: none). A later flake of a test that has an open bug gets one
  comment on it, keyed `flake-bug/<hash>/c/<flake event id>` and carrying that key as its hidden
  marker; a flake the bug's body names gets none. One flake of a test files and comments nothing.
  The bounds: this is the one case where the loop readies its own work (owner, 2026-10-18), only a bug
  it filed with the marker. The bug gets `ready` only when fewer than `flakeBugReadyCap` (2) open issues
  carrying the marker are labelled `ready` or have a record that is not closed; otherwise it is filed
  without `ready`. The loop never readies any other issue and never readies a held flake bug later: the
  owner adds `ready`. Each bug filed is told once, `tell(flake-bug)` (key `tell:flake-bug:<bug number>`,
  not an owner item), planned the pass after it is filed from the entry's outcome, naming the test,
  the flake count and window, the bug, and whether it was readied or held by the cap. The tell's
  `loop_entry` carries `decision` (`ready` or `held`), `decision_reason`, `flake_test`, `flakes`,
  `window_days`, `first_flake_at` and `filed_issue`, so metrics 2d answers how long a test's first flake
  took to be fixed and how often the cap held a bug. A failed or unread `flakes` source plans nothing for
  F1 and never fails the pass.
- **Refused jobs.** A failed Actions job GitHub did not start for the account's sake (failed payments,
  a spending limit) is the account's fault, not the code's, so it is neither red nor green. The `prs`
  source classifies it: a failed check with a run and a job id (the job id is in its link,
  `.../actions/runs/<run>/job/<job>`) whose job, in `gh api repos/R/actions/runs/<run>/jobs?filter=latest&per_page=100`,
  has no steps and no runner (`runner_id` 0 or null, `runner_name` empty) and whose check run has an
  annotation starting "The job was not started" (`gh api repos/R/check-runs/<job>/annotations`). It gets the
  bucket `refused` and GitHub's message (`refusedWhy`, clipped to 200 characters). A zero-step failure
  without that annotation (a bad matrix expression) stays `fail`. One jobs read per failed run not yet
  classified and one annotations read per such job; a job's classification is kept in memory by job id (a
  re-run makes a new id); a read that fails or does not parse leaves the PR unread this pass.
  - The review step (`ciHalf`) and the merge queue's head (`ciOf`) hold on a head with a refused check and
    no real failure, with a skip line naming the job, the run and GitHub's message. The hold spends no
    round re-run, starts no fixer, counts toward no fix cap and is not bounded by `ciStartMs` or `ciRunMs`
    (no `github-wait`): it is an outside block. A real failure beside a refused check still goes red as
    above. The flake row (`rules-flakes.ts`) ignores refused checks.
  - Repo-wide, a spell: while a read PR shows a refused check and no spell is open, the loop plans
    `tell(actions-refused)` (an owner item, no issue, key `tell:actions-refused:<job id of the earliest
    refused check>`), naming GitHub's message, that it is the account and not the code, the PRs it holds
    and that the loop resumes by itself; its `loop_entry` carries `decision` `hold` and `decision_reason`.
    The spell is open from that tell's ledger entry until the notice `actions-resumed` after it. Nothing
    is parked and no issue is told.
  - While it is open, every `PROBE_MS` (30 minutes, `rules-refused.ts`) the loop re-runs one refused run,
    that of the first record in the prs source's order (the queue's head first): `ci-rerun`, key
    `<life key>/refused/<run id>/p<k>`, k the period of the spell. A `gh run rerun` GitHub refuses leaves
    the spell open for the next period.
  - When a read shows a job that started after the spell opened (on any read head, not refused, not
    skipped), the loop plans the notice `actions-resumed` (not an owner item, key
    `tell:actions-resumed:<the refused tell's key>`, `decision` `resume`) and re-runs each refused run once,
    key `<life key>/refused/<run id>/go`. Neither key is the round's `rerunKey`, which stays free for a real
    failure afterwards, and neither matches the flake row's `rerun/r<round>/<run>`. A run refused again
    after the resume, with a job that ended after the notice, opens a new spell.
  - Each refused run is logged once as an `intervention` (cause `ci-refused`, fact `<life key>/refused/<run id>`,
    the jobs, the head and GitHub's message); the probes and the resume re-runs log `ci-refused:probe` and
    `ci-refused:rerun`, not `ci-rerun`. Metrics section 9 has the spells query.

### 8.6 Rounds and the cap

- `round` counts entries to reviewing in the life. `fixes` and `conflicts` count entries to fixing.
- A not-ok is base-caused when other merges caused it: its reason is `conflict` (from reviewing or
  the merge queue), or `ci-red` from the merge queue (the checks went red after the one re-run, on
  a head the review had approved). A reviewing `ci-red` and `changes` are the PR's own.
- Each reviewing, fixing, reviewing cycle adds one to the counter of its kind: `conflicts` for a
  base-caused not-ok, `fixes` for any other. At that counter's cap (`fixCap` 3, `conflictFixCap` 5;
  `config.ts`) the next not-ok of that kind parks instead (T10), with the question of its cap. A
  record at `fixCap` whose next not-ok is base-caused still goes to a fixer. The vias stay
  `fix:<kind>` and `fix-cap:<kind>`.
- A fixer that declines every finding sends the PR back to reviewing with its reasons (T12). The
  new round's reviewer judges the declines, and a failed check gets the new round's re-run. That
  costs a round, not a fix.
- A fixer that pushes nothing but fixed a finding outside the branch (on the PR description or evidence) answers `unchanged`; the PR goes back to reviewing with notes naming each finding (T17), and the answer's evidence is written into the PR body. A `fixed` answer whose origin head did not move stays an unknown bad-answer.
- An owner resume resets `fixes` and `conflicts` (P1).
- Rounds have no cap of their own. Without outside pushes they are bounded by `fixCap`,
  `conflictFixCap` and `maxTriages` (property 7).

### 8.7 The design brief

The designer is a reader: it writes nothing to GitHub.

- **Agent.** `factory-loop:designer-v2` (`agents/designer-v2.md`): the designer method (read
  the issue with `callum-flow-issue-read`, reproduce a bug first, explore with its own reads, the brief's fixed shape with its `## Rollout` line), with the command rule
  (10.4) and no GitHub writes. It has no Agent tool: a sub-agent's call always runs in the
  background and a turn end is final (10.8), so an explorer's report would arrive after the
  answer and never be recorded; the definition carries an exploration checklist instead
  ([#851](https://github.com/cbundy/dev-system/issues/851)).
- **Contract** `design`, through the answer script: `{ kind: "brief" | "question" | "split" | "wait" | "done" | "upstream",
  brief, question?, reasons?: { why_split, why_count, why_parts, why_order } (required for a split),
  children?: [{ key, title, body, why, blockedBy: [key | "#N"], ready: boolean, decision?: { question, context?, options?, recommendation? } }],
  conditions?: [{ kind: "issue-closed", issue: N, repo? } | { kind: "pr-merged", pr: N } | { kind: "tag-contains", sha, repo? }], reason?, evidence?: { pr: N | null, commit: sha | null, runIt: url | null },
  upstream?: { repo, request: "bug" | "need", title, body, authority: { kind: "owner", source, quote } | { kind: "bug", blocking, confidence } } }`.
- **Two layers.** The brief is read by the owner on GitHub: under its title, Acceptance criteria,
  Files to touch and Test plan it has one or two plain lines for a non-engineer, then a collapsed
  `<details><summary>Details</summary>` block (the title's block is `Exploration`) holding the full
  text. Every `##` heading, Risk, Observability, Compatibility, Sequencing, Rollout and Open
  decisions stay visible, so every brief reader (which keys on headings and first lines) reads it
  as before.
- **Observable by default.** A brief has an `## Observability` section, and the contract refuses
  one without it: each decision the change adds (a point where an agent or a rule chooses), where
  it is recorded with the facts weighed and the reason, and the `docs/metrics.md` query it
  answers, or "none - no new decision". Optional fields on an existing event type come before a
  new type; a new type ships schema, view fields and migration in release N, and no producer writes it
  before release N+3 (three minor releases before any producer), so the image readers of the last three minors know it. The reviewer holds the change to the section like an acceptance criterion.
- **Compatible by default.** A brief has a `## Compatibility` section, and the contract refuses
  one without it: what changes in a migration, event schema, the event writer or a
  factory-database reader and why every loop of the last 10 minor versions keeps working (only
  additive changes; the event readers in the image of the last three minor releases must read every
  event a producer writes, the separate reader-skew rule), and the test that proves it, or "none - no schema, event or reader change".
  The reviewer holds the change to the section like an acceptance criterion.
- **The loop posts** the brief as an issue comment with a hidden key (4.5), and the step is ok
  once it is posted. Its URL is the record's `brief`.
- **A split.** The loop creates the children with action `split`, one keyed effect per child
  (`i<N>/l<L>/s<seq>/child/<key>`). Each child's body carries the hidden key, so a retry finds it
  instead of making a second one. The effect links the child as a sub-issue, adds its `blocked_by`
  links (to a sibling, or to an existing open issue of the repo named as `#N`; a closed one is skipped, a pull request refused), then labels `ready` the children whose `ready` is true. A child whose `ready` is false carries an open
  owner decision, in a `decision` object checked as a question answer is (11; refused on a ready child; without one, the
  body's `## Open decisions` text, at most 2 000 characters, else a fixed sentence naming the parent). It is not left silent:
  once the child exists, plan claims it at once (a first claim keyed `i<child>/claim/<life>`, free, outside the capacity
  limit) carrying `park: { question, parent, parts? }` (`parts` the checked `decision` object's parts, 3.2), and the done claim makes the child's record through row S7: parked, resuming
  to designing, so the park comment with its tick boxes, `factory:parked`, the owner tell and the title's owner count come
  from the park machinery, and the owner's label removal or `/factory resume` takes it through P1 and T1 to its design with
  the answer as a note. Every not-ready child is claimed before the plan comment is posted and T4 closes the parent. A lost
  claim (a ledger rebuild) leaves the child to S0's queued record on its next claim, and the designer asks the question itself. The step is not-ok(split) once
  every child exists and is claimed, and T4 closes the record, keeping the parent open as the tracking epic
  until every sub-issue is closed, whatever its close reason: then the loop closes it
  (action `close-tracker`, planned by the closed row when a split child's merge is done; the child is
  found by its hidden key, so a merged issue without one, such as a child the owner made under an epic by hand,
  closes nothing). The parent is read live: any sub-issue still open leaves it open until the next sibling's merge checks again.
  A child whose rollout is `run-it` or `keep-open` stays open at its merge, so it plans no check, and its
  tracker is closed by the owner or by a later sibling's check. A split child is a whole issue: its `## Rollout` defaults to
  `merge`, and the contract refuses a child body without one, or a `keep-open` whose reason says
  the child is part of an epic or a split. The plan comment on the parent shows the four reasons
  under "Why this split", and each child line its `why`. `release-parent` carries `reasons` and
  `childWhys` (aligned with `created`; both null when the design answer can no longer be read), and
  the `abandoned` event's note carries them as tokens (`why_split`, `why_count`, `why_parts`,
  `why_order`, `child_whys`), which the translator lifts into optional fields of `abandoned.v1`.

- **A wait** (`kind: "wait"`, the designer's choice when the work is blocked only on a fact the loop
  can check; an owner choice is a `question`). `conditions` are 1 to 8 of `issue-closed` (the
  issue is closed), `pr-merged` (the PR is merged) or `tag-contains` (`{ kind: "tag-contains",
  sha }`: the newest release tag carries that commit; `sha` is 7 to 40 hex digits, stored
  lower-case), N at least 1, never the issue itself and none twice (a sha twice, in any case, is
  twice). `issue-closed` and `tag-contains` take an optional `repo` (`owner/name`, stored
  lower-case, dropped when it is the job's own repo; refused on `pr-merged` and when malformed): the
  condition is then about that repo, so an issue naming itself is refused only in the own repo, and
  the same sha in two repos is not twice. `reason` is one line of at most 500 characters; `brief` is an optional draft, as a
  question's. Stray fields are
  refused as for the other kinds, and `bin/factory-answer` reports "a wait on <n> conditions". The
  step is not-ok(wait) at once, with nothing posted (T16); the entry actions (4.5) then label the
  issue, post the one comment and make the `blocked_by` links. The designer never offers the owner
  a release: whether to cut one is the judge's decision (11), so a release wait is a `tag-contains`
  wait: for example a change that ships in two releases waits until a release tag carries the
  commit its readers ship in. The transition note's `wait` token writes it as `tag:<sha>` (`tag:<repo>@<sha>` with a repo; an issue is `issue:<repo>#<n>`). No `blocked_by` link is made for another repo's issue, and the waiting comment names it as `owner/name#N`.
  `bin/factory-answer` also reads each condition on GitHub, for its own `repo` or else the job's repo, before it records the
  wait (`hooks/v2/wait-check.mjs`, #980; all conditions at once, each `gh` call limited to 15 s): a
  `tag-contains` sha must be a commit of the repo and the repo must have a release, an `issue-closed`
  issue must exist, a `pr-merged` PR must exist and not be closed unmerged. A definite negative (HTTP
  404 or 422, "release not found", an unresolvable PR) is refused like any problem, one per
  condition; an indeterminate read (no `gh`, network, rate limit, auth, timeout) records the wait and
  names the unchecked conditions on stderr. The loop's turn-end re-check stays shape-only.
- **A brief's Rollout** (`kind: "brief"`, #987). When the Rollout (`rolloutOf`) is `merge`,
  `bin/factory-answer` reads the job's issue before it records
  (`hooks/v2/rollout-check.mjs`; `callum-flow-issue-read --json <N>` with `CALLUM_FLOW_REPO` set to the job's
  repo, limited to 15 s). A body with a `## Run it` heading (the test of `callum-flow-rollout`) refuses the
  answer with that tool's reason, `brief says merge but issue #<N> has a '## Run it' heading`, and the
  remedy: answer `run-it` when the Run it stands, or ask the owner to rename the stale heading. An
  indeterminate read records the brief and names the unchecked Rollout on stderr. The PR-open check
  (`callum-flow-rollout` in `act-pr.ts`) stays as the backstop.
- **An upstream request** (`kind: "upstream"`, the designer's choice when the change needs a change in
  another repo of the factory's own, and never a question asking the owner to write the issue). The
  answer is `{ kind: "upstream", upstream: { repo, request, title, body, authority }, reason, brief }`
  (`hooks/v2/upstream-answer.mjs`): `repo` is one of `UPSTREAM_REPOS` (a frozen list holding only
  `cbundy/dev-system`, compared in lower case) and never the job's own repo; `request` is `bug` or
  `need`; `title` is one line of at most 120 characters; `body` is at most the brief limit; `reason` is
  one line of at most 500; `brief` is an optional draft. Stray fields are refused, and every other kind
  refuses an `upstream` field. `authority` is either the owner's word, `{ kind: "owner", source, quote }`
  (`source` is `"note"`, the URL of this issue, or a comment URL on this issue; `quote` is 10 to 500
  characters), or a confident, non-minor bug, `{ kind: "bug", blocking, confidence }` (texts of at most
  500 characters: what it blocks and why the workarounds are poor, and the evidence), allowed only with
  `request: "bug"`. The authority is checked mechanically. The design step's job data carries the owner
  notes of the step (`data.ownerNotes`, the `owner: ` lines of the action's notes, set at the spawn), and
  a `note` source passes only when the quote appears in one of them (whitespace collapsed, case and
  straight versus curly quotes ignored); the contract does this, so the answer script and the loop's
  turn-end re-check refuse alike. A URL source is read by `bin/factory-answer`
  (`hooks/v2/upstream-check.mjs`; `callum-flow-issue-read --json --comment <url>`, or `--json <N>` for the
  body, with `CALLUM_FLOW_REPO` set to the job's repo, each read limited to 15 s): exit 3 (an untrusted
  author), a comment that is not on this issue, or a text without the quote refuses; a read that decides
  nothing records the answer and names the unchecked authority on stderr. `bin/factory-answer` reports
  "an upstream request to <repo> (<request>)". The step result is not-ok(`upstream`) with the answer as
  data; `designPlan` hands it to `upstreamPlan` (`rules-upstream.ts`), which plans one keyed effect, the
  `upstream` action (key `i<N>/l<L>/s<seq>/upstream`). Its executor (`act-upstream.ts`) lists the target
  repo's open issues (the reader with `CALLUM_FLOW_REPO` set to the target), finds the issue carrying the
  marker `<!-- factory-loop:upstream:<own repo>#<N>/l<L>/s<seq> -->`, or creates it with
  `gh issue create --repo <target>`; the body is the designer's text, a line naming the source issue as
  `<own repo>#<N>` (no closing keyword) and the request kind, and the marker. No label is added, and a
  retry or a lost ledger never files a second issue. This is the loop's only write to a repo other than
  its own, and the safety tests pin it to this one action kind and to `UPSTREAM_REPOS`. Once the effect is
  done the plan returns not-ok(`wait`) on `{ kind: "issue-closed", issue, repo }` with the text `raised
  <target>#<n> upstream (<request>): <reason>`, so T16 takes the record to waiting (the one waiting comment
  names `owner/name#N`) and the design resumes with a note naming what cleared. A design resuming after an
  upstream issue exists waits on it rather than raising another. The decision log's `upstream` action and
  outcome (`made`) record it (`docs/metrics.md`, "Upstream requests").
- **A done close** (`kind: "done"`, the designer's choice when the issue's work is already merged on
  the default branch). `evidence` is `{ pr, commit, runIt }`, at least one of `pr` and `commit` (a
  whole number of at least 1; 7 to 40 hex digits, stored lower-case); `runIt`, when given, is a
  comment URL on this issue (`https://github.com/<repo>/issues/<N>#issuecomment-<digits>`); `reason` is
  one line of at most 500 characters; `brief` is null. Stray fields are refused as for the other kinds
  (`hooks/v2/done-answer.mjs`), and `bin/factory-answer` reports "a done close on PR #N" (or `commit
  <sha7>`). Before it records, `bin/factory-answer` reads the evidence on GitHub
  (`hooks/v2/done-check.mjs`, as for a wait): the PR must be MERGED and the commit must be on the
  default branch (`gh api repos/R/compare/<default>...<sha> --jq .status` gives `behind` or
  `identical`); a definite negative is refused, an indeterminate read records the answer and names the
  unchecked evidence on stderr. The design step checks it again against origin: it fetches, then runs
  `git merge-base --is-ancestor` of the commit (or the PR's merge commit) against origin/<base>; evidence
  that is no ancestor, or a PR with no merge commit, is a bad answer (unknown, why `bad-answer`), so the
  step retries and then goes to triage like any bad answer, and a failed read is unknown (`cli`). The
  step result carries the evidence, the checked commit, the PR's merge commit and head, and the branch
  reading `{ sha, beyond }` (origin's ls-remote and `rev-list --count origin/<base>..<head>`). The step is
  not-ok(done), T18 closes the record why `done`, and the closed row (4.5) closes the issue.
  Nothing is posted by the step. An issue the done issue blocks is claimable once its `blockedBy`
  reads 0 (rules-claim.ts); no new mechanism.
- **The loop checks, with no model call** (2.4, `sources-waits.ts`): an issue condition holds when
  `callum-flow-issue-read --json N` shows it closed (for an issue of another repo, run with `CALLUM_FLOW_REPO` set to that repo), a PR condition when `gh pr view N --json
  state,mergedAt` shows it merged. A failed or skipped read (a GitHub backoff, a rate limit met this
  pass) keeps the condition open and never clears it. A tag condition is read by the compare of
  the commit with the newest release tag of its repo, `gh api repos/R/compare/<tag>...<sha> --jq .status`:
  `behind` or `identical` holds, `ahead` or `diverged` does not, and a failed read, no release yet
  or any other output keeps it open. A sha read for the current tag is read again only when the tag
  changes, and a held one stays held. The newest tag is read with gh only (`gh release view --repo R
  --json tagName`) on the milestone cadence whenever a stored record waits on a `tag-contains`
  condition of the loop's own repo (for another repo's condition, that repo's newest tag, per repo, on the same cadence; its sha is read again only when that repo's tag changes), whether or not the Next milestone qualifies (the full release read, when it qualifies,
  refreshes it too). When every condition holds the record takes `cleared` (C1), and the cleared
  note is the resumed designer's; for a tag condition it names the tag the read saw: "release
  v0.51.0 contains 35bb655", and "release v1.2.0 of o/n contains 35bb655" or "o/n#57 closed" for another repo. Rule O3 (11) counts only own-repo tag waits.

## 9. The merge queue

### 9.1 Order

- The queue is the records in merge-queue whose step is `queue`, oldest `seqAt` first (ties by
  issue number). Paused issues are skipped. A record whose step is triage is not in the queue.
- **The don't-merge hold.** A record is held when its issue or its PR carries the label
  `don't-merge`, matched by its exact name, ignoring case. The owner sets it; the loop never makes,
  adds or removes it. A held record is left out of the queue as a paused one is, so the next
  record is the head and can be updated and merged in the same pass, and it gets no Q1 and no Q2.
  Its step is `held` (never `waiting`: no E6 timeout and no tell), its skip line saying
  `merge queue: held by the don't-merge label on the issue` (or `on PR #<p>`). It keeps its
  `seqAt`, so once the label is gone from both, it is back at its old place on the next pass. The
  hold fails closed: an issue read that is missing or has no labels, or a PR view whose labels are
  null or malformed, holds the record with `merge queue: labels not read, held until they are`. A
  record with no PR view yet is held by the issue alone. The status title counts held records
  (`held <n>`). The hold is a hold, not a state: no record transition is made for it, and a
  hold and its release are interventions (7.2).
- **The release hold.** While a release bump PR's head is inside its window, the loop holds its own
  merges. The window is per head: it starts at the head's anchor, the latest of the PR's GitHub
  `createdAt`, the head commit's `committedDate` and the earliest `startedAt` of the head's checks
  (each left out when unread), and lasts `releaseHold` at most (45 minutes by default, the cap per
  head; 0 turns it off). A push makes a new head and so restarts the full window; a failed or
  cancelled check on the head ends the hold on that pass (the release failed, so the queue goes on).
  Pending, not yet reported and green checks hold.
  A bump PR is an open PR of the repo (not a fork's) whose head branch starts with
  `releaseBranchPrefix` (no default: unset turns the hold off; dev-system sets `chore/release-`).
  The signal is read from GitHub (the `releasePrs` source, 2.4), so every device honours it, a
  restart loses nothing, and a release that failed holds for the window at most (red checks end it
  sooner) with nothing to clear. While the hold is in force the head plans no Q2: its step is `held` (no clock, no E6, no
  tell) with the skip line `merge queue: held for release PR #<p> until <HH:MM> UTC`. The records
  stay in the queue in their order, the others keep their `waiting behind` lines and `seqAt`, and
  Q1, CI re-runs and fixers go on, so the head is ready to merge the moment the hold ends. The hold
  ends on the first pass where the PR is no longer listed open, its checks are red, or its window
  has run out, and the head is then merged on that same pass if it is ready. A window that ran out
  with the head open and the checks not red also plans the owner item `release-hold` (pr, branch,
  head, minutes, checks), once per head. Each window is an intervention pair (7.2).
- Every transition sets `seqAt`. So a head whose step ends other than ok (an unknown, a retry, a
  triage's retry) goes to the back, and the next PR becomes the head.
- The head is the first. Only the head is ever touched: updated, checked or merged. A
  PR behind the head waits untouched, however far behind main it falls.
- No other open PR is ever updated or rebased, by any rule. The safety tests check that
  `queue-update` names only the head's PR and that no rebase exists (17.1 property 8).

### 9.2 Q1: update the head

- **When:** the head is behind, and no queue action of the head is running. Behind is read from
  facts the loop has: the PR's base commit (`base.sha`) is not main's head on origin, or GitHub
  shows `mergeable_state` `behind`. GitHub computes mergeability lazily and shows `unknown` for up
  to two minutes after main moves, so the loop does not wait for it. A
  conflict (`dirty`) is still GitHub's to say.
- **Action** `queue-update`: `gh pr update-branch <p> --repo R`. GitHub merges main into the
  branch; no history is rewritten.
- **Key:** `i<N>/l<L>/queue/update/<base7>`, where `<base7>` is main's head at plan time. Each
  outside merge moves main and so earns one more update: a key that did not name the base could never
  update twice.
- **Outcomes:** GitHub's update is asynchronous, so the executor reads the PR's head until it
  moves (30 s bound) and records the new head in its ledger entry. That makes it a head the loop
  produced (4.1). An update GitHub finds needless (already up to date) records the head it reads
  back, never the head planned at: an earlier try of the attempt may have made it (5.1). A refusal
  for a conflict is `not-ok(conflict)`; a head that did not move or was not read back, or any
  other failure, is `unknown`, once a GitHub blip has been tried again (5.1).
- A head that already shows `dirty` is `not-ok(conflict)` without an update.

### 9.3 Q2: merge the head

- **When:** the head is not held (9.1) and no release hold is in force (9.1), shows `clean`, every check on its head passed or was skipped (after re-runs,
  8.5), its patch equals `approvedPatch`, and no queue action of the head is running.
- **Action** `queue-merge`: `callum-flow-merge <p> --patch <approvedPatch> --issue <N>`, keyed
  `i<N>/l<L>/queue/merge/<head7>`. The guard runs inside it, and the merge uses
  `--match-head-commit`, so a push in between makes GitHub refuse
  (`images/base/callum-flow-merge`). `--issue` is the record's issue: the guard never has
  to read it from the branch name. `check-pr-linkage.sh` reads `issue-<N>` from the branch too
  (the number followed by `-` or the end of the name), so the linkage is checked, never skipped, and a skipped check would park a green, approved PR.
- **Outcomes.** Merged is `ok` (T13). A FAIL line of the guard carries a class (9.4), and each
  class has one outcome:

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

`callum-flow-merge-guard` takes `--patch <id>`, which `callum-flow-merge` passes through. With it
the guard checks only facts the loop owns:

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

- **No no-mistakes call.** With `--patch` the guard skips its run lookup, which otherwise calls
  `pipeline-watch.sh --resolve` and `no-mistakes axi status` before any clause
  (`images/base/callum-flow-merge-guard`). Its test asserts that `--patch` mode calls
  neither.
- **Classes.** In `--patch` mode each FAIL line ends with `class=<class>`, one of `behind`,
  `conflict`, `checks`, `patch`, `linkage`, `read` and `policy` (9.3). So the loop never parses
  the reasons' wording. A `read` reason ends with what the read printed on
  stderr, so a GitHub blip in it is tried again like any other (5.1).
- Without `--patch` the guard behaves as today, for people
  (`images/base/callum-flow-merge-guard`).

### 9.5 No hold while main is red

The queue never holds for a red main. The loop reads main's checks (2.4 `main`) only to log them as `main_state` events (7.1); no rule waits on them or tells the owner:

- With "Require branches to be up to date" on, every PR's CI after its update runs on main plus
  the PR, so the head's own checks already carry main's state.
- A flake on main shows on the head as a failed check, and its one re-run clears it (8.5).
- A real break on main shows as `ci-red` on the head. The owner's rule then applies: the PR leaves
  the queue for a fixer, and the queue moves on. A fixer may fix the break in the PR
  or decline it; the fix cap and the step-unknown breaker bound the cost.
- A hold on a red main would make the queue wait on a person while holding K slots, and a
  failed-workflow signal would include the scheduled and release workflows, which would let a
  failed release hold merges. (The release hold of 9.1 is another thing: it reads the bump PR, not
  a workflow, and ends at the PR's merge, its close or its 10 minutes.)

The owner confirmed this (section 15).

### 9.6 Throughput

- A merge needs at most one update, one CI run and one merge: about 4 to 5 minutes, so 12 to 15
  merges an hour against a demand of about 1 (CI takes about 3 minutes).
- An outside merge during the head's CI wait makes the head `behind` again. Q1 then updates once
  more, under the new base's key. If main keeps moving, the GitHub wait bound and the unknown path
  bound it, and an unknown head goes to the back of the queue.

### 9.7 Fixer rounds

- A conflict, or red CI in the merge queue, goes to fixing with `conflicts + 1` (T9), up to
  `conflictFixCap`, then the issue parks (T10). Red CI in review goes with `fixes + 1`, up to
  `fixCap` (8.6).
- For a conflict, the fixer merges `origin/<default>` into the branch and resolves it. It never
  rebases or force-pushes (10.4). For red CI it gets the failed checks' names and links and reads
  the logs with `gh run view --log-failed`.
- A finding fixed without a code change is answered `unchanged`, with no head and the evidence in the answer. A fixer never pushes an empty commit or a change made only to move the head.
- After a fix the PR goes back through reviewing: a fix changes the patch, and approval is keyed
  by patch.

## 10. Workspaces

The loop owns each agent's workspace. The workspace spikes decided the design
([docs/spikes/factory-loop-workspace/README.md](../../spikes/factory-loop-workspace/README.md)): a
small companion plugin, `factory-loop-workspace`, starts each agent in its slot and carries the
write guard, the Bash timeout and the stop gate. It must be a plugin of its own, because the
engine skips a plugin's own hooks for everything its own code starts, and the loop starts its
agents from its timer (the spike notes, above).

### 10.1 Slots: W1 leases, W2 frees

- **Pool.** The treehouse pool of the main checkout, as today (`poolSize` 16, 13.4.1). The
  loop leases with the holder `factory-loop:<N>:<life>` and finds its leases again by holder in
  `treehouse status --json`. It never infers a slot's owner from reflogs.
- **W1, lease.** A record that needs a slot and has none: a queued record (resumes first, by park
  time, then new claims, by claim time) when the records in designing to merge-queue number fewer
  than the effective cap (K: `maxInFlightIssues`, or the memory ceiling when that is lower, 13.4.2), free slots exceed `worktreeReserve`, and the tier allows the class
  of the state the lease leads to; or a record in a slot state whose lease vanished (it already
  counts in flight). The action is `slot` op `lease`: `factory-slot lease <N> <life>`, which runs
  `treehouse get --lease --lease-holder factory-loop:<N>:<life> --base <default> --json` and
  prints `LEASED path=<p> lease=<id>`. The branch is checked out by `prepare` (10.2).
- **W2, free.** A slot with a `factory-loop:<N>:<life>` holder is freed when no record of that
  issue and life is in a slot state and no step entry of it runs. Action `slot` op `free`:
  `factory-slot free <path> <lease> <loop dir> [--keep-scratch]` kills the slot's processes (10.8),
  saves leftovers (10.2) and prints their file, removes the life's scratch folders (10.2) unless
  W2 passes `--keep-scratch`, runs `git reset --hard` and `git clean -fd`, then `treehouse return
  <path> --if-lease-id <lease>`, which also ends lingering processes. It is done when the slot
  shows available. From the free's start the lease counts as gone, so a record resumed meanwhile
  waits for it to go back rather than step onto it. A second lease of a live life (a lease whose
  answer was lost, taken again) is freed the same way once nothing of the life runs. For one
  issue, W2 runs before W1, so a slot the issue still holds is freed before it asks for another. Parking and waiting free the slot, so W2 passes `--keep-scratch`
  when a record of that issue and life is `parked` or `waiting`: a resume continues the life and its scratch
  folders. A free of the life after the resume removes them; the tool also prunes any older than
  7 days, which bounds the folders of a parked issue never resumed.
- **Budgets.** The executor gives the tool its op's timeout less a margin (`--budget-ms`), and
  the tool ends its own commands inside it, so no `treehouse get` it started can finish later and
  take a second slot.
- W2 is a rule over the pool, not an entry action, so a slot is freed however its issue left:
  parked, waiting, dropped, merged, closed by hand or lost to another device (#601).

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
   "is already used by worktree", exit 128;
5. write the step marker `factory-step.json` into the slot's own git dir (`git rev-parse
   --git-dir`), never into the tree, so it cannot be committed: `{ v: 1, repo, issue, life, seq,
   step, role: 'writer' | 'reader', branch, gateCommands, gateTimeoutMs, loopDir, scratch, gateConcurrency?, gateWaitTimeoutMs? }`
   (the last two are filled by the slot executor, which knows the CPU count; a marker without
   `gateConcurrency` means no limit);
6. make the step's scratch folder, `<loop dir>/scratch/<N>-<life>-s<seq>` (mode 0700, outside every
   repository), the `scratch` of the marker. The tool refuses (exit 3) a marker whose `scratch` is
   not exactly that path. It is the step's `$TMPDIR` (10.5): the loop's prompts name it, and
   `free` removes it (10.1). Folders older than 7 days are pruned at every prepare and free (D-46);
7. print `PREPARED head=<sha>`, `KILLED <n>` (step 1's count), and `LEFTOVERS file=<f>` when it
   saved any.

The builder and fixer start from origin's branch head. Committed and pushed work always survives a
retry. Uncommitted work of a failed attempt, and work it committed but never pushed, survives in
its leftovers file, which the retry's prompt names (5.1). A `prepare` that fails is the attempt's
`unknown`: it is part of the attempt, keyed with it.

### 10.3 Starting the agent in its slot

- The loop spawns the agent with `$.agent.spawn` (`driver-io.ts`). The prompt's first line is `factory-slot:
  <absolute slot path>`. The loop also passes `cwd`, so it keeps working once the engine honours
  that argument, which on 2.1.300 it drops (the spike notes).
- The companion's `agent.spawn` hook reads that line and the slot's step marker. It checks that
  they match the spawn (issue and seq; D-11 puts the issue in the agent's name), calls
  `next({ ...e, cwd: slot })`, and records `agentId -> marker` from the result. It refuses the
  spawn (`deny`) when the marker is missing or does not match, and the refused spawn is the step's
  `unknown`.
- Children the agent starts (a builder's sub-agent) inherit the folder, and the companion maps
  them through `parentAgentId` (the spike notes).
- Proven on Claude Code 2.1.300 for a spawn from a frameless timer, headless and interactive:
  `pwd`, relative Bash and Write paths, Read, `git` and the agent's system prompt all resolve to
  the slot. A `cd` elsewhere is reset to the slot on the next call.

### 10.4 The write guard

The companion's `tool.call` hook, for agents in its map and their children. A second plugin's
hooks fire and block for timer-spawned agents (the spike notes):

- **File tools** (Edit, Write, MultiEdit, NotebookEdit): the path, resolved against the slot
  because Write's `file_path` can arrive relative, must be inside the slot for a writer. A reader
  may not write anywhere in the repository. Both may write outside the repository (for example a
  scratch file in the step's scratch folder, 10.5). The deny reason names the slot.
- **Refused for every loop agent:**
  - in Bash, `gh pr create|edit|merge|close|reopen|review|update-branch`,
    `gh issue create|edit|close|comment`, `gh label` and `gh api` with a write method or field
    flags: the loop owns these. The companion's list (`hooks/guard.ts` `GH_WRITES`) also holds
    their aliases (`gh pr new`, `gh issue new`) and the other GitHub writes (`gh pr revert`,
    `gh repo edit`, `gh secret`, `gh variable`, `gh run rerun` and the like);
  - in Bash, `no-mistakes`, `axi` and a push to any remote but `origin`;
  - any call with `run_in_background: true`, `Bash` and `Agent` alike: a loop agent works in the
    foreground, a command under its 10-minute timeout (10.5), so it neither ends its turn while
    work it started runs nor sits polling for it. The
    reason tells it to run the call in the foreground with a timeout;
  - an `Agent` call with any `isolation` (`"remote"` always runs in the background, and
    `"worktree"` makes a git worktree).
- **Bash, refused for a writer:**
  - `git push` to any ref but `origin <branch>`;
  - any force push (`-f`, `--force`, `--force-with-lease`, a `+ref`);
  - branch creation (`git switch -c|-C`, `git checkout -b|-B`, `git branch <name>`) and
    `git worktree`.
- **Bash, refused for a reader:** `git commit` and `git push`.
- **The main checkout.** callum-flow's `forbid-main-checkout-write.sh` already refuses a
  sub-agent's writes there, Bash included, and it fires for these agents
  (`plugins/callum-flow/hooks/forbid-main-checkout-write.sh`). The loop relies on it and leaves callum-flow's `hooks.json` alone.
- **Each refusal** is appended to the companion's log, and the loop logs it as an intervention
  (`guard:*`, 7.2).
- **Command lines.** The rules apply to every simple command a line runs, through separators,
  subshells, wrappers (`env`, `timeout`, `bash -c`, `eval` and the like) and command
  substitutions, those inside double quotes and unquoted here-documents included.
- **Limits.** The Bash rules match commands, not effects. A Bash write into another slot is not
  refused. The tripwire (10.7) covers the main checkout, and each slot is reset at its next
  prepare.

### 10.5 The 10-minute Bash timeout

Every agent the loop starts runs with a 10-minute Bash timeout, set two independent
ways inside the plugins. No image or template change is needed:

- the loop's `session.start` calls `$.env.set('BASH_DEFAULT_TIMEOUT_MS', '600000')` and
  `$.env.set('BASH_MAX_TIMEOUT_MS', '600000')` (proven in the spike);
- the companion's `tool.call` hook gives a loop agent's Bash call with no `timeout` the value
  `600000` (the spike's rewrite, in the companion, whose hooks reach these agents).

- the companion's `tool.call` hook gives a mapped agent's Bash call (the agent and its children)
  the marker's `scratch` as `TMPDIR`, `TMP` and `TEMP`: the command becomes `export TMPDIR='<s>'
  TMP='<s>' TEMP='<s>'`, a newline, then the agent's own command, unchanged. The session-wide
  `$.env.set` cannot give an agent a folder of its own, and `> $TMPDIR/x` with `TMPDIR` empty
  writes `/x`. The write guard judges the agent's original command, before the rewrite. The
  companion uses `scratch` only when it is absolute, normalized and under `<marker loopDir>/scratch/`;
  a marker with no usable `scratch` (an older loop), and a caller it does not map, leave the
  command as it is.

A foreground test run then finishes instead of being moved to the background after 120 seconds,
which is what led agents to write polling loops that matched themselves. The
prompts carry `FOREGROUND_RULE` (`prompts.ts`) and the `COMMAND_RULE` of `prompts-triage.ts`, which
has no no-mistakes exception.

### 10.6 The stop gate

The companion's `classic.SubagentStop` hook, for a writer whose marker lists `gateCommands`
(the owner's rule: a builder's work is checked before it ends):

- It runs the commands in the slot, joined with `&&`, through `$.process.run` with one total
  budget, `gateTimeoutMs` (10 minutes). The gates take about 58 s serially on the 16-CPU container
  (the spike notes).
- **On failure** it returns `{ block }` with the failing command, its exit code and the last 150
  lines of its output. The agent carries on with them, and is refused again while they fail. There
  is no cap. The step's own timeout (90 or 60 minutes) and the unknown path bound it.
- **When the gate cannot run** (the budget runs out, or the run fails to start), the hook lets
  the agent finish and records the gate as unknown. CI stays the authority and decides in
  reviewing. A gate is never passed silently: it is appended to the companion's
  log, an intervention (`gate-unknown`, 7.2).
- **Each run** is one line of the companion's log (`<loop dir>/companion.jsonl`, 7.2) with the
  slot's HEAD, its duration and, for a fail, the command and its exit code: cause `gate-pass`,
  `gate-fail` or `gate-unknown`. Only `gate-unknown` is an intervention; the loop skips the other
  two, so the log is the audit of every run. The last result is also written to
  `<slot git dir>/factory-gate.json`, which the next run overwrites.
- **The start line, and a gate a restart cut.** The loop's restart (or a wind-down's cap) can end the
  process that runs a gate before the gate settles, and then nothing on disk says the gate began.
  So when a gated writer's `SubagentStop` begins, before it asks for a turn, the companion appends
  one `gate-start` line (the issue, life, seq, `startedAt`, which its settling line carries too,
  `slot`, `gitDir` and `process`, the id `pid:start-time` of its process from `/proc/self/stat`).
  It is neither an intervention nor a `gate_run`. The stop gate body is one function for the stop and
  the recovery, so the two cannot drift.
  **Recovery.** Only the session that holds the loop dir's `act.lock` (its lease names the session
  and has not expired) runs it, at most once per loop dir per process, checked on each handshake
  beat until it has run, from the beat's clock callback and not inside a hook handler, so the 10 s
  handler budget never cuts it. It reads the last 24 hours of `companion.jsonl` and picks each
  (issue, life, seq) whose newest line is `gate-start` or `gate-wait`, with no `gate-pass`,
  `gate-fail`, `gate-unknown`, `gate-rerun` or `gate-cut` at or after it, and whose start line's
  `process` is gone (`/proc/<pid>/stat` no longer gives the same id; a line with no `process`, from
  a companion before this one, counts as gone when it predates this process's start). When the
  slot's `factory-step.json` still names that issue, life and seq as a writer with gate commands,
  it writes `gate-rerun` and runs the gate through the same turns and budget, then writes the usual
  settling line with `rerun: true` and `factory-gate.json`; nothing is blocked, because no agent is
  left. Any other candidate gets one `gate-cut` line whose reason says why and runs nothing. A
  candidate gets at most one `gate-rerun` or `gate-cut`, across beats and restarts. `gate-rerun`
  and `gate-cut` are interventions (7.2); a re-run's settling line gives one `gate_run`. The
  loop treats a re-run's `gate-pass` or `gate-unknown` as any settling line (10.8). A re-run's
  `gate-fail` ends the hold instead, and the step ends lost (10.8).
- **Turns.** The companion runs at most `gateConcurrency` stop gates at once across every slot in
  its process, because `scripts/test.sh` sizes its pool to the whole container and several full
  gates at once would starve each other into timeouts. `gateConcurrency` is a whole number of at
  least 1 or `auto`, which is `max(1, floor(cpus / GATE_CPUS))` with `GATE_CPUS = 8`, the CPUs one
  full gate is assumed to use; `cpus` is `os.availableParallelism()` (cgroup-aware), read once
  per loop process through `node -e`. The slot executor writes the resolved number into the step
  marker as `gateConcurrency` (with `gateWaitTimeoutMs`); a marker without it takes no turn.
  A writer that finishes while every turn is taken waits in FIFO order. The engine gives every
  hook handler a budget of 10 000 ms that host calls pause and clock operations do not, so a
  bare wait for a turn would be cut off at 10 s (`exceeded 10000ms budget`), and the handler,
  which the engine does not cancel, would run its gate later in a slot the loop has left. A queued
  waiter therefore always has a host call in flight: a `sleep` of a few seconds through
  `$.process.run`, started again as each ends and raced against the grant, so a granted turn starts
  its gate at once; a slice that fails ends the slices and the wait goes on with the grant alone.
  The wait stays bounded by `gateWaitTimeoutMs`. A handler the engine has cut off runs no gate when
  its turn comes: it gives the turn back and writes nothing. The `.catch`'s `gate-unknown` reason
  names the error: `the stop gate hook failed (<error>)`. The `gateTimeoutMs`
  budget starts when the gate holds its turn.
  **The engine's stall limit.** The handler's own budget is not the only bound. Claude Code ends an
  async agent that makes no progress for `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` (600 000 ms by
  default on 2.1.304) and aborts the signal of everything running for it, the agent's stop hook
  included. A queued gate (a wait, then a run) is such a hook, so one that lives past 10 minutes in
  all was cut with `process.run(sh) aborted`, however its own clocks stood. The companion therefore
  sets the variable with `$.env.set` in its `agent.spawn` hook, for a writer whose marker lists gate
  commands, to `gateWaitTimeoutMs` (30 minutes if the marker has none; 0 with no `gateConcurrency`)
  + `gateTimeoutMs` + 5 minutes, and only upwards: the variable is the session's, so it never lowers
  a limit already set, and once set it applies to every async agent of the session, the owner's own
  included: a stalled agent is noticed that much later (45 minutes with the defaults). Claude Code reads it as the agent starts, so it is set before the spawn goes on.
  Nothing in a consumer's settings changes. The `gate-queue` case of the workspace probe proves it
  (below); a gate the engine cuts anyway is recorded as `gate-unknown` whose reason says `the hook
  was cut off N s after the gate started (W s waiting, R s running)` and not as a failed command.
  **The container's gate slots.** The turns above count the gates of one process; the stop gates and
  the writers' own gate-command runs (an agent running `npm test` itself) share one container-wide
  limit besides: `gateConcurrency` slot files `<loop dir>/gate-slots/<i>.lock`. A run holds one
  through `flock(1)` on an open fd in `plugins/factory-loop-workspace/bin/factory-gate-slot` (POSIX
  sh), so the kernel frees it when the holder dies, and the wrapper closes that fd for the command
  it runs, so a daemon the command leaves behind never keeps a slot. The wrapper tries each file
  with `flock -n`, sleeps briefly and tries again until its `--wait-ms` has passed (0: one round);
  it prints `factory-gate-slot: slot <i> after <ms> ms` and runs its argv, or prints a `busy` line,
  runs nothing and exits 75. Given `--log` it appends one `agent-gate` line (`command`, `waitMs`,
  `slot`, `exit`, `ms`, `refused`) to the companion's log; the loop reads none of it (not an
  intervention, a gate result or a recovery candidate).
  *The stop gate* cannot hold one flock across its commands (each is its own `$.process.run`, at most
  10 minutes), so it takes a slot per command, with no `--log` and a `--wait-ms` of one short slice
  (5 s). An exit 75 with only the busy line is retried, each retry a new host call so the handler's
  10 s budget never runs, until the cap (`gateWaitTimeoutMs` less the turn's wait) is used up: then the
  gate is `gate-unknown` naming the slot wait, never a pass. The wrapper's first line is stripped from
  the output. The wait is not the gate's time: `runGates` leaves it out of `gateTimeoutMs`. It is in
  `waitMs` (so `gate_run.wait_ms`), and the settling line and `factory-gate.json` also carry
  `slotWaitMs` (0 when none; absent for a marker without `gateConcurrency`, which runs exactly as
  before, with no wrapper).
  *The agents* get the wrapper through the companion's `tool.call`: with `gateConcurrency` in the
  marker, a mapped agent's Bash call (a writer's and its children's) starts with a line that defines
  one shell function per program among the `gateCommands`. The function calls the wrapper when the
  words of its own call equal the rest of a gate command (`npm test`, also in `npm test 2>&1 | tail`)
  and goes on to the program otherwise (`npm test -- <id>`, `npm ci`); quoted text never calls it.
  A gate command with shell syntax or a path program is not wrapped, and the guard still judges the
  original command. The agent's wait is `max(0, timeout - gateTimeoutMs)` (`timeout` the call's own
  or 10 minutes), so the wait and the run fit inside the call: at the defaults a busy container
  refuses at once, and the busy line tells the agent to run a subset or leave the full run to the
  stop gate.
  The turn is given back in a `finally`, whether the
  gate passes, fails, is unknown or the hook throws. A wait past `gateWaitTimeoutMs` (30 minutes)
  leaves the queue and is recorded as `gate-unknown` whose reason names the wait, never as a pass;
  the agent may finish, as with any unknown gate. A gate that waited writes a `gate-wait` line
  when it gets its turn (`waitMs`, `queuedBehind`; not an intervention). Every gate line carries
  `waitMs`, `concurrency` (null: no limit), `startedAt` (an ISO string read before the turn was
  asked for, with or without a limit) and `queuedBehind` (0 when the turn came at once), and
  `factory-gate.json` carries `waitMs`. The loop writes one free `gate_run` event for each such line
  of `gate-pass`, `gate-fail` and `gate-unknown` (`gateRunRules`, `rules-gates.ts`), keyed
  `i<N>/l<life>/s<seq>/gate/<started_at ms, base 36>`. A line from the companion of v0.51.0, with
  `waitMs` but no `startedAt`, gets `started_at` = its time less `ms` and `waitMs`, and
  `queued_behind` from the `gate-wait` line of the same seq inside the run (0 when `waitMs` is 0,
  else skipped); a line with no numeric `waitMs`, and any line whose values the schema refuses,
  gives no event. The companion writes no event itself.
  Flakes (rule S2): each gate line also carries `clean` (true when `git status --porcelain` ran
  and printed nothing before the commands and the head did not move during them; false when the
  tree was dirty or the head moved; null when it could not be read, and on the wait-cap
  `gate-unknown`), and a `gate-fail` carries `failedTests`, parsed by `failedTests(output)` of
  gate.ts from the failing command's full output: `FAIL <name>` and `(fail) <name> [<n>ms]` lines
  after ANSI escapes and leading blanks are removed, the job wrappers of `test-job.sh` and `FAIL
  test setup:` left out, `FAIL test isolation: <what>` kept, duplicates dropped, names cut to 200
  characters, at most 20 (null for none). A `gate-pass` with `clean` true gets `flaky: true`,
  `failed_tests` and `failed_at` (the fail's `started_at`) only when the run before it (same issue
  and life, latest known start, any seq) is a `gate-fail` with the same non-null head and a clean
  slot, and no run of unknown start lies between; any other pass with `clean` present gets
  `flaky: false`, and one from a companion before `clean` gets no `flaky`. A `gate-fail` row carries
  its own `failed_tests`. The action's reason names the outcome.
- **Gate commands** are repo settings: `gateCommands` in `.claude/factory-loop.json`. dev-system
  sets `["npm run lint", "npm test"]` (CLAUDE.md, "Canonical commands"). Empty means no gate. The
  plugin ships no repo-specific values (CLAUDE.md, "This repo").
- **The loop ends a writer step only on that step's settling gate line** (10.8): a gated build or fix
  attempt is not taken while its stop gate still runs, or is about to, in its slot.

### 10.7 The main checkout

Nothing in v2 runs or reads in the main checkout, so a dirty main checkout holds no issue. Two
safeguards remain:

- callum-flow's guard refuses sub-agents' writes there (10.4);
- **the tripwire.** R1 compares the `checkout` source with the checkout it last settled on: the
  newest read with nothing left untold. A change (new tracked changes, or a moved HEAD) sends
  `tell(checkout)` once, with the paths and the steps that ran in that window. The notice stays
  planned on every pass until it is told, so a pass that holds it back (one wake at a time, a rate
  cap, a store-blind pass, a failed read) loses nothing. After a restart, changes not told before
  are told. No step's outcome changes: a writer's ok already needs its commits on origin, and
  failing every step that overlapped would charge other issues for one agent's mistake. A moved HEAD
  counts only when the new read is not on origin: its branch is the default branch, its upstream
  is `origin/<default>` and it is 0 commits ahead (behind is allowed, since another worktree's
  fetch can move origin/main after the pull). A fast-forward to origin's head, as the hourly
  upgrade makes, is the owner's own checkout following origin and is not told; the base moves to
  it and R1 logs one skip line (old and new HEAD, commits behind). A commit ahead, a branch switch,
  a detached HEAD, no upstream or an unknown ahead count still tells, whoever moved it, and new
  tracked paths tell whether or not HEAD moved onto origin. The loop never cleans the main checkout.

### 10.8 Ending a step, and reading answers

- **An answer ends the step when it is read.** The loop reads each running agent step's answer
  file on every pass, not only at the agent's `turn.complete`. A valid answer
  ends the step at once, except a writer's. A build or fix attempt whose repo has stop-gate
  commands (gated) ends on one rule at all four reads (the per-pass read, the agent-list read
  before marking lost, `turn.complete` with reason `answer`, and a reload): its answer, `ok` and
  not-ok alike, is taken only once the companion log holds a settling gate line for that attempt,
  the newest `gate-pass`, `gate-fail` or `gate-unknown` line with its issue, life and seq dated at
  or after its `startedAt`, of cause `gate-pass` or `gate-unknown`. A newest `gate-fail` keeps the
  step open, as the agent is refused and works on; `gate-wait` lines are ignored. A newest
  `gate-fail` with `rerun: true` (the recovery's run of a gate a restart cut, 10.6) refuses
  nobody, since the agent that held the step is gone: it ends the hold and the answer is not taken.
  The next pass's agent-list read no longer holds the entry, so it ends lost, and as it started
  before this module load it gets the free re-run with cause `load`, whose builder then meets the
  failing gate. A re-run's `gate-pass` or `gate-unknown` settles a held entry from before the
  restart, with the same note. A turn that
  completes first leaves the step `running` (held): the agent list does not mark it lost, and a
  later pass ends it when the line arrives. The hold is bounded: `gateWaitTimeoutMs` plus
  `gateTimeoutMs` plus 2 minutes from its start, a reload restarting the count, after which the
  answer is taken anyway (`(no stop gate line within N min)`); an unreadable log stays held until
  then. The summary says `(after its gate-pass at <iso>)` or `(after its gate-unknown at <iso>)`.
  An ungated writer's `ok` is read when the agent's turn ends, its not-ok when read; readers end
  when read. A turn that ended in error, aborted or refused never ran the stop gate, and is read
  as before.
- **Before an agent step treats its agent as lost,** and before it spawns, it looks for a valid
  answer already recorded for its key (`answers/<key>.a*`). One that is there is the result, as the foundation does before marking an agent lost (13.6, `exec.ts`).
- **A writer's answer is confirmed on origin.** On a builder's or fixer's answer, the loop reads
  `git ls-remote origin refs/heads/<branch>` directly and attaches the head to the result. A failed
  read makes the result unknown, never not-ok.
- **Stopping.** At the next seq the entry actions stop the old step: TaskStop for its agent when
  it is still listed at work (13.6.1, `stop-agent`), then `factory-slot kill <path>`, both best
  effort (4.5). There is no grace period and no inference from a listed status.
- **`factory-slot kill`** sends SIGTERM to every process whose working directory is the slot or
  inside it, and SIGKILL to survivors after 5 seconds. It prints `KILLED <n>`, as `prepare` and
  `free` do when they end a slot's processes; the slot action's outcome keeps n and its summary
  names it, so an agent that left processes behind shows in the decision log. It refuses a path
  outside the pool and a lease whose holder is not `factory-loop:`-prefixed. A process that moved
  its working directory out of the slot survives it until W2's `treehouse return`, which ends
  lingering processes. The 10-minute timeout removes the reason agents left pollers behind.

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
  (`coder/push.sh`) lists `factory-loop-workspace` beside `factory-loop`.
- **Re-probe.** Two points are proven
  only in nearby shapes: a long `$.process.run` inside a second plugin's `classic.SubagentStop`,
  and `$.env.set` with no hook frame open. The probe stays in the repo and is re-run on each
  Claude Code upgrade (`docs/factory-loop/probes/workspace-probe/`). A third point is the stall
  limit of 10.6: its `gate-queue` case runs two writers under the real companion, the second
  gate waiting about 540 s behind the first and then running 300 s, and `gate-queue-bare` shows the
  same wait and run in a bare hook. They also need the 15-minute run, so they are not in the default set.
- **Fallbacks**, stated and not built:
  - if the companion's long gate run proves unreliable: the same gate as a classic command hook
    in the companion's `hooks/hooks.json` (`timeout` 900, the gate's own budget 600 s), keyed by
    agent id through a map file the companion writes at spawn. This shape is proven (the spike notes);
  - if a future engine stops applying a `cwd` set by a hook: start each agent as a separate
    `claude -p` process in its slot (the spike notes). That is a large change for the owner to decide;
  - if no hook route fires at all: the owner's fallback: the loop runs the gates after
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
- **Each deny** writes one `prompt_denied` event (`callum-flow-event --type prompt_denied --data <json>
  --issue N --repo R`, run in the slot) and one line of `companion.jsonl`, cause `prompt-denied`,
  which is an intervention (7.2). The data holds the schema's fields, null when unknown: `life`,
  `seq`, `step`, `attempt`, `agent_id`, `agent_type`, `tool_name`, `tool_input` (a Bash command,
  else the JSON input, clipped to 2000 characters), `ask_reason`, `slot`, `session`, `transcript`
  (the agent's own: `<session transcript without .jsonl>/subagents/agent-<id>.jsonl`, learned from
  `classic.SubagentStart`), `branch` and `pr`. Writing either never throws out of the hook and never
  turns the deny back into an ask: an image whose `callum-flow-event` cannot write the event still
  gets the deny and the log line. A hook that fails for a mapped agent after `next` returned `ask` still denies.
- **`classic.Notification`** with `notification_type` `permission_prompt` or
  `worker_permission_prompt` and an `agent_id` in the map writes one `prompt_waiting` event with the
  same data, except that it has no `ask_reason`, `tool_name` is null and `tool_input` is the message
  (clipped to 2000 characters). Without an `agent_id`, or with an unmapped one,
  it writes nothing. It always returns `next(e)`. There is no `prompt_answered`: the engine shows a
  mapped agent's answer to its prompt through no hook the companion could tie to the prompt.
- **The map** keeps what the note needs: `agentType` (per agent, children included), `attempt` (the
  name's `a<k>`), `pr` (the step marker's, `null` when the issue has none or an older loop wrote the
  marker) and `transcript`. A record kept before this change logs `none` for them.
- **The rule.** The command rule carries: "Never `rm` a glob under an unguarded variable: use
  `"${VAR:?}"/*` or a literal path.", in every prompt and agent definition.

### 10.11 Wind-down

A stop (a restart for an update, or the Coder workspace stopping) cuts every running agent step. A
wind-down lets the loop finish what runs and start nothing, so a stopper can wait for it
(`windDownMinutes`, Appendix A). It is a mode of the loop, not a state of an issue: it holds no
record and no ledger entry.

**The files** are three fixed names in the loop's directory (`<loop dir>/`):

| File | Written by | Contents |
|---|---|---|
| `wind-down.request` | the stopper (the stop script, or a person by hand), or R2 for its `restart-self` (13.11.2) | JSON `{ "requested_at": ISO, "trigger": "restart-self" \| "coder-stop" \| null }` |
| `wind-down.status.json` | the loop, each pass in wind-down | below |
| `wind-down.stop-now` | `/factory stop-now`, or by hand | one shot: JSON `{ "at": ISO }`; any content counts |

Observe reads the request and the stop-now file each pass into `V2State.windDown` (`request`,
`stopNow`, and `previous`: the last status file's `requested_at` and `started_at`). A missing request
is no request. A request that is not a JSON object with a `requested_at` time, or has a `trigger`
that is neither name nor null, is a request at the file's modification time (`stat`), with a
decision-log problem line (`wind-down: ...`), so a bad write never leaves the loop starting work
during a stop. With `windDownMinutes` 0 the request is ignored.

**The guard.** `windDownOf` gives `off`, `active` or `stale` (below). In an active wind-down
`windDownGuard` runs once in `planV2`, after every rule ran and before admission, and drops each
start action with the skip line `wind-down: no new start (<kind>)`:

- `claim` (S1 and H1), `agent-step` (every step and attempt, re-runs included), `slot` with `op: lease`
  (W1), `queue-update` (Q1), `queue-merge` (Q2), `ci-rerun`, and the `judge` and `task` wakes (the O3
  release task included);
- `restart-self`: R2's `restartOf` returns null with the skip line `R2: wind-down`. R2 itself writes the
  `restart-self` request before it restarts (see "Restart after a capped wind-down", section 15).

It keeps everything that finishes work: a running step's answer is read and its `transition`, `pr`,
`label`, `comment`, `event` and `split` effects run; `slot` prepare, kill and free (W2), `stop-agent`,
R1's releases, `heartbeat`, `sweep`, and every `tell` (owner tells included) still run. A running stop
gate, and a queue action or release task the ledger holds as running, are left to end and their
results are read by the next passes. The next step after a finished one is an `agent-step`, so it is
dropped.

**The status file.** Each pass in an active wind-down writes `wind-down.status.json` atomically (a
temp file beside it, then `mv` over it: `WIND_DOWN_WRITE_SCRIPT`), and a pass outside wind-down
writes none and removes no request:

```
{ "requested_at": ISO, "started_at": ISO, "cap_ms": windDownMinutes * 60000, "running": {
    "steps": [ledger keys of running agent-step entries], "gate": bool, "queue": bool, "release": bool },
  "idle": bool, "stop_now": bool, "at": ISO }
```

`started_at` is the first pass that saw this request (read back from the previous status file while
its `requested_at` matches). `gate` is true when a build or fix step runs: the loop cannot see a
stop gate apart from its step, whose hook runs it, so a running writer step may be in its gate.
The wind-down waits for a held writer step, so it waits for its gate; a gate the cap cuts anyway is
run again by the companion after the restart (10.6, recovery).
`queue` is a running `queue-update` or `queue-merge`, `release` a running release task. `idle` is
true when no step, gate, queue action or release task runs. `stop_now` is true when the stop-now
file exists. The stopper (#842) waits for `idle` or `stop_now` or its own timeout.

**The title** carries it as its first word after the counts: `winding down <m>m · <n> running`
(m: whole minutes since `started_at`; n: running agent steps), through the title's `before` words.

**A request the stop never followed.** A request older than `cap_ms` plus 5 minutes while the loop is
still running is `stale`: the loop plans normally again from that pass, removes the file
(`rm -f`, in the same pass) and tells the owner once (`tell(wind-down-stale)`, keyed
`tell:wind-down-stale:<requested_at ms>`, so a file that could not be removed is not told again).

**The stopper** is the Coder stop script of the loop template (`coder/dev-system/wind-down.sh`, a
`coder_script` with `run_on_stop` when the template variable `wind_down_minutes` is above 0, 10 for
`orchestrator-loop`; the container gets that cap plus 60 s of stop grace). It runs for every loop dir
`<config dir>/factory-loop/<owner>__<repo>` at once, against one deadline, and for each:

- **Off.** If the repo's effective `windDownMinutes` is 0 (repo `.claude/factory-loop.json`, then the
  user `config.json`, else 10), or the `OFF` file exists, it writes no request and records outcome
  `off` (`waited_ms` 0, `stopped_at` = `requested_at`).
- **The request.** It keeps a `restart-self` request (written by R2 just before `dev-restart-self`) no older than the cap plus 5 minutes; otherwise
  it writes `{ "requested_at", "trigger": "coder-stop" }` atomically (temp file, then `mv`).
- **The poll.** Every 2 s it reads the status, counting only one whose `requested_at` equals the
  request's. It ends at the first of: the stop-now file or a status with `stop_now` (outcome `now`);
  a status with `idle` (`idle`); the cap, the smaller of the status `cap_ms` and the template's,
  counted from `requested_at` (`cap`); no matching status within 3 minutes, meaning the loop is not
  passing (`idle`, 0 running).
- **The event.** One `wind_down` event per loop dir, with `running_at_request` from the first matching
  status and `cut_at_stop` from the last (for `cap` and `now`; 0 otherwise).
- **Cleanup.** It removes only the stop-now file (one shot). The request and status files stay,
  so the loop starts nothing in the seconds until Coder stops the container; the workspace start
  (`wind-down-start.sh`, run from the startup script before the loop) removes all three, so the
  next start does not wind down again. A request left by a stop that did not stop the container
  ends by the stale rule after the cap plus 5 minutes. The script then gives the heartbeat its
  `--final` beat. It always exits 0.

## 11. Releases and parking

- **Merges never wait for releases.** No rule holds a green, reviewed PR for a release, a bump, a
  Run it or a template change. There is no sequencing call and no run-it hold
  (14.1).
- **Releases** are cut by the release task (O3, kept). While the Next milestone has no open item and
  at least one closed, `task(release)` wakes the judge as an hourly review (at most one per UTC
  clock hour, whatever its key, and none while a release task runs (an earlier hour's included; the skip `release review running: <key> started at <ISO>`, plus `; waiting #N, #M` when records wait); a wait that arrives while it runs joins it, and one that arrives after the hour's review gets the next hour's; also while a record waits on a `tag-contains` condition, even with open items or none closed, a readable milestone source still required), keyed `task:release:<tag>:<YYYY-MM-DDTHH>`, whatever the waiting set is, with the last release
  tag (`unknown` before the first read, `none` before the first release) and carrying `closed`,
  `expected`, `tag`, `oldest` (the oldest merge since that tag, omitted when unknown) and `cadence` (`minimumReleaseCadence`, always present, in short form), and `waiting` (the issues of the records that wait on a release tag, comma-joined; omitted when none); a release wait is the judge's to answer, never the owner's; the judge
  decides whether to cut the release now or `hold` until the next hour (the action's reason is `task release: #N, #M waiting` when waiting issues make it due, else `task release`), and cuts the release with its standing
  authority (PR #634, `27a13ce`). After a `done` answer (the judge started a release) the loop sends no release review until a newer tag is seen (the tag view's newest tag, else the release read's) or `releaseInProgress` has passed since the task ended; an entry tagged `unknown` ends only by the window, `none` once any tag is known. The suppression records one skip per held pass (rule O3, `release in progress: <key> answered done at <ISO>, tag <tag>; until a newer tag or <ISO>`). A `hold`, `failed` or timed-out task starts none. The key's and field's `tag` is the newest known tag, and `oldest` is omitted when that tag differs from the release read's. "A Run it change ships alone" belongs to that task: it
  chooses the commit to tag, then does the Run its of the milestone's run-it issues.
- **The release log** has two producers, both opt-in with the Next milestone (a repo without one logs
  nothing). O4 logs each new release tag (the newest tag the milestone reads hold) once, through
  `callum-flow-released <tag> --repo R --source <loop|workflow>`: `loop` when the ledger holds a
  `done`-answered release task keyed on the previous released tag (the tag of the newest done
  `released` entry, else of the newest done/done release task that differs from the new tag), else
  `workflow`. The `released` action is keyed `released:<repo>:<tag>` and held in a GitHub backoff. An
  image without the tool ends it done with a summary, and a usage error (exit 2) is never retried.
  O5 logs one `milestone_state` event whenever the milestone's reading (closed, open, oldest closed
  issue, last tag, expected size, holding) differs from the last one logged, keyed
  `milestone-state/<fingerprint>/<base-36 end of the newest done entry, or 0>`; a reading that comes back is
  logged again. O5 waits until a tag read is held; `last_tag` is null only when the reads show no release. `holding` and `hold_reason` come from the newest release task when it answered `hold` on
  the newest tag.

  A merged issue that comes back open would hold Next forever (a closed record is absorbing and no
  `ready` label brings it back). Under O3, when the milestone reading (taken after the record closed)
  lists an issue open whose stored closed record has why `merged` or `merged-by-hand`, a done rollout
  other than `run-it` or `keep-open` (those stay open by design and were moved already), a done
  `close-issue` if one was planned, and no live record, the loop plans `milestone-later` for it and
  one owner `tell(reopened)` (fields `issue`, `pr`), both keyed by the merged life
  (`follow/reopened/milestone-later`, `follow/reopened/tell`), so once per life. It rejoins Next when
  it merges again. Detection relies on the closed record, kept 7 days: a later revert is not caught.
- **The release task never waits on the owner inside its wake.** A Run it that needs the owner
  (a workspace restart still needs asking) becomes an owner item, a comment and a tell, and the
  task ends. A wake held for the owner would hold every tell behind it (D-26, D-44).
- **The parts of a structured park travel on its transition.** The record's `parts` (3.2) and the
  transition's five note tokens carry the decision, context, options, recommended key and
  recommendation of a designer's, a triage's or a split child's structured question, so a reader of
  the event log has them without parsing the rendered `question`.
- **Parking frees capacity.** A parked (or waiting) issue leaves the in-flight count at once, and W2 frees its
  slot. Its claim stays live (H1 renews it), so no other device takes it.
- **Waiting is not parking.** A designer that is blocked only on a checkable fact waits (8.7): the
  record enters waiting (T16), leaves the in-flight count and frees its slot as a parked one does,
  and its claim stays live. Nobody has to act: the loop checks the conditions every pass and
  resumes the record itself (C1) through queued to designing, with a note naming what cleared. The
  owner may still end it earlier: `/factory resume N ["note"]` is the same `unpark` event (P1) and
  `/factory drop N` closes the life (E1) as for any record; removing `factory:waiting` is not a
  resume. The tell after 24 h is not an owner item.
- **One way to resume:** remove `factory:parked`, or `/factory resume N ["note"]` (a
  list of numbers is allowed). Both are the `unpark` event (P1). The note is the op's note or,
  for a label removal, the trusted comments posted after the loop's park comment (read with
  `callum-flow-issue-read --comments`). So an owner who answers on GitHub and removes the label is
  heard (#591). The daily reminder says that a comment alone does not resume.
- **Resume** goes through queued, because a slot is needed again, and resets the attempt, triage
  and fix budgets. It resumes the state the issue parked from, with the note for that state's
  step; a park at the fix cap resumes fixing (T10).
- **Drop, and bringing an issue back.** `/factory drop N` closes the current life (E1, `abandoned`
  with note `dropped`) and removes its labels. The issue stays open on GitHub (section 15).
  To bring it back, add `ready`: S1 claims it as a new life, and the old drop does not apply to it
  (4.1). No edit of `control.json` is needed. A drop also keeps R1 from putting
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

| # | Failure (evidence) | Outcome | How |
|---|---|---|---|
| 1 | Agents that had answered but were still listed at work held the main-checkout update and branch writes for up to 2 h; processes killed by hand | avoided, and generic | An answer ends the step when it is read, every pass (10.8); the next seq stops the agent and kills the slot's processes. Nothing waits on another issue's agent: no step reads the main checkout, and each branch has one writer by structure and by the write guard. A step that never answers meets its timeout. Bash calls end at 10 minutes (10.5) |
| 2 | The guard failed `head` after the loop's own update-behind, then judge, fixer and `-vN` PRs: 8 supersedes | avoided | No update of non-head PRs, no head or worktree clause, no new branches (3.5, 9.4), and agents cannot make branches (10.4) |
| 3 | A resumed escalation with an owner note reran the old head (#596) | generic | One unpark path: the parked state's step runs with the note (P1) |
| 4 | A run killed by a workspace restart was never recovered (#600) | avoided, and generic | No daemon runs. A step cut by a restart runs again free, once (U1), after the loop looks for its recorded answer (10.8). Review is keyed by patch and round, CI by head |
| 5 | Dropping an issue never returned its slot (#601) | generic | W2 frees every loop slot whose record is not in a slot state (10.1) |
| 6 | no-mistakes' fix agents in untrusted repo copies (#613) | avoided | no-mistakes is out of the loop's path, and the write guard refuses it (10.4); every agent runs in a loop slot |
| 7 | no-mistakes 1.84's PR body budget, body compare and self-abort; the `--closes` and `--ignore` adaptations | avoided | The loop writes the PR body through `neutral()` and its linkage (8.1); there are no gate responses |
| 8 | An inconclusive test gate was answered "fix" twice, then quiet for 80 minutes (#620) | avoided, and generic | No no-mistakes test gate; CI is the authority. The stop gate refuses while the gates fail, within the step's timeout; a gate that cannot run lets CI decide (10.6). A flaky check gets one re-run (8.5) |
| 9 | Implementers wrote to the main checkout (#624) | generic | Agents start in their slot, the companion confines file writes to it, and callum-flow's guard refuses writes to the main checkout (10.3, 10.4). The tripwire tells the owner of anything that gets past them (10.7). No other issue waits on the main checkout |
| 10 | `maxInFlightIssues` in the workspace file ignored; restart-self with no Coder token (#590); claims swept after 2 h offline (#589); an owner answer on GitHub released no hold (#591); the judge could not finish a release (#592) | mixed | Settings: the workspace file may set every key, and both files are read every pass (section 15). Token: environment; R2 tells the owner once when a restart fails, as the foundation's restart notice does (13.9). A lapsed claim is claimed again onto the same record (4.1). An owner answer on GitHub plus the label removal resumes with that answer as the note (11). Release: the judge's standing authority (PR #634); releases are out of the merge path |
| 11 | Usage tier stop-all for 42 and 197 minutes | kept, and generic | The foundation's tiers. A step killed by the window is a free re-run (U1), held until the tier allows it, so it costs the issue nothing. Merges are class `free` and go on in stop-all |
| 12 | Strict protection put every PR behind on every merge: 27 update-behinds for 4 merges | avoided | Only the head is updated: once per merge, plus once per outside merge during its CI wait (9.2) |
| E9 | #613's implementer stopped with no commit and no rule moved it for 549 minutes; #591's run died on a 429 and was answered as live | generic | No commit is `not-ok` (T6), so triage runs at once. Every record has a running step, a planned action or a named wait (property 3). A step killed by a 429 is a free re-run after the window (U1) |
| E10 | 282 passes from 02:41 at cap 7 of 7 with 4 queued and nothing moving | avoided | The seven were two merge holds (the loop has no such thing), an owner decision and a limbo (both parked, freeing capacity) and three no-mistakes refusals (no no-mistakes). Parked issues do not count, so the queued issues would have started. No wait on the owner holds capacity: there is no main-red hold and no reconcile hold |
| E20 | A gap in release authority held two green PRs for 583 issue-minutes | avoided | Merges never wait for releases, and the judge has standing release authority (11) |
| E21 | The usage window cost 1,119 issue-minutes | kept, and generic | The foundation's tiers. Steps killed by the window re-run free when it resets (U1). The step-unknown breaker stops an outage from spending every issue's budget (5.3). |

The other overnight failures are generic too:

- A designer that ended its turn with an async explorer running gave no answer. That is the U
  rows, and the guard now refuses background agents (10.4). The designer has no Agent tool at all
  now ([#851](https://github.com/cbundy/dev-system/issues/851)).
- `abandon` removing `ready` gives way to one owner interface: drop, then `ready` to bring it back
  (11).
- A misleading update failure is unknown, then triage, never a new branch.
- A fixer sent to an issue closed by a hand merge cannot happen, because `pr-merged` closes the
  record (E3).

## 13. The foundation

This section is the foundation of the loop, written as built: the driver, the sources, the
configuration, the foundation's rules, the actions, the ledger, wakes, notices, failure handling,
safety rails and observability. Its subsections and numbered items keep their numbers, because the
code, DECISIONS.md and the rest of this document cite them as "13.N.M" and "13.N item K". A bare
N.M elsewhere in this section is a section of this document outside section 13.

### 13.2 Architecture

```text
every passEveryMs (60 s), or at once when pinged:
    if mode is off or the kill switch exists: stop (title "off")
    if mode is act: check the safety rails (13.11.2); act only when they all pass
    state   = observe()                  read-only: CLIs, the engine, the store
    if acting: apply what the agent list and the wake timeouts prove to the ledger
    result  = plan(state, config)        pure: no I/O, no clock, same input -> same output
    if acting:
        for each action in result.actions:
            renew the act lease; start its ledger entry and save it; act(action); finish it
            (a heartbeat or a sweep only starts: its command runs on after the pass, 13.6.1)
    record(state, result, outcomes)      one decision-log line, the title
```

- **One pass at a time.** A ping or a timer tick that arrives during a pass sets a flag, and
  one more pass runs when the current one ends. Passes never overlap, and they start at least
  5 seconds apart. If pings drive more than 30 passes in 10 minutes, something keeps waking the
  loop without being handled: it ignores pings for 10 minutes and runs on the timer alone,
  logs a `loop` event and tells the owner once (section 13.11.4).
- **Start.** The loop starts from `session.start` and, as a fallback, from `session.append`
  (which fires every minute with the title), so it never depends on one event. The first pass
  runs 5 seconds after the module loads. It runs only in an interactive session: a session whose
  `session.start` says it is not (a `-p` run or the SDK, such as a review run that loads the
  plugin from the workspace environment) never observes or acts (D-61).
- **Pings.** An agent of the loop finished (`turn.complete` with its `agentId`), the model
  answered a wake (the answer tool or the main loop's `turn.complete`), or an owner control
  arrived (`/factory` or the control tool).
- **Off the pass.** `heartbeat`, `sweep` and `queue-merge` run off the pass (`OFF_PASS` in `hooks/act-off.ts`, the
  one list a later kind joins): the pass does everything it does for any action up to the saved
  `running` entry (kill switch, act lock, GitHub rate-limit hold, start, pre-check, save), starts the
  command without awaiting it and moves on, so a 40 s sweep no longer makes a 40 s pass. The
  command ends in the hook queue (below), never inside a pass. Planning does not plan its key
  again while the entry runs (the gate returns `running`), so no second sweep or heartbeat starts;
  a sweep and a heartbeat may run together. A merge never starts twice: a running one is
  `running` to the gate and to the queue step, and one lost to a reload has used its one attempt, so its
  outcome is read from the PR (9.3). A restart waits for a running merge (R2).
- **Between passes.** Hooks feed the ledger as things happen: an agent's answer, a wake's turn
  starting and ending, the answer tool, `/factory retry`, and the end of an off-pass command (13.6.1). They work only in act mode with no
  kill switch, one at a time and in the order their events came, on the same in-memory ledger
  the pass uses (section 13.7.1); a tool call changes that ledger at once and queues the rest
  (13.7.3a item 7).
- **Plan is the heart.** `planV2` (`hooks/v2/plan.ts`, 2.2) is pure: it imports types,
  `hooks/v2/*.ts` and `hooks/foundation.ts` only. Everything it needs, the time included, arrives
  in `State`. Actions already running or done are in the state's ledger, so re-planning an
  unchanged state yields no new action. Its result also carries the reasons it skipped
  candidates, for the decision log.
- **Observe and act are thin.** Adapters turn CLI output into typed values; executors turn
  actions into CLI calls, agent spawns or wakes, and record outcomes. Neither decides anything.
  The pass driver (`register.ts` and the `driver-*.ts` modules beside it) is the only code that
  holds the engine (`$`); `act.ts` dispatches each action kind to its one executor (`act-cli.ts`,
  `act-merge.ts`, `wake.ts` and v2's `hooks/v2/act-*.ts`, 2.2).
- **Modes.** `off` (nothing runs), `observe` (observe, plan and log; execute nothing; the
  default) and `act`. A kill-switch file forces `off` within one pass (section 13.11). An act-mode
  pass that a rail holds back runs exactly as observe mode does.

### 13.3 Observe

#### 13.3.1 State

```ts
type Ms = number                                   // epoch milliseconds
type Tier = 'normal' | 'slow' | 'stop-new' | 'stop-all'
type Stage = 'queued' | 'designing' | 'implementing' | 'in pipeline' | 'parked' | 'waiting'
           | 'ready to merge' | 'merged' | 'closed without merge'
type SourceName = 'factory' | 'facts' | 'runs' | 'queue' | 'github' | 'usage' | 'pool' | 'milestone'

type State = {
  now: Ms                         // read once per pass by observe; plan never reads a clock
  repo: string                    // owner/name
  device: string                  // DEV_MACHINE_NAME, else the hostname: the claim identity
  loadedAt: Ms                    // when this module instance loaded (restart detection)
  sources: Record<SourceName, { ok: boolean; at: Ms | null; error?: string }>
  usage: Usage
  issues: IssueView[]             // one per issue the loop may act on (13.3.2)
  queue: number[]                 // open, trusted issues labelled readyLabel, ascending
  runs: []                        // always empty: the loop reads no pipeline runs (13.3.3)
  pool: Pool | null               // the treehouse worktree pool
  agents: AgentView[]             // the session's agents that the loop spawned
  milestone: Milestone | null     // the Next release milestone, when the repo opted in
  release: ReleaseInfo | null     // the last release tag and the oldest merge since it, while the milestone qualifies
  ledger: LedgerEntry[]           // in-flight and recent actions (13.7)
  control: Control                // owner directives (13.4.3)
  lastTitle: string | null        // the title last set, so it is only set on change
  lastTitleAt: Ms | null          // when the last plan title was set, for the titleEveryMs throttle
  githubBackoffUntil: Ms | null   // act mode: GitHub writes wait until then (13.10 item 2)
  checkout: Checkout | null       // the main checkout (#544); null when not read (the replay)
  v2?: V2State                    // what v2 reads besides (2.4)
}

type Usage = {
  fiveHour: number | null         // percent, rounded up, as usage-check.sh prints it
  sevenDay: number | null         // the binding weekly window
  fiveHourResetsAt: Ms | null     // a window whose reset has passed counts as zero until the
  sevenDayResetsAt: Ms | null     //   next read (the replay found minutes stuck in Stop all)
  unavailable: boolean            // usage=unavailable, or the reading is older than usageStaleMs
  auth?: 'api-key'                // API-key mode (13.5.2 G3): the reading is spend, not windows
  spend?: { usd: number; budgetUsd: number; resetsAt: Ms } | null   // null with unavailable: a missing reading
  reason?: string                 // a missing reading's code: spend:no-budget, spend:bad-reset-day,
}                                 //   spend:no-session-cost, spend:bad-tally or spend:stale

type IssueView = {
  number: number
  stage: Stage | null             // callum-flow-factory-state; null when the database never saw it
  stageSince: Ms | null           // entered_at of that stage
  holder: string | null           // device of the latest claim
  run: string | null
  pr: number | null
  stuck: string | null            // S1..S5 from factory-state, shown in the title only
  // GitHub, through callum-flow-issue-read --json (null when not read this life)
  open: boolean | null
  trusted: boolean | null         // false when the reader refused the author (exit 3)
  labels: string[] | null
  blockedBy: number | null        // issue_dependencies_summary.blocked_by: open blockers
  blocking: number | null         // the open issues waiting on this one
  subIssues: number | null        // sub_issues_summary.total: more than 0 is a tracker
  blockingList: number[] | null   // the open issues of this repo it blocks (the reader's `blocking`); null: not read
  blockersClosedAt: Ms | null     // the newest closed_at among its listed closed blockers; null: none or not read
  parent: number | null           // the parent's number when the parent is in this repo
  siblings: { number: number; open: boolean }[] | null // the parent's other sub-issues in this repo; null: not read
  epic: boolean | null            // the title matches trackerTitle ("Epic: ..."): also a tracker
  subIssueList: number[] | null   // a tracker named in `only`: its open sub-issues, nested ones
                                  //   included (3 levels), from its timeline; null when not read
  brief: { url: string; at: Ms } | null   // latest '## Design brief' comment by a trusted author
  // the event log (dev-query)
  delegatedBrief: string | null   // the latest 'delegated' event's 'brief <url>' note
  claimLapsedAt: Ms | null        // the holder's claim lapsed: its lease ended then, with no renewal (H1)
  reclaimedAt: Ms | null          // the newest `reclaimed` event: a sweep or a release gave the claim back (H1)
  readyAt: Ms | null              // the newest `ready` event of the issue
}


type Pool = { free: number; total: number; slots: Slot[] }
type Slot = { path: string; branch: string | null; state: string; dirty: boolean | null; busy: boolean;
              lease: string | null; leasedAt: Ms | null;  // treehouse's lease_id and leased_at
              leaseBranch: string | null }  // branch, else the newest issue branch its reflog shows checked out since leasedAt
type Checkout = { branch: string | null; head: string | null; defaultBranch: string; dirty: string[] }
              | { error: string }   // branch is null when detached; dirty lists changed tracked paths only
type AgentView = { id: string; type: string; status: 'pending' | 'running' | 'waiting' | 'idle'
                   | 'completed' | 'failed' | 'killed' }
type Milestone = { open: number; closed: number; expected: 'patch' | 'minor' | 'major' | null }
```

#### 13.3.2 Which issues are in `issues`

The union of: every issue `callum-flow-factory-state` lists for the repo; every issue in
`queue`; every issue a ledger entry names; every issue `only` names, with the sub-issues a
tracker among them stands for. GitHub fields are filled for the queue, the issues this device
holds, every issue in a live stage, the issues of the loop's running work, those of a merged Run
it not answered `done`, and those `only` names, and stay `null` for the rest. `open` is what plan
reads to treat an issue closed on GitHub as finished (13.5.1); `null`, not yet read or never
readable, is never taken for closed.

#### 13.3.3 Sources

Each adapter runs a command with `$.process.run` (no shell), parses its output, and sets its
source status. A failed adapter keeps the previous value with its old `at`, so plan can see
how stale it is. `queue-watch.sh` and `usage-check.sh` run from
`toolsDir` (section 13.4.1); every other command comes from `PATH`.

| Source | Command | Cadence | Required for |
|---|---|---|---|
| `factory` | `callum-flow-factory-state --repo <R> --format json --github off` | every pass | everything: a failure makes the pass blind (rule `G2`) |
| `facts` | one `dev-query --factory --csv` call over 3 days of events (`NEW_EVENTS_SQL`, 3.3): the latest `delegated` note per live issue, and the v2 states (7.1); from the old log under `eventsSource` `old` (`EVENTS_SQL` in `derive.ts`) | every pass | v2's facts (2.4) |
| `runs` | not read: the loop reads no pipeline runs, so `runs` is always empty and the source reports `not read` (`runSource: events`, the replay's, marks it from `facts`) | - | nothing |
| `queue` | act mode: `queue-watch.sh --once --repo <R> --label <readyLabel> --known <last now>` (13.3.4), with `known` kept in the store. Observe mode: `callum-flow-issue-read --json --list --label <readyLabel>`, so an observing loop logs no `ready` events of its own. An empty list when the last list was not, while a member of the last list is open, trusted and labelled `readyLabel` by its own `github` read, is a failed source (`the ready list came back empty while #N carry ready by their own reads; the last list stands`): the last list stands and `known` is kept (D-76) | every `queueEveryMs` (120 s); skipped during a GitHub backoff | rule `S1` |
| `github` | one `callum-flow-issue-read --json --issues <N,...>` call for the issues due this pass (single `--json <N>` reads on an image whose reader exits 2 on `--issues`) (labels, state, author trust, dependency and sub-issue summaries), plus `--comments` only for the issues a designer works on, to find the latest `## Design brief` comment, and `--json --timeline <N>` for a tracker named in `only`, to list its sub-issues. First the issues the loop may act on or counts as live, so a closed one is known before plan drives it (#556): the records' issues and the issues of the loop's running work, then the queue, and the issues `only` names with their trackers' sub-issues, and last the open issues the read issues block (`blockingList`) (2.4 gives v2's read set and order). An issue known closed is not read again unless the queue, which lists open issues only, names it, or this device holds it (it may have been reopened); a failed read keeps the last value | per issue every `githubEveryMs` (5 min), at once for an issue not yet read, oldest first, at most 12 reads a pass; skipped during a GitHub backoff | rule `S1`; an issue closed on GitHub is finished (13.5.1) |
| `usage` | `usage-check.sh`, merged with `$.session.usage().rateLimits` (free, from the session's own API responses): the higher reading of each window wins. In API-key mode neither is read: the session's `cost.usd` is added to the tally (see G3) | `usage-check.sh` every `usageEveryMs` (5 min); the session figures every pass; in API-key mode the cost every pass and one `usage` event every `usageEveryMs` | rule `G3`; missing or stale is Normal, flagged (stop-new in API-key mode) |
| `pool` | `treehouse status --json` from the main checkout: the slots and who holds them. It does no reflog or status read of a slot (2.4 `leases`) | every pass | slot capacity (10.1) |
| `checkout` | `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, then `git --no-optional-locks status --porcelain=v2 --branch --untracked-files=no`, from the main checkout (it takes no index lock and ignores untracked files); its `# branch.upstream` and `# branch.ab` headers give the read's upstream and ahead and behind counts, null when absent. A missing origin/HEAD or a failed status is `{ error }`, whose text points at `git remote set-head origin --auto` | `checkoutEveryMs` | the main-checkout tripwire (10.7) |
| `agents` | `$.agent.list()`, read once per pass, filtered to the ids in the ledger | every pass | lost-agent detection (13.7.5) |
| `milestone` | `callum-flow-milestone show next` | every `milestoneEveryMs` (10 min) | rules `O3`, `O4`, `O5`; absent means not opted in; while it qualifies, `gh` also reads the last release tag and the oldest merge since it (O3 fields); whenever it exists, `gh release view` reads the newest tag and a list of the milestone's closed issues (`--json closedAt`, limit 200) the oldest `closedAt` (null on a full list of 200 or a failed read), both skipped in a GitHub backoff |
| ledger | act mode: the ledger the module keeps (13.7.1), from `$.store`; when the store holds none, rebuilt from 7 days of events (13.7.5). Observe mode: derived from the device's own events in the `facts` window | every pass | everything |
| control | `<loop dir>/control.json`, field by field (13.4.3) | every pass | rule `G4` |
| GitHub backoff | act mode: `$.store` (`backoff:<repo>`) | every pass | 13.10 item 2 |

In act mode, before plan runs, the pass also applies the transitions that are facts rather than
decisions (13.7.5): what a successful agent-list read proves about the loop's running
agents, and wakes past their timeout (13.8.2).

#### 13.3.4 The queue's one-shot mode

`queue-watch.sh` has a one-shot mode beside the watcher in `features/src/callum-tools/` (the
image's source), with a shell test beside the existing ones. The streaming and single-shot modes
are unchanged. `pipeline-watch.sh --once`, the pipeline poll the loop used to run, stays in the
image for now; the loop does not call it.

**`queue-watch.sh --repo <R> --label <L> [--known <list>] --once`**: one read of the queue, with
the same reader and trust filter as the watch modes and no debounce, then exit 0, whether or not
the queue changed:

```text
queue known=<n1,n2|none> now=<n1,n2|none>
```

`--known` is the last line's `now=` (`none`, empty or left out is the empty set). Every member
of `now` that is not in `known` logs a `ready` event with `--if-changed`, which carries the issue's title, labels and parent as the listing showed them (`--data`); an untrusted issue
never appears in `now`. A failed read (or `gh` or the reader missing) exits 1 with nothing on
stdout and no `watcher_error` event: a failed source, never an empty queue. A missing `--repo`
or `--label`, or any option but these three, is a usage error (exit 2).

Act mode keeps `known` in its store (`queue-known:<repo>`), so the `ready` events keep arriving
as they do today.

GitHub's label listing sometimes answers an empty list while the issues still carry the label, so
`observe` does not accept an empty `now` (here or from the observe-mode reader) when the last
accepted list was not empty and any member of it is, by its own cached `github` read, open,
trusted and labelled `readyLabel`. It marks `queue` failed, naming those issues, keeps the cached
list with its old time, and saves no new `known`. An empty list that no member contradicts (closed,
unlabelled or never read) is accepted at once (D-76).

### 13.4 Configuration

#### 13.4.1 Where it lives

- **Plugin options** (`userConfig`): `mode` (`off`, `observe` default, `act`), `repo` (default:
  the session checkout's GitHub `origin`), `shadowDevice` (observe mode only: plan as this device,
  the live orchestrator's, so an observe run can be compared with it; ignored in act mode) and
  `runSource` (`local`, the default, or `events`, which the replay sets: the `runs` source is then marked from the event log; the loop reads no pipeline runs either way, 13.3.3).
- **The workspace file** `${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/config.json` overrides the
  options and adds `checkout` (the consumer's main checkout, when it is not the session's
  directory), `poolSize` (default 16), `toolsDir` (where `queue-watch.sh`
  and `usage-check.sh` live; default `/usr/local/share/callum-tools`, the base image's copy),
  `binDir` (put ahead of `PATH` for every command, so the loop runs a checkout's own CLIs before
  a base image release carries them), `trace` (`true` or `false`): trace mode for this
  workspace's loop (13.12.1), over the repo's `trace`; `/factory trace on|off` writes it, as
  `/factory mode` writes `mode`; and `answerChannel` (`script`, `tool` or `text`, 13.4.2), over the
  repo's. A bad value of either is left out and named in the decision log, as the repo's are; so
  is `answerTools`, the switch `answerChannel` replaced, named as replaced and not read. It is
  plain JSON, easy to read and set from a shell, which an observe run uses (DECISIONS D-33). A testbed
  points `toolsDir` at a checkout's `features/src/callum-tools` and `binDir` at its
  `images/base` (DECISIONS D-42). A `toolsDir` also sets `CALLUM_FLOW_LINKAGE_BIN` to
  `<toolsDir>/check-pr-linkage.sh` for every command, so the merge guard's link check runs the
  checkout's script; without `toolsDir` the variable is left unset.
- **Repo-local** `.claude/factory-loop.json` in the consumer's main checkout: everything in appendix A.
  The plugin ships no repo-specific values (CLAUDE.md: shared plugins stay generic). An unknown
  key or a bad value is left out and named in the decision log (`config`).
- **Control state** in `<loop dir>/control.json` (13.4.3): owner directives that change at runtime.

Every command the loop runs gets `CALLUM_FLOW_REPO`, `CALLUM_FLOW_READY_LABEL` and
`CALLUM_FLOW_IN_DEV_LABEL` from the settings (`callum-flow-claim` and `callum-flow-sweep` read
the labels), `FACTORY_REGIME` (the `regime` setting) and, when the session id is not empty, `CLAUDE_SESSION_ID` (the loop's
session; `callum-flow-event` stamps both on every event), and, when the pass does not act, `CALLUM_EVENTS_DIR` (13.11.1).

#### 13.4.2 Settings and defaults

Every key, with its default and meaning, is a row of the table in appendix A; `/factory help config` prints the same
list (13.4.3). What stays here is the memory ceiling the settings `maxInFlightIssues`, `slotMemoryMiB` and
`memoryReserveMiB` feed.

The memory ceiling (`hooks/v2/capacity.ts`). The loop reads the container's memory once per process
beside the CPU count: the cgroup's `memory.max` in bytes, or `/proc/meminfo` `MemTotal` when that is
`max` or absent; unreadable is `memoryBytes: null`, which means no ceiling. The ceiling is
`max(1, floor((memoryBytes - reserve) / estimate))`, and the effective cap is
`min(maxInFlightIssues, ceiling)`, a null on either side dropping that side (both null: no cap; a
configured 0 stays 0). The claim rule (S1) and the lease rule (W1) hold to the effective cap; the skip text
names the bound that held: `capacity: 3 of 3 queued or in flight (memory ceiling: 12.9 GiB, 3.0 GiB per
slot, measured)` when the ceiling is the lower bound, the text above unchanged when the configured cap is.
The pass log's `cap` field is `{effective, configured, ceiling, memoryBytes, estimateBytes,
estimateSource}`. When `maxInFlightIssues` is above the ceiling, the notice `capacity` tells the owner
once per (configured, ceiling) pair (key `tell:capacity:<configured>:<ceiling>`), naming the memory, the
reserve, the estimate and its source, and the effective cap. The observe step's PR read budget stays the
configured cap: it bounds reads of records already held and decides no claim.

v2's own keys (the state timeouts, `maxTriages`, the gate commands and the rest) are in appendix A. Time settings take a duration in the files: `60s`, `5m`, `2h`, with the key's `Ms` dropped
(`passEvery: "60s"`). A plain number still reads as milliseconds. The loader converts them, so
the code keeps the `Ms` names and works in milliseconds (owner, 2026-10-13). A duration string
under the `Ms` spelling is a bad value. Recorded states for the replay are not a setting: they
are written in observe mode only (13.11.6).

#### 13.4.3 Control state (owner directives)

```ts
type Control = {
  paused: number[]                // no action at all on these issues (their claims still renew)
  noNewWork: boolean              // wind-down: no start and no develop actions
  skip: number[]                  // never claim these
  priority: number[]              // claim these first, in this order
  only: number[]                  // claim only these, in this order (empty: no limit); a tracker stands for its
                                  //   open sub-issues; work in flight goes on
  serial: boolean                 // one issue in flight at a time
  usageOverride: { untilPct: number; expiresAt: Ms } | null   // run past a threshold (I-19)
  updateDue: { reason: string; at: Ms } | null   // an update is due (rule R2): set by `/factory update`
  resumed: { subject: string; at: Ms; note?: string }[]  // parked issues the owner resumed: 'issue:<N>', with the note for the next step
  dropped: { issue: number; at: Ms }[]     // issues the owner dropped: their current life is closed (4.1)
  notes: { issue: number | null; text: string; at: Ms }[]     // owner instructions for agents, at most one per scope
}
```

They live in `<loop dir>/control.json`, which observe reads field by field each pass: a missing
or malformed field takes its empty value, so one bad directive never voids the others. The model
sets them with the `mcp__factory-loop__control` tool (`{ "op": "<op>" }`) when the owner says so
in chat, and the owner can type `/factory <op>` from any client (named so to stay clear of Claude
Code's built-in `/loop`): `status`, `pause <N>`, `unpause <N>`, `skip <N>`, `noskip <N>`,
`priority <N...>|off`, `only <N...>|off`, `serial on|off`, `new on|off`, `override <pct> <hours>|off`,
`resume <N...> ["note"]`, `retry <N>`, `update [<reason>]|off`, `drop <N>`, `note [<N>] <text>|off`,
`mode off|observe|act`, `trace on|off`, `config [set <key> <value>|unset <key>]`, `stamp <N>`, `stop-now`. Each change
pings the loop and gets its own decision-log line (`control`). Appendix E gives what v2 makes of `resume`, `drop`,
`note`, `retry` and `stop-now`.

- `config set <key> <value>` saves one setting in the workspace file and `config unset <key>` removes
  it, so the repo's value or the default applies again. A key is any setting under its file name
  (`passEvery` or `passEveryMs`, `stateTimeout.design` for a map entry) or `poolSize`; `mode`,
  `trace` and the runtime keys are refused with a pointer to their own op. The value is
  read as JSON when it parses (`3`, `true`, `null`, `["npm test"]`), else as text (`6h`). It is
  checked by `loadConfig` alone before anything is written: a problem, an unknown key or entry
  refuses the op with the loader's text and `Not changed.`, and the file is left as it was (as it is
  when it is not a JSON object). The answer names the old value in force, the new one and when it
  applies, from `SETTING_EFFECT` (`hooks/config-keys.ts`): `from the next pass` (runtime() reads
  both files every pass; a timeout is for new work) or `after the loop's process restarts` (a
  value captured once at load; no key is today). It is logged as a person intervention with cause
  `config-file`, and its write is the loop's own, never a hand edit. An agent may read `config`,
  never set or unset.
- `stamp <N>` dry-runs the intake reader on one issue and writes nothing (appendix E). It works while
  `intakeStamp` is `off` and in observe mode, and an agent may call it, as it may `status`. It answers within the
  tool bound (`Stamping #N with <intakeModel>, dry run: its answer follows when the reader ends.`; a second
  `stamp` of an issue still being stamped answers `already stamping #N`), then a background job reads the issue
  (`callum-flow-issue-read <N> --comments`, trusted authors only) and the repo's top level
  (`git ls-tree --name-only origin/<default branch>`, from the last pass's checkout; left out when unknown) and spawns
  `factory-loop:intake` with both as data in its prompt. The reader (`agents/intake.md`) has the Read tool alone, so it
  cannot write to GitHub or the repo. Its final message is one JSON object, checked by `checkIntake`
  (`hooks/v2/contracts-intake.mjs`, not in `V2_CONTRACTS`: the reader has no answer script). When its turn ends the owner
  gets one notice (outcome, area, needs_owner, reason, touches, what was dropped, the model and the seconds, ending
  `dry run: nothing written`) through `$.prompt.submit`. A failed read or spawn, a turn that ends without an answer, or a reader that does not end within 10 minutes is a
  failed stamp, noticed once. A dry run adds no label, comment or event (`intake_stamp` mode `dry` stays unwritten), leaves
  `stamps:<repo>`, the score and the ledger as they were, and logs one local decision-log line (`stamp`, `outcome`, `model`, `seconds`).
  The real run, which writes, is rule I1's (13.4.4); the dry run keeps writing nothing.
- An empty op is `status`: the last pass and the directives in force. `help` (also `--help`, `-h`) lists the ops as a normal
  answer and changes nothing; `help config` lists every setting `config set` accepts, each with its default and a one-line meaning
  (`hooks/config-help.ts`: `mode`, `trace`, the plugin and runtime keys, retired keys and the first-loop keys are left out of the list,
  the last on one closing line), also a normal answer that writes and logs nothing; any other word after `help` is refused with
  `Usage: help [config]`; the typeahead hint is a `/plan` style bracketed list built from the ops.
- Issue numbers may take a `#`, and a list may use commas. `resume` takes issue numbers and an
  optional note in double quotes (at most 2 000 characters).
- Limits, refused rather than cut: an override's percentage above 0 and at most 100 and its
  hours above 0 and at most 168; an update's reason at most 300 characters; a note at most
  2 000.
- `drop` of an issue already dropped does nothing. `retry` works through the ledger (13.7.1). `mode` and `trace` are written to the
  workspace file (13.4.1) and apply from the next pass.
- A malformed op changes nothing and answers with its usage. An op that changes nothing
  (pausing a paused issue) says so and writes nothing.
- A control.json that is not a JSON object is never overwritten: every changing op is refused
  with "fix or remove it", and `status` still answers, with a warning. A workspace file that is
  not a JSON object likewise refuses `mode`.
- The control tool refuses every op but `status`, `stamp` and the `config` view from inside an agent: only the main
  conversation sets directives.
- `/factory` is immediate, so a directive typed during a long wake turn applies at once. Ops run
  one at a time.

#### 13.4.4 The intake stamp's run (rule I1)

While `intakeStamp` is `on`, rule I1 stamps each ready issue once per body version; while it is `off` (the default) the
rule plans nothing, so no reader is spawned and no label, comment, event, `stamps:<repo>` write or ledger entry of the
kind `intake-stamp` happens.

- **The body version** is `body_sha`, which `callum-flow-issue-read --json --issues` adds to each item: the first 16 hex of
  the sha256 of the body text (a null body hashes as the empty text). The items still carry no body. The plugin reads it
  into `IssueView.bodyVersion` (null when absent or not 16 hex: an older image, or the per-issue fallback read), and I1
  skips an issue without one (skip `no-body-version`); it never stamps without a version.
- **I1 plans** one `intake-stamp` action, op `run`, key `intake/<N>/<version>`, class `develop`, for each issue in the ready
  queue that passes S1's filters before its blocked and claim checks (open, trusted, labels read, not `factory:rejected`, labelled
  `readyLabel`, no skip label; `readyProblem`, `hooks/v2/rules-claim.ts`) whose current version has no try in `stamps:<repo>`
  (skip `tried`), in ascending issue number, while fewer than 2 `intake/<N>/<version>` entries run (skip `cap`). It plans
  nothing while the records are not read (G2) or GitHub is in backoff. It runs after S1 and the merge queue, claims nothing
  and changes nothing S1 reads except through the score factors a stamp feeds (3.5).
- **The executor** (`hooks/v2/act-intake.ts`) reads the issue (`callum-flow-issue-read <N> --comments`) and the repo's top level, then
  records the try `{ version, outcome: running, at }` BEFORE it spawns `factory-loop:intake` (model `intakeModel`, name
  `intake-<N>-<version>`), so a crash, timeout, failure or drop never respawns the same version; an edited body (a new
  `body_sha`) is eligible exactly once. The entry runs until the reader's turn ends (`driver-between.ts` calls
  `intakeAnswered`, `act-between.ts`, before `agentAnswered`; it takes the turn only when a running `intake-stamp` entry holds
  the agent). The answer goes through `parseIntakeAnswer` / `checkIntake` and the outcome (`ok`, `dropped`, `failed`) is the
  try's. Only `ok` writes `stamps["<N>"]`; a failed or dropped stamp leaves the stamp factors at 0 and every other factor as it was.
- **Settling.** A try still `running` whose run has had `STAMP_TIMEOUT_MS` (10 minutes) from its start, or whose entry ended
  lost, timed out or failed, or is gone, is settled by an `intake-stamp` action op `settle` (key `intake/<N>/<version>/settle`,
  class `free`): the agent is stopped if it still runs, the try is recorded `failed` with the reason (`timeout`, `lost` or
  `spawn-failed`) and the run's entry ends. A try is never retried for its version; an answer that comes after is dropped.
- **Labels** (ok only; `hooks/v2/intake-labels.ts`): `area:<area>`, and `needs-decision` when `needs_owner` is true. A missing
  label is made first (`gh label create` without `--force`, so an existing label keeps the owner's colour; "already exists" is
  fine). The owner wins, group by group (`area`, `needs-decision`): a group is the owner's, and the loop never touches it
  again on that issue, when (1) the issue's labels in the group differ from the `labels` the loop last stored for it, or (2) on
  the first stamp the issue already carries an `area:*` label (area) or `needs-decision`. The loop removes only labels it set
  itself (an area that changed on a new version, `needs-decision` once `needs_owner` is false). The labels it set and the ones
  it kept go in the event (`labels_set`, `labels_kept`), the owned groups in `owned`, the labels it holds in the stamp's `labels`.
  When the issue's labels cannot be read none is set.
- **The event.** Every finished try (ok, dropped, failed, settled) writes exactly one `intake_stamp` v1 event, `mode` `run`, with the
  issue, the model and the run's input, output, cache-read and cache-creation token totals (read from the reader's transcript;
  null when it cannot be read). `reason` is the needs_owner reason, or why a failed run failed.
- **The ledger.** The run is the ledger kind `intake-stamp`, not in `LOOP_KINDS`, so it writes no `loop_entry`; the entry records its
  session so the tokens can be read. A wind-down drops a `run` like any start.

### 13.5 Plan: the foundation's rules

`planV2(state, config) -> { actions, title, skipped, tier, owner, capped, atCap }` (2.2). v2's
rules (14.1) run in a fixed order, each emits zero or more actions, and the result keeps that
order (finish in-flight work before starting new work). The tier gate, the control filters and the
caps apply to every emitted action before it is kept. The generic code is `hooks/foundation.ts`:
the tier, the class matrix, `gate` and `want`, `admit`, `oneWake` and the title frame. The rules
below are the foundation's own, G1 to G4, H1, H2, O1 and O2; O3 is in 14.1. Rule ids that earlier
versions had and the loop dropped are not reused.

#### 13.5.1 Helpers

- **mine(i)**: `i.holder === state.device`.
- **entry(key)**: the ledger entry with that key, if any.
- **blocked(key, kind)** (`gate` in `foundation.ts`): an entry exists and it is `running`; or it is
  `done`; or it is `failed`, `timed-out` or `lost` and its agent is still listed at work (it waits
  until the agent list shows the agent ended, so two agents never work one key); or it is
  `failed`, `timed-out` or `lost` with `attempts >= maxAttempts[kind]` (exhausted; never for
  heartbeat and sweep), or, unless it is `lost`, with its backoff (`retryBackoffMs * 2^(attempts-1)`
  after `endedAt`, at most the cadence for heartbeat and sweep) not yet elapsed. A rule emits an
  action only when its key is not blocked (`want`). A retry keeps the key and adds an attempt. An
  exhausted key is named in the skip reasons (`exhausted: <key>`), which is what `/factory retry`
  clears.
- **finished**: an issue closed on GitHub (`open === false`) is finished, whatever stage the
  factory still shows, as are `merged` and `closed without merge` (#556, DECISIONS D-72): it is
  not counted in the title, takes no place under `maxInFlightIssues`, and its record closes by the
  `issue-closed` event (4.1). An issue whose state is not known (`open` null) is not closed.

#### 13.5.2 Gates (G)

| Rule | When | Then |
|---|---|---|
| G1 | mode `off`, or the kill switch exists | The driver does not observe or plan. Title: `🔄 <name> · off`. (Driver, not plan.) |
| G2 | `sources.factory.ok` is false, or the image's report skipped a `derived` event (its readers are older than the loop) | Blind pass: no actions except `title`, and `tell(blind)` (with the source's `error`, at most 300 characters) once the factory source has been failing for `blindNoticeAfterMs`. A derived skip is never cached. A report that skipped only non-derived events keeps the pass working and plans the owner item `reader-behind` (`types`, `count`; key `tell:reader-behind:<types>`) |
| G3 | always | `tier = tierOf(usage, config, control.usageOverride, now)`: the higher of `fiveHour` and `sevenDay` (a window whose reset has passed counting as zero) against the thresholds; Normal when unavailable (flagged); an unexpired override keeps the tier Normal below its `untilPct`. **API-key mode** (the loop session's environment has `DEV_CLAUDE_AUTH=api-key`; `DEV_CLAUDE_BUDGET_USD` and `DEV_CLAUDE_BUDGET_RESET_DAY` come from the Coder template's `claude_budget_usd` and `claude_budget_reset_day` parameters): the reading is the spend percent, `ceil(100 * spentUsd / budgetUsd)`, against the same thresholds, and neither `usage-check.sh`, the session's `rateLimits` nor any subscription reading is read. The period starts at 00:00 UTC on the reset day (a day past the month's end means its last day); a reading whose `resetsAt` has passed counts as 0. `spentUsd` is a tally in `$.store` (`spend:<repo>`: `{ v, periodStart, spentUsd, counter: { process, session, lastUsd } \| null, at }`) that only an acting pass writes. For each `cost.usd` reading `c`: no counter adds `c`; the same process and `c >= lastUsd` adds `c - lastUsd`; the same process and `c < lastUsd` (the counter reset) adds `c`; another process of the same session and `c >= lastUsd` (a counter restored on resume) adds `c - lastUsd`; anything else adds `c`. A new period starts the tally at 0. A missing reading is **`stop-new`**, never Normal, and no override lifts it; its reason is `spend:no-budget` (no or zero budget), `spend:bad-reset-day`, `spend:no-session-cost` (no `cost.usd`), `spend:bad-tally` (the stored tally does not parse; the acting pass then stores a fresh one counting the whole current counter) or `spend:stale` (older than `usageStaleMs`). The usage pre-check (13.10 item 7) uses the stored tally plus the cost now less `lastUsd`, in memory. Every `usageEveryMs` one `usage` event goes out (`source` `spend` with `spend_usd`, `budget_usd`, `budget_resets_at`, or `available` false with the reason), to the sink in observe mode |
| G4 | always | The admission filters (`admit`), each held action leaving a skip line that names its filter: an action on a `paused` issue is dropped (except `heartbeat`); `noNewWork` drops the `start` and `develop` classes; the tier drops the classes it forbids; the GitHub backoff holds every action that writes to GitHub (13.10 item 2); an open breaker holds its kind (13.11.4); the rate caps hold a bucket or a kind on one issue (13.11.4). `skip`, `priority`, `only` and `serial` bound the claim rule S1 (14.1). At most one wake goes out (O2) |

**Tier and class matrix** (each action kind has one class, 13.6):

| Class | Normal | Slow | Stop new | Stop all |
|---|---|---|---|---|
| `free` (CLI work that spends no tokens) | yes | yes | yes | yes |
| `owner` (`tell`) | yes | yes | yes | yes |
| `drive` (agent steps for work in flight, `task`) | yes | yes | yes | no |
| `develop` (the first steps of a claimed issue) | yes | yes | no | no |
| `start` (claim) | up to `maxStartsPerPass` | one per pass, none within `slowGapMs` of the last claim | no | no |

A claim still running counts as started: it takes its place under the per-pass limit, the
worktree reserve, `maxInFlightIssues` and `serial`, so planning again while it runs adds no
claim (property 2, 13.5.9). A claim that is done but not yet shown by the factory state
counts the same way until the state shows the issue live, for at most one `heartbeatEveryMs`
(#547).

#### 13.5.3 Housekeeping (H)

| Rule | When | Then | Key |
|---|---|---|---|
| H1 | a record is not closed and its lease was last renewed before `loadedAt` (the first pass after any load) or at least `heartbeatEveryMs` ago; or a record's claim lapsed (4.1). An issue's lease was last renewed by the later of its own claim and the last `heartbeat`, so a fresh claim does not trigger one | `heartbeat` | `heartbeat:<last done endedAt or 0>` |
| H2 | the last `sweep` ended at least `sweepEveryMs` ago, or never | `sweep` | `sweep:<last done endedAt or 0>` |

#### 13.5.8 Owner and report (O)

| Rule | When | Then | Key |
|---|---|---|---|
| O1 | always, last (before a `restart-self`) | `title` when `titleOf(state, tier)` differs from `lastTitle` and `titleEveryMs` has passed since `lastTitleAt` (or `lastTitleAt` is null) (13.9.1) | none (compared, not keyed) |
| O2 | any wake (`task`, `tell`) is planned | keep at most one wake per pass and none while another wake is `running`, picked in order: `tell` of an owner item, `task`, other `tell`. Notices from outside plan (a rail, the ping breaker, failing passes: 13.9.2) go out through the same executor once no wake is open | the wake's own key |

#### 13.5.9 Properties every plan must keep

`plugins/factory-loop/tests/foundation.test.ts` and the `v2-*.test.ts` suites check these on
every call to `planV2` they make (17.1 adds v2's own):

1. **Determinism**: the same state and config give the same result.
2. **Idempotence**: starting every planned action in the ledger (as `ledger.ts` does, so
   `running`) and planning again yields no action except `title`.
3. **No I/O**: `hooks/v2/*.ts` and `foundation.ts` import types only and read no clock
   (`tests/factory-loop-plan.test.js` reads their source, since plugin tests cannot read files).
4. **Tier safety**: no action of a class the tier forbids, whatever the state.
5. **Control safety**: no action names a paused issue except `heartbeat`; nothing is claimed
   with `noNewWork`.
6. **Bounded**: at most one wake per pass, at most `maxStartsPerPass` claims, and no rate-cap
   bucket, or kind on one issue, past its cap.

### 13.6 Actions

#### 13.6.1 Catalogue

Every action carries `key`, `kind`, `class`, `rule` (the ID that emitted it) and `reason` (a few
words for the log). Commands run without a shell, from the main checkout unless noted, with the
mode's environment (13.4.1, 13.11.1). Every `gh` command gets `--repo <R>`, so a write can
only reach the configured repo. The foundation's kinds are these; v2's twelve (`transition`,
`label`, `comment`, `event`, `pr`, `split`, `link`, `agent-step`, `ci-rerun`, `queue-update`,
`queue-merge`, `slot`) are in appendix B.

| Kind | Class | Executor | Timeout | Retries | Outcome recorded |
|---|---|---|---|---|---|
| `heartbeat` | free | `callum-flow-claim --heartbeat`, off the pass | 120 s | never used up: next due time | exit code (the CLI logs `renewed`) |
| `sweep` | free | `callum-flow-sweep`, off the pass | 300 s | never used up: next due time | exit code (the CLI logs `reclaimed`, `closed`) |
| `claim` | start | `callum-flow-claim <N>` | 120 s | 3, backoff | `claimed`, `lost` (exit 3) or `failed` |
| `rollout` | free | `callum-flow-rollout <N>`, for a merged issue's follow-ups (11) | 60 s | 3 | the rollout: `merge`, `run-it` or `keep-open` |
| `close-issue` | free | `gh issue close <N> --repo <R> --reason completed` | 60 s | 3 | exit code |
| `release-parent` | free | `gh issue edit <N> --repo <R> --remove-label <inDevLabel>`, then `callum-flow-event abandoned --issue <N> --note "split into <list>"` | 60 s | 3 | exit codes |
| `milestone-later` | free | `callum-flow-milestone plan <N> later` | 60 s | 3 | exit code |
| `restart-self` | free | `dev-restart-self`, only from rule `R2` | 600 s | 1 | the session restarts, and the loop resumes on load (13.7.5) |
| `stop-agent` | free | `$.tool.call({ tool: 'TaskStop', task_id })`, only for an agent the ledger holds on a running entry | 30 s | 1 | stopped, or failed with the reason (13.13) |
| `task` | drive | `$.prompt.submit` with a `TASK` line | `wakeTimeoutMs.task` | 1 reminder | `done`, `failed`, `hold` |
| `tell` | owner | `$.prompt.submit` with a `TELL` line | `wakeTimeoutMs.tell` | none | delivered when its turn says something |
| `title` | free | `$.command.run({ command: 'rename', args })` | 10 s | next pass | `running`, off the pass |

An action is awaited in the pass that runs it, with two exceptions. The `title` rename runs off the
pass through the one title flight (`hooks/title-flight.ts`, 13.9.1): the action starts it and
reports `running` with `off: true`. And the kinds in `OFF_PASS`
(`hooks/act-off.ts`: `heartbeat`, `sweep`, `queue-merge`) are started in the pass, after their running entry is
saved, and not awaited. The pass reports them with status `running`. Their command runs on an
untraced `ActIo` and ends in the hook queue, which applies the same `finish` the inline run
applies (done or failed by exit code, the same summary, `noRetry` and `rateLimited`), only while
the entry is still the same attempt (key, `startedAt`, `attempts`) and still `running`; saves it
through the store (which refuses a write once the act lock is another session's: the completion
then changes nothing in memory and writes nothing); appends one decision-log line
(`offPass`: key, kind, status, `ms`, summary, `dropped` when it changed nothing); and pings a
pass. A rate-limited completion makes the next acting pass set the GitHub backoff as an inline
one does (13.10 item 2). The engine ends a command at its timeout and exposes no kill handle, so
each acting pass marks `timed-out` any running off-pass entry older than its kind's bound plus
`OFF_PASS_MARGIN_MS` (60 s: the engine's exit and the hook queue); the bound is the CLI timeout for
`heartbeat` and `sweep`, and for `queue-merge` the executor's longest path, the merge command and the
PR read-back (`MERGE_BOUND_MS`, 11 min). A timed-out merge may have merged: the queue step counts it
as one that may have (`mayHaveMerged`), so a PR reading merged at its head is the step's `ok`, never
the `pr-merged` hand merge, and one that did not merge reads unknown; it is never started again, with the summary
`timed out: no completion within <n> s`; a completion that arrives after that is dropped. A
reload marks the running entry `lost` (13.7.5).

The loop's agents are v2's: the designer, builder, fixer, reviewer and triage definitions in
`plugins/factory-loop/agents/` (10.3). An `agent.offer` hook keeps the loop's own types out of the
model's agent listing, except while the loop's own repair message to one is on its way
(13.7.3a). A spawn's name carries the step and the issue, and its description names the issue
(D-11). A spawn denied, one that throws, or one that starts with no agent id is a failed attempt. An
agent's turn that ends in `error`, `aborted` or `refusal` is a failed attempt too. Exit 2 is a
usage error, never retried, for the image's own CLIs (`callum-flow-*`, `dev-restart-self`); `gh`
exits 2 when cancelled and `treehouse` 1 on bad usage, so their exit 2 is retried like any failure.

Things no executor can do, by construction: pass `--yes`, run `no-mistakes`, merge without the
guard, force-push, edit a PR body outside `pr` ensure and `pr` body, add the `ready` label, run any
`coder` command, kill a process by name, or stop an agent the loop did not spawn.
`plugins/factory-loop/tests/safety.test.ts` runs every action kind through the dispatcher with a
recording fake and checks every argv, and `tests/factory-loop-safety.test.js` scans every string in
`hooks/*.ts`; both fail on any of them. The one `kill` allowed is the old-watcher rail's `kill -0`
probe, which signals nothing (13.11.2).

The loop makes no git write: `safety.test.ts` bans every one (push, reset, rebase, checkout,
clean, stash, commit, merge, a fast-forward included) in a shell script. Outside a script, git
runs only to read (`remote`, `ls-remote`, `symbolic-ref`, `status`, #544) and to switch a slot.

#### 13.6.3 Agent prompts

Each agent step's prompt comes from a template in `hooks/v2/prompts-*.ts`, with the shared parts
in `hooks/prompts.ts`. Templates carry only issue numbers, URLs, branch names, heads, step names,
instructions from the triage or the owner, owner notes, shared command restrictions, pointers
(CLAUDE.md, the agent type's own memory file under `.claude/agent-memory/`), a per-issue scratch
subdirectory (I-95), and how to answer: the answer script with its answer file (13.4.2
`answerChannel`). A prompt for an issue with a `model:` label says to pass that model to the
agent's own sub-agents.

- **Command restrictions.** Every role's opening instructions include `COMMAND_RULE` (defined once
  in `hooks/v2/prompts-triage.ts` for every v2 prompt and definition), the authoritative wording
  for command bounds, prohibited processes and handoff cleanup. `tests/prompts.test.ts` checks its
  presence in every role prompt; the root `tests/factory-loop-agents.test.js` checks that the
  loop's agent definitions retain the same paragraph.
- **No brief content.** A brief travels as its comment URL only; anything else in its place is
  dropped and the prompt says to read the issue instead.
- **No closing keyword.** The template text uses none of the words. In free text (owner notes,
  instructions, verdict lines) a closing keyword before an issue reference (`#N`, `GH-N`,
  `owner/repo#N`, a URL), or at the end of the value, becomes its `-ing` form ("Fixes #12" reads
  "Fixing #12"), so an agent that copies it into a PR body closes nothing (I-33). Every id
  (branch, head, step, model, repo) must have its shape, or it shows as not known.
- **The answer script** (13.7.3a). Each prompt asks the agent to record its answer once with the
  answer script, at the moment its work is done. It names the script by its absolute path under the
  plugin's root (`$.plugin.root`) and an answer file unique to the step's key, and shows the call
  as a here-document with an example of the JSON (`<script> --to <file> <<'JSON'`), so no quote
  in an answer trips the shell; the command, the JSON and the closing `JSON` line stand at
  column 0, so the block runs as copied. It says what each field means, that the script records
  the answer and changes nothing else, to correct the JSON and run it again when it prints
  problems, and to end the turn once it says the answer is recorded. The words stay neutral: the
  prompt never says why the script stands in. A path a prompt may not carry (anything but letters,
  digits and `._/-`, or a `..`, `.` or empty part) fails that spawn. The prompts also say to run
  any sub-agent in the foreground and wait for it there: "your turn ends only with your final
  answer, given as asked below."
- **Records.** Before each spawn the loop writes `<loop dir>/spawns/<key>.json` (the step, branch,
  slot, model, contract, the answer file it named and the exact prompt) and the job file beside the
  answer file (13.7.3a); each answer is saved whole at `<loop dir>/answers/<key>.answer.json`. The
  reply to a repair message follows the answer it repairs, never over it; a new attempt starts the
  file over.

`tests/prompts.test.ts` renders every template with hostile inputs and checks for brief content
and closing keywords.

### 13.7 Ledger

#### 13.7.1 Entries

```ts
type LedgerEntry = {
  key: string                     // the idempotency key: kind plus its subject's fingerprint
  kind: ActionKind
  class: ActionClass
  rule: string
  issue: number | null
  run: string | null
  pr: number | null
  head: string | null
  wake?: string                   // task, tell: the wake's name
  step?: AgentStep                // an agent step's kind, which the per-issue rate cap counts by
  maxAttempts?: number            // the key's own attempt cap, when its action set one
  status: 'running' | 'done' | 'failed' | 'timed-out' | 'lost'
  attempts: number
  startedAt: Ms
  endedAt: Ms | null
  agentId?: string                // agent steps
  wakeId?: string                 // task, tell (13.8.1 `id=`)
  turnId?: string                 // the turn the wake started
  reminded?: boolean              // its one reminder went out (a wake's reminder; an agent's one
                                  //   repair message, 13.7.3a)
  session?: string                // the session that submitted the wake (13.7.5)
  outcome?: Outcome               // parsed result, per kind
  summary?: string                // the executor's last few words, for the decision log
}
```

**One attempt.** Before an action runs, `start` records its entry as `running`: a new key at
attempt 1, a key that failed, timed out or was lost at attempt n + 1 with its old outcome
cleared. The running entry reaches the store before the command, spawn or wake starts, so a
reload or a restart at any point finds it (and marks it `lost`, 13.7.5). `finish` then applies the
executor's result: its status, outcome (the last one kept when the result carries none) and
summary. A `skipped` result (the usage pre-check, a dropped prompt) counts no attempt: the entry
goes back as it stood, or goes when it was new. A usage error (exit 2) uses up the attempts at
once. An executor may record extra done entries beside its own. Agents end
by their `turn.complete` (matched by agent id) and wakes by their answer, delivery or timeout,
outside the pass.

**In memory, one writer.** The module loads the ledger from the store once per load (and again
when it takes the act lease over from another session), keeps it in memory, and saves it after
every change, each before its `loop` event. It writes back only while the act lock names this
session or still stands as it did at the load (13.11.2): a lease another session wrote
since means that session kept the ledger, and this one reloads before it acts again. A store
that cannot be read leaves the ledger unloaded and the pass does not act; it never falls back to
the event log, which would overwrite the real ledger at the next save. A failed save is 13.10 item 10.

**In the store.** The ledger lives in `$.store` under `ledger:<repo>` as
`{ v: 1, savedAt, entries }`. Entries are pruned 7 days after they end; running entries are
never pruned. The store holds 4 MiB for all of the plugin's keys, so the ledger keeps within
3 MiB: past it, the entries that ended longest ago go first, never a running one. A busy
synthetic week (over 3 500 entries, more than twice the 1 600 events dev-system's orchestrator
logged in 7 days) stays under 2 MiB with nothing dropped. The other keys are `backoff:<repo>`,
`queue-known:<repo>`, `rails:<repo>` (the rails' memory) and `notices:<repo>` (notices waiting
for a wake to close, 13.9.2).

**Retry.** `/factory retry <N>` (D-38) resets the attempts of the issue's exhausted entries to 0,
so their rules try again from the next pass: the entries stay, since a rule may need the failed
entry to act at all. The owner notices they raised (`agent-failed`, `task-timeout`) go too, unless
still open, so a retry that runs out again is told again. The answer names the keys it cleared.
Appendix E gives what v2 makes of it (4.5).

#### 13.7.3a Answers: the answer script and the repair message (#548, #561)

1. **The channel.** The mod registers three answer tools, `mcp__factory-loop__verdict`,
   `mcp__factory-loop__design` and `mcp__factory-loop__handoff`, the intended answer channel, and
   serves them whatever `answerChannel` says (13.4.2). the loop's steps ask for the script and read
   nothing else (10.8).

   **The answer script, a temporary workaround** (#561, DECISIONS D-74). On Claude Code 2.1.296
   and 2.1.299 an agent the loop spawns from its timer never reaches the loop's tool hook (13.13),
   so no tool call of the loop's agents can work, while their Bash does. Until the probe in 13.13
   passes, `answerChannel` is `script` and agents answer through `bin/factory-answer` instead:
   - **One contract.** The script and the loop check an answer with one plain-JS module,
     `hooks/contract.mjs` (and v2's `hooks/v2/contracts-*.mjs`), which the TypeScript hooks import
     and plain `node` runs (it uses nothing of Node or the engine). The tool hook, the script and
     the loop's re-check all call its `checkAnswer(job, input)`, so a script answer is checked
     exactly as the same input through the tool. A table of cases (`tests/answer-cases.mjs`) holds
     both ends to the same problems: `tests/answer-contract.test.ts` reads each through the loop,
     and the root test `tests/factory-loop-answer.test.js` runs the script on each for real.
   - **The paths.** Before the spawn the loop writes a job file
     (`<loop dir>/answers/<key>.job.json`: the contract, the repo and issue a brief must be on, the
     branch a writer was sent to, and the data its contract's check needs), and the prompt names the
     answer file beside it (the same name ending `.answer.json`), unique to the step's key, and the
     script by its absolute path under `$.plugin.root`.
   - **The script.** `factory-answer --to <answer file> '<json>'`, or the JSON on standard input.
     It writes that one file and only where the loop issued it: an absolute plain path whose name
     ends `.answer.json`, in `<CLAUDE_CONFIG_DIR or ~/.claude>/factory-loop/<owner>__<repo>/answers/`
     (`contract.mjs` `loopDirOf`, which the loop builds its loop dir with too), every directory on
     the way a real one (no link out), with the job file beside it, for the repo whose loop dir it
     is in; any other path is refused before anything is written. It checks the JSON against the job's contract
     and prints every problem, exit 1; a usage error exits 2. On success it writes
     `{ v: 1, contract, answer }` atomically (a new temp file in the same directory, flushed, then
     renamed over the answer file), prints that it is recorded, and exits 0. For a `design-v2` wait it
     first reads the conditions on GitHub (8.7), and for a done close its evidence (a merged PR, a commit
     on the default branch): a definite negative is refused, an indeterminate
     read is recorded and named on stderr. It runs from any
     directory under plain node, as a CommonJS script or an ES module alike.
   - **Reading.** The loop reads the answer file at the path it issued for that step and attempt,
     and nowhere else: who answered is the path. It checks the answer again against what it knows
     itself (the entry, its spawn record and the runtime), never the job file. A valid file
     finishes the entry with the outcome and events its contract gives, whatever the turn's closing
     words say and however the turn ended (10.8 says when). A refused file is named in the decision
     log and in the repair message. An agent the agent list would mark lost (gone, or its turn
     ended, 13.7.5) has that file read first: a valid one finishes the entry as above.
   - **Switching back.** Once the probe passes, `answerChannel` goes to `tool`; the script and
     its job files then rest, and nothing else changes.
2. **Matching.** A tool call is tied to the running entry whose `agentId` is the call's
   `tool.call` `agentId`. Refused: the main conversation, an agent the ledger does not hold (an
   agent's own sub-agents among them), an entry that no longer runs ("already recorded" once
   done), another agent type's tool, and any session without the ledger (observe mode, the kill
   switch).
3. **Checks, beyond the schema** (the handler trusts no engine check). Free text is one line of at
   most 4 000 characters. Ids must have their shapes. A brief must be a comment URL on the
   designed issue of this repo. Every problem is named at once in the deny text, which the model
   reads and corrects in the same turn. What each v2 contract takes is in its `contracts-*.mjs`
   module.
4. **Recording.** An accepted call finishes the entry at once with the outcome and events its
   contract gives. Its summary is marked `(tool)`. The agent's later closing words are not read.
   An agent still listed at work after its accepted call is stopped at the next seq (10.8); one
   listed `idle` or `completed` has ended its turn (13.7.5) and is not.
5. **No text channel.** An agent that ends without a valid answer file of its attempt has no
   answer; v2's steps do not read the closing words of a turn.
6. **Repair.** A final turn with no valid answer, from an agent that is not still at work, first
   gets one message to the same agent via `$.session.send`, which resumes a finished agent from
   its transcript. The message names what was wrong (the contract's problems, after what kept a
   recorded answer file out) and asks again for the answer script with the same answer file. The
   entry stays running with its attempt unspent and is marked `reminded` before the send. While the
   send is on its way the agent counts as at work, its answer being handled. Once delivered, the
   loop waits on its reply: the agent counts as at work while still listed with its turn ended
   (`idle` or `completed`), for 5 minutes after the message or until its next `turn.complete`.
   After that its next such listing is counted afresh: one pass of grace, then lost (#560). One
   per attempt, only to agents the ledger holds, only in act mode with no kill switch and no
   restart pending. The engine resumes an agent only as a type it offers the model, and asks the
   `agent.offer` hooks, which hide the loop's own agent types (13.6.1): so while the loop's repair
   message to one of them is on its way, its type is offered. Hidden, the engine refused every
   repair of testbed run 3: `Agent "<id>" is stopped (completed) and could not be resumed: Agent
   type 'factory-loop:adjudicator' is not offered in this session.` (#559). A second unreadable
   answer, or a message not delivered within 10 s, fails the attempt. The decision log's line keeps
   the engine's reason whole (`repairRefused`); the entry's summary keeps a clipped copy.
7. **Answered at once (#558).** The engine gives up on a tool hook that runs too long (13.13), so
   each tool hook answers from memory and never waits on the hook queue. The call is checked
   against the live ledger, the last pass's runtime and the kill switch. An accepted call
   finishes its entry in the live ledger before the hook returns, so a later `turn.complete` reads
   `recorded` and a pass in flight keeps the change. An agent's accepted call has its input saved
   before it is recorded. A call that changed the ledger has it saved at once, outside the hook
   queue, so a reload before the queue reaches it keeps the answer. What follows goes through the
   hook queue, in order with other hook work: its events, the ledger saved, its loop event, its
   decision-log line (a failed save or event in `problems`) and the ping. Before the first pass
   after a load the ledger is not loaded, so a call is refused, asking for text; nothing is loaded
   for it. A call whose own work takes more than 2 s is refused, asking for text, and changes
   nothing when that work ends. The owner's `answer` tool and `retry` change the live ledger the
   same way. `control` (and `/factory`) writes `control.json` within the same bound, or nothing;
   once its write has begun, the answer says the op may not have taken.

#### 13.7.4 Events the loop logs

Most transitions are already logged by the CLIs the executors call (`claimed`, `claim_lost`,
`renewed`, `reclaimed`, `closed`, `implementer_routed`, `merged` and the queue state through
`queue-watch.sh --once`). A done close (8.7) also logs `closed` (reason `completed`) itself, as the `close-issue` executor's second step once `gh issue close` has passed, the way a split tracker's close is logged. v2 logs its own states through `hooks/v2/events.ts` (7.1). The
foundation logs two native events for its own transitions (DECISIONS D-09, dev-system#1142), `loop_entry`
and `loop_passes`, as `callum-flow-event --type <type> --data <json> [--issue N]`:

- a `loop_entry` for each agent and wake entry (`agent-step`, `task`, `tell`, owner notices
  included; a `judge` has no event) when it starts and when it ends: an attempt's start and its executor's result are
  one transition, logged once; an entry is logged only when its event would say something new:
  a wake's turn taking its id (even when the turn starts inside the submit, before the executor
  finishes the entry), its reminder, and any other change the note does not carry log nothing.
  The module remembers the event it last logged per key, and a ledger loaded from the store or
  rebuilt from the event log counts as logged (run 2, #536). An agent step's end (`done`, `failed`,
  `timed-out`, `lost`) also carries `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_creation_tokens` and `model` (dev-system#657): read once, when the end is logged, from the step
  agent's transcript `<config dir>/projects/<session cwd, non-alphanumerics as ->/<spawning session>/subagents/agent-<id>.jsonl`
  (the spawning session is kept on the agent-step entry from its start, so a step that ends after a restart
  finds it; when the file is absent one bounded `find` over the projects is tried). Usage is counted once
  per distinct `requestId`, the last line winning, over the agent and every agent nested under it
  (`.meta.json` `parentAgentId`, recursively); `model` is the step agent's own, the one of most turns.
  They are null on a running event, on a tell or task, and when the transcript cannot be read (the event
  is still written and the pass's problems name the key: "transcript not found");
- a `loop_passes` pass summary, once a minute (`plugins/factory-loop/hooks/passes.ts`, #680), from its own
  timer aligned to the UTC minute: `from_at`, `to_at`, `passes`, `mean_ms`, `p50_ms`, `p90_ms`, `max_ms`,
  `acting`, `acting_mean_ms`, `idle_mean_ms`, `errors`, `mode`, `planner` (`v2`) and `pass_every_ms`. It sums up the passes
  that ended in the minute (`acting` are those with a non-`title` outcome, `idle_*` the rest,
  error passes included; percentiles are nearest-rank; a value with nothing behind it is
  null, and a minute with no pass ends sends `passes` 0). Sent only while the loop runs in act
  mode, the kill switch is off and the last pass held the act lock; otherwise the minute is
  dropped. It is bookkeeping, never a stage or progress, and builds no ledger entry; the reader
  does any weighting.

The rate-cap holds and the ping-storm breaker are no longer logged as events (dev-system#1142): the
pass line's `capped` and `breaker` and the breaker's intervention record them.

A `loop_entry`'s data is `kind`, `key`, `status`, `attempts`, `class`, `rule`, `started_at`, `ended_at`,
`agent_id` and `wake` (null when unset), plus `decision` and `decision_reason` for a `task` entry
whose outcome is a wake, with an action's `loopData` merged on top; the entry's issue is `--issue`.
The run, PR and head are not carried. The note below is only what the old-source ledger rebuild
reads (derive.ts `loopNote`, `entryFromLoop`); nothing writes it any more.

An entry's note is `kind=<kind> key=<key> status=<status> attempts=<n> class=<class> rule=<rule>
started=<ms>[ ended=<ms>][ agentId=<id>][ wake=<name>]` and then its outcome's
tokens (`out=<kind>` and the fields plan reads), with `%` and whitespace percent-encoded and
`none` for an empty value. Free text (reasons, instructions, summaries) is left out, and a note over
500 characters keeps the entry without its outcome.

#### 13.7.5 Restart and re-derivation

The store survives a restart: `CLAUDE_CONFIG_DIR` is on `/persist`, which `dev-restart-self`
keeps (FINDINGS check 5). On load:

1. Every `running` CLI entry (no agent id, not a wake) becomes `lost`: its process died with
   the old session or module. That includes a `sweep`, `heartbeat` or `queue-merge` running off the pass (13.6.1):
   its completion, if the old process still delivers one, finds the store another load's and
   changes nothing.
2. A `running` wake that nobody can answer any more is `lost` at once, with its attempt given
   back, so the rule that raised it decides again on the next pass. That means a wake another
   session submitted, or one that records no session (an older build, or rebuilt from the event
   log) and started before this load. Its prompt went with that session. A module reload within
   one session keeps that session's wakes (#549).
3. A `running` agent is judged against the first successful agent-list read, and against every
   pass's after that: an id the list lacks is `lost`, one listed `failed` or `killed` is
   `failed`, and one listed `completed` or `idle` while its entry still runs is `lost`, but only
   from the second pass that lists it so (idle then completed is one sighting), since its
   `turn.complete` may still be on its way. `idle` is the engine's "between turns, until a
   message wakes it" (`AgentStatus`): on Claude Code 2.1.299 an agent that ended its turn is
   listed `idle` for 20 s or more before `completed`, and only the loop's own repair message
   wakes one of its agents, so the loop reads `idle` as an ended turn everywhere, like
   `completed` (#560). An agent whose answer is being handled counts as running, as does one the
   loop awaits a repair reply from (13.7.3a item 6). An agent about to be marked `lost` that recorded a
   valid answer with the answer script is finished with it instead (10.8). A failed read
   changes nothing.
4. Plan then re-derives what to do from the state, not from the lost entries. This is safe
   because every write the loop can lose midway is either idempotent at the CLI (a claim this
   device already holds is kept and nothing is posted; the heartbeat, sweep, labels and
   milestone calls converge) or visible in the next observation (a merged PR, a new head, a
   posted brief, a transition event). A `lost` entry is retried at once while attempts remain.
5. Rule `H1` heartbeats on the first pass (I-93).

If the store itself holds no ledger (a new device, a wiped config), act mode rebuilds it from 7
days of the event log, the ledger's own life: its own `loop` events give every agent, wake and
answer, and the CLIs' events give claims. Claims and stages also come from
`callum-flow-factory-state`. A device's own `merged` event becomes a done `rollout:<issue>` entry
for its issue: the device that merged (or noted an owner's hand merge) ran the follow-ups then,
so the rollout is not read again. The rebuilt ledger becomes the one the module keeps, and the
decision log names its source (`store`, `events` or `none`). A rebuild that found nothing is not
read again every pass. A wake rebuilt from events has no wake id and no session. Once the
rebuilt ledger is adopted, it is `lost` as in step 2, because it was open before this load. The
records rebuild the same way, from `transition` events (3.3). The 7 days are read from the store
`eventsSource` picks, as the facts are (3.3).

### 13.8 Waking the model

#### 13.8.1 Lines

The loop submits a prompt (`$.prompt.submit`), which runs as its own turn once the session is
idle. Its first line is machine-shaped; any further lines carry the details the model needs, in
plain text:

```text
TASK release id=w41 repo=cbundy/dev-system closed=12 expected=minor tag=v0.37.0 oldest=2026-10-15T09:00:00.000Z cadence=6h
Answer with the factory-loop:judge skill.
```

```text
TELL parked id=w43 repo=cbundy/dev-system issue=470 from=reviewing days=0
Answer with the factory-loop:judge skill.
```

The first line is `<TASK|TELL> <name> id=<id> repo=<owner/name>` and then plan's
`key=value` fields, with whitespace in a value percent-encoded. The id is `w` and the clock in
base 36, unique across restarts; `repo=` lets the model build issue and PR links. Plan's detail
lines follow. The last line is always `Answer with the factory-loop:judge skill.`, so a session
that lost the skill (`plugins/factory-loop/skills/judge/SKILL.md`) to compaction loads it again.
The details are visible, in the transcript and on the phone: a mod cannot attach hidden context
to its own prompt (the wake probe showed a plugin's own `prompt.submit` hooks do not see its own
submissions).

`$.prompt.submit` resolves once its turn starts, which waits for the session to be idle. The
executor gives it 5 seconds: a prompt still waiting then counts as queued and running, so a busy
session never holds a pass. A prompt the engine refuses or drops within the 5 seconds started
no turn: the action is skipped, no attempt counted, and plan asks again next pass. A drop after
the 5 seconds, before its turn started, marks the wake `lost` with its attempt given back, which
plan also asks again. A wake's turn is the turn whose text starts with its first line (the
engine's frame, if any, is skipped); a turn can start before the submit returns, and then takes
the one running wake of that kind and name with no id yet.

#### 13.8.2 Answers

The model answers with a block in its final message, read in the main loop's `turn.complete`:

```text
ANSWER w41 merge
reason: nothing else waits for the next release, so the image change can join it
```

The first line is `ANSWER <id> <decision>` (backticks or bold around it read the same); each
following `key: value` line is a field (`reason`, `instructions`, or `fields` as one line of
JSON), and a blank line or any other line ends the block. An answer in any main-loop turn
counts, wherever the block sits; an agent's turn never answers a wake. The loop checks the id is
an open task, the decision is allowed for its name, and the field the decision needs
is there (the table). A refused answer leaves the wake open, and why goes
to the decision log and into the reminder. A task name the table lacks may only `hold`,
with a reason. As an alternative the model may call `mcp__factory-loop__answer` with the same
fields, which the mod registers; the wake probe showed the tool works while the mod is stable,
but a turn that starts during a reload does not get it, so the text block is the primary
channel. The tool refuses a call from inside an agent.

| Wake | Allowed decisions | Timeout falls back to |
|---|---|---|
| `task release` | `done`; `failed` (reason); `hold` | `tell(task-timeout)` |
| `tell <kind>` | none: delivered when its own turn ends having said something | dropped after the timeout |

A task whose own turn ends without an answer, however it ended, gets exactly one
reminder: its first line again with ` reminder=1`, plus up to three lines saying why the answers
it got were refused. Then the timeout applies, counted from the submit: a task ends `timed-out` (plan tells the owner,
`task-timeout`), and a tell ends `timed-out` (dropped, never sent again). Reminders go out only
in act mode with no kill switch. Only one wake is open at a time (rule `O2`).

#### 13.8.3 What stays model work

- **Releases and Run its** (I-36, I-85), through the repo's release process (its `release` skill
  or `RELEASING.md`), with the owner only where that process requires approval: the release
  task (11).
- **Owner chat**: relaying `tell` lines, answering questions, turning instructions into control
  calls, and keeping `.claude/orchestrator-memory.md` (I-81).

Triage is a spawned agent, not model work in the main conversation (5.2).

#### 13.8.4 Proven by the wake probe

Tested on 2026-10-12 in the spike workspace, in the orchestrators' launch mode
([probes/wake-probe](../probes/wake-probe/README.md)): `$.prompt.submit` starts a turn 20 to 70 ms
after the call; a text `ANSWER` line came back three times out of three (2 s, 12 output tokens,
370 to 630 tokens of context); the tool answer works while the mod is stable. The judge skill must
keep answers short: a model that cannot do what a wake asks explains at length.

### 13.9 Owner notices

#### 13.9.1 The title

```text
🔄 dev-system (Q:3 - D:5 - M:9) · owner 1
```

The repo's short name and three counts (DECISIONS D-23): `Q` issues in the queue (and queued
records), `D` in flight, and `M` merged in the last 6 hours. Usage is not shown. A word is added
only when something needs attention, in this order: `observe` when the pass does not act (observe
mode, or act mode held back by a rail), `blind` (which replaces the counts in a blind pass), a usage
tier that holds work (`stop new`, `stop all`), v2's `parked <n>` and `waiting <n>`, `at cap`,
`capped <bucket>` or `capped <kind>:<issue>` for each rate cap tripped, `gh wait`, and `owner <n>`
for open owner items. The driver sets `🔄 <name> · off` when the mode
is off or the kill switch exists, and adds `· error` after a pass that throws, until a pass
succeeds. The title is set with `/rename` only when the text changes, and at most once every
`titleEveryMs` (a throttle): a change inside the window waits, the first pass after it sets
whatever the title is then, and a change that reverts to the last title sends nothing. The
first title after a load goes out at once (`lastTitle` and `lastTitleAt` start null), and the
driver's off, kill-switch and error titles go out at once too, and every rename, those
included, stamps `lastTitleAt`, so the first plan title after them waits until `titleEveryMs`
has passed. Every rename, the act `title` action's and the driver's own, goes through the one title
flight, which starts the rename and returns at once, so no pass awaits a rename. At most one rename is in
flight; a title wanted meanwhile becomes the single pending title and replaces any earlier pending one, and
starts when the running rename settles, unless it equals the title then set. Each rename is bounded at 10 s.
A rename that succeeds stamps `lastTitle` and `lastTitleAt` (its resolve time); one that fails or times out
leaves both as they were, and its `offPass` row (13.12.1) is its one log. The `session.append` hook blanks the note the rename leaves for the
model (FINDINGS check 3).

#### 13.9.2 `tell`

A `tell` is a wake whose turn writes one line to the owner in the conversation, which the phone
shows, in the tick report's format: who acts first, what happens next, each issue or PR named by
its work with a markdown link (I-88, I-89). The foundation's kinds are `blind`, `runaway`,
`breaker`, `heartbeat-other`, `old-watcher`, `schema-behind`, `pass-error` and `task-timeout`; v2 adds its own
(appendix D, which includes the notice `done`). Each is sent once per key. The owner items (`parked`, `breaker`, `stalled`,
`checkout`, `workspace`, `rejected`, `keep-open-blocks`, `reopened`, `records-shadow`, `facts-shadow`, `wait-unreadable`, `starved`, `blind`, `reader-behind` and `release-hold`) go out before any other
wake, and the title counts the open ones.

Five notices come from outside plan: `heartbeat-other`, `old-watcher` and `schema-behind` (a rail
holding act mode back, 13.11.2; `schema-behind` carries `to` and `error`), `breaker kind=ping` (the ping storm, 13.11.4) and `pass-error` (three passes in a
row that threw, 13.10 item 9). Each is keyed by when its spell began, so it goes out once per
spell, through the wake executor, and only while no wake is open. A rail or breaker notice waits
in the store meanwhile; it is dropped once its spell ended before it could go out, and sent again
if the engine dropped the prompt. A pass-error notice is tried again at each failing pass. A
session the role check refuses sends no rail notice and no pass-error.

### 13.10 Failure handling

1. **A CLI fails.** The exit code and the first 2 000 characters of stderr go into the outcome.
   Exit 2 (usage) from the image's own CLIs is never retried and tells the owner (a loop bug);
   `gh` and `treehouse` exit 2 is retried like any failure (13.6.1). Other failures are
   retried by their rule with backoff while attempts remain, then the owner hears of it
   (`tell(stalled)`, 4.5). A CLI that times out is killed by `$.process.run` and counts as failed. An
   executor that throws is a failed attempt and never stops the pass.
2. **GitHub rate limits.** In act mode, an adapter or executor whose stderr shows a rate limit
   (`API rate limit exceeded`, a secondary rate limit, HTTP 403 or 429 with a rate-limit line)
   sets `githubBackoffUntil = now + 15 min` in the store. Until then the `github` and `queue`
   sources are skipped (their old values stay, with their age), and every action that writes to
   GitHub is held. Once an executor meets a limit, the pass's
   remaining GitHub-writing actions are skipped with no attempt counted. The title shows `gh
   wait`. Observe mode keeps no backoff.
3. **The database is down.** `callum-flow-factory-state` and `dev-query` fail: the pass is
   blind (rule `G2`). Running agents still report into the ledger, and nothing new is acted on
   until the factory source returns. After `blindNoticeAfterMs`, `tell(blind)`. The same holds when the image's
   report says it skipped events of a type or version its readers cannot read in the derivation (`skipped_events` with
   `derived`): the image is older than the loop, and the pass is blind with that error until the image is updated.
4. **An agent dies or hangs.** A `turn.complete` with reason `error`, `aborted` or `refusal`,
   or an agent list entry `failed` or `killed`, ends the entry as `failed`; the step is then
   unknown and takes the unknown path (5.1). A hang ends at the step's timeout (4.4), which
   stops the agent. An answer for an entry that no longer runs (a stop timed it out, a retry
   replaced it) is logged and dropped. A spawn that does not start within 60 seconds is a failed
   attempt.
5. **Two devices claim the same issue.** `callum-flow-claim` lets the earliest live claim win;
   the loser exits 3, and its outcome is `lost`. Rule `S1` skips the issue while the other
   device's claim is live. If another device takes an issue this device was working (a lapsed
   lease, reclaimed), the next observation shows the new holder, and the record closes by the
   `claim-lost` event (row E5, 4.3): its agents stop at the next seq (10.8).
6. **A restart lands mid-action.** 13.7.5.
7. **Usage crosses a tier mid-pass.** The tier is fixed for the pass from the observed reading.
   Before each `start`, `develop` or `drive` action the act step reads `$.session.usage()`
   (free) and skips the action, no attempt counted, if that reading puts it in a tier that
   forbids its class (the owner's override counts). A failed read leaves plan's tier standing.
   The next pass re-plans with the new tier.
8. **A wake is never answered.** 13.8.2: one reminder, then the timeout's fallback, which
   always holds rather than acts.
9. **A pass throws.** The error is logged with the pass number and how many passes in a row
   have thrown, the title shows `error`, and the next pass runs as normal. Three throwing passes
   in a row in act mode tell the owner once (`tell(pass-error)` with the last error), from a
   session the role check allows and with no kill switch.
10. **The store refuses a ledger save.** Nothing starts until a save succeeds: each action is
    skipped before it runs, no attempt counted, the decision log names the problem, and the
    pass ends by throwing, so the title shows `error`.

### 13.11 Safety rails

#### 13.11.1 Observe mode writes nothing that matters

In observe mode no executor runs. The adapters still run read-only CLIs, and some of them log
events as a side effect (`usage-check.sh`, `callum-flow-issue-read`'s `untrusted_stripped`); the queue is read with the plain reader, which
logs no `ready` events. Every command the loop runs, in any mode, gets `FACTORY_REGIME` and `CLAUDE_SESSION_ID` (13.4.1), so the events it logs carry the regime and the loop's session. Every command a pass that does not act runs (observe mode, or act mode
held back by a rail) gets `CALLUM_EVENTS_DIR=<loop dir>/sink-events`, so those lines land in a
local file that `event-push-loop` never ships. The hooks between passes (agents' answers, wake
turns, the answer tool, `/factory retry`) do nothing outside act mode, so they log no real event
and keep no ledger. The live event log stays clean (the owner deleted 34 fake rows on
2026-10-12, MEM).

#### 13.11.2 One acting loop per repo and device

Act mode needs all of the following, checked at the start of every act-mode pass, before any
action, in this order. Every refusal is named in the decision log (`rails`), and a pass that is
refused plans and records exactly as observe mode does (13.11.1).

- `mode: act` in the plugin options or the workspace file, and no kill switch.
- **The checkout is the repo.** The checkout's `origin` names the configured repo (ignoring
  case): the CLIs act on the checkout's origin and the `gh` executors on the configured repo,
  so a mismatch would merge in one and follow up in the other.
- **The role.** `DEV_ROLE=orchestrator`, unless the repo-local config sets
  `allowActOutsideOrchestrator`. A session this refuses can never act, so it tells nothing.
- **No old watcher.** No live `orchestrator-watch.sh` lock for the repo, found where the watcher
  puts it (`ORCHESTRATOR_WATCH_LOCK_DIR`, else `XDG_RUNTIME_DIR`, else `TMPDIR`, else `/tmp`),
  for the repo as given and lower-cased. A lock is live when `kill -0` reaches its pid and the
  process's command line names the watcher or cannot be read; a lock directory with no readable pid blocks too,
  and so does a probe that fails. If the old watcher is armed, the released skill is still
  driving: the loop stays in observe, tells the owner once per spell (`tell(old-watcher)`), and
  acts only after the lock has been gone 10 minutes, since the released skill's single-shot
  watcher comes and goes between its turns.
- **No other orchestrator.** No other device with role `orchestrator` and the same repo (ignoring
  case) has a heartbeat in `factory.workers_status` from the last 120 seconds, a stopping device
  included. While one does, the loop stays in observe, tells the owner once
  (`tell(heartbeat-other)`), and acts again after 120 seconds of quiet (DECISIONS D-28). A failed
  query blocks, and so does a device with no name (`DEV_MACHINE_NAME`), which cannot tell its
  own heartbeat from another's. It covers two workspaces on one repo, which the per-workspace
  act lock cannot see. A beat whose `coder_workspace` is non-empty and equals this loop's own
  `DEV_CODER_WORKSPACE` is never another orchestrator, whatever its device name: it does not
  block, and the pass line records it as `railTwins` (device and age in seconds). With no
  `DEV_CODER_WORKSPACE` nothing is left out.
- **The schema is current.** `dev-init` runs `factory-db-migrate` before the loop starts
  (cbundy/dev-system#888); it writes its outcome to `DEV_FACTORY_DB_MIGRATE_STATUS` (default
  `/tmp/dev-factory-db-migrate.json`). A missing file passes (no migrator is set up), as do
  `migrated` and `current`. `failed` and `timed-out` keep the loop in observe with the reason
  `schema: migrate to <v> failed: <error>` and tell the owner once per startup
  (`tell(schema-behind)`, keyed by the status's `at`). `running` keeps it in observe without a
  tell for 10 minutes; a `running` record older than that, or a file that cannot be parsed,
  keeps it in observe and tells (fail safe). The next pass after a success acts with no other
  step. The check runs after the heartbeat guard and before the act lock.
- **The act lock**, `<loop dir>/act.lock`, a JSON lease (`session`, `renewedAt`, `expiresAt`)
  taken only when every rail above passes. A lease lasts the longer of 5 passes and 15 minutes,
  longer than any single step (a queue merge, then its rollout read), and an acting
  pass renews it before every action and on a timer while it runs. Every write is a
  compare-and-set under `flock`, landing by rename: of two sessions that both read the lock
  free, one writes and the other is refused. A second session on the same workspace finds a live
  lease and stays in observe. If another session holds the lease mid-pass, the pass runs nothing
  more and lets the ledger go (13.7.1). `session.end` expires this session's lease, so the next
  session acts at once. A command running off the pass (13.6.1) does not keep the lease renewed:
  the lease is renewed by passes, and by the timer only while one runs. Its completion saves only
  while the lease is still this session's (the store refuses the write otherwise) and writes
  nothing else.

Two more things hold act mode back for a pass: a ledger the store could not load (13.7.1), and a
`dev-restart-self` that already returned (rule `R2`), which holds it for the rest of the
module's life when `windDownMinutes` is 0. With wind-down on, R2 wrote a request first and the
session keeps acting in wind-down instead: it reads answers and finishes work, starts nothing, and
remembers the request in case the request file is lost; once that request is stale the restart
never came, and the session plans normally. The rails remember each blocking spell in the store, so a reload does not tell
it again.

#### 13.11.3 The kill switch

`${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/OFF` (any content) forces `off` at the start of
the next pass, with no restart, and keeps the hooks between passes quiet: no answer is recorded,
no reminder or notice goes out. Removing it resumes the configured mode. An acting pass also
checks it (one stat) before each action but the title: an action already running finishes, every
action left is skipped with the reason `kill switch` in the decision log, and the pass ends.

#### 13.11.4 Runaway protection

Plan counts the ledger's token-spending actions per bucket (claims; agent steps;
wakes), and per kind and issue, in the last hour. An action past its `rateCaps` entry is
dropped, and the bucket stays closed until the window clears. A drop is visible in the pass
that makes it: the decision log names it (`rate cap: <bucket> <n>/<cap>`, or
`rate cap: <kind> on #<N> <n>/<cap>`) and lists it under `capped`, the title adds
`capped <bucket>`, a `loop` event records it once per hour, and `tell(runaway)` goes out once per
cap per hour. Three consecutive failures of one executor kind close that kind for 30 minutes
and tell the owner (`tell(breaker)`). A ping storm (more than 30 ping-driven passes in 10
minutes) switches the loop to its timer alone for 10 minutes, logs a `loop` event and tells the
owner once (`TELL breaker kind=ping`, 13.2).

#### 13.11.5 Scope of every action

The loop acts only on its configured repo (every `gh` command carries `--repo`, and act mode
needs the checkout's origin to be that repo, 13.11.2), only on issues and PRs by trusted authors
(`callum-flow-issue-read` filters them, and the guard's `author` check runs before any merge),
and only on branches named `issue-<N>`. It stops only agents it spawned (an agent the ledger
holds on a running entry), and only the main conversation can answer its wakes or set its
directives.

#### 13.11.6 Where its files live

`<loop dir>` is `${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/<owner>__<repo>/`, the config dir
with no doubled or trailing `/` (`contract.mjs` `loopDirOf`):

- the decision logs (`decisions-YYYY-MM-DD.jsonl`) and `control.json`;
- `settings.json`, the settings in force: every pass that observes rewrites it atomically (temp file,
  then `mv -f`), and the prune never touches it. It is `{v: 1, repo, at, plugin_version, settings,
  layers, derived, problems}`. `settings` holds every config key, `poolSize`, `device` and the
  directives `serial`, `noNewWork` and `usageOverride` (`{untilPct, expiresAt}` while live, else
  null); `layers` gives the source of each leaf key (`default`, `repo`, `workspace`, `plugin`,
  `env` or `directive`; an object-valued key such as `stateTimeoutMs` is one `parent.sub` key per
  entry); `derived` holds `gateConcurrency`, `cpus`, `memoryBytes` and `effectiveCap` (integers or null; the slot estimate drifts each pass and is not kept), the agents' `models` and the two experiment
  shares (null when unset or unreadable); `problems` is what the loader left out. No secret is
  written. A failed write is a `settings snapshot:` problem in the decision line, never a failed pass;
- the trace files (`trace-YYYY-MM-DD.jsonl`), in trace mode only, kept under `traceMaxBytes` in
  all (13.12.1);
- recorded states (`states/YYYY-MM-DD/<pass>.json`): observe mode only, one per changed digest,
  at most 288 a day and each under 3.5 MB, for the replay harness;
- `spawns/` (each spawn's record and prompt) and `answers/` (each spawn's job file and the
  answer file its agent records, 13.7.3a), and `respond/`, the detached respond logs of earlier
  loops, which the daily prune still clears;
- `companion.jsonl` and the wind-down files (7.2, 10.11);
- the observe-mode event sink (`sink-events/`);
- the act lock (`act.lock`, with its `act.lock.flock`).

Once a day the loop deletes the spawn records, answers, respond logs, recorded states and
decision logs older than 7 days (the ledger's own life), and the state day directories left
empty. The trace files are not pruned by age: their cap keeps them bounded. The act lock, `control.json` and the event sink are never touched. Nothing goes in the
repository.

### 13.12 Observability

One JSON line per pass in the decision log:

```json
{"v":1,"at":"2026-10-13T03:12:00.000Z","pass":184,"loaded":"2026-10-13T00:01:12.000Z",
 "trigger":"timer","ms":5210,"mode":"act","planner":"v2","executed":true,
 "device":"coder-dev-system-orchestrator","tier":"slow",
 "digest":"9f2c41d0","sources":{"factory":"ok","queue":"ok","github":"ok"},
 "counts":{"queued":3,"dev":2,"owner":1},
 "actions":[{"key":"claim:470:new","kind":"claim","class":"start","rule":"S1","issue":470,"reason":"ready and unblocked"}],
 "skipped":[{"rule":"S1","issue":340,"why":"tracker (has sub-issues)"}],
 "outcomes":[{"key":"claim:470:new","status":"done","ms":8123,"summary":"claimed #470"}],
 "ledgerSource":"store","commands":["callum-flow-factory-state --repo cbundy/dev-system ..."],
 "title":"🔄 dev-system (Q:3 - D:5 - M:9) · owner 1"}
```

`loaded` tells module loads apart, since pass numbers start over at each. `trigger` says what
asked for the pass: `first` (the first pass after the module loaded: a session start or a
reload), `timer`, `agent <id>` (an agent of the loop answered, through the script or its answer
tool), `wake <id>` (a wake was answered, by the answer tool or by its own turn; `turn <id>` when
the answering turn was no wake's own), or `owner <op>` (a `/factory` op) or `judge <op>` (the control tool).
Requests that arrive while a pass runs, or waits out its gap, join the next pass's trigger,
separated by commas. A ping the breaker ignores is left out. `ms` is the pass's time from its
start to this line. The error line of a pass that threw carries both. `executed` says
whether the pass acted. Act mode adds, when they apply: `outcomes` (each action's status, time
and summary; the title's left out), `ledgerSource` (`store`, `events` or `none`), `rails` (why
act mode was held back), `railTwins` (heartbeats from this loop's own Coder workspace under
another device name, left out of the heartbeat guard), `capped` and `atCap`, `breaker` (the ping breaker opened), `told` (the
notices from outside plan sent this pass), `config` (what the repo-local settings got wrong) and
`problems` (a loop event not logged, a store write refused, the act lease lost mid-pass).
`commands` lists every command the pass ran, observe's and the executors'. Other lines share the
file: an owner op (`control`, with its answer and `by`: `person` for `/factory`, `judge` for the control tool), a turn's or an agent's answer problems, an
agent's answer at its turn's end (`{ agent, key, answer: "script" | "text", status, summary,
scriptRefused?, afterRepair? }`: `script` when read from the file it recorded with the answer
script, `scriptRefused` what kept a recorded file out;
`{ agent, key, answer: "repair", why }`), and per tool call
`{ agent, tool, key, answer: "tool", afterRepair? }` or
`{ agent, tool, key?, answer: "tool refused", why }`, 13.7.3a), and a pass that threw (`error`,
with `failures` in a row).

`digest` is a hash of the canonical state without its timestamps, so unchanged passes are easy
to spot. Appends go through one `$.process.run` per pass (`sh -c 'cat >> "$1"'` with the lines on
stdin), because `$.fs.write` rewrites whole files. In observe mode each state whose digest
changed is also written in full under `states/` (13.11.6), which the replay harness reads. The last
pass's summary (mode, whether it acted, the rails, tier, title, action and owner counts) is also
kept in plugin state, for `/factory status`.

#### 13.12.1 Trace mode

Off by default. It is turned on by config `trace`: in the repo's `.claude/factory-loop.json`, or
in the workspace file, which wins. `/factory trace on|off` writes the workspace file, so it
applies from the next pass without a reload. When on, every pass also appends one JSON record to
`<loop dir>/trace-YYYY-MM-DD.jsonl`, so a stall can be traced, or the loop measured, without
reading any other file. When off, only the decision log's `trigger` and `ms` are written, and the
pass's own time does not change measurably.

A record's fields (times in ms, to a tenth of a millisecond; `t`, `queued`, `started` and `ended`
are ms into the pass):

- `v`, `at`, `pass`, `loaded`, `mode`, `executed`, `trigger`: as on the pass's decision-log line,
  so the two join on `at` and `pass`.
- `start`, `end`, `ms`: when the pass started and ended, and the time between. `ms` runs to the
  trace's own write, so it is a little more than the decision log's.
- `phases`: `setup` (the settings, the kill switch, the agent list), `rails` (act mode's checks
  and taking the act lock), `observe`, `plan`, `act` (the actions, the title, the notices and the
  store writes after them) and `log` (the decision-log line, a recorded state, the daily prune).
  They follow one another and add up to `ms`.
- `persistMs`, `eventsMs`, `lockMs`: the pass's time in store writes (the ledger's saves and the
  other keys), event writes (`callum-flow-event`) and the act lock's writes (its flock wait
  included), whichever phase they fell in.
- `observe`: the observe call's wall time split: `ms`; `commandsMs` (the time at least one read -
  a command, a file read or the session usage - was in flight, the union of their intervals, so
  overlapping reads count once); and `inProcessMs` (`ms` less `commandsMs`, never below 0: the
  loop's own work). Each is to a tenth of a ms.
- `sources`: each State source and the main checkout (`checkout`): `ok`; `cached` (no command of
  its own ran this pass, so its data came from the observe cache; GitHub when no issue was due);
  `reads` (its commands); `ms` (the sum of its commands' times, which can exceed the wall time
  once reads overlap, as the `prs` source's do); `ageMs` (how old State says its data is); and
  `error`.
- `commands`: every command and engine call the pass made, in the order they started: `phase`;
  `source` (for an observe read); `cmd` (the argv, or the engine call such as `agent.list`,
  `agent.spawn <name>`, `prompt.submit <first line>`, `fs.read <path>` or `act lock`, at most 160
  characters); `t`; `ms`; `exit`; `bytes` (what it printed, read or wrote); and `error` (a throw
  or a refusal).
- `actions`: each action an acting pass ran: `key`, `kind`, `status`; `queued` (when plan handed
  it over); `started` and `ended` (null for one held before it started); and `ms`. A spawn's `ms`
  is its time to start, since it returns once the agent started; its `agent.spawn` command is the
  engine's share of that time. A `heartbeat` or `sweep` row (13.6.1) carries `off: true`, its
  `status` is `running` and its `ms` is its launch time; rows of other actions have no `off`.
- `offPass`: each off-pass command that finished since the previous record (`[]` when none):
  `cmd` (the kind), `key`, `ms` (how long the command ran), `exit` (`-1` when it never exited) and
  `endedAt` (ISO), and `error` (the reason, clipped) on a `title` row whose rename failed or timed out. The
  session title's rename (`cmd: 'title'`, 13.9.1) is one of these commands; its action row carries `off: true`.
- `wakes`: every open wake, plus each wake that ended since the previous pass (reported once):
  `key`, `wake`, `status`; `queued` (its submit); `delivered` (its turn started; null when not
  seen, as across a reload); `ended`; `deliverMs` (queued to delivered); and `answerMs`
  (delivered to ended).
- `waiting`: what each issue waits on, one row each: `issue` (null for what holds the whole pass,
  such as a source being down), `stage`, `rule`, `on`, `since` and `forMs`. A row is one of three
  things. A skip plan gave: `on` is its reason, and `since` is when that issue's skip under that
  rule was first seen in an unbroken run of passes, so a stall like a step waiting out its timeout
  shows as a growing `forMs` even while its words change. A running ledger entry: `on` is
  `<key> running`, since the entry started. Or a live issue of this device that nothing names and
  nothing acts on: `on` is `no rule acts on it`, since its stage began. Skip ages start over when
  the module reloads.

The trace files stay within `traceMaxBytes` (100 MiB) in all. Before each write, the oldest trace
files are deleted first, by the day in their names, until the record fits. When today's file
alone leaves no room, it is cut short with one last line
(`{"v":1,"at":...,"cut":"the trace cap (<n> bytes) is reached: nothing more is traced today"}`),
and nothing more goes in it that day unless the cap changes. The first trace write of each
module load reads the last 256 bytes of today's file (`tail -c`), so a cut made before a reload
holds. A record that cannot be written
never fails the pass. A pass that throws writes no record; its decision-log error line has
`trigger` and `ms`.

Examples, from the loop dir:

```sh
# the ten slowest passes, with their phases
jq -sc 'map(select(.pass)) | sort_by(.ms) | reverse | .[:10][] | {start, pass, trigger, ms, phases}' trace-*.jsonl
# the ten slowest commands
jq -sc '[.[] | .pass as $p | .commands[]? | {pass: $p, phase, source, cmd, ms}] | sort_by(.ms) | reverse | .[:10][]' trace-*.jsonl
# the longest waits at the last pass
jq -sc 'map(select(.waiting)) | last | .waiting | sort_by(.forMs) | reverse | .[] | {issue, rule, on, since, forMs}' trace-*.jsonl
```

#### 13.12.2 The factory report

`hooks/report.ts` is a pure module: `reportOf(records, titles, now, repo)` returns `{ text, digest }`
(`text` is null when nothing is in flight and nothing has merged). `text` holds an "In flight (N)"
table and a "Merged" table of the five newest merges; `digest` changes with a stage change or a new
merge and not with time alone. The driver keeps `titles:<repo>` in the store, a map from issue
number to title filled from the issue reads observe already makes (no extra GitHub call) and pruned
to the issues with a v2 record. Nothing is sent yet: delivery, paced by `reportEveryMs`, comes in a
later child of #684.

### 13.13 Known gaps and risks

- **API-key spend** is a local tally, not the provider's bill: it sees only this loop session and the
  agents it starts (the session's process-wide `cost.usd`), not other Claude sessions using the same
  key, and each repo's loop keeps its own tally and budget. A restored counter on resume is handled by
  the delta rule (13.5.2 G3), but a crash loses the cost since the last stored pass. Set the budget
  below the real limit.
- **Wakes** are proven in the launch mode (13.8.4); a turn that starts while the mod
  reloads loses the answer tool, so deploys avoid open wakes and the text block is primary.
- **`stop-agent`** relies on the `TaskStop` tool through `$.tool.call`; untested from a mod. If
  it is unavailable, a timed-out agent is left running, marked `timed-out`, its rule waits for
  the agent list to show it ended, and the owner is told.
- **Agent ids from a mod**: the engine's test host never returns an agent id from
  `$.agent.spawn`, so spawning from a mod, and each agent's `turn.complete` carrying that id, is
  proven only once act mode runs on the testbed. `act.test.ts` drives the same act-step
  functions outside the host instead.
- **The observe-mode event sink** is one append-only file per repo that nothing prunes yet.
- **Per-agent OTEL attributes**: `agent.spawn` has no environment field, so the
  `OTEL_RESOURCE_ATTRIBUTES=issue=<N>` tagging in skill step 3 cannot be reproduced (DECISIONS D-11).
- **Long-running agents** (implementers for an hour or more, several at once) are untested from a
  mod (FINDINGS section 6). Observe mode cannot test them either, since it spawns nothing.
- **Auto mode**: if orchestrators move from bypass to auto mode, every agent report hands back to
  the main conversation and wakes the model (FINDINGS check 4). The loop must then stay in bypass.
- **The mod API is early access**: the plugin pins Claude Code 2.1.296 in its README, and the
  spike's checks are re-run before each upgrade.
- **GitHub reads in an observe-mode workspace**: since the owner approved a login on 2026-10-12, an
  observe-mode workspace reads labels, blockers and sub-issues live, so it can judge claims.
- **Agents' tools**: the loop spawns its own agent types (13.6.1), which list their answer tool
  and ToolSearch. Only the testbed can prove three things: that a mod-registered tool
  named in a plugin agent's `tools:` line is reachable through ToolSearch; that the call carries
  the agent's `agentId`; and that hiding a type with `agent.offer` leaves the loop's own
  `$.agent.spawn` of it working.
- **Mod tool schemas**: whether the engine checks a mod tool's input against its schema is
  unproven (the test kit does not); the handler checks every field (13.7.3a).
- **The engine's hook deadline** (#558): a probe mod's `tool.call` hook that waited before
  answering got its answer through at 3 s and 8 s. At 20 s the agent got `no tool.call hook
  answered this call`, though the hook ran to its end. This fits the documented `HookBudget`:
  10 s of the hook's own time, in which awaiting other work (the loop's hook queue) counts and a
  `$` call does not. The `.catch` refusal never reached the agents in run 3. The loop's 2 s bound
  (13.7.3a) keeps well inside it; only the testbed proves the live answer times.
- **Agents spawned from the loop's timer cannot reach its tools** (#560): on Claude Code
  2.1.296 and 2.1.299 a probe mod's `$.agent.spawn` made from a `$.clock.after` callback started
  an agent whose call to the mod's own tool failed in milliseconds with `<plugin> registered the
  tool ... but no tool.call hook answered this call`, and the hook never ran. The same spawn made
  inside a `command.run` hook worked. The loop's passes run from its timer, so every agent it
  spawns is in the failing case: this, not only the deadline above, was the cause of testbed run
  3's 80 and more failed tool calls. Built-in tools are not affected, and agents use Bash freely.
  So the loop's agents answer through the checked answer script (`answerChannel` `script`, 13.4.2,
  13.7.3a, DECISIONS D-74), a temporary workaround standing in for the tools, the intended design;
  the tools stay served. The probe lives in `docs/factory-loop/probes/timer-spawn-probe`: load
  it in a throwaway session (`claude --plugin-dir docs/factory-loop/probes/timer-spawn-probe`)
  and run `/timer-spawn-probe`, which spawns one agent inside its command hook and one from a
  timer, each calling the probe's tool, and logs each call and reply to
  `${CLAUDE_CONFIG_DIR:-~/.claude}/timer-spawn-probe/log.jsonl`. Run it on each Claude Code
  upgrade. When the timer agent's call reaches the hook (a `called` line for it, and its reply
  `pong`), set `answerChannel` to `tool` (the default in `hooks/config.ts`, or a repo's or the
  workspace's file to try it first) and retire the script.
- **The answer script** (#561) is proven only by tests and by hand so far: only the testbed shows
  that agents run it as their prompts ask, that the `CLAUDE_CONFIG_DIR` their Bash sees is the one
  the loop's engine reads (the script refuses any other config directory's answers, and the
  agent then has no answer), that the script's absolute path under `$.plugin.root` runs where
  the plugin is installed, and that a read-only reader (the reviewer or the triage) records its answer when the prompt
  says the script changes nothing else.
- **The repair message** (#559): probe mods on 2.1.299 proved that `$.session.send` to an agent
  after its `turn.complete` is delivered and resumes it: sent at once, after 60 ms of hook work,
  20 s later, and from a hook held 12 s past its budget. The list shows the agent `idle` once its
  turn ends. The engine resumes only a type it offers: with the type hidden it refused as in run
  3, and with it offered only while the send was on its way the agent was resumed. In that window
  (milliseconds, 10 s at most) the model would also be offered the type if it listed agents. Only
  the testbed proves it end to end. An agent the list still shows idle or completed 5 minutes
  after its repair message is taken as never resumed.
- **An issue closed on GitHub** (#556) is known closed only once observe has read it: for up to
  `githubEveryMs` after it closes, and on the first pass after a load when more than 12 issues the
  loop may act on are unread (they are read first, but within the pass's 12), its record is driven
  as before, except that no agent starts on it while the `github` source fails. An issue known
  closed is not read again unless this device holds it, so another device's or a released one
  reopened is driven again only once the queue lists it or the loop reloads.

## 14. Rule ids, and the count

### 14.1 Rule ids

Twenty-six rules, by id.

| Id | Name | When | Then |
|---|---|---|---|
| G1 | off | mode off, or the kill switch exists | the driver does nothing (foundation) |
| G2 | blind | the `factory` source fails, or its report skipped a derived event | title only; `tell(blind)` after `blindNoticeAfterMs` (foundation); `reader-behind` for non-derived skips |
| G3 | tier | always | the tier from usage (foundation) |
| G4 | controls | always | the admission filters: pause, no new work, skip, priority, only, serial, rate caps and the breakers (5.3); a held record's skip line names the filter (foundation) |
| H1 | heartbeat | a record not closed, and a lease due; or a record's claim lapsed | `callum-flow-claim --heartbeat <N...>`; a lapsed claim is claimed again onto the same record (4.1) |
| H2 | sweep | every `sweepEveryMs`, and once a close's entry actions are done and the last of them ended after the last sweep began | `callum-flow-sweep`, which ends a closed record's claim (3.6) |
| R1 | reconcile | every pass | a live claim of this device with no record is released (6.2): back to the queue, unless the owner dropped it (it leaves) or it was its `maxLives`-th life (rejected, 6.4); the main-checkout tripwire (10.7) |
| R2 | restart | `updateDue` is set, the pass admitted no other action, and no `queue-merge` runs (whatever `windDownMinutes`), and (only with `windDownMinutes` 0) no `queue-update` or release task runs | `restart-self`, last in the pass; with wind-down on it writes the `restart-self` request first and the wind-down finishes queue and release work up to the cap; a failed restart is told once and not retried until the update is set again. Cut agent steps re-run free (5.1). See wind-down (10.11) |
| S1 | claim | a queue issue passes the claim filters (open, trusted, `ready`, no skip label, not blocked, not a tracker, not skipped or paused; claimed in the order of the `only` list or else the `priority` list, then by score, highest first (the claim score, `hooks/v2/score.ts`: the factors `priority-label`, `bug`, `unblocks`, `closes-epic`, `nearly-closes-epic`, `epic-started`, `waiting` and `failed-lives`, weighted by `queueScore`; and, only while `intakeStamp` is `on` and the issue has a stamp, `area-factory`, `needs-owner` and `overlap`, which are null, never a penalty, when the stamp or the facts they read are missing), ties to the oldest claimable time, then the lowest number; the reason names the order, `owner only`, `owner priority` or `score <n>: <factor> <points>, ...`, and every S1 claim carries its `score` and `factors`, which the claim tool records on the `claimed` event; and no `factory:rejected`, 3.4), has no non-closed record, queued plus in-flight records are fewer than K, the tier allows `start`, and Slow's gap holds; or the life's claim is done and no record exists | `claim` (which also lists open PRs for adoption, 3.5); then row S0. I1 (13.4.4) plans after S1 and changes neither its choice nor its order. The pass also gets a starved verdict (`PlanResult.starved`): true when the queue is not empty, no record is queued or in a slot state, no first claim is in flight, `noNewWork` is off, `only` is empty, the tier is not `stop-new` or `stop-all`, and every queue issue was skipped by a claim filter; null when the queue or github source failed. While it is true and the spell (the store's `starved:<repo>`, set on the first starved pass, kept through unknown passes, removed on the first pass that is not starved) is `starvedNoticeAfterMs` old, `tell(starved)` (an owner item, key `tell:starved:<since>:<k>`) names each root blocker found in the `blockers` tree and why it is not moving; it waits, with the skip `starved since <time>: blockers not read yet`, until that period's tree is read; S1 also records the queue view (`hooks/v2/queue-view.ts`): each candidate of the order with its rank, score, factors and a why-code (`blocked`, `skipped`, `paused`, `outside_only`, `no_slot`, `new_off`, `usage_tier`, `rejected`, `tracker`, `held`, `exhausted`, `untrusted`, `unknown`), finalised in `planV2` after admission (a claim admission or wind-down drops is `no_slot`), which the `queue_snapshot` event carries (7.1) |
| S2 | step | a record in designing, building, reviewing or fixing, or with a triage due, whose step is not running, whose entry actions are done and which holds its slot; or a failed check on a head in reviewing or at the queue's head | `slot` op `prepare`, then `agent-step`; in reviewing `pr` ensure first; `ci-rerun` for a failed check (8.5) |
| S3 | transition | a step result, or an owner or GitHub event, for a record | the table row: `transition`, then the entry actions |
| S4 | unknown | an unknown result, a running step's timeout, or a GitHub wait past its bound | the unknown path, rows U1 to U4 (5.1) |
| S5 | triage | U3 or T6 | the triage step; its answer through X1 to X5 |
| S6 | owner and GitHub | drop, unpark, issue-closed, pr-merged, pr-closed, claim-lost, a waiting state's period | E1 to E7, P1 |
| Q1 | update | the merge queue's head is behind | `queue-update` keyed by main's head |
| Q2 | merge | the head is clean, green and approved | `queue-merge` keyed by its head |
| W1 | lease | a queued record with capacity, or a record in a slot state with no lease | `slot` op `lease` |
| W2 | free | a loop slot whose record holds none | `slot` op `free` |
| O1 | title | last; the text differs from `lastTitle` and `titleEveryMs` has passed since `lastTitleAt` (or it is null) | `title` |
| O2 | one wake | wakes are planned | at most one, owner items first |
| O3 | release | the Next milestone has no open item and one closed, and no release task started this UTC hour and none running (skip `release review running: ...`), and no `done`-answered release is in progress (`releaseInProgressMs`, skip `release in progress: ...`); also a merged issue (closed record, merge rollout) the milestone lists open again, read after the close | `task(release)`, key `task:release:<tag>:<hour>`, fields `closed expected tag oldest cadence`; for the reopened issue `milestone-later` and `tell(reopened)` (fields `issue pr`), once per life |
| O4 | release logged | the milestone exists and the newest known tag has no done `released:<repo>:<tag>` entry | a free `released` action (`callum-flow-released`), source `loop` or `workflow` (11); held in a GitHub backoff |
| O5 | milestone state | the milestone exists and its reading differs from the last logged (the newest done `milestone-state/` entry's fingerprint) | a free `event` of `milestone_state`, key `milestone-state/<fingerprint>/<last>` (11) |
| M1 | main state | the `main` source has a reading this pass whose state differs from the last logged (the newest done `main/` entry's), whatever the store's state | a free `event` of `main_state`, key `main/<last>/<current>`; no hold and no tell (9.5) |
| N1 | settings changed | an acting pass whose settings snapshot differs, leaf by leaf, from the one the store kept (`settings:<repo>`); none when no valid snapshot was kept | a free `event` of `settings_changed` per changed leaf, key `settings/<key>/<snapshot time, base36>`, `who` from the config ops since (`settings-ops:<repo>`), then the layer; at most 50 per pass, the rest named in a skip line |
| I1 | intake stamp | `intakeStamp` is `on`, the records are read and GitHub is not in backoff: an issue of the ready queue that passes S1's filters before its blocked and claim checks has a `bodyVersion` and no try for it, fewer than 2 runs are going (ascending issue number); a try still running whose run timed out, was lost or failed | `intake-stamp` op `run` (13.4.4), once per issue and body version; op `settle` for a try that never ended. Skips `no-body-version`, `tried`, `cap`. After S1 and the merge queue: it claims nothing and S1's choice and order are as without it |
| F1 | flake bug | the `flakes` source shows a test with `flakeBugMin` flakes in the last `flakeWindowDays` and no open bug carrying its marker; or a flake of a test with an open bug that is not on it; or a `flake-bug` entry done with no tell yet | `flake-bug` (one bug, `ready` only under `flakeBugReadyCap`), a `comment` for each later flake, and `tell(flake-bug)` once per bug (8.5) |

## 15. Decisions

Unnumbered, so parallel work cannot collide. Each entry records a choice the loop makes and why.
The first entries are the owner's own decisions; they are settled.

### A drop does not close the GitHub issue (owner)

- **Decision:** a drop closes the record and removes the labels; the issue stays open, and
  re-adding `ready` brings it back (4.1, 11).
- **Why:** the issue is the owner's; a drop is the factory stepping away.

### The loop closes a split's tracker once every sub-issue is closed (owner, 2026-10-18, #946)

- **Decision:** a split parent stays open as the tracker, and the loop closes it as completed when
  its last sub-issue is closed (8.7). A parent that blocked another issue stops blocking it then.
- **Why:** the tracker kept blocking its dependents after all its children had merged (the plant
  console case), until the owner closed it by hand.
- **Limit:** the check runs at a child's merge, so a child whose rollout is `run-it` or `keep-open`
  (its issue stays open) plans none; its tracker closes with a later sibling's check or by the owner.

### The reconcile migration runs now (owner)

- **Decision:** `factory-reconcile` is a one-shot tool. Its report goes to the owner, and the
  releases the owner approves run when the owner says so (6.3).
- **Why:** ghosts, issues the factory shows as live that nothing works on, are a gap the loop's own
  reconcile (R1) does not cover for work from before it.

### The migration's ghosts leave the factory (owner)

- **Decision:** every issue the one-shot migration releases leaves the factory, whatever its
  labels, and the report names each open PR, so re-adding `ready` brings one back with its PR
  adopted (3.5, 6.3). Nothing is requeued (owner, 2026-10-15, superseding "still labelled
  `ready` goes back to the queue").
- **Why:** the owner's first rule never requeued anything (claiming removes `ready`), and for
  what earlier loops left behind the owner chooses what comes back.

### A release puts the issue back in the queue (owner, 2026-10-15)

- **Decision:** R1's release re-adds `ready` (`reclaimed`), unless the owner dropped the issue or
  the issue is closed, when it leaves; and unless the lives cap is reached (below). The seven
  state labels go and `ready` comes back in one call (`label` op `requeue`), the one place the
  loop adds `ready` but a split's ready child (6.4, appendix B); a split's not-ready child gets no label from the split, its claim parks it (8.7).
- **Alternatives:** "still labelled `ready` goes back to the queue, otherwise it leaves".
- **Why:** that rule never fired, because claiming removes `ready`; a ghost of the loop's own is a loop
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
- **Why:** the owner's rule. With "up to date" on, the head's own CI carries main's
  state; a hold would make the queue wait on a person while holding K slots.

### Interventions, by a person or by the loop (owner)

- **Decision:** the measure is every unplanned step-in, not only a person's touch (7.2). An
  `intervention` event names who (`person` or `loop`), a cause code, a one-line reason and the
  issue when there is one. An issue is untouched only when no intervention of either kind names
  it.
- **Alternatives:** count only what a person did.
- **Why:** the owner's words: "I would like it to include any point where the orchestrator had to
  unexpectedly step in with judgement. For example, something is not merging correctly, or an
  agent does something strange or crashes. Otherwise these signals are lost." Every cause is an
  exact fact the loop holds, so the happy path logs none and the bar stays fair.

### The companion plugin is enabled through the Coder template (owner)

- **Decision:** `factory-loop-workspace` is in the orchestrator-loop template's plugin list
  (`coder/push.sh`). The operator or the owner pushes the template (10.9).
- **Why:** one place, and the rail holds agent steps and tells the owner if it is missing.

### The release task stays in the loop (owner)

- **Decision:** O3 is kept; `task(run-it)` goes into it, and it never waits on the owner inside its
  wake (11).
- **Why:** the judge has standing release authority. A merge waits on a release only for the
  bounded hold of 9.1 (see "The merge queue holds for a release's bump PR" below).
- **Hourly review (#761):** the wake was keyed by the milestone's counts and ran once per key, so a
  later milestone reaching a used count never woke the judge, and a `hold` was final. It is now
  keyed by the last release tag and the UTC hour, at most one release task starts per hour, so a
  `hold` is asked again the next hour while unreleased merged work remains. The loop reads the tag
  and the oldest merge since it (`gh`, on the milestone cadence, only while the milestone qualifies).

### `fixCap` 3 and `maxTriages` 2 per life (owner)

- **Decision:** both, as settings (appendix A).
- **Why:** 3 review rounds is the review cap the loop has always had, and 2 triages bound a step's unknown path without letting it loop.

### Rounds caused by other merges have their own cap

- **Decision:** a conflict, or red CI in the merge queue, is charged to `conflicts` against
  `conflictFixCap` (5), not to `fixes` against `reviewFixCap` (3). A reviewing `ci-red` and `changes`
  stay on `fixes`. The vias stay `fix:<kind>` and `fix-cap:<kind>`; the park question says which cap.
- **Alternatives:** raise `reviewFixCap`; reset `fixes` when the base moves.
- **Why:** on busy days other merges conflict a PR again and again while its own review rounds are
  done, and the shared cap parked PRs the loop could still land (`fix-cap:conflict` parks, 2026-10-18
  and 19). Own caps keep both bounded. Part of #1089.

### `In development` is dropped now (owner)

- **Decision:** the loop neither writes nor reads `In development`. The claim, heartbeat, sweep and
  factory-state tools use the claim comments, the claim events and the `factory:*` labels instead
  (3.6). The migration removes `In development` from the issues it touches (6.3).
- **Alternatives:** keep it until the old orchestrator is retired.
- **Why:** one label set per issue.

### Small modules, and a size guard (owner)

- **Decision:** the layout of 2.5: one module per area and kind, the planner a thin composer, the
  table as data. `npm run lint` fails on any file under `plugins/factory-loop/hooks/` over 600
  lines. The allowlist is empty, and an oversized file is split, never listed.
- **Why:** the first loop grew into a few large files (one planner file of over 2,500 lines). A
  check keeps the loop from doing the same.

### The loop's events use today's format (owner), superseded for writing by native events

- **Decision:** on 2026-10-15 the owner withdrew the decision to use issue #534's structured
  event format, and the idea of a new database table: "it's going to be too complex to add". The
  loop wrote today's format: existing `callum-flow-event` states and fields, with its extra fields as
  `key=value` tokens in the note, encoded as `loop` notes are. `hooks/v2/events.ts` is the one
  seam, so a later format change touches one module (7.1).
- **Superseded:** epic #534 supersedes it for the write side (#1141): the loop now writes the new
  format natively, through the same seam (`events.ts`, with the data in `event-native.ts`), so the
  change touched one module as intended. The read side's note parse stays for the `old` source
  until #656.

### The table is data, with one lookup

- **Decision:** the transition table is an array of rows in `hooks/v2/table.ts`; `rowFor` is the
  only reader, and it throws when zero or two rows match.
- **Alternatives:** transitions coded in rule functions.
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
  same.

### The ledger is the outbox

- **Decision:** a transition only stores the record; its effects are keyed entry actions of the new
  seq; a record is made from its done claim (3.3).
- **Alternatives:** do everything inside the transition executor; keep a `loggedSeq` field.
- **Why:** the ledger already retries keyed actions, so no lost write needs a rule of its own.

### Triage is a spawned agent, not a wake

- **Decision:** the one bounded triage call is a `factory-loop:triage` agent with the answer
  script.
- **Alternatives:** a JUDGE wake to the main session.
- **Why:** wakes go one at a time (D-26) and queue behind tells and owner chat. An agent has its
  own timeout, its own model and no claim on the main session's context, and it uses the same
  checked answer path as every other step.

### Free re-runs for causes outside the issue, once per attempt

- **Decision:** the free re-run row (U1, 5.1), with four causes the loop holds as facts.
- **Alternatives:** no free re-runs; free re-runs without a bound.
- **Why:** a night with two restarts and two usage windows would otherwise spend issues' retries
  and triages on the environment. The bound keeps work finite.

### The breaker counts step unknowns across issues

- **Decision:** 5.3.
- **Alternatives:** count parks; no breaker.
- **Why:** counting parks acts after every in-flight issue has spent its budget. Counting the same
  kind of failure across issues acts on the first few.

### Every record change is a transition event, self-transitions included

- **Decision:** retries, triage starts and free re-runs bump `seq` and log `transition`.
- **Alternatives:** log only state changes.
- **Why:** the record can then be rebuilt from events alone (3.3), and judgement calls and retries
  can be counted from factory data (#632).

### Records have their own store key

- **Decision:** `records:<repo>`, written only by the `transition` executor, rebuilt from events.
- **Alternatives:** records as a ledger entry kind.
- **Why:** the record is state, not an action; keeping it apart keeps the ledger's prune, fit and
  retry rules away from it.

### A step key is one attempt; the table retries steps

- **Decision:** each step attempt has its own key, `maxAttempts` 1. Effects (labels, comments,
  events, PR writes) keep the ledger's retries.
- **Alternatives:** the ledger's same-key retries for steps.
- **Why:** one retry mechanism per thing. A step's second attempt is the table's decision (5.1),
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
- **Alternatives:** send it down the step's unknown path.
- **Why:** a retry of the step cannot fix a failing label or comment write; the owner's `retry`
  can, once the cause is fixed.

### A build that answers "cannot" goes to triage

- **Decision:** T6.
- **Alternatives:** park at once; retry.
- **Why:** "cannot" is often a fixable misunderstanding; triage can redesign, instruct or
  park, and it is bounded.

### Patch identity has no context lines

- **Decision:** `git diff -U0 ... | git patch-id --stable`.
- **Alternatives:** git's default context; the PR's commit list.
- **Why:** a clean update keeps approval, which the serial queue relies on; the form with context
  lines would re-review after harmless updates.

### Review is keyed by patch and round

- **Decision:** 8.4.
- **Alternatives:** by attempt.
- **Why:** a CI problem or a retry must not buy a second opus review of the same patch, and a new
  round must let the reviewer judge a fixer's declines.

### A failed check is re-run once per round

- **Decision:** 8.5.
- **Alternatives:** no re-run; a special path for a fixer's decline of a red check.
- **Why:** a flake should not spend a fix round; one re-run is the generic retry for CI, as a
  check step has.

### The release hold covers the bump PR's CI, per push (#1048)

- **Decision:** the hold window is per bump PR head: it starts at the latest of the PR's creation, the
  head commit's time and the earliest start of the head's checks, and lasts `releaseHold`, now 45
  minutes. A push restarts it, a failed or cancelled check ends it, and a window that runs out with
  the head open and its checks not red ends as `hold:release-timeout` and tells the owner
  (`release-hold`). Supersedes the 10 minutes from the PR's opening below.
- **Alternatives:** raise the number of minutes only; hold with no bound until the bump PR merges.
- **Why:** #1035: a bump PR's CI still ran at 11 minutes, the hold from creation had ended, the
  queue merged a head and the bump PR fell behind main again. Time from creation does not follow the
  CI run, a rebase and force push restart it, and a release that failed should not hold the queue.

### The merge queue holds for a release's bump PR (owner, 2026-10-18, #970)

- **Decision:** while a release bump PR is open, the loop holds its merges for at most `releaseHold`
  (10 minutes) from the PR's opening. The PR is found by `releaseBranchPrefix`, a repo setting with
  no default (dev-system: `chore/release-`). Records stay in the queue; Q1 still runs (9.1).
- **Alternatives:** the judge sets a flag for a release in progress; a hold with no bound until
  the bump PR merges.
- **Why:** each bump PR fell behind main several times because the queue kept merging while its CI
  ran (#947: 36 minutes, #966: 42). The owner: "once a release starts it should be given 10 minutes
  grace time while other items must remain in the merge queue". GitHub's own creation time bounds
  the window, so a failed release holds merges for 10 minutes at most, needs no clearing, and every
  device and every restart honours the same hold.

### Rounds have no cap of their own

- **Decision:** only `fixCap` and `maxTriages` bound work; `round` is counted, not capped.
- **Alternatives:** a separate review-round cap.
- **Why:** every loop into reviewing goes through a fix, a triage or an outside push, so the bound
  already exists; one cap fewer.

### The queue moves past a head that did not merge

- **Decision:** order by `seqAt`; a head's non-ok result sends it to the back (9.1).
- **Alternatives:** keep the head through its retries and triage.
- **Why:** one stuck head could block every merge for about 150 minutes, against the owner's rule
  that a merge never waits (bounded since by the release hold, 9.1).

### The reviewer has its own definition

- **Decision:** `agents/reviewer.md`, built from the merge adjudicator's judgement rules (8.3).
- **Alternatives:** the adjudicator definition with a review purpose.
- **Why:** that definition is a no-mistakes gate adjudicator with another contract, and it stays as
  it is.

### The designer is a reader

- **Decision:** the designer returns the brief or the split; the loop posts and creates them
  (8.7).
- **Alternatives:** the designer writes to GitHub.
- **Why:** a retried designer made duplicate sub-issues, and the write guard would block the labels
  a split needs. Keyed effects make both idempotent.

### A fixer's dispositions are `verdict` events

- **Decision:** fixed is `CORRECT`, declined is `WRONG`, actor `fixer`.
- **Alternatives:** a new event kind.
- **Why:** the reviewer false-positive query keeps working unchanged (`docs/metrics.md`).

### An open PR is adopted at claim

- **Decision:** 3.5.
- **Alternatives:** always design from scratch.
- **Why:** released ghosts and hand-made PRs come back with their work. The review reads the whole
  diff, so nothing is trusted that was not reviewed.

### One branch name per issue, across lives

- **Decision:** `issue-<N>`, continued from its origin head (3.5).
- **Alternatives:** `issue-<N>-<k>` for a new life.
- **Why:** the owner's "one branch and one PR per issue for life". Continuing needs no
  force-push, and it keeps a released ghost's work.

### The issue keeps one slot from designing to merge-queue

- **Decision:** the designer and the reviewer read in the issue's slot too.
- **Alternatives:** a slot only for writers; readers in the main checkout.
- **Why:** no agent reads the main checkout, and one slot per life needs no hand-over.

### Leftovers are saved as a patch file

- **Decision:** 10.2.
- **Alternatives:** push a `park/issue-N` ref; discard them.
- **Why:** no extra branches on origin; the work is still recoverable for 7 days, and the retry's
  prompt names it.

### A companion plugin owns the agent's folder, its guard, its timeout and its stop gate

- **Decision:** `factory-loop-workspace` (10.3 to 10.6).
- **Alternatives:** the loop's own hooks; command hooks in callum-flow; a separate
  `claude -p` process per agent.
- **Why:** the spikes showed that the loop's own hooks never see agents it starts from its timer,
  and that a second plugin's hooks do. callum-flow must stay generic (CLAUDE.md, "This repo"). A
  separate process loses the agent id, `turn.complete` and TaskStop.

### The stop gate refuses while the gates fail

- **Decision:** no cap; a gate that cannot run lets CI decide (10.6).
- **Alternatives:** refuse twice, then let the answer stand.
- **Why:** it is the owner's rule. The step's timeout and the unknown path bound it.

### Gate commands are repo settings

- **Decision:** `gateCommands`, empty by default.
- **Alternatives:** read them from `.no-mistakes.yaml`; hard-code npm.
- **Why:** shared plugins stay generic (CLAUDE.md), and no-mistakes is out of the path.

### The loop sets the Bash timeout itself

- **Decision:** `$.env.set` at session start, and the companion's per-call value (10.5).
- **Alternatives:** an export in `dev-remote-control` (an image release); the Coder template.
- **Why:** both proven routes live in the plugins, need no image release, and cover other repos'
  loops too.

### Reconcile has no mode

- **Decision:** R1 acts on the loop's own facts every pass; the one-shot migration observes first and
  acts on approval by issue (6).
- **Alternatives:** an observe mode for R1 with approval sets and a hold on claims.
- **Why:** the owner asked for the first reconcile in observe mode, not a permanent one. The hold
  made one ghost stop every claim, a wait on the owner holding capacity.

### Releases reuse `reclaimed` and `abandoned`

- **Decision:** 6.4: `reclaimed` for a requeue, `abandoned` for a release that leaves or rejects,
  each with the release fields (`outcome` and `lives` among them, 7.1).
- **Alternatives:** a new `released` kind; a new `rejected` kind.
- **Why:** every reader already ends a claim on them, and the note's `outcome` tells a
  rejection apart for the metrics.

### Three new event states; everything else reused

- **Decision:** `transition`, `reviewed`, `intervention` (7.1).
- **Alternatives:** a new kind per state; carry state changes in `loop` notes.
- **Why:** `loop` is never a stage (D-09), so state changes need their own kind; reusing
  `delegated`, `fix_requested`, `merge_ready` and `verdict` kept every existing query working; since #1141 the loop writes the new format natively and the queries read the transitions.

### No label mirror

- **Decision:** labels are written, not read back, except the parked label (3.4).
- **Alternatives:** rewrite drifted labels each pass.
- **Why:** the record is the authority; the label list lags, and the rewrite undid parks.

### A drop applies to the life it closed

- **Decision:** 4.1, 11.
- **Alternatives:** a drop list that never expires.
- **Why:** bringing an issue back needed a hand edit of `control.json` (#602).

### Waiting states tell; running steps go unknown

- **Decision:** queued, parked and a waiting merge-queue record tell on their period and stay.
- **Alternatives:** unknown for every timeout.
- **Why:** nothing is running to retry in a waiting state; the owner needs to know, not a triage.

### A designer can wait on a checkable condition

- **Decision:** a designer blocked only on an issue closing or a PR merging answers `wait` instead
  of asking: the record enters the new state `waiting` (T16), which frees its slot and leaves the
  in-flight count as parked does, and the loop resumes it by itself (C1) when every condition
  holds, read with no model call. It links the issue as blocked by each issue condition and posts
  one comment. The owner's resume and drop still work, and a removed label is no resume.
- **Alternatives:** park with a question (the owner would answer "wait for #57" and remove the
  label by hand); hold the record in designing (it would keep its slot and count in flight).
- **Why:** a question for a fact the loop can read costs the owner an interruption for nothing;
  and waiting in a slot state would waste capacity (#828).

### Restart after a capped wind-down

- **Decision:** R2 writes the `restart-self` wind-down request (10.11) and runs `dev-restart-self`
  on a pass that admits nothing else. The stop script and the loop's own wind-down then finish
  queue actions, the release task and steps, up to `windDownMinutes`. A running step the cap cuts
  re-runs free (5.1). With `windDownMinutes` 0, R2 keeps the old wait for a queue action or the
  release task, writes no request, and the restart rail holds act mode.
- **Alternatives:** v1's drain before the restart; restarting at once and cutting queue actions;
  waiting for agent steps.
- **Why:** v1's drain had no cap and held the factory for hours. The cap bounds this wait, so
  finishing a merge or a release is cheap and safe, and the restart no longer cuts them. Owner
  approved on 2026-10-17.

### A resume resets the budgets and hears GitHub answers

- **Decision:** P1 resets attempt, triages, fixes and conflicts, and takes the owner's trusted comments since
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
- **Alternatives:** the repo file read at session start, and the workspace file for a few keys.
- **Why:** a `maxInFlightIssues` set in one file was silently ignored. Nothing keeps the main
  checkout up to date, so the repo file is read from the branch, not the tree.

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
   steps per life stay under the bound computed from `fixCap`, `conflictFixCap`, `maxTriages` and one free re-run
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
    whatever else is present. A resumed record whose PR a person closed is not
    parked again for that same close.
13. **Interventions are exact.** Replaying any interleaving of the loop's writes and delayed
    reads gives no `unpark` and no person intervention without a person's action. A happy-path life (design, build, an approving review, green CI, merge)
    logs no intervention. Each loop intervention of 7.2 is logged exactly once for its fact.
14. **The queue moves.** A head whose step ends other than ok is not the head on the next pass
    while another record waits.
15. **Review reuse.** No plan starts a reviewer for a (patch, round) that already has a done review.
16. **The foundation's properties** (13.5.9): determinism, idempotence (planning again with
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
19. **Size.** No file under `plugins/factory-loop/hooks/` is over 600 lines, and the allowlist is
    empty (2.5; `npm run lint`).
20. **Lives.** S0's record counts one more than the issue's earlier lives since its count last
    started (a record's count, then one per R1 release after it), and the first claim after a
    rejection is life 1, logged as `unreject`. S1 never claims an issue that carries
    `factory:rejected`. No release re-adds `ready` at or past `maxLives`.

## Appendix A. Settings

Every key the loader accepts, one row each: the foundation's (13.4.2) and the loop's own, in the repo-local file or the workspace file
(which wins). Durations take `60s`, `5m`, `2h` under the key without `Ms` (the "written" spelling) or a number of
milliseconds under either spelling. The Default column is what `/factory help config` prints (`hooks/config-help.ts`,
`defaultText`): a duration in its short form, `none` for null, a list as JSON, a map as `name value, ...`;
`tests/factory-loop-settings-docs.test.js` holds it to the loader. `/factory config set` refuses `mode` and `trace` (they
have ops of their own) and `shadowDevice` (a plugin option), and `help config` leaves them and the first-loop keys out.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `observe` | `off`, `observe` or `act` (13.4.1): what the loop does. A plugin option; the workspace file's `mode`, which `/factory mode` writes, wins |
| `shadowDevice` | `none` | a plugin option (13.4.1), observe mode only: plan as this device, the live orchestrator's, so an observe run can be compared with it; `none` plans as this one; ignored in act mode |
| `readyLabel` | `ready` | the queue and claim label (I-03). Labels are lower case for now, and every label comparison ignores case (owner, 2026-10-13) |
| `priorityLabel` | `priority` | 3.3: the label of the `priority-label` score factor (S1 orders by score after the owner's `only`/`priority` list), ignoring case; order only, never a filter |
| `inDevLabel` | `in development` | the claim label (I-03); ignores case, so `in development` matches GitHub's existing `In development` (owner, 2026-10-13) |
| `skipLabels` | `[]` | labels that keep an issue out of rule `S1` (I-92) |
| `trackerTitle` | `^(Epic\|Tracker)\b` | a title that marks a tracker, like sub-issues do (I-91) |
| `usageSlowPct` | `85` | the Slow tier (I-12 to I-16), in percent |
| `usageStopNewPct` | `90` | the stop-new tier (I-12 to I-16), in percent |
| `usageStopAllPct` | `95` | the stop-all tier (I-12 to I-16), in percent |
| `passEveryMs` (written `passEvery`) | `1m` | the timer |
| `titleEveryMs` (written `titleEvery`) | `5m` | the session title is renamed at most this often (13.9.1) |
| `reportEveryMs` (written `reportEvery`) | `10m` | the factory report is built at most this often; delivery comes in a later child of #684 |
| `queueEveryMs` (written `queueEvery`) | `2m` | observe cadence: the queue |
| `githubEveryMs` (written `githubEvery`) | `5m` | observe cadence: GitHub |
| `usageEveryMs` (written `usageEvery`) | `5m` | observe cadence: usage |
| `milestoneEveryMs` (written `milestoneEvery`) | `10m` | observe cadence: milestones |
| `usageStaleMs` (written `usageStale`) | `15m` | an older reading counts as unavailable |
| `heartbeatEveryMs` (written `heartbeatEvery`) | `20m` | rule `H1`'s cadence; also how long a claim that is done but not yet shown by the factory state counts as started (#538) |
| `sweepEveryMs` (written `sweepEvery`) | `30m` | rule `H2`'s cadence |
| `checkoutEveryMs` (written `checkoutEvery`) | `5m` | how often the main-checkout tripwire reads the checkout (10.7) |
| `slowGapMs` (written `slowGap`) | `10m` | Slow: the least time between two claims |
| `maxStartsPerPass` | `4` | claims per pass in Normal |
| `maxInFlightIssues` | `3` | a cap on this device's live issues (K, further bounded by the memory ceiling in 13.4.2; owner, 2026-10-13, lowered from 10 after the testbed run; default 3 as built). Reaching it shows: the decision log names each claim it holds back, the title adds `at cap`, a `loop` event records it, and the owner is told once each time it is reached |
| `worktreeReserve` | `2` | free slots kept for the steps of issues already in flight |
| `reviewFixCap` | `3` | review fix rounds per issue (`fixCap`, 8.6; I-48) |
| `conflictFixCap` | `5` | fix rounds per life for conflicts and red CI in the merge queue, apart from `reviewFixCap` (8.6; applied `next-pass`) |
| `guardRecheckMs` | `3m` | first loop only: accepted in a settings file, no effect |
| `guardTtlMs` | `5m` | first loop only: accepted in a settings file, no effect |
| `respondSettleMs` | `15m` | first loop only: accepted in a settings file, no effect |
| `updateBehindRetryMs` | `5m` | first loop only: accepted in a settings file, no effect |
| `updateBehindRetries` | `3` | first loop only: accepted in a settings file, no effect |
| `ciStallRecheckMs` | `15m` | first loop only: accepted in a settings file, no effect |
| `blindNoticeAfterMs` (written `blindNoticeAfter`) | `15m` | blind this long tells the owner |
| `starvedNoticeAfterMs` (written `starvedNoticeAfter`) | `1h` | a starved queue (S1: ready issues, every one unclaimable, nothing queued or in flight, no owner hold) this long tells the owner, naming the root blockers; applied `next-pass` |
| `agentTimeoutMs` | `designer 1h, implementer 2h, adjudicator 30m, fixer 2h` | first loop only: accepted in a settings file, no effect |
| `wakeTimeoutMs` (written `wakeTimeout`) | `judge 30m, task 6h, tell 30m` | per wake kind (13.8); a wake already running keeps the timeout it took |
| `maxAttempts` | `claim 3, designer 2, implementer 2, adjudicator 2, fixer 2, heartbeat 3, sweep 3, restart-self 1, stop-agent 1, judge 1, task 1, tell 1, agent-step 1, ci-rerun 3, queue-update 1, queue-merge 1` | per action kind or agent type, then the owner hears of it (`tell(task-timeout)` for a task); any other kind is 3, and v2's step kinds carry their own (appendix B). A task and a tell are asked once, with one reminder inside the attempt. Heartbeat and sweep are never used up: that many failures in a row tells the owner once, and they keep trying at their cadence (DECISIONS D-47), and the owner item (`tell:stalled:<key>`) stays while a retry runs, until a run ends `done` |
| `retryBackoffMs` (written `retryBackoff`) | `2m` | doubled per attempt; for heartbeat and sweep at most their cadence. A `lost` entry is retried at once |
| `rateCaps` | `start 30, spawn 120, wake 20, perIssueKind 6` | runaway protection (13.11.4): starts, spawns and wakes per rolling hour, and `perIssueKind` actions of one kind on one issue; no global cap on merges (DECISIONS D-24) |
| `queueScore` | `priorityLabel 30, bug 25, unblocksDirect 10, unblocksTransitive 5, unblocksCap 40, closesEpic 20, nearlyClosesEpic 10, epicStarted 10, waitingPerHour 2, waitingCap 20, failedLife 10, failedLivesCap 30, areaFactory 20, needsOwner 40, overlap 15` | the weights of the claim score (S1, `hooks/v2/score.ts`): whole numbers of at least 0, penalties as positive magnitudes; set one with `/factory config set queueScore.<name> N`; applied `next-pass`. `unblocks` is `min(unblocksCap, unblocksDirect x direct + unblocksTransitive x transitive)`, where transitive walks `state.blockGraph`; `waiting` is `min(waitingCap, floor(waitingPerHour x hours claimable))`; `failed-lives` is `-min(failedLivesCap, failedLife x earlier lives not ended merged)`; the three intake weights score only while `intakeStamp` is `on` and the issue has a stamp (`stamps:<repo>`): `area-factory` is `+areaFactory` for the label `area:factory` (stacks on `bug`), `needs-owner` is `-needsOwner` for the label `needs-decision`, and `overlap` is `-overlap`, once, when the stamp's `touches` (cut to their first segment) meet the `paths` of any other live record |
| `allowActOutsideOrchestrator` | `false` | act mode without `DEV_ROLE=orchestrator`, for a testbed (13.11.2) |
| `trace` | `false` | trace mode (13.12.1): one timing record per pass. The workspace file's `trace`, which `/factory trace on|off` writes, overrides it |
| `traceMaxBytes` | `104857600` | the trace files' total size (100 MiB): the oldest go first, and today's is cut short rather than pass it (13.12.1) |
| `answerChannel` | `script` | how the spawn prompts and the repair message ask agents to answer (13.6.3, 13.7.3a): `script`, through the checked answer script `bin/factory-answer`; `tool`, through their answer tools; `text`, with the text contract alone. v2's contracts use the script only (10.8). `script` is a temporary workaround and the default: `tool` is the intended design, but on Claude Code 2.1.296 and 2.1.299 an agent the loop spawns from its timer never reaches the loop's tool hook, while its Bash works (13.13, DECISIONS D-74). It replaced `answerTools` (#560), which is named as replaced and not read. The workspace file's `answerChannel` overrides it |
| `eventsSource` | `new` | `old`, `new` or `shadow` (3.3): where the facts and the ledger rebuild read the factory events; `new` since #978, and `/factory config set eventsSource old` is the way back, taken on the next pass |
| `stateTimeoutMs` (written `stateTimeout`) | `design 45m, build 90m, review 30m, fix 1h, triage 15m, queued 6h, queueWait 2h, parked 24h, waiting 24h` | 4.4: per state, a map of durations |
| `ciStartMs` (written `ciStart`) | `10m` | 4.4 |
| `ciRunMs` (written `ciRun`) | `30m` | 4.4 |
| `prEveryMs` (written `prEvery`) | `30s` | 2.4: how long a PR's read stands before it is read again, unless the loop's own doings make it due sooner |
| `mainEveryMs` (written `mainEvery`) | `5m` | 2.4: how often the default branch's state is read (act mode), any positive duration |
| `maxTriages` | `2` | 5.1 |
| `windDownMinutes` | `10` | 10.11: the minutes a requested wind-down may take, a whole number of at least 0; 0 turns wind-down off (a request is ignored). Read every pass from both settings files; `/factory config` shows it as `windDown`, with its source |
| `minimumReleaseCadenceMs` (written `minimumReleaseCadence`) | `6h` | 2.4: the repo's minimum release cadence, at least `1h`: the age by which the oldest unreleased merge should have shipped; the O3 wake names it as `cadence` |
| `releaseBranchPrefix` | `none` | 9.1: the head-branch prefix of a release's bump PR (like `chore/release-`), a non-empty string; `none` (null) turns the release hold off. Read every pass from both settings files; `/factory config` shows it with its source |
| `releaseHoldMs` (written `releaseHold`) | `45m` | 9.1: the longest the merge queue holds per head of a bump PR, counted from the head's anchor; 0 turns the hold off. Read every pass from both settings files; `/factory config` shows it as `releaseHold` (`off` at 0) |
| `releaseInProgressMs` (written `releaseInProgress`) | `2h` | 11, O3: after a release task answered `done`, no release review is planned until a newer tag is seen or this long has passed since it ended; 0 turns it off. Read every pass; `/factory config` shows it as `releaseInProgress` (`off` at 0) |
| `flakeWindowDays` | `7` | 8.5: the days back a test's flakes count toward a flake bug, a whole number of at least 1 |
| `flakeBugMin` | `2` | 8.5: the flakes of one test in the window that file a flake bug, a whole number of at least 1 |
| `flakeBugReadyCap` | `2` | 8.5: a new flake bug is readied only while fewer open flake bugs than this are `ready` or in flight, a whole number of at least 0 |
| `flakeEpic` | `none` | 8.5: the issue a flake bug is linked under as a sub-issue; `none` (null) links none. dev-system's `.claude/factory-loop.json` sets 864 |
| `maxLives` | `3` | 6.4: a release at this life rejects the issue instead of putting it back in the queue |
| `triageModel` | `opus` | 5.2 |
| `regime` | `factory_loop_v2` | `factory_loop_v2` or `testbed` (anything else, `manual` included, is refused and read as `factory_loop_v2`): the `regime` every event the loop's commands write carries, passed as `FACTORY_REGIME` (13.4.1); applied `next-pass` |
| `intakeStamp` | `off` | `off` or `on` (anything else is refused): the intake stamp's factors score (3.5) and the `paths` source reads (2.4); off changes nothing of the claim order and runs no reader (13.4.4: on, rule I1 also stamps each ready issue once per body version and sets `area:*` and `needs-decision` with the owner's precedence), and `/factory stamp <N>` (13.4.3) still dry-runs the reader |
| `intakeModel` | `haiku` | the intake agent's model; when larger than `triageModel` (haiku < sonnet < opus < fable) it is named in the config problems and `triageModel` is used |
| `intakeAreas` | `["factory","product"]` | distinct area names (`^[a-z][a-z0-9-]*$`) that hold `factory` and `product`; anything else is refused |
| `reviewer` | `adjudicator` | 8.2 |
| `reviewerModel` | `opus` | 8.3 |
| `uiCapture` | `none` | 8.3: unset (`null`, shown as `none`) leaves a missing capture an error; otherwise the repo's UI capture command (a non-empty string; the builder and fixer run it first) or the literal `none` (no capture tooling: a missing capture is at most a warning and builders capture nothing); anything else is refused; applied `next-pass` |
| `gateCommands` | `[]` | 10.6: the stop gate's commands; a repo sets its own |
| `gateTimeoutMs` (written `gateTimeout`) | `10m` | 10.6: in all |
| `gateConcurrency` | `auto` | 10.6: `auto` is `max(1, floor(cpus / 8))`, or a whole number |
| `gateWaitTimeoutMs` (written `gateWaitTimeout`) | `30m` | 10.6: in all |
| `slotMemoryMiB` | `auto` | the memory one slot is assumed to use, `auto` or a whole number of at least 1 (`next-pass`). `auto` is the p90 (nearest rank) of `memPeakBytes - memStartBytes` over the companion's gate lines of the window that carry both, each run once per (issue, life, seq, startedAt), once at least 3 such runs exist; with fewer it is 3072 MiB (the agent session plus one full stop gate; the plant-console figure of 12.9 GB held 3 at a time without an OOM kill). A set number wins. Shown beside the estimate's source: `setting`, `measured` or `default` |
| `memoryReserveMiB` | `2048` | the container's memory kept free of slots, a whole number of at least 0 (`next-pass`) |
| `poolSize` | `16` | the treehouse pool of the main checkout (13.4.1); the workspace file only, a whole number of at least 1 |

Retired keys: `planner` and `shadow` chose between the first loop and this one (2.3). A settings
file that still sets either one, to any value, loads; the key is ignored and `problems` reports it
as retired (`/factory config` shows it).

Keys only the first loop read (`guardRecheckMs`, `guardTtlMs`, `respondSettleMs`, `updateBehindRetryMs`,
`updateBehindRetries`, `ciStallRecheckMs` and `agentTimeoutMs`) are rows above: the loop still accepts them in a
settings file, and they have no effect. `/factory help config` lists them on one line, not as settings.

## Appendix B. Action kinds

| Kind | Class | Executor and argv | Attempts |
|---|---|---|---|
| `transition` | free | re-checks its trigger, stores the record, pings | 3 |
| `label` | free | `gh issue edit <N> --repo R --add-label <l> --remove-label <l,...>`; op `ensure`: `gh label create <name> --repo R --color <c> --description <d> --force` for the nine; op `clear` (3.4); R1's op `requeue`: `--add-label <ready> --remove-label <the eight>`, and op `reject`: `--add-label factory:rejected --remove-label <the eight>` (6.4) | 3 |
| `comment` | free | reads comments for its hidden key, then `gh issue comment <N> --repo R --body-file -` or `gh pr comment <p> --repo R --body-file -`; also R1's rejection comment (6.4) | 3 |
| `event` | free | `callum-flow-event --type <type> --data <json> [--issue N] [--actor A]`, built only by `events.ts` (7.1), for `transition`, `abandoned`, `requeued`, `merged`, `reviewed`, `finding_handled`, `intervention`; an action marked logged (7.2, `events.ts` `logOnce`) is settled done with no command | 3 |
| `pr` | free | op `ensure`: `gh pr list --repo R --head <b> --state all ...`, then `gh pr reopen <p> --repo R` or `gh pr create --repo R --base <d> --head <b> --title <t> --body-file -`, and `gh pr edit <p> --repo R --body-file -`; op `body`: the edit alone | 3 |
| `split` | free | per child: find it by its hidden key, else `gh issue create --repo R --title <t> --body-file -`; link it as a sub-issue and add `blocked_by` (`gh api` with the sub-issue and dependency endpoints); `gh issue edit <c> --repo R --add-label ready` for a ready child; a not-ready child gets none: plan claims it with a `park` and row S7 parks it (8.7) | 3 |
| `close-tracker` | free | a merged split child's check (8.7): read the issue (`callum-flow-issue-read --json N`; open fails, to be retried), find its split parent by the hidden key in its trusted body (none: done, nothing closed), read the parent (closed: done), read the parent's sub-issue states (the `sub_issues` endpoint, `--paginate`, number and state only); when none is open, `gh issue close P --repo R --reason completed --comment <text naming the sub-issues, no closing keyword>`, then the `closed` event for P with note `completed`. Outcome `{parent, closed, open}`; the key's `/up` chain checks the closed tracker's own parent | 3 |
| `link` | free | a waiting record's issue linked as blocked by an issue it waits on: read the blocker through `callum-flow-issue-read --json N` (its REST id, open or closed, issue or PR), read the links already there and add the `blocked_by` link (`gh api` with the dependency endpoint, as `split` does); a closed blocker or a pull request makes no link and ends done | 3 |
| `upstream` | free | a design's upstream request (8.7): `callum-flow-issue-read --json --list --state open` with `CALLUM_FLOW_REPO` set to the target repo (one of `UPSTREAM_REPOS`) for the request's marker, else `gh issue create --repo <target> --title <t> --body-file -`; no label, no other write. The one write to a repo other than the loop's own | 3 |
| `flake-bug` | free | rule F1 (8.5): `callum-flow-issue-read --json --list --state open` for the bug's marker, else `gh label create flaky --repo R ... --force` and `gh issue create --repo R --title <t> --body-file -`; then `gh issue edit <N> --repo R --add-label flaky --add-label <priorityLabel>`, the sub-issue link under `flakeEpic` (`gh api`, unless the epic holds it), and last `gh issue edit <N> --repo R --add-label <ready>` only when the action says the cap allowed it. The one place the safety tests let the loop add `ready` outside a split child and a requeue | 3 |
| `intake-stamp` | develop (run), free (settle) | rule I1 (13.4.4): op `run`: `callum-flow-issue-read <N> --comments`, `git ls-tree --name-only origin/<base>`, the try recorded in `stamps:<repo>`, then `$.agent.spawn` of `factory-loop:intake` (`intakeModel`); at the reader's end `callum-flow-issue-read --json <N>`, `gh label create <name> --repo R --color <c> --description <d>` (no `--force`) for a missing `area:<area>` or `needs-decision`, `gh issue edit <N> --repo R --add-label <l,...>` and `--remove-label <l,...>`, and one `intake_stamp` event; op `settle`: TaskStop of the reader, the try recorded failed, one event | run 2 per key (reading fails before the try is recorded; the try is never repeated), settle 3 |
| `agent-step` | develop (design, build) or drive (review, fix, triage) | `$.agent.spawn` with the step's agent type, through the step spawn (`hooks/v2/steps.ts`), after looking for a recorded answer (10.8) | 1 per key |
| `ci-rerun` | free | `gh run rerun <run id> --failed --repo R` | 3 per key, with backoff, in reviewing and at the queue's head; GitHub's own refusal is never retried (8.5) |
| `queue-update` | free | `gh pr update-branch <p> --repo R`, then reads the PR head until it moves | 1 per key |
| `queue-merge` | free | `callum-flow-merge <p> --patch <id> --issue <N>`, off the pass | 1 per key |
| `slot` | free | `factory-slot lease\|prepare\|kill\|free ...` | lease 3; prepare 1 per key (part of the attempt); kill 1 (best effort); free 2 |
| `released` | free | `callum-flow-released <tag> --repo R --source loop\|workflow` (5 min) | 3; exit 2 never retried; a missing tool ends done |
| `claim`, `heartbeat`, `sweep`, `stop-agent`, `rollout`, `close-issue`, `release-parent`, `milestone-later`, `restart-self`, `task`, `tell`, `title` | foundation (13.6.1) | foundation (13.6.1); `claim` also lists open PRs for adoption (3.5) | foundation (13.6.1) |

16 kinds of the loop's own, 12 from the foundation. The per-issue rate cap (D-24) counts `agent-step` by step kind. Every `gh`
command carries `--repo`. The safety tests allow exactly these argv shapes and keep every other
ban of the foundation (13.11). `rerun` is banned there otherwise, so `gh run rerun` is allowed
deliberately, as one argv.

## Appendix C. Key families

| Family | Example |
|---|---|
| claim | `i571/claim/ss1x2k`; a re-claim `i571/lss1x2k/claim/ss2a9q` |
| transition | `i571/lss1x2k/s7/t` |
| entry action | `i571/lss1x2k/s7/label`, `.../s7/stop`, `.../s7/kill`, `.../s7/comment`, `.../s7/event/transition`, a wait's `.../s7/link/57` |
| step attempt | `i571/lss1x2k/s7/build/a1`, `.../s7/prepare/a1`, `.../s9/triage/a1` |
| review | `i571/lss1x2k/review/3fa2c1d/r2/a1` |
| PR | `i571/lss1x2k/s8/pr/ensure`, `.../s12/pr/body/a1` |
| split child | `i600/lss0q1z/s3/child/b` |
| CI re-run | `i571/lss1x2k/rerun/r2/18342299123`; of a refused run (8.5): `i571/lss1x2k/refused/18342299123/p2` (a probe), `.../refused/18342299123/go` (on resume) |
| queue | `i571/lss1x2k/queue/update/9e01b77`, `.../queue/merge/4c2d8aa` |
| slot | `i571/lss1x2k/lease/1`, `slot/<lease id>/free` |
| follow-up | `i571/lss1x2k/follow/rollout`, `.../follow/close-tracker`, `.../follow/close-tracker/up` |
| reconcile | `i571/reconcile/ss1x2k/requeue` (the label op is the outcome: `requeue`, `leave` or `reject`), `.../comment`, `.../stop/<agent>`, `.../event`; a rejection's tell `tell:rejected:i571/reconcile/ss1x2k/reject` |
| intervention | `iv/` plus the key of the fact it records: `iv/i571/lss1x2k/s7/t`, `iv/i571/lss1x2k/rerun/r2/18342299123`; for a fact with no key of its own, `iv/<cause>/<subject>/<at>`, as in `iv/push/i571/ss3b0c` |
| released | `released:<repo>:<tag>` |
| milestone state | `milestone-state/<fingerprint>/<base-36 end of the newest done entry, or 0>` |
| main state | `main/<last>/<current>`, each a state key `<head>.<workflows>.<deployments>` (8 hex digits each) or `none` before the first |
| intake stamp | `intake/<issue>/<body version>` (the run), `intake/<issue>/<body version>/settle` |
| upstream request | `i<N>/l<L>/s<seq>/upstream` |
| flake bug | `flake-bug/<hash>/<first flake event id>` (the bug), `flake-bug/<hash>/c/<flake event id>` (a comment on it); its tell `tell:flake-bug:<bug number>` |
| heartbeat, sweep, tell, restart, release task | foundation (13.7.1) (the release task: hourly review, 11) |

19 families of the loop's own, plus the foundation's 5.

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
| `factory:waiting` | `fef2c0` | Factory loop: waits on a condition the loop checks; it resumes by itself |
| `factory:rejected` | `6a737d` | Factory loop: its last life ended without a merge; remove this label and add ready to try again. Not a state (3.4, 6.4) |
| `flaky` | `fbca04` | A test that failed and then passed on the same code. Not a state: F1's executor makes it (`gh label create --force`) and puts it on the flake bugs it files (8.5) |

The owner's `don't-merge` label is not in this table: the loop never makes it. The owner sets it on an issue or its PR, and the loop reads it and never changes it (9.1). It is a hold on a merge-queue record, not a state.

Notices (TELL kinds), owner items first:

| Kind | Owner item | When |
|---|---|---|
| `parked` | yes | a park, and its daily reminder |
| `breaker` | yes | 5.3, and the foundation's executor breaker |
| `stalled` | yes | an effect used up its attempts (4.5) |
| `checkout` | yes | the main-checkout tripwire (10.7) |
| `workspace` | yes | the companion plugin is not loaded (10.9) |
| `rejected` | yes | R1 rejected an issue at its `maxLives`-th life, with why each life ended (6.4) |
| `wait-unreadable` | yes | E6: a waiting record has an open condition unread (its read failing, or no release tag known) for a whole period; it replaces that period's `waiting` tell |
| `starved` | yes | S1: the ready queue was starved (all of it unclaimable, nothing queued or in flight, no owner hold) for `starvedNoticeAfterMs`; names each root blocker and why it is not moving; once per spell and 24 h period of it |
| `actions-refused` | yes | 8.5: GitHub did not start a CI job for the account's sake (payments, a spending limit); once per spell, naming its message and the PRs held; the loop resumes by itself |
| `blind` | yes | G2: the factory source has failed for `blindNoticeAfterMs`; its `error` says why (a derived skip: the image is older than the loop, so the owner updates the image; else the owner checks the database) |
| `reader-behind` | yes | G2: the image skipped events of types it cannot read, none in the derivation; names the types and the count; once per set of types; a release adding a reader of those types turns it into `blind` |
| `release-hold` | yes | Q2: a release bump PR's hold window ran out (`releaseHold`, 45 minutes by default) with its head open and its checks not red; names the PR, branch, head, minutes and checks; the queue merges again meanwhile; once per head |
| `waiting` | no | E6: queued 6 h, behind the queue's head 2 h, or waiting on conditions 24 h |
| `task-timeout` | no | the release task timed out |
| `done` | no | a done close (8.7): one [INFO] line with the issue, the evidence and what became of its branch |
| `flake-bug` | no | F1: a flake bug was filed (or found) for a test; names the test, its flake count and window, the bug, and whether it was readied or held by `flakeBugReadyCap`, whose owner step is to add `ready` (8.5) |
| `actions-resumed` | no | 8.5: a job started after a refusal spell opened; the spell ends and the refused runs are re-run once |
| `capacity` | no | S1: `maxInFlightIssues` is above the memory ceiling (13.4.2); once per (configured, ceiling) pair, naming the memory, the reserve, the estimate and its source, and the effective cap |
| `runaway`, `heartbeat-other`, `old-watcher`, `schema-behind`, `pass-error` | no | foundation, unchanged |

16 kinds of the loop's own, 10 of them owner items, plus `blind` (an owner item too) and the foundation's others.

## Appendix E. Owner ops

| Op | Meaning |
|---|---|
| `resume <N...> ["note"]` | unpark (P1); in the note `\"` is a `"` and `\\` a `\`. On an issue that is not parked it changes nothing and answers "not parked; use `/factory note N`" |
| `drop <N>` | E1, for the current life only (4.1) |
| `note [N] <text>\|off` | a note for the issue's next step (or every issue's), its text kept as typed (inner spaces and line breaks too, only the ends trimmed), replacing its earlier note; `off` clears it |
| `stamp <N>` | the intake reader's dry run on issue N (13.4.3): the reply at once, the notice when the reader ends. The reader answers `{"area": <one of intakeAreas>, "needs_owner": <bool>, "reason": <one line, 1 to 200 characters, required when needs_owner is true>, "touches": [<at most 20 distinct top-level names>]}`; `checkIntake` drops a bad field and names it (`ok`, `dropped` or `failed`). View-only: it logs no intervention, writes nothing to GitHub, the events, `stamps:<repo>` or the ledger |
| `stop-now` | writes `wind-down.stop-now` (`{ "at": ISO }`), which tells the stopper of a wind-down not to wait for what still runs (10.11); answers whether a wind-down is requested. Only the main conversation may set it |
| `retry <N>` | clears the issue's exhausted effects (4.5) |
| `status`, `pause`, `unpause`, `skip`, `noskip`, `priority`, `only`, `serial`, `new`, `override`, `update`, `mode`, `trace`, `config`, `help [config]` | as the foundation (13.4.3) |

Every op but `status`, `stamp` and `help` is logged as a person intervention (7.2). Rescues the loop cannot
see are recorded by hand with `callum-flow-event intervention` (7.2); there is no `/factory touch`
op.
