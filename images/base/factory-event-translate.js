#!/usr/bin/env node
"use strict";
// factory-event-translate: turns one line of today's factory event log into at most one new event
// (docs/factory-events/translator.md is the mapping; docs/factory-events/schemas/ the output).
//
//   translate(line, opts) -> exactly one of
//     { event }          the new event, whole
//     { skip: "<name>" } a line that makes no new event, skipped by name
//     { miss: "<state>: <reason>" } a line that matches no shape: never a guess, never partial
//
// It is pure and deterministic: no clock, environment, file or network reads. `line` is the old
// line as a string of JSON or as the parsed object. With no `opts` it is the replay: `ts` is the
// stored second plus `.000Z` and `session_id` is copied. With `opts` ({ ts?, sessionId? }) it is
// dual write: `ts` and `session_id` come from opts (session_id null when sessionId is absent; a
// missing ts falls back to the replay's).
//
// CommonJS with no dependencies: callum-flow-event (dual write) and the replay script both use it.
// Temporary: deleted with the old event path (dev-system#656).
//
// CLI: node factory-event-translate.js [--ts T --session-id S] [--quiet] < old.jsonl > new.jsonl
//   One stderr line per miss and a summary of counts per state (--quiet drops the summary); exit 1 on any miss, else 0.

// --- the token codec (plugins/factory-loop/hooks/v2/events.ts: dec, tokensOf, noteToken) ---------
// The image cannot import the plugin, so this is a copy; tests/factory-event-translate.test.js
// proves it reads every corpus note as the plugin's functions do.

function dec(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

// A note's `key=value` tokens, the first of each key; words without `=` are skipped.
function tokensOf(note) {
  const out = new Map();
  if (note === null || note === undefined) return out;
  for (const word of note.split(" ")) {
    const i = word.indexOf("=");
    if (i > 0 && !out.has(word.slice(0, i))) out.set(word.slice(0, i), word.slice(i + 1));
  }
  return out;
}

// One token's value, decoded (`none` is null); undefined when the note lacks it.
function noteToken(note, key) {
  const v = tokensOf(note).get(key);
  if (v === undefined) return undefined;
  return v === "none" ? null : dec(v);
}

// --- misses and skips -----------------------------------------------------------------------------

class Miss extends Error {}
class Skip {
  constructor(name) {
    this.name = name;
  }
}
const miss = (why) => {
  throw new Miss(why);
};

// --- the field kinds each output is checked against -----------------------------------------------
// A miss is better than an event a strict reader would refuse, so every output is checked against
// the shape of its schema before it is returned.

const nul = (k) => (v) => v === null || k(v);
const S = (v) => typeof v === "string";
const NE = (v) => typeof v === "string" && v.length > 0;
const I = (min) => (v) => Number.isInteger(v) && v >= min;
const E = (...xs) => (v) => xs.includes(v);
const B = (v) => typeof v === "boolean";
const RX = (re) => (v) => typeof v === "string" && re.test(v);
const L = (k) => (v) => Array.isArray(v) && v.every(k);
const L1 = (k) => (v) => L(k)(v) && v.length > 0;
const opt = (k) => Object.assign((v) => k(v), { optional: true });
const COND = (v) =>
  v !== null &&
  typeof v === "object" &&
  ((Object.keys(v).length === 2 && v.kind === "issue-closed" && I(1)(v.issue)) ||
    (Object.keys(v).length === 2 && v.kind === "pr-merged" && I(1)(v.pr)) ||
    (Object.keys(v).length === 2 && v.kind === "tag-contains" && HEX(v.sha)));
const WAIT = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 8 && v.every(COND);
const HEX = RX(/^[0-9a-f]{7,40}$/);
const ISO = RX(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
const STATES = ["queued", "designing", "building", "reviewing", "fixing", "merge-queue", "parked", "waiting", "closed"];

const SPECS = {
  ready: {},
  claimed: { lease_minutes: I(1) },
  claim_renewed: { lease_minutes: I(1) },
  claim_lost: { holder: nul(S), holder_since: nul(S), race: B },
  requeued: { reason: E("lease-expired", "reconcile"), stage: nul(S), lives: nul(I(1)), branch: nul(S), pr: nul(I(1)), detail: nul(S) },
  closed: { reason: nul(S) },
  abandoned: {
    reason: E("dropped", "split", "triage", "reconcile", "rejected", "other"),
    split_into: L(Number.isInteger),
    why_split: nul(S),
    why_count: nul(S),
    why_parts: nul(S),
    why_order: nul(S),
    child_whys: nul(L(S)),
    stage: nul(S),
    lives: nul(I(1)),
    branch: nul(S),
    pr: nul(I(1)),
    detail: nul(S),
  },
  merged: { pr: nul(I(1)), branch: nul(S), head: nul(HEX), by: E("factory", "hand"), recovered: B },
  transition: {
    life: RX(/^[0-9a-z]+$/),
    seq: I(0),
    table_row: RX(/^([A-Z][0-9]+|recovered)$/),
    from_state: nul(E(...STATES)),
    to_state: E(...STATES),
    via: RX(/^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/),
    seq_at: ISO,
    state_since: ISO,
    resume_to: nul(E(...STATES)),
    branch: NE,
    pr: nul(I(1)),
    head: nul(HEX),
    approved_patch: nul(S),
    brief_url: nul(S),
    step: nul(E("lease", "design", "build", "review", "fix", "queue", "triage")),
    attempt: I(1),
    cut: B,
    triages: I(0),
    fixes: I(0),
    round: I(0),
    question: nul(S),
    wait: opt(nul(WAIT)),
    why: nul(E("merged", "merged-by-hand", "dropped", "split", "closed-on-github", "claim-lost")),
    notes: L(S),
    pr_closed_at: nul(S),
    lives: I(1),
  },
  reviewed: { branch: NE, pr: I(1), head: HEX, verdict: E("approve", "changes", "unknown"), round: I(1), patch: NE, errors: I(0), warnings: I(0), infos: I(0), reviewer: NE, answer_path: NE },
  finding_handled: { branch: NE, pr: nul(I(1)), head: nul(HEX), finding: NE, outcome: E("fixed", "declined"), detail: S },
  intervention: { who: E("person", "loop"), cause: RX(/^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/), life: nul(RX(/^[0-9a-z]+$/)), fact: nul(S), pr: nul(I(1)), detail: S },
  implementer_routed: { model: NE, reason: E("label", "default", "hash", "fallback"), bucket: nul(I(0)), opus_pct: I(0) },
  test_weakened: { branch: NE, pr: I(1), head: HEX, commit: HEX, restored: B, kinds: L1(S), files: L1(S) },
  untrusted_stripped: { source: E("issue", "pr", "comment", "comments", "timeline", "list"), refused: B, count: nul(I(0)), pr: nul(I(1)) },
  usage: {
    available: B,
    five_hour_pct: nul(I(0)),
    five_hour_resets_at: nul(S),
    seven_day_pct: nul(I(0)),
    seven_day_resets_at: nul(S),
    source: nul(E("oauth", "statusline")),
    reasons: L(S),
  },
  loop_entry: {
    kind: E("agent-step", "tell", "task"),
    key: NE,
    status: E("running", "done", "failed", "timed-out", "lost"),
    attempts: I(0),
    class: E("free", "owner", "drive", "develop", "start"),
    rule: NE,
    started_at: ISO,
    ended_at: nul(ISO),
    agent_id: nul(S),
    wake: nul(S),
  },
  loop_passes: {
    from_at: ISO,
    to_at: ISO,
    passes: I(0),
    acting: I(0),
    errors: I(0),
    mean_ms: nul(I(0)),
    p50_ms: nul(I(0)),
    p90_ms: nul(I(0)),
    max_ms: nul(I(0)),
    acting_mean_ms: nul(I(0)),
    idle_mean_ms: nul(I(0)),
    mode: E("off", "observe", "act"),
    planner: E("v1", "v2"),
    pass_every_ms: I(1),
  },
};

// The types whose schema says `x-issue: required`: their line must carry an issue.
const ISSUE_REQUIRED = new Set(["ready", "claimed", "claim_renewed", "claim_lost", "requeued", "closed", "abandoned", "merged", "transition", "reviewed", "finding_handled", "test_weakened", "untrusted_stripped"]);

function checkData(type, data) {
  const spec = SPECS[type];
  for (const k of Object.keys(data)) if (!(k in spec)) miss(`internal: unexpected field ${k}`);
  for (const [k, fits] of Object.entries(spec)) {
    if (!(k in data) || (fits.optional && data[k] === undefined)) {
      if (fits.optional) continue;
      miss(`internal: field ${k} not set`);
    }
    if (!fits(data[k])) miss(`${k} is not valid: ${JSON.stringify(data[k])}`);
  }
}

// --- reading tokens -------------------------------------------------------------------------------

// A token note as a Map. Every word must be `key=value`, every key must be in `keep` or `drop`
// (named), and every key in `need` must be there: anything else is a miss naming the token.
function strictTokens(note, { keep, drop = [], need = [] }) {
  if (note === null || note === undefined) miss("the note is missing");
  const known = new Set([...keep, ...drop]);
  const out = new Map();
  for (const word of note.split(" ")) {
    const i = word.indexOf("=");
    if (i <= 0) miss(`unreadable word in the note: ${JSON.stringify(word)}`);
    const k = word.slice(0, i);
    if (!known.has(k)) miss(`unexpected token ${k}=`);
    if (!out.has(k)) out.set(k, word.slice(i + 1));
  }
  for (const k of need) if (!out.has(k)) miss(`missing token ${k}=`);
  return out;
}

// A string value (`none` is null); undefined when absent.
function tStr(t, k) {
  const v = t.get(k);
  if (v === undefined) return undefined;
  return v === "none" ? null : dec(v);
}
// A string value that must be present, else null.
const tStrN = (t, k) => tStr(t, k) ?? null;

// An integer value (`none` is null when allowed); undefined when absent.
function tInt(t, k, nullable = false) {
  const v = t.get(k);
  if (v === undefined) return undefined;
  if (v === "none") {
    if (nullable) return null;
    miss(`bad number ${k}=${v}`);
  }
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) miss(`bad number ${k}=${v}`);
  return Number(v);
}

function tBool(t, k) {
  const v = t.get(k);
  if (v === undefined) return undefined;
  if (v === "yes") return true;
  if (v === "no") return false;
  return miss(`bad yes/no ${k}=${v}`);
}

// Epoch milliseconds as ISO 8601 with three millisecond digits.
function msToIso(v, k) {
  if (v === undefined) return undefined;
  if (v === "none") return null;
  if (!/^\d+$/.test(v)) miss(`bad time ${k}=${v}`);
  const d = new Date(Number(v));
  if (Number.isNaN(d.getTime())) miss(`bad time ${k}=${v}`);
  return d.toISOString();
}

// A comma list, each item decoded; `none` and an empty value are the empty list.
function tList(t, k) {
  const v = t.get(k);
  if (v === undefined) return undefined;
  return v === "none" || v === "" ? [] : v.split(",").map(dec);
}

// The wait list: `issue:<n>`, `pr:<n>`, `tag:<sha>`, comma-joined; `none` is null; absent is undefined.
function tWait(t) {
  const v = t.get("wait");
  if (v === undefined) return undefined;
  if (v === "none") return null;
  const items = v.split(",");
  if (items.length > 8) miss(`bad wait=: more than 8 items`);
  return items.map((item) => {
    const i = item.indexOf(":");
    const prefix = i < 0 ? item : item.slice(0, i);
    const arg = i < 0 ? "" : item.slice(i + 1);
    if (prefix === "issue" || prefix === "pr") {
      if (!/^[1-9][0-9]*$/.test(arg)) miss(`bad wait=: ${JSON.stringify(item)}`);
      return prefix === "issue" ? { kind: "issue-closed", issue: Number(arg) } : { kind: "pr-merged", pr: Number(arg) };
    }
    if (prefix === "tag") {
      if (!/^[0-9a-f]{7,40}$/.test(arg)) miss(`bad wait=: ${JSON.stringify(item)}`);
      return { kind: "tag-contains", sha: arg };
    }
    return miss(`bad wait=: ${JSON.stringify(item)}`);
  });
}

// --- the columns ----------------------------------------------------------------------------------

function colStr(line, k) {
  const v = line[k];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") miss(`column ${k} is not text`);
  return v;
}
function colInt(line, k) {
  const v = line[k];
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v)) miss(`column ${k} is not a number`);
  return v;
}
const need = (v, what) => (v === null || v === undefined ? miss(`${what} is missing`) : v);

// --- the shapes -----------------------------------------------------------------------------------

function leaseOf(line) {
  const note = line.note ?? null;
  if (note === null) return { lease_minutes: 120 };
  const m = /^lease: (\d+)$/.exec(note);
  if (m === null) return miss(`note matches no lease shape: ${JSON.stringify(note)}`);
  return { lease_minutes: Number(m[1]) };
}

function claimLost(line) {
  const note = line.note ?? "";
  let m = /^held by (\S+) since (\S+)$/.exec(note);
  if (m !== null) return { holder: m[1], holder_since: m[2], race: false };
  m = /^race lost to (.+)$/.exec(note);
  if (m !== null) return { holder: m[1] === "another device" ? null : m[1], holder_since: null, race: true };
  return miss(`note matches no claim_lost shape: ${JSON.stringify(note)}`);
}

// The note of a reconcile release (reclaimed or abandoned): reason, outcome, lives, stage, pr, checked.
function releaseTokens(note) {
  const t = strictTokens(note, { keep: ["reason", "outcome", "lives", "stage", "pr", "checked"], need: ["reason", "stage", "pr", "checked"] });
  return {
    reason: tStr(t, "reason"),
    outcome: tStr(t, "outcome") ?? null,
    stage: tStrN(t, "stage"),
    lives: tInt(t, "lives", true) ?? null,
    pr: tInt(t, "pr", true),
    detail: tStrN(t, "checked"),
  };
}

function reclaimed(line) {
  const note = line.note ?? null;
  const branch = colStr(line, "branch");
  const pr = colInt(line, "pr");
  if (note === "lease expired") return { reason: "lease-expired", stage: null, lives: null, branch, pr, detail: null };
  if (note === null || !note.startsWith("reason=")) return miss(`note matches no reclaimed shape: ${JSON.stringify(note)}`);
  const r = releaseTokens(note);
  if (r.reason !== "reconcile") miss(`reclaimed reason=${r.reason} is not reconcile`);
  if (r.outcome !== null && r.outcome !== "requeue") miss(`reclaimed outcome=${r.outcome} is not requeue`);
  return { reason: "reconcile", stage: r.stage, lives: r.lives, branch, pr: pr ?? r.pr, detail: r.detail };
}

const WHY_TOKENS = ["why_split", "why_count", "why_parts", "why_order"];
const ABANDON_REASONS = ["dropped", "split", "triage", "other"];

function splitList(text) {
  const m = /split into (\d+(?:\s*,\s*\d+)*)/i.exec(text ?? "");
  return m === null ? [] : m[1].split(",").map((n) => Number(n.trim()));
}

function abandoned(line) {
  const note = line.note ?? null;
  const branch = colStr(line, "branch");
  const pr = colInt(line, "pr");
  const base = { split_into: [], why_split: null, why_count: null, why_parts: null, why_order: null, child_whys: null, stage: null, lives: null, branch, pr, detail: null };
  if (note !== null && note.startsWith("reason=")) {
    const first = /^reason=(\S*)/.exec(note)[1];
    if (first === "reconcile") {
      // shapes 1 and 2
      const r = releaseTokens(note);
      let reason;
      if (r.outcome === "reject") reason = "rejected";
      else if (r.outcome === "leave" || r.outcome === null) reason = "reconcile";
      else return miss(`abandoned outcome=${r.outcome} is not reject or leave`);
      return { ...base, reason, stage: r.stage, lives: r.lives, pr: pr ?? r.pr, detail: r.detail };
    }
    // shape 3
    const t = strictTokens(note, { keep: ["reason", "note", ...WHY_TOKENS, "child_whys"], need: ["reason", "note"] });
    const reason = tStr(t, "reason");
    if (!ABANDON_REASONS.includes(reason)) miss(`abandoned reason=${reason} is none of ${ABANDON_REASONS.join(", ")}`);
    const detail = tStrN(t, "note");
    const out = { ...base, reason, split_into: reason === "split" ? splitList(detail) : [], detail };
    if (reason === "split") {
      // a v2 split's reasons: plain encoded text, so a reason that reads "none" stays text
      for (const k of WHY_TOKENS) if (t.has(k)) out[k] = dec(t.get(k));
      const kids = t.get("child_whys");
      if (kids !== undefined && kids !== "none") out.child_whys = tList(t, "child_whys");
    }
    return out;
  }
  // shapes 4 and 5: the first word says the reason, as abandonReason does (v2/events.ts)
  if (note === null || note === "") return { ...base, reason: "other" };
  const word = (/^\W*(\w+)/.exec(note)?.[1] ?? "").toLowerCase();
  let reason = "other";
  if (word === "split") reason = "split";
  else if (word === "triage") reason = "triage";
  else if (word === "drop" || word === "dropped") reason = "dropped";
  return { ...base, reason, split_into: reason === "split" ? splitList(note) : [], detail: note };
}

function merged(line) {
  const note = line.note ?? null;
  let by = "hand";
  let recovered = true;
  if (note === null) {
    by = "factory";
    recovered = false;
  } else if (note === "merged by the factory loop") by = "factory";
  return { pr: colInt(line, "pr"), branch: colStr(line, "branch"), head: colStr(line, "head"), by, recovered };
}

const TRANSITION_KEEP = ["row", "life", "seq", "from", "to", "seqAt", "since", "resumeTo", "step", "attempt", "cut", "triages", "fixes", "round", "why", "approvedPatch", "prClosedAt", "lives", "via", "brief", "question", "notes", "wait"];

function transition(line) {
  const t = strictTokens(line.note ?? null, { keep: TRANSITION_KEEP, need: TRANSITION_KEEP.filter((k) => k !== "lives" && k !== "wait") });
  const lives = t.has("lives") ? tInt(t, "lives") : 1;
  const wait = tWait(t);
  const ev = {
    life: tStr(t, "life"),
    seq: tInt(t, "seq"),
    table_row: tStr(t, "row"),
    from_state: tStr(t, "from"),
    to_state: tStr(t, "to"),
    via: tStr(t, "via"),
    seq_at: msToIso(t.get("seqAt"), "seqAt"),
    state_since: msToIso(t.get("since"), "since"),
    resume_to: tStr(t, "resumeTo"),
    branch: colStr(line, "branch"),
    pr: colInt(line, "pr"),
    head: colStr(line, "head"),
    approved_patch: tStr(t, "approvedPatch"),
    brief_url: tStr(t, "brief"),
    step: tStr(t, "step"),
    attempt: tInt(t, "attempt"),
    cut: tBool(t, "cut"),
    triages: tInt(t, "triages"),
    fixes: tInt(t, "fixes"),
    round: tInt(t, "round"),
    question: tStr(t, "question"),
    why: tStr(t, "why"),
    notes: tList(t, "notes"),
    pr_closed_at: tStr(t, "prClosedAt"),
    lives,
  };
  if (wait !== undefined) ev.wait = wait;
  return ev;
}

function reviewed(line) {
  const t = strictTokens(line.note ?? null, { keep: ["verdict", "round", "patch", "errors", "warnings", "infos", "reviewer", "answer"], need: ["verdict", "round", "patch", "errors", "warnings", "infos", "reviewer", "answer"] });
  return {
    branch: colStr(line, "branch"),
    pr: colInt(line, "pr"),
    head: colStr(line, "head"),
    verdict: tStr(t, "verdict"),
    round: tInt(t, "round"),
    patch: tStr(t, "patch"),
    errors: tInt(t, "errors"),
    warnings: tInt(t, "warnings"),
    infos: tInt(t, "infos"),
    reviewer: tStr(t, "reviewer"),
    answer_path: tStr(t, "answer"),
  };
}

function verdict(line) {
  const note = line.note ?? "";
  const prefix = /^(NIT|DUP|ENV)\b/.exec(note);
  if (prefix !== null) throw new Skip(`verdict ${prefix[1]}`);
  const m = /^(CORRECT|WRONG):\s+(\S+)\s*([\s\S]*)$/.exec(note);
  if (m === null) return miss(`note matches no verdict shape: ${JSON.stringify(note.slice(0, 60))}`);
  const finding = m[2].replace(/:$/, "");
  return {
    branch: colStr(line, "branch"),
    pr: colInt(line, "pr"),
    head: colStr(line, "head"),
    finding,
    outcome: m[1] === "CORRECT" ? "fixed" : "declined",
    detail: m[3].trim(),
  };
}

function intervention(line) {
  const t = strictTokens(line.note ?? null, { keep: ["who", "cause", "life", "fact", "reason"], need: ["who", "cause"] });
  return {
    who: tStr(t, "who"),
    cause: tStr(t, "cause"),
    life: tStrN(t, "life"),
    fact: tStrN(t, "fact"),
    pr: colInt(line, "pr"),
    detail: tStr(t, "reason") ?? "",
  };
}

function implementerRouted(line) {
  const t = strictTokens(line.note ?? null, { keep: ["model", "reason", "bucket", "pct"], need: ["model", "reason", "bucket", "pct"] });
  const b = t.get("bucket");
  return { model: tStr(t, "model"), reason: tStr(t, "reason"), bucket: b === "-" ? null : tInt(t, "bucket", true), opus_pct: tInt(t, "pct") };
}

function testWeakened(line) {
  // step names a no-mistakes step and is always `none` under v2: dropped
  const keep = ["commit", "restored", "kinds", "files"];
  const t = strictTokens(line.note ?? null, { keep, drop: ["step"], need: keep });
  return {
    branch: colStr(line, "branch"),
    pr: colInt(line, "pr"),
    head: colStr(line, "head"),
    commit: tStr(t, "commit"),
    restored: tBool(t, "restored"),
    kinds: tList(t, "kinds"),
    files: tList(t, "files"),
  };
}

function untrustedStripped(line) {
  const note = line.note ?? "";
  const pr = colInt(line, "pr");
  let m = /^list stripped=(\d+)$/.exec(note);
  if (m !== null) return { source: "list", refused: false, count: Number(m[1]), pr };
  m = /^(timeline|comments)=(\d+)$/.exec(note);
  if (m !== null) return { source: m[1], refused: false, count: Number(m[2]), pr };
  if (note === "issue" || note === "pr" || note === "comment") return { source: note, refused: true, count: null, pr };
  return miss(`note matches no untrusted_stripped shape: ${JSON.stringify(note)}`);
}

function usage(line) {
  const note = line.note ?? null;
  if (note !== null && note.startsWith("usage=")) {
    const t = strictTokens(note, { keep: ["usage", "reason"], need: ["usage", "reason"] });
    if (t.get("usage") !== "unavailable") miss(`usage=${t.get("usage")} is not unavailable`);
    return { available: false, five_hour_pct: null, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null, source: null, reasons: tList(t, "reason") };
  }
  // resets_in and seven_day_resets_in are dropped: each is the reset time minus ts
  const keep = ["five_hour", "resets_at", "seven_day", "seven_day_resets_at", "source"];
  const t = strictTokens(note, { keep, drop: ["resets_in", "seven_day_resets_in"], need: keep });
  return {
    available: true,
    five_hour_pct: tInt(t, "five_hour", true),
    five_hour_resets_at: tStr(t, "resets_at"),
    seven_day_pct: tInt(t, "seven_day", true),
    seven_day_resets_at: tStr(t, "seven_day_resets_at"),
    source: tStr(t, "source"),
    reasons: [],
  };
}

const V1_LOOP_KINDS = ["spawn", "delegate", "judge"];
const PASSES_KEYS = ["kind", "key", "status", "from", "to", "passes", "mean_ms", "p50_ms", "p90_ms", "max_ms", "acting", "acting_mean_ms", "idle_mean_ms", "errors", "mode", "planner", "pass_every_ms"];

function passes(line) {
  const t = strictTokens(line.note ?? null, { keep: PASSES_KEYS, need: PASSES_KEYS });
  if (t.get("status") !== "done") miss(`passes status=${t.get("status")} is not done`);
  const from = t.get("from");
  const fromMs = ISO(from) ? Date.parse(from) : NaN;
  if (Number.isNaN(fromMs)) miss(`bad time from=${from}`);
  if (t.get("key") !== `passes:${fromMs}`) miss(`passes key=${t.get("key")} is not passes:<epoch ms of from> (passes:${fromMs})`);
  const ms = (k) => tInt(t, k, true);
  return {
    from_at: from,
    to_at: tStr(t, "to"),
    passes: tInt(t, "passes"),
    acting: tInt(t, "acting"),
    errors: tInt(t, "errors"),
    mean_ms: ms("mean_ms"),
    p50_ms: ms("p50_ms"),
    p90_ms: ms("p90_ms"),
    max_ms: ms("max_ms"),
    acting_mean_ms: ms("acting_mean_ms"),
    idle_mean_ms: ms("idle_mean_ms"),
    mode: tStr(t, "mode"),
    planner: tStr(t, "planner"),
    pass_every_ms: tInt(t, "pass_every_ms"),
  };
}

// loop: skips first (they carry tokens the entry does not), then the passes summary, then an entry.
function loop(line) {
  const note = line.note ?? null;
  const kind = noteToken(note, "kind");
  const key = noteToken(note, "key");
  const status = noteToken(note, "status");
  if (kind === "breaker") throw new Skip("loop kind=breaker");
  if (typeof key === "string" && key.startsWith("cap:") && status === "held") throw new Skip("loop key=cap:* status=held");
  if (V1_LOOP_KINDS.includes(kind)) throw new Skip(`loop kind=${kind}`);
  if (kind === "passes") return { type: "loop_passes", data: passes(line) };
  // agent= and the v1 outcome tokens out= and decision= are named drops
  const keep = ["kind", "key", "status", "attempts", "class", "rule", "started", "ended", "agentId", "wake"];
  const t = strictTokens(note, { keep, drop: ["agent", "out", "decision"], need: ["kind", "key", "status", "attempts", "class", "rule", "started"] });
  return {
    type: "loop_entry",
    data: {
      kind: tStr(t, "kind"),
      key: tStr(t, "key"),
      status: tStr(t, "status"),
      attempts: tInt(t, "attempts"),
      class: tStr(t, "class"),
      rule: tStr(t, "rule"),
      started_at: msToIso(t.get("started"), "started"),
      ended_at: t.has("ended") ? msToIso(t.get("ended"), "ended") : null,
      agent_id: tStrN(t, "agentId"),
      wake: tStrN(t, "wake"),
    },
  };
}

// Lines that make no new event, skipped by name: the state is the name.
const SKIPPED_STATES = ["delegated", "fix_requested", "merge_ready", "prompt_denied", "prompt_waiting", "briefed", "design_routed", "run_started", "parked", "failed", "head_mismatch", "conflict", "ci_stalled", "rebased_behind", "superseded", "watcher_error"];

// The states that translate (some of their lines skip: loop, verdict), each to its handler.
const MAPPED = {
  ready: () => ({ type: "ready", data: {} }),
  claimed: (l) => ({ type: "claimed", data: leaseOf(l) }),
  renewed: (l) => ({ type: "claim_renewed", data: leaseOf(l) }),
  claim_lost: (l) => ({ type: "claim_lost", data: claimLost(l) }),
  reclaimed: (l) => ({ type: "requeued", data: reclaimed(l) }),
  closed: (l) => ({ type: "closed", data: { reason: l.note === undefined || l.note === null || l.note === "" ? null : l.note } }),
  abandoned: (l) => {
    const { reason, ...rest } = abandoned(l);
    return { type: "abandoned", data: { reason, ...rest } };
  },
  merged: (l) => ({ type: "merged", data: merged(l) }),
  transition: (l) => ({ type: "transition", data: transition(l) }),
  reviewed: (l) => ({ type: "reviewed", data: reviewed(l) }),
  verdict: (l) => ({ type: "finding_handled", data: verdict(l) }),
  intervention: (l) => ({ type: "intervention", data: intervention(l) }),
  implementer_routed: (l) => ({ type: "implementer_routed", data: implementerRouted(l) }),
  test_weakened: (l) => ({ type: "test_weakened", data: testWeakened(l) }),
  untrusted_stripped: (l) => ({ type: "untrusted_stripped", data: untrustedStripped(l) }),
  usage: (l) => ({ type: "usage", data: usage(l) }),
  loop,
};
const MAPPED_STATES = Object.keys(MAPPED);

// --- the envelope ---------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function envelope(line, type, data, opts) {
  if (typeof line.event_id !== "string" || line.event_id === "") miss("the line has no event_id");
  if (!UUID.test(line.event_id)) miss(`event_id is not a UUID: ${JSON.stringify(line.event_id)}`);
  let ts;
  if (opts !== undefined && opts !== null && opts.ts !== undefined && opts.ts !== null) {
    ts = opts.ts;
    if (!ISO(ts)) miss(`ts from the writer is not ISO with milliseconds: ${JSON.stringify(ts)}`);
  } else {
    if (!RX(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)(line.ts)) miss(`bad time ts=${JSON.stringify(line.ts)}`);
    ts = `${line.ts.slice(0, -1)}.000Z`;
  }
  if (Number.isNaN(Date.parse(ts))) miss(`bad time ts=${ts}`);
  let session;
  if (opts !== undefined && opts !== null) session = opts.sessionId ?? null;
  else session = line.session_id ?? null;
  if (session !== null && typeof session !== "string") miss("session_id is not text");
  const issue = line.issue === undefined ? null : line.issue;
  if (issue !== null && !I(1)(issue)) miss(`bad number issue=${JSON.stringify(issue)}`);
  if (issue === null && ISSUE_REQUIRED.has(type)) miss(`${type} needs an issue and the line has none`);
  const text = (k) => {
    const v = line[k] === undefined ? null : line[k];
    if (v !== null && typeof v !== "string") miss(`${k} is not text`);
    return v;
  };
  const repo = text("repo");
  if (repo === null || !/^[^/\s]+\/[^/\s]+$/.test(repo)) miss(`repo is not owner/name: ${JSON.stringify(repo)}`);
  for (const k of ["device", "actor"]) if (!NE(line[k])) miss(`${k} is missing`);
  return {
    envelope: 1,
    event_id: line.event_id,
    ts,
    type,
    type_version: 1,
    repo,
    device: line.device,
    actor: line.actor,
    session_id: session,
    issue,
    base_image: text("base_image"),
    dev_image: text("dev_image"),
    template_version: text("template_version"),
    plugin_version: text("plugin_version"),
    data,
  };
}

// --- translate ------------------------------------------------------------------------------------

function translate(input, opts) {
  let line = input;
  if (typeof line === "string") {
    try {
      line = JSON.parse(line);
    } catch {
      return { miss: "?: the line is not JSON" };
    }
  }
  if (line === null || typeof line !== "object" || Array.isArray(line)) return { miss: "?: the line is not an object" };
  const state = typeof line.state === "string" ? line.state : "?";
  try {
    if (typeof line.state !== "string") miss("the line has no state");
    if (SKIPPED_STATES.includes(state)) return { skip: state };
    const handler = MAPPED[state];
    if (handler === undefined) return miss("unknown state");
    const { type, data } = handler(line);
    checkData(type, data);
    return { event: envelope(line, type, data, opts) };
  } catch (e) {
    if (e instanceof Skip) return { skip: e.name };
    if (e instanceof Miss) return { miss: `${state}: ${e.message}` };
    throw e;
  }
}

// --- the CLI --------------------------------------------------------------------------------------

function main(argv) {
  const fs = require("node:fs");
  let ts;
  let sessionId;
  let dual = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ts" && i + 1 < argv.length) {
      ts = argv[++i];
      dual = true;
    } else if (argv[i] === "--session-id" && i + 1 < argv.length) {
      sessionId = argv[++i];
      dual = true;
    } else if (argv[i] === "--quiet") {
      quiet = true;
    } else {
      process.stderr.write("usage: factory-event-translate.js [--ts T --session-id S] [--quiet] < old.jsonl > new.jsonl\n");
      return 2;
    }
  }
  const opts = dual ? { ts, sessionId } : undefined;
  const counts = new Map();
  const bump = (state, what) => {
    const c = counts.get(state) ?? { translated: 0, skipped: 0, missed: 0 };
    c[what] += 1;
    counts.set(state, c);
  };
  const out = [];
  let missed = 0;
  const lines = fs.readFileSync(0, "utf8").split("\n");
  lines.forEach((text, i) => {
    if (text.trim() === "") return;
    const r = translate(text, opts);
    let state = "?";
    try {
      state = JSON.parse(text).state ?? "?";
    } catch {
      /* not JSON: counted under ? */
    }
    if (r.event !== undefined) {
      out.push(JSON.stringify(r.event));
      bump(state, "translated");
    } else if (r.skip !== undefined) bump(state, "skipped");
    else {
      missed += 1;
      bump(state, "missed");
      process.stderr.write(`line ${i + 1}: miss: ${r.miss}\n`);
    }
  });
  if (out.length > 0) process.stdout.write(`${out.join("\n")}\n`);
  for (const state of quiet ? [] : [...counts.keys()].sort()) {
    const c = counts.get(state);
    process.stderr.write(`summary: ${state} translated=${c.translated} skipped=${c.skipped} missed=${c.missed}\n`);
  }
  return missed > 0 ? 1 : 0;
}

module.exports = { translate, tokensOf, noteToken, MAPPED_STATES, SKIPPED_STATES, SPECS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
