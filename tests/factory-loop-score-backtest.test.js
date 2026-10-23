"use strict";

// The claim score's backtests (plugins/factory-loop/hooks/v2/score.ts, docs/spikes/queue-scoring):
// the real score(), FACTORS, default weights and S1 comparator drain the spike's 30 issues "all
// ready at once". Plugin tests cannot read files, so they run here under Node.
//
// Drain rules: blockers respected; a drained issue counts as closed; an issue outside the set is
// open unless facts.json dates its close before 2026-10-18T17:15Z; readyAt is now; no failed lives;
// nothing held.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { register } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

// The plugin's modules import each other without a file extension; plain Node needs the ".ts"
// (scripts/factory-loop-replay.js does the same).
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

const SPIKE = path.join(__dirname, "..", "docs", "spikes", "queue-scoring");
const read = (file) => JSON.parse(fs.readFileSync(path.join(SPIKE, file), "utf8"));
const CUTOFF = Date.parse("2026-10-18T17:15:00Z");
const NOW = Date.parse("2026-10-20T12:00:00Z");

let score, FACTORS, compareRanked, DEFAULT_CONFIG;
before(async () => {
  const hooks = path.join(__dirname, "..", "plugins", "factory-loop", "hooks");
  ({ score, FACTORS, compareRanked } = await import(path.join(hooks, "v2", "score.ts")));
  ({ DEFAULT_CONFIG } = await import(path.join(hooks, "config.ts")));
});

function drain(facts, weights, factors, labelsOf = (labels) => labels) {
  const set = new Set(facts.issues.map((i) => i.issue));
  const byNumber = new Map(facts.issues.map((i) => [i.issue, i]));
  const drained = new Set();
  const blocks = (n) => facts.blocks[String(n)] ?? [];
  const blockersOf = (n) => Object.keys(facts.blocks).filter((b) => facts.blocks[b].includes(n)).map(Number);
  const closedAt = (n) => (facts.closedAt[String(n)] === undefined ? Infinity : Date.parse(facts.closedAt[String(n)]));
  const isOpen = (n) => (set.has(n) ? !drained.has(n) : closedAt(n) > CUTOFF);
  const ctx = { now: NOW, weights, priorityLabel: "priority", held: new Set(), blocking: (n) => blocks(n).filter(isOpen), failedLives: () => 0 };
  const order = [];
  while (order.length < set.size) {
    const claimable = [...set].filter((n) => !drained.has(n) && blockersOf(n).every((b) => !isOpen(b)));
    const ranked = claimable
      .map((n) => {
        const f = byNumber.get(n);
        const sub = f.parent === null ? undefined : facts.subIssues[String(f.parent)];
        const view = {
          number: n,
          labels: labelsOf(f.labels),
          blockingList: blocks(n).filter(isOpen),
          parent: sub === undefined ? null : f.parent,
          siblings: sub === undefined ? null : sub.filter((s) => s !== n).map((s) => ({ number: s, open: isOpen(s) })),
          readyAt: NOW,
          blockersClosedAt: null,
        };
        return { issue: n, score: score(view, ctx, factors).score, claimableAt: NOW };
      })
      .sort(compareRanked);
    drained.add(ranked[0].issue);
    order.push(ranked[0].issue);
  }
  return order;
}

test("backtest 1: this issue's factors and default weights drain to the pinned order", () => {
  const facts = read("facts.json");
  assert.deepEqual(drain(facts, DEFAULT_CONFIG.queueScore, FACTORS), read("result-this-score.json").scored);
});

test("backtest 2: the spike's weights with its size and health factors reproduce its order exactly; adding a factor is one list entry", () => {
  const facts = read("facts.json");
  const byNumber = new Map(facts.issues.map((i) => [i.issue, i]));
  const size = (i) => {
    const l = byNumber.get(i.number)?.changedLines ?? null;
    return { name: "size", points: l === null ? 5 : l < 150 ? 15 : l < 600 ? 5 : l < 1500 ? 0 : -10 };
  };
  const health = (i) => ({ name: "factory-health", points: byNumber.get(i.number)?.factoryHealth === true ? 20 : 0 });
  const spike = {
    ...DEFAULT_CONFIG.queueScore,
    priorityLabel: 100, bug: 25, unblocksDirect: 10, unblocksTransitive: 3, unblocksCap: 40,
    closesEpic: 25, nearlyClosesEpic: 10, epicStarted: 5, waitingPerHour: 0, failedLife: 0,
  };
  assert.deepEqual(drain(facts, spike, [...FACTORS, size, health]), read("result-all-ready.json").scored);
});

test("backtest 3: every issue carries area:factory and needs-decision, and the ctx has no intake: the order is backtest 1's", () => {
  const facts = read("facts.json");
  // the labels would score +20 and -40 with the switch on; with no intake in the ctx (the switch off) they score nothing
  const labelled = (labels) => [...(labels ?? []), "area:factory", "needs-decision"];
  assert.deepEqual(drain(facts, DEFAULT_CONFIG.queueScore, FACTORS, labelled), read("result-this-score.json").scored);
});
