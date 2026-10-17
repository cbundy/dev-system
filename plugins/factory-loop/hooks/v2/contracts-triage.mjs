// The triage agent's answer (docs/factory-loop/v2/SPEC.md 5.2): `triage`, one choice of the menu
// (retry, fix, redesign, park, drop), its reason, and the instructions or the question the choice
// needs, each within its limit, and no other field:
//
//   { "choice": "retry | fix | redesign | park | drop",
//     "reason": "one line, at most 500 characters",
//     "instructions": "required for retry, fix and redesign; at most 4 000 characters",
//     "question": "required for park: the one-sentence decision; at most 2 000 characters",
//     "context": "park only, optional: a few sentences",
//     "options": "park only, optional: 2 to 6 of { key: A to F, title, detail? }",
//     "recommendation": "park only, optional: { key, reason }" }
//
// The optional fields are checked as the designer's are (question.mjs), and the question once
// rendered with them must fit its 2 000 characters; the outcome carries them only when given.
//
// A fix that is not valid in the record's state is still a valid answer: the table parks the issue
// with the triage's reason (row X4). The outcome is { choice, reason, instructions, question },
// absent texts null.
//
// Each contract is { check(input, job), summary(input) }: check gives { ok: true, outcome } or
// every problem at once, as contract.mjs's checks do; summary is the answer script's few words on
// what it recorded. contract.mjs imports this module, so the loop and bin/factory-answer check
// alike. ES2023 alone, nothing of Node or the engine. Its types are contracts-triage.d.mts's.

import { QUESTION_FIELDS, checkQuestionParts } from './question.mjs'

export const CHOICES = Object.freeze(['retry', 'fix', 'redesign', 'park', 'drop'])
export const FIELDS = Object.freeze(['choice', 'reason', 'instructions', 'question', ...QUESTION_FIELDS])
export const LIMITS = Object.freeze({ reason: 500, instructions: 4000, question: 2000 })
// the text each choice needs beside its reason
const NEEDS = Object.freeze({ retry: 'instructions', fix: 'instructions', redesign: 'instructions', park: 'question', drop: null })

function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
}

// show: a value as a problem names it, cut short.
function show(v) {
  const text = typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v) ?? v)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

function check(input) {
  const o = record(input)
  if (o === null) return { ok: false, problems: ['the answer must be one JSON object: {"choice", "reason", and "instructions" or "question"}'] }
  const problems = []
  for (const key of Object.keys(o)) if (!FIELDS.includes(key)) problems.push(`${key} is not a field of a triage answer (only ${FIELDS.join(', ')})`)
  const choice = CHOICES.find(c => c === o.choice)
  if (choice === undefined) problems.push(`choice ${show(o.choice)} is not one of ${CHOICES.join(', ')}`)
  const need = choice === undefined ? null : NEEDS[choice]
  const text = (key, required) => {
    const v = o[key]
    if (v === undefined || v === null) {
      if (required) problems.push(`${key} is required for the choice ${choice}`)
      return null
    }
    if (typeof v !== 'string' || v.trim() === '') {
      problems.push(`${key} must be text, not ${show(v)}`)
      return null
    }
    if (v.length > LIMITS[key]) problems.push(`${key} is ${v.length} characters; at most ${LIMITS[key]}`)
    return v.trim()
  }
  const reason = text('reason', true)
  if (reason !== null && /[\r\n]/.test(reason)) problems.push('reason must be one line')
  const instructions = text('instructions', need === 'instructions')
  const question = text('question', need === 'question')
  const parts = {}
  if (choice === 'park') {
    const p = checkQuestionParts(o, question, problems)
    if (p.context !== null) parts.context = p.context
    if (p.options !== null) parts.options = p.options
    if (p.recommendation !== null) parts.recommendation = p.recommendation
  } else for (const k of QUESTION_FIELDS) if (o[k] !== undefined && o[k] !== null) problems.push(`${k} must be absent or null unless the choice is park`)
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, outcome: { choice, reason, instructions, question, ...parts } }
}

function summary(input) {
  const o = record(input) ?? {}
  const reason = typeof o.reason === 'string' ? o.reason.trim() : ''
  return `${typeof o.choice === 'string' ? o.choice : 'no choice'}: ${reason.length > 80 ? `${reason.slice(0, 77)}...` : reason}`
}

export const CONTRACTS = Object.freeze({ triage: Object.freeze({ check, summary }) })
