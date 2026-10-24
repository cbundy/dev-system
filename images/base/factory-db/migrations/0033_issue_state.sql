-- 0033: the factory loop v2's state of every issue, as a view (cbundy/dev-system#1292). One row
-- per (repo, issue) that is live or whose life ended in the 24 hours before the instant asked
-- about. It gives the tool callum-flow-factory-state a database-side twin of its `v2` field, so a
-- later change can read the state instead of deriving it from the event rows in the client.
--
-- Run by factory-db-bootstrap in one transaction, as the database's NAME_owner role. Grants come
-- from the bootstrap (SELECT for the reader and the writer on every view; no INSERT or UPDATE on a
-- view; EXECUTE on a function is PUBLIC's by default). Nothing here is dropped, renamed or
-- retyped, and neither factory.event_store nor factory.event_log is touched. The panel role has no
-- USAGE on schema factory, so it reaches none of this.
--
-- factory.stuck_rules is a view over VALUES, not a table, on purpose: a table in schema factory
-- gets INSERT and UPDATE for the writer from the default privileges, and the writer (every loop)
-- must not be able to move a threshold. Only the owner role changes a threshold, by a migration
-- that replaces the view. A NULL minutes means the state has no stuck rule.
--
-- Type versions read: only the versions this file names, the current ones of
-- images/base/factory-event-shapes.json: transition, claimed, claim_renewed, requeued, ready,
-- merged, closed and abandoned, all at version 1. A row of a newer version is left out, never
-- misread: a newer writer's event does not change the state until the SQL is updated to read it.
--
-- The rules are those of docs/factory-state.md "The factory loop v2" and of v2Of in
-- images/base/callum-flow-factory-state (the comparison of the two is in the issue's evidence):
--  - The deciding transition is the newest one of the newest life. A life is a base-36 token
--    (when its claim started); a token that does not decode sorts lowest. Within a life the order
--    is seq_at, then seq (then ts and event_id, so a transition logged again after a re-claim
--    picks its newest copy). A closed transition with why claim-lost belongs to another device and
--    is ignored.
--  - A requeued, ready or claimed event newer than that transition releases the issue: it is
--    queued when the newest of those is a ready or requeued, designing when it is a claimed (a
--    claim with no transition yet).
--  - A merged, closed or abandoned event ends the life, and so does a closed transition, unless
--    a ready, requeued or claimed event came after it (a new life).
--  - A lapsed lease with no release keeps the loop's state; only lease_lapsed shows it.
-- No DISTINCT ON and no @> (0001): row_number() picks the newest row of each kind.

CREATE VIEW factory.stuck_rules (state, minutes) AS
SELECT r.state, r.minutes
FROM (VALUES
  ('queued', NULL::int),
  ('designing', 240),
  ('building', 60),
  ('reviewing', NULL),
  ('fixing', NULL),
  ('merge-queue', 30),
  ('parked', 30),
  ('waiting', NULL)
) AS r(state, minutes);

CREATE FUNCTION factory.issue_state_at(at timestamptz)
RETURNS TABLE (
  repo text, issue int, state text, step text, attempt int, life text, seq int, state_since timestamptz,
  branch text, pr int, why text, question text, decision text, context text, options jsonb,
  recommended text, recommendation text, holder text, claimed_at timestamptz, lease_until timestamptz,
  lease_lapsed boolean, ended boolean, stuck_minutes int, stuck boolean
)
LANGUAGE sql STABLE AS $fn$
WITH ev AS (
  SELECT l.event_id, l.ts, l.type, lower(l.repo) AS repo, l.issue, l.device, l.branch, l.pr, l.lease_minutes,
    l.to_state, l.life, l.seq, l.seq_at, l.state_since, l.step, l.attempt, l.why, l.question,
    l.decision, l.context, l.options, l.recommended, l.recommendation
  FROM factory.event_log l
  WHERE l.ts <= $1 AND l.issue IS NOT NULL
    AND (l.type, l.type_version) IN (VALUES
      ('transition', 1), ('claimed', 1), ('claim_renewed', 1), ('requeued', 1),
      ('ready', 1), ('merged', 1), ('closed', 1), ('abandoned', 1))
),
tv AS (
  SELECT * FROM (
    SELECT c.*, row_number() OVER (
      PARTITION BY c.repo, c.issue
      ORDER BY c.life_n DESC, c.seq_at DESC NULLS LAST, c.seq DESC NULLS LAST, c.ts DESC, c.event_id DESC) AS rn
    FROM (
      SELECT e.*, CASE WHEN e.life ~ '^[0-9a-z]+$' THEN (
        SELECT sum((strpos('0123456789abcdefghijklmnopqrstuvwxyz', substr(e.life, i, 1)) - 1)
          * power(36::numeric, length(e.life) - i))
        FROM generate_series(1, length(e.life)) AS i) ELSE -1 END AS life_n
      FROM ev e
      WHERE e.type = 'transition' AND e.life IS NOT NULL AND e.life <> ''
        AND e.to_state IN ('queued', 'designing', 'building', 'reviewing', 'fixing', 'merge-queue', 'parked', 'waiting', 'closed')
        AND NOT (e.to_state = 'closed' AND e.why = 'claim-lost')
    ) c
  ) t WHERE t.rn = 1
),
rel AS (
  SELECT * FROM (
    SELECT e.*, row_number() OVER (PARTITION BY e.repo, e.issue ORDER BY e.ts DESC, e.event_id DESC) AS rn
    FROM ev e WHERE e.type IN ('ready', 'requeued', 'claimed')
  ) t WHERE t.rn = 1
),
fin AS (
  SELECT * FROM (
    SELECT e.*, row_number() OVER (PARTITION BY e.repo, e.issue ORDER BY e.ts DESC, e.event_id DESC) AS rn
    FROM ev e
    WHERE e.type IN ('merged', 'closed', 'abandoned')
      OR (e.type = 'transition' AND e.to_state = 'closed' AND e.why IS DISTINCT FROM 'claim-lost')
  ) t WHERE t.rn = 1
),
lease AS (
  SELECT * FROM (
    SELECT e.*, row_number() OVER (PARTITION BY e.repo, e.issue ORDER BY e.ts DESC, e.event_id DESC) AS rn
    FROM ev e WHERE e.type IN ('claimed', 'claim_renewed')
  ) t WHERE t.rn = 1
),
clm AS (
  SELECT * FROM (
    SELECT e.*, row_number() OVER (PARTITION BY e.repo, e.issue ORDER BY e.ts DESC, e.event_id DESC) AS rn
    FROM ev e WHERE e.type = 'claimed'
  ) t WHERE t.rn = 1
),
keys AS (
  SELECT e.repo, e.issue FROM ev e GROUP BY e.repo, e.issue
),
j AS (
  SELECT k.repo, k.issue, tv.event_id AS tv_id, tv.to_state AS tv_state, tv.ts AS tv_ts, tv.life AS tv_life,
    tv.seq AS tv_seq, tv.step AS tv_step, tv.attempt AS tv_attempt, tv.branch AS tv_branch, tv.pr AS tv_pr,
    tv.why AS tv_why, tv.question AS tv_question, tv.decision AS tv_decision, tv.context AS tv_context,
    tv.options AS tv_options, tv.recommended AS tv_recommended, tv.recommendation AS tv_recommendation,
    CASE WHEN tv.state_since IS NOT NULL AND tv.state_since <= tv.ts THEN tv.state_since ELSE tv.ts END AS tv_since,
    rel.type AS rel_type, rel.ts AS rel_ts, rel.branch AS rel_branch, rel.pr AS rel_pr,
    fin.type AS fin_type, fin.ts AS fin_ts, fin.branch AS fin_branch, fin.pr AS fin_pr,
    lease.ts AS lease_ts, lease.lease_minutes AS lease_min,
    clm.device AS holder, clm.ts AS claimed_at,
    (fin.ts IS NOT NULL AND (rel.ts IS NULL OR rel.ts <= fin.ts)) AS is_ended,
    (tv.event_id IS NULL OR coalesce(rel.ts > tv.ts, false)) AS is_released
  FROM keys k
  LEFT JOIN tv ON tv.repo = k.repo AND tv.issue = k.issue
  LEFT JOIN rel ON rel.repo = k.repo AND rel.issue = k.issue
  LEFT JOIN fin ON fin.repo = k.repo AND fin.issue = k.issue
  LEFT JOIN lease ON lease.repo = k.repo AND lease.issue = k.issue
  LEFT JOIN clm ON clm.repo = k.repo AND clm.issue = k.issue
),
s AS (
  SELECT j.*,
    CASE WHEN j.is_ended THEN 'closed'
      WHEN NOT j.is_released THEN j.tv_state
      WHEN j.rel_type = 'claimed' THEN 'designing'
      ELSE 'queued' END AS st,
    -- the record of the deciding transition shows when it decides, or when its life ended
    (j.tv_id IS NOT NULL AND (j.is_ended OR NOT j.is_released)) AS uses_tv
  FROM j
  WHERE j.is_ended OR j.tv_id IS NOT NULL OR j.rel_ts IS NOT NULL
)
SELECT
  s.repo, s.issue, s.st AS state,
  CASE WHEN s.uses_tv AND (NOT s.is_ended OR s.tv_state = 'closed') THEN s.tv_step END AS step,
  CASE WHEN s.uses_tv AND (NOT s.is_ended OR s.tv_state = 'closed') THEN s.tv_attempt END AS attempt,
  CASE WHEN s.uses_tv THEN s.tv_life END AS life,
  CASE WHEN s.uses_tv THEN s.tv_seq END AS seq,
  CASE WHEN s.is_ended THEN CASE WHEN s.tv_state = 'closed' THEN s.tv_since ELSE s.fin_ts END
    WHEN NOT s.is_released THEN s.tv_since
    ELSE s.rel_ts END AS state_since,
  CASE WHEN s.uses_tv THEN s.tv_branch WHEN s.is_ended THEN s.fin_branch ELSE s.rel_branch END AS branch,
  CASE WHEN s.uses_tv THEN s.tv_pr WHEN s.is_ended THEN s.fin_pr ELSE s.rel_pr END AS pr,
  CASE WHEN s.is_ended THEN CASE WHEN s.tv_state = 'closed' THEN s.tv_why WHEN s.fin_type = 'merged' THEN 'merged' END END AS why,
  CASE WHEN s.st = 'parked' AND s.uses_tv AND NOT s.is_ended THEN s.tv_question END AS question,
  CASE WHEN s.st = 'parked' AND s.uses_tv AND NOT s.is_ended THEN s.tv_decision END AS decision,
  CASE WHEN s.st = 'parked' AND s.uses_tv AND NOT s.is_ended THEN s.tv_context END AS context,
  CASE WHEN s.st = 'parked' AND s.uses_tv AND NOT s.is_ended THEN s.tv_options END AS options,
  CASE WHEN s.st = 'parked' AND s.uses_tv AND NOT s.is_ended THEN s.tv_recommended END AS recommended,
  CASE WHEN s.st = 'parked' AND s.uses_tv AND NOT s.is_ended THEN s.tv_recommendation END AS recommendation,
  s.holder, s.claimed_at,
  s.lease_ts + make_interval(mins => CASE WHEN s.lease_min > 0 THEN s.lease_min ELSE 120 END) AS lease_until,
  s.lease_ts + make_interval(mins => CASE WHEN s.lease_min > 0 THEN s.lease_min ELSE 120 END) <= $1 AS lease_lapsed,
  s.is_ended AS ended,
  r.minutes AS stuck_minutes,
  NOT s.is_ended AND r.minutes IS NOT NULL
    AND CASE WHEN NOT s.is_released THEN s.tv_since ELSE s.rel_ts END < $1 - make_interval(mins => r.minutes) AS stuck
FROM s
LEFT JOIN factory.stuck_rules r ON r.state = s.st
WHERE NOT s.is_ended OR s.fin_ts > $1 - interval '24 hours'
$fn$;

CREATE VIEW factory.issue_state AS
SELECT * FROM factory.issue_state_at(now());
