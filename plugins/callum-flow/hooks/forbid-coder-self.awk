# forbid-coder-self.awk - detection logic for forbid-coder-self.sh (dev-system#263).
# Reads the raw PreToolUse JSON (one record, see BEGIN) from stdin and prints
# exactly one of DENY / ALLOW. See forbid-coder-self.sh for the full write-up.
# The JSON extractor, tokenizer and wrapper/segment logic mirror
# forbid-tmux-kill.awk on purpose (each hook stays self-contained).
# The workspace identity comes from the environment (ENVIRON), not -v, so
# backslashes in a name are never interpreted by awk.

BEGIN { RS = "\3" }
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

function base_of(w,    j) {
  for (j = length(w); j >= 1; j--) if (substr(w, j, 1) == "/") return substr(w, j + 1)
  return w
}

# Does token t name this workspace? Accepts NAME, OWNER/NAME (or me/NAME), each
# with an optional .AGENT suffix. Unexpanded $CODER_WORKSPACE_NAME and
# $CODER_WORKSPACE_OWNER_NAME references (bare or braced) count as the values.
function replace_lit(s, from, to,    i, out) {
  out = ""
  while ((i = index(s, from)) > 0) {
    out = out substr(s, 1, i - 1) to
    s = substr(s, i + length(from))
  }
  return out s
}

function names_self(t,    s) {
  s = replace_lit(t, "${CODER_WORKSPACE_NAME}", wsname)
  s = replace_lit(s, "$CODER_WORKSPACE_NAME", wsname)
  if (wsowner != "") {
    s = replace_lit(s, "${CODER_WORKSPACE_OWNER_NAME}", wsowner)
    s = replace_lit(s, "$CODER_WORKSPACE_OWNER_NAME", wsowner)
  }
  if (s == "") return 0
  if (s == wsname || index(s, wsname ".") == 1) return 1
  if (wsowner != "" && (index(s, wsowner "/" wsname) == 1)) {
    s = substr(s, length(wsowner "/" wsname) + 1)
    return (s == "" || substr(s, 1, 1) == ".")
  }
  if (index(s, "me/" wsname) == 1) {
    s = substr(s, length("me/" wsname) + 1)
    return (s == "" || substr(s, 1, 1) == ".")
  }
  return 0
}

# coder global flags that take a separate value.
function coder_global_takes_arg(opt) {
  return (opt == "--global-config" || opt == "--url" || opt == "--token" || \
          opt == "--header" || opt == "--header-command" || opt == "--agent-url" || \
          opt == "--agent-token")
}

# Is this `coder [global opts] restart|stop|update ... <self>`? i is the index
# after the coder word.
function coder_self_target(toks, cnt, i,    t, subc, k) {
  while (i <= cnt) {
    t = toks[i]
    if (t !~ /^-/) break
    if (t !~ /=/ && coder_global_takes_arg(t)) i += 2
    else i++
  }
  if (i > cnt) return 0
  subc = toks[i]
  if (subc != "restart" && subc != "stop" && subc != "update") return 0
  for (k = i + 1; k <= cnt; k++) {
    if (toks[k] ~ /^-/) continue
    if (names_self(toks[k])) return 1
  }
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
  return is_coder_self(command)
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

function tokens_are_coder_self(toks, cnt, i,    base, payload, k, first) {
  while (i <= cnt) {
    if (toks[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { i++; continue }
    if (toks[i] == "if" || toks[i] == "while" || toks[i] == "until" || \
        toks[i] == "then" || toks[i] == "do" || toks[i] == "elif" || \
        toks[i] == "else" || toks[i] == "!") { i++; continue }
    base = base_of(toks[i])
    if (base == "env" || base == "sudo" || base == "exec" || base == "command" || \
        base == "nohup" || base == "time") {
      i = wrapper_command_index(toks, cnt, i, base)
      if (i == 0) return 1
      continue
    }
    break
  }
  if (i > cnt) return 0
  base = base_of(toks[i])
  if (base == "sh" || base == "bash" || base == "zsh") {
    for (k = i + 1; k <= cnt; k++) {
      if (toks[k] ~ /^-[A-Za-z]*c[A-Za-z]*$/ && k < cnt)
        return is_coder_self(toks[k + 1])
      if (toks[k] == "--") break
    }
    return 0
  }
  if (base == "eval") {
    first = i + 1
    if (toks[first] == "--") first++
    payload = join_tokens(toks, first, cnt)
    return (payload != "" && is_coder_self(payload))
  }
  if (base == "coder") return coder_self_target(toks, cnt, i + 1)
  return 0
}

function segment_is_coder_self(segment,    toks, cnt) {
  cnt = tokenize(segment, toks)
  return tokens_are_coder_self(toks, cnt, 1)
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

# Command substitutions. An unmatched $( or backtick stops this scan only; the
# segment scan still runs on the text before the opener.
function nested_is_coder_self(cmd,    n, i, j, c, q, iq, depth) {
  n = length(cmd)
  q = ""
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
      if (is_coder_self(substr(cmd, i + 2, j - i - 2))) return 1
      unparseable = 0
      i = j
      continue
    }
    if (c == "`") {
      for (j = i + 1; j <= n && substr(cmd, j, 1) != "`"; j++);
      if (j > n) { unparseable = i; return 0 }
      if (is_coder_self(substr(cmd, i + 1, j - i - 1))) return 1
      unparseable = 0
      i = j
    }
  }
  return 0
}

function is_coder_self(cmd,    n, i, c, q, seg, segs, nseg, j) {
  cmd = strip_heredocs(cmd)
  unparseable = 0
  if (nested_is_coder_self(cmd)) return 1
  if (unparseable) cmd = substr(cmd, 1, unparseable - 1)
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
    if (c == ";" || c == "&" || c == "|" || c == "\n" || \
        c == "(" || c == ")" || c == "{" || c == "}") {
      nseg++; segs[nseg] = seg; seg = ""
      continue
    }
    seg = seg c
  }
  if (q == "") { nseg++; segs[nseg] = seg }

  for (j = 1; j <= nseg; j++) {
    if (segment_is_coder_self(segs[j])) return 1
  }
  return 0
}

END {
  wsname = ENVIRON["CODER_WORKSPACE_NAME"]
  wsowner = ENVIRON["CODER_WORKSPACE_OWNER_NAME"]
  if (wsname == "") { print "ALLOW"; exit }
  tool_name = jstr(json, "tool_name")
  if (tool_name != "Bash") { print "ALLOW"; exit }
  command = jstr(json, "command")
  print (is_coder_self(command) ? "DENY" : "ALLOW")
}
