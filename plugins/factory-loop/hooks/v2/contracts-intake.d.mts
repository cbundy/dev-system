// The types of contracts-intake.mjs.
export const FIELDS: readonly ['area', 'needs_owner', 'reason', 'touches']
export const LIMITS: Readonly<{ reason: number; touches: number }>
// ok: every field kept; dropped: at least one field (or unknown key) dropped; failed: no object, or no field kept.
// A dropped field is null. dropped names the fields and unknown keys left out; problems say why.
export type IntakeResult = {
  kind: 'ok' | 'dropped' | 'failed'
  area: string | null
  needsOwner: boolean | null
  reason: string | null
  touches: string[] | null
  dropped: string[]
  problems: string[]
}
export function checkIntake(input: unknown, areas: readonly string[]): IntakeResult
