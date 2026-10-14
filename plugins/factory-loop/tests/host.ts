// The engine's test host set up as a factory-loop session: files, the store, commands, agents,
// prompts and /rename are answered by the test's own hooks beneath the plugin, and every call is
// recorded. driver.test.ts and act.test.ts drive whole passes through it; each test answers the
// commands it cares about with `run`, and anything else is a quiet exit 0.
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LOCK_CAS_SCRIPT } from '../hooks/rails'
import { DEVICE, NOW } from './fixtures'

export const REPO = 'cbundy/dev-system'
export const CFG_DIR = '/cfg'
export const LOOP_DIR = `${CFG_DIR}/factory-loop/cbundy__dev-system`
export const TOOLS = '/usr/local/share/callum-tools'
export const SESSION = 'session-1'
export const LOCK = `${LOOP_DIR}/act.lock`
export const iso = (ms: number) => new Date(ms).toISOString()

export type Seen = { argv: string[]; env: Record<string, string>; stdin?: string; cwd?: string }
export type Reply = { exitCode?: number; stdout?: string; stderr?: string }

// origin: the checkout's origin, this repo's, unless a test answers git itself.
function origin(argv: readonly string[]): Reply | undefined {
  return argv.join(' ') === 'git remote get-url origin' ? { stdout: `https://github.com/${REPO}.git\n` } : undefined
}

// lockCas: rails.ts LOCK_CAS_SCRIPT, as the shell runs it, over a test's files; undefined for any
// other command. The lease lands only while the file still holds what its writer read.
export function lockCas(files: { get: (p: string) => string | undefined; set: (p: string, t: string) => unknown }, argv: readonly string[], stdin: string | undefined): Required<Reply> | undefined {
  if (argv[0] !== 'sh' || argv[2] !== LOCK_CAS_SCRIPT) return undefined
  const path = argv[4] ?? ''
  const cur = (files.get(path) ?? '').replace(/\n+$/, '')
  if (cur !== (argv[5] ?? '')) return { exitCode: 3, stdout: '', stderr: '' }
  files.set(path, stdin ?? '')
  return { exitCode: 0, stdout: '', stderr: '' }
}

export type HostOptions = {
  // the workspace config file (config.json)
  config?: Record<string, unknown>
  env?: Record<string, string>
  files?: Record<string, string>
  store?: Record<string, unknown>
  // answers a command, at once or later; undefined falls through to a quiet exit 0
  run?: (argv: string[], seen: Seen) => Reply | undefined | Promise<Reply | undefined>
  // answers $.agent.spawn: an agent id, or a refusal
  spawn?: (input: { subagentType?: string; name?: string; model?: string; prompt: string }) => { agentId?: string; deny?: string } | Promise<{ agentId?: string; deny?: string }>
  // answers TaskStop, at once or later (or never); undefined stops the agent
  stop?: (taskId: string) => { deny?: string } | undefined | Promise<{ deny?: string } | undefined>
  // answers $.prompt.submit, at once or later; { drop } drops the prompt
  submit?: (text: string) => { drop?: string } | undefined | Promise<{ drop?: string } | undefined>
}

export type Host = ReturnType<typeof host>

// A ledger entry as the store holds it, the fields the tests read.
type Stored = { key: string; status: string; attempts: number; agentId?: string; outcome?: { kind: string }; summary?: string; reminded?: boolean; turnId?: string }

export function host(on: On, opts: HostOptions = {}) {
  // an empty value leaves the variable unset
  const env = Object.entries({ CLAUDE_CONFIG_DIR: CFG_DIR, DEV_MACHINE_NAME: DEVICE, DEV_ROLE: 'orchestrator', ...opts.env }).filter(([, v]) => v !== '')
  mock.env(on, Object.fromEntries(env))
  const files = new Map<string, string>([[`${CFG_DIR}/factory-loop/config.json`, JSON.stringify(opts.config ?? {})]])
  for (const [path, body] of Object.entries(opts.files ?? {})) files.set(path, body)
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const seen: Seen[] = []
  const titles: string[] = []
  const prompts: string[] = []
  const spawns: { subagentType?: string; name?: string; model?: string; prompt: string; description?: string }[] = []
  const stops: string[] = []
  const registered: string[] = []
  const agents: { id: string; type: string; status: 'running' | 'waiting' | 'completed' | 'failed' | 'killed' | 'idle'; description: string; parentId?: string }[] = []
  let nextAgent = 0
  const h = {
    files,
    store,
    seen,
    titles,
    prompts,
    spawns,
    stops,
    registered,
    agents,
    usage: [] as { kind: string; percentUsed: number }[],
    // the decision log's appends fail (a full disk), so every pass throws at its end
    failAppends: false,
    // $.agent.list() is refused while this is set
    failList: false,
    // $.store.get and $.store.set are refused for the keys these name
    failGet: (_key: string) => false,
    failSet: (_key: string) => false,
    // the decision log's lines, oldest first
    lines(): Record<string, unknown>[] {
      return [...files.entries()]
        .filter(([path]) => path.startsWith(`${LOOP_DIR}/decisions-`))
        .flatMap(([, body]) => body.split('\n').filter(l => l !== ''))
        .map(l => JSON.parse(l) as Record<string, unknown>)
    },
    // the pass lines alone (the ones with a digest)
    passes(): Record<string, unknown>[] {
      return h.lines().filter(l => typeof l.digest === 'string')
    },
    last(): Record<string, unknown> {
      const all = h.passes()
      const line = all[all.length - 1]
      if (line === undefined) throw new Error('no pass line yet')
      return line
    },
    // every command but the loop dir's own upkeep: the decision log's appends, the act lock's
    // writes and the daily prune of its old files
    commands(): Seen[] {
      return seen.filter(s => !(s.argv[0] === 'sh' && (s.argv[2] ?? '').startsWith('mkdir -p')) && !(s.argv[0] === 'find' && (s.argv[1] ?? '').startsWith(LOOP_DIR)))
    },
    events(): string[][] {
      return seen.filter(s => s.argv[0] === 'callum-flow-event').map(s => s.argv)
    },
    ledger(): Stored[] {
      const stored = store.get(`ledger:${REPO}`) as { entries?: unknown[] } | undefined
      return (stored?.entries ?? []) as Stored[]
    },
    entry(key: string) {
      return h.ledger().find(e => e.key === key)
    },
  }

  on('fs.exists', async ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', async ($, e) => {
    const body = files.get(e.path)
    return body === undefined ? { deny: `ENOENT ${e.path}` } : { value: body }
  })
  on('fs.write', async ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  // $.store as the engine keeps it: values read back as their JSON round trip
  on('store.get', async ($, e) => {
    if (h.failGet(e.key)) return { deny: `store: ${e.key} could not be read` }
    return { value: store.has(e.key) ? JSON.parse(JSON.stringify(store.get(e.key))) : undefined }
  })
  on('store.set', async ($, e) => {
    if (h.failSet(e.key)) return { deny: `store: ${e.key} could not be written` }
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', async ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: [...store.keys()] }))
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    const s: Seen = { argv, env: { ...(e.init?.env ?? {}) }, stdin: e.init?.stdin, cwd: e.init?.cwd }
    seen.push(s)
    const done = (r: Reply) => ({
      value: { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    // the decision log's append: sh -c 'mkdir -p ... && cat >> "$1"' sh <path>
    if (argv[0] === 'sh' && (argv[2] ?? '').startsWith('mkdir -p') && argv[2] !== LOCK_CAS_SCRIPT) {
      if (h.failAppends) return { deny: 'cat: write error: No space left on device' }
      const path = argv[4] ?? ''
      files.set(path, (files.get(path) ?? '') + (e.init?.stdin ?? ''))
      return done({})
    }
    // the old-watcher rail asks whether a lock directory exists: one does when a file is under it
    if (argv[0] === 'test' && argv[1] === '-d') return done({ exitCode: [...files.keys()].some(p => p.startsWith(`${argv[2]}/`)) ? 0 : 1 })
    return done(lockCas(files, argv, e.init?.stdin) ?? (await opts.run?.(argv, s)) ?? origin(argv) ?? {})
  })
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000, tokens: 1000, percent: 1 }, rateLimits: h.usage } }))
  on('session.id', async () => ({ value: SESSION }))
  on('agent.list', async () => (h.failList ? { deny: 'agent list unavailable' } : { value: agents.map(a => ({ ...a })) }))
  on('agent.spawn', async ($, e) => {
    spawns.push({ subagentType: e.subagentType, name: e.name, model: e.model, prompt: e.prompt, description: e.description })
    const r = (await opts.spawn?.(e)) ?? { agentId: `agent-${++nextAgent}` }
    if (r.deny !== undefined) return { deny: r.deny }
    if (r.agentId !== undefined) agents.push({ id: r.agentId, type: e.subagentType, status: 'running', description: e.description })
    return { model: e.model ?? 'opus', agentId: r.agentId }
  })
  on('prompt.submit', async ($, e) => {
    prompts.push(e.text)
    const r = await opts.submit?.(e.text)
    return r?.drop !== undefined ? { drop: r.drop } : { text: e.text }
  })
  on('command.run', async ($, e) => {
    if (e.command === 'rename') titles.push(e.args)
    return {}
  })
  on('command.register', async ($, e) => {
    registered.push(`/${e.name}`)
    return { value: { command: e.name } }
  })
  on('tool.register', async ($, e) => {
    registered.push(`mcp__factory-loop__${e.name}`)
    return { value: { tool: `mcp__factory-loop__${e.name}` } }
  })
  on('tool.call', { tool: 'TaskStop' }, async ($, e) => {
    stops.push(String(e.task_id))
    const r = await opts.stop?.(String(e.task_id))
    if (r?.deny !== undefined) return { deny: r.deny }
    return { result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }
  })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
  return h
}

// agentDone: an agent of the loop finished: its turn.complete, then the agent list says so.
export async function agentDone(
  $: Engine,
  h: Host,
  agentId: string,
  answer: string,
  reason: 'answer' | 'aborted' | 'error' = 'answer',
) {
  await $.turn.complete({ agentId, answer, reason, turnId: `turn-${agentId}`, durationMs: 1000, isAborted: reason === 'aborted' })
  const a = h.agents.find(x => x.id === agentId)
  if (a !== undefined) a.status = 'completed'
}

// The factory-state report for one repo (callum-flow-factory-state --format json).
export function factoryDoc(issues: Record<string, unknown>[], recent: Record<string, unknown>[] = [], at = NOW): string {
  return JSON.stringify({ at: iso(at), repos: [{ repo: REPO, issues, recent }] })
}

// The heartbeat guard's query (rails.ts HEARTBEAT_SQL) reads no other orchestrator.
export const QUIET_BEATS = 'device,age_s\n'
// The event log's columns (derive.ts EVENTS_SQL), no rows.
export const NO_EVENTS = 'ts,state,issue,run_id,branch,pr,head,note,actor,device\n'
