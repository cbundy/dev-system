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
