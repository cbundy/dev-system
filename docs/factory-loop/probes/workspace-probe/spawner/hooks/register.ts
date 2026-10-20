// The workspace probe's spawner (docs/factory-loop/v2/SPEC.md 10.9): it stands in for the factory
// loop. Like the loop, it spawns its agent from a $.clock timer that its session.start scheduled,
// so no hook frame of this plugin is open when the spawn is raised. README.md beside this folder
// says how to run it and what each case shows. PROBE_RUN (an absolute folder) and PROBE_CASE pick
// the case:
//   control      - the agent runs `sleep 150` with no timeout argument and nothing set
//   envset-start - the same, after this module's session.start called $.env.set (the loop's shape)
//   envset-timer - the same, after a timer callback (no frame open) called $.env.set
//   gate         - the agent starts in <run>/slot through the helper plugin's agent.spawn hook,
//                  writes done.txt, tries a write outside the slot, and finishes; the helper's
//                  classic.SubagentStop runs a 75 s gate with $.process.run; once it answered,
//                  a message resumes it, as the loop's repair message does, to show the resumed
//                  agent keeps its slot and its guard
//   gate-queue-bare   - the agent starts in <run>/slot and finishes at once; the helper's
//                  classic.SubagentStop then waits about 540 s in host-call slices and runs a
//                  300 s command, the shape of a queued gate in the companion (SPEC 10.6)
// Every observation is one JSON line in <run>/log.jsonl.
import type { EngineInterface, Register } from 'claude-code'

const SLEEP =
  'Run exactly this one Bash command, as given: `date -u +%T; sleep 150; date -u +%T`. Do not pass a timeout parameter and do not set run_in_background. Run no other command. When it returns, reply with its exact output and one line saying whether it ran to completion in the foreground or was moved to the background.'

const gateAsk = (slot: string) => `factory-slot: ${slot}
Steps, each its own tool call:
1. Bash: pwd
2. Write tool: file_path "done.txt", content "hello"
3. Write tool: file_path "../escape.txt", content "escaped" (it may be refused: report what you were told)
Then reply with one line per step and finish. If you are told a check failed when you finish, do what it says, then finish again.`

const queueAsk = (slot: string) => `factory-slot: ${slot}
Reply with the single word: done. Run no tool.`

const cases = new Map<string, string>()
const resumed = new Set<string>()

async function cfg($: EngineInterface) {
  return { run: (await $.env.get('PROBE_RUN')) || '/tmp/workspace-probe', probe: (await $.env.get('PROBE_CASE')) || 'control' }
}

async function log($: EngineInterface, check: string, fields: Record<string, unknown> = {}) {
  const { run } = await cfg($)
  const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), plugin: 'spawner', check, ...fields }) + '\n'
  await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', `${run}/log.jsonl`], { stdin: line, timeoutMs: 10_000 }).catch(() => undefined)
}

async function setTimeouts($: EngineInterface, where: string) {
  await $.env.set('BASH_DEFAULT_TIMEOUT_MS', '600000')
  await $.env.set('BASH_MAX_TIMEOUT_MS', '600000')
  await log($, 'env.set', { where, BASH_DEFAULT_TIMEOUT_MS: (await $.env.get('BASH_DEFAULT_TIMEOUT_MS')) ?? null })
}

// spawn: the agent, from a timer. A headless session that is not built yet refuses a spawn (seen
// once at 4 s on 2.1.300), so a refusal is tried again 2 s later, up to 10 times.
async function spawn($: EngineInterface, tries = 1) {
  const { run, probe } = await cfg($)
  try {
    const prompt = probe === 'gate' ? gateAsk(`${run}/slot`) : probe === 'gate-queue-bare' ? queueAsk(`${run}/slot`) : SLEEP
    const r = await $.agent.spawn({ subagentType: 'workspace-probe-spawner:worker', description: `workspace probe ${probe}`, prompt })
    if (r.agentId !== undefined) cases.set(r.agentId, probe)
    await log($, 'spawned', { probe, tries, agentId: r.agentId ?? null, deny: r.deny ?? null })
  } catch (err) {
    await log($, 'spawned', { probe, tries, error: String(err) })
    if (tries < 10) $.clock.after(2_000, () => void spawn($, tries + 1))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const { run, probe } = await cfg($)
    await log($, 'session.start', { run, probe, version: (await $.session.version()).version })
    if (probe === 'envset-start') await setTimeouts($, 'session.start')
    // the loop's case: every timer below fires after this hook returned, outside any frame of ours
    if (probe === 'envset-timer') $.clock.after(1_000, () => void setTimeouts($, 'timer').catch(err => log($, 'env.set', { error: String(err) })))
    $.clock.after(4_000, () => void spawn($))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined || !cases.has(e.agentId)) return r
    const probe = cases.get(e.agentId)
    await log($, 'answered', { probe, agentId: e.agentId, answer: e.answer.slice(0, 1500) })
    // the loop's repair message resumes an agent with $.session.send from its turn.complete
    // (register.ts repairTo): does the resumed agent keep its slot, and its guard?
    if (probe === 'gate' && !resumed.has(e.agentId)) {
      resumed.add(e.agentId)
      const to = e.agentId
      void $.session
        .send({ to: { agentId: to }, text: 'One more step: run the Bash command `pwd`, then try the Write tool with file_path "../escape2.txt" and content "x", and reply with what each told you.' })
        .then(sent => log($, 'resumed', { agentId: to, sent }))
        .catch(err => log($, 'resumed', { agentId: to, error: String(err) }))
    }
    return r
  }).catch(($, e, next) => next(e))
}
