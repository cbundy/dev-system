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
                          [--rule S1..S5=<minutes>]... [--github on|off]
```

Exit 0 ok, 2 bad arguments, 1 a required source (`factory.events`, `nomistakes.runs`) that cannot be
read. An optional source (`factory.workers_status`, GitHub) that is missing shows as `n/a: <reason>`.

## Stages

An issue is in exactly one stage. `stuck` is a flag on a stage, not a stage.

| Stage | Meaning |
| --- | --- |
| `queued` | latest decision event is `ready` or `reclaimed`; no pipeline run in progress |
| `designing` | `claimed`, `briefed` or `design_routed`, with no delegation or run since |
| `implementing` | `delegated` with no run yet, or the latest run ended without a PR to merge (failed, cancelled, completed with no PR, PR closed) |
| `in pipeline` | the latest run is running and not waiting on anyone |
| `parked` | the latest run is running and waiting on an agent or the owner (`awaiting_agent_since` set) |
| `ready to merge` | the latest run completed and its PR is open |
| `merged` | a `merged` event, or the run's `pr_state` is `merged`. Not final: it stays visible until GitHub closes the issue |
| `closed without merge` | `closed` or `abandoned` with no merge |

Only `closed` and `abandoned` end an issue's life in the view. A `merged` issue that is later `closed`
leaves the live list and shows under "recently ended" (24 hours from `--at`) as `merged`. A new
`claimed` after a `closed` or `merged` event starts a new life.

## Source precedence

Highest first. A lower source never overrides a higher one.

1. GitHub closure: a `closed` event from the sweep, or the live GitHub read (the tool reads GitHub
   through `callum-flow-issue-read`: open or closed, labels, the claim comment).
2. `merged` and `abandoned` events.
3. Pipeline facts from the `nomistakes.runs` mirror: start, status, parked, PR. A run belongs to an
   issue by the one definition in [metrics.md](metrics.md#linking-pipeline-runs-to-issues), copied
   verbatim into the tool's SQL (a test fails if the copies drift). The agent-logged `run_started`,
   `parked`, `merge_ready`, `failed`, `head_mismatch`, `conflict` and `ci_stalled` events never set a
   stage; when the mirror has no run they only appear as an `event-only` hint. A `failed` replayed after
   `merged` or `closed` (#344) is therefore ignored.
4. Factory decisions: `ready`, `claimed`, `briefed`, `design_routed`, `delegated`, `reclaimed`.
5. Liveness from `factory.workers_status` (`n/a` until the worker heartbeat table, #339, is deployed).

A live run (in pipeline, parked, ready to merge) decides the stage. When the latest run has ended and
a newer decision event exists, the decision wins (a re-delegated or reopened issue).

GitHub is read live, so for a past `--at` its facts are not as of that time; the output says so. Use
`--github off` for a database-only view.

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
| S1 | `designing` for more than the threshold | 240 min (2 x the claim lease) |
| S2 | `implementing` with no run in progress for more than the threshold | 60 min |
| S3 | `parked` for more than the threshold | 30 min |
| S4 | `ready to merge` for more than the threshold | 30 min |
| S5 | `in pipeline` with no run `updated_at` for more than the threshold | 30 min |
| S6 | the holder's worker is `stale` or `stopped` while the issue is live | `n/a` until #339 |

This replaces the hardcoded 4 hour stuck query that `metrics.md` used to carry.

## Output

Per repo, each live issue: stage, detail, time in stage, holder device (the device of the latest
`claimed`), run ID, PR, the stuck rule, `source` (`mirror`, `event` or `github`) and `flags`. Flags are
disagreements between sources and never change the stage: a `ready` or `In development` label that does
not fit the stage, a GitHub claim comment held by another device than the events say, a GitHub state
that could not be read. Also per repo: recently ended issues, `other_runs` (running runs on a branch
with no issue number), and coverage. Across repos: the stuck list, and the workers section.

An open issue labelled `ready` or `In development` that the database has never seen is listed with
source `github` as `queued` or `implementing`, so a missing event never hides work.

## Coverage

A gap is named, never shown as idle.

| Class | Meaning |
| --- | --- |
| `full` | the repo has events and mirrored runs |
| `pipeline only` | runs but no events: claims, delegation and queue state are unknown |
| `events only` | events but no runs: pipeline stages are only what agents logged |
| `none` | nothing in the database |

Per repo the report also gives the last event and last run update, each device's event count and last
event, the number of live issues by source, and whether a heartbeat exists (`n/a` until #339). Known
gaps in the data: labels and claim comments never reach the event log (hence the live GitHub read), and
claim-lease renewals are not logged.

## Worked examples

One per fixture; the exact output is the fixture's `.expected.json`. Times are minutes before
`--at` = 2026-10-10T12:00Z.

- `closed-outside`: #10 had a running run, #11 was claimed, #12 was `ready` then `claimed`; the sweep
  logged `closed` for each, and #14 was `abandoned` although a run's PR had merged. None is live; all show `closed without merge` under recently ended. #13 was
  closed 8 days ago and is not shown.
- `missing-run-started`: #20, #21 and #22 were claimed and delegated and have no `run_started`. The
  mirror places them: a running run gives `in pipeline`, a completed run with an open PR gives
  `ready to merge`, a completed run whose PR is merged gives `merged`.
- `replayed-events`: #30 and #31 got a `failed` replay after `merged`/`closed`, #32 after `merged`.
  They stay `merged` and `closed without merge`; no `event-only` hint is shown for a merged issue.
- `pipeline-only`: `acme/gadgets` has runs and no events. Coverage is `pipeline only`; the running and
  the parked run show; the old merged run does not; a running run on `chore/release-1.0` is under
  `other_runs`.
- `split-parent`: #40 was claimed 300 minutes ago and never delegated: `designing`, S1 trips. #41 is
  `queued`, #42 is `designing` for 30 minutes.
- `parked`: #50 has waited 45 minutes (S3 trips), #51 5 minutes.
- `stuck-rules`: #70 delegated 120 minutes ago with no run (S2), #71 ready to merge for 45 (S4), #72
  in pipeline with no run update for 40 (S5), #73 whose last run failed 70 minutes ago (S2).
- `point-in-time-early` and `point-in-time-late`: run `r60` finished 10 minutes before the late
  `--at`. At the early `--at` (30 minutes before) the run row is newer than `--at`, so #60 is
  `in pipeline`, marked approximate; at the late one it is `ready to merge`.
- `github`: #80 is closed on GitHub, so it is `closed without merge` with source `github` although the
  events say `delegated`. #82 is `queued` but labelled `In development`, #84 is `designing` without
  that label, #81's claim comment names another device, #86's GitHub state could not be read, #83 is
  `merged` and still open (kept visible), #90 and #91 carry a label and are unknown to the database.
