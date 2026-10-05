// Tests for scripts/build-skills.js (dev-system#126): doc-backed skills are generated
// with absolute links and a package.json version, and --check catches drift. Each test
// builds a throwaway repo in a temp dir, so nothing depends on the real docs' content.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "build-skills.js");
const { BLOB_BASE, buildSkill, rewriteLinks, run } = require(SCRIPT);

const ENTRY = { source: "skills/demo/SKILL.src.md", doc: "docs/guide.md", output: "skills/demo/SKILL.md" };

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function fakeRepo(t, { doc } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "package.json", JSON.stringify({ version: "9.8.7" }));
  write(root, "docs/other.md", "# Other\n");
  write(root, "templates/README.md", "# Templates\n");
  write(root, ENTRY.source, "---\nname: demo\ndescription: A demo.\n---\n\n# Demo skill\n\nPreamble.\n\n<!-- include-doc -->\n");
  write(
    root,
    ENTRY.doc,
    doc ??
      "# Guide title\n\nSee [other](other.md#a-section) and [tpl](../templates/README.md).\n" +
        "Jump to [Verify](#verify) or [site](https://example.com/x).\n\n" +
        "```md\n[not a link](nowhere.md)\n```\n\n[ref]: ../templates/README.md\n",
  );
  return root;
}

test("relative links become absolute repo URLs; anchors, URLs and code fences stay", (t) => {
  const root = fakeRepo(t);
  const out = rewriteLinks(fs.readFileSync(path.join(root, ENTRY.doc), "utf-8"), ENTRY.doc, root);
  assert.match(out, new RegExp(`\\[other\\]\\(${BLOB_BASE}docs/other\\.md#a-section\\)`));
  assert.match(out, new RegExp(`\\[tpl\\]\\(${BLOB_BASE}templates/README\\.md\\)`));
  assert.match(out, /\[Verify\]\(#verify\)/);
  assert.match(out, /\[site\]\(https:\/\/example\.com\/x\)/);
  assert.match(out, /\[not a link\]\(nowhere\.md\)/);
  assert.match(out, new RegExp(`^\\[ref\\]: ${BLOB_BASE}templates/README\\.md$`, "m"));
});

test("a link to a missing path fails the build", (t) => {
  const root = fakeRepo(t, { doc: "# T\n\n[gone](gone.md)\n" });
  assert.throws(() => buildSkill(ENTRY, { root }), /'docs\/gone\.md', which does not exist/);
});

test("output has frontmatter with the package.json version, a generated notice, and the doc without its title", (t) => {
  const root = fakeRepo(t);
  const out = buildSkill(ENTRY, { root });
  assert.match(out, /^---\nname: demo\ndescription: A demo\.\nversion: 9\.8\.7\n---\n\n<!-- GENERATED /);
  assert.match(out, /npm run build:skills/);
  assert.match(out, /# Demo skill\n\nPreamble\.\n\nSee \[other\]/);
  assert.doesNotMatch(out, /Guide title/);
  assert.doesNotMatch(out, /include-doc/);
});

test("a version: line in the source is refused", (t) => {
  const root = fakeRepo(t);
  write(root, ENTRY.source, "---\nname: demo\nversion: 1.0.0\n---\n<!-- include-doc -->\n");
  assert.throws(() => buildSkill(ENTRY, { root }), /drop the version: line/);
});

test("check mode reports drift without writing; build mode fixes it", (t) => {
  const root = fakeRepo(t);
  const quiet = () => {};
  assert.deepEqual(run({ root, skills: [ENTRY], check: true, log: quiet }), [ENTRY.output]);
  assert.equal(fs.existsSync(path.join(root, ENTRY.output)), false);

  assert.deepEqual(run({ root, skills: [ENTRY], log: quiet }), [ENTRY.output]);
  assert.deepEqual(run({ root, skills: [ENTRY], check: true, log: quiet }), []);

  fs.appendFileSync(path.join(root, ENTRY.output), "hand edit\n");
  assert.deepEqual(run({ root, skills: [ENTRY], check: true, log: quiet }), [ENTRY.output]);

  write(root, ENTRY.doc, "# T\n\nChanged.\n");
  run({ root, skills: [ENTRY], log: quiet });
  assert.deepEqual(run({ root, skills: [ENTRY], check: true, log: quiet }), []);
});

test("the committed generated skills are up to date (--check exits 0)", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
});
