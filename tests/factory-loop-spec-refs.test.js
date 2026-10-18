"use strict";

// The factory loop's specification is docs/factory-loop/v2/SPEC.md, and its section 13 holds what
// the first loop's specification held that still applies. This keeps every cite of it true: no
// file names the deleted specification (a bare `SPEC 4.3`, `SPEC rule M2`, `v1 SPEC 6.1`, or a link
// or path to it), and every `v2 SPEC <ref>`, `docs/factory-loop/v2/SPEC.md <ref>` and the v2
// spec's own `section N` / `appendix X` names a heading the spec has. A list such as
// `10.3 to 10.6, 10.9` or `5.4, 11, appendix E` is read item by item; a letter range such as
// `appendices B to D` expands; a ref to a numbered item (`13.10 item 9`) resolves to its section.
//
// It also keeps every `D-NN` cite true: each one names a `### D-NN ` heading that
// docs/factory-loop/DECISIONS.md has, so a retired decision cannot be cited (the log keeps its
// numbers, and a retired number is gone).
//
// Dated evidence is left as written: release notes, changelogs, docs/spikes/ and the v2 verify
// results. A record a later change deletes is named in PENDING_DELETE, must still exist (a stale
// entry fails, so the change that deletes the file drops its entry), and is not scanned. The list
// is empty now.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SPEC_PATH = "docs/factory-loop/v2/SPEC.md";
const OLD_SPEC_PATH = "docs/factory-loop/SPEC.md";
const SELF = "tests/factory-loop-spec-refs.test.js";
const DECISIONS_PATH = "docs/factory-loop/DECISIONS.md";

// Records a pending change deletes; empty while none is pending.
const PENDING_DELETE = [];

const EXCLUDED_PREFIXES = ["release-notes/", "docs/spikes/", "scripts/factory-loop-v2-verify/results/"];

// ---- the ref parser ----------------------------------------------------------------------------

const KEYWORD = String.raw`(?:appendices|appendix|sections?)`;
const NUMBER = String.raw`\d+(?:\.\d+)*[a-z]?(?![\w-])(?:\s+items?\s+\d+)?`;
const LETTER = String.raw`[A-Z](?![\w-])`;
const ITEM = String.raw`(?:${KEYWORD}\s+)?(?:${NUMBER}|${LETTER})`;
const SEP = String.raw`(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s+to\s+|\s+or\s+)`;
const LIST = new RegExp(String.raw`^${ITEM}(?:${SEP}${ITEM})*`);
const ONE = new RegExp(String.raw`(?:(${KEYWORD})\s+)?(?:(${NUMBER})|(${LETTER}))`, "g");

// refsOf: the section numbers and appendix letters a ref list names, in order. `text` starts at the
// first item. A letter counts only after the word appendix or appendices: `D-24` is no appendix.
// ranges: a letter range expands; a number range names its two ends.
function refsOf(text) {
  const m = LIST.exec(text);
  if (m === null) return { refs: [], length: 0 };
  const refs = [];
  let appendix = false;
  let pendingRange = null;
  const tokens = m[0].split(new RegExp(`(${SEP})`));
  for (let i = 0; i < tokens.length; i += 2) {
    const item = tokens[i];
    const sep = tokens[i - 1] ?? "";
    ONE.lastIndex = 0;
    const one = ONE.exec(item);
    if (one === null) continue;
    if (one[1] !== undefined) appendix = /^appendi/.test(one[1]);
    let ref;
    if (one[3] !== undefined) {
      if (!appendix) continue;
      ref = { kind: "appendix", id: one[3] };
    } else {
      appendix = false;
      ref = { kind: "section", id: one[2].replace(/\s+items?\s+\d+$/, "") };
    }
    if (/^\s+to\s+$/.test(sep) && pendingRange !== null && pendingRange.kind === "appendix" && ref.kind === "appendix") {
      for (let c = pendingRange.id.charCodeAt(0) + 1; c < ref.id.charCodeAt(0); c++) refs.push({ kind: "appendix", id: String.fromCharCode(c) });
    }
    refs.push(ref);
    pendingRange = ref;
  }
  return { refs, length: m[0].length };
}

// headingsOf: the section numbers and appendix letters of a spec's headings.
function headingsOf(spec) {
  const sections = new Set();
  const appendices = new Set();
  for (const line of spec.split("\n")) {
    const s = /^#{2,4} (\d+(?:\.\d+)*[a-z]?)\.? /.exec(line);
    if (s !== null) sections.add(s[1]);
    const a = /^## Appendix ([A-Z])\./.exec(line);
    if (a !== null) appendices.add(a[1]);
  }
  return { sections, appendices };
}

const missing = (ref, headings) => (ref.kind === "appendix" ? !headings.appendices.has(ref.id) : !headings.sections.has(ref.id));
const label = (ref) => (ref.kind === "appendix" ? `appendix ${ref.id}` : `section ${ref.id}`);

// violationsOf: every cite in `text` that the rules refuse. `file` is the file's path in the repo,
// `headings` the v2 spec's.
function violationsOf(text, file, headings) {
  const out = [];
  const lines = text.split("\n");
  const add = (i, why) => out.push(`${file}:${i + 1}: ${why}`);
  lines.forEach((line, i) => {
    if (/\bv1 SPEC\b/.test(line)) add(i, "names `v1 SPEC`");
    if (/(?<!v2 )\bSPEC (?:rule\b|[0-9A-Z])/.test(line)) add(i, "a bare `SPEC` cite (name the section as `v2 SPEC <ref>`, or reword a retired rule)");
    const named = /factory-loop\/SPEC\.md/.test(line);
    if (named) add(i, `names ${OLD_SPEC_PATH}, which is deleted`);
    for (const link of named ? [] : line.matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), link[1]));
      if (target === OLD_SPEC_PATH) add(i, `links to ${OLD_SPEC_PATH}, which is deleted`);
    }
    // v2 SPEC <ref>, docs/factory-loop/v2/SPEC.md <ref>
    for (const m of line.matchAll(/(?:\bv2 SPEC|(?:docs\/factory-loop\/)?\bv2\/SPEC\.md)\s+(?=(?:(?:appendices|appendix|sections?)\s+)?[\dA-Z])/g)) {
      const { refs } = refsOf(line.slice(m.index + m[0].length));
      for (const ref of refs) if (missing(ref, headings)) add(i, `\`${m[0].trim()} ${ref.id}\` names no ${label(ref)} heading in ${SPEC_PATH}`);
    }
    // the v2 spec's own prose
    if (file === SPEC_PATH) {
      let consumed = 0;
      for (const m of line.matchAll(/(?<![A-Z][A-Z0-9]+\s)(?<![\w-])\b(?:[Ss]ections?|[Aa]ppendices|[Aa]ppendix)\s+(?=[\dA-Z])/g)) {
        if (m.index < consumed) continue;
        const { refs, length } = refsOf(line.slice(m.index));
        consumed = m.index + length;
        for (const ref of refs) if (missing(ref, headings)) add(i, `\`${m[0].trim()}\` names no ${label(ref)} heading`);
      }
    }
  });
  return out;
}

// decisionsOf: the numbers of the `### D-NN ` headings in a DECISIONS.md text.
const decisionsOf = (text) => new Set([...text.matchAll(/^### D-(\d{2}) /gm)].map((m) => m[1]));

// decisionProblemsOf: every `D-NN` cite in `text` that names no heading in `decisions`.
function decisionProblemsOf(text, file, decisions) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\bD-(\d{2})\b/g)) {
      if (!decisions.has(m[1])) out.push(`${file}:${i + 1}: cites D-${m[1]}, which ${DECISIONS_PATH} has no heading for`);
    }
  });
  return out;
}

// ---- the scan ----------------------------------------------------------------------------------

const pending = (file, list = PENDING_DELETE) => list.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
const excluded = (file) =>
  file === SELF || EXCLUDED_PREFIXES.some((p) => file.startsWith(p)) || /(^|\/)CHANGELOG[^/]*$/.test(file) || pending(file);

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter((f) => f !== "" && fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());
}

// stale: the entries of a PENDING_DELETE list that no longer exist on disk (a directory entry must be
// a directory).
function stale(list) {
  return list.filter((entry) => {
    const full = path.join(ROOT, entry);
    return !fs.existsSync(full) || (entry.endsWith("/") && !fs.statSync(full).isDirectory());
  });
}

test("every PENDING_DELETE entry still exists, so the child that deletes it drops the entry", () => {
  assert.deepEqual(stale(PENDING_DELETE), [], "PENDING_DELETE names files that are gone: drop those entries");
});

test("the old specification is deleted, and no tracked file cites it or a missing section of the v2 spec", () => {
  assert.equal(fs.existsSync(path.join(ROOT, OLD_SPEC_PATH)), false, `${OLD_SPEC_PATH} still exists`);
  const headings = headingsOf(fs.readFileSync(path.join(ROOT, SPEC_PATH), "utf8"));
  const problems = [];
  for (const file of trackedFiles()) {
    if (excluded(file)) continue;
    const buf = fs.readFileSync(path.join(ROOT, file));
    if (buf.includes(0)) continue;
    problems.push(...violationsOf(buf.toString("utf8"), file, headings));
  }
  assert.deepEqual(problems, [], `${problems.length} cite(s) of the specification do not hold:\n${problems.join("\n")}`);
});

test("every D-NN cite in a tracked file names a heading in DECISIONS.md", () => {
  const decisions = decisionsOf(fs.readFileSync(path.join(ROOT, DECISIONS_PATH), "utf8"));
  assert.ok(decisions.size > 0, `${DECISIONS_PATH} has no \`### D-NN \` headings`);
  const problems = [];
  for (const file of trackedFiles()) {
    if (excluded(file)) continue;
    const buf = fs.readFileSync(path.join(ROOT, file));
    if (buf.includes(0)) continue;
    problems.push(...decisionProblemsOf(buf.toString("utf8"), file, decisions));
  }
  assert.deepEqual(problems, [], `${problems.length} D-NN cite(s) name no decision:\n${problems.join("\n")}`);
});

// ---- the parser and the rules, on inline fixtures ------------------------------------------------

const FIXTURE_HEADINGS = headingsOf(
  ["## 4. Steps", "### 4.3 The table", "## 10. Workspaces", "### 10.3 A", "### 10.4 B", "### 10.5 C", "### 10.6 D", "### 10.9 E", "## 13. The foundation", "#### 13.4.3 Control", "### 13.10 Failure", "#### 13.7.3a Answers", "## Appendix B. Kinds", "## Appendix C. Keys", "## Appendix D. Labels", "## Appendix E. Ops", "## 5. Unknown", "### 5.4 Triage", "## 11. Releases", ""].join("\n"),
);
const problemsOf = (text, file = "plugins/x.ts") => violationsOf(text, file, FIXTURE_HEADINGS);

test("the rules refuse a bare cite, a v1 cite, a rule id, a link to the old specification and a missing section", () => {
  assert.equal(problemsOf("// see SPEC 4.3").length, 1);
  assert.equal(problemsOf("// v1 SPEC 6.1").length >= 1, true);
  assert.equal(problemsOf("// SPEC M2 holds the merge").length, 1);
  assert.equal(problemsOf("// SPEC rule G3").length, 1);
  assert.equal(problemsOf("// (SPEC A1)").length, 1);
  assert.equal(problemsOf("see docs/factory-loop/SPEC.md").length, 1);
  assert.equal(problemsOf("[spec](../factory-loop/SPEC.md#54)", "docs/x/README.md").length, 1);
  assert.equal(problemsOf("[spec](SPEC.md)", "docs/factory-loop/README.md").length, 1);
  assert.equal(problemsOf("// v2 SPEC 13.99").length, 1);
  assert.equal(problemsOf("// v2 SPEC 13.4.3, 13.99").length, 1);
  assert.equal(problemsOf("// docs/factory-loop/v2/SPEC.md 7.7").length, 1);
  assert.equal(problemsOf("// v2 SPEC appendices B to F").length, 1);
  assert.equal(problemsOf("see section 77 and appendix F", SPEC_PATH).length, 2);
});

test("the rules accept what holds", () => {
  assert.deepEqual(problemsOf("// v2 SPEC 13.4.3"), []);
  assert.deepEqual(problemsOf("// v2 SPEC 13.10 item 9"), []);
  assert.deepEqual(problemsOf("// v2 SPEC 13.7.3a item 7."), []);
  assert.deepEqual(problemsOf("// v2 SPEC 10.3 to 10.6, 10.9"), []);
  assert.deepEqual(problemsOf("// v2 SPEC 5.4, 11, appendix E"), []);
  assert.deepEqual(problemsOf("// v2 SPEC appendices B to D"), []);
  assert.deepEqual(problemsOf("// v2 SPEC section 4, D-24"), []);
  assert.deepEqual(problemsOf("// docs/factory-loop/v2/SPEC.md 4.3"), []);
  assert.deepEqual(problemsOf("// the retired v1 merge rule M2 (no cite)"), []);
  assert.deepEqual(problemsOf("see [spec](v2/SPEC.md#13-the-foundation)", "docs/factory-loop/README.md"), []);
  assert.deepEqual(problemsOf("FM section 99 and G2 section 1, sections 4 to 10, section 13, appendix B.", SPEC_PATH), []);
});

test("the ref parser reads a list item by item", () => {
  assert.deepEqual(refsOf("10.3 to 10.6, 10.9 and more").refs.map((r) => r.id), ["10.3", "10.6", "10.9"]);
  assert.deepEqual(refsOf("5.4, 11, appendix E.").refs.map(label), ["section 5.4", "section 11", "appendix E"]);
  assert.deepEqual(refsOf("appendices B to D").refs.map(label), ["appendix B", "appendix C", "appendix D"]);
  assert.deepEqual(refsOf("13.10 item 9, and 4.3").refs.map((r) => r.id), ["13.10", "4.3"]);
  assert.deepEqual(refsOf("4.3, D-24").refs.map(label), ["section 4.3"]);
});

test("a stale PENDING_DELETE entry is caught, and only a listed file is left unscanned", () => {
  const listed = ["docs/factory-loop/v2/SPEC.md", "docs/factory-loop/no-such-record.md", "docs/factory-loop/no-such-dir/"];
  assert.deepEqual(stale(listed), ["docs/factory-loop/no-such-record.md", "docs/factory-loop/no-such-dir/"]);
  assert.equal(pending("docs/factory-loop/no-such-record.md", listed), true, "a listed file is left unscanned");
  assert.equal(pending("docs/factory-loop/no-such-dir/x.md", listed), true, "a file under a listed directory is left unscanned");
  assert.equal(pending("docs/factory-loop/v2/OTHER.md", listed), false, "an entry the list lacks is scanned");
  assert.equal(excluded("docs/spikes/reconcile-mod/README.md"), true);
  assert.equal(excluded("plugins/factory-loop/CHANGELOG.md"), true);
  assert.equal(excluded("plugins/factory-loop/README.md"), false);
});

test("the D-NN check catches a missing number and accepts a present one", () => {
  const decisions = decisionsOf("# Log\n\n### D-24 Rate caps\n\ntext D-99 inside a body is no heading\n\n### D-74 Answers (owner call)\n");
  assert.deepEqual([...decisions].sort(), ["24", "74"]);
  assert.deepEqual(decisionProblemsOf("// see D-24 and D-74", "plugins/x.ts", decisions), []);
  assert.deepEqual(decisionProblemsOf("a\n// see D-99", "plugins/x.ts", decisions), [
    "plugins/x.ts:2: cites D-99, which docs/factory-loop/DECISIONS.md has no heading for",
  ]);
  assert.equal(decisionProblemsOf("D-24, D-13 and D-02", "x.md", decisions).length, 2);
  assert.deepEqual(decisionProblemsOf("D-240 and AD-24x and D-5", "x.md", decisions), [], "only a whole two-digit D-NN is a cite");
});
