// The repo-local settings under planner v2 (docs/factory-loop/v2/SPEC.md section 15, "Both settings
// files are read every pass; the workspace file may set any key"): nothing in v2 keeps the main
// checkout current, so the repo's .claude/factory-loop.json is read from origin's default branch
// with `git show`, again every githubEveryMs. When that branch cannot be read, the main checkout's
// file stands, and the decision log's config problems say so: settings are never silently stale.
// register.ts calls repoLoaded once per runtime read, with its own cache.
import { loadConfig } from '../config'
import type { LoadedConfig } from '../config'
import type { Ms } from '../types'

const FILE = '.claude/factory-loop.json'
// origin/HEAD is not always set (a clone made with --single-branch, or by hand); then main
const FALLBACK_REF = 'origin/main'
const GIT_TIMEOUT_MS = 10_000
const ERROR_MAX = 200

export type SettingsIo = {
  run: (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  now: () => Promise<Ms>
}

// What origin's default branch gave: its file's settings ({} when it has none), or why it could
// not be read.
export type OriginRead = { ok: true; raw: Record<string, unknown> } | { ok: false; error: string }

// The last read, kept by the caller between passes.
export type SettingsCache = { value: { at: Ms; checkout: string; read: OriginRead } | null }

export function newSettingsCache(): SettingsCache {
  return { value: null }
}

// defaultRef: origin's default branch as a ref (origin/main), from origin/HEAD, else main.
async function defaultRef(io: SettingsIo, checkout: string): Promise<string> {
  try {
    const r = await io.run(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: checkout, timeoutMs: GIT_TIMEOUT_MS })
    const ref = r.stdout.trim()
    return r.exitCode === 0 && /^origin\/[\w./-]+$/.test(ref) ? ref : FALLBACK_REF
  } catch {
    return FALLBACK_REF
  }
}

// originSettings: the repo-local settings file as origin's default branch holds it, read again
// every everyMs.
export async function originSettings(io: SettingsIo, cache: SettingsCache, checkout: string, everyMs: Ms): Promise<OriginRead> {
  const now = await io.now()
  const kept = cache.value
  if (kept !== null && kept.checkout === checkout && now - kept.at < everyMs) return kept.read
  const ref = await defaultRef(io, checkout)
  let read: OriginRead
  try {
    const r = await io.run(['git', 'show', `${ref}:${FILE}`], { cwd: checkout, timeoutMs: GIT_TIMEOUT_MS })
    if (r.exitCode === 0) read = { ok: true, raw: objectOf(r.stdout) }
    else if (/does not exist in|exists on disk, but not in/.test(r.stderr)) read = { ok: true, raw: {} }
    else read = { ok: false, error: `${ref}: ${firstLine(r.stderr) || `exit ${r.exitCode}`}` }
  } catch (err) {
    read = { ok: false, error: `${ref}: ${firstLine(err instanceof Error ? err.message : String(err))}` }
  }
  cache.value = { at: now, checkout, read }
  return read
}

// repoLoaded: the settings under planner v2: origin's repo-local file under the workspace file's
// keys (over), or, when origin's branch cannot be read, the main checkout's as loaded, with a
// problem that names it.
export async function repoLoaded(io: SettingsIo, cache: SettingsCache, checkout: string, fromTree: LoadedConfig, over: Record<string, unknown>): Promise<LoadedConfig> {
  const read = await originSettings(io, cache, checkout, fromTree.config.githubEveryMs)
  if (read.ok) return loadConfig(read.raw, over)
  return { ...fromTree, problems: [...fromTree.problems, `settings: origin's default branch not read (${read.error}); the main checkout's file is used`] }
}

function objectOf(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 3)}...` : line
}
