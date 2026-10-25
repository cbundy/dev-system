// The companion's rules, pure (docs/factory-loop/v2/SPEC.md 10.3, 10.4, 10.6): which writes,
// pushes and commands each role is refused, how a command line is read, the marker check, and the
// stop gate's results.
import { describe, expect, test } from 'claude-code/testing'

import { blockText, failedTests, gateLine, gateRecord, runGates, tail, waitedOut } from '../hooks/gate'
import type { Ran } from '../hooks/gate'
import { bootMs, gateEntries, isDead, judge, leaseHeld, openGates, pidOf, startMs } from '../hooks/recover'
import { agentRefusal, backgroundRefusal, bashRefusal, fileRefusal, needsHead, normalize } from '../hooks/guard'
import type { Guarded } from '../hooks/guard'
import { mismatch, nameParts, parseMarker, slotLine } from '../hooks/marker'
import { INPUT_CLIP, clip, inputOf, promptData, promptReason, transcriptOf, unguardedGlob, whyOf } from '../hooks/prompt'
import { scratchOk, withScratch } from '../hooks/scratch'
import { agentWaitMs, gatePrelude, parseSlotLine, runSlotted, slotCommand, slotDir } from '../hooks/slots'
import { simpleCommands } from '../hooks/shell'
import { runStopGate } from '../hooks/register'
import { parseCurrent, parseMax, startMemorySampler } from '../hooks/memory'
import { createTurns } from '../hooks/turns'
import type { Turn, TurnIo } from '../hooks/turns'

const MAIN = '/w/dev-system'
const SLOT = '/w/dev-system/.treehouse/p/3/dev-system'
const WRITER: Guarded = { slot: SLOT, role: 'writer', branch: 'issue-571', roots: [SLOT, MAIN] }
const READER: Guarded = { ...WRITER, role: 'reader' }

const cause = (g: Guarded, command: string, head: string | null = null) => bashRefusal(g, command, head)?.cause ?? null

describe('reading a command line', () => {
  test('splits on separators and looks through wrappers, assignments and shells', () => {
    expect(simpleCommands('cd x && FOO=1 timeout -s KILL 60 git push -f; echo done')).toEqual([
      ['cd', 'x'],
      ['git', 'push', '-f'],
      ['echo', 'done'],
    ])
    expect(simpleCommands("bash -lc 'npm test | tail -5' || env -u X sudo -u me axi")).toEqual([
      ['npm', 'test'],
      ['tail', '-5'],
      ['axi'],
    ])
    expect(simpleCommands('x=$(git rev-parse HEAD) && echo "$x" `date`')).toEqual([['git', 'rev-parse', 'HEAD'], ['echo', '$x'], ['date']])
  })

  test('keeps quoted text whole, and drops redirections, comments and here-document bodies', () => {
    expect(simpleCommands('git commit -m "gh pr create; git push -f" 2>&1 >/dev/null # git push -f')).toEqual([['git', 'commit', '-m', 'gh pr create; git push -f']])
    const heredoc = "git commit -F - <<'EOF'\nfix: do not run gh pr merge\ngit push --force\nEOF\ngit status"
    expect(simpleCommands(heredoc)).toEqual([['git', 'commit', '-F', '-'], ['git', 'status']])
    expect(simpleCommands('npm test > out.txt 2> err.txt')).toEqual([['npm', 'test']])
  })

  test('reads the commands a substitution runs inside double quotes, nested quotes and all', () => {
    expect(simpleCommands('echo "head: $(git rev-parse "HEAD")" `date`')).toEqual([['echo', 'head: $(git rev-parse "HEAD")'], ['date'], ['git', 'rev-parse', 'HEAD']])
    expect(simpleCommands('x="$(cd sub && (git push -f origin main))"')).toEqual([['cd', 'sub'], ['git', 'push', '-f', 'origin', 'main']])
    expect(simpleCommands('echo "`gh pr merge 12`"')).toEqual([['echo', '`gh pr merge 12`'], ['gh', 'pr', 'merge', '12']])
    // escaped, the text is only text
    expect(simpleCommands('echo "\\$(gh pr merge 12) \\`gh pr create\\`"')).toEqual([['echo', '$(gh pr merge 12) `gh pr create`']])
  })

  test('an unquoted here-document runs its substitutions; a quoted one does not', () => {
    expect(simpleCommands('cat <<EOF\nmerged: $(gh pr merge 12)\n`git push -f`\nEOF\ngit status')).toEqual([['cat'], ['git', 'status'], ['gh', 'pr', 'merge', '12'], ['git', 'push', '-f']])
    expect(simpleCommands("cat <<'EOF'\nmerged: $(gh pr merge 12)\nEOF")).toEqual([['cat']])
    expect(simpleCommands('cat <<\\EOF\nmerged: $(gh pr merge 12)\nEOF')).toEqual([['cat']])
  })
})

describe('file writes', () => {
  test('a writer writes inside its slot and outside the repository, nowhere else in it', () => {
    expect(fileRefusal(WRITER, normalize('src/a.ts', SLOT))).toBeNull()
    expect(fileRefusal(WRITER, '/tmp/scratch.txt')).toBeNull()
    expect(fileRefusal(WRITER, normalize('../../4/dev-system/a.ts', SLOT))?.cause).toBe('guard:write')
    expect(fileRefusal(WRITER, `${MAIN}/README.md`)?.reason).toContain(SLOT)
  })

  test('a reader writes nowhere in the repository, its slot included', () => {
    expect(fileRefusal(READER, `${SLOT}/notes.md`)?.cause).toBe('guard:write')
    expect(fileRefusal(READER, `${MAIN}/x`)?.cause).toBe('guard:write')
    expect(fileRefusal(READER, '/tmp/brief-draft.md')).toBeNull()
  })

  test('relative paths and dot segments resolve against the slot', () => {
    expect(normalize('./a/../b.txt', SLOT)).toBe(`${SLOT}/b.txt`)
    expect(normalize('/x//y/./z/', SLOT)).toBe('/x/y/z')
  })
})

describe('commands refused for every loop agent', () => {
  for (const g of [WRITER, READER]) {
    test(`GitHub writes and axi (${g.role})`, () => {
      for (const c of [
        'gh pr create --repo o/r --title t --body b',
        'gh pr merge 12 --repo o/r',
        'gh pr update-branch 12',
        'gh issue comment 5 --body hi',
        'gh label create x',
        'gh label list',
        'gh api repos/o/r/issues/5/labels -X POST -f labels[]=x',
        'gh api -XDELETE repos/o/r/git/refs/heads/x',
        'gh api repos/o/r/issues -f title=x',
        'gh run rerun 123 --failed',
        'gh pr new --title t --body b',
        'gh issue new --title t',
        'gh pr revert 12',
        'gh repo edit --default-branch x',
        'gh repo rename y',
        'gh repo archive o/r --yes',
        'gh repo delete o/r --yes',
        'gh repo sync',
        'gh secret set TOKEN --body x',
        'gh variable delete X',
        'gh cache delete --all',
        'git status; echo "$(gh pr create --fill)"',
        'echo "merged: $(gh pr merge 12 --squash)"',
        'cat <<EOF > notes.txt\n$(gh pr create --fill)\nEOF',
        '/usr/local/bin/axi start',
      ]) {
        expect(cause(g, c)).toBe('guard:command')
      }
    })

    test(`reads pass (${g.role})`, () => {
      for (const c of ['gh pr view 12 --json state', 'gh api repos/o/r/pulls/12', 'gh api -X GET search/issues -f q=x', 'gh issue view 5', 'gh repo view o/r', 'git log --oneline -5', 'npm test', 'echo "head: $(git rev-parse HEAD)"', "cat <<'EOF'\n$(gh pr create)\nEOF"]) {
        expect(cause(g, c)).toBeNull()
      }
    })
  }

  test('any call in the background, Bash or Agent', () => {
    expect(backgroundRefusal('Bash', { run_in_background: true })?.cause).toBe('guard:command')
    expect(backgroundRefusal('Agent', { run_in_background: true })?.reason).toBe('Agent in the background is refused: run it in the foreground and wait for it, a command with a timeout of up to 600000 ms')
    expect(backgroundRefusal('Bash', { run_in_background: false })).toBeNull()
    expect(backgroundRefusal('Bash', {})).toBeNull()
  })

  test('an Agent call isolated', () => {
    expect(agentRefusal({})).toBeNull()
    // remote always runs in the background; worktree makes a git worktree
    expect(agentRefusal({ isolation: 'remote' })?.cause).toBe('guard:command')
    expect(agentRefusal({ isolation: 'worktree' })?.reason).toContain('isolation "worktree"')
  })
})

describe('a writer pushes only its branch to origin', () => {
  test('its own branch passes, in each spelling', () => {
    for (const c of ['git push origin issue-571', 'git push -u origin issue-571', 'git push origin HEAD:issue-571', 'git push origin issue-571:refs/heads/issue-571', 'git -C . push --quiet origin issue-571']) {
      expect(cause(WRITER, c)).toBeNull()
    }
  })

  test('a bare push goes where the slot is: its branch passes, another or an unknown one does not', () => {
    expect(needsHead('git push')).toBe(true)
    expect(needsHead('git push origin issue-571')).toBe(false)
    expect(cause(WRITER, 'git push', 'issue-571')).toBeNull()
    expect(cause(WRITER, 'git push origin HEAD', 'issue-571')).toBeNull()
    expect(cause(WRITER, 'git push', 'main')).toBe('guard:push')
    expect(cause(WRITER, 'git push', null)).toBe('guard:push')
  })

  test('another ref, another remote, a force push or a deletion is refused', () => {
    for (const c of [
      'echo "pushed: $(git push -f origin main)"',
      'git push origin main',
      'git push origin issue-571:main',
      'git push upstream issue-571',
      'git push https://github.com/o/r issue-571',
      'git push -f origin issue-571',
      'git push --force-with-lease origin issue-571',
      'git push -uf origin issue-571',
      'git push origin +issue-571',
      'git push origin :issue-571',
      'git push --tags origin',
      'git push --all',
      'cd sub && git push --mirror',
    ]) {
      expect(cause(WRITER, c, 'issue-571')).toBe('guard:push')
    }
  })

  test('creates no branch and no worktree, but may inspect them', () => {
    for (const c of ['git switch -c other', 'git checkout -b other', 'git checkout -B other origin/main', 'git branch other', 'git branch -m renamed', 'git worktree add ../x']) {
      expect(cause(WRITER, c)).toBe('guard:command')
    }
    for (const c of ['git switch issue-571', 'git checkout -- a.ts', 'git branch --show-current', 'git branch -vv', 'git branch --contains HEAD', 'git worktree list', 'git commit -am fix']) {
      expect(cause(WRITER, c)).toBeNull()
    }
  })
})

describe('a reader neither commits nor pushes', () => {
  test('commit and push are refused; branches are not its rule', () => {
    expect(cause(READER, 'git add -A && git commit -m x')).toBe('guard:command')
    expect(cause(READER, 'git push origin issue-571')).toBe('guard:push')
    expect(cause(READER, 'git switch -c scratch')).toBeNull()
  })
})

describe('the spawn and its marker', () => {
  const MARKER = { v: 1, repo: 'o/r', issue: 571, life: 'ss1x2k', seq: 7, step: 'build', role: 'writer', branch: 'issue-571', gateCommands: ['npm run lint', ' ', 'npm test'], gateTimeoutMs: 600_000, loopDir: '/c/factory-loop/o__r/' }

  test('the slot line is the prompt\'s first line, an absolute plain path', () => {
    expect(slotLine(`factory-slot: ${SLOT}\nYou are the builder.`)).toBe(SLOT)
    expect(slotLine(`You are the builder.\nfactory-slot: ${SLOT}`)).toBeNull()
    expect(slotLine('factory-slot: relative/path')).toBeNull()
    expect(slotLine(`factory-slot: ${SLOT}/../4`)).toBeNull()
  })

  test('a marker reads, its blank gate commands and trailing slash dropped', () => {
    const m = parseMarker(JSON.stringify(MARKER))
    expect(m?.gateCommands).toEqual(['npm run lint', 'npm test'])
    expect(m?.loopDir).toBe('/c/factory-loop/o__r')
    expect(parseMarker('not json')).toBeNull()
    expect(parseMarker(JSON.stringify({ ...MARKER, role: 'admin' }))).toBeNull()
    expect(parseMarker(JSON.stringify({ ...MARKER, loopDir: '' }))).toBeNull()
  })

  test('a marker\'s pr is a number, and null when it has none or an older loop wrote it', () => {
    expect(parseMarker(JSON.stringify(MARKER))?.pr).toBeNull()
    expect(parseMarker(JSON.stringify({ ...MARKER, pr: null }))?.pr).toBeNull()
    expect(parseMarker(JSON.stringify({ ...MARKER, pr: 612 }))?.pr).toBe(612)
    expect(parseMarker(JSON.stringify({ ...MARKER, pr: 'x' }))?.pr).toBeNull()
  })

  test('a marker\'s scratch is kept when absolute, plain and under <loopDir>/scratch/, and ignored otherwise', () => {
    const scratch = '/c/factory-loop/o__r/scratch/571-ss1x2k-s7'
    expect(parseMarker(JSON.stringify({ ...MARKER, scratch }))?.scratch).toBe(scratch)
    // an older loop's marker has none
    expect(parseMarker(JSON.stringify(MARKER))).not.toHaveProperty('scratch')
    for (const bad of ['scratch/571-ss1x2k-s7', '/c/factory-loop/o__r/scratch/../../x', '/c/factory-loop/o__r/scratch/571//x', '/c/factory-loop/o__r/scratch/', '/c/factory-loop/o__r/scratch', '/c/factory-loop/other/scratch/571-ss1x2k-s7', '/tmp/571-ss1x2k-s7', '/c/factory-loop/o__r/scratchy/x', 7, null]) {
      const m = parseMarker(JSON.stringify({ ...MARKER, scratch: bad }))
      expect(m).not.toBeNull()
      expect(m).not.toHaveProperty('scratch')
    }
    expect(scratchOk(scratch, '/c/factory-loop/o__r')).toBe(true)
    expect(scratchOk(scratch, '/c/factory-loop/o__r/')).toBe(true)
  })

  test('a marker\'s gateConcurrency and wait cap are whole numbers of at least 1; any other value is left out, which means no limit', () => {
    expect(parseMarker(JSON.stringify({ ...MARKER, gateConcurrency: 3, gateWaitTimeoutMs: 60_000 }))).toMatchObject({ gateConcurrency: 3, gateWaitTimeoutMs: 60_000 })
    expect(parseMarker(JSON.stringify(MARKER))).not.toHaveProperty('gateConcurrency')
    expect(parseMarker(JSON.stringify(MARKER))).not.toHaveProperty('gateWaitTimeoutMs')
    for (const bad of [0, 1.5, '2', null, -1]) {
      const m = parseMarker(JSON.stringify({ ...MARKER, gateConcurrency: bad, gateWaitTimeoutMs: bad }))
      expect(m).not.toBeNull()
      expect(m).not.toHaveProperty('gateConcurrency')
      expect(m).not.toHaveProperty('gateWaitTimeoutMs')
    }
  })

  test('the Bash prefix quotes the path, ends in a newline before the command, and leaves the command whole', () => {
    const s = '/c/o__r/scratch/571-ss1x2k-s7'
    expect(withScratch('echo hi', s)).toBe(`export TMPDIR='${s}' TMP='${s}' TEMP='${s}'\necho hi`)
    expect(withScratch('x', "/c/it's/scratch/a")).toBe("export TMPDIR='/c/it'\\''s/scratch/a' TMP='/c/it'\\''s/scratch/a' TEMP='/c/it'\\''s/scratch/a'\nx")
    const doc = "cat <<'EOF' > f\nline $TMPDIR\nEOF\nls\n"
    expect(withScratch(doc, s).endsWith(`\n${doc}`)).toBe(true)
  })

  test('the name says the step, issue, seq and attempt', () => {
    expect(nameParts('build-571-s7-a2')).toEqual({ step: 'build', issue: 571, seq: 7, attempt: 2 })
    expect(nameParts('build-571-s7')).toBeNull()
  })

  test('it must be the loop\'s agent, for the marker\'s issue, seq and step', () => {
    const m = parseMarker(JSON.stringify(MARKER))
    expect(mismatch(m, { name: 'build-571-s7-a2', subagentType: 'factory-loop:builder' })).toBeNull()
    expect(mismatch(m, { name: 'build-571-s6-a1', subagentType: 'factory-loop:builder' })).toContain('seq 7')
    expect(mismatch(m, { name: 'build-572-s7-a1', subagentType: 'factory-loop:builder' })).toContain('#571')
    expect(mismatch(m, { name: 'fix-571-s7-a1', subagentType: 'factory-loop:fixer' })).toContain('build')
    expect(mismatch(m, { subagentType: 'factory-loop:builder' })).toContain('name')
    expect(mismatch(m, { name: 'build-571-s7-a1', subagentType: 'general-purpose' })).toContain('not one of')
    expect(mismatch(null, { name: 'build-571-s7-a1', subagentType: 'factory-loop:builder' })).toContain('marker')
  })
})

describe('the stop gate', () => {
  // io: each command's run in turn, with a clock that moves by each run's ms
  function io(runs: (Ran & { ms?: number })[]) {
    let now = 0
    const ran: { command: string; budget: number }[] = []
    return {
      ran,
      io: {
        now: async () => now,
        run: async (command: string, budget: number): Promise<Ran> => {
          ran.push({ command, budget })
          const r = runs.shift() ?? { exitCode: 0, output: '' }
          now += r.ms ?? 1_000
          return r
        },
      },
    }
  }

  test('passes when every command passes, each with the budget left', async () => {
    const t = io([{ exitCode: 0, output: '', ms: 20_000 }, { exitCode: 0, output: '', ms: 30_000 }])
    expect((await runGates(t.io, ['npm run lint', 'npm test'], 600_000)).result).toBe('pass')
    expect(t.ran).toEqual([
      { command: 'npm run lint', budget: 600_000 },
      { command: 'npm test', budget: 580_000 },
    ])
  })

  test('stops at the first failure, with its exit code and the tail of its output', async () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
    const t = io([{ exitCode: 1, output }])
    const r = await runGates(t.io, ['npm run lint', 'npm test'], 600_000)
    expect(t.ran.length).toBe(1)
    if (r.result !== 'fail') throw new Error(`expected a failure, got ${r.result}`)
    expect(r.exitCode).toBe(1)
    expect(r.tail.split('\n').length).toBe(150)
    expect(r.tail.startsWith('line 51\n')).toBe(true)
    const text = blockText(r, SLOT, ['npm run lint', 'npm test'])
    expect(text).toContain('`npm run lint` exited 1')
    expect(text).toContain('line 200')
  })

  test('runGates finds a failure past the 150-line tail', async () => {
    const output = `FAIL early one\n${Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')}`
    const r = await runGates(io([{ exitCode: 1, output }]).io, ['npm test'], 600_000)
    if (r.result !== 'fail') throw new Error('expected a failure')
    expect(r.failedTests).toEqual(['early one'])
    expect(r.tail).not.toContain('early one')
  })

  test('a command that cannot finish, or a budget spent, is unknown and never a pass', async () => {
    const timedOut = await runGates(io([{ error: 'the child was killed after 600000 ms' }]).io, ['npm test'], 600_000)
    expect(timedOut.result).toBe('unknown')
    const spent = await runGates(io([{ exitCode: 0, output: '', ms: 600_000 }]).io, ['npm run lint', 'npm test'], 600_000)
    expect(spent.result).toBe('unknown')
    if (spent.result === 'unknown') expect(spent.why).toContain('npm test')
  })

  test('a run the engine cut says so, with the wait and the run; otherwise the plain reason', async () => {
    const aborted = { error: 'process.run(sh) aborted', ms: 60_000 }
    // cut() holds: the cut reason, the wait and the run as two numbers
    const t = io([aborted])
    const cutIo = { ...t.io, cut: () => true }
    const cut = await runGates(cutIo, ['npm test'], 600_000, 540_000)
    if (cut.result !== 'unknown') throw new Error(`expected unknown, got ${cut.result}`)
    expect(cut.why).toContain('the hook was cut off 600 s after the gate started (540 s waiting, 60 s running)')
    expect(cut.why).toContain('`npm test`')
    // cut() does not hold and the error is a plain failure: the plain reason, no cut claim
    const plain = await runGates({ ...io([{ error: 'spawn sh ENOENT' }]).io, cut: () => false }, ['npm test'], 600_000, 540_000)
    if (plain.result !== 'unknown') throw new Error('expected unknown')
    expect(plain.why).toBe('`npm test` did not finish: spawn sh ENOENT')
    // no cut() at all (the recovery's caller): an engine abort error is still named
    const abortedOnly = await runGates(io([aborted]).io, ['npm test'], 600_000)
    if (abortedOnly.result !== 'unknown') throw new Error('expected unknown')
    expect(abortedOnly.why).toContain('cut off 60 s after the gate started (0 s waiting, 60 s running)')
  })

  test('its record carries the result and the head', () => {
    expect(gateRecord({ result: 'pass', ms: 5 }, 'abc', 0, ['npm test'])).toEqual({ v: 1, at: '1970-01-01T00:00:00.000Z', head: 'abc', commands: ['npm test'], result: 'pass', ms: 5, waitMs: 0, clean: null })
    expect(gateRecord({ result: 'unknown', ms: 5, why: 'x' }, null, 0, [])).toMatchObject({ result: 'unknown', why: 'x', head: null })
    expect(tail('a\nb\nc\n\n', 2)).toBe('b\nc')
  })
})

describe('failedTests', () => {
  test('reads the reporter\'s FAIL blocks, not their at and message lines', () => {
    const out = 'ok 1 - fine\nFAIL parses the marker\n  at tests/a.test.ts:3\n  expected 1 to be 2\nFAIL second one\n  at b\n  FAIL not a test line? \n'
    expect(failedTests(out)).toEqual(['parses the marker', 'second one', 'not a test line?'])
  })

  test('reads (fail) lines under the job wrapper, without the wrapper or the duration', () => {
    const out = 'FAIL plugins/factory-loop (claude plugin validate / test)\n    (pass) x > y [1.68ms]\n    (fail) group > fails here [0.43ms]\n    (fail) slow > one [1.5s]\n'
    expect(failedTests(out)).toEqual(['group > fails here', 'slow > one'])
  })

  test('drops the job wrapper of a shell suite and the setup failures, keeps an isolation failure', () => {
    expect(failedTests('FAIL scripts/x.test.sh\n')).toBeNull()
    expect(failedTests('FAIL test setup: no postgres\n')).toBeNull()
    expect(failedTests('FAIL test isolation: database factory_test_x\n')).toEqual(['test isolation: database factory_test_x'])
  })

  test('strips ANSI codes, drops duplicates, cuts names to 200 and the list to 20', () => {
    expect(failedTests('\u001b[31mFAIL red one\u001b[0m\nFAIL red one\n')).toEqual(['red one'])
    expect(failedTests(`FAIL ${'n'.repeat(300)}\n`)).toEqual(['n'.repeat(200)])
    const many = Array.from({ length: 25 }, (_, i) => `FAIL t${i}`).join('\n')
    expect(failedTests(many)?.length).toBe(20)
    expect(failedTests(many)?.[19]).toBe('t19')
  })

  test('is null when nothing failed', () => {
    expect(failedTests('all good\n(pass) a [1ms]\n')).toBeNull()
  })

})

describe('the stop gate\'s waiting', () => {
  test('a wait that hit the cap is unknown with a why that names the wait, and the wait is in the record and the line', () => {
    const r = waitedOut(1_800_000, 1_800_000, 2)
    expect(r).toMatchObject({ result: 'unknown', ms: 0 })
    if (r.result !== 'unknown') throw new Error('expected unknown')
    expect(r.why).toContain('waited 1800 s for a turn')
    expect(gateRecord(r, null, 0, ['npm test'], 1_800_000)).toMatchObject({ result: 'unknown', waitMs: 1_800_000 })
    expect(gateLine(r, null, 1_800_000, 2, '2026-10-17T10:00:00.000Z', 3, null)).toMatchObject({ cause: 'gate-unknown', fields: { waitMs: 1_800_000, concurrency: 2, startedAt: '2026-10-17T10:00:00.000Z', queuedBehind: 3, clean: null } })
    expect(gateLine({ result: 'pass', ms: 1 }, 'abc', 0, null, '2026-10-17T10:00:00.000Z', 0, true).fields).toEqual({ head: 'abc', ms: 1, waitMs: 0, concurrency: null, startedAt: '2026-10-17T10:00:00.000Z', queuedBehind: 0, clean: true })
    const fail = { result: 'fail' as const, ms: 1, command: 'npm test', exitCode: 1, tail: '', failedTests: ['a'] }
    expect(gateLine(fail, 'abc', 0, null, '2026-10-17T10:00:00.000Z', 0, true).fields).toMatchObject({ clean: true, failedTests: ['a'] })
    expect(gateRecord(fail, 'abc', 0, [], 0, false)).toMatchObject({ clean: false, failedTests: ['a'] })
  })
})

// a clock and timers the test moves by hand
function manual() {
  let now = 0
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  const io = (maxWaitMs: number, idle?: () => Promise<unknown>): TurnIo => ({
    idle,
    now: () => now,
    after: (ms, fn) => {
      const t = { at: now + ms, fn, live: true }
      timers.push(t)
      return { cancel: () => void (t.live = false) }
    },
    maxWaitMs,
  })
  return {
    io,
    advance: (ms: number) => {
      now += ms
      for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn() }
    },
    live: () => timers.filter(t => t.live).length,
  }
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const held = (t: Turn) => { if (!t.ok) throw new Error('expected a turn'); return t }

describe('the stop gate\'s turns', () => {
  test('with capacity 2 a third waits and is admitted in FIFO order as turns free up', async () => {
    const c = manual()
    const turns = createTurns()
    const a = held(await turns.acquire(2, c.io(1_000_000)))
    const b = held(await turns.acquire(2, c.io(1_000_000)))
    expect([a.queuedBehind, b.queuedBehind, a.waitMs]).toEqual([0, 0, 0])
    const order: string[] = []
    const third = turns.acquire(2, c.io(1_000_000)).then(t => (order.push('third'), t))
    const fourth = turns.acquire(2, c.io(1_000_000)).then(t => (order.push('fourth'), t))
    await tick()
    expect(turns.state()).toEqual({ held: 2, waiting: 2 })
    c.advance(5_000)
    a.release()
    await tick()
    expect(order).toEqual(['third'])
    c.advance(2_000)
    b.release()
    const [t3, t4] = [held(await third), held(await fourth)]
    expect(order).toEqual(['third', 'fourth'])
    expect([t3.waitMs, t3.queuedBehind, t4.waitMs, t4.queuedBehind]).toEqual([5_000, 2, 7_000, 3])
    expect(turns.state()).toEqual({ held: 2, waiting: 0 })
    t3.release()
    t4.release()
    expect(turns.state()).toEqual({ held: 0, waiting: 0 })
    expect(c.live()).toBe(0)
  })

  test('a release is given back once: a second call frees nothing more', async () => {
    const c = manual()
    const turns = createTurns()
    const a = held(await turns.acquire(1, c.io(1_000)))
    const waiting = turns.acquire(1, c.io(1_000_000))
    await tick()
    a.release()
    a.release()
    const b = held(await waiting)
    // a double release must not let a third in beside b
    const third = turns.acquire(1, c.io(1_000_000))
    await tick()
    expect(turns.state()).toEqual({ held: 1, waiting: 1 })
    b.release()
    held(await third).release()
    expect(turns.state()).toEqual({ held: 0, waiting: 0 })
  })

  test('a turn given back in a finally after a throw frees the next waiter', async () => {
    const c = manual()
    const turns = createTurns()
    const gate = async () => {
      const t = held(await turns.acquire(1, c.io(1_000_000)))
      try {
        throw new Error('the hook threw')
      } finally {
        t.release()
      }
    }
    const first = gate()
    const second = turns.acquire(1, c.io(1_000_000))
    await expect(first).rejects.toThrow('the hook threw')
    held(await second).release()
    expect(turns.state()).toEqual({ held: 0, waiting: 0 })
  })

  test('a wait past the cap times out, leaves the queue and never takes a turn later', async () => {
    const c = manual()
    const turns = createTurns()
    const a = held(await turns.acquire(1, c.io(1_000_000)))
    const late = turns.acquire(1, c.io(30_000))
    const next = turns.acquire(1, c.io(1_000_000))
    await tick()
    c.advance(30_000)
    expect(await late).toEqual({ ok: false, waitMs: 30_000, queuedBehind: 1 })
    expect(turns.state()).toEqual({ held: 1, waiting: 1 })
    a.release()
    const b = held(await next)
    // the timed-out waiter took nothing: one turn held, and the one freed is the next waiter's
    expect(turns.state()).toEqual({ held: 1, waiting: 0 })
    b.release()
    expect(turns.state()).toEqual({ held: 0, waiting: 0 })
    c.advance(10_000_000)
    expect(turns.state()).toEqual({ held: 0, waiting: 0 })
  })

  test('with an idle slice pending, a grant admits at once; the slice is called again as each ends', async () => {
    const c = manual()
    const turns = createTurns()
    const a = held(await turns.acquire(1, c.io(1_000_000)))
    const ends: (() => void)[] = []
    let calls = 0
    const idle = () => new Promise<void>(resolve => {
      calls++
      ends.push(resolve)
    })
    const w = turns.acquire(1, c.io(1_000_000, idle))
    await tick()
    expect(calls).toBe(1)
    ends.shift()?.()
    await tick()
    expect(calls).toBe(2)
    // the second slice is still pending when the turn is freed
    a.release()
    const b = held(await w)
    expect(turns.state()).toEqual({ held: 1, waiting: 0 })
    b.release()
  })

  test('the cap still leaves the queue while an idle slice is pending', async () => {
    const c = manual()
    const turns = createTurns()
    const a = held(await turns.acquire(1, c.io(1_000_000)))
    const late = turns.acquire(1, c.io(30_000, () => new Promise<void>(() => undefined)))
    await tick()
    c.advance(30_000)
    expect(await late).toEqual({ ok: false, waitMs: 30_000, queuedBehind: 1 })
    expect(turns.state()).toEqual({ held: 1, waiting: 0 })
    a.release()
  })

  test('a rejecting idle slice is not called again: the wait goes on with the grant alone', async () => {
    const c = manual()
    const turns = createTurns()
    const a = held(await turns.acquire(1, c.io(1_000_000)))
    let calls = 0
    const w = turns.acquire(1, c.io(1_000_000, () => (calls++, Promise.reject(new Error('no sleep')))))
    await tick()
    await tick()
    expect(calls).toBe(1)
    a.release()
    held(await w).release()
    expect(calls).toBe(1)
  })

  test('with no idle slice the wait is as before: nothing is called', async () => {
    const c = manual()
    const turns = createTurns()
    const a = held(await turns.acquire(1, c.io(1_000_000)))
    const w = turns.acquire(1, c.io(1_000_000))
    await tick()
    a.release()
    held(await w).release()
    expect(turns.state()).toEqual({ held: 0, waiting: 0 })
  })

  test('a turn granted before the cap is not taken back by the timer', async () => {
    const c = manual()
    const turns = createTurns()
    const a = held(await turns.acquire(1, c.io(1_000_000)))
    const w = turns.acquire(1, c.io(30_000))
    await tick()
    a.release()
    const b = held(await w)
    c.advance(60_000)
    expect(turns.state()).toEqual({ held: 1, waiting: 0 })
    b.release()
  })
})

describe('prompts nobody answers', () => {
  test('the reason names the rewrite for an rm of a glob under a variable, with the command\'s own variable', () => {
    for (const command of ['rm -f $D/*', 'rm -rf ${OUT}/build/*', 'cd x && rm -f "$DIR"/*.log']) {
      expect(unguardedGlob('Bash', { command })).not.toBeNull()
    }
    expect(promptReason('Bash', { command: 'rm -f $D/*' }, {})).toContain('`"${D:?}"/*`')
    // guarded, literal, not an rm, or not Bash
    for (const command of ['rm -f "${D:?}"/*', 'rm -f /tmp/x/*', 'ls $D/*', 'echo rm']) expect(unguardedGlob('Bash', { command })).toBeNull()
    expect(unguardedGlob('Write', { command: 'rm $D/*' })).toBeNull()
  })

  test('the reason starts with the companion, quotes Claude Code\'s and ends with what to do', () => {
    const r = promptReason('Bash', { command: 'git status' }, { reason: 'needs approval', rule: 'Bash(git:*)', decider: 'auto' })
    expect(r.startsWith('factory-loop-workspace: ')).toBe(true)
    expect(r).toContain('person nobody watches')
    expect(r).toContain('needs approval; rule Bash(git:*); decided by auto')
    expect(r.endsWith('Find another way to do it or, failing that, end your step saying what you needed.')).toBe(true)
    expect(whyOf({})).toBeNull()
  })

  test('the denied data has every required key, null for the unknown', () => {
    expect(promptData('prompt_denied', { life: 'ss1x2k', seq: 7, tool: 'Bash', input: 'rm -f $D/*', agent_type: 'none', agent: '' })).toEqual({
      life: 'ss1x2k',
      seq: 7,
      step: null,
      attempt: null,
      agent_id: null,
      agent_type: 'none',
      tool_name: 'Bash',
      tool_input: 'rm -f $D/*',
      ask_reason: null,
      slot: null,
      session: null,
      transcript: null,
      branch: null,
      pr: null,
    })
  })

  test('the waiting data has no ask_reason, a null tool_name and a clipped message', () => {
    const d = promptData('prompt_waiting', { agent: 'a1', tool: 'Bash', why: 'x', input: 'm'.repeat(INPUT_CLIP + 5), branch: 'issue-1', pr: 3 })
    expect(d).not.toHaveProperty('ask_reason')
    expect(d).toMatchObject({ agent_id: 'a1', tool_name: null, branch: 'issue-1', pr: 3 })
    expect(d.tool_input).toHaveLength(INPUT_CLIP)
    expect(Object.keys(promptData('prompt_waiting', {}))).toHaveLength(13)
    expect(Object.keys(promptData('prompt_denied', {}))).toHaveLength(14)
  })

  test('an input is a Bash command, else JSON, and clipped', () => {
    expect(inputOf('Bash', { command: 'ls' })).toBe('ls')
    expect(inputOf('Write', { file_path: '/x' })).toBe('{"file_path":"/x"}')
    expect(inputOf('Bash', { command: 'x'.repeat(INPUT_CLIP + 1) })).toHaveLength(INPUT_CLIP)
    expect(clip('abc', 2)).toBe('ab')
    expect(INPUT_CLIP).toBe(2000)
  })

  test('a subagent\'s transcript is beside the session\'s', () => {
    expect(transcriptOf('/c/projects/p/s1.jsonl', 'a1')).toBe('/c/projects/p/s1/subagents/agent-a1.jsonl')
    expect(transcriptOf(undefined, 'a1')).toBeNull()
    expect(transcriptOf('', 'a1')).toBeNull()
  })
})

describe('the recovery of a cut gate (10.6)', () => {
  const NOW_MS = Date.UTC(2026, 9, 15, 12, 0)
  const iso = (ms: number) => new Date(ms).toISOString()
  const row = (cause: string, at: number, over: Record<string, unknown> = {}) => JSON.stringify({ at: iso(at), issue: 571, life: 'ss1x2k', seq: 7, cause, ...over })
  const open = (...rows: string[]) => openGates(gateEntries(rows.join('\n'), NOW_MS))

  test('an agent-gate line (an agent\'s own gate run) is no gate entry and closes no open gate', () => {
    const agent = row('agent-gate', NOW_MS - 1, { command: 'npm test', refused: false })
    expect(gateEntries(agent, NOW_MS)).toEqual([])
    expect(open(row('gate-start', NOW_MS - 3, { slot: '/s', gitDir: '/g', process: '1:2' }), agent)).toMatchObject([{ at: NOW_MS - 3 }])
  })

  test('an attempt is open while its newest line is a start or a wait; the newest start is the cut one', () => {
    const s1 = { slot: '/s', gitDir: '/g', process: '1:2', startedAt: 'x' }
    expect(open(row('gate-start', NOW_MS - 3, s1))).toMatchObject([{ issue: 571, life: 'ss1x2k', seq: 7, at: NOW_MS - 3, process: '1:2', slot: '/s', gitDir: '/g' }])
    expect(open(row('gate-start', NOW_MS - 5, s1), row('gate-fail', NOW_MS - 4), row('gate-start', NOW_MS - 3, { ...s1, process: '3:4' }), row('gate-wait', NOW_MS - 2))).toMatchObject([{ at: NOW_MS - 3, process: '3:4' }])
    expect(open(row('gate-wait', NOW_MS - 2))).toMatchObject([{ at: NOW_MS - 2, process: null, slot: null }])
  })

  test('a settling line, a re-run or a cut closes it, another attempt\'s line does not, and nothing past 24 h is read', () => {
    for (const closing of ['gate-pass', 'gate-fail', 'gate-unknown', 'gate-rerun', 'gate-cut']) expect(open(row('gate-start', NOW_MS - 3), row(closing, NOW_MS - 2))).toEqual([])
    expect(open(row('gate-start', NOW_MS - 3), row('gate-pass', NOW_MS - 2, { seq: 8 }))).toHaveLength(1)
    expect(open(row('gate-start', NOW_MS - 25 * 3_600_000))).toEqual([])
    expect(open('not json', row('gate-start', NOW_MS, { life: 'BAD' }), row('gate-start', NOW_MS, { issue: 0 }), row('guard:write', NOW_MS))).toEqual([])
  })

  test('a process is dead when /proc gives another id for its pid, or none', () => {
    const at = NOW_MS
    expect(isDead({ at, process: '4242:7' }, '4242:7', null)).toBe(false)
    expect(isDead({ at, process: '4242:7' }, '4242:8', null)).toBe(true)
    expect(isDead({ at, process: '4242:7' }, undefined, null)).toBe(true)
    expect(pidOf('4242:7')).toBe('4242')
    expect(pidOf('x')).toBeNull()
    expect(pidOf(null)).toBeNull()
  })

  test('a line with no process is dead only when it predates this process\'s start, which needs /proc/stat', () => {
    const boot = bootMs('cpu 1\nbtime 1000\n')
    expect(boot).toBe(1_000_000)
    const stat = `4242 (a b) S ${'1 '.repeat(18)}500 5`
    expect(startMs(stat, boot)).toBe(1_005_000)
    expect(isDead({ at: 1_004_999, process: null }, undefined, 1_005_000)).toBe(true)
    expect(isDead({ at: 1_005_001, process: null }, undefined, 1_005_000)).toBe(false)
    expect(isDead({ at: 1, process: null }, undefined, null)).toBe(false)
    expect(bootMs(null)).toBeNull()
    expect(startMs(null, boot)).toBeNull()
  })

  test('the lease is held by this session until it expires', () => {
    const lock = JSON.stringify({ session: 's1', renewedAt: 1, expiresAt: 100 })
    expect(leaseHeld(lock, 's1', 99)).toBe(true)
    expect(leaseHeld(lock, 's1', 100)).toBe(false)
    expect(leaseHeld(lock, 's2', 50)).toBe(false)
    expect(leaseHeld('{', 's1', 50)).toBe(false)
    expect(leaseHeld(null, 's1', 50)).toBe(false)
  })

  test('judge re-runs only a writer\'s marker that still names the attempt', () => {
    const g = { issue: 571, life: 'ss1x2k', seq: 7, at: 1, startedAt: null, slot: '/s', gitDir: '/g', process: '1:2' }
    const m = parseMarker(JSON.stringify({ v: 1, repo: 'o/r', issue: 571, life: 'ss1x2k', seq: 7, step: 'build', role: 'writer', branch: 'b', gateCommands: ['x'], gateTimeoutMs: 1, loopDir: '/l' }))
    expect(judge(g, m)).toEqual({ rerun: true })
    expect(judge(g, null)).toMatchObject({ rerun: false })
    expect(judge({ ...g, slot: null }, m)).toMatchObject({ rerun: false })
    expect(judge({ ...g, seq: 8 }, m)).toMatchObject({ rerun: false, why: expect.stringContaining('not this attempt') })
  })

  test('gateLine adds rerun only for a re-run', () => {
    const pass = { result: 'pass', ms: 1 } as const
    expect(gateLine(pass, null, 0, null, 'x', 0, true).fields).not.toHaveProperty('rerun')
    expect(gateLine(pass, null, 0, null, 'x', 0, true, true).fields).toMatchObject({ rerun: true })
  })
})

describe('the stop gate hands runGates the engine\'s cut and the wait (10.6)', () => {
  test('a queued gate the engine cut is gate-unknown naming the cut, with its wait and its run', async () => {
    let now = 0
    let commands = 0
    let ended = false
    let release: () => void = () => undefined
    const holder = new Promise<void>(resolve => {
      release = resolve
    })
    const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    // only the pieces the stop gate touches: a clock with timers, and process.run
    const $ = {
      plugin: { root: '/plugins/factory-loop-workspace' },
      clock: {
        now: async () => now,
        after: () => ({ cancel: () => undefined }),
      },
      process: {
        run: async (argv: string[]) => {
          if (argv[0] === 'sleep') return new Promise(() => undefined)
          if (argv[0] === 'sh' && argv[2]?.startsWith('exec 2>&1\n')) {
            commands++
            if (commands === 1) {
              await holder
              return ok
            }
            // the queued gate's command: 4 s in, the engine ends the hook (a plain error text, so only cut() names it)
            now += 4_000
            ended = true
            throw new Error('the child was killed')
          }
          return ok
        },
      },
    } as unknown as Parameters<typeof runStopGate>[0]
    const target = { slot: SLOT, gitDir: '/w/g', issue: 571, life: 'ss1x2k', seq: 7, gateCommands: ['npm test'], gateTimeoutMs: 600_000, loopDir: '/c/loop-cut-test', gateConcurrency: 1, gateWaitTimeoutMs: 1_800_000 }
    const first = runStopGate($, target, new Date(0).toISOString(), { cut: () => false })
    await tick()
    const second = runStopGate($, target, new Date(0).toISOString(), { cut: () => ended })
    await tick()
    now += 7_000
    release()
    await first
    const out = await second
    if (!out.ran || out.result.result !== 'unknown') throw new Error(`expected an unknown result, got ${JSON.stringify(out)}`)
    expect(out.result.why).toContain('the hook was cut off 11 s after the gate started (7 s waiting, 4 s running)')
  })
})

describe('the gate\'s memory sampler', () => {
  test('the parsers take an integer and nothing else', () => {
    expect(parseCurrent('123456\n')).toBe(123456)
    expect(parseCurrent('')).toBeNull()
    expect(parseCurrent('garbage')).toBeNull()
    expect(parseCurrent('-5')).toBeNull()
    expect(parseCurrent('99999999999999999999')).toBeNull()
    expect(parseCurrent(null)).toBeNull()
    expect(parseMax('17179869184\n')).toBe(17179869184)
    expect(parseMax('max\n')).toBeNull()
    expect(parseMax(null)).toBeNull()
  })

  // a manual clock and a reader that answers from a list ('fail' throws, a string is the file's text)
  function rig(readings: (string | 'fail')[], max: string | null = '1000') {
    let tick: (() => void) | null = null
    let canceled = false
    let n = 0
    const io = {
      read: async () => {
        const r = readings[Math.min(n++, readings.length - 1)]
        if (r === 'fail') throw new Error('EIO')
        return { current: r ?? null, max }
      },
      every: (_ms: number, fn: () => void) => {
        tick = fn
        return { cancel: () => void (canceled = true) }
      },
    }
    return { io, fire: async () => { tick?.(); for (let i = 0; i < 10; i++) await Promise.resolve() }, canceled: () => canceled, reads: () => n }
  }

  test('keeps the start, the peak across rising and falling readings, and the count', async () => {
    const r = rig(['10', '50', '30', '20'])
    const s = await startMemorySampler(r.io)
    await r.fire()
    await r.fire()
    expect(await s.stop()).toEqual({ memStartBytes: 10, memPeakBytes: 50, memLimitBytes: 1000, memSamples: 4 })
  })

  test('a failed or unparsable read counts no sample and is never thrown', async () => {
    const r = rig(['fail', '40', 'garbage', 'fail'])
    const s = await startMemorySampler(r.io)
    await r.fire()
    await r.fire()
    expect(await s.stop()).toEqual({ memStartBytes: 40, memPeakBytes: 40, memLimitBytes: 1000, memSamples: 1 })
  })

  test('no reading worked: all null and zero samples', async () => {
    const r = rig(['fail'])
    const s = await startMemorySampler(r.io)
    expect(await s.stop()).toEqual({ memStartBytes: null, memPeakBytes: null, memLimitBytes: null, memSamples: 0 })
  })

  test('stop cancels the timer, reads once more, and a tick after it reads nothing', async () => {
    const r = rig(['1', '2'])
    const s = await startMemorySampler(r.io)
    expect(r.canceled()).toBe(false)
    const out = await s.stop()
    expect(r.canceled()).toBe(true)
    const reads = r.reads()
    await r.fire()
    expect(r.reads()).toBe(reads)
    expect(out).toMatchObject({ memStartBytes: 1, memPeakBytes: 2, memSamples: 2 })
    expect(await s.stop()).toBe(out)
  })
})

describe('the container\'s gate slots (10.6)', () => {
  const O = { wrapper: '/p/bin/factory-gate-slot', dir: '/l/gate-slots', capacity: 2, waitMs: 0, log: '/l/companion.jsonl', issue: 5, life: 'ab1', seq: 3 }

  test('the slot dir is under the loop dir', () => {
    expect(slotDir('/l/o__r')).toBe('/l/o__r/gate-slots')
    expect(slotDir('/l/o__r/')).toBe('/l/o__r/gate-slots')
  })

  test('an agent\'s wait is what the timeout leaves past the gate\'s budget', () => {
    expect(agentWaitMs(600_000, 600_000)).toBe(0)
    expect(agentWaitMs(600_000, 120_000)).toBe(480_000)
    expect(agentWaitMs(60_000, 600_000)).toBe(0)
  })

  test('the prelude defines one function per program', () => {
    const p = gatePrelude(['npm run lint', 'npm test', 'make check'], O) as string
    expect(p.match(/(?:^|; )\w+\(\) \{/g)).toEqual(['npm() {', '; make() {'])
    expect(p).not.toContain('\n')
  })

  test('a gate command with shell syntax or a path program is left out; none left is null', () => {
    expect(gatePrelude(['npm run lint && npm test', 'echo "x"', './check', 'a;b', 'npm run $X', 'sh -c y > z'], O)).toBeNull()
    expect(gatePrelude([], O)).toBeNull()
    expect(gatePrelude(['./check', 'npm test'], O)).toMatch(/^npm\(\)/)
  })

  test('parseSlotLine reads the slot line, the busy line and plain output', () => {
    expect(parseSlotLine('factory-gate-slot: slot 1 after 250 ms\nhello\n')).toEqual({ kind: 'slot', slot: 1, ms: 250, rest: 'hello\n' })
    expect(parseSlotLine('factory-gate-slot: busy: the container\'s 2 gate slots were all taken for 5 s; run a subset\n')).toEqual({ kind: 'busy' })
    expect(parseSlotLine('hello\n')).toEqual({ kind: 'none' })
    // a busy line with other output after it is the command's, not a refusal
    expect(parseSlotLine('factory-gate-slot: busy: x\nmore\n')).toEqual({ kind: 'none' })
  })

  test('slotCommand quotes the command for sh -c', () => {
    const text = slotCommand('echo \'a b\'', { wrapper: '/p/w', dir: '/d', capacity: 2, sliceMs: 5000 })
    expect(text).toBe(String.raw`sh '/p/w' --dir '/d' --capacity 2 --wait-ms 5000 -- sh -c 'echo '\''a b'\'''`)
  })

  test('runSlotted retries a busy answer, strips the slot line and counts the wait; the cap ends it', async () => {
    const answers = [{ exitCode: 75, stdout: 'factory-gate-slot: busy: x\n' }, { exitCode: 3, stdout: 'factory-gate-slot: slot 1 after 120 ms\nout\n' }]
    const state = { capMs: 60_000, waitedMs: 0 }
    expect(await runSlotted(state, 5_000, async () => answers.shift() as { exitCode: number; stdout: string })).toEqual({ exitCode: 3, output: 'out\n', slotWaitMs: 5_120 })
    expect(state.waitedMs).toBe(5_120)
    const capped = { capMs: 10_000, waitedMs: 0 }
    const r = await runSlotted(capped, 5_000, async () => ({ exitCode: 75, stdout: 'factory-gate-slot: busy: x\n' }))
    expect(r).toMatchObject({ slotWaitMs: 10_000 })
    expect('error' in r && r.error).toContain('gate slot')
    // output that is not the wrapper's goes through
    expect(await runSlotted({ capMs: 1, waitedMs: 0 }, 5_000, async () => ({ exitCode: 75, stdout: 'other\n' }))).toEqual({ exitCode: 75, output: 'other\n', slotWaitMs: 0 })
  })
})
