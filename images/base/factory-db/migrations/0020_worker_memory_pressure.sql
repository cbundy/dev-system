-- 0020: the memory pressure of each worker (cbundy/dev-system#1124).
--
-- Run by factory-db-bootstrap in one transaction, as the database's NAME_owner role. The grants
-- for NAME_writer and NAME_reader come from the bootstrap (a re-apply on every run), so this file
-- has none.
--
-- Builds on 0003 and 0019 (every earlier column keeps its name, type and order). Adds five
-- nullable columns to factory.workers (the latest reading) and factory.worker_samples (one per
-- running beat): the cgroup's memory.events "max" count and its rate per minute since the previous
-- beat, the "oom_kill" count, and the avg10 of memory.pressure "some" and "full". Like 0003, w.* is
-- expanded when a view is created, so workers_status is made again to show them.

ALTER TABLE factory.workers
  ADD COLUMN mem_max_events bigint,
  ADD COLUMN mem_max_rate_per_min real,
  ADD COLUMN mem_oom_kills bigint,
  ADD COLUMN mem_psi_some_avg10 real,
  ADD COLUMN mem_psi_full_avg10 real;

ALTER TABLE factory.worker_samples
  ADD COLUMN mem_max_events bigint,
  ADD COLUMN mem_max_rate_per_min real,
  ADD COLUMN mem_oom_kills bigint,
  ADD COLUMN mem_psi_some_avg10 real,
  ADD COLUMN mem_psi_full_avg10 real;

DROP VIEW factory.workers_status;
CREATE VIEW factory.workers_status AS
  SELECT w.*, now() - w.last_seen AS age,
    (now() - w.last_seen) > make_interval(secs => 3 * coalesce(w.interval_s, 60)) AS stale
  FROM factory.workers w;
