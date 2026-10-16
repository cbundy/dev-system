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
// the process's id, as the companion keeps it in the environment (v2 SPEC 10.9)
export const PROCESS = 'process-1'
export const LOCK = `${LOOP_DIR}/act.lock`
export const iso = (ms: number) => new Date(ms).toISOString()

export type Seen = { argv: string[]; env: Record<string, string>; stdin?: string; cwd?: string }
export type Reply = { exitCode?: number; stdout?: string; stderr?: string }

// origin: the checkout's origin, this repo's, unless a test answers git itself.
function origin(argv: readonly string[]): Reply | undefined {
  return argv.join(' ') === 'git remote get-url origin' ? { stdout: `https://github.com/${REPO}.git\n` } : undefined
}

export const CHECKOUT_HEAD = '5251b75ef45eef8d6c31556c1b5ac3d5dd34f3ff'

// checkout: the main checkout on its default branch with nothing changed (#544), and as current
// as origin when the loop updates it (#555), unless a test answers git itself.
export function checkout(argv: readonly string[]): Reply | undefined {
  const line = argv.join(' ')
  if (line === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD') return { stdout: 'origin/main\n' }
  if (line.startsWith('git --no-optional-locks status ')) return { stdout: `# branch.oid ${CHECKOUT_HEAD}\n# branch.head main\n` }
  if (argv[0] === 'sh' && argv[3] === 'factory-loop-update-checkout') return { stdout: `CURRENT ${CHECKOUT_HEAD}\n` }
  return undefined
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
  // answers $.session.send (an agent's repair message), at once or later (or never): undefined
  // delivers it as the engine does, a string refuses it
  send?: (to: string, text: string) => string | undefined | Promise<string | undefined>
  // holds a file's read ($.fs.exists, $.fs.read) or write until the promise it returns resolves
  hold?: (path: string, op: 'read' | 'write') => Promise<void> | undefined
  // the test's engine: with it, $.session.send resumes an agent as the engine does, only as a type
  // the agent.offer hooks offer (a hook's own $ cannot ask them)
  engine?: Engine
}

export type Host = ReturnType<typeof host>

// A ledger entry as the store holds it, the fields the tests read.
type Stored = { key: string; status: string; attempts: number; agentId?: string; outcome?: { kind: string }; summary?: string; reminded?: boolean; turnId?: string }

export function host(on: On, opts: HostOptions = {}) {
  // an empty value leaves the variable unset
  const env = Object.entries({ CLAUDE_CONFIG_DIR: CFG_DIR, DEV_MACHINE_NAME: DEVICE, DEV_ROLE: 'orchestrator', FACTORY_LOOP_WORKSPACE_PROCESS: PROCESS, ...opts.env }).filter(([, v]) => v !== '')
  mock.env(on, Object.fromEntries(env))
  const files = new Map<string, string>([[`${CFG_DIR}/factory-loop/config.json`, JSON.stringify(opts.config ?? {})]])
  for (const [path, body] of Object.entries(opts.files ?? {})) files.set(path, body)
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const seen: Seen[] = []
  const titles: string[] = []
  const prompts: string[] = []
  // the messages $.session.send delivered, to an agent's id
  const sends: { to: string; text: string }[] = []
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
    sends,
    spawns,
    stops,
    registered,
    agents,
    usage: [] as { kind: string; percentUsed: number }[],
    // the directories $.fs.list read
    listed: [] as string[],
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
    // the trace files' lines, oldest first (#552)
    traces(): Record<string, unknown>[] {
      return [...files.entries()]
        .filter(([path]) => path.startsWith(`${LOOP_DIR}/trace-`))
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([, body]) => body.split('\n').filter(l => l !== ''))
        .map(l => JSON.parse(l) as Record<string, unknown>)
    },
    last(): Record<string, unknown> {
      const all = h.passes()
      const line = all[all.length - 1]
      if (line === undefined) throw new Error('no pass line yet')
      return line
    },
    // every command but the loop dir's own upkeep: the decision log's and the trace's appends, the
    // act lock's writes, the daily prune of its old files, the trace cap's deletes and its read
    // of today's trace file for a cut line
    commands(): Seen[] {
      return seen.filter(
        s =>
          !(s.argv[0] === 'sh' && (s.argv[2] ?? '').startsWith('mkdir -p')) &&
          !(s.argv[0] === 'find' && (s.argv[1] ?? '').startsWith(LOOP_DIR)) &&
          !(s.argv[0] === 'rm' && (s.argv[3] ?? '').startsWith(`${LOOP_DIR}/`)) &&
          !(s.argv[0] === 'tail' && (s.argv[4] ?? '').startsWith(`${LOOP_DIR}/`)),
      )
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

  on('fs.exists', async ($, e) => {
    await opts.hold?.(e.path, 'read')
    return { value: files.has(e.path) }
  })
  on('fs.read', async ($, e) => {
    await opts.hold?.(e.path, 'read')
    const body = files.get(e.path)
    return body === undefined ? { deny: `ENOENT ${e.path}` } : { value: body }
  })
  on('fs.write', async ($, e) => {
    await opts.hold?.(e.path, 'write')
    files.set(e.path, e.text)
    return { value: undefined }
  })
  // a directory's entries, each file with its size in bytes, as the engine lists them
  on('fs.list', async ($, e) => {
    h.listed.push(e.path)
    const dir = `${e.path.replace(/\/+$/, '')}/`
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [path, body] of files) {
      if (!path.startsWith(dir)) continue
      const [name = '', ...deeper] = path.slice(dir.length).split('/')
      if (deeper.length > 0) entries.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
      else entries.set(name, { name, kind: 'file', size: new TextEncoder().encode(body).length, mtimeMs: 0, isLink: false })
    }
    return { value: [...entries.values()] }
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
    // rm -f -- <paths>: the trace cap's deletes (#552)
    if (argv[0] === 'rm' && argv[1] === '-f' && argv[2] === '--') {
      for (const path of argv.slice(3)) files.delete(path)
      return done({})
    }
    // tail -c <n> -- <path>: a trace file's last bytes, read for its cut line
    if (argv[0] === 'tail' && argv[1] === '-c' && argv[3] === '--') {
      const body = files.get(argv[4] ?? '')
      if (body === undefined) return done({ exitCode: 1, stderr: `tail: cannot open '${argv[4] ?? ''}'` })
      const bytes = new TextEncoder().encode(body)
      return done({ stdout: new TextDecoder().decode(bytes.slice(Math.max(0, bytes.length - Number(argv[2])))) })
    }
    // the old-watcher rail asks whether a lock directory exists: one does when a file is under it
    if (argv[0] === 'test' && argv[1] === '-d') return done({ exitCode: [...files.keys()].some(p => p.startsWith(`${argv[2]}/`)) ? 0 : 1 })
    return done(lockCas(files, argv, e.init?.stdin) ?? (await opts.run?.(argv, s)) ?? origin(argv) ?? checkout(argv) ?? {})
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
  // the engine offers the model every agent type no hook hides
  on('agent.offer', async () => ({ isOffered: true }))
  on('prompt.submit', async ($, e) => {
    prompts.push(e.text)
    const r = await opts.submit?.(e.text)
    return r?.drop !== undefined ? { drop: r.drop } : { text: e.text }
  })
  on('session.send', async ($, e) => {
    const refused = await opts.send?.(e.to, e.text)
    if (refused !== undefined) return { isDelivered: false, reason: refused }
    // as the engine does (probed on 2.1.299, #559): an agent not running a turn is resumed, and
    // only as a type the model is offered, which it asks the agent.offer hooks
    const to = agents.find(a => a.id === e.to)
    if (opts.engine !== undefined && to !== undefined && to.status !== 'running' && to.status !== 'waiting') {
      const plugin = to.type.includes(':') ? (to.type.split(':')[0] ?? '') : 'engine'
      const offer = await opts.engine.agent.offer({ agent: to.type, description: to.description, source: 'plugin', provider: { plugin, tier: 'user' } })
      if (!offer.isOffered) return { isDelivered: false, reason: `Agent "${e.to}" is stopped (completed) and could not be resumed: Agent type '${to.type}' is not offered in this session.` }
    }
    sends.push({ to: e.to, text: e.text })
    return { isDelivered: true }
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

// agentDone: an agent of the loop finished: its turn.complete, while the agent list shows it idle
// as the engine does (probed on 2.1.299, #559), then the agent list says it completed.
export async function agentDone(
  $: Engine,
  h: Host,
  agentId: string,
  answer: string,
  reason: 'answer' | 'aborted' | 'error' = 'answer',
) {
  const a = h.agents.find(x => x.id === agentId)
  if (a !== undefined && a.status === 'running') a.status = 'idle'
  await $.turn.complete({ agentId, answer, reason, turnId: `turn-${agentId}`, durationMs: 1000, isAborted: reason === 'aborted' })
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
