# Factory metrics

The factory event log answers the questions below, plus the waste measures at the end. Events are
written by `callum-flow-event` and shipped by `factory-event-push-loop` into the factory database
(see [Where events live](factory-events/README.md#where-events-live)). Every saved query here reads
the view `factory.event_log`, or for the workers `factory.workers_status` and
`factory.worker_samples`; none reads the old `factory.events` table or the `nomistakes` mirror.

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
  a build.

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
companion (`rules-gates.ts`, SPEC 10.6). `wait_ms` is the time before it got a turn (0 when it
took one at once or there is no limit), `run_ms` the time the commands ran (0 when they never
did), `queued_behind` how many gates held a turn or waited ahead when it asked, `concurrency` the
limit it ran under (null: none), and `started_at` when it asked for its turn. A retried write can
repeat an event, so each run counts once per (issue, life, seq, started_at). The query reads the
columns migration 0002 lifted into `factory.event_log` and gives one row per run. There are no
rows before a loop with this rule has run.

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
issue, life and step. `rerun_via` `free:load` with table row `U1` is the free re-run (SPEC 5.1,
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

## 4. Merges per device

```sql
SELECT device, date_trunc('week', ts)::date AS week, count(DISTINCT (repo, issue)) AS merges
FROM factory.event_log
WHERE type = 'merged'
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

## 6b. Reader shadow compares

How often a reader with an old/new source switch (`reader`, such as `claim-events`) found its two
sources disagreeing. The command that compares (`tool`) writes one `shadow_read` event per compare,
not per issue (`shadow_read.v1.json`). `differences` counts keys whose answers differ with both
sides cut at the settle time, `live_differences` the same on everything read (push lag included),
and `old_ok` / `new_ok` say whether that side's central read succeeded. A retried write can repeat
an event, so each compare counts once per (repo, device, ts). The query reads the columns migration
0005 lifted into `factory.event_log`, and `detail` (not lifted) from the same event's `data` in
`factory.event_store`. It takes `-v repo=... -v since=...`. The producer is the claim tools'
held rule (`images/base/claim-events.sh`): `callum-flow-claim` and `callum-flow-sweep` write one
event per run in their default `shadow` source (`CALLUM_FLOW_CLAIM_EVENTS_SOURCE`), with
`reader = 'claim-events'` and `tool` the command. `differences` counts issues whose held decision
(lifecycle class, latest claim type, claim device) differs, over the last 7 days cut 10 minutes
before now; the query groups by reader and tool.

```sql
-- per reader, tool, device and day: compares, differences, failed reads, newest difference detail
WITH compares AS (
  SELECT e.reader, e.tool, e.device, e.ts, e.differences, e.live_differences, e.old_ok, e.new_ok,
         s.data ->> 'detail' AS detail,
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
  max(detail) FILTER (WHERE newest = 1 AND differences > 0) AS newest_detail
FROM once
GROUP BY reader, tool, device, date_trunc('day', ts)
ORDER BY day DESC, reader, tool, device;
```

## 7. The waiting split

Each merged issue's wall-clock time from `ready` to `merged`, cut into two parts:

- **Dispatcher-bound**: `ready` to the first `claimed`; each `transition` to parked until the issue's
  next transition; each `transition` to merge-queue until the next `merged` or transition.
- **Agent work**: the rest (`total` minus `dispatcher_bound`).

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

The implementer's own token spend is not in this database: read it from the implementer rows of the
`spend` section of `callum-flow-evaluate`, which has one row per role and model. A random split
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

## 9. Interventions, judgement calls and claim completion

The factory loop v2's effectiveness, as issue #632 asks for it, from `factory.event_log` alone. Every
query counts a retried event once (see the reading rules above), and all of them apply to any regime
that logs these types. `callum-flow-evaluate` reports the same numbers over a window (its
`interventions`, `judgement_calls`, `claim_completion` and `rounds` sections).

**Interventions** (#632 metric 1): an `intervention` event is any point where a person, or the loop
with unplanned judgement or recovery, had to step in. A merged issue is **untouched** when no
intervention of either kind names its merged work; untouched merges are the target outcome. An
intervention names the merged work by its `life` when that life began by the first `merged` (a
`transition` of the life, timed by `seq_at`, at or before it), whenever the intervention itself was
logged: the loop derives most of them a pass or more after their fact, so a hand merge's can land
after the `merged` event. One with no life (an owner op, a hand-recorded rescue, a control-file edit),
or a life no `transition` names, counts from the first `claimed` to the issue's closing `transition`
(the first to `closed` since its last claim before the merge; else the merge) plus 30 minutes.
Fleet-level interventions (no `issue`) attach to no issue.

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
by row `T3` or `T4`) and a fixer's dispositions (`finding_handled` events of actor `fixer`, `fixed`
or `declined`). A call is **overridden** when a person intervention names its issue within an hour
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
       claude_interactive, claude_headless, claude_procs, procs, stats_at
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

## Shadow runs (source switch)

Records of the source switch's shadow mode ([replay.md](factory-events/replay.md#source-switch)) are
kept per device in `factory/.shadow/<tool>.jsonl` under the events folder. Per tool since a given time:
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

## Offline computation: `callum-flow-evaluate`

`callum-flow-evaluate --repo <owner/name> --since <ISO> [--until <ISO>] [--format json|markdown]
[--events <file>] [--nm-export <file>] [--ready-times <file>]` (base image, `images/base/callum-flow-evaluate`)
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
- `--source old|new|shadow` (else `CALLUM_FLOW_EVALUATE_SOURCE`, else `shadow`) picks the event store
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

### Reading the new events

Under `--source new` one mapping (`images/base/evaluate-new-events.js`) turns each new event, from the
local log (payload under `data`) or from a `factory.event_log` row (flat columns), into the record the
derivations above already read, so there is one copy of every metric. A transition logged more than
once counts once per (issue, life, seq), the first kept.

| New event | Becomes |
|---|---|
| `transition` | a `transition` timed by its `seq_at`, with `life`, `seq`, `row` (`table_row`), `from`, `to` and `via` |
| `transition` into `building`, `fixing`, `merge-queue` (from another state) | also `delegated`, `fix_requested`, `merge_ready`, timed by `seq_at` |
| `finding_handled` | `verdict`: `fixed` is `CORRECT`, `declined` is `WRONG` |
| `claim_renewed`, `requeued` | `renewed`, `reclaimed` |
| `loop_entry`, `loop_passes` | `loop` |
| `intervention` | `intervention` with `who`, `cause`, `life`, `fact` |
| `reviewed` | `reviewed` with `verdict`, `round`, `patch` |
| `test_weakened` | `test_weakened` with `restored` (no step: always `none` under v2) |
| `abandoned` | `abandoned` with `reason` |
| `ready`, `claimed`, `claim_lost`, `merged`, `closed`, `implementer_routed`, `untrusted_stripped`, `usage` | the same name |

Metrics that need a v1-only state read `n/a`, never 0, and `sources` names each one and why:
`waiting` (needs `run_started` and `parked`), `adjudicator_agreement` (pairs verdicts by the v1 `run_id`).
`first_pass` keeps its number but counts only `fix_requested` as a setback, as `failed` is v1 only
(`sources` says so). The per-issue lead-time stages `design`, `implementation`, `pipeline` and
`waiting_for_merge` can differ by seconds from `old`, which times `delegated` and `merge_ready` by the
line's write time; the shadow comparison leaves them out, with the `sources` block and the two `n/a` metrics.
A view export carries `reviewed.patch` and `test_weakened.restored` from migration 0006. The fleet export is
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
