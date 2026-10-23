// The types of upstream-answer.mjs.
export const UPSTREAM_REPOS: readonly string[]
export const UPSTREAM_REQUESTS: readonly ['bug', 'need']
export const UPSTREAM_LIMITS: Readonly<{ title: number; reason: number; authorityText: number; quoteMin: number; quoteMax: number }>
export type UpstreamAuthority = { kind: 'owner'; source: string; quote: string } | { kind: 'bug'; blocking: string; confidence: string }
export type UpstreamRequest = { repo: string; request: 'bug' | 'need'; title: string; body: string; authority: UpstreamAuthority }
export function normalQuote(s: string): string
export function quoteIn(quote: string, text: string): boolean
export function sourceKind(source: unknown, job: { repo: string; issue: number }): 'note' | 'issue' | 'comment' | null
export function checkUpstream(o: Record<string, unknown>, problems: string[], job: { repo: string; issue: number; data?: unknown }, bodyMax: number): { upstream: UpstreamRequest; reason: string } | null
