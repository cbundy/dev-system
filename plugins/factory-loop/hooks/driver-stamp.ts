// `/factory stamp <N>`: the intake reader's dry run (issue #1151; v2/intake.ts has the pure parts).
// The command answers at once (startStamp); its job runs on its own with the loop's own $:
// read the issue and the repo's top level, spawn the reader, and note it in S.stamping by agent id.
// When the reader's turn ends (stampEnded, ahead of the ledger's agentAnswered) its answer is
// checked and the owner gets one notice through $.prompt.submit. A dry run writes nothing: no
// GitHub write, no event, no store entry, no ledger change; its only record is one local
// decision-log line.
import type { EngineInterface } from 'claude-code'

import type { Runtime } from './observe'
import { INTAKE_AGENT, STAMP_TIMEOUT_MS, parseIntakeAnswer, readIssue, stampNotice, startingText, topLevelListing } from './v2/intake'

import type { IntakeResult } from './v2/contracts-intake.mjs'
import { intakePrompt } from './v2/prompts-intake'
import { actIo, appendLine, message } from './driver-io'
import { S } from './driver-state'
import type { Stamp } from './driver-state'

// startStamp: the reply to `stamp <N>`, with the job queued behind it.
export function startStamp(rt: Runtime, issue: number, now: number): string {
  const running = S.stamping.get(issue)
  if (running !== undefined) return `already stamping #${issue}`
  if (S.stampJob === null) return 'factory-loop: the loop has not started yet; try again in a moment.'
  const run: Stamp = { issue, model: rt.config.intakeModel, startedAt: now, agentId: null, rt, cancel: () => undefined }
  S.stamping.set(issue, run)
  S.stampJob(rt, run)
  return startingText(issue, run.model)
}

// finish: the stamp's end, once: out of the map, its timer cancelled, the notice submitted and one line
// in the decision log. A stamp already finished is left alone.
async function finish($: EngineInterface, run: Stamp, result: IntakeResult | null, why = ''): Promise<void> {
  if (S.stamping.get(run.issue) !== run) return
  S.stamping.delete(run.issue)
  run.cancel()
  const seconds = Math.max(0, Math.round(((await $.clock.now()) - run.startedAt) / 1000))
  const meta = { issue: run.issue, model: run.model, seconds }
  const outcome = result === null ? 'failed' : result.kind
  await actIo($)
    .submit(stampNotice(result, meta, why))
    .catch(() => undefined)
  await appendLine($, run.rt, { stamp: run.issue, outcome, model: run.model, seconds, ...(why === '' ? {} : { why }) })
}

// defaultBranch: origin's default branch as the last pass's checkout state knows it, else null.
function defaultBranch(): string | null {
  const c = S.checkout
  return c === null || 'error' in c || c.defaultBranch === '' ? null : c.defaultBranch
}

// stampJob: the background job (S.stampJob is set in ensure, with the loop's own $). It never throws.
export async function stampJob($: EngineInterface, rt: Runtime, run: Stamp): Promise<void> {
  try {
    const io = actIo($)
    const exec = (argv: string[]) => io.run(argv, { cwd: rt.cwd, env: rt.env, timeoutMs: 60_000 })
    const issue = await readIssue(exec, run.issue)
    if (!issue.ok) return await finish($, run, null, issue.why)
    const base = defaultBranch()
    const listing = base === null ? null : await topLevelListing(exec, base)
    const prompt = intakePrompt({ issue: run.issue, text: issue.text, listing, areas: rt.config.intakeAreas })
    const spawned = await io.spawnAgent({ subagentType: INTAKE_AGENT, prompt, description: `Stamp #${run.issue} (dry run)`, model: run.model })
    if (spawned.agentId === undefined) return await finish($, run, null, `the reader could not start (${spawned.deny ?? 'no agent id'})`)
    run.agentId = spawned.agentId
    const timer = $.clock.after(STAMP_TIMEOUT_MS, () => void finish($, run, null, 'the reader did not end its turn within 10 minutes').catch(() => undefined))
    run.cancel = () => timer.cancel()
  } catch (err) {
    await finish($, run, null, `the stamp could not run (${message(err)})`).catch(() => undefined)
  }
}

// stampEnded: a turn.complete of an agent: when it is a stamp's reader, its notice goes out and true
// comes back (the ledger never sees it); any other agent gets false.
export async function stampEnded($: EngineInterface, e: { agentId: string; answer: string; reason: string }): Promise<boolean> {
  const run = [...S.stamping.values()].find(r => r.agentId === e.agentId)
  if (run === undefined) return false
  if (e.reason !== 'answer') await finish($, run, null, `the reader's turn ended without an answer (${e.reason})`)
  else await finish($, run, parseIntakeAnswer(e.answer, run.rt.config.intakeAreas))
  return true
}

