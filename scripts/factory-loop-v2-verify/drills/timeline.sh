#!/bin/sh
# timeline.sh SINCE-ISO N [N...]: the testbed's scratch events naming these issues (or fleet events with no
# issue when N is 0) since SINCE, one line each, with the note's key fields.
SINCE=$1; shift; ISSUES="$*"
timeout 150 coder ssh dev-system-testbed-loop -- "SINCE='$SINCE' ISSUES='$ISSUES' sh -s" <<'REMOTE' 2>&1 | grep -v -E 'startup scripts|^Notice|troubleshooting'
python3 - <<'PY'
import json, os, re
since=os.environ['SINCE']; want=set(int(x) for x in os.environ['ISSUES'].split())
for l in open('/persist/events/cbundy__dev-system-scratch.jsonl'):
    try: e=json.loads(l)
    except Exception: continue
    if e.get('ts','')<since: continue
    n=e.get('issue')
    if (n or 0) not in want: continue
    if e.get('state') in ('usage',): continue
    note=e.get('note') or ''
    if e.get('state')=='transition':
        f=dict(re.findall(r'(\w+)=(\S+)', note))
        note='row=%s %s->%s seq=%s step=%s att=%s cut=%s tri=%s fixes=%s round=%s via=%s why=%s' % tuple(f.get(k) for k in ['row','from','to','seq','step','attempt','cut','triages','fixes','round','via','why'])
    elif e.get('state')=='loop':
        f=dict(re.findall(r'(\w+)=(\S+)', note))
        note='kind=%s key=%s status=%s' % (f.get('kind'), f.get('key'), f.get('status'))
    print(e.get('ts','')[11:19], e.get('state'), '#%s'%n, 'pr=%s'%e.get('pr'), e.get('actor'), note[:230])
PY
REMOTE
