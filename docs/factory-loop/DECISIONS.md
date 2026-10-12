# Factory loop: decisions made without the owner

The brief says: do not stop to ask; take the conservative option, record it here with the
alternatives and why, and carry on. Each decision below is in force in [SPEC.md](SPEC.md) and the
code. The ones marked **owner call** are the ones most worth a look in the morning: the rest
follow directly from the skill or the brief.

## Owner calls

### D-05 The merge review stays with the main model (owner call)

- **Decision**: before each merge the loop wakes the main model with `JUDGE merge-review`, which
  reads the pipeline's fix commits against the brief, checks the PR body and any UI evidence, and
  answers `merge`, `hold` or `fixer` (SPEC M4).
- **Alternatives**: (a) give it to the adjudicator agent, which would cost the main context
  nothing; (b) skip the review when a run has no `no-mistakes(...)` fix commits.
- **Why**: the skill gives this reading to the orchestrator itself (SKILL:141-145), and FINDINGS
  names it as the model's judgment. It is one short turn per merge, much less than the model
  spends today. Moving it to an agent is a one-line change in rule `M4` if the owner prefers.

### D-09 No new event state for loop-only transitions (owner call)

- **Decision**: the ledger lives in `$.store`, which survives restarts. The loop logs only events
  the model logs by hand today (`delegated`, `verdict`, `fix_requested`, `rebased_behind`,
  `abandoned`, `superseded`). It adds no event state for "adjudicator spawned", "wake sent" or
  "notice sent" (SPEC 7.4, 7.5).
- **Alternatives**: add one `loop` state to `callum-flow-event`'s closed vocabulary, with a
  `kind=... key=... status=...` note, so the fleet can see every loop transition and a lost store
  can be rebuilt exactly.
- **Why**: a new state changes a closed vocabulary that metrics, `callum-flow-factory-state` and
  the evaluate tool read, which is a bigger change than the brief needs. Losing the store costs
  only harmless repeats (a second adjudicator or a repeated notice), because plan re-derives its
  work from observations. The brief asks that "a restart re-derives the ledger from the event
  log": the store plus observations meet that intent without the vocabulary change. If the owner
  wants fleet-wide visibility of loop actions, the `loop` state is the way, and it is additive.

### D-13 Re-drives stay model tasks (owner call)

- **Decision**: a `failed` run with id `unknown` (infrastructure) and a re-driven `cancelled` run
  become `TASK redrive` for the main model, which checks `daemon.log`, rebases, runs
  `callum-flow-regate` and starts a fresh `axi run`, as it does today (SPEC P4, P5).
- **Alternatives**: (a) a fixer agent with fixed re-drive instructions; (b) a new
  `callum-flow-redrive` CLI.
- **Why**: the skill says "no fixer" for the infrastructure case, and both cases need reading
  `daemon.log` and composing the run's `--intent`, which is judgment. They are not rare: in the
  week to 2026-10-12 dev-system had 21 distinct cancelled runs and one run with id `unknown`. But
  18 of those 21 were history (their issue was superseded, merged or abandoned afterwards), and
  the loop acts only on an issue's current run (SPEC 5.4), so about one wake every two days
  remains. A CLI is the better long-term home once the steps are stable.

### D-25 Owner notices wake the model (owner call)

- **Decision**: an owner action or decision is a `TELL` wake: the model writes one line in the
  conversation, which the phone shows, in the tick report's format. The title also counts open
  owner items (SPEC 9).
- **Alternatives**: (a) the title only, which costs nothing but carries no detail (no links, no
  brief URL, no verdict lines); (b) push notifications from the mod.
- **Why**: the skill's tick report adds a line exactly for these cases (SKILL:173-174), and the
  phone shows only the conversation, the title and push notifications (FINDINGS section 1).
  Notices are rare and important, so a short turn each is worth it. Push notifications were not
  tested from a mod.

### D-02 The plugin stays out of the marketplace until cutover (owner call)

- **Decision**: `plugins/factory-loop/` is built, validated and tested by `npm test`, but is not
  listed in `.claude-plugin/marketplace.json`. It loads only through `CLAUDE_CODE_PLUGIN_DIRS` or
  `--plugin-dir`.
- **Alternatives**: list it now as opt-in, like factory-hud.
- **Why**: the brief says do not ship. A listed plugin would reach every workspace with the next
  release. Listing it is cutover step 2 (SPEC 14).

### D-28 Act mode needs the orchestrator role and no old watcher (owner call)

- **Decision**: act mode also needs `DEV_ROLE=orchestrator` and refuses while an
  `orchestrator-watch.sh` lock for the repo is live (SPEC 11.2).
- **Alternatives**: rely on the mode option alone.
- **Why**: two drivers on one repo would double every action. The old watcher's lock is the
  clearest sign that the released skill is still driving. The role check stops a desktop session
  with the plugin installed from acting by accident. The repo-local
  `allowActOutsideOrchestrator` lifts it for a testbed.

## Interpretations of the skill

### D-07 What "at most one new dispatch per tick" means in Slow

- **Decision**: in Slow, at most one claim per pass, none within `slowGapMs` (10 minutes) of the
  last claim, and none in a pass that plans merge work (SPEC 5.2).
- **Alternatives**: one per pass with no gap; one in flight at a time.
- **Why**: today a tick is a watcher event or an agent's end, every few minutes when busy. The
  loop passes every 60 seconds, so "one per pass" alone would dispatch up to 60 an hour and defeat
  the tier. A 10-minute gap is close to today's real pace in Slow (claims at 18:40, 18:44 and
  18:50 on 2026-10-12 at 83 to 85%). "Prefer merging in-flight work" becomes "no claim in a pass
  that merges". Only the claim counts as the new dispatch: the designer and implementer for a
  claimed issue follow without waiting for the gap.

### D-08 Stop new also holds the designer and implementer of an already-claimed issue

- **Decision**: they are the `develop` class, blocked in Stop new and Stop all (SPEC 5.2).
- **Alternatives**: treat them as in-flight work, which Stop new lets continue.
- **Why**: the conservative reading of "start no sub-agent for new work", and it matches what the
  live orchestrator did at 94% on 2026-10-12 ("#489 implementer held", MEM 18:55).

### D-12 Every conflict gets a fixer

- **Decision**: a guard `mergeable` conflict or a `conflict` run state spawns a fixer (SPEC M2).
- **Alternatives**: tell trivial from non-trivial conflicts and rebase trivial ones in code.
- **Why**: the skill says "spawn a fixer for a non-trivial conflict", but telling the two apart
  is judgment, and a wrong "trivial" rebase can drop one side of colliding additions. A fixer
  handles easy conflicts as well.

### D-17 Trackers are never claimed; parked issues are skipped by label

- **Decision**: an issue with sub-issues (`sub_issues_summary.total > 0`) is never a candidate,
  always. Labels in the repo-local `skipLabels` (for example `parked`) also exclude an issue
  (SPEC D1).
- **Alternatives**: leave both to owner `skip` directives.
- **Why**: "trackers are never claimed" is a standing owner rule (MEM 2026-10-12, follow-up #471)
  that holds in every repo. The `parked` label is this owner's convention, so it is repo
  configuration, not plugin code.

### D-18 Holds are derived, not stored

- **Decision**: a hold (a pending decision, an escalation, the review cap, a merge-review `hold`)
  is not a stored record. It is the plan finding that the fact still stands and the owner has not
  resumed that subject since. A new head, a closed issue or an owner `resume` ends it (SPEC 5).
- **Alternatives**: a stored hold list.
- **Why**: one less piece of state to keep in step. A hold ends by itself when its subject moves
  on, which is the behaviour the skill describes ("wait").

### D-29 Rollout follow-ups only for merges the loop made

- **Decision**: `M7` acts on the loop's own `merge` entries. A PR the owner merged by hand gets no
  `milestone-later` or `task(run-it)` from the loop.
- **Alternatives**: read the rollout of every newly merged issue.
- **Why**: a hand merge means the owner is driving that issue. The model hears of it in chat and
  can do the follow-up.

## Architecture

### D-03 Plan does not know the mode

- **Decision**: `plan` computes the same actions in observe and act mode; only the driver decides
  whether to execute them (SPEC 2).
- **Alternatives**: plan only what the mode allows.
- **Why**: observe mode then shows exactly what act mode would do, which is the point of the
  shadow run.

### D-04 The model answers with a text block, the tool as an alternative

- **Decision**: an `ANSWER <id> <decision>` block with optional `key: value` lines, read in the
  main loop's `turn.complete`. The `mcp__factory-loop__answer` tool is accepted as well (SPEC 8.2).
- **Alternatives**: the tool only, as first planned.
- **Why**: the wake probe showed both work, but the tool goes missing for a turn that starts
  while the mod reloads, and the text block costs least. The first plan (tool first) changed on
  that evidence.

### D-06 Usage comes from `usage-check.sh` every 5 minutes plus the session's own figures

- **Decision**: SPEC 3.3, `usage` source.
- **Alternatives**: `$.session.usage()` only, which is free.
- **Why**: the session's figures come from its own last API response. An idle loop makes no API
  calls, while the other orchestrators keep spending the same plan, so those figures go stale and
  under-report. `usage-check.sh` asks the usage endpoint and is token-free, and every 5 minutes is
  close to today's rate of `usage` events (380 in 7 days).

### D-10 Observe mode sends side-effect events to a sink

- **Decision**: every command run in observe mode gets `CALLUM_EVENTS_DIR=<loop dir>/sink-events`
  (SPEC 11.1).
- **Alternatives**: skip the CLIs that log, or add a no-log flag to each.
- **Why**: `usage-check.sh`, the `--once` modes and `callum-flow-issue-read` all log as a side
  effect. One environment variable keeps all of them out of the live event log without touching
  their code, and the sink file is itself evidence of what the shadow run read.

### D-14 The designer's result is parsed from a `RESULT` line the prompt asks for

- **Decision**: the loop's designer prompt asks for a closing
  `RESULT brief=... created=... pending_decision=...` line (SPEC 7.2).
- **Alternatives**: change `designer.md` to require it; parse its prose.
- **Why**: the brief forbids changing the released skill's behaviour, and the live orchestrators
  share the agent definitions. The prompt is the loop's own. A missing line goes to the model
  (`judge(report)`), never a guess.

### D-19 `blocked_by` comes from the issue's dependency summary

- **Decision**: `issue_dependencies_summary.blocked_by` (open blockers) from
  `callum-flow-issue-read --json <N>` (SPEC 3.1).
- **Alternatives**: a new `--blocked-by` mode on the reader, or a field in
  `callum-flow-factory-state`.
- **Why**: GitHub already returns the count on the issue object through the sanctioned reader
  (checked on 2026-10-12: #470 shows 1). No CLI change is needed.

### D-20 Pipeline classification stays in `pipeline-watch.sh`, through a new `--once` mode

- **Decision**: SPEC 3.4. The queue gets the same treatment (`queue-watch.sh --once`).
- **Alternatives**: re-implement the classification in TypeScript.
- **Why**: the brief asks for it, and the classification (head checks, CI markers, mergeability,
  stalls, run id resolution) is subtle and tested. A one-shot mode reuses it and keeps the
  watcher's event logging, so metrics see the same events.

### D-21 Shadow and replay read pipeline states from the event log

- **Decision**: `runSource: events` builds runs from the live orchestrator's watcher events and the
  mirror (SPEC 3.3).
- **Alternatives**: run the shadow loop on the orchestrator's own workspace.
- **Why**: pipeline runs are local to the workspace that started them, so the spike workspace has
  none for dev-system. The brief forbids touching the live orchestrator's workspace. The watcher
  logs every transition to `factory.events`, which gives the same states, a little later.
- **And**: the shadow loop observes as the live orchestrator's device (`shadowDevice`), because
  the plan drives only runs and claims the device holds. That is safe only because observe mode
  never executes anything, so the setting is refused outside observe mode.

### D-26 One wake at a time

- **Decision**: at most one `JUDGE`, `TASK` or `TELL` open at once (SPEC O2).
- **Alternatives**: several queued prompts.
- **Why**: the model answers one prompt per turn, and queued prompts would arrive while it is
  still answering the first. One at a time keeps each answer tied to its line.

### D-31 The judge skill is a new skill in the new plugin

- **Decision**: `plugins/factory-loop/skills/judge/SKILL.md`, a draft written in phase 3. The
  released `issue-orchestrator` skill is not touched.
- **Why**: the brief forbids changing the released skill. A separate skill can be reviewed and
  shipped on its own.

## Numbers and small choices

### D-01 Work documents live in `docs/factory-loop/`

The brief names the files but not where they go. Keeping them out of `plugins/factory-loop/`
keeps them out of the shipped plugin.

### D-11 The issue goes in the agent's description and name, not in OTEL attributes

Skill step 3 spawns the implementer with `OTEL_RESOURCE_ATTRIBUTES=issue=<N>,device=...`.
`agent.spawn` has no environment field (checked in the 2.1.296 declarations), so the loop cannot
set it per agent. The issue number goes in the spawn's `description` and `name` instead. If
per-issue telemetry matters, that needs an engine feature or a wrapper agent.

### D-15 The loop never restarts its workspace

`dev-restart-self` stays a model or owner action (I-41). A restart kills every in-process agent
(the memory file shows the owner holding releases for exactly that reason), so deciding when to
restart is judgment.

### D-16 Owner directives become control state

The pause, drain, wind-down, priority and skip instructions the memory file holds as free text
(I-90) become typed control state, set through the control tool or `/loop` (SPEC 4.3). The model
still keeps the memory file for lessons and context.

### D-22 Agent prompts point at the memory file

Every spawn prompt points at `.claude/orchestrator-memory.md` in the main checkout, as the
designer's does today. This is a small change for the implementer, adjudicator and fixer, whose
prompts carried only the brief URL. The memory file holds lessons for agents (scratch
directories, the PR appendix block).

### D-23 The title rounds usage down to 5%

So the title, and so the `/rename`, changes a few times an hour instead of every minute. Each
rename leaves two transcript rows, though the model's note is blanked.

### D-24 Rate caps

Starts 30, spawns 40, merges 10 and wakes 20 per rolling hour, plus 6 actions of one kind on one
issue. The busiest hours on dev-system in the week to 2026-10-12 had 14 claims (a burst of
tracker re-claims after a lapse), 7 delegations, 7 adjudicated runs, 4 review fix rounds and 4
merges, so the caps sit about twice above real peaks. The per-issue cap catches the likeliest plan
bug, a key that keeps changing for the same subject, long before the global caps would.

### D-27 Stuck rules show in the title only

`callum-flow-factory-state`'s S1 to S5 flags add `stuck <n>` to the title but send no notice. The
skill does not use them, and notices for them would be new behaviour.

### D-30 The flaky heartbeat-loop test is fixed in its own PR

`images/base/test/heartbeat-loop.test.sh` failed two full `npm test` runs out of six on this
branch. The cause was in the test: it scanned `/proc` with one `mawk` call, which stops at the
first file a finished process left behind, so under load it missed the loop's sleep and then
compared against an empty pid. The fix is its own PR
([#524](https://github.com/cbundy/dev-system/pull/524), closing
[#523](https://github.com/cbundy/dev-system/issues/523)), cherry-picked here so this branch's
gates are honest. It drops out of this diff once #524 merges.

### D-32 The shadow run cannot judge claims

The spike workspace has no `gh` login, so its loop runs with GitHub off and rule `D1` sees no
labels or blockers. It then claims nothing, which can neither agree nor disagree with the live
orchestrator. The replay harness (phase 2) approximates GitHub from the event log's `ready`
events to compare claims.
