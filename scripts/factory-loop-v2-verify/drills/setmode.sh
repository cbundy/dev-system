#!/bin/sh
# setmode.sh off|observe|act : set the testbed loop's mode in its workspace config.json (an operator touch).
m=$1
timeout 120 coder ssh dev-system-testbed-loop -- "python3 - <<PY
import json,os,datetime
p='/persist/claude/factory-loop/config.json'
d=json.load(open(p)); old=d.get('mode'); d['mode']='$m'
open(p+'.tmp','w').write(json.dumps(d,indent=2)+'\n'); os.replace(p+'.tmp',p)
print(datetime.datetime.utcnow().strftime('%H:%M:%SZ'),'mode',old,'->',d['mode'])
PY" 2>&1 | grep -v -E 'startup scripts|^Notice|troubleshooting'
