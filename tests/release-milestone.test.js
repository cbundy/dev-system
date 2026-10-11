// Tests for scripts/release-milestone.js (dev-system#404): the milestone rollover, run
// against an in-memory fake of the GitHub API and throwaway git repos for the ranges.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "release-milestone.js");
const { main, ghApi } = require(SCRIPT);

function git(root, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
}

// A repo with tag v1.0.0 and the given squash subjects after it.
function fakeRepo(t, subjects) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-milestone-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init (#1)");
  git(root, "tag", "v1.0.0");
  for (const s of subjects) git(root, "commit", "-q", "--allow-empty", "-m", s);
  return root;
}

// In-memory GitHub: milestones, issues/PRs (with milestone, state, closing refs).
function fakeGithub({ milestones = [], items = [] } = {}) {
  const ms = milestones.map((m, i) => ({ number: i + 1, state: "open", description: "", ...m }));
  const its = new Map(items.map((i) => [i.number, { state: "open", milestone: null, closes: [], ...i }]));
  const writes = [];
  const view = (it) => ({
    number: it.number,
    title: it.title || `item ${it.number}`,
    state: it.state,
    pull_request: it.pr ? {} : undefined,
    milestone: it.milestone == null ? null : { number: it.milestone, title: ms.find((m) => m.number === it.milestone).title },
  });
  async function api(method, endpoint, body) {
    const e = endpoint.replace("repos/{owner}/{repo}", "R");
    if (method !== "GET" && e !== "graphql") writes.push(`${method} ${e} ${JSON.stringify(body)}`);
    let m;
    if (method === "GET" && e === "R") return { full_name: "o/r" };
    if (method === "GET" && e.startsWith("R/milestones?")) return ms.map((x) => ({ ...x }));
    if (method === "POST" && e === "R/milestones") {
      const created = { number: ms.length + 1, state: "open", description: "", ...body };
      ms.push(created);
      return { ...created };
    }
    if (method === "PATCH" && (m = /^R\/milestones\/(\d+)$/.exec(e))) {
      const x = ms.find((k) => k.number === Number(m[1]));
      Object.assign(x, body);
      return { ...x };
    }
    if (method === "GET" && (m = /^R\/issues\?milestone=(\d+)&state=(\w+)/.exec(e))) {
      return [...its.values()].filter((i) => i.milestone === Number(m[1]) && (m[2] === "all" || i.state === m[2])).map(view);
    }
    if (method === "GET" && (m = /^R\/issues\/(\d+)$/.exec(e))) {
      const i = its.get(Number(m[1]));
      if (!i) throw Object.assign(new Error("HTTP 404"), { notFound: true });
      return view(i);
    }
    if (method === "PATCH" && (m = /^R\/issues\/(\d+)$/.exec(e))) {
      its.get(Number(m[1])).milestone = body.milestone;
      return {};
    }
    if (method === "POST" && e === "graphql") {
      const pr = its.get(body.variables.number);
      const nodes = ((pr && pr.closes) || []).map((ref) => {
        if (typeof ref === "object") return ref;
        return { number: ref, title: its.get(ref).title || `item ${ref}`, state: its.get(ref).state.toUpperCase(), repository: { nameWithOwner: "o/r" } };
      });
      return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes } } } } };
    }
    throw new Error(`unfaked ${method} ${endpoint}`);
  }
  const titleOf = (n) => { const i = its.get(n); return i.milestone == null ? null : ms.find((k) => k.number === i.milestone).title; };
  return { api, ms, its, writes, titleOf, byTitle: (t) => ms.filter((m) => m.title === t) };
}

async function run(gh, root, args) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, { api: gh.api, root, stdout: { write: (s) => (stdout += s) }, stderr: { write: (s) => (stderr += s) } });
  return { code, stdout, stderr };
}

function throughGh(t, api) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-responses-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const response = path.join(dir, "response.json");
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\ncase " $* " in *" --input "*) cat >/dev/null ;; esac\ncat '${response}'\n`, { mode: 0o755 });
  return async (method, endpoint, body) => {
    const value = await api(method, endpoint, body);
    const pages = Array.isArray(value) ? [value.slice(0, 1), value.slice(1)] : [value];
    fs.writeFileSync(response, JSON.stringify(method === "GET" ? pages : value));
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath}`;
    try {
      return ghApi(method, endpoint, body);
    } finally {
      process.env.PATH = originalPath;
    }
  };
}

for (const mode of ["--release", "--backfill", "--plan"]) {
  test(`${mode} preserves singleton resources and flattens collection pages through gh`, async (t) => {
    const root = fakeRepo(t, ["feat: a (#10)", "fix: b (#11)"]);
    const gh = fakeGithub({
      milestones: [{ title: "Next release" }, { title: "Later" }],
      items: [
        { number: 10, pr: true, state: "closed", milestone: 1, closes: [30] },
        { number: 11, pr: true, state: "closed", closes: [31] },
        { number: 20, milestone: 1 },
        { number: 30, state: "closed", milestone: 1 },
        { number: 31, state: "closed" },
      ],
    });
    const r = await run({ api: throughGh(t, gh.api) }, root, [mode, "1.1.0"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gh.titleOf(20), "Next release");
    if (mode === "--plan") {
      assert.deepEqual(gh.writes, []);
      assert.match(r.stdout, /in the range but not in the milestone \(2\):\n  #11\n  #31/);
      assert.match(r.stdout, /open items \(1\):\n  #20/);
    } else {
      assert.equal(gh.titleOf(10), mode === "--backfill" ? "Next release" : "v1.1.0");
      assert.equal(gh.titleOf(30), mode === "--backfill" ? "Next release" : "v1.1.0");
      assert.equal(gh.titleOf(11), "v1.1.0");
      assert.equal(gh.titleOf(31), "v1.1.0");
      assert.equal(gh.byTitle("v1.1.0")[0].state, "closed");
      gh.writes.length = 0;
      const rerun = await run({ api: throughGh(t, gh.api) }, root, [mode, "1.1.0"]);
      assert.equal(rerun.code, 0, rerun.stderr);
      assert.deepEqual(gh.writes, []);
    }
  });

  test(`${mode} ignores foreign linked issues with colliding local numbers`, async (t) => {
    const root = fakeRepo(t, ["feat: a (#10)"]);
    const gh = fakeGithub({
      milestones: [{ title: "Next release" }],
      items: [
        { number: 10, pr: true, state: "closed", closes: [
          { number: 31, title: "foreign", state: "CLOSED", repository: { nameWithOwner: "other/repo" } },
          { number: 32, title: "local", state: "CLOSED", repository: { nameWithOwner: "O/R" } },
        ] },
        { number: 31, title: "unrelated local issue", state: "closed" },
        { number: 32, title: "local", state: "closed" },
      ],
    });
    const calls = [];
    const r = await run({ api: async (...args) => { calls.push(args); return gh.api(...args); } }, root, [mode, "1.1.0"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gh.titleOf(31), null);
    assert.equal(calls.some(([, endpoint]) => endpoint === "repos/{owner}/{repo}/issues/31"), false);
    if (mode === "--plan") {
      assert.deepEqual(gh.writes, []);
      assert.match(r.stdout, /in the range but not in the milestone \(2\):\n  #10\n  #32/);
      assert.doesNotMatch(r.stdout, /#31/);
    } else {
      assert.equal(gh.titleOf(10), "v1.1.0");
      assert.equal(gh.titleOf(32), "v1.1.0");
    }
  });
}

test("fresh rollover renames, closes, creates a new Next release and keeps closed items", async (t) => {
  const root = fakeRepo(t, ["feat: a (#10)"]);
  const gh = fakeGithub({
    milestones: [{ title: "Next release", description: "Expected: minor - new thing" }],
    items: [{ number: 10, pr: true, state: "closed", milestone: 1 }],
  });
  const r = await run(gh, root, ["--release", "1.1.0"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(gh.ms[0].title, "v1.1.0");
  assert.equal(gh.ms[0].state, "closed");
  assert.equal(gh.ms[0].description, "Expected: minor - new thing");
  const next = gh.byTitle("Next release");
  assert.equal(next.length, 1);
  assert.equal(next[0].state, "open");
  assert.equal(gh.titleOf(10), "v1.1.0");
});

test("re-run after success makes no writes", async (t) => {
  const root = fakeRepo(t, ["feat: a (#10)"]);
  const gh = fakeGithub({ milestones: [{ title: "Next release" }], items: [{ number: 10, pr: true, state: "closed", milestone: 1 }] });
  await run(gh, root, ["--release", "1.1.0"]);
  gh.writes.length = 0;
  const r = await run(gh, root, ["--release", "1.1.0"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(gh.writes, []);
  assert.equal(gh.ms.length, 2);
});

test("open items are carried to the fresh Next release", async (t) => {
  const root = fakeRepo(t, ["feat: a (#10)"]);
  const gh = fakeGithub({
    milestones: [{ title: "Next release" }],
    items: [{ number: 10, pr: true, state: "closed", milestone: 1 }, { number: 20, title: "still open", milestone: 1 }],
  });
  const r = await run(gh, root, ["--release", "1.1.0"]);
  assert.match(r.stdout, /carried #20: still open/);
  assert.equal(gh.titleOf(20), "Next release");
  assert.equal(gh.titleOf(10), "v1.1.0");
});

test("missing PRs and their closed linked issues are reconciled; a reopened issue is not", async (t) => {
  const root = fakeRepo(t, ["fix: b (#11)", "chore: manual", "feat: a (#10)"]);
  const gh = fakeGithub({
    milestones: [{ title: "Next release" }],
    items: [
      { number: 10, pr: true, state: "closed", milestone: 1, closes: [30] },
      { number: 11, pr: true, state: "closed", closes: [31, 32], title: "PR eleven" },
      { number: 30, state: "closed", milestone: 1 },
      { number: 31, state: "closed", title: "closed issue" },
      { number: 32, state: "open" },
    ],
  });
  const r = await run(gh, root, ["--release", "1.1.0"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /added #11 \(pr\): PR eleven/);
  assert.match(r.stdout, /added #31 \(issue\): closed issue/);
  assert.match(r.stdout, /no PR: chore: manual/);
  assert.equal(gh.titleOf(11), "v1.1.0");
  assert.equal(gh.titleOf(31), "v1.1.0");
  assert.equal(gh.titleOf(32), null);
});

test("an item in Later is pulled in; one in another milestone is left alone with a warning", async (t) => {
  const root = fakeRepo(t, ["feat: a (#10)", "feat: b (#11)"]);
  const gh = fakeGithub({
    milestones: [{ title: "Next release" }, { title: "Later" }, { title: "v0.9.0", state: "closed" }],
    items: [{ number: 10, pr: true, state: "closed", milestone: 2 }, { number: 11, pr: true, state: "closed", milestone: 3 }],
  });
  const r = await run(gh, root, ["--release", "1.1.0"]);
  assert.equal(gh.titleOf(10), "v1.1.0");
  assert.equal(gh.titleOf(11), "v0.9.0");
  assert.match(r.stdout, /warning: #11 is in milestone v0\.9\.0, left alone/);
});

test("without a Next release, vX.Y.Z is created closed and no Next release appears", async (t) => {
  const root = fakeRepo(t, ["feat: a (#10)"]);
  const gh = fakeGithub({ items: [{ number: 10, pr: true, state: "closed" }] });
  const r = await run(gh, root, ["--release", "1.1.0"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(gh.ms.map((m) => [m.title, m.state]), [["v1.1.0", "closed"]]);
  assert.equal(gh.titleOf(10), "v1.1.0");
});

test("an interrupted rollover (vX.Y.Z open, no Next release) resumes", async (t) => {
  const root = fakeRepo(t, ["feat: a (#10)"]);
  const gh = fakeGithub({
    milestones: [{ title: "v1.1.0" }],
    items: [{ number: 10, pr: true, state: "closed", milestone: 1 }, { number: 20, milestone: 1 }],
  });
  const r = await run(gh, root, ["--release", "1.1.0"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(gh.byTitle("v1.1.0").length, 1);
  assert.equal(gh.ms[0].state, "closed");
  assert.equal(gh.titleOf(20), "Next release");
});

test("a closed vX.Y.Z is only reconciled and an open Next release is left untouched", async (t) => {
  const root = fakeRepo(t, ["feat: a (#10)"]);
  const gh = fakeGithub({
    milestones: [{ title: "v1.1.0", state: "closed" }, { title: "Next release" }],
    items: [{ number: 10, pr: true, state: "closed", milestone: 2 }, { number: 20, milestone: 2 }],
  });
  await run(gh, root, ["--release", "1.1.0"]);
  assert.equal(gh.titleOf(10), "v1.1.0");
  assert.equal(gh.titleOf(20), "Next release");
  assert.equal(gh.ms[1].state, "open");
  assert.equal(gh.byTitle("Next release").length, 1);
});

test("--backfill creates a closed milestone without touching Next release or other milestones", async (t) => {
  const root = fakeRepo(t, ["feat: a (#10)", "feat: b (#11)"]);
  const gh = fakeGithub({
    milestones: [{ title: "Next release" }],
    items: [{ number: 10, pr: true, state: "closed" }, { number: 11, pr: true, state: "closed", milestone: 1 }],
  });
  const r = await run(gh, root, ["--backfill", "1.1.0"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(gh.titleOf(10), "v1.1.0");
  assert.equal(gh.titleOf(11), "Next release");
  assert.deepEqual(gh.ms.map((m) => [m.title, m.state]), [["Next release", "open"], ["v1.1.0", "closed"]]);
});

test("--backfill reconciles into an existing open milestone and closes it", async (t) => {
  const root = fakeRepo(t, ["feat: a (#10)"]);
  const gh = fakeGithub({ milestones: [{ title: "v1.1.0" }], items: [{ number: 10, pr: true, state: "closed" }] });
  await run(gh, root, ["--backfill", "1.1.0"]);
  assert.equal(gh.titleOf(10), "v1.1.0");
  assert.equal(gh.ms[0].state, "closed");
  assert.equal(gh.ms.length, 1);
});

test("--plan writes nothing and reports the expected line, missing, extra and open items", async (t) => {
  const root = fakeRepo(t, ["feat: a (#10)", "feat: b (#11)"]);
  const gh = fakeGithub({
    milestones: [{ title: "Next release", description: "Intro\nexpected: Minor - adds b\n" }],
    items: [
      { number: 10, pr: true, state: "closed", milestone: 1 },
      { number: 12, pr: true, state: "closed", milestone: 1, title: "stray" },
      { number: 20, title: "open one", milestone: 1 },
      { number: 11, pr: true, state: "closed" },
    ],
  });
  const r = await run(gh, root, ["--plan", "1.1.0"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(gh.writes, []);
  assert.match(r.stdout, /expected: Minor - adds b/);
  assert.match(r.stdout, /in the range but not in the milestone \(1\):\n  #11/);
  assert.match(r.stdout, /in the milestone but not in the range \(2\):\n  #12: stray\n  #20: open one/);
  assert.match(r.stdout, /open items \(1\):\n  #20: open one/);
});

test("--plan says so when there is no Next release", async (t) => {
  const root = fakeRepo(t, []);
  const r = await run(fakeGithub(), root, ["--plan", "1.1.0"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no open Next release milestone/);
});

test("CLI: usage errors exit 2 and the real gh wiring is used", (t) => {
  const bad = spawnSync("node", [SCRIPT, "--bogus"], { encoding: "utf-8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage:/);

  const root = fakeRepo(t, ["feat: a (#10)"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-shim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\necho "$*" >> "${dir}/calls"\necho '[[]]'\n`, { mode: 0o755 });
  const r = spawnSync("node", [SCRIPT, "--plan", "1.1.0"], {
    encoding: "utf-8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RELEASE_NOTES_ROOT: root },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no open Next release milestone/);
  assert.match(fs.readFileSync(path.join(dir, "calls"), "utf-8"), /api -X GET repos\/\{owner\}\/\{repo\}\/milestones\?state=all&per_page=100 --paginate --slurp/);
});
