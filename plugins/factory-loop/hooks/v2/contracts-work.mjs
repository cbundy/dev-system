// The answers of the designer, the builder and the fixer (docs/factory-loop/v2/SPEC.md 8.1, 8.7,
// 9.7):
//
// - `design-v2` (named so beside v1's `design` until the delete wave): a brief, a question for the
//   owner, or a split into children. The designer is a reader (8.7): it gives the text, and the
//   loop posts the brief and makes the children.
//     { "kind": "brief", "brief": "## Design brief (designer, <date>) ..." }
//     { "kind": "question", "question": "...", "brief": "<a draft, or null>" }
//       and, optionally, "context", "options" (2 to 6 of { key: A to F, title, detail? }) and
//       "recommendation" ({ key, reason }), checked by question.mjs; the question once rendered
//       with them must fit its 2 000 characters; the outcome carries them only when given
//     { "kind": "split", "brief": "<the epic's plan>",
//       "reasons": { "why_split": "...", "why_count": "...", "why_parts": "...", "why_order": "..." },
//       "children": [{ "key": "a", "title": "...", "why": "...", "body": "...", "blockedBy": ["b"], "ready": true }] }
//     { "kind": "wait", "conditions": [{ "kind": "issue-closed", "issue": 57 }, { "kind": "pr-merged", "pr": 812 }, { "kind": "tag-contains", "sha": "35bb655" }],
//       "reason": "<one line, at most 500>", "brief": "<a draft, or null>" }
//       1 to 8 conditions of issue-closed, pr-merged or tag-contains (a release tag carries the commit
//       `sha`, 7 to 40 hex, stored lower-case), each number at least 1, never the issue itself, none
//       twice; the loop re-checks them and resumes the designer once every one holds; the outcome
//       carries conditions and reason only for a wait
//   A child with "ready": false carries an open owner decision: an optional "decision" object
//   { question, context?, options?, recommendation? }, checked as a question answer is
//   (split-decision.mjs; refused on a ready child), which the loop parks the child on. Without one, the
//   body's ## Open decisions section is the question.
//   A split gives four short reasons (each at most 500 characters) and a one-line `why` for each
//   child (at most 200): why split, why this many parts, why these boundaries, why this order.
//   A brief has an `## Observability` section (the decisions it adds and where each is recorded,
//   or "none - no new decision"), and a `## Compatibility` section (what changes in a migration,
//   event schema, the event writer or a factory-database reader and why the last 10 minor
//   versions keep working, or "none - no schema, event or reader change").
//   A brief starts with its `## Design brief` heading and has a `## Rollout` of merge, run-it or
//   keep-open, read as callum-flow-rollout reads it, so the merge guard can derive its linkage.
//   A keep-open whose reason says the issue is part of something larger is refused: a split child
//   is done when its PR merges. A split's children are 2 to 10, each key unique, each body with a
//   valid `## Rollout`. A blockedBy entry is a sibling key or "#<N>",
//   an existing issue of the repo (never the issue being split); the siblings have no cycle.
// - `build`: what the PR says, or that it cannot (T6 sends that to triage).
//     { "result": "built", "head": "<sha>", "title": "...", "summary": "...", "evidence": "..." | null }
//     { "result": "cannot", "reason": "..." }
// - `fix`: each finding fixed or declined, with a reason (8.6, 9.7). A fix that pushed gives its
//   head; one that declined everything pushes nothing. The job's data may name the finding ids that
//   must each have a disposition (the review's error findings). Either may give the PR's evidence,
//   as a build does: the newest given is the PR's (rules-review.ts workOf).
//     { "result": "fixed", "head": "<sha>", "summary": "...", "evidence": "..." | null,
//       "findings": [{ "id": "r2-1", "disposition": "fixed", "reason": "..." }] }
//     { "result": "declined", "summary": "...",
//       "findings": [{ "id": "r2-1", "disposition": "declined", "reason": "..." }] }
//     { "result": "unchanged", "summary": "...", "evidence": "..." | null,
//       "findings": [{ "id": "r2-1", "disposition": "fixed", "reason": "..." }] }
//   unchanged: nothing pushed, at least one finding fixed outside the branch (the PR's description
//   or evidence), the rest declined. A conflict is fixed only by a pushed merge, so never here.
//
// Each outcome is the answer with every field present (absent texts null, lists []), heads lower
// case. Each contract is { check(input, job), summary(input) }: check gives { ok: true, outcome } or
// every problem at once, as contract.mjs's checks do; summary is the answer script's few words on
// what it recorded. contract.mjs imports this module, so the loop and bin/factory-answer check
// alike. ES2023 alone, nothing of Node or the engine. Its types are contracts-work.d.mts's.

import { QUESTION_FIELDS, checkQuestionParts } from './question.mjs'
import { childDecisionOf } from './split-decision.mjs'

export const DESIGN_KINDS = Object.freeze(['brief', 'question', 'split', 'wait'])
export const BUILD_RESULTS = Object.freeze(['built', 'cannot'])
export const FIX_RESULTS = Object.freeze(['fixed', 'declined', 'unchanged'])
export const DISPOSITIONS = Object.freeze(['fixed', 'declined'])
export const ROLLOUTS = Object.freeze(['merge', 'run-it', 'keep-open'])
// A brief and a child's body may be long: GitHub takes 65 536 characters in a comment or a body.
// Every other text is short: a title, a reason, the PR's summary and evidence (neutral() keeps
// 4 000 of each, 8.1).
export const LIMITS = Object.freeze({
  brief: 20000,
  question: 2000,
  childTitle: 120,
  childBody: 20000,
  childWhy: 200,
  splitReason: 500,
  waitReason: 500,
  title: 72,
  summary: 4000,
  evidence: 4000,
  reason: 2000,
  findingReason: 1000,
  fixSummary: 2000,
})
export const REASON_KEYS = Object.freeze(['why_split', 'why_count', 'why_parts', 'why_order'])
export const CHILDREN = Object.freeze({ min: 2, max: 10 })
export const WAIT_CONDITIONS = Object.freeze({ min: 1, max: 8 })
// The conditions a wait may name: the loop checks each from GitHub with no model call.
export const WAIT_KINDS = Object.freeze(['issue-closed', 'pr-merged', 'tag-contains'])
// A child's key goes into its ledger key (keys.ts childKey) and its hidden marker.
export const CHILD_KEY = /^[a-z0-9][a-z0-9-]{0,23}$/
const SHA = /^[0-9a-f]{7,40}$/i
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/
const BRIEF_HEADING = /^\s*##\s+Design brief/

function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
}

// show: a value as a problem names it, cut short.
function show(v) {
  const text = typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v) ?? v)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

// strays: a problem for each field the answer has that its contract does not.
function strays(o, fields, what, problems) {
  for (const key of Object.keys(o)) if (!fields.includes(key)) problems.push(`${key} is not a field of ${what} (only ${fields.join(', ')})`)
}

// text: a field as trimmed text within its limit; null when absent and not required. A required
// one that is missing, empty or not text is a problem, as is a value given where none may be.
function text(o, key, limit, need, problems, where = '') {
  const v = o[key]
  const name = `${where}${key}`
  if (v === undefined || v === null) {
    if (need === 'required') problems.push(`${name} is required`)
    return null
  }
  if (need === 'none') {
    problems.push(`${name} must be absent or null here`)
    return null
  }
  if (typeof v !== 'string' || v.trim() === '') {
    problems.push(`${name} must be text, not ${show(v)}`)
    return null
  }
  if (v.length > limit) problems.push(`${name} is ${v.length} characters; at most ${limit}`)
  return v.trim()
}

function oneLine(value, name, problems) {
  if (value !== null && /[\r\n]/.test(value)) problems.push(`${name} must be one line`)
}

function sha(o, key, need, problems) {
  const v = o[key]
  if (v === undefined || v === null) {
    if (need === 'required') problems.push(`${key} is required: the commit you pushed, 7 to 40 hex digits`)
    return null
  }
  if (need === 'none') {
    problems.push(`${key} must be absent or null here`)
    return null
  }
  if (typeof v === 'string' && SHA.test(v.trim())) return v.trim().toLowerCase()
  problems.push(`${key} ${show(v)} is not a commit SHA of 7 to 40 hex digits`)
  return null
}

function checked(problems, outcome) {
  return problems.length > 0 ? { ok: false, problems } : { ok: true, outcome: outcome() }
}

// --- design-v2 (8.7) --------------------------------------------------------------------------------

// rolloutOf: the first word of a brief's `## Rollout` section, as callum-flow-rollout reads it: the
// first non-empty line under the first heading `## Rollout` outside fenced code, up to the next
// heading, lower case, leading non-letters dropped. null when the brief has no such section or
// line.
export function rolloutOf(brief) {
  const line = rolloutLineOf(brief)
  return line === null ? null : line.toLowerCase().replace(/^[^a-z]*/, '').replace(/[^a-z-].*$/, '')
}

// rolloutLineOf: the line rolloutOf reads, as written, or null.
function rolloutLineOf(brief) {
  return firstLineUnder(brief, 'rollout')
}

// firstLineUnder: the first non-empty line under the first heading named `name` (lower case)
// outside fenced code, up to the next heading, as written; null when there is none.
function firstLineUnder(brief, name) {
  let fence = false
  let on = false
  for (const line of brief.split(/\r?\n/)) {
    if (/^[ \t]*(```|~~~)/.test(line)) {
      fence = !fence
      if (on && line.trim() !== '') return null
      continue
    }
    if (!fence && /^#{1,6}[ \t]/.test(line)) {
      if (on) return null
      if (line.toLowerCase().replace(/^#{1,6}[ \t]+/, '').trim() === name) on = true
      continue
    }
    if (on && line.trim() !== '') return line
  }
  return null
}

// rolloutReasonOf: the reason text on the Rollout line, after the value and its dash; '' when the
// line has none, null when there is no Rollout line.
export function rolloutReasonOf(brief) {
  const line = rolloutLineOf(brief)
  if (line === null) return null
  const m = /^[^A-Za-z]*[A-Za-z-]+[^A-Za-z0-9]*(.*)$/.exec(line)
  return m === null ? '' : m[1].trim()
}

// A keep-open reason that says the issue is part of something larger: a split child is done when
// its PR merges, so its Rollout is merge (or run-it with its own Run it).
const PART_OF = /\b(part of|one part|epic|sub-issue|child of|split)\b/i

// rolloutProblems: what is wrong with the Rollout of a brief or a child body, as strings (where
// names it); [] when it is a merge, run-it, or a keep-open for another reason.
function rolloutProblems(text, where) {
  const rollout = rolloutOf(text)
  if (rollout === null || !ROLLOUTS.includes(rollout)) {
    return [`${where}'s ## Rollout must start with one of ${ROLLOUTS.join(', ')}${rollout === null ? '' : `, not ${show(rollout)}`}`]
  }
  const reason = rolloutReasonOf(text) ?? ''
  if (rollout === 'keep-open' && PART_OF.test(reason)) {
    return [`${where}'s ## Rollout is keep-open because it is part of something larger (${show(reason)}); a split child is done when its PR merges, so its Rollout is merge (or run-it with its own ## Run it). Use keep-open only for research, a proposal, or a Done-when that needs a person`]
  }
  return []
}

// cycleOf: the keys of a blockedBy cycle among the children, or null when there is none.
function cycleOf(children) {
  const by = new Map(children.map(c => [c.key, c.blockedBy]))
  const state = new Map()
  const path = []
  const visit = key => {
    if (state.get(key) === 'done') return null
    if (state.get(key) === 'open') return [...path.slice(path.indexOf(key)), key]
    state.set(key, 'open')
    path.push(key)
    // an entry that is not a sibling key (an "#<N>" issue) is no part of a cycle
    for (const next of (by.get(key) ?? []).filter(n => by.has(n))) {
      const found = visit(next)
      if (found !== null) return found
    }
    path.pop()
    state.set(key, 'done')
    return null
  }
  for (const c of children) {
    const found = visit(c.key)
    if (found !== null) return found
  }
  return null
}

const ISSUE_REF = /^#[1-9]\d*$/

function childrenOf(v, problems, parent) {
  if (!Array.isArray(v)) {
    problems.push(`children must be a list of ${CHILDREN.min} to ${CHILDREN.max} children`)
    return []
  }
  if (v.length < CHILDREN.min || v.length > CHILDREN.max) problems.push(`children has ${v.length}; a split has ${CHILDREN.min} to ${CHILDREN.max}`)
  const keys = v.map(c => record(c)?.key)
  const out = []
  v.forEach((raw, i) => {
    const where = `children[${i}].`
    const c = record(raw)
    if (c === null) {
      problems.push(`children[${i}] must be an object { key, title, why, body, blockedBy, ready }`)
      return
    }
    strays(c, ['key', 'title', 'why', 'body', 'blockedBy', 'ready', 'decision'], `children[${i}]`, problems)
    const key = typeof c.key === 'string' && CHILD_KEY.test(c.key) ? c.key : null
    if (key === null) problems.push(`${where}key ${show(c.key)} must be a short lower-case key: letters, digits and dashes, at most 24`)
    else if (keys.indexOf(key) !== i) problems.push(`${where}key ${key} is used twice`)
    const title = text(c, 'title', LIMITS.childTitle, 'required', problems, where)
    oneLine(title, `${where}title`, problems)
    const why = text(c, 'why', LIMITS.childWhy, 'required', problems, `children[${i}]${key === null ? '' : ` (${key})`}.`)
    oneLine(why, `children[${i}]${key === null ? '' : ` (${key})`}.why`, problems)
    const body = text(c, 'body', LIMITS.childBody, 'required', problems, where)
    let blockedBy = []
    if (!Array.isArray(c.blockedBy)) problems.push(`${where}blockedBy must be a list of sibling keys or #<N> issues ([] for none)`)
    else {
      blockedBy = [...new Set(c.blockedBy)]
      for (const b of c.blockedBy) {
        if (typeof b === 'string' && keys.includes(b)) {
          if (b === key) problems.push(`${where}blockedBy names the child itself`)
        } else if (typeof b === 'string' && b.startsWith('#')) {
          if (!ISSUE_REF.test(b)) problems.push(`${where}blockedBy ${show(b)} is not an issue reference: write #<N>, N a positive number with no leading zero`)
          else if (Number(b.slice(1)) === parent) problems.push(`${where}blockedBy ${b} is the issue being split, which stays open, so the child would wait forever`)
        } else problems.push(`${where}blockedBy ${show(b)} is neither the key of another child nor an existing issue #<N>`)
      }
    }
    if (typeof c.ready !== 'boolean') problems.push(`${where}ready must be true or false`)
    const decision = childDecisionOf(c, `children[${i}]${key === null ? '' : ` (${key})`}.`, c.ready, body, parent, problems)
    if (body !== null) problems.push(...rolloutProblems(body, `children[${i}]${key === null ? '' : ` (${key})`} body`))
    if (key !== null && title !== null && why !== null && body !== null) out.push({ key, title, why, body, blockedBy: blockedBy.filter(b => typeof b === 'string'), ready: c.ready === true, decision })
  })
  if (out.length === v.length) {
    const cycle = cycleOf(out)
    if (cycle !== null) problems.push(`children's blockedBy make a cycle: ${cycle.join(' -> ')}`)
  }
  return out
}

// reasonsOf: a split's four reasons, each short text; every problem at once.
function reasonsOf(v, problems) {
  if (v === undefined || v === null) {
    problems.push(`reasons is required for a split: { ${REASON_KEYS.join(', ')} }`)
    return null
  }
  const r = record(v)
  if (r === null) {
    problems.push(`reasons must be an object { ${REASON_KEYS.join(', ')} }, not ${show(v)}`)
    return null
  }
  strays(r, REASON_KEYS, 'reasons', problems)
  const out = {}
  for (const k of REASON_KEYS) out[k] = text(r, k, LIMITS.splitReason, 'required', problems, 'reasons.')
  return REASON_KEYS.every(k => out[k] !== null) ? out : null
}

// partsOf: the optional question fields a checked answer gave, none that it did not.
function partsOf(p) {
  const out = {}
  if (p.context !== null) out.context = p.context
  if (p.options !== null) out.options = p.options
  if (p.recommendation !== null) out.recommendation = p.recommendation
  return out
}

// conditionsOf: a wait's conditions, as the loop stores them; every problem at once.
function conditionsOf(v, problems, self, ownRepo) {
  if (!Array.isArray(v)) {
    problems.push(`conditions must be a list of ${WAIT_CONDITIONS.min} to ${WAIT_CONDITIONS.max} conditions { kind: ${WAIT_KINDS.join(' | ')}, issue | pr | sha }`)
    return []
  }
  if (v.length < WAIT_CONDITIONS.min || v.length > WAIT_CONDITIONS.max) problems.push(`conditions has ${v.length}; a wait has ${WAIT_CONDITIONS.min} to ${WAIT_CONDITIONS.max}`)
  const out = []
  const seen = new Set()
  v.forEach((raw, i) => {
    const where = `conditions[${i}]`
    const c = record(raw)
    if (c === null) {
      problems.push(`${where} must be an object { kind, issue }, { kind, pr } or { kind, sha }`)
      return
    }
    const kind = WAIT_KINDS.find(k => k === c.kind)
    if (kind === undefined) {
      problems.push(`${where}.kind ${show(c.kind)} is not one of ${WAIT_KINDS.join(', ')}`)
      return
    }
    const withRepo = kind !== 'pr-merged'
    let repo
    if (withRepo && c.repo !== undefined && c.repo !== null) {
      if (typeof c.repo !== 'string' || !REPO.test(c.repo)) {
        problems.push(`${where}.repo ${show(c.repo)} must be owner/name (letters, digits, . _ -)`)
        return
      }
      const lower = c.repo.toLowerCase()
      if (lower !== String(ownRepo).toLowerCase()) repo = lower
    }
    if (kind === 'tag-contains') {
      strays(c, ['kind', 'sha', 'repo'], where, problems)
      if (typeof c.sha !== 'string' || !SHA.test(c.sha)) {
        problems.push(`${where}.sha ${show(c.sha)} must be 7 to 40 hex characters (a commit sha)`)
        return
      }
      const sha = c.sha.toLowerCase()
      const id = repo === undefined ? `${kind}:${sha}` : `${kind}:${repo}@${sha}`
      if (seen.has(id)) {
        problems.push(`${where} repeats ${id}`)
        return
      }
      seen.add(id)
      out.push(repo === undefined ? { kind, sha } : { kind, sha, repo })
      return
    }
    const field = kind === 'issue-closed' ? 'issue' : 'pr'
    strays(c, withRepo ? ['kind', field, 'repo'] : ['kind', field], where, problems)
    const n = c[field]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      problems.push(`${where}.${field} ${show(n)} must be a whole number of at least 1`)
      return
    }
    if (kind === 'issue-closed' && n === self && repo === undefined) {
      problems.push(`${where}.issue ${n} is the issue itself, which stays open until its work is done, so the wait would never end`)
      return
    }
    const id = kind === 'issue-closed' && repo !== undefined ? `${kind}:${repo}#${n}` : `${kind}:${n}`
    if (seen.has(id)) {
      problems.push(`${where} repeats ${id}`)
      return
    }
    seen.add(id)
    out.push(kind === 'issue-closed' ? (repo === undefined ? { kind, issue: n } : { kind, issue: n, repo }) : { kind, pr: n })
  })
  return out
}

function checkDesign(input, job) {
  const o = record(input)
  if (o === null) return { ok: false, problems: ['the answer must be one JSON object: {"kind": "brief" | "question" | "split" | "wait", "brief", and "question", "children" or "conditions" and "reason"}'] }
  const problems = []
  strays(o, ['kind', 'brief', 'question', ...QUESTION_FIELDS, 'reasons', 'children', 'conditions', 'reason'], 'a design answer', problems)
  const kind = DESIGN_KINDS.find(k => k === o.kind)
  if (kind === undefined) problems.push(`kind ${show(o.kind)} is not one of ${DESIGN_KINDS.join(', ')}`)
  const brief = text(o, 'brief', LIMITS.brief, kind === 'question' || kind === 'wait' ? 'optional' : 'required', problems)
  if (kind === 'brief' && brief !== null) {
    if (!BRIEF_HEADING.test(brief)) problems.push('brief must start with its heading: ## Design brief (designer, <YYYY-MM-DD>)')
    problems.push(...rolloutProblems(brief, 'brief'))
    if (firstLineUnder(brief, 'observability') === null) problems.push('brief must have an ## Observability section: each decision the change adds and where it is recorded, or "none - no new decision"')
    if (firstLineUnder(brief, 'compatibility') === null) problems.push('brief must have a ## Compatibility section: what changes in a migration, event schema, the event writer or a factory-database reader and why the last 10 minor versions keep working, or "none - no schema, event or reader change"')
  }
  const question = text(o, 'question', LIMITS.question, kind === 'question' ? 'required' : 'none', problems)
  let parts = {}
  if (kind === 'question') parts = partsOf(checkQuestionParts(o, question, problems))
  else for (const k of QUESTION_FIELDS) if (o[k] !== undefined && o[k] !== null) problems.push(`${k} must be absent or null unless kind is question`)
  let children = []
  let reasons = null
  if (kind === 'split') {
    reasons = reasonsOf(o.reasons, problems)
    children = childrenOf(o.children, problems, job.issue)
  } else {
    if (o.children !== undefined && o.children !== null) problems.push('children must be absent or null unless kind is split')
    if (o.reasons !== undefined && o.reasons !== null) problems.push('reasons must be absent or null unless kind is split')
  }
  let wait = {}
  if (kind === 'wait') {
    const conditions = conditionsOf(o.conditions, problems, job.issue, job.repo)
    const reason = text(o, 'reason', LIMITS.waitReason, 'required', problems)
    oneLine(reason, 'reason', problems)
    wait = { conditions, reason }
  } else {
    if (o.conditions !== undefined && o.conditions !== null) problems.push('conditions must be absent or null unless kind is wait')
    if (o.reason !== undefined && o.reason !== null) problems.push('reason must be absent or null unless kind is wait')
  }
  return checked(problems, () => ({ kind, brief, question, ...parts, ...wait, reasons, children }))
}

function summaryOfDesign(input) {
  const o = record(input) ?? {}
  if (o.kind === 'split') return `a split into ${Array.isArray(o.children) ? o.children.length : 0} children`
  if (o.kind === 'question') return 'a question for the owner'
  if (o.kind === 'wait') return `a wait on ${Array.isArray(o.conditions) ? o.conditions.length : 0} conditions`
  return o.kind === 'brief' ? 'a design brief' : 'no kind'
}

// --- build (8.1, 4.2) ---------------------------------------------------------------------------------

function checkBuild(input) {
  const o = record(input)
  if (o === null) return { ok: false, problems: ['the answer must be one JSON object: {"result": "built", "head", "title", "summary", "evidence"} or {"result": "cannot", "reason"}'] }
  const problems = []
  strays(o, ['result', 'head', 'title', 'summary', 'evidence', 'reason'], 'a build answer', problems)
  const result = BUILD_RESULTS.find(r => r === o.result)
  if (result === undefined) problems.push(`result ${show(o.result)} is not one of ${BUILD_RESULTS.join(', ')}`)
  const built = result === 'built' ? 'required' : 'none'
  const head = sha(o, 'head', built, problems)
  const title = text(o, 'title', LIMITS.title, built, problems)
  oneLine(title, 'title', problems)
  const summary = text(o, 'summary', LIMITS.summary, built, problems)
  const evidence = text(o, 'evidence', LIMITS.evidence, result === 'built' ? 'optional' : 'none', problems)
  const reason = text(o, 'reason', LIMITS.reason, result === 'cannot' ? 'required' : 'none', problems)
  return checked(problems, () => ({ result, head, title, summary, evidence, reason }))
}

function summaryOfBuild(input) {
  const o = record(input) ?? {}
  if (o.result === 'built') return `built at ${typeof o.head === 'string' ? o.head.slice(0, 7) : 'no head'}`
  return o.result === 'cannot' ? 'cannot build' : 'no result'
}

// --- fix (8.6, 9.7) -----------------------------------------------------------------------------------

// expectedIds: the finding ids the job says must each have a disposition.
function expectedIds(job) {
  const ids = record(record(job)?.data)?.findings
  return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []
}

function findingsOf(v, problems) {
  if (!Array.isArray(v)) {
    problems.push('findings must be a list of { id, disposition, reason } ([] when there was no finding)')
    return []
  }
  const out = []
  const seen = new Set()
  v.forEach((raw, i) => {
    const where = `findings[${i}].`
    const f = record(raw)
    if (f === null) {
      problems.push(`findings[${i}] must be an object { id, disposition, reason }`)
      return
    }
    strays(f, ['id', 'disposition', 'reason'], `findings[${i}]`, problems)
    const id = typeof f.id === 'string' && FINDING_ID.test(f.id) ? f.id : null
    if (id === null) problems.push(`${where}id ${show(f.id)} is not a finding id`)
    else if (seen.has(id)) problems.push(`${where}id ${id} is given twice`)
    else seen.add(id)
    const disposition = DISPOSITIONS.find(d => d === f.disposition)
    if (disposition === undefined) problems.push(`${where}disposition ${show(f.disposition)} is not one of ${DISPOSITIONS.join(', ')}`)
    const reason = text(f, 'reason', LIMITS.findingReason, 'required', problems, where)
    if (id !== null && disposition !== undefined && reason !== null) out.push({ id, disposition, reason })
  })
  return out
}

function checkFix(input, job) {
  const o = record(input)
  if (o === null) return { ok: false, problems: ['the answer must be one JSON object: {"result": "fixed" | "declined" | "unchanged", "head", "summary", "evidence", "findings"}'] }
  const problems = []
  strays(o, ['result', 'head', 'summary', 'evidence', 'findings'], 'a fix answer', problems)
  const result = FIX_RESULTS.find(r => r === o.result)
  if (result === undefined) problems.push(`result ${show(o.result)} is not one of ${FIX_RESULTS.join(', ')}`)
  const head = sha(o, 'head', result === 'fixed' ? 'required' : 'none', problems)
  const summary = text(o, 'summary', LIMITS.fixSummary, 'required', problems)
  const evidence = text(o, 'evidence', LIMITS.evidence, 'optional', problems)
  const findings = findingsOf(o.findings, problems)
  if (result === 'declined') {
    if (Array.isArray(o.findings) && o.findings.length === 0) problems.push('a declined fix names each finding it declines, with its reason')
    for (const f of findings) if (f.disposition !== 'declined') problems.push(`findings: ${f.id} is fixed, so the result is fixed, with the head you pushed, or unchanged when you pushed nothing`)
  }
  if (result === 'unchanged') {
    if (Array.isArray(o.findings) && o.findings.length === 0) problems.push('an unchanged fix names each finding, with its reason')
    else if (findings.length > 0 && findings.every(f => f.disposition === 'declined')) problems.push('findings: every finding is declined, so the result is declined')
    for (const f of findings) if (f.id === 'conflict' && f.disposition === 'fixed') problems.push('findings: a conflict is fixed only by a pushed merge, so the result is fixed, with the head you pushed')
  }
  const given = new Set(findings.map(f => f.id))
  for (const id of expectedIds(job)) if (!given.has(id)) problems.push(`finding ${id} has no disposition: fix it, or decline it with a reason`)
  return checked(problems, () => ({ result, head, summary, evidence, findings }))
}

function summaryOfFix(input) {
  const o = record(input) ?? {}
  const n = Array.isArray(o.findings) ? o.findings.length : 0
  const what = o.result === 'fixed' ? `fixed at ${typeof o.head === 'string' ? o.head.slice(0, 7) : 'no head'}` : o.result === 'declined' ? 'declined' : o.result === 'unchanged' ? 'unchanged' : 'no result'
  return `${what}, ${n} finding${n === 1 ? '' : 's'}`
}

export const CONTRACTS = Object.freeze({
  'design-v2': Object.freeze({ check: checkDesign, summary: summaryOfDesign }),
  build: Object.freeze({ check: checkBuild, summary: summaryOfBuild }),
  fix: Object.freeze({ check: checkFix, summary: summaryOfFix }),
})
