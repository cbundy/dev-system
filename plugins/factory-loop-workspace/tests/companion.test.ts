// The companion in a session (docs/factory-loop/v2/SPEC.md 10.3 to 10.6, 10.9): the engine beneath
// it answered from a small world of one slot, so each hook is driven as the engine drives it for an
// agent the factory loop starts.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { INPUT_CLIP } from '../hooks/prompt'

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
// this process's /proc/self/stat: its pid, its command name (spaces and all) and, as field 22, its
// start time
const PROC_STAT = '4242 (claude code) S 1 4242 4242 0 -1 4194560 52005 150552 0 2 67 12 101 54 20 0 24 0 342070008 5783855104'
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
function world(on: On, opts: { marker?: unknown; head?: string; gates?: GateRun[]; eventExit?: number; hold?: (n: number, command: string) => Promise<void> | undefined } = {}) {
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
    // callum-flow-event's argv, and the engine's own answer to a tool.check
    events: [] as string[][],
    checked: [] as Record<string, unknown>[],
    decided: { decision: 'ask' } as Record<string, unknown>,
    ids: 0,
    sleeps: 0,
  }
  const files = new Map<string, string>([[`${GIT_DIR}/factory-step.json`, JSON.stringify(opts.marker ?? MARKER)], ['/proc/self/stat', PROC_STAT]])
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
  on('process.run', async ($, e) => {
    const [cmd, a1, a2] = e.argv
    if (cmd === 'git' && e.argv.includes('--show-toplevel')) return ran(`${SLOT}\n${GIT_DIR}\n${MAIN}/.git\n`)
    if (cmd === 'git' && e.argv.includes('symbolic-ref')) return ran(`${opts.head ?? 'issue-571'}\n`)
    if (cmd === 'git' && e.argv.at(-1) === 'HEAD') return ran('4c2d8aa0000000000000000000000000000000ff\n')
    if (cmd === 'find') return ran('')
    // the stop gate's idle slice while it queues: answers after a short real delay, never at once
    if (cmd === 'sleep') {
      w.sleeps++
      await new Promise<void>(resolve => setTimeout(resolve, 200))
      return ran('')
    }
    if (cmd === 'callum-flow-event') {
      w.events.push(e.argv)
      return ran('', opts.eventExit ?? 0)
    }
    if (cmd === 'sh' && a1 === '-c' && a2?.startsWith('exec 2>&1\n')) {
      w.gateRuns.push({ command: a2.slice('exec 2>&1\n'.length), cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
      // a gate command that stays pending until the test lets it go
      await opts.hold?.(w.gateRuns.length, a2.slice('exec 2>&1\n'.length))
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
  on('tool.check', ($, e) => {
    w.checked.push(e as unknown as Record<string, unknown>)
    return w.decided as { decision: 'ask' }
  })
  on('classic.SubagentStop', () => ({}))
  on('classic.SubagentStart', () => ({}))
  on('classic.Notification', () => ({}))
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

  test('the file names this process by its pid and start time, which the loop reads the same way', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const path = `${CONFIG}/factory-loop/workspace/s1.json`
    expect(JSON.parse(w.written.get(path) ?? '{}')).toMatchObject({ process: '4242:342070008' })
    await w.clock.advance(60_000)
    expect(JSON.parse(w.written.get(path) ?? '{}')).toMatchObject({ process: '4242:342070008' })
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

  test('a mapped agent\'s Bash call runs with TMPDIR, TMP and TEMP set to the marker\'s scratch; the timeout default still applies', async ($, on) => {
    const scratch = `${LOOP_DIR}/scratch/571-ss1x2k-s7`
    const w = world(on, { marker: { ...MARKER, scratch } })
    await $.agent.spawn(spawn(BUILD))
    await call($, { tool: 'Bash', command: 'echo "$TMPDIR"', agentId: 'agent-1' })
    await call($, { tool: 'Bash', command: 'cat <<EOF\nx\nEOF', timeout: 5000, agentId: 'agent-1' })
    const exported = `export TMPDIR='${scratch}' TMP='${scratch}' TEMP='${scratch}'\n`
    expect(w.calls.map(c => [c.command, c.timeout])).toEqual([
      [`${exported}echo "$TMPDIR"`, 600_000],
      [`${exported}cat <<EOF\nx\nEOF`, 5000],
    ])
    // other tools are untouched
    await call($, { tool: 'Read', file_path: `${SLOT}/a.ts`, agentId: 'agent-1' })
    expect(w.calls[2]).not.toHaveProperty('command')
  })

  test('two agents of different seqs get different folders, and a child gets its parent\'s', async ($, on) => {
    const a = `${LOOP_DIR}/scratch/571-ss1x2k-s7`
    const w = world(on, { marker: { ...MARKER, scratch: a } })
    await $.agent.spawn(spawn(BUILD))
    await $.agent.spawn(spawn({ subagentType: 'Explore', description: 'look', prompt: 'look around', parentAgentId: 'agent-1' }))
    await call($, { tool: 'Bash', command: 'pwd', agentId: 'agent-2' })
    expect(w.calls[0]?.command).toContain(`TMPDIR='${a}'`)
    expect(w.calls[0]?.command).not.toContain('s8')
  })

  test('an agent of another seq gets that seq\'s folder', async ($, on) => {
    const b = `${LOOP_DIR}/scratch/571-ss1x2k-s8`
    const w = world(on, { marker: { ...MARKER, seq: 8, scratch: b } })
    await $.agent.spawn(spawn({ ...BUILD, name: 'build-571-s8-a1' }))
    await call($, { tool: 'Bash', command: 'pwd', agentId: 'agent-1' })
    expect(w.calls[0]?.command).toContain(`TMPDIR='${b}'`)
    expect(w.calls[0]?.command).not.toContain('s7')
  })

  test('the guard still judges the original command: a refused call is refused, logged with that command, and never rewritten', async ($, on) => {
    const w = world(on, { marker: { ...MARKER, scratch: `${LOOP_DIR}/scratch/571-ss1x2k-s7` } })
    await $.agent.spawn(spawn(BUILD))
    const r = await call($, { tool: 'Bash', command: 'git push --force origin issue-571', agentId: 'agent-1' })
    expect(r.deny).toBeDefined()
    expect(w.calls).toEqual([])
    expect(companionLines(w)).toEqual([expect.objectContaining({ cause: 'guard:push', reason: 'Bash: a force push (--force) is refused: push your branch issue-571 without force' })])
    expect(JSON.stringify(companionLines(w))).not.toContain('TMPDIR')
  })

  test('a marker with no scratch, an unmapped caller and the session leave the command as it was', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    await call($, { tool: 'Bash', command: 'echo "$TMPDIR"', agentId: 'agent-1' })
    await call($, { tool: 'Bash', command: 'echo "$TMPDIR"', agentId: 'someone-else' })
    await call($, { tool: 'Bash', command: 'echo "$TMPDIR"' })
    expect(w.calls.map(c => c.command)).toEqual(['echo "$TMPDIR"', 'echo "$TMPDIR"', 'echo "$TMPDIR"'])
  })

  test('a marker whose scratch is outside <loopDir>/scratch/ reads as having none', async ($, on) => {
    const w = world(on, { marker: { ...MARKER, scratch: '/tmp/x' } })
    await $.agent.spawn(spawn(BUILD))
    await call($, { tool: 'Bash', command: 'echo hi', agentId: 'agent-1' })
    expect(w.calls[0]?.command).toBe('echo hi')
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
      { issue: 571, life: 'ss1x2k', seq: 7, cause: 'gate-fail', head, ms: 0, waitMs: 0, concurrency: null, startedAt: new Date(NOW).toISOString(), queuedBehind: 0, command: 'npm test', exitCode: 1 },
      { issue: 571, life: 'ss1x2k', seq: 7, cause: 'gate-pass', head, ms: 0, waitMs: 0, concurrency: null, startedAt: new Date(NOW).toISOString(), queuedBehind: 0 },
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

  describe('turns: at most gateConcurrency gates at once (10.6)', () => {
    const STOP = { agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false }
    const withLimit = { ...MARKER, gateConcurrency: 1 }
    // deferred: a promise the test settles by hand
    const deferred = () => {
      let go: () => void = () => undefined
      const promise = new Promise<void>(resolve => {
        go = resolve
      })
      return { promise, go }
    }
    const settle = async () => {
      for (let i = 0; i < 300; i++) await Promise.resolve()
    }
    // two writers in one slot's marker: agent-1 and agent-2 both finish
    async function two($: Engine) {
      await $.agent.spawn(spawn(BUILD))
      await $.agent.spawn(spawn(BUILD))
    }
    const stop = ($: Engine, id: string) => $.classic.SubagentStop({ agent_id: id, ...STOP })

    test('the second gate\'s command does not start until the first ends; it logs gate-wait and its wait', async ($, on) => {
      const first = deferred()
      const w = world(on, { marker: withLimit, hold: n => (n === 1 ? first.promise : undefined) })
      await two($)
      const p1 = stop($, 'agent-1')
      const p2 = stop($, 'agent-2')
      await settle()
      expect(w.gateRuns.map(g => g.command)).toEqual(['npm run lint'])
      await w.clock.advance(7_000)
      first.go()
      await Promise.all([p1, p2])
      expect(w.gateRuns.map(g => g.command)).toEqual(['npm run lint', 'npm test', 'npm run lint', 'npm test'])
      const lines = companionLines(w)
      expect(lines.map(l => l.cause)).toEqual(['gate-pass', 'gate-wait', 'gate-pass'])
      // startedAt is the clock before the turn was asked for, so the queued gate's is not its start after the wait
      const asked = new Date(NOW).toISOString()
      expect(lines[0]).toMatchObject({ waitMs: 0, concurrency: 1, startedAt: asked, queuedBehind: 0 })
      expect(lines[1]).toMatchObject({ waitMs: 7_000, queuedBehind: 1, concurrency: 1 })
      expect(lines[2]).toMatchObject({ waitMs: 7_000, concurrency: 1, startedAt: asked, queuedBehind: 1 })
      expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ result: 'pass', waitMs: 7_000 })
    })

    test('a marker with no limit runs both gates at once', async ($, on) => {
      const first = deferred()
      const w = world(on, { hold: n => (n === 1 ? first.promise : undefined) })
      await two($)
      const p1 = stop($, 'agent-1')
      const p2 = stop($, 'agent-2')
      await settle()
      // the second writer's gate ran to its end while the first's lint is still pending
      expect(w.gateRuns.map(g => g.command)).toEqual(['npm run lint', 'npm run lint', 'npm test'])
      first.go()
      await Promise.all([p1, p2])
      expect(companionLines(w).map(l => l.cause)).toEqual(['gate-pass', 'gate-pass'])
      expect(companionLines(w)[0]).toMatchObject({ concurrency: null, startedAt: new Date(NOW).toISOString(), queuedBehind: 0 })
    })

    test('a failing first gate gives its turn back', async ($, on) => {
      const first = deferred()
      const w = world(on, { marker: withLimit, gates: [{ exitCode: 1, output: 'not ok\n' }], hold: n => (n === 1 ? first.promise : undefined) })
      await two($)
      const p1 = stop($, 'agent-1')
      const p2 = stop($, 'agent-2')
      await settle()
      first.go()
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.block).toContain('exited 1')
      expect(r2.block).toBeUndefined()
      expect(companionLines(w).map(l => l.cause)).toEqual(['gate-fail', 'gate-wait', 'gate-pass'])
    })

    test('a first gate whose hook throws gives its turn back', async ($, on) => {
      const first = deferred()
      // an output that is no text makes the hook itself throw while the turn is held
      const w = world(on, { marker: withLimit, gates: [{ exitCode: 1, output: undefined as unknown as string }], hold: n => (n === 1 ? first.promise : undefined) })
      await two($)
      const p1 = stop($, 'agent-1')
      const p2 = stop($, 'agent-2')
      await settle()
      first.go()
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.block).toBeUndefined()
      expect(r2.block).toBeUndefined()
      expect(companionLines(w).map(l => l.cause)).toEqual(['gate-unknown', 'gate-wait', 'gate-pass'])
      expect(companionLines(w)[0]).toMatchObject({ reason: expect.stringMatching(/^the stop gate hook failed \(.+output.+\)$/) })
      // the catch path's bare line is unchanged: it has no waitMs, startedAt or queuedBehind
      expect(companionLines(w)[0]).not.toHaveProperty('startedAt')
      expect(companionLines(w)[0]).not.toHaveProperty('waitMs')
    })

    // a held command over 10 s of real time fails the world's own process.run (a handler with the same budget), so each of the first writer's two commands is held for about 6 s
    const heldSix = (first: { promise: Promise<void> }) => (n: number) => (n <= 2 ? new Promise<void>(resolve => setTimeout(resolve, 6_000)) : n === 0 ? first.promise : undefined)

    test('a gate queued for more than 10 s of real time is not cut off: it logs gate-wait and passes', { timeoutMs: 30_000 }, async ($, on) => {
      const w = world(on, { marker: withLimit, hold: heldSix(deferred()) })
      await two($)
      const [r1, r2] = await Promise.all([stop($, 'agent-1'), stop($, 'agent-2')])
      expect(r1.block).toBeUndefined()
      expect(r2.block).toBeUndefined()
      expect(companionLines(w).map(l => l.cause)).toEqual(['gate-pass', 'gate-wait', 'gate-pass'])
      expect(w.sleeps).toBeGreaterThan(0)
      expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ result: 'pass' })
    })

    test('a gate queued for more than 10 s still blocks the finish when it fails', { timeoutMs: 30_000 }, async ($, on) => {
      const w = world(on, { marker: withLimit, gates: [{ exitCode: 0, output: 'ok\n' }, { exitCode: 0, output: 'ok\n' }, { exitCode: 1, output: 'not ok\n' }], hold: heldSix(deferred()) })
      await two($)
      const [r1, r2] = await Promise.all([stop($, 'agent-1'), stop($, 'agent-2')])
      expect(r1.block).toBeUndefined()
      expect(r2.block).toContain('exited 1')
      expect(companionLines(w).map(l => l.cause)).toEqual(['gate-pass', 'gate-wait', 'gate-fail'])
    })

    test('a wait past gateWaitTimeoutMs is gate-unknown with the wait\'s why, and the gate never runs; the holder is unaffected', async ($, on) => {
      const first = deferred()
      const w = world(on, { marker: { ...withLimit, gateWaitTimeoutMs: 60_000 }, hold: n => (n === 1 ? first.promise : undefined) })
      await two($)
      const p1 = stop($, 'agent-1')
      const p2 = stop($, 'agent-2')
      await settle()
      await w.clock.advance(60_000)
      expect((await p2).block).toBeUndefined()
      expect(w.gateRuns.map(g => g.command)).toEqual(['npm run lint'])
      expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ result: 'unknown', waitMs: 60_000 })
      first.go()
      await p1
      const lines = companionLines(w)
      expect(lines.map(l => l.cause)).toEqual(['gate-unknown', 'gate-pass'])
      expect(lines[0]).toMatchObject({ waitMs: 60_000, concurrency: 1, startedAt: new Date(NOW).toISOString(), queuedBehind: 1 })
      expect(String(lines[0]?.reason)).toContain('waited 60 s for a turn')
      // the turn the timed-out waiter never took is free: a third gate runs at once
      await $.agent.spawn(spawn(BUILD))
      await stop($, 'agent-3')
      expect(companionLines(w).at(-1)).toMatchObject({ cause: 'gate-pass', waitMs: 0 })
    })
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

// check: a tool.check as the engine raises it from an agent's loop
const check = ($: Engine, input: Record<string, unknown>) => $.tool.check(input as unknown as Parameters<Engine['tool']['check']>[0])
const SESSION_TRANSCRIPT = '/c/projects/p/s1.jsonl'
const AGENT_TRANSCRIPT = '/c/projects/p/s1/subagents/agent-agent-1.jsonl'
const RM = { tool: 'Bash', input: { command: 'rm -f $D/*' }, agentId: 'agent-1' }
const noteOf = (argv: string[]) => Object.fromEntries((argv[argv.indexOf('--note') + 1] ?? '').split(' ').map(t => [t.slice(0, t.indexOf('=')), decodeURIComponent(t.slice(t.indexOf('=') + 1))]))

describe('prompts nobody answers', () => {
  test('a loop agent\'s call that Claude Code would ask about is denied, said, written and logged', async ($, on) => {
    // #674: `rm -f $D/*` waited for ever on a prompt nobody answered
    const w = world(on)
    w.decided = { decision: 'ask', reason: 'rm of a glob under a variable', decider: 'permission-check' }
    await $.agent.spawn(spawn(BUILD))
    await $.classic.SubagentStart({ agent_id: 'agent-1', agent_type: 'factory-loop:builder', transcript_path: SESSION_TRANSCRIPT } as never)
    const r = await check($, RM)
    expect(r.decision).toBe('deny')
    const reason = (r as { reason: string }).reason
    expect(reason.startsWith('factory-loop-workspace:')).toBe(true)
    expect(reason).toContain('"${D:?}"/*')
    expect(reason).toContain('rm of a glob under a variable')
    expect(reason).toContain('Find another way')
    expect(reason).toContain('end your step saying what you needed')
    expect(w.events).toHaveLength(1)
    const argv = w.events[0] as string[]
    expect(argv.slice(0, 2)).toEqual(['callum-flow-event', 'prompt_denied'])
    expect(argv.join(' ')).toContain('--issue 571 --branch issue-571')
    expect(argv).not.toContain('--pr')
    expect(noteOf(argv)).toEqual({
      life: 'ss1x2k',
      seq: '7',
      step: 'build',
      attempt: '1',
      agent: 'agent-1',
      agent_type: 'factory-loop:builder',
      tool: 'Bash',
      slot: SLOT,
      session: 's1',
      transcript: AGENT_TRANSCRIPT,
      why: expect.stringContaining('rm of a glob under a variable'),
      input: 'rm -f $D/*',
    })
    expect(companionLines(w)).toEqual([expect.objectContaining({ issue: 571, life: 'ss1x2k', seq: 7, cause: 'prompt-denied', reason: expect.stringContaining('Bash: factory-loop-workspace:') })])
  })

  test('the safe rewrite of the same command is allowed, with no event and no line', async ($, on) => {
    const w = world(on)
    w.decided = { decision: 'allow' }
    await $.agent.spawn(spawn(BUILD))
    expect(await check($, { tool: 'Bash', input: { command: 'rm -f "${D:?}"/*' }, agentId: 'agent-1' })).toEqual({ decision: 'allow' })
    expect(w.events).toEqual([])
    expect(companionLines(w)).toEqual([])
  })

  test('a deny of Claude Code\'s own comes back as it was, untouched', async ($, on) => {
    const w = world(on)
    w.decided = { decision: 'deny', reason: 'no' }
    await $.agent.spawn(spawn(BUILD))
    expect(await check($, RM)).toEqual({ decision: 'deny', reason: 'no' })
    expect(w.events).toEqual([])
  })

  test('a command that is no rm of a glob gets no rewrite, and one without a reason quotes none', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    const r = (await check($, { tool: 'Bash', input: { command: 'curl https://example.com' }, agentId: 'agent-1' })) as { reason: string }
    expect(r.reason).not.toContain(':?')
    expect(r.reason).not.toContain("Claude Code's own reason")
    expect(noteOf(w.events[0] as string[])).toMatchObject({ why: 'none', transcript: 'none' })
  })

  test('a child of the loop agent is denied and logged with its own agent type', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    await $.agent.spawn(spawn({ subagentType: 'Explore', description: 'look', prompt: 'look around', parentAgentId: 'agent-1' }))
    expect((await check($, { ...RM, agentId: 'agent-2' })).decision).toBe('deny')
    expect(noteOf(w.events[0] as string[])).toMatchObject({ agent: 'agent-2', agent_type: 'Explore', step: 'build', attempt: '1' })
  })

  test('the main session and an agent the companion does not know are left to Claude Code', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    expect(await check($, { tool: 'Bash', input: { command: 'rm -f $D/*' } })).toEqual({ decision: 'ask' })
    expect(await check($, { ...RM, agentId: 'someone-else' })).toEqual({ decision: 'ask' })
    expect(w.events).toEqual([])
    expect(companionLines(w)).toEqual([])
    // each asked the engine once
    expect(w.checked).toHaveLength(2)
  })

  test('a long input is clipped to the constant', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    await check($, { tool: 'Bash', input: { command: `echo ${'x'.repeat(5000)}` }, agentId: 'agent-1' })
    expect(noteOf(w.events[0] as string[]).input).toHaveLength(INPUT_CLIP)
    await check($, { tool: 'Write', input: { file_path: '/x', content: 'y'.repeat(5000) }, agentId: 'agent-1' })
    const input = noteOf(w.events[1] as string[]).input as string
    expect(input).toHaveLength(INPUT_CLIP)
    expect(input.startsWith('{"file_path":"/x"')).toBe(true)
  })

  test('an image whose callum-flow-event refuses the state still gets the deny and the line', async ($, on) => {
    const w = world(on, { eventExit: 2 })
    await $.agent.spawn(spawn(BUILD))
    expect((await check($, RM)).decision).toBe('deny')
    expect(w.events).toHaveLength(1)
    expect(companionLines(w).map(l => l.cause)).toEqual(['prompt-denied'])
  })

  test('a marker with a pr gives --pr, and one without gives none', async ($, on) => {
    const w = world(on, { marker: { ...MARKER, pr: 612 } })
    await $.agent.spawn(spawn(BUILD))
    await check($, RM)
    expect(w.events[0]?.join(' ')).toContain('--pr 612')
  })
})

describe('permission prompts waiting', () => {
  const note = { message: 'Claude needs your permission to use Bash', title: 'Permission needed', hook_event_name: 'Notification' as const }

  test('a mapped agent\'s permission prompt is a prompt_waiting event, and passes on', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    await $.classic.SubagentStart({ agent_id: 'agent-1', agent_type: 'factory-loop:builder', transcript_path: SESSION_TRANSCRIPT } as never)
    await $.classic.Notification({ ...note, notification_type: 'permission_prompt', agent_id: 'agent-1' } as never)
    expect(w.events).toHaveLength(1)
    expect((w.events[0] as string[]).slice(0, 2)).toEqual(['callum-flow-event', 'prompt_waiting'])
    expect(noteOf(w.events[0] as string[])).toMatchObject({ agent: 'agent-1', agent_type: 'factory-loop:builder', input: note.message, transcript: AGENT_TRANSCRIPT, tool: 'none', seq: '7' })
    await $.classic.Notification({ ...note, notification_type: 'worker_permission_prompt', agent_id: 'agent-1' } as never)
    expect(w.events).toHaveLength(2)
  })

  test('no agent, an unmapped one, or another kind of notification logs nothing', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    await $.classic.Notification({ ...note, notification_type: 'permission_prompt' } as never)
    await $.classic.Notification({ ...note, notification_type: 'permission_prompt', agent_id: 'someone-else' } as never)
    await $.classic.Notification({ ...note, notification_type: 'idle_prompt', agent_id: 'agent-1' } as never)
    expect(w.events).toEqual([])
  })
})
