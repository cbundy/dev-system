// The designer's two-layer brief (a plain summary, then the full text in a collapsed Details block)
// reads the same through every brief reader as the same brief without the <details> lines.
import { describe, expect, test } from 'claude-code/testing'

import { V2_CONTRACTS } from '../hooks/contract.mjs'
import { rolloutOf, rolloutReasonOf } from '../hooks/v2/contracts-work.mjs'
import { checkRollout } from '../hooks/v2/rollout-check.mjs'
import { decisionFallback } from '../hooks/v2/split-decision.mjs'

const design = (brief: string) => V2_CONTRACTS['design-v2'].check({ kind: 'brief', brief }, { contract: 'design-v2', purpose: null, repo: 'o/r', issue: 5, branch: 'issue-5' })

const briefOf = (rollout: string, open: string) =>
  [
    '## Design brief (designer, 2026-10-24)',
    '',
    'Makes the park comment shorter to read. Low risk.',
    '',
    '<details><summary>Exploration</summary>',
    '',
    'Read question.mjs and park-text.ts.',
    '',
    '</details>',
    '',
    '## Acceptance criteria',
    'The comment shows a summary first.',
    '',
    '<details><summary>Details</summary>',
    '',
    '- renderQuestion splits the context',
    '',
    '</details>',
    '',
    '## Files to touch',
    'The question renderer.',
    '',
    '<details><summary>Details</summary>',
    '',
    '- plugins/factory-loop/hooks/v2/question.mjs:99 - split',
    '',
    '</details>',
    '',
    '## Risk',
    'low - text only',
    '',
    '## Test plan',
    'Unit tests.',
    '',
    '<details><summary>Details</summary>',
    '',
    '- v2-park-text.test.ts',
    '',
    '</details>',
    '',
    '## Observability',
    'none - no new decision',
    '',
    '## Compatibility',
    'none - no schema, event or reader change',
    '',
    '## Sequencing',
    'none',
    '',
    '## Rollout',
    rollout,
    '',
    '## Open decisions',
    open,
    '',
  ].join('\n')

const flat = (b: string) =>
  b
    .split('\n')
    .filter(l => !/^<\/?details>|^<details>|^<summary>/.test(l))
    .join('\n')

const ok = (b: string) => {
  const c = design(b)
  return c.ok ? { ok: true } : { ok: false, problems: c.problems }
}

const stub = (body: string) => async () => ({ code: 0, stdout: JSON.stringify({ issue: { body } }), stderr: '' })

describe('a brief in the summary-plus-Details shape reads like the same brief without the details lines', () => {
  const cases: [string, string][] = [
    ['merge - plain change', 'none'],
    ['run-it - the issue has its own Run it', '- A: use the old store\n- B: use the new store'],
    ['keep-open - research only', 'none'],
  ]
  for (const [rollout, open] of cases) {
    test(`${rollout.split(' ')[0]}, open decisions ${open === 'none' ? 'none' : 'open'}`, async () => {
      const nested = briefOf(rollout, open)
      expect(nested).toContain('<details>')
      expect(flat(nested)).not.toContain('<details>')
      expect(rolloutOf(nested)).toBe(rolloutOf(flat(nested)))
      expect(rolloutOf(nested)).toBe(rollout.split(' ')[0])
      expect(rolloutReasonOf(nested)).toBe(rolloutReasonOf(flat(nested)))
      expect(ok(nested)).toEqual(ok(flat(nested)))
      expect(ok(nested)).toEqual({ ok: true })
      expect(decisionFallback(nested, 5)).toBe(decisionFallback(flat(nested), 5))
      for (const body of ['Do it.\n', 'Do it.\n\n## Run it\nlater\n']) {
        expect(await checkRollout(nested, 5, stub(body))).toEqual(await checkRollout(flat(nested), 5, stub(body)))
      }
    })
  }

  test('a merge brief over a Run it heading is still refused in the new shape', async () => {
    const r = await checkRollout(briefOf('merge - plain', 'none'), 5, stub('Do it.\n\n## Run it\nlater\n'))
    expect(r.problems).toHaveLength(1)
  })
})
