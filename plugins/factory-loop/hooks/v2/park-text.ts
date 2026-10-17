// The park's comment and the owner's tick (docs/factory-loop/v2/SPEC.md 4.5, 11).
//
// - parkText: the one template every park comment is written through: a heading, the decision
//   (the record's `question`, which question.mjs's renderQuestion made for an agent's structured
//   question, or a machine-written reason with no options), how to resume, and where it parked
//   from. The sections of a structured question (Context, Options, Recommendation) sit inside the
//   question's text, so they come in order between the decision sentence and How to resume.
// - decisionOf: the decision sentence alone, for a tell.
// - ticksOf: the owner's ticks in a park comment's Options section, read when the issue is
//   unparked by its label (rules-state.ts unparkOf).
//
// Pure.
import { resumeAction } from './types'
import type { IssueRecord, WaitCondition } from './types'

const OPTIONS_HEADING = /^#### Options[ \t]*$/m
// a heading line of the comment's template: the end of the Options section
const NEXT_HEADING = /^#{1,4} /m
// an option's line: `- [ ] **A** - title`, ticked with an x of either case
const OPTION_LINE = /^- \[( |x|X)\] (.*)$/
const OPTION_KEY = /^\*\*([A-F])\*\*(?: - (.*))?$/

// decisionOf: a question's decision sentence: its text before the first of its sections.
export function decisionOf(question: string): string {
  const at = question.search(/^#### /m)
  return (at < 0 ? question : question.slice(0, at)).trim()
}

// parkText: the park's comment: the question, how to resume and what parked it.
export function parkText(r: IssueRecord, from: IssueRecord['state'] | null, via: string | null): string {
  const question = r.question ?? 'none given'
  const options = OPTIONS_HEADING.test(question)
  const where = from === null ? 'It parked' : `It parked from ${from}${via === null ? '' : ` (${via})`}`
  const resumes = r.resumeTo === null ? '' : `, and a resume goes on with ${r.resumeTo}`
  return [
    '### Waiting on the owner',
    '',
    `**Decision needed:** ${question}`,
    '',
    '#### How to resume',
    '',
    `1. ${options ? 'Tick one option, or write your answer as a comment.' : 'Write your answer as a comment.'}`,
    `2. Then ${resumeAction(r.issue)}. A comment or a tick alone does not resume.`,
    '',
    `${where}${resumes}.`,
  ].join('\n')
}

// waitWords: one wait condition in words.
export function waitWords(c: WaitCondition): string {
  // a line must not end on a closing keyword before a reference's number (prompts.ts neutral rewrites it)
  return c.kind === 'issue-closed' ? `issue #${c.issue} must be closed on GitHub` : `PR #${c.pr} must be merged on GitHub`
}

// waitText: the comment a record posts on the issue when it begins to wait: the conditions, why, and
// that the loop resumes by itself. No tick boxes and no question: the owner has nothing to answer.
export function waitText(r: IssueRecord): string {
  const list = (r.wait ?? []).map(c => `- ${waitWords(c)}`)
  const why = r.notes[0] ?? 'the designer waits on a condition'
  return [
    '### Waiting on a condition',
    '',
    `The designer paused this issue until ${list.length === 1 ? 'one condition holds' : 'every one of these holds'}:`,
    '',
    ...list,
    '',
    `Why: ${why}`,
    '',
    'The factory loop checks the condition itself and resumes this issue when it holds. There is nothing to answer.',
  ].join('\n')
}

export type Ticks = {
  // the ticked options that exist (a key A to F), in the comment's order
  chosen: { key: string; title: string }[]
  // the ticked lines of the Options section that name no such option, as the owner wrote them
  unknown: string[]
}

// ticksOf: the ticks in a park comment's body. Only the Options section is read, so a line in the
// question's context or in a comment quoting it is not a tick.
export function ticksOf(body: string): Ticks {
  const out: Ticks = { chosen: [], unknown: [] }
  const start = body.search(OPTIONS_HEADING)
  if (start < 0) return out
  const rest = body.slice(start).split(/\r?\n/).slice(1)
  for (const line of rest) {
    if (NEXT_HEADING.test(line)) break
    const m = OPTION_LINE.exec(line)
    if (m === null || m[1] === ' ') continue
    const text = (m[2] ?? '').trim()
    const k = OPTION_KEY.exec(text)
    if (k === null || k[1] === undefined) out.unknown.push(text)
    else out.chosen.push({ key: k[1], title: (k[2] ?? '').trim() })
  }
  return out
}

// tickNote: the note a tick gives the resume, put before the comments after the park: the one
// option chosen, or a statement that none is when the ticks are several or name no option. null
// when nothing is ticked.
export function tickNote(ticks: Ticks): string | null {
  const n = ticks.chosen.length + ticks.unknown.length
  if (n === 0) return null
  if (n === 1 && ticks.chosen[0] !== undefined) return `Owner chose option ${ticks.chosen[0].key}: ${ticks.chosen[0].title}`
  const named = [...ticks.chosen.map(c => `${c.key}: ${c.title}`), ...ticks.unknown.map(u => `"${u}" (not an option)`)]
  const why = n > 1 ? `Owner ticked ${n} options, so none is chosen` : 'Owner ticked an option that does not exist, so none is chosen'
  return `${why}: ${named.join('; ')}`
}
