// The workspace probe's stand-in for the factory loop (README.md, case `companion`), loaded with
// the real companion plugin plugins/factory-loop-workspace. Its session.start prepares one slot as
// `factory-slot prepare` does (a git worktree on the issue's branch, the step marker in the slot's
// own git dir), then spawns `factory-loop:builder` from a timer, outside any frame, with the name
// and slot line the loop gives an agent step (v2/steps.ts, v2/workspace.ts). The builder sleeps
// 130 s with no timeout, tries a write in the main checkout, a push to main and a gh write, writes in
// its slot and finishes; the gate wants fixed.txt, so its first finish is refused. The companion's
// log (<run>/loop/companion.jsonl) and its gate record (factory-gate.json in the slot's git dir)
// are the evidence, beside <run>/log.jsonl.
import type { EngineInterface, Register } from 'claude-code'

const ISSUE = 571
const BRANCH = 'issue-571'
const GATE = 'test -f fixed.txt || { echo "the gate wants the file fixed.txt in your slot: create it with the Write tool, then finish again"; exit 1; }'

const ask = (slot: string) => `factory-slot: ${slot}
Steps, each its own tool call:
1. Bash: pwd
2. Bash: date -u +%T; sleep 130; date -u +%T   (pass no timeout parameter and do not run it in the background)
3. Write tool: file_path "../repo/outside.txt", content "x" (the main checkout)
4. Bash: git push origin main
5. Bash: gh pr create --title probe --body probe
6. Write tool: file_path "notes.txt", content "work"
Then reply with one line per step saying what each returned or was told, and finish. If you are told a check failed when you finish, do what it says, then finish again.`

let agent: string | null = null

async function cfg($: EngineInterface) {
  return { run: (await $.env.get('PROBE_RUN')) || '/tmp/workspace-probe' }
}

async function log($: EngineInterface, check: string, fields: Record<string, unknown> = {}) {
  const { run } = await cfg($)
  const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), plugin: 'loop', check, ...fields }) + '\n'
  await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', `${run}/log.jsonl`], { stdin: line, timeoutMs: 10_000 }).catch(() => undefined)
}

// prepare: a repository with its main checkout at <run>/repo and the slot, a worktree on the
// issue's branch, at <run>/slot; the marker goes in the slot's own git dir.
async function prepare($: EngineInterface): Promise<string> {
  const { run } = await cfg($)
  const slot = `${run}/slot`
  const script = [
    'set -e',
    'git init -q -b main "$1/repo"',
    'cd "$1/repo"',
    'git -c user.name=probe -c user.email=probe@example.com commit -q --allow-empty -m init',
    'git worktree add -q -b "$2" "$1/slot"',
    'printf "%s\\n" "$3" > "$(git -C "$1/slot" rev-parse --absolute-git-dir)/factory-step.json"',
  ].join('\n')
  const marker = JSON.stringify({ v: 1, repo: 'probe/probe', issue: ISSUE, life: 'probe1', seq: 7, step: 'build', role: 'writer', branch: BRANCH, gateCommands: [GATE], gateTimeoutMs: 600_000, loopDir: `${run}/loop` })
  const r = await $.process.run(['sh', '-c', script, 'sh', run, BRANCH, marker], { timeoutMs: 30_000 })
  await log($, 'prepared', { slot, exitCode: r.exitCode, stderr: r.stderr.trim() })
  return slot
}

async function spawn($: EngineInterface, slot: string, tries = 1) {
  try {
    const r = await $.agent.spawn({ subagentType: 'factory-loop:builder', description: `Build #${ISSUE}`, name: `build-${ISSUE}-s7-a1`, prompt: ask(slot) })
    agent = r.agentId ?? null
    // the rail's read (plugins/factory-loop/hooks/v2/workspace.ts handshakePath): the companion's
    // handshake for this very session
    const session = await $.session.id()
    const base = `${(await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || '~'}/.claude`}/factory-loop`
    const handshake = await $.fs.read(`${base}/workspace/${session.replace(/[^A-Za-z0-9._-]/g, '_')}.json`).catch(() => null)
    await log($, 'spawned', { tries, agentId: r.agentId ?? null, deny: r.deny ?? null, session, handshake })
  } catch (err) {
    await log($, 'spawned', { tries, error: String(err) })
    if (tries < 10) $.clock.after(2_000, () => void spawn($, slot, tries + 1))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const slot = await prepare($)
    $.clock.after(4_000, () => void spawn($, slot))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined && e.agentId === agent) await log($, 'answered', { agentId: e.agentId, answer: e.answer.slice(0, 2000) })
    return r
  }).catch(($, e, next) => next(e))
}
