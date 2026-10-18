#!/usr/bin/env node
// Data plumbing for the backlog-triage skill, so the session never hand-builds batches or seed
// documents. Node built-ins only.
//
//   node triage-prep.js prep <list.json> <dir> [--batch N]
//       <list.json> is `callum-flow-issue-read --list --state open --json` output. Writes
//       <dir>/batches.json (the triage workflow's `batches` arg: epic trees kept in one batch)
//       and <dir>/issues.json (number -> title, labels, epic, sub-issue progress).
//   node triage-prep.js seed <results.json> <dir> --repo R --title T [--lede L] [--direction D]
//       <results.json> is the triage workflow's return value (or the tool's JSON wrapper around
//       it). Writes one document per issue under <dir>/seed/issues/, the page's
//       <dir>/seed/meta.json, and <dir>/seed/writes-<k>.json: ArtifactData batch `writes`
//       arrays of at most 50 entries, each pointing at a document file.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function die(msg) {
  process.stderr.write(`triage-prep: ${msg}\n`);
  process.exit(2);
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function prep(listFile, dir, size) {
  const raw = readJson(listFile);
  const list = (Array.isArray(raw) ? raw : raw.issues || []).filter((i) => !i.pull_request);
  const byNum = new Map(list.map((i) => [i.number, i]));
  const parentOf = (i) => {
    const m = /\/issues\/(\d+)$/.exec(i.parent_issue_url || "");
    return m && byNum.has(Number(m[1])) ? Number(m[1]) : null;
  };
  const rootOf = (n) => {
    const seen = new Set();
    while (parentOf(byNum.get(n)) && !seen.has(n)) {
      seen.add(n);
      n = parentOf(byNum.get(n));
    }
    return n;
  };
  const item = (i) => {
    const s = i.sub_issues_summary || {};
    return {
      n: i.number,
      t: i.title,
      l: (i.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
      p: parentOf(i),
      s: s.total ? `${s.completed}/${s.total} sub-issues done` : "",
    };
  };
  const trees = new Map();
  for (const i of [...list].sort((a, b) => a.number - b.number)) {
    const r = rootOf(i.number);
    if (!trees.has(r)) trees.set(r, []);
    trees.get(r).push(item(i));
  }
  // Pack whole trees, biggest first, into batches of about `size`; a tree larger than `size`
  // gets a batch of its own.
  const batches = [];
  for (const tree of [...trees.values()].sort((a, b) => b.length - a.length)) {
    const fit = batches.find((b) => b.length + tree.length <= size);
    if (fit) fit.push(...tree);
    else batches.push([...tree]);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "batches.json"), JSON.stringify(batches));
  const index = Object.fromEntries(list.map((i) => {
    const it = item(i);
    return [i.number, { title: it.t, labels: it.l, epic: it.p, progress: it.s }];
  }));
  fs.writeFileSync(path.join(dir, "issues.json"), JSON.stringify(index));
  process.stdout.write(`${list.length} open issues in ${batches.length} batches (${batches.map((b) => b.length).join(", ")})\n`);
}

function seed(resultsFile, dir, opts) {
  if (!opts.repo || !opts.title) die("seed needs --repo and --title");
  let res = readJson(resultsFile);
  if (res && res.result) res = typeof res.result === "string" ? JSON.parse(res.result) : res.result;
  const assessed = res.issues || [];
  const index = readJson(path.join(dir, "issues.json"));
  const out = path.join(dir, "seed");
  fs.mkdirSync(path.join(out, "issues"), { recursive: true });
  const writes = [];
  const lists = new Set();
  for (const a of assessed) {
    const base = index[a.number] || {};
    const doc = {
      title: base.title || a.title || "",
      labels: base.labels || [],
      epic: base.epic || null,
      list: a.list,
      summary: a.summary || "",
      reason: a.reason || "",
      evidence: a.evidence || "",
      recommend: a.recommend,
      confidence: a.confidence || "low",
      tags: a.tags || [],
      unaffected: Boolean(a.unaffected),
      researchOnly: Boolean(a.researchOnly),
      rewriteSketch: a.rewriteSketch || "",
      impact: a.impact || "",
      rank: a.rank || 0,
      remaining: a.remaining || "",
      changed: Boolean(a.changed),
      challengeNote: a.challengeNote || "",
    };
    if (doc.list === "cleanup" || doc.list === "priority") lists.add(doc.list);
    const file = path.join(out, "issues", `${a.number}.json`);
    fs.writeFileSync(file, JSON.stringify(doc));
    writes.push({ op: "set", collection: "issues", doc_id: String(a.number), file_path: path.resolve(file) });
  }
  const meta = {
    repo: opts.repo,
    title: opts.title,
    lede: opts.lede || "",
    direction: opts.direction || "",
    lists: ["cleanup", "priority"].filter((l) => lists.has(l)),
  };
  const metaFile = path.join(out, "meta.json");
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  writes.push({ op: "set", collection: "meta", doc_id: "page", file_path: path.resolve(metaFile) });
  const chunks = [];
  for (let k = 0; k * 50 < writes.length; k++) {
    const f = path.join(out, `writes-${k + 1}.json`);
    fs.writeFileSync(f, JSON.stringify(writes.slice(k * 50, k * 50 + 50), null, 1));
    chunks.push(path.resolve(f));
  }
  const missing = Object.keys(index).filter((n) => !assessed.some((a) => String(a.number) === n));
  process.stdout.write(`${assessed.length} documents, lists: ${meta.lists.join(", ") || "none"}\n`);
  if (missing.length) process.stdout.write(`not assessed: ${missing.join(", ")}\n`);
  process.stdout.write(`${chunks.join("\n")}\n`);
}

const [cmd, ...rest] = process.argv.slice(2);
const f = flags(rest);
if (cmd === "prep" && f._.length === 2) prep(f._[0], f._[1], Number(f.batch) || 30);
else if (cmd === "seed" && f._.length === 2) seed(f._[0], f._[1], f);
else die("usage: triage-prep.js prep <list.json> <dir> [--batch N] | seed <results.json> <dir> --repo R --title T [--lede L] [--direction D]");
