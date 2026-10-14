// The spawn prompts (SPEC 6.3): one template per agent and purpose. A template carries only
// issue numbers, URLs, branch names, run ids, heads, step names, instructions from the
// adjudicator or the model, owner notes, pointers (CLAUDE.md, the agent type's own memory file
// (D-22), the implement-issue skill), a per-issue scratch subdirectory (I-95) and the machine
// line the loop parses (replies.ts). Never a brief's content: a brief travels as its URL only,
// and anything else in its place is dropped. Never a GitHub closing keyword before an issue
// reference (I-33): the template text uses none of the words, every id is checked for its
// shape, and free text (notes, instructions, guard and verdict lines) is neutralized. Each agent
// is asked to answer on the channel the setting answerChannel names (askOf): through the checked
// answer script (the default, #561), through its answer tool (agent-tools.ts, #548), or with its
// machine line alone (#560); the machine line stays the fallback of the other two. The one
// repair message for an answer the loop could not read is here too. Pure, so
// tests/prompts.test.ts renders every template with hostile inputs.
import { DESIGN, HANDOFF, TOOL_OF, VERDICT } from './agent-tools'
import { DESIGNER_RESULT, HANDOFF_RESULT, isBriefUrl } from './replies'
import type { Action, AdjudicatorPurpose, AgentType, AnswerChannel, FixerPurpose } from './types'

export type SpawnAction = Extract<Action, { kind: 'spawn' }>
export type DelegateAction = Extract<Action, { kind: 'delegate' }>
// The actions that start an agent: a spawn, or a delegate's implementer.
export type AgentAction = SpawnAction | DelegateAction

// A branch in flight for the designer: another issue's current run.
export type InFlight = { branch: string; issue: number | null }

export type PromptEnv = {
  repo: string
  // the issue's model label, passed on to the sub-agents the agent spawns (implement-issue)
  modelOverride: string | null
  // the designer only: other issues' branches in flight
  inFlight: InFlight[]
  // the owner's notes for this issue (control notes, SPEC 4.3, 6.3): every agent but the
  // designer, whose action carries them already, gets them before its reading list
  notes?: readonly string[]
  // config answerChannel (SPEC 4.2): the channel the agent is asked to answer on; absent is
  // text alone
  channel?: AnswerChannel
  // the answer script and this attempt's answer file, for the script channel (#561)
  script?: ScriptPlace | null
}

// Where an agent records its answer with the answer script: the script, and the answer file
// unique to its ledger entry and attempt (exec.ts scriptAnswerPath), both absolute.
export type ScriptPlace = { bin: string; file: string }

// A free-text value longer than this is cut: a prompt points, it does not carry documents.
const TEXT_MAX = 4000
const IN_FLIGHT_MAX = 20

// --- neutralizing free text ------------------------------------------------------------------

// A closing keyword (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved, any
// case) that an issue reference follows (#N, GH-N, owner/repo#N, a URL), or that ends the
// value, where the template's next words could follow it. Broader than GitHub's own parser on
// purpose.
const CLOSING = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(?=\W{0,8}(?:#|gh-\d|https?:|[\w.-]+\/[\w.-]+#)|\W*$)/gi

// participle: the keyword as its -ing form, which GitHub does not read, in the same case.
function participle(word: string): string {
  const lower = word.toLowerCase()
  const ing = lower.startsWith('clos') ? 'closing' : lower.startsWith('fix') ? 'fixing' : 'resolving'
  if (word === word.toUpperCase()) return ing.toUpperCase()
  return word.charAt(0) === word.charAt(0).toUpperCase() ? ing.charAt(0).toUpperCase() + ing.slice(1) : ing
}

// neutral: free text made safe for a prompt: control characters dropped, length capped, and
// each closing keyword before a reference turned into its participle ("Fixes #12" reads
// "Fixing #12"), so an agent that copies the text into a PR body closes nothing.
export function neutral(text: string): string {
  const clean = text.replace(/[^\S\n\t ]|[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim()
  const capped = clean.length > TEXT_MAX ? `${clean.slice(0, TEXT_MAX - 3)}...` : clean
  return capped.replace(CLOSING, participle)
}

// Each line of a free-text block, indented under its heading.
function block(heading: string, texts: readonly string[]): string[] {
  const body = texts
    .map(neutral)
    .filter(t => t !== '')
    .flatMap(t => t.split('\n').map(l => `  ${l.trim()}`))
  return body.length === 0 ? [] : [heading, ...body]
}

// --- ids, each checked for its shape -------------------------------------------------------------

const SHAPES = {
  repo: /^[\w.-]+\/[\w.-]+$/,
  branch: /^[A-Za-z0-9._/-]+$/,
  run: /^[A-Za-z0-9_-]+$/,
  head: /^[0-9a-f]{7,40}$/i,
  step: /^[A-Za-z0-9_-]+$/,
  model: /^[A-Za-z0-9._-]+$/,
}

// id: the value when it has its shape, else null (shown as not known): a garbled id would send
// an agent to the wrong place, and a free-text one could carry anything.
function id(value: string | null | undefined, shape: keyof typeof SHAPES): string | null {
  return typeof value === 'string' && SHAPES[shape].test(value) ? value : null
}

function issueNo(n: number | null): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

// --- shared lines ----------------------------------------------------------------------------

function issueRef(repo: string | null, n: number | null): string {
  if (n === null) return 'an issue the loop did not name'
  return repo === null ? `issue #${n}` : `issue #${n} (https://github.com/${repo}/issues/${n})`
}

function prRef(repo: string | null, pr: number | null): string | null {
  const n = issueNo(pr)
  if (n === null) return null
  return repo === null ? `PR #${n}` : `PR #${n} (https://github.com/${repo}/pull/${n})`
}

function briefLines(repo: string | null, brief: string | null, n: number | null): string[] {
  if (repo !== null && brief !== null && isBriefUrl(brief, repo)) {
    return [`Brief: ${brief}. Read it with \`callum-flow-issue-read --comment ${brief}\`.`]
  }
  const read = n === null ? '' : ` Read the issue and its comments with \`callum-flow-issue-read ${n} --comments\` instead, and say so.`
  return [`Brief: none known.${read}`]
}

function readFirst(type: AgentType): string {
  // the adjudicator starts no sub-agents (its tools have no Agent)
  const foreground = type === 'adjudicator' ? '' : ` ${FOREGROUND_RULE}`
  return `Read CLAUDE.md and your memory file .claude/agent-memory/${type}.md first. ${CHECKOUT_RULE}${foreground} ${COMMAND_RULE}`
}

// Agents start in the session's directory, the factory's main checkout, which the loop and every
// other agent read from. On the testbed a read-only adjudicator ran `git checkout` there and left
// it detached on another issue's branch, so every agent is told plainly.
// The loop reads an agent's first final message as its answer. On the testbed a designer started
// its explorer in the background and ended its turn to wait, so its answer was a wait note.
export const FOREGROUND_RULE =
  'Run any sub-agent you start in the foreground and wait for it there: your turn ends only with your final answer, given as asked below.'

export const CHECKOUT_RULE =
  'You start in the factory\'s main checkout: never check out, switch, reset, stash or commit in it. Read another branch with `git show` or `git diff origin/<branch>`, and do any work in a worktree of your own.'

// Two incidents on 2026-10-14: an agent ran `claude remote-control --help`, which starts a session
// and never exits, and others waited with `until ! pgrep -f <pattern>`, which matches its own shell.
export const COMMAND_RULE =
  'Run only commands known to exit. Read source, docs and `--help` output only from such commands, and bound any exploratory command with `timeout 30`. Never start a server, a watcher, a Remote Control session (`claude remote-control`, `claude --remote-control`) or any interactive or long-running command. Leave no background shell or wait loop running when you hand in your answer. The one exception is the detached no-mistakes pipeline run (`axi run` or `axi respond`) that the implement-issue skill launches. Wait on a PID you recorded or on the tool\'s own status, never with `pgrep -f <pattern>` from a shell whose command line contains the pattern.'

function modelLine(model: string | null): string[] {
  const m = id(model, 'model')
  return m === null ? [] : [`Model override: ${m} (the issue's model label). Pass it as \`model\` to any sub-agent you spawn.`]
}

function scratch(n: number | null): string {
  const dir = n === null ? 'loop' : `issue-${n}`
  return `Scratch: keep temporary files in the ${dir} subdirectory of your scratchpad directory, never at its top level: other agents share the scratchpad.`
}

// --- the answer channel (SPEC 4.2 answerChannel) --------------------------------------------------

// The channel a prompt asks for, with what it needs.
export type Ask = { kind: 'script'; place: ScriptPlace } | { kind: 'tool' } | { kind: 'text' }

// An absolute path with nothing in it a shell or a closing keyword could use: no space, quote,
// `$` or `#`.
const PATH = /^\/[A-Za-z0-9._/-]+$/

// scriptShaped: both paths of a script place have the shape a prompt may carry, and are plain
// (no `..`, `.` or empty part, so no `//` or `/./`): the answer script refuses any path that is
// not, so such a spawn is asked for text instead.
export function scriptShaped(place: ScriptPlace): boolean {
  return [place.bin, place.file].every(p => PATH.test(p) && p.slice(1).split('/').every(part => part !== '' && part !== '.' && part !== '..'))
}

// askOf: the channel a prompt asks for. `script` is a TEMPORARY WORKAROUND (#561, DECISIONS D-74):
// the registered answer tools (`tool`, #548) are the intended design, but on Claude Code 2.1.296
// and 2.1.299 an agent the loop spawns from its timer never reaches the loop's tool hook (#560,
// SPEC 13), while its Bash works. The words agents read stay neutral: they name the script and
// what it does, never why. Script only with both paths in their shape, else text.
export function askOf(channel: AnswerChannel | undefined, script: ScriptPlace | null | undefined): Ask {
  if (channel === 'script') return script !== undefined && script !== null && scriptShaped(script) ? { kind: 'script', place: script } : { kind: 'text' }
  return channel === 'tool' ? { kind: 'tool' } : { kind: 'text' }
}

// toolAsk: the answer through the agent's tool (agent-tools.ts), which checks it while the agent
// can still correct it; the machine line after it stays the fallback.
function toolAsk(ask: string): string {
  return `${ask} (load it with ToolSearch first if it is listed by name only). If it returns an error, correct the call and call it again; once it is recorded, end your turn.`
}

// scriptAsk: the answer recorded with the answer script (bin/factory-answer), which checks it
// against the contract while the agent can still correct it: the command with an example of its
// JSON, given as a here-document so no quote in the answer trips the shell, then what each field
// means. The command, the JSON and the closing JSON line stand at column 0, so the block runs as
// copied: bash ends a here-document only at a line that is exactly its word. The machine line
// after it stays the fallback.
function scriptAsk(place: ScriptPlace, lead: string, example: string, fields: string): string[] {
  return [
    `${lead}, record your answer with the factory loop's answer script, once, its JSON on standard input, each line below from the start of its line and the closing JSON alone on the last:`,
    `${place.bin} --to ${place.file} <<'JSON'`,
    example,
    'JSON',
    `${fields} The script records your answer for the factory loop and changes nothing else. If it prints problems, correct the JSON and run it again; once it says your answer is recorded, end your turn.`,
  ]
}

const SCRIPT_FALLBACK = 'If the script cannot record your answer, '
const TOOL_FALLBACK = 'If you cannot call it, '

// What one template offers each channel: the script's ask, the tool's ask, and the text ask
// (lower case, as it follows a fallback's "If ..., "); alone: the text ask on the text channel,
// the text ask capitalized when not given.
type Asks = { script: (place: ScriptPlace) => string[]; tool: string; text: string; alone?: string }

// answerLines: how an agent is asked for its answer on its channel: the script's or the tool's
// ask, then the text ask as their fallback; on the text channel, the text ask alone.
function answerLines(ask: Ask, asks: Asks): string[] {
  if (ask.kind === 'script') return [...asks.script(ask.place), `${SCRIPT_FALLBACK}${asks.text}`]
  if (ask.kind === 'tool') return [toolAsk(asks.tool), `${TOOL_FALLBACK}${asks.text}`]
  return [asks.alone ?? capital(asks.text)]
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// The JSON each contract takes (contract.mjs), shown by example and explained field by field.
const VERDICT_EXAMPLE = '{"findings": [{"id": "review-1", "verdict": "WRONG", "reason": "<the evidence, one sentence>"}], "action": {"type": "approve", "reason": "<the evidence>"}}'
const VERDICT_FIELDS =
  'findings: one { id, verdict, reason } per finding you judged, verdict one of CORRECT, WRONG, NIT, ENV, DUP ([] when there is nothing to report); a gap the reviewer missed takes an id of your own, missed-1 and on, and goes in action.addFinding. action: your one ACTION line as an object: type is its first word, and its options are its fields: reason, findings (a list of ids of the CORRECT or ENV findings above), instructions, addFinding (an object) and why.'
const MERGE_EXAMPLE = '{"findings": [], "action": {"type": "merge"}, "summary": "<what changes for users, one line>", "bump": {"level": "patch", "reason": "<why>"}, "flags": []}'
const MERGE_FIELDS =
  'findings: one { id, verdict, reason } per verdict line ([] for none). action: {"type": "merge"}, {"type": "hold", "reason": ...}, {"type": "fixer", "instructions": ...} or {"type": "escalate", "why": ...}. summary, bump ({ level, reason }) and flags (a list, [] for none): as the SUMMARY, BUMP and FLAGS lines below say.'
const DESIGN_FIELDS = "brief: the brief comment's URL, or null. created: the issue numbers you created ([] for none). pendingDecision: true when the brief waits on an owner decision."
const HANDOFF_EXAMPLE = '{"run": "<run id>", "head": "<head SHA>", "commit": "<your commit SHA>", "gated": true, "branch": "<branch>", "pr": null}'

function designExample(repo: string | null, n: number | null): string {
  return `{"brief": "https://github.com/${repo ?? '<owner>/<repo>'}/issues/${n ?? '<N>'}#issuecomment-<id>", "created": [], "pendingDecision": false}`
}

// What each field of the handoff's machine line (replies.ts parseHandoff) means.
const HANDOFF_FIELDS =
  'run and head: the pipeline run you started or drove, and its head from `no-mistakes status`. commit: your latest commit, or none when you drove the run with `axi respond` and committed nothing. gated: yes only with a run, when its head equals your commit or you committed nothing. branch: the branch the work is on now (a new one when `callum-flow-regate` moved you). pr: the PR number, or none.'

// handoffAsk: the handoff after implement-issue section 8, on the agent's channel, with what its
// fields mean; the machine line last, the fallback of the script and the tool.
function handoffAsk(ask: Ask): string[] {
  const after = 'After the implement-issue handoff (its section 8)'
  const line = 'end your final message with the line below, exactly once and last, filled in.'
  if (ask.kind === 'text') return [`${after}, ${line}`, HANDOFF_FIELDS, HANDOFF_RESULT]
  if (ask.kind === 'script') return [...scriptAsk(ask.place, after, HANDOFF_EXAMPLE, `${HANDOFF_FIELDS} In the JSON, none is null and yes is true.`), `${SCRIPT_FALLBACK}${line}`, HANDOFF_RESULT]
  return [
    toolAsk(`${after}, answer by calling ${HANDOFF} once, with run, head, commit, gated, branch and pr`),
    `${HANDOFF_FIELDS} In the tool, none is null and yes is true.`,
    `${TOOL_FALLBACK}${line}`,
    HANDOFF_RESULT,
  ]
}

// The adjudicator's fallback, its own output contract (a merge review's lines are its prompt's).
const CONTRACT = 'reply in your output contract and nothing else: verdict lines, then exactly one ACTION line.'

// --- the templates ---------------------------------------------------------------------------

// promptOf: the prompt for the agent this action starts.
export function promptOf(action: AgentAction, env: PromptEnv): string {
  const repo = id(env.repo, 'repo')
  const n = issueNo(action.issue)
  const ask = askOf(env.channel, env.script)
  let out: string[]
  if (action.kind === 'delegate') out = implementer(repo, n, action.brief, env.modelOverride, ask)
  else if (action.agent === 'designer') out = designer(repo, n, action.notes, env, ask)
  else if (action.agent === 'adjudicator') out = adjudicator(repo, n, action, ask)
  else out = fixer(repo, n, action, env.modelOverride, ask)
  if (action.kind === 'delegate' || action.agent !== 'designer') out = withNotes(out, env.notes ?? [])
  return out.join('\n')
}

// withNotes: the owner's notes go in before the agent's reading list. They are the owner's
// decisions for the issue, so they win where the brief disagrees (found on the testbed: an
// adjudicator without the owner's answer asked the same question again).
function withNotes(out: string[], notes: readonly string[]): string[] {
  const lines = block("Owner notes (the owner's decisions for this issue; where they differ from the brief, they win):", notes)
  if (lines.length === 0) return out
  const at = out.findIndex(l => l.startsWith('Read CLAUDE.md'))
  const i = at === -1 ? out.length : at
  return [...out.slice(0, i), ...lines, ...out.slice(i)]
}

function designer(repo: string | null, n: number | null, notes: readonly string[], env: PromptEnv, ask: Ask): string[] {
  const seen = new Set<string>()
  const branches: string[] = []
  for (const f of env.inFlight) {
    const branch = id(f.branch, 'branch')
    if (branch === null || seen.has(branch) || branches.length >= IN_FLIGHT_MAX) continue
    seen.add(branch)
    const other = issueNo(f.issue)
    branches.push(`  ${branch}${other === null ? '' : `, for issue ${other}`}`)
  }
  return [
    `Design ${issueRef(repo, n)}, as your agent definition says.`,
    readFirst('designer'),
    ...(branches.length === 0 ? [] : ['Branches in flight (find the shared files they touch, and sequence after them where needed):', ...branches]),
    ...block('Owner notes:', notes),
    ...modelLine(env.modelOverride),
    scratch(n),
    ...answerLines(ask, {
      script: place => scriptAsk(place, 'Once the brief is posted', designExample(repo, n), DESIGN_FIELDS),
      tool: `Once the brief is posted, answer by calling ${DESIGN} with brief, created and pendingDecision`,
      text: 'end your return with the line below, exactly once and last, filled in.',
      alone: 'Once the brief is posted, end your return with the line below, exactly once and last, filled in.',
    }),
    DESIGNER_RESULT,
  ]
}

type AdjudicatorSpawn = Extract<SpawnAction, { agent: 'adjudicator' }>

function adjudicator(repo: string | null, n: number | null, a: AdjudicatorSpawn, ask: Ask): string[] {
  const run = id(a.run, 'run')
  const branch = id(a.branch, 'branch')
  const head = id(a.head, 'head')
  const pr = prRef(repo, a.pr)
  const where = [run === null ? null : `run ${run}`, branch === null ? null : `branch ${branch}`, head === null ? null : `head ${head}`]
    .filter(w => w !== null)
    .join(', ')
  const contract = answerLines(ask, {
    script: place => scriptAsk(place, 'Once you have judged every finding', VERDICT_EXAMPLE, VERDICT_FIELDS),
    tool: `Answer by calling ${VERDICT} once, with your findings and one action`,
    text: CONTRACT,
  })
  if (a.purpose === 'gate') {
    const step = id(a.step, 'step')
    return [
      step === null
        ? `Adjudicate the failed gate of ${run === null ? 'the run' : `run ${run}`} for ${issueRef(repo, n)}. The event log does not name its step: find it with \`no-mistakes axi status --run ${run ?? '<id>'}\`.`
        : `Adjudicate the ${step} gate of ${run === null ? 'the run' : `run ${run}`} for ${issueRef(repo, n)}, which awaits a decision.`,
      ...(where === '' ? [] : [`Where: ${where}${pr === null ? '' : `, ${pr}`}.`]),
      ...briefLines(repo, a.brief, n),
      readFirst('adjudicator'),
      scratch(n),
      ...contract,
    ]
  }
  if (a.purpose === 'weakening') {
    return [
      `Judge the test-weakening warnings the merge guard printed for ${pr ?? 'the PR'} of ${issueRef(repo, n)}.`,
      ...(where === '' ? [] : [`Where: ${where}.`]),
      ...block('The warnings:', a.warns),
      'A removed or weakened test is CORRECT (restore it) unless the brief shows it is absolutely not required (WRONG: approve with that evidence as --reason).',
      ...briefLines(repo, a.brief, n),
      readFirst('adjudicator'),
      scratch(n),
      ...contract,
    ]
  }
  // purpose merge (rule M4, D-05): ids and pointers, never a diff
  const handoff = id(a.handoffHead, 'head')
  return [
    `Review ${pr ?? 'the PR'} of ${issueRef(repo, n)} before it merges. Its merge guard passed for this head.`,
    ...(where === '' ? [] : [`Where: ${where}.`]),
    handoff === null
      ? `The implementer's handoff head is not known: find the commits the pipeline added with \`no-mistakes axi status --run ${run ?? '<id>'}\`.`
      : `The implementer handed off at head ${handoff}.`,
    ...briefLines(repo, a.brief, n),
    ...block('The guard lines for this head:', a.guard),
    ...block("The run's verdict lines:", a.verdicts),
    readFirst('adjudicator'),
    'Read only: change nothing and post nothing. Check that:',
    `  1. the commits the pipeline added after the handoff head${handoff === null || head === null ? '' : ` (\`git log ${handoff}..${head}\`)`} keep every acceptance criterion and owner requirement in the brief, add nothing unrelated and weaken no test. With no such commits, say so and skip this check;`,
    `  2. the PR body links the issue as the brief's Rollout says${issueNo(a.pr) === null ? '' : ` (\`gh pr view ${a.pr} --json body,closingIssuesReferences\`)`}: merge needs a closing reference to the issue, run-it and keep-open a plain reference that leaves it open;`,
    '  3. a visible (UI) change has screenshot or video evidence in the PR body.',
    scratch(n),
    ...answerLines(ask, {
      script: place => scriptAsk(place, 'Once you have checked all three', MERGE_EXAMPLE, MERGE_FIELDS),
      tool: `Answer by calling ${VERDICT} once, with your findings, one action (merge, hold, fixer or escalate), summary, bump and flags`,
      text: 'reply with exactly these lines and nothing else:',
    }),
    '  verdict lines `<VERDICT>: <reason>` for what you find, VERDICT one of CORRECT, WRONG, NIT, ENV, DUP (none when there is nothing to report);',
    '  one ACTION line: `ACTION: merge`, `ACTION: hold <reason>` when the owner must decide, or `ACTION: fixer: <instructions>` when a change is needed before the merge;',
    '  `SUMMARY: <what changes for users, one line>`;',
    '  `BUMP: <patch|minor|major> <reason>`;',
    '  `FLAGS: <image,template,restart,run-it or none>`: image for a base image change, template for a template change, restart when a workspace restart is needed, run-it for a run-it rollout.',
  ]
}

type FixerSpawn = Extract<SpawnAction, { agent: 'fixer' }>

// Why the fixer was sent, by its purpose (the rules that spawn it: P3, M2, M2a, M3, M5b, D5).
const WHY: Record<FixerPurpose, string> = {
  gate: 'the adjudicator judged a gate of the run and asked for a change the pipeline cannot write from instructions alone, or the run is done.',
  conflict: 'the PR conflicts with its base. Rebase onto the base keeping both sides of colliding additions, then re-gate with a fresh run.',
  regate: 'the behind-only update (`callum-flow-merge-guard --update-behind`) could not prove a clean rebase. Do the full re-gate its line below names.',
  weakening: 'the merge guard warned that a commit weakened tests, and the adjudicator judged it unjustified. Restore the tests as the instructions say.',
  review: 'the merge review asked for a change before the PR merges.',
  guard: 'the merge guard printed a FAIL that was judged to need a fixer.',
  handoff: "the implementer's commit was not gated by its pipeline run. Get it gated as the instructions say.",
}

function fixer(repo: string | null, n: number | null, a: FixerSpawn, model: string | null, ask: Ask): string[] {
  const branch = id(a.branch, 'branch')
  const run = id(a.run, 'run')
  const head = id(a.head, 'head')
  const pr = prRef(repo, a.pr)
  const where = [
    branch === null ? 'Branch: not known; the run or the PR names it' : `Branch: ${branch}`,
    pr,
    run === null ? null : `Run ${run}${head === null ? '' : ` at head ${head}`}`,
  ].filter(w => w !== null)
  return [
    `Fixer for ${issueRef(repo, n)}: ${WHY[a.purpose] ?? WHY.gate}`,
    `${where.join('. ')}.`,
    ...briefLines(repo, a.brief, n),
    ...block('Instructions:', [a.instructions]),
    'Load and follow the implement-issue skill, in particular its rules for re-entering a branch that already has a run or PR. Make only the change described, then re-gate it through the pipeline. Do not merge.',
    readFirst('fixer'),
    ...modelLine(model),
    scratch(n),
    ...handoffAsk(ask),
  ]
}

function implementer(repo: string | null, n: number | null, brief: string, model: string | null, ask: Ask): string[] {
  return [
    `Implement ${issueRef(repo, n)}.`,
    ...briefLines(repo, brief, n),
    "The brief is the what: its acceptance criteria are your pipeline intent. Load and follow the implement-issue skill for the how: worktree, verification, evidence, the pipeline and the handoff. Do not merge.",
    readFirst('implementer'),
    ...modelLine(model),
    scratch(n),
    ...handoffAsk(ask),
  ]
}

// --- the repair message (#548) -----------------------------------------------------------------

// repairPrompt: the one message the loop sends an agent whose final answer it could not read:
// what was wrong, then the ask again on the channel its spawn was asked on (the answer script or
// its tool first, its machine lines as the fallback; on the text channel the machine lines
// alone), so the same agent answers with what it already found instead of a fresh agent redoing
// the work. The problem may quote the agent's own line, so it is neutralized like any free text.
export function repairPrompt(
  type: AgentType,
  purpose: AdjudicatorPurpose | null,
  problem: string,
  channel: AnswerChannel = 'text',
  script: ScriptPlace | null = null,
): string {
  const reply =
    type !== 'adjudicator'
      ? 'reply with only the line below, filled in.'
      : purpose === 'merge'
        ? 'reply with only your verdict lines, one ACTION line, and the SUMMARY, BUMP and FLAGS lines your prompt asked for.'
        : CONTRACT
  const ask = askOf(channel, script)
  const lines = answerLines(ask, {
    script: place => [
      `Do not redo the work. Record the answer you reached now with the answer script, its JSON on standard input as your prompt showed: \`${place.bin} --to ${place.file}\`. If it prints problems, correct the JSON and run it again; once it says your answer is recorded, end your turn.`,
    ],
    tool: `Do not redo the work. Call ${TOOL_OF[type]} now with the answer you reached`,
    text: reply,
  })
  const head = ask.kind === 'text' ? ['Do not redo the work: give the answer you reached.'] : []
  const line = type === 'adjudicator' ? [] : [type === 'designer' ? DESIGNER_RESULT : HANDOFF_RESULT]
  return [`The factory loop could not read your answer: ${neutral(problem)}.`, ...head, ...lines, ...line].join('\n')
}

// --- the spawn's description and name (D-11: the issue goes in both) -------------------------------

// descriptionOf: a few words the task shows as.
export function descriptionOf(action: AgentAction): string {
  const n = issueNo(action.issue)
  const issue = n === null ? 'an issue' : `#${n}`
  if (action.kind === 'delegate') return `Implement ${issue}`
  if (action.agent === 'designer') return `Design ${issue}`
  if (action.agent === 'adjudicator') {
    if (action.purpose === 'merge') return `Merge review ${issue}`
    if (action.purpose === 'weakening') return `Test weakening ${issue}`
    return `Adjudicate ${issue} ${id(action.step, 'step') ?? 'gate'}`
  }
  return `Fixer ${issue} (${action.purpose})`
}

// nameOf: `<type>-<N>[-<purpose>]`, with the attempt from the second on, so a retry never
// shares a name with an agent of an earlier attempt that is still winding down.
export function nameOf(action: AgentAction, attempt: number): string {
  const n = issueNo(action.issue)
  const type = action.kind === 'delegate' ? 'implementer' : action.agent
  const purpose = action.kind === 'spawn' && action.agent !== 'designer' ? `-${action.purpose}` : ''
  const again = Number.isInteger(attempt) && attempt > 1 ? `-${attempt}` : ''
  return `${type}-${n ?? 'loop'}${purpose}${again}`
}
