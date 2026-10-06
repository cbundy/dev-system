// node:test reporter for `npm test` (scripts/test.sh): silent for passing tests, and for
// each failure prints only what is needed to act on it - the test name, the file:line in
// this repo the failure comes from, and the assertion message (with its diff). Output a
// test writes is printed only when that test file has a failure.
//
// Its last line is always `node-tests: <total> total, <failed> failed`, which scripts/test.sh
// reads for its one-line summary.
//
// Usage: node --test --test-reporter=./scripts/test-reporter.js tests/*.test.js
// Node built-ins only; works on Node 20 (CI) and later.
"use strict";

const path = require("node:path");
const { fileURLToPath } = require("node:url");

const ROOT = path.resolve(__dirname, "..");

// The first stack frame that points into this repo (not node internals or node_modules),
// as a repo-relative file:line.
function repoFrame(stack) {
  for (const line of String(stack || "").split("\n")) {
    const m = line.match(/\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?\s*$/);
    if (!m) continue;
    const file = m[1].startsWith("file://") ? fileURLToPath(m[1]) : m[1];
    if (!file.startsWith(ROOT + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    return `${path.relative(ROOT, file)}:${m[2]}`;
  }
  return null;
}

// A test file as a repo-relative path. Events name it relative to the cwd or absolute,
// depending on the event and the Node version.
function relFile(file) {
  if (!file) return "";
  return path.relative(ROOT, path.resolve(file.startsWith("file://") ? fileURLToPath(file) : file));
}

function relLocation(data) {
  if (!data.file) return null;
  return data.line ? `${relFile(data.file)}:${data.line}` : relFile(data.file);
}

// Output a failing test file wrote, without node-internal stack frames.
function cleanOutput(out) {
  return out
    .split("\n")
    .filter((l) => !/^\s*at (?:.*\()?node:/.test(l))
    .join("\n")
    .trimEnd();
}

function describeFailure(data) {
  const err = data.details?.error;
  // The real error is the cause; the outer one is node:test's wrapper.
  const cause = err?.cause ?? err;
  const where = repoFrame(cause?.stack) ?? relLocation(data) ?? "<unknown location>";
  let message;
  if (cause instanceof Error || (cause && typeof cause.message === "string")) {
    message = cause.message;
  } else if (cause !== undefined) {
    message = String(cause);
  } else {
    message = err?.message ?? "failed";
  }
  const indented = message.trimEnd().split("\n").map((l) => `    ${l}`).join("\n");
  return `FAIL ${data.name}\n  at ${where}\n${indented}\n`;
}

module.exports = async function* reporter(source) {
  const counts = {};
  const output = new Map(); // test file -> captured stdout/stderr
  const failedFiles = new Set();
  let failures = "";

  for await (const event of source) {
    const { type, data } = event;
    if (type === "test:stdout" || type === "test:stderr") {
      const key = relFile(data.file);
      output.set(key, (output.get(key) ?? "") + data.message);
    } else if (type === "test:fail") {
      // A suite or parent test that failed only because a subtest did adds nothing.
      if (data.details?.error?.failureType === "subtestsFailed") continue;
      failedFiles.add(relFile(data.file));
      failures += describeFailure(data);
    } else if (type === "test:diagnostic" && data.nesting === 0) {
      const m = String(data.message).match(/^(tests|fail) (\d+)$/);
      if (m) counts[m[1]] = Number(m[2]);
    }
  }

  for (const file of failedFiles) {
    const out = output.get(file);
    if (out) yield `--- output of ${file || "tests"} ---\n${cleanOutput(out)}\n`;
  }
  if (failures) yield failures;
  yield `node-tests: ${counts.tests ?? 0} total, ${counts.fail ?? 0} failed\n`;
};
