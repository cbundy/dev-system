# forbid-tmux-kill.awk - detection logic for forbid-tmux-kill.sh (dev-system#177).
# Reads the raw PreToolUse JSON (one record, see BEGIN) from stdin and prints
# exactly one of DENY / ALLOW. See forbid-tmux-kill.sh for the full write-up.
# The JSON extractor, tokenizer and segment splitter mirror forbid-git-stash.awk
# on purpose (each hook stays self-contained).

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

# Basename of a command word (path ending in /tmux counts as tmux).
function base_of(w,    j) {
  for (j = length(w); j >= 1; j--) if (substr(w, j, 1) == "/") return substr(w, j + 1)
  return w
}

# Is sub a (possibly abbreviated) kill-server / kill-session? tmux accepts
# unambiguous prefixes, so kill-ser and kill-ses count; shorter ones are ambiguous.
function is_kill_sub(sc) {
  if (length(sc) < 8) return (sc == "kill-server" || sc == "kill-session")
  return (index("kill-server", sc) == 1 || index("kill-session", sc) == 1)
}

# tmux global options: -L name / -S path select a private socket; -f file,
# -c shell-cmd, -T features take an argument; other flags (-2 -C -D -l -N -u
# -v -V ...) take none. Clusters like -uL name are handled char by char.
# Returns 1 when the segment runs a kill-server/kill-session on the default socket.
function tmux_kill_default_socket(toks, cnt, i,    t, k, ch, priv, need) {
  priv = 0
  while (i <= cnt) {
    t = toks[i]
    if (t !~ /^-/) return (is_kill_sub(t) && !priv) ? 1 : 0
    need = 0
    for (k = 2; k <= length(t); k++) {
      ch = substr(t, k, 1)
      if (ch == "L" || ch == "S") { priv = 1; if (k == length(t)) need = 1; break }
      if (ch == "f" || ch == "c" || ch == "T") { if (k == length(t)) need = 1; break }
    }
    i += 1 + need
  }
  return 0
}

# pkill/killall aimed at tmux: inspect process-name operands, not option values.
function name_option_takes_arg(base, opt) {
  if (base == "pkill")
    return (opt == "-d" || opt == "--delimiter" || opt == "-F" || opt == "--pidfile" || \
            opt == "-G" || opt == "--group" || opt == "-g" || opt == "--pgroup" || \
            opt == "-O" || opt == "--older" || opt == "-P" || opt == "--parent" || \
            opt == "-s" || opt == "--session" || opt == "-t" || opt == "--terminal" || \
            opt == "-u" || opt == "--euid" || opt == "-U" || opt == "--uid" || \
            opt == "--ns" || opt == "--nslist" || opt == "--signal")
  return (opt == "-o" || opt == "--older-than" || opt == "-s" || opt == "--signal" || \
          opt == "-u" || opt == "--user" || opt == "-y" || opt == "--younger-than" || \
          opt == "-Z" || opt == "--context")
}

function name_short_option_takes_arg(base, ch) {
  if (base == "pkill") return (ch ~ /^[dFGgOPstuU]$/)
  return (ch ~ /^[osuyZ]$/)
}

function kills_tmux_by_name(toks, cnt, i, base,    t, k, ch, skip_next, endopts) {
  endopts = 0
  while (i <= cnt) {
    t = toks[i]
    if (!endopts && t == "--") { endopts = 1; i++; continue }
    if (!endopts && t ~ /^--/) {
      if (name_option_takes_arg(base, t)) i += 2
      else i++
      continue
    }
    if (!endopts && t ~ /^-/ && t != "-") {
      skip_next = 0
      for (k = 2; k <= length(t); k++) {
        ch = substr(t, k, 1)
        if (name_short_option_takes_arg(base, ch)) {
          if (k == length(t)) skip_next = 1
          break
        }
      }
      i += 1 + skip_next
      continue
    }
    if (tolower(t) ~ /tmux/) return 1
    i++
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
  return is_tmux_kill(command)
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

function tokens_are_tmux_kill(toks, cnt, i,    base, payload, k, first) {
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
        return is_tmux_kill(toks[k + 1])
      if (toks[k] == "--") break
    }
    return 0
  }
  if (base == "eval") {
    first = i + 1
    if (toks[first] == "--") first++
    payload = join_tokens(toks, first, cnt)
    return (payload != "" && is_tmux_kill(payload))
  }
  if (base == "tmux") return tmux_kill_default_socket(toks, cnt, i + 1)
  if (base == "pkill" || base == "killall") return kills_tmux_by_name(toks, cnt, i + 1, base)
  return 0
}

function segment_is_tmux_kill(segment,    toks, cnt) {
  cnt = tokenize(segment, toks)
  return tokens_are_tmux_kill(toks, cnt, 1)
}

function nested_is_tmux_kill(cmd,    n, i, j, c, q, iq, depth) {
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
      if (j > n || is_tmux_kill(substr(cmd, i + 2, j - i - 2))) return 1
      i = j
      continue
    }
    if (c == "`") {
      for (j = i + 1; j <= n && substr(cmd, j, 1) != "`"; j++);
      if (j > n || is_tmux_kill(substr(cmd, i + 1, j - i - 1))) return 1
      i = j
    }
  }
  return 0
}

# Split the whole command into segments on ; & | newline ( ) { }, quote-aware
# so those characters inside a quoted string never split it.
function is_tmux_kill(cmd,    n, i, c, q, seg, segs, nseg, j) {
  if (nested_is_tmux_kill(cmd)) return 1
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
  nseg++; segs[nseg] = seg

  for (j = 1; j <= nseg; j++) {
    if (segment_is_tmux_kill(segs[j])) return 1
  }
  return 0
}

END {
  tool_name = jstr(json, "tool_name")
  if (tool_name != "Bash") { print "ALLOW"; exit }
  command = jstr(json, "command")
  print (is_tmux_kill(command) ? "DENY" : "ALLOW")
}
