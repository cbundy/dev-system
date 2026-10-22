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
const SLOT_LINE = 'factory-gate-slot: slot 0 after 0 ms\n'
const BUSY = "factory-gate-slot: busy: the container's 1 gate slots were all taken for 5 s; run a subset (npm test -- <id>) or leave the full run to the stop gate.\n"
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
function world(on: On, opts: { env?: Record<string, string>; marker?: unknown; head?: string; gates?: GateRun[]; eventExit?: number; status?: string | 'fail'; heads?: string[]; hold?: (n: number, command: string) => Promise<void> | undefined; slotAnswers?: ('slot' | 'busy')[] } = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { CLAUDE_CONFIG_DIR: CONFIG, HOME: '/home/node', ...opts.env })
  const w = {
    clock,
    session: 's1',
    spawned: [] as { name?: string; cwd?: string; parentAgentId?: string }[],
    calls: [] as Record<string, unknown>[],
    written: new Map<string, string>(),
    window: 1_000_000 as number | undefined,
    usageFails: false,
    windowWrites: [] as string[],
    appended: new Map<string, string>(),
    gateRuns: [] as { command: string; cwd?: string; timeoutMs?: number }[],
    // every `exec 2>&1` text the gate ran, wrapper and all
    wrapperRuns: [] as string[],
    // callum-flow-event's argv, and the engine's own answer to a tool.check: allow, as for a loop
    // agent that runs unattended. Since Claude Code 2.1.308 the kit's $.tool.call raises tool.check
    // first, as the engine does, so a default of ask would turn every call into the guard's deny.
    events: [] as string[][],
    checked: [] as Record<string, unknown>[],
    decided: { decision: 'allow' } as Record<string, unknown>,
    ids: 0,
    sleeps: 0,
    // what the plugin set with $.env.set, in order
    envSet: [] as [string, string | undefined][],
    // the files the plugin reads (the marker, /proc, the loop's act lock and companion log), kept as the
    // engine would: a line appended to the companion log is read back
    files: undefined as unknown as Map<string, string>,
  }
  const files = new Map<string, string>([[`${GIT_DIR}/factory-step.json`, JSON.stringify(opts.marker ?? MARKER)], ['/proc/self/stat', PROC_STAT], ['/proc/4242/stat', PROC_STAT]])
  w.files = files
  const gates = [...(opts.gates ?? [])]
  const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('env.set', (_$, e) => {
    w.envSet.push([e.name, e.value])
    return { value: undefined }
  })
  on('session.id', () => ({ value: w.session }))
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version":"9.9.9"}' }
    const text = files.get(e.path)
    // the default cgroup dir answers an empty file (no reading): a throw is slower than the stop gate's timing tests allow
    if (text === undefined && e.path.startsWith('/sys/fs/cgroup/memory.')) return { value: '' }
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('session.usage', () => {
    if (w.usageFails) throw new Error('no usage')
    return { value: { startedAt: NOW, context: { window: w.window as number, tokens: 1, percent: 1 }, rateLimits: undefined as never } }
  })
  on('fs.write', (_$, e) => {
    w.windowWrites.push(e.path)
    w.written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.written.has(e.path) }))
  // the loop dirs under the config dir, and its handshake folder
  on('fs.list', ($, e) => {
    if (e.path !== `${CONFIG}/factory-loop`) throw new Error(`ENOENT ${e.path}`)
    return { value: ['o__r', 'workspace'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
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
    if (cmd === 'git' && e.argv.at(-1) === '--porcelain') return opts.status === 'fail' ? ran('', 128) : ran(opts.status ?? '')
    if (cmd === 'git' && e.argv.at(-1) === 'HEAD') return ran(`${opts.heads?.shift() ?? '4c2d8aa0000000000000000000000000000000ff'}\n`)
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
      const text = a2.slice('exec 2>&1\n'.length)
      // a gate through the container's slot wrapper: the command is the one it runs; the slot answers come from opts.slotAnswers
      const wrapped = /^sh '[^']*\/bin\/factory-gate-slot' .* -- sh -c '(.*)'$/s.exec(text)
      w.wrapperRuns.push(text)
      if (wrapped !== null) {
        const answer = opts.slotAnswers?.shift() ?? 'slot'
        if (answer === 'busy') return ran(BUSY, 75)
      }
      const command = wrapped === null ? text : (wrapped[1] as string).replace(/'\\''/g, "'")
      w.gateRuns.push({ command, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
      // a gate command that stays pending until the test lets it go
      await opts.hold?.(w.gateRuns.length, command)
      const g = gates.shift() ?? { exitCode: 0, output: 'ok\n' }
      if (g === 'timeout') throw new Error('the child ran past its timeout and was killed')
      return ran(wrapped === null || typeof g.output !== 'string' ? g.output : `${SLOT_LINE}${g.output}`, g.exitCode)
    }
    if (cmd === 'sh' && a1 === '-c' && a2?.includes('cat >>')) {
      const path = e.argv[4] as string
      w.appended.set(path, (w.appended.get(path) ?? '') + (e.init?.stdin ?? ''))
      files.set(path, (files.get(path) ?? '') + (e.init?.stdin ?? ''))
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
const allLines = (w: { appended: Map<string, string> }) =>
  (w.appended.get(`${LOOP_DIR}/companion.jsonl`) ?? '')
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
// the lines the plugin wrote, but for the `gate-start` ones (the stop gate's own tests are about the
// lines after it; the start lines have their own tests below)
const companionLines = (w: { appended: Map<string, string> }) => allLines(w).filter(l => l.cause !== 'gate-start')

describe('the context window file', () => {
  const file = (dir: string) => `${dir}/s1`
  test('session start writes the window under DEV_CONTEXT_WINDOW_DIR, else /tmp/dev-context-window', async ($, on) => {
    const w = world(on, { env: { DEV_CONTEXT_WINDOW_DIR: '/win' } })
    await $.session.start(START)
    expect(w.written.get(file('/win'))).toBe('1000000\n')
  })

  test('with the env unset it writes /tmp/dev-context-window', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect(w.written.get(file('/tmp/dev-context-window'))).toBe('1000000\n')
  })

  test('the beat writes again only for a changed window or a new session', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.advance(60_000)
    expect(w.windowWrites).toEqual(['/tmp/dev-context-window/s1'])
    w.window = 200_000
    await w.clock.advance(60_000)
    expect(w.written.get(file('/tmp/dev-context-window'))).toBe('200000\n')
    expect(w.windowWrites).toHaveLength(2)
    w.session = 's2'
    await w.clock.advance(60_000)
    expect(w.written.get('/tmp/dev-context-window/s2')).toBe('200000\n')
  })

  for (const value of [undefined, 0, -5, 1.5]) {
    test(`a window of ${value} writes no file, and the handshake is still written`, async ($, on) => {
      const w = world(on)
      w.window = value
      await $.session.start(START)
      expect(w.windowWrites).toEqual([])
      expect(w.written.has(`${CONFIG}/factory-loop/workspace/s1.json`)).toBe(true)
    })
  }

  test('a usage that throws writes no file, and the handshake is still written', async ($, on) => {
    const w = world(on)
    w.usageFails = true
    await $.session.start(START)
    expect(w.windowWrites).toEqual([])
    expect(w.written.has(`${CONFIG}/factory-loop/workspace/s1.json`)).toBe(true)
  })
})

describe('the context window file after a reload', () => {
  test('the first turn after a /reload-plugins records the window', async ($, on) => {
    const w = world(on)
    on('turn.start', () => ({ turnId: 't1' }))
    await $.turn.start({ turnId: 't1', prompt: 'hi' } as never)
    await w.clock.advance(0)
    expect(w.written.get('/tmp/dev-context-window/s1')).toBe('1000000\n')
  })
})

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

  describe('the container\'s gate slots in an agent\'s Bash call (10.6)', () => {
    const SLOTS = `${LOOP_DIR}/gate-slots`
    test('a mapped agent\'s Bash call arrives with the prelude; the command, scratch and timeout follow it', async ($, on) => {
      const scratch = `${LOOP_DIR}/scratch/571-ss1x2k-s7`
      const w = world(on, { marker: { ...MARKER, gateConcurrency: 2, scratch } })
      await $.agent.spawn(spawn(BUILD))
      await call($, { tool: 'Bash', command: 'npm test 2>&1 | tail', agentId: 'agent-1' })
      const command = w.calls[0]?.command as string
      const [prelude, exported, original] = command.split('\n')
      expect(prelude).toMatch(/^npm\(\) \{ if /)
      expect(prelude).toContain(`--dir '${SLOTS}' --capacity 2 --wait-ms 0 --log '${LOOP_DIR}/companion.jsonl' --issue 571 --life 'ss1x2k' --seq 7 -- command npm "$@"`)
      expect(prelude).toContain('/bin/factory-gate-slot')
      expect(exported).toContain(`TMPDIR='${scratch}'`)
      expect(original).toBe('npm test 2>&1 | tail')
      expect(w.calls[0]?.timeout).toBe(600_000)
    })

    test('the wait is what the call\'s timeout leaves past the gate\'s budget', async ($, on) => {
      const w = world(on, { marker: { ...MARKER, gateConcurrency: 1, gateTimeoutMs: 120_000 } })
      await $.agent.spawn(spawn(BUILD))
      await call($, { tool: 'Bash', command: 'npm test', timeout: 600_000, agentId: 'agent-1' })
      await call($, { tool: 'Bash', command: 'npm test', agentId: 'agent-1' })
      await call($, { tool: 'Bash', command: 'npm test', timeout: 60_000, agentId: 'agent-1' })
      expect(w.calls.map(c => /--wait-ms (\d+)/.exec(c.command as string)?.[1])).toEqual(['480000', '480000', '0'])
    })

    test('the guard still judges the original command: a refusal is logged with it and nothing is rewritten', async ($, on) => {
      const w = world(on, { marker: { ...MARKER, gateConcurrency: 1 } })
      await $.agent.spawn(spawn(BUILD))
      const r = await call($, { tool: 'Bash', command: 'git push --force origin issue-571', agentId: 'agent-1' })
      expect(r.deny).toBeDefined()
      expect(w.calls).toEqual([])
      expect(JSON.stringify(companionLines(w))).not.toContain('gate-slot')
    })

    test('an older marker (no gateConcurrency) and an unmapped caller get the command as it was', async ($, on) => {
      const w = world(on)
      await $.agent.spawn(spawn(BUILD))
      await call($, { tool: 'Bash', command: 'npm test', agentId: 'agent-1' })
      await call($, { tool: 'Bash', command: 'npm test', agentId: 'someone-else' })
      expect(w.calls.map(c => c.command)).toEqual(['npm test', 'npm test'])
    })

    test('an unmapped caller gets the command as it was, whatever the marker', async ($, on) => {
      const w = world(on, { marker: { ...MARKER, gateConcurrency: 1 } })
      await $.agent.spawn(spawn(BUILD))
      await call($, { tool: 'Bash', command: 'npm test', agentId: 'someone-else' })
      expect(w.calls[0]?.command).toBe('npm test')
    })

    test('a marker with no gate command that can be wrapped adds no prelude', async ($, on) => {
      const w = world(on, { marker: { ...MARKER, gateConcurrency: 1, gateCommands: ['npm run lint && npm test', './check'] } })
      await $.agent.spawn(spawn(BUILD))
      await call($, { tool: 'Bash', command: 'npm test', agentId: 'agent-1' })
      expect(w.calls[0]?.command).toBe('npm test')
    })
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
    const w = world(on, { gates: [{ exitCode: 0, output: 'lint ok\n' }, { exitCode: 1, output: 'FAIL parses the marker\n  at x\n' }] })
    await $.agent.spawn(spawn(BUILD))
    const stop = { agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false }
    expect((await $.classic.SubagentStop(stop)).block).toContain('`npm test` exited 1')
    expect((await $.classic.SubagentStop({ ...stop, stop_hook_active: true })).block).toBeUndefined()
    const head = '4c2d8aa0000000000000000000000000000000ff'
    expect(companionLines(w).map(({ at: _at, reason: _r, ...l }) => l)).toEqual([
      { issue: 571, life: 'ss1x2k', seq: 7, cause: 'gate-fail', head, ms: 0, waitMs: 0, concurrency: null, startedAt: new Date(NOW).toISOString(), queuedBehind: 0, clean: true, memStartBytes: null, memPeakBytes: null, memLimitBytes: null, memSamples: 0, command: 'npm test', exitCode: 1, failedTests: ['parses the marker'] },
      { issue: 571, life: 'ss1x2k', seq: 7, cause: 'gate-pass', head, ms: 0, waitMs: 0, concurrency: null, startedAt: new Date(NOW).toISOString(), queuedBehind: 0, clean: true, memStartBytes: null, memPeakBytes: null, memLimitBytes: null, memSamples: 0 },
    ])
  })

  describe('the gate\'s memory (FACTORY_GATE_CGROUP_DIR)', () => {
    const STOP = { agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false }
    const NONE = { memStartBytes: null, memPeakBytes: null, memLimitBytes: null, memSamples: 0 }

    test('a readable cgroup puts the start, the peak, the limit and the sample count on the pass line', async ($, on) => {
      const w = world(on, { env: { FACTORY_GATE_CGROUP_DIR: '/cg' } })
      w.files.set('/cg/memory.current', '3221225472\n')
      w.files.set('/cg/memory.max', '17179869184\n')
      await $.agent.spawn(spawn(BUILD))
      await $.classic.SubagentStop(STOP)
      expect(companionLines(w)[0]).toMatchObject({ cause: 'gate-pass', memStartBytes: 3221225472, memPeakBytes: 3221225472, memLimitBytes: 17179869184, memSamples: 2 })
    })

    test('a limit of max is null; a failing gate carries the fields too', async ($, on) => {
      const w = world(on, { env: { FACTORY_GATE_CGROUP_DIR: '/cg' }, gates: [{ exitCode: 0, output: '' }, { exitCode: 1, output: 'FAIL x\n' }] })
      w.files.set('/cg/memory.current', '100')
      w.files.set('/cg/memory.max', 'max\n')
      await $.agent.spawn(spawn(BUILD))
      await $.classic.SubagentStop(STOP)
      expect(companionLines(w)[0]).toMatchObject({ cause: 'gate-fail', memStartBytes: 100, memPeakBytes: 100, memLimitBytes: null, memSamples: 2 })
    })

    test('a missing dir writes nulls and a zero count, and the gate\'s result and factory-gate.json are as without the sampler', async ($, on) => {
      const w = world(on, { env: { FACTORY_GATE_CGROUP_DIR: '/nonexistent' } })
      await $.agent.spawn(spawn(BUILD))
      const r = await $.classic.SubagentStop(STOP)
      expect(r.block).toBeUndefined()
      expect(companionLines(w)[0]).toMatchObject({ cause: 'gate-pass', ...NONE })
      const record = JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')
      expect(record).toMatchObject({ result: 'pass' })
      expect(Object.keys(record).filter(k => k.startsWith('mem'))).toEqual([])
    })
  })

  for (const [status, clean] of [['', true], [' M a.ts\n', false], ['fail', null]] as const) {
    test(`the slot's tree is read before the gate: ${JSON.stringify(status)} is clean ${clean}`, async ($, on) => {
      const w = world(on, { status })
      await $.agent.spawn(spawn(BUILD))
      await $.classic.SubagentStop({ agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false })
      expect(companionLines(w)[0]).toMatchObject({ cause: 'gate-pass', clean })
      expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ clean })
    })
  }

  test('a head that moved during the gate is never clean', async ($, on) => {
    const w = world(on, { heads: ['4c2d8aa0000000000000000000000000000000ff', '5d3e9bb0000000000000000000000000000000ee'] })
    await $.agent.spawn(spawn(BUILD))
    await $.classic.SubagentStop({ agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false })
    expect(companionLines(w)[0]).toMatchObject({ cause: 'gate-pass', clean: false, head: '5d3e9bb0000000000000000000000000000000ee' })
  })

  test('a failure names its tests from the full output, past the tail', async ($, on) => {
    const output = `FAIL first one\n  at x\n${Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')}\n`
    const w = world(on, { gates: [{ exitCode: 0, output: '' }, { exitCode: 1, output }] })
    await $.agent.spawn(spawn(BUILD))
    await $.classic.SubagentStop({ agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false })
    expect(companionLines(w)[0]).toMatchObject({ cause: 'gate-fail', failedTests: ['first one'] })
    expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ failedTests: ['first one'] })
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
    // the gates' host calls (git, the memory sampler's reads) are real asynchronous hops: yield to the event loop between microtask turns
    const settle = async () => {
      for (let i = 0; i < 20; i++) {
        for (let j = 0; j < 300; j++) await Promise.resolve()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
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

    test('a second gate waits 9 minutes behind the first, then runs 5 minutes of commands and passes (the Done-when)', async ($, on) => {
      const first = deferred()
      // the second gate's two commands take 150 s each of clock time
      let w: ReturnType<typeof world> | undefined
      w = world(on, { marker: withLimit, hold: n => (n === 1 ? first.promise : n > 2 ? w?.clock.advance(150_000) : undefined) })
      await two($)
      const p1 = stop($, 'agent-1')
      const p2 = stop($, 'agent-2')
      await settle()
      await w.clock.advance(540_000)
      first.go()
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.block).toBeUndefined()
      expect(r2.block).toBeUndefined()
      const lines = companionLines(w)
      expect(lines.map(l => l.cause)).toEqual(['gate-pass', 'gate-wait', 'gate-pass'])
      expect(lines[1]).toMatchObject({ cause: 'gate-wait', waitMs: 540_000 })
      expect(lines[2]).toMatchObject({ cause: 'gate-pass', ms: 300_000, waitMs: 540_000 })
      // the first command of the queued gate gets the whole gateTimeoutMs, not what the wait left
      expect(w.gateRuns[2]).toMatchObject({ command: 'npm run lint', timeoutMs: 600_000 })
      // a slice of waiting for a slot is added to what is left (600 s less the 150 s the first command ran)
      expect(w.gateRuns[3]).toMatchObject({ command: 'npm test', timeoutMs: 455_000 })
    })

    describe('the container\'s gate slots (10.6)', () => {
      const SLOT_DIR = `${LOOP_DIR}/gate-slots`
      const lastLine = (w: ReturnType<typeof world>) => companionLines(w).at(-1) as Record<string, unknown>

      test('each command runs through the wrapper with a short wait, and a marker with no limit runs none', async ($, on) => {
        const w = world(on, { marker: withLimit })
        await $.agent.spawn(spawn(BUILD))
        await stop($, 'agent-1')
        expect(w.wrapperRuns).toHaveLength(2)
        expect(w.wrapperRuns[0]).toMatch(new RegExp(`^sh '[^']*/bin/factory-gate-slot' --dir '${SLOT_DIR}' --capacity 1 --wait-ms 5000 -- sh -c 'npm run lint'$`))
        expect(w.gateRuns.map(g => g.command)).toEqual(['npm run lint', 'npm test'])
      })

      test('a marker with no limit runs its commands as they are, with no wrapper', async ($, on) => {
        const w = world(on)
        await $.agent.spawn(spawn(BUILD))
        await stop($, 'agent-1')
        expect(w.wrapperRuns).toEqual(['npm run lint', 'npm test'])
      })

      test('a busy answer, then a slot: a pass whose waitMs includes the slot wait, and slotWaitMs says it; the wait is not the gate\'s time', async ($, on) => {
        const w = world(on, { marker: withLimit, slotAnswers: ['busy', 'busy', 'slot'] })
        await $.agent.spawn(spawn(BUILD))
        const r = await stop($, 'agent-1')
        expect(r.block).toBeUndefined()
        // lint was asked three times (two refusals), test once
        expect(w.wrapperRuns).toHaveLength(4)
        expect(w.gateRuns.map(g => g.command)).toEqual(['npm run lint', 'npm test'])
        expect(lastLine(w)).toMatchObject({ cause: 'gate-pass', waitMs: 10_000, slotWaitMs: 10_000, concurrency: 1 })
        expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ result: 'pass', waitMs: 10_000, slotWaitMs: 10_000 })
        // the budget the command got is the whole one: the slot wait is not taken from it
        expect(w.gateRuns[0]).toMatchObject({ timeoutMs: 600_000 })
      })

      test('a gate that got its slots at once has slotWaitMs 0; the wrapper\'s line is gone from a failure\'s tail', async ($, on) => {
        const w = world(on, { marker: withLimit, gates: [{ exitCode: 0, output: 'lint ok\n' }, { exitCode: 1, output: 'not ok 1 - x\n' }] })
        await $.agent.spawn(spawn(BUILD))
        const r = await stop($, 'agent-1')
        expect(r.block).toContain('not ok 1 - x')
        expect(r.block).not.toContain('factory-gate-slot')
        expect(lastLine(w)).toMatchObject({ cause: 'gate-fail', waitMs: 0, slotWaitMs: 0 })
      })

      test('a gate without a limit has no slotWaitMs', async ($, on) => {
        const w = world(on)
        await $.agent.spawn(spawn(BUILD))
        await stop($, 'agent-1')
        expect(lastLine(w)).not.toHaveProperty('slotWaitMs')
      })

      test('busy past the cap is gate-unknown naming the slot wait, never a pass, and no command runs', async ($, on) => {
        const w = world(on, { marker: { ...withLimit, gateWaitTimeoutMs: 20_000 }, slotAnswers: Array<'busy'>(20).fill('busy') })
        await $.agent.spawn(spawn(BUILD))
        const r = await stop($, 'agent-1')
        expect(r.block).toBeUndefined()
        expect(w.gateRuns).toEqual([])
        expect(lastLine(w)).toMatchObject({ cause: 'gate-unknown', slotWaitMs: 20_000, waitMs: 20_000 })
        expect(String(lastLine(w).reason)).toContain('gate slot')
        expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ result: 'unknown' })
      })
    })

    const STALL = 'CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS'

    test('a writer with gates raises the engine\'s stall limit to cover its wait and run (the default wait, gateTimeoutMs, a margin)', async ($, on) => {
      const w = world(on, { marker: withLimit })
      await $.agent.spawn(spawn(BUILD))
      expect(w.envSet).toEqual([[STALL, String(30 * 60_000 + MARKER.gateTimeoutMs + 5 * 60_000)]])
    })

    test('the stall limit follows the marker\'s own wait and run', async ($, on) => {
      const w = world(on, { marker: { ...withLimit, gateWaitTimeoutMs: 900_000, gateTimeoutMs: 1_200_000 } })
      await $.agent.spawn(spawn(BUILD))
      expect(w.envSet).toEqual([[STALL, String(900_000 + 1_200_000 + 300_000)]])
    })

    test('a limit already at or past the bound is left as it is, never lowered', async ($, on) => {
      const w = world(on, { marker: withLimit, env: { [STALL]: '9000000' } })
      await $.agent.spawn(spawn(BUILD))
      expect(w.envSet).toEqual([])
    })

    test('a marker with no concurrency limit waits for no turn: its bound is the gate\'s budget and the margin', async ($, on) => {
      const w = world(on)
      await $.agent.spawn(spawn(BUILD))
      expect(w.envSet).toEqual([[STALL, String(MARKER.gateTimeoutMs + 5 * 60_000)]])
    })

    test('a writer with no gates leaves the stall limit alone', async ($, on) => {
      const w = world(on, { marker: { ...withLimit, gateCommands: [] } })
      await $.agent.spawn(spawn(BUILD))
      expect(w.envSet).toEqual([])
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

    test('a gate that waited out carries no memory fields, the one that ran does', async ($, on) => {
      const first = deferred()
      const w = world(on, { env: { FACTORY_GATE_CGROUP_DIR: '/cg' }, marker: { ...withLimit, gateWaitTimeoutMs: 60_000 }, hold: n => (n === 1 ? first.promise : undefined) })
      w.files.set('/cg/memory.current', '5')
      await two($)
      const p1 = stop($, 'agent-1')
      const p2 = stop($, 'agent-2')
      await settle()
      await w.clock.advance(60_000)
      await p2
      first.go()
      await p1
      const [waited, ran] = companionLines(w)
      expect(waited).toMatchObject({ cause: 'gate-unknown' })
      expect(Object.keys(waited ?? {}).filter(k => k.startsWith('mem'))).toEqual([])
      expect(ran).toMatchObject({ cause: 'gate-pass', memStartBytes: 5, memPeakBytes: 5 })
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
const dataOf = (argv: string[]) => JSON.parse(argv[argv.indexOf('--data') + 1] ?? 'null') as Record<string, unknown>

// askWorld: a world whose engine would ask a person about every call
function askWorld(on: On, opts: Parameters<typeof world>[1] = {}) {
  const w = world(on, opts)
  w.decided = { decision: 'ask' }
  return w
}

describe('prompts nobody answers', () => {
  test('a loop agent\'s call that Claude Code would ask about is denied, said, written and logged', async ($, on) => {
    // #674: `rm -f $D/*` waited for ever on a prompt nobody answered
    const w = askWorld(on)
    w.decided = { decision: 'ask', reason: 'rm of a glob under a variable', decider: 'host' }
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
    expect(argv.slice(0, 4)).toEqual(['callum-flow-event', '--type', 'prompt_denied', '--data'])
    expect(argv.slice(4 + 1)).toEqual(['--issue', '571', '--repo', argv[argv.indexOf('--repo') + 1]])
    expect(argv).not.toContain('--note')
    expect(argv).not.toContain('--pr')
    expect(dataOf(argv)).toEqual({
      life: 'ss1x2k',
      seq: 7,
      step: 'build',
      attempt: 1,
      agent_id: 'agent-1',
      agent_type: 'factory-loop:builder',
      tool_name: 'Bash',
      tool_input: 'rm -f $D/*',
      ask_reason: expect.stringContaining('rm of a glob under a variable'),
      slot: SLOT,
      session: 's1',
      transcript: AGENT_TRANSCRIPT,
      branch: 'issue-571',
      pr: null,
    })
    expect(companionLines(w)).toEqual([expect.objectContaining({ issue: 571, life: 'ss1x2k', seq: 7, cause: 'prompt-denied', reason: expect.stringContaining('Bash: factory-loop-workspace:') })])
  })

  test('the safe rewrite of the same command is allowed, with no event and no line', async ($, on) => {
    const w = askWorld(on)
    w.decided = { decision: 'allow' }
    await $.agent.spawn(spawn(BUILD))
    expect(await check($, { tool: 'Bash', input: { command: 'rm -f "${D:?}"/*' }, agentId: 'agent-1' })).toEqual({ decision: 'allow' })
    expect(w.events).toEqual([])
    expect(companionLines(w)).toEqual([])
  })

  test('a deny of Claude Code\'s own comes back as it was, untouched', async ($, on) => {
    const w = askWorld(on)
    w.decided = { decision: 'deny', reason: 'no' }
    await $.agent.spawn(spawn(BUILD))
    expect(await check($, RM)).toEqual({ decision: 'deny', reason: 'no' })
    expect(w.events).toEqual([])
  })

  test('a command that is no rm of a glob gets no rewrite, and one without a reason quotes none', async ($, on) => {
    const w = askWorld(on)
    await $.agent.spawn(spawn(BUILD))
    const r = (await check($, { tool: 'Bash', input: { command: 'curl https://example.com' }, agentId: 'agent-1' })) as { reason: string }
    expect(r.reason).not.toContain(':?')
    expect(r.reason).not.toContain("Claude Code's own reason")
    expect(dataOf(w.events[0] as string[])).toMatchObject({ ask_reason: null, transcript: null })
  })

  test('a child of the loop agent is denied and logged with its own agent type', async ($, on) => {
    const w = askWorld(on)
    await $.agent.spawn(spawn(BUILD))
    await $.agent.spawn(spawn({ subagentType: 'Explore', description: 'look', prompt: 'look around', parentAgentId: 'agent-1' }))
    expect((await check($, { ...RM, agentId: 'agent-2' })).decision).toBe('deny')
    expect(dataOf(w.events[0] as string[])).toMatchObject({ agent_id: 'agent-2', agent_type: 'Explore', step: 'build', attempt: 1 })
  })

  test('the main session and an agent the companion does not know are left to Claude Code', async ($, on) => {
    const w = askWorld(on)
    await $.agent.spawn(spawn(BUILD))
    expect(await check($, { tool: 'Bash', input: { command: 'rm -f $D/*' } })).toEqual({ decision: 'ask' })
    expect(await check($, { ...RM, agentId: 'someone-else' })).toEqual({ decision: 'ask' })
    expect(w.events).toEqual([])
    expect(companionLines(w)).toEqual([])
    // each asked the engine once
    expect(w.checked).toHaveLength(2)
  })

  test('a long input is clipped to the constant', async ($, on) => {
    const w = askWorld(on)
    await $.agent.spawn(spawn(BUILD))
    await check($, { tool: 'Bash', input: { command: `echo ${'x'.repeat(5000)}` }, agentId: 'agent-1' })
    expect(dataOf(w.events[0] as string[]).tool_input).toHaveLength(INPUT_CLIP)
    await check($, { tool: 'Write', input: { file_path: '/x', content: 'y'.repeat(5000) }, agentId: 'agent-1' })
    const input = dataOf(w.events[1] as string[]).tool_input as string
    expect(input).toHaveLength(INPUT_CLIP)
    expect(input.startsWith('{"file_path":"/x"')).toBe(true)
  })

  test('an image whose callum-flow-event refuses the write still gets the deny and the line', async ($, on) => {
    const w = askWorld(on, { eventExit: 2 })
    await $.agent.spawn(spawn(BUILD))
    expect((await check($, RM)).decision).toBe('deny')
    expect(w.events).toHaveLength(1)
    expect(companionLines(w).map(l => l.cause)).toEqual(['prompt-denied'])
  })

  test('a marker with a pr gives pr in the data, and one without gives null', async ($, on) => {
    const w = askWorld(on, { marker: { ...MARKER, pr: 612 } })
    await $.agent.spawn(spawn(BUILD))
    await check($, RM)
    expect(dataOf(w.events[0] as string[]).pr).toBe(612)
    expect(w.events[0]).not.toContain('--pr')
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
    expect((w.events[0] as string[]).slice(0, 4)).toEqual(['callum-flow-event', '--type', 'prompt_waiting', '--data'])
    expect(dataOf(w.events[0] as string[])).toMatchObject({ agent_id: 'agent-1', agent_type: 'factory-loop:builder', tool_input: note.message, transcript: AGENT_TRANSCRIPT, tool_name: null, seq: 7, branch: 'issue-571' })
    expect(dataOf(w.events[0] as string[])).not.toHaveProperty('ask_reason')
    await $.classic.Notification({ ...note, notification_type: 'worker_permission_prompt', agent_id: 'agent-1' } as never)
    expect(w.events).toHaveLength(2)
  })

  test('a message over the clip is cut to 2000 characters', async ($, on) => {
    const w = world(on)
    await $.agent.spawn(spawn(BUILD))
    await $.classic.Notification({ ...note, message: 'm'.repeat(5000), notification_type: 'permission_prompt', agent_id: 'agent-1' } as never)
    expect(dataOf(w.events[0] as string[]).tool_input).toHaveLength(INPUT_CLIP)
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

describe('the gate-start line and the recovery of a gate a restart cut (10.6)', () => {
  const STOP = { agent_id: 'agent-1', agent_type: 'factory-loop:builder', agent_transcript_path: '', stop_hook_active: false }
  const iso = (ms: number) => new Date(ms).toISOString()
  // a process that is gone (nothing under /proc), and the one the world runs as (PROC_STAT)
  const DEAD = '999:111'
  const ALIVE = '4242:342070008'
  const CUT_AT = NOW - 10 * 60_000
  const start = (over: Record<string, unknown> = {}) => ({ at: iso(CUT_AT), issue: 571, life: 'ss1x2k', seq: 7, cause: 'gate-start', reason: 'the stop gate started', startedAt: iso(CUT_AT), slot: SLOT, gitDir: GIT_DIR, process: DEAD, ...over })
  const wait = (over: Record<string, unknown> = {}) => ({ at: iso(CUT_AT + 30_000), issue: 571, life: 'ss1x2k', seq: 7, cause: 'gate-wait', reason: 'waited', waitMs: 30_000, queuedBehind: 1, concurrency: 1, ...over })
  const text = (...lines: Record<string, unknown>[]) => lines.map(l => `${JSON.stringify(l)}\n`).join('')
  // the loop's session with its lease (this session is s1), the log, then a session that beats once
  async function afterRestart($: Engine, w: ReturnType<typeof world>, log: string, lock: unknown = { session: 's1', renewedAt: NOW, expiresAt: NOW + 3_600_000 }) {
    w.files.set(`${LOOP_DIR}/companion.jsonl`, log)
    if (lock !== null) w.files.set(`${LOOP_DIR}/act.lock`, JSON.stringify(lock))
    await $.session.start(START)
    await beat($, w)
  }
  // one minute of the clock: the handshake beat, and the recovery it starts, which has no hook to wait for
  async function beat($: Engine, w: ReturnType<typeof world>) {
    await w.clock.advance(60_000)
    for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  const causes = (w: ReturnType<typeof world>) => allLines(w).map(l => l.cause)

  test('SubagentStop writes gate-start before its turn, and its startedAt is the settling line\'s', async ($, on) => {
    const w = world(on, { marker: { ...MARKER, gateConcurrency: 1 } })
    await $.agent.spawn(spawn(BUILD))
    await $.classic.SubagentStop(STOP)
    const lines = allLines(w)
    expect(lines.map(l => l.cause)).toEqual(['gate-start', 'gate-pass'])
    expect(lines[0]).toMatchObject({ issue: 571, life: 'ss1x2k', seq: 7, startedAt: iso(NOW), slot: SLOT, gitDir: GIT_DIR, process: '4242:342070008' })
    expect(lines[1]).toMatchObject({ startedAt: iso(NOW) })
    expect(lines[1]).not.toHaveProperty('rerun')
  })

  test('a reader\'s or an ungated writer\'s stop writes no gate-start', async ($, on) => {
    const w = world(on, { marker: { ...MARKER, gateCommands: [] } })
    await $.agent.spawn(spawn(BUILD))
    await $.classic.SubagentStop(STOP)
    expect(allLines(w)).toEqual([])
  })

  test('the issue\'s case: a start and a wait from a dead process, no settling line: one beat re-runs the gate, a second writes nothing more', async ($, on) => {
    const w = world(on)
    await afterRestart($, w, text(start(), wait()))
    expect(causes(w)).toEqual(['gate-rerun', 'gate-pass'])
    expect(w.gateRuns.map(g => [g.command, g.cwd])).toEqual([['npm run lint', SLOT], ['npm test', SLOT]])
    const [rerun, pass] = allLines(w)
    expect(rerun).toMatchObject({ issue: 571, life: 'ss1x2k', seq: 7, cutStartedAt: iso(CUT_AT), process: DEAD, slot: SLOT, gitDir: GIT_DIR, marker: { issue: 571, life: 'ss1x2k', seq: 7 } })
    expect(rerun?.reason).toContain(iso(CUT_AT))
    expect(pass).toMatchObject({ rerun: true, startedAt: iso(NOW + 60_000), clean: true })
    expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ result: 'pass' })
    await beat($, w)
    expect(causes(w)).toEqual(['gate-rerun', 'gate-pass'])
    expect(w.gateRuns).toHaveLength(2)
  })

  test('the #1065 case: a lone gate-start (the gate took its turn at once) is recovered', async ($, on) => {
    const w = world(on)
    await afterRestart($, w, text(start()))
    expect(causes(w)).toEqual(['gate-rerun', 'gate-pass'])
    expect(allLines(w)[1]).toMatchObject({ rerun: true })
  })

  test('a failing re-run writes gate-fail with rerun: true and blocks nothing', async ($, on) => {
    const w = world(on, { gates: [{ exitCode: 0, output: 'lint ok\n' }, { exitCode: 1, output: 'FAIL parses the marker\n' }] })
    await afterRestart($, w, text(start()))
    expect(causes(w)).toEqual(['gate-rerun', 'gate-fail'])
    expect(allLines(w)[1]).toMatchObject({ rerun: true, command: 'npm test', exitCode: 1, failedTests: ['parses the marker'] })
    expect(JSON.parse(w.written.get(`${GIT_DIR}/factory-gate.json`) ?? '{}')).toMatchObject({ result: 'fail' })
  })

  test('a re-run uses a turn like a stop gate: it waits behind the limit and logs gate-wait', async ($, on) => {
    const w = world(on, { marker: { ...MARKER, gateConcurrency: 1 } })
    await afterRestart($, w, text(start()))
    expect(causes(w)).toEqual(['gate-rerun', 'gate-pass'])
    expect(allLines(w)[1]).toMatchObject({ rerun: true, concurrency: 1 })
  })

  for (const [what, marker] of [['another seq', { ...MARKER, seq: 8 }], ['another issue', { ...MARKER, issue: 572 }], ['another life', { ...MARKER, life: 'other' }], ['a reader', { ...MARKER, role: 'reader' }], ['no gate commands', { ...MARKER, gateCommands: [] }]] as const) {
    test(`a marker that names ${what} gives one gate-cut with its why, and no command runs`, async ($, on) => {
      const w = world(on, { marker })
      await afterRestart($, w, text(start()))
      expect(causes(w)).toEqual(['gate-cut'])
      expect(allLines(w)[0]).toMatchObject({ issue: 571, seq: 7, cutStartedAt: iso(CUT_AT), process: DEAD })
      expect(w.gateRuns).toEqual([])
    })
  }

  test('a missing marker is a gate-cut that says so', async ($, on) => {
    const w = world(on)
    w.files.delete(`${GIT_DIR}/factory-step.json`)
    await afterRestart($, w, text(start()))
    expect(causes(w)).toEqual(['gate-cut'])
    expect(allLines(w)[0]?.reason).toContain('no readable step marker')
    expect(w.gateRuns).toEqual([])
  })

  const settle = (cause: string, at: number) => ({ ...wait(), cause, at: iso(at) })
  const left: [string, string][] = [
    ['a start line from a live process', text(start({ process: ALIVE }))],
    ['a settled attempt (gate-pass)', text(start(), settle('gate-pass', CUT_AT + 60_000))],
    ['a settled attempt (gate-fail)', text(start(), settle('gate-fail', CUT_AT + 60_000))],
    ['a settled attempt (gate-unknown)', text(start(), settle('gate-unknown', CUT_AT + 60_000))],
    ['an attempt already re-run', text(start(), settle('gate-rerun', CUT_AT + 60_000))],
    ['an attempt already cut', text(start(), settle('gate-cut', CUT_AT + 60_000))],
    ['a refused finish and a live stop after it', text(start(), settle('gate-fail', CUT_AT + 60_000), start({ at: iso(CUT_AT + 120_000), process: ALIVE }))],
    ['a start line older than 24 h', text(start({ at: iso(NOW - 25 * 3_600_000) }))],
  ]
  for (const [what, log] of left) {
    test(`${what} is left alone`, async ($, on) => {
      const w = world(on)
      await afterRestart($, w, log)
      expect(causes(w)).toEqual([])
      expect(w.gateRuns).toEqual([])
    })
  }

  test('a fail after a cut start, then a new start from a dead process, is open again', async ($, on) => {
    const w = world(on)
    await afterRestart($, w, text(start(), { ...wait(), cause: 'gate-fail', at: iso(CUT_AT + 60_000) }, start({ at: iso(CUT_AT + 120_000), startedAt: iso(CUT_AT + 120_000) })))
    expect(causes(w)).toEqual(['gate-rerun', 'gate-pass'])
    expect(allLines(w)[0]?.reason).toContain(iso(CUT_AT + 120_000))
  })

  for (const [what, lock] of [['another session\'s lease', { session: 'other', renewedAt: NOW, expiresAt: NOW + 3_600_000 }], ['an expired lease of its own', { session: 's1', renewedAt: NOW - 3_600_000, expiresAt: NOW + 1_000 }], ['no lock at all', null]] as const) {
    test(`a session with ${what} runs nothing`, async ($, on) => {
      const w = world(on)
      await afterRestart($, w, text(start()), lock)
      expect(causes(w)).toEqual([])
      expect(w.gateRuns).toEqual([])
    })
  }

  test('the lock is checked on each beat until it is held: the recovery runs on the beat after the session takes it', async ($, on) => {
    const w = world(on)
    await afterRestart($, w, text(start()), { session: 'other', renewedAt: NOW, expiresAt: NOW + 3_600_000 })
    expect(causes(w)).toEqual([])
    w.files.set(`${LOOP_DIR}/act.lock`, JSON.stringify({ session: 's1', renewedAt: NOW, expiresAt: NOW + 3_600_000 }))
    await beat($, w)
    expect(causes(w)).toEqual(['gate-rerun', 'gate-pass'])
  })

  // this process started at btime + 342070008 ticks of 10 ms
  const BOOT_TO_START_S = 3_420_700
  const oldLine = () => start({ process: undefined, slot: undefined, gitDir: undefined })
  test('a line with no process (a companion before it) that predates this process is dead; with no slot named it is cut', async ($, on) => {
    const w = world(on)
    w.files.set('/proc/stat', `cpu 1 2 3\nbtime ${Math.floor(NOW / 1000) - BOOT_TO_START_S + 3_000}\n`)
    await afterRestart($, w, text(oldLine()))
    expect(causes(w)).toEqual(['gate-cut'])
    expect(allLines(w)[0]?.reason).toContain('names no slot')
  })

  test('a line with no process written after this process started is left alone', async ($, on) => {
    const w = world(on)
    w.files.set('/proc/stat', `cpu 1 2 3\nbtime ${Math.floor(NOW / 1000) - BOOT_TO_START_S - 3_000}\n`)
    await afterRestart($, w, text(oldLine()))
    expect(causes(w)).toEqual([])
  })

  test('a line with no process, when this process\'s start cannot be read, is left alone', async ($, on) => {
    const w = world(on)
    await afterRestart($, w, text(oldLine()))
    expect(causes(w)).toEqual([])
  })

  test('a gate-wait with no start line from a companion before gate-start is cut, as it has no slot', async ($, on) => {
    const w = world(on)
    w.files.set('/proc/stat', `btime ${Math.floor(NOW / 1000) + 10_000}\n`)
    await afterRestart($, w, text(wait()))
    expect(causes(w)).toEqual(['gate-cut'])
  })

  test('every candidate of the log is judged: two attempts, one re-run and one cut', async ($, on) => {
    const w = world(on)
    await afterRestart($, w, text(start({ issue: 572, seq: 3 }), start()))
    expect(allLines(w).map(l => [l.cause, l.issue])).toEqual([['gate-cut', 572], ['gate-rerun', 571], ['gate-pass', 571]])
  })

  test('a gate that cannot run in the re-run is a gate-unknown with rerun: true', async ($, on) => {
    const w = world(on, { gates: ['timeout'] })
    await afterRestart($, w, text(start()))
    expect(causes(w)).toEqual(['gate-rerun', 'gate-unknown'])
    expect(allLines(w)[1]).toMatchObject({ rerun: true })
  })
})
