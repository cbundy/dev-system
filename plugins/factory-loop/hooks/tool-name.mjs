// The fabriek command names with a fallback to the old callum-flow ones (#1359). The loop runs
// `fabriek-<x>`; on an image that predates the rename the program is missing, and the same argv
// runs once more with `callum-flow-` in its place. Which tools were missing is remembered per
// process, so later calls go straight to the old name. Any other failure is the command's own
// answer and is never retried. The companion and the status display carry copies of this rule
// (factory-loop-workspace/hooks/tool-name.ts, factory-hud/hooks/tool-name.ts); a test holds
// the three to the same table of cases. Drop it with the alias removal (#1361).

const NEW_PREFIX = 'fabriek-'
const OLD_PREFIX = 'callum-flow-'

const missingTools = new Set()
let notices = []

// programIndex: where the program is in an argv: the first element, or the first after `env` and
// its NAME=value words. -1 when there is none.
export function programIndex(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return -1
  if (argv[0] !== 'env') return 0
  let i = 1
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i++
  return i < argv.length ? i : -1
}

// toolOf: the fabriek program an argv runs, or '' for any other program.
export function toolOf(argv) {
  const i = programIndex(argv)
  return i >= 0 && typeof argv[i] === 'string' && argv[i].startsWith(NEW_PREFIX) ? argv[i] : ''
}

// oldName: the argv with its fabriek program renamed; the same argv when it runs no fabriek program.
export function oldName(argv) {
  const i = programIndex(argv)
  if (toolOf(argv) === '') return argv
  const out = [...argv]
  out[i] = OLD_PREFIX + argv[i].slice(NEW_PREFIX.length)
  return out
}

// couldNotStart: text that says the program is not there (a throw naming ENOENT, or the shell's 127).
export function couldNotStart(text) {
  return /ENOENT|not found|not installed|no such file/i.test(String(text))
}

function missingResult(r) {
  return r !== null && typeof r === 'object' && r.exitCode === 127 && couldNotStart(`${r.stderr ?? ''}\n${r.stdout ?? ''}`)
}

function noticeOf(tool) {
  return `${tool} is not on this image (it predates the fabriek names): running ${OLD_PREFIX}${tool.slice(NEW_PREFIX.length)}`
}

// withFallback: wraps a runner `(argv, init) => Promise<result>` with the rule.
export function withFallback(run) {
  return async (argv, init) => {
    const tool = toolOf(argv)
    if (tool === '') return run(argv, init)
    if (missingTools.has(tool)) return run(oldName(argv), init)
    let r
    try {
      r = await run(argv, init)
    } catch (err) {
      if (!couldNotStart(err instanceof Error ? err.message : err)) throw err
      return fallBack(tool, run, argv, init)
    }
    return missingResult(r) ? fallBack(tool, run, argv, init) : r
  }
}

// withFallbackSync: the same rule for a synchronous runner (bin/factory-reconcile's spawnSync).
export function withFallbackSync(run) {
  return (argv, init) => {
    const tool = toolOf(argv)
    if (tool === '') return run(argv, init)
    if (missingTools.has(tool)) return run(oldName(argv), init)
    let r
    try {
      r = run(argv, init)
    } catch (err) {
      if (!couldNotStart(err instanceof Error ? err.message : err)) throw err
      return fallBackSync(tool, run, argv, init)
    }
    return missingResult(r) ? fallBackSync(tool, run, argv, init) : r
  }
}

function fallBackSync(tool, run, argv, init) {
  if (!missingTools.has(tool)) {
    missingTools.add(tool)
    notices.push(noticeOf(tool))
  }
  return run(oldName(argv), init)
}

function fallBack(tool, run, argv, init) {
  if (!missingTools.has(tool)) {
    missingTools.add(tool)
    notices.push(noticeOf(tool))
  }
  return run(oldName(argv), init)
}

// takeNotices: the fallbacks not yet reported (one line per tool, once per process), for a pass's decision log.
export function takeNotices() {
  const out = notices
  notices = []
  return out
}

// resetFallbacks: forgets what was missing (tests).
export function resetFallbacks() {
  missingTools.clear()
  notices = []
}

// settingPair: a setting under both names, FABRIEK_<X> and CALLUM_FLOW_<X>, since an older image reads only the old one.
export function settingPair(name, value) {
  return { [`FABRIEK_${name}`]: value, [`CALLUM_FLOW_${name}`]: value }
}

// envOf: a setting read from the environment, FABRIEK_<X> first, then CALLUM_FLOW_<X>; undefined when neither is set.
export function envOf(env, name) {
  return env[`FABRIEK_${name}`] ?? env[`CALLUM_FLOW_${name}`]
}
