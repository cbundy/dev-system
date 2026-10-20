"use strict";

// The expand-only migration check (scripts/migration-lint.js; docs/factory-db.md "Schema
// compatibility"): each forbidden form fails with the file and line, additive SQL passes,
// comments and strings are ignored, and the real migrations pass.
const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const LINT = path.join(ROOT, "scripts", "migration-lint.js");
const tmps = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

function run(sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-lint-"));
  tmps.push(dir);
  if (sql !== undefined) fs.writeFileSync(path.join(dir, "0001_x.sql"), sql);
  return spawnSync("node", [LINT, dir], { encoding: "utf8" });
}

// [statement, expected line (1-based) of the offending keyword]
const FORBIDDEN = {
  "DROP TABLE": ["DROP TABLE factory.t;", 1],
  "DROP COLUMN": ["ALTER TABLE t DROP COLUMN c;", 1],
  "DROP VIEW without a re-create": ["DROP VIEW factory.v;", 1],
  "DROP VIEW re-created before it": ["CREATE VIEW v AS SELECT 1;\nDROP VIEW v;", 2],
  "DROP VIEW of several views": ["DROP VIEW factory.v, factory.w;\nCREATE VIEW factory.v AS SELECT 1;", 1],
  "DROP VIEW CASCADE": ["DROP VIEW factory.v CASCADE;\nCREATE VIEW factory.v AS SELECT 1;", 1],
  "DROP after an E-string with an escaped quote": ["SELECT E'it\\'s';\nDROP TABLE x;", 2],
  "ADD EXCLUDE": ["ALTER TABLE t ADD EXCLUDE USING gist (c WITH =);", 1],
  "DROP INDEX": ["DROP INDEX i;", 1],
  "DROP FUNCTION": ["DROP FUNCTION f();", 1],
  "DROP in a function body": ["CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  DROP TABLE x;\nEND $$ LANGUAGE plpgsql;", 3],
  "RENAME COLUMN": ["ALTER TABLE t RENAME COLUMN a TO b;", 1],
  "RENAME TO": ["ALTER TABLE t RENAME TO u;", 1],
  "view RENAME COLUMN": ["ALTER VIEW v RENAME COLUMN a TO b;", 1],
  "ALTER COLUMN TYPE": ["ALTER TABLE t ALTER COLUMN c TYPE bigint;", 1],
  "ALTER SET DATA TYPE": ["ALTER TABLE t ALTER c SET DATA TYPE text;", 1],
  "ADD COLUMN NOT NULL": ["ALTER TABLE t ADD COLUMN c int NOT NULL;", 1],
  "SET NOT NULL": ["ALTER TABLE t ALTER COLUMN c SET NOT NULL;", 1],
  "ADD CONSTRAINT CHECK": ["ALTER TABLE t ADD CONSTRAINT k CHECK (c > 0);", 1],
  "ADD UNIQUE": ["ALTER TABLE t ADD UNIQUE (c);", 1],
  "ADD PRIMARY KEY": ["ALTER TABLE t ADD PRIMARY KEY (c);", 1],
  "ADD FOREIGN KEY": ["ALTER TABLE t ADD FOREIGN KEY (c) REFERENCES u (id);", 1],
  "ALTER DOMAIN ADD CONSTRAINT": ["ALTER DOMAIN d ADD CONSTRAINT k CHECK (VALUE > 0);", 1],
  "CREATE UNIQUE INDEX on an old table": ["CREATE UNIQUE INDEX i ON factory.event_store (id);", 1],
  "REVOKE": ["REVOKE SELECT ON t FROM r;", 1],
  "ALTER DEFAULT PRIVILEGES REVOKE": ["ALTER DEFAULT PRIVILEGES IN SCHEMA factory\n  REVOKE ALL ON TABLES FROM r;", 2],
  "multi-line, keyword on a later line": ["SELECT 1;\n\nALTER TABLE t\n  ADD COLUMN ok int,\n  DROP COLUMN c;", 5],
  "mixed case and whitespace": ["alter   TABLE t\n   Alter  column c   set\n  data   type text;", 2],
};

for (const [name, [sql, line]] of Object.entries(FORBIDDEN)) {
  test(`fails: ${name}`, () => {
    const r = run(sql);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(`^0001_x\\.sql:${line}: .*\\(expand-only migrations, docs/factory-db\\.md\\)$`, "m"));
  });
}

test("additive SQL passes", () => {
  const r = run(`
CREATE TABLE factory.a (id bigint NOT NULL PRIMARY KEY, n int NOT NULL CHECK (n > 0), UNIQUE (n));
ALTER TABLE factory.a ADD COLUMN x int;
ALTER TABLE factory.a ADD COLUMN y jsonb NOT NULL DEFAULT '[]';
CREATE OR REPLACE VIEW factory.v AS SELECT * FROM factory.a;
CREATE INDEX i ON factory.a (n);
CREATE UNIQUE INDEX u ON factory.a (x);
CREATE FUNCTION f() RETURNS void AS $$ BEGIN DELETE FROM factory.a; END $$ LANGUAGE plpgsql;
CREATE TRIGGER t AFTER INSERT ON factory.a FOR EACH ROW EXECUTE FUNCTION f();
ALTER TABLE factory.a ALTER COLUMN n DROP NOT NULL;
DROP VIEW IF EXISTS factory.w RESTRICT;
CREATE VIEW factory.w AS SELECT 1 AS one;
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, "");
});

test("comments and strings are ignored", () => {
  const r = run("-- DROP TABLE x\n/* RENAME\n REVOKE */\nSELECT 'DROP TABLE ''x''; REVOKE';\nCREATE TABLE t (c text DEFAULT 'RENAME');\n");
  assert.equal(r.status, 0, r.stderr);
});

test("the real migrations pass", () => {
  const r = spawnSync("node", [LINT], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, "");
});
