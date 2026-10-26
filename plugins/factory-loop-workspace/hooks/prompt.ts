// Prompts nobody answers (docs/factory-loop/v2/SPEC.md 10.10), pure: the reason a refused call is
// given, and the data of the native `prompt_denied` and `prompt_waiting` events (written with
// `fabriek-event --type`, docs/factory-events/schemas), so the rules test covers them without
// the engine.
import { oneLine } from './gate'

// the most of a call's input an event carries (a Bash command, else the input as JSON)
export const INPUT_CLIP = 2000
const ME = 'factory-loop-workspace'

// clip: at most `max` characters.
export function clip(text: string, max = INPUT_CLIP): string {
  return text.length > max ? text.slice(0, max) : text
}

// What Claude Code's own check said (the result of `next(e)` for a tool.check).
export type Decided = { reason?: unknown; rule?: unknown; decider?: unknown }

const say = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

// whyOf: Claude Code's reason, rule and decider as one line; null when it said none.
export function whyOf(d: Decided): string | null {
  const parts = [say(d.reason), say(d.rule) === null ? null : `rule ${say(d.rule)}`, say(d.decider) === null ? null : `decided by ${say(d.decider)}`]
  const text = parts.filter((p): p is string => p !== null).join('; ')
  return text === '' ? null : oneLine(text, 500)
}

// inputOf: what the event says of the call: a Bash command, else the input as JSON; clipped.
export function inputOf(tool: string, input: unknown): string {
  const command = tool === 'Bash' && input !== null && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined
  if (typeof command === 'string') return clip(command)
  try {
    return clip(JSON.stringify(input) ?? '')
  } catch {
    return ''
  }
}

// a `rm` of a glob under a variable that is not guarded with `:?`: if the variable is empty it is
// `rm -f /*`. Group 1: the variable's name.
const VARIABLE_GLOB = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))[^\s;|&]*[*?]/

// unguardedGlob: the variable of a Bash command that removes a glob under an unguarded variable;
// null for any other call.
export function unguardedGlob(tool: string, input: unknown): string | null {
  const command = inputOf(tool, input)
  if (tool !== 'Bash' || !/\brm\b/.test(command)) return null
  const m = VARIABLE_GLOB.exec(command)
  return m === null ? null : (m[1] ?? m[2] ?? null)
}

// rmHint: the safe rewrite, with the command's own variable.
export const rmHint = (name: string): string => `Never \`rm\` a glob under an unguarded variable: use \`"\${${name}:?}"/*\` or a literal path.`

// promptReason: what the agent is told when its call is refused, because Claude Code would have
// asked a person.
export function promptReason(tool: string, input: unknown, decided: Decided): string {
  const why = whyOf(decided)
  const glob = unguardedGlob(tool, input)
  return [
    `${ME}: this ${tool} call would wait on a person nobody watches, so it is refused.`,
    why === null ? null : `Claude Code's own reason: ${why}.`,
    glob === null ? null : rmHint(glob),
    'Find another way to do it or, failing that, end your step saying what you needed.',
  ]
    .filter((p): p is string => p !== null)
    .join(' ')
}

// The facts of a prompt event, each null when unknown.
export type PromptFields = {
  life?: string | null
  seq?: number | null
  step?: string | null
  attempt?: number | null
  agent?: string | null
  agent_type?: string | null
  tool?: string | null
  slot?: string | null
  session?: string | null
  transcript?: string | null
  why?: string | null
  input?: string | null
  branch?: string | null
  pr?: number | null
}

const orNull = <T>(v: T | null | undefined): T | null => (v === undefined || v === '' ? null : v)

// promptData: the data of a `prompt_denied` or `prompt_waiting` event, under the schema's names,
// with every required key of the type (an unknown value null, an empty agent id null). A waiting
// prompt has no tool and no ask_reason: its message is the tool_input, clipped like a deny's.
export function promptData(kind: 'prompt_denied' | 'prompt_waiting', f: PromptFields): Record<string, string | number | null> {
  const denied = kind === 'prompt_denied'
  const input = orNull(f.input)
  return {
    life: orNull(f.life) ?? null,
    seq: orNull(f.seq) ?? null,
    step: orNull(f.step) ?? null,
    attempt: orNull(f.attempt) ?? null,
    agent_id: orNull(f.agent) ?? null,
    agent_type: orNull(f.agent_type) ?? null,
    tool_name: denied ? (orNull(f.tool) ?? null) : null,
    tool_input: input === null ? null : clip(input),
    ...(denied ? { ask_reason: orNull(f.why) ?? null } : {}),
    slot: orNull(f.slot) ?? null,
    session: orNull(f.session) ?? null,
    transcript: orNull(f.transcript) ?? null,
    branch: orNull(f.branch) ?? null,
    pr: orNull(f.pr) ?? null,
  }
}

// transcriptOf: an agent's own transcript, beside the session's:
// <session transcript without .jsonl>/subagents/agent-<id>.jsonl. null: the session's is not known.
export function transcriptOf(sessionTranscript: unknown, agentId: string): string | null {
  if (typeof sessionTranscript !== 'string' || sessionTranscript === '') return null
  return `${sessionTranscript.replace(/\.jsonl$/, '')}/subagents/agent-${agentId}.jsonl`
}

// the notification types that mean a prompt waits on a person
export const PROMPT_NOTIFICATIONS: readonly string[] = ['permission_prompt', 'worker_permission_prompt']
