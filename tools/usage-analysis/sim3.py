import json,glob,os,sys
sys.stdout.reconfigure(encoding='utf-8')
D=sys.argv[1] if len(sys.argv)>1 else os.path.expanduser('~/.pi/agent/sessions/--E--Dev-Dev-myproject--')
p=4e-6; r=0.1*p; w1=1.25*p; w2=2*p; o_=5*p
R={k:0.0 for k in ['actual','A_cachedcomp(1h+compact)','A_1h_nocompact','B_idlewarm(pi default)','B_forcewarm(30min cap)']}
cnt={'miss':0,'miss_lt60':0,'miss_ge60':0,'compact':0}
warmcost=0
for f in glob.glob(D+'/*.jsonl'):
    sub=False; prev=None
    for l in open(f,encoding='utf-8'):
        o=json.loads(l)
        if o['type']=='session': sub='parentSession' in o
        if sub or o['type']!='message' or o['message']['role']!='assistant': continue
        m=o['message']; u=m['usage']; c=u['cost']
        C=u['input']+u['cacheRead']+u['cacheWrite']
        act=c.get('cacheRead',0)+c.get('cacheWrite',0)+c.get('input',0)
        R['actual']+=act
        if prev is None:
            for k in R:
                if k!='actual': R[k]+=act*(1.6 if k.startswith('A') else 1)
            prev=(m['timestamp'],C); continue
        g=(m['timestamp']-prev[0])/60000; P=prev[1]; N=max(C-P,0)
        miss = u['cacheWrite']>30000 and u['cacheRead']<0.5*P
        if not miss:
            for k in R:
                if k=='actual': continue
                R[k]+= (c.get('cacheRead',0)+c.get('input',0)+c.get('cacheWrite',0)*1.6) if k.startswith('A') else act
        else:
            cnt['miss']+=1
            if g<60:
                cnt['miss_lt60']+=1
                R['A_cachedcomp(1h+compact)']+=P*r+N*w2; R['A_1h_nocompact']+=P*r+N*w2
            else:
                cnt['miss_ge60']+=1
                R['A_1h_nocompact']+=C*w2
                if P>=140000: cnt['compact']+=1; R['A_cachedcomp(1h+compact)']+=P*r+5000*o_+(45000+N)*w2
                else: R['A_cachedcomp(1h+compact)']+=C*w2
            for k,force in (('B_idlewarm(pi default)',False),('B_forcewarm(30min cap)',True)):
                if (force or P>=138000) and g<=32: R[k]+=int(g/4.5)*P*r+P*r+N*w1
                elif (force or P>=138000): R[k]+=6*P*r+act
                else: R[k]+=act
        prev=(m['timestamp'],C)
for k,v in R.items(): print(f'{k:28s} ${v:6.0f}  ({v-R["actual"]:+.0f})')
print(cnt)
