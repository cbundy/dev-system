#!/bin/sh
# waitev.sh MAXSECS ERE [SINCE-ISO]: wait (foreground, bounded) until a line of the testbed's scratch
# event log, or of companion.jsonl, newer than SINCE matches ERE, or MAXSECS pass. Prints the match.
MAX=$1; PAT=$2; SINCE=${3:-}
timeout $((MAX+60)) coder ssh dev-system-testbed-loop -- "MAX=$MAX PAT='$PAT' SINCE='$SINCE' sh -s" <<'REMOTE' 2>&1 | grep -v -E 'startup scripts|^Notice|troubleshooting'
EV=/persist/events/cbundy__dev-system-scratch.jsonl
CJ=/persist/claude/factory-loop/cbundy__dev-system-scratch/companion.jsonl
end=$(( $(date +%s) + MAX ))
hit() { cat $EV $CJ 2>/dev/null | python3 -c "
import json,sys,re
for l in sys.stdin:
    try: e=json.loads(l)
    except Exception: continue
    ts=e.get('ts') or e.get('at') or ''
    if ts>='$SINCE' and re.search(r'''$PAT''', l): print(ts[11:19], e.get('state') or e.get('cause'), '#%s'%e.get('issue'), (e.get('note') or e.get('reason') or '')[:200]); sys.exit(0)
sys.exit(1)"; }
until hit || [ "$(date +%s)" -ge "$end" ]; do sleep 15; done
echo "waited until $(date -u +%T)"
REMOTE
