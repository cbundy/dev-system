// Tests for images/base/codex-otel.sh, the [otel] table dev-init writes to codex's
// config.toml when the runtime sets OTEL_EXPORTER_OTLP_ENDPOINT (dev-system#68, #171).
// The library runs through a real bash, as dev-init sources it. When codex is on PATH,
// the written config is also loaded by codex itself.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "images", "base", "codex-otel.sh");
const TELEMETRY = path.join(ROOT, "images", "base", "telemetry.sh");

const BEGIN = "# BEGIN dev-system telemetry";
const END = "# END dev-system telemetry";
const HTTP_LOGS = 'exporter = { otlp-http = { endpoint = "http://gw.invalid:4318/v1/logs", protocol = "binary" } }';
const HTTP_METRICS =
  'metrics_exporter = { otlp-http = { endpoint = "http://gw.invalid:4318/v1/metrics", protocol = "binary" } }';

function codexHome(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-otel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, "config.toml");
  if (content !== undefined) fs.writeFileSync(cfg, content);
  return { dir, cfg };
}

// One dev-init start: codex_otel_configure with exactly the env given (plus PATH).
function configure(cfg, env = {}) {
  const r = spawnSync(
    "bash",
    ["-c", 'log() { echo "dev-init: $*" >&2; }; . "$1" && codex_otel_configure "$2" "$3"', "bash", LIB, cfg, TELEMETRY],
    { encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
  );
  assert.equal(r.status, 0, r.stderr);
  return { log: r.stderr, toml: fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : null };
}

const ON = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://gw.invalid:4318", OTEL_RESOURCE_ATTRIBUTES: "host=ws-1,env=coder" };

function block(toml) {
  const lines = toml.split("\n");
  return lines.slice(lines.indexOf(BEGIN), lines.indexOf(END) + 1);
}

const codexOnPath = spawnSync("sh", ["-c", "command -v codex"]).status === 0;

// codex itself loads the file without a configuration error.
function assertCodexLoads(dir) {
  const r = spawnSync("codex", ["login", "status"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: dir },
  });
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Error loading config/i);
}

test("the runtime's env resource attribute is codex's environment, so records are not labelled env=dev", (t) => {
  const { cfg } = codexHome(t, 'sandbox_mode = "danger-full-access"\n');
  const { toml, log } = configure(cfg, ON);
  assert.deepEqual(block(toml), [
    BEGIN,
    "# Written by dev-init from OTEL_EXPORTER_OTLP_ENDPOINT and removed when that is unset",
    "# (cbundy/dev-system#68). Edits here are lost: for settings of your own, replace this",
    "# whole block, markers included, with your own [otel] table.",
    "[otel]",
    "log_user_prompt = false",
    'environment = "coder"',
    HTTP_LOGS,
    HTTP_METRICS,
    END,
  ]);
  assert.match(log, /codex telemetry export on: .* \(http\/protobuf, env coder\)/);
});

test("environment follows the last env attribute, trimmed and TOML-escaped, and is left out without one", (t) => {
  const { cfg } = codexHome(t, "");
  const env = (attrs) => {
    const { toml } = configure(cfg, { ...ON, OTEL_RESOURCE_ATTRIBUTES: attrs });
    return block(toml).filter((l) => l.startsWith("environment"));
  };
  assert.deepEqual(env("env=a, host=h , env = b "), ['environment = "b"']);
  assert.deepEqual(env('env=we"ird\\'), ['environment = "we\\"ird\\\\"']);
  assert.deepEqual(env("host=h,environment=x"), []);
  assert.deepEqual(env(""), []);
});

test("grpc sends to the endpoint as is; HTTP appends the signal paths to an endpoint with a trailing slash", (t) => {
  const { cfg } = codexHome(t, "");
  let { toml } = configure(cfg, { ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: "http://gw.invalid:4318/" });
  assert.ok(block(toml).includes(HTTP_LOGS) && block(toml).includes(HTTP_METRICS), toml);
  ({ toml } = configure(cfg, {
    ...ON,
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://gw.invalid:4317",
    OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
  }));
  assert.ok(block(toml).includes('exporter = { otlp-grpc = { endpoint = "http://gw.invalid:4317" } }'), toml);
  assert.ok(block(toml).includes('metrics_exporter = { otlp-grpc = { endpoint = "http://gw.invalid:4317" } }'), toml);
  assert.ok(!toml.includes("trace_exporter"));
});

test("no endpoint and no block: config.toml is left byte for byte, or not created", (t) => {
  const before = 'sandbox_mode = "workspace-write"\n\n[profiles.x]\nmodel = "m"\n';
  const { cfg } = codexHome(t, before);
  assert.deepEqual(configure(cfg), { log: "", toml: before });
  const fresh = codexHome(t);
  assert.equal(configure(fresh.cfg).toml, null);
});

test("the block sits after the top-level keys, before the first table and the comments above it", (t) => {
  const before = 'sandbox_mode = "workspace-write"\nmodel = "m"\n\n# my profile\n[profiles.x]\nmodel = "n"\n';
  const { cfg } = codexHome(t, before);
  const { toml } = configure(cfg, ON);
  const lines = toml.split("\n");
  assert.deepEqual(lines.slice(0, 3), ['sandbox_mode = "workspace-write"', 'model = "m"', ""]);
  assert.equal(lines[3], BEGIN);
  assert.deepEqual(lines.slice(lines.indexOf(END) + 1), ["", "# my profile", "[profiles.x]", 'model = "n"', ""]);
  // Idempotent, and unsetting the endpoint gives the file back as it was.
  assert.deepEqual(configure(cfg, ON), { log: "", toml });
  assert.equal(configure(cfg).toml, before);
});

test("tables codex appended inside the markers survive a restart, moved out of the block", (t) => {
  // The layout every Coder workspace had: the block at the end of the file, and the
  // [projects] trust entries codex adds at the end written inside the markers.
  const { cfg } = codexHome(
    t,
    [
      'sandbox_mode = "danger-full-access"',
      "",
      BEGIN,
      "[otel]",
      "log_user_prompt = false",
      HTTP_LOGS,
      HTTP_METRICS,
      "",
      '[projects."/work/a"]',
      'trust_level = "trusted"',
      "",
      '[projects."/work/b"]',
      'trust_level = "trusted"',
      END,
      "",
    ].join("\n"),
  );
  const { toml } = configure(cfg, ON);
  const trust = ['[projects."/work/a"]', 'trust_level = "trusted"', "", '[projects."/work/b"]', 'trust_level = "trusted"'];
  assert.ok(!block(toml).some((l) => l.startsWith("[projects")), toml);
  assert.deepEqual(toml.split("\n").slice(toml.split("\n").indexOf(END) + 1), ["", ...trust, ""]);
  assert.ok(block(toml).includes('environment = "coder"'), toml);
  // Unsetting the endpoint removes the block and keeps the trust entries.
  const off = configure(cfg).toml;
  assert.equal(off, ['sandbox_mode = "danger-full-access"', "", ...trust, ""].join("\n"));
});

test("a user's own otel settings win, and dev-init's block is dropped", (t) => {
  const mine = 'sandbox_mode = "workspace-write"\n\n[otel]\nenvironment = "mine"\n';
  const { cfg } = codexHome(t, mine);
  const r = configure(cfg, ON);
  assert.equal(r.toml, mine);
  assert.match(r.log, /left the otel settings already in .* alone/);
  // dev-init's block first, then a user table added beside it.
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\n');
  configure(cfg, ON);
  fs.appendFileSync(cfg, '\n[otel]\nenvironment = "mine"\n');
  const after = configure(cfg, ON).toml;
  assert.ok(!after.includes(BEGIN), after);
  assert.equal(after.match(/^\[otel\]$/gm).length, 1);
});

test("codex loads the config dev-init writes", { skip: !codexOnPath && "codex is not on PATH" }, (t) => {
  const { dir, cfg } = codexHome(t, 'sandbox_mode = "danger-full-access"\n\n[projects."/w"]\ntrust_level = "trusted"\n');
  configure(cfg, ON);
  assertCodexLoads(dir);
  // A broken table is caught, so the check is not vacuous.
  fs.appendFileSync(cfg, "\n[otel]\nlog_user_prompt = false\n");
  const r = spawnSync("codex", ["login", "status"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: dir },
  });
  assert.match(`${r.stdout}${r.stderr}`, /Error loading config/i);
});
