// The types of split-decision.mjs.
export function decisionFallback(body: string, parent: number): string
export function childDecisionOf(c: Record<string, unknown>, where: string, ready: unknown, body: string | null, parent: number, problems: string[]): string | null
