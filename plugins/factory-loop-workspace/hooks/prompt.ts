// Prompts nobody answers (docs/factory-loop/v2/SPEC.md 10.10), pure: the reason a refused call is
// given, and the note of the `prompt_denied` and `prompt_waiting` events, so the rules test covers
// them without the engine.
import { oneLine } from './gate'

// the most of a call's input a note carries (a Bash command, else the input as JSON)
export const INPUT_CLIP = 2000
const NONE = 'none'
const ME = 'factory-loop-workspace'

// enc: a value with no space in it: `%` and whitespace percent-encoded, as the loop's
// plugins/factory-loop/hooks/v2/events.ts enc does, so the loop's parsers read the note.
export function enc(v: string): string {
  return v.replace(/[%\s]/g, c => encodeURIComponent(c))
}

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

// inputOf: what the note says of the call: a Bash command, else the input as JSON; clipped.
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

// The tokens of a prompt note, each `none` when unknown.
export type NoteFields = {
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
}

// the order of the tokens: what identifies first, free text last
const NOTE_KEYS = ['life', 'seq', 'step', 'attempt', 'agent', 'agent_type', 'tool', 'slot', 'session', 'transcript', 'why', 'input'] as const

// promptNote: `key=value` tokens, a value encoded with no space in it, `none` for an unknown one
// (a string that is literally `none` has its first letter encoded, so it reads back as itself).
export function promptNote(f: NoteFields): string {
  return NOTE_KEYS.map(k => {
    const v = f[k]
    return `${k}=${v === undefined || v === null || v === '' ? NONE : v === NONE ? '%6Eone' : enc(String(v))}`
  }).join(' ')
}

// transcriptOf: an agent's own transcript, beside the session's:
// <session transcript without .jsonl>/subagents/agent-<id>.jsonl. null: the session's is not known.
export function transcriptOf(sessionTranscript: unknown, agentId: string): string | null {
  if (typeof sessionTranscript !== 'string' || sessionTranscript === '') return null
  return `${sessionTranscript.replace(/\.jsonl$/, '')}/subagents/agent-${agentId}.jsonl`
}

// the notification types that mean a prompt waits on a person
export const PROMPT_NOTIFICATIONS: readonly string[] = ['permission_prompt', 'worker_permission_prompt']
