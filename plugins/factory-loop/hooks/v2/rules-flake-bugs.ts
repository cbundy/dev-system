// Rule F1, the flake bug (docs/factory-loop/v2/SPEC.md 8.5): a test that flaked at least
// flakeBugMin times in the last flakeWindowDays, as the `flakes` source shows (a gate flake or a CI
// flake, each once), gets exactly one bug, and every later flake of it one comment on that bug.
// The bug carries the hidden marker <!-- factory-loop:flake:<hash> -->, the `flaky` label and
// priorityLabel, and is linked under flakeEpic when one is set. It is the one case where the loop
// readies its own work (owner, 2026-10-18): only a bug F1 filed, and only while fewer than
// flakeBugReadyCap open flake bugs are `ready` or in flight; past the cap it is filed without
// `ready` and the owner adds it. One tell(flake-bug) per bug says which, planned the pass after the
// bug is filed (its number is then known) from the flake-bug entry's outcome. A failed or unread
// `flakes` source plans nothing. Pure.
import { gate, isoOf, skip, wake, want } from '../foundation'
import { flakeBugKey, flakeCommentKey } from './keys'
import type { Flake, FlakeBug } from './sources-flakes'
import type { FlakeBugSpec, V2Ctx } from './types'

const DAY = 86_400_000
const LINE_MAX = 300
const LINES_MAX = 40
const TEST_MAX = 512
const REASON_MAX = 200

// The flake-fix standard, as the designer holds a flake bug's brief to it (agents/designer-v2.md "A flake bug").
export const FLAKE_STANDARD = [
  'A fix for this bug must (1) reproduce the flake under load first, meaning the test or its suite run many times while the machine is busy (for example alongside two other full `npm test` runs); (2) fix the cause (real waits instead of sleeps, wall-clock time, shared state, ordering); and (3) show the same stress run passing many times in a row (for example 20 consecutive passes) in the answer\'s evidence.',
  'No retry, skip or raised timeout without a written reason sized to what the test does.',
]

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text)
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

// flakeLine: one flake as the bug and its comments list it.
export function flakeLine(f: Flake): string {
  return `${f.issue === null ? 'no issue' : `#${f.issue}`}, ${f.head === null ? 'no head' : `\`${f.head.slice(0, 7)}\``}, ${isoOf(f.at)}, ${f.source}`
}

// failureLine: the line a flake row gives for its failure: the test, and the failed jobs for a CI flake.
function failureLine(f: Flake): string {
  return clip(oneLine(`${f.source}: ${f.test}${f.job === null ? '' : ` (jobs: ${f.job})`}`), LINE_MAX).replace(/```/g, "'''")
}

// bugText: the bug's body without its markers; the executor makes it safe (neutralBody, a planner
// may not reach prompts.ts) and adds the markers (act-flake-bug.ts bugBody).
export function bugText(test: string, flakes: readonly Flake[], windowDays: number, epic: number | null): string {
  const fence = flakes.slice(0, LINES_MAX).map(failureLine)
  return [
    `The factory loop saw the test \`${oneLine(test).replace(/`/g, "'")}\` flake ${flakes.length} times in the last ${windowDays} days (first on ${isoOf(flakes[0]?.at ?? 0)}). A flake is a gate run that failed and then passed on the same code, or a CI run that passed on its re-run.`,
    `Flakes:\n${flakes.slice(0, LINES_MAX).map(f => `- ${flakeLine(f)}`).join('\n')}${flakes.length > LINES_MAX ? `\n- and ${flakes.length - LINES_MAX} more` : ''}`,
    `Failures:\n\`\`\`\n${fence.join('\n')}\n\`\`\``,
    ...(epic === null ? [] : [`Part of the flaky tests epic #${epic}.`]),
    `The flake-fix standard:\n${FLAKE_STANDARD.map(l => `> ${l}`).join('\n')}`,
  ].join('\n\n')
}

function commentBody(f: Flake): string {
  return `Another flake of this test: ${flakeLine(f)}.\n\n\`\`\`\n${failureLine(f)}\n\`\`\``
}

// openBugs: the open flake bugs that hold a place under the ready cap: ready, or with a record not closed.
function inFlight(ctx: V2Ctx, bugs: readonly FlakeBug[]): number {
  return bugs.filter(b => b.hash !== null && (b.ready || ctx.v2.records.some(r => r.issue === b.number && r.state !== 'closed'))).length
}

export function flakeBugRules(ctx: V2Ctx): void {
  tellRules(ctx)
  const src = ctx.v2.sources.flakes
  if (src === undefined) return
  if (!src.ok) {
    skip(ctx, 'F1', null, `flakes source unread: ${src.error ?? 'failed'}; no flake bug is filed or commented`)
    return
  }
  const read = ctx.v2.flakes
  if (read === undefined) return
  const { config, state } = ctx
  const from = state.now - config.flakeWindowDays * DAY
  const byTest = new Map<string, Flake[]>()
  for (const f of read.flakes) {
    if (f.at < from) continue
    const list = byTest.get(f.hash) ?? []
    if (!list.some(x => x.id === f.id)) list.push(f)
    byTest.set(f.hash, list)
  }
  let held = inFlight(ctx, read.bugs)
  const groups = [...byTest.entries()].map(([hash, list]) => ({ hash, list: list.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)) }))
  groups.sort((a, b) => (a.list[0]?.at ?? 0) - (b.list[0]?.at ?? 0) || (a.hash < b.hash ? -1 : 1))
  for (const { hash, list } of groups) {
    const first = list[0]
    if (first === undefined || list.length < config.flakeBugMin) continue
    const bug = read.bugs.find(b => b.hash === hash)
    if (bug !== undefined) {
      for (const f of list) {
        if (bug.known.includes(f.id)) continue
        const key = flakeCommentKey(hash, f.id)
        want(ctx, { kind: 'comment', key, class: 'free', rule: 'F1', reason: `another flake of ${hash} on its bug #${bug.number}`, issue: null, on: 'issue', number: bug.number, body: commentBody(f) })
      }
      continue
    }
    const key = flakeBugKey(hash, first.id)
    const g = gate(ctx, key, 'flake-bug')
    if (g === 'exhausted') skip(ctx, 'F1', null, `exhausted: ${key}: the flake bug is not filed`)
    if (g !== 'go') continue
    const ready = held < config.flakeBugReadyCap
    if (ready) held += 1
    const reason = ready
      ? `${held - 1} open flake bugs ready or in flight, under the cap of ${config.flakeBugReadyCap}`
      : `${held} open flake bugs ready or in flight reach the cap of ${config.flakeBugReadyCap}`
    const spec: FlakeBugSpec = {
      hash,
      test: first.test.slice(0, TEST_MAX),
      title: `Flaky test: ${clip(oneLine(first.test), 90)}`,
      body: bugText(first.test, list, config.flakeWindowDays, config.flakeEpic),
      flakeIds: list.map(f => f.id),
      ready,
      epic: config.flakeEpic,
      flakes: list.length,
      windowDays: config.flakeWindowDays,
      firstFlakeAt: isoOf(first.at),
      reason: clip(reason, REASON_MAX),
    }
    want(ctx, { kind: 'flake-bug', key, class: 'free', rule: 'F1', reason: `flake bug for ${hash}: ${list.length} flakes in ${config.flakeWindowDays} days`, issue: null, bug: spec })
  }
}

// tellRules: one tell per bug filed, from the entry the executor ended done (the bug's number is in its outcome).
function tellRules(ctx: V2Ctx): void {
  for (const e of ctx.state.ledger) {
    const o = e.outcome
    if (e.kind !== 'flake-bug' || e.status !== 'done' || o?.kind !== 'flake-bug') continue
    const decision = o.ready ? 'ready' : 'held'
    const tell = wake('tell', 'flake-bug', `tell:flake-bug:${o.issue}`, 'F1', null, { bug: o.issue, flakes: o.flakes, days: o.windowDays, decision }, [
      `The test ${clip(oneLine(o.test), 200)} flaked ${o.flakes} times in the last ${o.windowDays} days, so the loop ${o.made ? 'filed' : 'found'} bug #${o.issue}.`,
      o.ready ? 'It is labelled ready: the loop will claim it.' : `It is held by the cap (${o.reason}): the owner adds \`ready\`.`,
    ])
    const loopData = {
      decision,
      decision_reason: clip(o.reason, REASON_MAX),
      flake_test: o.test.slice(0, TEST_MAX),
      flakes: o.flakes,
      window_days: o.windowDays,
      first_flake_at: o.firstFlakeAt,
      filed_issue: o.issue,
    }
    want(ctx, tell.kind === 'tell' ? { ...tell, loopData } : tell)
  }
}
