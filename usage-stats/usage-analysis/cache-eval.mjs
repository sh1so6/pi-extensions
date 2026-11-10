#!/usr/bin/env node
/**
 * cache-eval.mjs: キャッシュ運用 (1h TTL / ウォーマー / relay) の損得を過去ログから再計算する。
 * 手順と判断基準は EVALUATE.md。node だけで動く (依存なし)。
 *
 *   node cache-eval.mjs [--since 2026-11-18] [--root ~/.pi/agent/sessions]
 *
 * 出力 (入力側コストのみ。出力トークンは除外):
 *   1. シナリオ比較: actual / 5m(ウォーマー無し) / 5m+idle warm / 1h を main・sub 別に
 *   2. prefix 帯別の 1 ターン単価と、帯ごとのコスト占有率 (main のみ)
 *   3. relay / 標準 compaction 前後の prefix (S = リセット後の prefix の実測) と損益分岐ターン数
 * 倍率: 5m 書込み 1.25 / 1h 書込み 2 / 読込み 0.1 (単価はログの cacheRead 単価 ×10 を基準に逆算)。
 * 反事実の計算なので、モデルの再現値は実際の合計と 2 割ほどずれる (ログ側に既知のずれあり)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const root = opt("--root", path.join(os.homedir(), ".pi", "agent", "sessions"));
const since = opt("--since") ? Date.parse(opt("--since")) : 0;
const MIN = 60000;

const files = [];
for (const d of fs.readdirSync(root)) {
  const p = path.join(root, d);
  if (!fs.statSync(p).isDirectory()) continue;
  for (const f of fs.readdirSync(p)) if (f.endsWith(".jsonl")) files.push(path.join(p, f));
}

const price = {}; // model -> base $/token (= cacheRead rate * 10)
const sessions = [];
for (const f of files) {
  const ev = []; let name = "";
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(e.timestamp);
    if (e.type === "session_info") { name = e.name || name; continue; }
    if (since && ts < since) continue;
    if (e.type === "message" && e.message?.role === "assistant" && e.message.usage && e.message.provider === "anthropic") {
      const u = e.message.usage;
      if (u.cacheRead > 0 && u.cost.cacheRead > 0) price[e.message.model] = (u.cost.cacheRead / u.cacheRead) * 10;
      ev.push({ k: "a", m: e.message.model, start: e.message.timestamp, end: ts, P: u.input + u.cacheRead + u.cacheWrite, cost: u.cost, cacheRead: u.cacheRead });
    } else if (e.type === "usage" && e.kind === "cache_warm" && e.provider === "anthropic") {
      ev.push({ k: "w", m: e.model, end: ts, cost: e.usage.cost.total });
    } else if (e.type === "compaction") {
      ev.push({ k: "c", end: ts, relay: String(e.summary || "").startsWith("# Context hand-off") });
    }
  }
  if (ev.some((x) => x.k === "a")) sessions.push({ f, sub: /#[0-9a-f]{8}$/.test(name), ev });
}

// ---- 1. scenarios -------------------------------------------------------------------------------
function sim(s, sc) {
  let tot = 0, pings = 0, misses = 0, reqs = 0, prev = null, lastEnd = null, lastWarm = null;
  const w = sc === "1h" ? 2 : 1.25;
  let pingCost = 0;
  for (const x of s.ev) {
    if (x.k === "w") { lastWarm = x.end; continue; }
    if (x.k !== "a") continue;
    const p = price[x.m]; if (!p) continue;
    reqs++;
    if (!prev || x.P < prev.P * 0.9) { tot += w * x.P * p; misses++; }
    else {
      const gap = x.start - lastEnd;
      const gapAny = x.start - Math.max(lastEnd, lastWarm ?? 0);
      const hit = sc === "actual" ? gapAny <= 5 * MIN : sc === "5m" ? gap <= 5 * MIN : sc === "5m+warm" ? gap <= 35 * MIN : gap <= 60 * MIN;
      if (hit) {
        tot += (0.1 * prev.P + w * Math.max(0, x.P - prev.P)) * p;
        if (sc === "5m+warm") { const n = Math.floor(Math.min(Math.max(gap, 0) / MIN, 30) / 4.5); pings += n; pingCost += n * 0.1 * prev.P * p; }
      } else { tot += w * x.P * p; misses++; }
    }
    prev = x; lastEnd = x.end;
  }
  const warmActual = sc === "actual" ? s.ev.filter((x) => x.k === "w").reduce((a, x) => a + x.cost, 0) : 0;
  return { cost: tot + pingCost + warmActual, pings, misses, reqs };
}
console.log(`# cache-eval (${sessions.length} sessions, since ${since ? new Date(since).toISOString().slice(0, 10) : "all"})\n`);
console.log("## 1. シナリオ比較 (入力側 $, 反事実)");
for (const grp of ["main", "sub"]) {
  const ss = sessions.filter((s) => (grp === "sub") === s.sub);
  console.log(`${grp} (${ss.length} sessions)`);
  for (const sc of ["actual", "5m", "5m+warm", "1h"]) {
    let c = 0, pg = 0, ms = 0, rq = 0;
    for (const s of ss) { const r = sim(s, sc); c += r.cost; pg += r.pings; ms += r.misses; rq += r.reqs; }
    console.log(`  ${sc.padEnd(8)} $${c.toFixed(0).padStart(6)}  miss ${ms}/${rq}  pings ${pg}`);
  }
}

// ---- 2. prefix buckets (main) -------------------------------------------------------------------
const edges = [0, 50e3, 100e3, 150e3, 200e3, 300e3, 1e9];
const names = ["<50k", "50-100k", "100-150k", "150-200k", "200-300k", "300k+"];
const B = names.map(() => ({ n: 0, read: 0, write: 0, miss: 0, all: 0 }));
let tot = 0;
for (const s of sessions.filter((x) => !x.sub)) {
  for (const x of s.ev) {
    if (x.k !== "a") continue;
    const i = edges.findIndex((e, k) => x.P >= e && x.P < edges[k + 1]);
    const b = B[i]; b.n++; b.read += x.cost.cacheRead; b.write += x.cost.cacheWrite;
    b.all += x.cost.cacheRead + x.cost.cacheWrite + x.cost.input; if (x.cacheRead < 0.5 * x.P) b.miss++;
    tot += x.cost.cacheRead + x.cost.cacheWrite + x.cost.input;
  }
}
console.log("\n## 2. prefix 帯別 (main): turns / $read per turn / $write per turn / miss% / コスト占有率");
B.forEach((b, i) => console.log(`  ${names[i].padEnd(9)} ${String(b.n).padStart(6)}  ${(b.read / (b.n || 1)).toFixed(3)}  ${(b.write / (b.n || 1)).toFixed(3)}  ${((100 * b.miss) / (b.n || 1)).toFixed(0).padStart(3)}%  ${((100 * b.all) / (tot || 1)).toFixed(1)}%`));

// ---- 3. relay / compaction seed -----------------------------------------------------------------
const q = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN);
console.log("\n## 3. compaction 前後の prefix (main) — S = 直後の最初の assistant の prefix");
for (const kind of ["relay", "標準"]) {
  const pre = [], post = [];
  for (const s of sessions.filter((x) => !x.sub)) {
    let lastP = null, pending = null;
    for (const x of s.ev) {
      if (x.k === "a") { if (pending) { pre.push(pending.pre); post.push(x.P); pending = null; } lastP = x.P; }
      else if (x.k === "c" && x.relay === (kind === "relay") && lastP != null) pending = { pre: lastP };
    }
  }
  const f = (a) => `p25 ${(q(a, 0.25) / 1e3).toFixed(0)}k / 中央 ${(q(a, 0.5) / 1e3).toFixed(0)}k / p75 ${(q(a, 0.75) / 1e3).toFixed(0)}k`;
  console.log(`  ${kind} n=${pre.length}  前 P: ${f(pre)}  後 S: ${f(post)}`);
  if (post.length) {
    const P = q(pre, 0.5), S = q(post, 0.5);
    console.log(`     分岐ターン数 = 20S/(P-S) = ${P > S ? ((20 * S) / (P - S)).toFixed(1) : "n/a"} (中央値の P,S で)`);
  }
}

// 参考: 新規セッションの最初のターンの prefix (= system prompt + tools + AGENTS.md の固定分。S の下限の目安)
const first = [];
for (const s of sessions.filter((x) => !x.sub)) { const a = s.ev.find((x) => x.k === "a"); if (a) first.push(a.P); }
console.log(`\n参考: main 新規セッション初回の prefix  p25 ${(q(first, 0.25) / 1e3).toFixed(0)}k / 中央 ${(q(first, 0.5) / 1e3).toFixed(0)}k / p75 ${(q(first, 0.75) / 1e3).toFixed(0)}k (n=${first.length})`);
