// The container's gate slots (docs/factory-loop/v2/SPEC.md 10.6, "Turns"), pure. The in-process turns
// limit the stop gates of one session; the slots are <loopDir>/gate-slots/<i>.lock files held through
// flock(1) by bin/factory-gate-slot, so the stop gates and the writers' own gate-command runs share
// one container-wide limit that the kernel frees when a holder dies.
import { quoted } from './scratch'

export const SLOT_DIR = 'gate-slots'
export const WRAPPER = 'bin/factory-gate-slot'
// the exit code of a refusal: no slot was free in time (sysexits EX_TEMPFAIL)
export const BUSY_EXIT = 75

export function slotDir(loopDir: string): string {
  return `${loopDir.replace(/\/+$/, '')}/${SLOT_DIR}`
}

// agentWaitMs: how long an agent's gate command waits for a slot: what the call's own timeout leaves
// past the gate's budget, so the wait and the run fit inside the call. At the defaults that is none.
export function agentWaitMs(timeoutMs: number, gateTimeoutMs: number): number {
  return Math.max(0, timeoutMs - gateTimeoutMs)
}

const PROGRAM = /^[A-Za-z_][A-Za-z0-9_]*$/
const WORD = /^[A-Za-z0-9_.\/:=@%+,-]+$/

export type PreludeOpts = {
  // the wrapper's absolute path
  wrapper: string
  dir: string
  capacity: number
  waitMs: number
  log: string
  issue: number
  life: string
  seq: number
}

// gatePrelude: one shell line that defines a function for each program among the gate commands. The
// function runs the wrapper when the words of its own call are the rest of a gate command (`npm test`),
// and goes on to the program otherwise (`npm test -- x`). A function is called by command name only,
// so quoted text never calls it. A gate command whose program is not a plain identifier, or that has
// shell syntax in it, is left out; null when none is left.
export function gatePrelude(gateCommands: readonly string[], o: PreludeOpts): string | null {
  const byProgram = new Map<string, string[][]>()
  for (const command of gateCommands) {
    const words = command.split(/\s+/).filter(w => w !== '')
    const [program, ...rest] = words
    if (program === undefined || !PROGRAM.test(program) || !rest.every(w => WORD.test(w))) continue
    byProgram.set(program, [...(byProgram.get(program) ?? []), rest])
  }
  if (byProgram.size === 0) return null
  const run = [
    'sh', quoted(o.wrapper), '--dir', quoted(o.dir), '--capacity', String(o.capacity), '--wait-ms', String(Math.trunc(o.waitMs)),
    '--log', quoted(o.log), '--issue', String(o.issue), '--life', quoted(o.life), '--seq', String(o.seq),
  ].join(' ')
  const fns: string[] = []
  for (const [program, calls] of byProgram) {
    const cond = calls.map(rest => `{ [ "$#" -eq ${rest.length} ]${rest.map((w, i) => ` && [ "$${i + 1}" = ${quoted(w)} ]`).join('')}; }`).join(' || ')
    fns.push(`${program}() { if ${cond}; then ${run} -- command ${program} "$@"; else command ${program} "$@"; fi; }`)
  }
  return fns.join('; ')
}

const SLOT_LINE = /^factory-gate-slot: slot (\d+) after (\d+) ms\n?/
const BUSY_LINE = /^factory-gate-slot: busy: [^\n]*$/

export type SlotLine = { kind: 'slot'; slot: number; ms: number; rest: string } | { kind: 'busy' } | { kind: 'none' }

// parseSlotLine: the wrapper's first line off an output. `busy` only when the output is nothing but
// the busy line.
export function parseSlotLine(output: string): SlotLine {
  const m = SLOT_LINE.exec(output)
  if (m !== null) return { kind: 'slot', slot: Number(m[1]), ms: Number(m[2]), rest: output.slice(m[0].length) }
  return BUSY_LINE.test(output.trim()) ? { kind: 'busy' } : { kind: 'none' }
}

// What the stop gate's commands share: the slot wait it may still spend and what it has spent.
export type SlotState = { capMs: number; waitedMs: number }

export type SlotRun = { exitCode: number; output: string; slotWaitMs: number } | { error: string; slotWaitMs: number }

// slotCommand: the shell text that runs `command` (shell text) through the wrapper without a log, for
// at most sliceMs of waiting.
export function slotCommand(command: string, o: { wrapper: string; dir: string; capacity: number; sliceMs: number }): string {
  return `sh ${quoted(o.wrapper)} --dir ${quoted(o.dir)} --capacity ${o.capacity} --wait-ms ${o.sliceMs} -- sh -c ${quoted(command)}`
}

// runSlotted: runs one command through the wrapper (once is one host call), again each time it says
// busy, until it gets a slot or the state's cap is used up. The wait stays out of the command's own budget.
export async function runSlotted(
  state: SlotState,
  sliceMs: number,
  once: () => Promise<{ exitCode: number; stdout: string }>,
): Promise<SlotRun> {
  let waited = 0
  for (;;) {
    const r = await once()
    // an output that is no text is none of the wrapper's
    const p: SlotLine = typeof r.stdout === 'string' ? parseSlotLine(r.stdout) : { kind: 'none' }
    if (p.kind === 'slot') {
      waited += p.ms
      state.waitedMs += p.ms
      return { exitCode: r.exitCode, output: p.rest, slotWaitMs: waited }
    }
    if (p.kind === 'busy' && r.exitCode === BUSY_EXIT) {
      waited += sliceMs
      state.waitedMs += sliceMs
      if (state.waitedMs >= state.capMs) {
        return { error: `it waited ${Math.round(state.waitedMs / 1000)} s for a gate slot of the container (the cap is ${Math.round(state.capMs / 1000)} s) and the command never ran`, slotWaitMs: waited }
      }
      continue
    }
    return { exitCode: r.exitCode, output: r.stdout, slotWaitMs: waited }
  }
}
