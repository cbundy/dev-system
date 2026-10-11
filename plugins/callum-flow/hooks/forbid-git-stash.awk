# forbid-git-stash.awk - detection logic for forbid-git-stash.sh (dev-system#52).
# Reads the raw PreToolUse JSON (one record, see BEGIN) from stdin and prints
# exactly one of DENY / ALLOW. See forbid-git-stash.sh for the full write-up
# of why and what this does and does not catch. Quoted heredoc bodies are
# skipped (text in them is data).

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

# Does this one command segment run `git ... stash ...` as its subcommand?
# Skips leading VAR=value env assignments, then - if the command word is
# `git` (or a path ending in /git) - skips git's own global options up to
# the first non-option token, which is the real subcommand. A known set of
# global options (-C, -c, --git-dir, --work-tree, --namespace,
# --super-prefix, --config-env, --attr-source) consumes a separate next
# token as its argument; any other "--xxx=value" form is self-contained;
# any other token starting with "-" is treated as a no-arg flag.
function segment_is_git_stash(segment,    toks, cnt, i, j, t, cmdw, base, slash_idx) {
  cnt = tokenize(segment, toks)
  if (cnt == 0) return 0

  i = 1
  while (i <= cnt && toks[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) i++
  if (i > cnt) return 0

  cmdw = toks[i]
  slash_idx = 0
  for (j = length(cmdw); j >= 1; j--) {
    if (substr(cmdw, j, 1) == "/") { slash_idx = j; break }
  }
  base = (slash_idx > 0) ? substr(cmdw, slash_idx + 1) : cmdw
  if (base != "git") return 0
  i++

  while (i <= cnt) {
    t = toks[i]
    if (t !~ /^-/) return (t == "stash") ? 1 : 0
    if (t == "-C" || t == "-c" || t == "--git-dir" || t == "--work-tree" || \
        t == "--namespace" || t == "--super-prefix" || t == "--config-env" || \
        t == "--attr-source") {
      i += 2
      continue
    }
    i += 1
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

# Split the whole command into segments on ; & | newline ( ) { }, quote-aware
# so those characters inside a quoted string never split it.
function is_git_stash(cmd,    n, i, c, q, seg, segs, nseg, j) {
  cmd = strip_heredocs(cmd)
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
    if (segment_is_git_stash(segs[j])) return 1
  }
  return 0
}

END {
  tool_name = jstr(json, "tool_name")
  if (tool_name != "Bash") { print "ALLOW"; exit }
  command = jstr(json, "command")
  print (is_git_stash(command) ? "DENY" : "ALLOW")
}
