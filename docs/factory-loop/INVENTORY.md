# Factory loop: inventory of orchestrator responsibilities

Phase 0 of the [conversion brief](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md)
([tracking issue](https://github.com/cbundy/dev-system/issues/521)). One row per thing the
orchestrator does today, where it lives, what triggers it, who does it, and where it goes in the
loop. The new homes are named by their ID in [SPEC.md](SPEC.md):

- **rule `X1`**: a row of the plan's decision table (SPEC section 5).
- **exec `kind`**: an executor in the action catalogue (SPEC section 6). `spawn(<agent>)` is the
  agent executor. `judge(<kind>)` and `task(<kind>)` wake the main model (SPEC section 8).
  `tell(<kind>)` is an owner notice through the model, and `title` is the session title (SPEC
  section 9).
- **observe `source`**: an input adapter (SPEC section 3).
- **config `key`** or **control `key`**: a setting or an owner directive (SPEC section 4).
- **model**: stays with the main model, outside the loop. **agent**: stays inside an agent
  definition, unchanged. **CLI**: stays inside a CLI, which the loop calls. **dropped**: no longer
  needed, with the reason.

Sources: the skill is `plugins/callum-flow/skills/issue-orchestrator/SKILL.md` at v0.35.0
(cited `SKILL:<line>`), the watchers are in `features/src/callum-tools/`, and the
dev-system orchestrator's `.claude/orchestrator-memory.md` (read-only, 2026-10-12, cited
`MEM`) holds the owner rules and lessons the skill does not state.

Row 0 is the skill's frontmatter (`SKILL:1-10`). It is replaced by the new judge skill draft
(`plugins/factory-loop/skills/`, phase 3), and the released skill stays as it is.

## Role and inputs

| # | Responsibility | Where today | Trigger | Who today | New home |
|---|---|---|---|---|---|
| I-01 | Act as tech lead: delegate design and implementation, drive pipelines, verify and merge; never write feature code | SKILL:14-16 | always | model | The loop as a whole. The model's remaining job is the judge skill (SPEC section 8) |
| I-02 | Mechanics live in scripts and agents; each guard's FAIL line names its fix | SKILL:16-18 | any CLI call | model reads headers and FAIL lines | exec catalogue (SPEC 6), with a fixed FAIL map in rule `M2`. A FAIL line no rule maps goes to `judge(guard-fail)` |
| I-03 | Per-repo parameters: repo, ready label, in-development label, usage thresholds 85/90/95 | SKILL:20-24 | session start | model | config `repo`, `readyLabel`, `inDevLabel`, `usageSlowPct`, `usageStopNewPct`, `usageStopAllPct` |

## Ticks and the usage gate

| # | Responsibility | Where today | Trigger | Who today | New home |
|---|---|---|---|---|---|
| I-04 | A tick is a watcher line, an agent's termination or the watcher's timeout | SKILL:27-28 | events | watcher wakes the model | The loop pass: every `passEveryMs` (60 s) and at once on a ping (agent finished, wake answered, owner control). Model wakes: dropped |
| I-05 | Set the usage tier at the start of each tick | SKILL:28, 35-38 | tick | model runs `usage-check.sh` | observe `usage` (`usage-check.sh`, cached `usageEveryMs`) and rule `G3` |
| I-06 | List the ready and in-development issues and the open PRs | SKILL:29 | tick | model (`callum-flow-issue-read --list`, `gh pr list`) | observe `queue` (`queue-watch.sh --once` in act mode; the plain `callum-flow-issue-read --list` reader in observe mode, so a shadow logs no `ready` events), observe `factory` (stages, claims), observe `github` (labels, blockers, open PRs, metadata only) |
| I-07 | Handle what the event says | SKILL:30 | tick | model | Rules `P*`, `M*`, `D*`, `A*`: every pass re-plans the whole state, so no event can be missed |
| I-08 | Run the per-issue pipeline for each actionable `ready` issue that is not `blocked_by` an open issue, as far as tier and in-flight count allow | SKILL:30-31 | tick | model | rule `D1` (candidates: open, `ready`, trusted, `blocked_by` count 0, not a tracker, not skipped or paused) with capacity from `G3` and observe `pool` |
| I-09 | Never wait or poll inside a turn: the watcher is the wait | SKILL:32 | always | model discipline | dropped: there are no model turns in the loop; the loop is the wait |
| I-10 | Read issue, comment and PR text only through `callum-flow-issue-read`; record a non-zero `stripped` count; anything else is untrusted | SKILL:32 | every read | model | observe `queue` and `github` use `callum-flow-issue-read --json`; the loop reads labels, numbers, states and counts, never text. A non-zero `stripped` goes in the decision log. Agents keep their own rule (agent) |
| I-11 | Read usage before any action that spends tokens | SKILL:35-37 | before spending | model | rule `G3` gates every action by its tier class (SPEC 6.1). Before each `start`, `develop` or `drive` action the act step reads `$.session.usage()` again and skips the action, no attempt counted, if it now falls in a tier that forbids it (SPEC 10.7) |
| I-12 | Tier from the higher of `five_hour` and `seven_day` | SKILL:38 | tick | model | rule `G3` (pure function `tierOf`) |
| I-13 | Normal: dispatch as usual | SKILL:39 | tier | model | rule `G3`: every class allowed |
| I-14 | Slow: at most one new dispatch per tick; prefer merging in-flight work | SKILL:40 | tier | model | rule `G3`: at most one `new-work` action per pass, none within `slowGapMs` of the last, none in a pass that plans merge work. See DECISIONS D-07 |
| I-15 | Stop new: claim nothing and start no sub-agent for new work; in-flight work continues | SKILL:41-42 | tier | model | rule `G3`: `new-work` class blocked (claim, designer, implementer). MEM 18:55 confirms that a designed-but-undelegated implementer counts as new work |
| I-16 | Stop all: launch nothing, not even a fix-up round or `axi respond`; leave parked work as it is | SKILL:43-44 | tier | model | rule `G3`: only `free` actions run (no agent, no respond, no wake). MEM 19:08 confirms a WARN adjudicator waits in Stop all |
| I-17 | `usage=unavailable`: fail open as Normal and say so | SKILL:45 | tier | model | rule `G3` (Normal); the decision log shows the `usage` source failed. The title shows no usage (DECISIONS D-23) |
| I-18 | In Stop new or Stop all, arm one one-shot wake at the binding window's reset plus 2 minutes; resume under the Stop new threshold, else re-arm | SKILL:47-49 | tier | model (CronCreate) | dropped: the loop re-reads usage every `usageEveryMs` and resumes in the first pass under the threshold, so no wake is needed |
| I-19 | An owner instruction in the session to run past a threshold overrides the tier | SKILL:49 | owner chat | model | control `usageOverride` (`{ untilPct, expiresAt }`), set by the model through `mcp__factory-loop__control` or by `/factory override` |

## Watchers (all replaced by the loop)

| # | Responsibility | Where today | Trigger | Who today | New home |
|---|---|---|---|---|---|
| I-20 | Keep one watcher armed all session; its lock refuses a second copy | SKILL:52-54; `orchestrator-watch.sh` lock | session | model plus watcher | The loop runs for the session's life (`$.clock.every`). The single-copy lock becomes the act lock (SPEC 11.2): one acting loop per device and repo |
| I-21 | Active mode: Monitor, `--stream --deadline 1740` | SKILL:55-56 | active work | model | dropped: one cadence for all states |
| I-22 | Idle mode: background single shot, `--deadline 7140` | SKILL:57-58 | no active work | model | dropped: an idle pass costs no tokens (FINDINGS check 2) |
| I-23 | Re-arm from the last `rearm` line before handling an event; arm from the queue when there is none | SKILL:59-61; `orchestrator-watch.sh` rearm | watcher exit | model | dropped: no baseline to carry. The queue baseline lives in loop state (`queueKnown`) for `queue-watch.sh --once` and its `ready` events |
| I-24 | Watcher `timeout` is the audit tick: re-arm, heartbeat, sweep, re-read usage, check the resume wake | SKILL:62-64 | timeout | model | rules `H1` (heartbeat every `heartbeatEveryMs`) and `H2` (sweep every `sweepEveryMs`); usage per I-05; re-arm and resume wake dropped |
| I-25 | Fix a missing watcher or wake in the turn you see it | SKILL:64 | audit | model | dropped. The loop's own health is the decision log: a pass that throws is logged, the title adds `error`, and the next pass runs anyway; three in a row give `tell(pass-error)` (SPEC 10.9) |
| I-26 | Active to idle only at an active timeout; never TaskStop a stream copy; idle to active on owner chat | SKILL:65-68 | mode change | model | dropped: no watcher modes |

## Per-issue pipeline

| # | Responsibility | Where today | Trigger | Who today | New home |
|---|---|---|---|---|---|
| I-27 | Claim when the tier allows; exit 3 means another device holds it: skip | SKILL:71-72; `callum-flow-claim` | candidate issue | model runs the CLI | rule `D1`, exec `claim` (CLI). Exit 3 is outcome `lost`, and rule `D1` skips the issue while another device's claim is live |
| I-28 | Design: spawn `callum-flow:designer` with the issue, the branches in flight and the files they touch, and the owner's instructions | SKILL:73-75 | claimed | model | rule `D2`, exec `spawn(designer)`. The executor builds the prompt: other issues' in-flight branch names (the designer finds the files they share), owner notes from control `notes`, pointers to CLAUDE.md and the designer's own memory file (DECISIONS D-22, D-56) |
| I-29 | Keep only the designer's return: brief URL, created issues, dependency order, pending decisions | SKILL:75-76 | designer done | model | The prompt asks for a closing `RESULT` line; the outcome parser keeps only its fields (SPEC 7.2). A report with no `RESULT` line goes to `judge(report)` |
| I-30 | A pending owner decision: surface it and wait | SKILL:76 | designer return | model | rule `D3`: hold on the issue plus `tell(decision)`. Released by `/factory resume <N>` or by the control tool. MEM lesson: check the issue's comments for the owner's answer first, which the judge skill does |
| I-31 | On a split, release the claim on the parent (now a tracker): remove `In development`, leave `ready` off, log `abandoned`. Its `ready` sub-issues join the queue | SKILL:76-78 | designer return with created issues | model | rule `D3`, exec `release-parent` (label edit plus event). Sub-issues arrive through observe `queue` |
| I-32 | Delegate: run `callum-flow-implementer-route <N>`, log `delegated`, spawn `callum-flow:implementer` with the route's `model` and `OTEL_RESOURCE_ATTRIBUTES=issue=<N>,device=...` | SKILL:79-81 | brief ready | model | rule `D4`, exec `delegate` (route, then event, then `spawn(implementer)`). `agent.spawn` has no env field, so the OTEL attribute cannot be set per agent. The issue goes in the agent `description` and `name` instead (DECISIONS D-11) |
| I-33 | Pass the brief URL, never its content; keep `Closes`/`Fixes` out of briefs | SKILL:79, 82 | delegate | model | exec `delegate` prompt template: URL only. No template uses a closing keyword, and in free text a keyword before an issue reference becomes its `-ing` form; a test checks every template (SPEC 6.3) |
| I-34 | Rollout `merge`: the PR closes the issue | SKILL:84-85; `callum-flow-rollout` | merged | model | rule `M7`: nothing to do |
| I-35 | Rollout `merge` on an epic base: follow the merge script's manual closure instruction | SKILL:85 | merged | model | rule `M7`, exec `close-issue` from the merge output's `close_issue` field |
| I-36 | Rollout `run-it`: release on its own, never batched with another `run-it`, then do the Run it; whoever ran it records the result and closes the issue | SKILL:86-87 | merged | model | rule `M7`: exec `milestone-later` (I-38) and `task(run-it)`. The release and the Run it stay model work, with the owner (SPEC 8.3) |
| I-37 | Rollout `keep-open`: the owner closes it | SKILL:88 | merged | owner | rule `M7`: exec `milestone-later` (I-38) only |
| I-38 | A merged `run-it` or `keep-open` PR leaves the issue open: `callum-flow-milestone plan <N> later`, or it blocks its own release | SKILL:88-89 | merged | model | rule `M7`, exec `milestone-later` |
| I-39 | Replacing a branch or run for the same issue: log `superseded --run <old>`, not `abandoned` | SKILL:91 | re-drive to a new branch | model | Outcome rule: a fixer handoff that reports a branch other than the one it was sent to logs `superseded` (SPEC 6.1, 7.4). In `task(redrive)` the model logs it on `REGATE new-branch`, as the judge skill says. `callum-flow-regate --new-branch` reports `old_run` |
| I-40 | Stopping work on an issue (paused, split, dropped): log `abandoned` with run and branch when known | SKILL:92 | stop | model | exec `release-parent` (split) and exec `abandon` (the `drop` answer of `judge(cancelled)`, or `/factory drop <N>`, rule `D6`) log it |
| I-41 | Upgrade the workspace with `dev-restart-self`, never `coder restart`; after resume re-arm the watcher; CronList only for the usage wake | SKILL:94-98 | new image or template | model | rule `H4`: the loop restarts itself when the reconciler sets `updateDue` and nothing is in flight (DECISIONS D-15). After a restart the loop re-derives state (SPEC 10.6), and rule `H1` heartbeats on the first pass. Re-arm and CronList: dropped |
| I-42 | Delegate only through the named `callum-flow:*` agents, with no `model` argument except the implementer's | SKILL:100-101 | any spawn | model | exec `spawn`: agent types are a closed enum in the type contract, and `model` is set only from the route or a label |
| I-43 | An issue `model:<alias>` label means `model: "<alias>"` on every other sub-agent call for it, fixers included | SKILL:101-102 | any spawn | model | observe `github` (labels) gives `IssueView.modelLabel`; exec `spawn` passes it for designer, adjudicator and fixer. The implementer gets it through `callum-flow-implementer-route` (CLI) |
| I-44 | Serialize conflict-prone work with native `blocked_by` | SKILL:102-103 | design | model | The designer adds the links (its prompt carries the in-flight branches and their files); rule `D1` honours the `blocked_by` count. MEM 2026-10-12: the orchestrator also links by hand ("#431 blocked_by #339, same files"), which becomes a designer instruction |
| I-45 | Run independent issues in parallel, bounded by the tier and the worktree pool | SKILL:103-104 | tick | model | rule `D1` capacity: `pool.free > worktreeReserve` and in-flight issues under `maxInFlightIssues` (10 by default; reaching it shows as `at cap` and `tell(at-cap)`) |

## Pipeline events

| # | Responsibility | Where today | Trigger | Who today | New home |
|---|---|---|---|---|---|
| I-46 | A pipeline line is `<state> <branch> <run-id> ... head=<sha>`; never read a gate's log or the diff; never sleep or poll a run | SKILL:107-108; `pipeline-watch.sh` header | pipeline change | watcher plus model | observe `runs`: `pipeline-watch.sh --once` (new one-shot mode, every branch, plus `step=` for parked and failed) or, in shadow and replay, the watcher events in `factory.events`. The loop reads no log and no diff |
| I-47 | `parked`, or `failed` with a failing step: the gate is judged, not read | SKILL:109-110 | parked or failed | model | rules `P1` to `P3` |
| I-48 | Review gate only: cap at 3 fix rounds, counted from `fix_requested --note review` events; at 3 give the owner the brief URL and the run's `verdict` lines, and wait | SKILL:111-113 | parked on review | model | rule `P1`: `reviewFixRounds >= reviewFixCap` (3) gives a hold and `tell(review-cap)`. Rounds are the larger of the event count (observe `facts`) and the ledger's own count |
| I-49 | Spawn `callum-flow:adjudicator` with run id, branch, brief URL and the parked step | SKILL:114-115 | parked or failed | model | rule `P2`, exec `spawn(adjudicator)`, keyed by run, step and head |
| I-50 | Log each verdict line as a `verdict` event | SKILL:116-117 | adjudicator return | model | The adjudicator outcome handler logs them (SPEC 7.3) |
| I-51 | ACTION `approve`: `no-mistakes axi respond --action approve` in the background | SKILL:118-119 | adjudicator return | model | rule `P3`, exec `respond`. MEM lesson: respond has no `--run`; it runs in the slot that has the run's branch checked out |
| I-52 | ACTION `fix`: respond `--action fix`; on a review gate also log `fix_requested --note review` | SKILL:118-120 | adjudicator return | model | rule `P3`, exec `respond`; its success handler logs `fix_requested --note review` for the review step |
| I-53 | ACTION `skip`: respond `--action skip` | SKILL:118 | adjudicator return | model | rule `P3`, exec `respond` |
| I-54 | ACTION `escalate:` goes to the owner | SKILL:120 | adjudicator return | model | rule `P3`: hold plus `tell(escalate)` |
| I-55 | ACTION `fixer:` spawns `callum-flow:fixer` with the instructions and the brief URL, only when the pipeline cannot write the fix or the run is done | SKILL:120-122 | adjudicator return | model | rule `P3`, exec `spawn(fixer)` (the adjudicator already applied the "only when" test) |
| I-56 | Never pass `--yes`; `implement-issue` says how respond and rerun behave | SKILL:123-124 | respond | model | exec `respond` builds argv from a closed set (`--action`, `--step`, `--findings`, `--instructions`, `--add-finding`, `--reason`), each value one argv entry; the safety tests assert `--yes` and `rerun` never appear |
| I-57 | `failed` with run id `unknown` (no log directory): infrastructure. Check `daemon.log`, rebase, `callum-flow-regate`, fresh `axi run`; no fixer, no adjudicator | SKILL:125-127 | failed, id unknown | model | rule `P4`, `task(redrive)`: the model does it as today (rare; it needs `daemon.log` judgment). DECISIONS D-13 |
| I-58 | `merge-ready`: run the merge guard, then merge | SKILL:128 | merge-ready | model | rules `M1` (exec `guard`) then `M2` to `M5` |
| I-59 | `head-mismatch`, `conflict`: merge only after all guards pass; follow the guard's FAIL fix; fixer for a non-trivial conflict; a rebase keeps both sides | SKILL:129-130 | head-mismatch or conflict | model | rules `M1`, `M2`: conflict goes to `spawn(fixer)` with the "keep both sides" instruction in its template. Trivial and non-trivial are not told apart: every conflict gets a fixer (DECISIONS D-12) |
| I-60 | Only behind its base: `merge-guard --update-behind`, then `callum-flow-event rebased_behind` from its `UPDATED` line; the old run's following `head-mismatch` is expected and is the one that merges | SKILL:130 | guard says BEHIND | model | rule `M2`, exec `update-behind` (its success handler logs `rebased_behind`). The next pass sees `head-mismatch`, re-guards, and merges on `head PASS` |
| I-61 | `cancelled`: re-drive it (rebase, regate in the slot, fresh run) or drop it; never resume an old agent | SKILL:131 | cancelled | model | rule `P5`, `judge(cancelled)`: the answer is `redrive` (then `task(redrive)`) or `drop` (exec `abandon`) |
| I-62 | `ci-stalled reason=no-workflow`: tell the owner the default branch has no CI and do not merge | SKILL:132-133 | ci-stalled | model | rule `P6`: hold plus `tell(no-ci)` |
| I-63 | `ci-stalled reason=no-checks`: `gh pr close` and reopen once; if it stalls again, tell the owner the triggers do not match | SKILL:133-135 | ci-stalled | model | rule `P6`, exec `pr-reopen` once per run and head; the second stall gives a hold plus `tell(ci-triggers)` |
| I-64 | Run states with nothing to do (running, completed, not yet known) | `pipeline-watch.sh` | poll | watcher stays quiet | observe `runs`: `pipeline-watch.sh --once` prints `running` and `pending` (retried next pass) and nothing for a completed run; no rule acts on them |
| I-65 | Watcher `timeout` line (deadman heartbeat) | `pipeline-watch.sh` | deadline | watcher | dropped: the loop's pass is the heartbeat |
| I-66 | The watchers log every printed state to the event log (`watcher` actor, `--if-changed` on first sight) | `pipeline-watch.sh`, `queue-watch.sh` | state change | watchers | observe `runs` calls `pipeline-watch.sh --once`, and in act mode `queue` calls `queue-watch.sh --once`; both keep this logging, so metrics and `callum-flow-factory-state` see the same events. In observe mode every CLI writes to a sink, and the queue uses the plain reader (SPEC 11.1) |
| I-67 | A watcher error is a `watcher-error` line and a `watcher_error` event | watchers | crash | watcher | observe marks the source `failed`; rule `G2` handles a blind pass; `tell(blind)` after `blindNoticeAfterMs` |

## Merge

| # | Responsibility | Where today | Trigger | Who today | New home |
|---|---|---|---|---|---|
| I-68 | `callum-flow-merge-guard <pr>` checks read-only and prints one `GUARD <name> FAIL` line per failure; `--update-behind` is the orchestrator's alone | SKILL:138 | merge flow | model | exec `guard` (parses the lines into `GuardResult`); exec `update-behind` exists only in the loop, never in an agent prompt |
| I-69 | `UPDATE-BEHIND FAIL`: follow the full re-gate instruction; `SKIP`: follow its retry or guard instruction | SKILL:138 | update-behind result | model | rule `M2`: FAIL gives `spawn(fixer)` with the re-gate instruction from the line; SKIP gives a retry after `updateBehindRetryMs`, at most `updateBehindRetries`, then hold plus `tell(update-behind)` |
| I-70 | Act on each FAIL, re-run, and merge with `callum-flow-merge <pr>` once no FAIL remains | SKILL:139 | guard result | model | rules `M2` to `M5`; exec `merge` re-runs the guard itself |
| I-71 | Before merging, read every `no-mistakes(<step>)` fix commit against the issue's requirements | SKILL:141-142 | before merge | model | rule `M4`: the adjudicator, purpose `merge`, reads them and answers `merge`, `hold` or `fixer` with a summary, bump and flags (DECISIONS D-05) |
| I-72 | Send every `GUARD test-weakening WARN` to the adjudicator, then restore through a fixer or record the accepted justification in a PR comment | SKILL:143-144 | guard WARN | model | rule `M3`: `spawn(adjudicator)` with the WARN lines; `approve` gives exec `pr-comment` with its reason, `fixer:` gives `spawn(fixer)` |
| I-73 | Check the pipeline-built PR body (implement-issue shape, issue linkage) | SKILL:145 | before merge | model | linkage: the guard's `linkage` check (CLI). Body shape: part of the merge adjudicator's check (rule `M4`) |
| I-74 | `GUARD linkage FAIL`: run `callum-flow-fix-linkage <pr>` from the main checkout, re-run the guard | SKILL:146 | guard FAIL | model | rule `M2`, exec `fix-linkage` (cwd: the main checkout), then exec `guard` again |
| I-75 | Park-after-green (a green run left unmerged) is yours to merge; if the harness refuses, give the owner the PR link and guard output | SKILL:148-150 | ready to merge | model | rules `M1` to `M5` apply to every merge-ready run, whatever its age; rule `M6`: refusal gives a hold plus `tell(merge-refused)` with the PR link and guard lines |
| I-76 | Release the worktree after the merge, as `implement-issue` says | SKILL:150 | merged | model | rule `H3`, exec `release-worktree` (`treehouse return <path>` from the main checkout, only for a clean slot on the merged branch) |

## Special issue types

| # | Responsibility | Where today | Trigger | Who today | New home |
|---|---|---|---|---|---|
| I-77 | High-risk or large: split sub-issues arrive `ready`; only a pending owner decision stops a piece | SKILL:153 | design | designer plus model | agent (the designer splits and labels); rule `D1` takes the pieces from the queue; rule `D3` holds a piece with a pending decision |
| I-78 | If implementation has begun on an issue that turns high-risk, stop the agent before a PR | SKILL:153 | re-design | model | rule `A2`: exec `stop-agent` (through the `TaskStop` tool; untested, SPEC 13) plus `tell(stopped)` |
| I-79 | UI change: require before/after screenshots (a clip when interactive) on the PR | SKILL:154 | before merge | model | the merge adjudicator checks it (rule `M4`) |
| I-80 | Human-decision gates (branching, data loss, finalization): surface the options and wait | SKILL:155 | design or gate | model | rule `D3` (designer `pending_decision=yes`) and rule `P3` (`escalate:`): hold plus `tell(decision)` |

## Memory, releases and reporting

| # | Responsibility | Where today | Trigger | Who today | New home |
|---|---|---|---|---|---|
| I-81 | Read `.claude/orchestrator-memory.md` at session start (create it if missing); only this repo's lessons and state; generic lessons go upstream through `/update-dev` | SKILL:158-160 | session start | model | model (it still talks to the owner and answers judge lines). Agent prompts point at their own type's memory file instead (DECISIONS D-22). The loop's own durable state is control state and the ledger (SPEC 4.3, 7), and owner directives move there (I-90) |
| I-82 | Releases only when the repo has an open `Next release` milestone | SKILL:163 | tick | model | observe `milestone` (`callum-flow-milestone show`, every `milestoneEveryMs`) gives `optedIn` |
| I-83 | To make the release wait for an issue, `callum-flow-milestone plan <N> next` that tick; later work `later` | SKILL:163-165 | judgment | model | model: deciding that an issue gates the release is an owner or model call (`/factory` or chat). The deterministic half is rule `M7` (`later` after `run-it` and `keep-open` merges) |
| I-84 | Keep the bump current: `callum-flow-milestone expect <patch|minor|major> "<reason>"` | SKILL:165 | after merges | model | the merge adjudicator's report carries the `bump` (rule `M4`); rule `M7`, exec `milestone-expect` when it raises the current expectation |
| I-85 | Release ready when Next release has no open items: tell the owner and follow the repo's release process; never report holding it for an issue not in it | SKILL:166-168 | milestone empty | model | rule `O3`: `task(release)` once per milestone state; the release itself stays model and owner work (the `release` skill needs owner approval) |
| I-86 | Answer "what is planned" from `callum-flow-milestone show` | SKILL:168 | owner asks | model | model |
| I-87 | Tick report: one status line (usage and tier, watcher state, ready / in-development / open PR counts, resume wake id, Next release counts and blockers) | SKILL:171-173 | each tick | model writes it in the conversation | rule `O1`, exec `title` (set with `/rename` only when the text changes, note blanked; FINDINGS check 3), plus one decision-log line per pass. The title shows the queue, in-progress and merged counts and a word for whatever needs attention (DECISIONS D-23), not usage or watcher state; the resume wake id is dropped (I-18) |
| I-88 | Add a line only for an owner action, an owner decision or an orchestrator bug, opening with who acts and what happens next | SKILL:173-174 | when needed | model | rule `O2`, `tell(<kind>)`: one wake per new notice; the model writes the line in that format. The title counts open notices |
| I-89 | Name each issue or PR by what the work does, then a markdown link; never a bare number | SKILL:174-175 | report | model | The judge skill's `tell` instructions (model). The title uses counts only, so it carries no issue numbers |

## Rules and lessons that live only in the memory file

| # | Responsibility | Where today | Trigger | Who today | New home |
|---|---|---|---|---|---|
| I-90 | Owner directives: pause a set of issues (no responds, merges or dispatches), drain one at a time in a given order, "pick up nothing new", wind down, priorities, start after a usage reset | MEM 06:45, 08:50, wind-down | owner chat | model keeps them as free text | control `paused`, `noNewWork`, `serial`, `priority`, `only`, `skip` (SPEC 4.3), set through `mcp__factory-loop__control` or `/factory`, read by rule `G4` |
| I-91 | Trackers (issues with sub-issues) are never claimed | MEM 2026-10-12 owner rule | candidate | model | rule `D1`: `sub_issues_summary.total > 0` excludes it (from `callum-flow-issue-read --json`) |
| I-92 | Owner-parked issues carry a `parked` label | MEM 2026-10-12 | candidate | model | config `skipLabels` (repo-local, for example `["parked"]`); rule `D1` excludes them |
| I-93 | Run `callum-flow-claim --heartbeat` first thing after any restart or compaction | MEM 05:03 lesson | restart | model | rule `H1` fires on the first pass after a load whenever this device holds a live claim |
| I-94 | `axi respond` has no `--run`; run it from the branch's worktree and never pipe it through `tail` | MEM lesson | respond | model | exec `respond`: cwd is the pool slot on the run's branch (`treehouse status --json`), or one leased and switched to it; launched detached with `nohup` and `--step`, with output to a log per ledger key and attempt, which the launch reads back after 5 seconds (SPEC 6.1) |
| I-95 | Agents share one scratchpad and clobber each other's files: use a per-issue subdirectory | MEM lesson | any spawn | model tells agents | exec `spawn` prompt templates name a per-issue scratch subdirectory |
| I-96 | Never edit inside a PR body's `no-mistakes-pr-appendix` block | MEM lesson | PR edits | model | CLI (`callum-flow-fix-linkage` edits outside it); the loop never edits PR bodies itself |
| I-97 | Usage events: every `usage-check.sh` run logs one `usage` event | `usage-check.sh` | each check | script | observe `usage` keeps the cadence (`usageEveryMs`, 5 minutes), close to today's tick rate; observe mode sends it to the sink |
| I-98 | Two devices racing for one issue | `callum-flow-claim` collision rule | claim | CLI | CLI (earliest live claim wins); rule `D1` skips while another device's claim is live; SPEC 10.5 |

## Coverage of the skill, line by line

Every line of `SKILL.md` v0.35.0 maps to at least one row. Blank lines and headings are left out.

| Lines | Rows | Lines | Rows |
|---|---|---|---|
| 1-10 | row 0 (frontmatter) | 106-108 | I-46 |
| 14-16 | I-01 | 109-110 | I-47 |
| 16-18 | I-02 | 111-113 | I-48 |
| 20-24 | I-03 | 114-115 | I-49 |
| 26-28 | I-04, I-05 | 116-117 | I-50 |
| 28-31 | I-06, I-07, I-08 | 118-120 | I-51, I-52, I-53, I-54 |
| 32 | I-09, I-10 | 120-122 | I-55 |
| 34-38 | I-05, I-11, I-12 | 123-124 | I-56 |
| 39-45 | I-13 to I-17 | 125-127 | I-57 |
| 47-49 | I-18, I-19 | 128 | I-58 |
| 51-54 | I-20 | 129-130 | I-59, I-60 |
| 55-58 | I-21, I-22 | 131 | I-61 |
| 59-61 | I-23 | 132-135 | I-62, I-63 |
| 62-64 | I-24, I-25 | 137-139 | I-68, I-69, I-70 |
| 65-68 | I-26 | 140-146 | I-71 to I-74 |
| 70-72 | I-27 | 148-150 | I-75, I-76 |
| 73-78 | I-28 to I-31 | 152-155 | I-77 to I-80 |
| 79-82 | I-32, I-33 | 157-160 | I-81 |
| 83 | I-58, I-68 to I-76 | 162-168 | I-82 to I-86 |
| 84-89 | I-34 to I-38 | 170-175 | I-87, I-88, I-89 |
| 91-92 | I-39, I-40 | | |
| 94-98 | I-41 | | |
| 100-104 | I-42 to I-45 | | |

The brief's required topics and their rows: usage tiers and resume wake (I-11 to I-19); watcher
arming, modes and re-arming (I-20 to I-26); the tick report (I-87 to I-89); claim, design,
split, delegate, verify, merge and rollout (I-27 to I-38, I-58 to I-76); every pipeline state
(I-46 to I-67); the review cap (I-48); each adjudicator `ACTION` (I-51 to I-55); run id
`unknown` (I-57); test-weakening WARN (I-72); linkage FAIL (I-74); park-after-green (I-75);
`blocked_by` (I-08, I-44); worktree pool (I-45); model labels (I-43); `superseded` and
`abandoned` (I-39, I-40); high-risk, UI and human-decision issues (I-77 to I-80); the memory file
(I-81, I-90 to I-96); releases and milestones (I-82 to I-86); restarts (I-41, I-93).
