// The agents' answer contract (SPEC 7.3a): what an adjudicator's verdict, a designer's result and
// an implementer's or fixer's handoff must hold, checked field by field with every problem named
// at once, and the files of the answer script (#561). One plain-JS module with one reader of
// each answer: the loop imports it (the TypeScript hooks the engine runs: replies.ts,
// agent-tools.ts, act-agents.ts), and so does bin/factory-answer under plain node, so the
// registered tools, the script and the loop's own re-check of the script's file cannot drift.
// tests/answer-contract.test.ts (the loop) and tests/factory-loop-answer.test.js at the repo
// root (the script, run for real) hold both ends to one table of cases (tests/answer-cases.mjs).
// It uses ES2023 alone, nothing of Node or the engine. Its types are contract.d.mts's.

export const VERDICTS = Object.freeze(['CORRECT', 'WRONG', 'NIT', 'ENV', 'DUP'])
export const BUMPS = Object.freeze(['patch', 'minor', 'major'])
export const FLAGS = Object.freeze(['image', 'template', 'restart', 'run-it'])

// The ACTIONs that answer each purpose. A gate or a test-weakening review never merges or
// holds (types.ts, D-05); a merge review never drives the run's gate. escalate stays open to
// the merge review: its definition offers it, and plan holds on it as on `hold` (rule M5a).
export const ACTIONS_FOR = Object.freeze({
  gate: Object.freeze(['approve', 'fix', 'skip', 'fixer', 'escalate']),
  weakening: Object.freeze(['approve', 'fix', 'skip', 'fixer', 'escalate']),
  merge: Object.freeze(['merge', 'hold', 'fixer', 'escalate']),
})

// A finding id as no-mistakes names them (review-1).
export const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/

// The shape of each handoff id, as a RESULT line or a structured answer gives it.
export const HANDOFF_SHAPES = Object.freeze({ run: /^[A-Za-z0-9_-]+$/, sha: /^[0-9a-f]{7,40}$/i, branch: /^[A-Za-z0-9._/-]+$/ })

// A free-text value past this is refused: an answer points, it does not carry documents.
export const TEXT_MAX = 4000

// The contract each agent answers with; each answer tool is named after its contract.
export const CONTRACT_OF = Object.freeze({ adjudicator: 'verdict', designer: 'design', implementer: 'handoff', fixer: 'handoff' })
const CONTRACTS = Object.freeze(['verdict', 'design', 'handoff'])
const PURPOSES = Object.freeze(['gate', 'weakening', 'merge'])

// isBriefUrl: a brief comment's URL on an issue of this repo (on that issue, when given).
export function isBriefUrl(url, repo, issue = null) {
  const m = url.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)#issuecomment-\d+$/)
  if (m === null || (m[1] ?? '').toLowerCase() !== repo.toLowerCase()) return false
  return issue === null || Number(m[2]) === issue
}

// gatedWithoutRun: a handoff that says gated but names no run, as an agent that gave up and
// committed nothing may. Read as done, no rule would act on it (D4b retries only a delegate that
// failed, D5 only one not gated), so its issue would stall: it is unreadable instead.
export function gatedWithoutRun(fields) {
  return fields.gated && fields.run === null
}

// One SHA may be the other's short form.
function sameSha(a, b) {
  return a.startsWith(b) || b.startsWith(a)
}

// handoffOutcome: what a handoff's fields mean, from any channel: not gated when it says so, or
// when the run's head is not the agent's commit (implement-issue section 8: never rationalise a
// mismatch away); newBranch is the branch it reports when that is not the one the spawn named.
export function handoffOutcome(fields, namedBranch) {
  const mismatch = fields.head !== null && fields.commit !== null && !sameSha(fields.head, fields.commit)
  const named = namedBranch === null || namedBranch === '' ? null : namedBranch
  return {
    kind: 'handoff',
    notGated: !fields.gated || mismatch,
    run: fields.run,
    head: fields.head,
    newBranch: fields.branch !== null && fields.branch !== named ? fields.branch : null,
  }
}

// --- the checks: an input in, the outcome its text lines would give or every problem out ---------

function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
}

function checked(problems, outcome) {
  return problems.length > 0 ? { ok: false, problems } : { ok: true, outcome: outcome() }
}

// strays: a field the contract does not have is named, never ignored: it is a misunderstanding.
function strays(o, allowed, at, problems) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`${at}${k} is not a field here`)
}

// text: a free-text field as one trimmed line (the text contract's lines are one line each);
// null when absent or null. Not text, empty where required, or over TEXT_MAX is a problem.
function text(v, name, problems, required) {
  if (v === undefined || v === null) {
    if (required) problems.push(`${name} is required`)
    return null
  }
  if (typeof v !== 'string') {
    problems.push(`${name} must be text`)
    return null
  }
  const t = v.replace(/\s+/g, ' ').trim()
  if (t === '' && required) problems.push(`${name} must not be empty`)
  else if (t.length > TEXT_MAX) problems.push(`${name} is over ${TEXT_MAX} characters`)
  else if (t !== '') return t
  return null
}

// clip: a value quoted in a problem as the model wrote it, cut to a readable length.
function clip(v) {
  const s = typeof v === 'string' ? JSON.stringify(v.length > 120 ? `${v.slice(0, 117)}...` : v) : (JSON.stringify(v) ?? String(v))
  return s.length > 124 ? `${s.slice(0, 121)}...` : s
}

// --- the adjudicator (SPEC 7.3) --------------------------------------------------------------

// The fields each action takes beside its type, as its ACTION line's grammar has them.
const ACTION_FIELDS = Object.freeze({
  approve: ['reason'],
  fix: ['findings', 'instructions', 'addFinding'],
  skip: [],
  fixer: ['instructions'],
  escalate: ['why'],
  merge: [],
  hold: ['reason'],
})
const REPORT_FIELDS = Object.freeze(['summary', 'bump', 'flags'])

// verdictLine: a finding as the verdict line the text contract gives, naming its id (once, when
// the reason already opens with it), for the verdict event and the rules that read the lines
// (P2a reads `ENV:`).
function verdictLine(verdict, id, reason) {
  const named = reason.startsWith(id) && !/[\w.-]/.test(reason.charAt(id.length))
  return named ? `${verdict}: ${reason}` : `${verdict}: ${id}: ${reason}`
}

// checkVerdict: an adjudicator's answer of this purpose.
export function checkVerdict(input, purpose) {
  const problems = []
  const o = record(input) ?? {}
  strays(o, ['findings', 'action', ...REPORT_FIELDS], '', problems)
  const judged = new Map()
  const verdicts = []
  const findings = Array.isArray(o.findings) ? o.findings : null
  if (findings === null) problems.push('findings must be a list of { id, verdict, reason } ([] when there is nothing to report)')
  for (const [i, raw] of (findings ?? []).entries()) {
    const at = `findings[${i}]`
    const f = record(raw)
    if (f === null) {
      problems.push(`${at} must be an object { id, verdict, reason }`)
      continue
    }
    strays(f, ['id', 'verdict', 'reason'], `${at}.`, problems)
    const id = typeof f.id === 'string' ? f.id.trim() : ''
    const verdict = VERDICTS.find(v => v === f.verdict)
    const reason = text(f.reason, `${at}.reason`, problems, true)
    if (verdict === undefined) problems.push(`${at}.verdict must be one of ${VERDICTS.join(', ')}`)
    if (!FINDING_ID.test(id)) problems.push(`${at}.id ${clip(f.id)} is not a finding id such as review-1`)
    else if (judged.has(id)) problems.push(`${at}.id ${id} is judged twice`)
    else if (verdict !== undefined) {
      judged.set(id, verdict)
      if (reason !== null) verdicts.push(verdictLine(verdict, id, reason))
    }
  }
  const action = actionOf(o.action, purpose, judged, problems)
  let report = null
  if (purpose === 'merge') report = reportOf(o, problems)
  else {
    const extra = REPORT_FIELDS.filter(k => o[k] !== undefined)
    if (extra.length > 0) problems.push(`${extra.join(', ')} answer a merge review only, and this is a ${purpose} review`)
  }
  if (action === null || problems.length > 0) return { ok: false, problems: problems.length > 0 ? problems : ['action is required'] }
  return { ok: true, outcome: { kind: 'adjudicator', verdicts, action, report } }
}

// actionOf: the one action, of a type the purpose allows, with the fields its type takes (the
// same as its ACTION line: a fix needs findings, instructions or a finding to add).
function actionOf(raw, purpose, judged, problems) {
  const allowed = ACTIONS_FOR[purpose]
  const a = record(raw)
  const type = allowed.find(t => t === a?.type)
  if (a === null || type === undefined) {
    problems.push(`action must be { type, ... } with type one of ${allowed.join(', ')}: a ${purpose} review takes no other`)
    return null
  }
  const fields = ACTION_FIELDS[type]
  for (const k of Object.keys(a)) {
    if (k !== 'type' && !fields.includes(k)) problems.push(`action ${type} takes ${fields.length === 0 ? 'no field but type' : fields.join(', ')}, not ${k}`)
  }
  switch (type) {
    case 'skip':
    case 'merge':
      return { type }
    case 'approve':
      return { type, reason: text(a.reason, 'action.reason', problems, false) }
    case 'fixer': {
      const instructions = text(a.instructions, 'action.instructions', problems, true)
      return instructions === null ? null : { type, instructions }
    }
    case 'escalate': {
      const why = text(a.why, 'action.why', problems, true)
      return why === null ? null : { type, why }
    }
    case 'hold': {
      const reason = text(a.reason, 'action.reason', problems, true)
      return reason === null ? null : { type, reason }
    }
    case 'fix': {
      const findings = fixIds(a.findings, judged, problems)
      const instructions = text(a.instructions, 'action.instructions', problems, false)
      let addFinding = null
      if (a.addFinding !== undefined && a.addFinding !== null) {
        if (record(a.addFinding) === null) problems.push('action.addFinding must be an object: the finding as no-mistakes takes it')
        else addFinding = JSON.stringify(a.addFinding)
      }
      if (findings === null && instructions === null && addFinding === null) problems.push('action fix needs findings, instructions or addFinding')
      return { type, findings, instructions, addFinding }
    }
  }
  return null
}

// The id prefix the contract asks for a gap the reviewer missed, which the gate does not know.
const MISSED_ID = 'missed-'

// fixIds: a fix's finding ids, each one judged above as CORRECT or ENV: a fix for a WRONG, NIT or
// DUP finding would make the pipeline rewrite sound code (adjudicator.md). The loop has no view of
// the gate's own list, so an id the agent made up for a missed gap (MISSED_ID) is the one it can
// tell is not the gate's: respond would name a finding the gate does not have.
function fixIds(raw, judged, problems) {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(id => typeof id === 'string')) {
    problems.push('action.findings must be a list of the ids of findings above')
    return null
  }
  const ids = [...new Set(raw.map(id => id.trim()))]
  for (const id of ids) {
    const verdict = judged.get(id)
    if (!FINDING_ID.test(id)) problems.push(`action.findings: ${clip(id)} is not a finding id`)
    else if (id.startsWith(MISSED_ID)) problems.push(`action.findings: ${id} is a gap the reviewer missed, which the gate does not know: put it in action.addFinding`)
    else if (verdict === undefined) problems.push(`action.findings: ${id} is not one of the findings above`)
    else if (verdict !== 'CORRECT' && verdict !== 'ENV') problems.push(`action.findings: ${id} is judged ${verdict}, and a fix is for CORRECT or ENV findings`)
  }
  return ids.join(',')
}

// reportOf: the merge review's summary, bump and flags (rule M4).
function reportOf(o, problems) {
  const summary = text(o.summary, 'summary', problems, true)
  const b = record(o.bump)
  const level = BUMPS.find(x => x === b?.level)
  let bumpReason = null
  if (b === null) problems.push('bump is required: { level: patch|minor|major, reason }')
  else {
    strays(b, ['level', 'reason'], 'bump.', problems)
    if (level === undefined) problems.push(`bump.level must be one of ${BUMPS.join(', ')}`)
    bumpReason = text(b.reason, 'bump.reason', problems, true)
  }
  const flags = []
  if (!Array.isArray(o.flags)) problems.push(`flags is required: a list of ${FLAGS.join(', ')} ([] for none)`)
  else {
    for (const raw of o.flags) {
      const flag = FLAGS.find(f => f === raw)
      if (flag === undefined) problems.push(`flags: ${clip(raw)} is not one of ${FLAGS.join(', ')}`)
      else if (!flags.includes(flag)) flags.push(flag)
    }
  }
  return summary === null || level === undefined || bumpReason === null ? null : { summary, bump: level, bumpReason, flags }
}

// --- the designer (SPEC 7.2) ------------------------------------------------------------------

// checkDesign: a designer's answer for this issue. A result that leaves the loop nothing to do
// (no brief, no created issues, no decision pending) is a forgotten field.
export function checkDesign(input, repo, issue) {
  const problems = []
  const o = record(input) ?? {}
  strays(o, ['brief', 'created', 'pendingDecision'], '', problems)
  const where = `${repo} issue ${issue ?? '<N>'}`
  let brief = null
  if (o.brief === undefined) problems.push(`brief is required: the brief comment's URL on ${where}, or null`)
  else if (o.brief !== null) {
    const url = typeof o.brief === 'string' ? o.brief.trim() : ''
    if (isBriefUrl(url, repo, issue)) brief = url
    else problems.push(`brief ${clip(o.brief)} is not a comment URL on ${where} (https://github.com/${repo}/issues/${issue ?? '<N>'}#issuecomment-<id>)`)
  }
  const created = Array.isArray(o.created) && o.created.every(n => Number.isInteger(n) && n > 0) ? [...new Set(o.created)] : null
  if (created === null) problems.push('created must be a list of the issue numbers you created ([] for none)')
  if (typeof o.pendingDecision !== 'boolean') problems.push('pendingDecision must be true or false')
  const pending = o.pendingDecision === true
  if (problems.length === 0 && brief === null && created?.length === 0 && !pending) {
    problems.push('with no brief, no created issues and no decision pending, the loop has nothing to hand on: give the brief URL')
  }
  return checked(problems, () => ({ kind: 'designer', brief, created: created ?? [], pendingDecision: pending }))
}

// --- implementer and fixer handoffs ---------------------------------------------------------

// checkHandoff: a handoff, read as its RESULT line is (handoffOutcome): not gated when it says so
// or its head is not its commit; a branch other than the one the spawn named is a new one; gated
// with no run is refused (gatedWithoutRun).
export function checkHandoff(input, namedBranch) {
  const problems = []
  const o = record(input) ?? {}
  strays(o, ['run', 'head', 'commit', 'gated', 'branch', 'pr'], '', problems)
  const id = (key, shape, what) => {
    const v = o[key]
    if (v === undefined) problems.push(`${key} is required (null for none)`)
    else if (v !== null) {
      if (typeof v === 'string' && shape.test(v.trim())) return v.trim()
      problems.push(`${key} ${clip(v)} is not ${what}, or null`)
    }
    return null
  }
  const run = id('run', HANDOFF_SHAPES.run, 'a pipeline run id')
  const head = id('head', HANDOFF_SHAPES.sha, 'a commit SHA of 7 to 40 hex digits')
  const commit = id('commit', HANDOFF_SHAPES.sha, 'a commit SHA of 7 to 40 hex digits')
  const branch = id('branch', HANDOFF_SHAPES.branch, 'a branch name')
  if (typeof o.gated !== 'boolean') problems.push('gated must be true or false')
  else if (o.run === null && gatedWithoutRun({ run, gated: o.gated })) problems.push('gated is true with run null, and with no pipeline run nothing is gated: give the run, or gated false')
  if (o.pr === undefined) problems.push('pr is required (null for none)')
  else if (o.pr !== null && !(Number.isInteger(o.pr) && o.pr > 0)) problems.push(`pr ${clip(o.pr)} is not a PR number, or null`)
  const pr = typeof o.pr === 'number' ? o.pr : null
  const gated = o.gated === true
  return checked(problems, () => handoffOutcome({ run, head: head?.toLowerCase() ?? null, commit: commit?.toLowerCase() ?? null, gated, branch, pr }, namedBranch))
}

// checkAnswer: an answer under its job: the contract, and what checking it needs (the review's
// purpose, the repo and issue a brief must be on, the branch a fixer was sent to). Every channel
// checks through this one call: the tool's hook and the loop's re-check with the job the loop
// knows from its ledger, the script with the job file the loop wrote at the spawn.
export function checkAnswer(job, input) {
  if (job.contract === 'verdict') {
    if (job.purpose === null) return { ok: false, problems: ['the factory loop cannot tell which review this is'] }
    return checkVerdict(input, job.purpose)
  }
  if (job.contract === 'design') return checkDesign(input, job.repo, job.issue)
  return checkHandoff(input, job.branch)
}

// --- the answer script's files (#561) ------------------------------------------------------------

// An agent's answer file, at a path the loop names in its prompt, unique to the ledger entry and
// attempt, in <loop dir>/answers/; beside it the job file the loop writes before the spawn. The
// script writes the answer file alone, and only where a job file stands.
export const ANSWER_SUFFIX = '.answer.json'
export const JOB_SUFFIX = '.job.json'
export const ANSWER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.answer\.json$/
// The loop dir's own name: <owner>__<repo> (register.ts runtime).
export const LOOP_DIR_NAME = /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/
const FILE_VERSION = 1

// jobPathOf: the job file beside an answer file, or null for a path that names no answer file.
export function jobPathOf(answerPath) {
  const slash = answerPath.lastIndexOf('/')
  const name = answerPath.slice(slash + 1)
  return ANSWER_NAME.test(name) ? `${answerPath.slice(0, slash + 1)}${name.slice(0, -ANSWER_SUFFIX.length)}${JOB_SUFFIX}` : null
}

// jobText: the job file's body.
export function jobText(job) {
  return `${JSON.stringify({ v: FILE_VERSION, contract: job.contract, purpose: job.purpose, repo: job.repo, issue: job.issue, branch: job.branch }, null, 2)}\n`
}

// parseJob: a job file's body as a job, or why it is none.
export function parseJob(body) {
  let v
  try {
    v = JSON.parse(body)
  } catch {
    return 'the job file is not JSON'
  }
  const o = record(v)
  if (o === null || o.v !== FILE_VERSION) return `the job file is not version ${FILE_VERSION} of the factory loop's job files`
  const contract = CONTRACTS.find(c => c === o.contract)
  const purpose = o.purpose === null ? null : (PURPOSES.find(p => p === o.purpose) ?? undefined)
  const issue = o.issue === null || (Number.isInteger(o.issue) && o.issue > 0) ? o.issue : undefined
  const branch = o.branch === null || (typeof o.branch === 'string' && o.branch !== '') ? o.branch : undefined
  if (contract === undefined || purpose === undefined || typeof o.repo !== 'string' || issue === undefined || branch === undefined) return 'the job file is not in the shape the factory loop writes'
  return { contract, purpose, repo: o.repo, issue, branch }
}

// answerText: the answer file's body for an input its job's contract takes, or the problems
// that keep it out. The input is kept as the agent gave it: the loop checks it again on reading.
export function answerText(job, input) {
  const check = checkAnswer(job, input)
  if (!check.ok) return check
  return { ok: true, outcome: `${JSON.stringify({ v: FILE_VERSION, contract: job.contract, answer: input }, null, 2)}\n` }
}

// parseAnswer: an answer file's body: the answer it carries, for this contract, still to be
// checked; or why it carries none.
export function parseAnswer(body, contract) {
  let v
  try {
    v = JSON.parse(body)
  } catch {
    return { ok: false, problems: ['the answer file is not JSON'] }
  }
  const o = record(v)
  if (o === null || o.v !== FILE_VERSION || !('answer' in o)) return { ok: false, problems: ['the answer file is not in the shape the answer script writes'] }
  if (o.contract !== contract) return { ok: false, problems: [`the answer file holds a ${clip(o.contract)} answer, and this agent answers with ${contract}`] }
  return { ok: true, outcome: o.answer }
}
