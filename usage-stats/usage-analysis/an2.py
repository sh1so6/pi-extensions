import json,glob,collections,re,os,sys,statistics as st
sys.stdout.reconfigure(encoding='utf-8')
D=sys.argv[1] if len(sys.argv)>1 else os.path.expanduser('~/.pi/agent/sessions/--E--Dev-Dev-myproject--')
syslen={'main':[], 'sub':[]}; first_user={'main':[], 'sub':[]}
errcat=collections.Counter(); errex={}
bigbash=collections.Counter(); bigbashchars=collections.Counter()
gsr=collections.Counter()
ctx_per_turn={'main':[], 'sub':[]}
turns_hist={'main':[], 'sub':[]}
ctx_first=[]  # ctx at first assistant turn (subs)
sameCmdRepeat=0; sameCmdEx=collections.Counter()
sections=collections.Counter()
truncated=collections.Counter()
unity_timeouts=0
def catcmd(cmd):
    c=cmd.strip()
    c=re.sub(r'^cd [^&;]+(&&|;)\s*','',c)
    w=c.split()[:2]
    if not w: return ''
    k=w[0]
    if k in('unity','bash','python','python3','powershell','pwsh','blender','./bl.sh','git') and len(w)>1: k+=' '+w[1][:30]
    return k
for f in sorted(glob.glob(D+'/*.jsonl')):
    kind='main'; pending={}; seencmd=collections.Counter(); first=True; fu=True
    for l in open(f,encoding='utf-8'):
        try:o=json.loads(l)
        except:continue
        t=o.get('type')
        if t=='session' and 'parentSession' in o: kind='sub'
        if t!='message': continue
        m=o['message']; r=m.get('role')
        if r=='system':
            c=m.get('content') or ''
            secs=m.get('sections') or {}
            L=len(c)+sum(len(v) for v in secs.values() if isinstance(v,str))
            syslen[kind].append(L)
            for k,v in secs.items():
                if isinstance(v,str): sections[(kind,k)]+=len(v)
        elif r=='user' and fu:
            fu=False
            c=m.get('content'); s=c if isinstance(c,str) else ''.join(x.get('text','') for x in c if isinstance(x,dict))
            first_user[kind].append(len(s))
        elif r=='assistant':
            u=m.get('usage') or {}
            ctx=u.get('input',0)+u.get('cacheRead',0)+u.get('cacheWrite',0)
            ctx_per_turn[kind].append(ctx)
            if first and kind=='sub': ctx_first.append(ctx); first=False
            for c in m.get('content',[]):
                if c.get('type')=='toolCall':
                    a=c.get('arguments') or {}; pending[c.get('id')]=(c.get('name'),a)
                    if c.get('name')=='bash':
                        cmd=a.get('command','')
                        seencmd[cmd]+=1
                        if seencmd[cmd]>1: sameCmdRepeat+=1; sameCmdEx[catcmd(cmd)]+=1
                    if c.get('name')=='get_subagent_result':
                        gsr['wait' if a.get('wait') else 'nowait']+=1
                        if a.get('verbose'): gsr['verbose']+=1
        elif r=='toolResult':
            nm,a=pending.get(m.get('toolCallId'),(m.get('toolName'),{}))
            txt=''.join(c.get('text','') for c in m.get('content',[]) if isinstance(c,dict))
            if 'truncated' in txt[-400:].lower() or 'Full output' in txt: truncated[nm]+=1
            if nm=='bash':
                k=catcmd(a.get('command',''))
                bigbash[k]+=1; bigbashchars[k]+=len(txt)
                if re.search(r'timed? ?out',txt,re.I) and 'unity' in a.get('command',''): unity_timeouts+=1
            if m.get('isError'):
                first_line=(txt.strip().splitlines() or [''])[-1][:90]
                key=nm+': '+re.sub(r'\d+','N',first_line)
                if nm=='bash':
                    if 'exit code' in txt.lower() or 'Command exited' in txt: key=nm+' exit: '+catcmd(a.get('command',''))
                    if re.search(r'timed out|timeout',txt,re.I): key=nm+' TIMEOUT: '+catcmd(a.get('command',''))
                errcat[key]+=1
for k in('main','sub'):
    print(k,'sys prompt chars median',st.median(syslen[k]) if syslen[k] else 0,'first user msg chars median',st.median(first_user[k]) if first_user[k] else 0, 'p90',sorted(first_user[k])[int(len(first_user[k])*.9)] if first_user[k] else 0)
    c=ctx_per_turn[k]; print('  ctx/turn mean',int(st.mean(c)),'median',int(st.median(c)),'p90',sorted(c)[int(len(c)*.9)])
print('sub ctx at first turn median',st.median(ctx_first))
print('system prompt sections (total chars, sub/main):')
for (k,s),v in sorted(sections.items(),key=lambda x:-x[1])[:20]: print('  ',k,s,v)
print('\nget_subagent_result',gsr)
print('repeated identical bash cmds',sameCmdRepeat, sameCmdEx.most_common(15))
print('unity timeouts',unity_timeouts)
print('truncated outputs',truncated)
print('\nbash output by command kind (count, chars M):')
for k,v in bigbashchars.most_common(25): print(f'  {bigbash[k]:6d} {v/1e6:6.1f}M {k}')
print('\nerror categories:')
for k,v in errcat.most_common(40): print(f'  {v:5d} {k}')
