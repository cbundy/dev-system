-- A breaking migration for the self-test of tests/schema-compat.test.js: it is applied after head's
-- migrations (both copied into one FACTORY_DB_MIGRATIONS_DIR), so the harness must report the readers
-- that use factory.event_log's `issue` column. It is not under images/base/factory-db/migrations, so
-- scripts/migration-lint.js never sees it.
--
-- factory.event_log is renamed to event_log_full and re-created without its `issue` column. The column
-- list comes from information_schema, so the fixture never goes stale when a later migration adds one.
ALTER VIEW factory.event_log RENAME TO event_log_full;

DO $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position) INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'factory' AND table_name = 'event_log_full' AND column_name <> 'issue';
  EXECUTE format('CREATE VIEW factory.event_log AS SELECT %s FROM factory.event_log_full', cols);
END
$$;
