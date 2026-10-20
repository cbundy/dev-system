// The step's scratch folder (docs/factory-loop/v2/SPEC.md 10.2, 10.5), pure. factory-slot prepare
// makes <loop dir>/scratch/<N>-<life>-s<seq> and writes its path into the step marker as `scratch`;
// the companion exports it as TMPDIR, TMP and TEMP into every Bash call of a mapped agent, because
// `$.env.set` is session-wide and gives no agent a folder of its own.
import { normalize } from './guard'

// scratchOk: whether a marker's `scratch` is usable: absolute, normalized, and under
// <loopDir>/scratch/ (below it, never the folder itself).
export function scratchOk(scratch: unknown, loopDir: string): scratch is string {
  if (typeof scratch !== 'string' || !scratch.startsWith('/') || normalize(scratch, '/') !== scratch) return false
  const root = `${loopDir.replace(/\/+$/, '')}/scratch/`
  return scratch.startsWith(root) && scratch.length > root.length
}

export const quoted = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

// withScratch: the Bash command, run with TMPDIR, TMP and TEMP set to the folder. The export is
// its own line, so the command's text runs unchanged after it, here-documents and multi-line
// commands included.
export function withScratch(command: string, scratch: string): string {
  const s = quoted(scratch)
  return `export TMPDIR=${s} TMP=${s} TEMP=${s}\n${command}`
}
