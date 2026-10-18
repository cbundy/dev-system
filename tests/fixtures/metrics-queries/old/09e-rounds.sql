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
