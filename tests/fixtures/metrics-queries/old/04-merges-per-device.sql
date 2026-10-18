SELECT device, date_trunc('week', ts)::date AS week, count(DISTINCT (repo, issue)) AS merges
FROM factory.events
WHERE state = 'merged'
GROUP BY device, week
ORDER BY week DESC, merges DESC;
