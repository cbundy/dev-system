// The answer contract the loop and the answer script share (hooks/contract.mjs, #561). The answer script (bin/factory-answer) is a temporary workaround for the
// registered answer tools, which an agent the loop spawns from its timer cannot reach (#560); its
// file and the tool's input are the same answer, so both are checked by the one contract. Every
// case of the shared table (answer-cases.mjs) must read here exactly as the script, run for real
// by tests/factory-loop-answer.test.js at the repo root, names it: recorded, or refused with the
// same problems. A change to either end that the other does not share fails one of the two.
import { describe, expect, test } from 'claude-code/testing'

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
    const job = (over: Record<string, unknown>) => JSON.stringify({ v: 1, contract: 'review', purpose: null, repo: 'o/r', issue: 1, branch: null, ...over })
    for (const bad of [
      { v: 2, contract: 'review' },
      { contract: 'tool' },
      // the retired v1 contracts, and a purpose, are no longer jobs
      { contract: 'verdict', purpose: 'gate' },
      { contract: 'design' },
      { contract: 'handoff' },
      { purpose: 'gate' },
      { contract: 'review', issue: 0 },
    ]) {
      expect(typeof contract.parseJob(job(bad))).toBe('string')
    }
    expect(contract.parseJob(job({}))).toEqual({ contract: 'review', purpose: null, repo: 'o/r', issue: 1, branch: null })
    // a contract the loop does not have checks nothing
    expect(contract.checkAnswer({ ...JOBS.review, contract: 'verdict' as never }, {})).toEqual({ ok: false, problems: ['the factory loop has no "verdict" contract'] })
  })
})
