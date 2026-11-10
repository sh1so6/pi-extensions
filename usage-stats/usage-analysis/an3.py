import json,glob,collections,re,os,sys,statistics as st
sys.stdout.reconfigure(encoding='utf-8')
D=sys.argv[1] if len(sys.argv)>1 else os.path.expanduser('~/.pi/agent/sessions/--E--Dev-Dev-myproject--')
agents_in_sub=0; nsub=0; imgs=collections.Counter(); costband=collections.Counter(); turnsL=[]
sub_first_reads=collections.Counter()
unity_ex=[]; pyerr=[]
cost_after100=0; cost_total=0
growth=[]  # (tokens added per turn)
for f in sorted(glob.glob(D+'/*.jsonl')):
    kind='main'; pending={}; turn=0; nreads=0; prevctx=0; name=''
    for l in open(f,encoding='utf-8'):
        try:o=json.loads(l)
        except:continue
        t=o.get('type')
        if t=='session' and 'parentSession' in o: kind='sub'; nsub+=1
        if t=='session_info': name=o.get('name','')
        if t!='message': continue
        m=o['message']; r=m.get('role')
        if r=='system' and kind=='sub':
            s=json.dumps(m,ensure_ascii=False)
            if '絶対ルール' in s: agents_in_sub+=1
        if r=='assistant':
            turn+=1; u=m.get('usage') or {}; c=(u.get('cost') or {}).get('total',0)
            ctx=u.get('input',0)+u.get('cacheRead',0)+u.get('cacheWrite',0)
            if prevctx and ctx>prevctx: growth.append(ctx-prevctx)
            prevctx=ctx
            cost_total+=c
            band=('<50k' if ctx<5e4 else '<100k' if ctx<1e5 else '<200k' if ctx<2e5 else '<300k' if ctx<3e5 else '>=300k')
            costband[(kind,band)]+=c
            for x in m.get('content',[]):
                if x.get('type')=='toolCall':
                    a=x.get('arguments') or {}; pending[x.get('id')]=(x.get('name'),a)
                    if kind=='sub' and turn<=12:
                        if x.get('name')=='read': sub_first_reads[re.sub(r'.*myproject[^/\\]*[/\\]','',a.get('path','')).replace(chr(92),'/')]+=1
                        if x.get('name')=='bash':
                            for mm in re.findall(r'(?:cat|head|sed -n [^ ]+)\s+([\w./-]+\.md)',a.get('command','')): sub_first_reads['(bash) '+mm.split('/')[-1] if 'SKILL' not in mm else '(bash) '+mm]+=1
        if r=='toolResult':
            nm,a=pending.get(m.get('toolCallId'),(m.get('toolName'),{}))
            for x in m.get('content',[]):
                if isinstance(x,dict) and x.get('type')=='image': imgs[(kind,nm)]+=1
            txt=''.join(x.get('text','') for x in m.get('content',[]) if isinstance(x,dict))
            cmd=a.get('command','') if nm=='bash' else ''
            if m.get('isError') and nm=='bash' and 'unity' in cmd and len(unity_ex)<25: unity_ex.append((cmd[:160].replace('\n',' '),txt.strip()[-200:].replace('\n',' ')))
    if kind=='sub': turnsL.append(turn)
print('subs',nsub,'with AGENTS rules in system prompt',agents_in_sub)
print('images in tool results',imgs.most_common())
print('sub turns: median',st.median(turnsL),'p90',sorted(turnsL)[int(len(turnsL)*.9)],'max',max(turnsL),' >100 turns:',sum(1 for t in turnsL if t>100))
print('cost by ctx band (total $%.0f):'%cost_total)
for k,v in sorted(costband.items()): print('  ',k,round(v))
print('context growth per turn: median',st.median(growth),'p90',sorted(growth)[int(len(growth)*.9)],'p99',sorted(growth)[int(len(growth)*.99)], 'sum of >10k jumps',sum(g for g in growth if g>10000), 'of', sum(growth))
print('\nsub first-12-turn doc reads:')
for k,v in sub_first_reads.most_common(30): print(f'  {v:4d} {k}')
print('\nunity errors sample:')
for c,t in unity_ex: print(' CMD:',c,'\n   ->',t)
