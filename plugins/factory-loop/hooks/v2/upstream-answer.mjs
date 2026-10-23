// The shape and authority check of a design `upstream` answer (v2 SPEC 8.7): the designer's work
// needs a change in another repo of the factory's own (a tool, a template, an image), so the loop
// raises an issue there and the design waits for it to close. The loop's one write to another repo.
//   { "kind": "upstream",
//     "upstream": { "repo": "cbundy/dev-system", "request": "bug" | "need", "title": "<one line>", "body": "<text>",
//                   "authority": { "kind": "owner", "source": "note" | "<issue URL>" | "<comment URL>", "quote": "<the owner's words>" }
//                              | { "kind": "bug", "blocking": "<what it blocks, why the workarounds are poor>", "confidence": "<the evidence>" } },
//     "reason": "<one line>", "brief": null }
// An owner authority is the owner telling the designer to raise it: a `note` source is checked here
// against the owner notes of the step (job.data.ownerNotes), so the answer script and the loop's
// re-check refuse alike; an issue or comment URL is read by upstream-check.mjs (bin/factory-answer).
// A bug authority is allowed only for a bug request. contracts-work.mjs calls it.
// ES2023 alone, nothing of Node or the engine.

// The repos a design may raise an issue in: lower case, compared lower case.
export const UPSTREAM_REPOS = Object.freeze(['cbundy/dev-system'])
export const UPSTREAM_REQUESTS = Object.freeze(['bug', 'need'])
export const UPSTREAM_LIMITS = Object.freeze({ title: 120, reason: 500, authorityText: 500, quoteMin: 10, quoteMax: 500 })

const FIELDS = ['repo', 'request', 'title', 'body', 'authority']
const OWNER_FIELDS = ['kind', 'source', 'quote']
const BUG_FIELDS = ['kind', 'blocking', 'confidence']

const record = v => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null)

function show(v) {
  const text = typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v) ?? v)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// normalQuote: a text as the quote match reads it: whitespace collapsed, lower case, curly quotes straight.
export function normalQuote(s) {
  return String(s)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// quoteIn: whether the quote appears in the text, as normalQuote reads both.
export function quoteIn(quote, text) {
  const q = normalQuote(quote)
  return q !== '' && normalQuote(text).includes(q)
}

// sourceKind: 'note', 'issue' (this issue's body) or 'comment' (a comment on this issue) for a source, else null.
export function sourceKind(source, job) {
  if (source === 'note') return 'note'
  if (typeof source !== 'string') return null
  const base = `https://github.com/${escape(String(job.repo))}/issues/${job.issue}`
  if (new RegExp(`^${base}$`, 'i').test(source)) return 'issue'
  return new RegExp(`^${base}#issuecomment-\\d+$`, 'i').test(source) ? 'comment' : null
}

function line(o, key, limit, problems, where) {
  const v = o[key]
  const name = `${where}${key}`
  if (v === undefined || v === null) {
    problems.push(`${name} is required`)
    return null
  }
  if (typeof v !== 'string' || v.trim() === '') {
    problems.push(`${name} must be text, not ${show(v)}`)
    return null
  }
  if (/[\r\n]/.test(v.trim())) problems.push(`${name} must be one line`)
  if (v.length > limit) problems.push(`${name} is ${v.length} characters; at most ${limit}`)
  return v.trim()
}

function authorityOf(a, request, job, problems) {
  const o = record(a)
  if (o === null) {
    problems.push('upstream.authority is required: { kind: "owner", source, quote } or { kind: "bug", blocking, confidence }')
    return null
  }
  const where = 'upstream.authority.'
  const lim = UPSTREAM_LIMITS
  if (o.kind === 'owner') {
    for (const key of Object.keys(o)) if (!OWNER_FIELDS.includes(key)) problems.push(`${where}${key} is not a field of an owner authority (only ${OWNER_FIELDS.join(', ')})`)
    const source = typeof o.source === 'string' ? o.source.trim() : o.source
    const kind = sourceKind(source, job)
    if (kind === null) problems.push(`${where}source ${show(o.source)} must be "note", the URL of this issue (https://github.com/${job.repo}/issues/${job.issue}) or a comment URL on it (...#issuecomment-<digits>)`)
    const quote = typeof o.quote === 'string' ? o.quote.trim() : null
    if (quote === null) problems.push(`${where}quote is required: the owner's words saying to raise it upstream`)
    else if (quote.length < lim.quoteMin || quote.length > lim.quoteMax) problems.push(`${where}quote is ${quote.length} characters; ${lim.quoteMin} to ${lim.quoteMax}`)
    else if (kind === 'note') {
      const notes = Array.isArray(job.data?.ownerNotes) ? job.data.ownerNotes.filter(n => typeof n === 'string') : []
      if (!notes.some(n => quoteIn(quote, n))) problems.push(`${where}quote ${show(quote)} is in no owner note of this step: quote the note word for word, or use the URL of the comment or issue that holds it`)
    }
    return kind !== null && quote !== null ? { kind: 'owner', source: kind === 'note' ? 'note' : source, quote } : null
  }
  if (o.kind === 'bug') {
    for (const key of Object.keys(o)) if (!BUG_FIELDS.includes(key)) problems.push(`${where}${key} is not a field of a bug authority (only ${BUG_FIELDS.join(', ')})`)
    if (request !== null && request !== 'bug') problems.push(`${where}kind "bug" is allowed only with request "bug"; a need rests on the owner's word`)
    const blocking = text(o, 'blocking', lim.authorityText, problems, where)
    const confidence = text(o, 'confidence', lim.authorityText, problems, where)
    return blocking !== null && confidence !== null ? { kind: 'bug', blocking, confidence } : null
  }
  problems.push(`${where}kind ${show(o.kind)} is not one of owner, bug`)
  return null
}

function text(o, key, limit, problems, where) {
  const v = o[key]
  if (typeof v !== 'string' || v.trim() === '') {
    problems.push(`${where}${key} is required: text, not ${show(v)}`)
    return null
  }
  if (v.length > limit) problems.push(`${where}${key} is ${v.length} characters; at most ${limit}`)
  return v.trim()
}

// checkUpstream: the upstream object and the reason of an upstream answer, or null when either has a
// problem (each one pushed onto `problems`). job: { repo, issue, data? }; bodyMax: the brief limit.
export function checkUpstream(o, problems, job, bodyMax) {
  const before = problems.length
  const u = record(o.upstream)
  if (u === null) {
    problems.push('upstream is required for an upstream answer: { repo, request, title, body, authority }')
    return null
  }
  for (const key of Object.keys(u)) if (!FIELDS.includes(key)) problems.push(`upstream.${key} is not a field of an upstream request (only ${FIELDS.join(', ')})`)
  const repo = typeof u.repo === 'string' ? u.repo.trim().toLowerCase() : null
  if (repo === null || !UPSTREAM_REPOS.includes(repo)) problems.push(`upstream.repo ${show(u.repo)} is not one of ${UPSTREAM_REPOS.join(', ')}`)
  else if (repo === String(job.repo).toLowerCase()) problems.push(`upstream.repo ${repo} is this issue's own repo; an upstream request goes to another one`)
  const request = UPSTREAM_REQUESTS.find(r => r === u.request) ?? null
  if (request === null) problems.push(`upstream.request ${show(u.request)} is not one of ${UPSTREAM_REQUESTS.join(', ')}`)
  const title = line(u, 'title', UPSTREAM_LIMITS.title, problems, 'upstream.')
  let body = null
  if (typeof u.body !== 'string' || u.body.trim() === '') problems.push(`upstream.body is required: text, not ${show(u.body)}`)
  else if (u.body.length > bodyMax) problems.push(`upstream.body is ${u.body.length} characters; at most ${bodyMax}`)
  else body = u.body.trim()
  const authority = authorityOf(u.authority, request, job, problems)
  const reason = line(o, 'reason', UPSTREAM_LIMITS.reason, problems, '')
  if (problems.length > before) return null
  return { upstream: { repo, request, title, body, authority }, reason }
}
