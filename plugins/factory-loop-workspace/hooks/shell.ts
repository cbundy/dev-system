// A Bash command line as the simple commands it runs, each as its words, for the write guard
// (docs/factory-loop/v2/SPEC.md 10.4). Best effort by design: the guard matches commands, not
// effects. It splits on the shell's separators (; & && | || newlines, subshells, $( ) and
// backquotes), honours quotes and escapes, skips comments and here-documents, drops redirections,
// and looks through the wrappers that run another command (env, sudo, timeout, xargs, bash -c,
// eval and the like), so `cd x && FOO=1 timeout 60 git push -f` still reads as a git push.

// One word as read: its text, and whether any of it was quoted (a quoted `>` is no redirection).
type Word = { text: string; quoted: boolean }

const MAX_DEPTH = 3

// simpleCommands: every simple command of a line, outermost first, each as its argv.
export function simpleCommands(line: string, depth = 0): string[][] {
  const out: string[][] = []
  for (const words of split(line)) out.push(...unwrap(dropRedirects(words), depth))
  return out
}

// program: a command's program name, without its folder (`/usr/bin/git` is `git`).
export function program(argv: readonly string[]): string {
  return (argv[0] ?? '').replace(/^.*\//, '')
}

// --- splitting ------------------------------------------------------------------------------------

function split(line: string): Word[][] {
  const cmds: Word[][] = []
  let words: Word[] = []
  // the word being read, if any (a holder, so the closures below can change it)
  const at: { word: Word | null } = { word: null }
  const heredocs: { delim: string; strip: boolean }[] = []
  const add = (text: string, quoted = false) => {
    at.word ??= { text: '', quoted: false }
    at.word.text += text
    if (quoted) at.word.quoted = true
  }
  const flush = () => {
    if (at.word !== null) words.push(at.word)
    at.word = null
  }
  const end = () => {
    flush()
    if (words.length > 0) cmds.push(words)
    words = []
  }
  let i = 0
  while (i < line.length) {
    const c = line[i] ?? ''
    const next = line[i + 1] ?? ''
    if (c === '\n') {
      end()
      i++
      // the here-documents opened on that line: their bodies are text, not commands
      while (heredocs.length > 0) {
        const h = heredocs.shift() as { delim: string; strip: boolean }
        while (i < line.length) {
          const nl = line.indexOf('\n', i)
          const body = line.slice(i, nl === -1 ? line.length : nl)
          i = nl === -1 ? line.length : nl + 1
          if ((h.strip ? body.replace(/^\t+/, '') : body) === h.delim) break
        }
      }
      continue
    }
    if (c === '#' && at.word === null) {
      while (i < line.length && line[i] !== '\n') i++
      continue
    }
    if (c === '\\') {
      if (next === '\n') i += 2
      else {
        add(next, true)
        i += 2
      }
      continue
    }
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      const stop = close === -1 ? line.length : close
      add(line.slice(i + 1, stop), true)
      i = stop + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      let text = ''
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && '"\\$`\n'.includes(line[j + 1] ?? '')) {
          if (line[j + 1] !== '\n') text += line[j + 1]
          j += 2
        } else {
          text += line[j]
          j++
        }
      }
      add(text, true)
      i = j + 1
      continue
    }
    if (c === ' ' || c === '\t') {
      flush()
      i++
      continue
    }
    if (c === '<' && next === '<' && line[i + 2] !== '<') {
      // a here-document: <<DELIM or <<-DELIM, the delimiter quoted or not
      flush()
      let j = i + 2
      const strip = line[j] === '-'
      if (strip) j++
      while (line[j] === ' ' || line[j] === '\t') j++
      let delim = ''
      while (j < line.length && !' \t\n;&|()<>'.includes(line[j] ?? '')) {
        if (line[j] !== "'" && line[j] !== '"' && line[j] !== '\\') delim += line[j]
        j++
      }
      if (delim !== '') heredocs.push({ delim, strip })
      i = j
      continue
    }
    if (c === '&') {
      // part of a redirection (2>&1, >&2, &>file), else a separator (& and &&)
      if (next === '>' || at.word?.text.endsWith('>') || at.word?.text.endsWith('<')) {
        add(c)
        i++
        continue
      }
      end()
      i += next === '&' ? 2 : 1
      continue
    }
    if (c === ';' || c === '|' || c === '(' || c === ')' || c === '`') {
      end()
      i += c === '|' && (next === '|' || next === '&') ? 2 : 1
      continue
    }
    if (c === '$' && next === '(') {
      end()
      i += 2
      continue
    }
    add(c)
    i++
  }
  end()
  return cmds
}

// dropRedirects: the words that are redirections (>f, 2>&1, < f, &>f), and the target that
// follows an operator standing alone.
function dropRedirects(words: Word[]): Word[] {
  const out: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === undefined) continue
    const m = w.quoted ? null : /^(\d*|&)(>>?|<|>&|<&|>\|)(.*)$/.exec(w.text)
    if (m === null) out.push(w)
    else if (m[3] === '') i++
  }
  return out
}

// --- wrappers ---------------------------------------------------------------------------------------

// Words that open a compound command and run the command after them.
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time'])

// The wrappers that run the command after their own options, and those options that take a value.
const WRAPPERS: Record<string, { valued: string[]; positional: number }> = {
  env: { valued: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], positional: 0 },
  sudo: { valued: ['-u', '-g', '-C', '-D', '-h', '-p', '-U', '-r', '-t'], positional: 0 },
  command: { valued: [], positional: 0 },
  exec: { valued: ['-a'], positional: 0 },
  nohup: { valued: [], positional: 0 },
  nice: { valued: ['-n', '--adjustment'], positional: 0 },
  stdbuf: { valued: ['-i', '-o', '-e'], positional: 0 },
  timeout: { valued: ['-s', '--signal', '-k', '--kill-after'], positional: 1 },
  xargs: { valued: ['-I', '-i', '-n', '-P', '-d', '-L', '-l', '-s', '-a', '-E', '-e', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace'], positional: 0 },
}

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh'])

// unwrap: the command a simple command runs, through assignments, keywords and wrappers; a shell's
// -c script and eval's words are read as command lines of their own.
function unwrap(words: Word[], depth: number): string[][] {
  let argv = words.map(w => w.text)
  for (;;) {
    while (argv.length > 0 && (KEYWORDS.has(argv[0] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? ''))) argv = argv.slice(1)
    if (argv.length === 0) return []
    const name = program(argv)
    const wrapper = WRAPPERS[name]
    if (wrapper !== undefined) {
      let i = 1
      let positional = wrapper.positional
      while (i < argv.length) {
        const a = argv[i] ?? ''
        if (a === '--') {
          i++
          break
        }
        if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) i++
        else if (a.startsWith('-') && a.length > 1) i += wrapper.valued.includes(a) ? 2 : 1
        else if (positional > 0) {
          positional--
          i++
        } else break
      }
      argv = argv.slice(i)
      continue
    }
    if (depth < MAX_DEPTH && SHELLS.has(name)) {
      const at = argv.findIndex((a, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(a))
      const script = at === -1 ? undefined : argv[at + 1]
      if (script !== undefined) return simpleCommands(script, depth + 1)
    }
    if (depth < MAX_DEPTH && name === 'eval') return simpleCommands(argv.slice(1).join(' '), depth + 1)
    return [argv]
  }
}
