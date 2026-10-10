#!/usr/bin/env node
// Validates and assembles the release notes (cbundy/dev-system#291). Each release has one
// hand-curated file, release-notes/vX.Y.Z.md, written with the `release` skill and
// reviewed in the bump PR. This script checks that file and builds the published body:
// the curated notes, then a collapsed "Technical changes" list built from the commits
// since the previous release tag.
//
//   node scripts/release-notes.js --check X.Y.Z      exit 1 unless the notes exist and are valid
//   node scripts/release-notes.js --lint             validate every notes file, and require
//                                                    notes for the root package.json version
//   node scripts/release-notes.js --body X.Y.Z [--from <prev-tag>] [--to <ref>]
//                                                    print the release body to stdout
//
// Node built-ins only.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const NOTES_DIR = "release-notes";
const REPO_URL = "https://github.com/cbundy/dev-system";
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
// "Fits on one screen": the cap on the notes file's lines, blank lines included.
const MAX_LINES = 40;
const HEADINGS = ["Breaking", "New", "Changed", "Fixed", "Upgrade"];
const ITEM_HEADINGS = HEADINGS.slice(0, 4);
const PR_LINK = /\[#\d+\]\(https:\/\/github\.com\/cbundy\/dev-system\/pull\/\d+\)/;
const BULLET = /^- \*\*[^*]+\*\* - \S/;

const notesPath = (version) => `${NOTES_DIR}/v${version}.md`;
const hint = (version) => `write it with the \`release\` skill (.claude/skills/release/SKILL.md)${version ? ` for v${version}` : ""}`;

// Returns the list of problems with one notes file's text (empty when valid).
function validateNotes(text, file = "release-notes") {
  const errors = [];
  const err = (msg) => errors.push(`${file}: ${msg}`);
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length > MAX_LINES) err(`${lines.length} lines, over the ${MAX_LINES}-line cap (notes must fit on one screen)`);
  if (/<details/i.test(text)) err("contains a <details> block; the technical list is added when the body is built");
  if (/^#+\s*technical changes/im.test(text)) err('contains a "Technical changes" heading; it is added when the body is built');

  const sections = [];
  let current = null;
  lines.forEach((line, i) => {
    const h = /^##\s+(.*?)\s*$/.exec(line);
    if (h) {
      current = { name: h[1], line: i + 1, items: 0 };
      sections.push(current);
      return;
    }
    if (/^#\s/.test(line) || /^#{3,}\s/.test(line)) err(`line ${i + 1}: only "##" headings are allowed (${HEADINGS.join(", ")})`);
    if (/^\s*[-*]\s/.test(line) && current) {
      current.items += 1;
      if (current.name !== "Upgrade") {
        if (!BULLET.test(line)) err(`line ${i + 1}: item must look like "- **Title** - description ([#N](${REPO_URL}/pull/N))"`);
        if (!PR_LINK.test(line)) err(`line ${i + 1}: item has no PR link ([#N](${REPO_URL}/pull/N))`);
      }
    } else if (line.trim() && !h && !current) {
      err(`line ${i + 1}: text before the first "##" heading`);
    }
  });

  let last = -1;
  for (const s of sections) {
    const idx = HEADINGS.indexOf(s.name);
    if (idx < 0) err(`line ${s.line}: unknown heading "${s.name}" (allowed: ${HEADINGS.join(", ")})`);
    else if (idx <= last) err(`line ${s.line}: heading "${s.name}" is duplicated or out of order (order: ${HEADINGS.join(", ")})`);
    else last = idx;
    if (idx >= 0 && s.items === 0) err(`line ${s.line}: empty "${s.name}" group; leave it out`);
  }
  if (!sections.some((s) => ITEM_HEADINGS.includes(s.name))) err(`needs at least one of: ${ITEM_HEADINGS.join(", ")}`);
  if (!sections.some((s) => s.name === "Upgrade")) err('needs an "Upgrade" section');
  return errors;
}

function checkVersion(version, root = REPO_ROOT) {
  if (!SEMVER.test(version || "")) return [`'${version}' is not a valid semantic version`];
  const rel = notesPath(version);
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return [`${rel}: missing; ${hint(version)}`];
  return validateNotes(fs.readFileSync(file, "utf-8"), rel).map((e) => `${e} (see the release skill)`);
}

function lint(root = REPO_ROOT) {
  const errors = [];
  const dir = path.join(root, NOTES_DIR);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  for (const f of files) {
    const m = /^v(.+)\.md$/.exec(f);
    if (!m || !SEMVER.test(m[1])) errors.push(`${NOTES_DIR}/${f}: name must be vX.Y.Z.md`);
    else errors.push(...validateNotes(fs.readFileSync(path.join(dir, f), "utf-8"), `${NOTES_DIR}/${f}`));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
  if (!files.includes(`v${pkg.version}.md`)) errors.push(`${notesPath(pkg.version)}: missing for package.json version ${pkg.version}; ${hint(pkg.version)}`);
  return errors;
}

const core = (v) => v.replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number);
function compareVersions(a, b) {
  const [x, y] = [core(a), core(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  const pre = (v) => /^v?[^-+]+-/.test(v);
  return pre(a) === pre(b) ? 0 : pre(a) ? -1 : 1;
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

// The highest v* semver tag strictly below `version`, or null.
function previousTag(version, root = REPO_ROOT) {
  const tags = git(root, ["tag", "--list", "v*"]).split("\n").filter((t) => /^v\d+\.\d+\.\d+/.test(t) && SEMVER.test(t.slice(1)));
  const below = tags.filter((t) => compareVersions(t, version) < 0);
  below.sort(compareVersions);
  return below.length ? below[below.length - 1] : null;
}

// Parses first-parent squash subjects `type(scope)!: subject (#N)` into groups.
function technicalChanges(version, { from, to } = {}, root = REPO_ROOT) {
  const prev = from === undefined ? previousTag(version, root) : from;
  let target = to;
  if (!target) {
    const hasTag = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/v${version}`], { cwd: root }).status === 0;
    target = hasTag ? `v${version}` : "HEAD";
  }
  const range = prev ? `${prev}..${target}` : target;
  const raw = git(root, ["log", "--first-parent", "--format=%s%x1f%b%x1e", range]);
  const groups = { Breaking: [], Enhancements: [], Fixes: [], Maintenance: [] };
  for (const rec of raw.split("\x1e")) {
    const [subject, body = ""] = rec.replace(/^\n/, "").split("\x1f");
    if (!subject.trim()) continue;
    const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.*?)(?:\s+\(#(\d+)\))?$/.exec(subject.trim());
    const type = m ? m[1] : null;
    const text = m ? (m[2] ? `${m[2]}: ${m[4]}` : m[4]) : subject.trim().replace(/\s+\(#\d+\)$/, "");
    const pr = m ? m[5] : (/\(#(\d+)\)$/.exec(subject.trim()) || [])[1];
    const entry = `- ${text}${pr ? ` ([#${pr}](${REPO_URL}/pull/${pr}))` : ""}`;
    const breaking = (m && m[3]) || /^BREAKING[ -]CHANGE/m.test(body);
    const group = breaking ? "Breaking" : type === "feat" ? "Enhancements" : type === "fix" ? "Fixes" : "Maintenance";
    groups[group].push(entry);
  }
  return groups;
}

function buildBody(version, opts = {}, root = REPO_ROOT) {
  const errors = checkVersion(version, root);
  if (errors.length) throw new Error(errors.join("\n"));
  const notes = fs.readFileSync(path.join(root, notesPath(version)), "utf-8").replace(/\n+$/, "");
  const groups = technicalChanges(version, opts, root);
  const parts = Object.entries(groups).filter(([, e]) => e.length).map(([name, e]) => `### ${name}\n\n${e.join("\n")}`);
  if (!parts.length) return `${notes}\n`;
  return `${notes}\n\n<details>\n<summary>Technical changes</summary>\n\n${parts.join("\n\n")}\n\n</details>\n`;
}

function main(argv) {
  // RELEASE_NOTES_ROOT lets the tests point the CLI at a throwaway repo.
  const root = process.env.RELEASE_NOTES_ROOT || REPO_ROOT;
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const fail = (errors) => {
    for (const e of errors) process.stderr.write(`${e}\n`);
    return 1;
  };
  if (cmd === "--check") {
    const errors = checkVersion(rest[0], root);
    if (errors.length) return fail(errors);
    process.stdout.write(`release notes for v${rest[0]} are valid\n`);
    return 0;
  }
  if (cmd === "--lint") {
    const errors = lint(root);
    return errors.length ? fail(errors) : 0;
  }
  if (cmd === "--body") {
    try {
      process.stdout.write(buildBody(rest[0], { from: flag("--from"), to: flag("--to") }, root));
      return 0;
    } catch (e) {
      return fail([e.message]);
    }
  }
  process.stderr.write("usage: release-notes.js --check X.Y.Z | --lint | --body X.Y.Z [--from <tag>] [--to <ref>]\n");
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { validateNotes, checkVersion, lint, previousTag, technicalChanges, buildBody, MAX_LINES };
