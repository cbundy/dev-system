# Factory metrics

The factory event log (`callum-flow-event`, shipped to the `factory.events` table by
`event-push-loop`; see "Factory event log" in `images/base/README.md`) answers four
questions. Each query below runs as is in `psql` against the agentsview PostgreSQL.
Rows are keyed `(device, repo, seq)`; `issue` joins to GitHub, and to Claude cost and token
metrics through the `issue` and `device` resource attributes the orchestrator sets on
sub-agents.

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
