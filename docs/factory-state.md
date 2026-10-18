# Factory state

`callum-flow-factory-state` (in the base image, read-only) answers "what is the factory doing right
now?" in one deterministic report, so no reader has to write its own SQL against raw tables. Read
naively those tables are wrong: on 2026-10-10 half the issues that looked in progress were closed on
GitHub. This page is the contract; `tests/factory-state.test.js` checks the tool against the fixtures
in `tests/fixtures/factory-state/` (each `<name>.input.json` has its reviewed `<name>.expected.json`),
and the image CI runs the same SQL against a real PostgreSQL. The `factory-state` skill runs the tool
and adds a short narrative.

```
callum-flow-factory-state [--repo <owner/name>]... [--at <ISO time>] [--format text|json]
                          [--rule S1..S5=<minutes>]... [--github on|off] [--source old|new|shadow]
```

Exit 0 ok, 2 bad arguments (a bad `--source` or `CALLUM_FLOW_FACTORY_STATE_SOURCE` included), 1 the required
source that cannot be read: `factory.events` for `old` and `shadow`, `factory.event_log` (through
`dev-query --factory`) for `new`, which also fails with `unknown factory event: <type> v<N>` on an event
type or version `factory-event-shapes.json` does not list as current. An optional
source (`nomistakes.runs`, `factory.workers_status`, GitHub) that is missing shows as `n/a: <reason>`
(`runs` and `workers` in the JSON), so no-mistakes data can never blind a reader of the factory. With
no `nomistakes.runs`, no run places an issue.

## Stages

An issue is in exactly one stage. `stuck` is a flag on a stage, not a stage.

| Stage | Meaning |
| --- | --- |
| `queued` | latest decision event is `ready` or `reclaimed`, or a designing claim has lapsed (see below); no pipeline run in progress |
| `designing` | `claimed`, `briefed` or `design_routed`, with no delegation or run since; any recorded claim lease must still be live (see below) |
| `implementing` | `implementer_routed` or `delegated` with no run yet, or the latest run ended without a PR to merge (failed, cancelled, completed with no PR, PR closed) |
| `in pipeline` | the latest run is running and not waiting on anyone |
| `parked` | the latest run is running and waiting on an agent or the owner (`awaiting_agent_since` set) |
| `waiting` | the factory loop v2 holds the claim and re-checks the record's wait conditions each pass, with no slot. The loop owns it: only a v2 record in `waiting` or a `factory:waiting` label gives it |
| `ready to merge` | the latest run completed and its PR is open |
| `merged` | a `merged` event, or the run's `pr_state` is `merged`. Not final: it stays visible until GitHub closes the issue |
| `closed without merge` | `closed` or `abandoned` (with no new life after it) and no merge |

Only `closed` and `abandoned` end an issue's life in the view. A `merged` issue that is later `closed`
leaves the live list and shows under "recently ended" (24 hours from `--at`) as `merged`. A new
`claimed` after a `closed` or `merged` event starts a new life.

A claim is live while its newest `claimed` or `renewed` event plus its lease is still in the future.
The lease is the event's `lease: <minutes>` note, or 120 minutes when the note has no positive
lease value. See the [factory event log reference](../images/base/README.md#factory-event-log)
for how claims and heartbeats record it. When the issue would be `designing` but that time is at
or before `--at`,
it is `queued` with the detail `claim lapsed at <ISO time>`; time in stage starts at that expiry.
Without a recorded `claimed` or `renewed` event, `briefed` and `design_routed` remain `designing`.
`renewed` never sets a stage, never starts a new life after `closed` or `abandoned`, and never counts
as a decision newer than a run.

An `abandoned` event is final only until a new life starts. Strictly after it, a new life is: a
`ready`, `reclaimed`, `claimed`, `briefed`, `design_routed`, `implementer_routed` or `delegated` event; a `merged` event; a
mirror run created after it; or, for a run not in the mirror, a `run_started`, `parked`, `verdict`,
`fix_requested` or `merge_ready` event on a run id that is not the abandoned one and appears in no
earlier event. Replay-prone events (`failed`, `head_mismatch`, `conflict`, `ci_stalled`), anything on the
abandoned run, `superseded`, `usage` and `untrusted_stripped` never start one. `closed` stays final
unless a later `claimed` follows.

### The factory loop v2

The factory loop v2 logs a `transition` event at every change of an issue's state
([v2 SPEC 7.1](factory-loop/v2/SPEC.md#71-what-v2-emits)): its note carries the record as
`key=value` tokens, `to=` the new state. An issue whose current life has one takes its stage from the
newest one:

| v2 state | Stage |
| --- | --- |
| `queued` | `queued` |
| `designing` | `designing` |
| `building` | `implementing` |
| `reviewing`, `fixing` | `in pipeline` |
| `merge-queue` | `ready to merge` |
| `parked` | `parked` |
| `waiting` | `waiting` |
| `closed` | `merged` when its `why` is `merged` or `merged-by-hand`, else `closed without merge` |

The detail shows the v2 state, the step and the attempt, and time in stage runs from the record's
own `since`. Only the newest life counts (its `life=` token is the claim's start time): a
`claim-lost` close is another device's issue and is left out, as are the transitions of an older
life, so a loop that lost the issue to a second loop never hides the live life's state. The state
holds only while nothing released the issue after it: a `ready` or `reclaimed` (the sweep, or the
loop's reconcile, put it back in the queue) or a `claimed` newer than the newest transition shows no
v2 state, whatever that transition's `to`, so a released ghost never shows its old stage. The loop's
own re-claim logs the transition again right after its `claimed`. A closed one is of the current
life only while no new life followed it (a `ready`, a claim, a delegation). A v2 issue keeps the
loop's state while its claim lapses and no sweep has released it: the loop claims it again, so the
lapse shows in the `lease` field, not as `queued`. The stuck rules apply as to any issue.

`superseded` (run-scoped, `--run` required) says a run was replaced for the same issue. It is never a
stage and never final; the named run is dropped when the issue's latest run is chosen, so its stale
`running` row cannot set the stage.

## Source precedence

Highest first. A lower source never overrides a higher one.

1. GitHub closure: a `closed` event from the sweep, or the live GitHub read (the tool reads GitHub
   through `callum-flow-issue-read`: open or closed, labels, the claim comment).
2. `merged` and `abandoned` events.
3. The factory loop v2's state: the newest `transition` event of the current life (see
   [The factory loop v2](#the-factory-loop-v2)). The mirror's runs no longer set such an issue's stage.
4. Pipeline facts from the `nomistakes.runs` mirror: start, status, parked, PR. A run belongs to an
   issue by the one definition in [Linking pipeline runs to issues](#linking-pipeline-runs-to-issues),
   copied verbatim into the tool's SQL (a test fails if the copies drift). The agent-logged `run_started`,
   `parked`, `merge_ready`, `failed`, `head_mismatch`, `conflict` and `ci_stalled` events never set a
   stage; when the mirror has no run they only appear as an `event-only` hint. A `failed` replayed after
   `merged` or `closed` (#344) is therefore ignored.
5. Factory decisions: `ready`, `claimed`, `briefed`, `design_routed`, `implementer_routed`, `delegated`, `reclaimed`.
6. Worker liveness is currently `n/a`: this reader checks whether `factory.workers_status` exists
   but does not read its rows yet. Use the [fleet status query](metrics.md#workers) for liveness.

A live run (in pipeline, parked, ready to merge) decides the stage. When the latest run has ended and
a newer decision event exists, the decision wins (a re-delegated or reopened issue).

GitHub is read live, so for a past `--at` its facts are not as of that time; the output says so. Use
`--github off` for a database-only view.

## Linking pipeline runs to issues

`run_started` is logged only when an agent remembers to, so 13 of the first 37 merged issues have
none. The no-mistakes database records every run itself and `nm-push-loop` mirrors it into the
`nomistakes` schema, so the mirror is the source of every pipeline fact (start time, status, parked
time, PR). A run belongs to issue N of repo R when:

- `runs.repo = lower(R)` (the exporter lowercases `repo`; `factory.events.repo` is not lowercased,
  so compare with `lower()`), and
- its `branch` matches `(^|/)issue-([0-9]+)(-|$)`, the `feat/issue-<N>-<slug>` convention the
  `implement-issue` skill uses (the CTE reads up to nine digits).

Legacy fallback: a run whose branch carries no issue number is linked through a `run_started` event
with the same `run_id`, so old rows keep working. The branch wins when the two disagree. Every
other run, including one with NULL `repo`, is unlinked: it is left out of per-issue numbers, never
counted against an issue by guess. The start of a pipeline run in any issue-level number is the
linked run's `created_at`; `run_started` timestamps are never read.

`callum-flow-factory-state` copies the CTE verbatim (`tests/factory-state.test.js` fails if the copy
drifts), and `callum-flow-evaluate` applies the same rules to the no-mistakes source (see "Offline
computation" in [metrics.md](metrics.md#offline-computation-callum-flow-evaluate)). The
tool's SQL reads the old `factory.events` table until
[#898](https://github.com/cbundy/dev-system/issues/898) moves it to the factory database.

```sql
WITH run_link AS (
  SELECT r.repo, ((regexp_match(r.branch, '(?:^|/)issue-([0-9]{1,9})(?:-|$)'))[1])::int AS issue,
         r.id AS run_id, r.created_at
  FROM nomistakes.runs r
  WHERE r.repo IS NOT NULL AND r.branch ~ '(^|/)issue-[0-9]{1,9}(-|$)'
  UNION
  SELECT r.repo, e.issue, r.id, r.created_at
  FROM nomistakes.runs r
  JOIN factory.events e ON e.run_id = r.id AND lower(e.repo) = r.repo
                       AND e.state = 'run_started' AND e.issue IS NOT NULL
  WHERE r.repo IS NOT NULL AND (r.branch IS NULL OR r.branch !~ '(^|/)issue-[0-9]{1,9}(-|$)')
)
SELECT * FROM run_link ORDER BY repo, issue, created_at;
```

## Time and `--at`

`--at` defaults to the database's `now()`, resolved once and printed with its source. Events are
bounded by `ts <= at` and runs by `created_at <= at`. The same rows, `--at` and GitHub answers give
byte-identical output, with a fixed sort order (repo, stage order, issue number).

The mirror holds only each run's latest row. For a run updated after `--at` the state then is
reconstructed from timestamps: it counts as running (parked only if `awaiting_agent_since <= at`) and
is marked `approximate`; stuck rule S5 is not evaluated on it.

## Stuck rules

Inputs, not judgement. Defaults come from the factory's own data and can be set per run with
`--rule S1=<minutes>`; the active values are echoed in the output.

| Rule | Trips when | Default |
| --- | --- | --- |
| S1 | `designing` for more than the threshold | 240 min (2 x the default claim lease) |
| S2 | `implementing` with no run in progress for more than the threshold | 60 min |
| S3 | `parked` for more than the threshold | 30 min |
| S4 | `ready to merge` for more than the threshold | 30 min |
| S5 | `in pipeline` with no run `updated_at` for more than the threshold | 30 min |
| S6 | the holder's worker is `stale` or `stopped` while the issue is live | `n/a`; see [Source precedence](#source-precedence) |

`waiting` has no stuck rule of its own: the loop tells the owner after 24 h.

This replaces the hardcoded 4 hour stuck query that `metrics.md` used to carry.

## Output

Per repo, each live issue: stage, detail, time in stage, holder device (the device of the latest
`claimed`), run ID, PR, the stuck rule, `source` (`mirror`, `event` or `github`), `flags`, `lease`
(`{ until, lapsed }` of the newest `claimed` or `renewed` and its lease, or null) and `v2` (the
factory loop v2's `{ state, step, attempt, life, seq, why }`, or null). Flags are disagreements
between sources and never change the stage: for a v2 issue, a missing `factory:<state>` label or any
other `factory:*` label (but `factory:rejected` on a closed one: the loop rejected the issue at its
last life, v2 SPEC 6.4, and that label is not a state); for any other issue, a `queued` one without `ready`; a GitHub claim comment
held by another device than the events say; a GitHub state that could not be read. No label marks a
claim: `In development` is gone (v2 SPEC 3.6). Also per repo: recently ended issues, `other_runs` (running runs on a branch
with no issue number), and coverage. Across repos: the stuck list, and the workers section.

An open issue labelled `factory:<state>` or `ready` that the database has never seen is listed with
source `github`, its stage from the `factory:*` label (as in the table above), else `queued`, so a
missing event never hides work. `factory:rejected` names no stage.

## Coverage

A gap is named, never shown as idle.

| Class | Meaning |
| --- | --- |
| `full` | the repo has events and mirrored runs |
| `pipeline only` | runs but no events: claims, delegation and queue state are unknown |
| `events only` | events but no runs: pipeline stages are only what agents logged |
| `none` | nothing in the database |

Per repo the report also gives the last event and last run update, each device's event count and last
event, the number of live issues by source, and worker coverage (see [Source precedence](#source-precedence)). Known
gaps in the data: labels and claim comment bodies never reach the event log (hence the live GitHub
read). Claim-lease renewals are recorded as `renewed` events, as described under [Stages](#stages).

## Worked examples

One per fixture; the exact output is the fixture's `.expected.json`. Times are minutes before
`--at` = 2026-10-10T12:00Z.

- `closed-outside`: #10 had a running run, #11 was claimed, #12 was `ready` then `claimed`; the sweep
  logged `closed` for each, and #14 was `abandoned` although a run's PR had merged. None is live; all show `closed without merge` under recently ended. #13 was
  closed 8 days ago and is not shown.
- `superseded-run`: #80 is the real #229 shape: `abandoned` on the old run with the note `superseded by
  -v2`, a new run, replayed `failed` events on the old run, then `merged` - live `merged` on the new
  run. #81 only has replays after its `abandoned` and stays `closed without merge`; #82 (`ready`), #84
  (a newer mirror run) and #85 (an unseen run's `run_started`) start a new life; #83's run predates its
  abandon so it stays ended. #86 and #87 have a `superseded` old run still `running` in the mirror: #86
  is `parked` on the new run, #87 is `implementing` with no run.
- `missing-run-started`: #20, #21 and #22 were claimed and delegated and have no `run_started`. The
  mirror places them: a running run gives `in pipeline`, a completed run with an open PR gives
  `ready to merge`, a completed run whose PR is merged gives `merged`.
- `replayed-events`: #30 and #31 got a `failed` replay after `merged`/`closed`, #32 after `merged`.
  They stay `merged` and `closed without merge`; no `event-only` hint is shown for a merged issue.
- `pipeline-only`: `acme/gadgets` has runs and no events. Coverage is `pipeline only`; the running and
  the parked run show; the old merged run does not; a running run on `chore/release-1.0` is under
  `other_runs`.
- `split-parent`: #40 was claimed 300 minutes ago, renewed by a heartbeat 30 minutes ago and never delegated: `designing`, S1 trips. #41 is
  `queued`, #42 is `designing` for 30 minutes.
- `lapsed-claim` (`--at` = 2026-10-12T07:00Z): #1 was claimed 7 hours ago with no renewal and #5 has a
  `lease: 30` note and was claimed 40 minutes ago: both are `queued` with `claim lapsed at ...`. #2 is
  freshly claimed, #3 was claimed long ago but renewed within the lease, and #4 was `briefed` and then
  renewed: all `designing`. #6 got a `renewed` after `closed` and stays ended, #7 is `implementing`
  although `untrusted_stripped` came after `delegated`, and #8 has a running run: `in pipeline`.
- `parked`: #50 has waited 45 minutes (S3 trips), #51 5 minutes.
- `stuck-rules`: #70 delegated 120 minutes ago with no run (S2), #71 ready to merge for 45 (S4), #72
  in pipeline with no run update for 40 (S5), #73 whose last run failed 70 minutes ago (S2).
- `point-in-time-early` and `point-in-time-late`: run `r60` finished 10 minutes before the late
  `--at`. At the early `--at` (30 minutes before) the run row is newer than `--at`, so #60 is
  `in pipeline`, marked approximate; at the late one it is `ready to merge`.
- `github`: #80 is closed on GitHub, so it is `closed without merge` with source `github` although the
  events say `delegated`. #82 is `queued` but has no `ready` label, #84 is `designing` with no label
  and no flag (no label marks a claim), #81's claim comment names another device, #86's GitHub state
  could not be read, #83 is `merged` and still open (kept visible), #90 (`ready`) and #91
  (`factory:building`, so `implementing`) carry a label and are unknown to the database.
- `v2`: the factory loop v2's issues. #100 is `building` (so `implementing`) although an old run
  still runs in the mirror, #101 is `parked` for an hour (S3), #102 is `reviewing` but still labelled
  `factory:building` (flagged), #103 closed as merged with its `merged` event lost (`merged`), #104
  was dropped (`closed without merge`), #105 was dropped and then labelled `ready` again (`queued`, a
  new life), #106's record closed as `claim-lost` while another device holds it (`designing`, held by
  `dev-b`), #107 is `queued` and #109 `designing`, both with a lapsed lease, and #108 is labelled
  `factory:fixing` with no events (`in pipeline` from GitHub).
- `v2-waiting`: the `waiting` stage. #200 is `waiting` for 30 hours with no stuck rule, #201 is
  `waiting` but labelled `factory:parked` (flagged), #202 is `parked` and #203 `queued` (they sort
  before the waiting ones), #204 is labelled `factory:waiting` with no events (`waiting` from GitHub)
  and #205 is `waiting` while another device's claim comment holds it (flagged).

## Sources (old|new|shadow)

The events come from one of two stores ([source switch](factory-events/replay.md#source-switch)): `old`,
`factory.events` through plain `dev-query`, or `new`, the `factory.event_log` view through
`dev-query --factory` (named columns only, never the `data` jsonb). `--source` beats
`CALLUM_FLOW_FACTORY_STATE_SOURCE`; the default is `shadow`, which prints the old answer, exits as the old read
does and records how the new read differed in `factory/.shadow/factory-state.jsonl` under the events folder. A
failing or refused new read is only a record (`new_error`). `nomistakes.runs` and `factory.workers_status` come
from the same place whichever store is chosen, with the same `n/a` handling.

Both reads fill one event shape (type, issue, device, time, PR, branch, the transition's state fields, the
claim's lease, the closing reason) and one derivation runs over it. On the new side `requeued` is
`reclaimed`, `claim_renewed` is `renewed`, `finding_handled` is `verdict`, `loop_entry` and `loop_passes` are the
loop's bookkeeping; `gate_run`, `wind_down`, `reviewed`, `intervention`, `usage`, `untrusted_stripped`,
`test_weakened`, `claim_lost` and `shadow_read` are ignored by name.

What the shadow comparison leaves out, because the two reports differ there by construction and nowhere else:

- coverage event counts and times (`coverage.events`, `coverage.last_event_at`, `devices[].events`,
  `devices[].last_event_at`): the new store holds no line of the skipped old states and holds new-only types;
- the v1 `run` id of an issue: no new event carries a `run_id`;
- an abandoned final's free-text detail: the old note is free text and the new `reason` an enum, so
  `abandoned (...)` is compared as `abandoned`.
