// The loop's side of the companion plugin `factory-loop-workspace` (docs/factory-loop/v2/SPEC.md
// 10.3, 10.5, 10.9), pure: the slot line and folder each agent step's spawn carries, the Bash
// timeout the loop sets for its session, and the workspace rail. The companion writes a handshake
// for each session it runs in, again every minute; without a fresh one for this session, an agent
// would start in the main checkout, unguarded, so every agent step is held with the skip line
// `workspace`, and the owner is told once (tell(workspace)). sources-workspace.ts reads and judges
// the handshake, observeV2 puts it in the State, and rules-state.ts and plan.ts hold and tell
// from it.
import { skip, wake, want } from '../foundation'
import type { Ms } from '../types'
import { AGENT_STEPS } from './types'
import type { StepKind, V2Ctx } from './types'

// The 10-minute Bash timeout (10.5): the loop's session.start sets BASH_DEFAULT_TIMEOUT_MS and
// BASH_MAX_TIMEOUT_MS to it; the companion also gives a loop agent's Bash call with no timeout the
// same value.
export const BASH_TIMEOUT_MS = '600000'

// The rail's owner notice waits this long after the module loaded, so the companion's own
// session.start, which may finish after the loop's first pass, is not told as missing. The hold
// starts at once.
export const WORKSPACE_GRACE_MS = 2 * 60_000

// withSlotLine: the spawn's prompt, opening with `factory-slot: <slot>`, which the companion reads
// to start the agent in its slot (10.3). A prompt that opens with it already is kept; one that
// opens with another slot's has that line replaced. No slot: the prompt as it is.
export function withSlotLine(prompt: string, slot: string | undefined): string {
  if (slot === undefined) return prompt
  const line = `factory-slot: ${slot}`
  const nl = prompt.indexOf('\n')
  const first = nl === -1 ? prompt : prompt.slice(0, nl)
  if (first === line) return prompt
  if (first.startsWith('factory-slot: ')) return nl === -1 ? line : `${line}${prompt.slice(nl)}`
  return `${line}\n${prompt}`
}

// handshakePath: where the companion says it runs in a session (its hooks/register.ts
// handshakePath): one file per session under the loop's base directory.
export function handshakePath(loopBase: string, session: string): string {
  return `${loopBase}/workspace/${session.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

// processIdOf: the process that /proc/<pid>/stat describes, by its pid and start time, as the
// companion names its own in the handshake (its hooks/register.ts processIdOf). No other process
// has it: not a child, not a later one given the same pid. undefined: no stat to read.
export function processIdOf(stat: string | null): string | undefined {
  const pid = stat?.split(' ', 1)[0] ?? ''
  const start = stat?.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] ?? ''
  return /^\d+$/.test(pid) && /^\d+$/.test(start) ? `${pid}:${start}` : undefined
}

// What the rail read: this session's handshake is there, names it and this process, and is
// fresh, or why not (sources-workspace.ts workspaceRead).
export type WorkspaceRead = { session: string; ok: true; version: string | null } | { session: string; ok: false; why: string }

// workspaceHold: why a record's step may not start: an agent step while the rail fails. null: it
// may (the rail passed, or was not read).
export function workspaceHold(ctx: V2Ctx, step: StepKind | null): string | null {
  const w = ctx.v2.workspace
  if (w === undefined || w.ok || step === null || !(AGENT_STEPS as readonly string[]).includes(step)) return null
  return `workspace: ${w.why}; agent steps are held`
}

// workspaceTell: the owner told once per session while the rail fails, after the grace.
export function workspaceTell(ctx: V2Ctx): void {
  const w = ctx.v2.workspace
  if (w === undefined || w.ok) return
  const since: Ms = ctx.state.loadedAt
  if (ctx.state.now - since < WORKSPACE_GRACE_MS) {
    skip(ctx, 'O2', null, `workspace: told after ${WORKSPACE_GRACE_MS / 60_000} minutes without the companion: ${w.why}`)
    return
  }
  const key = `tell:workspace:${w.session.replace(/[^A-Za-z0-9._-]/g, '_')}`
  const context = [w.why, 'Enable the factory-loop-workspace plugin beside factory-loop in this workspace, then restart the session. Until then no agent step starts.']
  want(ctx, wake('tell', 'workspace', key, 'O2', null, { session: w.session }, context))
}
