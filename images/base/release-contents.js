"use strict";
// What a release carried (cbundy/dev-system#1010, part of #871): the one definition, shared by
// scripts/release-notes.js (the technical list), scripts/release-milestone.js (the milestone) and
// callum-flow-released (the `released` factory event). A release carried:
//   - the first-parent PRs since the previous final tag (release candidates never count),
//   - the issues those PRs close, and the issues they link with `Refs #N` / `Part of #N`,
//   - the headlines of its release notes: the bold title leading each bullet above "Technical
//     changes", outside the Upgrade and Verify sections.
// The image ships this file beside the tool in /usr/local/share/dev-system/. Node built-ins only;
// the only I/O is gitRangeCommits' `git log`.

const { spawnSync } = require("node:child_process");

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const MAX_HEADLINE = 200;

const core = (v) => v.replace(/^v/, "").split(/[-+]/)[0].split(".").map(BigInt);
const coreString = (v) => v.replace(/^v/, "").split(/[-+]/)[0];
const isFinal = (v) => !/^v?[^-+]+-/.test(v);

function compareVersions(a, b) {
  const [x, y] = [core(a), core(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  const pre = (v) => /^v?[^-+]+-([^+]+)/.exec(v)?.[1].split(".");
  const [p, q] = [pre(a), pre(b)];
  if (!p || !q) return p ? -1 : q ? 1 : 0;
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    const [pn, qn] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (pn && qn) {
      const [pv, qv] = [BigInt(p[i]), BigInt(q[i])];
      if (pv !== qv) return pv < qv ? -1 : 1;
    } else {
      if (pn !== qn) return pn ? -1 : 1;
      return p[i] < q[i] ? -1 : 1;
    }
  }
  return p.length - q.length;
}

// The highest final `v*` tag strictly below the core version of `version`, or null.
function previousTag(tagNames, version) {
  const tags = tagNames.filter((t) => /^v\d+\.\d+\.\d+/.test(t) && SEMVER.test(t.slice(1)) && isFinal(t));
  const target = coreString(version);
  const below = tags.filter((t) => compareVersions(t, target) < 0);
  below.sort(compareVersions);
  return below.length ? below[below.length - 1] : null;
}

// {subject, body} -> {subject, body, pr}; pr is the trailing "(#N)" of the subject, else null.
function parseCommit({ subject, body = "" }) {
  const s = subject.trim();
  const pr = (/\s\(#(\d+)\)$/.exec(s) || [])[1];
  return { subject: s, body, pr: pr || null };
}

// The first-parent commits of a git range, newest first, parsed with parseCommit.
function gitRangeCommits(root, range) {
  const r = spawnSync("git", ["log", "--first-parent", "--format=%s%x1f%b%x1e", range], { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git log --first-parent ${range} failed: ${r.stderr.trim()}`);
  const commits = [];
  for (const rec of r.stdout.split("\x1e")) {
    const [subject, body = ""] = rec.replace(/^\n/, "").split("\x1f");
    if (!subject.trim()) continue;
    commits.push(parseCommit({ subject, body }));
  }
  return commits;
}

// GitHub compare/commits-list commits ({sha, parents: [{sha}], ...}), in any order -> the ones on
// the first-parent chain from headSha, newest first. The chain ends at the first parent the list
// does not hold, so the set equals `git log --first-parent <base>..<head>`.
function firstParentChain(compareCommits, headSha) {
  const bySha = new Map(compareCommits.map((c) => [c.sha, c]));
  const chain = [];
  const seen = new Set();
  let cur = bySha.get(headSha);
  while (cur && !seen.has(cur.sha)) {
    seen.add(cur.sha);
    chain.push(cur);
    const parent = cur.parents && cur.parents[0];
    cur = parent ? bySha.get(parent.sha) : undefined;
  }
  return chain;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The issue numbers a PR body links without closing: `Refs #N` and `Part of #N`, also with this
// repo's name (`Refs owner/name#N`), case-insensitive. Another repo's reference is no match.
function prLinks(body, repo) {
  const own = repo ? `(?:${escapeRe(repo)})?` : "";
  const re = new RegExp(`(?<![\\w/-])(?:refs|part\\s+of)\\s+${own}#(\\d+)\\b`, "gi");
  const out = [];
  for (const m of String(body || "").matchAll(re)) out.push(Number(m[1]));
  return out;
}

const ascending = (set) => [...set].sort((a, b) => a - b);

// prs: [{number, body, closing}] in the order given (newest first). closing: the PR's closing
// issue references, numbers or {number, repository: {nameWithOwner}}; with `repo`, a reference
// to another repo is dropped. Returns {prs, issues_closed, issues}.
function contents(prs, repo) {
  const same = (c) => typeof c === "number" || !repo || !c.repository || String(c.repository.nameWithOwner).toLowerCase() === repo.toLowerCase();
  const numbers = [...new Set(prs.map((p) => Number(p.number)))];
  const closed = new Set();
  const linked = new Set();
  for (const p of prs) {
    for (const c of p.closing || []) if (same(c)) closed.add(typeof c === "number" ? c : Number(c.number));
    for (const n of prLinks(p.body, repo)) linked.add(n);
  }
  return { prs: numbers, issues_closed: ascending(closed), issues: ascending(new Set([...closed, ...linked])) };
}

// The headlines of a release body: each bullet's leading **Title** above the "Technical changes"
// marker, outside the Upgrade and Verify sections, trimmed and cut to 200 characters.
function headlines(releaseBody) {
  const out = [];
  let skip = false;
  for (const line of String(releaseBody || "").split("\n")) {
    if (/^\s*<details/i.test(line) || /^#+\s*technical changes/i.test(line)) break;
    const h = /^##\s+(.*?)\s*$/.exec(line);
    if (h) {
      skip = /^(upgrade|verify)$/i.test(h[1]);
      continue;
    }
    if (skip) continue;
    const m = /^\s*[-*]\s+\*\*(.+?)\*\*/.exec(line);
    if (m && m[1].trim()) out.push(m[1].trim().slice(0, MAX_HEADLINE));
  }
  return out;
}

module.exports = { compareVersions, isFinal, previousTag, parseCommit, gitRangeCommits, firstParentChain, prLinks, contents, headlines };
