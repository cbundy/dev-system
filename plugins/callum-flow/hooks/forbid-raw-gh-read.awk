# forbid-raw-gh-read.awk - detection logic for forbid-raw-gh-read.sh (dev-system#312).
# Reads the raw PreToolUse JSON (one record, see BEGIN) from stdin and prints
# exactly one of DENY / ALLOW. See forbid-raw-gh-read.sh for the full write-up.
# The JSON extractor, tokenizer and wrapper/segment/heredoc/substitution logic
# mirror forbid-coder-self.awk on purpose (each hook stays self-contained).
# Unparseable input (unmatched quote, unclosed substitution) is ALLOWed.

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

# Does text t point at a GitHub issue or PR text endpoint? Used for curl/wget
# arguments (any argument, so flag values like -o and URLs are both covered).
function text_is_raw_url(t) {
  t = tolower(t)
  if (index(t, "api.github.com") > 0) return 1
  if (index(t, "patch-diff.githubusercontent.com") > 0) return 1
  if (match(t, /github\.com\/[^\/]+\/[^\/]+\/(issues|pull)/)) return 1
  return 0
}

# WebFetch URL: http(s), optional www., host api.github.com or
# patch-diff.githubusercontent.com, or github.com/<o>/<r>/issues... or /pull....
function url_is_raw(u,    host, path, k) {
  u = tolower(u)
  if (u == "") return 0
  if (match(u, /^[a-z][a-z0-9+.-]*:\/\//)) u = substr(u, RLENGTH + 1)
  else return 0
  k = match(u, /[\/?#]/)
  if (k == 0) { host = u; path = "" }
  else { host = substr(u, 1, k - 1); path = substr(u, k) }
  sub(/^[^@]*@/, "", host)
  sub(/:[0-9]*$/, "", host)
  sub(/^www\./, "", host)
  if (host == "api.github.com" || host == "patch-diff.githubusercontent.com") return 1
  if (host == "github.com" && match(path, /^\/[^\/]+\/[^\/]+\/(issues|pull)/)) return 1
  return 0
}

# Is field f among the comma-separated names in list?
function in_list(list, f,    parts, n, i) {
  n = split(list, parts, ",")
  for (i = 1; i <= n; i++) if (parts[i] == f) return 1
  return 0
}

# gh api flags that take a separate value.
function gh_api_flag_takes_arg(opt) {
  return (opt == "-f" || opt == "-F" || opt == "--field" || opt == "--raw-field" || \
          opt == "-H" || opt == "--header" || opt == "-q" || opt == "--jq" || \
          opt == "-t" || opt == "--template" || opt == "-X" || opt == "--method" || \
          opt == "--input" || opt == "--hostname" || opt == "--cache" || \
          opt == "-p" || opt == "--preview")
}

# gh [global opts] <group> <action> ...: is it a raw read of issue, PR or comment
# text? i is the index after the gh word.
function gh_is_raw(toks, cnt, i,    t, group, action, k, json, hasjson, lt, method, hasfield, hit) {
  group = ""
  action = ""
  while (i <= cnt) {
    t = toks[i]
    if (t ~ /^-/) {
      if (t == "-R" || t == "--repo") i += 2
      else i++
      continue
    }
    if (group == "") { group = t; i++; if (group == "api") break; continue }
    action = t
    i++
    break
  }
  if (group == "") return 0

  if (group == "api") {
    method = ""
    hasfield = 0
    hit = 0
    for (k = i; k <= cnt; k++) {
      t = toks[k]
      if (t ~ /^-/) {
        if (t == "-X" || t == "--method") { method = toupper(toks[k + 1]); k++; continue }
        if (index(t, "--method=") == 1) { method = toupper(substr(t, 10)); continue }
        if (t ~ /^-X./) { method = toupper(substr(t, 3)); continue }
        if (t == "-f" || t == "-F" || t == "--field" || t == "--raw-field" || t == "--input") hasfield = 1
        else if (t ~ /^-[fF]./ || t ~ /^--(field|raw-field|input)=/) hasfield = 1
        if (gh_api_flag_takes_arg(t)) k++
        continue
      }
      lt = tolower(t)
      if (lt == "graphql") return 1
      if (index(lt, "issues") || index(lt, "pulls") || index(lt, "comments") || \
          index(lt, "timeline") || index(lt, "reviews")) hit = 1
    }
    if (method != "" ? method != "GET" : hasfield) return 0
    return hit
  }
  if (group == "search") return (action == "issues" || action == "prs")
  if (group == "issue") return (action == "view" || action == "list" || action == "status")
  if (group != "pr" || (action != "view" && action != "list")) return 0

  hasjson = 0
  json = ""
  for (k = i; k <= cnt; k++) {
    t = toks[k]
    if (t == "--json") { hasjson = 1; json = json "," toks[k + 1]; k++ }
    else if (index(t, "--json=") == 1) { hasjson = 1; json = json "," substr(t, 8) }
    else if (action == "view" && (t == "--comments" || t == "-c" || t == "--web" || t == "-w")) return 1
  }
  if (!hasjson) return 1
  if (in_list(json, "title") || in_list(json, "body")) return 1
  if (action == "view" && (in_list(json, "comments") || in_list(json, "reviews") || in_list(json, "latestReviews"))) return 1
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
  return is_raw_read(command)
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

function tokens_are_raw_read(toks, cnt, i,    base, payload, k, first) {
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
        return is_raw_read(toks[k + 1])
      if (toks[k] == "--") break
    }
    return 0
  }
  if (base == "eval") {
    first = i + 1
    if (toks[first] == "--") first++
    payload = join_tokens(toks, first, cnt)
    return (payload != "" && is_raw_read(payload))
  }
  if (base == "gh") return gh_is_raw(toks, cnt, i + 1)
  if (base == "curl" || base == "wget") {
    for (k = i + 1; k <= cnt; k++) if (text_is_raw_url(toks[k])) return 1
  }
  return 0
}

function segment_is_raw_read(segment,    toks, cnt) {
  cnt = tokenize(segment, toks)
  return tokens_are_raw_read(toks, cnt, 1)
}

# Remove the bodies of quoted heredocs (<<'X', <<"X", <<\X, with optional -):
# the shell never expands them, so text in them is data. Unquoted heredoc
# bodies stay, because $(...) inside them does run.
function strip_heredocs(cmd,    nl, lines, i, out, line, delim, dash, skipping, t, q, n, k, c, rest) {
  nl = split(cmd, lines, "\n")
  out = ""
  skipping = 0
  for (i = 1; i <= nl; i++) {
    line = lines[i]
    if (skipping) {
      t = line
      if (dash) sub(/^\t+/, "", t)
      if (t == delim) skipping = 0
      continue
    }
    out = out (i > 1 ? "\n" : "") line
    dash = 0
    q = ""
    n = length(line)
    for (k = 1; k <= n; k++) {
      c = substr(line, k, 1)
      if (c == "\\" && q != "'") { k++; continue }
      if (q != "") { if (c == q) q = ""; continue }
      if (c == "'" || c == "\"") { q = c; continue }
      if (c != "<" || substr(line, k + 1, 1) != "<") continue
      if (substr(line, k + 2, 1) == "<") { k += 2; continue }
      rest = substr(line, k)
      if (match(rest, /^<<-?[ \t]*('[^']+'|"[^"]+"|\\[A-Za-z_0-9]+)/)) {
        t = substr(rest, 1, RLENGTH)
        dash = (substr(t, 3, 1) == "-")
        sub(/^<<-?[ \t]*/, "", t)
        if (substr(t, 1, 1) == "\\") delim = substr(t, 2)
        else delim = substr(t, 2, length(t) - 2)
        skipping = 1
        break
      }
      k++
    }
  }
  return out
}

# Command substitutions. Unmatched $( or backtick: cannot parse, so allow.
function nested_is_raw_read(cmd,    n, i, j, c, q, iq, depth) {
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
      if (j > n) { unparseable = 1; return 0 }
      if (is_raw_read(substr(cmd, i + 2, j - i - 2))) return 1
      i = j
      continue
    }
    if (c == "`") {
      for (j = i + 1; j <= n && substr(cmd, j, 1) != "`"; j++);
      if (j > n) { unparseable = 1; return 0 }
      if (is_raw_read(substr(cmd, i + 1, j - i - 1))) return 1
      i = j
    }
  }
  return 0
}

function is_raw_read(cmd,    n, i, c, q, seg, segs, nseg, j) {
  cmd = strip_heredocs(cmd)
  unparseable = 0
  if (nested_is_raw_read(cmd)) return 1
  if (unparseable) return 0
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
  if (q != "") return 0
  nseg++; segs[nseg] = seg

  for (j = 1; j <= nseg; j++) {
    if (segment_is_raw_read(segs[j])) return 1
  }
  return 0
}

END {
  tool_name = jstr(json, "tool_name")
  if (tool_name == "Bash") {
    print (is_raw_read(jstr(json, "command")) ? "DENY" : "ALLOW")
  } else if (tool_name == "WebFetch") {
    ti = index(json, "\"tool_input\"")
    print (ti > 0 && url_is_raw(jstr(substr(json, ti), "url")) ? "DENY" : "ALLOW")
  } else {
    print "ALLOW"
  }
}
