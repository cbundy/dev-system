const fs=require('fs');const D='/tmp/';
const rd=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const claims=fs.readFileSync(D+'claims.csv','utf8').trim().split('\n').slice(1).map(l=>{const [i,r,c,m]=l.split(',');return{n:+i,ready:Date.parse(r.replace(' ','T').replace('+00','Z')),claim:Date.parse(c.replace(' ','T').replace('+00','Z'))}});
const size={607:22,652:2980,855:355,897:525,898:723,899:591,900:542,901:87,903:394,904:6,905:817,906:135,914:700,915:73,917:196,922:577,926:16947,927:3644,937:52,942:802,943:4178};
const health={855:1,917:1,922:1,937:1,946:1};
const iss={};for(const f of fs.readdirSync(D+'iss')){try{const j=rd(D+'iss/'+f).issue;iss[j.number]=j}catch{}}
const closedAt=n=>iss[n]&&iss[n].closed_at?Date.parse(iss[n].closed_at):Infinity;
// edges from timelines
const blocks={},parentOf={},subs={},subAt={};const add=(m,k,v)=>{(m[k]=m[k]||new Set).add(v)};
for(const f of fs.readdirSync(D+'tl')){const n=+f.split('.')[0];let t;try{t=rd(D+'tl/'+f)}catch{continue}
 const ev=[];(function w(o){if(Array.isArray(o))o.forEach(w);else if(o&&typeof o==='object'){if(o.event)ev.push(o);else Object.values(o).forEach(w)}})(t);
 for(const e of ev){if(e.event==='blocked_by_added')add(blocks,e.blocked_by.number,n);
  if(e.event==='blocking_added')add(blocks,n,e.blocking.number);
  if(e.event==='sub_issue_added'){add(subs,n,e.sub_issue.number);parentOf[e.sub_issue.number]=n;subAt[e.sub_issue.number]=Date.parse(e.created_at)}}}
for(const n in iss){const p=iss[n].parent_issue_url;if(p&&!parentOf[n])parentOf[n]=+p.split('/').pop()}
const blockersOf=n=>Object.keys(blocks).filter(b=>blocks[b].has(n)).map(Number);
const C=Object.fromEntries(claims.map(c=>[c.n,c]));
for(const c of claims){const bl=Math.max(0,...blockersOf(c.n).map(closedAt).filter(isFinite));c.elig=Math.min(c.claim,Math.max(c.ready,bl))}
const openAt=(n,t)=>closedAt(n)>t;
function score(n,t){const j=iss[n],L=j.labels.map(l=>l.name),f=[];
 if(L.includes('priority'))f.push(['Owner priority',100]);
 if(L.includes('bug'))f.push(['Bug',25]);
 if(health[n])f.push(['Factory health',20]);
 const direct=[...(blocks[n]||[])].filter(x=>openAt(x,t));
 if(direct.length)f.push([`Unblocks ${direct.length}`,Math.min(40,10*direct.length)]);
 const seen=new Set(direct),q=[...direct];while(q.length){const x=q.shift();for(const y of blocks[x]||[])if(!seen.has(y)&&openAt(y,t)){seen.add(y);q.push(y)}}
 const down=seen.size-direct.length;if(down)f.push([`Frees ${down} further`,Math.min(15,3*down)]);
 const p=parentOf[n];if(p&&subs[p]){const sib=[...subs[p]].filter(x=>x!=n&&(subAt[x]||0)<=t&&openAt(x,t));
  if(sib.length===0)f.push(['Closes epic',25]);else if(sib.length===1)f.push(['Nearly closes epic',10]);
  if([...subs[p]].some(x=>x!=n&&(C[x]&&C[x].claim<t||closedAt(x)<t)))f.push(['Epic started',5])}
 const s=size[n];const sz=s===undefined?['Size M (est.)',5]:s<150?['Size S',15]:s<600?['Size M',5]:s<1500?['Size L',0]:['Size XL',-10];f.push(sz);
 const h=(t-C[n].elig)/36e5;const a=Math.min(20,Math.floor(h*2));if(a>0)f.push([`Waited ${h.toFixed(1)} h`,a]);
 return{total:f.reduce((s,x)=>s+x[1],0),f}}
// actual order
const actual=[...claims].sort((a,b)=>a.claim-b.claim);
const slots=actual.map(c=>c.claim);const done=new Set(),prop=[];
for(const t of slots){const cand=actual.filter(c=>!done.has(c.n)&&c.elig<=t);
 cand.sort((a,b)=>score(b.n,t).total-score(a.n,t).total||a.n-b.n);const pick=cand[0];done.add(pick.n);prop.push(pick.n)}
const out=actual.map((c,i)=>{const s=score(c.n,c.claim);return{n:c.n,title:iss[c.n].title,actual:i+1,proposed:prop.indexOf(c.n)+1,score:s.total,factors:s.f.map(x=>`${x[0]} ${x[1]>0?'+':''}${x[1]}`).join(', '),claim:new Date(c.claim).toISOString().slice(11,16)}});
fs.writeFileSync(D+'score/out.json',JSON.stringify(out,null,1));
const w=actual.map(c=>(c.claim-c.elig)/6e4).sort((x,y)=>x-y);console.log("WAIT",w.filter(x=>x<1).length,w.filter(x=>x<5).length,w[15].toFixed(1),w.slice(-5).map(x=>x.toFixed(0)).join(" "));
for(const o of out)console.log(o.actual,o.proposed,o.n,o.score,o.claim,'|',o.factors,'|',o.title.slice(0,60));
// Scenario B: all 30 ready at once, drained one at a time; compare today's rule vs the score
const set=new Set(actual.map(c=>c.n));const NOW=Date.parse('2026-10-18T17:15:00Z');
function sim(pick){const drained=new Set(),order=[];
 const isOpen=x=>set.has(x)?!drained.has(x):closedAt(x)>NOW;
 while(order.length<set.size){const cand=[...set].filter(n=>!drained.has(n)&&blockersOf(n).every(b=>!isOpen(b)));
  const n=pick(cand,isOpen,drained);drained.add(n);order.push(n)}return order}
function scoreSim(n,isOpen,drained){const j=iss[n],L=j.labels.map(l=>l.name);let s=0;
 if(L.includes('priority'))s+=100;if(L.includes('bug'))s+=25;if(health[n])s+=20;
 const direct=[...(blocks[n]||[])].filter(isOpen);s+=Math.min(40,10*direct.length);
 const seen=new Set(direct),q=[...direct];while(q.length){const x=q.shift();for(const y of blocks[x]||[])if(!seen.has(y)&&isOpen(y)){seen.add(y);q.push(y)}}
 s+=Math.min(15,3*(seen.size-direct.length));
 const p=parentOf[n];if(p&&subs[p]){const sib=[...subs[p]].filter(x=>x!=n&&isOpen(x));if(!sib.length)s+=25;else if(sib.length===1)s+=10;if([...subs[p]].some(x=>x!=n&&!isOpen(x)))s+=5}
 const z=size[n];s+=z===undefined?5:z<150?15:z<600?5:z<1500?0:-10;return s}
const isPri=n=>iss[n].labels.some(l=>l.name==='priority');
const today=sim(c=>c.sort((a,b)=>isPri(b)-isPri(a)||a-b)[0]);
const scored=sim((c,o,d)=>c.sort((a,b)=>scoreSim(b,o,d)-scoreSim(a,o,d)||a-b)[0]);
fs.writeFileSync(D+'score/simB.json',JSON.stringify({today,scored}));
console.log('today ',today.join(' '));console.log('scored',scored.join(' '));
// when do epics finish / bugs land under each
const epicDone=o=>{const r={};for(const p of [534,651,653,658,667,671,928]){const k=[...(subs[p]||[])].filter(x=>set.has(x));if(!k.length)continue;r[p]=Math.max(...k.map(x=>o.indexOf(x)+1))}return r};
console.log(epicDone(today),epicDone(scored));
const bugs=[...set].filter(n=>iss[n].labels.some(l=>l.name==='bug'));const avg=o=>(bugs.reduce((s,n)=>s+o.indexOf(n)+1,0)/bugs.length).toFixed(1);console.log('bugs avg pos',avg(today),avg(scored), bugs.join(' '));
// Snapshot the facts the replay used, so the backtest can be rerun without GitHub.
const facts={issues:[...set].map(n=>({issue:n,labels:iss[n].labels.map(l=>l.name),parent:parentOf[n]||null,ready:new Date(C[n].ready).toISOString(),claimable:new Date(C[n].elig).toISOString(),claimed:new Date(C[n].claim).toISOString(),changedLines:size[n]??null,factoryHealth:!!health[n]})),
 blocks:Object.fromEntries(Object.entries(blocks).map(([k,v])=>[k,[...v]])),subIssues:Object.fromEntries(Object.entries(subs).map(([k,v])=>[k,[...v]])),
 subAddedAt:Object.fromEntries(Object.entries(subAt).map(([k,v])=>[k,new Date(v).toISOString()])),
 closedAt:Object.fromEntries(Object.keys(iss).filter(n=>iss[n].closed_at).map(n=>[n,iss[n].closed_at]))};
fs.writeFileSync(D+'score/facts.json',JSON.stringify(facts,null,1));
