"use strict";
// The new-format input of callum-flow-evaluate (cbundy/dev-system#899, part of #534): reads the new
// factory events and maps each one to the record the evaluate derivations already read
// ({ state, ts, issue, actor, device, repo, event_id, note }, the note holding `key=value` tokens), so
// the metrics stay one copy. CommonJS, node built-ins only. docs/metrics.md, "Reading the new events".
//
// Two input shapes, one mapping:
//   the local log   ${CALLUM_EVENTS_DIR:-/persist/events}/factory/<owner>__<name>.jsonl: one event per
//                   line, the payload under `data`;
//   a view export   rows of factory.event_log (flat columns, no `data`), one JSON object per line.
// A payload field the view does not lift (reviewed.patch and test_weakened.restored are lifted by
// migration 0006) reads as absent from a view row.

const fs = require("node:fs");
const path = require("node:path");

// The new types that keep their own name as the old state, and need no note.
const SAME = new Set(["ready", "claimed", "claim_lost", "closed", "implementer_routed", "untrusted_stripped", "usage"]);
// A transition into these states is also the old delegated, fix_requested and merge_ready line.
const SYNTHESIZED = { building: "delegated", fixing: "fix_requested", "merge-queue": "merge_ready" };

// The metrics that need a state only the old log has, and why they read n/a under the new source.
const NA_METRICS = {
  waiting: "needs the v1-only run_started and parked events: the new log has neither, so ready-to-merge time cannot be split into pipeline-bound and dispatcher-bound",
  adjudicator_agreement: "pairs verdicts by the v1 run_id, which no new event carries",
};
// The sections that read the new events' pr, by and recovered fields; n/a under --source old.
const MERGE_SECTIONS = ["merges", "prs", "gaps"];
const NOTES = {
  first_pass: "the v1-only failed event does not exist in the new log: setbacks count fix_requested (a transition to fixing) only",
};

const iso = (x) => {
  if (x === null || x === undefined) return null;
  const t = Date.parse(x);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// tokens({k: v}): the note format of docs/factory-events/translator.md: percent-encoded values, none for null.
const tokens = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v === null ? "none" : encodeURIComponent(String(v))}`)
    .join(" ");

// mapEvent(raw): the records one new event gives, in order (none for a type the metrics do not read).
function mapEvent(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return [];
  const d = raw.data && typeof raw.data === "object" ? raw.data : raw;
  const get = (k) => (d[k] === undefined ? null : d[k]);
  const ts = iso(raw.ts);
  if (ts === null) return [];
  const base = {
    ts,
    issue: raw.issue === undefined ? null : raw.issue,
    actor: raw.actor || null,
    device: raw.device || null,
    repo: raw.repo || null,
    event_id: raw.event_id || null,
    device_seq: Number.isInteger(raw.device_seq) ? raw.device_seq : null,
    pr: Number.isInteger(d.pr) ? d.pr : null,
    regime: typeof raw.regime === "string" && raw.regime !== "" ? raw.regime : null,
    session_id: typeof raw.session_id === "string" && raw.session_id !== "" ? raw.session_id : null,
  };
  const rec = (state, note, at = ts) => ({ ...base, state, ts: at, note });
  switch (raw.type) {
    case "transition": {
      const at = iso(get("seq_at")) || ts;
      const note = tokens({ life: get("life"), seq: get("seq"), row: get("table_row"), from: get("from_state"), to: get("to_state"), via: get("via"), step: get("step"), round: get("round"), why: get("why"), question: get("question") === null ? null : "yes" });
      const out = [rec("transition", note, at)];
      const old = SYNTHESIZED[get("to_state")];
      if (old && get("from_state") !== get("to_state")) out.push(rec(old, null, at));
      return out;
    }
    case "finding_handled": {
      const prefix = get("outcome") === "fixed" ? "CORRECT" : get("outcome") === "declined" ? "WRONG" : null;
      return prefix ? [rec("verdict", `${prefix}: ${get("finding") || "-"}`)] : [];
    }
    case "merged":
      return [rec("merged", tokens({ by: get("by"), recovered: get("recovered") }))];
    case "claim_renewed":
      return [rec("renewed", null)];
    case "requeued":
      return [rec("reclaimed", null)];
    case "loop_entry":
      return [rec("loop", tokens({ kind: get("kind"), key: get("key"), status: get("status"), wake: get("wake") }))];
    case "loop_passes":
      return [rec("loop", tokens({ kind: "passes" }))];
    case "intervention":
      return [rec("intervention", tokens({ who: get("who"), cause: get("cause"), life: get("life"), fact: get("fact"), reason: get("detail") }))];
    case "reviewed":
      return [rec("reviewed", tokens({ verdict: get("verdict"), round: get("round"), patch: get("patch") }))];
    case "test_weakened":
      return [rec("test_weakened", tokens({ restored: get("restored") === true ? "yes" : "no" }))];
    case "abandoned":
      return [rec("abandoned", tokens({ reason: get("reason") }))];
    default:
      return SAME.has(raw.type) ? [rec(raw.type, null)] : [];
  }
}

// The transitions of one (issue, life, seq) count once, the first kept: a retried or re-claimed write
// logs it again.
const transitionKey = (raw) => {
  const d = raw.data && typeof raw.data === "object" ? raw.data : raw;
  return d.life !== undefined && d.life !== null && d.seq !== undefined && d.seq !== null ? `${raw.issue}|${d.life}|${d.seq}` : null;
};

// factory-event-shapes.json is found beside this module, else in $DEV_SYSTEM_SHARE, else in
// /usr/local/share/dev-system (the image copies it there beside this module).
let shapeVersions = null;
function currentShapes() {
  if (shapeVersions) return shapeVersions;
  const dirs = [__dirname, process.env.DEV_SYSTEM_SHARE || "/usr/local/share/dev-system"];
  const hit = dirs.map((d) => path.join(d, "factory-event-shapes.json")).find((f) => fs.existsSync(f));
  if (!hit) throw new Error(`cannot find factory-event-shapes.json beside the module or in ${dirs[1]}`);
  shapeVersions = JSON.parse(fs.readFileSync(hit, "utf8")).current;
  return shapeVersions;
}

// isCurrent(current, raw): whether the event's (type, type_version) is the pair the shapes file lists.
// A line with no type_version at all (every writer stamps one, so only a hand-made line lacks it) is
// not a newer writer's: only its type is checked.
const isCurrent = (current, raw) => Object.prototype.hasOwnProperty.call(current, raw.type)
  && (raw.type_version === undefined || current[raw.type] === raw.type_version);

// skippedList(counts): the Map of "type\0version" -> count as [{type, type_version, count}] sorted by type, then version.
function skippedList(counts) {
  return [...counts].map(([k, count]) => {
    const [type, v] = k.split("\0");
    return { type, type_version: JSON.parse(v), count };
  }).sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (a.type_version < b.type_version ? -1 : a.type_version > b.type_version ? 1 : 0));
}
const countSkip = (counts, raw) => {
  const k = `${raw.type}\0${JSON.stringify(raw.type_version === undefined ? null : raw.type_version)}`;
  counts.set(k, (counts.get(k) || 0) + 1);
};

// loadNewEvents(file): { events, reason, skipped }. A missing file reads as events null with the reason, as the
// old loader does; a line that is not JSON is skipped. A line whose (type, type_version) is not current
// in the shapes file (a newer writer) is left out and counted in `skipped`; a current type the metrics do
// not read is still dropped by mapEvent and is not counted.
function loadNewEvents(file) {
  if (!fs.existsSync(file)) return { events: null, reason: `file not found: ${file}`, skipped: [] };
  const current = currentShapes();
  const counts = new Map();
  const seen = new Set();
  const events = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw && typeof raw === "object" && typeof raw.type === "string" && !isCurrent(current, raw)) {
      countSkip(counts, raw);
      continue;
    }
    if (raw && raw.type === "transition") {
      const k = transitionKey(raw);
      if (k !== null) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
    }
    events.push(...mapEvent(raw));
  }
  return { events, reason: null, skipped: skippedList(counts) };
}

const localLog = (eventsDir, repo) => path.join(eventsDir || "/persist/events", "factory", `${repo.replace("/", "__")}.jsonl`);

// The per-issue lead-time stages that run between two events the new log times differently: the old
// delegated and merge_ready lines are written seconds after the transition they follow, the new ones are
// timed by that transition's seq_at (the total, ready to merged, is not affected).
const STAGE_FIELDS = ["design", "implementation", "pipeline", "waiting_for_merge"];

// normalize(report): the report with the differences known between the sources removed (documented in
// docs/metrics.md, "Reading the new events"): the sources block (it names the input), the metrics that
// read n/a under the new source (NA_METRICS), and the per-issue stage timings (STAGE_FIELDS).
function normalize(report) {
  const out = JSON.parse(JSON.stringify(report));
  delete out.sources;
  for (const k of Object.keys(NA_METRICS)) if (k in out) out[k] = "n/a (v1-only input)";
  // the merges, prs and gaps sections read the new events' pr, by and recovered fields, which the old
  // log has no equivalent of: n/a under --source old, so a shadow run records no difference for them
  for (const k of MERGE_SECTIONS) delete out[k];
  // by_regime has no counterpart under the old source, whose records carry no regime
  if (out.throughput && typeof out.throughput === "object") delete out.throughput.by_regime;
  if (out.spend && typeof out.spend === "object") delete out.spend.by_regime;
  if (out.throughput && Array.isArray(out.throughput.issues)) {
    for (const i of out.throughput.issues) for (const f of STAGE_FIELDS) delete i[f];
  }
  return out;
}

module.exports = { MERGE_SECTIONS, SYNTHESIZED, mapEvent, loadNewEvents, currentShapes, isCurrent, skippedList, countSkip, localLog, normalize, NA_METRICS, NOTES };
