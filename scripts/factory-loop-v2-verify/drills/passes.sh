#!/bin/sh
# passes.sh FROM TO [cmdfilter]: decision-log passes FROM..TO (by pass number, today's log), with actions, skips,
# transitions, v2 sources and commands (filtered by the optional ERE).
F=$1; T=$2; CF=${3:-.}
timeout 150 coder ssh dev-system-testbed-loop -- "F=$F T=$T CF='$CF' sh -s" <<'REMOTE' 2>&1 | grep -v -E 'startup scripts|^Notice|troubleshooting'
L=/persist/claude/factory-loop/cbundy__dev-system-scratch
cat $(ls $L/decisions-*.jsonl | tail -1) | python3 -c "
import json,sys,re
for line in sys.stdin:
    d=json.loads(line)
    p=d.get('pass')
    if p is None or p<$F or p>$T: 
        if p is None and d.get('at','')[:10]: pass
        continue
    print('P%s %s mode=%s ms=%s trig=%s'%(p,d.get('at','')[11:19],d.get('mode'),d.get('ms'),d.get('trigger')), 'v2src:', {k:v for k,v in (d.get('sources') or {}).items() if k.startswith('v2') and v!='ok'}, 'err:',d.get('error'))
    for a in d.get('actions',[]): print('  A',a.get('kind'),a.get('rule'),a.get('issue'),a.get('key'),(a.get('reason') or '')[:120])
    for s in d.get('skipped',[]): print('  S',json.dumps(s)[:240])
    for t in d.get('transitions',[]): print('  T',json.dumps(t)[:240])
    for c in d.get('commands',[]):
        if re.search(r'''$CF''',c): print('  C',c[:260])
    for k in ('problems','rails','results','outcomes'):
        if d.get(k): print('  ',k,json.dumps(d.get(k))[:600])
"
REMOTE
