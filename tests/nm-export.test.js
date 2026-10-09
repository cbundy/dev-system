// Tests for images/base/nm-export (cbundy/dev-system#273): the SQLite-to-SQL half of nm-push-loop.
// Runs the script as a subprocess against a node:sqlite fixture (images/base/test/nm-fixture.js
// builds the same shape for the container test), so no binary is committed and no Postgres is needed.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { beforeEach, test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const SCRIPT = path.join(__dirname, "..", "images", "base", "nm-export");
const FIXTURE = path.join(__dirname, "..", "images", "base", "test", "nm-fixture.js");
const mod = require(SCRIPT);

let tmp;
let file;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nm-export-test-"));
  file = path.join(tmp, "state.sqlite");
  const r = spawnSync(process.execPath, [FIXTURE, file, "create"]);
  assert.equal(r.status, 0, String(r.stderr));
});

function exp(args = [], env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, file, "--device", "dev-box", ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, inserts: r.stdout.split("\n").filter((l) => l.startsWith("INSERT")) };
}
const rowsOf = (res, table) => res.inserts.filter((l) => l.startsWith(`INSERT INTO nomistakes.${table} `));
function mutate(sql) { const db = new DatabaseSync(file); db.exec(sql); db.close(); }

test("backfill sends every table with device and repo", () => {
  const r = exp();
  assert.equal(r.status, 0, r.err);
  assert.equal(rowsOf(r, "repos").length, 1);
  assert.equal(rowsOf(r, "runs").length, 2);
  assert.equal(rowsOf(r, "step_results").length, 2);
  assert.equal(rowsOf(r, "step_rounds").length, 1);
  assert.equal(rowsOf(r, "agent_invocations").length, 1);
  assert.equal(rowsOf(r, "run_agent_sessions").length, 1);
  assert.match(rowsOf(r, "runs")[0], /'dev-box', 'acme\/widgets', NULL\) ON CONFLICT \(id\) DO UPDATE/);
  assert.match(rowsOf(r, "run_agent_sessions")[0], /ON CONFLICT \(run_id, role\) DO UPDATE/);
  assert.match(r.out, /CREATE SCHEMA IF NOT EXISTS nomistakes;/);
  assert.match(rowsOf(r, "runs")[0], /to_timestamp\(1700000100\)/);
});

for (const missing of [["repos"], ["runs"], ["step_results"], ["repos", "runs", "step_results"]]) {
  test(`backfill preserves available rows without parent tables: ${missing.join(", ")}`, () => {
    const expected = {
      repos: ["rp1"], runs: ["r1", "r2"], step_results: ["s1", "s2"],
      step_rounds: ["d1"], agent_invocations: ["i1"], run_agent_sessions: ["r1"],
    };
    for (const table of missing) mutate(`DROP TABLE ${table}`);
    const markOut = path.join(tmp, "mark.json");
    const r = exp(["--mark-out", markOut]);
    assert.equal(r.status, 0, r.err);
    for (const [table, ids] of Object.entries(expected)) {
      const rows = rowsOf(r, table);
      assert.deepEqual(rows.map((row) => /VALUES \('([^']+)'/.exec(row)[1]).sort(), missing.includes(table) ? [] : ids, table);
      if (missing.includes(table)) {
        assert.equal(r.err.split(`table ${table} is missing, skipped`).length - 1, 1, table);
      }
      const unresolved = table !== "repos" && (missing.includes("repos") || missing.includes("runs") ||
        (table === "step_rounds" && missing.includes("step_results")));
      for (const row of rows) {
        assert.ok(row.includes(unresolved ? "'dev-box', NULL, NULL) ON CONFLICT" : "'dev-box', 'acme/widgets', NULL) ON CONFLICT"), table);
      }
    }
    assert.equal(JSON.parse(fs.readFileSync(markOut, "utf8")).rows, r.inserts.length);
  });
}

test("backfill preserves child rows whose parent records are absent", () => {
  mutate("UPDATE step_results SET run_id = 'absent'; UPDATE step_rounds SET step_result_id = 'absent'; UPDATE agent_invocations SET run_id = 'absent'; UPDATE run_agent_sessions SET run_id = 'absent'");
  const r = exp();
  assert.equal(r.status, 0, r.err);
  for (const [table, count] of [["step_results", 2], ["step_rounds", 1], ["agent_invocations", 1], ["run_agent_sessions", 1]]) {
    const rows = rowsOf(r, table);
    assert.equal(rows.length, count, table);
    for (const row of rows) assert.ok(row.includes("'dev-box', NULL, NULL) ON CONFLICT"), table);
  }
});

test("device falls back to DEV_MACHINE_NAME, then the hostname", () => {
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8", env: { PATH: process.env.PATH, DEV_MACHINE_NAME: "from-env" } });
  assert.match(r.stdout, /'from-env', 'acme\/widgets'/);
  const h = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.ok(h.stdout.includes(`'${os.hostname()}', 'acme/widgets'`));
});

test("repoOfUrl matches callum-flow-evaluate", () => {
  const ev = require(path.join(__dirname, "..", "images", "base", "callum-flow-evaluate"));
  for (const u of ["git@github.com:Acme/Widgets.git", "https://github.com/Acme/Widgets", "https://github.com/a/b.git/", "", null, "nonsense"]) {
    assert.equal(mod.repoOfUrl(u), ev.repoOfUrl(u), String(u));
  }
});

test("incremental: a terminal run untouched since the mark is not re-sent, a live one is, with all children", () => {
  const r = exp(["--mark", "1700000200"]);
  assert.equal(rowsOf(r, "runs").length, 1);
  assert.match(rowsOf(r, "runs")[0], /'r1'/);
  assert.equal(rowsOf(r, "step_results").length, 1);
  assert.equal(rowsOf(r, "step_rounds").length, 1);
  assert.equal(rowsOf(r, "agent_invocations").length, 1);
  assert.equal(rowsOf(r, "run_agent_sessions").length, 1);
  assert.equal(rowsOf(r, "repos").length, 1);
});

test("the mark is inclusive: a terminal run touched exactly at the mark is sent, one second later is not", () => {
  assert.equal(rowsOf(exp(["--mark", "1700000150"]), "runs").length, 2);
  assert.equal(rowsOf(exp(["--mark", "1700000151"]), "runs").length, 1);
});

test("a terminal run is touched through any of its children", () => {
  mutate("UPDATE agent_invocations SET run_id = 'r2', completed_at = 1700000500 WHERE id = 'i1'");
  const r = exp(["--mark", "1700000400"]);
  assert.deepEqual(rowsOf(r, "runs").map((l) => /VALUES \('(\w+)'/.exec(l)[1]).sort(), ["r1", "r2"]);
  mutate("UPDATE step_rounds SET step_result_id = 's2', created_at = 1700000600");
  const r2 = exp(["--mark", "1700000550"]);
  assert.match(rowsOf(r2, "step_rounds")[0], /'d1'/);
  assert.ok(rowsOf(r2, "runs").some((l) => l.includes("VALUES ('r2'")));
});

test("the new mark and the row count go to --mark-out, and the mark never goes backwards", () => {
  const out = path.join(tmp, "mark.json");
  exp(["--mark-out", out]);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), { mark: 1700000200, rows: 8 });
  exp(["--mark", "1800000000", "--mark-out", out]);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).mark, 1800000000);
});

test("--waiting says yes only for activity newer than the mark", () => {
  assert.equal(exp(["--waiting", "--mark", "1700000199"]).out.trim(), "yes");
  assert.equal(exp(["--waiting", "--mark", "1700000200"]).out.trim(), "no");
  assert.equal(exp(["--waiting"]).out.trim(), "yes");
});

test("excluded columns appear nowhere, not even in raw", () => {
  mutate("ALTER TABLE runs ADD COLUMN extra TEXT; UPDATE runs SET extra = 'x'");
  const r = exp();
  for (const needle of ["/secret/", "4242", "worktree_dir", "log_path", "agent_pid", "working_path", "global_config_yaml", "repo_config_yaml", "AP8="]) {
    assert.ok(!r.out.includes(needle), needle);
  }
  assert.match(rowsOf(r, "runs")[0], /'\{"extra":"x"\}'::jsonb/);
});

test("unknown columns go to raw (blobs as base64) and a missing known column is NULL", () => {
  mutate("ALTER TABLE step_results ADD COLUMN blobby BLOB; UPDATE step_results SET blobby = x'0102'");
  const r = exp();
  assert.match(rowsOf(r, "step_results")[0], /'\{"blobby":"AQI="\}'::jsonb/);
  // the fixture has no ci_ready_at, push_ref ... on runs: they ship as NULL
  assert.match(rowsOf(r, "runs")[0], /VALUES \('r1', 'rp1', 'feat\/x', NULL,/);
});

test("raw text preserves literal backslash escapes while removing actual NULs in every table", () => {
  const tables = ["repos", "runs", "step_results", "step_rounds", "agent_invocations", "run_agent_sessions"];
  const input = {
    literal: "ends in \\u0000",
    actual: "a\u0000b",
    mixed: "it's \\u0000\u0000 and \\\\u0000",
  };
  const expected = {
    literal: "ends in \\u0000",
    actual: "ab",
    mixed: "it's \\u0000 and \\\\u0000",
  };
  const db = new DatabaseSync(file);
  try {
    for (const table of tables) {
      for (const [column, value] of Object.entries(input)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
        db.prepare(`UPDATE ${table} SET ${column} = ?`).run(value);
      }
    }
  } finally {
    db.close();
  }
  const r = exp();
  assert.equal(r.status, 0, r.err);
  for (const table of tables) {
    const rows = rowsOf(r, table);
    assert.ok(rows.length > 0, table);
    for (const row of rows) {
      const raw = /, '((?:[^']|'')*)'::jsonb\) ON CONFLICT/.exec(row);
      assert.ok(raw, table);
      assert.deepEqual(JSON.parse(raw[1].replace(/''/g, "'")), expected, table);
    }
  }
});

test("a missing table is skipped with one warning and the rest is sent", () => {
  mutate("DROP TABLE agent_invocations");
  const r = exp();
  assert.equal(r.status, 0);
  assert.equal((r.err.match(/table agent_invocations is missing, skipped/g) || []).length, 1);
  assert.equal(rowsOf(r, "agent_invocations").length, 0);
  assert.equal(rowsOf(r, "runs").length, 2);
});

test("SQL quoting: quotes, backslashes, newlines, unicode and NUL", () => {
  assert.equal(mod.lit("it's \\ \n é 🚀", "t"), "'it''s \\ \n é 🚀'");
  assert.equal(mod.lit("a\u0000b", "t"), "'ab'");
  assert.equal(mod.lit(null, "t"), "NULL");
  assert.equal(mod.lit(1700000000, "ts"), "to_timestamp(1700000000)");
  assert.equal(mod.lit(1700000000000, "ts"), "to_timestamp(1700000000)");
  assert.equal(mod.lit("1.5", "i"), "1");
  mutate("UPDATE runs SET error = 'bad '' quote' || char(10) || '$$ ; DROP TABLE x; --' WHERE id = 'r1'");
  const sql = exp().out;
  assert.ok(sql.includes("'bad '' quote\n$$ ; DROP TABLE x; --'"));
});

test("a missing state.sqlite is a no-op, a corrupt one fails", () => {
  const r = spawnSync(process.execPath, [SCRIPT, path.join(tmp, "nope.sqlite")], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  fs.writeFileSync(path.join(tmp, "bad.sqlite"), "not a database at all");
  assert.equal(spawnSync(process.execPath, [SCRIPT, path.join(tmp, "bad.sqlite")], { encoding: "utf8" }).status, 1);
});

test("the source file is only read: its bytes are unchanged", () => {
  const before = fs.readFileSync(file);
  exp(["--mark", "0"]);
  assert.ok(before.equals(fs.readFileSync(file)));
});

test("bad usage exits 2", () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, file, "--bogus"], { encoding: "utf8" }).status, 2);
});
