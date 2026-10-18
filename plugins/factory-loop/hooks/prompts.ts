// What every prompt of the loop shares (SPEC 6.3): free text made safe for a prompt, so it never
// carries a GitHub closing keyword before an issue reference (I-33), the rules every agent is
// told, and the shape check of the answer script's paths. The prompts themselves are v2's
// (hooks/v2/prompts-*.ts). Pure, so tests/prompts.test.ts renders them with hostile inputs.

// Where an agent records its answer with the answer script: the script, and the answer file
// unique to its ledger entry and attempt, both absolute.
export type ScriptPlace = { bin: string; file: string }

// A free-text value longer than this is cut: a prompt points, it does not carry documents.
const TEXT_MAX = 4000

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

// Whitespace other than a newline, a tab or a space, and the control characters.
const CONTROL = /[^\S\n\t ]|[\u0000-\u0008\u000b-\u001f\u007f]/g

// neutral: free text made safe for a prompt: control characters dropped, length capped, and
// each closing keyword before a reference turned into its participle ("Fixes #12" reads
// "Fixing #12"), so an agent that copies the text into a PR body closes nothing.
export function neutral(text: string): string {
  const clean = text.replace(CONTROL, ' ').trim()
  const capped = clean.length > TEXT_MAX ? `${clean.slice(0, TEXT_MAX - 3)}...` : clean
  return capped.replace(CLOSING, participle)
}

// neutralWhole: neutral()'s clean-up over a whole text, with no trim and no cap, so every line,
// blank line and indent stays where it was: for a long text the loop posts itself (v2
// prompts-work.ts neutralBody), which caps it once at the end.
export function neutralWhole(text: string): string {
  return text.replace(CONTROL, ' ').replace(CLOSING, participle)
}

// The loop reads an agent's first final message as its answer. On the testbed a designer started
// its explorer in the background and ended its turn to wait, so its answer was a wait note.
export const FOREGROUND_RULE =
  'Run any sub-agent you start in the foreground and wait for it there: your turn ends only with your final answer, given as asked below.'

// Two incidents on 2026-10-14: an agent ran `claude remote-control --help`, which starts a session
// and never exits, and others waited with `until ! pgrep -f <pattern>`, which matches its own shell.
export const COMMAND_RULE =
  'Run only commands known to exit. Read source, docs and `--help` output only from such commands, and bound any exploratory command with `timeout 30`. Never start a server, a watcher, a Remote Control session (`claude remote-control`, `claude --remote-control`) or any interactive or long-running command. Leave no background shell or wait loop running when you hand in your answer. The one exception is the detached no-mistakes pipeline run (`axi run` or `axi respond`) that the implement-issue skill launches. Wait on a PID you recorded or on the tool\'s own status, never with `pgrep -f <pattern>` from a shell whose command line contains the pattern.'

// --- the answer script's paths ---------------------------------------------------------------------

// An absolute path with nothing in it a shell or a closing keyword could use: no space, quote,
// `$` or `#`.
const PATH = /^\/[A-Za-z0-9._/-]+$/

// scriptShaped: both paths of a script place have the shape a prompt may carry, and are plain
// (no `..`, `.` or empty part, so no `//` or `/./`): the answer script refuses any path that is
// not, so such a spawn is asked for text instead.
export function scriptShaped(place: ScriptPlace): boolean {
  return [place.bin, place.file].every(p => PATH.test(p) && p.slice(1).split('/').every(part => part !== '' && part !== '.' && part !== '..'))
}
