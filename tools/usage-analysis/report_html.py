"""pi セッションディレクトリの利用レポートを 1 枚の HTML (CSS/SVG 埋め込み・外部依存なし) にする。

使い方: python report_html.py [セッションディレクトリ] [--out PATH]
  既定の出力先: <agent_dir>/usage-report/<セッションディレクトリ名>.html
  標準出力の最後の行に出力ファイルの絶対パスを表示する (usage-stats 拡張がこれを読む)。

数値の計算は report.py のもの (parse / prices / one_hour_effect / sub_savings / relay_entries) を
そのまま使い、ここでは表示 (HTML と SVG) だけを作る。
"""
import argparse
import collections
import datetime
import html
import json
import math
import os
import sys
import time
from typing import List, Optional

import report

WEEK_MS = 7 * 86_400_000
NOTE_COST = '金額はAPI従量課金に換算した参考値（サブスクでは実際の請求額ではありません）'
REL_NAMES = {'manual': '手動', 'input': '入力時', 'expiry': '期限切れ前'}

CSS = """
:root{color-scheme:light dark;--bg:#f7f8fa;--card:#fff;--fg:#1c2330;--sub:#5b6577;--line:#d9dee7;--grid:#e6e9ef;
--main:#0072B2;--subc:#E69F00;--ref:#8c95a6;--good:#0a7d55;--bad:#b3261e;
--c-input:#56B4E9;--c-output:#D55E00;--c-cacheRead:#009E73;--c-cacheWrite:#CC79A7;--hit:#009E73;--miss:#D55E00}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--fg:#e6e9ef;--sub:#9aa5b8;--line:#323a49;
--grid:#2a313e;--ref:#7d879a;--good:#4cc79b;--bad:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "Segoe UI","Hiragino Sans","Yu Gothic UI",Meiryo,sans-serif}
main{max-width:900px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.15rem;margin:0 0 4px}
header p,.cap,.note{color:var(--sub);margin:2px 0}
.note{font-size:.85rem}.cap{font-size:.9rem;margin-bottom:10px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:16px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:14px 0 4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.card .k{font-size:.8rem;color:var(--sub)}.card .v{font-size:1.45rem;font-weight:700;font-variant-numeric:tabular-nums}
.card .s{font-size:.8rem;color:var(--sub)}
.gauge{margin:10px 0}.gauge .row{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.track{height:16px;border-radius:8px;background:var(--grid);overflow:hidden;border:1px solid var(--line)}
.fill{height:100%;background:var(--main)}.fill.hi{background:var(--miss)}
.est{border-left:4px solid var(--subc);padding:4px 10px;margin:6px 0;font-size:.9rem}
.stale{color:var(--sub)}
svg{width:100%;height:auto;display:block}
svg text{fill:var(--fg);font-size:12px}svg .mut{fill:var(--sub)}svg .axis{stroke:var(--line)}svg .grid{stroke:var(--grid)}
.f-main{fill:var(--main)}.f-sub{fill:var(--subc)}.f-ref{fill:var(--ref)}.f-hit{fill:var(--hit)}.f-miss{fill:var(--miss)}
.f-input{fill:var(--c-input)}.f-output{fill:var(--c-output)}.f-cacheRead{fill:var(--c-cacheRead)}.f-cacheWrite{fill:var(--c-cacheWrite)}
svg text.on{fill:#fff;font-weight:600}svg text.on-dark{fill:#111;font-weight:600}
table{border-collapse:collapse;width:100%;font-size:.9rem;font-variant-numeric:tabular-nums;margin:8px 0}
th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:right}th:first-child,td:first-child{text-align:left}
th{color:var(--sub);font-weight:600}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.85rem;margin:4px 0}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:4px;vertical-align:-1px}
.sw.main{background:var(--main)}.sw.sub{background:var(--subc)}.sw.ref{background:var(--ref)}
.sw.input{background:var(--c-input)}.sw.output{background:var(--c-output)}.sw.cacheRead{background:var(--c-cacheRead)}
.sw.cacheWrite{background:var(--c-cacheWrite)}
.big{font-size:1.2rem;font-weight:700}.good{color:var(--good)}.bad{color:var(--bad)}
"""


# ---------------------------------------------------------------- 小物

def esc(x) -> str:
    return html.escape(str(x), quote=True)


def usd(x) -> str:
    return report.usd(x)


def pct(a, b) -> str:
    return report._pct(a, b)


def fmt_time(ms) -> str:
    return datetime.datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M')


def nice_max(v: float, ticks: int = 4):
    """v 以上のきりのよい上限と刻み幅。"""
    if v <= 0:
        return 1.0, 0.25
    raw = v / ticks
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            step = m * mag
            break
    return step * ticks, step


def axis_usd(v: float) -> str:
    return f'${v:,.0f}' if v >= 10 or float(v).is_integer() else f'${v:,.2f}'


def legend(items) -> str:
    """items: [(css class, label)]"""
    return '<div class="legend">' + ''.join(
        f'<span><i class="sw {c}"></i>{esc(l)}</span>' for c, l in items) + '</div>'


def svg(w, h, title, body) -> str:
    return (f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{esc(title)}" xmlns="http://www.w3.org/2000/svg">'
            f'<title>{esc(title)}</title>{body}</svg>')


def text(x, y, s, anchor='start', cls='') -> str:
    c = f' class="{cls}"' if cls else ''
    return f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}"{c}>{esc(s)}</text>'


def rect(x, y, w, h, cls, tip='') -> str:
    t = f'<title>{esc(tip)}</title>' if tip else ''
    return f'<rect x="{x:.1f}" y="{y:.1f}" width="{max(w, 0):.1f}" height="{max(h, 0):.1f}" class="{cls}" rx="2">{t}</rect>'


def bar_chart(buckets, series, title, stacked: bool, width=860, height=280) -> str:
    """縦棒グラフ。buckets=[(ラベル, [系列ごとの値])]、series=[(css 名, 凡例名)]。

    stacked=True なら積み上げ、False なら並べる。Y 軸に $ の目盛り、棒の上に値を表示 (棒が多い時は合計のみ省略)。
    """
    L, R, T, B = 58, 12, 22, 34
    pw, ph = width - L - R, height - T - B
    totals = [sum(v) if stacked else max(v) for _, v in buckets]
    top, step = nice_max(max(totals) if totals else 0)
    y = lambda v: T + ph - v / top * ph
    out = []
    k = 0.0
    while k <= top + 1e-9:
        out.append(f'<line class="grid" x1="{L}" x2="{width - R}" y1="{y(k):.1f}" y2="{y(k):.1f}"/>')
        out.append(text(L - 6, y(k) + 4, axis_usd(k), 'end', 'mut'))
        k += step
    n = len(buckets)
    slot = pw / max(n, 1)
    gap = slot * 0.2
    ns = len(series)
    show_vals = n <= 14
    label_every = max(1, math.ceil(n / 12))
    for i, (label, vals) in enumerate(buckets):
        x0 = L + i * slot + gap / 2
        bw = slot - gap
        if stacked:
            acc = 0.0
            for (cls, name), v in zip(series, vals):
                if v > 0:
                    out.append(rect(x0, y(acc + v), bw, y(acc) - y(acc + v), 'f-' + cls, f'{label} {name} {usd(v)}'))
                acc += v
            if show_vals and acc > 0:
                out.append(text(x0 + bw / 2, y(acc) - 4, usd(acc), 'middle'))
        else:
            sw = bw / ns
            for j, ((cls, name), v) in enumerate(zip(series, vals)):
                out.append(rect(x0 + j * sw, y(v), sw - 1, y(0) - y(v), 'f-' + cls, f'{label} {name} {usd(v)}'))
                if show_vals and n <= 8:
                    out.append(text(x0 + j * sw + sw / 2, y(v) - 4, usd(v), 'middle', 'mut'))
        if i % label_every == 0:
            out.append(text(x0 + bw / 2, height - 12, label, 'middle', 'mut'))
    out.append(f'<line class="axis" x1="{L}" x2="{width - R}" y1="{y(0):.1f}" y2="{y(0):.1f}"/>')
    return svg(width, height, title, ''.join(out))


def hbars(rows, title, width=860, unit_fmt=None, vmax=None) -> str:
    """横棒 (積み上げ)。rows=[(ラベル, [(css, 値, 凡例名)])]。値は合計に対する % と $ をセグメント内に出す。"""
    L, R, rh = 90, 12, 44
    height = 16 + rh * len(rows)
    vmax = vmax or max((sum(v for _, v, _ in segs) for _, segs in rows), default=0) or 1
    pw = width - L - R
    out = []
    for i, (label, segs) in enumerate(rows):
        yy = 10 + i * rh
        tot = sum(v for _, v, _ in segs)
        out.append(text(L - 8, yy + 22, label, 'end'))
        x = float(L)
        for cls, v, name in segs:
            w = v / vmax * pw
            if v > 0:
                out.append(rect(x, yy, w, 30, 'f-' + cls, f'{label} {name} {usd(v)}（{pct(v, tot)}）'))
                if w > 62:
                    dark = cls in ('input', 'cacheRead')
                    out.append(text(x + w / 2, yy + 20, f'{usd(v)} ({pct(v, tot)})', 'middle', 'on-dark' if dark else 'on'))
            x += w
        out.append(text(x + 6, yy + 20, usd(tot), 'start', 'mut') if x + 60 < width else '')
    return svg(width, height, title, ''.join(out))


# ---------------------------------------------------------------- 使用量ゲージ

def _read_json(path):
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _quota(percent, resets):
    if isinstance(percent, bool) or isinstance(resets, bool):
        return None
    if isinstance(percent, (int, float)) and isinstance(resets, (int, float)):
        return float(percent), float(resets)
    return None


def load_quota(adir: str) -> dict:
    """{'7d': (percent, resetsAt) | None}。ファイルが無い/壊れている場合は None。
    ※ 5時間枠は廃止されたため扱わない。"""
    res = {'7d': None}
    bar = _read_json(os.path.join(adir, 'usage-bar-cache.json'))
    items = bar.get('anthropic') if isinstance(bar, dict) else None
    for it in items if isinstance(items, list) else []:
        if isinstance(it, dict):
            cat = it.get('category') or it.get('label')
            if cat in res and res[cat] is None:
                res[cat] = _quota(it.get('percent'), it.get('resetsAt'))
    router = _read_json(os.path.join(adir, 'claude-quota-router.cache.json'))
    w7 = router.get('w7d') if isinstance(router, dict) else None
    if isinstance(w7, dict):
        q = _quota(w7.get('percent'), w7.get('resetsAt'))
        if q:
            res['7d'] = q
    return res


def _remain(ms) -> str:
    m = max(0, int(ms // 60_000))
    d, h, mi = m // 1440, m % 1440 // 60, m % 60
    return (f'{d}日' if d else '') + (f'{h}時間' if h or d else '') + f'{mi}分'


def gauge(label, q, now_ms) -> str:
    head = f'<div class="row"><b>{esc(label)}</b>'
    if q is None or q[1] <= now_ms:
        why = '未取得' if q is None else f'リセット予定 {fmt_time(q[1])} を過ぎています'
        return (f'<div class="gauge">{head}<span class="stale">データが古い／未取得（{esc(why)}）</span></div>'
                f'<div class="track" aria-hidden="true"></div></div>')
    p = max(0.0, min(100.0, q[0]))
    cls = 'fill hi' if p >= 80 else 'fill'
    return (f'<div class="gauge">{head}<span>約 {p:.0f}% 使用　リセット {esc(fmt_time(q[1]))}（あと{esc(_remain(q[1] - now_ms))}）</span></div>'
            f'<div class="track" role="progressbar" aria-label="{esc(label)} 使用率" aria-valuemin="0" aria-valuemax="100" '
            f'aria-valuenow="{p:.0f}"><div class="{cls}" style="width:{p:.1f}%"></div></div></div>')


def section_gauges(records, adir, now_ms) -> str:
    q = load_quota(adir)
    parts = ['<section><h2>サブスクの使用状況（目安）</h2>',
             '<p class="cap">Claude の利用枠のうち、いま何%使ったかの目安です。バーが右まで届くと上限です。</p>',
             gauge('7日枠', q['7d'], now_ms)]
    w = q['7d']
    if w and w[1] > now_ms and w[0] >= 1:
        cost = sum(r.cost_total for r in records if w[1] - WEEK_MS <= r.ts <= now_ms)
        if cost > 0:
            parts.append(
                f'<div class="est">【概算】この週の本プロジェクトのAPI換算 {usd(cost)} ≒ 枠の {w[0]:.0f}% '
                f'→ 枠全体で約 {usd(cost / (w[0] / 100))} 相当'
                '<br><span class="note">このプロジェクトのみで算出した概算です。他のプロジェクトの利用は含まれないため、'
                '実際の枠全体はこれより大きい可能性があります。</span></div>')
    parts.append('</section>')
    return ''.join(parts)


# ---------------------------------------------------------------- 各セクション

def cards(items) -> str:
    return '<div class="cards">' + ''.join(
        f'<div class="card"><div class="k">{esc(k)}</div><div class="v">{esc(v)}</div><div class="s">{esc(s)}</div></div>'
        for k, v, s in items) + '</div>'


def _bucket_label(d, weekly):
    return ('週 ' if weekly else '') + d.strftime('%m-%d')


def section_daily(records) -> str:
    days = sorted({report._day(r.ts) for r in records})
    weekly = (days[-1] - days[0]).days + 1 > 14
    agg = collections.defaultdict(lambda: [0.0, 0.0])
    for r in records:
        agg[report._bucket(report._day(r.ts), weekly)][0 if r.kind == 'main' else 1] += r.cost_total
    if weekly:   # 抜けた週も 0 で並べる
        d = min(agg)
        while d <= max(agg):
            agg.setdefault(d, [0.0, 0.0])
            d += datetime.timedelta(days=7)
    buckets = [(_bucket_label(d, weekly), v) for d, v in sorted(agg.items())]
    ser = [('main', 'main'), ('sub', 'sub')]
    return ('<section><h2>① ' + ('週別' if weekly else '日別') + 'のコスト</h2>'
            '<p class="cap">棒の高さがその' + ('週' if weekly else '日') + 'のAPI換算額。青が人が直接使った会話(main)、橙がサブエージェント(sub)です。</p>'
            + legend([('main', 'main'), ('sub', 'sub')])
            + bar_chart(buckets, ser, ('週別' if weekly else '日別') + 'コスト (main/sub 積み上げ)', True) + '</section>')


def section_components(records) -> str:
    comp = collections.defaultdict(float)
    for r in records:
        for key, v in (('input', r.cost_input), ('output', r.cost_output), ('cacheRead', r.cost_read), ('cacheWrite', r.cost_write)):
            comp[(r.kind, key)] += v
    rows = []
    for kind in ('main', 'sub'):
        rows.append((kind, [(k, comp[(kind, k)], lbl) for k, lbl in report.COMPONENTS]))
    tot = {k: sum(v for _, v, _ in segs) for k, segs in rows}
    tr = ['<tr><th></th><th>main</th><th>sub</th></tr>']
    for k, lbl in report.COMPONENTS:
        tr.append(f'<tr><td><i class="sw {k}"></i>{esc(lbl)}</td>'
                  + ''.join(f'<td>{usd(comp[(kd, k)])} ({pct(comp[(kd, k)], tot[kd])})</td>' for kd in ('main', 'sub')) + '</tr>')
    tr.append(f'<tr><td><b>合計</b></td><td><b>{usd(tot["main"])}</b></td><td><b>{usd(tot["sub"])}</b></td></tr>')
    return ('<section><h2>② コストの内訳（種類別）</h2>'
            '<p class="cap">お金が何に使われたかの割合です。各行の長さは $ に比例し、色ごとに入力・出力・キャッシュ読込・書込を表します。</p>'
            + legend([(k, l) for k, l in report.COMPONENTS])
            + hbars(rows, 'main と sub のコスト内訳（入力・出力・キャッシュ読込・キャッシュ書込）')
            + '<table>' + ''.join(tr) + '</table></section>')


def section_1h(E) -> str:
    (bn, bh, bm, bc), (an, ah, am, ac) = E['before'], E['after']
    L, W = 150, 860
    out = []
    for i, (lbl, n, hits) in enumerate((('1hなし(導入前)', bn, bh), ('1hあり(導入後)', an, ah))):
        yy = 10 + i * 46
        rate = len(hits) / n if n else 0
        out.append(text(L - 8, yy + 20, lbl, 'end'))
        out.append(rect(L, yy, W - L - 120, 28, 'f-ref', ''))
        out.append(rect(L, yy, (W - L - 120) * rate, 28, 'f-hit', f'{lbl} ヒット率 {pct(len(hits), n)}'))
        out.append(text(W - 110, yy + 19, f'{pct(len(hits), n)}  (n={n:,})' if n else 'n=0'))
    chart = svg(W, 104, '1hキャッシュ導入前後のヒット率', ''.join(out))
    p = ['<section><h2>③ 1hキャッシュの効果（mainのみ）</h2>',
         '<p class="cap">前の応答から5〜60分あいた後に、キャッシュが効いた割合です。緑が「効いた」割合。導入後に増えていれば効果ありです。</p>',
         legend([('hit', 'ヒット（前回文脈の80%以上を読込）'), ('ref', 'ミス')]), chart]
    if E['cw1h_tokens'] == 0:
        p.append('<p>1hキャッシュへの書込みはまだ記録されていません（効果は未計測）。</p>'
                 f'<p class="note">参考: 導入前のこの時間帯のミスは {len(bm)} 回、書込み代 {usd(bc)}。これが削減できる余地です。</p>')
    else:
        n = E['n_saving']
        warn = f'　【データ不足（n={n}）】' if n < report.MIN_N else f'　（n={n}）'
        cls = 'good' if E['net'] >= 0 else 'bad'
        p.append('<table><tr><th>項目</th><th>金額</th></tr>'
                 f'<tr><td>実現した節約（5分なら書き直していた分）</td><td>{usd(E["savings"])}</td></tr>'
                 f'<tr><td>1hの割増コスト</td><td>{usd(E["premium"])}</td></tr>'
                 f'<tr><td><b>差し引き（純節約）</b></td><td class="big {cls}">{usd(E["net"])}{esc(warn)}</td></tr></table>')
        if n < report.MIN_N:
            p.append(f'<p class="note">データ不足: ヒット件数が {report.MIN_N} 件未満のため参考程度に見てください。</p>')
    if E['est']:
        p.append(f'<p class="note">推定単価を使用: {esc(", ".join(E["est"]))}（実測の標本なし）</p>')
    p.append('</section>')
    return ''.join(p)


def section_sub(S) -> str:
    p = ['<section><h2>④ サブエージェントの節約</h2>']
    if S['n_anth'] == 0 and not S['other']:
        return p[0] + '<p>サブエージェントの発言がありません。</p></section>'
    if not S['has_ref']:
        p.append(f'<p>{esc(report.REF_MODEL)} の単価が記録に無いため計算できません。</p></section>')
        return ''.join(p)
    wk = S['weekly']
    p.append(f'<p class="cap">サブを全部 {esc(report.REF_MODEL)}（Opus）で動かした場合の額（灰）と、実際の額（橙）の比較です。差が大きいほど安いモデルへ振り分けた効果が出ています。</p>')
    p.append(f'<p>節約 <span class="big good">{usd(S["saving"])}</span>（{pct(S["saving"], S["counterfactual"])}減）'
             f'　実際 {usd(S["actual"])} / Opus換算 {usd(S["counterfactual"])}　発言 {S["n_anth"]:,} 件</p>')
    if S['ref_estimated']:
        p.append(f'<p class="note">基準単価に推定値を含む: {esc(", ".join(S["ref_estimated"]))}</p>')
    buckets = [(_bucket_label(d, wk), [a, c]) for d, (a, c, _, _) in sorted(S['by_day'].items())]
    p.append(legend([('sub', '実際'), ('ref', 'Opus換算')]))
    p.append(bar_chart(buckets, [('sub', '実際'), ('ref', 'Opus換算')], ('週別' if wk else '日別') + 'のサブ実際額とOpus換算額', False))
    rows = ''.join(f'<tr><td>{esc(m)}</td><td>{n:,}</td><td>{usd(a)}</td><td>{usd(c)}</td><td>{usd(c - a)}</td></tr>'
                   for m, (a, c, n) in sorted(S['by_model'].items(), key=lambda kv: -kv[1][0]))
    p.append('<table><tr><th>モデル</th><th>発言数</th><th>実際$</th><th>Opus換算$</th><th>節約$</th></tr>' + rows + '</table>')
    if S['other']:
        rows = ''.join(f'<tr><td>{esc(m)}</td><td>{n:,}</td><td>{usd(a)}</td></tr>'
                       for m, (a, n) in sorted(S['other'].items(), key=lambda kv: -kv[1][0]))
        p.append('<p class="note">Anthropic 以外のサブモデル（実際の額のみ・比較対象外）</p>'
                 '<table><tr><th>モデル</th><th>発言数</th><th>実際$</th></tr>' + rows + '</table>')
    p.append('</section>')
    return ''.join(p)


def section_relay(records, relay_log) -> str:
    entries = report.relay_entries(records, relay_log)
    p = ['<section><h2>⑤ context-relay</h2>']
    if not entries:
        return p[0] + '<p>relay の記録はまだありません。</p></section>'
    by = collections.defaultdict(list)
    for o in entries:
        by[str(o.get('trigger') or '?')].append(o)
    rows, trs, bars = [], [], []
    avg = lambda xs: sum(xs) / len(xs) if xs else None
    fmt = lambda v: f'{v:,.0f}' if v is not None else '-'
    for trig in sorted(by, key=lambda k: -len(by[k])):
        es = by[trig]
        ok = [e for e in es if e.get('ok')]
        b = avg([report._num(e.get('tokensBefore')) for e in ok])
        a = avg([report._num(e.get('noteChars')) / 4 for e in ok])
        name = REL_NAMES.get(trig, trig)
        trs.append(f'<tr><td>{esc(name)}</td><td>{len(es)}</td><td>{len(ok)}</td><td>{fmt(b)}</td><td>{fmt(a)}</td></tr>')
        if b is not None:
            bars.append((name, b, a or 0))
    trs.append(f'<tr><td><b>合計</b></td><td>{len(entries)}</td><td>{sum(1 for e in entries if e.get("ok"))}</td><td></td><td></td></tr>')
    p.append('<p class="cap">長くなった会話を短いノートに圧縮して新しい会話へ移した記録です。「前」より「後」が短いほど圧縮できています（成功分の平均トークン）。</p>')
    p.append('<table><tr><th>きっかけ</th><th>回数</th><th>成功</th><th>平均 前</th><th>平均 後(概算)</th></tr>' + ''.join(trs) + '</table>')
    if bars:
        W, L = 860, 90
        vmax = max(b for _, b, _ in bars) or 1
        out = []
        for i, (name, b, a) in enumerate(bars):
            yy = 8 + i * 50
            out.append(text(L - 8, yy + 20, name, 'end'))
            for j, (cls, v, lbl) in enumerate((('main', b, '前'), ('sub', a, '後'))):
                w = v / vmax * (W - L - 130)
                out.append(rect(L, yy + j * 22, w, 18, 'f-' + cls, f'{name} {lbl} {v:,.0f}'))
                out.append(text(L + w + 6, yy + j * 22 + 13, f'{lbl} {v:,.0f}', 'start', 'mut'))
        p.append(legend([('main', '圧縮前'), ('sub', '圧縮後(概算)')]))
        p.append(svg(W, 16 + 50 * len(bars), 'relay の圧縮前後の平均トークン', ''.join(out)))
    p.append('</section>')
    return ''.join(p)


# ---------------------------------------------------------------- ページ

def build_html(records, relay_log=None, now_ms=None, agent_dir=None, project='') -> str:
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    adir = agent_dir or report.agent_dir()
    head = ['<header><h1>pi 利用レポート</h1>', f'<p>プロジェクト: <b>{esc(project or "-")}</b></p>']
    if records:
        days = sorted({report._day(r.ts) for r in records})
        head.append(f'<p>期間: {days[0]} ～ {days[-1]}（稼働 {len(days)} 日）</p>')
    else:
        head.append('<p>期間: -</p>')
    head.append(f'<p>生成: {esc(fmt_time(now_ms))}</p></header>')
    body = [''.join(head)]
    if not records:
        body.append('<section><p>データがありません（assistant の発言が見つかりませんでした）。</p></section>')
        body.append(section_gauges(records, adir, now_ms))
    else:
        P = report.prices(records)
        E = report.one_hour_effect(records, P)
        S = report.sub_savings(records, P)
        total = sum(r.cost_total for r in records)
        by_kind = {k: sum(r.cost_total for r in records if r.kind == k) for k in ('main', 'sub')}
        ndays = len({report._day(r.ts) for r in records})
        if E['cw1h_tokens'] == 0:
            one = ('未計測', '1hへの書込みなし')
        else:
            one = (usd(E['net']), f'n={E["n_saving"]}' + ('（データ不足）' if E['n_saving'] < report.MIN_N else ''))
        sav = (usd(S['saving']), f'{pct(S["saving"], S["counterfactual"])}減（Opus換算比）') if S['has_ref'] and S['n_anth'] else ('-', 'サブ(Anthropic)なし')
        body.append(cards([
            ('合計コスト', usd(total), f'発言 {len(records):,} 件'),
            ('1稼働日あたり', usd(total / ndays), f'稼働 {ndays} 日'),
            ('main / sub', f'{usd(by_kind["main"])} / {usd(by_kind["sub"])}', f'sub {pct(by_kind["sub"], total)}'),
            ('1hキャッシュ純節約', one[0], one[1]),
            ('サブのモデル置き換え節約', sav[0], sav[1]),
        ]))
        body.append(f'<p class="note">{esc(NOTE_COST)}</p>')
        body.append(section_gauges(records, adir, now_ms))
        body += [section_daily(records), section_components(records), section_1h(E), section_sub(S),
                 section_relay(records, relay_log)]
    return ('<!DOCTYPE html>\n<html lang="ja"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>pi 利用レポート - {esc(project or "")}</title><style>{CSS}</style></head>'
            '<body><main>' + '\n'.join(body) + '</main></body></html>\n')


def default_out(session_dir: str) -> str:
    name = os.path.basename(os.path.normpath(os.path.abspath(session_dir))) or 'sessions'
    return os.path.join(report.agent_dir(), 'usage-report', name + '.html')


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description='pi 利用レポートを HTML で出力する')
    ap.add_argument('session_dir', nargs='?', default=report.DEFAULT_DIR)
    ap.add_argument('--out')
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out or default_out(a.session_dir))
    name = os.path.basename(os.path.normpath(os.path.abspath(a.session_dir)))
    doc = build_html(report.parse(a.session_dir), project=name)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write(doc)
    print(out)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
