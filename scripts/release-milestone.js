#!/usr/bin/env node
// Rolls the "Next release" milestone over on each release (cbundy/dev-system#404, epic #402),
// so the milestone history stays complete even when a PR was merged by hand.
//
//   node scripts/release-milestone.js --release X.Y.Z  [--from <tag>] [--to <ref>]
//       Reconcile (every PR merged in the release range, and every closed issue it closes,
//       ends up in the milestone), then roll over: rename "Next release" to vX.Y.Z, create a
//       fresh "Next release", carry still-open items into it, reconcile, close vX.Y.Z. With
//       no "Next release" it creates vX.Y.Z already closed. Safe to re-run.
//   node scripts/release-milestone.js --backfill X.Y.Z [--from <tag>] [--to <ref>]
//       Create (or finish) a closed vX.Y.Z from a tag range. Never reads or writes
//       "Next release", and never moves an item that already has a milestone.
//   node scripts/release-milestone.js --plan X.Y.Z [--from <tag>] [--to <ref>]
//       Read-only: print what "Next release" holds, its expected-bump line, the differences
//       from the git range, and its open items. Always exits 0.
//
// The milestone contract (titles, expected-bump line) is in RELEASING.md "Milestones".
// The range and PR parsing come from release-notes.js, and the rule for which issues a release
// carried lives in images/base/release-contents.js (contents()), so the milestone, the technical
// list and the `released` event cannot disagree. The milestone keeps its own placement rule on top:
// only a CLOSED issue goes in. Node built-ins only; GitHub is reached through `gh api`.
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { rangeCommits } = require("./release-notes.js");
const { contents } = require("../images/base/release-contents.js");

const NEXT = "Next release";
const LATER = "Later";
const EXPECTED = /^expected:\s*(patch|minor|major)\b.*$/im;
const REPO = "repos/{owner}/{repo}";

// The one place that talks to GitHub: (method, endpoint, body) -> parsed JSON. GETs are
// paginated and flattened into one array; graphql is POST "graphql" with {query, variables}.
function ghApi(method, endpoint, body) {
  const args = ["api", "-X", method, endpoint];
  if (method === "GET") args.push("--paginate", "--slurp");
  if (body !== undefined) args.push("--input", "-");
  const r = spawnSync("gh", args, { encoding: "utf-8", input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`gh api ${method} ${endpoint} failed: ${r.error.message}`);
  if (r.status !== 0) {
    const err = new Error(`gh api ${method} ${endpoint} failed: ${(r.stderr || r.stdout).trim()}`);
    err.notFound = /HTTP 404/.test(r.stderr || "");
    throw err;
  }
  const out = r.stdout.trim();
  if (!out) return null;
  const json = JSON.parse(out);
  return method === "GET" ? (Array.isArray(json[0]) ? json.flat() : json[0]) : json;
}

const CLOSING_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { closingIssuesReferences(first: 50) { nodes { number title state repository { nameWithOwner } } } }
  }
}`;

function makeClient(api, out) {
  const writes = [];
  const send = (method, endpoint, body) => {
    writes.push(`${method} ${endpoint}`);
    return api(method, endpoint, body);
  };
  let repoName;
  return {
    writes,
    async milestones() {
      return api("GET", `${REPO}/milestones?state=all&per_page=100`);
    },
    async createMilestone(title, state, description) {
      const body = { title, state };
      if (description) body.description = description;
      out(`created milestone ${title} (${state})`);
      return send("POST", `${REPO}/milestones`, body);
    },
    async patchMilestone(m, fields) {
      return send("PATCH", `${REPO}/milestones/${m.number}`, fields);
    },
    async items(m, state) {
      return api("GET", `${REPO}/issues?milestone=${m.number}&state=${state}&per_page=100`);
    },
    async item(n) {
      try {
        return await api("GET", `${REPO}/issues/${n}`);
      } catch (e) {
        if (e.notFound) return null;
        throw e;
      }
    },
    async setMilestone(n, m) {
      return send("PATCH", `${REPO}/issues/${n}`, { milestone: m.number });
    },
    async closing(n) {
      if (!repoName) repoName = (await api("GET", REPO)).full_name;
      const [owner, name] = repoName.split("/");
      const res = await api("POST", "graphql", { query: CLOSING_QUERY, variables: { owner, name, number: n } });
      const pr = res && res.data && res.data.repository && res.data.repository.pullRequest;
      return pr ? pr.closingIssuesReferences.nodes.filter((i) => i.repository.nameWithOwner.toLowerCase() === repoName.toLowerCase()) : [];
    },
  };
}

const openNamed = (ms, title) => ms.find((m) => m.title === title && m.state === "open");
const anyNamed = (ms, title) => ms.find((m) => m.title === title);

// Puts every PR in the range, and every closed issue it closes, into `target`. An item with
// no milestone (or, when `movable` lists them, one of those milestones) is moved; an item in
// some other milestone is left alone.
async function reconcile(gh, out, target, version, opts, root, movable) {
  const commits = rangeCommits(version, opts, root);
  for (const c of commits) if (!c.pr) out(`no PR: ${c.subject}`);
  const seen = new Set();
  const place = async (n, kind, title) => {
    if (seen.has(n)) return;
    seen.add(n);
    const it = await gh.item(n);
    if (!it) return out(`warning: #${n} not found, skipped`);
    const cur = it.milestone;
    if (cur && cur.number === target.number) return;
    if (cur && !movable.includes(cur.title)) {
      if (movable.length) out(`warning: #${n} is in milestone ${cur.title}, left alone`);
      return;
    }
    await gh.setMilestone(n, target);
    out(`added #${n} (${kind}): ${title || it.title}`);
  };
  for (const c of commits) {
    if (!c.pr) continue;
    const n = Number(c.pr);
    await place(n, "pr");
    const closed = (await gh.closing(n)).filter((i) => i.state === "CLOSED");
    const titles = new Map(closed.map((i) => [i.number, i.title]));
    for (const num of contents([{ number: n, body: "", closing: closed.map((i) => i.number) }]).issues_closed) await place(num, "issue", titles.get(num));
  }
}

async function release(gh, out, version, opts, root) {
  const title = `v${version}`;
  const ms = await gh.milestones();
  let target = anyNamed(ms, title);
  const next = openNamed(ms, NEXT);
  if (target && target.state === "closed") {
    out(`${title} is already closed - reconciling only`);
    return reconcile(gh, out, target, version, opts, root, [NEXT, LATER]);
  }
  if (!target && !next) {
    out(`no ${NEXT} milestone - creating ${title} directly`);
    target = await gh.createMilestone(title, "closed");
    return reconcile(gh, out, target, version, opts, root, [NEXT, LATER]);
  }
  if (!target) {
    target = await gh.patchMilestone(next, { title });
    out(`renamed ${NEXT} to ${title}`);
  } else {
    out(`${title} exists and is open - resuming the rollover`);
  }
  let fresh = openNamed(await gh.milestones(), NEXT);
  if (!fresh) fresh = await gh.createMilestone(NEXT, "open");
  for (const it of await gh.items(target, "open")) {
    await gh.setMilestone(it.number, fresh);
    out(`carried #${it.number}: ${it.title}`);
  }
  await reconcile(gh, out, target, version, opts, root, [NEXT, LATER]);
  await gh.patchMilestone(target, { state: "closed" });
  out(`closed ${title}`);
}

async function backfill(gh, out, version, opts, root) {
  const title = `v${version}`;
  let target = anyNamed(await gh.milestones(), title);
  if (!target) target = await gh.createMilestone(title, "closed");
  await reconcile(gh, out, target, version, opts, root, []);
  if (target.state !== "closed") {
    await gh.patchMilestone(target, { state: "closed" });
    out(`closed ${title}`);
  }
}

async function plan(gh, out, version, opts, root) {
  const next = openNamed(await gh.milestones(), NEXT);
  if (!next) return out(`no open ${NEXT} milestone (a release would create v${version} directly)`);
  const m = EXPECTED.exec(next.description || "");
  out(`expected: ${m ? m[0].replace(/^expected:\s*/i, "") : "(none)"}`);
  const items = [...(await gh.items(next, "open")), ...(await gh.items(next, "closed"))].sort((a, b) => a.number - b.number);
  out(`${NEXT} items (${items.length}):`);
  for (const it of items) out(`  #${it.number} ${it.state} ${it.pull_request ? "pr" : "issue"}: ${it.title}`);
  const inMs = new Set(items.map((i) => i.number));
  const prs = [...new Set(rangeCommits(version, opts, root).filter((c) => c.pr).map((c) => Number(c.pr)))];
  const carried = [];
  for (const n of prs) carried.push({ number: n, body: "", closing: (await gh.closing(n)).filter((i) => i.state === "CLOSED").map((i) => i.number) });
  const expected = new Set([...prs, ...contents(carried).issues_closed]);
  const missing = [...expected].filter((n) => !inMs.has(n));
  const extra = items.filter((i) => !expected.has(i.number));
  const open = items.filter((i) => i.state === "open");
  out(`in the range but not in the milestone (${missing.length}):`);
  for (const n of missing) out(`  #${n}`);
  out(`in the milestone but not in the range (${extra.length}):`);
  for (const i of extra) out(`  #${i.number}: ${i.title}`);
  out(`open items (${open.length}):`);
  for (const i of open) out(`  #${i.number}: ${i.title}`);
}

const USAGE = "usage: release-milestone.js --release|--backfill|--plan X.Y.Z [--from <tag>] [--to <ref>]\n";

async function main(argv, { api = ghApi, stdout = process.stdout, stderr = process.stderr, root = path.join(__dirname, "..") } = {}) {
  const [mode, version, ...rest] = argv;
  const modes = { "--release": release, "--backfill": backfill, "--plan": plan };
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const known = rest.every((a, i) => ["--from", "--to"].includes(a) || ["--from", "--to"].includes(rest[i - 1]));
  if (/^\d+\.\d+\.\d+-/.test(version || "")) {
    stderr.write(`${version} is a prerelease; milestones are only for final releases (X.Y.Z)\n`);
    return 2;
  }
  if (!modes[mode] || !/^\d+\.\d+\.\d+$/.test(version || "") || !known) {
    stderr.write(USAGE);
    return 2;
  }
  const out = (line) => stdout.write(`${line}\n`);
  try {
    await modes[mode](makeClient(api, out), out, version, { from: flag("--from"), to: flag("--to") }, root);
    return 0;
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2), { root: process.env.RELEASE_NOTES_ROOT || undefined }).then((c) => process.exit(c));
}

module.exports = { main, ghApi, NEXT, LATER, EXPECTED };
