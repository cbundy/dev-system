# Factory loop: decisions made without the owner

The brief says: do not stop to ask; take the conservative option, record it here with the
alternatives and why, and carry on. Each decision below is in force in [SPEC.md](SPEC.md) and the
code. The ones marked **owner call** are the ones most worth a look in the morning: the rest
follow directly from the skill or the brief.

## Owner calls

### D-05 The adjudicator reviews each merge; the model only sequences releases (owner call)

- **Decision**: before each merge the loop spawns the adjudicator with purpose `merge` (SPEC M4).
  It is seeded with ids and pointers only: the issue and brief URL, the PR, run and head, the
  implementer's handoff head, the guard output for that head and the run's verdict lines. It
  checks that the pipeline's fix commits after the handoff head keep every acceptance criterion
  and owner requirement in the brief, add nothing unrelated and weaken no test, that the PR body
  links the issue the right way, and that a visual change has UI evidence. It returns
  `ACTION merge`, `hold` or `fixer`, one line on what changes for users, the bump with a reason,
  and sequencing flags (base image or template touched, a restart needed, a `run-it` rollout).
  The loop merges on `merge` unless a sequencing rule holds it (SPEC M5); the model is woken only
  when a flag needs a release-sequencing call, with the report's lines, never the diff.
- **Alternatives**: (a) the first decision: the main model reads the fix commits
  (`JUDGE merge-review`); (b) skip the review when the pipeline added no fix commits.
- **Why**: owner, 2026-10-13. The main model has read no more than an adjudicator would, so it
  brings no extra judgment, and reading code would bloat its context and slow it down. What it
  does need is a high-level view of what is changing, to sequence releases. The review runs on
  every merge, because its summary, bump and flags feed release planning; with no pipeline fix
  commits it skips that check. Its answer is logged as a `loop` event (D-09).

### D-09 One new event state, `loop`, for the loop's own transitions (owner call)

- **Decision**: `callum-flow-event` gains one state, `loop`, with `kind=... key=... status=...`
  in its note. The loop logs it for agent starts and ends, wakes and their answers (with the
  wake's cause), owner notices and rate-cap holds. CLI work already logs its own events and gets
  no `loop` event. The ledger still lives in `$.store`, and a lost store is rebuilt exactly from
  these events (SPEC 7.4, 7.5).
- **Alternatives**: no new state; the loop logs only what the model logs by hand today (the
  first decision). A lost store then costs harmless repeats.
- **Why**: owner, 2026-10-13. Someone watching or debugging the factory must see when an
  adjudicator started, and when and why the model was woken, without the loop's local files. The
  state gives start-to-verdict timings, the re-drive trail D-13 asks for, and exact holds after a
  lost store (D-18). It only adds to the vocabulary; each reader of the event log
  (`callum-flow-factory-state`, metrics, the evaluate tool) is checked to ignore it, or use it,
  when the state ships.

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
- **Owner (2026-10-13)**: accepted for now, likely to be revisited. Every re-drive must leave a
  clear trail of when and why the model was involved, so that frequency and causes can justify
  another approach later (for example, resetting the issue to an earlier stage with extra
  instructions).

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
- **Owner (2026-10-13)**: fine for now.

### D-02 The plugin stays out of the marketplace until cutover (owner call)

- **Decision**: `plugins/factory-loop/` is built, validated and tested by `npm test`, but is not
  listed in `.claude-plugin/marketplace.json`. It loads only through `CLAUDE_CODE_PLUGIN_DIRS` or
  `--plugin-dir`.
- **Alternatives**: list it now as opt-in, like factory-hud.
- **Why**: the brief says do not ship. A listed plugin would reach every workspace with the next
  release. Listing it is cutover step 2 (SPEC 14).
- **Owner (2026-10-13)**: keep it out of the marketplace until the build is further along. When it
  goes to other containers for testing, it ships as a replacement for the released orchestrator,
  never alongside it.

### D-28 Act mode needs the orchestrator role and no old watcher (owner call)

- **Decision**: act mode also needs `DEV_ROLE=orchestrator` and refuses while an
  `orchestrator-watch.sh` lock for the repo is live (SPEC 11.2).
- **Heartbeat guard** (owner, 2026-10-13): act mode also waits while another device with role
  `orchestrator` and the same repo has a heartbeat in `factory.workers` from the last 120
  seconds. The check runs at the start of every pass, before any action, tells the owner once,
  and lets the loop act after 120 seconds of quiet. It covers two workspaces on one repo, which
  the per-workspace act lock cannot see. A heartbeat means the workspace is up, not that it is
  driving, so an idle old orchestrator blocks the loop too: the safe side during cutover.
- **Alternatives**: rely on the mode option alone.
- **Why**: two drivers on one repo would double every action. The old watcher's lock is the
  clearest sign that the released skill is still driving. The role check stops a desktop session
  with the plugin installed from acting by accident. The repo-local
  `allowActOutsideOrchestrator` lifts it for a testbed.

## Interpretations of the skill

### D-07 What "at most one new dispatch per tick" means in Slow (owner call)

- **Decision**: in Slow, at most one claim per pass, none within `slowGapMs` (10 minutes) of the
  last claim, and none in a pass that plans merge work (SPEC 5.2).
- **Alternatives**: one per pass with no gap; one in flight at a time; a shorter gap.
- **Why**: today a tick is a watcher event or an agent's end, every few minutes when busy. The
  loop passes every 60 seconds, so "one per pass" alone would dispatch up to 60 an hour and defeat
  the tier. "Prefer merging in-flight work" becomes "no claim in a pass that merges". Only the
  claim counts as the new dispatch: the designer and implementer for a claimed issue follow
  without waiting for the gap.
- **Replay evidence** ([REPLAY-REPORT.md](REPLAY-REPORT.md), window 1): in a Slow stretch the live
  orchestrator spaced claims 4 and 6 minutes apart, so a 10-minute gap would have delayed one
  claim (#498) by about 4 minutes. A 5-minute gap matches the live pace more closely. It is one
  number in config, and the conservative value stays until the owner picks.

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

- **Decision**: an issue with sub-issues (`sub_issues_summary.total > 0`), or whose title matches
  `trackerTitle` (default `Epic` or `Tracker` first, as in #340 "Epic: deterministic current
  state of the factory", which has no linked sub-issues), is never a candidate. Labels in the repo-local `skipLabels` (for example `parked`) also exclude an issue
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

### D-29 Rollout follow-ups for every merge of an issue the loop drove

- **Decision**: `M7` acts on every merged PR whose issue this device held, whether the loop merged
  it or the owner did by hand. A hand merge is found from the factory state: the sweep already
  logs it (`merged`, actor `sweep`), and the issue shows stage `merged` with no loop `merge`
  entry. It gets the same follow-ups as a loop merge: the issue closed when its rollout says so,
  its milestone placement, and `task(run-it)` for a run-it rollout. So it joins release planning
  like any other merge.
- **Alternatives**: act only on the loop's own merges (the first decision).
- **Why**: the owner sometimes merges a PR the loop brought to merge-ready but could not merge
  itself (owner, 2026-10-13). Leaving those out would lose their rollout and drop them from
  release planning. GitHub, through the mirror and the sweep, says what merged, so no local merge
  log is needed.

## Architecture

### D-03 Plan does not know the mode

- **Decision**: `plan` computes the same actions in observe and act mode; only the driver decides
  whether to execute them (SPEC 2).
- **Alternatives**: plan only what the mode allows.
- **Why**: observe mode then shows exactly what act mode would do, which is the point of the
  shadow run.

### D-04 The model answers with a text block, the tool as an alternative

- **Decision**: when the loop wakes the model with a `JUDGE` or `TASK` line, the model answers by
  ending its reply with a short block the loop reads: `ANSWER <id> <decision>`, then optional
  `key: value` lines such as `reason:`. Calling the `mcp__factory-loop__answer` tool works too,
  but nothing depends on it (SPEC 8.2).
- **What it means for you**: every answer the model gives the loop is plain text in the
  conversation, so you see it in the transcript and on your phone, and nothing is hidden. A
  missing or malformed answer gets one reminder, then the wake's safe fallback, which is always a
  hold and never a guess.
- **Alternatives**: the tool only, as first planned.
- **Why**: the wake probe showed both channels work, but a turn that starts while the mod reloads
  (during a deploy, for example) does not see the tool, and the text block costs the fewest
  tokens. The first plan, tool first, changed on that evidence.

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

### D-14 The designer's definition owns its `RESULT` line

- **Decision**: the designer's agent definition (`designer.md`) ends every return with one
  `RESULT brief=... created=... pending_decision=...` line (SPEC 7.2), as the adjudicator's
  definition already owns its verdict lines and `ACTION`. It ships with cutover step 1; until
  then the loop's prompt asks for the line as a fallback.
- **Alternatives**: the first decision, where only the loop's prompt asks for it; parsing the
  designer's prose.
- **Why**: owner, 2026-10-13: optimise for the end state, where the loop replaces the released
  orchestrator. An output contract belongs to the agent that produces it, not to each caller's
  prompt. Adding the line early is safe, since the released orchestrator ignores an extra last
  line. A missing line still goes to the model (`judge(report)`), never a guess.

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

### D-15 The loop restarts its own workspace for an update, once nothing is in flight

- **Decision**: when an update is due, the loop drains: it starts no new claims, agents or
  wakes. Once the safe state holds (no loop agent running, no wake open, no command in flight,
  every current pipeline run parked, merge-ready or done) it runs `dev-restart-self` and resumes
  by itself after the restart (SPEC H4). The reconciler says an update is due through control
  state (`updateDue`): it owns which versions are wanted, and the loop owns when it is safe to
  switch. A drain longer than an hour tells the owner.
- **Alternatives**: the first decision, where restarting stays a model or owner action (I-41);
  the reconciler filing an issue for the orchestrator to update itself.
- **Why**: owner, 2026-10-13: the safe moment can be computed, so waiting for a person is
  needless. Pipeline runs are the real risk: the 2026-10-12 restart crashed the no-mistakes
  daemon and failed three runs, so the drain waits for them too.

### D-16 Owner directives become control state

The pause, drain, wind-down, priority, "only these" and skip instructions the memory file holds as free text
(I-90) become typed control state, set through the control tool or `/factory` (SPEC 4.3). The model
still keeps the memory file for lessons and context.

### D-22 Agent prompts point at their own type's memory file

Each agent type has its own memory file in the consumer repo: `.claude/agent-memory/designer.md`,
`implementer.md`, `adjudicator.md` and `fixer.md`. Each spawn prompt points only at its own
type's file, and `.claude/orchestrator-memory.md` stays the model's. The agent lessons now in the
orchestrator's memory file (scratch directories, the PR appendix block) move to the
implementer's and fixer's files, and the model adds each new lesson to the file of the type it
is for. Owner, 2026-10-13: separate files keep one agent from being confused by another's
lessons.

### D-23 The title shows counts, not usage

Owner, 2026-10-13: usage does not belong in the title. It reads `🔄 dev-system (3 - 5 - 9)`:
issues in the queue, in progress (designing through ready to merge), and merged in the last 6
hours. A word is added only when something needs attention: `owner <n>`, `blind`, `off`,
`observe` (not acting), or a usage tier that holds work (`stop new`, `stop all`). It changes only
when a count changes, so the `/rename` rows stay few. The running observe build still shows the
first format until the act-half build.

### D-24 Rate caps

Starts 30, spawns 40 and wakes 20 per rolling hour, plus 6 actions of one kind on one issue.
There is no global cap on merges (owner, 2026-10-13): a PR merges only once, after a guard and a
review, so merges cannot run away. The busiest hours on dev-system in the week to 2026-10-12 had 14 claims (a burst of
tracker re-claims after a lapse), 7 delegations, 7 adjudicated runs, 4 review fix rounds and 4
merges, so the caps sit about twice above real peaks. The per-issue cap catches the likeliest plan
bug, a key that keeps changing for the same subject, long before the global caps would. A capped
action is visible in the pass that drops it: the decision log names it, the title adds
`capped <class>`, a `loop` event records it, and the owner is told once (owner, 2026-10-13).

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

### D-32 The shadow run cannot judge claims (superseded)

Superseded at 22:32 UTC on 2026-10-12, when the owner approved a GitHub login for the spike
workspace: the shadow now reads labels, blockers and sub-issues live. The original note:

The spike workspace has no `gh` login, so its loop runs with GitHub off and rule `D1` sees no
labels or blockers. It then claims nothing, which can neither agree nor disagree with the live
orchestrator. The replay harness (phase 2) approximates GitHub from the event log's `ready`
events to compare claims.

### D-33 Runtime settings and owner directives are plain JSON files

`${CLAUDE_CONFIG_DIR}/factory-loop/config.json` holds the workspace's mode, repo, shadow device
and run source, and `<loop dir>/control.json` holds the owner directives (SPEC 4.1, 4.3). The
plugin options stay as defaults. The first plan put control state in `$.store`; files are easier
to inspect and set from a shell (the shadow run is configured that way), they survive restarts on
`/persist` just as well, and the `/factory` command and the control tool write the same file.

### D-34 A shadow run does not heartbeat on its own restarts

Rule `H1` heartbeats on the first pass after a load (I-93). A shadow watches another session, so
its own load says nothing about when that session restarted. While shadowing, the load time
counts as unknown, and only real lease timing drives heartbeats. The driver test caught this.

### D-35 "Only these issues" is its own directive

- **Decision**: control state gains `only` (SPEC 4.3): when it is non-empty, rule `D1` claims
  only those issues, in that order, and leaves work in flight alone. A tracker or epic in the
  list stands for its open sub-issues, nested ones included, in ascending order; they come from
  the tracker's timeline (`sub_issue_added` and `sub_issue_removed`), which
  `callum-flow-issue-read --timeline` already returns (owner, 2026-10-13). `noNewWork` still
  wins.
- **Alternatives**: (a) let `priority` issues pass `noNewWork`, so "no new work" plus a priority
  means "only these"; (b) express it with `skip` on every other issue.
- **Why**: on 2026-10-13 the owner told the live orchestrator "522 only". Mirrored as no new work
  plus a priority, the shadow would have claimed nothing, #522 included (SHADOW-REPORT, #522).
  Option (a) matches how the owner used a priority in the 2026-10-12 drain, but makes a wind-down
  claim whatever an old priority list still names. Option (b) misses issues labelled later. An
  explicit list says what the owner said.

### D-36 A claim counts as its own lease's renewal

- **Decision**: rule `H1` takes each held issue's last renewal as the later of its claim and the
  last heartbeat, and renews when the stalest is 20 minutes old (or older than the last load).
- **Alternatives**: the first rule, which counted heartbeats only.
- **Why**: after an idle spell the first rule heartbeated on the pass after every claim, a
  minute into a fresh two-hour lease. The shadow did that on #522, where the live orchestrator
  did not. With the change, the evening replay's six live renewals each fall within 30 seconds of
  the loop's.

### D-37 A stuck respond becomes a model task

- **Decision**: when a respond leaves its gate unmoved, is retried once and still has not moved,
  rule `P3a` gives `task(respond-stuck)`: the model reads the run's log and `daemon.log`, then
  re-drives the run or reports what it found (SPEC P3a).
- **Alternatives**: tell the owner (the first rule).
- **Why**: owner, 2026-10-13: a notice at 3 a.m. leaves the factory stuck until morning. The
  likely causes, a hung run or a crashed daemon, are what the re-drive task already handles.
