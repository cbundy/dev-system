-- 0001: the factory event store and the worker heartbeat table.
--
-- Run by factory-db-bootstrap in one transaction, as the database's NAME_owner role, which
-- owns everything created here. The grants for NAME_writer and NAME_reader come from the
-- bootstrap (default privileges plus a re-apply on every run), so this file has none.
--
-- event_store: the envelope fields (docs/factory-events/schemas/envelope.v1.json) as columns,
-- device_seq (the line number in the device's local log) and the payload as data. event_id is
-- the primary key, so a re-push never makes a second row.
-- event_log: the view readers use. Every event_store column but data, plus one column for each
-- payload field marked "x-column": true in docs/factory-events/schemas/*.v1.json, read from
-- data by name. A schema that lifts a new field ships a migration that replaces this view
-- (tests/factory-db-schema.test.js fails until it does). No @> and no DISTINCT ON
-- (cbundy/dev-system#644).

CREATE TABLE factory.event_store (
  envelope int NOT NULL,
  event_id uuid PRIMARY KEY,
  ts timestamptz NOT NULL,
  type text NOT NULL,
  type_version int NOT NULL,
  repo text NOT NULL,
  device text NOT NULL,
  actor text NOT NULL,
  session_id text,
  issue int,
  base_image text,
  dev_image text,
  template_version text,
  plugin_version text,
  device_seq bigint NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX event_store_repo_issue_ts ON factory.event_store (repo, issue, ts);
CREATE INDEX event_store_repo_type_ts ON factory.event_store (repo, type, ts);

CREATE VIEW factory.event_log AS
SELECT
  e.envelope, e.event_id, e.ts, e.type, e.type_version, e.repo, e.device, e.actor, e.session_id,
  e.issue, e.base_image, e.dev_image, e.template_version, e.plugin_version, e.device_seq,
  e.data ->> 'answer_path' AS answer_path,
  (e.data ->> 'attempt')::int AS attempt,
  e.data ->> 'branch' AS branch,
  e.data ->> 'cause' AS cause,
  e.data ->> 'fact' AS fact,
  e.data ->> 'from_state' AS from_state,
  e.data ->> 'head' AS head,
  e.data ->> 'life' AS life,
  e.data ->> 'outcome' AS outcome,
  (e.data ->> 'pr')::int AS pr,
  e.data ->> 'reason' AS reason,
  (e.data ->> 'round')::int AS round,
  (e.data ->> 'seq')::int AS seq,
  (e.data ->> 'seq_at')::timestamptz AS seq_at,
  (e.data ->> 'state_since')::timestamptz AS state_since,
  e.data ->> 'step' AS step,
  e.data ->> 'table_row' AS table_row,
  e.data ->> 'to_state' AS to_state,
  e.data ->> 'verdict' AS verdict,
  e.data ->> 'via' AS via,
  e.data ->> 'who' AS who,
  e.data ->> 'why' AS why
FROM factory.event_store e;

CREATE FUNCTION factory.event_store_notify() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM pg_notify('factory_events', json_build_object('event_id', NEW.event_id,
    'device', NEW.device, 'repo', NEW.repo, 'issue', NEW.issue, 'type', NEW.type)::text);
  RETURN NULL;
END
$body$;
CREATE TRIGGER event_store_notify AFTER INSERT ON factory.event_store
  FOR EACH ROW EXECUTE FUNCTION factory.event_store_notify();

CREATE TABLE factory.workers (
  device text PRIMARY KEY,
  repo text,
  role text,
  ring text,
  runtime text,
  coder_workspace text,
  base_image text,
  dev_image text,
  template_version text,
  plugin_version text,
  versions jsonb,
  state text,
  in_flight jsonb NOT NULL DEFAULT '[]'::jsonb,
  chat_active_at timestamptz,
  sessions jsonb NOT NULL DEFAULT '[]'::jsonb,
  critical_failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  push jsonb,
  interval_s int,
  started_at timestamptz,
  last_seen timestamptz
);

CREATE VIEW factory.workers_status AS
  SELECT w.*, now() - w.last_seen AS age,
    (now() - w.last_seen) > make_interval(secs => 3 * coalesce(w.interval_s, 60)) AS stale
  FROM factory.workers w;

CREATE FUNCTION factory.workers_notify() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM pg_notify('factory_workers', NEW.device);
  RETURN NULL;
END
$body$;
CREATE TRIGGER workers_notify AFTER INSERT OR UPDATE ON factory.workers
  FOR EACH ROW EXECUTE FUNCTION factory.workers_notify();
