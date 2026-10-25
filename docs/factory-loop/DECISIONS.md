# Factory loop: the standing decisions

The decisions behind the loop, kept by number so that cites in the code, the skill and the v2
spec resolve. Each entry says what holds as built, with the alternatives considered and why. The
ones marked **owner call** were the owner's. The build decisions of the v2 loop itself are in
[v2 SPEC section 15](v2/SPEC.md#15-decisions), unnumbered.

### D-01 Work documents live in `docs/factory-loop/`

The brief names the files but not where they go. Keeping them out of `plugins/factory-loop/`
keeps them out of the shipped plugin.

### D-03 Plan does not know the mode

- **Decision**: `plan` computes the same actions in observe and act mode; only the driver decides
  whether to execute them (v2 SPEC 13.2).
- **Alternatives**: plan only what the mode allows.
- **Why**: observe mode then shows exactly what act mode would do, which is the point of the
  shadow run.

### D-04 The model answers with a text block, the tool as an alternative

- **Decision**: when the loop wakes the model with a `TELL` line or the release `TASK`, the model answers by
  ending its reply with a short block the loop reads: `ANSWER <id> <decision>`, then optional
  `key: value` lines such as `reason:`. Calling the `mcp__factory-loop__answer` tool works too,
  but nothing depends on it (v2 SPEC 13.8.2).
- **What it means for you**: every answer the model gives the loop is plain text in the
  conversation, so you see it in the transcript and on your phone, and nothing is hidden. A
  missing or malformed answer gets one reminder, then the wake's safe fallback, which is always a
  hold and never a guess.
- **Alternatives**: the tool only, as first planned.
- **Why**: the wake probe showed both channels work, but a turn that starts while the mod reloads
  (during a deploy, for example) does not see the tool, and the text block costs the fewest
  tokens. The first plan, tool first, changed on that evidence.
- **Note** (2026-10-14): the loop's agents answer through a checked script (D-74); wakes keep
  the text block as primary.

### D-05 The review step reviews each merge's whole diff; merges are free (owner call)

- **Decision**: before each merge the review step reads the PR's whole diff against the brief. It
  checks that every acceptance criterion and owner requirement holds, that nothing unrelated is
  added, that no test is weakened, that the PR body links the issue the right way, and that a
  visual change has UI evidence. Merges are `free` in the usage tiers, and the model sequences no
  releases: the release task takes the rollout follow-ups (v2 SPEC 8, 11).
- **Alternatives**: (a) the main model reads the fix commits; (b) skip the review when the
  pipeline added no fix commits.
- **Why**: owner, 2026-10-13. The main model has read no more than a reviewer would, so it brings
  no extra judgment, and reading code would bloat its context and slow it down. Every merge is
  reviewed, so the whole diff is checked once, at the end. Its answer is logged as a `loop`
  event (D-09).
- **Owner (2026-10-13)**: a review on every merge is OK for now.

### D-06 Usage comes from `usage-check.sh` every 5 minutes plus the session's own figures

- **Decision**: v2 SPEC 13.3.3, `usage` source.
- **Alternatives**: `$.session.usage()` only, which is free.
- **Why**: the session's figures come from its own last API response. An idle loop makes no API
  calls, while the other orchestrators keep spending the same plan, so those figures go stale and
  under-report. `usage-check.sh` asks the usage endpoint and is token-free, and every 5 minutes is
  close to today's rate of `usage` events (380 in 7 days).

### D-07 Slow means one claim per pass and a 10-minute gap (owner call)

- **Decision**: in Slow, at most one claim per pass and none within `slowGapMs` (10 minutes) of
  the last claim (v2 SPEC 13.5.2). Merges are `free`, so they never hold a claim.
- **Alternatives**: one per pass with no gap; one in flight at a time; a shorter gap.
- **Why**: the loop passes every 60 seconds, so "one per pass" alone would dispatch up to 60 an
  hour and defeat the tier. Only the claim counts as the new dispatch: the designer and builder
  for a claimed issue follow without waiting for the gap. The gap is one number in config.
- **Owner (2026-10-13)**: no preference, so the conservative 10 minutes stands.

### D-08 Stop new also holds the designer and implementer of an already-claimed issue

- **Decision**: they are the `develop` class, blocked in Stop new and Stop all (v2 SPEC 13.5.2).
- **Alternatives**: treat them as in-flight work, which Stop new lets continue.
- **Why**: the conservative reading of "start no sub-agent for new work", and it matches what the
  live orchestrator did at 94% on 2026-10-12 ("#489 implementer held", MEM 18:55).

### D-09 One new event state, `loop`, for the loop's own transitions (owner call)

- **Decision**: `callum-flow-event` gains one state, `loop`, with `kind=... key=... status=...`
  in its note. The loop logs it for agent starts and ends, wakes and their answers (with the
  wake's cause), owner notices and rate-cap holds. CLI work already logs its own events and gets
  no `loop` event. The ledger still lives in `$.store`, and a lost store is rebuilt exactly from
  these events (v2 SPEC 13.7.4, 13.7.5).
- **Alternatives**: no new state; the loop logs only what the model logs by hand today (the
  first decision). A lost store then costs harmless repeats.
- **Why**: owner, 2026-10-13. Someone watching or debugging the factory must see when an
  adjudicator started, and when and why the model was woken, without the loop's local files. The
  state gives start-to-answer timings, a trail of when and why the model was involved, and an
  exact rebuild after a lost store. It only adds to the vocabulary; each reader of the event log
  (`callum-flow-factory-state`, metrics, the evaluate tool) is checked to ignore it, or use it,
  when the state ships.

### D-10 Observe mode sends side-effect events to a sink

- **Decision**: every command run in observe mode gets `CALLUM_EVENTS_DIR=<loop dir>/sink-events`
  (v2 SPEC 13.11.1).
- **Alternatives**: skip the CLIs that log, or add a no-log flag to each.
- **Why**: `usage-check.sh`, the `--once` modes and `callum-flow-issue-read` all log as a side
  effect. One environment variable keeps all of them out of the live event log without touching
  their code, and the sink file is itself evidence of what the shadow run read.

### D-11 The issue goes in the agent's description and name, not in OTEL attributes

Skill step 3 spawns the implementer with `OTEL_RESOURCE_ATTRIBUTES=issue=<N>,device=...`.
`agent.spawn` has no environment field (checked in the 2.1.296 declarations), so the loop cannot
set it per agent. The issue number goes in the spawn's `description` and `name` instead. If
per-issue telemetry matters, that needs an engine feature or a wrapper agent.

### D-12 Every conflict gets a fixer

- **Decision**: a merge conflict spawns a fixer (T9 in the v2 transition table).
- **Alternatives**: tell trivial from non-trivial conflicts and rebase trivial ones in code.
- **Why**: the skill says "spawn a fixer for a non-trivial conflict", but telling the two apart
  is judgment, and a wrong "trivial" rebase can drop one side of colliding additions. A fixer
  handles easy conflicts as well.

### D-14 The designer answers through the script; the loop posts the brief

- **Decision**: the designer answers through the checked answer script (D-74). The loop posts the
  brief on the issue and creates any sub-issues; the designer does neither (v2 SPEC 8.7).
- **Alternatives**: the designer posts the brief itself and ends with a `RESULT` line; parsing the
  designer's prose.
- **Why**: owner, 2026-10-13: optimise for the end state. An output contract belongs to the agent
  that produces it, and a checked answer cannot be misread. Posting is a GitHub write, which the
  loop owns. A missing or invalid answer is never guessed.

### D-15 The loop restarts its own workspace for an update

- **Decision**: when an update is due, rule R2 writes a `restart-self` wind-down request and
  runs `dev-restart-self`, and the loop resumes by itself after the restart (v2 SPEC 14.1). The
  wind-down is capped at `windDownMinutes`, so queue actions and the release task finish within the
  cap; only with `windDownMinutes` 0 does R2 wait for them to finish first. There is no
  uncapped drain. The reconciler says an update is due through
  control state (`updateDue`): it owns which versions are wanted, and the loop owns when it is
  safe to switch. Whenever the owner wants one, `/factory update` sets it by hand
  (owner, 2026-10-13). A failed restart is not retried, since a retry cannot fix a missing token: it ends
  the update (`updateDue` cleared, `updateFailed` set) and the owner is told until `/factory update <reason>`
  or `/factory update off` clears the notice (#1346).
- **Alternatives**: restarting stays a model or owner action; the reconciler filing an issue for
  the orchestrator to update itself.
- **Why**: owner, 2026-10-13: the safe moment can be computed, so waiting for a person is
  needless. Agent steps survive a restart through the ledger, and the capped wind-down gives a
  queue action or the release task, which a restart would cut off, time to finish (owner, 2026-10-17).

### D-16 Owner directives become control state

The pause, drain, wind-down, priority, "only these" and skip instructions the memory file holds as free text
(I-90) become typed control state, set through the control tool or `/factory` (v2 SPEC 13.4.3). The model
still keeps the memory file for lessons and context.

### D-17 Trackers are never claimed; parked issues are skipped by label

- **Decision**: an issue with sub-issues (`sub_issues_summary.total > 0`), or whose title matches
  `trackerTitle` (default `Epic` or `Tracker` first, as in #340 "Epic: deterministic current
  state of the factory", which has no linked sub-issues), is never a candidate. Labels in the repo-local `skipLabels` (for example `parked`) also exclude an issue
- **Alternatives**: leave both to owner `skip` directives.
- **Why**: "trackers are never claimed" is a standing owner rule (MEM 2026-10-12, follow-up #471)
  that holds in every repo. The `parked` label is this owner's convention, so it is repo
  configuration, not plugin code.

### D-19 `blocked_by` comes from the issue's dependency summary

- **Decision**: `issue_dependencies_summary.blocked_by` (open blockers) from
  `callum-flow-issue-read --json <N>` (v2 SPEC 13.3.1).
- **Alternatives**: a new `--blocked-by` mode on the reader, or a field in
  `callum-flow-factory-state`.
- **Why**: GitHub already returns the count on the issue object through the sanctioned reader
  (checked on 2026-10-12: #470 shows 1). No CLI change is needed.

### D-22 Each agent type has its own memory file

Each agent type (builder, fixer, reviewer, triage and designer-v2) has its own memory file in the
consumer repo, `.claude/agent-memory/<type>.md`. Each spawn prompt points only at its own type's
file, and `.claude/orchestrator-memory.md` stays the model's. The model adds each new lesson to the
file of the type it is for. Owner, 2026-10-13: separate files keep one agent from being confused
by another's lessons.

### D-23 The title shows counts, not usage

Owner, 2026-10-13: usage does not belong in the title. It reads `🔄 dev-system (Q:3 - D:5 - M:9)`:
`Q` issues in the queue, `D` in progress (counted by v2 state), and `M` merged in the last 6
hours. A word is added only when something needs attention: `owner <n>`, `parked <n>`, `blind`,
`off`, `observe` (not acting), or a usage tier that holds work (`stop new`, `stop all`). It changes
only when a count changes, so the `/rename` rows stay few.

### D-24 Rate caps

Starts 30, spawns 120 and wakes 20 per rolling hour, plus 6 actions of one kind on one issue.
There is no global cap on merges (owner, 2026-10-13): a PR merges only once, after a guard and a
review, so merges cannot run away. The busiest hours on dev-system in the week to 2026-10-12 had 14 claims (a burst of
tracker re-claims after a lapse), 7 delegations, 7 adjudicated runs, 4 review fix rounds and 4
merges, so the caps sit about twice above real peaks. The per-issue cap catches the likeliest plan
bug, a key that keeps changing for the same subject, long before the global caps would. The per-issue cap counts agent steps by step kind. A capped
action is visible in the pass that drops it: the decision log names it, the title adds
`capped <class>`, a `loop` event records it, and the owner is told once (owner, 2026-10-13).

The first testbed run (2026-10-13) hit the first spawn cap of 40 in 31 minutes: the loop claimed
ten issues within two passes and each issue uses four to five agents (designer, implementer, gate
and merge adjudicators, sometimes a fixer), so a full batch passes 40 within its first hour even
with nothing going wrong. The owner lowered the in-flight cap to 5 and raised spawns to 120, so
the spawn cap is runaway protection again rather than a limit on normal work.

### D-25 Owner notices wake the model (owner call)

- **Decision**: an owner action or decision is a `TELL` wake: the model writes one line in the
  conversation, which the phone shows, in the tick report's format. The title also counts open
  owner items (v2 SPEC 13.9).
- **Alternatives**: (a) the title only, which costs nothing but carries no detail (no links, no
  brief URL, no verdict lines); (b) push notifications from the mod.
- **Why**: the skill's tick report adds a line exactly for these cases (SKILL:173-174), and the
  phone shows only the conversation, the title and push notifications (FINDINGS section 1).
  Notices are rare and important, so a short turn each is worth it. Push notifications were not
  tested from a mod.
- **Owner (2026-10-13)**: fine for now.

### D-26 One wake at a time

- **Decision**: at most one `JUDGE`, `TASK` or `TELL` open at once (v2 SPEC 13.5.8, rule O2).
- **Alternatives**: several queued prompts.
- **Why**: the model answers one prompt per turn, and queued prompts would arrive while it is
  still answering the first. One at a time keeps each answer tied to its line.

### D-27 Stuck rules show in the title only

`callum-flow-factory-state`'s S1 to S5 flags add `stuck <n>` to the title but send no notice. The
skill does not use them, and notices for them would be new behaviour.

### D-28 Act mode needs the orchestrator role and no old watcher (owner call)

- **Decision**: act mode also needs `DEV_ROLE=orchestrator` and refuses while an
  `orchestrator-watch.sh` lock for the repo is live (v2 SPEC 13.11.2).
- **Heartbeat guard** (owner, 2026-10-13): act mode also waits while another device with role
  `orchestrator` and the same repo has a heartbeat in `factory.workers` from the last 120
  seconds. The check runs at the start of every pass, before any action, tells the owner once,
  and lets the loop act after 120 seconds of quiet. It covers two workspaces on one repo, which
  the per-workspace act lock cannot see. A heartbeat means the workspace is up, not that it is
  driving, so an idle old orchestrator blocks the loop too: the safe side during cutover.
- **Amendment, own workspace (2026-10-22, cbundy/dev-system#1051)**: a beat whose `coder_workspace`
  is non-empty and equals this loop's `DEV_CODER_WORKSPACE` is never another orchestrator, even
  under another device name (a test once wrote a `box` row from a loop's own workspace). It is left
  out of the block and logged as `railTwins` on the pass line. Every other beat blocks as before,
  and so do a failed query, unexpected output and a device with no name. heartbeat-loop also names
  its device from `DEV_MACHINE_NAME` first, so a snapshot cannot rename the row.
- **Alternatives**: rely on the mode option alone.
- **Why**: two drivers on one repo would double every action. The old watcher's lock is the
  clearest sign that the released skill is still driving. The role check stops a desktop session
  with the plugin installed from acting by accident. The repo-local
  `allowActOutsideOrchestrator` lifts it for a testbed.

  Retired by D-77: the released orchestrator skill and its watcher are gone, so only the role check
  and the heartbeat guard against another loop remain relevant.

### D-29 Rollout follow-ups for every merge, hand merges too

- **Decision**: the follow-ups act on every merged PR whose issue this device held, whether the
  loop merged it or the owner did by hand. A hand merge is found from the factory state: the sweep
  logs it (`merged`, actor `sweep`). It gets the same follow-ups as a loop merge: the issue closed
  when its rollout says so, and its milestone placement. A `run-it` rollout joins the release
  task, which absorbs it (v2 SPEC 11).
- **Alternatives**: act only on the loop's own merges.
- **Why**: the owner sometimes merges a PR the loop brought to merge-ready but could not merge
  itself (owner, 2026-10-13). Leaving those out would lose their rollout and drop them from
  release planning. GitHub, through the mirror and the sweep, says what merged, so no local merge
  log is needed.

### D-31 The judge skill is a new skill in the new plugin

- **Decision**: `plugins/factory-loop/skills/judge/SKILL.md`, a draft written in phase 3. The
  released `issue-orchestrator` skill is not touched.
  Retired by D-77: the `issue-orchestrator` skill no longer exists.
- **Why**: the brief forbids changing the released skill. A separate skill can be reviewed and
  shipped on its own.

### D-33 Runtime settings and owner directives are plain JSON files

`${CLAUDE_CONFIG_DIR}/factory-loop/config.json` holds the workspace's mode, repo, shadow device
and run source, and `<loop dir>/control.json` holds the owner directives (v2 SPEC 13.4.1, 13.4.3). The
plugin options stay as defaults. The first plan put control state in `$.store`; files are easier
to inspect and set from a shell (the shadow run is configured that way), they survive restarts on
`/persist` just as well, and the `/factory` command and the control tool write the same file.

### D-34 A shadow run does not heartbeat on its own restarts

Rule `H1` heartbeats on the first pass after a load (I-93). A shadow watches another session, so
its own load says nothing about when that session restarted. While shadowing, the load time
counts as unknown, and only real lease timing drives heartbeats. The driver test caught this.

### D-35 "Only these issues" is its own directive

- **Decision**: control state gains `only` (v2 SPEC 13.4.3): when it is non-empty, the claim rule claims
  only those issues, in that order, and leaves work in flight alone. A tracker or epic in the
  list stands for its open sub-issues, nested ones included, in ascending order; they come from
  the tracker's timeline (`sub_issue_added` and `sub_issue_removed`), which
  `callum-flow-issue-read --timeline` already returns (owner, 2026-10-13). `noNewWork` still
  wins.
- **Alternatives**: (a) let `priority` issues pass `noNewWork`, so "no new work" plus a priority
  means "only these"; (b) express it with `skip` on every other issue.
- **Why**: on 2026-10-13 the owner told the live orchestrator "522 only". Mirrored as no new work
  plus a priority, the shadow would have claimed nothing, #522 included (#522).
  Option (a) matches how the owner used a priority in the 2026-10-12 drain, but makes a wind-down
  claim whatever an old priority list still names. Option (b) misses issues labelled later. An
  explicit list says what the owner said.

### D-36 A claim counts as its own lease's renewal

- **Decision**: the heartbeat rule takes each held issue's last renewal as the later of its claim and the
  last heartbeat, and renews when the stalest is 20 minutes old (or older than the last load).
- **Alternatives**: the first rule, which counted heartbeats only.
- **Why**: after an idle spell the first rule heartbeated on the pass after every claim, a
  minute into a fresh two-hour lease. The shadow did that on #522, where the live orchestrator
  did not. With the change, the evening replay's six live renewals each fall within 30 seconds of
  the loop's.

### D-38 The owner clears an issue's exhausted actions

- **Decision**: `/factory retry <N>` (and the control tool) clears the issue's exhausted effects,
  which hold a record as `stalled` (v2 SPEC 4.5), so its rules can try again. Steps that ran out
  go through triage and parking instead (v2 SPEC 13.4.3, 13.7.1).
- **Alternatives**: wait for the seven-day prune, or for the subject's key to change.
- **Why**: owner, 2026-10-13. An entry blocks only its own key, but a key that never changes
  would otherwise stay held for a week.

### D-39 A ping storm falls back to the timer

- **Decision**: passes start at least 5 seconds apart, and if pings drive more than 30 passes in
  10 minutes the loop ignores pings for 10 minutes, runs on its 60-second timer alone, logs a
  `loop` event and tells the owner once (v2 SPEC 13.2, 13.11.4).
- **Alternatives**: no limit beyond passes never overlapping.
- **Why**: owner, 2026-10-13: something that keeps waking the loop without being handled (a
  hook firing in a loop, an answer the parser rejects) would otherwise spin it. The timer keeps
  the factory moving while the owner looks.

### D-40 The ledger lives in memory, with one writer

- **Decision**: the module loads the ledger from the store once per load (and again when it
  takes over another session's expired lease), keeps it in memory, and saves it after every
  change: an action's running entry before its command, spawn or wake starts, and every
  transition before its `loop` event. It writes back only while the act lock names this session
  or still stands as it did at the load. The lease lasts at least 15 minutes, is renewed before
  every action and on a timer during a pass, and each write of it is a compare-and-set under
  `flock`. A store that cannot be read, or that refuses a save, starts nothing (v2 SPEC 13.7.1, 13.10 item 10,
  11.2).
- **Alternatives**: re-read the ledger from the store every pass; a lease renewed once a pass and
  written plainly; fall back to the event log when the store cannot be read.
- **Why**: hooks change the ledger between passes and during them (an answer arriving
  mid-pass), so a re-read would race with them. A once-a-pass lease could lapse inside a long
  merge and let a second session in, and two sessions that both read the lock free could both
  take it. Saving before acting means a restart at any point finds what already started.
  Falling back to the event log would overwrite the real ledger, holds included, at the next
  save.

### D-41 Act mode reads the queue through `--once` and rebuilds records from a week of events

- **Decision**: act mode reads the queue with `queue-watch.sh --once`, its `known` list kept in
  the store, so `ready` events keep arriving; observe mode keeps the plain reader, so a shadow
  logs none of its own. A lost store is rebuilt from 7 days of `transition` events (the facts
  window is 3), and the rebuilt ledger is kept and saved. A GitHub rate limit is remembered in the
  store for 15 minutes, and once an executor meets one, the rest of the pass's GitHub writes are
  skipped with no attempt counted (v2 SPEC 13.3.3, 13.7.5, 13.10 item 2).
- **Alternatives**: one reader in both modes; rebuild from the facts window; let each later
  write in the pass meet the limit itself.
- **Why**: a shadow must not log the events the live orchestrator also logs. A hold such as a
  pending decision can be older than three days, and the ledger keeps entries for seven. Each
  write after a limit only meets it again and spends an attempt.

### D-42 A testbed runs a checkout's own tools

- **Decision**: the workspace file takes `toolsDir` (where the watchers and `usage-check.sh`
  live; default the base image's `/usr/local/share/callum-tools`) and `binDir` (put ahead of
  `PATH`). A `toolsDir` also sets `CALLUM_FLOW_LINKAGE_BIN=<toolsDir>/check-pr-linkage.sh` for every
  command, so the merge guard's link check runs the checkout's script. Every command also gets the configured labels as `CALLUM_FLOW_READY_LABEL` and
  `CALLUM_FLOW_IN_DEV_LABEL` (v2 SPEC 13.4.1).
- **Alternatives**: wait for a base image release before any act-mode test; fixed image paths.
- **Why**: the `--once` modes and the `loop` state ship in the image, and no release carries
  them yet; pointing at a checkout's `features/src/callum-tools` and `images/base` lets the
  testbed start now. Without the label variables, `callum-flow-claim` and `callum-flow-sweep`
  would use their own defaults rather than the repo's settings.

### D-43 The safety rails fail safe

- **Decision**: act mode is also refused when the checkout's origin is not the configured repo.
  The old-watcher rail blocks on a lock directory with no readable pid or a probe that fails,
  waits 10 minutes after the lock goes before acting, and tells the owner once per spell (a new
  `old-watcher` notice). The heartbeat guard blocks on a failed query and on a device with no
  name, and counts a stopping device's heartbeat. A session the role check refuses tells
  nothing. The usage pre-check, by contrast, fails open. A pass a rail refuses plans exactly as
  observe mode does (v2 SPEC 13.10 item 7, 13.11.2).
- **Alternatives**: read a check that cannot run as "nothing there"; act as soon as the
  watcher's lock is gone; tell the owner from every session.
- **Why**: each rail guards against two drivers on one repo, where doubt should keep the loop in
  observe. The released skill's single-shot watcher drops its lock between turns, so one pass
  without it proves nothing. The checkout check closes a gap the lock cannot see: the CLIs act on
  the checkout's origin and the `gh` executors on the configured repo. A session the role check
  refuses can never act, so its notices would be noise. The pre-check fails open because plan's
  tier does (the skill: usage unavailable is Normal).

### D-44 Notices from outside plan wait for the open wake

- **Decision**: the rails' notices (`heartbeat-other`, `old-watcher`), the ping breaker's
  (`breaker kind=ping`) and three throwing passes (`pass-error`, new) go out through the wake
  executor, keyed by when their spell began, and only while no wake is open, outside plan's
  one-wake choice. Rail and breaker notices wait in the store, are dropped when their spell ends
  first, and go again if the engine dropped the prompt. `stopped` now says why (v2 SPEC 13.9.2).
- **Alternatives**: hand these notices to plan as state; send them whatever wake is open.
- **Why**: they come from the driver, not the factory's state, so plan never sees them, and one
  wake at a time (D-26) still holds. The owner needs to hear once why act mode is held back or
  failing, not every pass.

### D-45 The `--once` mode and the `loop` event, as built

- **Decision**: `queue-watch.sh --once` takes only its own options, exits 1 also when `gh` is
  missing, and logs no `watcher_error`. `callum-flow-event loop` refuses a note without `kind=`,
  `key=` and `status=`, `--if-changed` skips `loop` lines, and every event-log reader
  (factory-state, evaluate, heartbeat-state, the sweep) treats `loop` as bookkeeping. Loop notes
  leave out free text (v2 SPEC 13.3.4, 13.7.4).
- **Alternatives**: accept and ignore other options; log a `watcher_error` for each failure;
  let `loop` events count as activity.
- **Why**: a failed listing must never read as "no queue". The loop polls every minute and
  reports a failed source itself, so a broken tool would otherwise log an error event a minute.
  Without the reader changes, a `loop` event after a close looked like the issue's latest event
  and the sweep logged a second `closed`, and a bookkeeping line made a repeated watcher event
  look new. Free text is not needed for a rebuild and would overflow the note.

### D-46 The loop's files stay bounded

- **Decision**: once a day the loop deletes the spawn records, saved answers, recorded states,
  decision logs and `leftovers/` older than 7 days. Recorded states are written in observe mode
  only, at most 288 a day. The stored ledger keeps within 3 MiB by dropping the entries that ended
  longest ago, never a running one (v2 SPEC 13.7.1, 13.11.6).
- **Alternatives**: keep everything; a size limit on each file.
- **Why**: nothing reads past the ledger's own week, and the store refuses a whole save over its
  4 MiB limit, which would lose every change since the last one. The ledger cap is a valve, not a
  working limit. The observe-mode event sink, one append-only file, is not pruned yet: it needs
  trimming, not deleting by age.

### D-47 Retries and their counts

- **Decision**: heartbeat and sweep are never used up: they retry at their cadence, and three
  failures in a row tell the owner once. `pr-reopen`, `stop-agent` and `restart-self` get one
  attempt, `release-worktree` two, and each wake one (with its one reminder). A `lost` entry is
  retried at once. A step key is one attempt; the transition table retries steps (v2 SPEC 5.1).
  Exit 2 is a never-retried usage error only for the image's own CLIs (v2 SPEC 13.4.2, 13.6.1,
  13.10 item 1).
- **Alternatives**: one count for every CLI write; every exit 2 a usage error.
- **Why**: a heartbeat that ran out of attempts would stop renewing claims for a week, and
  another device would reclaim the work. The smaller counts are v2 SPEC 13.6.1's. A lost entry did
  not fail: its process died with the session. `gh` exits 2 when a command is cancelled and 1 on
  bad usage, so its exit 2 is worth another try.

### D-48 Executors keep their writes narrow

- **Decision**: every `gh` command carries `--repo`. The label, comment, PR, split, update-branch,
  run re-run and slot writes sit on the executor allowlist, one argv each. `abandon` removes the
  label before it logs `abandoned`; `release-parent` only logs `abandoned` (no label edit: the label
  was dropped in SPEC 3.6 and a repo without it failed every split, #1353). `release-worktree` gives
  `treehouse return` empty stdin, never `--force`, and is done only when the slot reads
  `available`. `milestone-expect` puts its reason on one line. `stop-agent` refuses any agent the
  ledger does not hold running (v2 SPEC 13.6.1).
- **Alternatives**: rely on `CALLUM_FLOW_REPO`, which `gh` does not read; log the event first;
  force the return.
- **Why**: a write can then reach only the configured repo. With the label off first, the event
  records a release that happened and a retry repeats only the label edit; logged first, a failed
  edit would leave the label on an issue the claim rule then skips. A slot that turned dirty after
  plan looked keeps its work. The milestone CLI refuses a reason with a line break.

### D-54 The agent list decides what still runs

- **Decision**: only a successful agent-list read marks agents lost or failed; nothing more is
  inferred. An agent first listed completed counts as running for that pass, and so does one
  whose answer is being handled. An agent that failed, timed out or was lost but is still listed
  at work blocks its step's retry, and a failed stop tells the owner. A turn that ends in
  `refusal` is a failed attempt, and a spawn that does not start within 60 seconds fails (v2 SPEC
  13.5.1, 13.7.5, 13.10 item 4).
- **Alternatives**: trust any list read; retry by attempts alone; infer an agent's state from its
  own status.
- **Why**: a failed read that returned nothing would mark every agent lost and spawn them all
  again, and an answer still on its way would be thrown away. A retry beside an agent a stop
  could not end puts two agents on one key.

### D-55 Wakes never spend an attempt the engine dropped

- **Decision**: a wake's submit gets 5 seconds; a prompt still waiting then counts as queued, so
  a busy session never holds a pass. A prompt refused or dropped within that time is skipped
  with no attempt counted, and a later drop marks the wake lost with its attempt given back.
  Every first line carries `repo=`. The one reminder repeats why an answer was refused, and an
  aborted or refused turn gets it too. A wake from an earlier session (another session id, or
  none recorded and started before this load) is lost at once with its attempt given back, so
  its rule decides again (v2 SPEC 13.7.5, 13.8.1, 13.8.2; #549).
- **Alternatives**: wait for the submit to resolve; count a dropped prompt as the wake's attempt.
- **Why**: a wake gets one attempt, so a prompt the model never saw must not use it up. Waiting
  on a busy session would stall every other action for as long as its turn runs. `repo=` saves a
  read for every link the model writes. A wake from a session that ended can never be answered,
  and would hold every other wake until its timeout, and a fallback would hold its rule (a
  judge's hold) for a question nobody was asked.

### D-56 Prompts rewrite closing keywords

- **Decision**: in a prompt's free text, a closing keyword before an issue reference becomes its
  `-ing` form ("Fixes #12" reads "Fixing #12") instead of being refused, and every id must have
  its shape. Spawns are named with their purpose and, from the second attempt, the attempt. Each
  spawn's prompt and each answer are kept in the loop dir. The handoff contracts are v2's
  (v2 SPEC 13.6.1, 13.6.3).
- **Alternatives**: refuse any text with the bare words.
- **Why**: a ban on the words would garble agent instructions ("Fix the timeout") and branch
  names. A name with its attempt never clashes with an agent still winding down. The kept prompts
  show the owner exactly what each agent was told.

### D-57 Plan details settled in code

- **Decision**: `at cap` shows only when the cap actually held a claim back; `blind` replaces the
  title's counts; a claim still running counts against every claim limit; an issue `only` names
  that is not in the queue is named in the skip reasons; trackers are followed three levels deep
  (v2 SPEC 13.5).
- **Alternatives**: `at cap` whenever live issues equal the cap; a claim counted only once done.
- **Why**: a cap reached with an empty queue is no news. Checking the plan properties on every
  plan call showed that planning again while a claim ran claimed again (v2 SPEC 13.5.9,
  property 2).

### D-58 Owner controls as built

- **Decision**: `priority off` and `override off` sit beside `only off` and `update off`; `help`
  lists the ops; dropping a dropped issue does nothing; `planner` is added, and `resume`, `drop`
  and `note` have the meanings v2 SPEC 13.4.3 gives them. Input has limits (an override up to 100%
  and 168 hours, a reason up to 300 characters, a note up to 2 000, and an all-digit run id
  needs `run:`), refused rather than cut. A control.json that does not parse is never
  overwritten. The control tool refuses every op but `status` from inside an agent. `retry`
  sets the exhausted entries' attempts to 0 rather than removing them, and clears the notices
  they raised (v2 SPEC 13.4.3, 13.7.1).
- **Alternatives**: the first op list alone; cut long input; remove retried entries.
- **Why**: nothing else could lift a priority or cancel an override. A second drop would plan a
  second abandon. A cut directive is a different directive. Directives the owner could still
  recover must not be lost to a write. The loop's agents act on their own issue only.

### D-59 The judge skill's own choices

- **Decision**: a TELL line opens with `[DECISION]`, `[ACTION]` or `[INFO]`; the release `TASK`
  is the one task left, and its answer carries a reason, `done` included; a wake name the skill
  does not list gets `hold` (a TELL is relayed as it stands).
- **Alternatives**: no tags; a reason only for `failed`; the TELL kinds in a second file.
- **Why**: the tag says at a glance on the phone whether the owner must act. A reason on every
  task answer leaves a trail of when and why the model was involved. Holding is the safe default.
  A second file would cost a read on every TELL.

### D-60 The claim-to-merge test runs beside the engine's test host

- **Decision**: `tests/act.test.ts` drives the real act-step functions (the dispatcher and
  `runActions`) with a recording fake; `tests/driver.test.ts` tests the driver's own wiring in the
  engine's test host, with agents seeded in the store. No test walks one issue from claim to merge
  in the host: the path is covered stage by stage in the module tests.
- **Alternatives**: one end-to-end test inside the host.
- **Why**: the host never returns an agent id from `$.agent.spawn` (probed: the subagent type
  arrives empty too), so a spawn there always fails. Only the testbed closes that gap (v2 SPEC 13.13).

### D-61 Only an interactive session runs the loop

- **Decision**: a session whose `session.start` says it is not interactive (a `-p` run, the
  SDK) never runs a pass or handles a hook (v2 SPEC 13.2).
- **Alternatives**: rely on the act lock alone, so extra copies only observe.
- **Why**: found on the testbed on 2026-10-13. The plugin loads in every Claude process that sees
  the workspace's plugin folders, so each review step the pipeline ran started its own loop.
  They stayed in observe only because the main session held the act lock; one could have taken
  it whenever that lease lapsed, and each ran the observe reads every minute for nothing.

### D-63 One writer per branch

- **Decision**: structural: a record runs one step at a time, and the write guard refuses a
  branch write from any agent but the step that holds the branch (v2 SPEC 10).
- **Alternatives**: rely on each action's own key, as the first build did.
- **Why**: found on the testbed on 2026-10-13: a guard-failure fixer and then a conflict fixer
  started on the same PR a pass apart. Two agents committing to one branch race each other and
  the pipeline.

### D-68 Agents answer through validated tools; one repair message before an attempt is spent

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #548): three tools
  (`mcp__factory-loop__verdict`, `mcp__factory-loop__design`, `mcp__factory-loop__handoff`),
  each schema its agent's contract, behind ToolSearch. The handler re-checks every field plus
  what a schema cannot, and names all problems at once. Fix ids must be judged `CORRECT` or `ENV`
  in the same call. An accepted call ends the entry at once. Text stays the fallback. One repair
  message per attempt via `$.session.send`, marked on the entry (`reminded`) before it goes out,
  before a failed attempt or `judge(report)`. The decision log records each answer's path
  (v2 SPEC 13.7.3a, 13.12).
- **Alternatives**: one tool with a union schema; holding a tool answer until `turn.complete`;
  retrying with a fresh agent (the old way); several repairs.
- **Why**: run 2 refused four sound approvals of one gate over a line of prose, and each refusal
  spent an attempt on a fresh adjudicator. A per-agent schema says exactly what each answer
  needs, and the API takes no `anyOf` at a tool schema's top level. Finishing at the call removes
  any wait on text. The same agent already holds its judgement, so one message costs a fraction
  of a new agent. One repair bounds a model that cannot comply.
- **Note** (2026-10-14): three changes after review. A handoff that says gated with no run is
  refused in both channels, the tool and the `RESULT` line. A repair reply is appended to the
  saved answer, under a separator, never written over it. A fix refuses `missed-` ids in its
  findings: a gap the reviewer missed goes in `addFinding` (v2 SPEC 13.6.3, 13.7.3a).

### D-69 Trace mode: one switch in two files, a size cap, and skip ages kept in memory

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #552; the per-repo switch and
  the 100 MiB cap are the owner's): trace mode is the setting `trace`, in the repo's
  `.claude/factory-loop.json` and in the workspace file, which wins. `/factory trace on|off`
  writes the workspace file, as `/factory mode` does. The trace files share one cap,
  `traceMaxBytes` (100 MiB): the oldest files go first, and today's is cut short with a closing
  line. Times inside a pass come from `performance.now()`. The decision log's `trigger` and `ms`
  are always written. A skip's age is kept in the module's memory from pass to pass, by issue and
  rule (v2 SPEC 13.12, 13.12.1).
- **Alternatives**: `/factory trace` writes the repo's file; `control.json`; `$.clock.now()` for
  every timing; a skip's age keyed by its exact words; per-file caps, or deleting by age alone.
- **Why**: the owner asked for it per repo in the config, and switchable mid-run. The repo's file
  is checked in, so writing it would dirty the consumer's checkout, which nothing may do
  (v2 SPEC 13.11.6). `control.json` holds owner directives that plan obeys, and trace is not one. The
  workspace file is read every pass, so a write applies at the next one without a reload, and a
  repo can still turn it on. Each `$.clock.now()` reading is an engine call, and plan's few
  milliseconds would read as 0 or 1. A countdown in a skip's words changes every pass, so an age
  keyed by the words would never grow; keyed by issue and rule, run 2's 30-minute guard wait
  shows as a growing number. The 100 MiB is the owner's.

### D-70 The loop owns its agent definitions

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #548): the
  loop owns the definitions of the agents it spawns, in `plugins/factory-loop/agents/`:
  designer-v2, builder, fixer, reviewer and triage, each answering through the answer script.
  A companion plugin carries what the loop's agents need from the engine. A root test
  (`tests/factory-loop-agents.test.js`) keeps the definitions and the hooks in step, and
  `agent.offer` hides the definitions from the model (v2 SPEC 13.6.1).
- **Alternatives**: edit the callum-flow definitions, which changes the released orchestrator's
  agents; register the released plugin's agents at load, but no engine API finds another
  plugin's files; answer in text only.
- **Why**: the engine refuses any call outside an agent's allowlist, so an agent's definition
  must list the tools it uses, and the loop must not change the released orchestrator's agents.
  A definition kept in step by a test cannot drift unnoticed.

### D-72 An issue closed on GitHub is finished, and its state is read before the queue

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #556): a
  close on GitHub is the `issue-closed` event (v2 SPEC 4). Each pass's GitHub reads start with
  the issues the loop may act on or counts as live, and the queue comes after them. An issue known
  closed is not read again unless the queue names it or this device holds it. A failed read keeps
  the last value, and an issue whose state is not known is driven as before, except that no agent
  starts on it while GitHub fails (a backoff, a failed read). A closed issue is finished: it is
  not live, not in the title's `D` or `stuck`, not under the in-flight cap, and has no heartbeat.
  Its agents are stopped and its clean slots returned (v2 SPEC 13.3.3, 13.5.1, 13.13).
- **Alternatives**: (a) hold every action on an issue whose state is not known, which would hold
  a new device's whole first pass; (b) re-read every closed issue on a slow cadence, to notice a
  reopen; (c) `callum-flow-factory-state --github on`, which reads GitHub every pass outside the
  loop's budget and backoff.
- **Why**: on run 3's first pass, twelve queue reads took the whole budget, so the closed issues
  were never read before plan drove them. Reading them first only delays the queue's reads, by a
  pass when the budget is short, and an unread queue issue is never claimed. A closed issue soon
  ends in the factory too (the sweep logs it closed), so a reopened one comes back through the
  queue and a new claim; until then one this device holds is still read, or a reopen would leave
  it held but not driven, with no heartbeat for its lease. While GitHub fails, an unread state is
  as likely closed as not (a reload empties the cache), so no agent starts; agents are what cost
  the most.

### D-74 Agents answer through a checked script until a timer-spawned agent reaches the loop's tools

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #561): a temporary workaround
  for the answer tools of D-68, which no agent the loop spawns can reach. The plugin ships
  `bin/factory-answer`; each prompt names it by its absolute path under `$.plugin.root` and an
  answer file unique to the ledger entry and attempt (`answers/<key>.a<attempt>.<started ms>.answer.json`),
  and asks the agent to run it once with its answer as JSON. The script checks the JSON against
  the same contract the tools use, names every problem (exit 1; usage exit 2), and on success
  writes the file atomically. It writes only where the loop issued a path: beside the job file
  the loop writes before the spawn, in the loop's own `answers/` directory, every directory on
  the way a real one. At the agent's `turn.complete` the loop reads that one path, checks the
  answer again against its own ledger, and records it with `answer: "script"` in the decision
  log; with no valid file it reads the text, then sends the repair message, which asks for the
  script again. The contract is one plain-JS module, `hooks/contract.mjs`, imported by the
  TypeScript hooks and by the script under plain node, with its types in `contract.d.mts`; a
  shared table of cases holds the loop and the script, run for real, to the same problems. The
  setting `answerChannel` (`script`, the default; `tool`; `text`). Prompts never say why the script stands in. It goes
  back to `tool` once the timer-spawn probe (v2 SPEC 13.13) passes (v2 SPEC 13.4.2, 13.6.3, 13.7.3a, 13.11.6, 13.12, 13.13).
- **Alternatives**: (a) stay on text with the repair message, as #560 left it; (b) write the
  contract in TypeScript and run the script with node's type stripping; (c) a JSON schema plus a
  small validator; (d) pass the purpose, repo and issue as flags on the script's command line;
  (e) read whatever answer file the agent wrote, or the newest; (f) an alias of an older
  setting.
- **Why**: unreadable text answers were the most frequent failure in all three testbed runs, and
  built-in tools work for timer-spawned agents, so a script the agent runs gives back what the
  tool was for: a structured answer, checked while the agent can still correct it. (b) needs
  Node 22.6 with a flag or 23.6 by default, and the hooks' extensionless imports need a loader
  under plain node; the engine loads an `.mjs` a hook imports and `claude plugin validate`
  accepts it, so one plain module serves both with no build step. (c) cannot hold the rules that
  are code: a fix names only findings judged `CORRECT` or `ENV`, a brief is on the designed
  issue, gated needs a run. With one module the checking cannot drift; the case table catches
  drift in what is around it. (d) gives agents a longer command to get right, and the script could
  not tell a path the loop issued; with the job file, `--to` is the only argument and any other
  path is refused. (e) would let a stale file or another agent's answer stand in: the path is
  who answered. Text stays every
  prompt's fallback, so an agent whose script call is refused still answers.

### D-75 The loop stays in observe while the startup schema migrate has failed

- **Decision** (the agent's choice, 2026-10-19; #888): `dev-init` migrates the factory database
  with `factory-db-migrate` before the loop starts and records the outcome in a status file. A new
  rail (`hooks/rail-schema.ts`, after the heartbeat guard, before the act lock) reads it. A missing
  file, `migrated` and `current` pass; `failed`, `timed-out`, a `running` record older than 10
  minutes and a file that cannot be parsed keep the loop in observe, and all but a young `running`
  tell the owner once per startup as `TELL schema-behind to=<v> error=<e>` under
  `tell:schema-behind:<at>` (v2 SPEC 13.9.2, 13.11.2).
- **Alternatives**: (a) fail `dev-init`; (b) let the loop act and fail on the first write the schema
  lacks; (c) have the loop run the migrate itself; (d) pass on a missing file only when no
  migrator secret exists, checking the secret from the rail.
- **Why**: a loop acting on an old schema writes events and reads views that are not there. (a)
  would keep the workspace from starting for a database fault, and `dev-init` is best effort by
  design. (b) leaves partial work. (c) gives a loop session the migrator secret. (d) makes the rail
  read a secret folder; a missing status file already means nothing ran here.

### D-76 An empty ready list is checked against the members' own reads

- **Decision**: `observe` does not accept an empty ready list (act mode's `queue-watch.sh --once`
  or observe mode's `--list`) when the last accepted list was not empty and a member of it is, by
  its own cached per-issue read, open, trusted and labelled `readyLabel`. The source is marked
  failed, naming those issues; the last list stands and the stored `--known` is kept. An empty
  list no member contradicts is accepted (v2 SPEC 13.3.3, 13.3.4).
- **Alternatives**: debounce an empty read for N passes.
- **Why**: GitHub's label listing returned `[]` with status 200 for runs of up to 4 reads (8
  minutes) while the issues carried the label, which flipped the title Q:8 -> Q:0 -> Q:8, fed
  rule S1 an empty queue and re-logged `ready` events. A debounce long enough for those runs would
  delay every genuine emptying by as long. The per-issue reads are already cached, so a wrong
  guess delays emptying by at most one `githubEveryMs`.
- **Same change**: a cadenced key (heartbeat, sweep) that used up its attempts stays exhausted
  while its next attempt runs, so its `tell:stalled` owner item does not drop out of the title's
  count for the length of the retry.

### D-77 The skills-based orchestrator is retired (owner call)

- **Decision**: the `issue-orchestrator` and `implement-issue` skills, the five `callum-flow`
  agents (designer, explorer, implementer, fixer, adjudicator) and the `orchestrator` Coder
  template are removed. The factory loop is the only orchestrator. The manual path is a person
  working in a worktree, running the canonical commands and opening a plain PR that links its
  issue. `coder/push.sh orchestrator` is refused; `orchestrator-loop` stays (owner, 2026-10-24,
  cbundy/dev-system#1276, #667).
- **Alternatives**: keep the template for a person to start an interactive orchestrator.
- **Why**: the loop covers everything the skills did, and two orchestrators on one repo is the
  hazard D-28 guards against. The `.claude/orchestrator-memory.md` file name stays: it is the
  judge's memory. After the merge the owner deletes the live `orchestrator` template in Coder
  once no workspace uses it.
