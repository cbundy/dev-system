#!/bin/sh
# testbed-check.sh: read-only health check of the v2 loop in the Coder workspace
# dev-system-testbed-loop, run from any workspace with the coder CLI logged in.
#
#   testbed-check.sh            logins, the session, its plugins' handshake, the config, the
#                               last decision-log lines (read only)
#   testbed-check.sh observe N  also switch mode to observe for N seconds (default 200), show the
#                               passes it logged, then switch mode back to off. Observe executes
#                               nothing (its events go to the loop dir's sink-events).
# shellcheck disable=SC2016 # the remote scripts are meant to expand in the workspace
set -eu
WS=dev-system-testbed-loop
mode=${1:-}
secs=${2:-200}

remote() { timeout 300 coder ssh "$WS" -- "$1" 2>&1 | grep -v -E 'startup scripts|^Notice|troubleshooting' || true; }

remote '
D=/persist/claude/factory-loop
L=$D/cbundy__dev-system-scratch
echo "== logins"
claude auth status --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(\"claude loggedIn:\", d.get(\"loggedIn\"), d.get(\"authMethod\"))"
gh auth status 2>&1 | sed -n 2p
echo "== session"
tmux ls 2>&1
for p in $(pgrep -f "^claude --remote-control" || true); do echo "pid $p cwd $(readlink /proc/$p/cwd)"; tr "\0" " " < /proc/$p/cmdline | cut -c1-200; echo; done
tail -3 /tmp/dev-remote-control.log
echo "== companion handshakes (newest first)"
ls -t $D/workspace/ 2>/dev/null | head -3 | while read f; do echo "$f: $(cat $D/workspace/$f)"; done
echo "now: $(date -u +%FT%TZ)"
echo "== config"
cat $D/config.json
ls -la $D/OFF 2>/dev/null && echo "KILL SWITCH ON" || echo "kill switch off ($D/OFF absent)"
echo "== last decision-log lines"
f=$(ls -t $L/decisions-*.jsonl 2>/dev/null | head -1)
[ -n "$f" ] && tail -3 "$f" | python3 -c "
import json,sys
for line in sys.stdin:
    d=json.loads(line)
    ws=[s for s in d.get(\"skipped\",[]) if \"workspace\" in json.dumps(s)]
    print({k:d.get(k) for k in [\"at\",\"pass\",\"mode\",\"executed\",\"planner\",\"tier\",\"counts\",\"rails\",\"config\",\"problems\",\"title\"]})
    print(\"   sources:\", d.get(\"sources\"))
    print(\"   workspace skips:\", ws or \"none\")
" || echo "no decision log yet in $L"
'

[ "$mode" = observe ] || exit 0

setmode() {
  remote "python3 - <<EOF
import json,os
p='/persist/claude/factory-loop/config.json'
d=json.load(open(p)); d['mode']='$1'
open(p+'.tmp','w').write(json.dumps(d,indent=2)+'\n'); os.replace(p+'.tmp',p)
print('mode ->', d['mode'])
EOF"
}

setmode observe
echo "waiting ${secs}s for observe passes"
sleep "$secs"
setmode off
remote '
f=$(ls -t /persist/claude/factory-loop/cbundy__dev-system-scratch/decisions-*.jsonl 2>/dev/null | head -1)
[ -n "$f" ] || { echo "no decision log"; exit 0; }
echo "== $f"
tail -6 "$f" | python3 -c "
import json,sys
for line in sys.stdin:
    d=json.loads(line)
    ws=[s for s in d.get(\"skipped\",[]) if \"workspace\" in json.dumps(s)]
    print({k:d.get(k) for k in [\"at\",\"pass\",\"loaded\",\"mode\",\"executed\",\"planner\",\"tier\",\"counts\",\"actions\",\"rails\",\"config\",\"problems\",\"error\"]})
    print(\"   sources:\", d.get(\"sources\"))
    print(\"   workspace skips:\", ws or \"none\")
"
'
