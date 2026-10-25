-- 0035: the GitHub API health of each worker (cbundy/dev-system#1305).
--
-- Run by factory-db-bootstrap in one transaction, as the database's NAME_owner role. The grants
-- for NAME_writer and NAME_reader come from the bootstrap (a re-apply on every run), so this file
-- has none.
--
-- Builds on 0020 and 0030 (every earlier column keeps its name, type and order). Adds nullable
-- columns to factory.workers (the latest reading) and factory.worker_samples (one per running
-- beat): the REST ("core") and GraphQL budgets (remaining, limit, reset time) of the device's
-- GitHub login, and the GitHub API errors the factory loop on that device hit in the last hour.
-- factory.workers also gets github_at, the database's now() at the write. A device that cannot
-- fill a value (no GitHub login, no loop running, an older image) leaves it NULL.
--
-- Like 0003 and 0020, w.* is expanded when a view is created, so factory.workers_status is made
-- again to show them. The factory_public views name every column (0030): the new ones go last,
-- since OR REPLACE only adds columns at the end; factory_public.workers_status has age and stale
-- after the table columns, so it is dropped and created again, as 0030 built it.

ALTER TABLE factory.workers
  ADD COLUMN github_core_remaining int,
  ADD COLUMN github_core_limit int,
  ADD COLUMN github_core_reset_at timestamptz,
  ADD COLUMN github_graphql_remaining int,
  ADD COLUMN github_graphql_limit int,
  ADD COLUMN github_graphql_reset_at timestamptz,
  ADD COLUMN github_errors_1h int,
  ADD COLUMN github_at timestamptz;

ALTER TABLE factory.worker_samples
  ADD COLUMN github_core_remaining int,
  ADD COLUMN github_core_limit int,
  ADD COLUMN github_core_reset_at timestamptz,
  ADD COLUMN github_graphql_remaining int,
  ADD COLUMN github_graphql_limit int,
  ADD COLUMN github_graphql_reset_at timestamptz,
  ADD COLUMN github_errors_1h int;

DROP VIEW factory.workers_status;
CREATE VIEW factory.workers_status AS
  SELECT w.*, now() - w.last_seen AS age,
    (now() - w.last_seen) > make_interval(secs => 3 * coalesce(w.interval_s, 60)) AS stale
  FROM factory.workers w;

CREATE OR REPLACE VIEW factory_public.workers WITH (security_barrier = true) AS
  SELECT
    device, repo, role, ring, runtime, coder_workspace, base_image, dev_image,
    template_version, plugin_version, versions, state, in_flight, chat_active_at, sessions,
    critical_failures, push, interval_s, started_at, last_seen, cpu_pct, cpu_limit_cores,
    cpu_quota_set, mem_used_bytes, mem_limit_bytes, claude_interactive, claude_headless,
    claude_procs, procs, stats_at, config, mem_max_events, mem_max_rate_per_min,
    mem_oom_kills, mem_psi_some_avg10, mem_psi_full_avg10,
    github_core_remaining, github_core_limit, github_core_reset_at, github_graphql_remaining,
    github_graphql_limit, github_graphql_reset_at, github_errors_1h, github_at
  FROM factory.workers
  WHERE repo IN (SELECT repo FROM factory.public_repos);

DROP VIEW factory_public.workers_status;
CREATE VIEW factory_public.workers_status WITH (security_barrier = true) AS
  SELECT
    w.device, w.repo, w.role, w.ring, w.runtime, w.coder_workspace, w.base_image, w.dev_image,
    w.template_version, w.plugin_version, w.versions, w.state, w.in_flight, w.chat_active_at, w.sessions,
    w.critical_failures, w.push, w.interval_s, w.started_at, w.last_seen, w.cpu_pct, w.cpu_limit_cores,
    w.cpu_quota_set, w.mem_used_bytes, w.mem_limit_bytes, w.claude_interactive, w.claude_headless,
    w.claude_procs, w.procs, w.stats_at, w.config, w.mem_max_events, w.mem_max_rate_per_min,
    w.mem_oom_kills, w.mem_psi_some_avg10, w.mem_psi_full_avg10,
    w.github_core_remaining, w.github_core_limit, w.github_core_reset_at, w.github_graphql_remaining,
    w.github_graphql_limit, w.github_graphql_reset_at, w.github_errors_1h, w.github_at,
    now() - w.last_seen AS age,
    (now() - w.last_seen) > make_interval(secs => 3 * coalesce(w.interval_s, 60)) AS stale
  FROM factory.workers w
  WHERE w.repo IN (SELECT repo FROM factory.public_repos);

CREATE OR REPLACE VIEW factory_public.worker_samples WITH (security_barrier = true) AS
  SELECT
    device, sampled_at, state, cpu_pct, cpu_limit_cores, cpu_quota_set, mem_used_bytes,
    mem_limit_bytes, claude_interactive, claude_headless, claude_procs, procs, mem_max_events,
    mem_max_rate_per_min, mem_oom_kills, mem_psi_some_avg10, mem_psi_full_avg10,
    github_core_remaining, github_core_limit, github_core_reset_at, github_graphql_remaining,
    github_graphql_limit, github_graphql_reset_at, github_errors_1h
  FROM factory.worker_samples
  WHERE device IN (
    SELECT w.device FROM factory.workers w WHERE w.repo IN (SELECT repo FROM factory.public_repos));
