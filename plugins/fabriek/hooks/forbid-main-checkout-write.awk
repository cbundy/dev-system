# forbid-main-checkout-write.awk - detection logic for forbid-main-checkout-write.sh
# (dev-system#624). Reads the raw PreToolUse JSON (one record, see BEGIN) on stdin.
#
# mode=meta: prints three lines, the tool name, the agent id and the cwd, for the
#   wrapper's gate.
# otherwise: prints ALLOW, or DENY<TAB><path relative to the main checkout> for the
#   first write it finds into the protected part of the main checkout.
#
# Variables from the wrapper: main (the main checkout, symlinks resolved), main_lex
# (the same as git printed it), has_realpath (1 when `realpath -m` works).
# See forbid-main-checkout-write.sh for what is refused and what is not.

BEGIN {
  RS = "\3"; HDN = 0; MAXDEPTH = 4; HIT = ""
  # linked worktrees that live under the main checkout (from git worktree list): theirs
  NWT = split(ENVIRON["MAIN_WRITE_WORKTREES"], WTROOT, "\n")
}
{ json = $0 }

# Minimal JSON string-value extractor (same as forbid-git-stash.awk).
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

# --- paths ------------------------------------------------------------------------------

# Lexical normalisation: collapse //, . and .. (how the shell's logical cd sees a path).
function normpath(p,    n, parts, i, out, stack, sp, k) {
  n = split(p, parts, "/")
  sp = 0
  for (i = 1; i <= n; i++) {
    if (parts[i] == "" || parts[i] == ".") continue
    if (parts[i] == "..") { if (sp > 0) sp--; continue }
    stack[++sp] = parts[i]
  }
  out = ""
  for (k = 1; k <= sp; k++) out = out "/" stack[k]
  return out == "" ? "/" : out
}

function shq(s) { gsub(/'/, "'\\''", s); return "'" s "'" }

# The path with symlinks resolved (realpath -m, which also takes paths that do not
# exist yet), else its lexical normal form.
function canon(p,    cmd, r) {
  if (p in CANON) return CANON[p]
  r = ""
  if (has_realpath == 1) {
    cmd = "realpath -m -- " shq(p) " 2>/dev/null"
    if ((cmd | getline r) <= 0) r = ""
    close(cmd)
    sub(/\n+$/, "", r)
  }
  CANON[p] = (r == "" ? normpath(p) : r)
  return CANON[p]
}

# An absolute, canonical path for word t seen from directory dir ("" when unknown).
function resolve(t, dir,    home) {
  if (t == "") return ""
  home = ENVIRON["HOME"]
  if (t == "~") t = home
  else if (substr(t, 1, 2) == "~/") t = home substr(t, 2)
  if (substr(t, 1, 1) != "/") {
    if (dir == "") return ""
    t = dir "/" t
  }
  return canon(t)
}

# A directory the shell would cd into: logical (.. is lexical), then canonical.
function resolve_dir(t, dir,    home) {
  home = ENVIRON["HOME"]
  if (t == "~") t = home
  else if (substr(t, 1, 2) == "~/") t = home substr(t, 2)
  if (substr(t, 1, 1) != "/") {
    if (dir == "") return ""
    t = dir "/" t
  }
  return canon(normpath(t))
}

function under(p, root) { return root != "" && (p == root || substr(p, 1, length(root) + 1) == root "/") }

# The repo-local paths under the main checkout that may be written: the treehouse pool,
# Claude Code's own worktrees, and the operator and loop state files.
function allowed_rel(rel) {
  if (rel == ".treehouse" || substr(rel, 1, 11) == ".treehouse/") return 1
  if (rel == ".claude/worktrees" || substr(rel, 1, 18) == ".claude/worktrees/") return 1
  if (rel == ".claude/orchestrator-memory.md" || rel == ".claude/factory-loop.json") return 1
  if (rel == ".claude/agent-memory" || substr(rel, 1, 21) == ".claude/agent-memory/") return 1
  return 0
}

function prot_in(p, root,    rel) {
  if (!under(p, root)) return 0
  rel = (p == root) ? "" : substr(p, length(root) + 2)
  if (allowed_rel(rel)) return 0
  HIT = (rel == "" ? "." : rel)
  return 1
}

# Is canonical path p in the protected part of the main checkout? Sets HIT.
function protected(p,    w) {
  if (p == "") return 0
  for (w = 1; w <= NWT; w++) if (WTROOT[w] != "" && WTROOT[w] != main && under(p, WTROOT[w])) return 0
  if (prot_in(p, main)) return 1
  if (main_lex != main && prot_in(p, main_lex)) return 1
  return 0
}

# --- heredocs ---------------------------------------------------------------------------

# Replace each heredoc operator and its word with a placeholder \004<n>\004 and store
# the body in HD[n]. Bodies are data to the shell (or the stdin of the command), never
# command text. Adapted from strip_heredocs in forbid-git-stash.awk.
function extract_heredocs(cmd,    nl, lines, i, out, line, delims, tabs, hdi, head, tail, t, q, stack, depth, n, k, c, j, dq, word, hasword, dash, start, kept, part) {
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
      else HD[hdi[head]] = HD[hdi[head]] line "\n"
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
      hasword = 0
      for (; j <= n; j++) {
        c = substr(line, j, 1)
        if (dq == "'") {
          if (c == dq) dq = ""
          else word = word c
          continue
        }
        if (c == "\\") {
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
        if (c == "'" || c == "\"") { dq = c; hasword = 1; continue }
        if (c ~ /[ \t;|&()<>]/) break
        hasword = 1
        word = word c
      }
      if (!hasword || dq != "") continue
      HDN++
      HD[HDN] = ""
      delims[++tail] = word
      tabs[tail] = dash
      hdi[tail] = HDN
      kept = kept substr(line, part, start - part) " \004" HDN "\004 "
      part = j
      k = j - 1
    }
    out = out (i > 1 ? "\n" : "") kept substr(line, part)
  }
  return out
}

# --- segments and words -----------------------------------------------------------------

# Split a command into segments on ; & | && || newline ( ), quote- and backslash-aware,
# recording in seps[] what ended each one. An & or | that belongs to a redirection
# (>&2, &>, >|) does not split, and ${...} is kept whole.
function split_segments(cmd, segs, seps,    n, i, c, q, seg, nseg, prev, nxt, depth) {
  n = length(cmd)
  seg = ""
  q = ""
  nseg = 0
  for (i = 1; i <= n; i++) {
    c = substr(cmd, i, 1)
    if (c == "\\" && q != "'") { seg = seg c substr(cmd, i + 1, 1); i++; continue }
    if (q != "") {
      seg = seg c
      if (c == q) q = ""
      continue
    }
    if (c == "'" || c == "\"") { q = c; seg = seg c; continue }
    if (c == "$" && substr(cmd, i + 1, 1) == "{") {
      depth = 0
      for (; i <= n; i++) {
        c = substr(cmd, i, 1)
        seg = seg c
        if (c == "{") depth++
        else if (c == "}" && --depth == 0) break
      }
      continue
    }
    prev = substr(cmd, i - 1, 1)
    nxt = substr(cmd, i + 1, 1)
    if (c == "&" && (prev == ">" || prev == "<" || nxt == ">")) { seg = seg c; continue }
    if (c == "|" && prev == ">") { seg = seg c; continue }
    if (c == ";" || c == "&" || c == "|" || c == "\n" || c == "(" || c == ")") {
      segs[++nseg] = seg
      seps[nseg] = c
      if ((c == "&" || c == "|") && nxt == c) { seps[nseg] = c c; i++ }
      seg = ""
      continue
    }
    seg = seg c
  }
  segs[++nseg] = seg
  seps[nseg] = ""
  return nseg
}

# The value of $name: assigned earlier in this command (a for list counts), else PWD,
# else the hook's own environment (the agent's shell inherits the same one). Anything
# else (a loop or read variable, one set by an earlier call) makes the word unknown.
function varval(name) {
  if (name in ASSIGNED) { if (ASSIGNED_U[name]) TOKU = 1; return ASSIGNED[name] }
  if (name == "PWD") { if (D == "") TOKU = 1; return D }
  if (name in ENVIRON) return ENVIRON[name]
  TOKU = 1
  return ""
}

# Quote-aware tokenizer with parameter expansion. Fills T[] (text), K[] ("w" word,
# "r" redirection operator, "h" heredoc placeholder whose T is the HD index) and U[]
# (1 when the word holds a command substitution or variable we cannot evaluate).
function tokenize(seg,    n, i, c, q, tok, cnt, nm, op, nxt, started) {
  split("", T); split("", K); split("", U)
  n = length(seg)
  tok = ""
  q = ""
  cnt = 0
  started = 0
  TOKU = 0
  for (i = 1; i <= n; i++) {
    c = substr(seg, i, 1)
    if (q == "'") {
      if (c == "'") q = ""
      else tok = tok c
      continue
    }
    if (c == "\\") {
      nxt = substr(seg, i + 1, 1)
      if (nxt == "\n") { i++; continue }
      if (q == "\"" && nxt !~ /[$`"\\]/) tok = tok c
      tok = tok nxt
      started = 1
      i++
      continue
    }
    if (c == "$") {
      nxt = substr(seg, i + 1, 1)
      if (nxt == "{") {
        nm = ""
        for (i += 2; i <= n && substr(seg, i, 1) != "}"; i++) nm = nm substr(seg, i, 1)
        if (nm ~ /^[A-Za-z_][A-Za-z0-9_]*$/) tok = tok varval(nm)
        else TOKU = 1
        started = 1
        continue
      }
      if (nxt ~ /[A-Za-z_]/) {
        nm = ""
        for (i++; i <= n && substr(seg, i, 1) ~ /[A-Za-z0-9_]/; i++) nm = nm substr(seg, i, 1)
        i--
        tok = tok varval(nm)
        started = 1
        continue
      }
      if (nxt == "(" || nxt == "") { TOKU = 1; started = 1; continue }
      tok = tok c
      started = 1
      continue
    }
    if (c == "`") { TOKU = 1; tok = tok c; started = 1; continue }
    if (q == "\"") {
      if (c == "\"") q = ""
      else tok = tok c
      continue
    }
    if (c == "'" || c == "\"") { q = c; started = 1; continue }
    if (c == "#" && !started) break
    if (c == "\004") {
      if (started) { cnt++; T[cnt] = tok; K[cnt] = "w"; U[cnt] = TOKU }
      nm = ""
      for (i++; i <= n && substr(seg, i, 1) != "\004"; i++) nm = nm substr(seg, i, 1)
      cnt++; T[cnt] = nm; K[cnt] = "h"; U[cnt] = 0
      tok = ""; started = 0; TOKU = 0
      continue
    }
    if (c == ">" || c == "<") {
      # a pure fd number or & right before the operator belongs to it
      if (started && tok !~ /^[0-9]*$/ && tok != "&") { cnt++; T[cnt] = tok; K[cnt] = "w"; U[cnt] = TOKU }
      tok = ""; started = 0; TOKU = 0
      op = c
      nxt = substr(seg, i + 1, 1)
      if (c == ">" && (nxt == ">" || nxt == "|" || nxt == "&")) { op = op nxt; i++ }
      else if (c == "<" && (nxt == "<" || nxt == ">" || nxt == "&")) {
        op = op nxt; i++
        if (op == "<<" && substr(seg, i + 1, 1) == "<") { op = "<<<"; i++ }
      }
      if (op == ">>" && substr(seg, i + 1, 1) == "&") i++
      cnt++; T[cnt] = op; K[cnt] = "r"; U[cnt] = 0
      continue
    }
    if (c == " " || c == "\t") {
      if (started) { cnt++; T[cnt] = tok; K[cnt] = "w"; U[cnt] = TOKU }
      tok = ""; started = 0; TOKU = 0
      continue
    }
    tok = tok c
    started = 1
  }
  if (started) { cnt++; T[cnt] = tok; K[cnt] = "w"; U[cnt] = TOKU }
  return cnt
}

function basename(w,    b) {
  b = w
  sub(/.*\//, "", b)
  return b
}

# --- the write checks ---------------------------------------------------------------------

# Check one written path (a word as typed). A word we cannot evaluate is refused only
# when the command runs in the protected part, where a relative path would land.
function wpath(i) {
  if (WU[i]) return protected(D)
  return protected(resolve(W[i], D))
}

# A writer fed by xargs: its files come from stdin, so refuse when it runs in the
# protected part or an earlier command in the same pipeline names a protected path.
function xargs_hit() {
  if (protected(D)) return 1
  if (PIPE_PROT) { HIT = PIPE_HIT; return 1 }
  return 0
}

# A heredoc that reaches this command's stdin: its own, else one fed into the pipeline.
function stdin_hd(hd) {
  if (hd != "") return hd
  return IN_PIPE ? PIPE_HD : ""
}

# Does inline code (python -c, node -e, a heredoc script) look like it writes files?
function writes_code(code) {
  # method-call forms only, so a path or word that merely contains "write" does not count
  if (code ~ /[.](write|rename|unlink|rmdir|mkdir|makedirs|truncate|symlink|appendFile|rmSync|cpSync|copyFile)|os[.](replace|remove)|shutil[.]|fs[.]rm|writeFile/) return 1
  if (code ~ /open[[:space:]]*\([^)]*,[[:space:]]*['"][^'"]*[wax+]/) return 1
  if (code ~ /open[[:space:]]*\([^)]*['"][+]?>/) return 1
  return 0
}

# Does text name a protected path under the main checkout by its absolute path?
function mentions_main(code) {
  return mentions_in(code, main) || (main_lex != main && mentions_in(code, main_lex))
}
function mentions_in(code, root,    rest, idx, after, rel, c) {
  rest = code
  while ((idx = index(rest, root)) > 0) {
    after = substr(rest, idx + length(root))
    rest = after
    c = substr(after, 1, 1)
    if (c != "" && c != "/" && c !~ /[ \t\n'"`;:,)]/) continue
    rel = after
    sub(/^\//, "", rel)
    sub(/[ \t\n'"`;:,)].*/, "", rel)
    if (allowed_rel(rel)) continue
    HIT = (rel == "" ? "." : rel)
    return 1
  }
  return 0
}

# Interpreter inline code: refuse when it writes and either runs in the protected part
# of the main checkout, or a line that writes names a protected path there (directly or
# through a variable assigned one).
function check_code(code,    n, L, i, nm, names, line) {
  if (code == "") return 0
  gsub(/(sys\.|process\.)?std(out|err)\.write/, "", code)
  if (!writes_code(code)) return 0
  if (protected(D)) return 1
  n = split(code, L, "\n")
  nm = 0
  for (i = 1; i <= n; i++) {
    line = L[i]
    # NAME = '<main path>' (a path, not the content read from one)
    if (line ~ /^[ \t]*(const |let |var |my )?[$]?[A-Za-z_][A-Za-z0-9_]*[ \t]*=[^=]/ && line !~ /open[[:space:]]*\(|read/ && mentions_main(line)) {
      sub(/^[ \t]*(const |let |var |my )?[$]?/, "", line)
      sub(/[^A-Za-z0-9_].*/, "", line)
      names[++nm] = line
      continue
    }
    if (!writes_code(line)) continue
    if (mentions_main(line)) return 1
  }
  for (i = 1; i <= n; i++) {
    if (!writes_code(L[i])) continue
    for (line = 1; line <= nm; line++) {
      if (match(L[i], "(^|[^A-Za-z0-9_])" names[line] "([^A-Za-z0-9_]|$)")) { mentions_main(code); return 1 }
    }
  }
  return 0
}

# Words W[k..nw] form one simple command (after env assignments). Returns 1 to refuse.
function check_command(k, nw, hd, depth,    base, i, t, c, j, nops, ops, opsi, inplace, hasscript, dest, root, gd, sub_, code, cl, ch, rest, xargs, words, valopts, kk, roots, nroots, writer) {
  xargs = 0
  # unwrap wrappers that run the rest of the line as a command
  while (k <= nw) {
    base = basename(W[k])
    if (base == "sudo" || base == "command" || base == "builtin" || base == "exec" || base == "nohup" || \
        base == "time" || base == "stdbuf" || base == "ionice" || base == "chronic" || base == "doas") {
      k++
      while (k <= nw && W[k] ~ /^-/) {
        if ((base == "sudo" || base == "doas") && W[k] ~ /^-[ugCDhprtUT]$/) k++
        k++
      }
      continue
    }
    if ((base == "uv" || base == "poetry" || base == "pdm" || base == "rye" || base == "pipenv") && W[k + 1] == "run") {
      k += 2
      while (k <= nw && W[k] ~ /^-/) {
        if (W[k] ~ /^(--with|-w|--python|-p|--project|--directory|--env-file|--package|--group|--extra)$/) k++
        k++
      }
      continue
    }
    if (base == "nice") {
      k++
      while (k <= nw && W[k] ~ /^-/) { if (W[k] == "-n") k++; k++ }
      continue
    }
    if (base == "env") {
      k++
      while (k <= nw && (W[k] ~ /^-/ || W[k] ~ /^[A-Za-z_][A-Za-z0-9_]*=/)) {
        if (W[k] == "-C" || W[k] == "--chdir") {
          # env -C runs the command in another directory, for this command only
          if (!ENVD_SET) { ENVD_SAVED = D; ENVD_SET = 1 }
          D = WU[k + 1] ? "" : resolve_dir(W[k + 1], D)
        }
        if (W[k] == "-u" || W[k] == "-C" || W[k] == "--chdir" || W[k] == "-S") k++
        k++
      }
      continue
    }
    if (base == "timeout") {
      k++
      while (k <= nw && W[k] ~ /^-/) { if (W[k] == "-s" || W[k] == "-k") k++; k++ }
      k++
      continue
    }
    if (base == "xargs") {
      xargs = 1
      k++
      while (k <= nw && W[k] ~ /^-/) {
        if (W[k] ~ /^-[ILnPsdEae]$/) k++
        k++
      }
      continue
    }
    break
  }
  if (k > nw) return 0
  base = basename(W[k])

  if (base == "cd" || base == "pushd") {
    t = ""
    for (i = k + 1; i <= nw; i++) if (W[i] !~ /^-/ || W[i] == "-") { t = W[i]; break }
    if (t == "") t = ENVIRON["HOME"]
    if (t == "-" || WU[i]) D = ""
    else D = resolve_dir(t, D)
    return 0
  }
  if (base == "popd") { D = ""; return 0 }
  if (base == "export" || base == "declare" || base == "typeset" || base == "local" || base == "readonly") {
    for (i = k + 1; i <= nw; i++) assign(i)
    return 0
  }

  if (base == "git") {
    gd = D
    i = k + 1
    sub_ = ""
    while (i <= nw) {
      t = W[i]
      if (t !~ /^-/) { sub_ = t; break }
      if (t == "-C") { gd = WU[i + 1] ? "" : resolve_dir(W[i + 1], gd); i += 2; continue }
      if (t == "--work-tree") { gd = WU[i + 1] ? "" : resolve_dir(W[i + 1], D); i += 2; continue }
      if (t ~ /^--work-tree=/) { gd = WU[i] ? "" : resolve_dir(substr(t, 13), D); i++; continue }
      if (t == "-c" || t == "--git-dir" || t == "--namespace" || t == "--super-prefix" || \
          t == "--config-env" || t == "--attr-source") { i += 2; continue }
      i++
    }
    if (sub_ ~ /^(checkout|switch|restore|reset|clean|apply|am|commit|add|rm|mv|merge|rebase|cherry-pick|revert|pull|stash)$/) {
      # help, dry runs, stash list/show and git apply's report-only modes change nothing
      if (sub_ == "stash" && (W[i + 1] == "list" || W[i + 1] == "show")) return 0
      for (j = i + 1; j <= nw; j++) {
        t = W[j]
        if (t == "--help" || t == "-h" || t == "--dry-run") return 0
        if (sub_ == "apply" && (t == "--check" || t == "--stat" || t == "--numstat" || t == "--summary") && !applyflag(i, nw)) return 0
      }
      return protected(gd)
    }
    return 0
  }

  if (base ~ /^(ba|z|da|k|)sh$/) {
    for (i = k + 1; i <= nw; i++) {
      t = W[i]
      if (t !~ /^-/) break
      if (t ~ /^-[A-Za-z]*c[A-Za-z]*$/) {
        if (i + 1 <= nw && !WU[i + 1]) return analyze(W[i + 1], depth + 1)
        return 0
      }
    }
    if ((i > nw || W[i] == "-") && stdin_hd(hd) != "") return analyze(HD[stdin_hd(hd)], depth + 1)
    return 0
  }
  if (base == "eval") {
    code = ""
    for (i = k + 1; i <= nw; i++) code = code " " W[i]
    return analyze(code, depth + 1)
  }

  if (base ~ /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|bun|deno|ruby|php|perl)$/) {
    code = ""
    inplace = 0
    nops = 0
    for (i = k + 1; i <= nw; i++) {
      t = W[i]
      if (t == "--") { for (i++; i <= nw; i++) { nops++; ops[nops] = i }; break }
      if (t == "-" || t !~ /^-/) {
        nops++; ops[nops] = i
        # a script file: the rest are its arguments, unless -i makes them files to edit
        if (!inplace && code == "" && t != "-") break
        continue
      }
      if (t ~ /^--/) {
        if (t == "--eval" || t == "--print") { code = code "\n" W[i + 1]; i++ }
        continue
      }
      cl = substr(t, 2)
      for (j = 1; j <= length(cl); j++) {
        ch = substr(cl, j, 1)
        if (ch == "i" && (base == "perl" || base == "ruby")) { inplace = 1; break }
        if ((ch == "c" && base ~ /^(python|pypy)/) || ((ch == "e" || ch == "E") && base ~ /^(perl|ruby|node|nodejs|bun|deno)$/) || \
            (ch == "p" && base ~ /^(node|nodejs|bun)$/) || (ch == "r" && base == "php")) {
          if (j == length(cl)) { code = code "\n" W[i + 1]; i++ }
          else code = code "\n" substr(cl, j + 1)
          break
        }
      }
    }
    if (inplace) {
      for (j = 1; j <= nops; j++) if (wpath(ops[j])) return 1
      if (xargs && xargs_hit()) return 1
      return 0
    }
    if (code == "" && stdin_hd(hd) != "" && (nops == 0 || W[ops[1]] == "-")) code = HD[stdin_hd(hd)]
    return check_code(code)
  }

  if (base == "sed" || base == "gsed") {
    inplace = 0
    hasscript = 0
    nops = 0
    for (i = k + 1; i <= nw; i++) {
      t = W[i]
      if (t == "--") { for (i++; i <= nw; i++) { nops++; ops[nops] = i }; break }
      if (t ~ /^--in-place/) { inplace = 1; continue }
      if (t ~ /^--(expression|file)=/) { hasscript = 1; continue }
      if (t == "--expression" || t == "--file") { hasscript = 1; i++; continue }
      if (t ~ /^--/) continue
      if (t ~ /^-./) {
        cl = substr(t, 2)
        for (j = 1; j <= length(cl); j++) {
          ch = substr(cl, j, 1)
          if (ch == "i") { inplace = 1; break }
          if (ch == "e" || ch == "f") { hasscript = 1; if (j == length(cl)) i++; break }
          if (ch == "l") { if (j == length(cl)) i++; break }
        }
        continue
      }
      nops++; ops[nops] = i
    }
    if (!inplace) return 0
    for (j = (hasscript ? 1 : 2); j <= nops; j++) if (wpath(ops[j])) return 1
    if (xargs && xargs_hit()) return 1
    return 0
  }

  if (base == "awk" || base == "gawk") {
    inplace = 0
    hasscript = 0
    nops = 0
    for (i = k + 1; i <= nw; i++) {
      t = W[i]
      if (t == "-i" && W[i + 1] == "inplace") { inplace = 1; i++; continue }
      if (t == "-iinplace" || t == "--include=inplace") { inplace = 1; continue }
      if (t == "-f" || t == "-v" || t == "-F" || t == "-i") { if (t == "-f") hasscript = 1; i++; continue }
      if (t ~ /^-/) continue
      nops++; ops[nops] = i
    }
    if (!inplace) return 0
    for (j = (hasscript ? 1 : 2); j <= nops; j++) if (wpath(ops[j])) return 1
    return 0
  }

  if (base == "find") {
    nroots = 0
    for (i = k + 1; i <= nw; i++) {
      t = W[i]
      if (t ~ /^[-!(]/) break
      nroots++; roots[nroots] = i
    }
    writer = 0
    for (; i <= nw; i++) {
      t = W[i]
      if (t == "-delete") writer = 1
      if ((t == "-exec" || t == "-execdir" || t == "-ok" || t == "-okdir") && i + 1 <= nw) {
        c = basename(W[i + 1])
        if (c ~ /^(rm|rmdir|mv|cp|touch|truncate|shred|unlink|chmod|chown|tee|ln|install|mkdir|patch|dd)$/) writer = 1
        if (c ~ /^(sed|gsed|perl)$/) {
          for (j = i + 2; j <= nw && W[j] != ";" && W[j] != "+"; j++) {
            if (W[j] ~ /^-[A-Za-z]*i/ || W[j] ~ /^--in-place/) writer = 1
          }
        }
      }
    }
    if (!writer) return 0
    if (nroots == 0) return protected(D)
    for (j = 1; j <= nroots; j++) if (wpath(roots[j])) return 1
    return 0
  }

  if (base == "tar" || base == "bsdtar") {
    writer = 0
    gd = D
    for (i = k + 1; i <= nw; i++) {
      t = W[i]
      if (t == "--extract" || t == "--get" || (t ~ /^-[A-Za-z]*x/) || (i == k + 1 && t ~ /^[A-Za-z]*x[A-Za-z]*$/)) writer = 1
      if (t == "-C" || t == "--directory") { gd = WU[i + 1] ? "" : resolve_dir(W[i + 1], gd); i++ }
      else if (t ~ /^--directory=/) gd = resolve_dir(substr(t, 13), gd)
    }
    return writer ? protected(gd) : 0
  }

  if (base == "curl" || base == "wget") {
    writer = (base == "wget")
    gd = D
    for (i = k + 1; i <= nw; i++) {
      t = W[i]
      if ((base == "curl" && (t == "-o" || t == "--output")) || (base == "wget" && (t == "-O" || t == "--output-document"))) {
        writer = 0
        if (W[i + 1] != "-" && wpath(i + 1)) return 1
        i++
      } else if (base == "curl" && t ~ /^-[A-Za-z]+o$/) {
        if (W[i + 1] != "-" && wpath(i + 1)) return 1
        i++
      } else if (base == "curl" && (t ~ /^-[A-Za-z]*O[A-Za-z]*$/ || t == "--remote-name" || t == "--remote-name-all")) writer = 1
      else if ((base == "curl" && t == "--output-dir") || (base == "wget" && (t == "-P" || t == "--directory-prefix"))) {
        gd = WU[i + 1] ? "" : resolve_dir(W[i + 1], D); i++
      }
    }
    return writer ? protected(gd) : 0
  }

  if (base == "dd") {
    for (i = k + 1; i <= nw; i++) {
      if (W[i] ~ /^of=/ && !WU[i]) { if (protected(resolve(substr(W[i], 4), D))) return 1 }
    }
    return 0
  }

  if (base == "patch") {
    gd = D
    for (i = k + 1; i <= nw; i++) {
      t = W[i]
      if (t == "--dry-run" || t == "-C" || t == "--check") return 0
      if (t == "-d" || t == "--directory") { gd = WU[i + 1] ? "" : resolve_dir(W[i + 1], D); i++ }
      else if (t ~ /^--directory=/) gd = resolve_dir(substr(t, 13), D)
      else if (t == "-o" || t == "--output") { if (!WU[i + 1] && protected(resolve(W[i + 1], D))) return 1; i++ }
    }
    return protected(gd)
  }

  if (base ~ /^(tee|rm|rmdir|touch|mkdir|truncate|shred|unlink|chmod|chown|chgrp|mv|cp|install|ln|rsync)$/) {
    # options that take a separate value, per command
    valopts = ""
    if (base == "touch") valopts = " -d -t -r "
    else if (base == "mkdir") valopts = " -m "
    else if (base == "truncate") valopts = " -s -r "
    else if (base == "shred") valopts = " -n -s "
    else if (base == "install") valopts = " -m -o -g -S -t "
    else if (base == "cp" || base == "mv" || base == "ln") valopts = " -S -t "
    else if (base == "rsync") valopts = " -e -f --exclude --include --filter -T --temp-dir "
    dest = 0
    nops = 0
    for (i = k + 1; i <= nw; i++) {
      t = W[i]
      if (t == "--") { for (i++; i <= nw; i++) { nops++; ops[nops] = i }; break }
      if (t == "-t" && valopts ~ / -t /) { dest = i + 1; i++; continue }
      if (t ~ /^--target-directory=/) { if (!WU[i] && protected(resolve(substr(t, 20), D))) return 1; continue }
      if (t ~ /^-/ && length(t) > 1) {
        if (index(valopts, " " t " ") > 0) i++
        continue
      }
      nops++; ops[nops] = i
    }
    if (dest > 0 && dest <= nw && wpath(dest)) return 1
    if (base ~ /^(cp|install|ln|rsync)$/) {
      if (dest == 0 && nops >= 2 && wpath(ops[nops])) return 1
      if (dest == 0 && nops == 1 && base == "ln" && protected(D)) return 1
    } else {
      for (j = (base ~ /^(chmod|chown|chgrp)$/ ? 2 : 1); j <= nops; j++) if (wpath(ops[j])) return 1
      if (xargs && xargs_hit()) return 1
    }
    return 0
  }

  # formatters and linters told to rewrite files (prettier --write, eslint --fix, ...)
  # on the files named, else (none named) the current directory
  for (i = k + 1; i <= nw; i++) {
    if (W[i] == "--write" || W[i] == "--fix" || W[i] ~ /^--fix=/) {
      kk = k + 1
      if (base ~ /^(npx|bunx|pnpx)$/) kk++
      else if (base ~ /^(npm|pnpm|yarn)$/ && W[kk] ~ /^(exec|dlx|run)$/) kk += 2
      nops = 0
      for (j = kk; j <= nw; j++) if (W[j] !~ /^-/) { nops++; if (wpath(j)) return 1 }
      return nops == 0 ? protected(D) : 0
    }
  }
  return 0
}

# Does a git apply command line (words after index i) carry --apply?
function applyflag(i, nw,    j) {
  for (j = i + 1; j <= nw; j++) if (W[j] == "--apply") return 1
  return 0
}

# Record a NAME=value word into ASSIGNED.
function assign(i,    t, eq) {
  t = W[i]
  eq = index(t, "=")
  if (eq < 2 || substr(t, 1, eq - 1) !~ /^[A-Za-z_][A-Za-z0-9_]*$/) return
  ASSIGNED[substr(t, 1, eq - 1)] = substr(t, eq + 1)
  ASSIGNED_U[substr(t, 1, eq - 1)] = WU[i]
}

# One segment: redirections first (any command), then the command itself.
function check_segment(seg, depth,    cnt, i, op, nw, hd, k, t) {
  cnt = tokenize(seg)
  split("", W); split("", WU)
  nw = 0
  hd = ""
  for (i = 1; i <= cnt; i++) {
    if (K[i] == "h") { hd = T[i]; continue }
    if (K[i] == "r") {
      op = T[i]
      if (i + 1 <= cnt && K[i + 1] == "w") {
        i++
        if ((op ~ /^>/ || op == "<>") && !U[i] && T[i] != "/dev/null" && T[i] !~ /^\/dev\/(stdout|stderr|fd\/)/) {
          if (!(op ~ /&$/ && T[i] ~ /^([0-9]+|-)$/)) {
            if (protected(resolve(T[i], D))) return 1
          }
        }
      }
      continue
    }
    nw++; W[nw] = T[i]; WU[nw] = U[i]
  }
  # an absolute path this segment names, for an xargs writer later in the pipeline
  for (i = 1; i <= nw; i++) {
    if (!SEGPROT && !WU[i] && W[i] ~ /^[\/~]/ && protected(resolve(W[i], D))) { SEGPROT = 1; SEGHIT = HIT }
  }
  SEGHD = hd
  # skip shell keywords and grouping words at command position
  k = 1
  while (k <= nw && W[k] ~ /^(\{|\}|!|then|do|else|elif|if|while|until|done|fi)$/) k++
  # for NAME in WORDS: the loop variable stands for its words; take a protected one if any
  if (W[k] == "for" && k + 2 <= nw && W[k + 2] == "in") {
    t = ""
    for (i = k + 3; i <= nw; i++) {
      if (WU[i]) continue
      if (t == "") t = W[i]
      if (protected(resolve(W[i], D))) { t = W[i]; break }
    }
    ASSIGNED[W[k + 1]] = t
    ASSIGNED_U[W[k + 1]] = (t == "")
    return 0
  }
  # leading assignments: alone they set variables; before a command they apply to it only
  i = k
  while (i <= nw && W[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) i++
  if (i > nw) {
    for (; k <= nw; k++) assign(k)
    return 0
  }
  ENVD_SET = 0
  k = check_command(i, nw, hd, depth)
  if (ENVD_SET) { D = ENVD_SAVED; ENVD_SET = 0 }
  return k
}

# Analyse a whole command string from the current directory D. A nested command (sh -c,
# eval) runs in a subshell, so D is restored afterwards.
function analyze(cmd, depth,    saved, segs, seps, nseg, j, r, ds, dn, pp, ph, phd, ip) {
  if (depth > MAXDEPTH) return 0
  saved = D
  pp = PIPE_PROT; ph = PIPE_HIT; phd = PIPE_HD; ip = IN_PIPE
  cmd = extract_heredocs(cmd)
  nseg = split_segments(cmd, segs, seps)
  r = 0
  dn = 0
  PIPE_PROT = 0; PIPE_HIT = ""; PIPE_HD = ""
  for (j = 1; j <= nseg; j++) {
    # a segment after a lone | reads the pipeline so far; anything else starts afresh
    IN_PIPE = (j > 1 && seps[j - 1] == "|")
    if (!IN_PIPE) { PIPE_PROT = 0; PIPE_HIT = ""; PIPE_HD = "" }
    SEGPROT = 0; SEGHIT = ""; SEGHD = ""
    if (check_segment(segs[j], depth)) { r = 1; break }
    if (SEGPROT) { PIPE_PROT = 1; PIPE_HIT = SEGHIT }
    if (SEGHD != "") PIPE_HD = SEGHD
    # ( and $( open a subshell: a cd inside it ends at the matching )
    if (seps[j] == "(") ds[++dn] = D
    else if (seps[j] == ")" && dn > 0) D = ds[dn--]
  }
  if (depth > 0) {
    D = saved
    PIPE_PROT = pp; PIPE_HIT = ph; PIPE_HD = phd; IN_PIPE = ip
  }
  return r
}

END {
  tool = jstr(json, "tool_name")
  if (mode == "meta") {
    print tool
    print jstr(json, "agent_id")
    print jstr(json, "cwd")
    exit
  }
  cwd = jstr(json, "cwd")
  D = (substr(cwd, 1, 1) == "/") ? canon(cwd) : ""
  deny = 0
  if (tool == "Bash") {
    deny = analyze(jstr(json, "command"), 0)
  } else if (tool == "Edit" || tool == "Write" || tool == "MultiEdit") {
    deny = protected(resolve(jstr(json, "file_path"), D))
  } else if (tool == "NotebookEdit") {
    deny = protected(resolve(jstr(json, "notebook_path"), D))
  }
  if (deny) print "DENY\t" HIT
  else print "ALLOW"
}
