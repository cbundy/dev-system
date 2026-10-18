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
