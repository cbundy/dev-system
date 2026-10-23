-- 0030: the public panel (cbundy/dev-system#1264). A read-only window onto the repos on an
-- allowlist, for a public dashboard that logs in as NAME_panel (docs/factory-db.md "The panel
-- role"). Only adds: a table, a schema and views.
--
-- factory.public_repos is the allowlist, edited with factory-db-bootstrap --public-repo. The
-- views in factory_public run with their owner's rights (NAME_owner, who made them), so the panel
-- reads through them without any grant on the factory schema, and each is a security barrier so
-- a function the panel calls in a query cannot see a row the filter drops. Every column is named
-- (never *): a column a later migration adds to a factory table or view stays hidden from the
-- panel until that migration adds it to the matching view here too. The bootstrap grants SELECT
-- on the views it lists in PANEL_VIEWS, and nothing else.

CREATE TABLE factory.public_repos (
  repo text PRIMARY KEY CHECK (repo ~ '^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$'),
  added_at timestamptz NOT NULL DEFAULT now(),
  note text
);

CREATE SCHEMA factory_public;

CREATE VIEW factory_public.event_store WITH (security_barrier = true) AS
  SELECT
    envelope, event_id, ts, type, type_version, repo, device, actor, session_id, issue,
    base_image, dev_image, template_version, plugin_version, device_seq, data, regime
  FROM factory.event_store
  WHERE repo IN (SELECT repo FROM factory.public_repos);

CREATE VIEW factory_public.event_log WITH (security_barrier = true) AS
  SELECT
    envelope, event_id, ts, type, type_version, repo, device, actor, session_id, issue,
    base_image, dev_image, template_version, plugin_version, device_seq, answer_path,
    attempt, branch, cause, fact, from_state, head, life, outcome, pr, reason, round, seq,
    seq_at, state_since, step, table_row, to_state, verdict, via, who, why, result,
    wait_ms, run_ms, concurrency, queued_behind, started_at, requested_at, stopped_at,
    waited_ms, cap_ms, running_at_request, cut_at_stop, cut_at_stop_keys, trigger, reader,
    tool, compared, differences, live_differences, settle_seconds, old_ok, new_ok,
    lease_minutes, model, restored, patch, fixes, triages, lives, attempts, passes, acting,
    errors, mean_ms, p50_ms, p90_ms, max_ms, acting_mean_ms, idle_mean_ms, pass_every_ms,
    five_hour_pct, seven_day_pct, additions, deletions, bucket, opus_pct, available,
    ended_at, from_at, to_at, five_hour_resets_at, seven_day_resets_at, notes, files,
    split_into, resume_to, brief_url, question, kind, key, status, class, agent_id, mode,
    planner, by, title, labels, parent, tag, previous_tag, commit, wake, decision,
    milestone_closed, milestone_open, holding, prs, comment_url, observed_at, green,
    changed, flaky, failed_tests, failed_jobs, failed_at, tool_name, tool_input,
    agent_type, layer, old_value, new_value, flake_test, flakes, window_days,
    first_flake_at, filed_issue, sonnet_pct, context, options, recommended, recommendation,
    auth, spend_usd, budget_usd, budget_resets_at, recovered, mem_start_bytes,
    mem_peak_bytes, mem_limit_bytes, taken_at, considered, candidates, rest, free_slots,
    owner_priority, owner_only, owner_serial, owner_new_off, folded, version, area,
    needs_owner, touches, dropped, labels_set, labels_kept, observe_mean_ms,
    observe_commands_mean_ms, observe_in_process_mean_ms, observe_in_process_max_ms,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, regime,
    file_lines, issues, issues_closed, headlines
  FROM factory.event_log
  WHERE repo IN (SELECT repo FROM factory.public_repos);

CREATE VIEW factory_public.workers WITH (security_barrier = true) AS
  SELECT
    device, repo, role, ring, runtime, coder_workspace, base_image, dev_image,
    template_version, plugin_version, versions, state, in_flight, chat_active_at, sessions,
    critical_failures, push, interval_s, started_at, last_seen, cpu_pct, cpu_limit_cores,
    cpu_quota_set, mem_used_bytes, mem_limit_bytes, claude_interactive, claude_headless,
    claude_procs, procs, stats_at, config, mem_max_events, mem_max_rate_per_min,
    mem_oom_kills, mem_psi_some_avg10, mem_psi_full_avg10
  FROM factory.workers
  WHERE repo IN (SELECT repo FROM factory.public_repos);

-- Built on factory.workers, not on factory.workers_status, so a later DROP VIEW
-- factory.workers_status (as 0003, 0015 and 0020 did) is never blocked. The age and stale
-- expressions are those of factory.workers_status.
CREATE VIEW factory_public.workers_status WITH (security_barrier = true) AS
  SELECT
    w.device, w.repo, w.role, w.ring, w.runtime, w.coder_workspace, w.base_image, w.dev_image,
    w.template_version, w.plugin_version, w.versions, w.state, w.in_flight, w.chat_active_at, w.sessions,
    w.critical_failures, w.push, w.interval_s, w.started_at, w.last_seen, w.cpu_pct, w.cpu_limit_cores,
    w.cpu_quota_set, w.mem_used_bytes, w.mem_limit_bytes, w.claude_interactive, w.claude_headless,
    w.claude_procs, w.procs, w.stats_at, w.config, w.mem_max_events, w.mem_max_rate_per_min,
    w.mem_oom_kills, w.mem_psi_some_avg10, w.mem_psi_full_avg10,
    now() - w.last_seen AS age,
    (now() - w.last_seen) > make_interval(secs => 3 * coalesce(w.interval_s, 60)) AS stale
  FROM factory.workers w
  WHERE w.repo IN (SELECT repo FROM factory.public_repos);

CREATE VIEW factory_public.worker_samples WITH (security_barrier = true) AS
  SELECT
    device, sampled_at, state, cpu_pct, cpu_limit_cores, cpu_quota_set, mem_used_bytes,
    mem_limit_bytes, claude_interactive, claude_headless, claude_procs, procs, mem_max_events,
    mem_max_rate_per_min, mem_oom_kills, mem_psi_some_avg10, mem_psi_full_avg10
  FROM factory.worker_samples
  WHERE device IN (
    SELECT w.device FROM factory.workers w WHERE w.repo IN (SELECT repo FROM factory.public_repos));
