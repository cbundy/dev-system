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

# pkill/killall aimed at tmux: any argument mentioning tmux, unless it is a
# pkill -f pattern that itself names a private socket ("tmux -L name").
function kills_tmux_by_name(toks, cnt, i,    t) {
  for (; i <= cnt; i++) {
    t = toks[i]
    if (t ~ /tmux/ && t !~ /tmux .*-[LS]/) return 1
  }
  return 0
}

function wrapper_option_takes_arg(base, opt) {
  if (base == "env")
    return (opt == "-u" || opt == "--unset" || opt == "-C" || \
            opt == "--chdir" || opt == "-S" || opt == "--split-string")
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

function wrapper_command_index(toks, cnt, i, base,    opt) {
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

function segment_is_tmux_kill(segment,    toks, cnt, i, base) {
  cnt = tokenize(segment, toks)
  if (cnt == 0) return 0
  i = 1
  while (i <= cnt) {
    if (toks[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { i++; continue }
    base = base_of(toks[i])
    if (base == "env" || base == "sudo" || base == "exec" || base == "command" || \
        base == "nohup" || base == "time") {
      i = wrapper_command_index(toks, cnt, i, base)
      continue
    }
    break
  }
  if (i > cnt) return 0
  base = base_of(toks[i])
  if (base == "tmux") return tmux_kill_default_socket(toks, cnt, i + 1)
  if (base == "pkill" || base == "killall") return kills_tmux_by_name(toks, cnt, i + 1)
  return 0
}

# Split the whole command into segments on ; & | newline ( ) { }, quote-aware
# so those characters inside a quoted string never split it.
function is_tmux_kill(cmd,    n, i, c, q, seg, segs, nseg, j) {
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
