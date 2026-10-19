// The shape check of a design `done` answer (v2 SPEC 8.7): the issue's work is already merged, so
// the designer gives the evidence and a one-line reason and the loop closes the issue.
//   { "kind": "done", "evidence": { "pr": N | null, "commit": "<7-40 hex>" | null, "runIt": "<url>" | null },
//     "reason": "<one line>", "brief": null }
// At least one of pr and commit is required. A runIt, when given, is a comment URL on this issue.
// contracts-work.mjs calls it; the GitHub side (done-check.mjs) and the loop's own re-check
// (steps-work.ts) read the evidence it gives. ES2023 alone, nothing of Node or the engine.

export const DONE_REASON_MAX = 500
const SHA = /^[0-9a-f]{7,40}$/i
const EVIDENCE_FIELDS = ['pr', 'commit', 'runIt']

const record = v => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null)

function show(v) {
  const text = typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v) ?? v)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// checkDone: the evidence and the reason of a done answer, or null when either has a problem (each
// one pushed onto `problems`). job: { repo, issue }.
export function checkDone(o, problems, job) {
  let evidence = null
  const e = record(o.evidence)
  if (e === null) {
    problems.push('evidence is required for done: { pr, commit, runIt }, at least one of pr and commit')
  } else {
    for (const key of Object.keys(e)) if (!EVIDENCE_FIELDS.includes(key)) problems.push(`evidence.${key} is not a field of the evidence (only ${EVIDENCE_FIELDS.join(', ')})`)
    const before = problems.length
    let pr = null
    if (e.pr !== undefined && e.pr !== null) {
      if (typeof e.pr !== 'number' || !Number.isInteger(e.pr) || e.pr < 1) problems.push(`evidence.pr ${show(e.pr)} must be a whole number of at least 1, or null`)
      else pr = e.pr
    }
    let commit = null
    if (e.commit !== undefined && e.commit !== null) {
      if (typeof e.commit !== 'string' || !SHA.test(e.commit.trim())) problems.push(`evidence.commit ${show(e.commit)} must be 7 to 40 hex characters (a commit sha), or null`)
      else commit = e.commit.trim().toLowerCase()
    }
    if (pr === null && commit === null && problems.length === before) problems.push('evidence needs a merged pr or a commit on the default branch (at least one)')
    let runIt = null
    if (e.runIt !== undefined && e.runIt !== null) {
      const url = typeof e.runIt === 'string' ? e.runIt.trim() : ''
      const own = new RegExp(`^https://github\\.com/${escape(String(job.repo))}/issues/${job.issue}#issuecomment-\\d+$`, 'i')
      if (!own.test(url)) problems.push(`evidence.runIt ${show(e.runIt)} must be a comment URL on this issue: https://github.com/${job.repo}/issues/${job.issue}#issuecomment-<digits>, or null`)
      else runIt = url
    }
    if (problems.length === before) evidence = { pr, commit, runIt }
  }
  let reason = null
  const r = o.reason
  if (r === undefined || r === null) problems.push('reason is required')
  else if (typeof r !== 'string' || r.trim() === '') problems.push(`reason must be text, not ${show(r)}`)
  else if (/[\r\n]/.test(r.trim())) problems.push('reason must be one line')
  else if (r.length > DONE_REASON_MAX) problems.push(`reason is ${r.length} characters; at most ${DONE_REASON_MAX}`)
  else reason = r.trim()
  return evidence !== null && reason !== null ? { evidence, reason } : null
}
