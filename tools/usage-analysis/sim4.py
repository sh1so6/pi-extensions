import json,glob,os,sys
sys.stdout.reconfigure(encoding='utf-8')
D=sys.argv[1] if len(sys.argv)>1 else os.path.expanduser('~/.pi/agent/sessions/--E--Dev-Dev-myproject--')
p=4e-6; r=0.1*p; w2=2*p
BASE=25000  # system+tools(~12k) + handoff note + last exchange
def run(policy, thr):
    total=0; resets=0
    for f in glob.glob(D+'/*.jsonl'):
        sub=False; prev=None; off=0; pending_user=False
        for l in open(f,encoding='utf-8'):
            o=json.loads(l); t=o['type']
            if t=='session': sub='parentSession' in o
            if sub: break
            if t=='message' and o['message']['role']=='user': pending_user=True
            if t!='message' or o['message']['role']!='assistant': continue
            m=o['message']; u=m['usage']
            C=u['input']+u['cacheRead']+u['cacheWrite']
            if prev is None: total+=C*w2; prev=(m['timestamp'],C); pending_user=False; continue
            g=(m['timestamp']-prev[0])/60000; P=prev[1]; N=max(C-P,0)
            cold = g>=60 and (u['cacheWrite']>30000 and u['cacheRead']<0.5*P)
            Peff=P-off
            do_reset = policy!='none' and Peff>thr and (
                (policy=='user' and pending_user) or (policy=='cold' and cold) or (policy=='user_or_cold' and (pending_user or cold)))
            if do_reset:
                resets+=1; off=P-BASE; total+= (BASE+N)*w2   # rebuild small context (system prefix may be cached; ignore)
            elif cold: total+=(C-off)*w2
            else: total+=Peff*r+N*w2
            prev=(m['timestamp'],C); pending_user=False
    return total,resets
for pol,thr in (('none',0),('cold',140000),('user',150000),('user',100000),('user',60000),('user_or_cold',100000)):
    t,n=run(pol,thr); print(f'{pol:13s} thr={thr//1000:3d}k  main cache ${t:6.0f}  resets={n}')
