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
if (args[0] === "release") {
  // gh release upload TAG FILE --clobber --repo R: record the call and keep what was uploaded.
  fs.appendFileSync(process.env.GH_FIXTURE + ".calls", args.join(" ") + "\\n");
  const hit = fx["release upload"];
  if (hit && hit.fail) { process.stderr.write(hit.fail + "\\n"); process.exit(1); }
  fs.copyFileSync(args[3], process.env.GH_FIXTURE + ".uploaded");
  process.exit(0);
}
if (key === "graphql") key = "graphql#" + JSON.parse(fs.readFileSync(0, "utf8")).variables.number;
fs.appendFileSync(process.env.GH_FIXTURE + ".calls", args.slice(1).join(" ") + "\\n");
const hit = fx[key];
if (hit === undefined) { process.stderr.write("HTTP 404: stub has no " + key + "\\n"); process.exit(1); }
if (hit && hit.fail) { process.stderr.write(hit.fail + "\\n"); process.exit(1); }
process.stdout.write(hit && hit.raw !== undefined ? hit.raw : JSON.stringify(hit));
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
  return { go, lines, dir, log, uploaded: () => (fs.existsSync(`${fxFile}.uploaded`) ? fs.readFileSync(`${fxFile}.uploaded`, "utf8") : null), calls: () => (fs.existsSync(`${fxFile}.calls`) ? fs.readFileSync(`${fxFile}.calls`, "utf8") : "") };
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

// ---- --attach (the CI side)

test("--attach uploads the dry-run payload wrapped as a released event, with --clobber, and writes no event", () => {
  const dry = run(["v0.2.0", "--repo", REPO, "--source", "workflow", "--dry-run"]).go();
  const t = run(["v0.2.0", "--repo", REPO, "--source", "workflow", "--attach"]);
  const r = t.go();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `callum-flow-released: attached factory-released.json to ${REPO} v0.2.0 (2 PRs)\n`);
  assert.equal(t.uploaded(), `${JSON.stringify({ type: "released", type_version: 1, data: JSON.parse(dry.stdout) })}\n`);
  assert.match(t.calls(), /^release upload v0\.2\.0 \S+factory-released\.json --clobber --repo o\/r$/m);
  assert.equal(fs.existsSync(path.join(t.dir, "factory")), false);
  // a re-run uploads again with --clobber (replaces the asset)
  assert.equal(t.go().status, 0);
  assert.equal(t.calls().split("\n").filter((l) => l.startsWith("release upload")).length, 2);
});

test("--attach with no GitHub Release for the tag exits 1 and uploads nothing", () => {
  const fx = fixture();
  delete fx[`repos/${REPO}/releases/tags/v0.2.0`];
  const t = run(["v0.2.0", "--repo", REPO, "--attach"], { fx });
  const r = t.go();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no GitHub Release for v0\.2\.0/);
  assert.equal(t.uploaded(), null);
});

test("--attach with a failed upload exits 1", () => {
  const r = run(["v0.2.0", "--repo", REPO, "--attach"], { fx: fixture({ "release upload": { fail: "HTTP 403: nope" } }) }).go();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nope/);
});

test("--attach with --dry-run, and --collect with a tag or --attach, exit 2", () => {
  for (const args of [["v0.2.0", "--repo", REPO, "--attach", "--dry-run"], ["--collect", "v0.2.0"], ["--collect", "--attach"], ["--collect", "--repo", "bad"]]) {
    const t = run(args);
    const r = t.go();
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(t.uploaded(), null);
  }
});

test("the composite action runs the attach mode with the repo, tag and source inputs", () => {
  const y = fs.readFileSync(path.join(ROOT, ".github", "actions", "released-event", "action.yml"), "utf8");
  assert.match(y, /^runs:\s*\n\s+using: composite/m);
  assert.match(y, /^\s+tag:\s*\n(\s+.*\n)*?\s+required: true/m);
  assert.match(y, /^\s+source:\s*\n(\s+.*\n)*?\s+default: workflow/m);
  assert.match(y, /TAG: \$\{\{ inputs\.tag \}\}/);
  assert.match(y, /SOURCE: \$\{\{ inputs\.source \}\}/);
  assert.match(y, /callum-flow-released" "\$TAG" --repo "\$GITHUB_REPOSITORY" --source "\$SOURCE" --attach/);
  const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const steps = wf.split(/^ {6}- /m);
  assert.match(steps[steps.length - 1], /uses: \.\/\.github\/actions\/released-event/);
});

// ---- --collect (the device side)

const rel = (tag, assetId, over = {}) => ({ tag_name: tag, draft: false, assets: assetId === null ? [] : [{ id: assetId, name: "factory-released.json" }], ...over });
const asset = (tag, over = {}) => ({ raw: JSON.stringify({ type: "released", type_version: 1, data: { ...EXPECTED, tag, source: "workflow" }, ...over }) });
const rawData = (tag, data) => ({ raw: JSON.stringify({ type: "released", type_version: 1, data: { ...EXPECTED, tag, ...data } }) });
const releasesKey = (repo) => `repos/${repo}/releases?per_page=20`;
const assetKey = (repo, id) => `repos/${repo}/releases/assets/${id}`;
const tagsOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("--collect writes one valid released event per release, once, and says so", () => {
  const fx = {
    [releasesKey(REPO)]: [rel("v0.2.0", 1), rel("v0.1.0", null)],
    [assetKey(REPO, 1)]: asset("v0.2.0"),
  };
  const t = run(["--collect", "--repo", REPO], { fx });
  let r = t.go();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /callum-flow-released: collect o\/r v0\.2\.0: collect \(source workflow\)/);
  const evs = t.lines().map((l) => JSON.parse(l));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "released");
  assert.equal(evs[0].data.source, "workflow");
  assert.deepEqual(reader.validateStrict("released", evs[0].type_version, evs[0].data), []);
  r = t.go();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /v0\.2\.0: skip already-logged/);
  assert.equal(t.lines().length, 1);
});

test("--collect skips a tag the log already holds (written by the loop)", () => {
  const t = run(["--collect", "--repo", REPO], { fx: { [releasesKey(REPO)]: [rel("v0.2.0", 1)], [assetKey(REPO, 1)]: asset("v0.2.0") } });
  const w = spawnSync(path.join(ROOT, "images", "base", "callum-flow-event"), ["--type", "released", "--data", JSON.stringify(EXPECTED), "--repo", REPO], { encoding: "utf8", env: { ...process.env, CALLUM_EVENTS_DIR: t.dir, DEV_VERSIONS_FILE: path.join(t.dir, "versions.json"), DEV_MACHINE_NAME: "box" } });
  assert.equal(w.status, 0, w.stderr);
  const r = t.go();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /v0\.2\.0: skip already-logged/);
  assert.equal(t.lines().length, 1);
});

test("--collect skips an unknown type_version, and collects it once the shapes know it", () => {
  const fx = { [releasesKey(REPO)]: [rel("v0.2.0", 1)], [assetKey(REPO, 1)]: asset("v0.2.0", { type_version: 2 }) };
  const t = run(["--collect", "--repo", REPO], { fx });
  let r = t.go();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /v0\.2\.0: skip unknown-version/);
  assert.equal(t.lines().length, 0);

  const shapes = JSON.parse(fs.readFileSync(path.join(ROOT, "images", "base", "factory-event-shapes.json"), "utf8"));
  shapes.schemas["released.v2"] = shapes.schemas["released.v1"];
  const f = path.join(t.dir, "shapes.json");
  fs.writeFileSync(f, JSON.stringify(shapes));
  const t2 = run(["--collect", "--repo", REPO], { fx, env: { CALLUM_EVENT_SHAPES: f } });
  r = t2.go();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /v0\.2\.0: collect/);
  assert.equal(t2.lines().length, 1);
  assert.equal(JSON.parse(t2.lines()[0]).type_version, 2);
});

test("--collect refuses a non-JSON asset, a wrong type, a tag mismatch, a bad source; ignores a draft; goes on", () => {
  const fx = {
    [releasesKey(REPO)]: [rel("v0.9.0", 1), rel("v0.8.0", 2), rel("v0.7.0", 3), rel("v0.6.0", 4), rel("v0.5.0", 5, { draft: true }), rel("v0.4.0", 6)],
    [assetKey(REPO, 1)]: { raw: "<html>not json" },
    [assetKey(REPO, 2)]: asset("v0.8.0", { type: "closed" }),
    [assetKey(REPO, 3)]: asset("v0.0.1"),
    [assetKey(REPO, 4)]: rawData("v0.6.0", { source: "bogus" }),
    [assetKey(REPO, 5)]: asset("v0.5.0"),
    [assetKey(REPO, 6)]: asset("v0.4.0"),
  };
  const t = run(["--collect", "--repo", REPO], { fx });
  const r = t.go();
  assert.equal(r.status, 0, r.stderr);
  for (const tag of ["v0.9.0", "v0.8.0", "v0.7.0", "v0.6.0"]) assert.match(r.stderr, new RegExp(`collect o/r ${tag.replace(/\./g, "\\.")}: refuse`));
  assert.doesNotMatch(r.stderr, /v0\.5\.0/);
  assert.deepEqual(t.lines().map((l) => JSON.parse(l).data.tag), ["v0.4.0"]);
});

test("--collect refuses an asset the writer refuses (a missing required field)", () => {
  const bad = JSON.parse(asset("v0.2.0").raw);
  delete bad.data.prs;
  const t = run(["--collect", "--repo", REPO], { fx: { [releasesKey(REPO)]: [rel("v0.2.0", 1)], [assetKey(REPO, 1)]: { raw: JSON.stringify(bad) } } });
  const r = t.go();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /v0\.2\.0: refuse \(the event writer refused it/);
  assert.equal(t.lines().length, 0);
});

test("--collect reads a repo whose releases fail, logs it, collects the other repo, exits 1", () => {
  const fx = {
    [releasesKey("o/bad")]: { fail: "HTTP 404: Not Found" },
    [releasesKey(REPO)]: [rel("v0.2.0", 1)],
    [assetKey(REPO, 1)]: asset("v0.2.0"),
  };
  const t = run(["--collect", "--repo", "o/bad", "--repo", REPO], { fx });
  const r = t.go();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /collect o\/bad: cannot read its releases/);
  assert.equal(t.lines().length, 1);
});

test("--collect watches FACTORY_RELEASE_REPOS and the repos of the device's own logs", () => {
  const fx = {
    [releasesKey(REPO)]: [rel("v0.2.0", 1)],
    [assetKey(REPO, 1)]: asset("v0.2.0"),
    [releasesKey("x/y")]: [rel("v1.0.0", 2)],
    [assetKey("x/y", 2)]: asset("v1.0.0"),
    [releasesKey("a/b")]: [rel("v2.0.0", 3)],
    [assetKey("a/b", 3)]: asset("v2.0.0"),
  };
  const t = run(["--collect"], { fx, env: { FACTORY_RELEASE_REPOS: "x/y, nonsense" } });
  fs.mkdirSync(path.join(t.dir, "factory"));
  fs.writeFileSync(path.join(t.dir, "factory", "a__b.jsonl"), "");
  const r = t.go();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /collect x\/y v1\.0\.0: collect/);
  assert.match(r.stderr, /collect a\/b v2\.0\.0: collect/);
  assert.doesNotMatch(r.stderr, /o\/r/);
  assert.equal(tagsOf(path.join(t.dir, "factory", "x__y.jsonl")).length, 1);
  assert.equal(tagsOf(path.join(t.dir, "factory", "a__b.jsonl")).length, 1);
});
