# Factory metrics

The factory event log answers the questions below, plus the waste measures at the end. Events are
written by `callum-flow-event` and shipped by `factory-event-push-loop` into the factory database
(see [Where events live](factory-events/README.md#where-events-live)). Every saved query here reads
the view `factory.event_log`, or for the workers `factory.workers_status` and
`factory.worker_samples`; none reads the old `factory.events` table or the `nomistakes` mirror. The old log and `factory.events` get no
new rows since the cutover ([#1143](https://github.com/cbundy/dev-system/issues/1143)); the old table holds
only the history before it.

Run the queries with `dev-query --factory` (see "dev-query" in `images/base/README.md`), e.g.
`dev-query --factory -c '<sql>'` or the SQL on stdin, with `-v NAME=VALUE` for the `:'NAME'`
variables. It connects to the factory database read-only and handles the TLS root-cert and
secret-masking details. To run by hand with `psql` instead, you need the reader role's URL and, for
`sslmode=verify-ca`/`verify-full` with a private CA, `PGSSLROOTCERT`.

**The view.** `factory.event_log` has one row per event: the envelope columns (`ts`, `type`,
`type_version`, `repo`, `device`, `actor`, `session_id`, `issue`, `event_id`, and the four version
columns below) and `device_seq`, plus one column for each payload field that the schemas mark
`"x-column": true`. A column is null for a type that lacks the field. The types, their fields and
which of them are columns are in [factory-events/REFERENCE.md](factory-events/REFERENCE.md). Rows
are unique on `event_id` (a UUID the writer makes locally); `issue` joins to GitHub, and to Claude
cost and token metrics through the `issue` and `device` resource attributes the orchestrator sets on
sub-agents.

**Reading rules** (from [Reading events](factory-events/README.md#reading-events)):

- Count a retried write once. Each type names its key: `transition` is one per `(issue, life, seq)`,
  `reviewed` one per `(issue, round, patch)`, `intervention` one per `(issue, who, cause, fact)`
  (a hand-recorded `rescue` has no fact, so each row counts).
- Time a transition by `seq_at`, not `ts`: one logged again after a re-claim keeps its `seq_at`.
- Pick types by name. The queries never exclude "noise" types, so a new type cannot change an answer.
- Percentiles and medians are not SQL: take them in code from the rows a query gives. The shared
  queries also use no `@>` and no `DISTINCT ON` (a window function with `row_number() ... = 1` does
  the job).

Types these queries read, besides the stages `ready`, `claimed`, `transition` (the loop's record,
whose `to_state` is the issue's state: `queued`, `designing`, `building`, `reviewing`, `fixing`,
`merge-queue`, `parked`, `waiting` or `closed`), `merged`, `abandoned` and `requeued`:

- `closed` is logged by `callum-flow-sweep` (actor `sweep`) for issues closed outside the factory;
  the [factory event log reference](../images/base/README.md#factory-event-log) defines which issues
  it checks. Its `reason` is GitHub's close reason verbatim (`completed`, `not_planned` or
  `duplicate`; null when GitHub gives none). It releases a claim like `merged` does, but throughput
  and lead-time queries keep counting `merged` only. Two devices sweeping before either has pushed
  can both log it, so count identical consecutive rows once.
- `requeued` is a claim given back to the queue: the lease ran out (`reason` `lease-expired`) or the
  loop's reconcile found no live work behind it (`reason` `reconcile`). `abandoned` ends the issue
  for the factory; its `reason` is `dropped`, `split`, `triage`, `reconcile`, `rejected` (the lives
  cap was reached and the issue is labelled `factory:rejected`) or `other`.
- `reviewed`: one review result, with `verdict` (`approve`, `changes` or `unknown`), `round` and
  `patch`. `finding_handled`: a fixer's disposition of one finding, `outcome` `fixed` or `declined`
  (actor `fixer`). `intervention`: someone had to step in that the plan did not foresee, with `who`
  (`person` or `loop`), `cause` (a code of [v2 SPEC 7.2](factory-loop/v2/SPEC.md#72-interventions)),
  `life` and `fact`; `issue` is null for a fleet-level one. These three are never a stage and never
  progress, and never decide whether an issue is final.
- `loop_entry` and `loop_passes` are the factory loop's own bookkeeping
  ([DECISIONS D-09](factory-loop/DECISIONS.md)): agent starts and ends, judgment wakes and their
  answers, and a pass summary once a minute. They are never a stage and never progress: no query here
  counts them as an issue event, and `callum-flow-factory-state` and `heartbeat-state` ignore them.
  Only "alive" in the waiting split counts any row of a device, `usage` and these included, since a
  loop that logs is a device at work.
- `claim_lost` is logged by `callum-flow-claim` on exit 3 (`holder` says who holds the issue, `race`
  whether both devices claimed at once). `claim_renewed` is the lease heartbeat, not progress.
  `test_weakened` is one flagged commit of a merged PR. `implementer_routed` is the model chosen for
  a build and `designer_routed` the model chosen for a design (reason `hash`, `label` or `fallback`).

The four version columns (`base_image`, `dev_image`, `template_version`, `plugin_version`: what
`dev-version --json` calls the running base image, dev image, Coder template version and callum-flow
plugin version) are filled for events written by base image 2.26.0 and later; earlier rows are null.
To compare releases, filter on them:

```sql
select plugin_version, count(*) from factory.event_log
where type = 'merged' and base_image = '2.26.0' group by plugin_version;
```

Subscribe to new events with `LISTEN factory_events`: each insert notifies a JSON payload with
`event_id`, `device`, `repo`, `issue` and `type`.

## Data coverage

Check coverage before quoting any window, and never extrapolate before it.

- `factory.event_log` starts at 2026-10-16T02:00Z, where the owner started the replay of the old
  log into the factory database ([replay.md](factory-events/replay.md)). Earlier history is only in
  the old `factory.events` table, which these queries do not read.
- Per device and repo, the earliest and latest row:
  `select device, min(ts), max(ts) from factory.event_log where repo = '<owner/name>' group by device`.
- Per regime, the rows by the kind of run that wrote them:
  `select regime, count(*) from factory.event_log where repo = '<owner/name>' group by regime`.
  A null regime means an older row or an unset regime (see
  [Regime](factory-events/README.md#reading-events)).
- A device whose container is stale (older than the base image that ships the push loops) pushes
  nothing, so a missing device means missing data, not zero work.

## 1. Lead time by stage

Per issue, the time between the first occurrence of each stage on the way to a merge: `ready`,
`claimed`, the first `transition` to building, to reviewing and to merge-queue (timed by `seq_at`),
and `merged`. `ready` can repeat when a watcher restarts with a stale `--known`, so the query uses the
first one per issue. The columns are `waiting_for_claim` (ready to claimed), `design` (claimed to
building), `implementation` (building to reviewing), `review` (reviewing to merge-queue),
`waiting_for_merge` (merge-queue to merged) and `total` (ready to merged). A stage the issue never
reached gives NULL. The loop's transitions come within two minutes of the old stage lines, so a stage
time can differ from an answer given from the old log by up to 120 seconds.

```sql
WITH stages AS (
  SELECT repo, issue, type AS stage, min(ts) AS at_ts
  FROM factory.event_log
  WHERE issue IS NOT NULL AND type IN ('ready', 'claimed', 'merged')
  GROUP BY repo, issue, type
  UNION ALL
  SELECT repo, issue, to_state, min(seq_at)
  FROM factory.event_log
  WHERE issue IS NOT NULL AND type = 'transition' AND to_state IN ('building', 'reviewing', 'merge-queue')
  GROUP BY repo, issue, to_state
)
SELECT repo, issue,
  min(at_ts) FILTER (WHERE stage = 'claimed')     - min(at_ts) FILTER (WHERE stage = 'ready')       AS waiting_for_claim,
  min(at_ts) FILTER (WHERE stage = 'building')    - min(at_ts) FILTER (WHERE stage = 'claimed')     AS design,
  min(at_ts) FILTER (WHERE stage = 'reviewing')   - min(at_ts) FILTER (WHERE stage = 'building')    AS implementation,
  min(at_ts) FILTER (WHERE stage = 'merge-queue') - min(at_ts) FILTER (WHERE stage = 'reviewing')   AS review,
  min(at_ts) FILTER (WHERE stage = 'merged')      - min(at_ts) FILTER (WHERE stage = 'merge-queue') AS waiting_for_merge,
  min(at_ts) FILTER (WHERE stage = 'merged')      - min(at_ts) FILTER (WHERE stage = 'ready')       AS total
FROM stages
GROUP BY repo, issue
HAVING bool_or(stage = 'merged')
ORDER BY min(at_ts) FILTER (WHERE stage = 'merged') DESC;
```

## 2. First-pass gate pass rate

The share of issues whose first trip through review went green with no setback: the first
`transition` to merge-queue (green) comes before the first `transition` to fixing (setback).

```sql
WITH per_issue AS (
  SELECT repo, issue,
    min(seq_at) FILTER (WHERE type = 'transition' AND to_state = 'merge-queue') AS first_green,
    min(seq_at) FILTER (WHERE type = 'transition' AND to_state = 'fixing')      AS first_setback
  FROM factory.event_log
  WHERE issue IS NOT NULL
  GROUP BY repo, issue
)
SELECT repo,
  count(*) FILTER (WHERE first_green IS NOT NULL)                                             AS reached_green,
  count(*) FILTER (WHERE first_green IS NOT NULL
                   AND (first_setback IS NULL OR first_setback > first_green))                AS first_pass,
  round(100.0 * count(*) FILTER (WHERE first_green IS NOT NULL
                                 AND (first_setback IS NULL OR first_setback > first_green))
        / nullif(count(*) FILTER (WHERE first_green IS NOT NULL), 0), 1)                      AS first_pass_pct
FROM per_issue
GROUP BY repo;
```

## 2b. Gate waits

How long the stop gate waited for a turn, and how long it ran, per gate run. The loop writes one
`gate_run` event for each `gate-pass`, `gate-fail` and `gate-unknown` line of the workspace
companion (`rules-gates.ts`, v2 SPEC 10.6). `wait_ms` is the time before it got a turn plus the time it waited for one of the container's
gate slots (v2 SPEC 10.6; 0 when it took both at once or there is no limit), `run_ms` the time the commands ran (0 when they never
did), `queued_behind` how many gates held a turn or waited ahead when it asked, `concurrency` the
limit it ran under (null: none), and `started_at` when it asked for its turn. A retried write can
repeat an event, so each run counts once per (issue, life, seq, started_at). The query reads the
columns migration 0002 lifted into `factory.event_log` and gives one row per run. There are no
rows before a loop with this rule has run.

How often agents' own gate-command runs (`npm test` run by an agent) waited for the container's gate
slots or were refused by them (the second command gives the per-day counts of runs, waits and refusals). The wrapper writes an `agent-gate` line to the companion's log
(`<loop dir>/companion.jsonl`) when each ends or is refused; they are not events, so read the file:

```sh
jq -c 'select(.cause == "agent-gate") | {at, issue, command, waitMs, refused, ms}' <loop dir>/companion.jsonl
jq -rs '[.[] | select(.cause == "agent-gate")] | group_by(.at[:10])[] | {day: .[0].at[:10], runs: length, waited: map(select(.waitMs > 1000)) | length, refused: map(select(.refused)) | length}' <loop dir>/companion.jsonl
```

A stop gate's own wait for a container slot is `slotWaitMs` on its settling line, also counted in
`waitMs`.

A pass row can carry `flaky` (and, when true, `failed_tests` and `failed_at` of the fail it followed)
and a fail row `failed_tests`; section 2d reads them.

Take the p50 and p95 of `wait_ms` and `run_ms` per `day` in code (docs/factory-events/README.md:
percentiles and medians are not SQL); a count and a mean per day are safe in SQL.

```sql
SELECT repo, issue, life, seq, started_at, started_at::date AS day,
  min(result)         AS result,
  min(wait_ms)        AS wait_ms,
  min(run_ms)         AS run_ms,
  min(concurrency)    AS concurrency,
  min(queued_behind)  AS queued_behind
FROM factory.event_log
WHERE type = 'gate_run'
GROUP BY repo, issue, life, seq, started_at
ORDER BY started_at DESC;
```

How often the stop gate hook itself failed or was cut off (the engine gives a hook 10 s of budget
that host calls pause, v2 SPEC 10.6). Every `gate-unknown` line is an `intervention` with cause
`gate-unknown`; a cap wait or a gate that could not run also gives a `gate_run` with result
`unknown`, but the hook's own `.catch` line has no `waitMs` and gives none. So per day, the excess
of the first count over the second is the hook failures and cut-offs; its reason (the
intervention's detail) reads `the stop gate hook failed (...)`, with the engine's error.

```sql
SELECT repo, day, sum(unknowns) AS gate_unknown_interventions, sum(runs) AS gate_run_unknown,
  sum(unknowns) - sum(runs) AS hook_failures
FROM (
  SELECT repo, ts::date AS day, count(*) AS unknowns, 0 AS runs
  FROM factory.event_log WHERE type = 'intervention' AND cause = 'gate-unknown'
  GROUP BY repo, ts::date
  UNION ALL
  SELECT repo, ts::date, 0, count(DISTINCT (issue, life, seq, started_at))
  FROM factory.event_log WHERE type = 'gate_run' AND result = 'unknown'
  GROUP BY repo, ts::date
) x
GROUP BY repo, day
ORDER BY repo, day DESC;
```

How often a restart cut a stop gate, and what became of it (v2 SPEC 10.6). The companion re-runs
a cut gate when its slot's marker still names the attempt (`gate-rerun`) and gives it up
otherwise (`gate-cut`); each is an `intervention` with that cause. A re-run's outcome is the first
`gate_run` of the same issue and life that started after that row. A re-run that failed ends the
held step lost, which shows as a `free:load` intervention. So per repo and day: the re-runs, the
cuts, and the re-runs by outcome (no outcome yet shows as NULL).

```sql
SELECT i.repo, i.ts::date AS day, i.cause, g.result, count(*) AS n
FROM factory.event_log i
LEFT JOIN LATERAL (
  SELECT result FROM factory.event_log r
  WHERE r.type = 'gate_run' AND r.repo = i.repo AND r.issue = i.issue AND r.life = i.life
    AND r.started_at > i.ts AND i.cause = 'gate-rerun'
  ORDER BY r.started_at LIMIT 1
) g ON true
WHERE i.type = 'intervention' AND i.cause IN ('gate-rerun', 'gate-cut')
GROUP BY i.repo, i.ts::date, i.cause, g.result
ORDER BY i.repo, day DESC, i.cause;
```

Writer steps that ended before their gate (v2 SPEC 10.8). The loop ends a gated build or fix step
only on that attempt's settling gate line, so after the release that added the rule every row's
`hold_ms` is zero or more, and `ended_early` is false. A row with `ended_early` true is a step
that closed while its stop gate still ran or was about to. It joins the done `loop_entry` of a
build or fix step (its key carries the life and seq) to the `gate_run` events of the same issue,
life and seq that started at or after the step's `started_at`; a gate's end is its `started_at`
plus `wait_ms` plus `run_ms`. Count `ended_early` per `day` in code, and take the p50 and p95 of
`hold_ms` (what the hold added) there too; steps with no gate run give no row.

```sql
WITH steps AS (
  SELECT repo, issue, key,
    substring(key from '^i[0-9]+/l([0-9a-z]+)/s[0-9]+/(?:build|fix)/a[0-9]+$')      AS life,
    substring(key from '^i[0-9]+/l[0-9a-z]+/s([0-9]+)/(?:build|fix)/a[0-9]+$')::int AS seq,
    min(started_at) AS started_at, min(ended_at) AS ended_at
  FROM factory.event_log
  WHERE type = 'loop_entry' AND kind = 'agent-step' AND status = 'done'
    AND key ~ '^i[0-9]+/l[0-9a-z]+/s[0-9]+/(build|fix)/a[0-9]+$'
  GROUP BY repo, issue, key
),
gates AS (
  SELECT repo, issue, life, seq, started_at,
    started_at + (min(wait_ms) + min(run_ms)) * interval '1 millisecond' AS gate_end
  FROM factory.event_log
  WHERE type = 'gate_run'
  GROUP BY repo, issue, life, seq, started_at
)
SELECT s.repo, s.issue, s.key, s.ended_at::date AS day, s.ended_at, max(g.gate_end) AS last_gate_end,
  max(g.gate_end) > s.ended_at AS ended_early,
  round(extract(epoch FROM s.ended_at - max(g.gate_end)) * 1000)::bigint AS hold_ms
FROM steps s
JOIN gates g ON g.repo = s.repo AND g.issue = s.issue AND g.life = s.life AND g.seq = s.seq
  AND g.started_at >= s.started_at
WHERE s.ended_at IS NOT NULL
GROUP BY s.repo, s.issue, s.key, s.ended_at
ORDER BY s.ended_at DESC;
```

## 2c. Wind-downs

How long a stop of the loop waited for running steps, and what the cap cost. The loop writes one
`wind_down` event per stop, not per issue (`wind_down.v1.json`). `requested_at` is when the stop
was asked for, `stopped_at` when the loop stopped, `waited_ms` the wait against `cap_ms`, and
`outcome` how it ended (`idle`, `cap`, `now`, `off`; with `off` the stop is at once and `waited_ms`
is 0). `cut_at_stop` counts the steps still running that were cut, and `cut_at_stop_keys` lists
their loop keys. A retried write can repeat an event, so each stop counts once per (repo, device,
requested_at). The queries read the columns migration 0004 lifted into `factory.event_log` and
take `-v repo=... -v since=...`. There are no rows until the producer (#842) ships.

The median and p90 of `waited_ms` come from (a) in code (nearest rank), not from SQL.

(a) One row per stop:

```sql
SELECT repo, device, requested_at,
  min(stopped_at)    AS stopped_at,
  min(outcome)       AS outcome,
  min(waited_ms)     AS waited_ms,
  min(cap_ms)        AS cap_ms,
  min(cut_at_stop)   AS cut_at_stop,
  min(trigger)       AS trigger
FROM factory.event_log
WHERE type = 'wind_down' AND repo = :'repo' AND requested_at >= :'since'::timestamptz
GROUP BY repo, device, requested_at
ORDER BY requested_at DESC;
```

(b) A summary per repo: stops, the share that hit the cap, and the mean steps cut per stop:

```sql
WITH stops AS (
  SELECT repo, device, requested_at,
    min(outcome) AS outcome, min(cut_at_stop) AS cut_at_stop
  FROM factory.event_log
  WHERE type = 'wind_down' AND repo = :'repo' AND requested_at >= :'since'::timestamptz
  GROUP BY repo, device, requested_at
)
SELECT repo,
  count(*)                                                        AS stops,
  round(count(*) FILTER (WHERE outcome = 'cap')::numeric / count(*), 3) AS cap_share,
  round(avg(cut_at_stop), 2)                                      AS mean_cut_per_stop
FROM stops
GROUP BY repo;
```

(c) Each cut step and its re-run: the first `transition` after `stopped_at` with the same repo,
issue, life and step. `rerun_via` `free:load` with table row `U1` is the free re-run (v2 SPEC 5.1,
docs/factory-loop/v2/SPEC.md:528, 731-733). Any other via is the cost of the cap: the attempt's
free re-run was already spent. Null means no re-run yet. A seq key
(`i<N>/l<life>/s<seq>/<step>/a<n>`) and a review key (`i<N>/l<life>/review/<patch7>/r<round>/a<n>`)
both parse; a review key's step is `review`.

```sql
WITH stops AS (
  SELECT repo, device, requested_at,
    min(stopped_at) AS stopped_at, min(cut_at_stop_keys::text)::jsonb AS keys
  FROM factory.event_log
  WHERE type = 'wind_down' AND repo = :'repo' AND requested_at >= :'since'::timestamptz
  GROUP BY repo, device, requested_at
), cuts AS (
  SELECT s.repo, s.device, s.requested_at, s.stopped_at, k.key,
    substr(split_part(k.key, '/', 1), 2)::int AS issue,
    substr(split_part(k.key, '/', 2), 2)      AS life,
    CASE WHEN split_part(k.key, '/', 3) = 'review' THEN 'review'
         ELSE split_part(k.key, '/', 4) END   AS step
  FROM stops s, jsonb_array_elements_text(s.keys) AS k(key)
), first_after AS (
  SELECT c.*, (SELECT min(t.seq_at) FROM factory.event_log t
               WHERE t.type = 'transition' AND t.repo = c.repo AND t.issue = c.issue
                 AND t.life = c.life AND t.step = c.step AND t.seq_at > c.stopped_at) AS rerun_at
  FROM cuts c
)
SELECT f.repo, f.requested_at, f.key, f.issue, f.life, f.step, f.rerun_at,
  min(t.via) AS rerun_via, min(t.table_row) AS table_row
FROM first_after f
LEFT JOIN factory.event_log t
  ON t.type = 'transition' AND t.repo = f.repo AND t.issue = f.issue
 AND t.life = f.life AND t.step = f.step AND t.seq_at = f.rerun_at
GROUP BY f.repo, f.device, f.requested_at, f.key, f.issue, f.life, f.step, f.rerun_at
ORDER BY f.requested_at DESC, f.key;
```

(d) Stops by trigger (`restart-self` is the loop's own restart for an update, `coder-stop` a Coder
stop): the count, the cap share and the mean steps cut. It answers whether the loop's own restarts
wind down like Coder stops and whether the cap is enough for them:

```sql
WITH stops AS (
  SELECT repo, device, requested_at,
    min(trigger) AS trigger, min(outcome) AS outcome, min(cut_at_stop) AS cut_at_stop
  FROM factory.event_log
  WHERE type = 'wind_down' AND repo = :'repo' AND requested_at >= :'since'::timestamptz
  GROUP BY repo, device, requested_at
)
SELECT repo, trigger,
  count(*)                                                        AS stops,
  round(count(*) FILTER (WHERE outcome = 'cap')::numeric / count(*), 3) AS cap_share,
  round(avg(cut_at_stop), 2)                                      AS mean_cut_per_stop
FROM stops
GROUP BY repo, trigger
ORDER BY repo, trigger;
```

## 2d. Flaky tests

Which tests passed on a re-run of the same code, how often, and where. Two events carry it, both
from the loop. A `gate_run` pass row has `flaky` true when the run just before it, in the same issue
and life, failed on the same head and both slots were clean; `failed_tests` then holds the names from
the fail before it and `failed_at` when that run started (`gate_run.v1.json`). A `ci-rerun`
`intervention` row with `flaky` true records the re-run's result as a second row for the same fact, so
section 9 still counts the fact once; its `failed_jobs` and `failed_tests` name what failed
(`intervention.v1.json`). A retried write can repeat a row, so a gate flake counts once per (issue,
life, seq, started_at) and a CI flake once per (issue, fact). A row with `flaky` false is not a flake.
The queries read the columns migration 0011 lifted into `factory.event_log` and take
`-v repo=... -v since=...`; `since` filters on when the flake passed. There are no gate rows until
its producer (#1026) ships; the CI rows come from the loop's flake rule (v2 SPEC 8.5).

The first query gives one row per flake per test. `source` is `gate` or `ci`; `job` is null for the
gate and the failed jobs for CI; `test` is null when no name was recorded; `failed_at` is the gate's
`failed_at`, or for CI the time of the first `ci-rerun` row for the fact; `passed_at` is the flake
row's time. The second lists each test with its flake count, first and last flake and the issues it
hit.

```sql
-- one row per flake per test
WITH gate AS (
  -- a gate flake: the flaky pass row, once per (issue, life, seq, started_at) however often it was written
  SELECT repo, issue, life, seq, started_at, max(head) AS head,
    min(failed_at) AS failed_at, min(ts) AS passed_at,
    (array_agg(failed_tests ORDER BY ts, device, device_seq))[1] AS tests
  FROM factory.event_log
  WHERE type = 'gate_run' AND flaky = true AND repo = :'repo' AND ts >= :'since'
  GROUP BY repo, issue, life, seq, started_at
), first_rerun AS (
  SELECT repo, issue, coalesce(fact, event_id::text) AS fact, min(ts) AS rerun_at
  FROM factory.event_log
  WHERE type = 'intervention' AND cause = 'ci-rerun' AND repo = :'repo'
  GROUP BY repo, issue, coalesce(fact, event_id::text)
), ci AS (
  -- a CI flake: the ci-rerun row with flaky = true, once per (issue, fact)
  SELECT repo, issue, coalesce(fact, event_id::text) AS fact, max(life) AS life, max(head) AS head,
    min(ts) AS passed_at,
    (array_agg(failed_jobs ORDER BY ts, device, device_seq))[1] AS jobs,
    (array_agg(failed_tests ORDER BY ts, device, device_seq))[1] AS tests
  FROM factory.event_log
  WHERE type = 'intervention' AND cause = 'ci-rerun' AND flaky = true AND repo = :'repo' AND ts >= :'since'
  GROUP BY repo, issue, coalesce(fact, event_id::text)
), flakes AS (
  SELECT 'gate' AS source, repo, issue, life, head, NULL::text AS job, failed_at, passed_at,
    CASE WHEN jsonb_typeof(tests) = 'array' THEN tests ELSE '[]'::jsonb END AS tests
  FROM gate
  UNION ALL
  SELECT 'ci', c.repo, c.issue, c.life, c.head,
    (SELECT string_agg(j, ', ' ORDER BY j)
       FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.jobs) = 'array' THEN c.jobs ELSE '[]'::jsonb END) AS j),
    f.rerun_at, c.passed_at,
    CASE WHEN jsonb_typeof(c.tests) = 'array' THEN c.tests ELSE '[]'::jsonb END
  FROM ci c
  LEFT JOIN first_rerun f ON f.repo = c.repo AND f.issue IS NOT DISTINCT FROM c.issue AND f.fact = c.fact
)
SELECT f.source, f.repo, f.issue, f.life, f.head, f.job, t.test, f.failed_at, f.passed_at
FROM flakes f
LEFT JOIN LATERAL jsonb_array_elements_text(f.tests) AS t(test) ON true
ORDER BY f.passed_at DESC, f.source, f.issue, t.test;
```

```sql
-- each test per repo: how often it flaked, when, and in how many issues
WITH gate AS (
  -- a gate flake: the flaky pass row, once per (issue, life, seq, started_at) however often it was written
  SELECT repo, issue, life, seq, started_at, max(head) AS head,
    min(failed_at) AS failed_at, min(ts) AS passed_at,
    (array_agg(failed_tests ORDER BY ts, device, device_seq))[1] AS tests
  FROM factory.event_log
  WHERE type = 'gate_run' AND flaky = true AND repo = :'repo' AND ts >= :'since'
  GROUP BY repo, issue, life, seq, started_at
), first_rerun AS (
  SELECT repo, issue, coalesce(fact, event_id::text) AS fact, min(ts) AS rerun_at
  FROM factory.event_log
  WHERE type = 'intervention' AND cause = 'ci-rerun' AND repo = :'repo'
  GROUP BY repo, issue, coalesce(fact, event_id::text)
), ci AS (
  -- a CI flake: the ci-rerun row with flaky = true, once per (issue, fact)
  SELECT repo, issue, coalesce(fact, event_id::text) AS fact, max(life) AS life, max(head) AS head,
    min(ts) AS passed_at,
    (array_agg(failed_jobs ORDER BY ts, device, device_seq))[1] AS jobs,
    (array_agg(failed_tests ORDER BY ts, device, device_seq))[1] AS tests
  FROM factory.event_log
  WHERE type = 'intervention' AND cause = 'ci-rerun' AND flaky = true AND repo = :'repo' AND ts >= :'since'
  GROUP BY repo, issue, coalesce(fact, event_id::text)
), flakes AS (
  SELECT 'gate' AS source, repo, issue, life, head, NULL::text AS job, failed_at, passed_at,
    CASE WHEN jsonb_typeof(tests) = 'array' THEN tests ELSE '[]'::jsonb END AS tests
  FROM gate
  UNION ALL
  SELECT 'ci', c.repo, c.issue, c.life, c.head,
    (SELECT string_agg(j, ', ' ORDER BY j)
       FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.jobs) = 'array' THEN c.jobs ELSE '[]'::jsonb END) AS j),
    f.rerun_at, c.passed_at,
    CASE WHEN jsonb_typeof(c.tests) = 'array' THEN c.tests ELSE '[]'::jsonb END
  FROM ci c
  LEFT JOIN first_rerun f ON f.repo = c.repo AND f.issue IS NOT DISTINCT FROM c.issue AND f.fact = c.fact
)
SELECT f.repo, t.test, count(*) AS flakes, min(f.passed_at) AS first_flake, max(f.passed_at) AS last_flake,
  count(DISTINCT f.issue) AS issues
FROM flakes f
CROSS JOIN LATERAL jsonb_array_elements_text(f.tests) AS t(test)
GROUP BY f.repo, t.test
ORDER BY flakes DESC, last_flake DESC, t.test;
```

The flake bug rule (v2 SPEC 8.5, rule F1) files one bug for a test with at least `flakeBugMin`
flakes in the last `flakeWindowDays`, and comments on that bug for each later flake. It reads this
query: one row per flake per test, as the first query counts them, with the event id of the flake's
first row (the identity a bug's comment is keyed by), the test's name hashed (the first 16 hex digits
of its sha256, which the bug's marker carries) and the failed jobs of a CI flake. The loop runs it
with `-v repo=... -v since=...`, `since` being now minus `flakeWindowDays`. The loop's copy of the
query (`FLAKES_SQL` in `plugins/factory-loop/hooks/v2/sources-flakes.ts`) is held identical to this one
by `tests/metrics-flakes.test.js`.

```sql
-- the bug rule's read: one row per flake per test, with the event id and the test's hash
WITH gate AS (
  SELECT repo, issue, life, seq, started_at, max(head) AS head, min(ts) AS passed_at,
    (array_agg(event_id ORDER BY ts, device, device_seq))[1] AS event_id,
    (array_agg(failed_tests ORDER BY ts, device, device_seq))[1] AS tests
  FROM factory.event_log
  WHERE type = 'gate_run' AND flaky = true AND repo = :'repo' AND ts >= :'since'
  GROUP BY repo, issue, life, seq, started_at
), ci AS (
  SELECT repo, issue, coalesce(fact, event_id::text) AS fact, max(head) AS head, min(ts) AS passed_at,
    (array_agg(event_id ORDER BY ts, device, device_seq))[1] AS event_id,
    (array_agg(failed_jobs ORDER BY ts, device, device_seq))[1] AS jobs,
    (array_agg(failed_tests ORDER BY ts, device, device_seq))[1] AS tests
  FROM factory.event_log
  WHERE type = 'intervention' AND cause = 'ci-rerun' AND flaky = true AND repo = :'repo' AND ts >= :'since'
  GROUP BY repo, issue, coalesce(fact, event_id::text)
), flakes AS (
  SELECT 'gate' AS source, event_id, issue, head, passed_at, NULL::text AS job,
    CASE WHEN jsonb_typeof(tests) = 'array' THEN tests ELSE '[]'::jsonb END AS tests
  FROM gate
  UNION ALL
  SELECT 'ci', event_id, issue, head, passed_at,
    (SELECT string_agg(j, ', ' ORDER BY j)
       FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(jobs) = 'array' THEN jobs ELSE '[]'::jsonb END) AS j),
    CASE WHEN jsonb_typeof(tests) = 'array' THEN tests ELSE '[]'::jsonb END
  FROM ci
)
SELECT f.event_id, f.source, f.issue, f.head,
  to_char(f.passed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS passed_at, t.test, f.job,
  left(encode(sha256(convert_to(t.test, 'UTF8')), 'hex'), 16) AS hash
FROM flakes f
CROSS JOIN LATERAL jsonb_array_elements_text(f.tests) AS t(test)
ORDER BY f.passed_at, f.event_id, t.test;
```

The rule writes one `loop_entry` tell (`wake` `flake-bug`) for each bug it files. It carries the
decision (`ready`, or `held` when `flakeBugReadyCap` open flake bugs were already ready or in flight),
the test (`flake_test`), how many flakes the window held (`flakes`, `window_days`), the first of them
(`first_flake_at`) and the bug (`filed_issue`). The tell is written when the bug exists, and again as
it is delivered, so the queries below group by the bug. The first gives the time from a test's first
flake to its fix merging; the second, the daily summary, counts the bugs filed, readied, held, fixed
(closed or merged) and still open, and how often the cap held one. A bug closed without a merge
counts as fixed in the summary and has no row in the first.

```sql
-- time from a test's first flake to its fix merging, per flake bug
WITH bugs AS (
  SELECT repo, filed_issue, max(flake_test) AS flake_test, min(first_flake_at) AS first_flake,
    min(ts) AS filed_at, bool_or(decision = 'ready') AS readied
  FROM factory.event_log
  WHERE type = 'loop_entry' AND wake = 'flake-bug' AND filed_issue IS NOT NULL AND repo = :'repo' AND ts >= :'since'
  GROUP BY repo, filed_issue
)
SELECT b.filed_issue AS bug, b.flake_test, b.first_flake, b.filed_at, b.readied, m.merged_at,
  m.merged_at - b.first_flake AS first_flake_to_merge
FROM bugs b
LEFT JOIN LATERAL (
  SELECT min(ts) AS merged_at FROM factory.event_log
  WHERE type = 'merged' AND repo = b.repo AND issue = b.filed_issue
) m ON true
ORDER BY b.first_flake, b.filed_issue;
```

```sql
-- the daily summary: flake bugs filed, readied, held, fixed and still open
WITH bugs AS (
  SELECT repo, filed_issue, min(ts) AS filed_at,
    bool_or(decision = 'ready') AS readied, bool_or(decision = 'held') AS held
  FROM factory.event_log
  WHERE type = 'loop_entry' AND wake = 'flake-bug' AND filed_issue IS NOT NULL AND repo = :'repo'
  GROUP BY repo, filed_issue
), ended AS (
  SELECT repo, issue, min(ts) AS ended_at
  FROM factory.event_log
  WHERE type IN ('closed', 'merged') AND repo = :'repo' AND issue IS NOT NULL
  GROUP BY repo, issue
)
SELECT count(*) FILTER (WHERE b.filed_at >= :'since') AS filed,
  count(*) FILTER (WHERE b.filed_at >= :'since' AND b.readied) AS readied,
  count(*) FILTER (WHERE b.filed_at >= :'since' AND b.held) AS held,
  count(*) FILTER (WHERE e.ended_at >= :'since') AS fixed,
  count(*) FILTER (WHERE e.ended_at IS NULL) AS still_open
FROM bugs b
LEFT JOIN ended e ON e.repo = b.repo AND e.issue = b.filed_issue;
```

## 2e. Gate memory

How much memory a stop gate adds. The workspace companion reads the container's cgroup
(`memory.current`, `memory.max`) when a gate starts to run, every 5 s while it runs and once when
it ends, and writes the first reading, the highest one and the limit on the gate's settling line;
the loop copies them onto the `gate_run` event as `mem_start_bytes`, `mem_peak_bytes` and
`mem_limit_bytes` (left out when the cgroup could not be read, and on a gate that never got a
turn). The test hook `FACTORY_GATE_CGROUP_DIR` names another cgroup directory.

The reading is container-wide. At concurrency above 1 other gates run in the same container and
their memory overlaps this one's, so the query groups by `concurrency`: the `concurrency` 1 rows
are the nearest to one gate's own memory. This is the per-slot estimate the memory cap (#1127)
uses (`slotMemoryMiB: auto`: the p90, nearest rank, of `mem_peak_bytes - mem_start_bytes`, once at
least 3 runs are in the loop's 6-day companion window, else 3072 MiB). A retried write can repeat an event, so each run counts once per (issue, life, seq,
started_at). Take percentiles in code.

```sql
WITH runs AS (
  SELECT repo, issue, life, seq, started_at,
    min(concurrency) AS concurrency,
    min(mem_peak_bytes) - min(mem_start_bytes) AS added_bytes
  FROM factory.event_log
  WHERE type = 'gate_run' AND mem_start_bytes IS NOT NULL AND mem_peak_bytes IS NOT NULL
    AND started_at >= :'since'::timestamptz
  GROUP BY repo, issue, life, seq, started_at
)
SELECT repo, concurrency,
  count(*)                    AS runs,
  round(avg(added_bytes))     AS avg_added_bytes,
  max(added_bytes)            AS max_added_bytes
FROM runs
GROUP BY repo, concurrency
ORDER BY repo, concurrency;
```

The loop holds at most `min(maxInFlightIssues, ceiling)` issues, where the ceiling is
`max(1, floor((memory - memoryReserveMiB) / estimate))` (`memory`: the cgroup's `memory.max`, else
`/proc/meminfo` MemTotal, read once per process). Each pass line of the decision log carries
`cap: {effective, configured, ceiling, memoryBytes, estimateBytes, estimateSource}`
(`estimateSource`: `setting`, `measured` or `default`), so a held issue is told apart: the S1/W1 skip
text names `memory ceiling` only when the ceiling was the lower bound. When the configured cap is
above the ceiling the loop tells the owner once per pair (`loop_entry` wake `capacity`).

```sh
jq -c 'select(.cap != null) | {at, cap}' /persist/claude/factory-loop/<owner>__<name>/decisions-*.jsonl
jq -c 'select(.cap.ceiling != null and .cap.ceiling < .cap.configured) | {at, cap}' /persist/claude/factory-loop/<owner>__<name>/decisions-*.jsonl
```

## 3. Reviewer false-positive rate

`finding_handled` events carry the fixer's disposition of each review finding in `outcome`: `fixed`
(the finding was right) or `declined` (the finding was a false positive). The rate is
`declined / (fixed + declined)`.

```sql
SELECT repo,
  count(*) FILTER (WHERE outcome = 'fixed')    AS fixed,
  count(*) FILTER (WHERE outcome = 'declined') AS declined,
  round(100.0 * count(*) FILTER (WHERE outcome = 'declined')
        / nullif(count(*) FILTER (WHERE outcome IN ('fixed', 'declined')), 0), 1) AS false_positive_pct
FROM factory.event_log
WHERE type = 'finding_handled'
GROUP BY repo;
```

### Fix rounds with no new head

A fix round can end with no new head because a finding was fixed outside the branch (transition row
T17, via `unchanged`). This counts them per repo and week.

```sql
SELECT repo, date_trunc('week', seq_at) AS week, count(*) AS unchanged_fixes
FROM factory.event_log
WHERE type = 'transition' AND table_row = 'T17'
GROUP BY 1, 2 ORDER BY 2, 1;
```

### Fix rounds caused by other merges

A conflict, or red CI in the merge queue, is charged to its own cap (`conflictFixCap`) apart from the
PR's own fix rounds (v2 SPEC 8.6). This counts per repo and week the fix rounds other merges caused
(via `fix:conflict`, or `fix:ci` from the merge queue) and the parks at the conflict cap (via
`fix-cap:conflict`, or `fix-cap:ci` from the merge queue), to show whether the separate cap still
parks busy days.

```sql
SELECT repo, date_trunc('week', seq_at) AS week,
       count(*) FILTER (WHERE table_row = 'T9') AS conflict_rounds,
       count(*) FILTER (WHERE table_row = 'T10') AS conflict_cap_parks
FROM factory.event_log
WHERE type = 'transition'
  AND ((table_row = 'T9' AND (via = 'fix:conflict' OR (via = 'fix:ci' AND from_state = 'merge-queue')))
    OR (table_row = 'T10' AND (via = 'fix-cap:conflict' OR (via = 'fix-cap:ci' AND from_state = 'merge-queue'))))
GROUP BY 1, 2 ORDER BY 2, 1;
```

### Split children parked on their open decision

A split's not-ready child is claimed at once and parked on its decision (row S7, via `split-decision`).
Per such park this gives how long it waited for the owner and whether the next transition (the owner's
resume, P1) was followed by the designer's step (T1 to designing). `waited_seconds` is null while the
child still waits; `resumed_via` is the resume route (`unpark:label` or `unpark:op`). Take the count of rows
for how many children park, the median of `waited_seconds` for how long, and the share with `designing_at`
set for how many reach designing. It takes `-v repo=... -v since=...`.

```sql
WITH tr AS (
  SELECT repo, issue, life, seq, table_row, to_state, via, seq_at,
         lead(seq_at) OVER w AS next_at, lead(via) OVER w AS next_via,
         lead(table_row) OVER w AS next_row, lead(to_state, 2) OVER w AS then_state,
         lead(seq_at, 2) OVER w AS then_at
  FROM (SELECT l.repo, l.issue, l.life, l.seq, l.table_row, l.to_state, l.via, l.seq_at,
          row_number() OVER (PARTITION BY l.repo, l.issue, l.life, l.seq ORDER BY l.ts, l.device, l.device_seq) AS n
        FROM factory.event_log l
        WHERE l.type = 'transition' AND l.issue IS NOT NULL AND l.repo = :'repo') x
  WHERE n = 1
  WINDOW w AS (PARTITION BY repo, issue ORDER BY seq_at, seq)
)
SELECT repo, issue, seq_at AS parked_at, next_via AS resumed_via,
       extract(epoch FROM next_at - seq_at) AS waited_seconds,
       CASE WHEN then_state = 'designing' THEN then_at END AS designing_at
FROM tr
WHERE table_row = 'S7' AND via = 'split-decision' AND seq_at >= :'since'::timestamptz
ORDER BY seq_at DESC;
```

## 4. Merges per device

Merges that closed an issue. A `merged` event with no issue is left out: `callum-flow-sweep` logs a merge
to the default branch that no event recorded with no issue when the pull request's author is not trusted,
or when it closes none, and a sweep-logged hand merge (`actor = 'sweep'`, `by = 'hand'`, `recovered`) would
otherwise count as a merge of the factory and of the device that swept (cbundy/dev-system#752).

```sql
SELECT device, date_trunc('week', ts)::date AS week, count(DISTINCT (repo, issue)) AS merges
FROM factory.event_log
WHERE type = 'merged' AND issue IS NOT NULL
  AND NOT (actor = 'sweep' AND by = 'hand' AND coalesce(recovered, false))
GROUP BY device, week
ORDER BY week DESC, merges DESC;
```

## 5b. Tests deleted or weakened by auto-fixes

`callum-flow-merge` logs one `test_weakened` event per commit that `callum-flow-test-weakening`
flagged on a merged PR (a commit that deleted assertions, or added `--warn-only`, `|| true`, a
skip or `.only`, or commented an assertion out; cbundy/dev-system#314). The event has `commit`,
`restored` (true when a later commit put the test back), `kinds` and `files`. There is no step: the
no-mistakes step that made the commit is not carried over. `callum-flow-evaluate` reports the same
counts as its `test_weakened` section.

```sql
SELECT repo,
  count(*)                                AS commits,
  count(*) FILTER (WHERE restored = false) AS unrestored
FROM factory.event_log
WHERE type = 'test_weakened'
GROUP BY repo
ORDER BY unrestored DESC, commits DESC;
```

## 6. Double-claims, lost claim races and stuck issues

The two-device trial (cbundy/dev-system#222) asks whether two dispatchers ever hold one issue at
once. A **double-claim** is two devices with a live `claimed` on one issue and no `ready`,
`requeued`, `merged`, `abandoned` or `closed` between them. A **lost race** is a `claim_lost` event,
logged by `callum-flow-claim` on exit 3 (`holder` says who holds the issue): it proves the lanes
contended. An issue is **stuck** when it is claimed (a `claimed` after its last `ready`,
`requeued`, `merged`, `abandoned` or `closed`) and has had no event, other than `claim_lost`,
`claim_renewed` (a heartbeat is not progress), `loop_entry` and `loop_passes` (the factory loop's
bookkeeping), and `reviewed` and `intervention` (the factory loop v2's review results and step-ins),
for more than twice the claim lease (2 x 120 minutes by default, `CALLUM_FLOW_LEASE_MINUTES`).
`callum-flow-evaluate` applies exactly this test over a window. For the factory's state right now,
use `callum-flow-factory-state` ([factory-state.md](factory-state.md)): it has six stuck rules with
adjustable thresholds and puts GitHub closure first.

```sql
-- double-claims: one row per pair of overlapping claims
SELECT c2.repo, c2.issue, c1.device AS first_device, c2.device AS second_device, c2.ts AS at
FROM factory.event_log c2
JOIN factory.event_log c1
  ON c1.repo = c2.repo AND c1.issue = c2.issue AND c1.type = 'claimed'
 AND c1.device <> c2.device AND c1.ts < c2.ts
WHERE c2.type = 'claimed'
  AND NOT EXISTS (
    SELECT 1 FROM factory.event_log r
    WHERE r.repo = c2.repo AND r.issue = c2.issue
      AND r.type IN ('ready', 'requeued', 'merged', 'abandoned', 'closed')
      AND r.ts >= c1.ts AND r.ts <= c2.ts)
ORDER BY c2.ts;
```

```sql
-- lost races, and requeued leases, per device
SELECT device,
  count(*) FILTER (WHERE type = 'claim_lost') AS claim_lost,
  count(*) FILTER (WHERE type = 'requeued')   AS requeued
FROM factory.event_log
GROUP BY device;
```

### Claim order

S1 names the order a claim came from in its reason: `ready and unblocked (order: owner only)` or
`(order: owner priority)` for the owner's lists, else `(order: score <n>: <factor> <+/-points>, ...)`
(`score 0` when no factor scored). The factors are `priority-label`, `bug`, `unblocks`, `closes-epic`,
`nearly-closes-epic`, `epic-started`, `waiting` and `failed-lives`, and, only while `intakeStamp` is on and the issue has a stamp, `area-factory`, `needs-owner` and `overlap`. How many claims each order gave
per day, grouped by the owner tiers and `score`, and which factors put the issues first, from the
decision log (`/persist/claude/factory-loop/<owner>__<name>/decisions-*.jsonl`, per device); a loop
before the score reads `label priority` and `number`, and groups apart:

```sh
jq -rs '[.[] | . as $d | ($d.actions // [])[] | select(.rule == "S1" and (.reason | test("order:")))
  | {day: ($d.at | tostring | .[0:10]), order: (.reason | capture("order: (?<t>[^)]*)").t), issue}
  | .tier = (.order | if startswith("score") then "score" else . end)
  | .factors = (.order | if startswith("score") then ((capture("score -?[0-9]+: (?<f>.*)").f // "") | split(", ")) else [] end)]
  | group_by([.day, .tier])[] | "\(.[0].day) \(.[0].tier): \(length) \(map({issue, factors}) | @json)"' \
  /persist/claude/factory-loop/*/decisions-*.jsonl
```

Does a high score merge sooner, in fewer lives? The `claimed` event records the claim's `score` and
`factors` in the event's `data` (read from `factory.event_store`, as no `event_log` column lifts them; events from a loop before the score carry none and stay out). One row per scored
claim, with the seconds to its issue's next `merged` (null if none yet) and how many `claimed` events
the issue has (its lives). Bucket by `score`, then count, take the median of `claim_to_merge_s` and
the mean of `lives` in code (percentiles and medians are not SQL):

```sql
SELECT c.repo, c.issue, c.ts AS claimed_at, (s.data->>'score')::int AS score, s.data->'factors' AS factors,
  extract(epoch FROM (m.ts - c.ts)) AS claim_to_merge_s,
  count(*) OVER (PARTITION BY c.repo, c.issue) AS lives
FROM factory.event_log c
JOIN factory.event_store s ON s.event_id = c.event_id
LEFT JOIN LATERAL (
  SELECT min(ts) AS ts FROM factory.event_log
  WHERE type = 'merged' AND repo = c.repo AND issue = c.issue AND ts > c.ts
) m ON true
WHERE c.type = 'claimed' AND c.issue IS NOT NULL AND s.data->>'score' IS NOT NULL
ORDER BY c.ts;
```

Did the score change how long ready work waits for a claim? One row per claim with the seconds from
the issue's last `ready` to its `claimed` and the plugin version the claim ran under; take the median
per `plugin_version` in code and compare the versions before and after the release that brought the
score (an issue with no `ready` event drops out). The second query is the loop's mean pass time per
plugin version from `loop_passes`, weighted by passes, which should not move:

```sql
SELECT c.plugin_version, c.repo, c.issue, c.ts AS claimed_at,
  extract(epoch FROM (c.ts - r.ts)) AS time_to_claim_s
FROM factory.event_log c
JOIN LATERAL (
  SELECT max(ts) AS ts FROM factory.event_log
  WHERE type = 'ready' AND repo = c.repo AND issue = c.issue AND ts <= c.ts
) r ON r.ts IS NOT NULL
WHERE c.type = 'claimed' AND c.issue IS NOT NULL
ORDER BY c.ts;
```

```sql
SELECT plugin_version, sum(passes) AS passes, round(sum(mean_ms * passes)::numeric / sum(passes)) AS mean_pass_ms
FROM factory.event_log
WHERE type = 'loop_passes' AND passes > 0
GROUP BY plugin_version
ORDER BY min(ts);
```

Which claims did a stamp factor move, and by how much? One row per factor per day from the `claimed`
events' `factors`, with the claims it appeared in and its points (`area-factory`, `needs-owner`,
`overlap`; a stamp factor that scored 0 is not listed, so the count is claims it moved):

```sql
SELECT date_trunc('day', c.ts) AS day, f->>'name' AS factor, count(*) AS claims, sum((f->>'points')::int) AS points
FROM factory.event_log c
JOIN factory.event_store s ON s.event_id = c.event_id
CROSS JOIN LATERAL jsonb_array_elements(s.data->'factors') f
WHERE c.type = 'claimed' AND jsonb_typeof(s.data->'factors') = 'array'
  AND f->>'name' IN ('area-factory', 'needs-owner', 'overlap')
GROUP BY 1, 2
ORDER BY 1, 2;
```

### Intake stamp

These queries stay empty until the loop writes `intake_stamp` (one event per stamp attempt of one issue version; `outcome` is `ok`, `failed` or `dropped`).

Stamps per repo and day by `outcome`:

```sql
SELECT date_trunc('day', ts) AS day, repo, outcome, count(*) AS stamps
FROM factory.event_log
WHERE type = 'intake_stamp'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
```

The `area` mix of `ok` stamps:

```sql
SELECT repo, area, count(*) AS stamps
FROM factory.event_log
WHERE type = 'intake_stamp' AND outcome = 'ok'
GROUP BY 1, 2
ORDER BY 1, 3 DESC, 2;
```

The share of `ok` stamps with `needs_owner` true, per day:

```sql
SELECT date_trunc('day', ts) AS day, count(*) AS ok_stamps,
  count(*) FILTER (WHERE needs_owner) AS needs_owner,
  round(100.0 * count(*) FILTER (WHERE needs_owner) / count(*), 1) AS needs_owner_pct
FROM factory.event_log
WHERE type = 'intake_stamp' AND outcome = 'ok'
GROUP BY 1
ORDER BY 1;
```

How often the owner overrode a stamp label (a stamp whose `labels_kept` is not empty), over all stamps, per day:

```sql
SELECT date_trunc('day', ts) AS day, count(*) AS stamps,
  count(*) FILTER (WHERE jsonb_array_length(labels_kept) > 0) AS overridden,
  round(100.0 * count(*) FILTER (WHERE jsonb_array_length(labels_kept) > 0) / count(*), 1) AS overridden_pct
FROM factory.event_log
WHERE type = 'intake_stamp'
GROUP BY 1
ORDER BY 1;
```

The share of `claimed` events per day whose `factors` include `area-factory`, `needs-owner` or `overlap`. It counts claims and complements the per-factor query under "Claim order" (which lists points per factor); `factors` are read from `factory.event_store` as there:

```sql
SELECT date_trunc('day', c.ts) AS day, count(*) AS claims,
  count(*) FILTER (WHERE jsonb_typeof(s.data->'factors') = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(s.data->'factors') f
    WHERE f->>'name' IN ('area-factory', 'needs-owner', 'overlap'))) AS stamp_moved,
  round(100.0 * count(*) FILTER (WHERE jsonb_typeof(s.data->'factors') = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(s.data->'factors') f
    WHERE f->>'name' IN ('area-factory', 'needs-owner', 'overlap'))) / count(*), 1) AS stamp_moved_pct
FROM factory.event_log c
JOIN factory.event_store s ON s.event_id = c.event_id
WHERE c.type = 'claimed'
GROUP BY 1
ORDER BY 1;
```

### Split trackers closed by the loop

When a split child merges, the loop closes the split's parent (its tracker) once every sub-issue is closed, and
logs `closed` with reason `completed` for it. Each check, closed or not, is a `close-tracker` entry in the
loop's ledger with its outcome `{parent, closed, open}` and summary (`closing #139: ...` or `kept #139 open: #190 open`).
The split itself is an `abandoned` event with reason `split`; its `split_into` field (in `data` of
`factory.event_store`, not lifted) lists the children. Per split parent, the query takes the time the last child merged
(`last_merged_at`) and the time the loop closed the tracker (`closed_at`).
`closed_at - last_merged_at` is how long the tracker stayed open after its last child merged. A parent with
`all_merged` true and a null `closed_at` is the leftover case: every child merged but the tracker is still open (the
last child's rollout was `run-it` or `keep-open`, whose issue stays open at its merge so no check ran, or the owner
closed it as another reason). A parent with `all_merged` false is still waiting on a child.

```sql
WITH splits AS (
  SELECT s.repo, s.issue AS parent, s.ts AS split_at,
         (SELECT array_agg(c::int) FROM jsonb_array_elements_text(d.data -> 'split_into') AS c) AS children
  FROM factory.event_log s
  JOIN factory.event_store d ON d.event_id = s.event_id
  WHERE s.type = 'abandoned' AND s.reason = 'split' AND s.repo = :'repo' AND s.ts >= :'since'::timestamptz
),
kids AS (
  SELECT sp.repo, sp.parent, sp.split_at, c AS child,
         (SELECT min(m.ts) FROM factory.event_log m
           WHERE m.repo = sp.repo AND m.issue = c AND m.type = 'merged') AS merged_at
  FROM splits sp, unnest(sp.children) AS c
),
agg AS (
  SELECT repo, parent, split_at, count(*) AS children, count(merged_at) AS merged,
         count(merged_at) = count(*) AS all_merged, max(merged_at) AS last_merged_at
  FROM kids
  GROUP BY repo, parent, split_at
)
SELECT a.repo, a.parent, a.split_at, a.children, a.merged, a.all_merged, a.last_merged_at,
       c.ts AS closed_at, c.ts - a.last_merged_at AS open_after_last_merge
FROM agg a
LEFT JOIN LATERAL (
  SELECT min(ts) AS ts FROM factory.event_log c
  WHERE c.repo = a.repo AND c.issue = a.parent AND c.type = 'closed' AND c.reason = 'completed' AND c.ts > a.split_at
) c ON true
ORDER BY a.split_at DESC;
```

The leftover count is the rows with `all_merged AND closed_at IS NULL`.

### Queue snapshots

The loop writes a `queue_snapshot` after each claim pass when its view of the claim queue changed, and as a heartbeat when it did not: the candidates in rank order (first 50) with score, factors, whether the claim rule would take each and, if not, a `why` code, plus the owner's controls. These queries are empty until the loop writes them. The newest queue per repo, with its age in seconds (`candidates` is the JSON list, `rest` counts the candidates past 50 by `why`):

```sql
SELECT repo, taken_at, reason, considered, free_slots, candidates, rest,
  extract(epoch FROM (now() - taken_at)) AS age_s
FROM (
  SELECT repo, taken_at, reason, considered, free_slots, candidates, rest,
    row_number() OVER (PARTITION BY repo ORDER BY taken_at DESC, ts DESC) AS n
  FROM factory.event_log
  WHERE type = 'queue_snapshot'
) t
WHERE n = 1
ORDER BY repo;
```

Snapshots per repo and day by `reason`, with the queue changes they folded in (a quiet day is about 100 snapshots, at most about 1,440 plus claims):

```sql
SELECT repo, date_trunc('day', taken_at) AS day, reason, count(*) AS snapshots, sum(folded) AS folded
FROM factory.event_log
WHERE type = 'queue_snapshot' AND taken_at >= :'since'::timestamptz
GROUP BY repo, date_trunc('day', taken_at), reason
ORDER BY day, repo, reason;
```

Do claims follow the queue? For each scored `claimed` event (score read from `factory.event_store`, as in the Claim order block above), the newest `queue_snapshot` of the same repo at or before it, that issue's score in that snapshot's top 50, and whether the two match (null when the issue is not in the top 50 or no snapshot exists):

```sql
SELECT c.repo, c.issue, c.ts AS claimed_at, (s.data->>'score')::int AS claim_score,
  q.taken_at AS snapshot_at, q.snapshot_score,
  (s.data->>'score')::int = q.snapshot_score AS match
FROM factory.event_log c
JOIN factory.event_store s ON s.event_id = c.event_id
LEFT JOIN LATERAL (
  SELECT n.taken_at,
    (SELECT (e->>'score')::int FROM jsonb_array_elements(n.candidates) e WHERE (e->>'issue')::int = c.issue LIMIT 1) AS snapshot_score
  FROM factory.event_log n
  WHERE n.type = 'queue_snapshot' AND n.repo = c.repo AND n.taken_at <= c.ts
  ORDER BY n.taken_at DESC, n.ts DESC
  LIMIT 1
) q ON true
WHERE c.type = 'claimed' AND c.issue IS NOT NULL AND s.data->>'score' IS NOT NULL
ORDER BY c.ts;
```

## 6b. Reader shadow compares

How often a reader with an old/new source switch (`reader`, such as `claim-events`) found its two
sources disagreeing. The command that compares (`tool`) writes one `shadow_read` event per compare,
not per issue (`shadow_read.v1.json`). `differences` counts keys whose answers differ with both
sides cut at the settle time, `live_differences` the same on everything read (push lag included),
and `old_ok` / `new_ok` say whether that side's central read succeeded. Both compares leave out the events of a
device older than that device's first event in the new store (its floor): the production new store holds only
dual-written events, so the old window reaches back before it begins. `scope_floor` is the writing device's floor
(null when it has none) and `out_of_scope` how many events the floor left out (`loop-facts` only), so a clean
compare can be told from one the floor cut most of; the query returns the newest `scope_floor` and the summed
`out_of_scope`. A retried write can repeat
an event, so each compare counts once per (repo, device, ts). The query reads the columns migration
0005 lifted into `factory.event_log`, and `detail` (not lifted) from the same event's `data` in
`factory.event_store`. It takes `-v repo=... -v since=...`. The producers are the factory loop's record rebuild (`reader = 'loop-records'`, `tool = 'factory-loop'`; written under the
loop setting `eventsSource` `shadow` (opt-in; the default is `new`), once per load and then at most hourly; `differences` counts issues whose
rebuilt record differs, with both sides cut 600 seconds back, and `diff_keys` holds their issue numbers), the factory loop's facts and ledger rebuild (`reader = 'loop-facts'`, same setting and cadence; `differences` counts the differing keys among the newest `reclaimed` and the newest `ready` per issue, the derived ledger entries and the once keys, with both sides cut 600 seconds back, and `diff_keys` holds them as `reclaimed:#N`, `ready:#N`, `ledger:<key>` and `once:<key>`) and the claim tools'
held rule (`images/base/claim-events.sh`): `callum-flow-claim` and `callum-flow-sweep` write one
event per run only when the source is set to `shadow` (`CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow`; the default is `new`), with
`reader = 'claim-events'` and `tool` the command. `differences` counts issues whose held decision
(lifecycle class, latest claim type, claim device) differs, over the last 7 days cut 10 minutes
before now; the query groups by reader and tool.

```sql
-- per reader, tool, device and day: compares, differences, failed reads, newest difference detail, newest scope floor, events out of scope
WITH compares AS (
  SELECT e.reader, e.tool, e.device, e.ts, e.differences, e.live_differences, e.old_ok, e.new_ok,
         s.data ->> 'detail' AS detail,
         s.data ->> 'scope_floor' AS scope_floor,
         (s.data ->> 'out_of_scope')::int AS out_of_scope,
         row_number() OVER (PARTITION BY e.repo, e.device, e.ts ORDER BY e.event_id) AS dup
  FROM factory.event_log e
  JOIN factory.event_store s ON s.event_id = e.event_id
  WHERE e.type = 'shadow_read' AND e.repo = :'repo' AND e.ts >= :'since'::timestamptz
),
once AS (
  SELECT *,
         row_number() OVER (PARTITION BY reader, tool, device, date_trunc('day', ts)
                            ORDER BY (differences > 0) DESC, ts DESC) AS newest
  FROM compares
  WHERE dup = 1
)
SELECT reader, tool, device, date_trunc('day', ts) AS day,
  count(*)                                         AS compares,
  sum(differences)                                 AS differences,
  sum(live_differences)                            AS live_differences,
  count(*) FILTER (WHERE NOT old_ok OR NOT new_ok) AS failed_reads,
  max(detail) FILTER (WHERE newest = 1 AND differences > 0) AS newest_detail,
  (array_agg(scope_floor ORDER BY ts DESC) FILTER (WHERE scope_floor IS NOT NULL))[1] AS scope_floor,
  coalesce(sum(out_of_scope), 0)                   AS out_of_scope
FROM once
GROUP BY reader, tool, device, date_trunc('day', ts)
ORDER BY day DESC, reader, tool, device;
```

## 7. The waiting split

Each merged issue's wall-clock time from `ready` to `merged`, cut into two parts:

- **Dispatcher-bound**: `ready` to the first `claimed`; each `transition` to parked until the issue's
  next transition; each `transition` to merge-queue until the next `merged` or transition.
- **Agent work**: the rest (`total` minus `dispatcher_bound`).

Time a merge-queue record is held by the owner's `don't-merge` label counts as owner-bound, not
dispatcher-bound; this split does not carve it out, and section 9 has its own query ("Held time").

A dispatcher-bound second is flagged "another device idle" when, at that moment, some device other
than the issue's owner (the device of its first `claimed`) was alive and held no in-flight issue.
A device is alive for 30 minutes after any `event_log` row it logged (`usage`, `loop_entry` and
`loop_passes` included). It holds an issue from its `claimed` until that issue's next `ready`,
`requeued`, `merged`, `abandoned` or `closed`.

The pipeline-bound part and the B-or-gate rule that needed it are gone from this query: they read the
no-mistakes mirror, which this document no longer covers. `callum-flow-evaluate`'s `waiting` section
still makes that call from the no-mistakes source (see below).

Most issues have no `ready` event, because `queue-watch.sh` logs one only for issues missing from
its baseline. The `ready` time therefore comes from each issue's GitHub timeline, the last
`labeled` `ready` event before the claim. Collect them with
`callum-flow-issue-read --json --timeline <n>` and put them in `ready_times`
below; an issue with no row falls back to its first `ready` event. The SQL needs PostgreSQL 14 or
later (multiranges). It is the twin of the tool's `waiting` section: the tool also clips the
"alive" window at the report's end, which the SQL does not. The transitions come within two minutes
of the old stage lines, so a total can differ from one given from the old log by a few minutes.

```sql
WITH ready_times(repo, issue, ts) AS (
  -- replace with the labeled-ready times from the timeline, e.g.
  --   VALUES ('cbundy/dev-system', 222, '2026-10-09T08:00:00Z'::timestamptz), ...
  SELECT NULL::text, NULL::int, NULL::timestamptz WHERE false
), merged AS (   -- the first merged of each issue
  SELECT repo, issue, ts AS m
  FROM (SELECT repo, issue, ts,
          row_number() OVER (PARTITION BY repo, issue ORDER BY ts, device, device_seq) AS n
        FROM factory.event_log WHERE type = 'merged' AND issue IS NOT NULL) x
  WHERE n = 1
), first_claim AS (
  SELECT repo, issue, ts AS c, device AS owner
  FROM (SELECT repo, issue, ts, device,
          row_number() OVER (PARTITION BY repo, issue ORDER BY ts, device, device_seq) AS n
        FROM factory.event_log WHERE type = 'claimed' AND issue IS NOT NULL) x
  WHERE n = 1
), tr AS (       -- one row per (issue, life, seq), with the issue's next transition
  SELECT repo, issue, to_state, seq_at,
         lead(seq_at) OVER (PARTITION BY repo, issue ORDER BY seq_at, seq) AS next_at
  FROM (SELECT repo, issue, life, seq, to_state, seq_at,
          row_number() OVER (PARTITION BY repo, issue, life, seq ORDER BY ts, device, device_seq) AS n
        FROM factory.event_log WHERE type = 'transition' AND issue IS NOT NULL) x
  WHERE n = 1
), span AS (
  SELECT m.repo, m.issue, m.m, fc.c,
    COALESCE(fc.owner, (SELECT e.device FROM factory.event_log e
                        WHERE e.repo = m.repo AND e.issue = m.issue AND e.type = 'merged'
                        ORDER BY e.ts LIMIT 1)) AS owner,
    COALESCE(
      (SELECT max(rt.ts) FROM ready_times rt
       WHERE rt.repo = m.repo AND rt.issue = m.issue AND (fc.c IS NULL OR rt.ts <= fc.c)),
      (SELECT min(e.ts) FROM factory.event_log e
       WHERE e.repo = m.repo AND e.issue = m.issue AND e.type = 'ready')) AS r
  FROM merged m LEFT JOIN first_claim fc USING (repo, issue)
), disp AS (
  SELECT repo, issue, r AS s, c AS e FROM span WHERE c IS NOT NULL
  UNION ALL     -- each park, until the issue's next transition
  SELECT s.repo, s.issue, p.seq_at, COALESCE(p.next_at, s.m)
  FROM span s JOIN tr p ON p.repo = s.repo AND p.issue = s.issue AND p.to_state = 'parked'
  UNION ALL     -- each entry to the merge queue, until the next transition or the merge
  SELECT s.repo, s.issue, p.seq_at, COALESCE(p.next_at, s.m)
  FROM span s JOIN tr p ON p.repo = s.repo AND p.issue = s.issue AND p.to_state = 'merge-queue'
), alive AS (   -- per device: alive for 30 minutes after each event
  SELECT repo, device, range_agg(tstzrange(ts, ts + interval '30 minutes')) AS mr
  FROM factory.event_log GROUP BY repo, device
), held AS (    -- per device: from each claimed until that issue's next release
  SELECT c.repo, c.device, range_agg(tstzrange(c.ts, COALESCE(
    (SELECT min(x.ts) FROM factory.event_log x
     WHERE x.repo = c.repo AND x.issue = c.issue AND x.ts > c.ts
       AND x.type IN ('ready', 'requeued', 'merged', 'abandoned', 'closed')), 'infinity'))) AS mr
  FROM factory.event_log c WHERE c.type = 'claimed' GROUP BY c.repo, c.device
), idle AS (    -- alive and holding nothing
  SELECT a.repo, a.device, a.mr - COALESCE(h.mr, '{}'::tstzmultirange) AS mr
  FROM alive a LEFT JOIN held h USING (repo, device)
), per_issue AS (
  SELECT s.repo, s.issue, s.owner, s.r, s.m,
    COALESCE((SELECT range_agg(tstzrange(LEAST(d.s, d.e), d.e)) FROM disp d
              WHERE d.repo = s.repo AND d.issue = s.issue), '{}'::tstzmultirange)
      * tstzmultirange(tstzrange(s.r, s.m)) AS disp,
    COALESCE((SELECT range_agg(r2) FROM idle i, unnest(i.mr) AS r2
              WHERE i.repo = s.repo AND i.device <> s.owner), '{}'::tstzmultirange) AS other_idle
  FROM span s WHERE s.r IS NOT NULL AND s.r < s.m
), secs AS (
  SELECT repo, issue, owner, extract(epoch FROM m - r) AS total,
    (SELECT COALESCE(sum(upper(x) - lower(x)), interval '0') FROM unnest(disp) x)              AS disp_iv,
    (SELECT COALESCE(sum(upper(x) - lower(x)), interval '0') FROM unnest(disp * other_idle) x) AS disp_idle_iv
  FROM per_issue
)
SELECT repo, issue, owner,
  extract(epoch FROM disp_iv)      AS dispatcher_bound,
  extract(epoch FROM disp_idle_iv) AS dispatcher_bound_other_idle,
  total - extract(epoch FROM disp_iv) AS agent_work,
  total
FROM secs
ORDER BY repo, issue;
```

Sum the columns for totals. `sum(dispatcher_bound_other_idle) / sum(dispatcher_bound)` is the share of
dispatcher-bound time with another device idle. The B-or-gate call needs the pipeline-bound seconds as
well, so read it from `callum-flow-evaluate`'s `waiting` section, whose `decision` is `B` when more
than 50% of the wait was dispatcher-bound with another device idle and `gate` otherwise.

## 7a. How waits end

A design wait (v2 SPEC 8.7) is the transition to `waiting` (T16). The answer script refuses a wait
that could never clear (a commit of another repo, a repo with no release, an issue or PR that does
not exist; #980), so after it ships the share of waits that never end should drop. This lists each
wait with the transition that ended it and how long it lasted: `ended_via` is the next transition's
`via` (the loop's own check clearing it, a tell, the owner's resume), and a null `ended_at` is a
wait still open. Time is by `seq_at`; a retried write counts once. It takes `-v repo=... -v since=...`.

```sql
-- per wait: when it began, how it ended and how long it lasted
WITH tr AS (       -- one row per (issue, life, seq), with the issue's next transition
  SELECT repo, issue, life, seq, to_state, via, seq_at, data,
         lead(seq_at) OVER (PARTITION BY repo, issue ORDER BY seq_at, seq) AS next_at,
         lead(via)    OVER (PARTITION BY repo, issue ORDER BY seq_at, seq) AS next_via
  FROM (SELECT l.repo, l.issue, l.life, l.seq, l.to_state, l.via, l.seq_at, d.data,
          row_number() OVER (PARTITION BY l.repo, l.issue, l.life, l.seq ORDER BY l.ts, l.device, l.device_seq) AS n
        FROM factory.event_log l JOIN factory.event_store d ON d.event_id = l.event_id
        WHERE l.type = 'transition' AND l.issue IS NOT NULL AND l.repo = :'repo') x
  WHERE n = 1
)
SELECT repo, issue, life, seq, seq_at AS waited_at, next_at AS ended_at, next_via AS ended_via,
  extract(epoch FROM next_at - seq_at) AS wait_seconds,
  EXISTS (SELECT 1 FROM jsonb_array_elements(data -> 'wait') w WHERE w ->> 'repo' IS NOT NULL) AS foreign
FROM tr
WHERE to_state = 'waiting' AND seq_at >= :'since'::timestamptz
ORDER BY seq_at DESC;
```

Group by `foreign` and `ended_via` for how waits end (`foreign` is true when a condition names another repo, so waits on another repo's release or issue compare with those on the loop's own), and count the rows with a null `ended_at` older than a day for
waits that look stuck.

How often a release wait triggers a review within the hour (the O3 key carries the waiting set the review saw, the reason names the new issues):

```sh
jq -rs '[.[] | . as $d | ($d.actions // [])[] | select(.rule == "O3" and (.reason | test("started waiting"))) | {at: $d.at, key, reason}] | .[] | "\(.at) \(.key) \(.reason)"' /persist/claude/factory-loop/*/decisions-*.jsonl
```

How often, and for how long, a started release quiets the review (first and last pass held, passes held, the entry):

```sh
jq -rs '[.[] | . as $d | ($d.skipped // [])[] | select(.rule == "O3" and (.why | startswith("release in progress"))) | {at: $d.at, why}] | group_by(.why) | .[] | "\(.[0].at) \(.[-1].at) \(length) \(.[0].why)"' /persist/claude/factory-loop/*/decisions-*.jsonl
```

A wait the loop cannot read (a failing read, or a tag condition on a repo with no release) raises the owner item
`wait-unreadable` once per 24 h period, keyed `.../wait-unreadable/<k>`. How many periods each issue hung for, from the decision log
(the planned action carries the key and the issue; the conditions are in the tell's fields in the ledger):

```sh
jq -rs '[.[] | . as $d | ($d.actions // [])[] | select(.kind == "tell" and (.key | test("/wait-unreadable/")))
  | {day: ($d.at | tostring | .[0:10]), issue, key}] | unique_by(.key) | group_by(.issue)[]
  | "\(.[0].issue): \(length) periods"' /persist/claude/factory-loop/*/decisions-*.jsonl
```

### Starved queue

A ready queue the factory cannot touch while nothing is in flight raises the owner item `starved` once the
spell is `starvedNoticeAfterMs` (default 60 min) old, and again once per 24 h period of it, keyed
`tell:starved:<since>:<k>`. What each notice named, from the decision log:

```sh
jq -rs '[.[] | . as $d | ($d.actions // [])[] | select(.kind == "tell" and (.key | startswith("tell:starved:")))
  | {since: .fields.since, minutes: (.fields.minutes | tonumber), roots: .fields.roots, why: .fields.why}]
  | unique_by(.since + .roots) | .[] | "\(.since) \(.minutes) min: \(.why)"' /persist/claude/factory-loop/*/decisions-*.jsonl
```

The pass line carries `starved: {since, minutes}` while a pass is starved, so a spell's start, end and length
show without the tell:

```sh
jq -rs 'map(select(.starved != null)) | group_by(.starved.since)[] | "\(.[0].starved.since): \((map(.starved.minutes) | max)) min"' /persist/claude/factory-loop/*/decisions-*.jsonl
```

## 7b. Done closes

The designer answers `done` when an issue's work is already merged (v2 SPEC 8.7): the loop checks the
evidence, closes the record with `why = 'done'` (row T18, `via` `done`) and closes the issue as completed.
This lists each issue the loop closed that way, newest first, with the evidence the transition's `notes` hold for
a person to read (`done: PR #N (merge <sha7>)`, `commit <sha7>`, and the run-it URL when given; never parsed), so a
count per week is `date_trunc('week', closed_at)` over the rows. A retried write counts once. It takes
`-v repo=... -v since=...`.

```sql
-- per done close: when, and on what evidence
SELECT issue, life, closed_at, evidence
FROM (SELECT issue, life, seq_at AS closed_at, notes::text AS evidence,
             row_number() OVER (PARTITION BY repo, issue, life, seq ORDER BY ts, device, device_seq) AS n
      FROM factory.event_log
      WHERE type = 'transition' AND why = 'done' AND repo = :'repo' AND seq_at >= :'since'::timestamptz) x
WHERE n = 1
ORDER BY closed_at DESC;
```

What became of each issue's branch: the done close's `delete-branch` entry (key `.../follow/delete-branch`)
is in the decision log's outcomes, with the summary `deleted issue-N` or `kept issue-N: it moved since it was
read`. A branch the close kept for its own commits, or that origin did not have, plans no `delete-branch` at all;
the done comment on the issue and the `done` tell (`fields.branch`: `deleted`, `kept` or `none`) say which:

```sh
jq -rs '[.[] | (.outcomes // [])[] | select(.key | test("/follow/delete-branch$")) | "\(.key) \(.status): \(.summary)"] | .[]' /persist/claude/factory-loop/*/decisions-*.jsonl
jq -rs '[.[] | . as $d | ($d.actions // [])[] | select(.kind == "tell" and .reason == "tell done") | "#\(.issue) branch \(.fields.branch)"] | unique | .[]' /persist/claude/factory-loop/*/decisions-*.jsonl
```

How often a done answer's evidence fails the loop's own check: the design step's unknown with `why` `bad-answer`
and a reason that starts "the done evidence ..." or "the done answer's PR ...", in the `transition` events'
notes (the retry) and in the decision log. The answer script's refusals show only in the designer's stderr.

## 8. Implementer model comparison

Sonnet against Opus as the implementer, from the split `callum-flow-implementer-route` makes (see the
[factory event log reference](../images/base/README.md#factory-event-log)). Only issues the hash
routed count: an issue with any `label`, `default` or `fallback` route, or routed to both models (the
share changed while it was in flight), is left out. Each issue counts from its first
`implementer_routed` event (`routed_at`).

(a) One row per hash-routed issue, with its facts:

- `model`; `building_at`, the issue's first `transition` to building (the loop logs the route just
  after that transition, so this one is not clipped to the route); `reviewing_at`, `green_at`
  (merge-queue), `merged_at` and `setback_at` (fixing), each the first such event at or after the
  route, timed by `seq_at` for transitions.
- `fix_requests`: the transitions to fixing after the route, one per `(life, seq)`.
- `abandoned`: the issue has an `abandoned` event after the route.

(b) One row per model: `issues`, `merged`, `abandoned` (abandoned and never merged), `first_pass_pct`
(of the issues that reached merge-queue, the share with no transition to fixing before it, as in
"2. First-pass gate pass rate") and `fix_requests_per_merged` (per merged issue; an issue still in
flight would undercount).

The medians come from (a) in code, not from SQL: the median seconds of `reviewing_at - building_at`
(the implementer's own time), of `green_at - reviewing_at` (review) and of `merged_at - building_at`
(total), over the rows that have both times. The pipeline columns of the older version of this query
(runs, auto-fix rounds, failed steps, parked time and pipeline tokens) read the no-mistakes mirror and
are gone.

The implementer's own token spend is in this database from the loop that writes it on (see
[Tokens per merged issue](#tokens-per-merged-issue), per issue, model and role); for older issues read it
from the implementer rows of the `spend` section of `callum-flow-evaluate`, which has one row per role and model. A random split
balances easy and hard issues only over many of them, so size the noise before reading a gap as real:
run the query with `routed` replaced by a split of past building transitions by issue parity (both
halves on the same model), and treat a gap no bigger than that one as noise. To narrow to one repo or
window, filter `routed`.

```sql
WITH routed AS (   -- issues the hash split, each on one model; label, default and fallback routes are left out
  SELECT repo, issue, min(ts) AS routed_at, min(model) AS model
  FROM factory.event_log
  WHERE type = 'implementer_routed' AND issue IS NOT NULL
  GROUP BY repo, issue
  HAVING bool_and(reason = 'hash') AND count(DISTINCT model) = 1
), tr AS (         -- one row per (issue, life, seq)
  SELECT repo, issue, to_state, seq_at
  FROM (SELECT repo, issue, to_state, seq_at,
          row_number() OVER (PARTITION BY repo, issue, life, seq ORDER BY ts, device, device_seq) AS n
        FROM factory.event_log WHERE type = 'transition' AND issue IS NOT NULL) x
  WHERE n = 1
), ev AS (
  SELECT repo, issue, to_state AS what, seq_at AS at_ts FROM tr
  UNION ALL
  SELECT repo, issue, type, ts FROM factory.event_log WHERE type IN ('merged', 'abandoned') AND issue IS NOT NULL
)
SELECT x.repo, x.issue, x.model,
  min(e.at_ts) FILTER (WHERE e.what = 'building')                                AS building_at,
  min(e.at_ts) FILTER (WHERE e.what = 'reviewing'   AND e.at_ts >= x.routed_at)  AS reviewing_at,
  min(e.at_ts) FILTER (WHERE e.what = 'merge-queue' AND e.at_ts >= x.routed_at)  AS green_at,
  min(e.at_ts) FILTER (WHERE e.what = 'merged'      AND e.at_ts >= x.routed_at)  AS merged_at,
  min(e.at_ts) FILTER (WHERE e.what = 'fixing'      AND e.at_ts >= x.routed_at)  AS setback_at,
  count(*)     FILTER (WHERE e.what = 'fixing'      AND e.at_ts >= x.routed_at)  AS fix_requests,
  COALESCE(bool_or(e.what = 'abandoned' AND e.at_ts >= x.routed_at), false)      AS abandoned
FROM routed x
LEFT JOIN ev e ON e.repo = x.repo AND e.issue = x.issue
GROUP BY x.repo, x.issue, x.model
ORDER BY x.repo, x.issue;
```

(b) The per-model summary. It starts from the same `routed`, `tr` and `ev` as (a):

```sql
WITH routed AS (   -- issues the hash split, each on one model; label, default and fallback routes are left out
  SELECT repo, issue, min(ts) AS routed_at, min(model) AS model
  FROM factory.event_log
  WHERE type = 'implementer_routed' AND issue IS NOT NULL
  GROUP BY repo, issue
  HAVING bool_and(reason = 'hash') AND count(DISTINCT model) = 1
), tr AS (         -- one row per (issue, life, seq)
  SELECT repo, issue, to_state, seq_at
  FROM (SELECT repo, issue, to_state, seq_at,
          row_number() OVER (PARTITION BY repo, issue, life, seq ORDER BY ts, device, device_seq) AS n
        FROM factory.event_log WHERE type = 'transition' AND issue IS NOT NULL) x
  WHERE n = 1
), ev AS (
  SELECT repo, issue, to_state AS what, seq_at AS at_ts FROM tr
  UNION ALL
  SELECT repo, issue, type, ts FROM factory.event_log WHERE type IN ('merged', 'abandoned') AND issue IS NOT NULL
), per_issue AS (
  SELECT x.repo, x.issue, x.model,
    min(e.at_ts) FILTER (WHERE e.what = 'merge-queue' AND e.at_ts >= x.routed_at) AS green_at,
    min(e.at_ts) FILTER (WHERE e.what = 'merged'      AND e.at_ts >= x.routed_at) AS merged_at,
    min(e.at_ts) FILTER (WHERE e.what = 'fixing'      AND e.at_ts >= x.routed_at) AS setback_at,
    count(*)     FILTER (WHERE e.what = 'fixing'      AND e.at_ts >= x.routed_at) AS fix_requests,
    COALESCE(bool_or(e.what = 'abandoned' AND e.at_ts >= x.routed_at), false)     AS abandoned
  FROM routed x
  LEFT JOIN ev e ON e.repo = x.repo AND e.issue = x.issue
  GROUP BY x.repo, x.issue, x.model
)
SELECT model,
  count(*)                                                                         AS issues,
  count(merged_at)                                                                 AS merged,
  count(*) FILTER (WHERE abandoned AND merged_at IS NULL)                          AS abandoned,
  round(100.0 * count(*) FILTER (WHERE green_at IS NOT NULL AND (setback_at IS NULL OR setback_at > green_at))
        / nullif(count(green_at), 0), 1)                                           AS first_pass_pct,
  round(avg(fix_requests) FILTER (WHERE merged_at IS NOT NULL), 2)                 AS fix_requests_per_merged
FROM per_issue
GROUP BY model
ORDER BY model;
```

## 8b. Designer model comparison

The design step runs on the model `callum-flow-designer-route` picks and logs as `designer_routed`;
when the route cannot run, the loop logs the same event with reason `fallback` and a null
`sonnet_pct`. Set the share of issues designed by Sonnet with `"env": { "CALLUM_FLOW_DESIGNER_SONNET_PCT": "50" }`
in the repo's `.claude/settings.json`, and keep it fixed while the comparison runs. Only
hash-routed issues count: an issue with any other reason, or routed to both models, is left out. A
timed-out route can leave a tool event and a fallback event for one attempt; the hash-only rule
excludes both. Each issue is counted from its first `designer_routed`.

- `built_clean`: the first design transition after the route is T2 (to building) with no T3 or T4 before it.
- `parked_pct`: the share of issues with a T3 question after the route.
- `splits`: issues with a T4. `waits`: issues with a T16. `merged`: a `merged` event after the route.

```sql
WITH routed AS (
  SELECT repo, issue, min(ts) AS routed_at, min(model) AS model
  FROM factory.event_log
  WHERE type = 'designer_routed'
  GROUP BY repo, issue
  HAVING count(*) FILTER (WHERE reason IS DISTINCT FROM 'hash') = 0
     AND count(DISTINCT model) = 1
),
per_issue AS (
  SELECT r.model,
    (SELECT t.table_row FROM factory.event_log t
      WHERE t.repo = r.repo AND t.issue = r.issue AND t.type = 'transition'
        AND t.seq_at >= r.routed_at AND t.table_row IN ('T2', 'T3', 'T4', 'T16')
      ORDER BY t.seq_at, t.seq LIMIT 1) = 'T2'                                      AS built_clean,
    EXISTS (SELECT 1 FROM factory.event_log t WHERE t.repo = r.repo AND t.issue = r.issue
            AND t.type = 'transition' AND t.table_row = 'T3' AND t.seq_at >= r.routed_at) AS parked,
    EXISTS (SELECT 1 FROM factory.event_log t WHERE t.repo = r.repo AND t.issue = r.issue
            AND t.type = 'transition' AND t.table_row = 'T4' AND t.seq_at >= r.routed_at) AS split,
    EXISTS (SELECT 1 FROM factory.event_log t WHERE t.repo = r.repo AND t.issue = r.issue
            AND t.type = 'transition' AND t.table_row = 'T16' AND t.seq_at >= r.routed_at) AS waited,
    EXISTS (SELECT 1 FROM factory.event_log t WHERE t.repo = r.repo AND t.issue = r.issue
            AND t.type = 'merged' AND t.ts >= r.routed_at)                            AS merged
  FROM routed r
)
SELECT model,
  count(*)                                                       AS issues,
  count(*) FILTER (WHERE built_clean)                            AS built_clean,
  round(100.0 * count(*) FILTER (WHERE parked) / count(*), 1)    AS parked_pct,
  count(*) FILTER (WHERE split)                                  AS splits,
  count(*) FILTER (WHERE waited)                                 AS waits,
  count(*) FILTER (WHERE merged)                                 AS merged
FROM per_issue
GROUP BY model
ORDER BY model;
```

## 9. Interventions, judgement calls and claim completion

The factory loop v2's effectiveness, as issue #632 asks for it, from `factory.event_log` alone. Every
query counts a retried event once (see the reading rules above), and all of them apply to any regime
that logs these types. `callum-flow-evaluate` reports the same numbers over a window (its
`interventions`, `judgement_calls`, `claim_completion` and `rounds` sections). Merges, pull requests
and merge gaps are section 9c.

**Interventions** (#632 metric 1): an `intervention` event is any point where a person, the loop's judge
(`who=judge`, a control op run through the control tool) or the loop with unplanned judgement or
recovery (`who=loop`), had to step in. A merged issue is **untouched** when no
intervention of any kind names its merged work; untouched merges are the target outcome. An
intervention names the merged work by its `life` when that life began by the first `merged` (a
`transition` of the life, timed by `seq_at`, at or before it), whenever the intervention itself was
logged: the loop derives most of them a pass or more after their fact, so a hand merge's can land
after the `merged` event. One with no life (an owner op, a hand-recorded rescue, a control-file edit),
or a life no `transition` names, counts from the first `claimed` to the issue's closing `transition`
(the first to `closed` since its last claim before the merge; else the merge) plus 30 minutes.
Fleet-level interventions (no `issue`) attach to no issue. A `ci-rerun` flake row (2d) shares its
`fact` with the re-run's first row, so these queries count the pair once.

```sql
-- interventions per repo and day, by who and cause; `fleet` counts those that name no issue
WITH iv AS (
  SELECT repo, issue, ts, who, cause
  FROM (
    SELECT repo, issue, ts, who, cause,
           row_number() OVER (PARTITION BY repo, coalesce(issue, 0), who, cause,
                                           coalesce(fact, event_id::text, ts::text)
                              ORDER BY ts, device, device_seq) AS n
    FROM factory.event_log
    WHERE type = 'intervention'
  ) x
  WHERE n = 1
)
SELECT repo, date_trunc('day', ts)::date AS day, who, cause,
  count(*)                              AS interventions,
  count(*) FILTER (WHERE issue IS NULL) AS fleet
FROM iv
GROUP BY repo, day, who, cause
ORDER BY repo, day, who, cause;
```

```sql
-- per merged issue: the interventions that name its merged work, and whether it was untouched
WITH iv AS (
  SELECT repo, issue, ts, who, cause, life
  FROM (
    SELECT repo, issue, ts, who, cause, life,
           row_number() OVER (PARTITION BY repo, issue, who, cause, coalesce(fact, event_id::text, ts::text)
                              ORDER BY ts, device, device_seq) AS n
    FROM factory.event_log
    WHERE type = 'intervention' AND issue IS NOT NULL
  ) x
  WHERE n = 1
), tr AS (
  SELECT repo, issue, life, seq_at, to_state
  FROM factory.event_log WHERE type = 'transition' AND issue IS NOT NULL
), merged AS (
  SELECT repo, issue, min(ts) AS merged_at
  FROM factory.event_log WHERE type = 'merged' AND issue IS NOT NULL GROUP BY repo, issue
), spans AS (
  SELECT m.repo, m.issue, m.merged_at,
    least(coalesce((SELECT min(c.ts) FROM factory.event_log c
                    WHERE c.repo = m.repo AND c.issue = m.issue AND c.type = 'claimed'), m.merged_at), m.merged_at) AS from_ts,
    greatest(m.merged_at, coalesce((
      SELECT min(t.seq_at) FROM tr t
      WHERE t.repo = m.repo AND t.issue = m.issue AND t.to_state = 'closed'
        AND t.seq_at >= coalesce((SELECT max(c.ts) FROM factory.event_log c
                                  WHERE c.repo = m.repo AND c.issue = m.issue AND c.type = 'claimed' AND c.ts <= m.merged_at),
                                 m.merged_at)), m.merged_at)) + interval '30 minutes' AS until_ts
  FROM merged m
), mine AS (
  SELECT s.repo, s.issue, iv.who, iv.cause
  FROM spans s
  JOIN iv ON iv.repo = s.repo AND iv.issue = s.issue
  WHERE CASE
    WHEN iv.life IS NOT NULL AND EXISTS (SELECT 1 FROM tr t WHERE t.repo = s.repo AND t.issue = s.issue AND t.life = iv.life)
      THEN EXISTS (SELECT 1 FROM tr t WHERE t.repo = s.repo AND t.issue = s.issue AND t.life = iv.life AND t.seq_at <= s.merged_at)
    ELSE iv.ts >= s.from_ts AND iv.ts <= s.until_ts
  END
)
SELECT s.repo, s.issue, s.merged_at,
  count(mine.cause) FILTER (WHERE mine.who = 'person') AS person,
  count(mine.cause) FILTER (WHERE mine.who = 'loop')   AS loop,
  count(mine.cause) FILTER (WHERE mine.who = 'judge')  AS judge,
  count(mine.cause) = 0                                AS untouched,
  string_agg(DISTINCT mine.cause, ',')                 AS causes
FROM spans s
LEFT JOIN mine ON mine.repo = s.repo AND mine.issue = s.issue
GROUP BY s.repo, s.issue, s.merged_at
ORDER BY s.merged_at DESC;
```

**Judgement calls** (#632 metric 2): the decisions a model made, by kind and outcome: each review
(`reviewed`, by `verdict`; one per `(issue, round, patch)`), each triage call (an `intervention` with
cause `triage`, by the choice the next triage row of the loop's table applied: `X1` retry, `X2` fix,
`X3` redesign, `X4` park, `X5` drop, else `pending`), a designer's question or split (a `transition`
by row `T3` or `T4`), a fixer's dispositions (`finding_handled` events of actor `fixer`, `fixed`
or `declined`) and a judge task (a `loop_entry` with `kind = 'task'`: a wake of the loop's model
outside a planned step; one call per `key`, timed and attributed by the key's first row, its outcome
`<wake>:<final status>` from the key's latest row by `ts`, then `device_seq`, with `none` for a null
wake). A call is **overridden** when a person intervention names its issue within an hour
after it.

```sql
WITH calls AS (
  SELECT repo, issue, ts, kind, outcome
  FROM (
    SELECT c.*, row_number() OVER (PARTITION BY repo, issue, kind, key ORDER BY ts, event_id) AS n
    FROM (
      SELECT e.repo, e.issue, e.ts, e.event_id, 'review' AS kind, e.verdict AS outcome,
             coalesce(e.round::text, '') || '/' || coalesce(e.patch, '') AS key
      FROM factory.event_log e WHERE e.type = 'reviewed'
      UNION ALL
      SELECT e.repo, e.issue, e.ts, e.event_id, 'triage',
             coalesce((SELECT CASE x.table_row
                                WHEN 'X1' THEN 'retry' WHEN 'X2' THEN 'fix' WHEN 'X3' THEN 'redesign'
                                WHEN 'X4' THEN 'park' WHEN 'X5' THEN 'drop' END
                       FROM factory.event_log x
                       WHERE x.repo = e.repo AND x.issue = e.issue AND x.type = 'transition' AND x.seq_at >= e.ts
                         AND x.table_row IN ('X1', 'X2', 'X3', 'X4', 'X5')
                       ORDER BY x.seq_at, x.seq LIMIT 1), 'pending'),
             coalesce(e.fact, e.event_id::text)
      FROM factory.event_log e
      WHERE e.type = 'intervention' AND e.who = 'loop' AND e.cause = 'triage'
      UNION ALL
      SELECT e.repo, e.issue, e.ts, e.event_id, 'design',
             CASE e.table_row WHEN 'T3' THEN 'question' ELSE 'split' END,
             e.life || '/' || e.seq
      FROM factory.event_log e
      WHERE e.type = 'transition' AND e.table_row IN ('T3', 'T4')
      UNION ALL
      SELECT e.repo, e.issue, e.ts, e.event_id, 'fix', e.outcome, e.event_id::text
      FROM factory.event_log e
      WHERE e.type = 'finding_handled' AND e.actor = 'fixer' AND e.outcome IN ('fixed', 'declined')
      UNION ALL
      SELECT f.repo, f.issue, f.ts, f.event_id, 'task', coalesce(f.wake, 'none') || ':' || f.status, f.key
      FROM (
        SELECT e.repo, e.issue, e.ts, e.event_id, e.key,
               first_value(e.wake) OVER latest AS wake, first_value(e.status) OVER latest AS status,
               row_number() OVER (PARTITION BY e.repo, e.key ORDER BY e.ts, e.device_seq) AS first_n
        FROM factory.event_log e
        WHERE e.type = 'loop_entry' AND e.kind = 'task'
        WINDOW latest AS (PARTITION BY e.repo, e.key ORDER BY e.ts DESC, e.device_seq DESC)
      ) f
      WHERE f.first_n = 1
    ) c
  ) y
  WHERE n = 1
)
SELECT c.repo, c.kind, c.outcome,
  count(*) AS calls,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM factory.event_log p
    WHERE p.repo = c.repo AND p.issue = c.issue AND p.type = 'intervention'
      AND p.who = 'person' AND p.ts > c.ts AND p.ts <= c.ts + interval '1 hour')) AS overridden
FROM calls c
GROUP BY c.repo, c.kind, c.outcome
ORDER BY c.repo, c.kind, c.outcome;
```

**Claim completion** (#632 metric 3): per issue and life, its first `claimed`, then the first of
`merged`, `abandoned` (by its `reason`: `dropped`, `split`, `triage`, `reconcile`, `rejected`,
`other`), `closed`, a release back to the queue (`requeued` or `ready`, read as `released`) or a
`transition` to parked (timed by `seq_at`); a claim with none of them yet is `open`. A claim while a
life is open is the same life (a re-claim of a lapsed claim). Open claims are censored, not failures,
so the share merged is of the resolved ones.

```sql
WITH ends AS (
  SELECT repo, issue, ts,
    CASE type WHEN 'merged' THEN 'merged' WHEN 'closed' THEN 'closed'
              WHEN 'requeued' THEN 'released' WHEN 'ready' THEN 'released'
              WHEN 'abandoned' THEN 'abandoned:' || coalesce(reason, 'unknown')
              ELSE 'parked' END AS outcome
  FROM (
    SELECT repo, issue, ts, type, reason
    FROM factory.event_log
    WHERE issue IS NOT NULL AND type IN ('merged', 'closed', 'requeued', 'ready', 'abandoned')
    UNION ALL
    SELECT repo, issue, seq_at, type, NULL
    FROM factory.event_log
    WHERE issue IS NOT NULL AND type = 'transition' AND to_state = 'parked'
  ) x
), claims AS (
  SELECT c.repo, c.issue, c.device, c.ts AS claimed_at,
         (SELECT max(e.ts) FROM ends e WHERE e.repo = c.repo AND e.issue = c.issue AND e.ts < c.ts) AS prev_end
  FROM factory.event_log c
  WHERE c.type = 'claimed' AND c.issue IS NOT NULL
), lives AS (  -- a claim starts a life when no other claim came between the last end and it
  SELECT k.* FROM claims k
  WHERE NOT EXISTS (
    SELECT 1 FROM claims o
    WHERE o.repo = k.repo AND o.issue = k.issue AND o.claimed_at < k.claimed_at
      AND o.claimed_at > coalesce(k.prev_end, '-infinity'::timestamptz))
), completion AS (  -- one row per life; select from it for the list
  SELECT l.repo, l.issue, l.device, l.claimed_at,
    coalesce((SELECT e.outcome FROM ends e
              WHERE e.repo = l.repo AND e.issue = l.issue AND e.ts > l.claimed_at
              ORDER BY e.ts LIMIT 1), 'open') AS outcome
  FROM lives l
)
SELECT repo,
  count(*)                                       AS claims,
  count(*) FILTER (WHERE outcome = 'merged')     AS merged,
  count(*) FILTER (WHERE outcome = 'open')       AS open,
  round(100.0 * count(*) FILTER (WHERE outcome = 'merged')
        / nullif(count(*) FILTER (WHERE outcome <> 'open'), 0), 1) AS merged_pct_of_resolved
FROM completion
GROUP BY repo
ORDER BY repo;
```

**Rounds and time in flight** per merged issue, from its first `claimed` to its first `merged`: review
rounds are the distinct `round` values of its `reviewed` events, fix rounds its transitions to fixing
(one per `(life, seq)`), and time in flight leaves out the time parked (a `transition` to parked until
the issue's next transition).

```sql
WITH merged AS (
  SELECT repo, issue, min(ts) AS merged_at
  FROM factory.event_log WHERE type = 'merged' AND issue IS NOT NULL GROUP BY repo, issue
), claimed AS (
  SELECT repo, issue, min(ts) AS claimed_at
  FROM factory.event_log WHERE type = 'claimed' AND issue IS NOT NULL GROUP BY repo, issue
), spans AS (
  SELECT m.repo, m.issue, least(c.claimed_at, m.merged_at) AS from_ts, m.merged_at AS to_ts
  FROM merged m LEFT JOIN claimed c ON c.repo = m.repo AND c.issue = m.issue
), tr AS (  -- one row per (issue, life, seq), with the issue's next transition
  SELECT repo, issue, seq_at, to_state, lead(seq_at) OVER (PARTITION BY repo, issue ORDER BY seq_at, seq) AS next_at
  FROM (
    SELECT repo, issue, life, seq, seq_at, to_state,
           row_number() OVER (PARTITION BY repo, issue, life, seq ORDER BY ts, device, device_seq) AS n
    FROM factory.event_log WHERE type = 'transition' AND issue IS NOT NULL
  ) x
  WHERE n = 1
)
SELECT s.repo, s.issue, s.to_ts AS merged_at,
  (SELECT count(DISTINCT r.round) FROM factory.event_log r
   WHERE r.repo = s.repo AND r.issue = s.issue AND r.type = 'reviewed'
     AND r.ts BETWEEN s.from_ts AND s.to_ts)                                  AS review_rounds,
  (SELECT count(*) FROM tr f
   WHERE f.repo = s.repo AND f.issue = s.issue AND f.to_state = 'fixing'
     AND f.seq_at BETWEEN s.from_ts AND s.to_ts)                              AS fix_rounds,
  round(extract(epoch FROM s.to_ts - s.from_ts) - coalesce((
    SELECT sum(extract(epoch FROM least(coalesce(t.next_at, s.to_ts), s.to_ts) - greatest(t.seq_at, s.from_ts)))
    FROM tr t
    WHERE t.repo = s.repo AND t.issue = s.issue AND t.to_state = 'parked'
      AND t.seq_at < s.to_ts AND coalesce(t.next_at, s.to_ts) > s.from_ts), 0)) AS in_flight_s
FROM spans s
ORDER BY s.to_ts DESC;
```

**Held time** (the owner's `don't-merge` hold, v2 SPEC 9.1): one `hold:dont-merge` person intervention
starts a hold and the next `hold:released` ends it; a hold the owner never released ends at the PR's
`merged` or at the next `transition` out of merge-queue, whichever comes first. A merge-queue record
the label holds waits on the owner, not on the loop, and a label that could not be read writes no
event, so this counts the owner's choices only.

```sql
-- per hold: how long the owner held a PR out of the queue, from each hold:dont-merge to the next
-- hold:released, merged, or transition out of merge-queue (held_s is null while the hold is open)
WITH ev AS (
  SELECT repo, issue, life, ts, cause
  FROM (
    SELECT repo, issue, life, ts, cause,
           row_number() OVER (PARTITION BY repo, issue, who, cause, coalesce(fact, event_id::text, ts::text)
                              ORDER BY ts, device, device_seq) AS n
    FROM factory.event_log
    WHERE type = 'intervention' AND who = 'person' AND cause IN ('hold:dont-merge', 'hold:released')
      AND issue IS NOT NULL
  ) x
  WHERE n = 1
), holds AS (
  SELECT repo, issue, life, ts AS held_at FROM ev WHERE cause = 'hold:dont-merge'
)
SELECT h.repo, h.issue, h.life, h.held_at,
  e.ended_at,
  round(extract(epoch FROM e.ended_at - h.held_at))::bigint AS held_s
FROM holds h
LEFT JOIN LATERAL (
  SELECT min(t) AS ended_at FROM (
    SELECT r.ts AS t FROM ev r
      WHERE r.repo = h.repo AND r.issue = h.issue AND r.life IS NOT DISTINCT FROM h.life
        AND r.cause = 'hold:released' AND r.ts > h.held_at
    UNION ALL
    SELECT m.ts FROM factory.event_log m
      WHERE m.repo = h.repo AND m.issue = h.issue AND m.type = 'merged' AND m.ts > h.held_at
    UNION ALL
    SELECT x.seq_at FROM factory.event_log x
      WHERE x.repo = h.repo AND x.issue = h.issue AND x.type = 'transition'
        AND x.life IS NOT DISTINCT FROM h.life AND x.seq_at > h.held_at AND x.to_state <> 'merge-queue'
  ) u
) e ON true
ORDER BY h.held_at DESC;
```

**Release holds** (the merge queue's hold for a release's bump PR, v2 SPEC 9.1): the loop logs one
`hold:release` loop intervention when a hold starts, fact `hold/release/pr<p>/start`, and one end,
fact `hold/release/pr<p>/end`, with cause `hold:release-merged`, `hold:release-closed` or
`hold:release-timeout`. Each device logs its own, so an event is counted once per fact. The detail
names the queue heads whose merge the hold deferred. A hold with no end yet has a null `held_s`.

```sql
-- per hold: when the bump PR's hold started, how it ended and how long it lasted
WITH ev AS (
  SELECT repo, pr, fact, cause, min(ts) AS ts
  FROM factory.event_log
  WHERE type = 'intervention' AND who = 'loop' AND cause LIKE 'hold:release%'
    AND fact LIKE 'hold/release/pr%' AND pr IS NOT NULL
  GROUP BY repo, pr, fact, cause
)
SELECT s.repo, s.pr, s.ts AS held_at,
  e.ts AS ended_at,
  e.cause AS ended_by,
  round(extract(epoch FROM e.ts - s.ts))::bigint AS held_s
FROM ev s
LEFT JOIN ev e ON e.repo = s.repo AND e.pr = s.pr AND e.fact = regexp_replace(s.fact, '/start$', '/end')
WHERE s.cause = 'hold:release'
ORDER BY s.ts DESC;
```

```sql
-- per week: how many release holds ended, and the share that ran out their window (is 10 minutes enough)
WITH ends AS (
  SELECT repo, fact, cause, min(ts) AS ts
  FROM factory.event_log
  WHERE type = 'intervention' AND who = 'loop' AND cause LIKE 'hold:release-%'
    AND fact LIKE 'hold/release/pr%/end'
  GROUP BY repo, fact, cause
)
SELECT date_trunc('week', ts)::date AS week,
  count(*) AS holds,
  count(*) FILTER (WHERE cause = 'hold:release-timeout') AS timeouts,
  round(100.0 * count(*) FILTER (WHERE cause = 'hold:release-timeout') / count(*), 1) AS timeout_pct
FROM ends
GROUP BY 1
ORDER BY 1 DESC;
```

### Actions refusal spells

When GitHub does not start a CI job for the account's sake (failed payments, a spending limit), the
factory loop holds the PRs instead of fixing them and tells the owner once (v2 SPEC 8.5, "Refused
jobs"). A spell runs from the `actions-refused` tell to the `actions-resumed` notice that names it
(`tell:actions-resumed:<the tell's key>`). One row per spell started in the window: when it began, when
it ended (null while open), its minutes, GitHub's message (read from `event_store` as `decision_reason`
is not a column), and the refused runs and PRs the `ci-refused` interventions counted from ten minutes
before it opened (the loop logs a run when it first sees it refused, a pass before the tell) to its end.
The probes and resume re-runs are `ci-refused:probe` and `ci-refused:rerun` interventions, so
`count(*) FILTER (WHERE cause = 'ci-refused:probe')` over the same span gives the probes a spell took.

```sql
SELECT s.started_at, s.resumed_at,
  round(extract(epoch FROM coalesce(s.resumed_at, now()) - s.started_at) / 60) AS minutes,
  s.reason,
  count(DISTINCT i.fact) AS refused_runs, count(DISTINCT i.pr) AS prs
FROM (
  SELECT o.repo, o.key, o.started_at, o.reason,
    (SELECT min(r.ts) FROM factory.event_log r
     WHERE r.type = 'loop_entry' AND r.wake = 'actions-resumed' AND r.repo = o.repo
       AND r.key = 'tell:actions-resumed:' || o.key) AS resumed_at
  FROM (
    SELECT l.repo, l.key, min(l.ts) AS started_at, max(e.data->>'decision_reason') AS reason
    FROM factory.event_log l
    JOIN factory.event_store e ON e.event_id = l.event_id
    WHERE l.type = 'loop_entry' AND l.wake = 'actions-refused' AND l.repo = :'repo'
    GROUP BY l.repo, l.key
    HAVING min(l.ts) >= :'since'
  ) o
) s
LEFT JOIN factory.event_log i
  ON i.repo = s.repo AND i.type = 'intervention' AND i.cause = 'ci-refused'
 AND i.ts >= s.started_at - interval '10 minutes' AND (s.resumed_at IS NULL OR i.ts <= s.resumed_at)
GROUP BY s.repo, s.key, s.started_at, s.resumed_at, s.reason
ORDER BY s.started_at DESC;
```

## 9b. Permission prompts

Reads the `prompt_denied` and `prompt_waiting` events (`prompt_denied.v1.json`, `prompt_waiting.v1.json`):
an agent's tool use that the companion denied, and an agent that stopped on a permission prompt nobody
answers. Neither is a stage or progress. The companion never retries the write, so each row is one
prompt (one per `event_id`).
`tool_name`, `tool_input` and `agent_type` are the columns migration 0014 lifted; a `prompt_waiting` has
no `tool_name` (its notification names none), and its `tool_input` is the notification's message.

One block, two kinds of row told apart by `part`: `daily` is the prompts per repo and day (denied by
`tool_name` and `agent_type`, and waiting), and `blocked` is the issues with a `prompt_waiting` in the last
24 hours (issue, `agent_type`, `tool_input`, `ts`). It takes `-v repo=... -v since=...` (the daily part
only; `blocked` is always the last 24 hours).

```sql
SELECT 'daily' AS part, repo, date_trunc('day', ts)::date AS day, NULL::int AS issue,
  tool_name, agent_type, NULL::text AS tool_input, NULL::timestamptz AS ts,
  count(*) FILTER (WHERE type = 'prompt_denied') AS denied,
  count(*) FILTER (WHERE type = 'prompt_waiting') AS waiting
FROM factory.event_log
WHERE type IN ('prompt_denied', 'prompt_waiting') AND repo = :'repo' AND ts >= :'since'::timestamptz
GROUP BY repo, date_trunc('day', ts)::date, tool_name, agent_type
UNION ALL
SELECT 'blocked', repo, NULL::date, issue, NULL::text, agent_type, tool_input, ts, NULL::bigint, NULL::bigint
FROM factory.event_log
WHERE type = 'prompt_waiting' AND repo = :'repo' AND ts >= now() - interval '24 hours'
ORDER BY 1, 3 DESC, 2, 4, 5, 6;
```

## 9c. Merges, pull requests and gaps

How merges arrive and how a pull request behaves on the way: how many merges per day, how long a
pull request is open before it merges, how often it is replaced or its head moved, and where the
long quiet stretches between merges went. Every query reads `factory.event_log` only, counts a
retried event once by its type's key (a `transition` by `(issue, life, seq)`, a `reviewed` by
`(issue, round, patch)`, an `intervention` by `(issue, who, cause, fact)`), and takes
`-v repo=... -v since=...` (merges at or after `since`; `callum-flow-evaluate` also takes the
window's end). Each repeats the same first CTEs (`ev`, `sig`, `mg`), so it runs on its own. They
need `recovered` as a column: migration 0021 lifts it. `callum-flow-evaluate` reports the same
numbers as its `merges`, `prs` and `gaps` sections, from the new events only.

**A merge** is one per `(repo, issue, pr)`, told by three signals: a `merged` event; a `transition`
to `closed` with `why = 'merged-by-hand'` (timed by `seq_at`); and a person `intervention` with
cause `hand-merge`. A signal whose `pr` is null takes the `pr` of the issue's latest event with a
non-null `pr` at or before it (a `transition`, `reviewed`, `intervention` or `merged`, ties by the
higher `pr`); with none it stays a merge of its own with a null `pr`. The merge's time is its
earliest signal. It is `hand` when any signal says so (`merged.by = 'hand'`, the transition or the
intervention), else `factory`. `recovered` is the `merged` event's `recovered` (true when any
`merged` event of the merge says so), and null when no `merged` event names the merge.

**Merges per day** (#0): per repo and day, by `merged_by` and `recovered`.

```sql
WITH ev AS (
  -- the events that name a pull request, a retried one counted once by its type's key
  SELECT repo, issue, type, pr, at, who, cause, to_state, why, question, life, seq, merged_by, recovered
  FROM (
    SELECT e.repo, e.issue, e.type, e.pr, e.who, e.cause, e.to_state, e.why, e.question, e.life, e.seq,
           e.by AS merged_by, e.recovered,
           CASE WHEN e.type = 'transition' THEN coalesce(e.seq_at, e.ts) ELSE e.ts END AS at,
           row_number() OVER (
             PARTITION BY e.repo, e.issue, e.type,
               CASE e.type
                 WHEN 'transition' THEN coalesce(e.life || '/' || e.seq::text, e.event_id::text)
                 WHEN 'reviewed' THEN coalesce(e.round::text, '') || '/' || coalesce(e.patch, '')
                 WHEN 'intervention' THEN coalesce(e.who, '') || '/' || coalesce(e.cause, '') || '/' || coalesce(e.fact, e.event_id::text)
                 ELSE e.event_id::text
               END
             ORDER BY e.ts, e.device, e.device_seq) AS n
    FROM factory.event_log e
    WHERE e.repo = :'repo' AND e.issue IS NOT NULL
      AND e.type IN ('transition', 'reviewed', 'intervention', 'merged')
  ) x
  WHERE n = 1
), sig AS (
  -- the three signals of a merge
  SELECT repo, issue, pr, at, coalesce(merged_by = 'hand', false) AS hand, true AS is_merged, recovered
  FROM ev WHERE type = 'merged'
  UNION ALL
  SELECT repo, issue, pr, at, true, false, NULL::boolean
  FROM ev WHERE type = 'transition' AND to_state = 'closed' AND why = 'merged-by-hand'
  UNION ALL
  SELECT repo, issue, pr, at, true, false, NULL::boolean
  FROM ev WHERE type = 'intervention' AND who = 'person' AND cause = 'hand-merge'
), mg AS (
  -- one merge per (repo, issue, pr); a signal with no pr takes the issue's latest pr at or before it
  SELECT repo, issue, pr, min(at) AS at,
         CASE WHEN bool_or(hand) THEN 'hand' ELSE 'factory' END AS merged_by,
         bool_or(recovered) FILTER (WHERE is_merged) AS recovered
  FROM (
    SELECT s.repo, s.issue, s.at, s.hand, s.is_merged, s.recovered,
           coalesce(s.pr, (SELECT p.pr FROM ev p
                           WHERE p.repo = s.repo AND p.issue = s.issue AND p.pr IS NOT NULL AND p.at <= s.at
                           ORDER BY p.at DESC, p.pr DESC LIMIT 1)) AS pr
    FROM sig s
  ) r
  GROUP BY repo, issue, pr
)
SELECT repo, (at AT TIME ZONE 'UTC')::date AS day, merged_by, recovered, count(*) AS merges
FROM mg
WHERE at >= :'since'::timestamptz
GROUP BY repo, day, merged_by, recovered
ORDER BY repo, day, merged_by, recovered;
```

**PR open to merge** (#1): per merge, the seconds from the first `transition` or `reviewed` row that
names the merge's `pr` for that issue (at or before the merge) to the merge time. That is "first seen
by the factory", not GitHub's creation time of the pull request; null when no such row exists (and
for a merge with no `pr`).

```sql
WITH ev AS (
  -- the events that name a pull request, a retried one counted once by its type's key
  SELECT repo, issue, type, pr, at, who, cause, to_state, why, question, life, seq, merged_by, recovered
  FROM (
    SELECT e.repo, e.issue, e.type, e.pr, e.who, e.cause, e.to_state, e.why, e.question, e.life, e.seq,
           e.by AS merged_by, e.recovered,
           CASE WHEN e.type = 'transition' THEN coalesce(e.seq_at, e.ts) ELSE e.ts END AS at,
           row_number() OVER (
             PARTITION BY e.repo, e.issue, e.type,
               CASE e.type
                 WHEN 'transition' THEN coalesce(e.life || '/' || e.seq::text, e.event_id::text)
                 WHEN 'reviewed' THEN coalesce(e.round::text, '') || '/' || coalesce(e.patch, '')
                 WHEN 'intervention' THEN coalesce(e.who, '') || '/' || coalesce(e.cause, '') || '/' || coalesce(e.fact, e.event_id::text)
                 ELSE e.event_id::text
               END
             ORDER BY e.ts, e.device, e.device_seq) AS n
    FROM factory.event_log e
    WHERE e.repo = :'repo' AND e.issue IS NOT NULL
      AND e.type IN ('transition', 'reviewed', 'intervention', 'merged')
  ) x
  WHERE n = 1
), sig AS (
  -- the three signals of a merge
  SELECT repo, issue, pr, at, coalesce(merged_by = 'hand', false) AS hand, true AS is_merged, recovered
  FROM ev WHERE type = 'merged'
  UNION ALL
  SELECT repo, issue, pr, at, true, false, NULL::boolean
  FROM ev WHERE type = 'transition' AND to_state = 'closed' AND why = 'merged-by-hand'
  UNION ALL
  SELECT repo, issue, pr, at, true, false, NULL::boolean
  FROM ev WHERE type = 'intervention' AND who = 'person' AND cause = 'hand-merge'
), mg AS (
  -- one merge per (repo, issue, pr); a signal with no pr takes the issue's latest pr at or before it
  SELECT repo, issue, pr, min(at) AS at,
         CASE WHEN bool_or(hand) THEN 'hand' ELSE 'factory' END AS merged_by,
         bool_or(recovered) FILTER (WHERE is_merged) AS recovered
  FROM (
    SELECT s.repo, s.issue, s.at, s.hand, s.is_merged, s.recovered,
           coalesce(s.pr, (SELECT p.pr FROM ev p
                           WHERE p.repo = s.repo AND p.issue = s.issue AND p.pr IS NOT NULL AND p.at <= s.at
                           ORDER BY p.at DESC, p.pr DESC LIMIT 1)) AS pr
    FROM sig s
  ) r
  GROUP BY repo, issue, pr
)
SELECT m.repo, m.issue, m.pr, m.at AS merged_at, f.first_seen,
       round(extract(epoch FROM m.at - f.first_seen))::bigint AS pr_open_to_merge_seconds
FROM mg m
LEFT JOIN LATERAL (
  SELECT min(e.at) AS first_seen FROM ev e
  WHERE e.repo = m.repo AND e.issue = m.issue AND e.type IN ('transition', 'reviewed')
    AND e.pr = m.pr AND e.at <= m.at
) f ON true
WHERE m.at >= :'since'::timestamptz
ORDER BY m.at, m.issue, m.pr;
```

**Pull requests per issue** (#2): per merge, the distinct non-null `pr` values on the issue's
`transition`, `reviewed`, `intervention` and `merged` events from its first `claimed` (else the merge)
to the merge time, and `supersedes`, that count minus one (never below 0): how many pull requests the
factory dropped for a new one.

```sql
WITH ev AS (
  -- the events that name a pull request, a retried one counted once by its type's key
  SELECT repo, issue, type, pr, at, who, cause, to_state, why, question, life, seq, merged_by, recovered
  FROM (
    SELECT e.repo, e.issue, e.type, e.pr, e.who, e.cause, e.to_state, e.why, e.question, e.life, e.seq,
           e.by AS merged_by, e.recovered,
           CASE WHEN e.type = 'transition' THEN coalesce(e.seq_at, e.ts) ELSE e.ts END AS at,
           row_number() OVER (
             PARTITION BY e.repo, e.issue, e.type,
               CASE e.type
                 WHEN 'transition' THEN coalesce(e.life || '/' || e.seq::text, e.event_id::text)
                 WHEN 'reviewed' THEN coalesce(e.round::text, '') || '/' || coalesce(e.patch, '')
                 WHEN 'intervention' THEN coalesce(e.who, '') || '/' || coalesce(e.cause, '') || '/' || coalesce(e.fact, e.event_id::text)
                 ELSE e.event_id::text
               END
             ORDER BY e.ts, e.device, e.device_seq) AS n
    FROM factory.event_log e
    WHERE e.repo = :'repo' AND e.issue IS NOT NULL
      AND e.type IN ('transition', 'reviewed', 'intervention', 'merged')
  ) x
  WHERE n = 1
), sig AS (
  -- the three signals of a merge
  SELECT repo, issue, pr, at, coalesce(merged_by = 'hand', false) AS hand, true AS is_merged, recovered
  FROM ev WHERE type = 'merged'
  UNION ALL
  SELECT repo, issue, pr, at, true, false, NULL::boolean
  FROM ev WHERE type = 'transition' AND to_state = 'closed' AND why = 'merged-by-hand'
  UNION ALL
  SELECT repo, issue, pr, at, true, false, NULL::boolean
  FROM ev WHERE type = 'intervention' AND who = 'person' AND cause = 'hand-merge'
), mg AS (
  -- one merge per (repo, issue, pr); a signal with no pr takes the issue's latest pr at or before it
  SELECT repo, issue, pr, min(at) AS at,
         CASE WHEN bool_or(hand) THEN 'hand' ELSE 'factory' END AS merged_by,
         bool_or(recovered) FILTER (WHERE is_merged) AS recovered
  FROM (
    SELECT s.repo, s.issue, s.at, s.hand, s.is_merged, s.recovered,
           coalesce(s.pr, (SELECT p.pr FROM ev p
                           WHERE p.repo = s.repo AND p.issue = s.issue AND p.pr IS NOT NULL AND p.at <= s.at
                           ORDER BY p.at DESC, p.pr DESC LIMIT 1)) AS pr
    FROM sig s
  ) r
  GROUP BY repo, issue, pr
)
SELECT m.repo, m.issue, m.pr, m.at AS merged_at, p.prs, greatest(p.prs - 1, 0) AS supersedes
FROM mg m
CROSS JOIN LATERAL (
  SELECT count(DISTINCT e.pr) AS prs FROM ev e
  WHERE e.pr IS NOT NULL AND e.repo = m.repo AND e.issue = m.issue AND e.at <= m.at
        AND e.at >= least(coalesce((SELECT min(c.ts) FROM factory.event_log c
                                    WHERE c.repo = m.repo AND c.issue = m.issue AND c.type = 'claimed'), m.at), m.at)
) p
WHERE m.at >= :'since'::timestamptz
ORDER BY m.at, m.issue, m.pr;
```

**Head moves** (#3): per merge, the `intervention` rows with cause `queue:patch` or `push` in the same
span, once each: the times the merge queue or a person moved the pull request's head after the review.
This is v2's equivalent of the v1 `head_mismatch`, which the translator treats as v1-only
([translator.md](factory-events/translator.md)).

```sql
WITH ev AS (
  -- the events that name a pull request, a retried one counted once by its type's key
  SELECT repo, issue, type, pr, at, who, cause, to_state, why, question, life, seq, merged_by, recovered
  FROM (
    SELECT e.repo, e.issue, e.type, e.pr, e.who, e.cause, e.to_state, e.why, e.question, e.life, e.seq,
           e.by AS merged_by, e.recovered,
           CASE WHEN e.type = 'transition' THEN coalesce(e.seq_at, e.ts) ELSE e.ts END AS at,
           row_number() OVER (
             PARTITION BY e.repo, e.issue, e.type,
               CASE e.type
                 WHEN 'transition' THEN coalesce(e.life || '/' || e.seq::text, e.event_id::text)
                 WHEN 'reviewed' THEN coalesce(e.round::text, '') || '/' || coalesce(e.patch, '')
                 WHEN 'intervention' THEN coalesce(e.who, '') || '/' || coalesce(e.cause, '') || '/' || coalesce(e.fact, e.event_id::text)
                 ELSE e.event_id::text
               END
             ORDER BY e.ts, e.device, e.device_seq) AS n
    FROM factory.event_log e
    WHERE e.repo = :'repo' AND e.issue IS NOT NULL
      AND e.type IN ('transition', 'reviewed', 'intervention', 'merged')
  ) x
  WHERE n = 1
), sig AS (
  -- the three signals of a merge
  SELECT repo, issue, pr, at, coalesce(merged_by = 'hand', false) AS hand, true AS is_merged, recovered
  FROM ev WHERE type = 'merged'
  UNION ALL
  SELECT repo, issue, pr, at, true, false, NULL::boolean
  FROM ev WHERE type = 'transition' AND to_state = 'closed' AND why = 'merged-by-hand'
  UNION ALL
  SELECT repo, issue, pr, at, true, false, NULL::boolean
  FROM ev WHERE type = 'intervention' AND who = 'person' AND cause = 'hand-merge'
), mg AS (
  -- one merge per (repo, issue, pr); a signal with no pr takes the issue's latest pr at or before it
  SELECT repo, issue, pr, min(at) AS at,
         CASE WHEN bool_or(hand) THEN 'hand' ELSE 'factory' END AS merged_by,
         bool_or(recovered) FILTER (WHERE is_merged) AS recovered
  FROM (
    SELECT s.repo, s.issue, s.at, s.hand, s.is_merged, s.recovered,
           coalesce(s.pr, (SELECT p.pr FROM ev p
                           WHERE p.repo = s.repo AND p.issue = s.issue AND p.pr IS NOT NULL AND p.at <= s.at
                           ORDER BY p.at DESC, p.pr DESC LIMIT 1)) AS pr
    FROM sig s
  ) r
  GROUP BY repo, issue, pr
)
SELECT m.repo, m.issue, m.pr, m.at AS merged_at, h.head_moves
FROM mg m
CROSS JOIN LATERAL (
  SELECT count(*) AS head_moves FROM ev e
  WHERE e.type = 'intervention' AND e.cause IN ('queue:patch', 'push') AND e.repo = m.repo AND e.issue = m.issue AND e.at <= m.at
        AND e.at >= least(coalesce((SELECT min(c.ts) FROM factory.event_log c
                                    WHERE c.repo = m.repo AND c.issue = m.issue AND c.type = 'claimed'), m.at), m.at)
) h
WHERE m.at >= :'since'::timestamptz
ORDER BY m.at, m.issue, m.pr;
```

**Merge gaps** (#4): the 10 longest gaps between consecutive merges of a repo (by merge time, ties by
the earlier start), each with the issues in flight during it. An issue is **in flight** during a gap
when its state, from its `transition` rows ordered by `seq_at` then `seq` (a state lasts to the next
transition; before the first it has none), was anything but `closed` for part of the gap. `state` is
the `to_state` it held for the most gap time, summed over its visits (a tie goes to the name that
sorts first), and `parked_with_question` says whether it held a `parked` state entered by a
`transition` with a non-null `question` during the gap. `in_flight` is a JSON list ordered by issue.

```sql
WITH ev AS (
  -- the events that name a pull request, a retried one counted once by its type's key
  SELECT repo, issue, type, pr, at, who, cause, to_state, why, question, life, seq, merged_by, recovered
  FROM (
    SELECT e.repo, e.issue, e.type, e.pr, e.who, e.cause, e.to_state, e.why, e.question, e.life, e.seq,
           e.by AS merged_by, e.recovered,
           CASE WHEN e.type = 'transition' THEN coalesce(e.seq_at, e.ts) ELSE e.ts END AS at,
           row_number() OVER (
             PARTITION BY e.repo, e.issue, e.type,
               CASE e.type
                 WHEN 'transition' THEN coalesce(e.life || '/' || e.seq::text, e.event_id::text)
                 WHEN 'reviewed' THEN coalesce(e.round::text, '') || '/' || coalesce(e.patch, '')
                 WHEN 'intervention' THEN coalesce(e.who, '') || '/' || coalesce(e.cause, '') || '/' || coalesce(e.fact, e.event_id::text)
                 ELSE e.event_id::text
               END
             ORDER BY e.ts, e.device, e.device_seq) AS n
    FROM factory.event_log e
    WHERE e.repo = :'repo' AND e.issue IS NOT NULL
      AND e.type IN ('transition', 'reviewed', 'intervention', 'merged')
  ) x
  WHERE n = 1
), sig AS (
  -- the three signals of a merge
  SELECT repo, issue, pr, at, coalesce(merged_by = 'hand', false) AS hand, true AS is_merged, recovered
  FROM ev WHERE type = 'merged'
  UNION ALL
  SELECT repo, issue, pr, at, true, false, NULL::boolean
  FROM ev WHERE type = 'transition' AND to_state = 'closed' AND why = 'merged-by-hand'
  UNION ALL
  SELECT repo, issue, pr, at, true, false, NULL::boolean
  FROM ev WHERE type = 'intervention' AND who = 'person' AND cause = 'hand-merge'
), mg AS (
  -- one merge per (repo, issue, pr); a signal with no pr takes the issue's latest pr at or before it
  SELECT repo, issue, pr, min(at) AS at,
         CASE WHEN bool_or(hand) THEN 'hand' ELSE 'factory' END AS merged_by,
         bool_or(recovered) FILTER (WHERE is_merged) AS recovered
  FROM (
    SELECT s.repo, s.issue, s.at, s.hand, s.is_merged, s.recovered,
           coalesce(s.pr, (SELECT p.pr FROM ev p
                           WHERE p.repo = s.repo AND p.issue = s.issue AND p.pr IS NOT NULL AND p.at <= s.at
                           ORDER BY p.at DESC, p.pr DESC LIMIT 1)) AS pr
    FROM sig s
  ) r
  GROUP BY repo, issue, pr
), m AS (
  SELECT repo, issue, pr, at,
         lead(at) OVER w AS next_at, lead(issue) OVER w AS next_issue, lead(pr) OVER w AS next_pr
  FROM mg
  WHERE at >= :'since'::timestamptz
  WINDOW w AS (PARTITION BY repo ORDER BY at, issue, pr)
), gaps AS (
  SELECT repo, gap_no, gap_from, gap_to, before_issue, before_pr, after_issue, after_pr
  FROM (
    SELECT repo, at AS gap_from, next_at AS gap_to, issue AS before_issue, pr AS before_pr,
           next_issue AS after_issue, next_pr AS after_pr,
           row_number() OVER (ORDER BY next_at - at DESC, at) AS gap_no
    FROM m WHERE next_at IS NOT NULL
  ) z
  WHERE gap_no <= 10
), st AS (
  -- each issue's states from its transitions: a state lasts to the next transition, the last has no end
  SELECT repo, issue, to_state, question, at AS s_from,
         coalesce(lead(at) OVER (PARTITION BY repo, issue ORDER BY at, seq, life), 'infinity'::timestamptz) AS s_to
  FROM ev WHERE type = 'transition'
), held AS (
  SELECT g.gap_no, s.issue, s.to_state,
         sum(extract(epoch FROM least(s.s_to, g.gap_to) - greatest(s.s_from, g.gap_from))) AS held_seconds,
         bool_or(s.to_state = 'parked' AND s.question IS NOT NULL) AS asked
  FROM gaps g
  JOIN st s ON s.repo = g.repo AND s.s_from < g.gap_to AND s.s_to > g.gap_from AND s.to_state <> 'closed'
  GROUP BY g.gap_no, s.issue, s.to_state
), flight AS (
  SELECT gap_no, issue, to_state,
         bool_or(asked) OVER (PARTITION BY gap_no, issue) AS asked,
         row_number() OVER (PARTITION BY gap_no, issue ORDER BY held_seconds DESC, to_state) AS n
  FROM held
)
SELECT g.repo, g.gap_from, g.gap_to, round(extract(epoch FROM g.gap_to - g.gap_from))::bigint AS gap_seconds,
       g.before_issue, g.before_pr, g.after_issue, g.after_pr,
       coalesce(jsonb_agg(jsonb_build_object('issue', f.issue, 'state', f.to_state, 'parked_with_question', f.asked)
                          ORDER BY f.issue) FILTER (WHERE f.issue IS NOT NULL), '[]'::jsonb) AS in_flight
FROM gaps g
LEFT JOIN flight f ON f.gap_no = g.gap_no AND f.n = 1
GROUP BY g.gap_no, g.repo, g.gap_from, g.gap_to, g.before_issue, g.before_pr, g.after_issue, g.after_pr
ORDER BY g.gap_no;
```

**Unrecorded merges the sweep logged** (run only; cbundy/dev-system#752): the merges to the default
branch that no `merged` event recorded and `callum-flow-sweep` (rule 7) logged afterwards, per repo and
week, split by whether the sweep tied the merge to an issue. Takes `-v repo=... -v since=...`.

```sql
SELECT repo, date_trunc('week', ts)::date AS week, issue IS NULL AS no_issue, count(DISTINCT pr) AS merges
FROM factory.event_log
WHERE type = 'merged' AND actor = 'sweep' AND by = 'hand' AND coalesce(recovered, false)
  AND repo = :'repo' AND ts >= :'since'::timestamptz
GROUP BY repo, week, no_issue
ORDER BY week DESC, no_issue;
```

**Merges missing their size** (run only; cbundy/dev-system#752): the `merged` events of a pull request
whose size (`additions`) the producer could not read, per repo, week and producer (`actor`, with `by`).
Takes `-v repo=... -v since=...`.

```sql
SELECT repo, date_trunc('week', ts)::date AS week, actor, by,
       count(*) AS merges, count(*) FILTER (WHERE additions IS NULL) AS missing_size
FROM factory.event_log
WHERE type = 'merged' AND pr IS NOT NULL AND repo = :'repo' AND ts >= :'since'::timestamptz
GROUP BY repo, week, actor, by
HAVING count(*) FILTER (WHERE additions IS NULL) > 0
ORDER BY week DESC, missing_size DESC;
```

## 10. Releases

Reads the `released` and `milestone_state` events and loop_entry's `wake` and `decision`. The
factory loop writes them: rule O4 logs each new release tag through `callum-flow-released`, and rule
O5 logs one `milestone_state` per change of the Next release milestone's reading (docs/factory-loop/v2/SPEC.md
11). A repo with no Next release milestone logs neither. Count a release once by `(repo, tag)`.

Releases per week and the pull requests each carried:

```sql
SELECT date_trunc('week', ts)::date AS week, repo, tag, previous_tag,
  jsonb_array_length(prs) AS pr_count, prs
FROM factory.event_log
WHERE type = 'released'
ORDER BY week DESC, ts DESC;
```

How long Next sat full before each release (from the first milestone with closed work after the
previous release to the release):

```sql
WITH rel AS (
  SELECT repo, tag, min(ts) AS ts,
    lag(min(ts)) OVER (PARTITION BY repo ORDER BY min(ts)) AS prev_ts
  FROM factory.event_log
  WHERE type = 'released'
  GROUP BY repo, tag
)
SELECT r.repo, r.tag, r.ts AS released_at,
  r.ts - (
    SELECT min(m.ts) FROM factory.event_log m
    WHERE m.type = 'milestone_state' AND m.repo = r.repo AND m.milestone_closed > 0
      AND (r.prev_ts IS NULL OR m.ts > r.prev_ts) AND m.ts <= r.ts
  ) AS sat_full
FROM rel r
ORDER BY r.ts DESC;
```

How often the judge held, per week (wakes that decided hold, and the milestone states where holding
turned true):

```sql
WITH judged AS (
  SELECT date_trunc('week', ts)::date AS week, count(*) AS wakes_held
  FROM factory.event_log
  WHERE type = 'loop_entry' AND wake = 'release' AND decision = 'hold'
  GROUP BY 1
), states AS (
  SELECT ts, holding, lag(holding) OVER (PARTITION BY repo ORDER BY ts) AS was_holding
  FROM factory.event_log
  WHERE type = 'milestone_state'
), turned AS (
  SELECT date_trunc('week', ts)::date AS week, count(*) AS holds_started
  FROM states
  WHERE holding AND coalesce(was_holding, false) = false
  GROUP BY 1
)
SELECT coalesce(j.week, t.week) AS week,
  coalesce(j.wakes_held, 0) AS wakes_held, coalesce(t.holds_started, 0) AS holds_started
FROM judged j FULL JOIN turned t ON j.week = t.week
ORDER BY 1 DESC;
```

Why the judge held, per week (the release wake's reason, one line of at most 200 characters, read
from `event_store` as `decision_reason` is not a column):

```sql
SELECT date_trunc('week', l.ts)::date AS week, s.data->>'decision_reason' AS reason, count(*) AS holds
FROM factory.event_log l
JOIN factory.event_store s ON s.event_id = l.event_id
WHERE l.type = 'loop_entry' AND l.wake = 'release' AND l.decision = 'hold'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;
```

## Main after merge

Reads the `main_state` events. The factory loop writes one (rule M1) when the state of the default
branch it read differs from the last one it logged; it reads the branch every `mainEveryMs` (5
minutes) in act mode. Count a state once by `(repo, device, observed_at)`.

Main's newest state per repo:

```sql
SELECT s.repo, s.branch, s.head, s.pr, s.observed_at, s.green, s.changed
FROM factory.event_log s
WHERE s.type = 'main_state'
  AND s.observed_at = (
    SELECT max(n.observed_at) FROM factory.event_log n
    WHERE n.type = 'main_state' AND n.repo = s.repo)
GROUP BY s.repo, s.branch, s.head, s.pr, s.observed_at, s.green, s.changed
ORDER BY s.repo;
```

Did main stay green after each merge? `first_green` is the first state observed at or after the
merge and `first_observed_at` is when it was observed; `settled_green` is the newest state of that pull request, before main's head moved on. Both
are null when no state was observed. The join is on `pr`, not `head`: a squash merge's commit on
main is not the head that `merged` records.

```sql
SELECT m.repo, m.pr, m.ts AS merged_at,
  (SELECT f.green FROM factory.event_log f
    WHERE f.type = 'main_state' AND f.repo = m.repo AND f.pr = m.pr AND f.ts >= m.ts
    ORDER BY f.observed_at ASC LIMIT 1) AS first_green,
  (SELECT l.green FROM factory.event_log l
    WHERE l.type = 'main_state' AND l.repo = m.repo AND l.pr = m.pr
    ORDER BY l.observed_at DESC LIMIT 1) AS settled_green,
  (SELECT f.observed_at FROM factory.event_log f
    WHERE f.type = 'main_state' AND f.repo = m.repo AND f.pr = m.pr AND f.ts >= m.ts
    ORDER BY f.observed_at ASC LIMIT 1) AS first_observed_at
FROM factory.event_log m
WHERE m.type = 'merged' AND m.pr IS NOT NULL
ORDER BY m.ts DESC;
```

## Workers

The [base image's worker heartbeat reference](../images/base/README.md#worker-heartbeat)
owns the row fields, state rules, staleness threshold and notifications.

Fleet status:

```sql
SELECT device, state, stale, age, base_image, dev_image, plugin_version,
       jsonb_array_length(in_flight) AS in_flight_count, critical_failures
FROM factory.workers_status
ORDER BY stale, device;
```

Live Claude sessions and sub-agents, with the context window when known:

```sql
SELECT w.device, s->>'session_id' AS session_id, s->>'parent_session_id' AS parent_session_id,
       (s->>'context_window')::int AS context_window
FROM factory.workers_status w, jsonb_array_elements(w.sessions) s
WHERE NOT w.stale AND w.state <> 'stopped';
```

Latest machine load per worker (the stats columns are NULL until a worker's first beat after the
[migration](../images/base/README.md#machine-stats)):

```sql
SELECT device, state, stale, cpu_pct, cpu_limit_cores, cpu_quota_set,
       round(mem_used_bytes / 1048576.0) AS mem_used_mib, round(mem_limit_bytes / 1048576.0) AS mem_limit_mib,
       claude_interactive, claude_headless, claude_procs, procs, stats_at,
       mem_max_events, mem_max_rate_per_min, mem_oom_kills, mem_psi_some_avg10, mem_psi_full_avg10
FROM factory.workers_status
ORDER BY stale, device;
```

Load trend per device, hourly over the last day (samples are kept 30 days):

```sql
SELECT device, date_trunc('hour', sampled_at) AS hour,
       round(avg(cpu_pct)::numeric, 1) AS cpu_avg, max(cpu_pct) AS cpu_max,
       round(avg(mem_used_bytes) / 1048576.0) AS mem_avg_mib, round(max(mem_used_bytes) / 1048576.0) AS mem_max_mib
FROM factory.worker_samples
WHERE sampled_at > now() - interval '1 day'
GROUP BY device, hour
ORDER BY device, hour;
```

Memory pressure per device, hourly over the last day (the rate is how often the container hit its memory
limit per minute; `psi_full` is the percent of time all tasks stalled on memory, and a rate above 0, any
OOM kill or `psi_full` of 10 or more means the machine is short of memory; the columns are NULL on cgroup v1):

```sql
SELECT device, date_trunc('hour', sampled_at) AS hour,
       max(mem_max_rate_per_min) AS max_rate_per_min,
       max(mem_psi_full_avg10) AS psi_full_max, round(avg(mem_psi_full_avg10)::numeric, 2) AS psi_full_avg,
       max(mem_oom_kills) - min(mem_oom_kills) AS oom_kills_growth
FROM factory.worker_samples
WHERE sampled_at > now() - interval '1 day'
GROUP BY device, hour
ORDER BY device, hour;
```

## Settings

Settings the loop runs on. A `settings_changed` event records one change of one setting (see
[REFERENCE.md](factory-events/REFERENCE.md)); `factory.workers.config` holds each worker's latest
settings snapshot, written by each worker's heartbeat (images/base/README.md, "Settings snapshot"). The loop writes
`settings_changed` (rule N1): each acting pass compares its settings with the last it kept and logs one event per
setting that differs (at most 50 per pass), with `who` (person, judge, repo or plugin) and the `layer` of the new value
(null for a derived value such as `derived.gateConcurrency`). The first pass after a start logs none, only keeps the snapshot.

Settings changes over time, newest first (one row per `fact`, the once key; the same change seen by two
devices counts once):

```sql
SELECT ts, repo, device, key, layer, who, old_value, new_value
FROM (
  SELECT e.*, row_number() OVER (PARTITION BY e.fact ORDER BY e.ts, e.device) AS n
  FROM factory.event_log e
  WHERE e.type = 'settings_changed') c
WHERE n = 1
ORDER BY ts DESC, key;
```

Settings in force per worker. `config` is null while a worker has no snapshot (no loop settings file, or one that
is unreadable, invalid or oversize). Judge how fresh a snapshot is by `config->>'at'`, the loop's last observing
pass, never by `last_seen`: a worker keeps beating after its loop stops writing the snapshot:

```sql
SELECT device, repo, config->>'at' AS settings_at,
  now() - (config->>'at')::timestamptz AS settings_age, config->'settings' AS settings
FROM factory.workers_status
ORDER BY device;
```

## Spend on an API key

A `usage` event ([REFERENCE.md](factory-events/REFERENCE.md)) taken on an API key records dollars, not window
percentages. `auth` says which login the reading was taken under (`subscription` or `api-key`). A spend reading has
`source` `spend`, `available` true and null window fields; `spend_usd` is the dollars spent in the current budget period,
`budget_usd` the budget for that period and `budget_resets_at` when the period resets. All four are null on every
other usage event, and no producer writes them yet.

Spend per day against the budget, per repo and device: the day's last reading, its percent of the budget (null when
there is no budget) and `spent_that_day`, the day's last spend less the previous day's last spend in the same budget
period (the same `budget_resets_at`), else the day's own last spend:

```sql
WITH last_per_day AS (
  SELECT repo, device, date_trunc('day', ts) AS day, spend_usd, budget_usd, budget_resets_at
  FROM (
    SELECT e.*, row_number() OVER (PARTITION BY e.repo, e.device, date_trunc('day', e.ts) ORDER BY e.ts DESC) AS n
    FROM factory.event_log e
    WHERE e.type = 'usage' AND e.available AND e.auth = 'api-key' AND e.spend_usd IS NOT NULL
      AND e.repo = :'repo' AND e.ts >= :'since'::timestamptz) r
  WHERE n = 1)
SELECT day::date AS day, repo, device, spend_usd, budget_usd,
  round(100 * spend_usd / nullif(budget_usd, 0)) AS pct_of_budget,
  CASE WHEN lag(day) OVER w IS NOT NULL AND lag(budget_resets_at) OVER w IS NOT DISTINCT FROM budget_resets_at
       THEN spend_usd - lag(spend_usd) OVER w
       ELSE spend_usd END AS spent_that_day
FROM last_per_day
WINDOW w AS (PARTITION BY repo, device ORDER BY day)
ORDER BY repo, device, day;
```

Time in each tier while on an API key, per repo and device. The tier is worked out from `100 * spend_usd / budget_usd`
against the default thresholds 85 / 90 / 95 (slow, stop-new, stop-all); they mirror
`plugins/factory-loop/hooks/config.ts` (`usageSlowPct`, `usageStopNewPct`, `usageStopAllPct`) and are edited here when
the loop's are. A reading lasts until the next reading of the same device, at most 15 minutes (`usageStaleMs`); a
reading with no spend or no budget counts as `unknown`:

```sql
SELECT repo, device,
  CASE WHEN pct IS NULL THEN 'unknown'
       WHEN pct >= 95 THEN 'stop-all'
       WHEN pct >= 90 THEN 'stop-new'
       WHEN pct >= 85 THEN 'slow'
       ELSE 'normal' END AS tier,
  sum(held) AS time_in_tier
FROM (
  SELECT repo, device, 100 * spend_usd / nullif(budget_usd, 0) AS pct,
    least(coalesce(lead(ts) OVER (PARTITION BY repo, device ORDER BY ts), now()) - ts, interval '15 minutes') AS held
  FROM factory.event_log
  WHERE type = 'usage' AND available AND auth = 'api-key'
    AND repo = :'repo' AND ts >= :'since'::timestamptz) r
GROUP BY repo, device, tier
ORDER BY repo, device, tier;
```

## Tokens per merged issue

An agent step's `loop_entry` ([REFERENCE.md](factory-events/REFERENCE.md)) carries, when the step has ended
(`done`, `failed`, `timed-out` or `lost`), `input_tokens`, `output_tokens`, `cache_read_tokens` and
`cache_creation_tokens`, and `model`, the full id of the model the step's agent actually ran on. The loop reads them
from the step agent's transcript when the entry ends: usage once per distinct `requestId` (the last line of a streamed
response wins, as in [Token and wake definitions](#token-and-wake-definitions)), plus every agent nested under the
step agent. They are null on a running event, on every other kind, on events from a loop older than this field, and
when the transcript could not be found (the decision log then names the step key and "transcript not found").

The queries count each agent once: the newest ended `loop_entry` of an agent step per `(repo, agent_id)` that has
tokens, so a re-logged end, a restart and a repaired agent (the repair resumes the same agent) are one agent, and a
retry is a new agent. They take every attempt of a merged issue in every life. A merged issue is one with a `merged`
event in the window; `since` narrows by when it merged. `steps_without_tokens` counts the ended agent steps (one per
key) of those issues with no counted agent behind them, so a gap is visible rather than silently low.

What they leave out: the loop's own main-session wakes and judge turns, the tells, and the no-mistakes pipeline's
agents; only the step agents the loop spawned are here. A step's `role` is read from its key: `i<N>/l<life>/s<seq>/<step>/a<n>`
or, for a review, `i<N>/l<life>/review/<patch>/r<round>/a<n>`.

Per merged issue, the four token sums and their total over all its attempts:

```sql
WITH merged AS (
  SELECT repo, issue, min(ts) AS merged_at
  FROM factory.event_log
  WHERE type = 'merged' AND issue IS NOT NULL AND repo = :'repo' AND ts >= :'since'::timestamptz
  GROUP BY repo, issue),
steps AS (
  SELECT e.*, row_number() OVER (PARTITION BY e.repo, e.key ORDER BY e.ts DESC, e.device_seq DESC) AS n
  FROM factory.event_log e
  WHERE e.type = 'loop_entry' AND e.kind = 'agent-step' AND e.status IN ('done', 'failed', 'timed-out', 'lost')
    AND e.repo = :'repo'),
counted AS (
  SELECT s.*, row_number() OVER (PARTITION BY s.repo, s.agent_id ORDER BY s.ts DESC, s.device_seq DESC) AS rn
  FROM factory.event_log s
  WHERE s.type = 'loop_entry' AND s.kind = 'agent-step' AND s.status IN ('done', 'failed', 'timed-out', 'lost')
    AND s.repo = :'repo' AND s.agent_id IS NOT NULL AND s.input_tokens IS NOT NULL),
tokens AS (SELECT * FROM counted WHERE rn = 1),
gaps AS (
  SELECT s.repo, s.issue, count(*) AS steps_without_tokens
  FROM steps s
  WHERE s.n = 1
    AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.repo = s.repo AND t.agent_id = s.agent_id)
  GROUP BY s.repo, s.issue)
SELECT m.repo, m.issue, m.merged_at,
  count(t.agent_id) AS agents,
  coalesce(sum(t.input_tokens), 0) AS input_tokens,
  coalesce(sum(t.output_tokens), 0) AS output_tokens,
  coalesce(sum(t.cache_read_tokens), 0) AS cache_read_tokens,
  coalesce(sum(t.cache_creation_tokens), 0) AS cache_creation_tokens,
  coalesce(sum(t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens), 0) AS total_tokens,
  coalesce(max(g.steps_without_tokens), 0) AS steps_without_tokens
FROM merged m
LEFT JOIN tokens t ON t.repo = m.repo AND t.issue = m.issue
LEFT JOIN gaps g ON g.repo = m.repo AND g.issue = m.issue
GROUP BY m.repo, m.issue, m.merged_at
ORDER BY m.merged_at, m.issue;
```

The same split per model (the full id the agent ran on; `unknown` for an agent whose transcript held no model):

```sql
WITH merged AS (
  SELECT repo, issue
  FROM factory.event_log
  WHERE type = 'merged' AND issue IS NOT NULL AND repo = :'repo' AND ts >= :'since'::timestamptz
  GROUP BY repo, issue),
counted AS (
  SELECT s.*, row_number() OVER (PARTITION BY s.repo, s.agent_id ORDER BY s.ts DESC, s.device_seq DESC) AS rn
  FROM factory.event_log s
  WHERE s.type = 'loop_entry' AND s.kind = 'agent-step' AND s.status IN ('done', 'failed', 'timed-out', 'lost')
    AND s.repo = :'repo' AND s.agent_id IS NOT NULL AND s.input_tokens IS NOT NULL)
SELECT t.repo, coalesce(t.model, 'unknown') AS model,
  count(*) AS agents,
  sum(t.input_tokens) AS input_tokens,
  sum(t.output_tokens) AS output_tokens,
  sum(t.cache_read_tokens) AS cache_read_tokens,
  sum(t.cache_creation_tokens) AS cache_creation_tokens,
  sum(t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens) AS total_tokens
FROM counted t
JOIN merged m ON m.repo = t.repo AND m.issue = t.issue
WHERE t.rn = 1
GROUP BY t.repo, coalesce(t.model, 'unknown')
ORDER BY t.repo, total_tokens DESC;
```

The same split per step role, with the steps that have no tokens:

```sql
WITH merged AS (
  SELECT repo, issue
  FROM factory.event_log
  WHERE type = 'merged' AND issue IS NOT NULL AND repo = :'repo' AND ts >= :'since'::timestamptz
  GROUP BY repo, issue),
steps AS (
  SELECT e.*, row_number() OVER (PARTITION BY e.repo, e.key ORDER BY e.ts DESC, e.device_seq DESC) AS n
  FROM factory.event_log e
  WHERE e.type = 'loop_entry' AND e.kind = 'agent-step' AND e.status IN ('done', 'failed', 'timed-out', 'lost')
    AND e.repo = :'repo'),
counted AS (
  SELECT s.*, row_number() OVER (PARTITION BY s.repo, s.agent_id ORDER BY s.ts DESC, s.device_seq DESC) AS rn
  FROM factory.event_log s
  WHERE s.type = 'loop_entry' AND s.kind = 'agent-step' AND s.status IN ('done', 'failed', 'timed-out', 'lost')
    AND s.repo = :'repo' AND s.agent_id IS NOT NULL AND s.input_tokens IS NOT NULL),
tokens AS (SELECT * FROM counted WHERE rn = 1),
roles AS (
  SELECT s.repo, s.issue,
    CASE WHEN split_part(s.key, '/', 3) ~ '^s[0-9]+$' THEN split_part(s.key, '/', 4) ELSE split_part(s.key, '/', 3) END AS role,
    t.agent_id AS counted_agent, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens
  FROM steps s
  LEFT JOIN tokens t ON t.repo = s.repo AND t.agent_id = s.agent_id
  WHERE s.n = 1)
SELECT r.repo, r.role,
  count(r.counted_agent) AS agents,
  coalesce(sum(r.input_tokens), 0) AS input_tokens,
  coalesce(sum(r.output_tokens), 0) AS output_tokens,
  coalesce(sum(r.cache_read_tokens), 0) AS cache_read_tokens,
  coalesce(sum(r.cache_creation_tokens), 0) AS cache_creation_tokens,
  count(*) FILTER (WHERE r.counted_agent IS NULL) AS steps_without_tokens
FROM roles r
JOIN merged m ON m.repo = r.repo AND m.issue = r.issue
GROUP BY r.repo, r.role
ORDER BY r.repo, r.role;
```

## Observe time per pass

A `loop_passes` event ([REFERENCE.md](factory-events/REFERENCE.md)) summarises one UTC minute of the loop's passes. Four
optional fields split the time of each pass's observe call: `observe_mean_ms` (the mean wall time),
`observe_commands_mean_ms` (the mean time with at least one read in flight), `observe_in_process_mean_ms` (the mean
in-process time) and `observe_in_process_max_ms` (the longest in-process time). All four are null when no pass in the
minute had a measure, and absent from older loops' events. The loop writes them from this release on.

Per hour, repo and device, the pass-weighted mean of each (`sum(x * passes) / sum(passes)`, so a busy minute counts for
more than a quiet one) and the longest in-process time, from the minutes that have a measure:

```sql
SELECT date_trunc('hour', from_at) AS hour, repo, device,
  sum(passes) AS passes,
  round(sum(observe_mean_ms::numeric * passes) / sum(passes)) AS observe_ms,
  round(sum(observe_commands_mean_ms::numeric * passes) / sum(passes)) AS commands_ms,
  round(sum(observe_in_process_mean_ms::numeric * passes) / sum(passes)) AS in_process_ms,
  max(observe_in_process_max_ms) AS in_process_max_ms
FROM factory.event_log
WHERE type = 'loop_passes' AND observe_mean_ms IS NOT NULL AND passes > 0
  AND repo = :'repo' AND from_at >= :'since'::timestamptz
GROUP BY 1, repo, device
ORDER BY 1, repo, device;
```

## Pass time

A pass no longer waits for the sweep, the heartbeat or a merge: all run off the pass ([v2 SPEC 13.6.1](factory-loop/v2/SPEC.md#1361-catalogue)),
so passes over 20 s should be rare from this release on. Per hour, repo and device, from the `loop_passes` events (`mean_ms` and
`max_ms` are one minute's mean and longest pass): the passes, their pass-weighted mean, the longest pass, and the minutes
whose longest pass was over 20 s (a restart held for a running merge shows as the decision log's R2 skip line `update due: waiting on <keys>`, passes before the restart):

```sql
SELECT date_trunc('hour', from_at) AS hour, repo, device,
  sum(passes) AS passes,
  round(sum(mean_ms::numeric * passes) / sum(passes)) AS mean_ms,
  max(max_ms) AS max_ms,
  count(*) FILTER (WHERE max_ms > 20000) AS minutes_over_20s
FROM factory.event_log
WHERE type = 'loop_passes' AND mean_ms IS NOT NULL AND passes > 0
  AND repo = :'repo' AND from_at >= :'since'::timestamptz
GROUP BY 1, repo, device
ORDER BY 1, repo, device;
```

With trace mode on, each record lists the off-pass commands that finished since the last record (`offPass`: `cmd`, `key`, `ms`,
`exit`, `endedAt`). How long they ran, per command, from a day's trace file in the loop dir:

```sh
jq -s '[.[].offPass[]?] | group_by(.cmd) | map({cmd: .[0].cmd, runs: length, failed: (map(select(.exit != 0)) | length),
  mean_ms: (map(.ms) | add / length | round), max_ms: (map(.ms) | max)})' trace-2026-10-21.jsonl
```

The session title's rename is one of these commands (`cmd: "title"`), so the same query shows how long renames
take. The renames that failed or timed out, with the reason:

```sh
jq -c '.offPass[]? | select(.cmd == "title" and .error != null)' trace-2026-10-21.jsonl
```

## Shadow runs (source switch)

Shadow is opt-in for `callum-flow-factory-state`, `callum-flow-evaluate` and `heartbeat-state` since their default moved to `new` on 2026-10-18 ([replay.md](factory-events/replay.md#defaults-moved-to-new)); set `--source shadow` to record. Records of the source switch's shadow mode ([replay.md](factory-events/replay.md#source-switch)) are
kept per device in `factory/.shadow/<tool>.jsonl` under the events folder. The exceptions write `shadow_read` events instead and are read by [6b](#6b-reader-shadow-compares): the claim tools, and the factory loop's record rebuild (`eventsSource`, written only when set to `shadow`, as the claim tools' are). Per tool since a given time:
runs, clean runs (`differences == 0` and no `new_error`), runs with differences, runs with a new error,
and the most frequent differing paths:

```sh
jq -s --arg since 2026-10-18T00:00:00Z '
  map(select(.ts >= $since)) | group_by(.tool) | map({
    tool: .[0].tool,
    runs: length,
    clean: map(select(.differences == 0 and .new_error == null)) | length,
    with_differences: map(select((.differences // 0) > 0)) | length,
    with_new_error: map(select(.new_error != null)) | length,
    top_paths: ([.[].paths[]?.path] | group_by(.) | map({path: .[0], n: length}) | sort_by(-.n) | .[:5])
  })' "${CALLUM_EVENTS_DIR:-/persist/events}"/factory/.shadow/*.jsonl
```

For one tool, `callum-flow-evaluate`, the share of runs that agree per day, and the most common
differing paths (a run whose new side was skipped or failed has `new_error` set and is not counted as agreeing):

```sh
jq -s --arg since 2026-10-18T00:00:00Z '
  map(select(.tool == "evaluate" and .ts >= $since)) | {
    per_day: (group_by(.ts[:10]) | map({day: .[0].ts[:10], runs: length,
      agree_pct: (100 * (map(select(.differences == 0 and .new_error == null)) | length) / length | round)})),
    top_paths: ([.[].paths[]?.path] | group_by(.) | map({path: .[0], n: length}) | sort_by(-.n) | .[:5])
  }' "${CALLUM_EVENTS_DIR:-/persist/events}"/factory/.shadow/evaluate.jsonl
```

For `heartbeat-state` (it runs on every beat, so its agreeing runs are sampled: a clean record is written at most once per
`CALLUM_FLOW_HEARTBEAT_STATE_SHADOW_QUIET_SECONDS`, default 600, while every difference and every failed new read is
written), per day: records, those with differences, those with a new error, the most common differing paths and the
slowest new read:

```sh
jq -s --arg since 2026-10-18T00:00:00Z '
  map(select(.tool == "heartbeat-state" and .ts >= $since)) | group_by(.ts[:10]) | map({
    day: .[0].ts[:10], records: length,
    with_differences: map(select((.differences // 0) > 0)) | length,
    with_new_error: map(select(.new_error != null)) | length,
    top_paths: ([.[].paths[]?.path] | group_by(.) | map({path: .[0], n: length}) | sort_by(-.n) | .[:5]),
    max_new_ms: (map(.new_ms) | max)
  })' "${CALLUM_EVENTS_DIR:-/persist/events}"/factory/.shadow/heartbeat-state.jsonl
```

## Offline computation: `callum-flow-evaluate`

`callum-flow-evaluate --repo <owner/name> --since <ISO> [--until <ISO>] [--format json|markdown]
[--events <file>] [--nm-export <file>] [--ready-times <file>] [--regime <value>]` (base image, `images/base/callum-flow-evaluate`)
computes the numbers of queries 1 to 4, 6, 7 and 9 for a time window from an events file (`--events`,
default the local event log; a `factory.events` export covers every device), plus token spend, waste
and pipeline numbers from Claude Code transcripts and the no-mistakes `state.sqlite`. It reads the
old event log, not the factory database. It is read-only, makes no network calls and is
deterministic. The `evaluate-sessions` skill runs it and writes the report; every number in a report
comes from this tool. Differences from the SQL above: the SQL reads the factory database; the window
selects issues by their `merged` event (query 1) or first `merge_ready` (query 2) and verdicts by
their own timestamp (query 3), and the events file is the one device's log unless a `factory.events`
export is passed (see the skill).

- `throughput` (query 1) and `waiting` (query 7) take every pipeline run start from the linked
  runs of the no-mistakes source (`state.sqlite` or `--nm-export`), by the rules in
  [Linking pipeline runs to issues](factory-state.md#linking-pipeline-runs-to-issues); `run_started` events are read only for the legacy link, never for a
  timestamp. Each lead-time row carries `run_source`: `mirror` (the first linked run is linked by
  its branch), `run_started` (linked only by a legacy event) or `none`. With no linked run in the
  source, `implementation` and `pipeline` are `null`, never a number from the events, and nothing
  is pipeline-bound in the waiting split. `pipeline.unlinked_runs` counts this repo's runs created
  in the window that no issue claims (runs with no `repo` belong to no
  repo and are not counted). A run created before `--since` for an issue merged inside the window
  must be in the source, so export the mirror from a lookback earlier than the window start.
- `per_device` (query 4, plus claims and `claim_lost` per device) and `claims` (query 6:
  `double_claims`, `claim_lost`, `reclaimed`, `stuck`) read each event's `device`. The stuck test
  is evaluated at the window's end; its lease comes from `CALLUM_FLOW_LEASE_MINUTES` (default 120).
- `waiting` (query 7) gives each merged issue's split and the totals, `other_idle_pct_of_wait`
  and a `decision`: `B` when more than 50% of the wait was dispatcher-bound with another device
  idle, `gate` otherwise.
- `interventions`, `judgement_calls`, `claim_completion` and `rounds` are section 9's numbers over
  the window: interventions logged in the window by who and cause, per day (with the fleet-level
  ones) and per merged issue (`untouched` when none named its merged work, as section 9 defines it);
  judgement calls made in the window by kind and outcome, with those overridden; the lives claimed
  in the window and how each ended (`open` when it had not by the window's end, censored); and per
  merged issue its review and fix rounds and its time in flight less the time parked. Each counts a
  retried event once, as section 9 does. A merged issue's lead-time row takes its pipeline start from
  its first `transition` to reviewing when it has no linked run (`run_source` `transition`).
- `merges`, `prs` and `gaps` are section 9c's numbers over the window, from the new events' `pr`, `by`
  and `recovered` fields: the merges whose time is in the window (a `merged` event, a hand-merge
  transition or a person `hand-merge` intervention, one per issue and `pr`) by `by` and `recovered`,
  per day and per merge; per merge the seconds from the first `transition` or `reviewed` naming its
  `pr` to the merge ("first seen by the factory"), the pull requests it went through, how many it
  superseded and its head moves (`queue:patch` and `push` interventions), with the median and max
  computed in code; and the 10 longest gaps between consecutive in-window merges, each with the
  issues in flight. They read `n/a` with a reason for no events, for 0 merges (`gaps`: fewer than 2)
  and under `--source old`.
- `--source old|new|shadow` (else `CALLUM_FLOW_EVALUATE_SOURCE`, else `new`; `old` is the way back) picks the event store
  ([source switch](factory-events/replay.md#source-switch)). `old` is the behaviour above. `new` reads the
  new events, from `${CALLUM_EVENTS_DIR:-/persist/events}/factory/<owner>__<name>.jsonl`, or with
  `--new-events <file>` from a file of `factory.event_log` rows (`--events` is ignored under `new`).
  `shadow` prints the `old` report and appends one record to `factory/.shadow/evaluate.jsonl`; it
  skips the new side when `--events` is given without `--new-events`, and a failing new side never fails
  the tool. See "Reading the new events" below.
- `--ready-times <file>` is a JSON object `{"<issue>": "<ISO>" | ["<ISO>", ...]}` of the times
  each issue got its `ready` label, from the GitHub timeline. The tool takes the last one at or
  before the issue's first `claimed`, and falls back to the first `ready` event (each lead-time
  row says which as `ready_source`). Merged issues with neither read `n/a` and are counted in
  `issues_without_ready`, so a report can state how many lead times it could not compute.

### Regimes

`--regime <factory_loop_v2|testbed|manual|unknown>` keeps only the events whose `regime` equals the value
(a null, empty or missing regime is `unknown`; any other value, or none, exits 2 with the usage line). The
filter runs before pipeline runs are linked and before the event metrics are computed, and `window.regime` says
which value was given, or `all`. Without the flag, `throughput.by_regime` lists per regime `merged_issues` (the
throughput derivation on that regime's events), `closed_issues` (distinct issues with a `closed` event in the
window) and `claims` (`claimed` events in the window), and `spend.by_regime` lists the spend rows of each regime
(for a role and model they add up to `spend.rows`); both hold exactly the regimes that appear among the window's
events or attributed turns, sorted by name, and are omitted with `--regime`, where they would repeat the totals.

A transcript turn has no regime of its own. It takes one through the transcript's session (a sub-agent takes its
parent's): the regime of the latest regime-carrying event of that session at or before the turn's time, the first
such event's regime for an earlier turn, and `unknown` when no event of the session carries one. Pipeline
(no-mistakes) invocations have no session, so they are `unknown`. With `--regime R`, `spend.rows` counts only the
turns attributed to R, and the pipeline rows only when R is `unknown`. `waste`, `pipeline` and
`sub_agent_model_mismatches` are not filtered by regime. A regime is never guessed from a device, workspace name
or path. Events written before v0.81.0 carry no `regime` or `session_id` and read as `unknown` and no session.
The shadow and replay comparisons leave both `by_regime` keys out (the old source's records carry no regime).

### Reading the new events

Under `--source new` one mapping (`images/base/evaluate-new-events.js`) turns each new event, from the
local log (payload under `data`) or from a `factory.event_log` row (flat columns), into the record the
derivations above already read, so there is one copy of every metric. A transition logged more than
once counts once per (issue, life, seq), the first kept.

| New event | Becomes |
|---|---|
| `transition` | a `transition` timed by its `seq_at`, with `life`, `seq`, `row` (`table_row`), `from`, `to`, `via`, `why` and `question` (`yes` when the transition has one) |
| `transition` into `building`, `fixing`, `merge-queue` (from another state) | also `delegated`, `fix_requested`, `merge_ready`, timed by `seq_at` |
| `finding_handled` | `verdict`: `fixed` is `CORRECT`, `declined` is `WRONG` |
| `claim_renewed`, `requeued` | `renewed`, `reclaimed` |
| `loop_entry`, `loop_passes` | `loop`, with `kind`, `key`, `status` and `wake` |
| `intervention` | `intervention` with `who`, `cause`, `life`, `fact` |
| `reviewed` | `reviewed` with `verdict`, `round`, `patch` |
| `merged` | `merged` with `by` and `recovered` |
| `test_weakened` | `test_weakened` with `restored` (no step: always `none` under v2) |
| `abandoned` | `abandoned` with `reason` |
| `ready`, `claimed`, `claim_lost`, `closed`, `implementer_routed`, `untrusted_stripped`, `usage` | the same name |

Every record also carries the event's `pr` (null when it has none) and its `device_seq` (a view
row's; the local log has none, so file order breaks ties), which the 9c sections read.

Metrics that need a v1-only state read `n/a`, never 0, and `sources` names each one and why:
`waiting` (needs `run_started` and `parked`), `adjudicator_agreement` (pairs verdicts by the v1 `run_id`).
`first_pass` keeps its number but counts only `fix_requested` as a setback, as `failed` is v1 only
(`sources` says so). The per-issue lead-time stages `design`, `implementation`, `pipeline` and
`waiting_for_merge` can differ by seconds from `old`, which times `delegated` and `merge_ready` by the
line's write time; the shadow comparison leaves them out, with the `sources` block, the two `n/a` metrics and the
`merges`, `prs` and `gaps` sections (they read `n/a` under `--source old`: "needs the new events' pr, by and recovered fields").
A view export carries `reviewed.patch` and `test_weakened.restored` from migration 0006, and `merged.recovered`
from migration 0021. The fleet export is
`dev-query --factory -At -c "SELECT row_to_json(e) FROM factory.event_log e WHERE repo = :'repo' AND ts >= :'since'" -v repo=<owner/name> -v since=<ISO>`.

### Scope and the fleet-wide no-mistakes export

Every report says which scope each source covers, in `window.scope` (one `Scope:` line under
`window` in markdown):

- `pipeline`: `workspace` when the numbers come from this device's `state.sqlite`, `fleet` when
  `--nm-export` is given.
- `events`: `workspace` for the local event log, `fleet` when `--events` is given (a
  `factory.events` export is expected there).
- `transcripts`: always `workspace`.

`--nm-export <file>` replaces `state.sqlite` as the source of every pipeline number
(`pipeline`, the `pipeline:<step>` rows in `spend`, `window.pipeline_runs`). The tool still opens
`state.sqlite` for `repos.working_path`, which `nm-export` never ships, to find this checkout's
transcripts; its `sources` row says it is used for transcript discovery only. The export is read
offline, so the tool makes no network call in either mode.

The file is JSON lines, one `{"table": "<name>", "row": {...}}` per row, with the column names of
the `nomistakes` tables. The tool uses `runs`, `step_results`, `step_rounds` and
`agent_invocations` and ignores any other table, unknown columns and lines that are not JSON,
like `--events`. Timestamps are the ISO strings `timestamptz` gives; they give the same numbers
as the epoch seconds in `state.sqlite`. A missing file makes the pipeline metrics `n/a` with the
reason. A column that an older export lacks (`step_results.status`, `step_rounds.trigger_type`,
`agent_invocations.purpose`, `runs.parked_ms`, `runs.awaiting_agent_since`) makes only the
metrics that need it `n/a`. The export query, which covers every repo and device (the
`raw` column is dropped) and the `step_results`, `step_rounds`, `agent_invocations` and
`run_agent_sessions` of the runs it selects, plus `repos`:

```sh
dev-query -At -v since=<ISO> > /tmp/nm-export.jsonl <<'SQL'
WITH r AS (
  SELECT * FROM nomistakes.runs WHERE created_at >= :'since'::timestamptz
), s AS (
  SELECT x.* FROM nomistakes.step_results x JOIN r ON r.id = x.run_id
)
SELECT jsonb_build_object('table', 'runs', 'row', to_jsonb(r) - 'raw') FROM r
UNION ALL
SELECT jsonb_build_object('table', 'step_results', 'row', to_jsonb(s) - 'raw') FROM s
UNION ALL
SELECT jsonb_build_object('table', 'step_rounds', 'row', to_jsonb(d) - 'raw')
FROM nomistakes.step_rounds d JOIN s ON s.id = d.step_result_id
UNION ALL
SELECT jsonb_build_object('table', 'agent_invocations', 'row', to_jsonb(i) - 'raw')
FROM nomistakes.agent_invocations i JOIN r ON r.id = i.run_id
UNION ALL
SELECT jsonb_build_object('table', 'run_agent_sessions', 'row', to_jsonb(a) - 'raw')
FROM nomistakes.run_agent_sessions a JOIN r ON r.id = a.run_id
UNION ALL
SELECT jsonb_build_object('table', 'repos', 'row', to_jsonb(p) - 'raw') FROM nomistakes.repos p;
SQL
```

Do not filter by `device` or `repo`: `pipeline.by_device` and `pipeline.by_repo` need
every device's rows, and the report should list every device that ran.

### Pipeline definitions

All of these are in `pipeline`, computed from the runs created in the window for `--repo`, from
either source. A key is `n/a` on its own when its columns are missing.

- **Gate first-pass rate** (`gates`): per `step_name`, the steps that ended `completed` or
  `failed` (`skipped`, `pending` and `running` are left out), how many of those `completed` with
  no round whose `trigger_type` is not `initial`, and that share as a percentage. This is the
  pipeline's gate, not the issue-level `first_pass` of section 2.
- **Fix rounds** (`fix_rounds`): step rounds with a `trigger_type` other than `initial` (in
  practice `auto_fix`). Reported as the total, the count per `step_name` (every step that ran,
  zero included) and `max_per_run`, the most in any one run.
- **Tokens by model and purpose** (`tokens_by_model_purpose`): one row per `(model, purpose)`
  with `invocations` and input, output, cache_read and cache_creation tokens, reported
  separately. An empty model or purpose reads `unknown`. Sorted by model, then purpose.
- **Time parked** (`parked`): over the runs with `parked_ms > 0`, the count (`runs_parked`), total,
  median and max in seconds. `awaiting_agent` counts runs with `awaiting_agent_since` set, as of
  when the data was read, which is the window's end only for a report run right after it.
- **`by_device`**: the four metrics above per `device`, for `--repo`. In workspace mode there is
  one row named `DEV_MACHINE_NAME`, else the hostname (the rule `nm-export --device` uses).
- **`by_repo`**: the same per repo, over every repo in the source (workspace mode names a repo
  from `repos.upstream_url`). It is the one key that ignores `--repo`, and its `scope` field says
  so.

### Token and wake definitions

- **Turn**: one distinct `requestId` among a transcript's assistant lines, with the last usage seen
  for that `requestId` (never summed per line, as one model response is streamed as several lines).
  Lines outside the window are dropped by `timestamp`. The same rule as mealplanning's
  `analyze-agent-run.ts`.
- **Tokens**: input, output, cache_read and cache_creation tokens, reported separately; a "wake's
  tokens" is the sum of the four over its turns.
- **Regime**: a turn's regime comes from its session's events, see "Regimes" above; the `unknown` rule and the
  attribution apply to every spend row.
- **Role**: the main session is `orchestrator`; a sub-agent's role is its `agent-<id>.meta.json`
  `agentType`, else `unknown`; pipeline agent invocations are `pipeline:<step_name>`, restricted
  to runs of the repo created in the window (their `turns` are `model_roundtrips`).
- **Wake**: a user line carrying a `<task-notification>`, a `scheduled_task_fire` system line, or
  an owner prompt, in the main session. Kind: `monitor-event`, `monitor-timeout` (a Monitor that
  ended or a task stopped), `agent-done`, `bash-done`, `cron` or `owner`, from the notification
  summary. The wake's turns are those until the next wake.
- **Idle wake**: a non-owner wake with at least one turn and no action call. Action calls are
  `Agent`, `Edit`, `Write`, or a `Bash` call matching `gh (issue|pr) (create|comment|edit|merge|close|ready)`,
  `gh workflow run`, `git (commit|push|rebase)`, `axi (run|respond|abort)` or
  `callum-flow-(claim|merge|event|fix-linkage)`.
- **Re-arm**: an idle wake whose only calls relaunch a Monitor or a background `Bash` (calls to
  `ToolSearch` and `TaskStop` alongside are ignored). Counted within idle wakes.
- **Stale wake**: a notification for a task id that already notified `completed`, or whose text
  names an issue (`#N`) or a pipeline run id whose `merged` event is earlier than the wake.
- **Repeated check**: an identical, whitespace-normalised `Bash` command repeated within 10 minutes
  with no action call in between. Its tokens are those of the turns containing a repeat.

The 10-minute window and the action list are constants in the script; tune them after real use.
Idle, re-arm and stale wakes overlap (a re-arm is idle, a stale wake can be idle).

### Startup schema migrates

`factory-db-migrate` (run by `dev-init` before the loop starts, cbundy/dev-system#888) writes one
`loop_entry` per run that found the migrator secret: a `task` with key `task:migrate:<to_version>`,
wake `migrate`, status `done`, `failed` or `timed-out`, and the payload fields `database`,
`from_version`, `to_version`, `duration_ms`, `outcome` (`migrated`, `current`, `failed`,
`timed-out`) and `error`. They are not columns of `factory.event_log`, so the query reads
`factory.event_store.data`. It answers when each database moved to each version, how long a migrate
takes, how often it fails, and how long a database sat behind the newest image: the first attempt,
the first success, the failed attempts and the time between them, per `database` and `to_version`.
Take the time a migrate takes (p50, p95) in code from `duration_ms`. A join with
`factory.schema_migrations.applied_at` (a query against that one database) confirms when the version landed. While a status is
`failed` or `timed-out` the loop stays in observe and tells the owner once (`TELL schema-behind`).

```sql
SELECT s.data->>'database' AS database, (s.data->>'to_version')::int AS to_version,
  min(l.ts) AS first_attempt,
  min(l.ts) FILTER (WHERE s.data->>'outcome' IN ('migrated', 'current')) AS first_done,
  count(*) FILTER (WHERE s.data->>'outcome' IN ('failed', 'timed-out')) AS failed_attempts,
  round(extract(epoch FROM
    min(l.ts) FILTER (WHERE s.data->>'outcome' IN ('migrated', 'current')) - min(l.ts)) / 60) AS minutes_behind
FROM factory.event_log l
JOIN factory.event_store s ON s.event_id = l.event_id
WHERE l.type = 'loop_entry' AND l.kind = 'task' AND s.data->>'wake' = 'migrate'
GROUP BY 1, 2
ORDER BY first_attempt DESC;
```
