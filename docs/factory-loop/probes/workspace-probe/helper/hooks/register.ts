// The workspace probe's helper (docs/factory-loop/v2/SPEC.md 10.9): a plugin other than the
// spawner, in the companion plugin's role. Its agent.spawn hook starts an agent whose prompt opens
// with `factory-slot: <path>` in that folder and maps the agent's id to it; its tool.call hook logs
// the agent's calls and refuses a Write outside the slot; its classic.SubagentStop hook runs a gate
// of about 75 s in the slot with $.process.run and blocks the finish while it fails. In the
// gate-queue-bare case it waits 540 s in 5 s host-call slices and then runs a 300 s command, the shape of
// a queued gate in the companion (hooks/register.ts runStopGate), and logs when each ends or fails.
// In the timeout cases it only logs, so the Bash call's own `timeout` shows the agent passed none.
import type { EngineInterface, Register } from 'claude-code'

// fails until done.txt holds the line `fixed`; about 75 s either way
const GATE = 'sleep 75; if grep -qx fixed done.txt; then echo gate passed; else echo "done.txt must hold exactly the line: fixed. Write it with the Write tool." >&2; exit 2; fi'

// the gate-queue-bare case: PROBE_WAIT_S (540) of waiting in SLICE_S host-call slices (the companion's IDLE_S),
// then a PROBE_RUN_S (300) command
const SLICE_S = 5

const slotOf = new Map<string, string>()

async function cfg($: EngineInterface) {
  return { run: (await $.env.get('PROBE_RUN')) || '/tmp/workspace-probe' }
}

async function log($: EngineInterface, check: string, fields: Record<string, unknown> = {}) {
  const { run } = await cfg($)
  const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), plugin: 'helper', check, ...fields }) + '\n'
  await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', `${run}/log.jsonl`], { stdin: line, timeoutMs: 10_000 }).catch(() => undefined)
}

function norm(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

// queued: wait, then run, as the companion's runStopGate does for a gate behind another. The run's
// timeoutMs is its own 600 s, so only the engine can cut it.
async function queued($: EngineInterface, e: { agent_id: string }, next: (e: never) => Promise<unknown>, slot: string, t0: number) {
  const waitS = Number((await $.env.get('PROBE_WAIT_S')) ?? 540)
  const runS = Number((await $.env.get('PROBE_RUN_S')) ?? 300)
  await log($, 'queue-start', { agentId: e.agent_id, waitS, runS })
  const secs = async () => Math.round(((await $.clock.now()) - t0) / 1000)
  try {
    while ((await $.clock.now()) - t0 < waitS * 1000) await $.process.run(['sleep', String(SLICE_S)], { timeoutMs: SLICE_S * 1000 + 15_000 })
    await log($, 'queue-waited', { agentId: e.agent_id, secs: await secs() })
    const ran = await $.process.run(['sh', '-c', `sleep ${runS}; echo ran`], { cwd: slot, timeoutMs: 600_000 })
    await log($, 'queue-end', { agentId: e.agent_id, exitCode: ran.exitCode, secs: await secs() })
  } catch (err) {
    await log($, 'queue-error', { agentId: e.agent_id, error: String(err), secs: await secs() })
  }
  return (next as (e: unknown) => Promise<unknown>)(e)
}

export const register: Register = on => {
  on('agent.spawn', async ($, e, next) => {
    const m = /^factory-slot: (\/\S+)$/m.exec(e.prompt)
    const r = await next(m === null ? e : { ...e, cwd: m[1] })
    if (m !== null && r.agentId !== undefined) slotOf.set(r.agentId, m[1])
    await log($, 'agent.spawn', { origin: (next as unknown as { origin?: unknown }).origin ?? null, resume: e.resume?.agentId ?? null, cwdIn: e.cwd ?? null, slot: m?.[1] ?? null, agentId: r.agentId ?? null, deny: r.deny ?? null })
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const input = e as unknown as Record<string, unknown>
    const slot = slotOf.get(e.agentId) ?? null
    await log($, 'tool.call', { agentId: e.agentId, slot, tool: e.tool, command: input.command ?? null, timeout: input.timeout ?? null, file_path: input.file_path ?? null })
    if (slot !== null && e.tool === 'Write' && typeof input.file_path === 'string') {
      const p = norm(input.file_path.startsWith('/') ? input.file_path : `${slot}/${input.file_path}`)
      if (p !== slot && !p.startsWith(`${slot}/`)) {
        await log($, 'guard-deny', { agentId: e.agentId, file_path: input.file_path })
        return { deny: `workspace-probe: ${input.file_path} is outside your slot ${slot}` }
      }
    }
    const t0 = await $.clock.now()
    const r = await next(e)
    await log($, 'tool.result', { agentId: e.agentId, tool: e.tool, ms: (await $.clock.now()) - t0, isError: r.isError ?? false, text: String(r.text ?? r.deny ?? '').slice(0, 600) })
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'workspace-probe: its guard failed' }))

  on('classic.SubagentStop', async ($, e, next) => {
    const slot = slotOf.get(e.agent_id) ?? null
    if (slot === null) return next(e)
    const t0 = await $.clock.now()
    if ((await $.env.get('PROBE_CASE')) === 'gate-queue-bare') return queued($, e, next, slot, t0)
    await log($, 'gate-start', { agentId: e.agent_id, stop_hook_active: e.stop_hook_active, cwd: e.cwd })
    try {
      const ran = await $.process.run(['sh', '-c', GATE], { cwd: slot, timeoutMs: 600_000 })
      const secs = Math.round(((await $.clock.now()) - t0) / 1000)
      await log($, 'gate-end', { agentId: e.agent_id, exitCode: ran.exitCode, secs, stderr: ran.stderr.trim() })
      if (ran.exitCode !== 0) return { block: `GATE failed (exit ${ran.exitCode}) in ${slot}: ${ran.stderr.trim()}` }
    } catch (err) {
      await log($, 'gate-error', { agentId: e.agent_id, error: String(err), secs: Math.round(((await $.clock.now()) - t0) / 1000) })
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
