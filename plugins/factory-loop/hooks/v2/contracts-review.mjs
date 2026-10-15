// The reviewer's answer (docs/factory-loop/v2/SPEC.md 8.2): `review`, a verdict, the findings, a
// summary and a bump, and no other field:
//
//   { "verdict": "approve | changes",
//     "findings": [{ "id": "r<round>-<k>", "severity": "error | warning | info",
//                    "file": "a path in the repository, or \"\" for none", "line": 12 | null,
//                    "text": "at most 2 000 characters" }],
//     "summary": "at most 2 000 characters",
//     "bump": "patch | minor | major" }
//
// `changes` needs at least one error finding; `approve` carries none (warnings and infos only).
// Finding ids are r<round>-<k>, k from 1, each once: the round is the job's (data.round, which the
// review step writes at its spawn), so an answer from an earlier round's prompt cannot pass for
// this one. At most 50 findings. The outcome is the answer with its texts trimmed.
//
// Each contract is { check(input, job), summary(input) }: check gives { ok: true, outcome } or
// every problem at once, as contract.mjs's checks do; summary is the answer script's few words on
// what it recorded. contract.mjs imports this module, so the loop and bin/factory-answer check
// alike. ES2023 alone, nothing of Node or the engine. Its types are contracts-review.d.mts's.

export const VERDICTS = Object.freeze(['approve', 'changes'])
export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])
export const BUMPS = Object.freeze(['patch', 'minor', 'major'])
export const FIELDS = Object.freeze(['verdict', 'findings', 'summary', 'bump'])
export const FINDING_FIELDS = Object.freeze(['id', 'severity', 'file', 'line', 'text'])
export const LIMITS = Object.freeze({ findings: 50, text: 2000, summary: 2000, file: 300 })

function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
}

// show: a value as a problem names it, cut short.
function show(v) {
  const text = typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v) ?? v)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

// roundOf: the review round the job names, or null when it names none.
function roundOf(job) {
  const r = record(job?.data)?.round
  return Number.isInteger(r) && r >= 0 ? r : null
}

function finding(raw, i, round, seen, problems) {
  const at = `findings[${i}]`
  const o = record(raw)
  if (o === null) {
    problems.push(`${at} must be an object: { id, severity, file, line, text }`)
    return null
  }
  for (const key of Object.keys(o)) if (!FINDING_FIELDS.includes(key)) problems.push(`${at}.${key} is not a field of a finding (only ${FINDING_FIELDS.join(', ')})`)
  const id = typeof o.id === 'string' ? o.id.trim() : null
  const m = id === null ? null : /^r(\d+)-([1-9]\d*)$/.exec(id)
  if (m === null) problems.push(`${at}.id ${show(o.id)} is not a finding id such as r${round ?? '<round>'}-1`)
  else if (round !== null && Number(m[1]) !== round) problems.push(`${at}.id ${id} is not of this review's round: ids are r${round}-1, r${round}-2, ...`)
  else if (seen.has(id)) problems.push(`${at}.id ${id} is used twice`)
  if (id !== null) seen.add(id)
  const severity = SEVERITIES.find(s => s === o.severity)
  if (severity === undefined) problems.push(`${at}.severity ${show(o.severity)} is not one of ${SEVERITIES.join(', ')}`)
  let file = null
  if (typeof o.file !== 'string') problems.push(`${at}.file must be a path in the repository, or "" when the finding is about no one file`)
  else if (o.file.length > LIMITS.file) problems.push(`${at}.file is ${o.file.length} characters; at most ${LIMITS.file}`)
  else if (/[\r\n]/.test(o.file)) problems.push(`${at}.file must be one line`)
  else file = o.file.trim()
  const line = o.line === null || o.line === undefined ? null : o.line
  if (line !== null && !(Number.isInteger(line) && line > 0)) problems.push(`${at}.line ${show(o.line)} must be a line number, or null`)
  let text = null
  if (typeof o.text !== 'string' || o.text.trim() === '') problems.push(`${at}.text must say what is wrong`)
  else if (o.text.length > LIMITS.text) problems.push(`${at}.text is ${o.text.length} characters; at most ${LIMITS.text}`)
  else text = o.text.trim()
  if (m === null || severity === undefined || file === null || text === null) return null
  return { id, severity, file, line, text }
}

function check(input, job) {
  const o = record(input)
  if (o === null) return { ok: false, problems: ['the answer must be one JSON object: {"verdict", "findings", "summary", "bump"}'] }
  const problems = []
  const round = roundOf(job)
  if (round === null) problems.push('the job names no review round, so no finding id can be checked (a factory loop bug)')
  for (const key of Object.keys(o)) if (!FIELDS.includes(key)) problems.push(`${key} is not a field of a review answer (only ${FIELDS.join(', ')})`)
  const verdict = VERDICTS.find(v => v === o.verdict)
  if (verdict === undefined) problems.push(`verdict ${show(o.verdict)} is not one of ${VERDICTS.join(', ')}`)
  const findings = []
  if (!Array.isArray(o.findings)) problems.push('findings must be a list ([] for none)')
  else if (o.findings.length > LIMITS.findings) problems.push(`findings has ${o.findings.length} entries; at most ${LIMITS.findings}`)
  else {
    const seen = new Set()
    o.findings.forEach((raw, i) => {
      const f = finding(raw, i, round, seen, problems)
      if (f !== null) findings.push(f)
    })
  }
  // counted over the findings as given, so a finding with another problem still counts here
  const errors = Array.isArray(o.findings) ? o.findings.filter(f => record(f)?.severity === 'error').length : 0
  if (verdict === 'changes' && Array.isArray(o.findings) && errors === 0) problems.push('changes needs at least one error finding: the change a fixer must make')
  if (verdict === 'approve' && errors > 0) problems.push(`approve carries no error finding (${errors} given): answer changes, or make them warnings`)
  let summary = null
  if (typeof o.summary !== 'string' || o.summary.trim() === '') problems.push('summary must say what the change does and why this verdict')
  else if (o.summary.length > LIMITS.summary) problems.push(`summary is ${o.summary.length} characters; at most ${LIMITS.summary}`)
  else summary = o.summary.trim()
  const bump = BUMPS.find(b => b === o.bump)
  if (bump === undefined) problems.push(`bump ${show(o.bump)} is not one of ${BUMPS.join(', ')}`)
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, outcome: { verdict, findings, summary, bump } }
}

function summary(input) {
  const o = record(input) ?? {}
  const findings = Array.isArray(o.findings) ? o.findings : []
  const errors = findings.filter(f => record(f)?.severity === 'error').length
  return `${typeof o.verdict === 'string' ? o.verdict : 'no verdict'}, ${findings.length} finding${findings.length === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'})`
}

export const CONTRACTS = Object.freeze({ review: Object.freeze({ check, summary }) })
