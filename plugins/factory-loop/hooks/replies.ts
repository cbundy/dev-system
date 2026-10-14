// The agents' replies, parsed: the designer's RESULT line (SPEC 7.2), the adjudicator's verdict
// and ACTION lines with the merge review's report (SPEC 7.3, plugins/callum-flow/agents/
// adjudicator.md), and the implementer's and fixer's handoff (the RESULT line prompts.ts asks
// for after the implement-issue handoff). Pure: text in, an Outcome or null out; each read*
// says instead what kept a reply from parsing, for the one repair message (#548). A reply that
// is not the contract is unparseable, never guessed: act-agents.ts records it as a failed
// attempt, except the designer's, which goes to the model as judge(report) (rule D3). The same
// contracts as tool inputs are agent-tools.ts's.
import type { AdjudicatorAction, AdjudicatorPurpose, Bump, MergeFlag, MergeReport, Outcome } from './types'

export type DesignerOutcome = Extract<Outcome, { kind: 'designer' }>
export type DesignResult = Exclude<DesignerOutcome, { unparsed: true }>
export type AdjudicatorOutcome = Extract<Outcome, { kind: 'adjudicator' }>
export type HandoffOutcome = Extract<Outcome, { kind: 'handoff' }>

// The machine lines, as the prompts ask for them (prompts.ts quotes these).
export const DESIGNER_RESULT = 'RESULT brief=<comment URL|none> created=<n1,n2|none> pending_decision=<yes|no>'
export const HANDOFF_RESULT = 'RESULT run=<id|none> head=<sha|none> commit=<sha|none> gated=<yes|no> branch=<name> pr=<n|none>'

export const VERDICTS = ['CORRECT', 'WRONG', 'NIT', 'ENV', 'DUP'] as const
const VERDICT_LINE = /^(CORRECT|WRONG|NIT|ENV|DUP):\s*\S/
// a contract word with decoration around it (`- WRONG:`, `**ACTION**:`, `` `NIT`: ``), then its colon
const MISSHAPEN_LINE = /^\W*(CORRECT|WRONG|NIT|ENV|DUP|ACTION|SUMMARY|BUMP|FLAGS)\W*:/
export const BUMPS: readonly Bump[] = ['patch', 'minor', 'major']
export const FLAGS: readonly MergeFlag[] = ['image', 'template', 'restart', 'run-it']

// The ACTIONs that answer each purpose. A gate or a test-weakening review never merges or
// holds (types.ts, D-05); a merge review never drives the run's gate. escalate stays open to
// the merge review: its definition offers it, and plan holds on it as on `hold` (rule M5a).
export const ACTIONS_FOR: Record<AdjudicatorPurpose, readonly AdjudicatorAction['type'][]> = {
  gate: ['approve', 'fix', 'skip', 'fixer', 'escalate'],
  weakening: ['approve', 'fix', 'skip', 'fixer', 'escalate'],
  merge: ['merge', 'hold', 'fixer', 'escalate'],
}

// A reply's lines, trimmed, blank ones left out.
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l !== '')
}

// A machine line an agent wrapped in backticks reads the same.
function bare(line: string): string {
  return line.length > 1 && line.startsWith('`') && line.endsWith('`') ? line.slice(1, -1).trim() : line
}

// A reply's line quoted in a problem, cut to a readable length.
function quote(line: string): string {
  return JSON.stringify(line.length > 120 ? `${line.slice(0, 117)}...` : line)
}

const parsed = <T>(r: T | string): T | null => (typeof r === 'string' ? null : r)

// isBriefUrl: a brief comment's URL on an issue of this repo (on that issue, when given).
export function isBriefUrl(url: string, repo: string, issue: number | null = null): boolean {
  const m = url.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)#issuecomment-\d+$/)
  if (m === null || (m[1] ?? '').toLowerCase() !== repo.toLowerCase()) return false
  return issue === null || Number(m[2]) === issue
}

// --- the designer (SPEC 7.2) -----------------------------------------------------------------

const DESIGNER_LINE = /^RESULT\s+brief=(\S+)\s+created=(\S+)\s+pending_decision=(yes|no)$/

// parseDesigner: the report's last line, exactly the RESULT shape, with a brief URL on the
// designed issue of this repo. Anything else is { unparsed: true }: judge(report) hands the
// model the saved report and asks for the fields.
export function parseDesigner(answer: string, repo: string, issue: number | null): DesignerOutcome {
  return parsed(readDesigner(answer, repo, issue)) ?? { kind: 'designer', unparsed: true }
}

// readDesigner: parseDesigner's result, or what kept the report from parsing.
export function readDesigner(answer: string, repo: string, issue: number | null): DesignResult | string {
  const all = lines(answer)
  const last = all[all.length - 1]
  const m = last === undefined ? null : bare(last).match(DESIGNER_LINE)
  if (last === undefined || m === null) {
    if (last !== undefined && /^RESULT\b/.test(bare(last))) return `the last line is not in the shape ${DESIGNER_RESULT}: ${quote(last)}`
    return all.some(l => /^RESULT\b/.test(bare(l))) ? 'the RESULT line is not the last line' : 'no RESULT line'
  }
  const [, briefRaw = '', createdRaw = '', pending] = m
  if (briefRaw !== 'none' && !isBriefUrl(briefRaw, repo, issue)) return `brief= is neither none nor a comment URL on ${repo} issue ${issue ?? '<N>'}`
  if (createdRaw !== 'none' && !/^[1-9]\d*(,[1-9]\d*)*$/.test(createdRaw)) return 'created= is neither none nor issue numbers joined by commas'
  const created = createdRaw === 'none' ? [] : [...new Set(createdRaw.split(',').map(Number))]
  return { kind: 'designer', brief: briefRaw === 'none' ? null : briefRaw, created, pendingDecision: pending === 'yes' }
}

// --- the adjudicator (SPEC 7.3) ----------------------------------------------------------------

// parseAdjudicator: verdict lines `<VERDICT>: <reason>`, exactly one `ACTION:` line, and for
// purpose merge exactly one each of SUMMARY, BUMP and FLAGS. Any other line, an ACTION the
// purpose does not take, or a second ACTION makes the reply unparseable (rule P2 retries it).
export function parseAdjudicator(answer: string, purpose: AdjudicatorPurpose): AdjudicatorOutcome | null {
  return parsed(readAdjudicator(answer, purpose))
}

// readAdjudicator: parseAdjudicator's result, or what kept the reply from parsing.
export function readAdjudicator(answer: string, purpose: AdjudicatorPurpose): AdjudicatorOutcome | string {
  const verdicts: string[] = []
  const actions: { line: string; action: AdjudicatorAction | null }[] = []
  let summary: string | null = null
  let bump: { bump: Bump; reason: string } | null = null
  let flags: MergeFlag[] | null = null
  // prose before the contract is skipped (agents often open with a sentence of context, as the
  // testbed showed), but a contract line in the wrong shape (a bulleted or bold verdict, a fenced
  // block) is not prose; from the first contract line on, any other line makes the reply
  // unparseable. Only a contract word followed by its colon is a contract line: a sentence that
  // merely opens with one ("CORRECT is not warranted", "CORRECT/WRONG judgments:") is prose.
  let started = false
  for (const line of lines(answer)) {
    if (!started && !VERDICT_LINE.test(line) && !/^(ACTION|SUMMARY|BUMP|FLAGS):/.test(line)) {
      if (MISSHAPEN_LINE.test(line) || /^[A-Z]{2,}:/.test(line) || line.startsWith('```')) return `a contract line in the wrong shape: ${quote(line)}`
      continue
    }
    started = true
    if (VERDICT_LINE.test(line)) {
      verdicts.push(line)
      continue
    }
    const act = line.match(/^ACTION:\s*(.*)$/)
    if (act !== null) {
      actions.push({ line, action: parseAction(act[1] ?? '') })
      continue
    }
    const report = line.match(/^(SUMMARY|BUMP|FLAGS):\s*(.*)$/)
    if (report === null) return `a line after the first contract line that is not a contract line: ${quote(line)}`
    const [, name, value = ''] = report
    if (purpose !== 'merge') return `${name} answers a merge review only, and this is a ${purpose} review`
    if (name === 'SUMMARY') {
      if (summary !== null) return 'more than one SUMMARY line'
      if (value === '') return 'an empty SUMMARY line'
      summary = value
    } else if (name === 'BUMP') {
      const parsed = parseBump(value)
      if (bump !== null) return 'more than one BUMP line'
      if (parsed === null) return `the BUMP line is not patch, minor or major and its reason: ${quote(line)}`
      bump = parsed
    } else {
      const parsed = parseFlags(value)
      if (flags !== null) return 'more than one FLAGS line'
      if (parsed === null) return `the FLAGS line is not none or a comma list of ${FLAGS.join(', ')}: ${quote(line)}`
      flags = parsed
    }
  }
  const only = actions.length === 1 ? actions[0] : undefined
  if (only === undefined) return actions.length === 0 ? 'no ACTION line' : 'more than one ACTION line'
  const action = only.action
  if (action === null) return `the ACTION line does not read as any action the contract allows: ${quote(only.line)}`
  if (!ACTIONS_FOR[purpose].includes(action.type)) return `ACTION ${action.type} does not answer a ${purpose} review, which takes ${ACTIONS_FOR[purpose].join(', ')}`
  if (purpose !== 'merge') return { kind: 'adjudicator', verdicts, action, report: null }
  const missing = [summary === null ? 'SUMMARY' : '', bump === null ? 'BUMP' : '', flags === null ? 'FLAGS' : ''].filter(n => n !== '')
  if (summary === null || bump === null || flags === null) return `a merge review needs its ${missing.join(', ')} line${missing.length === 1 ? '' : 's'}`
  const report: MergeReport = { summary, bump: bump.bump, bumpReason: bump.reason, flags }
  return { kind: 'adjudicator', verdicts, action, report }
}

// `<patch|minor|major> <reason>`; a reason led by a dash or colon reads the same.
function parseBump(value: string): { bump: Bump; reason: string } | null {
  const m = value.match(/^(\S+)\s*(.*)$/)
  const bump = BUMPS.find(b => b === m?.[1]?.toLowerCase())
  if (m === null || bump === undefined) return null
  return { bump, reason: (m[2] ?? '').replace(/^[-:]\s*/, '').trim() }
}

// `none`, or a comma list of the four flags; a flag the loop does not know may matter for
// sequencing, so it makes the reply unparseable rather than being dropped.
function parseFlags(value: string): MergeFlag[] | null {
  if (value.toLowerCase() === 'none') return []
  const out: MergeFlag[] = []
  for (const word of value.split(',').map(w => w.trim().toLowerCase())) {
    const flag = FLAGS.find(f => f === word)
    if (flag === undefined) return null
    if (!out.includes(flag)) out.push(flag)
  }
  return out.length > 0 ? out : null
}

const FIX_FLAGS = ['--findings', '--instructions', '--add-finding'] as const
export const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/
const APPROVE_FLAGS = ['--reason'] as const

// parseAction: what follows `ACTION:`, by the definition's contract: `approve [--reason <text>]`,
// `fix` with `--findings <ids>`, `--instructions <text>` and/or `--add-finding <json>`, `skip`,
// `fixer: <instructions>`, `escalate: <why>`, and the merge review's `merge` and `hold <reason>`.
// A value may be quoted as in a shell ('...' or "...") or bare, up to the next flag.
export function parseAction(text: string): AdjudicatorAction | null {
  const m = text.trim().match(/^(approve|fixer|fix|skip|escalate|merge|hold)\b(:?)\s*([\s\S]*)$/)
  if (m === null) return null
  const [, type, colon, rest = ''] = m
  if (colon === ':' && type !== 'fixer' && type !== 'escalate' && type !== 'hold') return null
  switch (type) {
    case 'skip':
      return rest === '' ? { type: 'skip' } : null
    case 'merge':
      return rest === '' ? { type: 'merge' } : null
    case 'approve': {
      if (rest === '') return { type: 'approve', reason: null }
      const reason = parseOptions(rest, APPROVE_FLAGS)?.get('--reason')
      return reason === undefined ? null : { type: 'approve', reason }
    }
    case 'fix': {
      const flags = parseOptions(rest, FIX_FLAGS)
      if (flags === null || flags.size === 0) return null
      // finding ids as no-mistakes names them (review-1); a stray flag is no id
      const ids = flags.get('--findings')?.split(/[\s,]+/).filter(id => id !== '')
      if (ids !== undefined && (ids.length === 0 || !ids.every(id => FINDING_ID.test(id)))) return null
      const findings = ids === undefined ? null : ids.join(',')
      const json = flags.get('--add-finding')
      const addFinding = json === undefined ? null : findingJson(json)
      if (addFinding === '') return null
      return { type: 'fix', findings, instructions: flags.get('--instructions') ?? null, addFinding }
    }
    case 'fixer':
      return rest === '' ? null : { type: 'fixer', instructions: unquote(rest) }
    case 'escalate':
      return rest === '' ? null : { type: 'escalate', why: unquote(rest) }
    case 'hold':
      return rest === '' ? null : { type: 'hold', reason: unquote(rest) }
    default:
      return null
  }
}

// The finding no-mistakes adds (`--add-finding`, one JSON object), compacted; '' when it is not
// a JSON object, which the caller rejects.
function findingJson(text: string): string {
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : ''
  } catch {
    return ''
  }
}

function unquote(text: string): string {
  const t = text.trim()
  const q = t[0]
  return t.length > 1 && (q === '"' || q === "'") && t.endsWith(q) ? t.slice(1, -1).trim() : t
}

// parseOptions: `--flag value` pairs from the allowed set, each at most once, every value
// non-empty. Anything else (an unknown flag such as --yes, stray words) is null.
function parseOptions(text: string, allowed: readonly string[]): Map<string, string> | null {
  const out = new Map<string, string>()
  const flagAt = (j: number) =>
    allowed.find(f => text.startsWith(f, j) && (j + f.length === text.length || /[\s=]/.test(text[j + f.length] ?? ''))) ?? null
  let i = 0
  for (;;) {
    while (i < text.length && /\s/.test(text[i] ?? '')) i++
    if (i >= text.length) return out
    const flag = flagAt(i)
    if (flag === null || out.has(flag)) return null
    i += flag.length
    if (text[i] === '=') i++
    while (i < text.length && /\s/.test(text[i] ?? '')) i++
    const read = readValue(text, i, flagAt)
    if (read === null || read.value === '') return null
    out.set(flag, read.value)
    i = read.end
  }
}

// readValue: one value at i: quoted, a JSON object or array (balanced), or bare up to the next
// allowed flag that starts a word.
function readValue(text: string, i: number, flagAt: (j: number) => string | null): { value: string; end: number } | null {
  const c = text[i]
  const endsWord = (j: number) => j >= text.length || /\s/.test(text[j] ?? '')
  if (c === '"' || c === "'") {
    let value = ''
    let j = i + 1
    while (j < text.length && text[j] !== c) {
      // inside double quotes a backslash escapes " \ $ and ` (POSIX sh)
      if (c === '"' && text[j] === '\\' && '"\\$`'.includes(text[j + 1] ?? 'x')) j++
      value += text[j] ?? ''
      j++
    }
    if (j >= text.length || !endsWord(j + 1)) return null
    return { value: value.trim(), end: j + 1 }
  }
  if (c === '{' || c === '[') {
    const end = jsonEnd(text, i)
    return end === null || !endsWord(end) ? null : { value: text.slice(i, end), end }
  }
  let j = i
  while (j < text.length && !(/\s/.test(text[j] ?? '') && flagAt(j + 1) !== null)) j++
  return { value: text.slice(i, j).trim(), end: j }
}

// jsonEnd: the index after the bracket that closes the one at i, minding JSON strings.
function jsonEnd(text: string, i: number): number | null {
  let depth = 0
  let inString = false
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (inString) {
      if (c === '\\') j++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return j + 1
    }
  }
  return null
}

// --- implementer and fixer handoffs ----------------------------------------------------------

const HANDOFF_LINE = /^RESULT\s+run=(\S+)\s+head=(\S+)\s+commit=(\S+)\s+gated=(yes|no)\s+branch=(\S+)\s+pr=(\S+)$/

export type HandoffFields = { run: string | null; head: string | null; commit: string | null; gated: boolean; branch: string | null; pr: number | null }

// The shape of each handoff id, as a RESULT line or the handoff tool gives it.
export const HANDOFF_SHAPES = { run: /^[A-Za-z0-9_-]+$/, sha: /^[0-9a-f]{7,40}$/i, branch: /^[A-Za-z0-9._/-]+$/ }

// handoffFields: one RESULT line's fields, each checked for its shape, or null.
function handoffFields(line: string): HandoffFields | null {
  const m = bare(line).match(HANDOFF_LINE)
  if (m === null) return null
  const [, run = '', head = '', commit = '', gated, branch = '', pr = ''] = m
  const shapes: [string, RegExp][] = [
    [run, HANDOFF_SHAPES.run],
    [head, HANDOFF_SHAPES.sha],
    [commit, HANDOFF_SHAPES.sha],
    [branch, HANDOFF_SHAPES.branch],
    [pr, /^#?\d+$/],
  ]
  if (shapes.some(([v, shape]) => v !== 'none' && !shape.test(v))) return null
  const opt = (v: string) => (v === 'none' ? null : v)
  return {
    run: opt(run),
    head: opt(head)?.toLowerCase() ?? null,
    commit: opt(commit)?.toLowerCase() ?? null,
    gated: gated === 'yes',
    branch: opt(branch),
    pr: pr === 'none' ? null : Number(pr.replace('#', '')),
  }
}

// One SHA may be the other's short form.
function sameSha(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a)
}

// parseHandoff: the last RESULT line of an implementer's or fixer's handoff. It is not gated
// when it says so, or when the run's head is not the agent's commit (implement-issue section 8:
// never rationalise a mismatch away). newBranch is the branch it reports when that is not the
// one the spawn named (an implementer is named none). With no RESULT line, the words NOT GATED
// still say enough for rule D5; anything else is unparseable.
export function parseHandoff(answer: string, namedBranch: string | null): HandoffOutcome | null {
  return parsed(readHandoff(answer, namedBranch))
}

// readHandoff: parseHandoff's result, or what kept the handoff from parsing.
export function readHandoff(answer: string, namedBranch: string | null): HandoffOutcome | string {
  const all = lines(answer)
  const found = all.map(handoffFields).filter(f => f !== null)
  const fields = found[found.length - 1]
  if (fields === undefined) {
    if (/\bNOT GATED\b/.test(answer)) return { kind: 'handoff', notGated: true, run: null, head: null, newBranch: null }
    const misshapen = all.filter(l => /^RESULT\b/.test(bare(l))).pop()
    return misshapen === undefined ? 'no RESULT line, and it does not say NOT GATED' : `the RESULT line is not in the shape ${HANDOFF_RESULT}: ${quote(misshapen)}`
  }
  return handoffOutcome(fields, namedBranch)
}

// handoffOutcome: what a handoff's fields mean, from either channel.
export function handoffOutcome(fields: HandoffFields, namedBranch: string | null): HandoffOutcome {
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
