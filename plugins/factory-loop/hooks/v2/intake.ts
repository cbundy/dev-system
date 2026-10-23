// The intake reader's dry run (epic #995, issue #1151; #1152's real run reuses these functions
// unchanged): reading the issue and the repo's top level for the reader's prompt, parsing the
// reader's final message into a checked result (contracts-intake.mjs), and the plain notice the
// owner reads. The driver's wiring (which holds $) is driver-stamp.ts. A dry run writes nothing.
import type { RunResult } from '../exec'
import type { Ms } from '../types'
import { checkIntake } from './contracts-intake.mjs'
import type { IntakeResult } from './contracts-intake.mjs'

// the loop's own agent type for the reader (agents/intake.md), hidden from the model like the step agents
export const INTAKE_AGENT = 'factory-loop:intake'

// a reader that has not ended its turn by then is reported as failed, once (defined in stamps.ts, which the
// pure planner may import; rule I1 settles a real run by it)
export { STAMP_TIMEOUT_MS } from './stamps'

// One stamp in progress: the issue, the model it runs on, when it started, and its agent once spawned.
export type StampRun = { issue: number; model: string; startedAt: Ms; agentId: string | null }

export type Run = (argv: string[]) => Promise<RunResult>

export function startingText(issue: number, model: string): string {
  return `Stamping #${issue} with ${model}, dry run: its answer follows when the reader ends.`
}

// readIssue: the issue and its comments by trusted authors only (callum-flow-issue-read drops the rest).
export async function readIssue(run: Run, issue: number): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  try {
    const r = await run(['callum-flow-issue-read', String(issue), '--comments'])
    if (r.exitCode !== 0) return { ok: false, why: `the issue could not be read (exit ${r.exitCode}: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 200)})` }
    return r.stdout.trim() === '' ? { ok: false, why: 'the issue read was empty' } : { ok: true, text: r.stdout }
  } catch (err) {
    return { ok: false, why: `the issue could not be read (${String(err).slice(0, 200)})` }
  }
}

// topLevelListing: the top-level names of origin's default branch; null when it cannot be listed.
export async function topLevelListing(run: Run, base: string): Promise<string[] | null> {
  try {
    const r = await run(['git', 'ls-tree', '--name-only', `origin/${base}`])
    return r.exitCode === 0 ? r.stdout.split('\n').filter(l => l.trim() !== '') : null
  } catch {
    return null
  }
}

// objectSpans: every top-level {...} span of a text, braces inside JSON strings not counted.
function objectSpans(text: string): string[] {
  const spans: string[] = []
  let depth = 0
  let start = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"' && depth > 0) inString = true
    else if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0) spans.push(text.slice(start, i + 1))
    }
  }
  return spans
}

const failed = (problem: string): IntakeResult => ({ kind: 'failed', area: null, needsOwner: null, reason: null, touches: null, dropped: [], problems: [problem] })

// parseIntakeAnswer: the reader's final message: the whole text as JSON, else the one object (fenced
// or bare) in it, then checkIntake. No object, or more than one, is a failed result; nothing is repaired.
export function parseIntakeAnswer(text: string, areas: readonly string[]): IntakeResult {
  try {
    return checkIntake(JSON.parse(text.trim()), areas)
  } catch {
    // not JSON as a whole: look for the one object in it
  }
  const spans = objectSpans(text)
  if (spans.length === 0) return failed('the answer holds no JSON object')
  if (spans.length > 1) return failed(`the answer holds ${spans.length} JSON objects; one is expected`)
  try {
    return checkIntake(JSON.parse(spans[0] ?? ''), areas)
  } catch {
    return failed('the JSON object in the answer does not parse')
  }
}

export type StampMeta = { issue: number; model: string; seconds: number }

// stampNotice: the owner's one plain notice. A null result is a stamp that failed before it had an
// answer, and `why` says why. It always ends by saying nothing was written.
export function stampNotice(result: IntakeResult | null, meta: StampMeta, why = ''): string {
  const head = `Stamp #${meta.issue} (${meta.model}, ${meta.seconds}s): `
  const lines: string[] = []
  if (result === null) lines.push(`${head}failed: ${why}`)
  else {
    lines.push(`${head}${result.kind}`)
    const show = (v: unknown) => (v === null ? 'none' : Array.isArray(v) ? (v.length === 0 ? 'none' : v.join(', ')) : String(v))
    lines.push(`area: ${show(result.area)}`, `needs_owner: ${show(result.needsOwner)}`, `reason: ${show(result.reason)}`, `touches: ${show(result.touches)}`)
    if (result.dropped.length > 0) lines.push(`dropped: ${result.dropped.join(', ')}`)
    for (const p of result.problems) lines.push(`problem: ${p}`)
  }
  lines.push('dry run: nothing written')
  return lines.join('\n')
}
