// The loop's side of the fabriek names' fallback (hooks/tool-name.mjs, #1359): the sync twin, the
// notices a pass logs and the settings pairs. The rule's table, run against the loop's code and the
// two copies (the companion's and the status display's), is tests/fabriek-tool-name.test.js.
import { describe, expect, test } from 'claude-code/testing'

import { envOf, resetFallbacks, settingPair, takeNotices, withFallback, withFallbackSync } from '../hooks/tool-name.mjs'

function imageRun(has: string[]) {
  return async (argv: string[]) => {
    const program = argv[0] ?? ''
    return has.includes(program) ? { exitCode: 0, stdout: '', stderr: '' } : { exitCode: 127, stdout: '', stderr: `sh: ${program}: not found\n` }
  }
}

describe('the loop only: the sync twin, notices and settings', () => {
  test('the sync twin follows the same rule', () => {
    resetFallbacks()
    const calls: string[][] = []
    const run = withFallbackSync((a: string[]) => {
      calls.push(a)
      return a[0] === 'fabriek-event' ? { exitCode: 127, stderr: 'sh: fabriek-event: not found' } : { exitCode: 0, stderr: '' }
    })
    expect(run(['fabriek-event', '1'], undefined).exitCode).toBe(0)
    expect(run(['fabriek-event', '2'], undefined).exitCode).toBe(0)
    expect(calls).toEqual([['fabriek-event', '1'], ['callum-flow-event', '1'], ['callum-flow-event', '2']])
  })

  test('a fallback is noticed once per tool, then the notices are taken', async () => {
    resetFallbacks()
    const run = imageRun(['callum-flow-event'])
    const w = withFallback((a: string[]) => run(a))
    await w(['fabriek-event'])
    await w(['fabriek-event'])
    expect(takeNotices()).toEqual(['fabriek-event is not on this image (it predates the fabriek names): running callum-flow-event'])
    expect(takeNotices()).toEqual([])
  })

  test('a setting goes out under both names, and is read FABRIEK first', () => {
    expect(settingPair('REPO', 'o/n')).toEqual({ FABRIEK_REPO: 'o/n', CALLUM_FLOW_REPO: 'o/n' })
    expect(envOf({ FABRIEK_X: 'new', CALLUM_FLOW_X: 'old' }, 'X')).toBe('new')
    expect(envOf({ CALLUM_FLOW_X: 'old' }, 'X')).toBe('old')
    expect(envOf({}, 'X')).toBeUndefined()
  })
})
