#!/bin/sh
# setpace.sh DURATION : set the testbed loop's pass timer (passEvery, e.g. 10s; "default" removes it) in its
# workspace config.json (an operator touch). Run only when the drills operator is not editing the config.
v=$1
timeout 120 coder ssh dev-system-testbed-loop -- "python3 - <<PY
import json,os,datetime
p='/persist/claude/factory-loop/config.json'
d=json.load(open(p)); old=d.get('passEvery')
if '$v'=='default': d.pop('passEvery',None)
else: d['passEvery']='$v'
open(p+'.tmp','w').write(json.dumps(d,indent=2)+'\n'); os.replace(p+'.tmp',p)
print(datetime.datetime.utcnow().strftime('%H:%M:%SZ'),'passEvery',old,'->',d.get('passEvery'))
PY" 2>&1 | grep -v -E 'startup scripts|^Notice|troubleshooting'
