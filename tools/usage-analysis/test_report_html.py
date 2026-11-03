import contextlib
import io
import json
import os
import re
import unittest

import report
import report_html
from test_report import Base, MIN, T0, asst, ses, tool, user

DAY = 86_400_000


class HtmlBase(Base):
    def setUp(self):
        super().setUp()
        self.adir = os.path.join(self.tmp.name, 'agent')
        os.makedirs(self.adir)

    def dataset(self, sub_model='claude-sonnet-5-5'):
        self.write('main.jsonl', [
            ses('m'), user(T0), asst(T0 + 1000, inp=100, out=100, cr=1000, cw=1000, model='claude-opus-5-5'),
            user(T0 + 10 * MIN), asst(T0 + 10 * MIN + 5000, inp=10, cr=1100, cw=100, model='claude-opus-5-5')])
        self.write('sub.jsonl', [ses('sub', parent='m'), user(T0),
                                 asst(T0 + 1, inp=100, out=100, cr=1000, cw=1000, model=sub_model)])
        self.write('sub2.jsonl', [ses('sub2', parent='m'), user(T0),
                                  asst(T0 + 1, inp=10, out=10, model='gpt-6.1-sol', provider='openai')])

    def relay(self, rows):
        path = os.path.join(self.tmp.name, 'relay.jsonl')
        with open(path, 'w', encoding='utf-8') as f:
            f.write('garbage\n' + '\n'.join(json.dumps(r) for r in rows) + '\n')
        return path

    def html(self, recs=None, **kw):
        kw.setdefault('agent_dir', self.adir)
        kw.setdefault('now_ms', T0 + DAY)
        kw.setdefault('relay_log', os.path.join(self.tmp.name, 'none.jsonl'))
        return report_html.build_html(self.recs() if recs is None else recs, **kw)

    def put(self, name, obj):
        with open(os.path.join(self.adir, name), 'w', encoding='utf-8') as f:
            f.write(obj if isinstance(obj, str) else json.dumps(obj))


class TestSections(HtmlBase):
    def test_sections_and_numbers(self):
        self.dataset()
        log = self.relay([
            {'sessionId': 'm', 'trigger': 'manual', 'tokensBefore': 100_000, 'noteChars': 8000, 'ok': True},
            {'sessionId': 'm', 'trigger': 'expiry', 'tokensBefore': 1, 'noteChars': 0, 'ok': False},
            {'sessionId': 'other', 'trigger': 'input', 'tokensBefore': 5, 'noteChars': 4, 'ok': True}])
        recs = self.recs()
        h = self.html(recs, relay_log=log, project='--proj--')
        for word in ('<title>pi 利用レポート', '--proj--', '合計コスト', '1稼働日あたり', 'main / sub',
                     '1hキャッシュ純節約', 'サブのモデル置き換え節約', '参考値', '日別', 'キャッシュ読込',
                     '未計測', 'Opus換算', 'gpt-6.1-sol', '手動', '期限切れ前', '100,000', '2,000',
                     'prefers-color-scheme:dark', '<svg'):
            self.assertIn(word, h)
        self.assertNotIn('入力時', h)      # 他セッションの relay は除外
        total = sum(r.cost_total for r in recs)
        self.assertIn(report.usd(total), h)
        S = report.sub_savings(recs)
        self.assertIn(report.usd(S['saving']), h)
        self.assertEqual(h.count('<svg'), h.count('</svg>'))
        self.assertNotRegex(h, r'(src|href)=["\']?https?:')
        self.assertNotIn('<script', h)

    def test_one_hour_state(self):
        self.write('a.jsonl', [ses('s'), user(T0), asst(T0 + 1, inp=1, cw=1000, w1h=1000),
                               user(T0 + 10 * MIN), asst(T0 + 10 * MIN + 10, inp=1, cr=1000)])
        h = self.html()
        self.assertIn('データ不足', h)
        self.assertNotIn('未計測', h.split('③')[1].split('④')[0])

    def test_weekly(self):
        self.dataset()
        rs = self.recs()
        rs = rs + [r._replace(ts=r.ts + 20 * DAY) for r in rs]
        self.assertIn('週別', self.html(rs))

    def test_empty(self):
        h = self.html([])
        self.assertIn('データがありません', h)
        self.assertIn('</html>', h)

    def test_escape(self):
        self.dataset(sub_model='<script>alert(1)</script>')
        h = self.html(project='<b>x</b>')
        self.assertNotIn('<script>alert', h)
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', h)
        self.assertNotIn('<b>x</b>', h)


class TestGauges(HtmlBase):
    def test_future_and_stale(self):
        self.dataset()
        now = T0 + DAY
        self.put('usage-bar-cache.json', {'anthropic': [{'category': '5h', 'label': '5h', 'percent': 7, 'resetsAt': now + 3600_000},
                                                         {'category': '7d', 'label': '7d', 'percent': 50, 'resetsAt': now - 1}]})   # 5h は廃止: 無視
        self.put('claude-quota-router.cache.json', {'fetchedAt': now, 'w7d': {'percent': 20, 'resetsAt': now + 2 * DAY}})
        h = self.html(now_ms=now)
        self.assertNotIn('約 7% 使用', h)     # 5h ゲージは出さない
        self.assertNotIn('5時間枠', h)
        self.assertIn('約 20% 使用', h)       # 7d は router を優先 (usage-bar の 7d は期限切れ)
        self.assertNotIn('データが古い／未取得', h)
        self.assertIn('【概算】', h)
        self.assertIn('他のプロジェクトの利用は含まれない', h)
        cost = sum(r.cost_total for r in self.recs() if r.ts >= now + 2 * DAY - 7 * DAY)
        self.assertIn(f'約 {report.usd(cost / 0.2)} 相当', h)

    def test_stale(self):
        self.dataset()
        now = T0 + DAY
        self.put('usage-bar-cache.json', {'anthropic': [{'category': '5h', 'percent': 7, 'resetsAt': now - 1000}]})
        self.put('claude-quota-router.cache.json', {'w7d': {'percent': 20, 'resetsAt': now - 1}})
        h = self.html(now_ms=now)
        self.assertEqual(h.count('データが古い／未取得'), 1)
        self.assertNotIn('使用　', h)
        self.assertNotIn('【概算】', h)

    def test_no_estimate_when_low_or_no_cost(self):
        self.dataset()
        now = T0 + DAY
        self.put('claude-quota-router.cache.json', {'w7d': {'percent': 0.4, 'resetsAt': now + DAY}})
        self.assertNotIn('【概算】', self.html(now_ms=now))
        self.put('claude-quota-router.cache.json', {'w7d': {'percent': 30, 'resetsAt': now + 30 * DAY}})   # 窓に記録なし
        self.assertNotIn('【概算】', self.html(now_ms=now))

    def test_malformed(self):
        self.dataset()
        for a, b in (('{broken', '[1,2'), ('[]', '"x"'), ('{"anthropic":[1,null,{"category":"5h","percent":"x"}]}',
                                                          '{"w7d":{"percent":true,"resetsAt":"y"}}'), ('', '{}')):
            self.put('usage-bar-cache.json', a)
            self.put('claude-quota-router.cache.json', b)
            h = self.html()
            self.assertEqual(h.count('データが古い／未取得'), 1)
        os.remove(os.path.join(self.adir, 'usage-bar-cache.json'))
        self.assertIn('データが古い／未取得', self.html())


class TestCli(HtmlBase):
    def run_main(self, argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = report_html.main(argv)
        return rc, buf.getvalue()

    def test_writes_file_and_prints_path(self):
        self.dataset()
        out = os.path.join(self.tmp.name, 'sub', 'dir', 'r.html')
        rc, o = self.run_main([self.tmp.name, '--out', out])
        self.assertEqual(rc, 0)
        last = o.rstrip('\n').split('\n')[-1]
        self.assertTrue(os.path.isabs(last))
        self.assertEqual(os.path.normcase(last), os.path.normcase(os.path.abspath(out)))
        with open(out, encoding='utf-8') as f:
            self.assertIn('合計コスト', f.read())

    def test_default_out_and_empty(self):
        empty = os.path.join(self.tmp.name, 'sessions-x')
        os.makedirs(empty)
        old = os.environ.get('PI_CODING_AGENT_DIR')
        os.environ['PI_CODING_AGENT_DIR'] = self.adir
        try:
            rc, o = self.run_main([empty])
        finally:
            if old is None:
                del os.environ['PI_CODING_AGENT_DIR']
            else:
                os.environ['PI_CODING_AGENT_DIR'] = old
        self.assertEqual(rc, 0)
        last = o.rstrip('\n').split('\n')[-1]
        self.assertEqual(os.path.normcase(last), os.path.normcase(os.path.join(self.adir, 'usage-report', 'sessions-x.html')))
        with open(last, encoding='utf-8') as f:
            self.assertIn('データがありません', f.read())


if __name__ == '__main__':
    unittest.main()
