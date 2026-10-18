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
routed AS (   -- issues the hash split, each on one model; label, default and fallback routes are left out
  SELECT lower(e.repo) AS repo, e.issue, min(e.ts) AS routed_at,
         min(substring(e.note FROM 'model=([^ ]+)')) AS model
  FROM factory.events e
  WHERE e.state = 'implementer_routed' AND e.issue IS NOT NULL
  GROUP BY lower(e.repo), e.issue
  HAVING bool_and(substring(e.note FROM 'reason=([^ ]+)') = 'hash')
     AND count(DISTINCT substring(e.note FROM 'model=([^ ]+)')) = 1
), facts AS (  -- orchestrator facts from the first route on
  SELECT x.repo, x.issue, x.model,
         min(e.ts) FILTER (WHERE e.state = 'delegated')                      AS delegated_at,
         min(e.ts) FILTER (WHERE e.state = 'merge_ready')                    AS green_at,
         min(e.ts) FILTER (WHERE e.state = 'merged')                         AS merged_at,
         min(e.ts) FILTER (WHERE e.state IN ('failed', 'fix_requested'))     AS setback_at,
         count(e.ts) FILTER (WHERE e.state = 'fix_requested')                AS fix_requests,
         bool_or(e.state = 'abandoned')                                      AS abandoned
  FROM routed x
  LEFT JOIN factory.events e ON lower(e.repo) = x.repo AND e.issue = x.issue AND e.ts >= x.routed_at
  GROUP BY x.repo, x.issue, x.model
), run_facts AS (  -- the issue's pipeline runs from the first route on
  SELECT x.repo, x.issue, r.id AS run_id, r.created_at, coalesce(r.parked_ms, 0) AS parked_ms,
         (SELECT count(*) FROM nomistakes.step_results s
          WHERE s.run_id = r.id AND s.status = 'failed') AS failed_steps,
         (SELECT count(*) FROM nomistakes.step_rounds d JOIN nomistakes.step_results s ON s.id = d.step_result_id
          WHERE s.run_id = r.id AND d.trigger_type = 'auto_fix') AS auto_fix_rounds,
         (SELECT coalesce(sum(i.input_tokens + i.output_tokens), 0) FROM nomistakes.agent_invocations i
          WHERE i.run_id = r.id) AS tokens
  FROM routed x
  JOIN run_link l ON l.repo = x.repo AND l.issue = x.issue AND l.created_at >= x.routed_at
  JOIN nomistakes.runs r ON r.id = l.run_id
), per_issue AS (
  SELECT f.repo, f.issue, f.model, f.delegated_at, f.green_at, f.merged_at, f.setback_at, f.fix_requests, f.abandoned,
         min(rf.created_at) AS first_run_at, count(rf.run_id) AS runs,
         coalesce(sum(rf.failed_steps), 0) AS failed_steps, coalesce(sum(rf.auto_fix_rounds), 0) AS auto_fix_rounds,
         coalesce(sum(rf.parked_ms), 0) AS parked_ms, coalesce(sum(rf.tokens), 0) AS tokens
  FROM facts f
  LEFT JOIN run_facts rf ON rf.repo = f.repo AND rf.issue = f.issue
  GROUP BY f.repo, f.issue, f.model, f.delegated_at, f.green_at, f.merged_at, f.setback_at, f.fix_requests, f.abandoned
)
SELECT model,
  count(*)                                                                         AS issues,
  count(merged_at)                                                                 AS merged,
  count(*) FILTER (WHERE abandoned AND merged_at IS NULL)                          AS abandoned,
  round(100.0 * count(*) FILTER (WHERE green_at IS NOT NULL AND (setback_at IS NULL OR setback_at > green_at))
        / nullif(count(green_at), 0), 1)                                           AS first_pass_pct,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_run_at - delegated_at))) AS implementation_p50_s,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM green_at - first_run_at)))     AS pipeline_p50_s,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM merged_at - delegated_at)))    AS total_p50_s,
  round(avg(runs) FILTER (WHERE merged_at IS NOT NULL), 2)                         AS runs_per_merged,
  round(avg(fix_requests) FILTER (WHERE merged_at IS NOT NULL), 2)                 AS fix_requests_per_merged,
  round(avg(auto_fix_rounds) FILTER (WHERE merged_at IS NOT NULL), 2)              AS auto_fix_rounds_per_merged,
  round(avg(failed_steps) FILTER (WHERE merged_at IS NOT NULL), 2)                 AS failed_steps_per_merged,
  round(avg(parked_ms) FILTER (WHERE merged_at IS NOT NULL) / 1000)                AS parked_s_per_merged,
  round(avg(tokens) FILTER (WHERE merged_at IS NOT NULL))                          AS pipeline_tokens_per_merged
FROM per_issue
GROUP BY model
ORDER BY model;
