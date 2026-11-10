"""pi セッションディレクトリの利用レポート (日本語)。

使い方: python report.py [セッションディレクトリ]   (既定は an5.py と同じ)

構成: parse() で 1 回だけ全 jsonl を読み Record のリストにし、各セクションは
そのリストを受け取る独立した関数 (section_*)。prices() はモデル別の単価を
ログの cost / トークン数から逆算する。
"""
import collections
import datetime
import glob
import json
import os
import sys
import unicodedata
from typing import Dict, List, NamedTuple, Optional

sys.stdout.reconfigure(encoding='utf-8')

GAP_MIN = 300      # 5 分 (秒)
GAP_MAX = 3600     # 60 分 (秒)
HIT_RATIO = 0.8
MIN_N = 10
DEFAULT_DIR = os.path.expanduser('~/.pi/agent/sessions/--E--Dev-Dev-myproject--')
COMPONENTS = (('input', '入力'), ('output', '出力'), ('cacheRead', 'キャッシュ読込'), ('cacheWrite', 'キャッシュ書込'))


class Record(NamedTuple):
    """assistant メッセージ 1 件。gap 系は同一セッション内で計算済み。"""
    kind: str                 # 'main' | 'sub'
    sid: str                  # セッション id (無ければファイル名)
    model: str
    provider: str
    ts: int                   # ms
    input: int
    output: int
    cacheRead: int
    cacheWrite: int
    cw1h: int                 # cacheWrite のうち 1h TTL 分
    cost_input: float
    cost_output: float
    cost_read: float
    cost_write: float         # 1h プレミアム込み
    cost_total: float
    gap: Optional[float]      # 直前 assistant → この assistant を起動した user/toolResult の秒数 (無ければ None)
    prev_ctx: int             # 直前 assistant の input+cacheRead+cacheWrite (無ければ 0)
    h1_active: bool           # これより前に同セッションで cacheWrite1h>0 の発言があった


def _num(x):
    return x if isinstance(x, (int, float)) else 0


def _iso_ms(v):
    """エントリ側の ISO 時刻 ('2026-10-31T08:45:00.901Z') → epoch ms。解釈できなければ None。"""
    if not isinstance(v, str):
        return None
    try:
        return datetime.datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp() * 1000
    except ValueError:
        return None


def parse(directory: str) -> List[Record]:
    """ディレクトリ内の *.jsonl を 1 パスで読み Record を返す (ファイル名順・ファイル内は記録順)。

    あき時間 (gap) の定義と時刻の意味 (実データで確認済み):
      - assistant の message.timestamp は「リクエスト開始」時刻。エントリ側の ISO timestamp が
        「応答の終了」時刻 (生成時間ぶん後)。次の toolResult の timestamp は終了時刻と一致し、次の
        assistant の message.timestamp はその数 ms 後。
      - よって gap = (直前 assistant 以降の最新の非 assistant エントリ時刻) − (直前 assistant の終了時刻)。
        生成時間は含まない。custom_message 等は message.timestamp が無いのでエントリの ISO 時刻を使う。
    """
    recs: List[Record] = []
    for f in sorted(glob.glob(os.path.join(directory, '*.jsonl'))):
        kind = 'main'
        sid = os.path.splitext(os.path.basename(f))[0]
        prev_end = None         # 直前 assistant の応答終了時刻 (ms)
        prev_ctx = 0
        trigger_ts = None       # 直前 assistant 以降の、assistant 以外の全エントリの最新時刻 (ms)
        h1 = False
        with open(f, encoding='utf-8') as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(o, dict):
                    continue
                t = o.get('type')
                if t == 'session':
                    if 'parentSession' in o:
                        kind = 'sub'
                    if o.get('id'):
                        sid = o['id']
                    continue
                m = o.get('message') if t == 'message' else None
                m = m if isinstance(m, dict) else {}
                entry_ts = _iso_ms(o.get('timestamp'))
                if m.get('role') != 'assistant':
                    # user / toolResult / system / custom_message / custom / model_change ... 全て「入力側の出来事」。
                    # 直前 assistant 以降で最も遅い時刻を起動時刻とする。
                    ts = m.get('timestamp') if isinstance(m.get('timestamp'), (int, float)) else entry_ts
                    if ts is not None and (trigger_ts is None or ts > trigger_ts):
                        trigger_ts = ts
                    continue
                ts = m.get('timestamp')
                if not isinstance(ts, (int, float)):
                    continue
                u = m.get('usage') or {}
                c = u.get('cost') or {}
                inp, out = _num(u.get('input')), _num(u.get('output'))
                cr, cw, w1 = _num(u.get('cacheRead')), _num(u.get('cacheWrite')), _num(u.get('cacheWrite1h'))
                gap = None
                if prev_end is not None:
                    # 起動時刻が見つからない場合はこの応答のリクエスト開始 (message.timestamp) で代用
                    g = ((trigger_ts if trigger_ts is not None else ts) - prev_end) / 1000
                    gap = g if g >= 0 else None
                recs.append(Record(kind, sid, m.get('model') or '?', m.get('provider') or '?', ts,
                                   inp, out, cr, cw, w1,
                                   _num(c.get('input')), _num(c.get('output')), _num(c.get('cacheRead')),
                                   _num(c.get('cacheWrite')), _num(c.get('total')),
                                   gap, prev_ctx, h1))
                ctx = inp + cr + cw
                if ctx > 0:     # usage 無しの失敗応答は連鎖に含めない
                    # 応答の終了時刻 = エントリ側の ISO timestamp (無ければ message.timestamp)
                    prev_end, prev_ctx = (entry_ts if entry_ts is not None else ts), ctx
                    trigger_ts = None
                if w1 > 0:
                    h1 = True
    return recs


def prices(records) -> Dict[str, dict]:
    """モデル別の単価 ($/token): {model: {input, output, read, w5m, w1h, estimated:set}}。

    実測 = Σcost / Σtokens。5m 書込は cacheWrite>0 かつ cacheWrite1h==0 の発言のみ、
    1h 書込は (cost.cacheWrite − (cw−w1h)·p5m) / w1h。標本が無い項目は input 単価の
    read 0.1× / 5m 1.25× / 1h 2× で補い estimated に項目名を入れる。
    """
    S = collections.defaultdict(lambda: collections.defaultdict(float))
    h1_msgs = collections.defaultdict(list)
    for r in records:
        s = S[r.model]
        s['in_c'] += r.cost_input; s['in_t'] += r.input
        s['out_c'] += r.cost_output; s['out_t'] += r.output
        s['rd_c'] += r.cost_read; s['rd_t'] += r.cacheRead
        if r.cacheWrite > 0 and r.cw1h == 0:
            s['w5_c'] += r.cost_write; s['w5_t'] += r.cacheWrite
        if r.cw1h > 0:
            h1_msgs[r.model].append(r)
    out = {}
    for model, s in S.items():
        est = set()
        p = {}
        p['input'] = s['in_c'] / s['in_t'] if s['in_t'] > 0 else None
        p['output'] = s['out_c'] / s['out_t'] if s['out_t'] > 0 else None
        p['read'] = s['rd_c'] / s['rd_t'] if s['rd_t'] > 0 else None
        p['w5m'] = s['w5_c'] / s['w5_t'] if s['w5_t'] > 0 else None
        if p['input'] is None:      # input 標本が無ければ output/5 で代用
            p['input'] = p['output'] / 5 if p['output'] else 0.0
            est.add('input')
        base = p['input']
        if p['output'] is None:
            p['output'] = 5 * base
            est.add('output')
        if p['read'] is None:
            p['read'] = 0.1 * base
            est.add('read')
        if p['w5m'] is None:
            p['w5m'] = 1.25 * base
            est.add('w5m')
        msgs = h1_msgs.get(model)
        if msgs:
            tot = sum(r.cost_write - (r.cacheWrite - r.cw1h) * p['w5m'] for r in msgs)
            p['w1h'] = tot / sum(r.cw1h for r in msgs)
        else:
            p['w1h'] = 2 * base
            est.add('w1h')
        p['estimated'] = est
        out[model] = p
    return out


# ---------------------------------------------------------------- 表示ヘルパ

def _w(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in 'WF' else 1 for ch in s)


def _ljust(s: str, n: int) -> str:
    return s + ' ' * max(0, n - _w(s))


def _rjust(s: str, n: int) -> str:
    return ' ' * max(0, n - _w(s)) + s


def usd(x: float) -> str:
    return f'-${-x:,.2f}' if x < -0.005 else f'${abs(x):,.2f}'


def _table(rows, aligns) -> List[str]:
    widths = [max(_w(str(r[i])) for r in rows) for i in range(len(rows[0]))]
    lines = []
    for r in rows:
        cells = [(_ljust if a == 'l' else _rjust)(str(c), widths[i]) for i, (c, a) in enumerate(zip(r, aligns))]
        lines.append('  ' + '  '.join(cells).rstrip())
    return lines


def _day(ts_ms: float) -> datetime.date:
    return datetime.datetime.fromtimestamp(ts_ms / 1000).date()


def _pct(a, b):
    return f'{a / b * 100:.0f}%' if b else '-'


# ---------------------------------------------------------------- セクション

def section_breakdown(records, P=None) -> str:
    L = ['■ 内訳', '']
    if not records:
        return '\n'.join(L + ['  assistant の発言がありません。'])
    comp = collections.defaultdict(float)
    total = collections.defaultdict(float)
    count = collections.Counter()
    models = collections.defaultdict(lambda: collections.defaultdict(float))
    for r in records:
        for key, v in (('input', r.cost_input), ('output', r.cost_output),
                       ('cacheRead', r.cost_read), ('cacheWrite', r.cost_write)):
            comp[(r.kind, key)] += v
            comp[('all', key)] += v
        total[r.kind] += r.cost_total
        total['all'] += r.cost_total
        count[r.kind] += 1
        models[r.kind][r.model] += r.cost_total
    days = sorted({_day(r.ts) for r in records})
    ndays = len(days)
    L.append(f'  期間: {days[0]} ～ {days[-1]}（稼働 {ndays} 日）　発言数: main {count["main"]:,} / sub {count["sub"]:,}')
    L.append(f'  1日あたり: {usd(total["all"] / ndays)}/日（稼働日ベース）')
    L.append('')
    rows = [('', 'main', 'sub', '合計')]
    for key, label in COMPONENTS:
        rows.append((label, usd(comp[('main', key)]), usd(comp[('sub', key)]), usd(comp[('all', key)])))
    rows.append(('合計', usd(total['main']), usd(total['sub']), usd(total['all'])))
    L += _table(rows, 'lrrr')
    L.append('  ※ main=人が直接使う会話、sub=サブエージェントのセッション。')
    for kind in ('main', 'sub'):
        if not models[kind]:
            continue
        L.append('')
        L.append(f'  {kind} の上位モデル（$）')
        top = sorted(models[kind].items(), key=lambda kv: -kv[1])[:5]
        L += _table([(m, usd(v), _pct(v, total[kind])) for m, v in top], 'lrr')
    return '\n'.join(L)


def _rate(hits, n):
    return f'{_pct(len(hits), n)}（{len(hits)}/{n}）' if n else '-'


def _gap_stats(rs):
    hits = [r for r in rs if r.cacheRead >= HIT_RATIO * r.prev_ctx]
    miss = [r for r in rs if r.cacheRead < HIT_RATIO * r.prev_ctx]
    return len(rs), hits, miss, sum(r.cost_write for r in miss)


def one_hour_effect(records, P=None) -> dict:
    """1h キャッシュ効果の数値 (表示と試験の両方で使う)。"""
    P = P or prices(records)
    main = [r for r in records if r.kind == 'main']
    bucket = [r for r in main if r.gap is not None and GAP_MIN <= r.gap < GAP_MAX and r.prev_ctx > 0]
    before = _gap_stats([r for r in bucket if not r.h1_active])
    after = _gap_stats([r for r in bucket if r.h1_active])
    savings = sum(r.cacheRead * (P[r.model]['w5m'] - P[r.model]['read']) for r in after[1])
    premium = sum(r.cw1h * (P[r.model]['w1h'] - P[r.model]['w5m']) for r in main if r.cw1h > 0)
    used = {r.model for r in after[1]} | {r.model for r in main if r.cw1h > 0}
    est = sorted(f'{m}:{k}' for m in used for k in P[m]['estimated'] if k in ('read', 'w5m', 'w1h'))
    return dict(before=before, after=after, savings=savings, premium=premium, net=savings - premium,
                n_saving=len(after[1]), est=est, cw1h_tokens=sum(r.cw1h for r in main), n_main=len(main),
                n_nogap=sum(1 for r in main if r.gap is None))


def section_1h_effect(records, P=None) -> str:
    E = one_hour_effect(records, P)
    L = ['■ 1hキャッシュの効果（mainセッションのみ）', '']
    L.append('  対象: 前の応答から5分以上60分未満あいた後の応答（通常の5分キャッシュは切れている時間帯）。')
    L.append('  あき時間 = 次の入力（ユーザー発言/ツール結果）の時刻 − 前の応答の時刻。')
    L.append('  ヒット = 前回の文脈の80%以上をキャッシュ読込できた場合。')
    L.append('')
    (bn, bh, bm, bc), (an, ah, am, ac) = E['before'], E['after']
    rows = [('', '1hなし(導入前)', '1hあり(導入後)'),
            ('対象の応答数', f'{bn:,}', f'{an:,}'),
            ('ヒット率', _rate(bh, bn), _rate(ah, an)),
            ('ミス時の書込$', usd(bc), usd(ac)),
            ('1回あたりのミス$', usd(bc / bn) if bn else '-', usd(ac / an) if an else '-')]
    L += _table(rows, 'lrr')
    L.append('  → 「ミス時の書込$」は、キャッシュが切れて文脈を丸ごと書き直すのに払った額です。')
    L.append(f'  ※ あき時間が不明な main 応答: {E["n_nogap"]:,} / {E["n_main"]:,} 件（各セッションの最初の応答など。集計から除外）')
    L.append('')
    if E['cw1h_tokens'] == 0:
        L.append('  1hキャッシュへの書込みはまだ記録されていません（効果は未計測）。')
        L.append(f'  参考: 導入前のこの時間帯のミスは {len(bm)} 回、書込み代 {usd(bc)}'
                 f'（1回 {usd(bc / bn) if bn else "-"}）。これが削減できる余地です。')
        return '\n'.join(L)
    n = E['n_saving']
    note = f'　【データ不足（n={n}）】' if n < MIN_N else f'　（n={n}）'
    L.append(f'  実現した節約  {usd(E["savings"])}{note}')
    L.append('    1h導入後にヒットした応答が、5分キャッシュなら書き直していた分の差額です。')
    L.append(f'  1hの割増コスト  {usd(E["premium"])}')
    L.append('    1h書込みは5分書込みより高く、その上乗せ分の合計です（書込み量ベース）。')
    L.append(f'  差し引き（純節約）  {usd(E["net"])}{note}')
    L.append('    節約 − 割増。プラスなら1hキャッシュは得をしています。')
    L.append('')
    L.append(f'  問題の大きさ: 導入前の5〜60分ミス {len(bm)} 回で書込み {usd(bc)}。')
    L.append('    1hキャッシュが無ければ、この種の無駄がこの規模で発生していました。')
    if E['est']:
        L.append('  ※ 推定単価を使用: ' + ', '.join(E['est']) + '（実測の標本なし）')
    return '\n'.join(L)


REF_MODEL = 'claude-opus-5-5'   # サブ節約の比較基準 (固定)


def _is_anthropic(r) -> bool:
    return r.provider == 'anthropic' or r.model.startswith('claude-')


def _reprice(r, p) -> float:
    """発言 r のトークンを単価 p で計算し直した額 (1h 書込みは w1h 単価)。"""
    return (r.input * p['input'] + r.output * p['output'] + r.cacheRead * p['read']
            + (r.cacheWrite - r.cw1h) * p['w5m'] + r.cw1h * p['w1h'])


def _bucket(d: datetime.date, weekly: bool):
    return d - datetime.timedelta(days=d.weekday()) if weekly else d


def sub_savings(records, P=None) -> dict:
    """サブエージェントの節約額 (数値)。"""
    P = P or prices(records)
    ref = P.get(REF_MODEL)
    subs = [r for r in records if r.kind == 'sub']
    anth = [r for r in subs if _is_anthropic(r)]
    other = collections.defaultdict(lambda: [0.0, 0])
    for r in subs:
        if not _is_anthropic(r):
            other[r.model][0] += r.cost_total
            other[r.model][1] += 1
    by_model = collections.defaultdict(lambda: [0.0, 0.0, 0])   # 実際, 換算, 件数
    by_day = collections.defaultdict(lambda: [0.0, 0.0, 0, 0])  # 実際, 換算, 件数, opus 件数
    if ref:
        for r in anth:
            cf = _reprice(r, ref)
            m = by_model[r.model]
            m[0] += r.cost_total; m[1] += cf; m[2] += 1
    days = sorted({_day(r.ts) for r in anth})
    weekly = bool(days) and (days[-1] - days[0]).days + 1 > 14
    if ref:
        for r in anth:
            b = by_day[_bucket(_day(r.ts), weekly)]
            b[0] += r.cost_total; b[1] += _reprice(r, ref); b[2] += 1
            b[3] += 1 if 'opus' in r.model else 0
    actual = sum(v[0] for v in by_model.values())
    cf = sum(v[1] for v in by_model.values())
    cache = {}
    for kind in ('sub', 'main'):
        cache[kind] = sum(r.cacheRead * (P[r.model]['input'] - P[r.model]['read']) for r in records if r.kind == kind)
    return dict(has_ref=bool(ref), ref_estimated=sorted(ref['estimated']) if ref else [], actual=actual,
                counterfactual=cf, saving=cf - actual, by_model=dict(by_model), by_day=dict(by_day), weekly=weekly,
                other=dict(other), cache=cache, n_anth=len(anth))


def section_sub_savings(records, P=None) -> str:
    S = sub_savings(records, P)
    L = ['■ サブエージェントの節約', '']
    if not any(r.kind == 'sub' for r in records):
        return '\n'.join(L + ['  サブエージェントの発言がありません。'])
    L.append(f'  【モデルの置き換え】サブ(Anthropic)の全トークンを {REF_MODEL} の単価で計算し直した額 − 実際の額')
    if not S['has_ref']:
        L.append(f'  {REF_MODEL} の単価が記録に無いため計算できません。')
    else:
        L.append(f'  実際 {usd(S["actual"])}　{REF_MODEL}換算 {usd(S["counterfactual"])}　節約 {usd(S["saving"])}'
                 f'（{_pct(S["saving"], S["counterfactual"])}減、発言 {S["n_anth"]:,} 件）')
        L.append('    サブを全部 Opus で動かした場合との差額です。大きいほど安いモデルへ振り分けた効果が出ています。')
        if S['ref_estimated']:
            L.append('    ※ 基準単価に推定値を含む: ' + ', '.join(S['ref_estimated']))
        L.append('')
        L.append('  モデル別')
        rows = [('モデル', '発言数', '実際$', 'Opus換算$', '節約$')]
        for m, (a, c, n) in sorted(S['by_model'].items(), key=lambda kv: -kv[1][0]):
            rows.append((m, f'{n:,}', usd(a), usd(c), usd(c - a)))
        L += _table(rows, 'lrrrr')
        L.append('')
        L.append('  ' + ('週別（月曜始まり）' if S['weekly'] else '日別') + '　※Opus率 = Opus系モデルの発言割合。下がるほど安いモデルへ移っています')
        rows = [('日付' if not S['weekly'] else '週', '発言数', 'Opus率', '実際$', 'Opus換算$', '節約$')]
        for d, (a, c, n, no) in sorted(S['by_day'].items()):
            rows.append((str(d), f'{n:,}', _pct(no, n), usd(a), usd(c), usd(c - a)))
        L += _table(rows, 'lrrrrr')
    if S['other']:
        L.append('')
        L.append('  Anthropic 以外のサブモデル（実際の額のみ）')
        rows = [(m, f'{n:,}', usd(a)) for m, (a, n) in sorted(S['other'].items(), key=lambda kv: -kv[1][0])]
        L += _table([('モデル', '発言数', '実際$')] + rows, 'lrr')
        L.append('    トークン数・キャッシュ仕様が違うため比較対象外。')
    L.append('')
    L.append('  【プロンプトキャッシュ】参考値（Anthropic 通常のキャッシュ動作で、最近の変更による効果ではありません）')
    L.append(f'  サブ {usd(S["cache"]["sub"])}　main {usd(S["cache"]["main"])}')
    L.append('    キャッシュ読込トークン × (入力単価 − 読込単価)。キャッシュが無く全て通常入力だった場合との差額です。')
    return '\n'.join(L)


def agent_dir() -> str:
    return os.environ.get('PI_CODING_AGENT_DIR') or os.path.expanduser('~/.pi/agent')


def relay_log_path() -> str:
    return os.path.join(agent_dir(), 'context-relay', 'log.jsonl')


def relay_entries(records, log_path=None) -> list:
    """relay ログのうち、records のセッション (sessionId) に属するエントリ。読めなければ空。"""
    path = log_path or relay_log_path()
    sids = {r.sid for r in records}
    entries = []
    try:
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if isinstance(o, dict) and o.get('sessionId') in sids:
                    entries.append(o)
    except OSError:
        pass
    return entries


def section_relay(records, log_path=None) -> str:
    L = ['■ context-relay', '']
    entries = relay_entries(records, log_path)
    if not entries:
        return '\n'.join(L + ['  relay の記録はまだありません。'])
    by = collections.defaultdict(list)
    for o in entries:
        by[str(o.get('trigger') or '?')].append(o)
    rows = [('きっかけ', '回数', '成功', '失敗', '平均 前', '平均 後(概算)')]
    names = {'manual': '手動', 'input': '入力時', 'expiry': '期限切れ前'}
    for trig in sorted(by, key=lambda k: -len(by[k])):
        es = by[trig]
        ok = [e for e in es if e.get('ok')]
        tb = [_num(e.get('tokensBefore')) for e in ok]
        ta = [_num(e.get('noteChars')) / 4 for e in ok]
        avg = lambda xs: f'{sum(xs) / len(xs):,.0f}' if xs else '-'
        rows.append((names.get(trig, trig), len(es), len(ok), len(es) - len(ok), avg(tb), avg(ta)))
    rows.append(('合計', len(entries), sum(1 for e in entries if e.get('ok')), sum(1 for e in entries if not e.get('ok')), '', ''))
    L.append('  文脈を引き継ぎノートに圧縮して新しい会話へ移した記録（このディレクトリのセッションのみ）')
    L += _table(rows, 'lrrrrr')
    L.append('    「前」=圧縮前の文脈トークン、「後」=引き継ぎノート文字数÷4 の概算トークン。成功分の平均です。')
    return '\n'.join(L)


def build_report(records, relay_log=None) -> str:
    P = prices(records)
    return '\n\n'.join([section_breakdown(records, P), section_1h_effect(records, P),
                        section_sub_savings(records, P), section_relay(records, relay_log)])


def main(argv=None):
    argv = sys.argv if argv is None else argv
    d = argv[1] if len(argv) > 1 else DEFAULT_DIR
    print(f'pi 利用レポート: {d}')
    print()
    print(build_report(parse(d)))


if __name__ == '__main__':
    main()
