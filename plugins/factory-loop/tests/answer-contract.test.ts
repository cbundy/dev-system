// The answer contract the loop and the answer script share (hooks/contract.mjs, #561). The answer script (bin/factory-answer) is a temporary workaround for the
// registered answer tools, which an agent the loop spawns from its timer cannot reach (#560); its
// file and the tool's input are the same answer, so both are checked by the one contract. Every
// case of the shared table (answer-cases.mjs) must read here exactly as the script, run for real
// by tests/factory-loop-answer.test.js at the repo root, names it: recorded, or refused with the
// same problems. A change to either end that the other does not share fails one of the two.
import { describe, expect, test } from 'claude-code/testing'

import { AGENT_TOOLS, DESIGN_TOOL, HANDOFF_TOOL, TOOL_OF, VERDICT_TOOL, checkDesign, checkHandoff, checkVerdict } from '../hooks/agent-tools'
import * as contract from '../hooks/contract.mjs'
import { stepAnswerPath } from '../hooks/v2/steps'
import { CASES, JOBS } from './answer-cases.mjs'

const LOOP = '/cfg/factory-loop/cbundy__dev-system'

describe('one contract for the loop and the answer script (#561)', () => {
  test('each job of the shared table is the job file the spawn writes for the script', () => {
    for (const job of Object.values(JOBS)) expect(contract.parseJob(contract.jobText(job))).toEqual(job)
  })

  test('every case of the shared table is checked by the contract as the script names it: recorded, or refused with the same problems', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(10)
    for (const c of CASES) {
      const job = JOBS[c.job]
      const checked = contract.checkAnswer(job, c.input)
      if (c.problems.length === 0) expect(checked.ok).toBe(true)
      else expect(checked).toEqual({ ok: false, problems: [...c.problems] })
      expect(contract.answerText(job, c.input).ok).toBe(c.problems.length === 0)
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

  test('an answer file is named for its step key, and its job file stands beside it', () => {
    for (const key of ['design:470:1', 'build:470:2', 'review:512:abc1234']) {
      const file = stepAnswerPath(LOOP, key)
      const name = file.slice(file.lastIndexOf('/') + 1)
      expect(file.startsWith(`${LOOP}/answers/`)).toBe(true)
      expect(contract.ANSWER_NAME.test(name)).toBe(true)
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
