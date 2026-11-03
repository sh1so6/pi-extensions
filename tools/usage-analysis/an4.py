import json,glob,collections,re,os,sys
sys.stdout.reconfigure(encoding='utf-8')
D=sys.argv[1] if len(sys.argv)>1 else os.path.expanduser('~/.pi/agent/sessions/--E--Dev-Dev-myproject--')
carry=collections.Counter(); cnt=collections.Counter(); tok=collections.Counter()
skillcarry=collections.Counter()
fullread_big=collections.Counter()
def cat_of(nm,a,txt):
    if nm=='read':
        p=a.get('path','').replace(chr(92),'/')
        if re.search(r'\.(png|jpe?g|webp|gif)$',p,re.I): return 'image(read)'
        if p.endswith('AGENTS.md'): return 'doc:AGENTS.md'
        if 'SKILL.md' in p or '/skills/' in p: return 'doc:skill'
        if p.endswith('TODO.md'): return 'doc:TODO.md'
        if p.endswith('.md'): return 'doc:other-md'
        return 'code(read)'+(' full' if not a.get('offset') and not a.get('limit') else ' ranged')
    if nm=='bash':
        c=a.get('command','')
        if re.search(r'\bunity\b',c) and ('command' in c or 'eval' in c): return 'bash:unity CLI'
        if 'blender' in c.lower() or 'bl.sh' in c: return 'bash:blender'
        if re.search(r'\b(cat|sed -n|head|tail)\b[^|]*\.md',c):
            if 'AGENTS.md' in c: return 'doc:AGENTS.md(bash)'
            if 'SKILL' in c: return 'doc:skill(bash)'
            return 'doc:other-md(bash)'
        if re.search(r'\b(cat|sed -n|head|tail)\b',c): return 'bash:cat/sed source'
        if re.search(r'\b(grep|rg)\b',c): return 'bash:grep'
        if re.search(r'\bgit\b',c): return 'bash:git'
        if re.search(r'python',c): return 'bash:python'
        return 'bash:other'
    if nm=='codemode': return 'codemode'
    if nm in('get_subagent_result','Agent'): return 'subagent results'
    if nm=='ask_advisor': return 'advisor'
    return 'other:'+str(nm)
total=0
for f in sorted(glob.glob(D+'/*.jsonl')):
    kind='main'; events=[]; turns=0; crtok=0; crcost=0; pending={}
    for l in open(f,encoding='utf-8'):
        try:o=json.loads(l)
        except:continue
        if o.get('type')=='session' and 'parentSession' in o: kind='sub'
        if o.get('type')!='message': continue
        m=o['message']; r=m.get('role')
        if r=='assistant':
            turns+=1; u=m.get('usage') or {}; crtok+=u.get('cacheRead',0); crcost+=(u.get('cost') or {}).get('cacheRead',0)
            for x in m.get('content',[]):
                if x.get('type')=='toolCall': pending[x.get('id')]=(x.get('name'),x.get('arguments') or {})
        elif r=='toolResult':
            nm,a=pending.get(m.get('toolCallId'),(m.get('toolName'),{}))
            txt=''.join(x.get('text','') for x in m.get('content',[]) if isinstance(x,dict))
            nimg=sum(1 for x in m.get('content',[]) if isinstance(x,dict) and x.get('type')=='image')
            t=len(txt)/3.2+nimg*1500
            c=cat_of(nm,a,txt)
            if nimg and nm=='codemode': c='image(codemode)'
            events.append((turns,c,t,a.get('path','')))
    price=(crcost/crtok) if crtok else 3e-7
    for (tn,c,t,p) in events:
        rem=max(turns-tn,0)
        k=(kind,c); carry[k]+=t*rem*price; cnt[k]+=1; tok[k]+=t
        if c.startswith('doc:skill') and p: skillcarry[p.replace(chr(92),'/').split('skills/')[-1]]+=t*rem*price
        if c=='code(read) full' and t>4000: fullread_big[p.replace(chr(92),'/').split('myproject')[-1]]+=t*rem*price
    total+=crcost
print('total cacheRead $ %.0f'%total)
print(f"{'kind':5} {'category':28} {'n':>6} {'Mtok':>7} {'carry$':>8}")
for k,v in sorted(carry.items(),key=lambda x:-x[1])[:35]:
    print(f"{k[0]:5} {k[1]:28} {cnt[k]:6d} {tok[k]/1e6:7.2f} {v:8.1f}")
print('\nskill carry $:'); [print(f'  {v:6.1f} {k}') for k,v in skillcarry.most_common(10)]
print('\nbig full code reads carry $:'); [print(f'  {v:6.1f} {k}') for k,v in fullread_big.most_common(12)]
