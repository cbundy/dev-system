# forbid-broad-kill.awk - detection logic for forbid-broad-kill.sh (dev-system#421).
# Reads the raw PreToolUse JSON (one record, see BEGIN) from stdin and prints
# exactly one of DENY / ALLOW (or, with -v mode=cwd, the input's cwd). See
# forbid-broad-kill.sh for the full write-up. The JSON extractor, tokenizer,
# wrapper handling, heredoc stripper and segment splitter mirror
# forbid-tmux-kill.awk on purpose (each hook stays self-contained).
# The worktree exemption root arrives in ENVIRON["BROAD_KILL_WORKTREE"].

BEGIN { RS = "\3"; worktree = ENVIRON["BROAD_KILL_WORKTREE"] }
{ json = $0 }

# Minimal JSON string-value extractor for a top-level or nested "key":"..."
# pair. Handles \" \\ \/ \n \t \r and skips \uXXXX escapes (never meaningful
# inside a shell command word we care about here).
function jstr(s, key,    keypat, idx, i, n, c, nc, out) {
  keypat = "\"" key "\"[[:space:]]*:[[:space:]]*\""
  idx = match(s, keypat)
  if (idx == 0) return ""
  i = idx + RLENGTH
  n = length(s)
  out = ""
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") {
      nc = substr(s, i + 1, 1)
      if (nc == "n") out = out "\n"
      else if (nc == "t") out = out "\t"
      else if (nc == "r") out = out "\r"
      else if (nc == "\"") out = out "\""
      else if (nc == "\\") out = out "\\"
      else if (nc == "/") out = out "/"
      else if (nc == "u") { out = out " "; i += 4 }
      else out = out nc
      i += 2
    } else if (c == "\"") {
      break
    } else {
      out = out c
      i += 1
    }
  }
  return out
}

# Quote-aware whitespace tokenizer for one command segment. Populates toks[]
# (1-indexed) and returns the token count. Surrounding quote characters are
# stripped; a quoted token may contain spaces and stays one token.
function tokenize(segment, toks,    n, i, c, q, tok, cnt) {
  delete toks
  n = length(segment)
  tok = ""
  q = ""
  cnt = 0
  for (i = 1; i <= n; i++) {
    c = substr(segment, i, 1)
    if (q != "") {
      if (c == q) q = ""
      else tok = tok c
      continue
    }
    if (c == "'" || c == "\"") { q = c; continue }
    if (c == " " || c == "\t") {
      if (tok != "") { cnt++; toks[cnt] = tok; tok = "" }
      continue
    }
    tok = tok c
  }
  if (tok != "") { cnt++; toks[cnt] = tok }
  return cnt
}

# Basename of a command word (path ending in /pkill counts as pkill).
function base_of(w,    j) {
  for (j = length(w); j >= 1; j--) if (substr(w, j, 1) == "/") return substr(w, j + 1)
  return w
}

# Options of pkill/pgrep/pidof/killall that consume the next token, so that
# their value is never mistaken for a process-name operand.
function name_option_takes_arg(base, opt) {
  if (base == "pkill" || base == "pgrep")
    return (opt == "-d" || opt == "--delimiter" || opt == "-F" || opt == "--pidfile" || \
            opt == "-G" || opt == "--group" || opt == "-g" || opt == "--pgroup" || \
            opt == "-O" || opt == "--older" || opt == "-P" || opt == "--parent" || \
            opt == "-s" || opt == "--session" || opt == "-t" || opt == "--terminal" || \
            opt == "-u" || opt == "--euid" || opt == "-U" || opt == "--uid" || \
            opt == "-r" || opt == "--runstates" || opt == "--cgroup" || \
            opt == "--ns" || opt == "--nslist" || opt == "--signal")
  if (base == "pidof") return (opt == "-o" || opt == "-S" || opt == "-d")
  return (opt == "-o" || opt == "--older-than" || opt == "-s" || opt == "--signal" || \
          opt == "-u" || opt == "--user" || opt == "-y" || opt == "--younger-than" || \
          opt == "-Z" || opt == "--context")
}

function name_short_option_takes_arg(base, ch) {
  if (base == "pkill" || base == "pgrep") return (ch ~ /^[dFGgOPrstuU]$/)
  if (base == "pidof") return (ch ~ /^[oSd]$/)
  return (ch ~ /^[osuyZ]$/)
}

# pkill's -SIGNAL form (-9, -TSTP, -SIGPIPE, -rtmin+2): a signal, never an
# option cluster, so -TSTP or -PIPE is not read as -P <parent>.
function is_signal(t,    s) {
  s = toupper(substr(t, 2))
  sub(/^SIG/, "", s)
  return (s ~ /^[0-9]+$/ || \
          s ~ /^(HUP|INT|QUIT|ILL|TRAP|ABRT|IOT|BUS|FPE|KILL|USR1|SEGV|USR2|PIPE|ALRM|TERM|STKFLT|CHLD|CLD|CONT|STOP|TSTP|TTIN|TTOU|URG|XCPU|XFSZ|VTALRM|PROF|WINCH|IO|POLL|PWR|SYS)$/ || \
          s ~ /^RT(MIN|MAX)([+-][0-9]+)?$/)
}

# Parse the options and operands of a pkill/pgrep/pidof command. Sets the
# globals sel_parent (the -P/--parent value, "" if none), sel_nops and sel_ops[]
# (the process-name/pattern operands).
function scan_selector(toks, cnt, i, base,    t, k, ch, endopts, val, eq, skip_next, opt) {
  sel_parent = ""
  sel_nops = 0
  delete sel_ops
  endopts = 0
  while (i <= cnt) {
    t = toks[i]
    if (!endopts && t == "--") { endopts = 1; i++; continue }
    if (!endopts && t ~ /^--/) {
      eq = index(t, "=")
      if (eq) {
        opt = substr(t, 1, eq - 1)
        if (opt == "--parent") sel_parent = substr(t, eq + 1)
        i++
      } else if (name_option_takes_arg(base, t)) {
        if (t == "--parent") sel_parent = toks[i + 1]
        i += 2
      } else i++
      continue
    }
    if (!endopts && base == "pkill" && t ~ /^-/ && is_signal(t)) { i++; continue }
    if (!endopts && t ~ /^-/ && t != "-") {
      skip_next = 0
      for (k = 2; k <= length(t); k++) {
        ch = substr(t, k, 1)
        if (name_short_option_takes_arg(base, ch)) {
          if (k < length(t)) val = substr(t, k + 1)
          else { val = toks[i + 1]; skip_next = 1 }
          if (ch == "P") sel_parent = val
          break
        }
      }
      i += 1 + skip_next
      continue
    }
    sel_ops[++sel_nops] = t
    i++
  }
}

# A -P/--parent value scopes the selector unless any listed pid is 0 or 1 (or empty).
function parent_scoped(p,    n, parts, i) {
  if (p == "") return 0
  n = split(p, parts, ",")
  for (i = 1; i <= n; i++) if (parts[i] == "" || parts[i] == "0" || parts[i] == "1") return 0
  return 1
}

# Does s contain root as a whole absolute path prefix (root followed by /)?
function path_under(s, root,    pos, from, l, pre) {
  if (root == "") return 0
  l = length(root)
  from = 1
  while ((pos = index(substr(s, from), root)) > 0) {
    pos += from - 1
    pre = (pos == 1) ? "" : substr(s, pos - 1, 1)
    if (pre !~ /[A-Za-z0-9_.\/-]/ && substr(s, pos + l, 1) == "/") return 1
    from = pos + 1
  }
  return 0
}

# Is this name/pattern operand an absolute path inside the agent's own linked
# worktree or a Claude scratchpad? Alternation or grouping could make the path
# optional, so it never counts. Backslashes (regex escapes) are removed first.
function operand_in_scope(op,    s) {
  if (op ~ /[|()]/) return 0
  s = op
  gsub(/\\/, "", s)
  if (index(s, "/../") > 0) return 0
  if (path_under(s, worktree)) return 1
  if (s ~ /\/claude-[0-9]+\/[^\/]+\/[^\/]+\/scratchpad\//) return 1
  return 0
}

# 1 when a pkill/pgrep/pidof command (options start at toks[i]) is not scoped
# to the caller's own processes.
function unscoped_selector(toks, cnt, i, base,    j, all) {
  scan_selector(toks, cnt, i, base)
  if (parent_scoped(sel_parent)) return 0
  if (sel_nops > 0) {
    all = 1
    for (j = 1; j <= sel_nops; j++) if (!operand_in_scope(sel_ops[j])) { all = 0; break }
    if (all) return 0
  }
  return 1
}

# kill aimed at every process: a -1 pid (kill -9 -1, kill -- -1), or a bare
# kill -1. A leading -1 followed by pids is the HUP signal and stays allowed.
function kill_everything(toks, cnt, i,    first, k) {
  first = i
  for (k = i; k <= cnt; k++)
    if (toks[k] == "-1" && (k != first || k == cnt)) return 1
  return 0
}

function wrapper_option_takes_arg(base, opt) {
  if (base == "sudo")
    return (opt == "-a" || opt == "--auth-type" || opt == "-C" || \
            opt == "--close-from" || opt == "-D" || opt == "--chdir" || \
            opt == "-g" || opt == "--group" || opt == "-h" || \
            opt == "--host" || opt == "-p" || opt == "--prompt" || \
            opt == "-R" || opt == "--chroot" || opt == "-r" || \
            opt == "--role" || opt == "-t" || opt == "--type" || \
            opt == "-T" || opt == "--command-timeout" || opt == "-u" || \
            opt == "--user")
  if (base == "exec") return (opt == "-a")
  if (base == "time")
    return (opt == "-f" || opt == "--format" || opt == "-o" || \
            opt == "--output")
  return 0
}

function join_tokens(toks, first, cnt,    out, i) {
  out = ""
  for (i = first; i <= cnt; i++) out = out (out == "" ? "" : " ") toks[i]
  return out
}

function shell_quote(value,    out, i, ch) {
  out = "'"
  for (i = 1; i <= length(value); i++) {
    ch = substr(value, i, 1)
    out = out (ch == "'" ? "'\\''" : ch)
  }
  return out "'"
}

function env_split_kills(toks, cnt, value, tail,    command, i) {
  command = "env " value
  for (i = tail; i <= cnt; i++) command = command " " shell_quote(toks[i])
  return is_broad_kill(command)
}

function env_command_index(toks, cnt, i,    opt, k, ch, value, tail, consumed) {
  i++
  while (i <= cnt) {
    opt = toks[i]
    if (opt == "--") return i + 1
    if (opt !~ /^-/) return i
    if (opt == "-") { i++; continue }
    if (opt == "-S" || opt == "--split-string") {
      if (i == cnt) return cnt + 1
      return env_split_kills(toks, cnt, toks[i + 1], i + 2) ? 0 : cnt + 1
    }
    if (index(opt, "--split-string=") == 1)
      return env_split_kills(toks, cnt, substr(opt, length("--split-string=") + 1), i + 1) ? 0 : cnt + 1
    if (opt ~ /^--/) {
      if (opt == "--argv0" || opt == "--unset" || opt == "--chdir") i += 2
      else i++
      continue
    }
    consumed = 0
    for (k = 2; k <= length(opt); k++) {
      ch = substr(opt, k, 1)
      if (ch == "S") {
        if (k < length(opt)) { value = substr(opt, k + 1); tail = i + 1 }
        else if (i < cnt) { value = toks[i + 1]; tail = i + 2 }
        else return cnt + 1
        return env_split_kills(toks, cnt, value, tail) ? 0 : cnt + 1
      }
      if (ch == "a" || ch == "u" || ch == "C") {
        i += (k < length(opt)) ? 1 : 2
        consumed = 1
        break
      }
    }
    if (!consumed) i++
  }
  return i
}

function wrapper_command_index(toks, cnt, i, base,    opt) {
  if (base == "env") return env_command_index(toks, cnt, i)
  i++
  while (i <= cnt) {
    opt = toks[i]
    if (opt == "--") return i + 1
    if (opt !~ /^-/ || opt == "-") return i
    if (wrapper_option_takes_arg(base, opt)) i += 2
    else i++
  }
  return i
}

# Index of the command word once assignments, control words and the env, sudo,
# exec, command, nohup and time wrappers are skipped. 0 means an env -S payload
# that is itself a broad kill; cnt+1 means there is no command word.
function cmd_start(toks, cnt, i,    base) {
  while (i <= cnt) {
    if (toks[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { i++; continue }
    if (toks[i] == "if" || toks[i] == "while" || toks[i] == "until" || \
        toks[i] == "then" || toks[i] == "do" || toks[i] == "elif" || \
        toks[i] == "else" || toks[i] == "!") { i++; continue }
    base = base_of(toks[i])
    if (base == "env" || base == "sudo" || base == "exec" || base == "command" || \
        base == "nohup" || base == "time") {
      i = wrapper_command_index(toks, cnt, i, base)
      if (i == 0) return 0
      continue
    }
    break
  }
  return i
}

function tokens_are_broad_kill(toks, cnt, i,    base, payload, k, first) {
  i = cmd_start(toks, cnt, i)
  if (i == 0) return 1
  if (i > cnt) return 0
  base = base_of(toks[i])
  if (base == "sh" || base == "bash" || base == "zsh") {
    for (k = i + 1; k <= cnt; k++) {
      if (toks[k] ~ /^-[A-Za-z]*c[A-Za-z]*$/ && k < cnt)
        return is_broad_kill(toks[k + 1])
      if (toks[k] == "--") break
    }
    return 0
  }
  if (base == "eval") {
    first = i + 1
    if (toks[first] == "--") first++
    payload = join_tokens(toks, first, cnt)
    return (payload != "" && is_broad_kill(payload))
  }
  if (base == "pkill") return unscoped_selector(toks, cnt, i + 1, "pkill")
  if (base == "killall" || base == "killall5") return 1
  if (base == "kill") return kill_everything(toks, cnt, i + 1)
  return 0
}

function segment_is_broad_kill(segment,    toks, cnt) {
  cnt = tokenize(segment, toks)
  return tokens_are_broad_kill(toks, cnt, 1)
}

# An unscoped pgrep/pidof: the list of pids a broad kill would be fed.
function segment_is_unscoped_lister(segment,    toks, cnt, i, base) {
  cnt = tokenize(segment, toks)
  i = cmd_start(toks, cnt, 1)
  if (i == 0 || i > cnt) return 0
  base = base_of(toks[i])
  if (base != "pgrep" && base != "pidof") return 0
  return unscoped_selector(toks, cnt, i + 1, base)
}

# xargs [options] kill ...: xargs options that consume the next token are skipped.
function segment_is_xargs_kill(segment,    toks, cnt, i, t, k, ch, skip_next, j) {
  cnt = tokenize(segment, toks)
  i = cmd_start(toks, cnt, 1)
  if (i == 0 || i > cnt || base_of(toks[i]) != "xargs") return 0
  i++
  while (i <= cnt) {
    t = toks[i]
    if (t == "--") { i++; break }
    if (t !~ /^-/ || t == "-") break
    if (t ~ /^--/) {
      if (t ~ /^--(max-args|max-procs|delimiter|arg-file|max-chars|process-slot-var)$/) i += 2
      else i++
      continue
    }
    skip_next = 0
    for (k = 2; k <= length(t); k++) {
      ch = substr(t, k, 1)
      if (ch ~ /^[InLPsdEa]$/) { if (k == length(t)) skip_next = 1; break }
    }
    i += 1 + skip_next
  }
  j = cmd_start(toks, cnt, i)
  return (j > 0 && j <= cnt && base_of(toks[j]) == "kill")
}

# Is the text before a substitution (back to the last separator) a kill command?
function prefix_is_kill(prefix,    toks, cnt, i) {
  cnt = tokenize(prefix, toks)
  i = cmd_start(toks, cnt, 1)
  return (i > 0 && i <= cnt && base_of(toks[i]) == "kill")
}

# Split into segments on ; & | newline ( ) { }, quote-aware so those characters
# inside a quoted string never split it. seps[j] is the separator after segs[j]
# (|| && stay one separator). Returns the segment count.
function split_segments(cmd, segs, seps,    n, i, c, q, seg, nseg, two) {
  n = length(cmd)
  seg = ""
  q = ""
  nseg = 0
  for (i = 1; i <= n; i++) {
    c = substr(cmd, i, 1)
    if (q != "") {
      seg = seg c
      if (c == q) q = ""
      continue
    }
    if (c == "'" || c == "\"") { q = c; seg = seg c; continue }
    if (c == "{" && substr(cmd, i + 1, 1) == "}") { seg = seg "{}"; i++; continue }
    if (c == ";" || c == "&" || c == "|" || c == "\n" || \
        c == "(" || c == ")" || c == "{" || c == "}") {
      two = c substr(cmd, i + 1, 1)
      nseg++; segs[nseg] = seg; seg = ""
      if (two == "||" || two == "&&") { seps[nseg] = two; i++ }
      else if (two == "|&") { seps[nseg] = "|"; i++ }
      else seps[nseg] = c
      continue
    }
    seg = seg c
  }
  nseg++; segs[nseg] = seg; seps[nseg] = ""
  return nseg
}

# Does the substitution body list pids with an unscoped pgrep/pidof?
function body_lists_unscoped(body,    segs, seps, nseg, j) {
  nseg = split_segments(body, segs, seps)
  for (j = 1; j <= nseg; j++) if (segment_is_unscoped_lister(segs[j])) return 1
  return 0
}

function nested_is_broad_kill(cmd,    n, i, j, c, q, iq, depth, segstart, body) {
  n = length(cmd)
  q = ""
  segstart = 1
  for (i = 1; i <= n; i++) {
    c = substr(cmd, i, 1)
    if (q == "'") {
      if (c == "'") q = ""
      continue
    }
    if (c == "'" && q == "") { q = "'"; continue }
    if (c == "\"") { q = (q == "\"") ? "" : "\""; continue }
    if (c == "$" && substr(cmd, i + 1, 1) == "(") {
      depth = 1
      iq = ""
      for (j = i + 2; j <= n; j++) {
        c = substr(cmd, j, 1)
        if (iq != "") { if (c == iq) iq = ""; continue }
        if (c == "'" || c == "\"") { iq = c; continue }
        if (c == "(") depth++
        else if (c == ")" && --depth == 0) break
      }
      if (j > n) { unparseable = i; return 0 }
      body = substr(cmd, i + 2, j - i - 2)
      if (prefix_is_kill(substr(cmd, segstart, i - segstart)) && body_lists_unscoped(body)) return 1
      if (is_broad_kill(body)) return 1
      unparseable = 0
      i = j
      continue
    }
    if (c == "`") {
      for (j = i + 1; j <= n && substr(cmd, j, 1) != "`"; j++);
      if (j > n) { unparseable = i; return 0 }
      body = substr(cmd, i + 1, j - i - 1)
      if (prefix_is_kill(substr(cmd, segstart, i - segstart)) && body_lists_unscoped(body)) return 1
      if (is_broad_kill(body)) return 1
      unparseable = 0
      i = j
      continue
    }
    if (q == "" && index(";&|\n(){}", c) > 0) segstart = i + 1
  }
  return 0
}

# Remove the bodies of quoted heredocs (<<'X', <<"X", <<\X, with optional -):
# the shell never expands them, so text in them is data. Unquoted heredoc
# bodies stay, because $(...) inside them does run.
function strip_heredocs(cmd,    nl, lines, i, out, line, delims, quoted, tabs, head, tail, t, q, stack, depth, n, k, c, j, dq, word, hasword, literal, dash, start, kept, part) {
  nl = split(cmd, lines, "\n")
  out = ""
  q = ""
  depth = 0
  head = 1
  tail = 0
  for (i = 1; i <= nl; i++) {
    line = lines[i]
    if (head <= tail) {
      t = line
      if (tabs[head]) sub(/^\t+/, "", t)
      if (t == delims[head]) head++
      else if (!quoted[head]) out = out (i > 1 ? "\n" : "") line
      continue
    }
    n = length(line)
    kept = ""
    part = 1
    for (k = 1; k <= n; k++) {
      c = substr(line, k, 1)
      if (c == "\\" && q != "'") { k++; continue }
      if (q == "'") { if (c == q) q = ""; continue }
      if (c == "$" && substr(line, k + 1, 1) == "(") {
        stack[++depth] = q
        q = ""
        k++
        continue
      }
      if (q != "") { if (c == q) q = ""; continue }
      if (c == "'" || c == "\"") { q = c; continue }
      if (c == "#" && (k == 1 || substr(line, k - 1, 1) ~ /[ \t;|&()]/)) break
      if (c == "(") { stack[++depth] = ""; continue }
      if (c == ")" && depth > 0) { q = stack[depth--]; continue }
      if (c != "<" || substr(line, k + 1, 1) != "<") continue
      if (substr(line, k + 2, 1) == "<") { k += 2; continue }
      start = k
      j = k + 2
      dash = (substr(line, j, 1) == "-")
      if (dash) j++
      while (substr(line, j, 1) ~ /[ \t]/ && j <= n) j++
      word = ""
      dq = ""
      literal = 0
      hasword = 0
      for (; j <= n; j++) {
        c = substr(line, j, 1)
        if (dq == "'") {
          if (c == dq) dq = ""
          else word = word c
          continue
        }
        if (c == "\\") {
          literal = 1
          hasword = 1
          if (j == n) break
          t = substr(line, j + 1, 1)
          if (dq == "\"" && t !~ /[$`"\\]/) word = word c
          word = word t
          j++
          continue
        }
        if (dq != "") {
          if (c == dq) dq = ""
          else word = word c
          continue
        }
        if (c == "'" || c == "\"") { dq = c; literal = 1; hasword = 1; continue }
        if (c ~ /[ \t;|&()<>]/) break
        hasword = 1
        word = word c
      }
      if (!hasword || dq != "") continue
      delims[++tail] = word
      quoted[tail] = literal
      tabs[tail] = dash
      kept = kept substr(line, part, start - part) " "
      part = j
      k = j - 1
    }
    out = out (i > 1 ? "\n" : "") kept substr(line, part)
  }
  return out
}

function is_broad_kill(cmd,    segs, seps, nseg, j, k, s) {
  cmd = strip_heredocs(cmd)
  unparseable = 0
  if (nested_is_broad_kill(cmd)) return 1
  if (unparseable) cmd = substr(cmd, 1, unparseable - 1)
  nseg = split_segments(cmd, segs, seps)
  for (j = 1; j <= nseg; j++) {
    if (segment_is_broad_kill(segs[j])) return 1
  }
  # pgrep/pidof piped (possibly through other stages) into xargs kill.
  for (j = 1; j <= nseg; j++) {
    if (!segment_is_unscoped_lister(segs[j])) continue
    k = j
    while (k < nseg) {
      s = seps[k]
      if (s == "|") { k++; if (segment_is_xargs_kill(segs[k])) return 1; continue }
      if ((s == ")" || s == "}") && segs[k + 1] ~ /^[ \t]*$/) { k++; continue }
      break
    }
  }
  return 0
}

END {
  if (mode == "cwd") { print jstr(json, "cwd"); exit }
  tool_name = jstr(json, "tool_name")
  if (tool_name != "Bash") { print "ALLOW"; exit }
  command = jstr(json, "command")
  print (is_broad_kill(command) ? "DENY" : "ALLOW")
}
