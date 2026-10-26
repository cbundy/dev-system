// The fabriek command names with a fallback to the old callum-flow ones (#1359): a copy of the
// rule in factory-loop/hooks/tool-name.mjs (plugins import nothing across plugin folders), which a
// test holds to the same table of cases. The program is the first argv element, or the first after
// `env` and its NAME=value words. A `fabriek-` program that could not start (a throw naming
// ENOENT or "not found", or exit 127 with such a message) runs once more as `callum-flow-`, and
// the tool is remembered as missing, so later calls go straight to the old name. Any other exit is
// the command's own answer. Drop it with the alias removal (#1361).
type Result = { exitCode: number; stdout: string; stderr: string }
type Run<I> = (argv: string[], init: I) => Promise<Result>

const missingTools = new Set<string>()

export function programIndex(argv: readonly string[]): number {
  if (argv.length === 0) return -1
  if (argv[0] !== 'env') return 0
  let i = 1
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] as string)) i++
  return i < argv.length ? i : -1
}

export function toolOf(argv: readonly string[]): string {
  const i = programIndex(argv)
  const program = i >= 0 ? (argv[i] as string) : ''
  return program.startsWith('fabriek-') ? program : ''
}

export function oldName(argv: string[]): string[] {
  const i = programIndex(argv)
  if (toolOf(argv) === '') return argv
  const out = [...argv]
  out[i] = `callum-flow-${(argv[i] as string).slice('fabriek-'.length)}`
  return out
}

export function couldNotStart(text: unknown): boolean {
  return /ENOENT|not found|not installed|no such file/i.test(String(text))
}

export function withFallback<I>(run: Run<I>): Run<I> {
  const fallBack = (tool: string, argv: string[], init: I) => {
    missingTools.add(tool)
    return run(oldName(argv), init)
  }
  return async (argv, init) => {
    const tool = toolOf(argv)
    if (tool === '') return run(argv, init)
    if (missingTools.has(tool)) return run(oldName(argv), init)
    let r: Result
    try {
      r = await run(argv, init)
    } catch (err) {
      if (!couldNotStart(err instanceof Error ? err.message : err)) throw err
      return fallBack(tool, argv, init)
    }
    return r.exitCode === 127 && couldNotStart(`${r.stderr ?? ''}\n${r.stdout ?? ''}`) ? fallBack(tool, argv, init) : r
  }
}

export function resetFallbacks(): void {
  missingTools.clear()
}
