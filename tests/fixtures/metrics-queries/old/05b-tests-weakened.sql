SELECT repo,
  substring(note FROM 'step=(\S+)')                         AS step,
  count(*)                                                  AS commits,
  count(*) FILTER (WHERE note LIKE '%restored=no%')         AS unrestored
FROM factory.events
WHERE state = 'test_weakened'
GROUP BY repo, step
ORDER BY unrestored DESC, commits DESC;
