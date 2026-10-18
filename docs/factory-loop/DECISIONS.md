# Factory loop: decisions made without the owner

The brief says: do not stop to ask; take the conservative option, record it here with the
alternatives and why, and carry on. Each decision below is in force in [the v2 spec](v2/SPEC.md) and the
code. The ones marked **owner call** are the ones most worth a look in the morning: the rest
follow directly from the skill or the brief.

The owner reviewed D-01 to D-39 in stage B, and approved D-40 to D-74 (the build decisions from
stage C, the testbed runs and release v0.1) on 2026-10-14. The review doc's Decisions tab has a
short summary of each under "Build decisions".

## Owner calls

### D-05 The adjudicator reviews each merge; the model only sequences releases (owner call)

- **Decision**: before each merge the loop spawns the adjudicator with purpose `merge` (the retired v1 merge rule M4).
  It is seeded with ids and pointers only: the issue and brief URL, the PR, run and head, the
  implementer's handoff head, the guard output for that head and the run's verdict lines. It
  checks that the pipeline's fix commits after the handoff head keep every acceptance criterion
  and owner requirement in the brief, add nothing unrelated and weaken no test, that the PR body
  links the issue the right way, and that a visual change has UI evidence. It returns
  `ACTION merge`, `hold` or `fixer`, one line on what changes for users, the bump with a reason,
  and sequencing flags (base image or template touched, a restart needed, a `run-it` rollout).
  The loop merges on `merge` unless a sequencing rule holds it (the retired v1 merge rule M5); the model is woken only
  when a flag needs a release-sequencing call, with the report's lines, never the diff.
- **Alternatives**: (a) the first decision: the main model reads the fix commits
  (`JUDGE merge-review`); (b) skip the review when the pipeline added no fix commits.
- **Why**: owner, 2026-10-13. The main model has read no more than an adjudicator would, so it
  brings no extra judgment, and reading code would bloat its context and slow it down. What it
  does need is a high-level view of what is changing, to sequence releases. The review runs on
  every merge, because its summary, bump and flags feed release planning; with no pipeline fix
  commits it skips that check. Its answer is logged as a `loop` event (D-09).
- **Owner (2026-10-13)**: an adjudicator on every merge is OK for now.

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
  state gives start-to-verdict timings, the re-drive trail D-13 asks for, and exact holds after a
  lost store (D-18). It only adds to the vocabulary; each reader of the event log
  (`callum-flow-factory-state`, metrics, the evaluate tool) is checked to ignore it, or use it,
  when the state ships.

### D-13 Re-drives stay model tasks (owner call)

- **Decision**: a `failed` run with id `unknown` (infrastructure) and a re-driven `cancelled` run
  become `TASK redrive` for the main model, which checks `daemon.log`, rebases, runs
  `callum-flow-regate` and starts a fresh `axi run`, as it does today (the retired v1 pipeline rules P4 and P5).
- **Alternatives**: (a) a fixer agent with fixed re-drive instructions; (b) a new
  `callum-flow-redrive` CLI.
- **Why**: the skill says "no fixer" for the infrastructure case, and both cases need reading
  `daemon.log` and composing the run's `--intent`, which is judgment. They are not rare: in the
  week to 2026-10-12 dev-system had 21 distinct cancelled runs and one run with id `unknown`. But
  18 of those 21 were history (their issue was superseded, merged or abandoned afterwards), and
  the loop acted only on an issue's current run (the retired v1 pipeline section), so about one wake every two days
  remains. A CLI is the better long-term home once the steps are stable.
- **Owner (2026-10-13)**: accepted for now, likely to be revisited. Every re-drive must leave a
  clear trail of when and why the model was involved, so that frequency and causes can justify
  another approach later (for example, resetting the issue to an earlier stage with extra
  instructions).

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

### D-02 The plugin stays out of the marketplace until cutover (owner call)

- **Decision**: `plugins/factory-loop/` is built, validated and tested by `npm test`, but is not
  listed in `.claude-plugin/marketplace.json`. It loads only through `CLAUDE_CODE_PLUGIN_DIRS` or
  `--plugin-dir`.
- **Alternatives**: list it now as opt-in, like factory-hud.
- **Why**: the brief says do not ship. A listed plugin would reach every workspace with the next
  release. Listing it is cutover step 2 (v2 SPEC 17.5).
- **Owner (2026-10-13)**: keep it out of the marketplace until the build is further along. When it
  goes to other containers for testing, it ships as a replacement for the released orchestrator,
  never alongside it.

### D-28 Act mode needs the orchestrator role and no old watcher (owner call)

- **Decision**: act mode also needs `DEV_ROLE=orchestrator` and refuses while an
  `orchestrator-watch.sh` lock for the repo is live (v2 SPEC 13.11.2).
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

### D-64 A resumed environment escalation reruns the same head once (owner call)

- **Decision**: owner, 2026-10-13, #537 option B: a narrow `env-retry` executor reruns an
  environment escalation on the same head once per resume. Amended by [D-76](#d-76-a-resumed-escalation-sends-a-fixer-unless-it-is-all-env-with-no-note)
  for owner notes and other verdicts. The pipeline routing it belonged to is retired; v2's [transition table](v2/SPEC.md#43-the-table)
  replaces it, and the executor catalogue is [v2 SPEC 13.6.1](v2/SPEC.md#1361-catalogue).
  The agent's safety choices were approved by the owner on 2026-10-14.
- **Alternatives**: option A, the resume becomes a `task(redrive)` for the model.
- **Why**: on the testbed codex was logged out, so six runs failed at the test step. Every
  resume re-asked adjudicators about the stale failure, and only a hand rerun moved the runs.

## Interpretations of the skill

### D-07 What "at most one new dispatch per tick" means in Slow (owner call)

- **Decision**: in Slow, at most one claim per pass, none within `slowGapMs` (10 minutes) of the
  last claim, and none in a pass that plans merge work (v2 SPEC 13.5.2).
- **Alternatives**: one per pass with no gap; one in flight at a time; a shorter gap.
- **Why**: today a tick is a watcher event or an agent's end, every few minutes when busy. The
  loop passes every 60 seconds, so "one per pass" alone would dispatch up to 60 an hour and defeat
  the tier. "Prefer merging in-flight work" becomes "no claim in a pass that merges". Only the
  claim counts as the new dispatch: the designer and implementer for a claimed issue follow
  without waiting for the gap.
- **Replay evidence** ([REPLAY-REPORT.md](REPLAY-REPORT.md), window 1): in a Slow stretch the live
  orchestrator spaced claims 4 and 6 minutes apart, so a 10-minute gap would have delayed one
  claim (#498) by about 4 minutes. A 5-minute gap matches the live pace more closely. It is one
  number in config.
- **Owner (2026-10-13)**: no preference, so the conservative 10 minutes stands.

### D-08 Stop new also holds the designer and implementer of an already-claimed issue

- **Decision**: they are the `develop` class, blocked in Stop new and Stop all (v2 SPEC 13.5.2).
- **Alternatives**: treat them as in-flight work, which Stop new lets continue.
- **Why**: the conservative reading of "start no sub-agent for new work", and it matches what the
  live orchestrator did at 94% on 2026-10-12 ("#489 implementer held", MEM 18:55).

### D-12 Every conflict gets a fixer

- **Decision**: a guard `mergeable` conflict or a `conflict` run state spawns a fixer (the retired v1 merge rule M2).
- **Alternatives**: tell trivial from non-trivial conflicts and rebase trivial ones in code.
- **Why**: the skill says "spawn a fixer for a non-trivial conflict", but telling the two apart
  is judgment, and a wrong "trivial" rebase can drop one side of colliding additions. A fixer
  handles easy conflicts as well.

### D-17 Trackers are never claimed; parked issues are skipped by label

- **Decision**: an issue with sub-issues (`sub_issues_summary.total > 0`), or whose title matches
  `trackerTitle` (default `Epic` or `Tracker` first, as in #340 "Epic: deterministic current
  state of the factory", which has no linked sub-issues), is never a candidate. Labels in the repo-local `skipLabels` (for example `parked`) also exclude an issue
  (the retired v1 claim rule D1).
- **Alternatives**: leave both to owner `skip` directives.
- **Why**: "trackers are never claimed" is a standing owner rule (MEM 2026-10-12, follow-up #471)
  that holds in every repo. The `parked` label is this owner's convention, so it is repo
  configuration, not plugin code.

### D-18 Holds are derived, not stored

- **Decision**: a hold (a pending decision, an escalation, the review cap, a merge `hold`)
  is not a stored record. It is the plan finding that the fact still stands and the owner has not
  resumed that subject since. A new head, a closed issue or an owner `resume` ends it (v2 SPEC 13.5).
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

### D-47 Retries and their counts

- **Decision**: heartbeat and sweep are never used up: they retry at their cadence, and three
  failures in a row tell the owner once. `pr-reopen`, `stop-agent` and `restart-self` get one
  attempt, `release-worktree` two, `guard` three, and each wake one (with its one reminder). A
  `lost` entry is retried at once. Exit 2 is a never-retried usage error only for the image's
  own CLIs (v2 SPEC 13.4.2, 13.6.1, 13.10 item 1).
- **Alternatives**: one count for every CLI write; every exit 2 a usage error.
- **Why**: a heartbeat that ran out of attempts would stop renewing claims for a week, and
  another device would reclaim the work. The smaller counts are v2 SPEC 13.6.1's. A lost entry did not
  fail: its process died with the session. `gh` exits 2 when a command is cancelled and 1 on bad
  usage, so its exit 2 is worth another try.

### D-49 A respond is done once launched

- **Decision**: a respond runs detached under `nohup` in the pool slot on the run's branch, or
  one leased for it, with `--step` so it answers only the gate plan judged (left out when the
  step is not known), and its log is read back after 5 seconds. A clean launch is `done`; rule
  `P3a` judges `respondSettleMs` later whether the gate moved. Each attempt has its own log
  (v2 SPEC 13.6.1; the retired v1 pipeline rule P3a).
- **Alternatives**: keep the entry `running` until the run moves; no `--step`; one log per run.
- **Why**: `P3a` reads a done respond's launch time, and the `H4` drain waits on running
  entries, so a respond left running would never be retried and would hold an update forever.
  Without `--step`, a run that moved on between observing and launching would get the answer
  meant for the gate before. One log per run let a retry or a later gate overwrite the evidence
  `task(respond-stuck)` reads.

### D-50 Merges follow through on the loop's own bookkeeping

- **Decision**: an `update-behind` that pushed a new PR head makes older guards stale, and the
  next update is keyed by the head it pushed. A merge its own guard refused is a failed attempt,
  retried once rule `M2` clears the FAIL; only a refusal by GitHub or the harness tells the
  owner. A merge whose rollout read failed has it read again. A hand-merged closing PR on an
  epic base closes its issue (the retired v1 merge rules M1, M2b, M6 and M7).
- **Alternatives**: guards fresh until their TTL, one update key per run head, every refused
  merge to the owner, and follow-ups only from a merge's own rollout read.
- **Why**: each was a way a PR stalled or lost its follow-ups. The watcher keeps printing the
  run's old head after an update, so one key per run head blocked every later update. A
  transient FAIL inside the merge would have parked a mergeable PR until the owner looked. A lost
  rollout read loses the Run it and the milestone placement. GitHub registers no closing
  reference for a PR on a non-default base, as `callum-flow-merge` already says.

### D-51 A resume starts a fresh review round

- **Decision**: after an escalated test-weakening review (`M3`) or a merge hold (`M5a`), the
  owner's `resume <run>` asks for a fresh adjudication, with `:r<n>` on its keys, as `P2` does.
  A `judge(sequence)` that times out counts as a hold a resume releases, and the merge
  adjudicator's `escalate` is read as `hold`.
- **Alternatives**: only a new head ends the hold.
- **Why**: the owner decides by resuming, and an `M3` escalation otherwise had no way out short
  of a new commit. The merge adjudicator's definition offers `escalate`, so refusing it would
  waste an attempt on an answer that means the same as `hold`.

### D-52 A held Run it holds the next run-it merge

- **Decision**: the judge skill answers `task(run-it)` and `task(release)` with `hold` while the
  release waits on the owner, then finishes in chat. A `run-it` PR waits while another merged
  `run-it` issue's Run it is unfinished: its task not answered `done`, the issue open, and the
  owner has not resumed that issue since (the retired v1 merge rule M5).
- **Alternatives**: keep the task open until the release is out; count any answered task as a
  finished Run it.
- **Why**: one wake is open at a time (D-26), so a task held open for hours would block every
  other wake. Counting the `hold` answer as finished would let a second `run-it` change merge
  before the first one's release, which the skill forbids.

### D-53 The update drain ends at the next load

- **Decision**: the drain's safe state also waits for `pending` and `ci-stalled` runs of any
  device, and for the runs source to read; the restart goes only in a pass with nothing else
  planned, after the title. Once `dev-restart-self` returns, the module acts no more, and the
  drain ends only when the next load finds the restart lost, or done before it loaded. A failed
  restart is not retried: the owner is told and the drain holds (the retired v1 housekeeping rule H4).
- **Alternatives**: end the drain when the restart reports done; retry a failed restart.
- **Why**: `dev-restart-self` returns once Coder accepts the build, minutes before the
  container is replaced, so ending there starts new work in a container about to go. A
  `ci-stalled` run's CI step still polls in the daemon the restart kills, the risk D-15 drains
  for. A restart that failed once usually needs a person.

### D-54 The agent list decides what still runs

- **Decision**: only a successful agent-list read marks agents lost or failed; an agent first
  listed completed counts as running for that pass, and so does one whose answer is being
  handled. An agent that failed, timed out or was lost but is still listed at work blocks its
  rule's retry, and a failed `A1` stop tells the owner. `A2` stops tell the owner why. A turn
  that ends in `refusal` is a failed attempt, a spawn that does not start within 60 seconds
  fails, and a designer that posted its brief before it failed is not spawned again: the brief
  goes to `judge(report)` (v2 SPEC 13.5.1, 13.7.5, 13.10 item 4; the retired v1 rules A1, A2 and D2).
- **Alternatives**: trust any list read; retry by attempts alone; spawn a new designer whenever
  the last one did not answer.
- **Why**: a failed read that returned nothing would mark every agent lost and spawn them all
  again, and an answer still on its way would be thrown away. A retry beside an agent a stop
  could not end puts two agents on one key. A posted brief is the designer's work done.

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

### D-56 Prompts rewrite closing keywords; handoffs end in a RESULT line

- **Decision**: in a prompt's free text, a closing keyword before an issue reference becomes its
  `-ing` form ("Fixes #12" reads "Fixing #12") instead of being refused, and every id must have
  its shape. The designer's prompt lists in-flight branch names only. Spawns are named with
  their purpose and, from the second attempt, the attempt. Implementers and fixers end their
  handoff with `RESULT run= head= commit= gated= branch= pr=`, and a head that is not the commit
  is not gated. Each spawn's prompt and each answer are kept in the loop dir (v2 SPEC 13.6.1, 13.6.3).
- **Alternatives**: refuse any text with the bare words; list the in-flight branches' files;
  read the handoff's prose.
- **Why**: a ban on the words would garble adjudicator instructions ("Fix the timeout") and
  branch names. The designer finds the shared files itself, which keeps the loop out of diffs. A
  name with its attempt never clashes with an agent still winding down. A fixed line can be
  checked, and implement-issue says never to explain a head mismatch away. The kept prompts show
  the owner exactly what each agent was told.

### D-57 Plan details settled in code

- **Decision**: `at cap` shows only when the cap actually held a claim back; `blind` replaces the
  title's counts; a claim still running counts against every claim limit, and merge work still
  running counts as "merging first" in Slow; hand-merge follow-ups stop after 24 hours; a review
  carries over a rebase-only update only on a head's first round; a `restart` flag alone needs no
  sequencing call; an ACTION a rule does not expect plans nothing and is logged; an issue `only`
  names that is not in the queue is named in the skip reasons; trackers are followed three
  levels deep (v2 SPEC 13.5).
- **Alternatives**: `at cap` whenever live issues equal the cap; a claim counted only once done;
  no bound on hand-merge follow-ups.
- **Why**: a cap reached with an empty queue is no news. Checking the plan properties on every
  plan call showed that planning again while a claim ran claimed again (v2 SPEC 13.5.9, property 2).
  `callum-flow-factory-state` lists a merged issue for 24 hours, well inside the ledger's
  seven-day prune, so a follow-up can never fire twice. The retired v1 merge rule M5 named a major bump, a run-it
  rollout and a base image or template change as the calls; a restart is rule `H4`'s.

## Architecture

### D-03 Plan does not know the mode

- **Decision**: `plan` computes the same actions in observe and act mode; only the driver decides
  whether to execute them (v2 SPEC 13.2).
- **Alternatives**: plan only what the mode allows.
- **Why**: observe mode then shows exactly what act mode would do, which is the point of the
  shadow run.

### D-04 The model answers with a text block, the tool as an alternative

- **Decision**: when the loop wakes the model with a `JUDGE` or `TASK` line, the model answers by
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
- **Note** (2026-10-14): the loop's agents answer through their own tools first (D-68), or,
  while those cannot be reached, through a checked script (D-73, D-74); wakes keep the text block
  as primary.

### D-06 Usage comes from `usage-check.sh` every 5 minutes plus the session's own figures

- **Decision**: v2 SPEC 13.3.3, `usage` source.
- **Alternatives**: `$.session.usage()` only, which is free.
- **Why**: the session's figures come from its own last API response. An idle loop makes no API
  calls, while the other orchestrators keep spending the same plan, so those figures go stale and
  under-report. `usage-check.sh` asks the usage endpoint and is token-free, and every 5 minutes is
  close to today's rate of `usage` events (380 in 7 days).

### D-10 Observe mode sends side-effect events to a sink

- **Decision**: every command run in observe mode gets `CALLUM_EVENTS_DIR=<loop dir>/sink-events`
  (v2 SPEC 13.11.1).
- **Alternatives**: skip the CLIs that log, or add a no-log flag to each.
- **Why**: `usage-check.sh`, the `--once` modes and `callum-flow-issue-read` all log as a side
  effect. One environment variable keeps all of them out of the live event log without touching
  their code, and the sink file is itself evidence of what the shadow run read.

### D-14 The designer's definition owns its `RESULT` line

- **Decision**: the designer's agent definition (`designer.md`) ends every return with one
  `RESULT brief=... created=... pending_decision=...` line (retired with v1's designer; v2's designer answers through the script, v2 SPEC 8.7), as the adjudicator's
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
  `callum-flow-issue-read --json <N>` (v2 SPEC 13.3.1).
- **Alternatives**: a new `--blocked-by` mode on the reader, or a field in
  `callum-flow-factory-state`.
- **Why**: GitHub already returns the count on the issue object through the sanctioned reader
  (checked on 2026-10-12: #470 shows 1). No CLI change is needed.

### D-20 Pipeline classification stays in `pipeline-watch.sh`, through a new `--once` mode

- **Decision**: v2 SPEC 13.3.4. The queue gets the same treatment (`queue-watch.sh --once`).
- **Alternatives**: re-implement the classification in TypeScript.
- **Why**: the brief asks for it, and the classification (head checks, CI markers, mergeability,
  stalls, run id resolution) is subtle and tested. A one-shot mode reuses it and keeps the
  watcher's event logging, so metrics see the same events.

### D-21 Shadow and replay read pipeline states from the event log

- **Decision**: `runSource: events` builds runs from the live orchestrator's watcher events and the
  mirror (v2 SPEC 13.3.3).
- **Alternatives**: run the shadow loop on the orchestrator's own workspace.
- **Why**: pipeline runs are local to the workspace that started them, so the spike workspace has
  none for dev-system. The brief forbids touching the live orchestrator's workspace. The watcher
  logs every transition to `factory.events`, which gives the same states, a little later.
- **And**: the shadow loop observes as the live orchestrator's device (`shadowDevice`), because
  the plan drives only runs and claims the device holds. That is safe only because observe mode
  never executes anything, so the setting is refused outside observe mode.

### D-26 One wake at a time

- **Decision**: at most one `JUDGE`, `TASK` or `TELL` open at once (v2 SPEC 13.5.8, rule O2).
- **Alternatives**: several queued prompts.
- **Why**: the model answers one prompt per turn, and queued prompts would arrive while it is
  still answering the first. One at a time keeps each answer tied to its line.

### D-31 The judge skill is a new skill in the new plugin

- **Decision**: `plugins/factory-loop/skills/judge/SKILL.md`, a draft written in phase 3. The
  released `issue-orchestrator` skill is not touched.
- **Why**: the brief forbids changing the released skill. A separate skill can be reviewed and
  shipped on its own.

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

### D-41 Act mode reads through the --once watchers and a week of events

- **Decision**: act mode reads the queue with `queue-watch.sh --once`, its `known` list kept in
  the store, so `ready` events keep arriving; observe mode keeps the plain reader, so a shadow
  logs none of its own. A lost store is rebuilt from 7 days of events (the facts window is 3),
  and the rebuilt ledger is kept and saved; a merge rebuilt from the log counts as having had its
  rollout read, since the merging device ran the follow-ups then. A GitHub rate limit is remembered in the store for
  15 minutes, and once an executor meets one, the rest of the pass's GitHub writes are skipped
  with no attempt counted (v2 SPEC 13.3.3, 13.7.5, 13.10 item 2).
- **Alternatives**: one reader in both modes; rebuild from the facts window; let each later
  write in the pass meet the limit itself.
- **Why**: a shadow must not log the events the live orchestrator also logs. A hold such as a
  pending decision can be older than three days, and the ledger keeps entries for seven. The
  `merged` event carries no rollout, so without that rule every recent merge would read as one
  whose rollout read failed, and its follow-ups would run twice. Each write after a limit only
  meets it again and spends an attempt.

### D-42 A testbed runs a checkout's own tools

- **Decision**: the workspace file takes `toolsDir` (where the watchers and `usage-check.sh`
  live; default the base image's `/usr/local/share/callum-tools`) and `binDir` (put ahead of
  `PATH`). Every command also gets the configured labels as `CALLUM_FLOW_READY_LABEL` and
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

### D-45 The --once modes and the loop event, as built

- **Decision**: `--once` takes only its own options, exits 1 also when `gh` is missing or
  `no-mistakes runs` fails, and logs no `watcher_error`. `pending` also covers a failed probe and
  a run no source can name (id `unknown`), and `step=unknown` mirrors `head=unknown`.
  `callum-flow-event loop` refuses a note without `kind=`, `key=` and `status=`, `--if-changed`
  skips `loop` lines, and every event-log reader (factory-state, evaluate, heartbeat-state, the
  sweep) treats `loop` as bookkeeping. Loop notes leave out free text and guard outcomes
  (v2 SPEC 13.3.4, 13.7.4).
- **Alternatives**: accept and ignore other options; log a `watcher_error` for each failure;
  let `loop` events count as activity.
- **Why**: a failed listing must never read as "no runs". The loop polls every minute and
  reports a failed source itself, so a broken tool would otherwise log an error event a minute.
  Without the reader changes, a `loop` event after a close looked like the issue's latest event
  and the sweep logged a second `closed`, and a bookkeeping line made a repeated watcher event
  look new. Free text is not needed for a rebuild and would overflow the note.

### D-46 The loop's files stay bounded

- **Decision**: once a day the loop deletes the spawn records, saved answers, respond logs,
  recorded states and decision logs older than 7 days. Recorded states are written in observe
  mode only, at most 288 a day. The stored ledger keeps within 3 MiB by dropping the entries
  that ended longest ago, never a running one (v2 SPEC 13.7.1, 13.11.6).
- **Alternatives**: keep everything; a size limit on each file.
- **Why**: nothing reads past the ledger's own week, and the store refuses a whole save over its
  4 MiB limit, which would lose every change since the last one. A busy synthetic week stays
  under 2 MiB, so the ledger cap is a valve, not a working limit. The observe-mode event sink,
  one append-only file, is not pruned yet: it needs trimming, not deleting by age.

### D-48 Executors keep their writes narrow

- **Decision**: every `gh` command carries `--repo`. `abandon` and `release-parent` remove the
  label before they log `abandoned`. `release-worktree` gives `treehouse return` empty stdin,
  never `--force`, and is done only when the slot reads `available`. `milestone-expect` puts its
  reason on one line. `stop-agent` refuses any agent the ledger does not hold running
  (v2 SPEC 13.6.1).
- **Alternatives**: rely on `CALLUM_FLOW_REPO`, which `gh` does not read; log the event first;
  force the return.
- **Why**: a write can then reach only the configured repo. With the label off first, the event
  records a release that happened and a retry repeats only the label edit; logged first, a failed
  edit would leave the label on an issue `D6` then skips. A slot that turned dirty after plan
  looked keeps its work. The milestone CLI refuses a reason with a line break.

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
  by itself after the restart (the retired v1 housekeeping rule H4, now R2, v2 SPEC 14.1). The reconciler says an update is due through control
  state (`updateDue`): it owns which versions are wanted, and the loop owns when it is safe to
  switch. Until the reconciler exists, and whenever the owner wants one, `/factory update` sets
  it by hand (owner, 2026-10-13). A drain longer than an hour tells the owner.
- **Alternatives**: the first decision, where restarting stays a model or owner action (I-41);
  the reconciler filing an issue for the orchestrator to update itself.
- **Why**: owner, 2026-10-13: the safe moment can be computed, so waiting for a person is
  needless. Pipeline runs are the real risk: the 2026-10-12 restart crashed the no-mistakes
  daemon and failed three runs, so the drain waits for them too.

### D-16 Owner directives become control state

The pause, drain, wind-down, priority, "only these" and skip instructions the memory file holds as free text
(I-90) become typed control state, set through the control tool or `/factory` (v2 SPEC 13.4.3). The model
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

Owner, 2026-10-13: usage does not belong in the title. It reads `🔄 dev-system (Q:3 - D:5 - M:9)`:
`Q` issues in the queue, `D` in progress (designing through ready to merge), and `M` merged in the
last 6 hours. A word is added only when something needs attention: `owner <n>`, `blind`, `off`,
`observe` (not acting), or a usage tier that holds work (`stop new`, `stop all`). It changes only
when a count changes, so the `/rename` rows stay few. The running observe build still shows the
first format until the act-half build.

### D-24 Rate caps

Starts 30, spawns 120 and wakes 20 per rolling hour, plus 6 actions of one kind on one issue.
There is no global cap on merges (owner, 2026-10-13): a PR merges only once, after a guard and a
review, so merges cannot run away. The busiest hours on dev-system in the week to 2026-10-12 had 14 claims (a burst of
tracker re-claims after a lapse), 7 delegations, 7 adjudicated runs, 4 review fix rounds and 4
merges, so the caps sit about twice above real peaks. The per-issue cap catches the likeliest plan
bug, a key that keeps changing for the same subject, long before the global caps would. A capped
action is visible in the pass that drops it: the decision log names it, the title adds
`capped <class>`, a `loop` event records it, and the owner is told once (owner, 2026-10-13).

The first testbed run (2026-10-13) hit the first spawn cap of 40 in 31 minutes: the loop claimed
ten issues within two passes and each issue uses four to five agents (designer, implementer, gate
and merge adjudicators, sometimes a fixer), so a full batch passes 40 within its first hour even
with nothing going wrong. The owner lowered the in-flight cap to 5 and raised spawns to 120, so
the spawn cap is runaway protection again rather than a limit on normal work.

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
and run source, and `<loop dir>/control.json` holds the owner directives (v2 SPEC 13.4.1, 13.4.3). The
plugin options stay as defaults. The first plan put control state in `$.store`; files are easier
to inspect and set from a shell (the shadow run is configured that way), they survive restarts on
`/persist` just as well, and the `/factory` command and the control tool write the same file.

### D-34 A shadow run does not heartbeat on its own restarts

Rule `H1` heartbeats on the first pass after a load (I-93). A shadow watches another session, so
its own load says nothing about when that session restarted. While shadowing, the load time
counts as unknown, and only real lease timing drives heartbeats. The driver test caught this.

### D-35 "Only these issues" is its own directive

- **Decision**: control state gains `only` (v2 SPEC 13.4.3): when it is non-empty, rule `D1` claims
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
  re-drives the run or reports what it found (the retired v1 pipeline rule P3a).
- **Alternatives**: tell the owner (the first rule).
- **Why**: owner, 2026-10-13: a notice at 3 a.m. leaves the factory stuck until morning. The
  likely causes, a hung run or a crashed daemon, are what the re-drive task already handles.

### D-38 The owner can clear an issue's exhausted actions

- **Decision**: `/factory retry <N>` (and the control tool) clears the issue's ledger entries
  whose attempts ran out, so its rules can try again (v2 SPEC 13.4.3, 13.7.1).
- **Alternatives**: wait for the seven-day prune, or for the subject's key to change.
- **Why**: owner, 2026-10-13. An entry blocks only its own key, but a key that never changes
  (an issue's claim within one life, for example) would otherwise stay held for a week.

### D-39 A ping storm falls back to the timer

- **Decision**: passes start at least 5 seconds apart, and if pings drive more than 30 passes in
  10 minutes the loop ignores pings for 10 minutes, runs on its 60-second timer alone, logs a
  `loop` event and tells the owner once (v2 SPEC 13.2, 13.11.4).
- **Alternatives**: no limit beyond passes never overlapping.
- **Why**: owner, 2026-10-13: something that keeps waking the loop without being handled (a
  hook firing in a loop, an answer the parser rejects) would otherwise spin it. The timer keeps
  the factory moving while the owner looks.

### D-58 Owner controls as built

- **Decision**: `priority off` and `override off` sit beside `only off` and `update off`; `help`
  lists the ops; dropping a dropped issue does nothing. Input has limits (an override up to 100%
  and 168 hours, a reason up to 300 characters, a note up to 2 000, and an all-digit run id
  needs `run:`), refused rather than cut. A control.json that does not parse is never
  overwritten. The control tool refuses every op but `status` from inside an agent. `retry`
  sets the exhausted entries' attempts to 0 rather than removing them, and clears the notices
  they raised (v2 SPEC 13.4.3, 13.7.1).
- **Alternatives**: SPEC's first op list alone; cut long input; remove retried entries.
- **Why**: nothing else could lift a priority or cancel an override. A second drop would plan a
  second abandon. A cut directive is a different directive. Directives the owner could still
  recover must not be lost to a write. The loop's agents act on their own issue only. Removing
  a retried entry broke `D4b`, which re-delegates from the last delegate entry.

### D-59 The judge skill's own choices

- **Decision**: a TELL line opens with `[DECISION]`, `[ACTION]` or `[INFO]`; every TASK answer
  carries a reason, `done` included; a handoff may be confirmed gated with
  `git merge-base --is-ancestor`; a re-drive finds the brief through the issue's comments; a
  wake name the skill does not list gets `hold` (a TELL is relayed as it stands). The skill is
  one file of about 260 lines.
- **Alternatives**: no tags; a reason only for `failed`; the TELL kinds in a second file.
- **Why**: the tag says at a glance on the phone whether the owner must act. D-13 asks for a
  trail of when and why the model was involved. A cheap factual read is not a diff read. Holding
  is the safe default. A second file would cost a read on every TELL.

### D-60 The claim-to-merge test runs beside the engine's test host

- **Decision**: `tests/act.test.ts` drives the real observe and act-step functions through ten
  passes, from claim to merge and the run-it follow-ups, with a recording fake;
  `tests/driver.test.ts` tests the driver's own wiring in the engine's test host, with agents
  seeded in the store.
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


### D-62 Prose before an adjudicator's contract is skipped

- **Decision**: the adjudicator parser skips lines before the first contract line, unless one
  looks like a misshapen contract line; after it, the contract stays strict (the retired v1 adjudicator reply contract).
- **Alternatives**: the strict parse of that contract as first written, where any other line fails.
- **Why**: on the testbed on 2026-10-13, adjudicators twice opened with a sentence of context
  before correct verdict and ACTION lines. The strict parse failed both attempts, so a correct
  escalation became an agent-failed notice and cost a second adjudicator run.

### D-63 One writer per branch

- **Decision**: while an implementer or fixer of an issue runs (by the ledger, or by the agent
  list for one a stop did not end), no other action that writes the issue's branch or its PR's
  head starts: another implementer or fixer, a respond, an `env-retry` (D-64), an update-behind,
  a fast-forward (D-66), a merge. Only one such writer is kept per issue per pass.
- **Alternatives**: rely on each action's own key, as the first build did.
- **Why**: found on the testbed on 2026-10-13: a guard-failure fixer and then a conflict fixer
  started on the same PR a pass apart, once earlier merges made the branch conflict. Two agents
  committing to one branch race each other and the pipeline.

### D-65 A guard failure is judged once; the guard expires after 5 minutes

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #550): a guard goes stale once
  any fixer on the PR ends `done`, with or without a commit, so the next pass guards again.
  `guardTtlMs` drops from 30 to 5 minutes, a backstop only. The guard-fail judge is keyed by the
  PR, the head and a digest of the FAIL lines, not by the guard's number: a re-check that fails
  the same way wakes no one, and a changed failure gets a new judge. A new round comes when the
  owner resumes the run, or 30 minutes after a `wait` answer (or after the fixer a `fixer` answer
  asked for ended) while the same failure stands; the 30 minutes are a constant in plan.ts
  (`JUDGE_REMIND_MS`), not a setting. The guard fixer's key follows the judge's round. Every
  merge-ready PR that no rule acts on in a pass leaves a skip line saying what it waits for
  (v2 SPEC 13.4.2; the retired v1 merge section).
- **Alternatives**: keep the 30 minute expiry and re-guard only after a commit; key the judge by
  the guard's number; no reminder after `wait`.
- **Why**: stage D run 2, PRs 44 to 46 sat about 20 minutes after no-commit fixers, and setting
  the expiry to 3 minutes by hand cleared them within a minute. A judge keyed by the guard's
  number would wake the session on every re-check, so the key follows the failure. Without the
  reminder, a `wait`, or a fixer that did not cure the failure, would leave the PR waiting for
  good; 30 minutes matches the old cadence for a truly stuck PR. Under the old per-head fixer
  key, a later `fixer` answer for a changed failure could never start a new fixer.

### D-66 The loop fast-forwards a worktree the pipeline's own commits left behind

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #551): a free `fast-forward`
  action repairs worktree lag before waking the judge. The current eligibility, recovery and
  safety requirements were the retired v1 merge rule M2's; the
  [executor catalogue](v2/SPEC.md#1361-catalogue) holds what remains.
- **Alternatives**: keep judging every `head` FAIL; fast-forward before every first guard,
  whatever the pool shows; move a lagging worktree by any means but `--ff-only`.
- **Why**: run 2 had six `FAIL head` results, every PR the pipeline committed to, each costing a
  judge wake and a fixer for one fast-forward. The executor's refusal checks protect work that
  a repair must preserve; see the executor catalogue above.
- **Note** (2026-10-14, #563): rule `M1`'s first-guard run is removed. Observe reads a slot's
  tree only for a finished issue, and an implementer detaches its slot once the pipeline holds
  the branch, so it never ran. `M2`'s run on a `head` FAIL covers the lag, at the cost of one
  guard.

### D-67 An agent's own `running` status is no proof it is still at work

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #545): an answer with no
  machine line is interim only when a fresh agent list shows the agent `waiting`, or a sub-agent
  of its own pending, running or waiting; then the loop waits for its next answer, up to its
  timeout. The agent's own `running` does not count (the retired v1 adjudicator reply section).
- **Alternatives**: hold whenever the list shows the agent at work, `running` included.
- **Why**: the test host lists an agent as `running` at its own `turn.complete`, and the real
  engine may too before it marks the agent completed. Counting `running` would hold every
  stopped agent's missing line until the `A1` timeout, so a designer's missing `RESULT` would no
  longer reach the model at once.

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

### D-70 The loop owns copies of the adjudicator and designer definitions

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #548):
  `plugins/factory-loop/agents/{adjudicator,designer}.md` are the callum-flow definitions word
  for word, plus ToolSearch and the answer tool on `tools:`. A root test
  (`tests/factory-loop-agents.test.js`) keeps them in step, and `agent.offer` hides them from the
  model (v2 SPEC 13.6.1).
- **Alternatives**: (a) edit the callum-flow `tools:` lines, which changes the released
  orchestrator's agents, and #548 keeps the instruction out of the shared definitions; (b)
  `$.agent.register` at load from the released plugin's agent file, but no engine API finds
  another plugin's files, and the plugin cache layout (`installed_plugins.json`,
  `cache/<marketplace>/<plugin>/<version>`) is internal; (c) answer in text only.
- **Why**: the engine refuses any call outside an agent's allowlist, so without this the
  adjudicator and designer could never use their tools. A copy kept identical by a test cannot
  drift unnoticed.

### D-71 After an answer: supervision and repair grace

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #548): a done agent entry whose
  agent is still listed at work 60 s after its answer stays under rules A1 and A2, and
  `stop-agent` accepts that agent as the loop's own. The 60 s grace leaves alone an agent the list
  has not yet marked completed. A repaired agent counts as at work for 5 minutes while still
  listed completed, or until its next `turn.complete`, instead of the full A1 timeout, so an agent
  that never resumes is lost quietly within minutes (the retired v1 agent rules A1 and A2; v2 SPEC 13.7.3a).
- **Alternatives**: keep a repaired agent at work for the full A1 timeout.
- **Why**: an answer through the tool ends the entry before the agent's turn ends, and an agent
  that works on still holds its branch, so it must stay supervised. The alternative would hold
  the issue for up to 2 h and end in a failed stop of a completed agent with a spurious owner
  tell.
- **Note** (2026-10-14, #560): every rule here reads an agent listed `idle` as one listed
  `completed`: reconcile, the repair grace, and the A1 and A2 at-work checks (and the readers
  that share `listedLive`). The engine documents `idle` as between turns, until a message wakes
  it, and on Claude Code 2.1.299 a finished agent is listed `idle` for 20 s or more, so before
  this the "5 minutes, then lost" rule might never fire. An agent the loop awaits a repair reply
  from is never cut off by it: while the send is on its way the agent is held at work as an
  answer being handled, and once delivered its entry stays `running`, which plan never treats as
  ended, while the reconciling read holds it at work within the 5 minutes.

### D-72 An issue closed on GitHub is finished, and its state is read before the queue

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #556): each pass's GitHub
  reads start with the issues the loop may act on or counts as live: those of its running work,
  this device's issues, every issue in a live stage, whoever holds it, and that of a merged Run it
  not answered `done`. The queue comes after them. An issue known closed is not read again unless
  the queue names it or this device holds it. A failed read keeps the last value, and an issue
  whose state is not known is driven as before, except that no agent starts on it while GitHub
  fails (a backoff, a failed read). Plan treats a closed issue as finished. It is not live: not in
  the title's `D` or `stuck`, not under the in-flight cap, no heartbeat for it. No rule drives its
  runs, designs or delegates it, or judges its handoffs. A2 stops its agents, naming the final
  stage when the factory shows one, else `closed`. H3 returns its clean slots once no agent of the
  loop works there. `M7`'s follow-ups and `M8`'s close still run (v2 SPEC 13.3.3, 13.5.1, 13.13).
- **Alternatives**: (a) hold every action on an issue whose state is not known, which would hold
  a new device's whole first pass, and a run whenever one read fails; (b) add the issues the
  watcher lists a run for: `no-mistakes` lists the newest unfinished run of every branch it ever
  gated, so after a load the budget would go on long-closed issues while the queue waited; (c)
  re-read every closed issue on a slow cadence, to notice a reopen; (d)
  `callum-flow-factory-state --github on`, which reads GitHub every pass outside the loop's budget
  and backoff; (e) keep H3 to `merged` and `closed without merge`.
- **Why**: on run 3's first pass, twelve queue reads took the whole budget, so the closed issues
  were never read before plan drove them. Reading them first only delays the queue's reads, by a
  pass when the budget is short, and an unread queue issue is never claimed. A run is driven only
  for an issue this device holds, so (b) adds nothing that matters. A closed issue soon ends in
  the factory too (the sweep logs it closed), so a reopened one comes back through the queue and a
  new claim; until then one this device holds is still read, or a reopen would leave it held but
  not driven, with no heartbeat for its lease. A Run it's issue is read until it closes, since its
  closing ends `M5`'s wait. While GitHub fails, an unread state is as likely closed as not (a
  reload empties the cache), so no agent starts; agents are what cost the most, and holding
  everything else too is alternative (a). Other devices' live issues are read because the title
  counts them. A clean slot of a finished issue holds nothing, and A2 stops any agent there
  before H3 returns the slot.

### D-73 Agents are asked for text until a timer-spawned agent reaches the loop's tools

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #560): a setting,
  `answerTools`, default `false`, in the repo's `.claude/factory-loop.json` and in the workspace
  file, which wins. Off, the spawn prompts and the repair message ask for the text contract alone
  and name no tool. On, they ask for the tool first, with the text as the fallback, as #548 built
  them. The three answer tools stay registered and served either way, and a call is answered as
  before. A bad value in either file is left out and named in the decision log (v2 SPEC 13.4.1, 13.4.2,
  6.3, 7.3a, 13).
- **Alternatives**: (a) keep asking for the tool, as now; (b) unregister the tools while off; (c)
  spawn agents from a hook the engine serves, not the timer; (d) a `/factory` op to switch it.
- **Why**: a probe mod on Claude Code 2.1.299 shows that a spawn made from a `$.clock.after`
  callback starts an agent whose call to the mod's own tool fails in milliseconds with
  `<plugin> registered the tool ... but no tool.call hook answered this call`, and the hook never
  runs. The same spawn made inside a `command.run` hook works. Every pass of the loop runs from its
  timer, so every agent it spawns is in the failing case; that was the real cause of run 3's 80
  and more failed tool calls, besides the deadline #558 fixed. (a) has every agent call, fail,
  and fall back to text, which wastes a step and invites odd replies. (b) removes the path for no
  gain: an agent that calls anyway gets the same refusal-or-answer it gets now, and keeping the
  tools served means turning the setting on is all an engine fix needs. (c) would put passes back
  on hooks' own dispatch, under the hook budget, which the loop avoids on purpose (a ping runs its
  pass with the timers' `$`), and a quiet factory has no hook to spawn from when the timer finds
  work. (d) is more surface for a switch that changes only with an engine release; the file,
  read every pass, is enough. The workspace file wins, as `trace` does, so a testbed can try the
  tools without touching the repo's checked-in file.
- **Note** (2026-10-14, #561): `answerTools` is replaced by `answerChannel`, whose default,
  `script`, has agents answer through a checked script until the tools can be reached; `text` is
  what `answerTools` off was, and `tool` what it was on (D-74).

### D-74 Agents answer through a checked script until a timer-spawned agent reaches the loop's tools

- **Decision** (the agent's choice, 2026-10-14, approved by the owner the same day; #561): a temporary workaround
  for the answer tools of D-68, which no agent the loop spawns can reach (D-73). The plugin ships
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
  setting `answerChannel` (`script`, the default; `tool`; `text`) replaces #560's `answerTools`,
  which is named as replaced and not read. Prompts never say why the script stands in. It goes
  back to `tool` once the timer-spawn probe (v2 SPEC 13.13) passes (v2 SPEC 13.4.2, 13.6.3, 13.7.3a, 13.11.6, 13.12, 13.13).
- **Alternatives**: (a) stay on text with the repair message, as #560 left it; (b) write the
  contract in TypeScript and run the script with node's type stripping; (c) a JSON schema plus a
  small validator; (d) pass the purpose, repo and issue as flags on the script's command line;
  (e) read whatever answer file the agent wrote, or the newest; (f) keep `answerTools` as an
  alias of `answerChannel`.
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
  who answered. (f) `answerTools` lived for a day on the unreleased branch, and an alias needs
  precedence rules against the new key; naming it as replaced is enough. Text stays every
  prompt's fallback, so an agent whose script call is refused still answers.

### D-75 An agent at work past its answer is stopped once the grace is out

- **Decision** (the agent's choice, 2026-10-14; #587): a done agent entry whose agent is still
  listed at work 60 s after its answer is stopped by rule A2 (reason `worked on past its answer`)
  for every agent type, instead of waiting for its A1 timeout, and the owner hears once
  (`tell(stopped)` with why `answered`, the agent type and the status it was listed with). Once
  that stop has ended, done or failed, the agent no longer counts as a reader of the main
  checkout (H5) or as the writer of its branch, so what it held goes on the next pass. A2's
  issue reasons (ended, claimed elsewhere, dropped, split) still come first, with their own
  reason and notice, and an implementer or fixer is left alone while a run of its issue moves or
  the `runs` source does not read. This revises D-71, which kept such an agent under A1 and A2
  only for their usual reasons.
- **Alternatives**: (a) never count an answered agent as a reader or writer, without stopping it;
  (b) let what it held go in the same pass as the stop; (c) a process-group kill of the agent's
  shells from the loop, besides TaskStop; (d) stop an implementer or fixer also while a run of
  its issue is running, pending or ci-stalled.
- **Why**: on the first day the loop ran the real repo, three stalls came from one cause: a
  designer left `claude remote-control --help` running in the main checkout, and two
  implementers left `until ! pgrep -f ...` wait loops that matched themselves, so the list kept
  them at work and held the checkout update, every adjudicator behind it and two gate responses
  for 20 to 60 minutes, up to the 60 and 120 minute timeouts. The answer is applied and saved
  before the entry is done, so the stop discards nothing; an entry still awaiting an answer or a
  repair reply is running and never counts. (d) would end a pipeline driver the agent launched
  in the background (`axi run` and `axi respond` block until the next gate) and strand the run;
  while the run moves nothing else needs its branch, and once it parks the driver has returned,
  so what is left is stopped then. (a) would leave the shells running for hours. (b)
  plans the checkout update before the stop runs, under a shell that may still be in it. (c)
  TaskStop is expected to end the background shells an agent owns: Claude Code 2.1.296 kills an
  agent's running shell tasks as its loop exits, and the process groups of a loop that does not
  settle after the kill, so the loop needs no process access of its own. A process that detached
  from its shell (setsid, a daemon) outlives the stop; the owner's notice names the agent.

### D-76 A resumed escalation sends a fixer unless it is all ENV with no note

- **Decision** (the agent's choice, 2026-10-14; #596, amends D-64): a resumed gate escalation
  sends a fixer for an owner instruction or recorded verdicts that are not all `ENV`, including
  an empty verdict list. Environment retry remains available without an owner instruction;
  missing adjudication details require a fresh adjudicator unless an owner instruction exists.
  The retired v1 pipeline rules P2, P2a and P2b owned the eligibility, instruction
  ordering and once-per-resume contract, and P3 the notice context. The
  [judge skill](../../plugins/factory-loop/skills/judge/SKILL.md#owner-chat)
  owns how to record the owner's instruction before resuming.
- **Why**: on #533 every verdict was `ENV` (the PR body was over the provider budget), the owner
  noted the change and resumed, and D-64's rule reran the same head and then escalated again; no
  fixer was ever planned. A code-failure escalation resumed with no note previously asked a new
  adjudicator the same question.
- **Alternatives**: read the notes inside `env-retry` (the rerun cannot change the PR body); a
  `task` for the model on every resume (a model wake for a decision the planner can make).
