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
