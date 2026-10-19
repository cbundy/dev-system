// The schema compatibility harness (docs/factory-db.md "Schema compatibility"): the factory
// database at head must work for the writers and readers of the last 10 minor releases.
//
// A differential. For a tag, the tag's own code writes the same events and heartbeat into two
// databases: A, built by the tag's own factory-db-bootstrap and migrations, and B, built by head's.
// Then each of the tag's reads (the sql blocks of its docs/metrics.md, the SQL the loop exports, its
// callum-flow-factory-state) runs on A and on B as the reader role, and B must answer as A does.
// Everything here returns problems as strings instead of asserting, so a test can inspect them.
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const EXPORTS_SCRIPT = path.join(__dirname, "schema-compat-exports.mjs");

// What a tag is extracted from, and what the writers and readers use (the dedupe key).
const ARCHIVE_PATHS = ["images/base", "plugins/factory-loop", "docs/metrics.md", "docs/factory-events"];
const KEY_PATHS = [
  "images/base/callum-flow-event", "images/base/factory-event-write.js", "images/base/factory-event-shapes.json",
  "images/base/factory-event-push-loop", "images/base/heartbeat-loop", "images/base/factory-db.sh",
  "images/base/callum-flow-factory-state", "images/base/dev-query", "images/base/factory-db",
  "images/base/factory-db-bootstrap", "images/base/factory-source.js", "images/base/agentsview.sh",
  "images/base/workspace.sh", "docs/metrics.md", "docs/factory-events/schemas", "plugins/factory-loop/hooks",
];

const WINDOW = 10;

// The variables the SQL reads may use, with fixed values.
const REPO = "cbundy/dev-system";
const DEVICE = "box";

// ------------------------------------------------------------------------------- tag selection

const semver = (tag) => {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m === null ? null : m.slice(1).map(Number);
};

// selectTags(tags, n): the highest patch of each minor among the plain vX.Y.Z names, the newest n
// minors, newest first. Pre-releases and any other name are ignored.
function selectTags(tags, n = WINDOW) {
  const best = new Map();
  for (const tag of tags) {
    const v = semver(tag);
    if (v === null) continue;
    const key = `${v[0]}.${v[1]}`;
    const cur = best.get(key);
    if (cur === undefined || v[2] > cur.v[2]) best.set(key, { tag, v });
  }
  return [...best.values()].sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1]).slice(0, n).map((x) => x.tag);
}

// dedupeTags(tags, keyOf): tags newest first. { run, covered } where covered maps a tag whose key
// equals a newer tag's to that tag, and run holds the rest, so no input is left unrun.
function dedupeTags(tags, keyOf) {
  const seen = new Map();
  const run = [];
  const covered = new Map();
  for (const tag of tags) {
    const key = keyOf(tag);
    if (seen.has(key)) covered.set(tag, seen.get(key));
    else {
      seen.set(key, tag);
      run.push(tag);
    }
  }
  return { run, covered };
}

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  return r;
}

const isShallow = () => git(["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";

// The tag names merged into HEAD (empty when git fails).
function mergedTags() {
  const r = git(["tag", "--merged", "HEAD"]);
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

// The message of the failure TEST_REQUIRE_TAGS=1 turns a missing tag window into, or null.
function requireTagsProblem({ shallow, tags, env = process.env }) {
  if (env.TEST_REQUIRE_TAGS !== "1") return null;
  if (shallow) return "TEST_REQUIRE_TAGS=1 but the clone is shallow: check out with fetch-depth: 0 so the release tags exist";
  if (tags.length === 0) return "TEST_REQUIRE_TAGS=1 but no vX.Y.Z tag is merged into HEAD: check out with fetch-depth: 0 so the release tags exist";
  return null;
}

// The id of what a tag's writers and readers use: its git object ids for KEY_PATHS.
function tagKey(tag) {
  return KEY_PATHS.map((p) => {
    const r = git(["rev-parse", "--verify", "--quiet", `${tag}:${p}`]);
    return r.status === 0 ? `${p}=${r.stdout.trim()}` : `${p}=-`;
  }).join("\n");
}

// extractTag(tag, into): the tag's files from git only (git archive), into the empty folder `into`.
function extractTag(tag, into) {
  const paths = ARCHIVE_PATHS.filter((p) => git(["rev-parse", "--verify", "--quiet", `${tag}:${p}`]).status === 0);
  const raw = spawnSync("git", ["archive", tag, ...paths], { cwd: ROOT, maxBuffer: 1 << 29 });
  if (raw.status !== 0) throw new Error(`git archive ${tag} failed: ${String(raw.stderr)}`);
  const tar = spawnSync("tar", ["-x", "-C", into], { input: raw.stdout, maxBuffer: 1 << 24 });
  if (tar.status !== 0) throw new Error(`tar -x of ${tag} failed: ${String(tar.stderr)}`);
  return into;
}

const hasMigrations = (tagDir) => fs.existsSync(path.join(tagDir, "images", "base", "factory-db", "migrations"));

// ----------------------------------------------------------------------------------- processes

// run(cmd, args, { env, cwd, input, timeout }): { status, stdout, stderr }, without blocking the
// event loop, so the tags' subtests overlap.
function run(cmd, args, { env = process.env, cwd, input, timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: 127, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? 124 : code, stdout, stderr: timedOut ? `${stderr}\ntimed out` : stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

const cleanEnv = (extra) => {
  const env = { ...process.env };
  for (const k of ["AGENTSVIEW_PG_URL", "FACTORY_DB_WRITER_URL", "FACTORY_DB_READER_URL", "DEV_SECRETS_DIR", "DEV_WORKSPACE_SECRETS_DIR", "CALLUM_FLOW_FACTORY_STATE_SOURCE"]) delete env[k];
  return { ...env, ...extra };
};

// ---------------------------------------------------------------------------------------- share

// A share folder for a tag: every file of its images/base, with a heartbeat-state stub (the heartbeat
// test's), as DEV_SYSTEM_SHARE.
function makeShare(tagDir, scratch) {
  const share = path.join(scratch, "share");
  fs.mkdirSync(share, { recursive: true });
  const base = path.join(tagDir, "images", "base");
  for (const f of fs.readdirSync(base)) if (f !== "test") fs.symlinkSync(path.join(base, f), path.join(share, f));
  const stub = path.join(share, "heartbeat-state");
  fs.rmSync(stub, { force: true });
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '{"state":"idle","in_flight":[],"chat_active_at":null,"sessions":[]}\\n'\n`, { mode: 0o755 });
  return share;
}

// ---------------------------------------------------------------------------------------- write

// writeEvents(tagDir, scratch, label): the tag's callum-flow-event writes one event per type of its
// factory-event-shapes.json `current`, with that schema's examples[0]. { dir, lines, problems }.
async function writeEvents(tagDir, scratch, label) {
  const base = path.join(tagDir, "images", "base");
  const shapes = path.join(base, "factory-event-shapes.json");
  const schemas = path.join(tagDir, "docs", "factory-events", "schemas");
  const dir = path.join(scratch, "events-src");
  fs.mkdirSync(dir, { recursive: true });
  const versions = path.join(scratch, "versions.json");
  fs.writeFileSync(versions, JSON.stringify({ base_image: "1.2.3", dev_image: "4.5.6", template_version: "7.8.9", plugin_version: "0.1.2" }));
  const current = JSON.parse(fs.readFileSync(shapes, "utf8")).current;
  const problems = [];
  for (const type of Object.keys(current)) {
    const schema = JSON.parse(fs.readFileSync(path.join(schemas, `${type}.v${current[type]}.json`), "utf8"));
    const args = [path.join(base, "callum-flow-event"), "--type", type];
    if (schema["x-issue"] !== "none") args.push("--issue", "3");
    args.push("--data", JSON.stringify(schema.examples[0]));
    const r = await run("/bin/sh", args, {
      env: cleanEnv({ CALLUM_EVENTS_DIR: dir, CALLUM_FLOW_REPO: REPO, DEV_MACHINE_NAME: DEVICE, DEV_VERSIONS_FILE: versions, CALLUM_EVENT_SHAPES: shapes }),
    });
    if (r.status !== 0) problems.push(`${label} callum-flow-event --type ${type}: exit ${r.status}: ${r.stderr.trim()}`);
  }
  const fdir = path.join(dir, "factory");
  const lines = fs.existsSync(fdir)
    ? fs.readdirSync(fdir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => fs.readFileSync(path.join(fdir, f), "utf8").split("\n").filter(Boolean))
    : [];
  return { dir, lines, problems };
}

// writeAll(tagDir, db, { label, scratch, events, share }): pushes the events (copied from
// `events.dir`) with the tag's factory-event-push-loop --once and beats the tag's heartbeat-loop
// --once, both as the writer role. Returns the problems.
async function writeAll(tagDir, db, { label, scratch, events, share }) {
  const base = path.join(tagDir, "images", "base");
  const problems = [];
  const eventsDir = path.join(scratch, "events");
  fs.cpSync(events.dir, eventsDir, { recursive: true });
  const push = await run("bash", [path.join(base, "factory-event-push-loop"), "--once"], {
    env: cleanEnv({ DEV_SYSTEM_SHARE: share, CALLUM_EVENTS_DIR: eventsDir, FACTORY_DB_WRITER_URL: db.writerUrl }),
  });
  if (push.status !== 0) problems.push(`${label} factory-event-push-loop: exit ${push.status}: ${(push.stdout + push.stderr).trim()}`);
  const refused = path.join(eventsDir, "factory", ".refused");
  if (fs.existsSync(refused) && fs.readdirSync(refused).length > 0) {
    const text = fs.readdirSync(refused).map((f) => fs.readFileSync(path.join(refused, f), "utf8").trim()).join(" ");
    problems.push(`${label} factory-event-push-loop: refused lines: ${text.slice(0, 400)}`);
  }
  let count = "?";
  try {
    count = db.query("SELECT count(*) FROM factory.event_store");
  } catch (err) {
    problems.push(`${label} factory-event-push-loop: ${err.message}`);
  }
  if (count !== String(events.lines.length)) problems.push(`${label} factory-event-push-loop: factory.event_store has ${count} rows, ${events.lines.length} events were written`);

  const hbDir = path.join(scratch, "hb");
  fs.mkdirSync(path.join(scratch, "hb-events"), { recursive: true });
  fs.mkdirSync(hbDir, { recursive: true });
  const beat = await run("bash", [path.join(base, "heartbeat-loop"), "--once"], {
    env: cleanEnv({
      DEV_SYSTEM_SHARE: share, DEV_HEARTBEAT_DIR: hbDir, DEV_VERSIONS_FILE: path.join(scratch, "versions.json"), DEV_MACHINE_NAME: DEVICE,
      CALLUM_EVENTS_DIR: path.join(scratch, "hb-events"), AGENTSVIEW_DATA_DIR: path.join(scratch, "av"), FACTORY_DB_WRITER_URL: db.writerUrl,
    }),
  });
  const out = beat.stdout + beat.stderr;
  if (beat.status !== 0) problems.push(`${label} heartbeat-loop: exit ${beat.status}: ${out.trim()}`);
  else if (/stats write failed|ERROR/.test(out)) problems.push(`${label} heartbeat-loop: ${out.trim().slice(0, 400)}`);
  try {
    const rows = db.query("SELECT count(*) FROM factory.workers");
    if (rows !== "1") problems.push(`${label} heartbeat-loop: factory.workers has ${rows} rows, 1 expected`);
  } catch (err) {
    problems.push(`${label} heartbeat-loop: ${err.message}`);
  }
  return problems;
}

// ----------------------------------------------------------------------------------------- read

// Every ```sql block of a markdown file as { id, sql }: the id is `<heading> #<n>` (as
// tests/metrics-queries.test.js names them).
function sqlBlocks(md) {
  const out = [];
  const count = {};
  let heading = "";
  let fence = null;
  for (const l of md.split("\n")) {
    if (fence === null && /^#{1,6} /.test(l)) heading = l.replace(/^#+ /, "").trim();
    if (fence === null && /^```sql\s*$/.test(l)) fence = [];
    else if (fence !== null && /^```\s*$/.test(l)) {
      const n = (count[heading] = (count[heading] ?? -1) + 1);
      out.push({ id: `${heading} #${n}`, sql: fence.join("\n") });
      fence = null;
    } else if (fence !== null) fence.push(l);
  }
  return out;
}

function tsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// The readers of a tag: [{ id, kind: "sql", sql } | { id, kind: "state" }].
async function listReaders(tagDir, label) {
  const readers = [];
  const doc = path.join(tagDir, "docs", "metrics.md");
  if (fs.existsSync(doc)) for (const b of sqlBlocks(fs.readFileSync(doc, "utf8"))) readers.push({ id: `docs/metrics.md "${b.id}"`, kind: "sql", sql: b.sql });
  const hooks = path.join(tagDir, "plugins", "factory-loop", "hooks");
  if (fs.existsSync(hooks)) {
    const files = tsFiles(hooks).filter((f) => /export const \w*SQL/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(tagDir, f)).sort();
    if (files.length > 0) {
      const r = await run(process.execPath, [EXPORTS_SCRIPT, tagDir, ...files], { env: cleanEnv({}) });
      if (r.status !== 0) throw new Error(`${label}: importing the loop's SQL exports failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
      const found = JSON.parse(r.stdout);
      for (const file of files) for (const [name, sql] of Object.entries(found[file] ?? {})) readers.push({ id: `${file} ${name}`, kind: "sql", sql });
    }
  }
  const state = path.join(tagDir, "images", "base", "callum-flow-factory-state");
  if (fs.existsSync(state) && fs.readFileSync(state, "utf8").includes("factory.event_log")) readers.push({ id: "callum-flow-factory-state", kind: "state" });
  return readers;
}

// The psql variables a read may use.
function readVars(at) {
  return { repo: REPO, device: DEVICE, at, days: "7", since: new Date(Date.parse(at) - 86400000).toISOString() };
}

// The `:'name'` variables of a block that are not in the fixed set (comments are dropped first).
function unknownVars(sql, vars) {
  const text = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const bad = new Set();
  for (const m of text.matchAll(/(?<!:):['"](\w+)['"]/g)) if (!(m[1] in vars)) bad.add(m[1]);
  return [...bad];
}

// Whether a read fails on A because it is outside the factory database: it reads the old store
// factory.events or the nomistakes mirror (which a factory database never has), or it is the mirror's
// own DDL (CREATE SCHEMA nomistakes, which the reader role may not run).
const isOutsideRead = (stderr, sql = "") =>
  /relation "(factory\.events|nomistakes\.\w+)" does not exist|schema "nomistakes" does not exist/.test(stderr) ||
  (/permission denied for database/.test(stderr) && /\bnomistakes\b/.test(sql));

const touchesWorkers = (sql) => /\bfactory\.(workers|workers_status|worker_samples)\b|\b(workers_status|worker_samples)\b/.test(sql);

// parseCsv(text): the rows of psql --csv output, each a list of fields.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// readOne(reader, db, { at, tagDir, share }): the answer of one read as the reader role:
// { id, ok: true, cols, rows, workers, ordered, raw } or { id, ok: false, error, outside } or
// { id, fault } when the read itself is not runnable (an unknown variable).
async function readOne(reader, db, { at, tagDir, share }) {
  if (reader.kind === "state") {
    const base = path.join(tagDir, "images", "base");
    const r = await run(process.execPath, [path.join(base, "callum-flow-factory-state"), "--source", "new", "--github", "off", "--at", at, "--format", "json"], {
      env: cleanEnv({ DEV_SYSTEM_SHARE: share, CALLUM_FLOW_DEV_QUERY_BIN: path.join(base, "dev-query"), FACTORY_DB_READER_URL: db.readerUrl }),
    });
    if (r.status !== 0) return { id: reader.id, ok: false, error: `exit ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 600)}`, outside: false };
    return { id: reader.id, ok: true, state: true, raw: r.stdout };
  }
  const vars = readVars(at);
  const bad = unknownVars(reader.sql, vars);
  if (bad.length > 0) return { id: reader.id, fault: `harness: the read uses the variable ${bad.map((b) => `:'${b}'`).join(", ")}, which the harness does not set (repo, device, at, days, since)` };
  const args = ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  args.push(db.readerUrl, "-f", "-");
  const r = await run("psql", args, { env: cleanEnv({ PGOPTIONS: "-c client_min_messages=warning" }), input: reader.sql });
  if (r.status !== 0) {
    const error = r.stderr.trim().split("\n").filter((l) => /ERROR|error|FATAL/.test(l))[0] ?? r.stderr.trim();
    return { id: reader.id, ok: false, error, outside: isOutsideRead(r.stderr, reader.sql) };
  }
  const all = parseCsv(r.stdout);
  return {
    id: reader.id, ok: true, cols: all[0] ?? [], rows: all.slice(1), workers: touchesWorkers(reader.sql),
    ordered: /\border\s+by\b/i.test(reader.sql), raw: r.stdout,
  };
}

// readAll(readers, db, ctx): Map id -> readOne's answer, in order.
async function readAll(readers, db, ctx) {
  const out = new Map();
  for (const reader of readers) out.set(reader.id, await readOne(reader, db, ctx));
  return out;
}

const sortedRows = (rows) => rows.map((r) => JSON.stringify(r)).sort();

// compare(label, a, b): the problems of B (head) against A (the tag's own schema), one string per
// read: `<label> <id>: <what differed or the error>`. A read that fails on A because it reads outside
// the factory database is skipped (see skipped()); any other failure on A is a harness fault.
function compare(label, a, b) {
  const problems = [];
  for (const [id, ra] of a) {
    const rb = b.get(id);
    if (ra.fault !== undefined) {
      problems.push(`${label} ${id}: ${ra.fault}`);
      continue;
    }
    if (!ra.ok) {
      if (!ra.outside) problems.push(`${label} ${id}: harness fault, the tag's own schema fails the read: ${ra.error}`);
      continue;
    }
    if (rb === undefined || !rb.ok) {
      problems.push(`${label} ${id}: head schema: ${rb === undefined ? "no answer" : rb.error}`);
      continue;
    }
    if (ra.state) {
      if (ra.raw !== rb.raw) problems.push(`${label} ${id}: head schema: the JSON differs from the tag's own schema's`);
      continue;
    }
    if (JSON.stringify(ra.cols) !== JSON.stringify(rb.cols)) {
      problems.push(`${label} ${id}: head schema: columns (${rb.cols.join(", ")}) differ from (${ra.cols.join(", ")})`);
      continue;
    }
    if (ra.workers) {
      if (ra.rows.length !== rb.rows.length) problems.push(`${label} ${id}: head schema: ${rb.rows.length} rows, ${ra.rows.length} expected`);
      continue;
    }
    const same = ra.ordered
      ? JSON.stringify(ra.rows) === JSON.stringify(rb.rows)
      : JSON.stringify(sortedRows(ra.rows)) === JSON.stringify(sortedRows(rb.rows));
    if (!same) problems.push(`${label} ${id}: head schema: ${rb.rows.length} rows differ from the tag's ${ra.rows.length}`);
  }
  return problems;
}

// skipped(a): the ids of reads that are non-factory reads for the tag, with the reason.
const skipped = (a) => [...a.values()].filter((r) => r.ok === false && r.outside).map((r) => `${r.id}: ${r.error}`);

// ------------------------------------------------------------------------------------ one tag

const randomPassword = () => crypto.randomBytes(12).toString("hex");

// runTag(t, tag, { createDb, at, migrationsDir }): extracts the tag, builds A with the tag's own
// bootstrap and B with head's (or with `migrationsDir`), writes and reads, and returns
// { problems, skipped, empty }. empty is a message when the tag has no migrations to test.
async function runTag(t, tag, { createDb, at, migrationsDir }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `schema-compat-${tag}-`));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const tagDir = path.join(scratch, "files");
  fs.mkdirSync(tagDir);
  extractTag(tag, tagDir);
  if (!hasMigrations(tagDir)) return { problems: [], skipped: [], empty: `${tag} has no images/base/factory-db/migrations` };
  const share = makeShare(tagDir, scratch);
  const pw = () => ({ writerPassword: randomPassword(), readerPassword: randomPassword() });
  const dbA = createDb(t, { bootstrap: path.join(tagDir, "images", "base", "factory-db-bootstrap"), ...pw() });
  const dbB = createDb(t, { migrationsDir, ...pw() });
  const events = await writeEvents(tagDir, scratch, tag);
  const problems = [...events.problems];
  for (const [name, db] of [["tag schema", dbA], ["head schema", dbB]]) {
    const sub = path.join(scratch, name.split(" ")[0]);
    fs.mkdirSync(sub);
    for (const p of await writeAll(tagDir, db, { label: tag, scratch: sub, events, share })) problems.push(`${p} [${name}]`);
  }
  const readers = await listReaders(tagDir, tag);
  const ctx = { at, tagDir, share };
  const a = await readAll(readers, dbA, ctx);
  const b = await readAll(readers, dbB, ctx);
  problems.push(...compare(tag, a, b));
  const withRows = [...a.values()].filter((r) => r.ok && (r.state || r.rows.length > 0)).length;
  return { problems, skipped: skipped(a), readers: readers.length, withRows };
}

module.exports = {
  ROOT, KEY_PATHS, selectTags, dedupeTags, mergedTags, isShallow, requireTagsProblem, tagKey, extractTag, hasMigrations,
  writeEvents, writeAll, listReaders, readOne, readAll, compare, skipped, unknownVars, isOutsideRead, parseCsv, sqlBlocks,
  runTag,
};
