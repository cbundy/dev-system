-- interventions per repo and day, by who and cause; `fleet` counts those that name no issue
WITH iv AS (
  SELECT DISTINCT ON (repo, coalesce(issue, 0), who, cause, coalesce(fact, event_id::text, ts::text))
         repo, issue, ts, who, cause
  FROM (
    SELECT e.repo, e.issue, e.ts, e.event_id,
           substring(e.note FROM '(?:^| )who=([^ ]+)')                    AS who,
           substring(e.note FROM '(?:^| )cause=([^ ]+)')                  AS cause,
           nullif(substring(e.note FROM '(?:^| )fact=([^ ]+)'), 'none')   AS fact
    FROM factory.events e
    WHERE e.state = 'intervention'
  ) x
  ORDER BY repo, coalesce(issue, 0), who, cause, coalesce(fact, event_id::text, ts::text), ts
)
SELECT repo, date_trunc('day', ts)::date AS day, who, cause,
  count(*)                              AS interventions,
  count(*) FILTER (WHERE issue IS NULL) AS fleet
FROM iv
GROUP BY repo, day, who, cause
ORDER BY repo, day, who, cause;
