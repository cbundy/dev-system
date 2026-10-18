-- 0006: lift test_weakened.restored and reviewed.patch into factory.event_log.
--
-- Run by factory-db-bootstrap in one transaction, as the database's NAME_owner role. The grants
-- for NAME_writer and NAME_reader come from the bootstrap (a re-apply on every run), so this file
-- has none; CREATE OR REPLACE VIEW keeps the view's existing ones.
--
-- Adds restored (boolean) and patch, the fields marked "x-column": true in test_weakened.v1.json
-- and reviewed.v1.json, so a view export gives callum-flow-evaluate the same test_weakened and
-- review numbers as the local log. Postgres only adds columns at the end on OR REPLACE, so they
-- come last and every earlier column keeps its name, type and order. No @> and no DISTINCT ON.

CREATE OR REPLACE VIEW factory.event_log AS
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
  e.data ->> 'why' AS why,
  e.data ->> 'result' AS result,
  (e.data ->> 'wait_ms')::int AS wait_ms,
  (e.data ->> 'run_ms')::int AS run_ms,
  (e.data ->> 'concurrency')::int AS concurrency,
  (e.data ->> 'queued_behind')::int AS queued_behind,
  (e.data ->> 'started_at')::timestamptz AS started_at,
  (e.data ->> 'requested_at')::timestamptz AS requested_at,
  (e.data ->> 'stopped_at')::timestamptz AS stopped_at,
  (e.data ->> 'waited_ms')::int AS waited_ms,
  (e.data ->> 'cap_ms')::int AS cap_ms,
  (e.data ->> 'running_at_request')::int AS running_at_request,
  (e.data ->> 'cut_at_stop')::int AS cut_at_stop,
  e.data -> 'cut_at_stop_keys' AS cut_at_stop_keys,
  e.data ->> 'trigger' AS trigger,
  e.data ->> 'reader' AS reader,
  e.data ->> 'tool' AS tool,
  (e.data ->> 'compared')::int AS compared,
  (e.data ->> 'differences')::int AS differences,
  (e.data ->> 'live_differences')::int AS live_differences,
  (e.data ->> 'settle_seconds')::int AS settle_seconds,
  (e.data ->> 'old_ok')::boolean AS old_ok,
  (e.data ->> 'new_ok')::boolean AS new_ok,
  (e.data ->> 'restored')::boolean AS restored,
  e.data ->> 'patch' AS patch
FROM factory.event_store e;
