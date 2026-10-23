// The plan side of a design's upstream request (docs/factory-loop/v2/SPEC.md 8.7): the designer's work
// needs a change in another repo of the factory's own, so the loop raises one issue there (the `upstream`
// action, one keyed effect per seq, act-upstream.ts) and the design waits for that issue to close: once the
// effect is done the step is not-ok `wait` on the foreign issue, which row T16 takes to waiting (the one
// waiting comment names owner/name#N, and the design resumes with a note naming what cleared). Pure.
import { upstreamKey, upstreamMarker } from './keys'
import type { StepRead } from './rules-agent'
import type { StepEnv } from './rules-agent'
import { effect } from './rules-work'
import type { Trigger } from './types'

const RULE = 'S2'

// The upstream request as the step's result carries it (upstream-answer.mjs UpstreamRequest), with the
// authority as the plan reads it: owner (with the source) or bug.
export type UpstreamSpec = { repo: string; request: 'bug' | 'need'; title: string; body: string; authority: { kind: 'owner' | 'bug'; source?: string } }

// upstreamOf: the request a checked design answer holds, or null when it is not in its shape.
export function upstreamOf(v: unknown): UpstreamSpec | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const u = v as Record<string, unknown>
  const a = u.authority !== null && typeof u.authority === 'object' ? (u.authority as Record<string, unknown>) : null
  if (typeof u.repo !== 'string' || (u.request !== 'bug' && u.request !== 'need') || typeof u.title !== 'string' || typeof u.body !== 'string' || a === null) return null
  if (a.kind !== 'owner' && a.kind !== 'bug') return null
  return { repo: u.repo, request: u.request, title: u.title, body: u.body, authority: a.kind === 'owner' && typeof a.source === 'string' ? { kind: 'owner', source: sourceOf(a.source) } : { kind: a.kind } }
}

// sourceOf: where an owner's authority came from, for the decision log: the step's note, the issue, or one comment.
function sourceOf(source: string): string {
  return source === 'note' ? 'note' : /#issuecomment-/.test(source) ? 'comment' : 'issue'
}

// upstreamPlan: the one effect, then the wait on the issue it made or found.
export function upstreamPlan(env: StepEnv, u: UpstreamSpec, reason: string, trigger: Trigger): StepRead {
  const { ctx, r } = env
  const posted = effect(
    env,
    { kind: 'upstream', key: upstreamKey(r), class: 'free', rule: RULE, reason: 'raise an issue upstream', issue: r.issue, target: u.repo, request: u.request, title: u.title, body: u.body, marker: upstreamMarker(ctx.state.repo, r), authority: u.authority, fields: { repo: u.repo, request: u.request, authority: u.authority.kind, source: u.authority.source ?? '' } },
    `upstream: the issue in ${u.repo}`,
  )
  if ('read' in posted) return posted.read
  const o = posted.done.outcome
  if (o?.kind !== 'upstream') return { kind: 'held', why: `upstream: ${upstreamKey(r)} ended without an outcome` }
  const text = `raised ${o.repo}#${o.issue} upstream (${u.request}): ${reason}`
  return { kind: 'result', event: { kind: 'not-ok', reason: 'wait', data: { text, conditions: [{ kind: 'issue-closed', issue: o.issue, repo: o.repo }] } }, trigger }
}
