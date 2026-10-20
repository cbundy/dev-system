// The types of done-answer.mjs.
export const DONE_REASON_MAX: number
export type DoneEvidence = { pr: number | null; commit: string | null; runIt: string | null }
export function checkDone(o: Record<string, unknown>, problems: string[], job: { repo: string; issue: number }): { evidence: DoneEvidence; reason: string } | null
