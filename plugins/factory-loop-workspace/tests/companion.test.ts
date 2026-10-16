// The companion in a session (docs/factory-loop/v2/SPEC.md 10.3 to 10.6, 10.9): the engine beneath
// it answered from a small world of one slot, so each hook is driven as the engine drives it for an
// agent the factory loop starts.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const CONFIG = '/c'
const MAIN = '/w/dev-system'
const SLOT = `${MAIN}/.treehouse/p/3/dev-system`
const GIT_DIR = `${MAIN}/.git/worktrees/dev-system3`
const LOOP_DIR = `${CONFIG}/factory-loop/o__r`
const NOW = Date.UTC(2026, 9, 15, 12, 0)
const MARKER = {
  v: 1,
  repo: 'o/r',
  issue: 571,
  life: 'ss1x2k',
  seq: 7,
  step: 'build',
  role: 'writer',
  branch: 'issue-571',
  gateCommands: ['npm run lint', 'npm test'],
  gateTimeoutMs: 600_000,
  loopDir: LOOP_DIR,
}
const BUILD = { subagentType: 'factory-loop:builder', description: 'Build #571', name: 'build-571-s7-a1', prompt: `factory-slot: ${SLOT}\nYou are the builder for #571.` }

// spawn: an agent spawn as the engine raises it (the loop's $.agent.spawn), with the fields the
// engine fills.
function spawn(over: Pick<AgentSpawnInput, 'prompt' | 'subagentType' | 'description'> & Partial<AgentSpawnInput>): AgentSpawnInput {
  return { tool_use_id: 'toolu_1', provider: { plugin: 'factory-loop', tier: 'user' }, parentModel: 'opus', background: false, fork: false, ...over }
}

// call: a tool call as the engine raises it from an agent's loop, whose agentId is the loop's and
// no argument of the tool.
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as unknown as Parameters<Engine['tool']['call']>[0])

type GateRun = { exitCode: number; output: string } | 'timeout'

// world: the engine beneath the plugin. What it was asked is kept to look at; gates answers the
// stop gate's commands in turn.
function world(on: On, opts: { marker?: unknown; head?: string; gates?: GateRun[] } = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { CLAUDE_CONFIG_DIR: CONFIG, HOME: '/home/node' })
  const w = {
    clock,
    session: 's1',
    spawned: [] as { name?: string; cwd?: string; parentAgentId?: string }[],
    calls: [] as Record<string, unknown>[],
    written: new Map<string, string>(),
    appended: new Map<string, string>(),
    gateRuns: [] as { command: string; cwd?: string; timeoutMs?: number }[],
    ids: 0,
  }
  const files = new Map<string, string>([[`${GIT_DIR}/factory-step.json`, JSON.stringify(opts.marker ?? MARKER)]])
  const gates = [...(opts.gates ?? [])]
  const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: w.session }))
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version":"9.9.9"}' }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: w.written.has(e.path) }))
  on('fs.stat', ($, e) => {
    if (e.path === SLOT || e.path === `${SLOT}/src`) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
    // a symlink in the slot that leads out of it
    if (e.path === `${SLOT}/link`) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: true, realPath: `${MAIN}/elsewhere` } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('process.run', ($, e) => {
    const [cmd, a1, a2] = e.argv
    if (cmd === 'git' && e.argv.includes('--show-toplevel')) return ran(`${SLOT}\n${GIT_DIR}\n${MAIN}/.git\n`)
    if (cmd === 'git' && e.argv.includes('symbolic-ref')) return ran(`${opts.head ?? 'issue-571'}\n`)
    if (cmd === 'git' && e.argv.at(-1) === 'HEAD') return ran('4c2d8aa0000000000000000000000000000000ff\n')
    if (cmd === 'find') return ran('')
    if (cmd === 'sh' && a1 === '-c' && a2?.startsWith('exec 2>&1\n')) {
      w.gateRuns.push({ command: a2.slice('exec 2>&1\n'.length), cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
      const g = gates.shift() ?? { exitCode: 0, output: 'ok\n' }
      if (g === 'timeout') throw new Error('the child ran past its timeout and was killed')
      return ran(g.output, g.exitCode)
    }
    if (cmd === 'sh' && a1 === '-c' && a2?.includes('cat >>')) {
      const path = e.argv[4] as string
      w.appended.set(path, (w.appended.get(path) ?? '') + (e.init?.stdin ?? ''))
      return ran('')
    }
    if (cmd === 'sh' && a1 === '-c' && a2?.includes('cat >')) {
      w.written.set(e.argv[4] as string, e.init?.stdin ?? '')
      return ran('')
    }
    throw new Error(`no answer for ${e.argv.join(' ')}`)
  })
  on('agent.spawn', ($, e) => {
    w.spawned.push({ name: e.name, cwd: e.cwd, parentAgentId: e.parentAgentId })
    return { model: 'opus', agentId: `agent-${++w.ids}` }
  })
  on('tool.call', ($, e) => {
    w.calls.push(e as unknown as Record<string, unknown>)
    return { result: 'ran', text: 'ran' }
  })
  on('classic.SubagentStop', () => ({}))
  return w
}

const START = { cwd: MAIN, surface: null, isInteractive: false }
const companionLines = (w: { appended: Map<string, string> }) =>
  (w.appended.get(`${LOOP_DIR}/companion.jsonl`) ?? '')
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)

describe('the handshake', () => {
  test('session start writes this session\'s file, and the beat writes it again for a new session', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const path = `${CONFIG}/factory-loop/workspace/s1.json`
    expect(JSON.parse(w.written.get(path) ?? '{}')).toMatchObject({ v: 1, session: 's1', version: '9.9.9' })
    // a /clear starts a new session id in the same process
    w.session = 's2'
    await w.clock.advance(60_000)
    expect(JSON.parse(w.written.get(`${CONFIG}/factory-loop/workspace/s2.json`) ?? '{}')).toMatchObject({ session: 's2' })
  })

  test('every beat writes the file again with the time now, so its age shows the companion runs', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const path = `${CONFIG}/factory-loop/workspace/s1.json`
    const at = () => (JSON.parse(w.written.get(path) ?? '{}') as { at?: string }).at
    expect(at()).toBe(new Date(NOW).toISOString())
    for (const minutes of [1, 2, 3]) {
      await w.clock.advance(60_000)
      expect(at()).toBe(new Date(NOW + minutes * 60_000).toISOString())
    }
  })
})

describe('starting an agent in its slot', () => {
  test('a spawn with the slot line and its marker starts in the slot', async ($, on) => {
    const w = world(on)
    const r = await $.agent.spawn(spawn(BUILD))
    expect(r.agentId).toBe('agent-1')
    expect(w.spawned).toEqual([{ name: 'build-571-s7-a1', cwd: SLOT, parentAgentId: undefined }])
  })

  test('a marker for another seq, or none, refuses the spawn', async ($, on) => {
    const w = world(on, { marker: { ...MARKER, seq: 6 } })
    const r = await $.agent.spawn(spawn(BUILD))
    expect(r.deny).toContain('seq 6')
    expect(w.spawned).toEqual([])
  })

  test('an unreadable marker refuses it too', async ($, on) => {
    const w = world(on, { marker: 'garbage' })
    expect((await $.agent.spawn(spawn(BUILD))).deny).toContain('marker')
    expect(w.spawned).toEqual([])
  })

  test('a spawn without the slot line is left alone', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn({ subagentType: 'factory-loop:designer', description: 'v1 design', prompt: 'You are the designer.' }))
    expect(w.spawned).toEqual([{ name: undefined, cwd: undefined, parentAgentId: undefined }])
  })

  test('a child of a slot agent is guarded as its parent is', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    await $.agent.spawn(spawn({ subagentType: 'Explore', description: 'look', prompt: 'look around', parentAgentId: 'agent-1' }))
    const r = await call($, { tool: 'Write', file_path: `${MAIN}/x.txt`, content: 'x', agentId: 'agent-2' })
    expect(r.deny).toContain('outside your slot')
  })
})

describe('the guard', () => {
  test('a write outside the slot is refused, its reason given and logged for the loop', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    const r = await call($, { tool: 'Write', file_path: '../../4/dev-system/a.ts', content: 'x', agentId: 'agent-1' })
    expect(r.deny).toContain(SLOT)
    expect(w.calls).toEqual([])
    expect(companionLines(w)).toEqual([{ at: new Date(NOW).toISOString(), issue: 571, life: 'ss1x2k', seq: 7, cause: 'guard:write', reason: expect.stringContaining('Write: ') }])
  })

  test('a relative write inside the slot goes ahead', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    const r = await call($, { tool: 'Write', file_path: 'src/a.ts', content: 'x', agentId: 'agent-1' })
    expect(r.deny).toBeUndefined()
    expect(w.calls.length).toBe(1)
  })

  test('a write through a symlink that leads out of the slot is refused', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    const r = await call($, { tool: 'Write', file_path: 'link/a.ts', content: 'x', agentId: 'agent-1' })
    expect(r.deny).toContain(`${MAIN}/elsewhere/a.ts`)
    expect(w.calls).toEqual([])
  })

  test('a push to another branch is refused as a push; a GitHub write as a command', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    expect((await call($, { tool: 'Bash', command: 'git push origin main', agentId: 'agent-1' })).deny).toContain('issue-571')
    expect((await call($, { tool: 'Bash', command: 'gh pr create --title x --body y', agentId: 'agent-1' })).deny).toContain('owns GitHub writes')
    expect(companionLines(w).map(l => l.cause)).toEqual(['guard:push', 'guard:command'])
  })

  test('a bare push from the slot\'s branch goes ahead, from another branch it does not', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    expect((await call($, { tool: 'Bash', command: 'git push', timeout: 1000, agentId: 'agent-1' })).deny).toBeUndefined()
  })

  test('the same bare push from a switched branch is refused', async ($, on) => {
    world(on, { head: 'other' })
    await $.agent.spawn(spawn(BUILD))
    expect((await call($, { tool: 'Bash', command: 'git push', agentId: 'agent-1' })).deny).toContain('other')
  })

  test('a Bash call with no timeout gets ten minutes; one with its own keeps it', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    await call($, { tool: 'Bash', command: 'npm test', agentId: 'agent-1' })
    await call($, { tool: 'Bash', command: 'npm test', timeout: 5000, agentId: 'agent-1' })
    expect(w.calls.map(c => c.timeout)).toEqual([600_000, 5000])
  })

  test('a background call is refused, Bash and Agent alike, and logged', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    const bash = await call($, { tool: 'Bash', command: 'sleep 420', run_in_background: true, agentId: 'agent-1' })
    expect(bash.deny).toContain('run it in the foreground and wait for it, a command with a timeout')
    const agent = await call($, { tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'Explore', run_in_background: true, agentId: 'agent-1' })
    expect(agent.deny).toContain('in the foreground')
    expect(w.calls).toEqual([])
    expect(companionLines(w).map(l => [l.cause, String(l.reason).split(':')[0]])).toEqual([['guard:command', 'Bash'], ['guard:command', 'Agent']])
  })

  test('the session\'s own calls and other agents\' are left alone', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    await call($, { tool: 'Bash', command: 'gh pr merge 3' })
    await call($, { tool: 'Bash', command: 'git push -f origin main', agentId: 'someone-else' })
    expect(w.calls.map(c => c.timeout)).toEqual([undefined, undefined])
    expect(companionLines(w)).toEqual([])
  })

  test('a reader may not write in the slot or commit', async ($, on) => {
    const w = world(on, { marker: { ...MARKER, step: 'review', role: 'reader' } })
    await $.agent.spawn(spawn({ ...BUILD, subagentType: 'factory-loop:reviewer', name: 'review-571-s7-a1' }))
    expect((await call($, { tool: 'Edit', file_path: 'src/a.ts', old_string: 'a', new_string: 'b', agentId: 'agent-1' })).deny).toContain('reads only')
    expect((await call($, { tool: 'Bash', command: 'git commit -am x', agentId: 'agent-1' })).deny).toContain('reads only')
    expect((await call($, { tool: 'Write', file_path: '/tmp/notes.md', content: 'x', agentId: 'agent-1' })).deny).toBeUndefined()
    expect(companionLines(w).map(l => l.cause)).toEqual(['guard:write', 'guard:command'])
  })
})

describe('the stop gate', () => {
  test('a failing gate holds the writer\'s finish with the command and its output, and records it', async ($, on) => {
    const w = world(on, { gates: [{ exitCode: 0, output: 'lint ok\n' }, { exitCode: 1, output: 'not ok 3 - parses the marker\n' }] })
    await $.agent.spawn(spawn(BUILD))
    const r = await $.classic.SubagentStop({ agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false })
    expect(r.block).toContain('`npm test` exited 1')
    expect(r.block).toContain('not ok 3 - parses the marker')
    expect(w.gateRuns.map(g => [g.command, g.cwd])).toEqual([
      ['npm run lint', SLOT],
      ['npm test', SLOT],
    ])
    expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ result: 'fail', command: 'npm test', exitCode: 1, head: '4c2d8aa0000000000000000000000000000000ff' })
  })

  test('every gate run, the refusal and the pass after it, is a line of the companion\'s log', async ($, on) => {
    // drill 8b (R2 run, #30): factory-gate.json kept only the last run, so the refusal was lost
    const w = world(on, { gates: [{ exitCode: 0, output: 'lint ok\n' }, { exitCode: 1, output: 'not ok 3\n' }] })
    await $.agent.spawn(spawn(BUILD))
    const stop = { agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false }
    expect((await $.classic.SubagentStop(stop)).block).toContain('`npm test` exited 1')
    expect((await $.classic.SubagentStop({ ...stop, stop_hook_active: true })).block).toBeUndefined()
    const head = '4c2d8aa0000000000000000000000000000000ff'
    expect(companionLines(w).map(({ at: _at, reason: _r, ...l }) => l)).toEqual([
      { issue: 571, life: 'ss1x2k', seq: 7, cause: 'gate-fail', head, ms: 0, command: 'npm test', exitCode: 1 },
      { issue: 571, life: 'ss1x2k', seq: 7, cause: 'gate-pass', head, ms: 0 },
    ])
  })

  test('a passing gate lets it finish', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    const r = await $.classic.SubagentStop({ agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: true })
    expect(r.block).toBeUndefined()
    expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ result: 'pass' })
  })

  test('a gate that cannot run lets it finish, logged as gate-unknown', async ($, on) => {
    const w = world(on, { gates: ['timeout'] })
    await $.agent.spawn(spawn(BUILD))
    const r = await $.classic.SubagentStop({ agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false })
    expect(r.block).toBeUndefined()
    expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ result: 'unknown' })
    expect(companionLines(w).map(l => [l.cause, l.issue])).toEqual([['gate-unknown', 571]])
  })

  test('readers, children and agents with no gate commands are not gated', async ($, on) => {
    const w = world(on, { marker: { ...MARKER, gateCommands: [] } })
    await $.agent.spawn(spawn(BUILD))
    await $.agent.spawn(spawn({ subagentType: 'Explore', description: 'look', prompt: 'look', parentAgentId: 'agent-1' }))
    await $.classic.SubagentStop({ agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false })
    await $.classic.SubagentStop({ agent_id: 'agent-2', agent_type: 'Explore', agent_transcript_path: '', stop_hook_active: false })
    await $.classic.SubagentStop({ agent_id: 'unknown', agent_type: 'Explore', agent_transcript_path: '', stop_hook_active: false })
    expect(w.gateRuns).toEqual([])
  })
})
