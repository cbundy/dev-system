-- 0003: the machine stats of each worker (cbundy/dev-system#543).
--
-- Run by factory-db-bootstrap in one transaction, as the database's NAME_owner role. The grants
-- for NAME_writer and NAME_reader come from the bootstrap (a re-apply on every run), so this file
-- has none.
--
-- factory.workers gets the latest reading (heartbeat-loop updates it on each running beat) and
-- factory.worker_samples keeps one row per running beat. The columns are the same in both.
-- worker_samples_prune keeps 30 days per device. It is SECURITY DEFINER so the writer role needs
-- no DELETE grant; its search_path is pinned. To change the period, ship a new migration.

ALTER TABLE factory.workers
  ADD COLUMN cpu_pct real,
  ADD COLUMN cpu_limit_cores numeric,
  ADD COLUMN cpu_quota_set boolean,
  ADD COLUMN mem_used_bytes bigint,
  ADD COLUMN mem_limit_bytes bigint,
  ADD COLUMN claude_interactive int,
  ADD COLUMN claude_headless int,
  ADD COLUMN claude_procs int,
  ADD COLUMN procs int,
  ADD COLUMN stats_at timestamptz;

-- w.* is expanded when a view is created, so the view is made again to show the new columns.
DROP VIEW factory.workers_status;
CREATE VIEW factory.workers_status AS
  SELECT w.*, now() - w.last_seen AS age,
    (now() - w.last_seen) > make_interval(secs => 3 * coalesce(w.interval_s, 60)) AS stale
  FROM factory.workers w;

CREATE TABLE factory.worker_samples (
  device text NOT NULL,
  sampled_at timestamptz NOT NULL,
  state text,
  cpu_pct real,
  cpu_limit_cores numeric,
  cpu_quota_set boolean,
  mem_used_bytes bigint,
  mem_limit_bytes bigint,
  claude_interactive int,
  claude_headless int,
  claude_procs int,
  procs int,
  PRIMARY KEY (device, sampled_at)
);

CREATE FUNCTION factory.worker_samples_prune() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = factory, pg_temp AS $body$
BEGIN
  DELETE FROM factory.worker_samples
    WHERE device = NEW.device AND sampled_at < NEW.sampled_at - interval '30 days';
  RETURN NULL;
END
$body$;
CREATE TRIGGER worker_samples_prune AFTER INSERT ON factory.worker_samples
  FOR EACH ROW EXECUTE FUNCTION factory.worker_samples_prune();
