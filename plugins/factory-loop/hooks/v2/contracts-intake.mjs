// The intake reader's answer (epic #995, issue #1151): one JSON object, no other channel.
//
//   { "area": "one of config.intakeAreas",
//     "needs_owner": true | false,
//     "reason": "one line, 1 to 200 characters; required when needs_owner is true",
//     "touches": ["top-level names of the repo the work is expected to change", "at most 20"] }
//
// The reader has no answer script (it has the Read tool alone), so this is not one of V2_CONTRACTS:
// intake.ts parses the agent's final message and checkIntake judges the object field by field. A bad
// field is dropped, never repaired: the rest still counts, and the result names what was dropped. The
// result is `failed` when the input is no object or no field survives, `dropped` when a field (or an
// unknown key) was dropped, `ok` otherwise. ES2023 alone, nothing of Node or the engine. Its types are
// contracts-intake.d.mts's.

export const FIELDS = Object.freeze(['area', 'needs_owner', 'reason', 'touches'])
export const LIMITS = Object.freeze({ reason: 200, touches: 20 })
const NAME = /^[A-Za-z0-9._-]+$/

function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
}

// show: a value as a problem names it, cut short.
function show(v) {
  const text = typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v) ?? v)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

// reasonOf: the trimmed one-line reason, or why not.
function reasonOf(v) {
  if (typeof v !== 'string') return { problem: `reason must be text, not ${show(v)}` }
  const reason = v.trim()
  if (reason === '') return { problem: 'reason must not be empty' }
  if (/[\r\n]/.test(reason)) return { problem: 'reason must be one line' }
  if (reason.length > LIMITS.reason) return { problem: `reason is ${reason.length} characters; at most ${LIMITS.reason}` }
  return { value: reason }
}

// touchesOf: the list of names, or why not. One bad entry spoils the whole list.
function touchesOf(v) {
  if (!Array.isArray(v)) return { problem: `touches must be a list of names, not ${show(v)}` }
  if (v.length > LIMITS.touches) return { problem: `touches has ${v.length} entries; at most ${LIMITS.touches}` }
  for (const [i, t] of v.entries()) {
    if (typeof t !== 'string' || !NAME.test(t) || t === '.' || t === '..') return { problem: `touches entry ${show(t)} is not a top-level name` }
    if (v.indexOf(t) !== i) return { problem: `touches entry ${show(t)} is listed twice` }
  }
  return { value: [...v] }
}

// checkIntake: the answer judged against the areas the repo configures.
export function checkIntake(input, areas) {
  const o = record(input)
  if (o === null) {
    return { kind: 'failed', area: null, needsOwner: null, reason: null, touches: null, dropped: [], problems: ['the answer must be one JSON object: {"area", "needs_owner", "reason", "touches"}'] }
  }
  const dropped = []
  const problems = []
  const drop = (field, why) => {
    dropped.push(field)
    problems.push(`${field} dropped: ${why}`)
  }
  for (const key of Object.keys(o)) if (!FIELDS.includes(key)) drop(key, 'not a field of the answer')

  let area = null
  if (!('area' in o)) drop('area', 'absent')
  else if (typeof o.area === 'string' && areas.includes(o.area)) area = o.area
  else drop('area', `${show(o.area)} is not one of ${areas.join(', ')}`)

  let needsOwner = null
  if (!('needs_owner' in o)) drop('needs_owner', 'absent')
  else if (typeof o.needs_owner === 'boolean') needsOwner = o.needs_owner
  else drop('needs_owner', `must be true or false, not ${show(o.needs_owner)}`)

  let reason = null
  if (!('reason' in o)) drop('reason', 'absent')
  else {
    const r = reasonOf(o.reason)
    if (r.value === undefined) drop('reason', r.problem)
    else reason = r.value
  }
  // a question for the owner without its reason is no usable answer: both go
  if (needsOwner === true && reason === null) {
    needsOwner = null
    if (!dropped.includes('needs_owner')) drop('needs_owner', 'true needs a valid reason')
    if (!dropped.includes('reason')) drop('reason', 'needs_owner true needs a valid reason')
  }

  let touches = null
  if (!('touches' in o)) drop('touches', 'absent')
  else {
    const t = touchesOf(o.touches)
    if (t.value === undefined) drop('touches', t.problem)
    else touches = t.value
  }

  const kept = area !== null || needsOwner !== null || reason !== null || touches !== null
  const kind = !kept ? 'failed' : dropped.length > 0 ? 'dropped' : 'ok'
  return { kind, area, needsOwner, reason, touches, dropped, problems }
}
