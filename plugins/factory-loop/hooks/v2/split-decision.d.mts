// The types of split-decision.mjs.
export function decisionFallback(body: string, parent: number): string
import type { ParkParts } from './types'
export function childDecisionWithParts(c: Record<string, unknown>, where: string, ready: unknown, body: string | null, parent: number, problems: string[]): { decision: string | null; parts: ParkParts | null }
export function childDecisionOf(c: Record<string, unknown>, where: string, ready: unknown, body: string | null, parent: number, problems: string[]): string | null
