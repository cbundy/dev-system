#!/usr/bin/env node
"use strict";
// A dev-query stand-in for the replay readers (dev-system#905). A shell rule under test
// (images/base/claim-events.sh) calls `dev-query [--factory] -At -v NAME=VALUE... -c SQL`; this runs the
// SQL read-only against FER_OLD_URL, or against FER_NEW_URL with --factory, through the harness's psql.
// The -v values are put into the SQL as quoted literals where it says :'name'.

const { psql } = require("./pg.js");

const args = process.argv.slice(2);
let factory = false;
let sql = null;
const vars = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--factory") factory = true;
  else if (a === "-v") {
    const kv = args[++i] || "";
    const at = kv.indexOf("=");
    vars[kv.slice(0, at)] = kv.slice(at + 1);
  } else if (a === "-c") sql = args[++i];
  else if (a !== "-A" && a !== "-t" && a !== "-At") {
    process.stderr.write(`dev-query stand-in: unsupported argument ${a}\n`);
    process.exit(2);
  }
}
const url = factory ? process.env.FER_NEW_URL : process.env.FER_OLD_URL;
if (!url || sql === null) {
  process.stderr.write("dev-query stand-in: needs -c SQL and FER_OLD_URL / FER_NEW_URL\n");
  process.exit(2);
}
const text = sql.replace(/:'([A-Za-z_][A-Za-z0-9_]*)'/g, (m, name) => {
  if (!(name in vars)) throw new Error(`no -v ${name}`);
  return `'${vars[name].replace(/'/g, "''")}'`;
});
try {
  process.stdout.write(psql(url, text, { readOnly: true }));
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
