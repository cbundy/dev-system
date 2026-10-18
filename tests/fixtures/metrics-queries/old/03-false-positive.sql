SELECT repo,
  count(*) FILTER (WHERE note LIKE 'CORRECT%') AS correct,
  count(*) FILTER (WHERE note LIKE 'WRONG%')   AS wrong,
  round(100.0 * count(*) FILTER (WHERE note LIKE 'WRONG%')
        / nullif(count(*) FILTER (WHERE note LIKE 'CORRECT%' OR note LIKE 'WRONG%'), 0), 1) AS false_positive_pct
FROM factory.events
WHERE state = 'verdict'
GROUP BY repo;
