# Factory metrics

The factory event log (`callum-flow-event`, shipped to the `factory.events` table by
`event-push-loop`; see "Factory event log" in `images/base/README.md`) answers the questions
below, plus the waste measures at the end. Each query below runs as is in `psql` against the agentsview PostgreSQL. When running them by hand against a URL with
`sslmode=verify-full` or `verify-ca`, set `PGSSLROOTCERT=system` or add `sslrootcert=system`
to it, as psql 17 has no default root cert (`event-push-loop` does this itself).
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

## Offline computation: `callum-flow-evaluate`

`callum-flow-evaluate --repo <owner/name> --since <ISO> [--until <ISO>] [--format json|markdown]`
(base image, `images/base/callum-flow-evaluate`) computes queries 1, 2, 3 and 5 for a time
window from a local events file (`--events`, default the local event log), plus token spend,
waste and pipeline numbers from Claude Code transcripts and the no-mistakes `state.sqlite`.
It is read-only, makes no network calls and is deterministic. The `evaluate-sessions` skill runs it
and writes the report; every number in a report comes from this tool. Differences from the SQL:
the window selects issues by their `merged` event (query 1) or first `merge_ready` (query 2) and
verdicts by their own timestamp (queries 3 and 5), and the events file is the one device's log
unless a `factory.events` export is passed (see the skill).

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
