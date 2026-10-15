// The spawn's slot line and the slot's step marker (docs/factory-loop/v2/SPEC.md 10.2, 10.3),
// pure. The loop's prompt opens with `factory-slot: <absolute slot path>`; factory-slot prepare
// wrote the marker `factory-step.json` into that slot's git dir. The companion starts the agent
// there only when the two agree with the spawn: the marker's issue, seq and step are the ones the
// agent's name carries (`<step>-<N>-s<seq>-a<attempt>`, D-11), and its type is the loop's.
import { normalize } from './guard'
import type { Role } from './guard'

export const MARKER_FILE = 'factory-step.json'
const STEPS = ['design', 'build', 'review', 'fix', 'triage'] as const
export type Step = (typeof STEPS)[number]

// The marker as the loop writes it (plugins/factory-loop/hooks/v2/types.ts StepMarker).
export type Marker = {
  v: 1
  repo: string
  issue: number
  life: string
  seq: number
  step: Step
  role: Role
  branch: string
  gateCommands: string[]
  gateTimeoutMs: number
  loopDir: string
}

// slotLine: the slot the prompt's first line names, or null when it names none. The path must be
// absolute and plain (no `.` or `..` parts, no doubled or trailing `/`).
export function slotLine(prompt: string): string | null {
  const first = (prompt.split('\n', 1)[0] ?? '').replace(/\r$/, '')
  const m = /^factory-slot: (\/.*\S)\s*$/.exec(first)
  const path = m?.[1]
  if (path === undefined) return null
  return normalize(path, '/') === path ? path : null
}

const int = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min
const str = (v: unknown): v is string => typeof v === 'string' && v !== ''

// parseMarker: the marker file's text as a Marker; null when it does not read.
export function parseMarker(text: string | null): Marker | null {
  if (text === null) return null
  let o: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(text)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
    o = v as Record<string, unknown>
  } catch {
    return null
  }
  if (o.v !== 1 || !str(o.repo) || !int(o.issue, 1) || !str(o.life) || !/^[0-9a-z]+$/.test(o.life) || !int(o.seq, 0)) return null
  if (!STEPS.includes(o.step as Step) || (o.role !== 'writer' && o.role !== 'reader') || !str(o.branch)) return null
  if (!Array.isArray(o.gateCommands) || !o.gateCommands.every(c => typeof c === 'string')) return null
  if (!int(o.gateTimeoutMs, 1) || !str(o.loopDir) || !o.loopDir.startsWith('/')) return null
  return {
    v: 1,
    repo: o.repo,
    issue: o.issue,
    life: o.life,
    seq: o.seq,
    step: o.step as Step,
    role: o.role,
    branch: o.branch,
    gateCommands: (o.gateCommands as string[]).map(c => c.trim()).filter(c => c !== ''),
    gateTimeoutMs: o.gateTimeoutMs,
    loopDir: o.loopDir.replace(/\/+$/, ''),
  }
}

// nameParts: what the loop puts in an agent step's name (v2/steps.ts): `<step>-<N>-s<seq>-a<k>`.
export function nameParts(name: string | undefined): { step: string; issue: number; seq: number } | null {
  const m = /^([a-z]+)-(\d+)-s(\d+)-a\d+$/.exec(name ?? '')
  return m === null ? null : { step: m[1] ?? '', issue: Number(m[2]), seq: Number(m[3]) }
}

// mismatch: why the marker does not belong to this spawn, or null when it does.
export function mismatch(marker: Marker | null, spawn: { name?: string; subagentType: string }): string | null {
  if (marker === null) return `the slot has no readable step marker (${MARKER_FILE} in its git dir)`
  if (!spawn.subagentType.startsWith('factory-loop:')) return `${spawn.subagentType} is not one of the factory loop's agents`
  const n = nameParts(spawn.name)
  if (n === null) return `the agent's name ${spawn.name ?? '(none)'} does not say its step, issue and seq`
  if (n.issue !== marker.issue || n.seq !== marker.seq || n.step !== marker.step) {
    return `the slot is prepared for ${marker.step} of #${marker.issue} seq ${marker.seq}, not ${n.step} of #${n.issue} seq ${n.seq}`
  }
  return null
}
