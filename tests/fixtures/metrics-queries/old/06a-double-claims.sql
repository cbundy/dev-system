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
