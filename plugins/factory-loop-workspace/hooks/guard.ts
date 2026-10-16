// The write guard's rules (docs/factory-loop/v2/SPEC.md 10.4), pure: what a loop agent may not
// do, by its role, with the reason the agent is told. register.ts applies them in its tool.call
// hook to the agents the loop started in a slot, and to their children.
//
// - File tools: a writer writes inside its slot or outside the repository (a scratch file in
//   /tmp); a reader writes nowhere in the repository. The repository is the slot and the main
//   checkout, whose tree holds the pool's other slots.
// - Every loop agent: no GitHub writes (the loop owns PRs, issues, labels and re-runs), no
//   no-mistakes, no axi, no push to a remote but origin, no call in the background (Bash or
//   Agent), no isolated Agent call.
// - A writer pushes only its branch to origin, never by force, creates no branch and no worktree.
// - A reader neither commits nor pushes.
import { program, simpleCommands } from './shell'

export type Role = 'writer' | 'reader'

// What the guard knows of an agent: its slot, its role and branch (the step marker's), and the
// repository's roots (the slot, and the main checkout when the slot is one of its worktrees).
export type Guarded = { slot: string; role: Role; branch: string; roots: string[] }

export type Cause = 'guard:write' | 'guard:push' | 'guard:command'
export type Refusal = { cause: Cause; reason: string }

export const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

// --- paths ------------------------------------------------------------------------------------------

// normalize: an absolute path with no `.`, `..` or doubled `/`; a relative one is resolved
// against base first (Write's file_path can arrive relative).
export function normalize(path: string, base: string): string {
  const out: string[] = []
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

export function within(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`)
}

// fileRefusal: a file tool's write to path (absolute, normalized), or null when it may go ahead.
export function fileRefusal(g: Guarded, path: string): Refusal | null {
  const inRepo = within(path, g.slot) || g.roots.some(r => within(path, r))
  if (g.role === 'writer') {
    if (within(path, g.slot) || !inRepo) return null
    return { cause: 'guard:write', reason: `${path} is outside your slot ${g.slot}: write only inside it` }
  }
  if (!inRepo) return null
  return { cause: 'guard:write', reason: `${path} is in the repository, and this step reads only: write nowhere in ${g.slot} or another checkout (a scratch file outside the repository is fine)` }
}

// --- commands ---------------------------------------------------------------------------------------

// The gh commands that write to GitHub, by group, aliases included (`gh pr new` is `gh pr
// create`): the loop owns these (10.4). `*`: every subcommand of the group.
const GH_WRITES: Record<string, readonly string[] | '*'> = {
  pr: ['create', 'new', 'edit', 'merge', 'close', 'reopen', 'review', 'update-branch', 'comment', 'ready', 'revert', 'lock', 'unlock'],
  issue: ['create', 'new', 'edit', 'close', 'comment', 'reopen', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin', 'develop'],
  label: '*',
  run: ['rerun', 'cancel', 'delete'],
  workflow: ['run', 'enable', 'disable'],
  release: ['create', 'new', 'edit', 'delete', 'upload', 'delete-asset'],
  repo: ['create', 'new', 'edit', 'rename', 'archive', 'unarchive', 'delete', 'sync', 'fork', 'deploy-key'],
  secret: '*',
  variable: '*',
  cache: ['delete'],
  gist: ['create', 'new', 'edit', 'rename', 'delete'],
}
const GH_VALUED = ['-R', '--repo', '-H', '--header', '-q', '--jq', '-t', '--template', '-p', '--preview', '--hostname', '--cache']
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']
const FIELD_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input']
const LOOP_TOOLS = ['no-mistakes', 'axi']

// The git options that come before the subcommand and take a value.
const GIT_VALUED = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']

// gitArgs: a git command's subcommand and its arguments, past git's own options; null when argv
// runs no git subcommand.
function gitArgs(argv: readonly string[]): string[] | null {
  let i = 1
  while (i < argv.length && (argv[i] ?? '').startsWith('-')) i += GIT_VALUED.includes(argv[i] ?? '') ? 2 : 1
  return i < argv.length ? argv.slice(i) : null
}

function ghArgs(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (GH_VALUED.includes(a)) i++
    else if (!a.startsWith('-')) out.push(a)
  }
  return out
}

// ghWrite: why a gh command writes to GitHub, or null.
function ghWrite(argv: readonly string[]): string | null {
  const [group, sub] = ghArgs(argv)
  if (group === 'api') {
    let method: string | null = null
    let fields = false
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i] ?? ''
      if (a === '-X' || a === '--method') method = (argv[i + 1] ?? '').toUpperCase()
      else if (/^-X./.test(a)) method = a.slice(2).toUpperCase()
      else if (a.startsWith('--method=')) method = a.slice('--method='.length).toUpperCase()
      else if (FIELD_FLAGS.includes(a) || FIELD_FLAGS.some(f => a.startsWith(`${f}=`)) || /^-[fF]./.test(a)) fields = true
    }
    if (method !== null && WRITE_METHODS.includes(method)) return `gh api with method ${method}`
    if (fields && method !== 'GET') return 'gh api with field flags (a write)'
    return null
  }
  const writes = group === undefined ? undefined : GH_WRITES[group]
  if (writes === undefined) return null
  if (writes === '*' || (sub !== undefined && writes.includes(sub))) return `gh ${group}${writes === '*' ? '' : ` ${sub}`}`
  return null
}

// A push's parts: the remote (origin when none is named), its refspecs, and its flags.
type Push = { remote: string; refspecs: string[]; flags: string[] }

const PUSH_VALUED = ['-o', '--push-option', '--receive-pack', '--exec']
const PUSH_OK_FLAGS = ['-u', '--set-upstream', '-v', '--verbose', '-q', '--quiet', '--porcelain', '--progress', '--no-progress', '-n', '--dry-run', '--no-verify', '--verify', '--atomic']

function pushOf(args: readonly string[]): Push {
  const flags: string[] = []
  const rest: string[] = []
  let remote: string | null = null
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a.startsWith('--repo=')) remote = a.slice('--repo='.length)
    else if (a === '--repo') remote = args[++i] ?? ''
    else if (PUSH_VALUED.includes(a)) i++
    else if (/^-[a-zA-Z]{2,}$/.test(a)) flags.push(...[...a.slice(1)].map(ch => `-${ch}`))
    else if (a.startsWith('-')) flags.push(a)
    else rest.push(a)
  }
  if (remote === null) remote = rest.shift() ?? 'origin'
  return { remote, refspecs: rest, flags }
}

// pushRefusal: why a writer's push may not go ahead, or null. head is the slot's current branch
// (null: unknown), read only when the push names no refspec or pushes HEAD.
function pushRefusal(g: Guarded, p: Push, head: string | null): string | null {
  const force = p.flags.find(f => f === '-f' || f === '--force' || f.startsWith('--force-with-lease') || f === '--force-if-includes')
  if (force !== undefined) return `a force push (${force}) is refused: push your branch ${g.branch} without force`
  const other = p.flags.find(f => !PUSH_OK_FLAGS.includes(f))
  if (other !== undefined) return `git push ${other} is refused: push only your branch, as git push origin ${g.branch}`
  const specs = p.refspecs.length === 0 ? [null] : p.refspecs
  for (const spec of specs) {
    if (spec !== null && spec.startsWith('+')) return `a force push (${spec}) is refused: push your branch ${g.branch} without force`
    let dst = spec === null ? 'HEAD' : spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec
    if (spec !== null && spec.startsWith(':')) return `deleting a remote ref (${spec}) is refused`
    if (dst === 'HEAD') dst = head ?? 'HEAD'
    dst = dst.replace(/^refs\/heads\//, '')
    if (dst !== g.branch) return `a push to ${dst === 'HEAD' ? 'the current branch, which is not known' : dst} is refused: push only your branch, as git push origin ${g.branch}`
  }
  return null
}

// needsHead: whether a command's pushes need the slot's current branch to be judged.
export function needsHead(command: string): boolean {
  return simpleCommands(command).some(argv => {
    if (program(argv) !== 'git') return false
    const args = gitArgs(argv)
    if (args === null || args[0] !== 'push') return false
    const p = pushOf(args)
    return p.refspecs.length === 0 || p.refspecs.some(s => s === 'HEAD' || s.endsWith(':HEAD'))
  })
}

// The git branch options that read, delete or set an upstream rather than create a branch.
const BRANCH_READS = ['-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '-d', '-D', '--delete', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '--column', '--no-column', '--color', '--no-color']
const BRANCH_MAKES = ['-m', '-M', '-c', '-C', '--move', '--copy', '-f', '--force']

// branchMade: the branch command a writer may not run (creating, renaming or copying a branch, or
// a worktree), or null.
function branchMade(args: readonly string[]): string | null {
  const [sub, ...rest] = args
  if (sub === 'switch' && rest.some(a => ['-c', '-C', '--create', '--force-create', '--orphan'].includes(a) || /^--(force-)?create=/.test(a))) return 'git switch -c'
  if (sub === 'checkout' && rest.some(a => ['-b', '-B', '--orphan'].includes(a))) return 'git checkout -b'
  if (sub === 'branch') {
    if (rest.some(a => BRANCH_MAKES.includes(a))) return 'git branch -m/-c'
    const named = rest.some(a => !a.startsWith('-'))
    if (named && !rest.some(a => BRANCH_READS.includes(a) || BRANCH_READS.some(r => a.startsWith(`${r}=`)))) return 'git branch <name>'
  }
  if (sub === 'worktree' && rest[0] !== 'list') return `git worktree${rest[0] === undefined ? '' : ` ${rest[0]}`}`
  return null
}

// bashRefusal: the first rule a Bash command breaks, or null. head: the slot's current branch,
// which the hook reads when needsHead says a push needs it.
export function bashRefusal(g: Guarded, command: string, head: string | null = null): Refusal | null {
  for (const argv of simpleCommands(command)) {
    const name = program(argv)
    if (LOOP_TOOLS.includes(name)) return { cause: 'guard:command', reason: `${name} is not used by the factory loop's agents: the loop reviews, opens the PR and merges itself` }
    if (name === 'gh') {
      const write = ghWrite(argv)
      if (write !== null) return { cause: 'guard:command', reason: `${write} is refused: the factory loop owns GitHub writes (PRs, issues, labels, re-runs); say what you need in your answer instead` }
      continue
    }
    if (name !== 'git') continue
    const args = gitArgs(argv)
    if (args === null) continue
    if (args[0] === 'push') {
      const p = pushOf(args)
      if (g.role === 'reader') return { cause: 'guard:push', reason: 'git push is refused: this step reads only' }
      if (p.remote !== 'origin') return { cause: 'guard:push', reason: `a push to ${p.remote} is refused: push only to origin, as git push origin ${g.branch}` }
      const why = pushRefusal(g, p, head)
      if (why !== null) return { cause: 'guard:push', reason: why }
      continue
    }
    if (g.role === 'reader' && args[0] === 'commit') return { cause: 'guard:command', reason: 'git commit is refused: this step reads only' }
    if (g.role === 'writer') {
      const made = branchMade(args)
      if (made !== null) return { cause: 'guard:command', reason: `${made} is refused: work on your branch ${g.branch} in your slot ${g.slot}` }
    }
  }
  return null
}

// backgroundRefusal: any call in the background, Bash or Agent, so an agent neither ends its turn
// while work it started still runs (failures/F13) nor sits polling for it (R4-O4); a command runs
// in the foreground under its 10-minute timeout (10.5).
export function backgroundRefusal(tool: string, input: { run_in_background?: unknown }): Refusal | null {
  if (input.run_in_background !== true) return null
  return { cause: 'guard:command', reason: `${tool} in the background is refused: run it in the foreground and wait for it, a command with a timeout of up to 600000 ms` }
}

// agentRefusal: an Agent call with an isolation: `remote` always runs in the background, and
// `worktree` makes a git worktree, which a writer may not.
export function agentRefusal(input: { isolation?: unknown }): Refusal | null {
  if (input.isolation === undefined || input.isolation === null) return null
  return { cause: 'guard:command', reason: `an Agent call with isolation ${JSON.stringify(input.isolation)} is refused: leave isolation out, run it in the foreground in your own folder and wait for its answer` }
}
