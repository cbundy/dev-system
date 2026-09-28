# forbid-git-stash.awk - detection logic for forbid-git-stash.sh (dev-system#52).
# Reads the raw PreToolUse JSON (one record, see BEGIN) from stdin and prints
# exactly one of DENY / ALLOW. See forbid-git-stash.sh for the full write-up
# of why and what this does and does not catch.

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

# Split the whole command into segments on ; & | newline ( ) { }, quote-aware
# so those characters inside a quoted string never split it.
function is_git_stash(cmd,    n, i, c, q, seg, segs, nseg, j) {
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
