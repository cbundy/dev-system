-- per merged issue: the interventions that name its merged work, and whether it was untouched
WITH iv AS (
  SELECT DISTINCT ON (repo, issue, who, cause, coalesce(fact, event_id::text, ts::text))
         repo, issue, ts, who, cause, life
  FROM (
    SELECT e.repo, e.issue, e.ts, e.event_id,
           substring(e.note FROM '(?:^| )who=([^ ]+)')                    AS who,
           substring(e.note FROM '(?:^| )cause=([^ ]+)')                  AS cause,
           nullif(substring(e.note FROM '(?:^| )life=([^ ]+)'), 'none')   AS life,
           nullif(substring(e.note FROM '(?:^| )fact=([^ ]+)'), 'none')   AS fact
    FROM factory.events e
    WHERE e.state = 'intervention' AND e.issue IS NOT NULL
  ) x
  ORDER BY repo, issue, who, cause, coalesce(fact, event_id::text, ts::text), ts
), tr AS (
  SELECT repo, issue, ts,
         substring(note FROM '(?:^| )life=([^ ]+)') AS life,
         substring(note FROM '(?:^| )to=([^ ]+)')   AS to_state
  FROM factory.events WHERE state = 'transition' AND issue IS NOT NULL
), merged AS (
  SELECT repo, issue, min(ts) AS merged_at
  FROM factory.events WHERE state = 'merged' AND issue IS NOT NULL GROUP BY repo, issue
), spans AS (
  SELECT m.repo, m.issue, m.merged_at,
    least(coalesce((SELECT min(c.ts) FROM factory.events c
                    WHERE c.repo = m.repo AND c.issue = m.issue AND c.state = 'claimed'), m.merged_at), m.merged_at) AS from_ts,
    greatest(m.merged_at, coalesce((
      SELECT min(t.ts) FROM tr t
      WHERE t.repo = m.repo AND t.issue = m.issue AND t.to_state = 'closed'
        AND t.ts >= coalesce((SELECT max(c.ts) FROM factory.events c
                              WHERE c.repo = m.repo AND c.issue = m.issue AND c.state = 'claimed' AND c.ts <= m.merged_at),
                             m.merged_at)), m.merged_at)) + interval '30 minutes' AS until_ts
  FROM merged m
), mine AS (
  SELECT s.repo, s.issue, iv.who, iv.cause
  FROM spans s
  JOIN iv ON iv.repo = s.repo AND iv.issue = s.issue
  WHERE CASE
    WHEN iv.life IS NOT NULL AND EXISTS (SELECT 1 FROM tr t WHERE t.repo = s.repo AND t.issue = s.issue AND t.life = iv.life)
      THEN EXISTS (SELECT 1 FROM tr t WHERE t.repo = s.repo AND t.issue = s.issue AND t.life = iv.life AND t.ts <= s.merged_at)
    ELSE iv.ts >= s.from_ts AND iv.ts <= s.until_ts
  END
)
SELECT s.repo, s.issue, s.merged_at,
  count(mine.cause) FILTER (WHERE mine.who = 'person') AS person,
  count(mine.cause) FILTER (WHERE mine.who = 'loop')   AS loop,
  count(mine.cause) = 0                                AS untouched,
  string_agg(DISTINCT mine.cause, ',')                 AS causes
FROM spans s
LEFT JOIN mine ON mine.repo = s.repo AND mine.issue = s.issue
GROUP BY s.repo, s.issue, s.merged_at
ORDER BY s.merged_at DESC;
