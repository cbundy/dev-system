#!/bin/sh
# obs.sh: read-only snapshot of the testbed v2 loop and the scratch repo.
#   obs.sh [N decision lines, default 3] [events since ISO, default last 30 lines]
WS=dev-system-testbed-loop
N=${1:-3}
SINCE=${2:-}
timeout 200 coder ssh "$WS" -- "N=$N SINCE='$SINCE' sh -s" <<'REMOTE' 2>&1 | grep -v -E 'startup scripts|^Notice|troubleshooting'
D=/persist/claude/factory-loop
L=$D/cbundy__dev-system-scratch
echo "now $(date -u +%FT%TZ) mode=$(python3 -c "import json;print(json.load(open('$D/config.json'))['mode'])") OFF=$([ -e $D/OFF ] && echo ON || echo off)"
f=$(ls -t $L/decisions-*.jsonl 2>/dev/null | head -1)
tail -n "$N" "$f" | python3 -c '
import json,sys
for line in sys.stdin:
    d=json.loads(line)
    acts=["%s:%s#%s(%s)"%(a.get("kind"),a.get("rule"),a.get("issue"),(a.get("reason") or "")[:60]) for a in d.get("actions",[])]
    print("P%s %s %s ex=%s tier=%s counts=%s err=%s" % (d.get("pass"),d.get("at")[11:19],d.get("mode"),d.get("executed"),d.get("tier"),d.get("counts"),d.get("error")))
    bad={k:v for k,v in (d.get("sources") or {}).items() if v!="ok" and k!="runs"}
    if bad: print("   sources:",bad)
    for a in acts: print("   A",a)
    for t in d.get("transitions",[]): print("   T",json.dumps(t)[:300])
    for s in d.get("skipped",[]): print("   S",json.dumps(s)[:250])
    if d.get("problems"): print("   problems",d.get("problems"))
    if d.get("rails"): print("   rails",d.get("rails"))
'
EV=/persist/events/cbundy__dev-system-scratch.jsonl
echo "== events ($EV)"
if [ -f $EV ]; then
  if [ -n "$SINCE" ]; then python3 -c "
import json,sys
for l in open('$EV'):
    e=json.loads(l)
    if e.get('ts','')>='$SINCE': print(e.get('ts','')[11:19],e.get('state'),'#%s'%e.get('issue'),'pr=%s'%e.get('pr'),e.get('actor'),(e.get('note') or '')[:220])
"; else tail -30 $EV | python3 -c "
import json,sys
for l in sys.stdin:
    e=json.loads(l); print(e.get('ts','')[11:19],e.get('state'),'#%s'%e.get('issue'),'pr=%s'%e.get('pr'),e.get('actor'),(e.get('note') or '')[:220])
"; fi
else echo "no event log yet"; fi
echo "== companion.jsonl"
tail -5 $L/companion.jsonl 2>/dev/null || echo none
echo "== slots"
cd /workspaces/dev-system-scratch && treehouse status --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
ws=d.get("worktrees") or d.get("slots") or d
for w in (ws if isinstance(ws,list) else []):
    if w.get("lease") or w.get("leased") or w.get("holder") or w.get("lease_holder"): print("  ",json.dumps(w)[:250])
' 2>/dev/null
REMOTE
echo "== github"
gh issue list --repo cbundy/dev-system-scratch --state all --limit 20 --json number,state,labels --jq '.[] | "#\(.number) \(.state) [\([.labels[].name]|join(","))]"'
gh pr list --repo cbundy/dev-system-scratch --state all --limit 20 --json number,state,headRefName,mergeStateStatus --jq '.[] | "PR\(.number) \(.state) \(.headRefName) \(.mergeStateStatus)"'
gh api repos/cbundy/dev-system-scratch/branches --jq '[.[].name]|join(" ")'
