import json,glob,collections,re,os,sys
sys.stdout.reconfigure(encoding='utf-8')
D=sys.argv[1] if len(sys.argv)>1 else os.path.expanduser('~/.pi/agent/sessions/--E--Dev-Dev-myproject--')
def norm(p):
    p=p.replace(chr(92),'/').strip()
    p=re.sub(r'^(/e/|E:/|e:/)','E:/',p)
    p=re.sub(r'^E:/Dev/myproject(-wt-\w+|\.ai\d|/\.\.?/[^/]+)?/','',p)
    p=re.sub(r'.*?myproject[^/]*/','',p) if 'myproject' in p else p
    return p
S=[]
G_read=collections.Counter(); G_readchars=collections.Counter()
G_doc_bash=collections.Counter()
G_tool=collections.Counter(); G_toolchars=collections.Counter(); G_err=collections.Counter()
G_dupread=collections.Counter()
DOCPAT=re.compile(r'(AGENTS\.md|TODO\.md|SKILL\.md|IMPLEMENTATION\.md|AI_WORKTREE\.md|README\.md|LICENSE_SOURCES\.md|[\w/.-]+\.md)')
for f in sorted(glob.glob(D+'/*.jsonl')):
    s=dict(file=os.path.basename(f),name='',models=collections.Counter(),turns=0,inp=0,cr=0,cw=0,out=0,cost=0.0,
           comp=0,cedit=0,reads=collections.Counter(),readchars=0,dup=0,dupchars=0,docbash=collections.Counter(),
           calls=0,first_edit=None,orient_tok=0,maxctx=0,sub=False,errs=0,resultchars=0)
    pending={}
    readseen={}
    for l in open(f,encoding='utf-8'):
        try:o=json.loads(l)
        except:continue
        t=o.get('type')
        if t=='session': s['sub']= 'parentSession' in o
        elif t=='session_info': s['name']=o.get('name','') or s['name']
        elif t=='compaction': s['comp']+=1
        elif t=='context_edit': s['cedit']+=1
        elif t=='message':
            m=o['message']; r=m.get('role')
            if r=='assistant':
                s['turns']+=1; u=m.get('usage') or {}
                s['models'][m.get('model')]+=1
                s['inp']+=u.get('input',0); s['cr']+=u.get('cacheRead',0); s['cw']+=u.get('cacheWrite',0); s['out']+=u.get('output',0)
                s['cost']+=(u.get('cost') or {}).get('total',0)
                ctx=u.get('input',0)+u.get('cacheRead',0)+u.get('cacheWrite',0); s['maxctx']=max(s['maxctx'],ctx)
                for c in m.get('content',[]):
                    if c.get('type')=='toolCall':
                        s['calls']+=1; nm=c.get('name'); a=c.get('arguments') or {}
                        G_tool[nm]+=1
                        pending[c.get('id')]=(nm,a)
                        if nm in('edit','write') and s['first_edit'] is None:
                            s['first_edit']=s['calls']; s['orient_tok']=ctx
                        if nm=='read':
                            p=norm(a.get('path','')); key=(p,a.get('offset'),a.get('limit'))
                            s['reads'][p]+=1; G_read[p]+=1
                        if nm=='bash':
                            cmd=a.get('command','')
                            for mm in re.finditer(r'\b(cat|head|tail|sed -n|less|type|Get-Content)\b[^|;&]*?([\w./\:-]+\.(md|cs|json|py|txt|shader))',cmd):
                                s['docbash'][norm(mm.group(2))]+=1; G_doc_bash[norm(mm.group(2))]+=1
            elif r=='toolResult':
                nm,a=pending.get(m.get('toolCallId'),(m.get('toolName'),{}))
                txt=''.join(c.get('text','') for c in m.get('content',[]) if isinstance(c,dict))
                n=len(txt); s['resultchars']+=n; G_toolchars[nm]+=n
                if m.get('isError'): s['errs']+=1; G_err[nm]+=1
                if nm=='read':
                    p=norm(a.get('path','')); key=(p,a.get('offset'),a.get('limit'))
                    s['readchars']+=n; G_readchars[p]+=n
                    if key in readseen: s['dup']+=1; s['dupchars']+=n; G_dupread[p]+=1
                    readseen[key]=1
    S.append(s)
json.dump([{k:(dict(v) if isinstance(v,collections.Counter) else v) for k,v in s.items()} for s in S],open('sessions.json','w',encoding='utf-8'),ensure_ascii=False)
main=[s for s in S if not s['sub']]; sub=[s for s in S if s['sub']]
def summ(L,lab):
    tot=lambda k:sum(x[k] for x in L)
    print(f"== {lab}: n={len(L)} turns={tot('turns')} cost=${tot('cost'):.0f} input={tot('inp')/1e6:.1f}M cacheRead={tot('cr')/1e6:.0f}M cacheWrite={tot('cw')/1e6:.0f}M out={tot('out')/1e6:.1f}M comp={tot('comp')} ctxedit={tot('cedit')} calls={tot('calls')} errs={tot('errs')} readchars={tot('readchars')/1e6:.1f}M dupReads={tot('dup')} dupchars={tot('dupchars')/1e6:.2f}M resultchars={tot('resultchars')/1e6:.1f}M")
summ(main,'main'); summ(sub,'sub')
roles=collections.defaultdict(list)
for s in sub: roles[s['name'].split('#')[0]].append(s)
for k,L in sorted(roles.items(),key=lambda x:-len(x[1])): summ(L,'sub:'+k)
print('\n== tools',G_tool.most_common(25)); print('== tool result chars (M)',[(k,round(v/1e6,1)) for k,v in G_toolchars.most_common(15)]); print('== errors',G_err.most_common(10))
print('\n== top read files (count, chars)'); 
for p,c in G_read.most_common(40): print(f"{c:5d} {G_readchars[p]/1e3:8.0f}k dup={G_dupread[p]:4d} {p}")
print('\n== docs read via bash cat/head/sed'); 
for p,c in G_doc_bash.most_common(30): print(f"{c:5d} {p}")
fe=[s for s in S if s['first_edit']]
import statistics as st
for lab,L in (('main',[s for s in fe if not s['sub']]),('sub',[s for s in fe if s['sub']])):
    if L: print(f"\n== {lab} orientation: median calls before first edit={st.median(x['first_edit'] for x in L)}, median ctx at first edit={st.median(x['orient_tok'] for x in L)/1e3:.0f}k")
print('\n== top cost sessions')
for s in sorted(S,key=lambda x:-x['cost'])[:20]: print(f"${s['cost']:7.1f} sub={s['sub']} {s['name'][:30]:30s} turns={s['turns']} comp={s['comp']} maxctx={s['maxctx']/1e3:.0f}k dup={s['dup']} {s['file'][:24]}")
