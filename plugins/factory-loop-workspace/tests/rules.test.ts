// The companion's rules, pure (docs/factory-loop/v2/SPEC.md 10.3, 10.4, 10.6): which writes,
// pushes and commands each role is refused, how a command line is read, the marker check, and the
// stop gate's results.
import { describe, expect, test } from 'claude-code/testing'

import { blockText, gateRecord, runGates, tail } from '../hooks/gate'
import type { Ran } from '../hooks/gate'
import { agentRefusal, backgroundRefusal, bashRefusal, fileRefusal, needsHead, normalize } from '../hooks/guard'
import type { Guarded } from '../hooks/guard'
import { mismatch, nameParts, parseMarker, slotLine } from '../hooks/marker'
import { INPUT_CLIP, clip, enc, inputOf, promptNote, promptReason, transcriptOf, unguardedGlob, whyOf } from '../hooks/prompt'
import { scratchOk, withScratch } from '../hooks/scratch'
import { simpleCommands } from '../hooks/shell'

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
    expect(simpleCommands("bash -lc 'npm test | tail -5' || env -u X sudo -u me no-mistakes")).toEqual([
      ['npm', 'test'],
      ['tail', '-5'],
      ['no-mistakes'],
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
    test(`GitHub writes, no-mistakes and axi (${g.role})`, () => {
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
        'no-mistakes run',
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

  test('a command that cannot finish, or a budget spent, is unknown and never a pass', async () => {
    const timedOut = await runGates(io([{ error: 'the child was killed after 600000 ms' }]).io, ['npm test'], 600_000)
    expect(timedOut.result).toBe('unknown')
    const spent = await runGates(io([{ exitCode: 0, output: '', ms: 600_000 }]).io, ['npm run lint', 'npm test'], 600_000)
    expect(spent.result).toBe('unknown')
    if (spent.result === 'unknown') expect(spent.why).toContain('npm test')
  })

  test('its record carries the result and the head', () => {
    expect(gateRecord({ result: 'pass', ms: 5 }, 'abc', 0, ['npm test'])).toEqual({ v: 1, at: '1970-01-01T00:00:00.000Z', head: 'abc', commands: ['npm test'], result: 'pass', ms: 5 })
    expect(gateRecord({ result: 'unknown', ms: 5, why: 'x' }, null, 0, [])).toMatchObject({ result: 'unknown', why: 'x', head: null })
    expect(tail('a\nb\nc\n\n', 2)).toBe('b\nc')
  })
})

describe('prompts nobody answers', () => {
  test('enc leaves no space or percent in a value', () => {
    expect(enc('rm -f $D/* 100%')).toBe('rm%20-f%20$D/*%20100%25')
    expect(enc('a\nb\tc')).toBe('a%0Ab%09c')
  })

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

  test('the note has every token, none for the unknown, and a value with no space in it', () => {
    expect(promptNote({ life: 'ss1x2k', seq: 7, tool: 'Bash', input: 'rm -f $D/*', agent_type: 'none' })).toBe(
      'life=ss1x2k seq=7 step=none attempt=none agent=none agent_type=%6Eone tool=Bash slot=none session=none transcript=none why=none input=rm%20-f%20$D/*',
    )
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
