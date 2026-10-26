export function programIndex(argv: readonly string[]): number
export function toolOf(argv: readonly string[]): string
export function oldName(argv: string[]): string[]
export function couldNotStart(text: unknown): boolean
export function withFallback<A extends string[], I, R>(run: (argv: A, init: I) => Promise<R>): (argv: A, init: I) => Promise<R>
export function withFallbackSync<A extends string[], I, R>(run: (argv: A, init: I) => R): (argv: A, init: I) => R
export function takeNotices(): string[]
export function resetFallbacks(): void
export function settingPair(name: string, value: string): Record<string, string>
export function envOf(env: Record<string, string | undefined>, name: string): string | undefined
