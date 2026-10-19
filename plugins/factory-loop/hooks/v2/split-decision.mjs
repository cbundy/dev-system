// The open decision of a not-ready split child (docs/factory-loop/v2/SPEC.md 8.7). A child with
// `ready: false` carries an open owner decision; the loop claims it at once and parks it on that
// decision (row S7 in table.ts), so the owner is asked and the child is never a silent issue.
//
// - childDecisionOf checks the child's optional `decision` object { question, context?, options?,
//   recommendation? } with the rules of a question answer (question.mjs) and gives the rendered
//   question. A ready child takes none. A not-ready child with none (an answer from before this
//   existed) gets decisionFallback.
// - decisionFallback: the text of the body's `## Open decisions` section, at most 2 000
//   characters, else a fixed sentence naming the parent split.
//
// ES2023 alone, nothing of Node or the engine: contracts-work.mjs and the planner import it.

import { QUESTION_FIELDS, checkQuestionParts, renderQuestion } from './question.mjs'

const DECISION_QUESTION_MAX = 2000

function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
}

// openDecisionsOf: the text under the body's `## Open decisions` heading, up to the next heading
// (fenced code kept as written); null when there is none, or it says "none".
function openDecisionsOf(body) {
  const lines = String(body).split(/\r?\n/)
  const at = lines.findIndex(l => /^#{1,6}[ \t]+open decisions[ \t]*$/i.test(l))
  if (at < 0) return null
  const out = []
  let fence = false
  for (const line of lines.slice(at + 1)) {
    if (/^[ \t]*(```|~~~)/.test(line)) fence = !fence
    else if (!fence && /^#{1,6}[ \t]/.test(line)) break
    out.push(line)
  }
  const t = out.join('\n').trim()
  return t === '' || /^[-*\s]*none\b[\s.]*$/i.test(t) ? null : t
}

// decisionFallback: the question of a not-ready child whose answer gave no `decision`.
export function decisionFallback(body, parent) {
  const open = openDecisionsOf(body)
  if (open !== null) return open.length > DECISION_QUESTION_MAX ? `${open.slice(0, DECISION_QUESTION_MAX - 3)}...` : open
  return `This issue was split from #${parent} and carries an open owner decision. The split did not word it: read the issue, answer in a comment, then resume it.`
}

// childDecisionOf: the rendered question of a child's `decision`, or null for a ready child. Every
// problem goes on `problems`, named under `where` (for example "children[1] (b)."); `ready` and
// `body` are the child's, `parent` the issue being split.
export function childDecisionOf(c, where, ready, body, parent, problems) {
  const given = c.decision !== undefined && c.decision !== null
  if (ready === true) {
    if (given) problems.push(`${where}decision must be absent or null on a child that is ready: only a child with ready false carries an open owner decision`)
    return null
  }
  if (!given) return body === null ? null : decisionFallback(body, parent)
  const d = record(c.decision)
  if (d === null) {
    problems.push(`${where}decision must be an object { question, context, options, recommendation }`)
    return null
  }
  for (const k of Object.keys(d)) if (k !== 'question' && !QUESTION_FIELDS.includes(k)) problems.push(`${where}decision.${k} is not a field of a decision (only question, ${QUESTION_FIELDS.join(', ')})`)
  let question = null
  if (typeof d.question !== 'string' || d.question.trim() === '') problems.push(`${where}decision.question is required: the decision as one sentence`)
  else {
    question = d.question.trim()
    if (question.length > DECISION_QUESTION_MAX) problems.push(`${where}decision.question is ${question.length} characters; at most ${DECISION_QUESTION_MAX}`)
  }
  const before = problems.length
  const parts = checkQuestionParts(d, question, problems)
  for (let i = before; i < problems.length; i++) problems[i] = `${where}decision.${problems[i]}`
  if (question === null || problems.length > before) return null
  return renderQuestion({ question, ...parts })
}

