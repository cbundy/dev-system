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
