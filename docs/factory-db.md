# Standing up the factory database

The factory database is a PostgreSQL database that holds the factory event store and the worker
heartbeats. This page takes a fresh server to a healthy `dev-doctor`. The event push loop and the
heartbeat write to it, and `dev-query --factory` reads it with the reader role; the other push
loops still use the agentsview database. The worker table, `factory.workers`, has a nullable `config`
column (jsonb) for the settings snapshot of the worker's loop; nothing writes it yet (migration 0014).

You need PostgreSQL 17 or later, the `psql` client, and the base image (it ships
`factory-db-bootstrap` and the migrations).

## 1. Provision the server

Either variant works; pick one.

- **Docker host.** Run a `postgres:17` container with a volume for `/var/lib/postgresql/data`, a
  strong `POSTGRES_PASSWORD`, and its port published only where your workspaces can reach it.
- **Managed service.** Create a PostgreSQL 17 or later instance (any provider) and note its host,
  port and admin credentials.

A host that is not local must use TLS: put `sslmode=require` (or `verify-full` with a root
certificate) in every URL below. A local socket or loopback host does not need it.

## 2. Create an admin role

The bootstrap needs a role with `CREATEDB` and `CREATEROLE` (a superuser also works). A managed
service's default admin user usually has both. On your own server:

```sql
CREATE ROLE factory_admin LOGIN CREATEDB CREATEROLE PASSWORD '<admin password>';
```

The admin URL is only for this procedure. **It never goes into a workspace**: no secret file, no
environment variable, no image.

## 3. Run the bootstrap

Choose a database name (`^[a-z][a-z0-9_]{0,47}$`; there is no default). One command creates the
roles, the database and the schema, generates each login role's password and writes each role's
URL file into the secrets directories. Run it from any container with the base image and a route
to the server, as root (the files go to the host, owned by UID 1000):

```sh
export FACTORY_DB_ADMIN_URL='postgresql://factory_admin:<admin password>@db.example.com:5432/postgres?sslmode=require'
docker run --rm --user root --entrypoint factory-db-bootstrap -e FACTORY_DB_ADMIN_URL \
  -v /etc/dev-system:/etc/dev-system ghcr.io/cbundy/dev-system/base:2 \
  --db factory --secrets-dir /etc/dev-system/secrets --migrator-dir /etc/dev-system/migrator
```

It creates `factory_owner` (no login), `factory_writer`, `factory_reader` and `factory_migrator`,
the database, the `factory` schema and the tables, then prints one summary line naming the roles it
created, the new passwords and the files it wrote. Running it again changes nothing and rewrites no
file. Notes:

- The admin URL's host must be the one the workspaces reach (it is copied into every role URL).
  When the server is a container on a Docker network, add `--network <that network>`.
- The admin URL never goes into a workspace. `--admin-url-file PATH` reads it from a file instead
  of `FACTORY_DB_ADMIN_URL`.
- The files are `factory-db-writer-url` and `factory-db-reader-url` in `--secrets-dir`, and
  `factory-db-migrator-url` in `--migrator-dir`, each mode 0600 and owned by
  `FACTORY_DB_SECRET_OWNER` (default `1000:1000`). A missing directory is created (mode 0700). Put
  the migrator file where only the host that upgrades the schema reads it, never in the
  workspaces' secrets directory.
- A role whose file is missing gets a new password and a new file, so deleting a file rotates that
  role. A role with no password (superuser admin only), or created by the run, does too. Set
  `FACTORY_DB_WRITER_PASSWORD`, `FACTORY_DB_READER_PASSWORD` or `FACTORY_DB_MIGRATOR_PASSWORD` to
  choose a password yourself; it wins and its file is rewritten.
- A database of that name that already exists, such as a server's default `POSTGRES_DB` database,
  is taken over: its owner becomes `factory_owner`. For that the admin must be a superuser or the
  database's current owner. Roles that already exist are adopted: attributes that differ are
  corrected, and the migrator's other memberships are revoked.
- The roles are named after the database, so several databases share one server.

## Adopt an existing server (one time)

On a server that already has the factory database, run the bootstrap once **without
`--secrets-dir`**. Without a secrets directory no writer or reader password is generated and
`factory-db-writer-url` / `factory-db-reader-url` are not touched, so the workspaces keep working.

For the shared production database:

```sh
export FACTORY_DB_ADMIN_URL='postgresql://factory_admin:<admin password>@db.example.com:5432/postgres?sslmode=require'
docker run --rm --user root --entrypoint factory-db-bootstrap -e FACTORY_DB_ADMIN_URL \
  -v /etc/dev-system:/etc/dev-system ghcr.io/cbundy/dev-system/base:2 \
  --db factory --migrator-dir /etc/dev-system/migrator
```

(`--admin-url-file PATH` reads the admin URL from a file instead.) On an existing server it adopts
the roles, creates `factory_migrator`, writes only `factory-db-migrator-url` into the migrator
directory, leaves the writer and reader URL files and their passwords alone, and applies any
pending migrations. This is the last time the admin URL is needed: from then on the loop migrates
with the migrator URL.

For a workspace on its own database (for example the dev server's `factory_testbed`), point
`--migrator-dir` at that workspace's folder, so its `factory-db-migrator-url` wins over the template
mount (the `factory-db-migrate` lookup below) and that loop migrates its own database:

```sh
docker run --rm --user root --entrypoint factory-db-bootstrap -e FACTORY_DB_ADMIN_URL \
  -v /etc/dev-system:/etc/dev-system ghcr.io/cbundy/dev-system/base:2 \
  --db factory_testbed \
  --migrator-dir /etc/dev-system/workspace-secrets/callum-bundy/dev-system-testbed-loop
```

Never pass the shared secrets directory (`--secrets-dir /etc/dev-system/secrets`) together with
another database's name: the bootstrap would write that database's writer and reader URLs over the
production files.

Check it after the next release:

1. The foreman pushes the loop template (`coder/push.sh` keeps `migrator_secrets_dir` only for
   `orchestrator-loop`).
2. Each loop restart writes one `loop_entry` with task `task:migrate:<to_version>`, carrying
   `from_version` / `to_version` and the outcome `migrated` (first loop) or `current` (second loop).
   Query it with "Startup schema migrates" in [docs/metrics.md](metrics.md).
3. `dev-doctor` shows both factory database lines OK.

## 4. The secrets

Each role has its own secret, separate from the agentsview secret (`agentsview-pg-url`):

| Secret file | Environment variable (wins over the file) | Holds |
|---|---|---|
| `factory-db-writer-url` | `FACTORY_DB_WRITER_URL` | the writer URL |
| `factory-db-reader-url` | `FACTORY_DB_READER_URL` | the reader URL |
| `factory-db-migrator-url` (migrator directory, or the workspace folder) | `FACTORY_DB_MIGRATOR_URL` (for `factory-db-bootstrap --migrate` only) | the migrator URL, for `--migrate` and for `factory-db-migrate` |

The secrets directory is `DEV_SECRETS_DIR`, `/run/secrets/dev-system` in the image. On Docker it is
the `dev-system-secrets` volume; on
Coder it is the host's `secrets_dir` (default `/etc/dev-system/secrets`), mounted read-only into
every workspace. The command above writes the files there once and every workspace has them.

A workspace never falls back to `agentsview-pg-url` for these.

### A workspace on another database

A workspace can use its own factory database (for example the dev server's `factory_testbed`)
while the others keep the shared one. On Coder, with `workspace_secrets_dir` set, put the
same two file names in that workspace's folder on the host,
`<workspace_secrets_dir>/<lower(owner)>/<lower(workspace)>/` (owned 1000:1000, mode 0600). Every
workspace mounts its own folder read-only at `/run/secrets/dev-system-workspace`
(`DEV_WORKSPACE_SECRETS_DIR`). The lookup, per role, is:

1. `FACTORY_DB_WRITER_URL` / `FACTORY_DB_READER_URL` in the environment;
2. `factory-db-<role>-url` in the workspace folder;
3. the same file in the shared folder.

A workspace file that exists wins even when it is empty or unreadable: `dev-doctor` then fails
naming that file, and the workspace never falls back to the shared database unseen. A missing
folder is empty and changes nothing. Check it with `dev-doctor`, which names the file the URL
came from.

## 5. Check

Restart the workspace or run `dev-doctor`. Expect, for each role:

```
dev-doctor: OK   factory database (writer): database factory as factory_writer, schema version N (URL from /run/secrets/dev-system/factory-db-writer-url)
dev-doctor: OK   factory database (reader): database factory as factory_reader, schema version N (URL from /run/secrets/dev-system/factory-db-reader-url)
```

It never prints a URL or password. Each failure names its fix:

| `dev-doctor` says | Meaning |
|---|---|
| WARN not configured | no file and no variable; nothing uses the database yet, so it does not fail |
| FAIL file is empty or not readable | fix the owner and mode (UID 1000, 0600) |
| FAIL cannot connect | wrong URL or password, server down, or `sslmode=require` missing for a non-local host |
| FAIL connected as role X, expected `_writer` / `_reader` | the wrong URL is in the slot (an admin URL, or the reader in the writer slot), or the role can create in schema `factory` |
| FAIL no `factory.schema_migrations` | the bootstrap has not run on that database |
| FAIL behind the image | the loop migrates at its next start; or run `factory-db-migrate --strict` / `factory-db-bootstrap --db <name> --migrate` with the migrator URL (no admin URL) |
| FAIL ahead of the image | the database is newer than this image: pull a newer image |

## Rotate a password

Delete the role's file (`factory-db-writer-url` or `factory-db-reader-url` in the secrets
directory, `factory-db-migrator-url` in the migrator directory) and run the command in step 3
again: the role gets a new password and the file is rewritten. Or set the role's
`FACTORY_DB_<WRITER|READER|MIGRATOR>_PASSWORD` to choose one. Restart the workspaces afterwards.

## Upgrade the schema

A newer base image can ship new migrations. The loop applies them itself at its next start (see
[Automatic migrate at start-up](#automatic-migrate-at-start-up)); `dev-doctor` fails with "behind"
until then. To apply them by hand, the migrator URL is enough, no admin URL needed:

```sh
docker run --rm --user root --entrypoint factory-db-bootstrap \
  -v /etc/dev-system/migrator:/etc/dev-system/migrator:ro ghcr.io/cbundy/dev-system/base:2 \
  --db factory --migrate --migrator-url-file /etc/dev-system/migrator/factory-db-migrator-url
```

`--migrate` connects as `factory_migrator` only (it refuses any other role, the admin URL
included), applies only the migrations not yet recorded and prints the schema version before and
after.

Then run `dev-doctor` and expect the factory database line OK for both roles.

### Automatic migrate at start-up

`dev-init` runs `factory-db-migrate` after the repo sync and before the factory event push and the
loop (cbundy/dev-system#888). It uses the migrator secret `factory-db-migrator-url`, looked up in
two places, and the workspace folder wins:

1. `${DEV_WORKSPACE_SECRETS_DIR:-/run/secrets/dev-system-workspace}/factory-db-migrator-url`
   (the workspace's own folder);
2. `${DEV_MIGRATOR_SECRETS_DIR:-/run/secrets/dev-system-migrator}/factory-db-migrator-url`
   (the template's `migrator_secrets_dir`, mounted read-only; see
   [coder/dev-system/README.md](../coder/dev-system/README.md)).

With neither file the command does nothing, so a workspace without the migrator behaves as before.
With one, it takes the database name from the writer URL (its `dbname` parameter, else its path)
and runs `factory-db-bootstrap --db NAME --migrate` once, bounded by
`DEV_FACTORY_DB_MIGRATE_TIMEOUT` (120 s). The outcome (`migrated`, `current`, `failed` or
`timed-out`) goes to `DEV_FACTORY_DB_MIGRATE_STATUS` (`/tmp/dev-factory-db-migrate.json`) and to
one `loop_entry` event. The factory loop reads the status file: while it says `failed`,
`timed-out` or a migrate still `running`, the loop stays in observe and tells the owner once
(`TELL schema-behind`). Run `factory-db-migrate --strict` by hand to retry (it exits 1 on a
failure); when it succeeds the next pass acts with no other step.

## Schema compatibility

The schema at any release works for the writers and readers of the last 10 minor releases, so a
workspace on an older image keeps working against a database a newer image has upgraded. Migrations are
therefore expand-only.

Allowed: new tables, new nullable or defaulted columns, new view columns (`CREATE OR REPLACE VIEW`, or a
`DROP VIEW` that the same file re-creates with `CREATE VIEW`), new indexes, new functions and triggers,
and `DROP NOT NULL`.

Forbidden, and refused by `npm run lint` (`scripts/migration-lint.js`, which prints `<file>:<line>` for each hit):

- any `DROP`, except `ALTER COLUMN ... DROP NOT NULL` and a `DROP VIEW` re-created in the same file;
- any `RENAME`;
- a column type change (`ALTER COLUMN ... TYPE`);
- `ADD COLUMN ... NOT NULL` with no `DEFAULT`, and `ALTER COLUMN ... SET NOT NULL`;
- a narrowed check: `ADD CHECK`, `UNIQUE`, `PRIMARY KEY`, `FOREIGN KEY` or `EXCLUDE` on an existing table,
  `ALTER DOMAIN ... ADD CONSTRAINT`, and `CREATE UNIQUE INDEX` on a table not created in the same file;
- any `REVOKE`.

An applied migration is immutable: the bootstrap refuses a file whose sha256 changed. Removing dead
fields is out of scope here; the epic that introduced this window owns it.

The window is proved by `tests/schema-compat.test.js` (in `npm test`, which needs the release tags: CI checks
out with `fetch-depth: 0`). For the newest patch of each of the last 10 minors it takes the tag's files
from git, builds one database with the tag's own bootstrap and one with head's, writes the same events and
a heartbeat through the tag's own `callum-flow-event`, `factory-event-push-loop` and `heartbeat-loop`, and
runs the tag's reads on both (the sql blocks of its `docs/metrics.md`, the loop's `*SQL` exports and
`callum-flow-factory-state`) as the reader role. Head must answer as the tag's own schema does. A failure
prints `<tag> <reader or writer>: <what differed or the psql error>`, for example
`v0.60.0 docs/metrics.md "Wind-down #2": head schema: ERROR: column "issue" does not exist`.
