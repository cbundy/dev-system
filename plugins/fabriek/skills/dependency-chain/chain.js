#!/usr/bin/env node
// Data plumbing for the dependency-chain skill: it crawls an issue's dependency chain through
// fabriek-issue-read, classifies each issue, finds what holds the chain, and writes the doc's
// parts (the diagram's widget code, the issue table, a Mermaid fallback), so the session never
// hand-builds the graph or the drawing. Node built-ins only.
//
//   node chain.js crawl <seed>... [--max N]
//       Prints the graph as JSON. Reads every issue and its timeline with `fabriek-issue-read
//       --json` (the repo comes from CALLUM_FLOW_REPO, as for that tool). From the seeds it follows
//       sub-issues down the whole tree, then blocked_by and blocking links up to two hops outside it.
//   node chain.js list <graph.json>
//       Prints the issues the diagram draws, one per line, for writing their short labels.
//   node chain.js holds <graph.json> [--labels labels.json]
//       Prints, as JSON, the open issues that keep ready issues blocked and nothing blocks themselves.
//   node chain.js table <graph.json> [--labels labels.json]
//       Prints the "every issue" markdown table.
//   node chain.js draw <graph.json> [--labels labels.json] [--title T]
//       Prints the diagram's widget module: one line, ready for the docs connector's widget `code`.
//   node chain.js mermaid <graph.json> [--labels labels.json]
//       Prints a Mermaid flowchart with a click link per issue, for a GitHub comment when no docs
//       connector is available.
//
// labels.json maps an issue number to {what, status?, statusText?}: `what` is the 2-6 word summary
// drawn in its box and shown in the table; `status` (one of STATUSES) and `statusText` override the
// state read from GitHub, for a hold only the issue text names (for example "the owner readies it").
"use strict";

const fs = require("node:fs");
const { execFile } = require("node:child_process");

function die(msg) {
  process.stderr.write(`chain: ${msg}\n`);
  process.exit(2);
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// ---- crawl ----------------------------------------------------------------------------------

function issueRead(args) {
  const run = (bin) =>
    new Promise((resolve, reject) => {
      execFile(bin, ["--json", ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(new Error(`${bin} --json ${args.join(" ")}: ${String(stderr || err.message).trim()}`), { code: err.code }));
        else resolve(JSON.parse(stdout));
      });
    });
  if (process.env.CALLUM_FLOW_ISSUE_READ) return run(process.env.CALLUM_FLOW_ISSUE_READ);
  // An image older than the rename has only the callum-flow-* name.
  return run("fabriek-issue-read").catch((e) => (e.code === "ENOENT" ? run("callum-flow-issue-read") : Promise.reject(e)));
}

// links: the current sub-issues, parent, blocked_by and blocking of one issue, replayed from its
// timeline in time order (an added link that was later removed is gone). Links to another repo
// are left out: the chain is drawn for one repo.
function links(events, repo) {
  const subs = new Set(), blockedBy = new Set(), blocking = new Set();
  let parent = null;
  const same = (o) => !repo || !o.repository || o.repository.full_name === repo;
  const sorted = [...events].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  for (const e of sorted) {
    const ev = e.event;
    if (ev === "sub_issue_added" && e.sub_issue && same(e.sub_issue)) subs.add(e.sub_issue.number);
    if (ev === "sub_issue_removed" && e.sub_issue) subs.delete(e.sub_issue.number);
    if (ev === "parent_issue_added" && e.parent_issue && same(e.parent_issue)) parent = e.parent_issue.number;
    if (ev === "parent_issue_removed") parent = null;
    if (ev === "blocked_by_added" && e.blocked_by && same(e.blocked_by)) blockedBy.add(e.blocked_by.number);
    if (ev === "blocked_by_removed" && e.blocked_by) blockedBy.delete(e.blocked_by.number);
    if (ev === "blocking_added" && e.blocking && same(e.blocking)) blocking.add(e.blocking.number);
    if (ev === "blocking_removed" && e.blocking) blocking.delete(e.blocking.number);
  }
  const num = (s) => [...s].sort((a, b) => a - b);
  return { subIssues: num(subs), parent, blockedBy: num(blockedBy), blocking: num(blocking) };
}

async function crawl(seeds, max) {
  const repo = process.env.CALLUM_FLOW_REPO || "";
  const nodes = new Map();
  const hop = new Map(seeds.map((n) => [n, 0]));
  let queue = [...seeds];
  let truncated = false;
  while (queue.length > 0) {
    const batch = queue.filter((n) => !nodes.has(n)).slice(0, 8);
    queue = queue.filter((n) => !batch.includes(n) && !nodes.has(n));
    if (batch.length === 0) break;
    const read = await Promise.all(batch.map(async (n) => {
      const [one, tl] = await Promise.all([issueRead([String(n)]), issueRead(["--timeline", String(n)])]);
      return { n, issue: one.issue || one, events: tl.events || [] };
    }));
    for (const { n, issue, events } of read) {
      if (nodes.size >= max) { truncated = true; break; }
      const l = links(events, repo);
      const node = {
        number: n,
        title: issue.title || "",
        state: issue.state === "closed" ? "closed" : "open",
        stateReason: issue.state_reason || null,
        labels: (issue.labels || []).map((x) => (typeof x === "string" ? x : x.name)).sort(),
        url: issue.html_url || "",
        ...l,
        hop: hop.get(n),
      };
      nodes.set(n, node);
      const h = hop.get(n);
      const add = (m, nh) => {
        if (nodes.has(m) || nh > 2) return;
        if (!hop.has(m) || hop.get(m) > nh) hop.set(m, nh);
        queue.push(m);
      };
      // the tree under the seeds is all hop 0; an open issue outside it brings its own sub-issues
      if (h === 0 || node.state === "open") for (const s of l.subIssues) add(s, h);
      // a closed issue's own prerequisites are history; its dependents still matter
      if (node.state === "open") for (const b of l.blockedBy) add(b, h + 1);
      for (const b of l.blocking) add(b, h + 1);
    }
    if (truncated) break;
  }
  return { repo, seeds, generatedAt: new Date().toISOString(), truncated: truncated || queue.some((n) => !nodes.has(n)), nodes: [...nodes.values()].sort((a, b) => a.number - b.number) };
}

// ---- analysis -------------------------------------------------------------------------------

const STATUSES = ["done", "dropped", "you", "loop", "readyblocked", "ready", "notready"];
const STATUS_TEXT = {
  done: "Done", dropped: "Closed, not planned", you: "Waits on you", loop: "In the factory",
  readyblocked: "Ready, blocked", ready: "Ready to start", notready: "Not ready",
};

function analyse(graph, labels = {}) {
  const by = new Map(graph.nodes.map((n) => [n.number, n]));
  const seeds = new Set(graph.seeds);
  const open = (m) => by.has(m) && by.get(m).state === "open";
  // a seed with sub-issues is the frame of the picture, not a box in it
  const frame = (n) => seeds.has(n.number) && n.subIssues.length > 0;
  const childrenOf = (n) => (frame(n) ? [] : n.subIssues.filter((s) => by.has(s)));
  const openBlockers = (n) => [...n.blockedBy.filter(open), ...childrenOf(n).filter(open)];
  const status = new Map(), statusText = new Map();
  for (const n of graph.nodes) {
    const factory = n.labels.find((l) => l.startsWith("factory:"));
    let s;
    if (n.state === "closed") s = n.stateReason === "not_planned" ? "dropped" : "done";
    else if (factory === "factory:parked") s = "you";
    else if (factory) s = "loop";
    else if (n.labels.includes("ready")) s = openBlockers(n).length > 0 ? "readyblocked" : "ready";
    else s = "notready";
    const o = labels[n.number] || {};
    if (o.status && STATUSES.includes(o.status)) s = o.status;
    status.set(n.number, s);
    let t = o.statusText || STATUS_TEXT[s];
    if (!o.statusText && s === "loop") t = `Factory: ${factory.slice("factory:".length).replace(/-/g, " ")}`;
    statusText.set(n.number, t);
  }
  // a finished part: a closed sub-issue of a drawn parent that blocks nothing outside that
  // parent; it is counted on the parent's box ("5 of 6 parts done"), not drawn
  const parentOf = new Map();
  for (const p of graph.nodes) for (const c of childrenOf(p)) parentOf.set(c, p.number);
  const finishedPart = (n) => n.state === "closed" && parentOf.has(n.number) && n.blocking.every((b) => !by.has(b) || parentOf.get(b) === parentOf.get(n.number));
  // drawn: every open issue but a frame, and each closed issue an open drawn issue waits on
  const drawn = new Set(graph.nodes.filter((n) => n.state === "open" && !frame(n)).map((n) => n.number));
  for (const n of graph.nodes) {
    if (!drawn.has(n.number)) continue;
    for (const b of n.blockedBy) if (by.has(b) && !finishedPart(by.get(b))) drawn.add(b);
  }
  const parts = new Map();
  for (const n of graph.nodes) {
    const kids = childrenOf(n);
    if (drawn.has(n.number) && kids.length > 0) parts.set(n.number, { done: kids.filter((c) => !open(c)).length, total: kids.length });
  }
  const history = graph.nodes.filter((n) => !drawn.has(n.number) && !frame(n) && !(finishedPart(n) && drawn.has(parentOf.get(n.number)))).map((n) => n.number);
  const edges = [];
  for (const n of graph.nodes) {
    if (!drawn.has(n.number)) continue;
    for (const b of n.blockedBy) if (drawn.has(b)) edges.push({ from: b, to: n.number, kind: "blocks" });
    // a part points at its parent only while the parent is open: a finished parent waits on nothing
    if (n.state === "open") for (const c of childrenOf(n)) if (drawn.has(c)) edges.push({ from: c, to: n.number, kind: "part" });
  }
  // an issue with no link to the rest is listed under the drawing, not boxed in it
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const offChain = [...drawn].filter((n) => !linked.has(n)).sort((p, q) => p - q);
  for (const n of offChain) drawn.delete(n);
  // holds: open issues in the blocker closure of a ready-but-blocked issue that nothing open blocks
  const holds = new Map();
  for (const n of graph.nodes) {
    if (status.get(n.number) !== "readyblocked") continue;
    const seen = new Set();
    const walk = (m) => {
      for (const b of openBlockers(by.get(m))) {
        if (seen.has(b)) continue;
        seen.add(b);
        if (openBlockers(by.get(b)).length === 0) {
          if (!holds.has(b)) holds.set(b, new Set());
          holds.get(b).add(n.number);
        } else walk(b);
      }
    };
    walk(n.number);
  }
  return { by, status, statusText, drawn, history, offChain, parts, edges, holds, openBlockers, frame };
}

// layout: layers by longest path over the drawn edges, at most five boxes to a row (a wide layer
// wraps), each row ordered by where its issues' blockers sit, on five fixed slots so the corridors
// between slots stay clear for long edges.
const SLOTS = 5, LEFT = 24, BOX_W = 129, STEP = 145, BOX_H = 88, ROW_STEP = 144;
const slotX = (c) => LEFT + c * STEP;
const CORRIDORS = [12, 161, 306, 451, 596, 748];

function layout(a) {
  const ids = [...a.drawn].sort((x, y) => x - y);
  const preds = new Map(ids.map((n) => [n, []]));
  for (const e of a.edges) preds.get(e.to).push(e.from);
  const layer = new Map(), visiting = new Set();
  const depth = (n) => {
    if (layer.has(n)) return layer.get(n);
    if (visiting.has(n)) return 0;
    visiting.add(n);
    const d = preds.get(n).length === 0 ? 0 : 1 + Math.max(...preds.get(n).map(depth));
    visiting.delete(n);
    layer.set(n, d);
    return d;
  };
  ids.forEach(depth);
  const layers = [];
  for (const n of ids) (layers[layer.get(n)] ||= []).push(n);
  const pos = new Map();
  let row = 0;
  for (const members of layers) {
    if (!members) continue;
    const bary = (n) => {
      const ps = preds.get(n).filter((p) => pos.has(p));
      return ps.length === 0 ? null : ps.reduce((s, p) => s + pos.get(p).slot, 0) / ps.length;
    };
    const sorted = [...members].sort((x, y) => (bary(x) ?? 2) - (bary(y) ?? 2) || x - y);
    for (let i = 0; i < sorted.length; i += SLOTS) {
      const chunk = sorted.slice(i, i + SLOTS);
      const start = Math.floor((SLOTS - chunk.length) / 2);
      const want = chunk.map((n, k) => Math.round(bary(n) ?? start + k));
      const slots = [];
      want.forEach((w, k) => slots.push(Math.max(Math.min(w, SLOTS - 1), k === 0 ? 0 : slots[k - 1] + 1)));
      for (let k = slots.length - 1; k >= 0; k--) slots[k] = Math.min(slots[k], SLOTS - chunk.length + k);
      chunk.forEach((n, k) => pos.set(n, { row, slot: slots[k], layer: layer.get(n) }));
      row++;
    }
  }
  return { pos, rows: row, layer };
}

// ---- words ----------------------------------------------------------------------------------

// JSX text cannot hold braces or angle brackets, and the drawing holds plain words only.
const clean = (s) => String(s).replace(/[{}]/g, "").replace(/</g, "(").replace(/>/g, ")").replace(/&/g, "and").replace(/\s+/g, " ").trim();

function wrap(text, width, lines) {
  const out = [];
  let cur = "";
  for (const w of clean(text).split(" ")) {
    const word = w.length > width ? `${w.slice(0, width - 1)}.` : w;
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = `${out[lines - 1].slice(0, width - 3).replace(/\s+$/, "")}...`;
  }
  return out;
}

const whatOf = (a, labels, n) => (labels[n] && labels[n].what) || a.by.get(n).title;
const urlOf = (graph, n) => graph.nodes.find((x) => x.number === n).url || `https://github.com/${graph.repo}/issues/${n}`;

// ---- draw -----------------------------------------------------------------------------------

const KEY = [
  ["done", "Done"], ["loop", "In the factory"], ["you", "Waits on you"], ["readyblocked", "Ready, blocked"],
  ["ready", "Ready to start"], ["notready", "Not ready"], ["dropped", "Closed, not planned"],
];

function draw(graph, labels, title, warn = () => {}) {
  const a = analyse(graph, labels);
  const { pos, rows } = layout(a);
  const parts = [];
  const t = (id, x, y, words, extra = "") => `<text data-claude-text-id='${id}' x='${x}' y='${y}'${extra}>${clean(words)}</text>`;
  const links = [];
  const link = (n, x, y, w, h) => links.push(`<a href='${urlOf(graph, n)}' target='_blank' rel='noreferrer'><rect x='${x}' y='${y}' width='${w}' height='${h}' rx='8' fill={ink} fillOpacity='0' cursor='pointer'><title>Open #${n} on GitHub</title></rect></a>`);
  parts.push(t("title", LEFT, 28, title, " fontSize='15' fontWeight='600' fill={ink}"));
  // the key names only the states drawn
  const present = new Set([...a.drawn].map((n) => a.status.get(n)));
  if (a.history.length > 0) present.add("done");
  let kx = LEFT;
  const keyParts = [];
  for (const [s, words] of KEY) {
    if (!present.has(s)) continue;
    keyParts.push(`{sw(${kx}, '${s}')}`, t(`key-${s}`, kx + 18, 51, words, " fontSize='11.5' fill={quiet}"));
    kx += 18 + Math.ceil(words.length * 6.2) + 24;
  }
  keyParts.push(t("key-click", 736, 51, "Click a box to open its issue", " textAnchor='end' fontSize='11.5' fill={quiet}"));
  parts.push(`<g data-claude-anchor='key'>${keyParts.join("")}</g>`);
  // finished issues that no open issue waits on: one line of numbers, each a link
  let y0 = 72;
  if (a.history.length > 0) {
    const hp = [t("history-label", LEFT, y0 + 14, "Earlier, all done:", " fontSize='11.5' fill={quiet}")];
    let x = LEFT + 112, y = y0;
    for (const n of a.history) {
      const w = Math.ceil(`#${n}`.length * 6.4) + 8;
      if (x + w > 736) { x = LEFT + 112; y += 20; }
      hp.push(t(`h${n}`, x, y + 14, `#${n}`, " fontSize='11.5' fill={ink}"));
      link(n, x - 4, y, w, 20);
      x += w + 6;
    }
    parts.push(`<g data-claude-anchor='history'>${hp.join("")}</g>`);
    y0 = y + 20 + 24;
  }
  const rowY = (r) => y0 + r * ROW_STEP;
  // edges first, under the boxes
  const outs = new Map(), ins = new Map();
  for (const e of a.edges) {
    (outs.get(e.from) || outs.set(e.from, []).get(e.from)).push(e);
    (ins.get(e.to) || ins.set(e.to, []).get(e.to)).push(e);
  }
  const cx = (n) => slotX(pos.get(n).slot) + BOX_W / 2;
  const port = (list, n, other) => {
    const sorted = [...list].sort((p, q) => cx(other(p)) - cx(other(q)));
    const k = sorted.length, spread = Math.min(12, 100 / Math.max(k, 1));
    return new Map(sorted.map((e, i) => [e, cx(n) + (i - (k - 1) / 2) * spread]));
  };
  const outPort = new Map(), inPort = new Map();
  for (const [n, list] of outs) for (const [e, x] of port(list, n, (e) => e.to)) outPort.set(e, x);
  for (const [n, list] of ins) for (const [e, x] of port(list, n, (e) => e.from)) inPort.set(e, x);
  const lanes = new Map();
  const lane = (r) => { const k = lanes.get(r) || 0; lanes.set(r, k + 1); return rowY(r) + BOX_H + 12 + (k % 6) * 7; };
  const corridorUse = new Map();
  const solid = [], dashed = [];
  const order = [...a.edges].sort((p, q) => pos.get(p.from).row - pos.get(q.from).row || cx(p.to) - cx(q.to));
  for (const e of order) {
    const s = pos.get(e.from), d = pos.get(e.to);
    const sx = outPort.get(e).toFixed(1), tx = inPort.get(e).toFixed(1);
    const ly = lane(s.row);
    let path;
    if (d.row === s.row + 1) path = `M${sx} ${rowY(s.row) + BOX_H}V${ly}H${tx}V${rowY(d.row)}`;
    else {
      const best = [...CORRIDORS].sort((p, q) => Math.abs(p - Number(tx)) - Math.abs(q - Number(tx)) || Math.abs(p - Number(sx)) - Math.abs(q - Number(sx)))[0];
      const k = corridorUse.get(best) || 0;
      corridorUse.set(best, k + 1);
      const c = best + ((k % 3) - 1) * 3;
      path = `M${sx} ${rowY(s.row) + BOX_H}V${ly}H${c}V${lane(d.row - 1)}H${tx}V${rowY(d.row)}`;
    }
    (e.kind === "part" ? dashed : solid).push(`<path d='${path}' markerEnd='url(#chain-arrow)'/>`);
  }
  if (solid.length > 0) parts.push(`<g data-claude-anchor='blocks' fill='none' stroke={edge} strokeWidth='1.25'>${solid.join("")}</g>`);
  if (dashed.length > 0) parts.push(`<g data-claude-anchor='part-of' fill='none' stroke={edge} strokeWidth='1.25' strokeDasharray='4 3'>${dashed.join("")}</g>`);
  // boxes: number, two lines of summary, the state
  for (const n of [...a.drawn].sort((p, q) => p - q)) {
    const { row, slot } = pos.get(n);
    const x = slotX(slot), y = rowY(row), mid = x + BOX_W / 2;
    const s = a.status.get(n);
    const p = a.parts.get(n);
    const lines = p ? [wrap(whatOf(a, labels, n), 17, 1)[0], `${p.done} of ${p.total} parts done`] : wrap(whatOf(a, labels, n), 17, 2);
    if (lines.some((l) => l.endsWith("..."))) warn(`#${n}: "${whatOf(a, labels, n)}" is cut in its box; ${p ? "a box with parts holds one line of 17 characters" : "a box holds two lines of 17 characters"}`);
    const g = [`{box(${x}, ${y}, ${BOX_W}, ${BOX_H}, '${s}')}`, t(`n${n}`, mid, y + 24, `#${n}`, " textAnchor='middle' fontWeight='600' fill={ink}")];
    lines.forEach((l, i) => g.push(t(`w${n}-${i + 1}`, mid, y + 42 + i * 16, l, " textAnchor='middle' fontSize='11.5' fill={ink}")));
    g.push(t(`s${n}`, mid, y + 76, wrap(a.statusText.get(n), 18, 1)[0], " textAnchor='middle' fontSize='11.5' fill={quiet}"));
    parts.push(`<g data-claude-anchor='i${n}'>${g.join("")}</g>`);
    link(n, x, y, BOX_W, BOX_H);
  }
  let height = (rows > 0 ? rowY(rows - 1) + BOX_H : y0 - 24) + 24;
  if (a.offChain.length > 0) {
    // issues in the chain with no link to the rest: one line, each a link, with its state
    let y = height + 8, x = LEFT + 96;
    const op = [t("off-label", LEFT, y + 14, "Off the chain:", " fontSize='11.5' fill={quiet}")];
    for (const n of a.offChain) {
      const words = `#${n} ${wrap(whatOf(a, labels, n), 30, 1)[0]}, ${a.statusText.get(n).toLowerCase()}`;
      const w = Math.ceil(words.length * 6.2) + 8;
      if (x + w > 736) { x = LEFT + 96; y += 20; }
      op.push(t(`o${n}`, x, y + 14, words, " fontSize='11.5' fill={ink}"));
      link(n, x - 4, y, w, 20);
      x += w + 12;
    }
    parts.push(`<g data-claude-anchor='off-chain'>${op.join("")}</g>`);
    height = y + 20 + 24;
  }
  const colours = "const done = 'var(--cds-chart-status-good)', loop = 'var(--cds-chart-categorical-1)', you = 'var(--cds-chart-status-critical)', warn = 'var(--cds-chart-status-warning)', go = 'var(--cds-chart-categorical-3)', edge = 'var(--cds-chart-axis)', ink = 'var(--cds-text-primary)', quiet = 'var(--cds-text-secondary)';";
  const col = "const col = k => k === 'done' ? done : k === 'loop' ? loop : k === 'you' ? you : k === 'readyblocked' ? warn : k === 'ready' ? go : edge;";
  const plain = "const plain = k => k === 'notready' || k === 'dropped';";
  const box = "const box = (x, y, w, h, k) => <rect x={x} y={y} width={w} height={h} rx='8' fill={plain(k) ? 'none' : col(k)} fillOpacity={plain(k) ? 1 : 0.12} stroke={col(k)} strokeWidth={k === 'you' ? 2 : 1.25} strokeDasharray={k === 'dropped' ? '4 3' : 'none'}/>;";
  const sw = "const sw = (x, k) => <rect x={x} y='41' width='12' height='12' rx='3' fill={plain(k) ? 'none' : col(k)} fillOpacity={plain(k) ? 1 : 0.12} stroke={col(k)} strokeWidth={k === 'you' ? 2 : 1.25}/>;";
  const marker = "<defs><marker id='chain-arrow' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='6' markerHeight='6' orient='auto-start-reverse'><path d='M0 0L10 5L0 10z' fill={edge}/></marker></defs>";
  // the links go last, on top of everything, and carry no text id or anchor: a click on a
  // commentable label or group is taken by the doc for editing and commenting, never the link
  return `export default () => { ${colours} ${col} ${plain} ${box} ${sw} return <svg viewBox='0 0 760 ${height}' role='img' aria-label='${clean(title).replace(/'/g, "")}' fontSize='13'>${marker}${parts.join("")}${links.join("")}</svg>; };`;
}

// ---- table, holds, list, mermaid ------------------------------------------------------------

const cell = (s) => String(s).replace(/\|/g, "/").replace(/\n/g, " ");

function table(graph, labels) {
  const a = analyse(graph, labels);
  const { layer } = layout(a);
  const link = (n) => `[#${n}](${urlOf(graph, n)})`;
  // the drawn chain from top to bottom, then what sits off it, then finished history
  const rank = (n) => (a.drawn.has(n.number) ? layer.get(n.number) : a.offChain.includes(n.number) ? 1000 : n.state === "open" ? 1001 : a.history.includes(n.number) ? 1003 : 1002);
  const rows = graph.nodes.filter((n) => !a.frame(n)).sort((p, q) => rank(p) - rank(q) || p.number - q.number);
  const out = ["| Issue | What | State | Labels | Waits on |", "| --- | --- | --- | --- | --- |"];
  for (const n of rows) {
    const waits = n.state === "open" ? a.openBlockers(n) : [];
    out.push(`| ${link(n.number)} | ${cell(whatOf(a, labels, n.number))} | ${cell(a.statusText.get(n.number))} | ${cell(n.labels.join(", ") || "none")} | ${waits.length ? waits.map(link).join(", ") : n.state === "open" ? "nothing open" : "-"} |`);
  }
  return out.join("\n");
}

function holds(graph, labels) {
  const a = analyse(graph, labels);
  return [...a.holds.entries()]
    .map(([n, held]) => ({ number: n, url: urlOf(graph, n), title: a.by.get(n).title, what: whatOf(a, labels, n), status: a.status.get(n), statusText: a.statusText.get(n), labels: a.by.get(n).labels, holds: [...held].sort((p, q) => p - q) }))
    .sort((p, q) => q.holds.length - p.holds.length || p.number - q.number);
}

function list(graph, labels) {
  const a = analyse(graph, labels);
  const lines = [...a.drawn].sort((p, q) => p - q).map((n) => `#${n}\t${a.status.get(n)}\t${a.by.get(n).title}`);
  if (a.history.length) lines.push(`history (one line of numbers, no summary needed): ${a.history.map((n) => `#${n}`).join(" ")}`);
  return lines.join("\n");
}

function mermaid(graph, labels) {
  const a = analyse(graph, labels);
  const words = (n) => clean(`#${n} ${whatOf(a, labels, n)}`).replace(/"/g, "'");
  const out = ["flowchart TB"];
  for (const n of [...a.drawn].sort((p, q) => p - q)) out.push(`  n${n}["${words(n)}<br/>${clean(a.statusText.get(n))}"]:::${a.status.get(n)}`);
  for (const e of a.edges) out.push(`  n${e.from} ${e.kind === "part" ? "-.->" : "-->"} n${e.to}`);
  for (const n of [...a.drawn].sort((p, q) => p - q)) out.push(`  click n${n} "${urlOf(graph, n)}" _blank`);
  out.push(
    "  classDef done fill:#e6f4ea,stroke:#5f8f6b", "  classDef loop fill:#e3eefc,stroke:#3b6fb6",
    "  classDef you fill:#fde8e8,stroke:#c0392b,stroke-width:2px", "  classDef readyblocked fill:#fff4d6,stroke:#c99a1e",
    "  classDef ready fill:#e8f0ff,stroke:#5b6abf", "  classDef notready fill:#f1f1f1,stroke:#8a8a8a",
    "  classDef dropped fill:#ffffff,stroke:#8a8a8a,stroke-dasharray:4 3",
  );
  return out.join("\n");
}

// ---- main -----------------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (cmd === "crawl") {
    const seeds = f._.map((s) => Number(String(s).replace(/^#/, "")));
    if (seeds.length === 0 || seeds.some((n) => !Number.isInteger(n) || n <= 0)) die("crawl takes one or more issue numbers");
    const graph = await crawl(seeds, Number(f.max || 80));
    process.stdout.write(`${JSON.stringify(graph, null, 1)}\n`);
    return;
  }
  const commands = { list, holds, table, draw, mermaid };
  if (!commands[cmd]) die("usage: chain.js crawl <seed>... [--max N] | list|holds|table|draw|mermaid <graph.json> [--labels labels.json] [--title T]");
  if (!f._[0]) die(`${cmd} needs the graph file`);
  const graph = readJson(f._[0]);
  const labels = f.labels ? readJson(f.labels) : {};
  let out;
  if (cmd === "draw") out = draw(graph, labels, f.title || `Dependency chain of #${graph.seeds.join(", #")}`, (m) => process.stderr.write(`chain: warning: ${m}\n`));
  else if (cmd === "holds") out = JSON.stringify(holds(graph, labels), null, 1);
  else out = commands[cmd](graph, labels);
  process.stdout.write(`${out}\n`);
}

if (require.main === module) main().catch((e) => die(e.message));

module.exports = { links, analyse, layout, draw, table, holds, list, mermaid, wrap, clean };
