// The answer tools the loop's agents call (#548): the adjudicator's verdict, the designer's
// result and the implementer's or fixer's handoff, each a tool whose input schema is the
// contract its text lines carry (replies.ts), and whose errors the model reads and corrects in
// the same turn. The handler (act.ts agentToolAnswered) ties a call to its ledger entry by the
// caller's agentId. The checks here take nothing on trust from the engine's own schema check
// (the test kit makes none) and add what a schema cannot say: the action the purpose allows,
// the fields that action takes, the finding ids a fix names, a brief on the designed issue.
// Pure, like replies.ts: an input in, the Outcome the text would give or the problems out. The
// text lines stay the fallback (SPEC 7.3), and the tools wait behind ToolSearch, as the wake
// answer tool does, so they cost the main conversation nothing.
import type { ToolSpec } from 'claude-code'

import { ACTIONS_FOR, BUMPS, FINDING_ID, FLAGS, HANDOFF_SHAPES, VERDICTS, gatedWithoutRun, handoffOutcome, isBriefUrl } from './replies'
import type { AdjudicatorOutcome, DesignResult, HandoffOutcome } from './replies'
import type { AdjudicatorAction, AdjudicatorPurpose, AgentType, MergeFlag, MergeReport } from './types'

// The tool each agent answers with, by its full name.
export const VERDICT = 'mcp__factory-loop__verdict'
export const DESIGN = 'mcp__factory-loop__design'
export const HANDOFF = 'mcp__factory-loop__handoff'
export const TOOL_OF: Record<AgentType, string> = { adjudicator: VERDICT, designer: DESIGN, implementer: HANDOFF, fixer: HANDOFF }

// A free-text value past this is refused: an answer points, it does not carry documents.
const TEXT_MAX = 4000
type Verdict = (typeof VERDICTS)[number]

const nullable = (type: string, description: string) => ({ type: [type, 'null'], description })

export const VERDICT_TOOL: ToolSpec = {
  name: 'verdict',
  description:
    "The factory loop's adjudicator answer, in place of verdict and ACTION lines: one call at the end of your judgement. " +
    'findings: one entry per finding you judged ([] for a clean review). action: exactly one; a gate or test-weakening review ' +
    'takes approve, fix, skip, fixer or escalate, a merge review merge, hold, fixer or escalate, and a merge review also gives ' +
    'summary, bump and flags. An error says what is wrong: correct the call and call it again; once it is recorded, end your turn.',
  inputSchema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: "the finding's id (review-1), or one of your own for a gap the reviewer missed" },
            verdict: { type: 'string', enum: [...VERDICTS] },
            reason: { type: 'string', description: 'one sentence with the evidence' },
          },
          required: ['id', 'verdict', 'reason'],
          additionalProperties: false,
        },
      },
      action: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['approve', 'fix', 'skip', 'fixer', 'escalate', 'merge', 'hold'] },
          reason: { type: 'string', description: 'approve: the evidence, optional; hold: why the owner must decide' },
          findings: { type: 'array', items: { type: 'string' }, description: 'fix: ids of CORRECT or ENV findings above for the pipeline to fix' },
          instructions: { type: 'string', description: 'fix: what the pipeline should change; fixer: what the fixer agent should do' },
          addFinding: { type: 'object', description: 'fix: a finding the reviewer missed, as no-mistakes takes it' },
          why: { type: 'string', description: 'escalate: what the owner must decide' },
        },
        required: ['type'],
        additionalProperties: false,
      },
      summary: { type: 'string', description: 'merge review: what changes for users, one line' },
      bump: {
        type: 'object',
        properties: { level: { type: 'string', enum: [...BUMPS] }, reason: { type: 'string' } },
        required: ['level', 'reason'],
        additionalProperties: false,
        description: 'merge review: the release bump and why',
      },
      flags: { type: 'array', items: { type: 'string', enum: [...FLAGS] }, description: 'merge review: [] for none' },
    },
    required: ['findings', 'action'],
    additionalProperties: false,
  },
  isDeferred: true,
}

export const DESIGN_TOOL: ToolSpec = {
  name: 'design',
  description:
    "The factory loop's designer answer, in place of the RESULT line: one call once the brief is posted. brief: the brief " +
    "comment's URL on the designed issue, or null; created: the issues you created ([] for none); pendingDecision: true when " +
    'the brief waits on an owner decision. An error says what is wrong: correct the call and call it again; once it is recorded, end your turn.',
  inputSchema: {
    type: 'object',
    properties: {
      brief: nullable('string', "the brief comment's URL (https://github.com/<owner>/<repo>/issues/<N>#issuecomment-<id>), or null"),
      created: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'issue numbers you created; [] for none' },
      pendingDecision: { type: 'boolean' },
    },
    required: ['brief', 'created', 'pendingDecision'],
    additionalProperties: false,
  },
  isDeferred: true,
}

export const HANDOFF_TOOL: ToolSpec = {
  name: 'handoff',
  description:
    "The factory loop's handoff from an implementer or fixer, in place of the RESULT line: one call after the implement-issue " +
    'handoff. run and head: the pipeline run you started or drove and its head from `no-mistakes status`; commit: your latest ' +
    'commit, null when you committed nothing; gated: true only with a run, when its head equals your commit or you committed nothing; branch: ' +
    'the branch the work is on now; pr: the PR number, or null. An error says what is wrong: correct the call and call it again; ' +
    'once it is recorded, end your turn.',
  inputSchema: {
    type: 'object',
    properties: {
      run: nullable('string', 'the pipeline run id, or null'),
      head: nullable('string', "the run's head SHA, or null"),
      commit: nullable('string', 'your latest commit SHA, or null'),
      gated: { type: 'boolean' },
      branch: nullable('string', 'the branch the work is on now'),
      pr: nullable('integer', 'the PR number, or null'),
    },
    required: ['run', 'head', 'commit', 'gated', 'branch', 'pr'],
    additionalProperties: false,
  },
  isDeferred: true,
}

export const AGENT_TOOLS: readonly ToolSpec[] = [VERDICT_TOOL, DESIGN_TOOL, HANDOFF_TOOL]

// What a check gives: the outcome the text contract would, or every problem at once, so the
// model fixes them in one more call.
export type ToolCheck<O> = { ok: true; outcome: O } | { ok: false; problems: string[] }

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function checked<O>(problems: string[], outcome: () => O): ToolCheck<O> {
  return problems.length > 0 ? { ok: false, problems } : { ok: true, outcome: outcome() }
}

// strays: a field the contract does not have is named, never ignored: it is a misunderstanding.
function strays(o: Record<string, unknown>, allowed: readonly string[], at: string, problems: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`${at}${k} is not a field here`)
}

// text: a free-text field as one trimmed line (the text contract's lines are one line each);
// null when absent or null. Not text, empty where required, or over TEXT_MAX is a problem.
function text(v: unknown, name: string, problems: string[], required: boolean): string | null {
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
function clip(v: unknown): string {
  const s = typeof v === 'string' ? JSON.stringify(v.length > 120 ? `${v.slice(0, 117)}...` : v) : (JSON.stringify(v) ?? String(v))
  return s.length > 124 ? `${s.slice(0, 121)}...` : s
}

// --- the adjudicator (SPEC 7.3) --------------------------------------------------------------

// The fields each action takes beside its type, as its ACTION line's grammar has them.
const ACTION_FIELDS: Record<AdjudicatorAction['type'], readonly string[]> = {
  approve: ['reason'],
  fix: ['findings', 'instructions', 'addFinding'],
  skip: [],
  fixer: ['instructions'],
  escalate: ['why'],
  merge: [],
  hold: ['reason'],
}
const REPORT_FIELDS = ['summary', 'bump', 'flags']

// verdictLine: a finding as the verdict line the text contract gives, naming its id (once, when
// the reason already opens with it), for the verdict event and the rules that read the lines
// (P2a reads `ENV:`).
function verdictLine(verdict: Verdict, id: string, reason: string): string {
  const named = reason.startsWith(id) && !/[\w.-]/.test(reason.charAt(id.length))
  return named ? `${verdict}: ${reason}` : `${verdict}: ${id}: ${reason}`
}

// checkVerdict: the verdict tool's input for an adjudicator of this purpose.
export function checkVerdict(input: unknown, purpose: AdjudicatorPurpose): ToolCheck<AdjudicatorOutcome> {
  const problems: string[] = []
  const o = record(input) ?? {}
  strays(o, ['findings', 'action', ...REPORT_FIELDS], '', problems)
  const judged = new Map<string, Verdict>()
  const verdicts: string[] = []
  const findings: unknown[] | null = Array.isArray(o.findings) ? o.findings : null
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
  let report: MergeReport | null = null
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
function actionOf(raw: unknown, purpose: AdjudicatorPurpose, judged: ReadonlyMap<string, Verdict>, problems: string[]): AdjudicatorAction | null {
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
      let addFinding: string | null = null
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

// fixIds: a fix's finding ids, each one judged above as CORRECT or ENV (the loop has no view of
// the gate's own list, so the call's findings are the ones that are real): a fix for a WRONG,
// NIT or DUP finding would make the pipeline rewrite sound code (adjudicator.md).
function fixIds(raw: unknown, judged: ReadonlyMap<string, Verdict>, problems: string[]): string | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(id => typeof id === 'string')) {
    problems.push('action.findings must be a list of the ids of findings above')
    return null
  }
  const ids = [...new Set(raw.map((id: string) => id.trim()))]
  for (const id of ids) {
    const verdict = judged.get(id)
    if (!FINDING_ID.test(id)) problems.push(`action.findings: ${clip(id)} is not a finding id`)
    else if (verdict === undefined) problems.push(`action.findings: ${id} is not one of the findings above`)
    else if (verdict !== 'CORRECT' && verdict !== 'ENV') problems.push(`action.findings: ${id} is judged ${verdict}, and a fix is for CORRECT or ENV findings`)
  }
  return ids.join(',')
}

// reportOf: the merge review's summary, bump and flags (rule M4).
function reportOf(o: Record<string, unknown>, problems: string[]): MergeReport | null {
  const summary = text(o.summary, 'summary', problems, true)
  const b = record(o.bump)
  const level = BUMPS.find(x => x === b?.level)
  let bumpReason: string | null = null
  if (b === null) problems.push('bump is required: { level: patch|minor|major, reason }')
  else {
    strays(b, ['level', 'reason'], 'bump.', problems)
    if (level === undefined) problems.push(`bump.level must be one of ${BUMPS.join(', ')}`)
    bumpReason = text(b.reason, 'bump.reason', problems, true)
  }
  const flags: MergeFlag[] = []
  if (!Array.isArray(o.flags)) problems.push(`flags is required: a list of ${FLAGS.join(', ')} ([] for none)`)
  else {
    for (const raw of o.flags as unknown[]) {
      const flag = FLAGS.find(f => f === raw)
      if (flag === undefined) problems.push(`flags: ${clip(raw)} is not one of ${FLAGS.join(', ')}`)
      else if (!flags.includes(flag)) flags.push(flag)
    }
  }
  return summary === null || level === undefined || bumpReason === null ? null : { summary, bump: level, bumpReason, flags }
}

// --- the designer (SPEC 7.2) ------------------------------------------------------------------

// checkDesign: the design tool's input for a designer of this issue. A result that leaves the
// loop nothing to do (no brief, no created issues, no decision pending) is a forgotten field.
export function checkDesign(input: unknown, repo: string, issue: number | null): ToolCheck<DesignResult> {
  const problems: string[] = []
  const o = record(input) ?? {}
  strays(o, ['brief', 'created', 'pendingDecision'], '', problems)
  const where = `${repo} issue ${issue ?? '<N>'}`
  let brief: string | null = null
  if (o.brief === undefined) problems.push(`brief is required: the brief comment's URL on ${where}, or null`)
  else if (o.brief !== null) {
    const url = typeof o.brief === 'string' ? o.brief.trim() : ''
    if (isBriefUrl(url, repo, issue)) brief = url
    else problems.push(`brief ${clip(o.brief)} is not a comment URL on ${where} (https://github.com/${repo}/issues/${issue ?? '<N>'}#issuecomment-<id>)`)
  }
  const created = Array.isArray(o.created) && o.created.every(n => Number.isInteger(n) && n > 0) ? [...new Set(o.created as number[])] : null
  if (created === null) problems.push('created must be a list of the issue numbers you created ([] for none)')
  if (typeof o.pendingDecision !== 'boolean') problems.push('pendingDecision must be true or false')
  const pending = o.pendingDecision === true
  if (problems.length === 0 && brief === null && created?.length === 0 && !pending) {
    problems.push('with no brief, no created issues and no decision pending, the loop has nothing to hand on: give the brief URL')
  }
  return checked(problems, () => ({ kind: 'designer', brief, created: created ?? [], pendingDecision: pending }))
}

// --- implementer and fixer handoffs ---------------------------------------------------------

// checkHandoff: the handoff tool's input, read as its RESULT line is (replies.ts handoffOutcome):
// not gated when it says so or its head is not its commit; a branch other than the one the spawn
// named is a new one; gated with no run is refused (replies.ts gatedWithoutRun).
export function checkHandoff(input: unknown, namedBranch: string | null): ToolCheck<HandoffOutcome> {
  const problems: string[] = []
  const o = record(input) ?? {}
  strays(o, ['run', 'head', 'commit', 'gated', 'branch', 'pr'], '', problems)
  const id = (key: string, shape: RegExp, what: string): string | null => {
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
  else if (o.pr !== null && !(Number.isInteger(o.pr) && (o.pr as number) > 0)) problems.push(`pr ${clip(o.pr)} is not a PR number, or null`)
  const pr = typeof o.pr === 'number' ? o.pr : null
  const gated = o.gated === true
  return checked(problems, () => handoffOutcome({ run, head: head?.toLowerCase() ?? null, commit: commit?.toLowerCase() ?? null, gated, branch, pr }, namedBranch))
}
