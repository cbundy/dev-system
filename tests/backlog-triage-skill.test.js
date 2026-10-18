// Tests for the backlog-triage skill: the frontmatter, that its workflow scripts parse and merge
// their agents' answers correctly (run here with stub agents), that triage-prep batches and seeds
// as the page expects, and that the page offers the outcomes the workflow produces.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const DIR = path.join(__dirname, "..", "plugins", "callum-flow", "skills", "backlog-triage");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const PREP = path.join(DIR, "triage-prep.js");

// Runs a Workflow script the way the Workflow tool does: an async body with its hooks in scope.
async function runWorkflow(file, args, agent) {
  const body = read(file).replace(/^export const meta/m, "const meta");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", body);
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const pipeline = (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      let v = item;
      for (const s of stages) v = await s(v, item, i);
      return v;
    }));
  const logs = [];
  const out = await fn(args, agent, parallel, pipeline, () => {}, (m) => logs.push(m));
  return { out, logs };
}

function assessed(n, extra = {}) {
  return {
    number: n, summary: `s${n}`, recommend: "leave", confidence: "high", reason: "r", evidence: "e",
    rewriteSketch: "", tags: [], unaffected: false, researchOnly: false, priorityCandidate: false,
    impact: "", impactWhy: "", changed: false, challengeNote: "", ...extra,
  };
}

test("frontmatter names the skill and covers both modes", () => {
  const fm = read("SKILL.md").match(/^---\n([\s\S]*?)\n---\n/)[1];
  assert.match(fm, /^name: backlog-triage$/m);
  assert.match(fm, /^version: \d+\.\d+\.\d+$/m);
  assert.match(fm, /direction/);
  assert.match(fm, /prioritise/);
});

test("no em dash in any skill file", () => {
  for (const f of fs.readdirSync(DIR)) assert.doesNotMatch(read(f), /—/, f);
});

test("the skill reads issues through callum-flow-issue-read and names every file it ships", () => {
  const skill = read("SKILL.md");
  assert.match(skill, /callum-flow-issue-read --list --state open --json/);
  for (const f of fs.readdirSync(DIR).filter((f) => f !== "SKILL.md")) assert.ok(skill.includes(f), `SKILL.md never mentions ${f}`);
});

test("triage workflow: a ranked candidate moves to the priority list, the rest stay in clean-up", async () => {
  const batches = [[{ n: 1, t: "a", l: [], p: null, s: "" }, { n: 2, t: "b", l: [], p: null, s: "" }], [{ n: 3, t: "c", l: [], p: null, s: "" }]];
  const seen = [];
  const agent = async (prompt, opts) => {
    seen.push(opts.label);
    if (opts.label === "signals") return "brief";
    if (opts.label.startsWith("assess:")) {
      return { issues: opts.label.endsWith("1") ? [assessed(1, { priorityCandidate: true, impact: "bug" }), assessed(2, { recommend: "close" })] : [] };
    }
    if (opts.label.startsWith("challenge:batch")) {
      const prior = JSON.parse(prompt.split("Prior calls:\n")[1].split("\n\nIssues in the batch:")[0]);
      return { issues: prior };
    }
    const ranked = { number: 1, rank: 1, impact: "bug", recommend: "prioritise", confidence: "high", reason: "hurt", evidence: "x", remaining: "", changed: false, challengeNote: "" };
    if (opts.label === "rank") return { issues: [ranked] };
    if (opts.label === "challenge:rank") return { issues: [{ ...ranked, changed: true, challengeNote: "checked" }] };
    throw new Error(`unexpected agent ${opts.label}`);
  };
  const { out, logs } = await runWorkflow("triage.workflow", { repo: "o/r", context: "ctx", direction: "", lists: [], batches }, agent);
  assert.deepEqual(out.missing, [3]);
  assert.ok(logs.some((l) => /Missing assessments: 3/.test(l)));
  const by = Object.fromEntries(out.issues.map((i) => [i.number, i]));
  assert.equal(by[1].list, "priority");
  assert.equal(by[1].recommend, "prioritise");
  assert.equal(by[1].challengeNote, "checked");
  assert.equal(by[2].list, "cleanup");
  assert.equal(by[2].recommend, "close");
  assert.equal(out.signals, "brief");
  assert.ok(seen.includes("signals") && seen.includes("challenge:rank"));
});

test("triage workflow: a clean-up-only direction skips signals and ranking", async () => {
  const labels = [];
  const agent = async (prompt, opts) => {
    labels.push(opts.label);
    assert.match(prompt, /drop the v1 loop/);
    assert.doesNotMatch(prompt, /PRIORITY CANDIDATES/);
    return { issues: [assessed(5, { changed: false, challengeNote: "" })] };
  };
  const { out } = await runWorkflow("triage.workflow",
    { repo: "o/r", context: "ctx", direction: "drop the v1 loop", lists: ["cleanup"], batches: [[{ n: 5, t: "e", l: [], p: null, s: "" }]] }, agent);
  assert.deepEqual(labels, ["assess:batch1", "challenge:batch1"]);
  assert.equal(out.issues[0].list, "cleanup");
});

test("rewrite workflow: one drafting agent per group, owner notes passed through", async () => {
  const prompts = [];
  const agent = async (prompt, opts) => {
    prompts.push(prompt);
    return { issues: [{ number: Number(opts.label.slice(-1)), verdict: "rewrite", newTitle: "t", change: "c", evidence: "e" }] };
  };
  const { out } = await runWorkflow("rewrite.workflow", {
    repo: "o/r", context: "ctx", draftDir: "/tmp/d", styleIssues: [9],
    groups: [{ name: "g1", issues: [{ n: 1, t: "a", reason: "r", sketch: "s", note: "keep it small" }] }, { name: "g2", issues: [{ n: 2, t: "b", reason: "r", sketch: "", note: "" }] }],
  }, agent);
  assert.equal(out.length, 2);
  assert.match(prompts[0], /OWNER NOTE \(follow it\): keep it small/);
  assert.match(prompts[0], /\/tmp\/d\/<N>\.md/);
});

test("triage-prep keeps epic trees in one batch and seeds the page's documents", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "triage-prep-"));
  const issue = (n, parent, extra = {}) => ({
    number: n, id: 1000 + n, title: `t${n}`, labels: [{ name: "bug" }],
    parent_issue_url: parent ? `https://api.github.com/repos/o/r/issues/${parent}` : null, ...extra,
  });
  const list = {
    issues: [
      issue(1, null, { sub_issues_summary: { total: 3, completed: 1 } }), issue(2, 1), issue(3, 2),
      issue(4, 99), issue(5, null), issue(6, null, { pull_request: {} }),
    ],
  };
  fs.writeFileSync(path.join(work, "list.json"), JSON.stringify(list));
  let r = spawnSync(process.execPath, [PREP, "prep", path.join(work, "list.json"), work, "--batch", "3"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const batches = JSON.parse(fs.readFileSync(path.join(work, "batches.json"), "utf8"));
  assert.deepEqual(batches.map((b) => b.map((i) => i.n).sort()), [[1, 2, 3], [4, 5]]);
  const tree = batches[0];
  assert.equal(tree.find((i) => i.n === 3).p, 2);
  assert.equal(tree.find((i) => i.n === 1).s, "1/3 sub-issues done");
  assert.equal(batches[1].find((i) => i.n === 4).p, null, "a parent outside the open list is dropped");

  const results = { result: { issues: [{ ...assessed(1), list: "priority", rank: 1, impact: "epic", recommend: "prioritise", remaining: "#2 t2" }, { ...assessed(2), list: "cleanup" }] } };
  fs.writeFileSync(path.join(work, "results.json"), JSON.stringify(results));
  r = spawnSync(process.execPath, [PREP, "seed", path.join(work, "results.json"), work, "--repo", "o/r", "--title", "Cut"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not assessed: 3, 4, 5/);
  const writes = JSON.parse(fs.readFileSync(path.join(work, "seed", "writes-1.json"), "utf8"));
  assert.deepEqual(writes.map((w) => `${w.collection}/${w.doc_id}`), ["issues/1", "issues/2", "meta/page"]);
  const doc = JSON.parse(fs.readFileSync(writes[0].file_path, "utf8"));
  assert.equal(doc.list, "priority");
  assert.equal(doc.remaining, "#2 t2");
  assert.equal(JSON.parse(fs.readFileSync(writes[1].file_path, "utf8")).epic, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(writes[2].file_path, "utf8")).lists, ["cleanup", "priority"]);
});

test("the page offers every outcome the workflow can suggest and reads the seeded collections", () => {
  const page = read("page.html");
  assert.match(page, /<title>__TITLE__<\/title>/);
  for (const o of ["close", "rewrite", "leave", "prioritise", "queue", "later"]) assert.match(page, new RegExp(`\\["${o}", "`));
  for (const g of ["bug", "observability", "epic", "other"]) assert.match(page, new RegExp(`key: "${g}"`));
  for (const c of ["meta", "issues", "decisions"]) assert.match(page, new RegExp(`collection\\("${c}"\\)`));
});
