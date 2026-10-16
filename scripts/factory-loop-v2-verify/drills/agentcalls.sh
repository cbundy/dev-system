#!/bin/sh
# agentcalls.sh AGENT_ID [AGENT_ID...]: an agent's tool calls from its transcript on the testbed (tool, Bash
# command, timeout, run_in_background, cwd), each with how it ended (error text, refusals), and its timings.
IDS="$*"
timeout 150 coder ssh dev-system-testbed-loop -- "IDS='$IDS' sh -s" <<'REMOTE' 2>&1 | grep -v -E 'startup scripts|^Notice|troubleshooting'
python3 - <<'PY'
import json, os, glob
base='/persist/claude/projects/-workspaces-dev-system-scratch'
for aid in os.environ['IDS'].split():
    files=glob.glob(f'{base}/*/subagents/agent-{aid}.jsonl')
    if not files: print('no transcript for', aid); continue
    f=files[0]
    meta=f.replace('.jsonl','.meta.json')
    try: print('==', aid, open(meta).read()[:300])
    except Exception: print('==', aid)
    res={}
    seen=set()
    calls=[]
    for l in open(f):
        try: e=json.loads(l)
        except Exception: continue
        m=e.get('message') or {}
        c=m.get('content')
        if not isinstance(c,list): continue
        for b in c:
            if b.get('type')=='tool_use' and b.get('id') not in seen:
                seen.add(b.get('id'))
                calls.append((e.get('timestamp','')[11:19], b.get('id'), b.get('name'), b.get('input') or {}, e.get('cwd')))
            elif b.get('type')=='tool_result':
                t=b.get('content')
                if isinstance(t,list): t=' '.join(x.get('text','') for x in t if isinstance(x,dict))
                res[b.get('tool_use_id')]=(b.get('is_error'), str(t)[:260].replace('\n',' | '), e.get('timestamp','')[11:19])
    for ts,i,name,inp,cwd in calls:
        r=res.get(i,(None,'(no result)',''))
        if name=='Bash':
            what='cmd=%r timeout=%s bg=%s' % (inp.get('command','')[:220], inp.get('timeout'), inp.get('run_in_background'))
        elif name in ('Edit','Write','Read','MultiEdit','NotebookEdit'):
            what='path=%s' % inp.get('file_path')
        elif name=='Agent' or name=='Task':
            what='sub=%s bg=%s iso=%s' % (inp.get('subagent_type'), inp.get('run_in_background'), inp.get('isolation'))
        else:
            what=json.dumps(inp)[:160]
        print(f'{ts}->{r[2]} {name} {what}')
        if r[0] or 'denied' in r[1].lower() or 'refus' in r[1].lower() or 'block' in r[1].lower():
            print(f'      RESULT err={r[0]}: {r[1]}')
PY
REMOTE
