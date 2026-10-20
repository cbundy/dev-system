// Tests for images/base/callum-flow-released (dev-system#1010): the real script with a `gh` stub on
// PATH, writing through the real callum-flow-event into a scratch events dir. The written event is
// checked strictly against released.v1 by the shared reader (the producer fixture).
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { register } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The plugin's modules import each other without a file extension; plain Node needs the ".ts".
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

const ROOT = path.join(__dirname, "..");
const TOOL = path.join(ROOT, "images", "base", "callum-flow-released");
const READER = path.join(ROOT, "plugins", "factory-loop", "hooks", "v2", "event-reader.ts");

let reader;
let tmp;
let n = 0;

before(async () => {
  reader = await import(READER);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callum-flow-released-"));
  // The gh stub: GH_FIXTURE is a JSON file mapping an endpoint (or "graphql#<pr>") to the JSON gh
  // would print (already --slurp shaped), or to {"fail": "<stderr>"}. It records every call.
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.writeFileSync(
    path.join(tmp, "bin", "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const fx = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, "utf8"));
const args = process.argv.slice(2);
let key = args[3];
if (key === "graphql") key = "graphql#" + JSON.parse(fs.readFileSync(0, "utf8")).variables.number;
fs.appendFileSync(process.env.GH_FIXTURE + ".calls", args.slice(1).join(" ") + "\\n");
const hit = fx[key];
if (hit === undefined) { process.stderr.write("HTTP 404: stub has no " + key + "\\n"); process.exit(1); }
if (hit && hit.fail) { process.stderr.write(hit.fail + "\\n"); process.exit(1); }
process.stdout.write(JSON.stringify(hit));
`,
    { mode: 0o755 },
  );
});
after(() => {
  if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true });
});

const REPO = "o/r";
const SHA = (c) => c.repeat(40);
const commit = (sha, parent, message) => ({ sha, parents: parent ? [{ sha: parent }] : [], commit: { message } });
const merge = (sha, parents, message) => ({ sha, parents: parents.map((p) => ({ sha: p })), commit: { message } });
const gql = (body, closing) => ({ data: { repository: { pullRequest: { body, closingIssuesReferences: { nodes: closing } } } } });
const RELEASE_BODY = "## New\n\n- **First thing** - d ([#11](u))\n- **Second thing** - d\n\n## Upgrade\n\n- **Not a headline** - x\n\n<details>\n<summary>Technical changes</summary>\n- **Nope**\n</details>\n";

// v0.2.0 = merge(#12 chain, side); #11 and #12 are on the first-parent chain, #99 is not.
function fixture(over = {}) {
  return {
    [`repos/${REPO}/commits/v0.2.0`]: [{ sha: SHA("d"), commit: { committer: { date: "2026-10-19T01:02:03Z" } } }],
    [`repos/${REPO}/git/matching-refs/tags/v?per_page=100`]: [[{ ref: "refs/tags/v0.1.0" }, { ref: "refs/tags/v0.2.0-rc.1" }, { ref: "refs/tags/v0.2.0" }]],
    [`repos/${REPO}/compare/v0.1.0...v0.2.0?per_page=100`]: [
      { commits: [commit(SHA("a"), SHA("0"), "first (#11)"), commit(SHA("b"), SHA("a"), "second (#12)"), commit(SHA("c"), SHA("0"), "side (#99)")] },
      { commits: [merge(SHA("d"), [SHA("b"), SHA("c")], "Merge branch side")] },
    ],
    "graphql#11": gql("Refs #5", [{ number: 3, repository: { nameWithOwner: REPO } }]),
    "graphql#12": gql("Part of #6\nrefs o/r#3", [{ number: 4, repository: { nameWithOwner: REPO } }, { number: 8, repository: { nameWithOwner: "x/y" } }]),
    [`repos/${REPO}/releases/tags/v0.2.0`]: [{ body: RELEASE_BODY }],
    ...over,
  };
}

function run(args, { fx = fixture(), env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, `d${n++}-`));
  const fxFile = path.join(dir, "fixture.json");
  fs.writeFileSync(fxFile, JSON.stringify(fx));
  const versions = path.join(dir, "versions.json");
  fs.writeFileSync(versions, JSON.stringify({ base_image: "1", dev_image: "1", template_version: "1", plugin_version: "1" }));
  const go = () =>
    spawnSync(process.execPath, [TOOL, ...args], {
      encoding: "utf8",
      env: { PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`, GH_FIXTURE: fxFile, CALLUM_EVENTS_DIR: dir, DEV_VERSIONS_FILE: versions, DEV_MACHINE_NAME: "box", ...env },
    });
  const log = path.join(dir, "factory", "o__r.jsonl");
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { go, lines, dir, log, calls: () => (fs.existsSync(`${fxFile}.calls`) ? fs.readFileSync(`${fxFile}.calls`, "utf8") : "") };
}

const EXPECTED = {
  tag: "v0.2.0", previous_tag: "v0.1.0", commit: SHA("d"), released_at: "2026-10-19T01:02:03Z",
  prs: [12, 11], issues: [3, 4, 5, 6], issues_closed: [3, 4], headlines: ["First thing", "Second thing"], source: "manual",
};

test("--dry-run prints the payload as one JSON line and writes nothing", () => {
  const t = run(["v0.2.0", "--repo", REPO, "--dry-run"]);
  const r = t.go();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(r.stdout), EXPECTED);
  assert.equal(fs.existsSync(path.join(t.dir, "factory")), false);
});

test("a write appends one released event that validates strictly; a second run skips it", () => {
  const t = run(["v0.2.0", "--repo", REPO, "--source", "workflow"]);
  let r = t.go();
  assert.equal(r.status, 0, r.stderr);
  const lines = t.lines();
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.type, "released");
  assert.deepEqual(e.data, { ...EXPECTED, source: "workflow" });
  assert.deepEqual(reader.validateStrict("released", e.type_version, e.data), []);

  r = t.go();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`callum-flow-released: v0.2.0 already written as ${e.event_id}, skipped`));
  assert.equal(t.lines().length, 1);
});

test("the repo falls back to CALLUM_FLOW_REPO", () => {
  const t = run(["v0.2.0", "--dry-run"], { env: { CALLUM_FLOW_REPO: REPO } });
  const r = t.go();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), EXPECTED);
});

test("a failed GitHub read exits 1 and writes nothing", () => {
  const t = run(["v0.2.0", "--repo", REPO], { fx: fixture({ [`repos/${REPO}/compare/v0.1.0...v0.2.0?per_page=100`]: { fail: "HTTP 500: boom" } }) });
  const r = t.go();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /boom/);
  assert.equal(fs.existsSync(t.log), false);
});

test("usage errors exit 2: no tag, a bad source, a bad repo, an unknown flag", () => {
  for (const args of [[], ["v0.2.0", "--source", "bogus"], ["v0.2.0", "--repo", "nope"], ["v0.2.0", "--bogus"], ["v0.2.0", "extra"]]) {
    const t = run(args);
    const r = t.go();
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /usage: callum-flow-released/);
    assert.equal(fs.existsSync(path.join(t.dir, "factory")), false);
  }
});

test("--help prints usage and exits 0", () => {
  const r = run(["--help"]).go();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: callum-flow-released /);
});

test("a missing GitHub Release gives empty headlines and one note, not a failure", () => {
  const fx = fixture();
  delete fx[`repos/${REPO}/releases/tags/v0.2.0`];
  const r = run(["v0.2.0", "--repo", REPO, "--dry-run"], { fx }).go();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).headlines, []);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.match(r.stderr, /no GitHub Release/);
});

test("with no previous tag, previous_tag is null and the commit list is read", () => {
  const fx = fixture();
  delete fx[`repos/${REPO}/compare/v0.1.0...v0.2.0?per_page=100`];
  fx[`repos/${REPO}/git/matching-refs/tags/v?per_page=100`] = [[{ ref: "refs/tags/v0.2.0" }]];
  fx[`repos/${REPO}/commits?sha=v0.2.0&per_page=100`] = [[
    merge(SHA("d"), [SHA("b"), SHA("c")], "Merge branch side"),
    commit(SHA("c"), null, "side (#99)"),
    commit(SHA("b"), SHA("a"), "second (#12)"),
    commit(SHA("a"), null, "first (#11)"),
  ]];
  const r = run(["v0.2.0", "--repo", REPO, "--dry-run"], { fx }).go();
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.previous_tag, null);
  assert.deepEqual(p.prs, [12, 11]);
});
