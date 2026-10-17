"use strict";
// psql through child_process for the replay tools (dev-system#650). It reuses run_psql from
// images/base/agentsview.sh, so a URL (a secret) reaches psql as PG* variables and never as an
// argument, and an ssl* parameter or the system root store work as for dev-query.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASE = path.join(__dirname, "..", "..", "images", "base");
const AGENTSVIEW_SH = path.join(BASE, "agentsview.sh");
const BOOTSTRAP = path.join(BASE, "factory-db-bootstrap");

// psql(url, sql, { readOnly }): the rows of the last statement unaligned (-At), the SQL on
// stdin, in one transaction. With readOnly, the session is default_transaction_read_only, so a
// write is refused by the server. Throws an Error carrying psql's own message.
function psql(url, sql, { readOnly = false } = {}) {
  const env = { ...process.env, FR_URL: url, FR_SH: AGENTSVIEW_SH, PGOPTIONS: "-c client_min_messages=warning" };
  if (readOnly) env.DEV_PG_FORCE_OPTIONS = "-c default_transaction_read_only=on";
  else delete env.DEV_PG_FORCE_OPTIONS;
  const r = spawnSync("bash", ["-c", '. "$FR_SH" && run_psql "$FR_URL" -At'], {
    input: sql,
    encoding: "utf8",
    env,
    maxBuffer: 1 << 30,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.trim()}`);
  return r.stdout;
}

// The old store's URL: FACTORY_REPLAY_OLD_URL, else the agentsview URL (AGENTSVIEW_PG_URL or the
// secret file), the database the old push writes to. Null when there is none.
function oldStoreUrl(env = process.env) {
  if (env.FACTORY_REPLAY_OLD_URL) return env.FACTORY_REPLAY_OLD_URL;
  if (env.AGENTSVIEW_PG_URL) return env.AGENTSVIEW_PG_URL;
  try {
    const v = fs.readFileSync(path.join(env.DEV_SECRETS_DIR || "/run/secrets/dev-system", "agentsview-pg-url"), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

// The admin connection that makes the throwaway database (a role with CREATEDB and CREATEROLE).
function adminUrl(env = process.env) {
  return env.FACTORY_DB_ADMIN_URL || env.FACTORY_TEST_PG_ADMIN_URL || null;
}

// The admin URL pointed at a database (the dbname parameter wins over the URL's path).
function urlFor(admin, db) {
  return `${admin}${admin.includes("?") ? "&" : "?"}dbname=${db}`;
}

const DB_NAME = /^[a-z][a-z0-9_]{0,47}$/;

module.exports = { psql, oldStoreUrl, adminUrl, urlFor, DB_NAME, BOOTSTRAP };
