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

## Offline computation: `callum-flow-evaluate`

`callum-flow-evaluate --repo <owner/name> --since <ISO> [--until <ISO>] [--format json|markdown]
[--events <file>] [--ready-times <file>]` (base image, `images/base/callum-flow-evaluate`)
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
