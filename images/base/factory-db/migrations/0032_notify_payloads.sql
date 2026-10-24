-- 0032: notification payloads that name nothing (cbundy/dev-system#1265). PostgreSQL has no
-- privilege on LISTEN, so the panel role (0030) can listen on factory_events and factory_workers
-- like any connected role, and the payloads used to carry the repo, issue, event type and device
-- of rows the panel may not read. They now carry nothing a reader needs a secret to hold: the
-- event id (a reader looks the row up through its views) and an empty string. Only replaces the
-- two trigger functions from 0001; the triggers themselves are untouched.

CREATE OR REPLACE FUNCTION factory.event_store_notify() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM pg_notify('factory_events', json_build_object('event_id', NEW.event_id)::text);
  RETURN NULL;
END
$body$;

CREATE OR REPLACE FUNCTION factory.workers_notify() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM pg_notify('factory_workers', '');
  RETURN NULL;
END
$body$;
