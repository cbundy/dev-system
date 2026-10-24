// The public panel role against a real PostgreSQL (cbundy/dev-system#1264): NAME_panel reads the
// factory_public views for the repos on factory.public_repos and can do nothing else. Every check
// logs in as the panel with its password, never SET ROLE: a role's settings (read-only, timeouts)
// apply at login only. Each test makes its own database (tests/lib/factory-db.js). The bootstrap's
// own flags are also covered here, because the panel is the reason they exist.
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { available, createDb } = require("./lib/factory-db.js");

const ROOT = path.join(__dirname, "..");
const BOOTSTRAP = path.join(ROOT, "images", "base", "factory-db-bootstrap");
const MIGRATIONS = path.join(ROOT, "images", "base", "factory-db", "migrations");
const VIEWS = ["event_store", "event_log", "workers", "workers_status", "worker_samples"];
const VOST = "cbundy/Vost";

const opts = { skip: available() ? false : "no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL)" };
const adminUrl = () => process.env.FACTORY_TEST_PG_ADMIN_URL || "";
const pw = () => crypto.randomBytes(8).toString("hex");

// A psql session that must not fail (as the admin).
function psql(url, sql) {
  const r = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", url, "-f", "-"], { input: sql, encoding: "utf8", env: cleanEnv() });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
// A session whose outcome is the test: { ok, out, err }.
function attempt(url, sql) {
  const r = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", url, "-f", "-"], { input: sql, encoding: "utf8", env: cleanEnv() });
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}
function cleanEnv() {
  const env = { ...process.env, PGCONNECT_TIMEOUT: "10" };
  delete env.PGOPTIONS;
  return env;
}
const refused = (r, what, re = /permission denied|must be|read-only|not allowed/) => {
  assert.equal(r.ok, false, `${what} was allowed: ${r.out}`);
  assert.match(r.err, re, `${what}: unexpected error ${r.err}`);
};

// A panel database: the bootstrap's own, with the panel's password known.
function panelDb(t, extra = {}) {
  const panelPassword = pw();
  const db = createDb(t, { panelPassword, ...extra });
  return { ...db, panelPassword, as: (sql) => attempt(db.panelUrl, sql), owner: (sql) => db.query(`SET ROLE "${db.name}_owner"; ${sql}`) };
}

// boot(db, args, env?): the real bootstrap again on db.
function boot(db, args, env = {}) {
  return spawnSync("bash", [BOOTSTRAP, "--db", db.name, ...args], {
    encoding: "utf8",
    env: { ...process.env, FACTORY_DB_ADMIN_URL: adminUrl(), FACTORY_DB_PANEL_PASSWORD: db.panelPassword, ...env },
  });
}
const bootOk = (db, args, env) => {
  const r = boot(db, args, env);
  assert.equal(r.status, 0, `bootstrap failed: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
};

// Rows for two repos, a look-alike repo (case differs) and the same for workers and samples.
function seed(db) {
  db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data) VALUES
      (1, gen_random_uuid(), now(), 'transition', 1, '${VOST}', 'd1', 'a', 7, 1, '{"k":"vost"}'),
      (1, gen_random_uuid(), now(), 'transition', 1, 'other/x', 'd2', 'a', 0, 2, '{"k":"other"}'),
      (1, gen_random_uuid(), now(), 'transition', 1, 'cbundy/vost', 'd3', 'a', 0, 3, '{"k":"lower"}');
    INSERT INTO factory.workers (device, repo, interval_s, last_seen) VALUES
      ('d1', '${VOST}', 60, now()), ('other-dev', 'other/x', 0, now()), ('vost-dev', 'cbundy/vost', 0, now());
    INSERT INTO factory.worker_samples (device, sampled_at, procs) VALUES
      ('d1', now(), 5), ('other-dev', now(), 0), ('vost-dev', now(), 0)`);
}
const counts = (db) => Object.fromEntries(VIEWS.map((v) => [v, Number(db.as(`SELECT count(*) FROM factory_public.${v}`).out)]));
const ALL = (n) => Object.fromEntries(VIEWS.map((v) => [v, n]));

// Everything the panel's boundary is made of, as text: ACLs, role attributes, memberships, settings.
function snapshot(db) {
  return db.query(`SELECT string_agg(x, E'\\n' ORDER BY x) FROM (
      SELECT n.nspname || '.' || c.relname || ' ' || coalesce(c.relacl::text, '') AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('factory', 'factory_public', 'public') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      UNION ALL SELECT 'schema ' || nspname || ' ' || coalesce(nspacl::text, '') FROM pg_namespace WHERE nspname IN ('factory', 'factory_public', 'public')
      UNION ALL SELECT 'database ' || coalesce(datacl::text, '') FROM pg_database WHERE datname = current_database()
      UNION ALL SELECT 'role ' || concat_ws(' ', rolcanlogin, rolsuper, rolinherit, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit) FROM pg_roles WHERE rolname = '${db.name}_panel'
      UNION ALL SELECT 'member ' || pg_get_userbyid(roleid) FROM pg_auth_members WHERE member = '${db.name}_panel'::regrole
      UNION ALL SELECT 'setting ' || s FROM pg_db_role_setting d, unnest(d.setconfig) s WHERE d.setrole = '${db.name}_panel'::regrole
    ) t`);
}

test("the panel sees only the allowlisted repo, exactly spelled, in every view", opts, (t) => {
  const db = panelDb(t);
  seed(db);
  assert.deepEqual(counts(db), ALL(0), "an empty allowlist shows nothing");
  assert.match(bootOk(db, ["--public-repo", "add", VOST]), /public repos: \+cbundy\/Vost\)/);
  assert.deepEqual(counts(db), ALL(1));
  assert.equal(db.as("SELECT string_agg(DISTINCT repo, ',') FROM factory_public.event_log").out, VOST);
  assert.equal(db.as("SELECT string_agg(DISTINCT repo, ',') FROM factory_public.event_store").out, VOST);
  assert.equal(db.as("SELECT data ->> 'k' FROM factory_public.event_store").out, "vost", "data is shown");
  assert.equal(db.as("SELECT string_agg(device, ',') FROM factory_public.workers_status").out, "d1");
  assert.equal(db.as("SELECT stale FROM factory_public.workers_status").out, "f");
  assert.equal(db.as("SELECT string_agg(device, ',') FROM factory_public.worker_samples").out, "d1", "samples go through their device's repo");
  assert.match(bootOk(db, ["--public-repo", "remove", VOST]), /public repos: -cbundy\/Vost\)/);
  assert.deepEqual(counts(db), ALL(0));
  bootOk(db, ["--public-repo", "add", VOST]);
  assert.deepEqual(counts(db), ALL(1));
  // A repo spelled with other case matches nothing: the allowlist is case-sensitive.
  bootOk(db, ["--public-repo", "remove", VOST, "--public-repo", "add", "cbundy/vost"]);
  assert.equal(db.as("SELECT string_agg(device, ',') FROM factory_public.workers").out, "vost-dev");
  assert.equal(db.as("SELECT count(*) FROM factory_public.event_store WHERE repo = 'cbundy/Vost'").out, "0");
});

test("the panel can read no base relation, write nothing, and sees no relation the views list leaves out", opts, (t) => {
  const db = panelDb(t);
  seed(db);
  bootOk(db, ["--public-repo", "add", VOST]);
  const rels = db.query("SELECT n.nspname || '.' || c.relname || ' ' || c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('factory', 'public') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') ORDER BY 1").split("\n");
  assert.ok(rels.length >= 7 && rels.includes("factory.public_repos r") && rels.includes("factory.event_log v"), `the enumeration saw ${rels.length} relations`);
  for (const rel of rels) {
    const [name, kind] = rel.split(" ");
    refused(db.as(kind === "S" ? `SELECT nextval('${name}')` : `SELECT * FROM ${name}`), `SELECT on ${name}`);
    refused(db.as(`SELECT count(*) FROM ${name}`), `SELECT count on ${name}`);
  }
  for (const rel of [...VIEWS.map((v) => `factory_public.${v}`), "factory.public_repos", "factory.event_store"]) {
    const [schema, table] = rel.split(".");
    const col = db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position LIMIT 1`);
    for (const stmt of [`INSERT INTO ${rel} SELECT * FROM ${rel}`, `UPDATE ${rel} SET ${col} = ${col}`, `DELETE FROM ${rel}`, `TRUNCATE ${rel}`]) {
      refused(db.as(stmt), stmt, /permission denied|must be|read-only|not allowed|not updatable|cannot (insert|update|delete)/);
    }
  }
  // The listed views are all the panel has: a relation the owner adds beside them stays hidden.
  db.owner("CREATE TABLE factory_public.extra (a int); INSERT INTO factory_public.extra VALUES (1); CREATE VIEW factory_public.extra_v AS SELECT repo FROM factory.event_store; CREATE TABLE factory.later (a int)");
  for (const rel of ["factory_public.extra", "factory_public.extra_v", "factory.later"]) refused(db.as(`SELECT * FROM ${rel}`), `SELECT on ${rel}`);
  assert.equal(db.as("SELECT count(*) FROM factory_public.event_store").out, "1");
});

test("a function the panel runs cannot see a row the allowlist drops, and a view without security_barrier shows the leak", opts, (t) => {
  const db = panelDb(t);
  seed(db);
  bootOk(db, ["--public-repo", "add", VOST]);
  // leak() is cheap and not leakproof: it raises on any value outside the allowlisted repo and device.
  db.owner(`CREATE FUNCTION factory_public.leak(v text) RETURNS boolean LANGUAGE plpgsql COST 0.0000001 AS $$
      BEGIN IF v NOT IN ('${VOST}', 'd1') THEN RAISE EXCEPTION 'leaked %', v; END IF; RETURN true; END $$;
    GRANT EXECUTE ON FUNCTION factory_public.leak(text) TO "${db.name}_panel"`);
  const probes = {
    event_store: ["repo", "issue"], event_log: ["repo", "issue"], workers: ["repo", "interval_s"],
    workers_status: ["repo", "interval_s"], worker_samples: ["device", "procs"],
  };
  const queries = (view) => {
    const [text, num] = probes[view];
    return [`SELECT count(*) FROM factory_public.${view} WHERE factory_public.leak(${text})`, `SELECT count(*) FROM factory_public.${view} WHERE 1 / ${num} >= 0`];
  };
  for (const view of VIEWS) {
    for (const q of queries(view)) {
      const r = db.as(q);
      assert.ok(r.ok, `${q} leaked: ${r.err}`);
      assert.equal(r.out, "1");
    }
    // The control: the same view without the barrier raises, so the check above can fail.
    db.owner(`CREATE VIEW factory_public.nb_${view} AS ${db.query(`SELECT pg_get_viewdef('factory_public.${view}'::regclass)`)}; GRANT SELECT ON factory_public.nb_${view} TO "${db.name}_panel"`);
    for (const q of queries(view)) {
      const r = db.as(q.replace(`factory_public.${view}`, `factory_public.nb_${view}`));
      assert.equal(r.ok, false, `${view} without security_barrier did not leak for: ${q}`);
      assert.match(r.err, /leaked|division by zero/);
    }
  }
});

test("the panel cannot create, escalate, write, read files or run programs", opts, (t) => {
  const db = panelDb(t);
  seed(db);
  bootOk(db, ["--public-repo", "add", VOST]);
  assert.equal(db.as("SELECT 1").out, "1", "the panel logs in");
  for (const schema of ["factory_public", "factory", "public"]) {
    refused(db.as(`CREATE TABLE ${schema}.p_t (a int)`), `CREATE TABLE in ${schema}`);
    refused(db.as(`CREATE FUNCTION ${schema}.p_f() RETURNS int LANGUAGE sql AS 'SELECT 1'`), `CREATE FUNCTION in ${schema}`);
  }
  refused(db.as("CREATE TEMP TABLE p_tmp (a int)"), "CREATE TEMP TABLE");
  refused(db.as("CREATE SCHEMA p_s"), "CREATE SCHEMA");
  for (const role of ["owner", "writer", "reader"]) refused(db.as(`SET ROLE "${db.name}_${role}"`), `SET ROLE ${role}`);
  refused(db.as("SET default_transaction_read_only = off; INSERT INTO factory.public_repos (repo) VALUES ('a/b')"), "an insert after read-only off");
  refused(db.as("SET default_transaction_read_only = off; INSERT INTO factory_public.event_log (repo) VALUES ('a/b')"), "an insert into a view after read-only off");
  refused(db.as("COPY (SELECT 1) TO PROGRAM 'true'"), "COPY TO PROGRAM");
  refused(db.as("COPY (SELECT 1) TO '/tmp/factory-panel-test'"), "COPY TO a file");
  refused(db.as("SELECT pg_read_file('/etc/hostname')"), "pg_read_file");
  refused(db.as("SELECT lo_import('/etc/hostname')"), "lo_import");
  refused(db.as("SET default_transaction_read_only = off; CREATE EXTENSION dblink"), "CREATE EXTENSION", /permission denied|must be|not available/);
  refused(db.as("ALTER ROLE CURRENT_USER SUPERUSER"), "ALTER ROLE SUPERUSER");
});

test("the panel is read-only, times out, and is limited to 10 sessions", opts, async (t) => {
  const db = panelDb(t);
  assert.equal(db.as("SHOW transaction_read_only").out, "on");
  assert.equal(db.as("SHOW statement_timeout").out, "5s");
  assert.equal(db.as("SHOW search_path").out, "factory_public");
  const slow = db.as("SELECT pg_sleep(10)");
  assert.equal(slow.ok, false);
  assert.match(slow.err, /statement timeout/);
  assert.equal(db.query(`SELECT rolconnlimit FROM pg_roles WHERE rolname = '${db.name}_panel'`), "10");
  const sessions = [];
  const done = [];
  for (let i = 0; i < 10; i++) {
    const p = spawn("psql", ["-X", "-q", "-At", db.panelUrl, "-c", "SELECT pg_sleep(4)"], { env: cleanEnv(), stdio: "ignore" });
    done.push(new Promise((resolve) => p.on("close", resolve)));
    sessions.push(p);
  }
  try {
    const deadline = Date.now() + 15000;
    const active = () => Number(db.query(`SELECT count(*) FROM pg_stat_activity WHERE usename = '${db.name}_panel' AND state = 'active'`));
    while (active() < 10 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(active(), 10, "ten panel sessions are open");
    const eleventh = db.as("SELECT 1");
    assert.equal(eleventh.ok, false);
    assert.match(eleventh.err, /too many connections for role/);
  } finally {
    await Promise.all(done);
  }
  assert.equal(db.as("SELECT 1").out, "1", "a session is allowed again once the others end");
});

test("a column a migration adds to a base table stays hidden, and each view has every column of its source", opts, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-migrations-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(MIGRATIONS)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "9000_drift.sql"), "CREATE TABLE factory.drift_table (a int);\nALTER TABLE factory.event_store ADD COLUMN drift_col text;\n");
  const db = panelDb(t, { migrationsDir: dir });
  seed(db);
  bootOk(db, ["--public-repo", "add", VOST], { FACTORY_DB_MIGRATIONS_DIR: dir });
  refused(db.as("SELECT * FROM factory.drift_table"), "the new table");
  refused(db.as("SELECT drift_col FROM factory_public.event_store"), "the new column", /does not exist/);
  refused(db.as("SELECT * FROM factory_public.drift_table"), "the new table in factory_public", /does not exist/);
  const cols = (schema, view) => db.query(`SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${view}'`);
  assert.ok(cols("factory", "event_store").includes("drift_col:text"));
  assert.ok(!cols("factory_public", "event_store").includes("drift_col"));
  // On the real migrations: nothing missing, in order and type.
  const head = panelDb(t);
  for (const view of VIEWS) {
    const src = head.query(`SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = '${view}'`);
    const pub = head.query(`SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'factory_public' AND table_name = '${view}'`);
    assert.equal(pub, src, `factory_public.${view} must show every column of factory.${view}: a migration that adds one adds it to the view too`);
  }
});

test("factory.public_repos takes only OWNER/NAME, and the writer and reader cannot change it", opts, (t) => {
  const db = panelDb(t);
  for (const bad of ["nope", "a/b/c", " a/b", "a/b ", "/b", "a/", "-a/b", "a/b;c", "a/b\nc", ""]) {
    assert.throws(() => db.query(`INSERT INTO factory.public_repos (repo) VALUES ($r$${bad}$r$)`), /check constraint/, JSON.stringify(bad));
  }
  db.query("INSERT INTO factory.public_repos (repo) VALUES ('a-b/c_d.e'), ('A/B')");
  assert.equal(db.query("SELECT count(*) FROM factory.public_repos"), "2");
  assert.equal(db.query("SELECT count(*) FROM factory.public_repos", "writer"), "2");
  assert.equal(db.query("SELECT count(*) FROM factory.public_repos", "reader"), "2");
  for (const role of ["writer", "reader"]) {
    assert.throws(() => db.query("INSERT INTO factory.public_repos (repo) VALUES ('x/y')", role), /permission denied/);
    assert.throws(() => db.query("UPDATE factory.public_repos SET note = 'x'", role), /permission denied/);
    assert.throws(() => db.query("SELECT 1 FROM factory_public.event_log", role), /permission denied/);
  }
  // The writer still writes events.
  seed(db);
  assert.equal(db.query("SELECT count(*) FROM factory.event_store", "writer"), "3");
});

test("the bootstrap takes an allowlist change, refuses a bad name before it connects, and a plain run leaves the list", opts, (t) => {
  const db = panelDb(t);
  assert.match(bootOk(db, ["--public-repo", "add", "a/b", "--public-repo", "add", "c/d"]), /public repos: \+a\/b, \+c\/d\)/);
  assert.match(bootOk(db, ["--public-repo", "add", "a/b"]), /public repos: none\)/, "a second add changes nothing");
  assert.match(bootOk(db, []), /public repos: none\)/);
  assert.equal(db.query("SELECT string_agg(repo, ',' ORDER BY repo) FROM factory.public_repos"), "a/b,c/d", "a plain run leaves the list");
  assert.match(bootOk(db, ["--public-repo", "remove", "a/b", "--public-repo", "remove", "x/y"]), /public repos: -a\/b\)/);
  assert.match(bootOk(db, ["--public-repo", "remove", "a/b"]), /public repos: none\)/, "a second remove changes nothing");
  assert.equal(db.query("SELECT string_agg(repo, ',') FROM factory.public_repos"), "c/d");
  assert.match(bootOk(db, ["--public-repo", "remove", "c/d", "--public-repo", "add", "c/d"]), /public repos: -c\/d, \+c\/d\)/);
  // Refused before any connection: the admin URL points nowhere.
  const nowhere = { FACTORY_DB_ADMIN_URL: "postgresql://nobody@127.0.0.1:1/none" };
  for (const bad of [["add", "nope"], ["add", "a/b/c"], ["remove", "a b/c"], ["drop", "a/b"]]) {
    const r = boot(db, ["--public-repo", ...bad], nowhere);
    assert.notEqual(r.status, 0, bad.join(" "));
    assert.match(r.stderr, /--public-repo|not a repo name/, bad.join(" "));
    assert.doesNotMatch(r.stderr, /failed|connect/i, `${bad.join(" ")} reached the server`);
  }
  assert.match(boot(db, ["--public-repo", "add"], nowhere).stderr, /needs add or remove, then OWNER\/NAME/);
});

test("a run puts back every change to the panel's grants, membership, limit and settings, and a second run changes nothing", opts, (t) => {
  const db = panelDb(t);
  seed(db);
  bootOk(db, ["--public-repo", "add", VOST]);
  const before = snapshot(db);
  assert.match(before, /factory_public\.event_log .*_panel=r\//);
  assert.match(before, /setting search_path=factory_public/);
  bootOk(db, []);
  assert.equal(snapshot(db), before, "a second run changes nothing");
  const p = `"${db.name}_panel"`;
  db.query(`GRANT SELECT ON factory.event_store TO ${p}; GRANT SELECT (repo) ON factory.workers TO ${p};
    GRANT USAGE ON SCHEMA factory TO ${p}; GRANT USAGE ON SCHEMA public TO ${p}; GRANT CREATE ON SCHEMA factory_public TO ${p};
    GRANT CREATE, TEMPORARY ON DATABASE "${db.name}" TO ${p}; GRANT INSERT ON factory_public.event_log TO ${p};
    GRANT "${db.name}_writer" TO ${p}; ALTER ROLE ${p} CONNECTION LIMIT 50; ALTER ROLE ${p} INHERIT;
    ALTER ROLE ${p} RESET statement_timeout; ALTER ROLE ${p} SET search_path = factory, public; ALTER ROLE ${p} SET default_transaction_read_only = off`);
  assert.notEqual(snapshot(db), before);
  assert.equal(db.as("SELECT count(*) FROM factory.event_store").out, "3", "the tampering opened the base table");
  bootOk(db, []);
  assert.equal(snapshot(db), before, "the run put everything back");
  refused(db.as("SELECT count(*) FROM factory.event_store"), "the base table");
});

test("--panel-dir writes the panel's URL with verify-full, rotates on deletion, and stays out of the other directories", opts, (t) => {
  const db = panelDb(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panel-dir-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const [pd, sd, md] = ["panel", "secrets", "migrator"].map((d) => path.join(tmp, d));
  const own = { FACTORY_DB_SECRET_OWNER: `${process.getuid()}:${process.getgid()}`, FACTORY_DB_PANEL_PASSWORD: "" };
  delete own.FACTORY_DB_PANEL_PASSWORD;
  const noPw = { ...own, FACTORY_DB_PANEL_PASSWORD: undefined };
  const sep = adminUrl().includes("?") ? "&" : "?";
  const insecure = { ...noPw, FACTORY_DB_ADMIN_URL: `${adminUrl()}${sep}sslmode=disable&sslrootcert=/etc/root.crt` };
  const out = bootOk(db, ["--panel-dir", pd, "--secrets-dir", sd, "--migrator-dir", md], insecure);
  assert.match(out, new RegExp(`new passwords: .*${db.name}_panel.*wrote: .*${pd}/factory-db-panel-url`));
  const file = path.join(pd, "factory-db-panel-url");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const url = fs.readFileSync(file, "utf8").trim();
  assert.match(url, new RegExp(`^postgresql://${db.name}_panel:[0-9a-f]{64}@`));
  assert.match(url, /sslmode=verify-full/);
  assert.doesNotMatch(url, /sslmode=disable/);
  assert.match(url, /sslrootcert=\/etc\/root\.crt/, "the admin URL's sslrootcert is kept");
  assert.match(url, new RegExp(`/${db.name}\\?`));
  for (const d of [sd, md]) assert.equal(fs.existsSync(path.join(d, "factory-db-panel-url")), false, `${d} has the panel URL`);
  assert.ok(fs.existsSync(path.join(sd, "factory-db-writer-url")));
  // A run that changes nothing rewrites nothing.
  const first = fs.statSync(file).ino;
  assert.match(bootOk(db, ["--panel-dir", pd], noPw), /new passwords: none; wrote: none/);
  assert.equal(fs.statSync(file).ino, first);
  // Deleting the file rotates the password.
  fs.unlinkSync(file);
  bootOk(db, ["--panel-dir", pd], noPw);
  const rotated = fs.readFileSync(file, "utf8").trim();
  assert.notEqual(rotated.split(":")[2].split("@")[0], url.split(":")[2].split("@")[0]);
  // The same directory for two secrets is refused before any connection.
  const nowhere = { ...own, FACTORY_DB_ADMIN_URL: "postgresql://nobody@127.0.0.1:1/none" };
  for (const args of [["--panel-dir", sd, "--secrets-dir", sd], ["--panel-dir", md, "--migrator-dir", md], ["--panel-dir", `${sd}/`, "--secrets-dir", sd], ["--panel-dir", `${sd}/../secrets`, "--secrets-dir", sd]]) {
    const r = boot(db, args, nowhere);
    assert.notEqual(r.status, 0, args.join(" "));
    assert.match(r.stderr, /--panel-dir must not be the same directory/, args.join(" "));
  }
});

test("--migrate re-applies the panel's grants and refuses --panel-dir and --public-repo", opts, (t) => {
  const db = panelDb(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panel-migrate-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const md = path.join(tmp, "migrator");
  const own = { FACTORY_DB_SECRET_OWNER: `${process.getuid()}:${process.getgid()}` };
  bootOk(db, ["--migrator-dir", md], own);
  const before = snapshot(db);
  db.query(`GRANT SELECT ON factory.event_store TO "${db.name}_panel"; GRANT USAGE ON SCHEMA public TO "${db.name}_panel"`);
  assert.notEqual(snapshot(db), before);
  const mig = (args) => spawnSync("bash", [BOOTSTRAP, "--db", db.name, "--migrate", "--migrator-url-file", path.join(md, "factory-db-migrator-url"), ...args], { encoding: "utf8", env: { ...process.env, FACTORY_DB_ADMIN_URL: "" } });
  const r = mig([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(snapshot(db), before, "--migrate put the panel's grants back");
  for (const args of [["--panel-dir", path.join(tmp, "p")], ["--public-repo", "add", "a/b"]]) {
    const refusal = mig(args);
    assert.notEqual(refusal.status, 0);
    assert.match(refusal.stderr, /--migrate connects as .*: --(panel-dir|public-repo) is not allowed/);
  }
});

test("a role the panel database does not have yet is skipped by --migrate", opts, (t) => {
  const db = panelDb(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panel-nopanel-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const md = path.join(tmp, "migrator");
  bootOk(db, ["--migrator-dir", md], { FACTORY_DB_SECRET_OWNER: `${process.getuid()}:${process.getgid()}` });
  db.query(`DROP OWNED BY "${db.name}_panel"; DROP ROLE "${db.name}_panel"`);
  const r = spawnSync("bash", [BOOTSTRAP, "--db", db.name, "--migrate", "--migrator-url-file", path.join(md, "factory-db-migrator-url")], { encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, r.stderr);
});

test("a CREATEDB CREATEROLE admin that is no superuser creates the panel and skips temp_file_limit until it holds SET on it", opts, (t) => {
  const name = `factory_test_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
  const adm = `${name}_adm`;
  const admPw = pw();
  const url = adminUrl().replace(/^([a-z]+:\/\/)[^@/?]*@/i, `$1${adm}:${admPw}@`);
  assert.notEqual(url, adminUrl(), "the admin URL has a user to swap");
  const base = adminUrl();
  const dbUrl = `${base}${base.includes("?") ? "&" : "?"}dbname=${name}`;
  t.after(() => {
    for (const sql of [`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${adm}') THEN REVOKE SET ON PARAMETER temp_file_limit FROM "${adm}"; END IF; END $$`, ...["panel", "migrator", "owner", "writer", "reader"].map((r) => `DROP ROLE IF EXISTS "${name}_${r}"`), `DROP ROLE IF EXISTS "${adm}"`]) psql(base, sql);
  });
  psql(base, `CREATE ROLE "${adm}" LOGIN CREATEDB CREATEROLE PASSWORD '${admPw}'`);
  const run = () => spawnSync("bash", [BOOTSTRAP, "--db", name], { encoding: "utf8", env: { ...process.env, FACTORY_DB_ADMIN_URL: url, FACTORY_DB_PANEL_PASSWORD: pw() } });
  const settings = () => psql(base, `SELECT string_agg(s, ',' ORDER BY s) FROM pg_db_role_setting d, unnest(d.setconfig) s WHERE d.setrole = '${name}_panel'::regrole`);
  let r = run();
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /panel settings skipped: temp_file_limit\)/);
  assert.equal(settings(), "default_transaction_read_only=on,idle_in_transaction_session_timeout=30s,lock_timeout=1s,search_path=factory_public,statement_timeout=5s,work_mem=4MB");
  assert.equal(psql(base, `SELECT rolconnlimit || ' ' || rolinherit FROM pg_roles WHERE rolname = '${name}_panel'`), "10 false");
  psql(base, `GRANT SET ON PARAMETER temp_file_limit TO "${adm}"`);
  r = run();
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /skipped/);
  assert.match(settings(), /temp_file_limit=64MB/);
  assert.equal(psql(dbUrl, `SELECT count(*) FROM pg_class WHERE relname = 'public_repos'`), "1");
});

// The notifications the panel can LISTEN to name nothing (cbundy/dev-system#1265).
test("LISTEN as the panel carries no repo, issue, type or device", opts, async (t) => {
  const db = panelDb(t);
  const p = spawn("psql", ["-X", "-q", "-At", db.panelUrl], { env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const waiters = [];
  p.stdout.on("data", (d) => {
    out += d;
    for (const w of waiters.splice(0)) w();
  });
  p.stderr.on("data", (d) => (err += d));
  const closed = new Promise((resolve) => p.on("close", resolve));
  const seen = (word) =>
    new Promise((resolve) => {
      const check = () => (out.includes(word) ? resolve() : waiters.push(check));
      check();
    });
  try {
    p.stdin.write("LISTEN factory_events; LISTEN factory_workers; SELECT 'ready';\n");
    await seen("ready");
    const id = crypto.randomUUID();
    db.query(`INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
      VALUES (1, '${id}', now(), 'claimed', 1, 'other/secret-repo', 'secret-device', 'a', 4242, 1, '{}')`);
    db.query(`INSERT INTO factory.workers (device, repo, interval_s, last_seen) VALUES ('secret-device', 'other/secret-repo', 60, now())`);
    db.query(`UPDATE factory.workers SET last_seen = now() WHERE device = 'secret-device'`);
    p.stdin.write("SELECT 'done';\n");
    await seen("done");
    p.stdin.end();
    await closed;
    assert.equal(err.trim(), "");
    const notes = [...out.matchAll(/Asynchronous notification "([^"]+)"(?: with payload "(.*)")? received from/g)].map((m) => [m[1], m[2] ?? ""]); // psql omits the payload part when it is empty
    const events = notes.filter(([c]) => c === "factory_events");
    const workers = notes.filter(([c]) => c === "factory_workers");
    for (const secret of ["other/secret-repo", "4242", "claimed", "secret-device"]) assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0][1]), { event_id: id });
    assert.deepEqual(workers, [["factory_workers", ""], ["factory_workers", ""]]);
  } finally {
    p.kill();
  }
});

test("the panel can NOTIFY a channel, so a listener treats a payload as a hint", opts, (t) => {
  const db = panelDb(t);
  const r = db.as("NOTIFY factory_events, 'x'");
  assert.equal(r.ok, true, r.err);
});
