import assert from "node:assert/strict";
const R = await import("./claude-quota-router.ts");
const { normalizeConfig, parseUsage, decideMode, computeBlockUntil, UsageCache, effectivePercent, DEFAULT_CONFIG } = R;
const cfg = normalizeConfig({});
const T = Date.parse("2026-01-10T00:00:00Z");
const fake = (p5, p7, r5 = "2026-01-10T03:00:00Z", r7 = "2026-01-15T00:00:00Z") => ({ limits: [
  { kind: "session", percent: p5, resets_at: r5, scope: null },
  { kind: "weekly_all", percent: p7, resets_at: r7, scope: null },
  { kind: "weekly_model", percent: 99, resets_at: r7, scope: { model: { display_name: "Opus" } } } ] });
// parse
let u = parseUsage(fake(12, 41), T);
assert.equal(u.w5h.percent, 12); assert.equal(u.w7d.percent, 41); assert.equal(u.w7d.resetsAt, Date.parse("2026-01-15T00:00:00Z"));
assert.equal(parseUsage({}, T), null); assert.equal(parseUsage({limits:[{kind:"x",percent:1}]}, T), null);
// config
assert.deepEqual({...cfg}, {...DEFAULT_CONFIG});
const c5 = normalizeConfig({ threshold5h: 90 }); assert.equal(c5.resume5h, 85);
assert.equal(normalizeConfig({ threshold7d: 80, resume7d: 90 }).resume7d, 80);
assert.equal(normalizeConfig("garbage").threshold7d, 95);
// sub -> api at >=95 (boundary)
const d = (cur, p5, p7, o = {}) => decideMode({ current: cur, usage: parseUsage(fake(p5, p7, o.r5, o.r7), T), now: o.now ?? T, cfg: o.cfg ?? cfg, pin: o.pin ?? null, blockUntil: o.block ?? 0 });
assert.equal(d("sub", 10, 94.9).mode, "sub");
let r = d("sub", 10, 95); assert.equal(r.mode, "api"); assert.ok(r.changed); assert.match(r.reason, /7d 95% >= 95%/);
// 5h off by default
assert.equal(d("sub", 100, 10).mode, "sub");
// 5h on
const cfg5 = normalizeConfig({ threshold5h: 90 });
assert.equal(d("sub", 90, 10, { cfg: cfg5 }).mode, "api");
assert.equal(d("api", 88, 10, { cfg: cfg5 }).mode, "api"); // 88 >= resume 85 -> stay
assert.equal(d("api", 84, 10, { cfg: cfg5 }).mode, "sub");
// hysteresis: api stays between 90..95, returns <90
assert.equal(d("api", 0, 93).mode, "api"); assert.equal(d("api", 0, 93).changed, false);
assert.equal(d("api", 0, 90).mode, "api");
r = d("api", 0, 89.9); assert.equal(r.mode, "sub"); assert.ok(r.changed);
// resetsAt passed -> back to sub even if stale percent 99
const after = Date.parse("2026-01-15T00:00:01Z");
r = d("api", 0, 99, { now: after }); assert.equal(r.mode, "sub"); assert.match(r.reason, /reset passed/);
// ... and sub with stale 99% but reset passed does not flip to api
assert.equal(d("sub", 0, 99, { now: after }).mode, "sub");
// pin
assert.equal(d("sub", 0, 99, { pin: "sub" }).mode, "sub");
assert.equal(d("sub", 0, 99, { pin: "sub" }).changed, false);
r = d("sub", 0, 0, { pin: "api" }); assert.equal(r.mode, "api"); assert.ok(r.changed);
assert.equal(d("api", 0, 0, { pin: "sub" }).mode, "sub");
// blockUntil holds api
assert.equal(d("api", 0, 10, { block: T + 1000 }).mode, "api");
assert.equal(d("api", 0, 10, { block: T - 1 }).mode, "sub");
// no usage data: sub stays sub, api stays api (fail-open / keep)
const nd = (cur) => decideMode({ current: cur, usage: null, now: T, cfg, pin: null, blockUntil: 0 });
assert.equal(nd("sub").mode, "sub"); assert.equal(nd("api").mode, "api");
// computeBlockUntil
assert.equal(computeBlockUntil(parseUsage(fake(100, 10), T), T, 300), Date.parse("2026-01-10T03:00:00Z"));
assert.equal(computeBlockUntil(parseUsage(fake(50, 10), T), T, 300), T + 300000);
assert.equal(computeBlockUntil(null, T, 300), T + 300000);
// cache: TTL, dedupe, SWR, fail-open
let now = 1_000_000, calls = 0, mode = "ok", resolveSlow;
const cache = new UsageCache(async () => { calls++; if (mode === "fail") throw new Error("boom"); if (mode === "slow") await new Promise(r => resolveSlow = r); return parseUsage(fake(1, 2), now); }, () => 90_000, () => now);
assert.equal(cache.peek(), null); // kicks fetch, returns immediately
await cache.inflight; assert.equal(calls, 1); assert.equal(cache.data.w7d.percent, 2);
cache.peek(); assert.equal(calls, 1); // fresh
now += 89_000; cache.peek(); assert.equal(calls, 1);
now += 2_000; mode = "fail"; const stale = cache.peek(); assert.equal(stale.w7d.percent, 2); // stale returned immediately
await cache.inflight; assert.equal(calls, 2); assert.equal(cache.lastError, "boom"); assert.equal(cache.data.w7d.percent, 2); // kept
cache.peek(); assert.equal(calls, 2); // attempt time counts: no hammering on failure
now += 91_000; mode = "slow"; cache.peek(); cache.peek(); cache.refresh(); assert.equal(calls, 3); // dedupe
resolveSlow?.(); await new Promise(r=>setTimeout(r,5));
// SWR doesn't block: peek latency while fetch is stuck
mode = "slow"; now += 91_000; const t0 = performance.now(); cache.peek(); const dt = performance.now()-t0; assert.ok(dt < 5, `peek ${dt}`);
// retry-after: 429 from usage endpoint suspends polling
{ let n=0, nw=1e6; const c2=new UsageCache(async()=>{n++; throw Object.assign(new Error("usage HTTP 429"),{retryAfterMs:200_000});},()=>90_000,()=>nw);
  c2.peek(); await c2.inflight; assert.equal(n,1); nw+=100_000; c2.peek(); assert.equal(n,1,"still backing off"); nw+=101_000; c2.peek(); await c2.inflight; assert.equal(n,2); }
console.log("ALL OK; peek while revalidating:", dt.toFixed(3), "ms");
