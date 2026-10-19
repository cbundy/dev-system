#!/usr/bin/env node
// v2 world simulation over the recorded night of 2026-10-14/15 (a scratch harness). It drives the real planV2 pass by pass from the branch build (a scratch copy of
// feat/factory-loop-v2 at 901a0a8), executes its actions against a simulated world at the outcome
// level (the ledger, records, leases, PRs, CI, main), and checks invariants every pass.
//
// usage: node v2-sim.mjs --src <scratch copy root> --replay <v1 replay.json> --out <dir>
//          [--k 3] [--variant pure|rescues|faults] [--seed 1] [--from ISO] [--to ISO]
//          [--takeover <v2 replay.json of the stock harness>]   start from v1's live claims (ghosts)
import { register } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
)

const argv = process.argv.slice(2)
const A = {}
for (let i = 0; i < argv.length; i += 2) A[argv[i].replace(/^--/, '')] = argv[i + 1]
const SRC = A.src
const HOOKS = path.join(SRC, 'plugins', 'factory-loop', 'hooks')
const K = Number(A.k ?? 3)
const VARIANT = A.variant ?? 'pure'
const SEED = Number(A.seed ?? 1)
const OUT = A.out
fs.mkdirSync(OUT, { recursive: true })

const { planV2 } = await import(path.join(HOOKS, 'v2', 'plan.ts'))
const { emptyV2State } = await import(path.join(HOOKS, 'v2', 'observe.ts'))
const { queueOf } = await import(path.join(HOOKS, 'v2', 'rules-queue.ts'))
const { recordStale, applied } = await import(path.join(HOOKS, 'v2', 'act-state.ts'))
const { SLOT_STATES, unknownResult } = await import(path.join(HOOKS, 'v2', 'types.ts'))
const ledgerMod = await import(path.join(HOOKS, 'ledger.ts'))
const { EMPTY_CONTROL, loadConfig } = await import(path.join(HOOKS, 'config.ts'))

const MIN = 60_000
const SEC = 1000
const REPO = 'cbundy/dev-system'
const DEVICE = 'coder-dev-system-loop'
const T = s => Date.parse(s)
const iso = ms => new Date(ms).toISOString()
const hhmm = ms => iso(ms).slice(11, 19)

// --- a seeded random source (faults variant) ---------------------------------------------------------
let rs = SEED >>> 0 || 1
const rand = () => {
  rs ^= rs << 13
  rs >>>= 0
  rs ^= rs >>> 17
  rs ^= rs << 5
  rs >>>= 0
  return rs / 4294967296
}
const sha = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex')

// --- the recorded world -----------------------------------------------------------------------------------
const replay = JSON.parse(fs.readFileSync(A.replay, 'utf8'))
const usageAt = []
for (const s of replay.samples) usageAt.push({ t: s.t, usage: s.usage })
usageAt.sort((a, b) => a.t - b.t)
function usageOf(t) {
  let u = null
  for (const x of usageAt) {
    if (x.t > t) break
    u = x.usage
  }
  return u ?? { fiveHour: 0, sevenDay: 0, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: true }
}
// when each issue first showed in the factory's queue (labelled ready by a person or a split)
const readyAt = new Map()
const readyUntil = new Map()
for (const s of replay.samples) for (const n of s.queue) {
  if (!readyAt.has(n)) readyAt.set(n, s.t)
  readyUntil.set(n, s.t)
}
// the 17 issues the v1 loop claimed (G1); any other issue that left the queue was taken by someone
// else (the old orchestrator before 16:32) or unlabelled, so it leaves the sim's queue then too
const V1_CLAIMED = new Set([356, 467, 533, 571, 583, 595, 596, 600, 588, 602, 613, 601, 589, 620, 624, 591, 590])

// the owner's directives over the night (operator transcript, efffea22-...jsonl)
const SKIP = [448, 452, 463, 464]
const directives = [
  { at: T('2026-10-14T16:00:00Z'), set: c => ({ ...c, noNewWork: true, skip: SKIP }) },
  { at: T('2026-10-14T18:01:56Z'), set: c => ({ ...c, noNewWork: false }) },
  { at: T('2026-10-14T20:03:47Z'), set: c => ({ ...c, only: [595, 596, 588, 589, 591, 590, 592] }) },
  { at: T('2026-10-14T20:08:42Z'), set: c => ({ ...c, only: [595, 596, 600, 588, 589, 591, 590, 592] }) },
  { at: T('2026-10-14T20:13:44Z'), set: c => ({ ...c, only: [595, 596, 600, 588, 601, 589, 591, 590, 592] }) },
  { at: T('2026-10-14T21:26:07Z'), set: c => ({ ...c, only: [...c.only, 613] }) },
  { at: T('2026-10-14T21:27:34Z'), set: c => ({ ...c, noNewWork: true }) },
  { at: T('2026-10-14T21:32:01Z'), set: c => ({ ...c, only: c.only.filter(n => n !== 595) }) },
  { at: T('2026-10-14T22:04:11Z'), set: c => ({ ...c, noNewWork: false, only: [...c.only, 533] }) },
  { at: T('2026-10-14T22:07:52Z'), set: c => ({ ...c, only: [...c.only, 620] }) },
  { at: T('2026-10-14T22:27:19Z'), set: c => ({ ...c, only: [...c.only, 624] }) },
]
// person rescues aimed at single issues (the rescues variant only)
const rescues = [
  { at: T('2026-10-14T20:10:25Z'), drop: [533, 583] },
  { at: T('2026-10-14T21:32:01Z'), drop: [595] },
  { at: T('2026-10-14T22:04:11Z'), undrop: [533], ready: [533] },
  { at: T('2026-10-14T23:14:18Z'), close: [624] },
]
// merges to main the loop did not make (git log --first-parent origin/main), and restarts
const outsideMerges = ['2026-10-14T19:36:59Z', '2026-10-14T19:56:03Z', '2026-10-14T20:36:05Z', '2026-10-14T20:47:45Z', '2026-10-14T21:08:17Z', '2026-10-14T22:42:16Z', '2026-10-14T23:14:18Z', '2026-10-14T23:35:50Z'].map(T)
const restarts = ['2026-10-14T19:43:28Z', '2026-10-14T22:03:03Z'].map(T)
// the Claude session limit: a 429 at 23:06:35 (daemon.log:353), reset 02:20
const limitFrom = T('2026-10-14T23:06:35Z')
const limitTo = T('2026-10-15T02:20:00Z')

// --- how each issue's agents behaved, mapped from G1 (pure and rescues variants) -------------------------------
// minutes of each step; design/build from G1's productive minutes; flags for what G1 records
const PROFILE = {
  356: { design: 6, build: 15 },
  467: { design: 8, build: 25 },
  533: { design: 10, build: 30 },
  571: { design: 6, build: 20, ciFlaky: 1, reviewChanges: 1 },
  583: { design: 8, build: 25, conflict: 1 },
  595: { design: 8, build: 25 },
  596: { design: 8, build: 25, conflict: 1 },
  600: { design: 7, split: [602, 603] },
  588: { design: 5, build: 15 },
  602: { design: 5, build: 12 },
  603: { design: 5, build: 15 },
  613: { design: 6, buildCannot: 'stopped with no commit: the work needs the Remote Control restore PR (#599) first' },
  601: { design: 5, build: 18 },
  589: { design: 8, build: 30, reviewChanges: 1 },
  620: { design: 8, build: 25, reviewChanges: 1 },
  624: { designDead: 2 },
  591: { design: 5, build: 12 },
  590: { designQuestion: 'Self-update needs a Coder user token in the loop workspace: which token and where should it live?' },
  592: { design: 8, build: 25 },
}
const DEFAULT_PROFILE = { design: 8, build: 25 }
const STEP_MIN = { review: 6, fix: 12, triage: 3 }
const CI_MIN = 3

// --- the simulated world -------------------------------------------------------------------------------------
const W = {
  now: 0,
  ledger: [],
  records: [],
  labels: new Map(), // issue -> Set
  open: new Map(), // issue -> bool
  blockers: new Map(), // issue -> [issues]
  subIssues: new Map(),
  only: new Set(), // admitted children
  claimedBy: new Map(), // issue -> { stage, since } for v1 ghosts in the takeover run
  leases: [],
  leaseSeq: 0,
  prs: [], // { pr, issue, branch, state, head, patch, base, mergeable, checks, closedAt, mergedHead }
  prSeq: 1000,
  prCreated: new Map(),
  heads: {},
  main: sha('main', 0),
  mainSeq: 0,
  control: { ...EMPTY_CONTROL },
  loadedAt: 0,
  agents: new Map(), // key -> { endAt, result, agentId, hang }
  agentSeq: 0,
  commentSeq: 0,
  ciRuns: new Map(), // head -> { runId, startAt, fail }
  ciSeq: 18000000000,
  events: [],
  log: [],
  violations: [],
  conflictsLeft: new Map(),
  flakyLeft: new Map(),
  reviewChangesLeft: new Map(),
  designDeadLeft: new Map(),
  lastTitle: null,
  fixRound: new Map(),
}

function labelsOf(n) {
  if (!W.labels.has(n)) W.labels.set(n, new Set(['enhancement']))
  return W.labels.get(n)
}
function profileOf(n) {
  return PROFILE[n] ?? DEFAULT_PROFILE
}
function violation(kind, text, issue = null) {
  W.violations.push({ at: iso(W.now), kind, issue, text })
}
function note(text) {
  W.log.push(`${hhmm(W.now)} ${text}`)
}

// --- the observed State ----------------------------------------------------------------------------------------
const OKSRC = () => ({ ok: true, at: W.now })
function stateNow() {
  const numbers = new Set([...readyAt.keys()].filter(n => readyAt.get(n) <= W.now || W.labels.has(n)))
  for (const r of W.records) numbers.add(r.issue)
  for (const n of W.claimedBy.keys()) numbers.add(n)
  for (const e of W.ledger) if (e.issue !== null) numbers.add(e.issue)
  const openRecord = n => W.records.some(r => r.issue === n && r.state !== 'closed')
  const issues = [...numbers]
    .sort((a, b) => a - b)
    .map(n => {
      const labels = [...labelsOf(n)].sort()
      const ghost = W.claimedBy.get(n)
      const live = openRecord(n)
      const rec = W.records.filter(r => r.issue === n).sort((a, b) => b.since - a.since)[0]
      const blockers = (W.blockers.get(n) ?? []).filter(b => W.open.get(b) !== false).length
      return {
        number: n,
        stage: ghost ? ghost.stage : live ? 'implementing' : labels.includes('ready') ? 'queued' : null,
        stageSince: ghost ? ghost.since : live ? (rec?.since ?? null) : (readyAt.get(n) ?? null),
        holder: ghost || live ? DEVICE : null,
        run: null,
        pr: ghost ? (ghost.pr ?? null) : (rec?.pr ?? null),
        stuck: null,
        open: W.open.get(n) !== false,
        trusted: true,
        labels,
        blockedBy: blockers,
        subIssues: W.subIssues.get(n) ?? 0,
        blockingList: null,
        blockersClosedAt: null,
        parent: null,
        siblings: null,
        epic: false,
        subIssueList: null,
        brief: null,
        delegatedBrief: null,
        claimLapsedAt: null,
        reclaimedAt: null,
        readyAt: null,
      }
    })
  const queue = issues.filter(i => i.open && i.labels.includes('ready') && !openRecord(i.number) && !W.claimedBy.has(i.number)).map(i => i.number)
  const reads = {}
  for (const i of issues) reads[i.number] = { at: W.now, open: i.open, labels: i.labels }
  const prsForState = W.prs
    .filter(p => W.records.some(r => r.issue === p.issue && r.state !== 'closed'))
    .map(p => ({ pr: p.pr, issue: p.issue, state: p.state, head: p.head, mergedHead: p.mergedHead ?? null, closedAt: p.closedAt ?? null, mergeable: mergeableOf(p), author: 'cbundy', checks: checksOf(p), patch: p.patch, readAt: W.now }))
  const behind = prsForState.some(p => p.mergeable === 'behind')
  const v2 = {
    ...emptyV2State(W.now, W.records.map(r => ({ ...r }))),
    sources: { store: OKSRC(), leases: OKSRC(), prs: OKSRC(), interventions: OKSRC(), comments: OKSRC() },
    recordsFrom: 'store',
    heads: { ...W.heads },
    leases: W.leases.map(l => ({ ...l })),
    reads,
    comments: {},
    prs: { prs: prsForState, ...(behind ? { main: { branch: 'main', sha: W.main } } : {}) },
    interventions: { companion: [], controlDigest: null, configDigest: null },
    checkoutBase: null,
  }
  const held = W.records.filter(r => SLOT_STATES.includes(r.state)).length
  return {
    now: W.now,
    repo: REPO,
    device: DEVICE,
    loadedAt: W.loadedAt,
    sources: Object.fromEntries(['factory', 'facts', 'runs', 'queue', 'github', 'usage', 'pool', 'milestone'].map(k => [k, OKSRC()])),
    usage: usageOf(W.now),
    issues,
    queue,
    runs: [],
    pool: { free: Math.max(0, 16 - W.leases.length), total: 16, slots: [] },
    agents: [],
    milestone: null,
    ledger: W.ledger.map(e => ({ ...e })),
    control: { ...W.control, only: [...W.control.only, ...(W.control.only.length > 0 ? [...W.only] : [])] },
    lastTitle: W.lastTitle,
    githubBackoffUntil: null,
    checkout: { branch: 'main', head: sha('checkout'), defaultBranch: 'main', dirty: [] },
    v2,
  }
}

function mergeableOf(p) {
  if (p.state !== 'open') return null
  if (p.dirty) return 'dirty'
  return p.base === W.main ? 'clean' : 'behind'
}
function checksOf(p) {
  if (p.head === null) return []
  const run = W.ciRuns.get(p.head)
  if (run === undefined) return []
  const done = W.now >= run.startAt + CI_MIN * MIN
  const bucket = !done ? 'pending' : run.fail ? 'fail' : 'pass'
  return [{ name: 'ci', state: bucket === 'pending' ? 'IN_PROGRESS' : bucket === 'pass' ? 'SUCCESS' : 'FAILURE', bucket, startedAt: run.startAt, completedAt: done ? run.startAt + CI_MIN * MIN : null, runId: String(run.runId), link: `https://github.com/${REPO}/actions/runs/${run.runId}/job/1` }]
}
function startCi(head, issue) {
  if (W.ciRuns.has(head)) return
  let fail = false
  const left = W.flakyLeft.get(issue) ?? 0
  if (left > 0) {
    fail = true
    W.flakyLeft.set(issue, left - 1)
  }
  if (VARIANT === 'faults' && rand() < 0.15) fail = true
  W.ciRuns.set(head, { runId: ++W.ciSeq, startAt: W.now, fail })
  if (!W.heads[head]) W.heads[head] = { pr: W.prs.find(p => p.head === head)?.pr ?? 0, at: W.now }
}
function advanceMain(why) {
  W.mainSeq++
  W.main = sha('main', W.mainSeq)
  note(`main moved (${why}) to ${W.main.slice(0, 7)}`)
}

// --- agent behaviour ----------------------------------------------------------------------------------------------
const BRIEF = n => ['## Design brief (designer, 2026-10-14)', '', `Do issue ${n}.`, '', '## Acceptance criteria', '- it works', '', '## Rollout', 'merge', ''].join('\n')
function stepResult(action, rec) {
  const n = action.issue
  const p = profileOf(n)
  const step = action.step
  let minutes = STEP_MIN[step] ?? p[step] ?? 10
  let hang = false
  let result
  const ok = (head, data) => ({ event: 'ok', reason: null, why: null, head, choice: null, data })
  const notOk = (reason, data) => ({ event: 'not-ok', reason, why: null, head: null, choice: null, data })
  if (step === 'design') {
    minutes = p.design ?? 8
    if (p.designDead && (W.designDeadLeft.get(n) ?? p.designDead) > 0) {
      W.designDeadLeft.set(n, (W.designDeadLeft.get(n) ?? p.designDead) - 1)
      result = unknownResult('agent-dead', 'its turn ended: error: the designer failed')
    } else if (p.designQuestion) result = notOk('question', { kind: 'question', brief: null, question: p.designQuestion, children: [], text: p.designQuestion })
    else if (p.split && !W.records.some(r => r.issue === n && r.state === 'closed')) {
      const children = p.split.map((c, i) => ({ key: `part-${i + 1}`, title: `Part ${i + 1} of #${n}`, body: BRIEF(c), blockedBy: i === 0 ? [] : ['part-1'], ready: i === 0 }))
      result = notOk('split', { kind: 'split', brief: `split #${n}`, question: null, children, text: `split into ${children.length} children` })
    } else result = ok(null, { kind: 'brief', brief: BRIEF(n), question: null, children: [] })
  } else if (step === 'build') {
    minutes = p.build ?? 25
    if (p.buildCannot) result = notOk('cannot', { result: 'cannot', head: null, title: null, summary: null, evidence: null, reason: p.buildCannot, text: p.buildCannot })
    else {
      const head = sha('build', n, rec.life, action.attempt)
      result = ok(head, { result: 'built', head, title: `Fix #${n}`, summary: `It fixes #${n}.`, evidence: 'npm test: pass', reason: null })
    }
  } else if (step === 'review') {
    const left = W.reviewChangesLeft.get(n) ?? 0
    const pr = W.prs.find(x => x.issue === n && x.state === 'open')
    const changes = left > 0 || (VARIANT === 'faults' && rand() < 0.3)
    if (left > 0) W.reviewChangesLeft.set(n, left - 1)
    const round = rec.round
    const data = {
      verdict: changes ? 'changes' : 'approve',
      findings: changes ? [{ id: `r${round}-1`, severity: 'error', file: 'x.ts', line: 1, text: 'a finding' }] : [],
      summary: changes ? 'needs a change' : 'looks good',
      bump: 'patch',
      round,
      patch: pr?.patch ?? 'unknown',
      head: pr?.head ?? 'unknown',
      pr: pr?.pr ?? rec.pr,
      reviewer: 'adjudicator',
      answer: `answers/${action.key}.answer.json`,
      text: changes ? 'needs a change' : 'looks good',
    }
    result = changes ? { event: 'not-ok', reason: 'changes', why: null, head: null, choice: null, data } : { event: 'ok', reason: null, why: null, head: null, choice: null, data }
  } else if (step === 'fix') {
    const declined = VARIANT === 'faults' && rand() < 0.1
    if (declined) result = notOk('declined', { result: 'declined', summary: 'declined', findings: [], notes: ['the fixer declined r1-1: wrong'], text: 'declined' })
    else {
      const k = (W.fixRound.get(n) ?? 0) + 1
      W.fixRound.set(n, k)
      const head = sha('fix', n, rec.life, k)
      result = ok(head, { result: 'fixed', head, summary: 'fixed', findings: [], notes: [] })
    }
  } else if (step === 'triage') {
    const q = p.buildCannot ?? `${rec.state}: two unknowns in a row (${rec.step ?? 'step'}); does this issue need a person?`
    result = { event: 'ok', reason: 'needs the owner', why: null, head: null, choice: 'park', data: { choice: 'park', question: q, text: q } }
  }
  if (VARIANT === 'faults' && step !== 'triage') {
    const x = rand()
    if (x < 0.08) result = unknownResult('agent-dead', 'its turn ended: error: agent crashed')
    else if (x < 0.14) hang = true
  }
  return { minutes, result, hang }
}

// --- executing one planned action ----------------------------------------------------------------------------------
const ALLOWED = new Set(['transition', 'label', 'comment', 'event', 'pr', 'split', 'agent-step', 'ci-rerun', 'queue-update', 'queue-merge', 'slot', 'claim', 'heartbeat', 'sweep', 'stop-agent', 'rollout', 'close-issue', 'release-parent', 'milestone-later', 'restart-self', 'task', 'tell', 'title'])
const done = (key, outcome, summary) => {
  W.ledger = ledgerMod.finish(W.ledger, key, { status: 'done', outcome, summary }, W.now)
}

function execute(a) {
  if (!ALLOWED.has(a.kind)) violation('kind', `planned a ${a.kind} action (${a.key}), which v2 has no executor for`, a.issue)
  if (a.kind === 'title') {
    W.lastTitle = a.text
    return
  }
  const started = ledgerMod.start(W.ledger, a, W.now)
  W.ledger = started.ledger
  const cli = { kind: 'cli', exit: 0 }
  switch (a.kind) {
    case 'transition': {
      const stale = recordStale(W.records, a.from, a.next)
      if (stale !== null) {
        W.ledger = ledgerMod.finish(W.ledger, a.key, { status: 'skipped', summary: stale }, W.now, { prev: started.prev })
        note(`transition ${a.key} skipped: ${stale}`)
        return
      }
      const old = a.from === null ? undefined : W.records.find(r => r.issue === a.next.issue && r.life === a.next.life)
      if (old && old.branch !== a.next.branch) violation('branch', `#${a.issue} record branch changed ${old.branch} -> ${a.next.branch}`, a.issue)
      if (old && old.pr !== null && a.next.pr !== null && old.pr !== a.next.pr) violation('pr', `#${a.issue} record PR changed #${old.pr} -> #${a.next.pr}`, a.issue)
      W.records = applied(W.records, a.from, a.next)
      done(a.key, { kind: 'transition', row: a.row, event: a.event, cause: a.cause ?? null, from: old?.state ?? null, to: a.next.state, step: old?.step ?? null, stored: true, via: a.via ?? a.row }, `#${a.issue} ${old?.state ?? 'new'} -> ${a.next.state}`)
      W.events.push({ at: iso(W.now), issue: a.issue, kind: 'transition', row: a.row, event: a.event, from: old?.state ?? null, to: a.next.state, via: a.via ?? a.row, seq: a.next.seq, life: a.next.life })
      if (a.next.state === 'closed') {
        // a dropped or split record leaves; a merged one closed with its PR already
        if (a.next.why === 'merged') W.open.set(a.issue, false)
      }
      return
    }
    case 'label': {
      if (a.issue !== null && a.op !== 'ensure') {
        const ls = labelsOf(a.issue)
        for (const l of [...ls]) if (l.startsWith('factory:')) ls.delete(l)
        if (a.op === 'set' && a.label) ls.add(a.label)
      }
      return done(a.key, cli, 'labels')
    }
    case 'comment':
      return done(a.key, { kind: 'cli', exit: 0, detail: `https://github.com/${REPO}/issues/${a.number}#issuecomment-${++W.commentSeq}` }, 'commented')
    case 'event': {
      W.events.push({ at: iso(W.now), issue: a.issue, kind: 'event', state: a.event?.state, who: a.event?.who ?? null, cause: a.event?.cause ?? null, reason: a.event?.reason ?? a.event?.note ?? null, key: a.key })
      if (a.event?.state === 'reclaimed' || a.event?.state === 'abandoned') {
        if (W.claimedBy.has(a.issue)) {
          W.claimedBy.delete(a.issue)
          note(`#${a.issue} ghost released (${a.event.state})`)
        }
      }
      return done(a.key, cli, 'logged')
    }
    case 'pr': {
      if (a.op === 'body') return done(a.key, cli, 'body')
      let p = W.prs.find(x => x.issue === a.issue && x.branch === a.branch && x.state !== 'merged')
      let created = false
      let reopened = false
      if (p === undefined) {
        const rec = W.records.find(r => r.issue === a.issue && r.state !== 'closed')
        const head = rec?.head ?? sha('nohead', a.issue)
        p = { pr: ++W.prSeq, issue: a.issue, branch: a.branch, state: 'open', head, patch: sha('patch', a.issue, 0).slice(0, 40), base: W.main, dirty: false }
        W.prs.push(p)
        created = true
        W.prCreated.set(a.issue, (W.prCreated.get(a.issue) ?? 0) + 1)
        if (W.prCreated.get(a.issue) > 1) violation('second-pr', `#${a.issue} got PR #${p.pr}, its ${W.prCreated.get(a.issue)}th`, a.issue)
        startCi(head, a.issue)
        note(`PR #${p.pr} opened for #${a.issue} on ${a.branch}`)
      } else if (p.state === 'closed') {
        p.state = 'open'
        reopened = true
      }
      if (a.pr !== null && a.pr !== p.pr) violation('pr', `ensure for #${a.issue} named PR #${a.pr} but the branch's PR is #${p.pr}`, a.issue)
      return done(a.key, { kind: 'pr', pr: p.pr, created, reopened }, `PR #${p.pr}`)
    }
    case 'split': {
      const p = profileOf(a.parent)
      const idx = Number((a.child.key.match(/(\d+)$/) ?? [0, 1])[1]) - 1
      const child = p.split?.[idx] ?? 2000 + W.commentSeq++
      labelsOf(child)
      if (a.child.ready) labelsOf(child).add('ready')
      W.open.set(child, true)
      W.blockers.set(child, a.blockedBy ?? [])
      W.subIssues.set(a.parent, (W.subIssues.get(a.parent) ?? 0) + 1)
      W.only.add(child)
      if (!readyAt.has(child)) readyAt.set(child, W.now)
      note(`split #${a.parent}: child #${child}${a.child.ready ? ' ready' : ''}`)
      return done(a.key, { kind: 'split', child }, `child #${child}`)
    }
    case 'agent-step': {
      const rec = W.records.find(r => r.issue === a.issue && r.life === a.life)
      if (rec === undefined) violation('nonsense', `agent-step ${a.key} for a life with no record`, a.issue)
      if (rec && a.branch !== rec.branch) violation('branch', `agent-step ${a.key} on ${a.branch}, record on ${rec.branch}`, a.issue)
      const running = W.ledger.filter(e => e.kind === 'agent-step' && e.status === 'running' && e.issue === a.issue && e.key !== a.key)
      if (running.length > 0) violation('one-writer', `#${a.issue} starts ${a.step} while ${running.map(e => e.key).join(', ')} runs`, a.issue)
      const agentId = `agent-${++W.agentSeq}`
      W.ledger = ledgerMod.finish(W.ledger, a.key, { status: 'running', agentId, summary: `${a.step} started` }, W.now)
      const limited = W.now >= limitFrom && W.now < limitTo
      const { minutes, result, hang } = rec ? stepResult(a, rec) : { minutes: 1, result: unknownResult('agent-dead', 'no record'), hang: false }
      if (limited) W.agents.set(a.key, { endAt: W.now + 30 * SEC, result: unknownResult('rate-limited', 'its turn ended: error: API Error: 429 session limit'), agentId, hang: false })
      else W.agents.set(a.key, { endAt: W.now + minutes * MIN, result, agentId, hang })
      note(`${a.step} #${a.issue} started (${a.key})${hang ? ' [will hang]' : ''}`)
      return
    }
    case 'ci-rerun': {
      const p = W.prs.find(x => x.pr === a.pr)
      const run = p && W.ciRuns.get(p.head)
      if (run) {
        run.startAt = W.now
        run.runId = run.runId // same run, re-run
        run.fail = VARIANT === 'faults' ? rand() < 0.3 : false
      }
      return done(a.key, cli, `re-ran ${a.runId}`)
    }
    case 'queue-update': {
      const p = W.prs.find(x => x.pr === a.pr)
      const head = queueOf(W.records, W.control.paused)[0]
      if (!head || head.pr !== a.pr) violation('head-only', `queue-update of PR #${a.pr} (#${a.issue}) while the head is ${head ? `#${head.issue}` : 'none'}`, a.issue)
      const left = W.conflictsLeft.get(a.issue) ?? 0
      if (left > 0 || (VARIANT === 'faults' && rand() < 0.15)) {
        W.conflictsLeft.set(a.issue, Math.max(0, left - 1))
        p.dirty = true
        note(`update of PR #${a.pr} conflicts`)
        return done(a.key, { kind: 'queue', op: 'update', merged: false, head: null, failClass: 'conflict', lines: ['merge conflict'] }, 'conflicts')
      }
      p.head = sha('update', p.pr, W.main)
      p.base = W.main
      startCi(p.head, a.issue)
      note(`PR #${a.pr} updated onto main ${W.main.slice(0, 7)}`)
      return done(a.key, { kind: 'queue', op: 'update', merged: false, head: p.head, failClass: null, lines: [] }, 'updated')
    }
    case 'queue-merge': {
      const p = W.prs.find(x => x.pr === a.pr)
      const head = queueOf(W.records, W.control.paused)[0]
      if (!head || head.pr !== a.pr) violation('head-only', `queue-merge of PR #${a.pr} (#${a.issue}) while the head is ${head ? `#${head.issue}` : 'none'}`, a.issue)
      const rec = W.records.find(r => r.issue === a.issue && r.state !== 'closed')
      if (rec && rec.approvedPatch !== a.patch) violation('patch', `merge of #${a.issue} with patch ${a.patch} not the approved ${rec.approvedPatch}`, a.issue)
      const checks = checksOf(p)
      const green = checks.length > 0 && checks.every(c => c.bucket === 'pass')
      if (p.head !== a.head || mergeableOf(p) !== 'clean' || !green || p.patch !== a.patch) {
        const cls = mergeableOf(p) === 'behind' ? 'behind' : !green ? 'checks' : 'patch'
        return done(a.key, { kind: 'queue', op: 'merge', merged: false, head: a.head, failClass: cls, lines: [`FAIL ${cls}`] }, `refused ${cls}`)
      }
      p.state = 'merged'
      p.mergedHead = p.head
      W.open.set(a.issue, false)
      advanceMain(`merge of PR #${p.pr} for #${a.issue}`)
      note(`MERGED PR #${p.pr} (#${a.issue})`)
      return done(a.key, { kind: 'queue', op: 'merge', merged: true, head: a.head, failClass: null, lines: ['merged'] }, 'merged')
    }
    case 'slot': {
      if (a.op === 'lease') {
        const id = `L${++W.leaseSeq}`
        const l = { path: `/workspaces/dev-system/.treehouse/pool/${W.leaseSeq}/dev-system`, lease: id, holder: `factory-loop:${a.issue}:${a.life}`, issue: a.issue, life: a.life, status: 'leased', busy: false }
        W.leases.push(l)
        return done(a.key, { kind: 'slot', op: 'lease', path: l.path, lease: id, head: null, killed: null }, `leased ${id}`)
      }
      if (a.op === 'prepare') {
        const rec = W.records.find(r => r.issue === a.issue && r.life === a.life)
        if (rec && a.branch !== null && a.branch !== rec.branch) violation('branch', `prepare ${a.key} on ${a.branch}, record on ${rec.branch}`, a.issue)
        const pr = rec?.pr ? W.prs.find(x => x.pr === rec.pr) : null
        return done(a.key, { kind: 'slot', op: 'prepare', path: a.path, lease: a.lease, head: pr?.head ?? rec?.head ?? W.main, killed: null, leftovers: null }, 'prepared')
      }
      if (a.op === 'free') {
        W.leases = W.leases.filter(l => l.lease !== a.lease)
        return done(a.key, { kind: 'slot', op: 'free', path: a.path, lease: a.lease, head: null, killed: 0, leftovers: null }, 'freed')
      }
      return done(a.key, { kind: 'slot', op: a.op, path: a.path, lease: a.lease, head: null, killed: 0 }, a.op)
    }
    case 'claim': {
      const n = a.issue
      if (a.rule === 'S1') {
        const ls = labelsOf(n)
        if (!ls.has('ready')) violation('nonsense', `claim of #${n}, which is not labelled ready`, n)
        ls.delete('ready')
        note(`claimed #${n}`)
        const open = W.prs.find(x => x.issue === n && x.state === 'open')
        return done(a.key, { kind: 'adopt', branch: open?.branch ?? `issue-${n}`, pr: open?.pr ?? null, others: [] }, `claimed #${n}`)
      }
      return done(a.key, { kind: 'claim', result: 'claimed' }, `claimed #${n} again`)
    }
    case 'stop-agent': {
      const e = W.ledger.find(x => x.agentId === a.agentId && x.status === 'running')
      if (e) {
        W.ledger = ledgerMod.finish(W.ledger, e.key, { status: 'timed-out', summary: 'stopped' }, W.now)
        W.agents.delete(e.key)
      }
      return done(a.key, cli, 'stopped')
    }
    case 'close-issue':
      W.open.set(a.issue, false)
      return done(a.key, cli, 'closed')
    default:
      return done(a.key, cli, a.kind)
  }
}

// --- world events between passes ------------------------------------------------------------------------------------
function worldStep(prev, now) {
  for (const d of directives) if (d.at > prev && d.at <= now) W.control = d.set(W.control)
  if (VARIANT === 'rescues') {
    for (const r of rescues) {
      if (!(r.at > prev && r.at <= now)) continue
      for (const n of r.drop ?? []) W.control = { ...W.control, dropped: [...W.control.dropped, { issue: n, at: r.at }] }
      for (const n of r.undrop ?? []) W.control = { ...W.control, dropped: W.control.dropped.filter(d => d.issue !== n) }
      for (const n of r.ready ?? []) labelsOf(n).add('ready')
      for (const n of r.close ?? []) W.open.set(n, false)
    }
  }
  // issues labelled ready (as the factory's queue first showed them), but split children, which
  // the sim's own split makes
  for (const [n, at] of readyAt) {
    if (at > prev && at <= now && !(n === 602 || n === 603) && !W.labels.has(n)) {
      labelsOf(n).add('ready')
      W.open.set(n, true)
    }
  }
  for (const [n, until] of readyUntil) {
    if (V1_CLAIMED.has(n) || n === 602 || n === 603) continue
    const last = replay.samples[replay.samples.length - 1].t
    if (until < last && until + 2 * MIN > prev && until + 2 * MIN <= now && W.labels.has(n) && !W.records.some(r => r.issue === n)) labelsOf(n).delete('ready')
  }
  for (const m of outsideMerges) if (m > prev && m <= now) advanceMain('an outside merge')
  for (const r of restarts) {
    if (!(r > prev && r <= now)) continue
    W.loadedAt = r + 30 * SEC
    for (const e of W.ledger.filter(x => x.status === 'running')) {
      W.ledger = ledgerMod.finish(W.ledger, e.key, { status: 'lost', summary: 'lost in a restart' }, r)
      W.agents.delete(e.key)
    }
    note('RESTART: running entries lost')
  }
  // the session limit: every running agent's turn ends in a 429
  if (limitFrom > prev && limitFrom <= now) {
    for (const [key, ag] of W.agents) ag.endAt = limitFrom
    for (const [, ag] of W.agents) {
      ag.result = unknownResult('rate-limited', 'its turn ended: error: API Error: 429 session limit')
      ag.hang = false
    }
    note('429: every running agent ends rate-limited')
  }
  for (const [key, ag] of [...W.agents]) {
    if (ag.hang || ag.endAt > now) continue
    const e = W.ledger.find(x => x.key === key)
    if (e && e.status === 'running' && e.agentId === ag.agentId) {
      const step = e.step
      W.ledger = ledgerMod.finish(W.ledger, key, { status: 'done', outcome: { kind: 'step', step, result: ag.result }, summary: `${step}: ${ag.result.event}` }, Math.min(ag.endAt, now))
      note(`${step} #${e.issue} answered ${ag.result.event}${ag.result.reason ? ` (${ag.result.reason})` : ''}`)
      if (ag.result.event === 'ok' && ag.result.head) {
        // a writer pushed: the PR (if any) moves to the new head, and CI runs on it
        const p = W.prs.find(x => x.issue === e.issue && x.state === 'open')
        if (p) {
          p.head = ag.result.head
          p.dirty = false
          if (step === 'fix') p.base = W.main
          p.patch = sha('patch', e.issue, W.fixRound.get(e.issue) ?? 0).slice(0, 40)
        }
        if (step === 'build' && p === undefined) {
          // nothing yet: the PR is ensured next; record the build head for it
        }
        startCi(ag.result.head, e.issue)
      }
    }
    W.agents.delete(key)
  }
}

// --- invariants per pass --------------------------------------------------------------------------------------------
const TIMEOUT_MIN = { designing: 45, building: 90, reviewing: 30, fixing: 60, queued: 360, 'merge-queue': 120 }
const idle = new Map() // `${issue}:${life}` -> { since, state, reasons: Set }
const findings = { maxIdle: [], silentPasses: 0, heldWaits: new Map(), onlyLines: 0 }
function checkPass(result, state) {
  const planned = new Set(result.actions.filter(a => a.issue !== null).map(a => a.issue))
  for (const a of result.actions) {
    if (a.kind === 'queue-update' || a.kind === 'queue-merge') {
      const head = queueOf(state.v2.records, state.control.paused)[0]
      if (!head || head.issue !== a.issue) violation('head-only', `planned ${a.kind} for #${a.issue}; queue head is ${head ? `#${head.issue}` : 'none'}`, a.issue)
    }
    if (a.kind === 'pr' && a.op === 'ensure') {
      const rec = state.v2.records.find(r => r.issue === a.issue && r.state !== 'closed')
      if (rec && a.branch !== rec.branch) violation('branch', `pr ensure for #${a.issue} on ${a.branch}, record on ${rec.branch}`, a.issue)
    }
  }
  const inSlots = state.v2.records.filter(r => SLOT_STATES.includes(r.state)).length
  if (inSlots > K) violation('capacity', `${inSlots} records in slot states, K=${K}`)
  for (const r of state.v2.records) {
    const id = `${r.issue}:${r.life}`
    if (r.state === 'closed' || r.state === 'parked') {
      idle.delete(id)
      continue
    }
    const running = state.ledger.some(e => e.status === 'running' && e.issue === r.issue)
    // S1's claim lines ('only names it, but it is not in the ready queue') say nothing of a record's
    // step, so they do not count as the record's named wait
    const allSkips = result.skipped.filter(s => s.issue === r.issue)
    const skips = allSkips.filter(s => s.rule !== 'S1').map(s => s.why)
    if (allSkips.some(s => s.rule === 'S1' && /only names it/.test(s.why))) findings.onlyLines++
    if (running || planned.has(r.issue)) {
      idle.delete(id)
      continue
    }
    if (skips.length === 0) {
      findings.silentPasses++
      violation('silent', `#${r.issue} in ${r.state} (step ${r.step}) has no running step, no planned action and no skip line`, r.issue)
    }
    const cur = idle.get(id)
    if (!cur || cur.state !== r.state) idle.set(id, { since: state.now, state: r.state, reasons: new Set(skips) })
    else for (const s of skips) cur.reasons.add(s)
    const x = idle.get(id)
    const mins = (state.now - x.since) / MIN
    const limit = TIMEOUT_MIN[r.state] ?? 60
    if (mins > limit && !x.flagged) {
      x.flagged = true
      findings.maxIdle.push({ issue: r.issue, state: r.state, from: iso(x.since), minutes: Math.round(mins), reasons: [...x.reasons].slice(0, 4) })
    }
  }
}

// --- the run ---------------------------------------------------------------------------------------------------------
const config = loadConfig({ mode: 'act', maxInFlightIssues: K, skipLabels: ['parked'] }).config
for (const [n, p] of Object.entries(PROFILE)) {
  if (VARIANT === 'faults') continue
  if (p.conflict) W.conflictsLeft.set(Number(n), p.conflict)
  if (p.ciFlaky) W.flakyLeft.set(Number(n), p.ciFlaky)
  if (p.reviewChanges) W.reviewChangesLeft.set(Number(n), p.reviewChanges)
}

let from = T(A.from ?? '2026-10-14T17:59:35Z')
const to = T(A.to ?? '2026-10-15T07:22:43Z')
W.loadedAt = from
W.now = from - 1
worldStep(T('2026-10-14T00:00:00Z'), from)
// labels of issues already ready when the run starts
for (const [n, at] of readyAt) if (at <= from && !W.labels.has(n)) labelsOf(n).add('ready')
if (A.takeover) {
  // the real world at --from: only the factory's real queue is labelled ready, and what v1 merged
  // or a person closed is closed (G1's per-issue table)
  const sample = [...replay.samples].reverse().find(x => x.t <= from)
  for (const [n, ls] of W.labels) ls.delete('ready')
  for (const n of sample.queue) labelsOf(n).add('ready')
  for (const n of [356, 588, 596, 601, 595, 624]) W.open.set(n, false)
  W.only.add(602)
  W.only.add(603)
  W.blockers.set(603, [602])
  for (const [n] of readyAt) if (readyAt.get(n) > from) readyAt.delete(n)
}
const reready = (A.reready ?? '').split(',').filter(Boolean).map(Number)

// takeover: the live v1 claims at --from, from the stock harness's v2 replay (each one R1 named)
if (A.takeover) {
  const tk = JSON.parse(fs.readFileSync(A.takeover, 'utf8'))
  const s = [...tk.samples].reverse().find(x => x.t <= from)
  const named = new Set(s.actions.filter(x => x.rule === 'R1' && x.issue !== null).map(x => x.issue))
  for (const sk of s.skipped) if (sk.rule === 'R1' && sk.issue !== null) named.add(sk.issue)
  for (const n of named) {
    W.claimedBy.set(n, { stage: 'implementing', since: from - 60 * MIN, pr: null })
    labelsOf(n).delete('ready')
    W.open.set(n, true)
  }
  // their open PRs (G1's per-issue table), which a re-claim adopts
  const open = { 467: 621, 571: 631, 589: 626, 583: 584, 533: 599 }
  for (const [n, pr] of Object.entries(open)) {
    const head = sha('v1head', n)
    W.prs.push({ pr, issue: Number(n), branch: `feat/issue-${n}-v`, state: 'open', head, patch: sha('v1patch', n).slice(0, 40), base: sha('old-main'), dirty: Number(n) === 589 || Number(n) === 583 })
    // green CI on the v1 heads (G1: #621 and #631 CLEAN); #589's PR #626 conflicts and has no checks
    if (Number(n) !== 589) W.ciRuns.set(head, { runId: ++W.ciSeq, startAt: from - 60 * MIN, fail: false })
    W.prCreated.set(Number(n), 0)
  }
  note(`takeover: v1's live claims ${[...named].join(', ')}`)
}

const passes = []
let prevT = from - 1
let t = from
let crashes = 0
let n = 0
while (t <= to) {
  W.now = t
  worldStep(prevT, t)
  // the owner re-adds ready to released issues five minutes in (takeover runs)
  if (reready.length > 0 && from + 5 * MIN > prevT && from + 5 * MIN <= t) {
    for (const k of reready) labelsOf(k).add('ready')
    W.control = { ...W.control, only: [...W.control.only, ...reready.filter(k => !W.control.only.includes(k))] }
    note(`owner re-adds ready: ${reready.join(', ')}`)
  }
  let state
  let result
  try {
    state = stateNow()
    result = planV2(state, config)
  } catch (err) {
    crashes++
    violation('crash', `planV2 threw: ${err.stack?.split('\n').slice(0, 3).join(' | ')}`)
    prevT = t
    t += 60 * SEC
    continue
  }
  checkPass(result, state)
  for (const a of result.actions) {
    try {
      execute(a)
    } catch (err) {
      crashes++
      violation('crash', `executing ${a.kind} ${a.key} threw: ${err.message}`)
    }
  }
  const acted = result.actions.some(a => a.kind !== 'title' && a.kind !== 'heartbeat' && a.kind !== 'sweep')
  passes.push({
    at: iso(t),
    tier: result.tier,
    atCap: result.atCap,
    actions: result.actions.filter(a => a.kind !== 'title').map(a => `${a.kind}${a.op ? ':' + a.op : ''}${a.step ? ':' + a.step : ''}${a.issue !== null ? ' #' + a.issue : ''}`),
    records: W.records.filter(r => r.state !== 'closed').map(r => `#${r.issue}:${r.state}${r.step ? '/' + r.step : ''}`),
    queue: state.queue,
    skipped: result.skipped.filter(s => s.issue !== null).map(s => `#${s.issue} ${s.rule}: ${s.why}`).slice(0, 12),
    title: result.title,
  })
  prevT = t
  t += acted ? 10 * SEC : 60 * SEC
  n++
}

// --- the report --------------------------------------------------------------------------------------------------------
const lives = new Map()
for (const r of W.records) lives.set(`${r.issue}:${r.life}`, r)
const summary = {
  args: { k: K, variant: VARIANT, seed: SEED, from: iso(from), to: iso(to), takeover: Boolean(A.takeover) },
  passes: n,
  crashes,
  records: [...lives.values()].map(r => ({ issue: r.issue, life: r.life, state: r.state, why: r.why, step: r.step, pr: r.pr, branch: r.branch, fixes: r.fixes, triages: r.triages, round: r.round, question: r.question })),
  merged: W.records.filter(r => r.why === 'merged').map(r => r.issue),
  prsCreated: Object.fromEntries(W.prCreated),
  violations: W.violations,
  violationsByKind: W.violations.reduce((m, v) => ({ ...m, [v.kind]: (m[v.kind] ?? 0) + 1 }), {}),
  idleOverTimeout: findings.maxIdle,
  onlyLinesOnRecords: findings.onlyLines,
  interventions: W.events.filter(e => e.state === 'intervention').map(e => ({ at: e.at, issue: e.issue, who: e.who, cause: e.cause, reason: e.reason })),
  kinds: passes.flatMap(p => p.actions).reduce((m, a) => {
    const k = a.split(' ')[0]
    return { ...m, [k]: (m[k] ?? 0) + 1 }
  }, {}),
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1) + '\n')
fs.writeFileSync(path.join(OUT, 'passes.jsonl'), passes.map(p => JSON.stringify(p)).join('\n') + '\n')
fs.writeFileSync(path.join(OUT, 'transitions.jsonl'), W.events.map(e => JSON.stringify(e)).join('\n') + '\n')
fs.writeFileSync(path.join(OUT, 'world.log'), W.log.join('\n') + '\n')
console.log(JSON.stringify({ passes: n, crashes, merged: summary.merged, violationsByKind: summary.violationsByKind, idleOverTimeout: findings.maxIdle.length, records: summary.records.map(r => `#${r.issue} ${r.state}${r.why ? '(' + r.why + ')' : ''}`) }))
