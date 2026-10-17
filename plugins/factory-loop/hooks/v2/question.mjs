// The structure of an agent's question for the owner (docs/factory-loop/v2/SPEC.md 11): the one
// sentence decision (`question`, required by its contract), an optional `context`, 2 to 6 lettered
// `options` and an optional `recommendation`. checkQuestionParts checks the optional fields for
// the contracts of the designer's question and the triage's park; renderQuestion turns the parts
// into the one canonical markdown text the record stores as its `question`. The park comment
// (park-text.ts) wraps that text in its template and tickedOptions reads the owner's tick back.
// With no optional field the rendered text is the decision alone, so an old answer and a machine
// written park reason are unchanged.
//
// ES2023 alone, nothing of Node or the engine: bin/factory-answer reaches it through the contracts.
// Its types are question.d.mts's.

export const OPTION_KEYS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F'])
export const QUESTION_FIELDS = Object.freeze(['context', 'options', 'recommendation'])
export const OPTIONS = Object.freeze({ min: 2, max: 6 })
export const QUESTION_LIMITS = Object.freeze({ context: 800, optionTitle: 120, optionDetail: 300, recommendationReason: 200 })
// the cap of the record's `question` (event-schemas.ts), which the rendered text must fit
export const QUESTION_CAP = 2000
// the line under the options: where a tick is read and where it is not
export const OPTIONS_NOTE = '_Tick one box and remove the `factory:parked` label. `/factory resume` does not read the ticks: the note you give it is the answer._'

function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
}

function show(v) {
  const text = typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v) ?? v)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

// textOf: a field as trimmed text within its limit; null when absent or when it is a problem.
function textOf(v, name, limit, problems, { oneLine = false, headings = false } = {}) {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || v.trim() === '') {
    problems.push(`${name} must be text, not ${show(v)}`)
    return null
  }
  const t = v.trim()
  if (t.length > limit) problems.push(`${name} is ${t.length} characters; at most ${limit}`)
  if (oneLine && /[\r\n]/.test(t)) problems.push(`${name} must be one line`)
  if (headings && /^\s*#/m.test(t)) problems.push(`${name} must not hold a heading line (one starting with #)`)
  return t
}

// checkQuestionParts: the optional fields of an answer whose `question` is `decision`. Gives
// { context, options, recommendation } (absent ones null, options null or a list), each field
// checked and the rendered text against the cap; problems go on `problems`. The fields are
// reported as their own names.
export function checkQuestionParts(o, decision, problems) {
  const before = problems.length
  const context = textOf(o.context, 'context', QUESTION_LIMITS.context, problems, { headings: true })
  let options = null
  if (o.options !== undefined && o.options !== null) {
    if (!Array.isArray(o.options)) problems.push(`options must be a list, not ${show(o.options)}`)
    else {
      if (o.options.length < OPTIONS.min || o.options.length > OPTIONS.max) problems.push(`options has ${o.options.length} items; ${OPTIONS.min} to ${OPTIONS.max}`)
      options = []
      const seen = new Set()
      o.options.forEach((item, i) => {
        const name = `options[${i}]`
        const it = record(item)
        if (it === null) {
          problems.push(`${name} must be an object {"key", "title", "detail"}, not ${show(item)}`)
          return
        }
        for (const k of Object.keys(it)) if (!['key', 'title', 'detail'].includes(k)) problems.push(`${name}.${k} is not a field of an option (only key, title, detail)`)
        if (!OPTION_KEYS.includes(it.key)) problems.push(`${name}.key ${show(it.key)} is not one of ${OPTION_KEYS.join(', ')}`)
        else if (seen.has(it.key)) problems.push(`${name}.key ${it.key} is given twice`)
        else seen.add(it.key)
        const title = textOf(it.title, `${name}.title`, QUESTION_LIMITS.optionTitle, problems, { oneLine: true })
        if (title === null && (it.title === undefined || it.title === null)) problems.push(`${name}.title is required`)
        const detail = textOf(it.detail, `${name}.detail`, QUESTION_LIMITS.optionDetail, problems)
        options.push({ key: it.key, title: title ?? '', detail })
      })
    }
  }
  let recommendation = null
  if (o.recommendation !== undefined && o.recommendation !== null) {
    const rec = record(o.recommendation)
    if (rec === null) problems.push(`recommendation must be an object {"key", "reason"}, not ${show(o.recommendation)}`)
    else {
      for (const k of Object.keys(rec)) if (!['key', 'reason'].includes(k)) problems.push(`recommendation.${k} is not a field of a recommendation (only key, reason)`)
      const reason = textOf(rec.reason, 'recommendation.reason', QUESTION_LIMITS.recommendationReason, problems, { oneLine: true })
      if (reason === null && (rec.reason === undefined || rec.reason === null)) problems.push('recommendation.reason is required')
      if (!(options ?? []).some(x => x.key === rec.key)) problems.push(`recommendation.key ${show(rec.key)} names no option${options === null ? ' (there are no options)' : ` (the options are ${options.map(x => x.key).join(', ')})`}`)
      else recommendation = { key: rec.key, reason: reason ?? '' }
    }
  }
  if (problems.length === before && decision !== null && decision.length <= QUESTION_CAP) {
    const rendered = renderQuestion({ question: decision, context, options, recommendation })
    if (rendered.length > QUESTION_CAP) problems.push(`question comes to ${rendered.length} characters once rendered with its context, options and recommendation; at most ${QUESTION_CAP}`)
  }
  return { context, options, recommendation }
}

// renderQuestion: the canonical markdown of a question: the decision sentence, then the sections
// that are given, in order: Context, Options (one checkbox line each, its detail indented below,
// then the note on how a tick is read) and Recommendation. With no optional part: the decision.
export function renderQuestion(q) {
  const out = [String(q.question).trim()]
  if (q.context) out.push('#### Context', q.context.trim())
  if (q.options && q.options.length > 0) {
    const lines = []
    for (const o of q.options) {
      lines.push(`- [ ] **${o.key}** - ${o.title}`)
      if (o.detail) for (const l of o.detail.split(/\r?\n/)) lines.push(l.trim() === '' ? '' : `  ${l.trim()}`)
    }
    out.push('#### Options', lines.join('\n'), OPTIONS_NOTE)
  }
  if (q.recommendation) out.push('#### Recommendation', `**${q.recommendation.key}** - ${q.recommendation.reason}`)
  return out.join('\n\n')
}
