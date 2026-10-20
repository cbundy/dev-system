// The stop gate (docs/factory-loop/v2/SPEC.md 10.6): the repo's gate commands, run in the slot one
// after another as `a && b` would run them, inside one total budget. A failing command refuses the
// writer's finish with the command, its exit code and the last lines of its output; a gate that
// cannot run (its budget spent, or a command that could not start) lets the agent finish and is
// recorded as unknown, never as a pass. register.ts supplies how a command runs and the clock.

export const TAIL_LINES = 150

// the longest a finished writer waits for its gate's turn when its marker does not say (config.ts
// gateWaitTimeoutMs)
export const DEFAULT_GATE_WAIT_MS = 30 * 60_000

// Claude Code ends an async agent that makes no progress for CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS
// (600000 by default on 2.1.304), aborting the signal of the agent's stop hook, so a gate that waits
// for its turn and then runs outlives its handler at 10 minutes in all (SPEC 10.6; the gate-queue case
// of docs/factory-loop/probes/workspace-probe). The companion raises the limit for a writer with gates.
// (register.ts spells the variable out: the engine wants a literal name in $.env.get and $.env.set)
// what Claude Code uses when the variable is unset
export const STALL_DEFAULT_MS = 600_000
// the room left past a gate's longest wait and run
export const STALL_MARGIN_MS = 5 * 60_000

// stallBoundMs: how long a writer's stop hook may live: the longest wait for a turn (none without a
// concurrency limit), the gate's budget and a margin.
export function stallBoundMs(m: { gateTimeoutMs: number; gateConcurrency?: number; gateWaitTimeoutMs?: number }): number {
  const wait = m.gateConcurrency === undefined ? 0 : (m.gateWaitTimeoutMs ?? DEFAULT_GATE_WAIT_MS)
  return wait + m.gateTimeoutMs + STALL_MARGIN_MS
}

// One command's run: its exit code and its output (standard output then standard error), or the
// error that kept it from finishing (a timeout, a failure to start).
export type Ran = { exitCode: number; output: string } | { error: string }

export type GateResult =
  | { result: 'pass'; ms: number }
  | { result: 'fail'; ms: number; command: string; exitCode: number; tail: string; failedTests: string[] | null }
  | { result: 'unknown'; ms: number; why: string }

export type GateIo = {
  // runs one command in the slot within budgetMs
  run: (command: string, budgetMs: number) => Promise<Ran>
  now: () => Promise<number>
  // whether the engine has cut the hook off (its signal aborted); absent: never known
  cut?: () => boolean
}

// The least budget a command is started with; less than this left counts as the budget spent.
const MIN_BUDGET_MS = 1_000

// runGates: the commands in order, stopping at the first that fails or cannot run.
// waitMs: the time the gate waited for its turn before runGates started, so a cut gate says how long
// the engine let the hook live in all.
export async function runGates(io: GateIo, commands: readonly string[], budgetMs: number, waitMs = 0): Promise<GateResult> {
  const t0 = await io.now()
  const spent = async () => (await io.now()) - t0
  for (const command of commands) {
    const left = budgetMs - (await spent())
    if (left < MIN_BUDGET_MS) return { result: 'unknown', ms: await spent(), why: `the gate's budget of ${Math.round(budgetMs / 1000)} s ran out before \`${command}\`` }
    let ran: Ran
    try {
      ran = await io.run(command, left)
    } catch (err) {
      ran = { error: err instanceof Error ? err.message : String(err) }
    }
    if ('error' in ran) {
      const ms = await spent()
      // the engine ended the hook (its bound, not the command's): say so, with the wait and the run
      if (io.cut?.() === true || /\baborted\b/.test(ran.error)) return { result: 'unknown', ms, why: `\`${command}\` did not finish: ${cutReason(waitMs, ms)} (${oneLine(ran.error)})` }
      return { result: 'unknown', ms, why: `\`${command}\` did not finish: ${oneLine(ran.error)}` }
    }
    if (ran.exitCode !== 0) return { result: 'fail', ms: await spent(), command, exitCode: ran.exitCode, tail: tail(ran.output), failedTests: failedTests(ran.output) }
  }
  return { result: 'pass', ms: await spent() }
}

// cutReason: the engine cut the hook off; the time since the gate started is the wait plus the run.
export function cutReason(waitMs: number, runMs: number): string {
  const s = (ms: number) => Math.round(ms / 1000)
  return `the hook was cut off ${s(waitMs + runMs)} s after the gate started (${s(waitMs)} s waiting, ${s(runMs)} s running)`
}

const MAX_FAILED = 20
const MAX_NAME = 200

// failedTests: the names of the failing tests in a failed command's full output, or null for none.
// It reads `FAIL <name>` (scripts/test-reporter.js) and `(fail) <name> [<n>ms]` lines (claude plugin
// test) after the ANSI escapes and leading blanks are gone, and leaves the job wrappers of
// scripts/test-job.sh and the test setup failures out; `FAIL test isolation: <what>` is kept.
export function failedTests(output: string): string[] | null {
  const names: string[] = []
  for (const raw of output.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim()
    let name: string | null = null
    let m = /^FAIL (.+)$/.exec(line)
    if (m !== null) {
      const n = m[1]!.trim()
      if (!/^test setup:/.test(n) && !/\(claude plugin validate \/ test\)$/.test(n) && !/^\S+\.test\.sh$/.test(n)) name = n
    } else if ((m = /^\(fail\) (.+?)(?: \[[0-9.]+ ?m?s\])?$/.exec(line)) !== null) name = m[1]!
    if (name === null || name === '') continue
    name = name.slice(0, MAX_NAME)
    if (!names.includes(name)) names.push(name)
    if (names.length === MAX_FAILED) break
  }
  return names.length === 0 ? null : names
}

// tail: the last TAIL_LINES lines of an output, without its trailing blank lines.
export function tail(output: string, lines = TAIL_LINES): string {
  const all = output.replace(/\s+$/, '').split('\n')
  return all.slice(-lines).join('\n')
}

export function oneLine(text: string, max = 300): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 3)}...` : line
}

// blockText: what the agent is told when the gate refuses its finish.
export function blockText(r: Extract<GateResult, { result: 'fail' }>, slot: string, commands: readonly string[]): string {
  return [
    `The stop gate failed in your slot ${slot}: \`${r.command}\` exited ${r.exitCode}. The gates are ${commands.map(c => `\`${c}\``).join(' then ')}; your step cannot finish while one fails.`,
    `Fix the failures, commit and push your branch, then finish again. The last ${TAIL_LINES} lines of its output:`,
    '```',
    r.tail,
    '```',
  ].join('\n')
}

// gateRecord: the result as factory-gate.json holds it in the slot's git dir, with the slot's HEAD
// (null: not read), for the decision log and the triage's inputs.
export function gateRecord(r: GateResult, head: string | null, at: number, commands: readonly string[], waitMs = 0, clean: boolean | null = null): Record<string, unknown> {
  const base = { v: 1, at: new Date(at).toISOString(), head, commands: [...commands], result: r.result, ms: r.ms, waitMs, clean }
  if (r.result === 'fail') return { ...base, command: r.command, exitCode: r.exitCode, tail: r.tail, failedTests: r.failedTests }
  if (r.result === 'unknown') return { ...base, why: r.why }
  return base
}

// gateLine: every run as one line of the companion's log, which outlives factory-gate.json (the
// next run overwrites it), so a step's gate runs can be audited. Only `gate-unknown` is an
// intervention (v2 SPEC 7.2); the loop skips `gate-pass` and `gate-fail`, the gate doing its work.
// clean: whether the slot's tree was clean when the gate started and its head did not move during it
// (null: not known). waitMs is the time the gate waited for its turn and concurrency the limit it ran under (null: none).
// startedAt (ISO, 3 ms digits) is when it asked for its turn, before any wait, and queuedBehind how
// many held a turn or waited ahead of it then (0: none); the loop writes `gate_run` from these.
// rerun: the run is the recovery's, of a gate the loop's restart cut, with no agent left to refuse
// (the field is written only then).
export function gateLine(
  r: GateResult,
  head: string | null,
  waitMs: number,
  concurrency: number | null,
  startedAt: string,
  queuedBehind: number,
  clean: boolean | null,
  rerun = false,
): { cause: string; reason: string; fields: Record<string, unknown> } {
  const fields = { head, ms: r.ms, waitMs, concurrency, startedAt, queuedBehind, clean, ...(rerun ? { rerun: true } : {}) }
  if (r.result === 'pass') return { cause: 'gate-pass', reason: 'the stop gate passed', fields }
  if (r.result === 'fail') return { cause: 'gate-fail', reason: `the stop gate refused the finish: \`${r.command}\` exited ${r.exitCode}`, fields: { ...fields, command: r.command, exitCode: r.exitCode, failedTests: r.failedTests } }
  return { cause: 'gate-unknown', reason: `the stop gate could not run: ${r.why}`, fields }
}

// waitedOut: the result of a gate that never got a turn within the wait cap: unknown, never a pass.
export function waitedOut(waitMs: number, capMs: number, concurrency: number): GateResult {
  return { result: 'unknown', ms: 0, why: `it waited ${Math.round(waitMs / 1000)} s for a turn (the cap is ${Math.round(capMs / 1000)} s, ${concurrency} gate${concurrency === 1 ? '' : 's'} at once) and the gate never ran` }
}
