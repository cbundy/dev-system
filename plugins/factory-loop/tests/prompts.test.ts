// The text helpers the agent prompts share (prompts.ts, SPEC 6.3): free text made safe for a
// prompt, so no GitHub closing keyword can come to stand before an issue reference (I-33), and the
// shape a path must have for a prompt to carry it. The prompts themselves are v2's
// (tests/v2-work.test.ts and the other v2 prompt suites).
import { describe, expect, test } from 'claude-code/testing'

import { neutral, neutralWhole, scriptShaped } from '../hooks/prompts'
import type { ScriptPlace } from '../hooks/prompts'

const PLACE: ScriptPlace = {
  bin: '/plugins/factory-loop/bin/factory-answer',
  file: '/cfg/factory-loop/cbundy__dev-system/answers/adjudicate_R470_review_abc1234.a1.1760430000000.answer.json',
}

describe('neutral', () => {
  test('a keyword before a reference becomes its participle, in the same case; other text stays', () => {
    expect(neutral('Closes #12')).toBe('Closing #12')
    expect(neutral('fixes cbundy/dev-system#13')).toBe('fixing cbundy/dev-system#13')
    expect(neutral('RESOLVED: https://github.com/o/r/issues/14')).toBe('RESOLVING: https://github.com/o/r/issues/14')
    expect(neutral('**Resolves** #18')).toBe('**Resolving** #18')
    expect(neutral('a value that ends in fix')).toBe('a value that ends in fixing')
    expect(neutral('Fix the timeout in a.ts, then re-gate.')).toBe('Fix the timeout in a.ts, then re-gate.')
    expect(neutral('prefixes #12 and unresolved #13')).toBe('prefixes #12 and unresolved #13')
  })

  test('control characters go, long text is cut', () => {
    expect(neutral('a\u0007b\r\nc')).toBe('a b \nc')
    expect(neutral('x'.repeat(5000))).toHaveLength(4000)
  })

  test('neutralWhole keeps every line and indent and cuts nothing', () => {
    expect(neutralWhole('  Closes #12\n\n    fixes #13\n')).toBe('  Closing #12\n\n    fixing #13\n')
    expect(neutralWhole('x'.repeat(5000))).toHaveLength(5000)
  })
})

describe('scriptShaped', () => {
  test('both paths must be plain absolute paths a prompt may carry', () => {
    expect(scriptShaped(PLACE)).toBe(true)
    for (const bad of ['relative/bin/factory-answer', '/home/a b/factory-answer', "/x/it's", '/x/$HOME/a', '/x/#1', '/x/../etc/passwd', '/x/a;rm', '/cfg//factory-loop/a.answer.json', '/x/./a', '/x/a/', '/x/.']) {
      expect(scriptShaped({ ...PLACE, bin: bad })).toBe(false)
      expect(scriptShaped({ ...PLACE, file: bad })).toBe(false)
    }
  })
})
