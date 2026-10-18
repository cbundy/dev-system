"use strict";
// The source switch for factory read tools (cbundy/dev-system#897): which store a tool reads
// (old, new or shadow), and the shadow run that answers from old while recording how new differs.
// CommonJS, node built-ins only. docs/factory-events/replay.md, "Source switch".

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SOURCES = ["old", "new", "shadow"];

const clip = (s, n = 200) => (s.length > n ? s.slice(0, n) : s);
const show = (v) => (v === undefined ? "undefined" : clip(JSON.stringify(v) ?? "undefined"));

function usageError(msg) {
  const e = new Error(msg);
  e.code = "USAGE";
  return e;
}

function check(value, from) {
  if (!SOURCES.includes(value)) throw usageError(`invalid source '${value}' from ${from}: use one of ${SOURCES.join(", ")}`);
  return value;
}

// resolveSource(tool, argv, env, fallback): { source, argv } with --source X / --source=X removed.
// Precedence: the flag, CALLUM_FLOW_<TOOL>_SOURCE, then fallback.
function resolveSource(tool, argv, env, fallback) {
  const rest = [];
  let flag = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") {
      if (i + 1 >= argv.length) throw usageError(`--source needs a value: use one of ${SOURCES.join(", ")}`);
      flag = argv[++i];
    } else if (a.startsWith("--source=")) {
      flag = a.slice("--source=".length);
    } else rest.push(a);
  }
  const envName = `CALLUM_FLOW_${tool.toUpperCase().replace(/-/g, "_")}_SOURCE`;
  if (flag !== null) return { source: check(flag, "the --source flag"), argv: rest };
  const ev = env[envName];
  if (ev !== undefined && ev !== "") return { source: check(ev, `${envName}`), argv: rest };
  return { source: fallback, argv: rest };
}

const here = (p, k) => (typeof k === "number" ? `${p}[${k}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `${p}.${k}` : `${p}[${JSON.stringify(k)}]`);

// diff(a, b, path): [{ path, old, new }] for every leaf where a and b differ. A key or index on one
// side only has the other side undefined.
function diff(a, b, p = "$") {
  if (Object.is(a, b)) return [];
  const isObj = (v) => v !== null && typeof v === "object";
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return [{ path: p, old: a, new: b }];
  const out = [];
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diff(a[i], b[i], here(p, i)));
  } else {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) out.push(...diff(a[k], b[k], here(p, k)));
  }
  return out;
}

// runShadow({ tool, old, new, normalize, repo, args, eventsDir, now }): runs old then new, resolves to
// old's raw answer and appends one record to <events>/factory/.shadow/<tool>.jsonl. A failing new or an
// unwritable record never fails the tool; a failing old propagates.
async function runShadow({ tool, old, new: nu, normalize, repo = null, args = null, eventsDir, now = () => Date.now() }) {
  const norm = typeof normalize === "function" ? normalize : (x) => x;
  const t0 = now();
  const oldAnswer = await old();
  const t1 = now();
  let differences = null;
  let paths = [];
  let newError = null;
  let t2;
  try {
    const newAnswer = await nu();
    t2 = now();
    const d = diff(norm(oldAnswer), norm(newAnswer));
    differences = d.length;
    paths = d.slice(0, 5).map((x) => ({ path: x.path, old: show(x.old), new: show(x.new) }));
  } catch (e) {
    t2 = now();
    newError = clip(String(e && e.message !== undefined ? e.message : e));
  }
  const dir = path.join(eventsDir || process.env.CALLUM_EVENTS_DIR || "/persist/events", "factory", ".shadow");
  const file = path.join(dir, `${tool}.jsonl`);
  const record = {
    ts: new Date(t2).toISOString(),
    tool,
    device: process.env.DEV_MACHINE_NAME || os.hostname(),
    repo,
    args,
    old_ms: t1 - t0,
    new_ms: t2 - t1,
    differences,
    paths,
    new_error: newError,
  };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`${tool}: shadow: cannot write ${file}: ${e.message}\n`);
  }
  if (differences) process.stderr.write(`${tool}: shadow: ${differences} difference(s), first at ${paths[0].path} (see ${file})\n`);
  return oldAnswer;
}

module.exports = { resolveSource, runShadow, diff, clip };
