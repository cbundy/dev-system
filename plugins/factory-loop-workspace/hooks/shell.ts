// A Bash command line as the simple commands it runs, each as its words, for the write guard
// (docs/factory-loop/v2/SPEC.md 10.4). Best effort by design: the guard matches commands, not
// effects. It splits on the shell's separators (; & && | || newlines, subshells, $( ) and
// backquotes), honours quotes and escapes, skips comments and here-document text, drops
// redirections, and looks through the wrappers that run another command (env, sudo, timeout,
// xargs, bash -c, eval and the like), so `cd x && FOO=1 timeout 60 git push -f` still reads as a
// git push. A command substitution the shell runs inside double quotes or in an unquoted
// here-document (`echo "$(git push -f)"`) is read as a command line of its own.

// One word as read: its text, and whether any of it was quoted (a quoted `>` is no redirection).
type Word = { text: string; quoted: boolean }

const MAX_DEPTH = 3

// simpleCommands: every simple command of a line, outermost first, each as its argv.
export function simpleCommands(line: string, depth = 0): string[][] {
  const out: string[][] = []
  const { cmds, subs } = split(line)
  for (const words of cmds) out.push(...unwrap(dropRedirects(words), depth))
  for (const sub of subs) out.push(...simpleCommands(sub, depth + 1))
  return out
}

// program: a command's program name, without its folder (`/usr/bin/git` is `git`).
export function program(argv: readonly string[]): string {
  return (argv[0] ?? '').replace(/^.*\//, '')
}

// --- splitting ------------------------------------------------------------------------------------

// substEnd: the index of the `)` that closes a `$(` whose body starts at i, past nested
// parentheses, quotes and backquotes; -1 when it never closes.
function substEnd(s: string, i: number): number {
  let depth = 1
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') i += 2
    else if (c === "'") {
      const close = s.indexOf("'", i + 1)
      if (close === -1) return -1
      i = close + 1
    } else if (c === '"' || c === '`') {
      const close = c === '"' ? dquoteEnd(s, i + 1) : backquoteEnd(s, i + 1)
      if (close === -1) return -1
      i = close + 1
    } else {
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return i
      i++
    }
  }
  return -1
}

// backquoteEnd: the index of the backquote that closes one whose body starts at i; -1 when none.
function backquoteEnd(s: string, i: number): number {
  while (i < s.length) {
    if (s[i] === '\\') i += 2
    else if (s[i] === '`') return i
    else i++
  }
  return -1
}

// dquoteEnd: the index of the `"` that closes a double-quoted string whose text starts at i, past
// the substitutions in it (which may hold quotes of their own); -1 when none.
function dquoteEnd(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') i += 2
    else if (c === '"') return i
    else if (c === '$' && s[i + 1] === '(') {
      const close = substEnd(s, i + 2)
      if (close === -1) return -1
      i = close + 1
    } else if (c === '`') {
      const close = backquoteEnd(s, i + 1)
      if (close === -1) return -1
      i = close + 1
    } else i++
  }
  return -1
}

// expansions: text the shell expands (a double-quoted string's, or an unquoted here-document's) as
// the word it reads as, and the bodies of the command substitutions in it, which the shell runs.
// escapes: the characters a backslash escapes in this text.
function expansions(text: string, escapes: string): { text: string; subs: string[] } {
  let out = ''
  const subs: string[] = []
  let j = 0
  while (j < text.length) {
    const c = text[j] ?? ''
    if (c === '\\' && escapes.includes(text[j + 1] ?? '')) {
      if (text[j + 1] !== '\n') out += text[j + 1]
      j += 2
    } else if (c === '$' && text[j + 1] === '(') {
      const close = substEnd(text, j + 2)
      const stop = close === -1 ? text.length : close
      subs.push(text.slice(j + 2, stop))
      out += text.slice(j, stop + 1)
      j = stop + 1
    } else if (c === '`') {
      const close = backquoteEnd(text, j + 1)
      const stop = close === -1 ? text.length : close
      // in backquotes a backslash escapes only $, ` and itself
      subs.push(text.slice(j + 1, stop).replace(/\\([$`\\])/g, '$1'))
      out += text.slice(j, stop + 1)
      j = stop + 1
    } else {
      out += c
      j++
    }
  }
  return { text: out, subs }
}

// split: a line's simple commands as words, and the bodies of the command substitutions the shell
// runs from inside double quotes or unquoted here-documents (an unquoted one splits in place).
function split(line: string): { cmds: Word[][]; subs: string[] } {
  const cmds: Word[][] = []
  const subs: string[] = []
  let words: Word[] = []
  // the word being read, if any (a holder, so the closures below can change it)
  const at: { word: Word | null } = { word: null }
  // expand: an unquoted delimiter, so the body's substitutions run
  const heredocs: { delim: string; strip: boolean; expand: boolean }[] = []
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
      // the here-documents opened on that line: their bodies are text, not commands, but an
      // unquoted delimiter's body runs its substitutions
      while (heredocs.length > 0) {
        const h = heredocs.shift() as { delim: string; strip: boolean; expand: boolean }
        const body: string[] = []
        while (i < line.length) {
          const nl = line.indexOf('\n', i)
          const text = line.slice(i, nl === -1 ? line.length : nl)
          i = nl === -1 ? line.length : nl + 1
          if ((h.strip ? text.replace(/^\t+/, '') : text) === h.delim) break
          body.push(text)
        }
        if (h.expand) subs.push(...expansions(body.join('\n'), '$`\\\n').subs)
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
      const close = dquoteEnd(line, i + 1)
      const stop = close === -1 ? line.length : close
      const quoted = expansions(line.slice(i + 1, stop), '"\\$`\n')
      add(quoted.text, true)
      subs.push(...quoted.subs)
      i = stop + 1
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
      let expand = true
      while (j < line.length && !' \t\n;&|()<>'.includes(line[j] ?? '')) {
        if (line[j] !== "'" && line[j] !== '"' && line[j] !== '\\') delim += line[j]
        else expand = false
        j++
      }
      if (delim !== '') heredocs.push({ delim, strip, expand })
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
  return { cmds, subs }
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
