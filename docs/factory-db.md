# Standing up the factory database

The factory database is a PostgreSQL database that holds the factory event store and the worker
heartbeats. This page takes a fresh server to a healthy `dev-doctor`. Nothing reads or writes the
database yet (the push loops, the heartbeat and `dev-query` still use the agentsview database), so
until a reader or writer switches over, `dev-doctor` only reports on it.

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

Choose a database name (`^[a-z][a-z0-9_]{0,47}$`; there is no default) and one password for each
login role. Run, from any container with the base image and a route to the server:

```sh
export FACTORY_DB_ADMIN_URL='postgresql://factory_admin:<admin password>@db.example.com:5432/postgres?sslmode=require'
export FACTORY_DB_WRITER_PASSWORD='<writer password>'
export FACTORY_DB_READER_PASSWORD='<reader password>'
factory-db-bootstrap --db factory
```

`--admin-url-file PATH` reads the admin URL from a file instead of `FACTORY_DB_ADMIN_URL`. The
command creates `factory_owner` (no login), `factory_writer` and `factory_reader`, the database,
the `factory` schema and the tables, and prints one summary line. Running it again changes nothing.
The roles are named after the database, so several databases share one server.

## 4. Build each role's URL

```
postgresql://factory_writer:<writer password>@db.example.com:5432/factory?sslmode=require
postgresql://factory_reader:<reader password>@db.example.com:5432/factory?sslmode=require
```

Percent-encode characters in a password that a URL reserves (`@`, `:`, `/`, `?`, `#`, `%`).

## 5. Place the secrets

Each role has its own secret, separate from the agentsview secret (`agentsview-pg-url`):

| Secret file in the secrets directory | Environment variable (wins over the file) | Holds |
|---|---|---|
| `factory-db-writer-url` | `FACTORY_DB_WRITER_URL` | the writer URL |
| `factory-db-reader-url` | `FACTORY_DB_READER_URL` | the reader URL |

The secrets directory is `DEV_SECRETS_DIR`, `/run/secrets/dev-system` in the image. On Docker it is
the `dev-system-secrets` volume; on Coder it is the host's `secrets_dir` (default
`/etc/dev-system/secrets`), mounted read-only into every workspace. Put the files on the host once
and every workspace has them. Each file is owned by UID 1000, mode 0600:

```sh
cd /etc/dev-system/secrets
(umask 077 && read -rsp 'writer URL: ' url && printf '%s\n' "$url" > factory-db-writer-url)
(umask 077 && read -rsp 'reader URL: ' url && printf '%s\n' "$url" > factory-db-reader-url)
chown 1000:1000 factory-db-writer-url factory-db-reader-url
```

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

## 6. Check

Restart the workspace or run `dev-doctor`. Expect, for each role:

```
dev-doctor: OK   factory database (writer): database factory as factory_writer, schema version 1 (URL from /run/secrets/dev-system/factory-db-writer-url)
dev-doctor: OK   factory database (reader): database factory as factory_reader, schema version 1 (URL from /run/secrets/dev-system/factory-db-reader-url)
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

Run the bootstrap again with the new password in `FACTORY_DB_WRITER_PASSWORD` or
`FACTORY_DB_READER_PASSWORD` (a password that is not set is left alone), then replace the URL in the
secrets directory and restart the workspaces.

## Upgrade the schema

A newer base image can ship new migrations. `dev-doctor` fails with "behind" until you run
`factory-db-bootstrap --db <name>` with the admin URL from a container on the newer image; it applies
only the migrations not yet recorded.

Then run `dev-doctor` and expect the factory database line OK for both roles.
