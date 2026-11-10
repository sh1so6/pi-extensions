import json,glob,collections,re,os,sys,statistics as st
sys.stdout.reconfigure(encoding='utf-8')
D=sys.argv[1] if len(sys.argv)>1 else os.path.expanduser('~/.pi/agent/sessions/--E--Dev-Dev-myproject--')
comp=collections.Counter(); spikes=collections.Counter(); spikecost=collections.Counter(); gaps=collections.defaultdict(list)
cw1h=0; models=collections.Counter()
for f in sorted(glob.glob(D+'/*.jsonl')):
    kind='main'; prev_ts=None
    for l in open(f,encoding='utf-8'):
        try:o=json.loads(l)
        except:continue
        if o.get('type')=='session' and 'parentSession' in o: kind='sub'
        if o.get('type')!='message': continue
        m=o['message']
        if m.get('role')=='assistant':
            u=m.get('usage') or {}; c=u.get('cost') or {}
            for k in('input','output','cacheRead','cacheWrite'): comp[(kind,k)]+=c.get(k,0)
            models[(kind,m.get('model'))]+=c.get('total',0)
            cw1h+=u.get('cacheWrite1h',0) or 0
            ts=m.get('timestamp')
            if u.get('cacheWrite',0)>30000:
                gap=(ts-prev_ts)/1000 if prev_ts else -1
                b='first' if gap<0 else '<5m' if gap<300 else '5-60m' if gap<3600 else '>60m'
                spikes[(kind,b)]+=1; spikecost[(kind,b)]+=c.get('cacheWrite',0)
            prev_ts=ts
print('cost components:'); [print('  ',k,round(v)) for k,v in sorted(comp.items())]
print('cost by model:'); [print('  ',k,round(v)) for k,v in models.most_common(10)]
print('cacheWrite1h tokens',cw1h)
print('cacheWrite>30k spikes by gap since previous assistant msg (count, $):')
for k in sorted(spikes): print('  ',k,spikes[k],round(spikecost[k]))
