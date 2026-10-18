# Factory metrics

The factory event log (`callum-flow-event`, shipped to the `factory.events` table by
`event-push-loop`; see "Factory event log" in `images/base/README.md`) answers the questions
below, plus the waste measures at the end. Run the queries with `dev-query` (see "dev-query" in `images/base/README.md`), e.g.
`dev-query -c '<sql>'` or the SQL on stdin: it connects to the agentsview PostgreSQL read-only and
handles the TLS root-cert and secret-masking details. To run by hand with `psql` instead, you need
the database URL and, for `sslmode=verify-ca`/`verify-full` with a private CA, `PGSSLROOTCERT`.
Rows are unique on `event_id` (a UUID the writer makes locally), or, for older rows without one, on `(device, repo, seq)`; `issue` joins to GitHub, and to Claude cost and token
metrics through the `issue` and `device` resource attributes the orchestrator sets on
sub-agents.

A second schema, `nomistakes`, mirrors the no-mistakes pipeline database (see "no-mistakes
pipeline data" below). Pipeline facts (when a run started, its status, parked time, its PR) come
from that mirror, never from agent-logged `run_started` events: a run belongs to an issue by its
branch name (see "Linking pipeline runs to issues" below).

`superseded` is logged by the orchestrator when it replaces a branch or run for the same issue (`--run` names the old run). It is run-scoped, so it ends nothing and releases no claim.

`rebased_behind` is logged by the orchestrator after a successful behind-only update without a
new pipeline run (cbundy/dev-system#476; see the [merge workflow](../plugins/callum-flow/skills/issue-orchestrator/SKILL.md#merge)).
It names the original gated run in `--run` and the pushed head in `--head`. The subsequent
`head_mismatch` event (`head-mismatch` in watcher output) is expected for that run; the merge
guard must still verify the patch and all remaining merge conditions.

`closed` is logged by `callum-flow-sweep` (actor `sweep`) for issues closed outside the factory;
the [factory event log reference](../images/base/README.md#factory-event-log) defines which issues it checks.
Its `note` is GitHub's close reason verbatim: `completed`, `not_planned` or
`duplicate` (empty when GitHub gives none). It releases a claim like `merged` does, but
throughput and lead-time queries keep counting `merged` only. Two devices sweeping before either
has pushed can both log it, so count identical consecutive rows once.

`loop` is the factory loop's own bookkeeping (`plugins/factory-loop`, see
[DECISIONS D-09](factory-loop/DECISIONS.md)): agent starts and ends, judgment wakes and their
answers (with the wake's cause), owner notices and rate-cap holds, and once a minute a pass summary (`kind=passes`: how many
passes ended in the minute, their mean, p50, p90 and max duration in ms, how many acted and
errored, and the mode, planner and pass interval; `passes=0` for a minute with none; sent only
while the loop acts). Its `note` carries
`kind=<kind> key=<idempotency key> status=<status>` (more fields may follow), and `issue` is null
for work that names no issue (a release wake, a hold on a whole class). It shows when an agent started or the model was
woken without the loop's local files, and rebuilds the loop's ledger after a lost store. It is
never a stage and never progress: no query here counts it as an issue event, the stuck test below
skips it, and `callum-flow-factory-state` and `heartbeat-state` ignore it. Only "alive" in the
waiting split counts it, since a loop that logs is a device at work. CLI work the loop runs
(claims, merges, the watchers' states) logs its own states, not `loop`.

The factory loop v2 ([v2 SPEC 7.1](factory-loop/v2/SPEC.md#71-what-v2-emits)) adds three states. Their
fields are `key=value` tokens in `note`, encoded as `loop` notes are: tokens are split by single
spaces, `%` and whitespace inside a value are percent-encoded (`%20`), and a missing value is `none`.
Read one with `substring(note FROM '(?:^| )<key>=([^ ]+)')`, and decode the percent-encoding of
free text (a reason, a question) when you show it.

- `transition`: every change of an issue's v2 state, and again after a re-claim. `issue`, `branch`,
  `pr` and `head` are columns; the note has `row` (the table row), `life`, `seq`, `from`, `to` (the new
  state: `queued`, `designing`, `building`, `reviewing`, `fixing`, `merge-queue`, `parked` or `closed`),
  `why` (for `closed`: `merged`, `merged-by-hand`, `dropped`, `split`, `closed-on-github` or
  `claim-lost`), `step`, `attempt`, `round`, `fixes`, `triages` and the rest of the loop's record, the
  free text (`via`, `brief`, `question`, `notes`) last. A retried event can be logged twice: count one
  per `(issue, life, seq)`. It is a stage for `callum-flow-factory-state` ([factory-state.md](factory-state.md)).
- `reviewed`: one review result, with `verdict` (`approve`, `changes` or `unknown`), `round`, `patch`
  (the patch id reviewed), `errors`, `warnings`, `infos`, `reviewer` and `answer` (the answer's path).
  Count one per `(issue, round, patch)`.
- `intervention`: someone had to step in that the plan did not foresee, with `who` (`person` or
  `loop`), `cause` (a code of [v2 SPEC 7.2](factory-loop/v2/SPEC.md#72-interventions), such as
  `op:resume`, `push`, `hand-merge`, `restart`, `rescue`, `triage`, `unknown:timeout`, `free:load`,
  `park` or `fix:ci`), `life`, `fact` (the key of the fact it records) and `reason` (one line).
  `issue` is null for a fleet-level one (a mode change, a restart, a settings edit). Count one per
  `(issue, who, cause, fact)`; a hand-recorded `rescue` has no fact, so each row counts.

- `prompt_denied`: the factory loop companion refused a loop agent's tool call, because Claude Code
  would have asked a person nobody watches ([v2 SPEC 10.10](factory-loop/v2/SPEC.md)). `--issue` and
  `--branch` as every event, `--pr` when the issue has one. The note is `key=value` tokens, none
  required, `none` when unknown: `life`, `seq`, `step`, `attempt`, `agent`, `agent_type`, `tool`,
  `input` (clipped to 2000 characters), `why` (Claude Code's own reason), `slot`, `session`,
  `transcript`. The same refusal is an `intervention` with cause `prompt-denied`, derived by the
  loop from the companion's log.
- `prompt_waiting`: the same columns and tokens, for a loop agent that is waiting on a permission
  prompt now (`input` is the prompt's message).

`reviewed`, `intervention`, `prompt_denied` and `prompt_waiting` are never a stage and never progress,
and never decide whether an issue is final. The loop's reused states keep
their meaning and note: `delegated` (`brief <url>`), `fix_requested` (`review`, `ci`, `conflict` or
`triage`), `merge_ready`, `verdict` (a fixer's `CORRECT:` for a fixed finding, `WRONG:` for a declined
one, actor `fixer`), `merged`, and `abandoned` and `reclaimed`, whose v2 note starts with
`reason=<dropped|split|triage|reconcile|other>`. A `reconcile` release also carries
`outcome=<requeue|leave|reject>` (`reject`: the lives cap was reached and the issue is labelled
`factory:rejected`) and `lives=<n|none>`, the released life's number.

Columns: `device`, `repo`, `seq`, `ts`, `state`, `issue`, `run_id`, `branch`, `pr`, `head`,
`note`, `session_id`, `actor`, `v`, `raw`, `event_id`, `base_image`, `dev_image`,
`template_version`, `plugin_version`.

The four version columns (what `dev-version --json` calls the running base image, dev image,
Coder template version and callum-flow plugin version) are filled for events written by
base image 2.26.0 and later; earlier rows, and rows pushed by older images, are null. To compare
releases, filter on them:

```sql
select plugin_version, count(*) from factory.events
where state = 'merged' and base_image = '2.26.0' group by plugin_version;
```

Subscribe to new events with `LISTEN factory_events`: each insert notifies a JSON payload with
`event_id`, `device`, `repo`, `issue` and `state`.

## Data coverage

Check coverage before quoting any window, and never extrapolate before it.

- `factory.events` data starts 2026-10-08. `nomistakes` data starts with the first push from the
  release that ships `nm-push-loop`.
- Per device and repo, the earliest and latest row:
  `select device, min(ts), max(ts) from factory.events where repo = '<owner/name>' group by device`.
- A device whose container is stale (older than the base image that ships the push loops) pushes
  nothing, so a missing device means missing data, not zero work.

## 1. Lead time by stage

Per issue, the time between the first occurrence of each state on the way to a merge. Watcher
states carry the polling interval's delay (queue 2 minutes, pipeline 25 seconds).
The pipeline stage starts at the first linked run's `nomistakes.runs.created_at`, not at an
agent-logged event: `implementation` is `delegated` to that start and `pipeline` is that start to
`merge_ready`. An issue with no linkable run has NULL `implementation` and `pipeline`.
`ready` can repeat when a watcher restarts with a stale `--known`, so the query uses the first one per issue.
A factory loop v2 issue has no run: its pipeline stage starts at its first `transition` to
reviewing, `min(ts) FILTER (WHERE state = 'transition' AND note ~ '(^| )to=reviewing( |$)')`, which
`callum-flow-evaluate` uses (`run_source` `transition`) when the issue has no linked run.

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
),
first AS (
  SELECT repo, issue, state, min(ts) AS ts
  FROM factory.events
  WHERE issue IS NOT NULL
    AND state IN ('ready', 'claimed', 'delegated', 'merge_ready', 'merged')
  GROUP BY repo, issue, state
  UNION ALL
  SELECT e.repo, rl.issue, 'run', min(rl.created_at)
  FROM run_link rl
  JOIN (SELECT DISTINCT repo, issue FROM factory.events WHERE issue IS NOT NULL) e
    ON lower(e.repo) = rl.repo AND e.issue = rl.issue
  GROUP BY e.repo, rl.issue
)
SELECT repo, issue,
  min(ts) FILTER (WHERE state = 'claimed')     - min(ts) FILTER (WHERE state = 'ready')       AS waiting_for_claim,
  min(ts) FILTER (WHERE state = 'delegated')   - min(ts) FILTER (WHERE state = 'claimed')     AS design,
  min(ts) FILTER (WHERE state = 'run')         - min(ts) FILTER (WHERE state = 'delegated')   AS implementation,
  min(ts) FILTER (WHERE state = 'merge_ready') - min(ts) FILTER (WHERE state = 'run')         AS pipeline,
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

## 5b. Tests deleted or weakened by auto-fixes

`callum-flow-merge` logs one `test_weakened` event per commit that `callum-flow-test-weakening`
flagged on a merged PR (a commit that deleted assertions, or added `--warn-only`, `|| true`, a
skip or `.only`, or commented an assertion out; cbundy/dev-system#314). The `note` is
`step=<review|document|ci|test|lint|rebase|none> commit=<sha7> restored=<yes|no> kinds=<k1,k2>
files=<a,b>`; `step=none` is a repair commit without a `no-mistakes(<step>)` subject. `restored=yes`
means a later commit put the test back. `callum-flow-evaluate` reports the same counts as its
`test_weakened` section.

```sql
SELECT repo,
  substring(note FROM 'step=(\S+)')                         AS step,
  count(*)                                                  AS commits,
  count(*) FILTER (WHERE note LIKE '%restored=no%')         AS unrestored
FROM factory.events
WHERE state = 'test_weakened'
GROUP BY repo, step
ORDER BY unrestored DESC, commits DESC;
```

## 6. Double-claims, lost claim races and stuck issues

The two-device trial (cbundy/dev-system#222) asks whether two dispatchers ever hold one issue at
once. A **double-claim** is two devices with a live `claimed` on one issue and no `ready`,
`reclaimed`, `merged`, `abandoned` or `closed` between them. A **lost race** is a `claim_lost` event,
logged by `callum-flow-claim` on exit 3 (the note says who holds the issue): it proves the lanes
contended. An issue is **stuck** when it is claimed (a `claimed` after its last `ready`,
`reclaimed`, `merged`, `abandoned` or `closed`) and has had no event, other than `claim_lost`, `renewed` (a heartbeat is not progress), `loop` (the factory loop's bookkeeping), and `reviewed`, `intervention`, `prompt_denied` and `prompt_waiting` (the factory loop v2's review results, step-ins and prompts nobody answers), for more than
twice the claim lease (2 x 120 minutes by default, `CALLUM_FLOW_LEASE_MINUTES`).
`superseded` (a run or branch replaced for the same issue, run-scoped) is none of these: it neither ends an issue nor releases a claim.
`callum-flow-evaluate` applies exactly this test over a window. For the factory's state right now,
use `callum-flow-factory-state` ([factory-state.md](factory-state.md)): it has six stuck rules with
adjustable thresholds and puts GitHub closure first. The hardcoded 4 hour stuck query that used to
follow is retired in its favour.

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
      AND r.state IN ('ready', 'reclaimed', 'merged', 'abandoned', 'closed')
      AND r.ts >= c1.ts AND r.ts <= c2.ts)
ORDER BY c2.ts;

-- lost races, and reclaimed leases, per device
SELECT device,
  count(*) FILTER (WHERE state = 'claim_lost') AS claim_lost,
  count(*) FILTER (WHERE state = 'reclaimed')  AS reclaimed
FROM factory.events
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
`factory.event_store`. It takes `-v repo=... -v since=...`. There are no rows until the producer
(#905) ships.

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

Each merged issue's wall-clock time from `ready` to `merged`, cut into three parts:

- **Pipeline-bound**: a linked run's `created_at` to the run's next `merge_ready` (or `failed`, or
  the next linked run's start), including CI. Parked time is excluded, because a parked gate waits on the
  dispatcher.
- **Dispatcher-bound**: `ready` to the first `claimed`; each `parked` to its next `verdict` or
  `fix_requested` (or `merge_ready`, `failed`, `merged`); each `merge_ready` to the next `merged`,
  linked run start or `failed`.
- **Agent work**: the rest.

A dispatcher-bound second is flagged "another device idle" when, at that moment, some device other
than the issue's owner (the device of its first `claimed`) was alive and held no in-flight issue.
A device is alive for 30 minutes after any event it logged (`usage` and `loop` included). It holds an issue
from its `claimed` until that issue's next `ready`, `reclaimed`, `merged`, `abandoned` or `closed`.

**The B-or-gate rule.** Wait is pipeline-bound plus dispatcher-bound seconds. If the
dispatcher-bound seconds flagged "another device idle" are more than 50% of the wait, the
dispatcher (option B) is what limits throughput; otherwise invest in the gate.

Run starts come from the mirror (`run_link`, see "Linking pipeline runs to issues"); `run_started` events are not read. Most issues have no `ready` event, because `queue-watch.sh` logs one only for issues missing from
its baseline. The `ready` time therefore comes from each issue's GitHub timeline, the last
`labeled` `ready` event before the claim. Collect them with
`callum-flow-issue-read --json --timeline <n>` and put them in `ready_times`
below; an issue with no row falls back to its first `ready` event. The SQL needs PostgreSQL 14 or
later (multiranges). It is the twin of the tool's `waiting` section: the tool also clips the
"alive" window at the report's end, which the SQL does not.

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
),
ready_times(repo, issue, ts) AS (
  -- replace with the labeled-ready times from the timeline, e.g.
  --   VALUES ('cbundy/dev-system', 222, '2026-10-09T08:00:00Z'::timestamptz), ...
  SELECT NULL::text, NULL::int, NULL::timestamptz WHERE false
), pev AS (   -- events, with the mirror's run starts in place of run_started
  SELECT repo, issue, state, ts FROM factory.events WHERE issue IS NOT NULL AND state <> 'run_started'
  UNION ALL
  SELECT e.repo, rl.issue, 'run_started', rl.created_at
  FROM run_link rl
  JOIN (SELECT DISTINCT repo, issue FROM factory.events WHERE issue IS NOT NULL) e
    ON lower(e.repo) = rl.repo AND e.issue = rl.issue
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
    (SELECT min(x.ts) FROM pev x
     WHERE x.repo = p.repo AND x.issue = p.issue AND x.ts > p.ts
       AND x.state IN ('merged', 'run_started', 'failed')), s.m)
  FROM span s JOIN factory.events p ON p.repo = s.repo AND p.issue = s.issue AND p.state = 'merge_ready'
), pipe AS (
  SELECT s.repo, s.issue, p.ts AS s, COALESCE(
    (SELECT min(x.ts) FROM pev x
     WHERE x.repo = p.repo AND x.issue = p.issue AND x.ts > p.ts
       AND x.state IN ('merge_ready', 'failed', 'run_started', 'merged')), s.m) AS e
  FROM span s JOIN pev p ON p.repo = s.repo AND p.issue = s.issue AND p.state = 'run_started'
), alive AS (   -- per device: alive for 30 minutes after each event
  SELECT repo, device, range_agg(tstzrange(ts, ts + interval '30 minutes')) AS mr
  FROM factory.events GROUP BY repo, device
), held AS (    -- per device: from each claimed until that issue's next release state
  SELECT c.repo, c.device, range_agg(tstzrange(c.ts, COALESCE(
    (SELECT min(x.ts) FROM factory.events x
     WHERE x.repo = c.repo AND x.issue = c.issue AND x.ts > c.ts
       AND x.state IN ('ready', 'reclaimed', 'merged', 'abandoned', 'closed')), 'infinity'))) AS mr
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

## 8. Implementer model comparison

Sonnet against Opus as the implementer, one row per model, from the split `callum-flow-implementer-route`
makes (see the [factory event log reference](../images/base/README.md#factory-event-log)). Only issues the
hash routed count: an issue with any `label`, `default` or `fallback` route, or routed to both models (the
share changed while it was in flight), is left out. Each issue counts from its first `implementer_routed`
event, and its runs are the linked runs created after it (see "Linking pipeline runs to issues").

- `issues`, `merged`, `abandoned` (abandoned and never merged): how many issues each model got and how they ended.
- `first_pass_pct`: of the issues that reached `merge_ready`, the share with no `failed` or `fix_requested`
  event before it, as in "2. First-pass gate pass rate".
- `implementation_p50_s`: the median seconds from `delegated` to the first linked run, the implementer's own
  time. `pipeline_p50_s`: the first run to the first `merge_ready`. `total_p50_s`: `delegated` to `merged`.
  Each is the first such event at or after the route (the orchestrator routes, then logs `delegated`).
- Per merged issue (an issue still in flight would undercount): `runs` (a restart or a `-v2` adds one),
  `fix_requests` (the orchestrator's `fix_requested` events), `auto_fix_rounds` (the pipeline's own `auto_fix`
  rounds, any step), `failed_steps`, `parked_s` and `pipeline_tokens` (input plus output tokens of every
  pipeline agent invocation).

The implementer's own token spend is not in this database: read it from the implementer rows of the `spend`
section of `callum-flow-evaluate`, which has one row per role and model. A random split balances easy and hard
issues only over many of them, so size the noise before reading a gap as real: run the query with `routed`
replaced by a split of past `delegated` events by issue parity (both halves on the same model), and treat a
gap no bigger than that one as noise. To narrow to one repo or window, filter `routed`; for one row per issue,
select from `per_issue` instead of the final aggregate.

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
),
routed AS (   -- issues the hash split, each on one model; label, default and fallback routes are left out
  SELECT lower(e.repo) AS repo, e.issue, min(e.ts) AS routed_at,
         min(substring(e.note FROM 'model=([^ ]+)')) AS model
  FROM factory.events e
  WHERE e.state = 'implementer_routed' AND e.issue IS NOT NULL
  GROUP BY lower(e.repo), e.issue
  HAVING bool_and(substring(e.note FROM 'reason=([^ ]+)') = 'hash')
     AND count(DISTINCT substring(e.note FROM 'model=([^ ]+)')) = 1
), facts AS (  -- orchestrator facts from the first route on
  SELECT x.repo, x.issue, x.model,
         min(e.ts) FILTER (WHERE e.state = 'delegated')                      AS delegated_at,
         min(e.ts) FILTER (WHERE e.state = 'merge_ready')                    AS green_at,
         min(e.ts) FILTER (WHERE e.state = 'merged')                         AS merged_at,
         min(e.ts) FILTER (WHERE e.state IN ('failed', 'fix_requested'))     AS setback_at,
         count(e.ts) FILTER (WHERE e.state = 'fix_requested')                AS fix_requests,
         bool_or(e.state = 'abandoned')                                      AS abandoned
  FROM routed x
  LEFT JOIN factory.events e ON lower(e.repo) = x.repo AND e.issue = x.issue AND e.ts >= x.routed_at
  GROUP BY x.repo, x.issue, x.model
), run_facts AS (  -- the issue's pipeline runs from the first route on
  SELECT x.repo, x.issue, r.id AS run_id, r.created_at, coalesce(r.parked_ms, 0) AS parked_ms,
         (SELECT count(*) FROM nomistakes.step_results s
          WHERE s.run_id = r.id AND s.status = 'failed') AS failed_steps,
         (SELECT count(*) FROM nomistakes.step_rounds d JOIN nomistakes.step_results s ON s.id = d.step_result_id
          WHERE s.run_id = r.id AND d.trigger_type = 'auto_fix') AS auto_fix_rounds,
         (SELECT coalesce(sum(i.input_tokens + i.output_tokens), 0) FROM nomistakes.agent_invocations i
          WHERE i.run_id = r.id) AS tokens
  FROM routed x
  JOIN run_link l ON l.repo = x.repo AND l.issue = x.issue AND l.created_at >= x.routed_at
  JOIN nomistakes.runs r ON r.id = l.run_id
), per_issue AS (
  SELECT f.repo, f.issue, f.model, f.delegated_at, f.green_at, f.merged_at, f.setback_at, f.fix_requests, f.abandoned,
         min(rf.created_at) AS first_run_at, count(rf.run_id) AS runs,
         coalesce(sum(rf.failed_steps), 0) AS failed_steps, coalesce(sum(rf.auto_fix_rounds), 0) AS auto_fix_rounds,
         coalesce(sum(rf.parked_ms), 0) AS parked_ms, coalesce(sum(rf.tokens), 0) AS tokens
  FROM facts f
  LEFT JOIN run_facts rf ON rf.repo = f.repo AND rf.issue = f.issue
  GROUP BY f.repo, f.issue, f.model, f.delegated_at, f.green_at, f.merged_at, f.setback_at, f.fix_requests, f.abandoned
)
SELECT model,
  count(*)                                                                         AS issues,
  count(merged_at)                                                                 AS merged,
  count(*) FILTER (WHERE abandoned AND merged_at IS NULL)                          AS abandoned,
  round(100.0 * count(*) FILTER (WHERE green_at IS NOT NULL AND (setback_at IS NULL OR setback_at > green_at))
        / nullif(count(green_at), 0), 1)                                           AS first_pass_pct,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_run_at - delegated_at))) AS implementation_p50_s,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM green_at - first_run_at)))     AS pipeline_p50_s,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM merged_at - delegated_at)))    AS total_p50_s,
  round(avg(runs) FILTER (WHERE merged_at IS NOT NULL), 2)                         AS runs_per_merged,
  round(avg(fix_requests) FILTER (WHERE merged_at IS NOT NULL), 2)                 AS fix_requests_per_merged,
  round(avg(auto_fix_rounds) FILTER (WHERE merged_at IS NOT NULL), 2)              AS auto_fix_rounds_per_merged,
  round(avg(failed_steps) FILTER (WHERE merged_at IS NOT NULL), 2)                 AS failed_steps_per_merged,
  round(avg(parked_ms) FILTER (WHERE merged_at IS NOT NULL) / 1000)                AS parked_s_per_merged,
  round(avg(tokens) FILTER (WHERE merged_at IS NOT NULL))                          AS pipeline_tokens_per_merged
FROM per_issue
GROUP BY model
ORDER BY model;
```

## 9. Interventions, judgement calls and claim completion

The factory loop v2's effectiveness, as issue #632 asks for it, from `factory.events` alone. Every
query counts a retried event once (see the `intervention` and `reviewed` states above), and all three
apply to any regime that logs these states. `callum-flow-evaluate` reports the same numbers over a
window (its `interventions`, `judgement_calls`, `claim_completion` and `rounds` sections).

**Interventions** (#632 metric 1): an `intervention` event is any point where a person, or the loop
with unplanned judgement or recovery, had to step in. A merged issue is **untouched** when no
intervention of either kind names its merged work; untouched merges are the target outcome. An
intervention names the merged work by its `life=` token when that life began by the first `merged` (a
`transition` of the life logged at or before it), whenever the intervention itself was logged: the
loop derives most of them a pass or more after their fact, so a hand merge's can land after the
`merged` event. One with no life (an owner op, a hand-recorded rescue, a control-file edit), or a life
no `transition` names, counts from the first `claimed` to the issue's closing `transition` (the first
to `closed` since its last claim before the merge; else the merge) plus 30 minutes. Fleet-level
interventions (no `issue`) attach to no issue.

```sql
-- interventions per repo and day, by who and cause; `fleet` counts those that name no issue
WITH iv AS (
  SELECT DISTINCT ON (repo, coalesce(issue, 0), who, cause, coalesce(fact, event_id::text, ts::text))
         repo, issue, ts, who, cause
  FROM (
    SELECT e.repo, e.issue, e.ts, e.event_id,
           substring(e.note FROM '(?:^| )who=([^ ]+)')                    AS who,
           substring(e.note FROM '(?:^| )cause=([^ ]+)')                  AS cause,
           nullif(substring(e.note FROM '(?:^| )fact=([^ ]+)'), 'none')   AS fact
    FROM factory.events e
    WHERE e.state = 'intervention'
  ) x
  ORDER BY repo, coalesce(issue, 0), who, cause, coalesce(fact, event_id::text, ts::text), ts
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
  SELECT DISTINCT ON (repo, issue, who, cause, coalesce(fact, event_id::text, ts::text))
         repo, issue, ts, who, cause, life
  FROM (
    SELECT e.repo, e.issue, e.ts, e.event_id,
           substring(e.note FROM '(?:^| )who=([^ ]+)')                    AS who,
           substring(e.note FROM '(?:^| )cause=([^ ]+)')                  AS cause,
           nullif(substring(e.note FROM '(?:^| )life=([^ ]+)'), 'none')   AS life,
           nullif(substring(e.note FROM '(?:^| )fact=([^ ]+)'), 'none')   AS fact
    FROM factory.events e
    WHERE e.state = 'intervention' AND e.issue IS NOT NULL
  ) x
  ORDER BY repo, issue, who, cause, coalesce(fact, event_id::text, ts::text), ts
), tr AS (
  SELECT repo, issue, ts,
         substring(note FROM '(?:^| )life=([^ ]+)') AS life,
         substring(note FROM '(?:^| )to=([^ ]+)')   AS to_state
  FROM factory.events WHERE state = 'transition' AND issue IS NOT NULL
), merged AS (
  SELECT repo, issue, min(ts) AS merged_at
  FROM factory.events WHERE state = 'merged' AND issue IS NOT NULL GROUP BY repo, issue
), spans AS (
  SELECT m.repo, m.issue, m.merged_at,
    least(coalesce((SELECT min(c.ts) FROM factory.events c
                    WHERE c.repo = m.repo AND c.issue = m.issue AND c.state = 'claimed'), m.merged_at), m.merged_at) AS from_ts,
    greatest(m.merged_at, coalesce((
      SELECT min(t.ts) FROM tr t
      WHERE t.repo = m.repo AND t.issue = m.issue AND t.to_state = 'closed'
        AND t.ts >= coalesce((SELECT max(c.ts) FROM factory.events c
                              WHERE c.repo = m.repo AND c.issue = m.issue AND c.state = 'claimed' AND c.ts <= m.merged_at),
                             m.merged_at)), m.merged_at)) + interval '30 minutes' AS until_ts
  FROM merged m
), mine AS (
  SELECT s.repo, s.issue, iv.who, iv.cause
  FROM spans s
  JOIN iv ON iv.repo = s.repo AND iv.issue = s.issue
  WHERE CASE
    WHEN iv.life IS NOT NULL AND EXISTS (SELECT 1 FROM tr t WHERE t.repo = s.repo AND t.issue = s.issue AND t.life = iv.life)
      THEN EXISTS (SELECT 1 FROM tr t WHERE t.repo = s.repo AND t.issue = s.issue AND t.life = iv.life AND t.ts <= s.merged_at)
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
(`reviewed`, by `verdict`), each triage call (an `intervention` with cause `triage`, by the choice the
next triage row of the loop's table applied: `X1` retry, `X2` fix, `X3` redesign, `X4` park, `X5`
drop, else `pending`), a designer's question or split (a `transition` by row `T3` or `T4`) and a
fixer's dispositions (`verdict` events of actor `fixer`, `CORRECT` fixed, `WRONG` declined). A call is
**overridden** when a person intervention names its issue within an hour after it.

```sql
WITH calls AS (
  SELECT DISTINCT ON (repo, issue, kind, key) repo, issue, ts, kind, outcome
  FROM (
    SELECT e.repo, e.issue, e.ts, 'review' AS kind,
           substring(e.note FROM '(?:^| )verdict=([^ ]+)') AS outcome,
           coalesce(substring(e.note FROM '(?:^| )round=([^ ]+)'), '') || '/' ||
           coalesce(substring(e.note FROM '(?:^| )patch=([^ ]+)'), '') AS key
    FROM factory.events e WHERE e.state = 'reviewed'
    UNION ALL
    SELECT e.repo, e.issue, e.ts, 'triage',
           coalesce((SELECT CASE substring(x.note FROM '(?:^| )row=([^ ]+)')
                              WHEN 'X1' THEN 'retry' WHEN 'X2' THEN 'fix' WHEN 'X3' THEN 'redesign'
                              WHEN 'X4' THEN 'park' WHEN 'X5' THEN 'drop' END
                     FROM factory.events x
                     WHERE x.repo = e.repo AND x.issue = e.issue AND x.state = 'transition' AND x.ts >= e.ts
                       AND substring(x.note FROM '(?:^| )row=([^ ]+)') IN ('X1', 'X2', 'X3', 'X4', 'X5')
                     ORDER BY x.ts LIMIT 1), 'pending'),
           coalesce(substring(e.note FROM '(?:^| )fact=([^ ]+)'), e.event_id::text)
    FROM factory.events e
    WHERE e.state = 'intervention' AND e.note ~ '(^| )who=loop( |$)' AND e.note ~ '(^| )cause=triage( |$)'
    UNION ALL
    SELECT e.repo, e.issue, e.ts, 'design',
           CASE substring(e.note FROM '(?:^| )row=([^ ]+)') WHEN 'T3' THEN 'question' ELSE 'split' END,
           substring(e.note FROM '(?:^| )life=([^ ]+)') || '/' || substring(e.note FROM '(?:^| )seq=([^ ]+)')
    FROM factory.events e
    WHERE e.state = 'transition' AND substring(e.note FROM '(?:^| )row=([^ ]+)') IN ('T3', 'T4')
    UNION ALL
    SELECT e.repo, e.issue, e.ts, 'fix', CASE WHEN e.note LIKE 'CORRECT%' THEN 'fixed' ELSE 'declined' END,
           coalesce(e.event_id::text, e.ts::text)
    FROM factory.events e
    WHERE e.state = 'verdict' AND e.actor = 'fixer' AND (e.note LIKE 'CORRECT%' OR e.note LIKE 'WRONG%')
  ) c
  ORDER BY repo, issue, kind, key, ts
)
SELECT c.repo, c.kind, c.outcome,
  count(*) AS calls,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM factory.events p
    WHERE p.repo = c.repo AND p.issue = c.issue AND p.state = 'intervention'
      AND p.note ~ '(^| )who=person( |$)' AND p.ts > c.ts AND p.ts <= c.ts + interval '1 hour')) AS overridden
FROM calls c
GROUP BY c.repo, c.kind, c.outcome
ORDER BY c.repo, c.kind, c.outcome;
```

**Claim completion** (#632 metric 3): per issue and life, its first `claimed`, then the first of
`merged`, `abandoned` (by the note's `reason`: `dropped`, `split`, `triage`, `reconcile`), `closed`, a
release back to the queue (`reclaimed` or `ready`, read as `released`) or a `transition` to parked; a
claim with none of them yet is `open`. A claim while a life is open is the same life (a re-claim of a
lapsed claim). Open claims are censored, not failures, so the share merged is of the resolved ones.

```sql
WITH ends AS (
  SELECT repo, issue, ts,
    CASE state WHEN 'merged' THEN 'merged' WHEN 'closed' THEN 'closed'
               WHEN 'reclaimed' THEN 'released' WHEN 'ready' THEN 'released'
               WHEN 'abandoned' THEN 'abandoned:' || coalesce(substring(note FROM '(?:^| )reason=([^ ]+)'), 'unknown')
               ELSE 'parked' END AS outcome
  FROM factory.events
  WHERE issue IS NOT NULL
    AND (state IN ('merged', 'closed', 'reclaimed', 'ready', 'abandoned')
         OR (state = 'transition' AND note ~ '(^| )to=parked( |$)'))
), claims AS (
  SELECT c.repo, c.issue, c.device, c.ts AS claimed_at,
         (SELECT max(e.ts) FROM ends e WHERE e.repo = c.repo AND e.issue = c.issue AND e.ts < c.ts) AS prev_end
  FROM factory.events c
  WHERE c.state = 'claimed' AND c.issue IS NOT NULL
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
rounds are the distinct `round` values of its `reviewed` events, fix rounds its `fix_requested`
events, and time in flight leaves out the time parked (a `transition` to parked until the issue's
next transition).

```sql
WITH merged AS (
  SELECT repo, issue, min(ts) AS merged_at
  FROM factory.events WHERE state = 'merged' AND issue IS NOT NULL GROUP BY repo, issue
), claimed AS (
  SELECT repo, issue, min(ts) AS claimed_at
  FROM factory.events WHERE state = 'claimed' AND issue IS NOT NULL GROUP BY repo, issue
), spans AS (
  SELECT m.repo, m.issue, least(c.claimed_at, m.merged_at) AS from_ts, m.merged_at AS to_ts
  FROM merged m LEFT JOIN claimed c ON c.repo = m.repo AND c.issue = m.issue
), tr AS (  -- one row per (issue, life, seq), with the issue's next transition
  SELECT repo, issue, ts, to_state, lead(ts) OVER (PARTITION BY repo, issue ORDER BY ts) AS next_ts
  FROM (
    SELECT DISTINCT ON (repo, issue, life, seq) repo, issue, ts, to_state
    FROM (
      SELECT repo, issue, ts,
             substring(note FROM '(?:^| )life=([^ ]+)') AS life,
             substring(note FROM '(?:^| )seq=([^ ]+)')  AS seq,
             substring(note FROM '(?:^| )to=([^ ]+)')   AS to_state
      FROM factory.events WHERE state = 'transition' AND issue IS NOT NULL
    ) x
    ORDER BY repo, issue, life, seq, ts
  ) y
)
SELECT s.repo, s.issue, s.to_ts AS merged_at,
  (SELECT count(DISTINCT substring(r.note FROM '(?:^| )round=([^ ]+)')) FROM factory.events r
   WHERE r.repo = s.repo AND r.issue = s.issue AND r.state = 'reviewed'
     AND r.ts BETWEEN s.from_ts AND s.to_ts)                                  AS review_rounds,
  (SELECT count(*) FROM factory.events f
   WHERE f.repo = s.repo AND f.issue = s.issue AND f.state = 'fix_requested'
     AND f.ts BETWEEN s.from_ts AND s.to_ts)                                  AS fix_rounds,
  round(extract(epoch FROM s.to_ts - s.from_ts) - coalesce((
    SELECT sum(extract(epoch FROM least(coalesce(t.next_ts, s.to_ts), s.to_ts) - greatest(t.ts, s.from_ts)))
    FROM tr t
    WHERE t.repo = s.repo AND t.issue = s.issue AND t.to_state = 'parked'
      AND t.ts < s.to_ts AND coalesce(t.next_ts, s.to_ts) > s.from_ts), 0)) AS in_flight_s
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

## Linking pipeline runs to issues

`run_started` is logged only when an agent remembers to, so 13 of the first 37 merged issues have
none. The no-mistakes database records every run itself and `nm-push-loop` mirrors it, so the
mirror is the source of every pipeline fact (start time, status, parked time, PR). A run belongs to
issue N of repo R when:

- `runs.repo = lower(R)` (the exporter lowercases `repo`; `factory.events.repo` is not lowercased,
  so compare with `lower()`), and
- its `branch` matches `(^|/)issue-([0-9]+)(-|$)`, the `feat/issue-<N>-<slug>` convention the
  `implement-issue` skill uses (the CTE reads up to nine digits).

Legacy fallback: a run whose branch carries no issue number is linked through a `run_started` event
with the same `run_id`, so old rows keep working. The branch wins when the two disagree. Every
other run, including one with NULL `repo`, is unlinked: it is left out of per-issue numbers and
listed by the "Unlinked runs" saved query, never silently dropped. The start of a pipeline run in
any issue-level metric is the linked run's `created_at`; `run_started` timestamps are never read.

Copy the CTE verbatim. Queries 1 and 7, the example join, saved query 7 and "Unlinked runs" all
start with it (`tests/metrics-queries.test.js` fails if a copy drifts):

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

Example: pipeline runs with the issue each one belongs to (`run_link`, from "Linking pipeline
runs to issues" above; the branch name does the linking, so no event is needed):

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
SELECT r.repo, rl.issue, r.id AS run_id, r.status, r.no_mistakes_version,
       (SELECT count(*) FROM nomistakes.step_results s WHERE s.run_id = r.id) AS steps,
       (SELECT sum(i.input_tokens + i.output_tokens) FROM nomistakes.agent_invocations i
        WHERE i.run_id = r.id) AS tokens
FROM nomistakes.runs r
JOIN run_link rl ON rl.run_id = r.id
ORDER BY r.created_at, r.id;
```

### Saved queries

Seven queries on the mirror, each runnable as is with `dev-query`. They qualify every `nomistakes` column
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
time and the rest. Pipeline time is `runs.updated_at - runs.created_at` summed over the runs
`run_link` places on the issue (by branch name, see "Linking pipeline runs to issues"); it
includes the time those runs sat parked, so `parked_s` is shown beside it (not additional to it).
`other_s` is everything outside the pipeline: waiting to be picked up, design, review and merge.

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
),
issues AS (
  SELECT e.repo, e.issue,
         min(e.ts) FILTER (WHERE e.state = 'claimed') AS claimed_at,
         max(e.ts) FILTER (WHERE e.state = 'merged') AS merged_at
  FROM factory.events e
  WHERE e.issue IS NOT NULL
  GROUP BY e.repo, e.issue
)
SELECT n.repo, n.issue,
       round(extract(epoch FROM n.merged_at - n.claimed_at)) AS lead_s,
       round(sum(extract(epoch FROM r.updated_at - r.created_at))) AS pipeline_s,
       round(sum(coalesce(r.parked_ms, 0)) / 1000.0) AS parked_s,
       round(extract(epoch FROM n.merged_at - n.claimed_at) - sum(extract(epoch FROM r.updated_at - r.created_at))) AS other_s,
       count(r.id) AS runs
FROM issues n
JOIN run_link l ON lower(n.repo) = l.repo AND l.issue = n.issue
JOIN nomistakes.runs r ON r.id = l.run_id
WHERE n.claimed_at IS NOT NULL AND n.merged_at IS NOT NULL
GROUP BY n.repo, n.issue, n.claimed_at, n.merged_at
ORDER BY n.merged_at;
```

#### Unlinked runs

The runs `run_link` cannot place on an issue, so no per-issue number counts them: a branch with no
`issue-<N>` (a release, a chore, a probe), or a run with no `repo`. An issue whose only runs are
listed here shows NULL pipeline times in queries 1 and 7. One row per run, ordered by repo and
device.

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
SELECT r.repo, r.device, r.id AS run_id, r.branch, r.status, r.created_at
FROM nomistakes.runs r
WHERE NOT EXISTS (SELECT 1 FROM run_link rl WHERE rl.run_id = r.id)
ORDER BY r.repo, r.device, r.created_at, r.id;
```

## Offline computation: `callum-flow-evaluate`

`callum-flow-evaluate --repo <owner/name> --since <ISO> [--until <ISO>] [--format json|markdown]
[--events <file>] [--nm-export <file>] [--ready-times <file>]` (base image, `images/base/callum-flow-evaluate`)
computes queries 1 to 7 and 9 for a time window from an events file (`--events`, default the local
event log; a `factory.events` export covers every device), plus token spend, waste and pipeline
numbers from Claude Code transcripts and the no-mistakes `state.sqlite`. It is read-only, makes
no network calls and is deterministic. The `evaluate-sessions` skill runs it and writes the
report; every number in a report comes from this tool. Differences from the SQL:
the window selects issues by their `merged` event (query 1) or first `merge_ready` (query 2) and
verdicts by their own timestamp (queries 3 and 5), and the events file is the one device's log
unless a `factory.events` export is passed (see the skill).

- `throughput` (query 1) and `waiting` (query 7) take every pipeline run start from the linked
  runs of the no-mistakes source (`state.sqlite` or `--nm-export`), by the rules in "Linking
  pipeline runs to issues"; `run_started` events are read only for the legacy link, never for a
  timestamp. Each lead-time row carries `run_source`: `mirror` (the first linked run is linked by
  its branch), `run_started` (linked only by a legacy event) or `none`. With no linked run in the
  source, `implementation` and `pipeline` are `null`, never a number from the events, and nothing
  is pipeline-bound in the waiting split. `pipeline.unlinked_runs` counts this repo's runs created
  in the window that no issue claims (the "Unlinked runs" query; runs with no `repo` belong to no
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
