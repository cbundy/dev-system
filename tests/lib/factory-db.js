// Per-test factory database for node tests (cbundy/dev-system#646): the node twin of
// factory_test_db_new / factory_test_db_drop in scripts/test-pg.sh. It makes a unique
// factory_test_<pid>_<random> database with the real images/base/factory-db-bootstrap, over
// psql through child_process, and registers the drop (the database WITH (FORCE), then its three
// roles) in t.after, so a failing test still cleans up. `npm test` fails when one is left.
"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");

const BOOTSTRAP = path.join(__dirname, "..", "..", "images", "base", "factory-db-bootstrap");

const adminUrl = () => process.env.FACTORY_TEST_PG_ADMIN_URL || "";

// The admin URL pointed at a database (the dbname parameter wins over the URL's path).
function urlFor(db) {
  const url = adminUrl();
  return `${url}${url.includes("?") ? "&" : "?"}dbname=${db}`;
}

function psql(url, sql) {
  const r = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", url, "-c", sql], {
    encoding: "utf8",
    env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" },
  });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// Whether a test server is configured. Without one the database tests skip (scripts/test.sh
// notes it in its summary), unless TEST_REQUIRE_POSTGRES=1, where scripts/test.sh has failed
// the run already.
const available = () => adminUrl() !== "";

// createDb(t): { name, url, query(sql, role?) }. The drop is registered on t.
function createDb(t) {
  const name = `factory_test_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
  const drop = () => {
    for (const sql of [
      `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
      `DROP ROLE IF EXISTS "${name}_owner"`,
      `DROP ROLE IF EXISTS "${name}_writer"`,
      `DROP ROLE IF EXISTS "${name}_reader"`,
    ]) psql(adminUrl(), sql);
  };
  t.after(drop);
  const r = spawnSync("bash", [BOOTSTRAP, "--db", name], {
    encoding: "utf8",
    env: { ...process.env, FACTORY_DB_ADMIN_URL: adminUrl() },
  });
  if (r.status !== 0) throw new Error(`factory-db-bootstrap failed: ${r.stdout}${r.stderr}`);
  const url = urlFor(name);
  // query(sql, role): the rows unaligned; with a role, the statement runs as that role.
  const query = (sql, role) => psql(url, role ? `SET ROLE "${name}_${role}"; ${sql}` : sql);
  return { name, url, query };
}

module.exports = { available, createDb };
