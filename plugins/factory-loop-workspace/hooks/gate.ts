// The stop gate (docs/factory-loop/v2/SPEC.md 10.6): the repo's gate commands, run in the slot one
// after another as `a && b` would run them, inside one total budget. A failing command refuses the
// writer's finish with the command, its exit code and the last lines of its output; a gate that
// cannot run (its budget spent, or a command that could not start) lets the agent finish and is
// recorded as unknown, never as a pass. register.ts supplies how a command runs and the clock.

export const TAIL_LINES = 150

// One command's run: its exit code and its output (standard output then standard error), or the
// error that kept it from finishing (a timeout, a failure to start).
export type Ran = { exitCode: number; output: string } | { error: string }

export type GateResult =
  | { result: 'pass'; ms: number }
  | { result: 'fail'; ms: number; command: string; exitCode: number; tail: string }
  | { result: 'unknown'; ms: number; why: string }

export type GateIo = {
  // runs one command in the slot within budgetMs
  run: (command: string, budgetMs: number) => Promise<Ran>
  now: () => Promise<number>
}

// The least budget a command is started with; less than this left counts as the budget spent.
const MIN_BUDGET_MS = 1_000

// runGates: the commands in order, stopping at the first that fails or cannot run.
export async function runGates(io: GateIo, commands: readonly string[], budgetMs: number): Promise<GateResult> {
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
    if ('error' in ran) return { result: 'unknown', ms: await spent(), why: `\`${command}\` did not finish: ${oneLine(ran.error)}` }
    if (ran.exitCode !== 0) return { result: 'fail', ms: await spent(), command, exitCode: ran.exitCode, tail: tail(ran.output) }
  }
  return { result: 'pass', ms: await spent() }
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
export function gateRecord(r: GateResult, head: string | null, at: number, commands: readonly string[]): Record<string, unknown> {
  const base = { v: 1, at: new Date(at).toISOString(), head, commands: [...commands], result: r.result, ms: r.ms }
  if (r.result === 'fail') return { ...base, command: r.command, exitCode: r.exitCode, tail: r.tail }
  if (r.result === 'unknown') return { ...base, why: r.why }
  return base
}
