#!/usr/bin/env node
// callum-dev: scaffolds and syncs the dev-system templates layer in a consumer repo.
//
//   init    copy templates in, prompt for repo-owned values, record a version stamp
//           and a pristine baseline copy of each template
//   update  pull upstream template changes forward with a 3-way merge
//           (baseline vs new template vs repo file, via `git merge-file`),
//           surfacing conflicts instead of overwriting repo-owned edits
//   check   fail when the applied template version lags the installed package
//           (suitable as a CI drift gate)
//
// Dependency-free on purpose: this file runs via npx straight out of a git
// install, so it can rely only on Node built-ins plus a git binary.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

const PKG_ROOT = path.resolve(__dirname, "..");
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8"),
).version;
// Overridable so tests can point "upstream" at a modified copy of the templates.
const TEMPLATE_ROOT =
  process.env.CALLUM_DEV_TEMPLATES || path.join(PKG_ROOT, "templates");

const STAMP_FILE = ".callum-dev.json";
const BASELINE_DIR = path.join(".callum-dev", "baseline");

// How `update` treats each file (templates/README.md documents the split per file):
//   merge      3-way merge; repo-owned edits survive, synced changes come forward
//   replace    wholesale overwrite; the file is fully synced, never hand-edited
//   init-only  copied at init as a starting point, then fully repo-owned - update
//              never touches it
//
// `src` is the name under templates/ when it differs from the destination path.
// Only .gitignore needs it, and for a non-obvious reason: npm silently drops any
// file named `.gitignore` from a package, so a `templates/.gitignore` would be
// missing from every install while every other dotfile here survives. Verified
// with `npm pack --dry-run`. Do not "simplify" this back to a dotfile source.
const TEMPLATES = [
  { file: ".no-mistakes.yaml", strategy: "merge" },
  { file: "treehouse.toml", strategy: "init-only" },
  { file: "CLAUDE.md", strategy: "merge" },
  { file: ".claude/settings.json", strategy: "replace" },
  { file: ".devcontainer/devcontainer.json", strategy: "merge" },
  // `merge`, not `init-only`: as this system grows new generated artefacts, their
  // ignore rules have to reach repos that were scaffolded before those artefacts
  // existed. A repo's own paths live in the file's repo-owned block and survive.
  { file: ".gitignore", src: "gitignore", strategy: "merge" },
];

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readStamp() {
  const raw = readIfExists(STAMP_FILE);
  return raw ? JSON.parse(raw) : null;
}

function writeStamp(stamp) {
  writeFile(STAMP_FILE, JSON.stringify(stamp, null, 2) + "\n");
}

function countPlaceholders(content) {
  return (content.match(/<REPLACE[:>]/g) || []).length;
}

// Fill prompted answers into the copied templates. Baselines stay pristine, so
// these substitutions read as ordinary repo-owned edits to `update`'s 3-way merge.
function applyAnswers(file, content, answers) {
  if (file === ".no-mistakes.yaml") {
    if (answers.lint) {
      content = content.replace(
        /^(\s*lint:\s*)"<REPLACE:[^"]*>"$/m,
        (_, prefix) => prefix + JSON.stringify(answers.lint),
      );
    }
    if (answers.test) {
      content = content.replace(
        /^(\s*test:\s*)"<REPLACE:[^"]*>"$/m,
        (_, prefix) => prefix + JSON.stringify(answers.test),
      );
    }
  }
  if (file === ".devcontainer/devcontainer.json" && answers.name) {
    content = content.replace('"<REPLACE: repo name>"', JSON.stringify(answers.name));
  }
  return content;
}

async function promptAnswers() {
  const rl = readline.createInterface({ input: process.stdin });
  // Queue lines instead of using rl.question: with piped (non-TTY) input,
  // readline emits buffered lines in the gaps between sequential questions,
  // and rl.question would silently drop them.
  const lines = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()(null);
  });
  const ask = async (question, def) => {
    process.stderr.write(`${question}${def ? ` [${def}]` : ""}: `);
    let answer;
    if (lines.length > 0) answer = lines.shift();
    else if (closed) answer = null;
    else answer = await new Promise((resolve) => waiters.push(resolve));
    return (answer ?? "").trim() || def;
  };

  const answers = {
    name: await ask("Repo name (devcontainer)", path.basename(process.cwd())),
    lint: await ask("Lint command (blank to fill in later)", ""),
    test: await ask("Test command (blank to fill in later)", ""),
  };
  rl.close();
  return answers;
}

async function init() {
  if (readStamp()) {
    console.error(
      `${STAMP_FILE} already exists - this repo is initialized. Run 'callum-dev update' instead.`,
    );
    process.exit(1);
  }

  const answers = await promptAnswers();
  const skipped = [];
  const written = [];

  for (const { file, src } of TEMPLATES) {
    const source = src ?? file;
    const template = fs.readFileSync(path.join(TEMPLATE_ROOT, source), "utf-8");
    if (fs.existsSync(file)) {
      // Never clobber an existing file; the pristine baseline below still lets
      // a later `update` merge upstream changes into it.
      skipped.push(file);
    } else {
      writeFile(file, applyAnswers(file, template, answers));
      written.push(file);
    }
    writeFile(path.join(BASELINE_DIR, source), template);
  }

  writeStamp({
    version: PKG_VERSION,
    baseline: BASELINE_DIR.split(path.sep).join("/"),
    files: TEMPLATES.map((t) => t.file),
  });

  for (const file of written) console.log(`created   ${file}`);
  for (const file of skipped)
    console.log(`skipped   ${file} (already exists - 'callum-dev update' will merge into it)`);
  console.log(`stamped   ${STAMP_FILE} (template version ${PKG_VERSION})`);

  const remaining = TEMPLATES.map((t) => ({
    file: t.file,
    count: fs.existsSync(t.file) ? countPlaceholders(fs.readFileSync(t.file, "utf-8")) : 0,
  })).filter((r) => r.count > 0);
  if (remaining.length > 0) {
    console.log("\nStill to fill in (search for <REPLACE):");
    for (const r of remaining) console.log(`  ${r.file}: ${r.count} placeholder(s)`);
  }
  console.log(
    `\nCommit ${STAMP_FILE} and ${BASELINE_DIR}/ along with the config files - ` +
      "'callum-dev update' needs the baseline to merge upstream changes without clobbering yours.",
  );
}

function mergeFile(repoFile, baseFile, newFile, oldVersion) {
  const result = spawnSync(
    "git",
    [
      "merge-file",
      "-L", `${repoFile} (this repo)`,
      "-L", `template v${oldVersion} (baseline)`,
      "-L", `template v${PKG_VERSION} (dev-system)`,
      repoFile,
      baseFile,
      newFile,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.error || result.status === null || result.status < 0) {
    throw new Error(
      `git merge-file failed for ${repoFile}: ${result.error ? result.error.message : "git not found or killed"}`,
    );
  }
  // git merge-file exits with the number of conflicts (markers left in the file).
  return result.status;
}

function update() {
  const stamp = readStamp();
  if (!stamp) {
    console.error(`${STAMP_FILE} not found - run 'callum-dev init' first.`);
    process.exit(1);
  }
  const oldVersion = stamp.version;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "callum-dev-"));
  const emptyBase = path.join(tmpDir, "empty");
  fs.writeFileSync(emptyBase, "");

  const conflicts = [];
  const changed = [];

  try {
    for (const { file, src, strategy } of TEMPLATES) {
      const source = src ?? file;
      const newContent = fs.readFileSync(path.join(TEMPLATE_ROOT, source), "utf-8");
      const baselineFile = path.join(BASELINE_DIR, source);
      const baseline = readIfExists(baselineFile);
      const current = readIfExists(file);

      if (strategy === "init-only") {
        // Fully repo-owned: never touched after init. Restore only if deleted.
        if (current === null) {
          writeFile(file, newContent);
          changed.push(`restored  ${file}`);
        }
      } else if (strategy === "replace") {
        if (current !== newContent) {
          writeFile(file, newContent);
          changed.push(`${current === null ? "restored" : "replaced"}  ${file}`);
        }
      } else if (current === null) {
        writeFile(file, newContent);
        changed.push(`restored  ${file}`);
      } else if (newContent !== (baseline ?? "")) {
        // Upstream changed this template: 3-way merge it into the repo's copy.
        // A missing baseline (template added upstream) merges against empty.
        let baseFile = emptyBase;
        if (baseline !== null) {
          baseFile = path.join(tmpDir, "base");
          fs.writeFileSync(baseFile, baseline);
        }
        const newFile = path.join(tmpDir, "new");
        fs.writeFileSync(newFile, newContent);
        const conflictCount = mergeFile(file, baseFile, newFile, oldVersion);
        if (conflictCount > 0) {
          conflicts.push(file);
          changed.push(`CONFLICT  ${file} (${conflictCount} conflict(s) - resolve the markers)`);
        } else {
          changed.push(`merged    ${file}`);
        }
      }

      writeFile(baselineFile, newContent);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  writeStamp({ ...stamp, version: PKG_VERSION, files: TEMPLATES.map((t) => t.file) });

  if (changed.length === 0) {
    console.log(`Already in sync with template version ${PKG_VERSION}.`);
  } else {
    for (const line of changed) console.log(line);
    console.log(`\nStamp updated: ${oldVersion} -> ${PKG_VERSION}.`);
  }
  if (conflicts.length > 0) {
    console.error(
      `\n${conflicts.length} file(s) need manual conflict resolution: ${conflicts.join(", ")}`,
    );
    process.exit(1);
  }
}

function check() {
  const stamp = readStamp();
  if (!stamp) {
    console.error(`${STAMP_FILE} not found - run 'callum-dev init' first.`);
    process.exit(1);
  }
  if (stamp.version !== PKG_VERSION) {
    console.error(
      `Template drift: repo has template version ${stamp.version}, installed dev-system is ${PKG_VERSION}. Run 'npx callum-dev update'.`,
    );
    process.exit(1);
  }
  console.log(`Templates in sync at version ${PKG_VERSION}.`);
}

function usage() {
  console.log(`callum-dev ${PKG_VERSION} - scaffold and sync Callum's dev-system templates

Usage: callum-dev <command>

Commands:
  init     Copy the template files into the current repo, prompting for
           repo-owned values, and record the applied template version.
  update   Merge upstream template changes into this repo (3-way, via
           git merge-file). Repo-owned edits survive; conflicts are left
           as markers and reported with a non-zero exit.
  check    Exit non-zero when the applied template version lags the
           installed package (use in CI to catch drift).
`);
}

async function main() {
  const command = process.argv[2];
  if (command === "init") await init();
  else if (command === "update") update();
  else if (command === "check") check();
  else if (command === "--version" || command === "-v") console.log(PKG_VERSION);
  else {
    usage();
    if (command && command !== "help" && command !== "--help") process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
