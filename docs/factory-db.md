# Standing up the factory database

The factory database is a PostgreSQL database that holds the factory event store and the worker
heartbeats. This page takes a fresh server to a healthy `dev-doctor`. The event push loop and the
heartbeat write to it, and `dev-query --factory` reads it with the reader role; the other push
loops still use the agentsview database.

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

## 4. The secrets

Each role has its own secret, separate from the agentsview secret (`agentsview-pg-url`):

| Secret file | Environment variable (wins over the file) | Holds |
|---|---|---|
| `factory-db-writer-url` | `FACTORY_DB_WRITER_URL` | the writer URL |
| `factory-db-reader-url` | `FACTORY_DB_READER_URL` | the reader URL |
| `factory-db-migrator-url` (migrator directory only) | `FACTORY_DB_MIGRATOR_URL` | the migrator URL, for `--migrate` |

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
dev-doctor: OK   factory database (writer): database factory as factory_writer, schema version 3 (URL from /run/secrets/dev-system/factory-db-writer-url)
dev-doctor: OK   factory database (reader): database factory as factory_reader, schema version 3 (URL from /run/secrets/dev-system/factory-db-reader-url)
```

It never prints a URL or password. Each failure names its fix:

| `dev-doctor` says | Meaning |
|---|---|
| WARN not configured | no file and no variable; nothing uses the database yet, so it does not fail |
| FAIL file is empty or not readable | fix the owner and mode (UID 1000, 0600) |
| FAIL cannot connect | wrong URL or password, server down, or `sslmode=require` missing for a non-local host |
| FAIL connected as role X, expected `_writer` / `_reader` | the wrong URL is in the slot (an admin URL, or the reader in the writer slot), or the role can create in schema `factory` |
| FAIL no `factory.schema_migrations` | the bootstrap has not run on that database |
| FAIL behind the image | re-run the bootstrap with the admin URL to apply the newer migrations |
| FAIL ahead of the image | the database is newer than this image: pull a newer image |

## Rotate a password

Delete the role's file (`factory-db-writer-url` or `factory-db-reader-url` in the secrets
directory, `factory-db-migrator-url` in the migrator directory) and run the command in step 3
again: the role gets a new password and the file is rewritten. Or set the role's
`FACTORY_DB_<WRITER|READER|MIGRATOR>_PASSWORD` to choose one. Restart the workspaces afterwards.

## Upgrade the schema

A newer base image can ship new migrations. `dev-doctor` fails with "behind" until you run them.
The migrator URL is enough, no admin URL needed:

```sh
docker run --rm --user root --entrypoint factory-db-bootstrap \
  -v /etc/dev-system/migrator:/etc/dev-system/migrator:ro ghcr.io/cbundy/dev-system/base:2 \
  --db factory --migrate --migrator-url-file /etc/dev-system/migrator/factory-db-migrator-url
```

`--migrate` connects as `factory_migrator` only (it refuses any other role, the admin URL
included), applies only the migrations not yet recorded and prints the schema version before and
after. Running the full command of step 3 with the admin URL works too.

Then run `dev-doctor` and expect the factory database line OK for both roles.
