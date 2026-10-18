#!/usr/bin/env node
"use strict";

// Replay harness for the factory loop (docs/factory-loop/v2/SPEC.md 13; conversion brief, phase 2).
// It rebuilds the factory's state at past moments and runs plan() on it, then compares what the
// loop would have done with what the live orchestrator did next. Every source is read-only:
//
//   the database   callum-flow-factory-state --at <t> --github off, and the event log (dev-query)
//   GitHub         each issue's timeline and state through callum-flow-issue-read, replayed to <t>:
//                  labels (labeled/unlabeled), open blockers (blocked_by_added/removed and each
//                  blocker's closed_at) and sub-issues (sub_issue_added/removed)
//   the ledger     derived from the device's own events up to <t> (derive.ts, v2 SPEC 13.7.5)
//
// Samples are every --step-minutes and one second before each live decision. It writes
// <out>/replay.json (every sample's plan) and <out>/comparison.json, and prints a summary. --out is
// required, so a run never writes into the repo by default.
//
// usage: node scripts/factory-loop-replay.js --repo owner/name --device <device>
//          --from <ISO> --to <ISO> --out <dir> [--step-minutes 2] [--skip-labels a,b]
//          [--control <JSON>]   owner directives in force over the window (v2 SPEC 13.4.3), e.g.
//                               '{"noNewWork":true}' for a drain the memory file records
//          [--decisions <file>] compare a shadow run's decision log (decisions-*.jsonl) with
//                               the live orchestrator instead of replaying: the shadow's
//                               logged actions stand in for plan()'s
//
// The loop always plans with v2 (docs/factory-loop/v2/SPEC.md 2.3): planV2() over the states with
// v2's fields empty (no v2 records in a history from before it), for its claims and titles.
const { execFileSync } = require("node:child_process");
const { register } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

// The plugin's modules import each other without a file extension, as the engine resolves them;
// plain Node needs the ".ts", so relative imports that fail are retried with it.
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
const HOOKS = path.join(ROOT, "plugins", "factory-loop", "hooks");
const FACTORY_STATE = path.join(ROOT, "images", "base", "callum-flow-factory-state");
const MIN = 60_000;
const LOOKBACK = 60 * MIN;
// A heartbeat is periodic, so it matches only when the loop planned one within BEAT_BEFORE of the
// live renewal, or would have within BEAT_AFTER from the state a second before it.
const BEAT_BEFORE = 5 * MIN;
const BEAT_AFTER = 2 * MIN;

const USAGE_SQL = `select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ts, note
from factory.events
where repo = :'repo' and device = :'device' and state = 'usage'
  and ts <= :'at'::timestamptz and ts > :'at'::timestamptz - make_interval(days => :'days'::int)
order by ts;
`;

// The arguments the harness takes (see the usage above).
const ARGS = ["repo", "device", "from", "to", "stepMinutes", "out", "skipLabels", "control", "decisions"];

function args(argv) {
  const out = { stepMinutes: 2, skipLabels: "parked" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!ARGS.includes(key) || !argv[i].startsWith("--")) throw new Error(`unknown argument ${argv[i]}`);
    out[key] = argv[i + 1];
  }
  for (const k of ["repo", "device", "from", "to", "out"]) if (!out[k]) throw new Error(`--${k} is required`);
  return out;
}

const iso = (ms) => new Date(ms).toISOString();

// The reader logs an untrusted_stripped event as a side effect of filtering; those writes go to a
// scratch sink, never to the factory's event log (the replay writes nothing outside --out).
const SINK = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "factory-loop-replay-sink-"));

// run: one read-only command; a failure is retried twice (the database host has been seen to
// drop a DNS lookup), and an exit the caller handles (the reader's exit 3) is not retried.
function run(cmd, argv, input) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(cmd, argv, {
        input,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CALLUM_EVENTS_DIR: SINK },
      });
    } catch (err) {
      if (err.status === 3 || attempt >= 3) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000 * attempt);
    }
  }
}

// issueRead: the reader's JSON, or { untrusted: true } on its exit 3.
function issueRead(argv) {
  try {
    return JSON.parse(run("callum-flow-issue-read", ["--json", ...argv]));
  } catch (err) {
    if (err.status === 3) return { untrusted: true };
    throw err;
  }
}

// closedAt: when an issue closed, read once. A timeline's blocker can say "closed" with no
// closed_at, so the blocker's own record decides.
const closedCache = new Map();
function closedAt(n) {
  if (!closedCache.has(n)) {
    const read = issueRead([String(n)]);
    closedCache.set(n, read.issue?.closed_at ?? null);
  }
  return closedCache.get(n);
}

// github: an issue's state at any past moment, from its current state and its timeline.
function githubHistory(repo, n) {
  const now = issueRead([String(n)]);
  if (now.untrusted) return { untrusted: true };
  const events = (issueRead(["--timeline", String(n)]).events ?? [])
    .filter((e) => typeof e.created_at === "string")
    .map((e) => ({ ...e, at: Date.parse(e.created_at) }))
    .sort((a, b) => a.at - b.at);
  const closed = now.issue?.closed_at ? Date.parse(now.issue.closed_at) : null;
  return {
    untrusted: false,
    at(t) {
      const labels = new Set();
      const blockers = new Map();
      const subs = new Set();
      for (const e of events) {
        if (e.at > t) break;
        if (e.event === "labeled" && e.label?.name) labels.add(e.label.name);
        if (e.event === "unlabeled" && e.label?.name) labels.delete(e.label.name);
        if (e.event === "blocked_by_added" && e.blocked_by?.number) {
          const b = e.blocked_by;
          blockers.set(b.number, b.closed_at ?? (b.state === "closed" ? closedAt(b.number) : null));
        }
        if (e.event === "blocked_by_removed" && e.blocked_by?.number) blockers.delete(e.blocked_by.number);
        if (e.event === "sub_issue_added" && e.sub_issue?.number) subs.add(e.sub_issue.number);
        if (e.event === "sub_issue_removed" && e.sub_issue?.number) subs.delete(e.sub_issue.number);
      }
      const openBlockers = [...blockers.values()].filter((c) => c === null || c === undefined || Date.parse(c) > t).length;
      return {
        title: now.issue?.title ?? "",
        open: closed === null || closed > t,
        labels: [...labels].sort(),
        blockedBy: openBlockers,
        subIssues: subs.size,
      };
    },
  };
}

function liveDecisions(events, device, from, to) {
  const own = events.filter((e) => e.device === device && e.ts >= from && e.ts <= to);
  const out = [];
  let lastBeat = -Infinity;
  const parksSeen = new Set();
  for (const e of own) {
    if (e.state === "claimed" && e.actor !== "sweep") out.push({ type: "claim", issue: e.issue, ts: e.ts });
    else if (e.state === "delegated") out.push({ type: "delegate", issue: e.issue, ts: e.ts });
    else if (e.state === "merged" && e.actor !== "sweep") out.push({ type: "merge", issue: e.issue, pr: e.pr, ts: e.ts });
    else if (e.state === "rebased_behind") out.push({ type: "update-behind", issue: e.issue, pr: e.pr, ts: e.ts });
    else if (e.state === "renewed" && e.ts - lastBeat > MIN) {
      out.push({ type: "heartbeat", ts: e.ts });
      lastBeat = e.ts;
    } else if (e.state === "renewed") lastBeat = e.ts;
    else if (e.state === "verdict" && e.run) {
      // one adjudication per park: the first verdict after each park of the run
      const park = [...events].reverse().find((p) => p.state === "parked" && p.run === e.run && p.ts <= e.ts);
      const id = `${e.run}@${park ? park.ts : 0}`;
      if (!parksSeen.has(id)) {
        parksSeen.add(id);
        out.push({ type: "adjudicate", issue: e.issue, run: e.run, ts: e.ts, parkedAt: park ? park.ts : null });
      }
    } else if (["abandoned", "superseded", "fix_requested"].includes(e.state)) {
      out.push({ type: e.state, issue: e.issue, run: e.run, ts: e.ts });
    } else if (e.state === "closed" && e.actor !== "sweep") out.push({ type: "closed", issue: e.issue, ts: e.ts });
  }
  return out;
}

// matches: whether a planned action is the loop's version of a live decision.
function matches(action, d) {
  switch (d.type) {
    case "claim":
      return action.kind === "claim" && action.issue === d.issue;
    case "adjudicate":
      return action.kind === "spawn" && action.agent === "adjudicator" && action.run === d.run;
    case "merge":
    case "update-behind":
      // the merge flow: guard, update-behind, the merge adjudicator (the retired v1 merge rule M4), a sequencing
      // judge (M5) and the merge itself; v2's queue update and merge (v2 SPEC 9)
      return (
        ((["guard", "merge", "update-behind", "queue-update", "queue-merge"].includes(action.kind) || action.key.startsWith("adjudicate-merge:")) && action.pr === d.pr) ||
        (action.key.startsWith("judge:sequence:") && action.issue === d.issue)
      );
    case "heartbeat":
      return action.kind === "heartbeat";
    case "delegate":
      return (
        (action.kind === "delegate" || (action.kind === "spawn" && action.agent === "designer") || (action.kind === "agent-step" && (action.step === "design" || action.step === "build"))) &&
        action.issue === d.issue
      );
    default:
      return false;
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  const from = Date.parse(a.from);
  const to = Date.parse(a.to);
  const step = Number(a.stepMinutes) * MIN;
  const { planV2 } = await import(path.join(HOOKS, "v2", "plan.ts"));
  const { emptyV2State } = await import(path.join(HOOKS, "v2", "observe.ts"));
  const parse = await import(path.join(HOOKS, "parse.ts"));
  const derive = await import(path.join(HOOKS, "derive.ts"));
  const { buildState } = await import(path.join(HOOKS, "state.ts"));
  const { EMPTY_CONTROL, loadConfig } = await import(path.join(HOOKS, "config.ts"));
  // the settings the planner runs with, its own defaults included (K is 3)
  const config = loadConfig({ skipLabels: a.skipLabels ? a.skipLabels.split(",") : [] }).config;
  // v2 plans the state with its own fields empty
  const plan = (state, cfg) => planV2({ ...state, v2: state.v2 ?? emptyV2State(state.now) }, cfg);

  const days = Math.ceil((to - from) / 86_400_000) + 3;
  const vars = ["-v", `repo=${a.repo}`, "-v", `at=${iso(to + LOOKBACK)}`, "-v", `days=${days}`, "-v", `device=${a.device}`];
  const events = derive.eventsFromRows(parse.parseCsv(run("dev-query", ["--csv", ...vars], derive.EVENTS_SQL)));
  const usage = parse.parseCsv(run("dev-query", ["--csv", ...vars], USAGE_SQL)).map((r) => ({ ts: Date.parse(r.ts), note: r.note }));
  const decisions = liveDecisions(events, a.device, from, to + LOOKBACK);

  const times = new Set();
  for (let t = from; t <= to; t += step) times.add(t);
  // one second and twenty seconds before each decision: a claim swaps the labels a moment
  // before it logs the claim, so the earlier sample still sees the issue in the queue
  for (const d of decisions) {
    for (const before of [1000, 20_000]) if (d.ts - before >= from && d.ts - before <= to) times.add(d.ts - before);
  }
  // and five seconds after each issue joins the queue, before a fast claim takes it out again
  for (const e of events) if (e.state === "ready" && e.ts + 5000 >= from && e.ts + 5000 <= to) times.add(e.ts + 5000);
  const samples = [...times].sort((x, y) => x - y);

  const history = new Map();
  const githubAt = (n, t) => {
    if (!history.has(n)) history.set(n, githubHistory(a.repo, n));
    const h = history.get(n);
    return h.untrusted ? { facts: null, trusted: false, brief: null } : { facts: h.at(t), trusted: true, brief: null };
  };

  const results = [];
  const states = new Map();
  if (a.decisions) {
    // a shadow run's own log: one line per pass, already planned
    for (const line of fs.readFileSync(a.decisions, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const d = JSON.parse(line);
      const t = Date.parse(d.at);
      if (!d.actions || t < from || t > to) continue;
      results.push({ t, at: d.at, tier: d.tier, actions: d.actions, skipped: d.skipped ?? [] });
    }
  }
  for (const t of a.decisions ? [] : samples) {
    const json = run(FACTORY_STATE, ["--repo", a.repo, "--format", "json", "--github", "off", "--at", iso(t)]);
    const factory = parse.parseFactoryState(json, a.repo);
    if (factory === null) throw new Error(`factory-state at ${iso(t)} did not parse`);
    const upTo = events.filter((e) => e.ts <= t);
    const facts = derive.factsOf(upTo);
    const candidates = factory.issues.filter((i) => !i.ended && (i.stage === "queued" || i.holder === a.device)).map((i) => i.number);
    const github = new Map(candidates.map((n) => [n, githubAt(n, t)]));
    const queue = candidates.filter((n) => {
      const g = github.get(n);
      return g.facts !== null && g.facts.open && g.facts.labels.includes(config.readyLabel);
    });
    const held = factory.issues.filter((i) => !i.ended && i.holder === a.device && ["implementing", "in pipeline", "parked", "ready to merge"].includes(i.stage)).length;
    const u = [...usage].reverse().find((r) => r.ts <= t);
    const ok = { ok: true, at: t };
    const state = buildState({
      now: t,
      repo: a.repo,
      device: a.device,
      loadedAt: from - 120 * MIN,
      sources: { factory: ok, facts: ok, runs: ok, queue: ok, github: ok, usage: ok, pool: ok, milestone: { ok: false, at: null } },
      factory,
      facts,
      runs: null,
      queue,
      github,
      // trackers' timelines are read only for an `only` directive's trackers (D-35)
      timelines: new Map(),
      usage: u ? parse.parseUsage(u.note) : null,
      pool: { free: Math.max(0, 16 - held), total: 16, slots: [] },
      agents: [],
      milestone: null,
      ledger: derive.deriveLedger(upTo, a.device),
      control: { ...EMPTY_CONTROL, ...(a.control ? JSON.parse(a.control) : {}) },
      lastTitle: null,
      githubBackoffUntil: null,
      trackerTitle: config.trackerTitle,
    });
    const result = plan(state, config);
    states.set(t, state);
    results.push({
      t,
      at: iso(t),
      tier: result.tier,
      usage: state.usage,
      queue,
      runs: state.runs.map((r) => ({ issue: r.issue, run: r.run, state: r.state, head: r.head })),
      actions: result.actions.filter((x) => x.kind !== "title").map((x) => ({ key: x.key, kind: x.kind, agent: x.agent, step: x.step, rule: x.rule, issue: x.issue, run: x.run ?? null, pr: x.pr ?? null })),
      skipped: result.skipped.filter((s) => s.issue !== null),
    });
    process.stderr.write(".");
  }
  process.stderr.write("\n");

  // A heartbeat the loop would plan soon after a sample: the seconds until it is due, if within BEAT_AFTER.
  const beatLag = (r, ts) => {
    const state = r && states.get(r.t);
    if (!state) return null;
    for (const s of [15, 30, 60, 90, 120].filter((x) => x * 1000 <= BEAT_AFTER)) {
      const later = plan({ ...state, now: ts + s * 1000 }, config);
      if (later.actions.some((x) => x.kind === "heartbeat")) return s;
    }
    return null;
  };
  // Each live decision: the earliest sample within the lookback where the loop planned it.
  const compared = decisions
    .filter((d) => d.ts >= from && d.ts <= to)
    .map((d) => {
      // an adjudication matches a plan made after its own park, not an earlier park of the run
      const since = Math.max(d.ts - (d.type === "heartbeat" ? BEAT_BEFORE : LOOKBACK), d.parkedAt ?? -Infinity);
      const hit = results.find((r) => r.t >= since && r.t < d.ts && r.actions.some((x) => matches(x, d)));
      const before = [...results].reverse().find((r) => r.t < d.ts);
      const lag = hit === undefined && d.type === "heartbeat" ? beatLag(before, d.ts) : null;
      return {
        ...d,
        at: iso(d.ts),
        agreed: hit !== undefined || lag !== null,
        leadMinutes: hit ? Math.round((d.ts - hit.t) / MIN) : null,
        ...(lag !== null ? { lagSeconds: lag } : {}),
        planBefore: before ? before.actions.map((x) => x.key) : [],
        skippedBefore: before ? before.skipped.filter((s) => s.issue === d.issue) : [],
      };
    });
  // Each planned action: its first sample, and whether a live decision followed within an hour.
  const first = new Map();
  for (const r of results) for (const x of r.actions) if (!first.has(x.key)) first.set(x.key, { ...x, t: r.t, at: r.at });
  const extras = [...first.values()]
    .filter((x) => {
      const ahead = x.kind === "heartbeat" ? config.heartbeatEveryMs : LOOKBACK;
      return !decisions.some((d) => d.ts > x.t && d.ts <= x.t + ahead && matches(x, d));
    })
    .map((x) => ({ ...x, liveLater: decisions.filter((d) => matches(x, d)).map((d) => iso(d.ts)) }));

  fs.mkdirSync(a.out, { recursive: true });
  fs.writeFileSync(path.join(a.out, "replay.json"), JSON.stringify({ args: a, samples: results }, null, 1) + "\n");
  fs.writeFileSync(path.join(a.out, "comparison.json"), JSON.stringify({ args: a, decisions: compared, extras }, null, 1) + "\n");
  const by = (list, key) => list.reduce((m, x) => ({ ...m, [x[key]]: (m[x[key]] ?? 0) + 1 }), {});
  console.log(`samples ${results.length}, live decisions ${compared.length}, agreed ${compared.filter((d) => d.agreed).length}`);
  console.log("decisions by type:", JSON.stringify(by(compared, "type")));
  console.log("agreed by type:", JSON.stringify(by(compared.filter((d) => d.agreed), "type")));
  console.log("planned with no live decision within an hour, by kind:", JSON.stringify(by(extras, "kind")));
}

main().catch((err) => {
  console.error(`factory-loop-replay: ${err.message}`);
  process.exit(1);
});
