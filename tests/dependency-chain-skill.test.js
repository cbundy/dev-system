// Tests for the dependency-chain skill: the frontmatter, the crawl through a stubbed
// callum-flow-issue-read (sub-issues, blocker links, removed links, the hop limit), the states and
// holds it finds, and the parts of the doc it writes: the diagram's widget code (every box a link
// on top, literal text ids, nothing the docs validator refuses), the issue table and the Mermaid
// fallback.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const DIR = path.join(__dirname, "..", "plugins", "callum-flow", "skills", "dependency-chain");
const CHAIN = path.join(DIR, "chain.js");
const chain = require(CHAIN);
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

// The fixture chain, in repo o/r. #1 is the epic (the seed). #9 was its sub-issue once, then
// removed. #5 and #6 sit outside the tree and are reached through blocker links; #8 is three hops
// out and stays out.
const R = { full_name: "o/r" };
const ref = (n) => ({ number: n, repository: R });
const at = (i) => `2026-10-18T10:${String(i).padStart(2, "0")}:00Z`;
const ISSUES = {
  1: { title: "Epic: the whole thing", state: "open", labels: [] },
  2: { title: "Groundwork", state: "closed", state_reason: "completed", labels: [] },
  3: { title: "A parked question", state: "open", labels: [{ name: "factory:parked" }] },
  4: { title: "The main change", state: "open", labels: [{ name: "ready" }] },
  5: { title: "An outside prerequisite", state: "open", labels: [] },
  6: { title: "Old outside work", state: "closed", state_reason: "completed", labels: [] },
  7: { title: "Downstream metrics", state: "open", labels: [{ name: "ready" }] },
  8: { title: "Far away", state: "open", labels: [] },
  10: { title: "A group with parts", state: "open", labels: [] },
  11: { title: "A finished part", state: "closed", state_reason: "completed", labels: [] },
  12: { title: "The part in the factory", state: "open", labels: [{ name: "factory:building" }] },
  13: { title: "A research note", state: "open", labels: [{ name: "research" }] },
  14: { title: "Done long ago", state: "closed", state_reason: "completed", labels: [] },
};
const TIMELINES = {
  1: [
    ...[2, 3, 4, 9, 10, 13, 14].map((n, i) => ({ event: "sub_issue_added", created_at: at(i), sub_issue: ref(n) })),
    { event: "sub_issue_removed", created_at: at(20), sub_issue: ref(9) },
    { event: "blocked_by_added", created_at: at(21), blocked_by: { number: 99, repository: { full_name: "x/other" } } },
  ],
  2: [{ event: "blocking_added", created_at: at(1), blocking: ref(4) }],
  4: [
    { event: "blocked_by_added", created_at: at(1), blocked_by: ref(2) },
    { event: "blocked_by_added", created_at: at(2), blocked_by: ref(5) },
    { event: "blocked_by_added", created_at: at(3), blocked_by: ref(3) },
    { event: "blocked_by_removed", created_at: at(4), blocked_by: ref(3) },
    { event: "blocking_added", created_at: at(5), blocking: ref(7) },
  ],
  5: [{ event: "blocked_by_added", created_at: at(1), blocked_by: ref(6) }, { event: "blocking_added", created_at: at(2), blocking: ref(4) }],
  6: [{ event: "blocking_added", created_at: at(1), blocking: ref(5) }, { event: "blocked_by_added", created_at: at(2), blocked_by: ref(8) }],
  7: [{ event: "blocked_by_added", created_at: at(1), blocked_by: ref(4) }, { event: "blocked_by_added", created_at: at(2), blocked_by: ref(10) }],
  10: [
    { event: "sub_issue_added", created_at: at(1), sub_issue: ref(11) },
    { event: "sub_issue_added", created_at: at(2), sub_issue: ref(12) },
    { event: "blocking_added", created_at: at(3), blocking: ref(7) },
  ],
  11: [{ event: "blocking_added", created_at: at(1), blocking: ref(12) }],
  12: [{ event: "blocked_by_added", created_at: at(1), blocked_by: ref(11) }],
};

// A stand-in for callum-flow-issue-read that answers from the fixture and logs each call.
function stub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-"));
  const data = path.join(dir, "data.json");
  const log = path.join(dir, "calls.log");
  const issues = Object.fromEntries(Object.entries(ISSUES).map(([n, i]) => [n, { number: Number(n), html_url: `https://github.com/o/r/issues/${n}`, ...i }]));
  fs.writeFileSync(data, JSON.stringify({ issues, timelines: TIMELINES }));
  const bin = path.join(dir, "issue-read");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
if (a[0] !== "--json") process.exit(2);
if (a[1] === "--timeline") { process.stdout.write(JSON.stringify({ events: d.timelines[a[2]] || [] })); process.exit(0); }
if (!d.issues[a[1]]) { process.stderr.write("not found"); process.exit(1); }
process.stdout.write(JSON.stringify({ issue: d.issues[a[1]], stripped: 0 }));
`);
  fs.chmodSync(bin, 0o755);
  return { dir, bin, log };
}

function crawl() {
  const s = stub();
  const r = spawnSync(process.execPath, [CHAIN, "crawl", "1"], { encoding: "utf8", env: { ...process.env, CALLUM_FLOW_ISSUE_READ: s.bin, CALLUM_FLOW_REPO: "o/r" } });
  assert.equal(r.status, 0, r.stderr);
  return { graph: JSON.parse(r.stdout), calls: fs.readFileSync(s.log, "utf8").trim().split("\n"), dir: s.dir };
}

test("frontmatter names the skill and says when to use it", () => {
  const fm = read("SKILL.md").match(/^---\n([\s\S]*?)\n---\n/)[1];
  assert.match(fm, /^name: dependency-chain$/m);
  assert.match(fm, /^version: \d+\.\d+\.\d+$/m);
  assert.match(fm, /\/dependency-chain/);
});

test("no em dash in any skill file", () => {
  for (const f of fs.readdirSync(DIR)) assert.doesNotMatch(read(f), /—/, f);
});

test("the skill reads issues through callum-flow-issue-read and runs every chain.js command it ships", () => {
  const skill = read("SKILL.md");
  assert.match(skill, /callum-flow-issue-read --list --json/);
  for (const cmd of ["crawl", "list", "holds", "table", "draw", "mermaid"]) assert.match(skill, new RegExp(`chain\\.js ${cmd}\\b`), cmd);
});

test("crawl follows the tree, blocker links both ways and stops two hops out", () => {
  const { graph, calls } = crawl();
  const nums = graph.nodes.map((n) => n.number);
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14]);
  assert.ok(!nums.includes(9), "a removed sub-issue is not part of the chain");
  assert.ok(!nums.includes(8), "an issue three hops out of the tree is left out");
  assert.ok(calls.every((c) => c.startsWith("--json ")), "every read goes through --json");
  const by = Object.fromEntries(graph.nodes.map((n) => [n.number, n]));
  assert.deepEqual(by[1].subIssues, [2, 3, 4, 10, 13, 14]);
  assert.deepEqual(by[1].blockedBy, [], "a link to another repo is left out");
  assert.deepEqual(by[4].blockedBy, [2, 5], "a removed blocker is gone");
  assert.deepEqual(by[4].blocking, [7]);
  assert.equal(by[2].state, "closed");
  assert.deepEqual(by[3].labels, ["factory:parked"]);
  assert.equal(graph.truncated, false);
});

test("crawl stops at --max and says it was cut", () => {
  const s = stub();
  const r = spawnSync(process.execPath, [CHAIN, "crawl", "1", "--max", "4"], { encoding: "utf8", env: { ...process.env, CALLUM_FLOW_ISSUE_READ: s.bin, CALLUM_FLOW_REPO: "o/r" } });
  assert.equal(r.status, 0, r.stderr);
  const g = JSON.parse(r.stdout);
  assert.ok(g.nodes.length <= 4);
  assert.equal(g.truncated, true);
});

test("states, the drawn set, folded parts and what is left off the drawing", () => {
  const { graph } = crawl();
  const a = chain.analyse(graph, {});
  const st = (n) => a.status.get(n);
  assert.equal(st(2), "done");
  assert.equal(st(3), "you");
  assert.equal(st(4), "readyblocked");
  assert.equal(st(5), "notready");
  assert.equal(st(7), "readyblocked");
  assert.equal(st(12), "loop");
  assert.equal(a.statusText.get(12), "Factory: building");
  assert.deepEqual([...a.drawn].sort((p, q) => p - q), [2, 4, 5, 6, 7, 10, 12], "the epic is the frame, a finished part folds into its parent");
  assert.deepEqual(a.parts.get(10), { done: 1, total: 2 });
  assert.deepEqual(a.offChain, [3, 13], "an issue linked to nothing is listed under the drawing");
  assert.deepEqual(a.history, [14]);
  const edges = a.edges.map((e) => `${e.from}${e.kind === "part" ? "~" : ">"}${e.to}`).sort();
  assert.deepEqual(edges, ["10>7", "12~10", "2>4", "4>7", "5>4", "6>5"]);
  // an owner override wins over the GitHub state
  const b = chain.analyse(graph, { 5: { status: "you", statusText: "Your hold" } });
  assert.equal(b.status.get(5), "you");
  assert.equal(b.statusText.get(5), "Your hold");
});

test("holds: the open issues nothing open blocks, with the ready issues each holds", () => {
  const { graph } = crawl();
  const h = chain.holds(graph, {});
  assert.deepEqual(h.map((x) => [x.number, x.holds]), [[5, [4, 7]], [12, [7]]]);
  assert.equal(h[0].url, "https://github.com/o/r/issues/5");
});

test("draw: one line of widget code, every box a link on top, literal text ids", () => {
  const { graph } = crawl();
  const warnings = [];
  const code = chain.draw(graph, { 10: { what: "A group with parts" } }, "Two ready issues wait on two holds", (m) => warnings.push(m));
  assert.ok(code.startsWith("export default () => {"));
  assert.ok(!code.includes("\n"), "the code is one line");
  // one link per box, per earlier issue and per issue off the chain, each opening in a new tab
  const links = code.match(/<a href='[^']+' target='_blank' rel='noreferrer'><rect [^>]*fillOpacity='0'[^>]*><title>Open #\d+ on GitHub<\/title><\/rect><\/a>/g) || [];
  assert.equal(links.length, 10);
  for (const n of [2, 4, 5, 6, 7, 10, 12, 14, 3, 13]) assert.ok(code.includes(`href='https://github.com/o/r/issues/${n}'`), `#${n} has a link`);
  assert.equal((code.match(/<a /g) || []).length, links.length, "no other links");
  assert.ok(code.indexOf("<a href") > code.lastIndexOf("data-claude-anchor"), "the links are drawn last, on top");
  for (const l of links) assert.doesNotMatch(l, /data-claude/, "a link carries no text id or anchor");
  const ids = [...code.matchAll(/data-claude-text-id='([^']+)'/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "each text id once");
  assert.ok(ids.includes("title") && ids.includes("n4") && ids.includes("h14") && ids.includes("o13"));
  // what the docs validator refuses: words or ids built in a loop, computed indexes, window names
  assert.doesNotMatch(code, /\.map\(/);
  assert.doesNotMatch(code, /\[[a-z]\]|\[\d+\]/);
  assert.doesNotMatch(code, /\b(window|parent|self|top)\b/);
  assert.match(code, /1 of 2 parts done/);
  assert.match(code, /Factory: building/);
  assert.equal(warnings.length, 1, "a parent's label longer than one line is reported");
  assert.match(warnings[0], /#10/);
  for (const [open, close] of [["<g", "</g>"], ["<text", "</text>"], ["<a ", "</a>"]]) {
    assert.equal(code.split(open).length - 1, code.split(close).length - 1, `${open} is closed`);
  }
});

test("table and mermaid: a row and a click link for each issue", () => {
  const { graph, dir } = crawl();
  const g = path.join(dir, "graph.json");
  fs.writeFileSync(g, JSON.stringify(graph));
  const run = (cmd) => spawnSync(process.execPath, [CHAIN, cmd, g], { encoding: "utf8" });
  const t = run("table");
  assert.equal(t.status, 0, t.stderr);
  const rows = t.stdout.trim().split("\n").slice(2);
  assert.equal(rows.length, 11, "every issue but the epic");
  assert.match(t.stdout, /\| \[#4\]\(https:\/\/github\.com\/o\/r\/issues\/4\) \| The main change \| Ready, blocked \| ready \| \[#5\]/);
  const m = run("mermaid");
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, /^flowchart TB/);
  assert.match(m.stdout, /click n4 "https:\/\/github\.com\/o\/r\/issues\/4" _blank/);
  assert.match(m.stdout, /n12 -\.-> n10/);
});

test("wrap keeps to its width and marks a cut", () => {
  assert.deepEqual(chain.wrap("Loop record rebuild onto the new database", 17, 2), ["Loop record", "rebuild onto t..."]);
  assert.deepEqual(chain.wrap("Short", 17, 2), ["Short"]);
  assert.equal(chain.clean("a <b> {c} & d"), "a (b) c and d");
});
