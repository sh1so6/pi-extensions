import datetime
import json
import os
import tempfile
import unittest

import report

MIN = 60_000
T0 = 1_700_000_000_000
IN, OUT, RD, W5, W1 = 4e-6, 20e-6, 2e-7, 5e-6, 8e-6   # $/token (read = 0.05x input like real data)


def ses(sid, parent=None):
    o = {'type': 'session', 'id': sid, 'timestamp': '2026-10-31T00:00:00Z'}
    if parent:
        o['parentSession'] = parent
    return o


def user(ts):
    return {'type': 'message', 'message': {'role': 'user', 'timestamp': ts}}


def tool(ts):
    return {'type': 'message', 'message': {'role': 'toolResult', 'timestamp': ts}}


def asst(ts, inp=0, out=0, cr=0, cw=0, w1h=None, model='m1', provider='anthropic'):
    u = {'input': inp, 'output': out, 'cacheRead': cr, 'cacheWrite': cw}
    cw5 = cw - (w1h or 0)
    if w1h is not None:
        u['cacheWrite1h'] = w1h
    c = {'input': inp * IN, 'output': out * OUT, 'cacheRead': cr * RD, 'cacheWrite': cw5 * W5 + (w1h or 0) * W1}
    c['total'] = sum(c.values())
    u['cost'] = c
    return {'type': 'message', 'message': {'role': 'assistant', 'timestamp': ts, 'model': model,
                                           'provider': provider, 'usage': u}}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, name, objs):
        with open(os.path.join(self.tmp.name, name), 'w', encoding='utf-8') as f:
            f.write('{broken json\n')   # 壊れた行は無視される
            for o in objs:
                f.write(json.dumps(o) + '\n')

    def recs(self):
        return report.parse(self.tmp.name)


class TestParse(Base):
    def test_kind_and_gap(self):
        self.write('a.jsonl', [ses('main1'), user(T0), asst(T0 + 1000, inp=4, cw=1000),
                               user(T0 + 10 * MIN), asst(T0 + 10 * MIN + 5000, inp=4, cr=1000)])
        self.write('b.jsonl', [ses('sub1', parent='x'), user(T0), asst(T0 + 1000, inp=4, cw=100)])
        rs = self.recs()
        kinds = {r.sid: r.kind for r in rs}
        self.assertEqual(kinds, {'main1': 'main', 'sub1': 'sub'})
        m = [r for r in rs if r.sid == 'main1']
        self.assertIsNone(m[0].gap)
        # トリガー時刻(10分後) − 前 assistant(1秒後) = 599 秒。生成時間(+5s)は含まない
        self.assertAlmostEqual(m[1].gap, 10 * 60 - 1)
        self.assertEqual(m[1].prev_ctx, 1004)

    def test_toolresult_trigger(self):
        self.write('a.jsonl', [ses('s'), user(T0), asst(T0, inp=1, cw=1000),
                               tool(T0 + 6 * MIN), asst(T0 + 6 * MIN + 20_000, inp=1, cr=1000)])
        r = self.recs()[1]
        self.assertAlmostEqual(r.gap, 6 * 60)


class TestPrices(Base):
    def test_mixed_and_pure(self):
        self.write('a.jsonl', [
            ses('s'), user(T0),
            asst(T0 + 1, inp=4, out=10, cr=2000, cw=500),                 # 5m のみ
            asst(T0 + 2, inp=4, out=10, cr=2000, cw=1000, w1h=400),       # 混在: 600 が 5m, 400 が 1h
            asst(T0 + 3, inp=4, out=10, cr=2000, cw=300, w1h=300),        # 純 1h
        ])
        p = report.prices(self.recs())['m1']
        self.assertAlmostEqual(p['input'], IN)
        self.assertAlmostEqual(p['output'], OUT)
        self.assertAlmostEqual(p['read'], RD)
        self.assertAlmostEqual(p['w5m'], W5)       # 混在メッセージは 5m 標本に入らない
        self.assertAlmostEqual(p['w1h'], W1)
        self.assertEqual(p['estimated'], set())

    def test_fallback_estimated(self):
        self.write('a.jsonl', [ses('s'), user(T0), asst(T0 + 1, inp=10, out=10, cr=0, cw=0)])
        p = report.prices(self.recs())['m1']
        self.assertAlmostEqual(p['read'], 0.1 * IN)
        self.assertAlmostEqual(p['w5m'], 1.25 * IN)
        self.assertAlmostEqual(p['w1h'], 2 * IN)
        self.assertEqual(p['estimated'], {'read', 'w5m', 'w1h'})


class TestOneHour(Base):
    def build(self):
        # session s1: 1h 導入前 (2 gap: ヒット1, ミス1)、途中で初の 1h 書込み、その後 (ヒット1, ミス1)
        o = [ses('s1'), user(T0), asst(T0 + 1000, inp=4, cw=10_000)]
        t = T0 + 1000
        # 導入前 gap 10 分: ミス (cacheRead 0, 全書き直し)
        o += [user(t + 10 * MIN), asst(t + 10 * MIN + 1000, inp=4, cw=10_000)]
        t += 10 * MIN + 1000
        # 導入前 gap 10 分: ヒット
        o += [tool(t + 10 * MIN), asst(t + 10 * MIN + 1000, inp=4, cr=10_000, cw=500)]
        t += 10 * MIN + 1000
        # 初の 1h 書込み (gap 1 分, 5-60m 対象外)
        o += [user(t + MIN), asst(t + MIN + 1000, inp=4, cr=10_500, cw=2000, w1h=2000)]
        t += MIN + 1000
        # 導入後 gap 20 分: ヒット (cacheRead 12_500 ≥ 0.8*12_504)
        o += [user(t + 20 * MIN), asst(t + 20 * MIN + 1000, inp=4, cr=12_500, cw=100, w1h=100)]
        t += 20 * MIN + 1000
        # 導入後 gap 30 分: ミス
        o += [user(t + 30 * MIN), asst(t + 30 * MIN + 1000, inp=4, cr=0, cw=12_604, w1h=12_604)]
        t += 30 * MIN + 1000
        # 導入後 gap 90 分 (対象外)
        o += [user(t + 90 * MIN), asst(t + 90 * MIN + 1000, inp=4, cw=12_608, w1h=12_608)]
        self.write('main.jsonl', [ses('s1')] + o[1:])
        # sub は集計対象外
        self.write('sub.jsonl', [ses('sub', parent='s1'), user(T0), asst(T0 + 1, inp=4, cw=999, w1h=999),
                                 user(T0 + 10 * MIN), asst(T0 + 10 * MIN + 1, inp=4, cr=0, cw=999, w1h=999)])

    def test_before_after(self):
        self.build()
        rs = self.recs()
        main = [r for r in rs if r.sid == 's1']
        # 1 つ目の 1h 書込みより前は h1_active=False、それ以降 True (途中から始まる)
        self.assertEqual([r.h1_active for r in main], [False, False, False, False, True, True, True])
        E = report.one_hour_effect(rs)
        bn, bh, bm, bc = E['before']
        an, ah, am, ac = E['after']
        self.assertEqual((bn, len(bh), len(bm)), (2, 1, 1))
        self.assertAlmostEqual(bc, 10_000 * W5)
        self.assertEqual((an, len(ah), len(am)), (2, 1, 1))
        self.assertAlmostEqual(ac, 12_604 * W1)
        # 節約 = ヒットの cacheRead × (w5m − read)
        self.assertAlmostEqual(E['savings'], 12_500 * (W5 - RD))
        # 割増 = main の全 cw1h × (w1h − w5m)  (sub は含まない)
        self.assertAlmostEqual(E['premium'], (2000 + 100 + 12_604 + 12_608) * (W1 - W5))
        self.assertEqual(E['n_saving'], 1)

    def test_report_text(self):
        self.build()
        text = report.build_report(self.recs())
        self.assertIn('データ不足（n=1）', text)
        self.assertIn('■ 内訳', text)
        self.assertIn('■ 1hキャッシュの効果', text)
        self.assertNotIn("('", text)

    def test_breakdown_totals(self):
        self.build()
        rs = self.recs()
        txt = report.section_breakdown(rs)
        main_total = sum(r.cost_total for r in rs if r.kind == 'main')
        sub_total = sum(r.cost_total for r in rs if r.kind == 'sub')
        self.assertIn(report.usd(main_total), txt)
        self.assertIn(report.usd(sub_total), txt)
        self.assertIn(report.usd(main_total + sub_total), txt)

    def test_no_1h(self):
        self.write('a.jsonl', [ses('s'), user(T0), asst(T0 + 1, inp=4, cw=1000),
                               user(T0 + 10 * MIN), asst(T0 + 10 * MIN + 1, inp=4, cw=1004)])
        text = report.build_report(self.recs())
        self.assertIn('まだ記録されていません', text)


def custom_msg(iso_ts):
    """message.timestamp を持たない custom_message (エントリ側 ISO 時刻のみ)。"""
    return {'type': 'custom_message', 'timestamp': iso_ts, 'customType': 'x', 'content': 'task done'}


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


class TestGapEntries(Base):
    def test_custom_message_trigger_and_assistant_end(self):
        # assistant: message.timestamp=リクエスト開始、エントリ ISO=応答終了(+40秒)。
        a1 = asst(T0, inp=1, cw=1000)
        a1['timestamp'] = iso(T0 + 40_000)
        a2 = asst(T0 + 30 * MIN, inp=1, cr=1000)
        self.write('a.jsonl', [ses('s'), user(T0 - 1000), a1,
                               {'type': 'custom', 'timestamp': iso(T0 + 41_000)},
                               custom_msg(iso(T0 + 30 * MIN - 5)), a2])
        r = self.recs()[1]
        # 起動 = custom_message の ISO (T0+30分−5ms)、前の終了 = T0+40秒。生成時間は含まれない
        self.assertAlmostEqual(r.gap, 30 * 60 - 40 - 0.005, places=2)
        self.assertGreaterEqual(r.gap, report.GAP_MIN)

    def test_stale_user_does_not_win(self):
        # 直前 assistant より前の user ではなく、後の custom_message が起動
        a1 = asst(T0 + 10 * MIN, inp=1, cw=1000)
        self.write('a.jsonl', [ses('s'), user(T0), a1, custom_msg(iso(T0 + 25 * MIN)),
                               asst(T0 + 25 * MIN + 10, inp=1, cr=900)])
        self.assertAlmostEqual(self.recs()[1].gap, 15 * 60)


class TestSubSavings(Base):
    def build(self):
        self.write('main.jsonl', [ses('m'), user(T0), asst(T0 + 1, inp=100, out=100, cr=1000, cw=1000, model='claude-opus-5-5')])
        self.write('sub.jsonl', [ses('sub', parent='m'), user(T0),
                                 asst(T0 + 1, inp=100, out=100, cr=1000, cw=1000, model='claude-sonnet-5-5')])
        self.write('sub2.jsonl', [ses('sub2', parent='m'), user(T0),
                                  asst(T0 + 1, inp=10, out=10, cr=0, cw=0, model='gpt-6.1-sol', provider='openai')])

    def cheap_sonnet(self):
        # sonnet の実コストを opus の 0.2 倍にする (同じトークン数)
        f = 0.2
        return [r._replace(cost_input=r.cost_input * f, cost_output=r.cost_output * f, cost_read=r.cost_read * f,
                           cost_write=r.cost_write * f, cost_total=r.cost_total * f)
                if r.model == 'claude-sonnet-5-5' else r for r in self.recs()]

    def test_numbers(self):
        self.build()
        rs = self.cheap_sonnet()
        S = report.sub_savings(rs)
        opus_cost = [r.cost_total for r in rs if r.model == 'claude-opus-5-5'][0]
        self.assertAlmostEqual(S['counterfactual'], opus_cost)
        self.assertAlmostEqual(S['actual'], opus_cost * 0.2)
        self.assertAlmostEqual(S['saving'], opus_cost * 0.8)
        self.assertIn('gpt-6.1-sol', S['other'])
        self.assertNotIn('gpt-6.1-sol', S['by_model'])
        self.assertAlmostEqual(S['cache']['main'], 1000 * (IN - RD))
        txt = report.section_sub_savings(rs)
        for word in ('比較対象外', '参考値', '日別'):
            self.assertIn(word, txt)

    def test_weekly_when_long(self):
        self.build()
        rs = self.recs()
        rs = rs + [r._replace(ts=r.ts + 20 * 86_400_000) for r in rs if r.kind == 'sub']
        self.assertTrue(report.sub_savings(rs)['weekly'])
        self.assertIn('週別', report.section_sub_savings(rs))


class TestRelay(Base):
    def test_missing(self):
        self.write('a.jsonl', [ses('s1'), user(T0), asst(T0 + 1, inp=1, cw=10)])
        txt = report.section_relay(self.recs(), os.path.join(self.tmp.name, 'nope.jsonl'))
        self.assertIn('relay の記録はまだありません', txt)

    def test_counts(self):
        self.write('a.jsonl', [ses('s1'), user(T0), asst(T0 + 1, inp=1, cw=10)])
        log = os.path.join(self.tmp.name, 'log.jsonl')
        rows = [
            {'at': 1, 'sessionId': 's1', 'trigger': 'manual', 'tokensBefore': 100_000, 'noteChars': 8000, 'ok': True},
            {'at': 2, 'sessionId': 's1', 'trigger': 'input', 'tokensBefore': 200_000, 'noteChars': 4000, 'ok': True},
            {'at': 3, 'sessionId': 's1', 'trigger': 'input', 'tokensBefore': 1, 'noteChars': 0, 'ok': False, 'error': 'e'},
            {'at': 4, 'sessionId': 'other', 'trigger': 'expiry', 'tokensBefore': 5, 'noteChars': 4, 'ok': True},
        ]
        with open(log, 'w', encoding='utf-8') as f:
            f.write('garbage\n' + '\n'.join(json.dumps(r) for r in rows) + '\n')
        txt = report.section_relay(self.recs(), log)
        self.assertIn('入力時', txt)
        self.assertNotIn('期限切れ前', txt)      # 他ディレクトリのセッションは除外
        self.assertIn('200,000', txt)            # input の ok 平均 (失敗は除く)
        self.assertIn('1,000', txt)              # 4000/4
        self.assertIn('2,000', txt)              # manual 8000/4


if __name__ == '__main__':
    unittest.main()
