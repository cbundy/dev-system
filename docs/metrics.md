# Factory metrics

The factory event log (`callum-flow-event`, shipped to the `factory.events` table by
`event-push-loop`; see "Factory event log" in `images/base/README.md`) answers the questions
below, plus the waste measures at the end. Each query below runs as is in `psql` against the agentsview PostgreSQL. When running them by hand against a URL with
`sslmode=verify-full` or `verify-ca`, set `PGSSLROOTCERT=system` or add `sslrootcert=system`
to it, as psql 17 has no default root cert (`event-push-loop` does this itself).
Rows are keyed `(device, repo, seq)`; `issue` joins to GitHub, and to Claude cost and token
metrics through the `issue` and `device` resource attributes the orchestrator sets on
sub-agents.

A second schema, `nomistakes`, mirrors the no-mistakes pipeline database (see "no-mistakes
pipeline data" below); it joins to `factory.events` on `run_id`.

Columns: `device`, `repo`, `seq`, `ts`, `state`, `issue`, `run_id`, `branch`, `pr`, `head`,
`note`, `session_id`, `actor`, `v`, `raw`.

## 1. Lead time by stage

Per issue, the time between the first occurrence of each state on the way to a merge. Watcher
states carry the polling interval's delay (queue 2 minutes, pipeline 25 seconds).
`ready` can repeat when a watcher restarts with a stale `--known`, so the query uses the first one per issue.

```sql
WITH first AS (
  SELECT repo, issue, state, min(ts) AS ts
  FROM factory.events
  WHERE issue IS NOT NULL
    AND state IN ('ready', 'claimed', 'delegated', 'run_started', 'merge_ready', 'merged')
  GROUP BY repo, issue, state
)
SELECT repo, issue,
  min(ts) FILTER (WHERE state = 'claimed')     - min(ts) FILTER (WHERE state = 'ready')       AS waiting_for_claim,
  min(ts) FILTER (WHERE state = 'delegated')   - min(ts) FILTER (WHERE state = 'claimed')     AS design,
  min(ts) FILTER (WHERE state = 'run_started') - min(ts) FILTER (WHERE state = 'delegated')   AS implementation,
  min(ts) FILTER (WHERE state = 'merge_ready') - min(ts) FILTER (WHERE state = 'run_started') AS pipeline,
  min(ts) FILTER (WHERE state = 'merged')      - min(ts) FILTER (WHERE state = 'merge_ready') AS waiting_for_merge,
  min(ts) FILTER (WHERE state = 'merged')      - min(ts) FILTER (WHERE state = 'ready')       AS total
FROM first
GROUP BY repo, issue
HAVING bool_or(state = 'merged')
ORDER BY min(ts) FILTER (WHERE state = 'merged') DESC;
```

## 2. First-pass gate pass rate

The share of issues whose pipeline went green with no failed run and no fix requested before
the first `merge_ready`.

```sql
WITH per_issue AS (
  SELECT repo, issue,
    min(ts) FILTER (WHERE state = 'merge_ready')                  AS first_green,
    min(ts) FILTER (WHERE state IN ('failed', 'fix_requested'))   AS first_setback
  FROM factory.events
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

## 3. Reviewer false-positive rate

`verdict` events carry the adjudication prefix in `note` (`CORRECT:`, `WRONG:`, `NIT:`, `ENV:`,
`DUP:`). The rate is `WRONG / (CORRECT + WRONG)`.

```sql
SELECT repo,
  count(*) FILTER (WHERE note LIKE 'CORRECT%') AS correct,
  count(*) FILTER (WHERE note LIKE 'WRONG%')   AS wrong,
  round(100.0 * count(*) FILTER (WHERE note LIKE 'WRONG%')
        / nullif(count(*) FILTER (WHERE note LIKE 'CORRECT%' OR note LIKE 'WRONG%'), 0), 1) AS false_positive_pct
FROM factory.events
WHERE state = 'verdict'
GROUP BY repo;
```

## 4. Merges per device

```sql
SELECT device, date_trunc('week', ts)::date AS week, count(DISTINCT (repo, issue)) AS merges
FROM factory.events
WHERE state = 'merged'
GROUP BY device, week
ORDER BY week DESC, merges DESC;
```

## 5. Adjudicator agreement

How often the adjudicator and the other verdict authorities (the orchestrator, the reviewer) reach
the same prefix on the same finding. A `verdict` note is `PREFIX: <finding-id> reason`, and the
pair key is `(run_id, finding-id)`, with the finding id being the first token after the prefix
(for example `review-1`). A pair needs one verdict from actor `adjudicator` and one from a
different actor. Agreement is same-prefix pairs over pairs; with no pairs it reports `n/a (0 pairs)`
and counts the adjudicator verdicts that had no partner.

```sql
WITH v AS (
  SELECT repo, run_id, actor,
    substring(note FROM '^\s*([A-Z]+)\s*:')          AS prefix,
    substring(note FROM '^\s*[A-Z]+\s*:\s*(\S+)')   AS finding
  FROM factory.events
  WHERE state = 'verdict' AND run_id IS NOT NULL
), adj AS (
  SELECT DISTINCT ON (repo, run_id, finding) repo, run_id, finding, prefix FROM v
  WHERE actor = 'adjudicator' AND finding IS NOT NULL ORDER BY repo, run_id, finding
), other AS (
  SELECT DISTINCT ON (repo, run_id, finding) repo, run_id, finding, prefix FROM v
  WHERE actor <> 'adjudicator' AND finding IS NOT NULL ORDER BY repo, run_id, finding
)
SELECT adj.repo, count(*) AS pairs, count(*) FILTER (WHERE adj.prefix = other.prefix) AS agreed,
  round(100.0 * count(*) FILTER (WHERE adj.prefix = other.prefix) / nullif(count(*), 0), 1) AS agreement_pct
FROM adj JOIN other USING (repo, run_id, finding)
GROUP BY adj.repo;
```

## 6. Double-claims, lost claim races and stuck issues

The two-device trial (cbundy/dev-system#222) asks whether two dispatchers ever hold one issue at
once. A **double-claim** is two devices with a live `claimed` on one issue and no `ready`,
`reclaimed`, `merged` or `abandoned` between them. A **lost race** is a `claim_lost` event,
logged by `callum-flow-claim` on exit 3 (the note says who holds the issue): it proves the lanes
contended. An issue is **stuck** when it is claimed (a `claimed` after its last `ready`,
`reclaimed`, `merged` or `abandoned`) and has had no event, other than `claim_lost`, for more than
twice the claim lease (2 x 120 minutes by default, `CALLUM_FLOW_LEASE_MINUTES`).

```sql
-- double-claims: one row per pair of overlapping claims
SELECT c2.repo, c2.issue, c1.device AS first_device, c2.device AS second_device, c2.ts AS at
FROM factory.events c2
JOIN factory.events c1
  ON c1.repo = c2.repo AND c1.issue = c2.issue AND c1.state = 'claimed'
 AND c1.device <> c2.device AND c1.ts < c2.ts
WHERE c2.state = 'claimed'
  AND NOT EXISTS (
    SELECT 1 FROM factory.events r
    WHERE r.repo = c2.repo AND r.issue = c2.issue
      AND r.state IN ('ready', 'reclaimed', 'merged', 'abandoned')
      AND r.ts >= c1.ts AND r.ts <= c2.ts)
ORDER BY c2.ts;

-- lost races, and reclaimed leases, per device
SELECT device,
  count(*) FILTER (WHERE state = 'claim_lost') AS claim_lost,
  count(*) FILTER (WHERE state = 'reclaimed')  AS reclaimed
FROM factory.events
GROUP BY device;

-- stuck issues
WITH per_issue AS (
  SELECT repo, issue,
    max(ts) FILTER (WHERE state <> 'claim_lost')                                  AS last_ts,
    (array_agg(state ORDER BY ts DESC) FILTER (WHERE state <> 'claim_lost'))[1]   AS last_state,
    max(ts) FILTER (WHERE state IN ('ready', 'reclaimed', 'merged', 'abandoned')) AS last_release,
    max(ts) FILTER (WHERE state = 'claimed')                                      AS last_claim
  FROM factory.events
  WHERE issue IS NOT NULL
  GROUP BY repo, issue
)
SELECT repo, issue, last_state, last_ts, now() - last_ts AS silent
FROM per_issue
WHERE last_claim IS NOT NULL
  AND (last_release IS NULL OR last_claim > last_release)
  AND now() - last_ts > interval '4 hours'
ORDER BY last_ts;
```

## 7. The waiting split

Each merged issue's wall-clock time from `ready` to `merged`, cut into three parts:

- **Pipeline-bound**: `run_started` to the run's next `merge_ready` (or `failed`, or the next
  `run_started`), including CI. Parked time is excluded, because a parked gate waits on the
  dispatcher.
- **Dispatcher-bound**: `ready` to the first `claimed`; each `parked` to its next `verdict` or
  `fix_requested` (or `merge_ready`, `failed`, `merged`); each `merge_ready` to the next `merged`,
  `run_started` or `failed`.
- **Agent work**: the rest.

A dispatcher-bound second is flagged "another device idle" when, at that moment, some device other
than the issue's owner (the device of its first `claimed`) was alive and held no in-flight issue.
A device is alive for 30 minutes after any event it logged (`usage` included). It holds an issue
from its `claimed` until that issue's next `ready`, `reclaimed`, `merged` or `abandoned`.

**The B-or-gate rule.** Wait is pipeline-bound plus dispatcher-bound seconds. If the
dispatcher-bound seconds flagged "another device idle" are more than 50% of the wait, the
dispatcher (option B) is what limits throughput; otherwise invest in the gate.

Most issues have no `ready` event, because `queue-watch.sh` logs one only for issues missing from
its baseline. The `ready` time therefore comes from each issue's GitHub timeline, the last
`labeled` `ready` event before the claim. Collect them with
`gh api repos/<owner>/<name>/issues/<n>/timeline --paginate` and put them in `ready_times`
below; an issue with no row falls back to its first `ready` event. The SQL needs PostgreSQL 14 or
later (multiranges). It is the twin of the tool's `waiting` section: the tool also clips the
"alive" window at the report's end, which the SQL does not.

```sql
WITH ready_times(repo, issue, ts) AS (
  -- replace with the labeled-ready times from the timeline, e.g.
  --   VALUES ('cbundy/dev-system', 222, '2026-10-09T08:00:00Z'::timestamptz), ...
  SELECT NULL::text, NULL::int, NULL::timestamptz WHERE false
), merged AS (
  SELECT repo, issue, min(ts) AS m FROM factory.events
  WHERE state = 'merged' AND issue IS NOT NULL GROUP BY repo, issue
), first_claim AS (
  SELECT DISTINCT ON (repo, issue) repo, issue, ts AS c, device AS owner
  FROM factory.events WHERE state = 'claimed' ORDER BY repo, issue, ts
), span AS (
  SELECT m.repo, m.issue, m.m, fc.c,
    COALESCE(fc.owner, (SELECT e.device FROM factory.events e
                        WHERE e.repo = m.repo AND e.issue = m.issue AND e.state = 'merged'
                        ORDER BY e.ts LIMIT 1)) AS owner,
    COALESCE(
      (SELECT max(rt.ts) FROM ready_times rt
       WHERE rt.repo = m.repo AND rt.issue = m.issue AND (fc.c IS NULL OR rt.ts <= fc.c)),
      (SELECT min(e.ts) FROM factory.events e
       WHERE e.repo = m.repo AND e.issue = m.issue AND e.state = 'ready')) AS r
  FROM merged m LEFT JOIN first_claim fc USING (repo, issue)
), disp AS (
  SELECT repo, issue, r AS s, c AS e FROM span WHERE c IS NOT NULL
  UNION ALL
  SELECT s.repo, s.issue, p.ts, COALESCE(
    (SELECT min(x.ts) FROM factory.events x
     WHERE x.repo = p.repo AND x.issue = p.issue AND x.ts > p.ts
       AND x.state IN ('verdict', 'fix_requested', 'merge_ready', 'failed', 'merged')), s.m)
  FROM span s JOIN factory.events p ON p.repo = s.repo AND p.issue = s.issue AND p.state = 'parked'
  UNION ALL
  SELECT s.repo, s.issue, p.ts, COALESCE(
    (SELECT min(x.ts) FROM factory.events x
     WHERE x.repo = p.repo AND x.issue = p.issue AND x.ts > p.ts
       AND x.state IN ('merged', 'run_started', 'failed')), s.m)
  FROM span s JOIN factory.events p ON p.repo = s.repo AND p.issue = s.issue AND p.state = 'merge_ready'
), pipe AS (
  SELECT s.repo, s.issue, p.ts AS s, COALESCE(
    (SELECT min(x.ts) FROM factory.events x
     WHERE x.repo = p.repo AND x.issue = p.issue AND x.ts > p.ts
       AND x.state IN ('merge_ready', 'failed', 'run_started', 'merged')), s.m) AS e
  FROM span s JOIN factory.events p ON p.repo = s.repo AND p.issue = s.issue AND p.state = 'run_started'
), alive AS (   -- per device: alive for 30 minutes after each event
  SELECT repo, device, range_agg(tstzrange(ts, ts + interval '30 minutes')) AS mr
  FROM factory.events GROUP BY repo, device
), held AS (    -- per device: from each claimed until that issue's next release state
  SELECT c.repo, c.device, range_agg(tstzrange(c.ts, COALESCE(
    (SELECT min(x.ts) FROM factory.events x
     WHERE x.repo = c.repo AND x.issue = c.issue AND x.ts > c.ts
       AND x.state IN ('ready', 'reclaimed', 'merged', 'abandoned')), 'infinity'))) AS mr
  FROM factory.events c WHERE c.state = 'claimed' GROUP BY c.repo, c.device
), idle AS (    -- alive and holding nothing
  SELECT a.repo, a.device, a.mr - COALESCE(h.mr, '{}'::tstzmultirange) AS mr
  FROM alive a LEFT JOIN held h USING (repo, device)
), per_issue AS (
  SELECT s.repo, s.issue, s.owner, s.r, s.m,
    COALESCE((SELECT range_agg(tstzrange(LEAST(d.s, d.e), d.e)) FROM disp d
              WHERE d.repo = s.repo AND d.issue = s.issue), '{}'::tstzmultirange)
      * tstzmultirange(tstzrange(s.r, s.m)) AS disp,
    COALESCE((SELECT range_agg(tstzrange(LEAST(p.s, p.e), p.e)) FROM pipe p
              WHERE p.repo = s.repo AND p.issue = s.issue), '{}'::tstzmultirange)
      * tstzmultirange(tstzrange(s.r, s.m)) AS pipe,
    COALESCE((SELECT range_agg(r2) FROM idle i, unnest(i.mr) AS r2
              WHERE i.repo = s.repo AND i.device <> s.owner), '{}'::tstzmultirange) AS other_idle
  FROM span s WHERE s.r IS NOT NULL AND s.r < s.m
), secs AS (
  SELECT repo, issue, owner, extract(epoch FROM m - r) AS total,
    (SELECT COALESCE(sum(upper(x) - lower(x)), interval '0') FROM unnest(pipe - disp) x)       AS pipeline_iv,
    (SELECT COALESCE(sum(upper(x) - lower(x)), interval '0') FROM unnest(disp) x)              AS disp_iv,
    (SELECT COALESCE(sum(upper(x) - lower(x)), interval '0') FROM unnest(disp * other_idle) x) AS disp_idle_iv
  FROM per_issue
)
SELECT repo, issue, owner,
  extract(epoch FROM pipeline_iv)  AS pipeline_bound,
  extract(epoch FROM disp_iv)      AS dispatcher_bound,
  extract(epoch FROM disp_idle_iv) AS dispatcher_bound_other_idle,
  total - extract(epoch FROM pipeline_iv) - extract(epoch FROM disp_iv) AS agent_work,
  total
FROM secs
ORDER BY repo, issue;
```

Totals and the call: sum the columns; `sum(dispatcher_bound_other_idle) / sum(pipeline_bound +
dispatcher_bound)` above 0.5 means option B.

## no-mistakes pipeline data (`nomistakes` schema)

`nm-push-loop` (`images/base/nm-push-loop`, SQLite half in `nm-export`) mirrors six tables of
the local `state.sqlite` into the same PostgreSQL: `repos`, `runs`, `step_results`,
`step_rounds`, `agent_invocations` and `run_agent_sessions`. The tables are created on the first
push (`CREATE SCHEMA/TABLE IF NOT EXISTS`) and written with upserts on the source key (`id`;
`(run_id, role)` for `run_agent_sessions`), so a run is updated in place as it progresses.
Source and checkpoint paths, startup and controls are documented in the
[base image reference](../images/base/README.md#factory-event-log).

The exporter opens SQLite read-only and reads all available tables in one read transaction.
Without a valid checkpoint, it backfills every row in each available table, even when a
parent table is absent; unresolved repo attribution is NULL. Later passes send all
nonterminal runs and terminal runs touched at or after the checkpoint (`>=`), with their
children and repos. Touch timestamps come from `runs.updated_at`, step start/completion/
activity, round creation, invocation completion and session updates. A missing table or
one missing a primary-key column is skipped with a warning. Each push is one PostgreSQL
transaction; the checkpoint advances only after success, so failures are retried in full.

Column rules:

- Every table has `device` (the exporter's device attribution) and
  `repo` (lowercase `owner/name` from `repos.upstream_url`) beside the source columns.
- Epoch-second `*_at` and `*_since` columns are `timestamptz`; other integers are `bigint`;
  JSON columns (`findings_json`, `gates_json`, ...) stay `text`.
- A column the mirror does not know goes into `raw jsonb` (blobs as base64) instead of failing
  the push; a known column missing from the SQLite file is NULL.
- Actual NUL characters are removed from string values before serialization; literal
  backslash escape text is preserved.
- Never shipped, and absent from `raw`: `repos.working_path`, `runs.worktree_dir`,
  `step_results.log_path` and `agent_pid`, `step_rounds.global_config_yaml` and
  `repo_config_yaml`, and the step log files.
- `runs.no_mistakes_version` records which no-mistakes wrote the row.

Stability: the mirror reads no-mistakes' internal `state.sqlite` directly. That layout is not a
stable interface, and any no-mistakes release can add, rename or remove columns or tables.
Unknown columns are tolerated (they land in `raw`), but a rename or removal shows up as NULLs
or a skipped table until the exporter is updated. Check `runs.no_mistakes_version` when a
column goes quiet. The upstream ask for a stable, schema-versioned export is
[kunchenguid/no-mistakes#985](https://github.com/kunchenguid/no-mistakes/issues/985).

The DDL below is generated from `nm-export`'s schema definition. Regenerate it from the
repository root with `node -e 'console.log(require("./images/base/nm-export").ddl())'`;
the exporter is the authoritative source for column names, types, keys and indexes.

```sql
CREATE SCHEMA IF NOT EXISTS nomistakes;
CREATE TABLE IF NOT EXISTS nomistakes.repos (
  id text,
  upstream_url text,
  fork_url text,
  default_branch text,
  created_at timestamptz,
  device text NOT NULL,
  repo text,
  raw jsonb,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS nomistakes.runs (
  id text,
  repo_id text,
  branch text,
  head_sha text,
  base_sha text,
  submitted_head_sha text,
  no_mistakes_version text,
  no_mistakes_build_sha text,
  review_approved_head_sha text,
  status text,
  pr_url text,
  pr_state text,
  pr_state_observed_at timestamptz,
  ci_ready_at timestamptz,
  ci_ready_no_ci bigint,
  last_pushed_sha text,
  push_target_kind text,
  push_target_fingerprint text,
  push_ref text,
  last_pushed_at timestamptz,
  push_generation bigint,
  push_active bigint,
  terminal_head_verified_at timestamptz,
  gates_json text,
  error text,
  awaiting_agent_since timestamptz,
  parked_ms bigint,
  launch_nonce text,
  launch_validation_generation text,
  launch_intent_digest text,
  launch_receipt_claimed_at timestamptz,
  pr_base_branch text,
  omit_intent bigint,
  pi_profile text,
  verification_plan text,
  created_at timestamptz,
  updated_at timestamptz,
  intent text,
  intent_source text,
  intent_session_id text,
  intent_score double precision,
  ci_rerun_state text,
  custody_returned_at timestamptz,
  device text NOT NULL,
  repo text,
  raw jsonb,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS nomistakes.step_results (
  id text,
  run_id text,
  step_name text,
  step_order bigint,
  status text,
  exit_code bigint,
  duration_ms bigint,
  findings_json text,
  error text,
  started_at timestamptz,
  round_started_at timestamptz,
  completed_at timestamptz,
  last_activity_at timestamptz,
  last_activity text,
  auto_fix_limit bigint,
  ci_fix_attempts bigint,
  override_reason text,
  skip_reason text,
  approval_reason text,
  device text NOT NULL,
  repo text,
  raw jsonb,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS nomistakes.step_rounds (
  id text,
  step_result_id text,
  round bigint,
  trigger_type text,
  findings_json text,
  reviewed_head_sha text,
  starting_head_sha text,
  trusted_config_sha text,
  user_findings_json text,
  selected_finding_ids text,
  selection_source text,
  fix_summary text,
  repair_published bigint,
  duration_ms bigint,
  created_at timestamptz,
  device text NOT NULL,
  repo text,
  raw jsonb,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS nomistakes.agent_invocations (
  id text,
  run_id text,
  step_name text,
  round bigint,
  purpose text,
  agent text,
  model text,
  model_provider text,
  session_mode text,
  session_key text,
  fallback_reason text,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms bigint,
  subprocess_wait_ms bigint,
  exit_status text,
  failure_category text,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_creation_tokens bigint,
  fresh_input_tokens bigint,
  reasoning_tokens bigint,
  delta_input_tokens bigint,
  delta_output_tokens bigint,
  delta_cache_read_tokens bigint,
  model_roundtrips bigint,
  tool_calls bigint,
  tool_wait_calls bigint,
  tool_test_lint_calls bigint,
  tool_edit_calls bigint,
  tool_read_calls bigint,
  tool_git_calls bigint,
  tool_other_calls bigint,
  workload_files bigint,
  workload_lines bigint,
  finding_count bigint,
  device text NOT NULL,
  repo text,
  raw jsonb,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS nomistakes.run_agent_sessions (
  run_id text,
  role text,
  agent text,
  session_id text,
  created_at timestamptz,
  updated_at timestamptz,
  device text NOT NULL,
  repo text,
  raw jsonb,
  PRIMARY KEY (run_id, role)
);
CREATE INDEX IF NOT EXISTS runs_repo_idx ON nomistakes.runs (repo, created_at);
CREATE INDEX IF NOT EXISTS step_results_run_idx ON nomistakes.step_results (run_id);
CREATE INDEX IF NOT EXISTS step_rounds_step_idx ON nomistakes.step_rounds (step_result_id);
CREATE INDEX IF NOT EXISTS agent_invocations_run_idx ON nomistakes.agent_invocations (run_id);
```

Example: pipeline runs against the factory's own view of the same run (`factory.events.run_id`
is the no-mistakes run id the orchestrator recorded at `run_started`):

```sql
SELECT r.repo, e.issue, r.id AS run_id, r.status, r.no_mistakes_version,
       (SELECT count(*) FROM nomistakes.step_results s WHERE s.run_id = r.id) AS steps,
       (SELECT sum(i.input_tokens + i.output_tokens) FROM nomistakes.agent_invocations i
        WHERE i.run_id = r.id) AS tokens
FROM nomistakes.runs r
JOIN factory.events e ON e.run_id = r.id AND e.state = 'run_started'
ORDER BY e.ts;
```

### Saved queries

Seven queries on the mirror, each runnable as is in `psql`. They qualify every `nomistakes` column
with a table alias (`r` runs, `s` step_results, `d` step_rounds, `i` agent_invocations); that is
the convention `tests/metrics-queries.test.js` relies on to catch a column that has drifted out
of the schema, and image CI runs every block here against a real PostgreSQL. The JSON columns
(`findings_json`, `user_findings_json`) are `text`, so each query casts them and treats NULL and
empty text as "no findings". Values seen in a live `state.sqlite`: `step_name` is one of `rebase`,
`review`, `test`, `document`, `lint`, `push`, `pr`, `ci`, `intent`; step `status` is `completed`,
`failed`, `skipped`, `pending` (or `running`); `trigger_type` is `initial` or `auto_fix`;
`selection_source` is `user`, `user_declined`, `auto_fix` or NULL.

#### 1. First-pass rate per gate

A step is first-pass when it ended `completed` and has no `auto_fix` round. The denominator is
the steps that reached a verdict (`completed` or `failed`), so `skipped`, `pending` and
`running` steps are excluded.

```sql
SELECT s.step_name, r.repo, r.device,
       count(*) AS steps,
       count(*) FILTER (WHERE s.status = 'completed' AND NOT EXISTS (
         SELECT 1 FROM nomistakes.step_rounds d
         WHERE d.step_result_id = s.id AND d.trigger_type = 'auto_fix')) AS first_pass,
       round((count(*) FILTER (WHERE s.status = 'completed' AND NOT EXISTS (
         SELECT 1 FROM nomistakes.step_rounds d
         WHERE d.step_result_id = s.id AND d.trigger_type = 'auto_fix')))::numeric / count(*), 3) AS first_pass_rate
FROM nomistakes.step_results s
JOIN nomistakes.runs r ON r.id = s.run_id
WHERE s.status IN ('completed', 'failed')
GROUP BY s.step_name, r.repo, r.device
ORDER BY first_pass_rate, steps DESC, s.step_name;
```

#### 2. Fix rounds per step

How many `auto_fix` rounds each gate needed and the deepest round it reached. The gates that
loop most come first.

```sql
SELECT s.step_name,
       count(*) FILTER (WHERE d.trigger_type = 'auto_fix') AS fix_rounds,
       coalesce(max(d.round), 0) AS max_round,
       count(DISTINCT s.id) AS steps
FROM nomistakes.step_results s
LEFT JOIN nomistakes.step_rounds d ON d.step_result_id = s.id
GROUP BY s.step_name
ORDER BY fix_rounds DESC, max_round DESC, s.step_name;
```

#### 3. Findings per round and share dismissed

Findings per round come from `findings_json`. A round whose `selection_source` is `user_declined`
is one where the user dismissed the findings, so `dismissed_share` (dismissed findings over the
findings of rounds with a decision, i.e. a non-NULL `selection_source`) reads as a reviewer
false-positive signal. `user_added_findings` counts findings the user supplied in
`user_findings_json`, the opposite signal: something the reviewer missed.

```sql
SELECT s.step_name, r.repo, r.device,
       count(*) AS rounds,
       sum(f.n) AS findings,
       round(avg(f.n), 2) AS findings_per_round,
       coalesce(sum(f.n) FILTER (WHERE d.selection_source IS NOT NULL), 0) AS decided_findings,
       coalesce(sum(f.n) FILTER (WHERE d.selection_source = 'user_declined'), 0) AS dismissed_findings,
       round(coalesce(sum(f.n) FILTER (WHERE d.selection_source = 'user_declined'), 0)::numeric
             / nullif(sum(f.n) FILTER (WHERE d.selection_source IS NOT NULL), 0), 3) AS dismissed_share,
       sum(u.n) AS user_added_findings
FROM nomistakes.step_rounds d
JOIN nomistakes.step_results s ON s.id = d.step_result_id
JOIN nomistakes.runs r ON r.id = s.run_id
CROSS JOIN LATERAL (SELECT CASE WHEN nullif(btrim(d.findings_json), '') IS NULL THEN 0
                           ELSE coalesce(jsonb_array_length(d.findings_json::jsonb -> 'findings'), 0) END AS n) f
CROSS JOIN LATERAL (SELECT CASE WHEN nullif(btrim(d.user_findings_json), '') IS NULL THEN 0
                           ELSE coalesce(jsonb_array_length(d.user_findings_json::jsonb -> 'findings'), 0) END AS n) u
GROUP BY s.step_name, r.repo, r.device
ORDER BY findings DESC, s.step_name;
```

#### 4. Agent tokens and wall time

One query, three grains (`grain` column): by `agent`, `model` and `purpose`; per run; and per
merged pull request (`runs.pr_url` where `pr_state = 'merged'`, summed over the runs that
produced it). `duration_ms` is the invocation wall time.

```sql
SELECT 'agent_model_purpose' AS grain, NULL::text AS repo, NULL::text AS run_id, NULL::text AS pr_url,
       i.agent, i.model, i.purpose, count(*) AS invocations,
       coalesce(sum(i.input_tokens), 0) AS input_tokens, coalesce(sum(i.output_tokens), 0) AS output_tokens,
       coalesce(sum(i.cache_read_tokens), 0) AS cache_read_tokens,
       coalesce(sum(i.cache_creation_tokens), 0) AS cache_creation_tokens,
       coalesce(sum(i.duration_ms), 0) AS duration_ms
FROM nomistakes.agent_invocations i
GROUP BY i.agent, i.model, i.purpose
UNION ALL
SELECT 'run', r.repo, r.id, r.pr_url, NULL, NULL, NULL, count(*),
       coalesce(sum(i.input_tokens), 0), coalesce(sum(i.output_tokens), 0),
       coalesce(sum(i.cache_read_tokens), 0), coalesce(sum(i.cache_creation_tokens), 0),
       coalesce(sum(i.duration_ms), 0)
FROM nomistakes.agent_invocations i
JOIN nomistakes.runs r ON r.id = i.run_id
GROUP BY r.repo, r.id, r.pr_url
UNION ALL
SELECT 'merged_pr', r.repo, NULL, r.pr_url, NULL, NULL, NULL, count(*),
       coalesce(sum(i.input_tokens), 0), coalesce(sum(i.output_tokens), 0),
       coalesce(sum(i.cache_read_tokens), 0), coalesce(sum(i.cache_creation_tokens), 0),
       coalesce(sum(i.duration_ms), 0)
FROM nomistakes.agent_invocations i
JOIN nomistakes.runs r ON r.id = i.run_id
WHERE r.pr_state = 'merged' AND r.pr_url IS NOT NULL
GROUP BY r.repo, r.pr_url
ORDER BY grain, input_tokens DESC;
```

#### 5. Time parked

A run is parked while it waits for an agent or a person; `runs.parked_ms` accumulates that time.
`totals` rows give the sum and the distribution (median, 90th percentile, max) per repo and
device over runs that parked at all. `parked_now` rows are the runs parked right now
(`awaiting_agent_since IS NOT NULL`) with how long they have waited.

```sql
SELECT 'totals' AS grain, r.repo, r.device, NULL::text AS run_id,
       count(*) AS runs,
       sum(r.parked_ms)::bigint AS parked_ms_total,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.parked_ms))::bigint AS parked_ms_p50,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY r.parked_ms))::bigint AS parked_ms_p90,
       max(r.parked_ms)::bigint AS parked_ms_max,
       NULL::text AS parked_for
FROM nomistakes.runs r
WHERE r.parked_ms > 0
GROUP BY r.repo, r.device
UNION ALL
SELECT 'parked_now', r.repo, r.device, r.id, NULL, r.parked_ms::bigint, NULL, NULL, NULL,
       date_trunc('second', now() - r.awaiting_agent_since)::text
FROM nomistakes.runs r
WHERE r.awaiting_agent_since IS NOT NULL
ORDER BY grain DESC, repo, device;
```

#### 6. Failure categories and fallback reasons

Counts of invocation outcomes by `purpose` and `model`. An empty `failure_category` means the
invocation did not fail and shows as `none`; a `fallback_reason` is set when the invocation fell
back to another agent.

```sql
SELECT i.purpose, i.model,
       coalesce(nullif(i.failure_category, ''), 'none') AS failure_category,
       coalesce(nullif(i.fallback_reason, ''), 'none') AS fallback_reason,
       count(*) AS invocations
FROM nomistakes.agent_invocations i
GROUP BY i.purpose, i.model, 3, 4
ORDER BY invocations DESC, i.purpose, i.model, 3, 4;
```

#### 7. Run lead time joined to `factory.events`

Per issue, from the orchestrator's `claimed` event to its `merged` event, split into pipeline
time and the rest. Pipeline time is `runs.updated_at - runs.created_at` summed over the runs the
orchestrator linked to the issue with `run_started` events; it includes the time those runs sat
parked, so `parked_s` is shown beside it (not additional to it). `other_s` is everything
outside the pipeline: waiting to be picked up, design, review and merge.

```sql
WITH issues AS (
  SELECT e.repo, e.issue,
         min(e.ts) FILTER (WHERE e.state = 'claimed') AS claimed_at,
         max(e.ts) FILTER (WHERE e.state = 'merged') AS merged_at
  FROM factory.events e
  WHERE e.issue IS NOT NULL
  GROUP BY e.repo, e.issue
), linked AS (
  SELECT DISTINCT e.repo, e.issue, e.run_id
  FROM factory.events e
  WHERE e.state = 'run_started' AND e.run_id IS NOT NULL
)
SELECT n.repo, n.issue,
       round(extract(epoch FROM n.merged_at - n.claimed_at)) AS lead_s,
       round(sum(extract(epoch FROM r.updated_at - r.created_at))) AS pipeline_s,
       round(sum(coalesce(r.parked_ms, 0)) / 1000.0) AS parked_s,
       round(extract(epoch FROM n.merged_at - n.claimed_at) - sum(extract(epoch FROM r.updated_at - r.created_at))) AS other_s,
       count(r.id) AS runs
FROM issues n
JOIN linked l ON l.repo = n.repo AND l.issue = n.issue
JOIN nomistakes.runs r ON r.id = l.run_id
WHERE n.claimed_at IS NOT NULL AND n.merged_at IS NOT NULL
GROUP BY n.repo, n.issue, n.claimed_at, n.merged_at
ORDER BY n.merged_at;
```

## Offline computation: `callum-flow-evaluate`

`callum-flow-evaluate --repo <owner/name> --since <ISO> [--until <ISO>] [--format json|markdown]
[--events <file>] [--nm-export <file>] [--ready-times <file>]` (base image, `images/base/callum-flow-evaluate`)
computes queries 1 to 7 for a time window from an events file (`--events`, default the local
event log; a `factory.events` export covers every device), plus token spend, waste and pipeline
numbers from Claude Code transcripts and the no-mistakes `state.sqlite`. It is read-only, makes
no network calls and is deterministic. The `evaluate-sessions` skill runs it and writes the
report; every number in a report comes from this tool. Differences from the SQL:
the window selects issues by their `merged` event (query 1) or first `merge_ready` (query 2) and
verdicts by their own timestamp (queries 3 and 5), and the events file is the one device's log
unless a `factory.events` export is passed (see the skill).

- `per_device` (query 4, plus claims and `claim_lost` per device) and `claims` (query 6:
  `double_claims`, `claim_lost`, `reclaimed`, `stuck`) read each event's `device`. The stuck test
  is evaluated at the window's end; its lease comes from `CALLUM_FLOW_LEASE_MINUTES` (default 120).
- `waiting` (query 7) gives each merged issue's split and the totals, `other_idle_pct_of_wait`
  and a `decision`: `B` when more than 50% of the wait was dispatcher-bound with another device
  idle, `gate` otherwise.
- `--ready-times <file>` is a JSON object `{"<issue>": "<ISO>" | ["<ISO>", ...]}` of the times
  each issue got its `ready` label, from the GitHub timeline. The tool takes the last one at or
  before the issue's first `claimed`, and falls back to the first `ready` event (each lead-time
  row says which as `ready_source`). Merged issues with neither read `n/a` and are counted in
  `issues_without_ready`, so a report can state how many lead times it could not compute.

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
PGSSLROOTCERT=system psql "$AGENTSVIEW_PG_URL" -At -v since=<ISO> > /tmp/nm-export.jsonl <<'SQL'
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
either source. They match saved queries 1 and 2 above. A key is `n/a` on its own when its columns
are missing.

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
