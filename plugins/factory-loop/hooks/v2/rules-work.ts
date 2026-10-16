// The plan side of the designer's step (docs/factory-loop/v2/SPEC.md 4.2, 4.5, 8.7): the generic
// agent step (rules-agent.ts agentStep), then what its answer needs before its result counts. The
// designer is a reader, so the loop does its GitHub writes, each a keyed effect a retry never
// repeats:
// - a brief: posted on the issue as a comment with the hidden key (the seq's `comment` entry
//   action key, keys.ts entryKey); the step is ok once it is posted, with the comment's URL as the
//   record's brief (T2);
// - a question: not-ok at once, its question for the owner (T3);
// - a split: one `split` action per child (keys.ts childKey), each once the siblings it is blocked
//   by exist, so its blocked_by links name issue numbers; then the plan of the whole posted on the
//   parent with the children listed; the step is not-ok (split) once that is done (T4), and the
//   parent's release follows as a closed record's follow-up (rules-entry.ts).
// The builder's and the fixer's steps are the generic agent step: their modules read origin
// (steps-work.ts) and their results carry what the rows read (table.ts EventData).
//
// rules-state.ts takes each step's plan from PLANS, over the generic one. Pure.
import { want } from '../foundation'
import type { LedgerEntry } from '../types'
import { childKey, entryKey } from './keys'
import { agentStep, unknownOf } from './rules-agent'
import type { StepEnv, StepPlan, StepRead } from './rules-agent'
import type { IssueRecord, SplitChild, StepKind, TableEvent, Trigger } from './types'

const RULE = 'S2'

// The design answer as the step's result carries it (contracts-work.mjs DesignAnswer).
type Design = { kind: 'brief' | 'question' | 'split'; brief: string | null; question: string | null; children: SplitChild[] }

// designOf: the checked design answer an ended step's entry holds, or null.
export function designOf(e: LedgerEntry | undefined): Design | null {
  const data = e?.outcome?.kind === 'step' ? e.outcome.result.data : null
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Partial<Design>
  if (d.kind !== 'brief' && d.kind !== 'question' && d.kind !== 'split') return null
  const children = Array.isArray(d.children) ? d.children : []
  return { kind: d.kind, brief: typeof d.brief === 'string' ? d.brief : null, question: typeof d.question === 'string' ? d.question : null, children }
}

// childOf: the issue a done split action made or found.
function childOf(e: LedgerEntry | undefined): number | null {
  return e?.status === 'done' && e.outcome?.kind === 'split' ? e.outcome.child : null
}

// effect: one keyed effect of the step: planned when it may start, else what holds it. done: its
// entry ended well, with the entry.
type Effect = { done: LedgerEntry } | { read: StepRead }

function effect(env: StepEnv, action: Parameters<typeof want>[1], what: string): Effect {
  const e = env.ctx.byKey.get(action.key)
  if (e?.status === 'done') return { done: e }
  if (!env.start) return { read: { kind: 'held', why: env.hold ?? `${what} is held` } }
  const g = want(env.ctx, action)
  if (g === 'go') return { read: { kind: 'held', why: '' } }
  if (g === 'running') return { read: { kind: 'held', why: `${what}: it runs` } }
  if (g === 'wait') return { read: { kind: 'held', why: `${what}: retries after its backoff` } }
  // exhausted: the record's stalled line names it (rules-entry.ts stalledOf)
  return { read: { kind: 'held', why: `${what}: used up its attempts` } }
}

// briefComment: the comment that carries the designer's text on the issue.
function briefComment(r: IssueRecord, body: string) {
  return { kind: 'comment' as const, key: entryKey(r, 'comment'), class: 'free' as const, rule: RULE, reason: 'post the design brief', issue: r.issue, on: 'issue' as const, number: r.issue, body }
}

// order: the children in an order where each comes after the siblings it is blocked by (the
// contract refuses a cycle; any left over keep their order). An entry that is no sibling's key (an
// existing issue, "#<N>") never waits.
function order(children: readonly SplitChild[]): SplitChild[] {
  const out: SplitChild[] = []
  const left = [...children]
  while (left.length > 0) {
    const i = left.findIndex(c => c.blockedBy.every(b => out.some(o => o.key === b) || !children.some(x => x.key === b)))
    out.push(...left.splice(i === -1 ? 0 : i, 1))
  }
  return out
}

// splitPlan: each child made once the siblings it waits on exist, then the parent's comment, then
// the result.
function splitPlan(env: StepEnv, d: Design, trigger: Trigger): StepRead {
  const { ctx, r } = env
  const made = new Map<string, number>()
  const waits: StepRead[] = []
  for (const c of order(d.children)) {
    const key = childKey(r, c.key)
    const done = childOf(ctx.byKey.get(key))
    if (done !== null) {
      made.set(c.key, done)
      continue
    }
    // a sibling key resolves through the made children, "#<N>" straight to N
    const blockers = c.blockedBy.map(b => (b.startsWith('#') ? Number(b.slice(1)) : made.get(b)))
    if (blockers.some(n => n === undefined)) {
      waits.push({ kind: 'held', why: `split: child ${c.key} waits for the siblings it is blocked by` })
      continue
    }
    const step = effect(env, { kind: 'split', key, class: 'free', rule: RULE, reason: `make child ${c.key} of the split`, issue: r.issue, parent: r.issue, child: c, blockedBy: blockers as number[] }, `split: child ${c.key}`)
    if ('read' in step) waits.push(step.read)
    else {
      const n = childOf(step.done)
      if (n !== null) made.set(c.key, n)
    }
  }
  // a pass that planned a child says nothing more; else the first wait names why
  if (made.size < d.children.length) return waits.find(w => w.kind === 'held' && w.why === '') ?? waits[0] ?? { kind: 'held', why: 'split: its children are being made' }
  const list = d.children.map(c => `- #${made.get(c.key)}: ${c.title}${c.ready ? '' : ' (waits on an owner decision)'}`)
  const body = [d.brief ?? `The designer split #${r.issue} into ${d.children.length} issues.`, '', 'Split by the factory loop into:', ...list].join('\n')
  const posted = effect(env, briefComment(r, body), 'split: the plan on the issue')
  if ('read' in posted) return posted.read
  const text = `split into ${d.children.map(c => `#${made.get(c.key)}`).join(', ')}`
  return { kind: 'result', event: { kind: 'not-ok', reason: 'split', data: { text } }, trigger }
}

// designPlan: the designer's step: the generic agent step, then its answer's effects.
export const designPlan: StepPlan = env => {
  const read = agentStep(env, { step: 'design' })
  if (read.kind !== 'result' || read.event.kind === 'unknown' || read.trigger.kind !== 'entry') return read
  const { ctx, r } = env
  const entry = ctx.byKey.get(read.trigger.key)
  const d = designOf(entry)
  if (d === null) return { kind: 'result', event: unknownOf(ctx, r, entry ?? null, 'bad-answer', 'the design answer holds no brief, question or split'), trigger: read.trigger }
  if (d.kind === 'question') {
    const event: TableEvent = { kind: 'not-ok', reason: 'question', data: { question: d.question ?? 'the designer asks the owner a question it did not word' } }
    return { kind: 'result', event, trigger: read.trigger }
  }
  if (d.kind === 'split') return splitPlan(env, d, read.trigger)
  if (d.brief === null) return { kind: 'result', event: unknownOf(ctx, r, entry ?? null, 'bad-answer', 'the design answer holds no brief'), trigger: read.trigger }
  const posted = effect(env, briefComment(r, d.brief), 'the brief on the issue')
  if ('read' in posted) return posted.read
  const o = posted.done.outcome
  const url = o?.kind === 'cli' && typeof o.detail === 'string' && o.detail !== '' ? o.detail : null
  return { kind: 'result', event: { kind: 'ok', data: url === null ? {} : { brief: url } }, trigger: read.trigger }
}

export const PLANS: Partial<Record<StepKind, StepPlan>> = { design: designPlan }
