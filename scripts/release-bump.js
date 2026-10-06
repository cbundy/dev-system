#!/usr/bin/env node
// Bumps the whole system to one release version, in a normal PR, so a release never pushes
// to main (cbundy/dev-system#147). It sets `version` in every
// plugins/*/.claude-plugin/plugin.json, the `version:` frontmatter field of every
// plugins/*/skills/*/SKILL.md (replaced if present, appended if missing) and the root
// package.json, then refreshes this repo's own template stamp with
// `node bin/callum-dev.js update`. The Release workflow runs --check against the version
// it is asked to tag and refuses to tag a tree that was not bumped first.
//
//   node scripts/release-bump.js X.Y.Z           bump every version and refresh the stamp
//   node scripts/release-bump.js --check X.Y.Z   exit 1 if any of them is not at X.Y.Z
//
// Node built-ins only.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
// Same pattern release.yml validated with before this script existed.
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const STAMP_FILE = ".callum-dev.json";

const subdirs = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(dir, d.name))
    : [];

// Every versioned file, as { file (repo-relative), kind: "json" | "skill" }.
function versionedFiles(root = REPO_ROOT) {
  const files = [];
  for (const pluginDir of subdirs(path.join(root, "plugins"))) {
    const manifest = path.join(pluginDir, ".claude-plugin", "plugin.json");
    if (fs.existsSync(manifest)) files.push({ file: manifest, kind: "json" });
    for (const skillDir of subdirs(path.join(pluginDir, "skills"))) {
      const skill = path.join(skillDir, "SKILL.md");
      if (fs.existsSync(skill)) files.push({ file: skill, kind: "skill" });
    }
  }
  files.push({ file: path.join(root, "package.json"), kind: "json" });
  return files.map((f) => ({ ...f, file: path.relative(root, f.file) }));
}

function frontmatter(src, file) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`${file}: no frontmatter block found`);
  return m;
}

// The version a file currently carries, or null when it has none.
function readVersion(root, { file, kind }) {
  const src = fs.readFileSync(path.join(root, file), "utf-8");
  if (kind === "json") return JSON.parse(src).version ?? null;
  const v = frontmatter(src, file)[1].match(/^version:\s*(.*)$/m);
  return v ? v[1].trim() : null;
}

function writeVersion(root, { file, kind }, version) {
  const abs = path.join(root, file);
  const src = fs.readFileSync(abs, "utf-8");
  if (kind === "json") {
    const pkg = JSON.parse(src);
    pkg.version = version;
    fs.writeFileSync(abs, JSON.stringify(pkg, null, 2) + "\n");
    return;
  }
  const m = frontmatter(src, file);
  const body = /^version:/m.test(m[1])
    ? m[1].replace(/^version:.*$/m, `version: ${version}`)
    : m[1] + `\nversion: ${version}`;
  fs.writeFileSync(abs, src.replace(m[0], `---\n${body}\n---`));
}

function validate(version) {
  if (!SEMVER.test(version ?? "")) {
    throw new Error(`'${version}' is not a valid semantic version (expected e.g. 1.2.3)`);
  }
}

// Runs this repo's own CLI in a separate process: it reads package.json at require time,
// so it must start after the bump. Returns the exit status.
function runUpdate(root) {
  const result = spawnSync(process.execPath, [path.join(root, "bin", "callum-dev.js"), "update"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Sets every versioned file to `version`, then refreshes the stamp. Throws on failure.
function bump(version, { root = REPO_ROOT, update = runUpdate, log = console.log } = {}) {
  validate(version);
  for (const entry of versionedFiles(root)) {
    writeVersion(root, entry, version);
    log(`release-bump: bumped ${entry.file}`);
  }
  const status = update(root);
  if (status !== 0) {
    throw new Error(
      `'node bin/callum-dev.js update' exited ${status}: resolve the conflicts it reported, ` +
        "then commit the bump and the stamp refresh together",
    );
  }
}

// Returns one "file: has A, expected X" line per file not at `version`, the stamp included.
function check(version, { root = REPO_ROOT } = {}) {
  validate(version);
  const mismatches = [];
  for (const entry of versionedFiles(root)) {
    const have = readVersion(root, entry);
    if (have !== version) mismatches.push(`${entry.file}: has ${have ?? "no version"}, expected ${version}`);
  }
  const stampPath = path.join(root, STAMP_FILE);
  const stamp = fs.existsSync(stampPath) ? JSON.parse(fs.readFileSync(stampPath, "utf-8")).version : undefined;
  if (stamp !== version) mismatches.push(`${STAMP_FILE}: has ${stamp ?? "no version"}, expected ${version}`);
  return mismatches;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const checkMode = args[0] === "--check";
  const version = checkMode ? args[1] : args[0];
  try {
    if (args.length !== (checkMode ? 2 : 1)) {
      throw new Error("usage: node scripts/release-bump.js [--check] X.Y.Z");
    }
    if (checkMode) {
      const mismatches = check(version);
      if (mismatches.length > 0) {
        for (const line of mismatches) console.error(`release-bump: ${line}`);
        process.exit(1);
      }
    } else {
      bump(version);
    }
  } catch (err) {
    console.error(`release-bump: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { SEMVER, STAMP_FILE, versionedFiles, readVersion, bump, check };
