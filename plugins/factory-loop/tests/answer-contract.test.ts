// The answer contract the loop and the answer script share (hooks/contract.mjs, #561), read
// through the loop. The answer script (bin/factory-answer) is a temporary workaround for the
// registered answer tools, which an agent the loop spawns from its timer cannot reach (#560); its
// file and the tool's input are the same answer, so both are checked by the one contract. Every
// case of the shared table (answer-cases.mjs) must read here exactly as the script, run for real
// by tests/factory-loop-answer.test.js at the repo root, names it: recorded, or refused with the
// same problems. A change to either end that the other does not share fails one of the two.
import { describe, expect, test } from 'claude-code/testing'

import { jobOf, readScriptAnswer, readToolAnswer } from '../hooks/act-agents'
import type { AnswerInfo } from '../hooks/act-agents'
import { AGENT_TOOLS, DESIGN_TOOL, HANDOFF_TOOL, TOOL_OF, VERDICT_TOOL, checkDesign, checkHandoff, checkVerdict } from '../hooks/agent-tools'
import * as contract from '../hooks/contract.mjs'
import type { Job } from '../hooks/contract.mjs'
import { scriptAnswerPath } from '../hooks/exec'
import type { AgentType, LedgerEntry } from '../hooks/types'
import { CASES, JOBS } from './answer-cases.mjs'
import type { JobName } from './answer-cases.mjs'
import { NOW, entry } from './fixtures'

const LOOP = '/cfg/factory-loop/cbundy__dev-system'
const BRIEF = 'https://github.com/cbundy/dev-system/issues/470#issuecomment-3301234567'

// The ledger entry and spawn record each job of the table stands for, as the loop holds them.
const AGENTS: Record<Exclude<JobName, 'designV2'>, { entry: LedgerEntry; type: AgentType; info: AnswerInfo }> = {
  gate: { entry: entry('adjudicate:R470:review:abc1234', 'spawn', { agent: 'adjudicator', issue: 470 }), type: 'adjudicator', info: { repo: 'cbundy/dev-system', branch: null, purpose: null } },
  weakening: { entry: entry('adjudicate-weakening:512:abc1234', 'spawn', { agent: 'adjudicator', issue: 470 }), type: 'adjudicator', info: { repo: 'cbundy/dev-system', branch: null, purpose: null } },
  merge: { entry: entry('adjudicate-merge:512:abc1234', 'spawn', { agent: 'adjudicator', issue: 470 }), type: 'adjudicator', info: { repo: 'cbundy/dev-system', branch: null, purpose: null } },
  designer: { entry: entry('design:470:1', 'spawn', { agent: 'designer', issue: 470 }), type: 'designer', info: { repo: 'cbundy/dev-system', branch: null, purpose: null } },
  implementer: { entry: entry(`delegate:470:${BRIEF}`, 'delegate', { agent: 'implementer', issue: 470 }), type: 'implementer', info: { repo: 'cbundy/dev-system', branch: null, purpose: null } },
  fixer: { entry: entry('fixer:conflict:512:abc1234', 'spawn', { agent: 'fixer', issue: 470 }), type: 'fixer', info: { repo: 'cbundy/dev-system', branch: 'feat/issue-470-x', purpose: null } },
}

// The answer file around an input, as the script writes it, whether or not the contract takes it.
const fileOf = (job: Job, input: unknown) => JSON.stringify({ v: 1, contract: job.contract, answer: input })

describe('one contract for the loop and the answer script (#561)', () => {
  test('the job the loop checks each answer against is the job file the spawn writes for the script', () => {
    for (const [name, a] of Object.entries(AGENTS) as [Exclude<JobName, 'designV2'>, (typeof AGENTS)[Exclude<JobName, 'designV2'>]][]) {
      expect(jobOf(a.entry, a.type, a.info)).toEqual(JOBS[name])
      expect(contract.parseJob(contract.jobText(JOBS[name]))).toEqual(JOBS[name])
    }
  })

  test('every case of the shared table reads through the loop as the script names it: the same outcome as the tool, or the same problems', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(10)
    for (const c of CASES) {
      const job = JOBS[c.job]
      if (c.job === 'designV2') {
        // a v2 answer is checked by its contract alone (the v2 steps read it, not the v1 tools)
        const checked = contract.checkAnswer(job, c.input)
        if (c.problems.length === 0) expect(checked.ok).toBe(true)
        else expect(checked).toEqual({ ok: false, problems: [...c.problems] })
        expect(contract.answerText(job, c.input).ok).toBe(c.problems.length === 0)
        continue
      }
      const a = AGENTS[c.job]
      const script = readScriptAnswer(a.entry, fileOf(job, c.input), a.info)
      const tool = readToolAnswer(a.entry, TOOL_OF[a.type], c.input, a.info)
      if (c.problems.length === 0) {
        if (!('exec' in script) || 'refused' in tool) throw new Error(`${c.name}: refused: ${JSON.stringify({ script, tool })}`)
        expect(script.exec.status).toBe('done')
        // the same outcome and events through either channel; the summary says which
        expect({ ...script, exec: { ...script.exec, summary: '' } }).toEqual({ ...tool, exec: { ...tool.exec, summary: '' } })
        expect(script.exec.summary).toContain('script)')
        // and the file the script writes for it is the one the loop reads
        const written = contract.answerText(job, c.input)
        if (!written.ok) throw new Error(`${c.name}: the script would refuse it`)
        expect(readScriptAnswer(a.entry, written.outcome, a.info)).toEqual(script)
      } else {
        expect(script).toEqual({ problem: `the answer recorded with the answer script does not pass its checks: ${c.problems.join('; ')}` })
        expect(tool).toEqual({ refused: `${c.problems.join('; ')}. Correct the call and call ${TOOL_OF[a.type]} again` })
        expect(contract.answerText(job, c.input)).toEqual({ ok: false, problems: [...c.problems] })
      }
    }
  })

  test("the tools check with the contract's own functions, are named after its contracts, and offer its words", () => {
    expect(checkVerdict).toBe(contract.checkVerdict)
    expect(checkDesign).toBe(contract.checkDesign)
    expect(checkHandoff).toBe(contract.checkHandoff)
    expect(AGENT_TOOLS.map(t => t.name)).toEqual(['verdict', 'design', 'handoff'])
    for (const type of ['adjudicator', 'designer', 'implementer', 'fixer'] as const) expect(TOOL_OF[type]).toBe(`mcp__factory-loop__${contract.CONTRACT_OF[type]}`)
    const props = (spec: typeof VERDICT_TOOL) => (spec.inputSchema as { properties: Record<string, { enum?: unknown; items?: { enum?: unknown; properties?: Record<string, { enum?: unknown }> } }> }).properties
    expect(props(VERDICT_TOOL).findings?.items?.properties?.verdict?.enum).toEqual([...contract.VERDICTS])
    expect(props(VERDICT_TOOL).flags?.items?.enum).toEqual([...contract.FLAGS])
    expect(Object.keys(props(DESIGN_TOOL)).sort()).toEqual(['brief', 'created', 'pendingDecision'])
    expect(Object.keys(props(HANDOFF_TOOL)).sort()).toEqual(['branch', 'commit', 'gated', 'head', 'pr', 'run'])
    // every action type the schema offers is one the contract allows some purpose
    const types = (props(VERDICT_TOOL).action as unknown as { properties: { type: { enum: string[] } } }).properties.type.enum
    expect([...types].sort()).toEqual([...new Set(Object.values(contract.ACTIONS_FOR).flat())].sort())
  })

  test('an answer file is named for its entry and attempt, and its job file stands beside it', () => {
    for (const a of Object.values(AGENTS)) {
      const file = scriptAnswerPath(LOOP, { ...a.entry, attempts: 3, startedAt: NOW })
      const name = file.slice(file.lastIndexOf('/') + 1)
      expect(file.startsWith(`${LOOP}/answers/`)).toBe(true)
      expect(contract.ANSWER_NAME.test(name)).toBe(true)
      expect(name).toEndWith(`.a3.${NOW}${contract.ANSWER_SUFFIX}`)
      expect(contract.jobPathOf(file)).toBe(`${file.slice(0, -contract.ANSWER_SUFFIX.length)}${contract.JOB_SUFFIX}`)
    }
    expect(contract.LOOP_DIR_NAME.test('cbundy__dev-system')).toBe(true)
    for (const other of [`${LOOP}/answers/x.job.json`, `${LOOP}/answers/x.txt`, `${LOOP}/answers/.x.answer.json`, '/etc/passwd']) expect(contract.jobPathOf(other)).toBeNull()
  })

  test("a job file that is not the loop's is no job, and says why", () => {
    expect(contract.parseJob('not json')).toBe('the job file is not JSON')
    for (const bad of [{}, { v: 2, contract: 'verdict' }, { v: 1, contract: 'tool', purpose: null, repo: 'o/r', issue: 1, branch: null }, { v: 1, contract: 'verdict', purpose: 'review', repo: 'o/r', issue: 1, branch: null }, { v: 1, contract: 'design', purpose: null, repo: 'o/r', issue: 0, branch: null }]) {
      expect(typeof contract.parseJob(JSON.stringify(bad))).toBe('string')
    }
    // a verdict job with no purpose can check nothing
    expect(contract.checkAnswer({ ...JOBS.gate, purpose: null }, {})).toEqual({ ok: false, problems: ['the factory loop cannot tell which review this is'] })
  })
})
