/**
 * claude-quota-router: Claude サブスク(anthropic/OAuth)の使用率を見て、足りなくなったら
 * API キー課金(anthro-api, 同じモデルID)へ自動で切り替える。サブスク優先。
 * Install: pi install npm:@sh1so6/pi-claude-quota-router (or copy to ~/.pi/agent/extensions/<name>.ts and run /reload).
 *
 * ── 方式 ───────────────────────────────────────────────────────────────
 * ModelRuntime(= ctx.modelRegistry.runtime。メイン/pi-subagents の子セッション/Workflow/
 * advisor の streamSimple が全て共有する)の `getAuth` を薄いラッパで包み、
 *   provider === "anthropic" かつ mode === "api" のとき、同じモデルのまま
 *   anthro-api の API キーで認証を解決する。
 * pi-ai は apiKey が sk-ant-oat で始まる時だけ OAuth 経路(Bearer / Claude Code 偽装 system /
 * tool名変換 / oauth beta)を取るので、API キーに差し替えれば自動で通常の x-api-key 経路になる。
 * モデルID・メッセージ上の provider は "anthropic" のまま変わらない(setModel しない)ので、
 * セッション履歴・設定・advisor.json・settings.json には一切触れない。
 * (before_provider_headers はモデル情報も apiKey も持たず、advisor の streamSimple では
 *  発火すらしないため、この用途には使えない。)
 *
 * ── 判定 ───────────────────────────────────────────────────────────────
 *  sub → api : 7d 使用率 >= threshold7d(95)  /  (設定時) 5h 使用率 >= threshold5h
 *              /  anthropic の 429(クォータ枯渇) を検知
 *  api → sub : 7d < resume7d(90) または 7d の resetsAt 経過(5h も設定時は同様) かつ 429 クールダウン明け
 *  使用率は GET https://api.anthropic.com/api/oauth/usage(OAuth token は pi のモデルレジストリ経由)。
 *  TTL キャッシュ + stale-while-revalidate(リクエストをブロックしない)。取得失敗は現状維持(fail-open)。
 *
 * ── コマンド ───────────────────────────────────────────────────────────
 *  /claude-router [status|auto|sub|api|refresh]
 *    status  : mode / 5h% / 7d% / resetsAt / 切替理由 / pin の有無 / ルーティング統計
 *    auto    : pin 解除(自動切替)      sub|api : 手動 pin(pin 中は自動切替しない)
 *    refresh : 使用率を即再取得
 *  pin はプロセス内のみ(再起動で解除)。環境変数 CLAUDE_ROUTER_FORCE=sub|api で起動時 pin。
 *
 * ── 設定 ~/.pi/agent/claude-quota-router.json(session_start ごとに読み直し。全項目任意) ──
 *  { "enabled": true,
 *    "threshold7d": 95, "resume7d": 90,
 *    "threshold5h": null, "resume5h": null,      // null=5h は見ない。resume5h 未指定は threshold5h-5
 *    "cacheTtlSec": 90, "fetchTimeoutMs": 3000,
 *    "limitCooldownSec": 300,                    // クォータ枯渇検知後、満杯の枠が無い場合の api 維持時間
 *    "firstFetchWaitMs": 1500,                   // 起動後の最初の1回だけ、使用率が未取得なら最大これだけ待つ(0=待たない)
 *    "staleMaxSec": 1800,                        // 起動時に前回プロセスのキャッシュ(claude-quota-router.cache.json)を採用する最大経過秒
 *    "dropThinkingOnSwitch": true,               // 切替前に作られた anthropic の thinking ブロックを以後のリクエストから外す(署名400対策)
 *    "sourceProvider": "anthropic", "apiProvider": "anthro-api",
 *    "notify": true,                             // 切替時に UI 通知
 *    "debug": false, "logFile": null }           // debug=true で ~/.pi/agent/claude-quota-router.log に追記(キーは出さない)
 *
 * ── 既知の制約 ─────────────────────────────────────────────────────────
 *  - クォータ枯渇の即時検知: ①429(after_provider_response, サブスク経路のみ) ②アシスタントメッセージが
 *    "Third-party apps now draw from your extra usage, not your plan limits" 等で終わった場合(message_end。
 *    実際に枠が尽きたアカウントでは 429 ではなくこの 400 が返る)。検知したその 1 リクエストは失敗する(次から api)。
 *  - 429 即時検知は after_provider_response(エージェントループ)経由。advisor の streamSimple は
 *    このフックが発火しないので、advisor 単独の 429 は次回の使用率再取得(<=TTL)で拾う。
 *  - 拡張を削除して /reload してもラッパはプロセス内に残る(pass-through になるだけ)。完全除去は再起動。
 *  - 履歴上の provider は常に "anthropic"。API 課金分のコスト表示は anthropic モデルの単価に従う。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ───────────────────────────── 純ロジック(単体テスト対象) ─────────────────────────────

export type Mode = "sub" | "api";
export interface Window {
  percent: number;
  resetsAt: number; // epoch ms
}
export interface Usage {
  w5h?: Window;
  w7d?: Window;
  fetchedAt: number;
}
export interface Config {
  enabled: boolean;
  threshold7d: number;
  resume7d: number;
  threshold5h: number | null;
  resume5h: number | null;
  cacheTtlSec: number;
  fetchTimeoutMs: number;
  limitCooldownSec: number;
  firstFetchWaitMs: number;
  staleMaxSec: number;
  dropThinkingOnSwitch: boolean;
  sourceProvider: string;
  apiProvider: string;
  notify: boolean;
  debug: boolean;
  logFile: string | null;
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  threshold7d: 95,
  resume7d: 90,
  threshold5h: null,
  resume5h: null,
  cacheTtlSec: 90,
  fetchTimeoutMs: 3000,
  limitCooldownSec: 300,
  firstFetchWaitMs: 1500,
  staleMaxSec: 1800,
  dropThinkingOnSwitch: true,
  sourceProvider: "anthropic",
  apiProvider: "anthro-api",
  notify: true,
  debug: false,
  logFile: null,
};

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown, d: number | null): number | null =>
  v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : d;
const str = (v: unknown, d: string): string => (typeof v === "string" && v.trim() ? v.trim() : d);

export function normalizeConfig(raw: unknown): Config {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c: Config = {
    enabled: r.enabled !== false,
    threshold7d: num(r.threshold7d, DEFAULT_CONFIG.threshold7d),
    resume7d: num(r.resume7d, DEFAULT_CONFIG.resume7d),
    threshold5h: numOrNull(r.threshold5h, DEFAULT_CONFIG.threshold5h),
    resume5h: numOrNull(r.resume5h, DEFAULT_CONFIG.resume5h),
    cacheTtlSec: Math.max(5, num(r.cacheTtlSec, DEFAULT_CONFIG.cacheTtlSec)),
    fetchTimeoutMs: Math.max(500, num(r.fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs)),
    limitCooldownSec: Math.max(10, num(r.limitCooldownSec, DEFAULT_CONFIG.limitCooldownSec)),
    firstFetchWaitMs: Math.max(0, num(r.firstFetchWaitMs, DEFAULT_CONFIG.firstFetchWaitMs)),
    staleMaxSec: Math.max(60, num(r.staleMaxSec, DEFAULT_CONFIG.staleMaxSec)),
    dropThinkingOnSwitch: r.dropThinkingOnSwitch !== false,
    sourceProvider: str(r.sourceProvider, DEFAULT_CONFIG.sourceProvider),
    apiProvider: str(r.apiProvider, DEFAULT_CONFIG.apiProvider),
    notify: r.notify !== false,
    debug: r.debug === true,
    logFile: typeof r.logFile === "string" && r.logFile ? r.logFile : null,
  };
  // resume は threshold 以下であること(ヒステリシスが逆転すると flap する)
  if (c.resume7d > c.threshold7d) c.resume7d = c.threshold7d;
  if (c.threshold5h !== null) {
    if (c.resume5h === null) c.resume5h = c.threshold5h - 5;
    if (c.resume5h > c.threshold5h) c.resume5h = c.threshold5h;
  }
  return c;
}

/** /api/oauth/usage の応答 → 5h(kind=session) / 7d(kind=weekly_all)。percent は「使用済み%」。 */
export function parseUsage(json: unknown, now: number): Usage | null {
  const limits = (json as { limits?: unknown })?.limits;
  if (!Array.isArray(limits)) return null;
  const usage: Usage = { fetchedAt: now };
  for (const l of limits) {
    if (!l || typeof l !== "object") continue;
    const { kind, percent, resets_at } = l as { kind?: unknown; percent?: unknown; resets_at?: unknown };
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    const t = typeof resets_at === "string" ? Date.parse(resets_at) : Number.NaN;
    const w: Window = { percent, resetsAt: Number.isNaN(t) ? 0 : t };
    if (kind === "session") usage.w5h = w;
    else if (kind === "weekly_all") usage.w7d = w;
  }
  return usage.w5h || usage.w7d ? usage : null;
}

/** resetsAt を過ぎた枠は取得時の値が古いので 0% 扱い(resetsAt 不明(0)は過ぎた扱いにしない)。 */
export function effectivePercent(w: Window | undefined, now: number): number | undefined {
  if (!w) return undefined;
  if (w.resetsAt > 0 && now >= w.resetsAt) return 0;
  return w.percent;
}

export interface Decision {
  mode: Mode;
  changed: boolean;
  reason?: string;
}

/** 純粋な判定。pin / 429 クールダウン(blockUntil)は呼び出し側の状態を引数で受ける。 */
export function decideMode(args: {
  current: Mode;
  usage: Usage | null;
  now: number;
  cfg: Config;
  pin: Mode | null;
  blockUntil: number;
}): Decision {
  const { current, usage, now, cfg, pin, blockUntil } = args;
  if (pin) return { mode: pin, changed: pin !== current, reason: pin !== current ? `manual pin (${pin})` : undefined };
  const p7 = effectivePercent(usage?.w7d, now);
  const p5 = effectivePercent(usage?.w5h, now);
  const f = (v: number | undefined) => (v === undefined ? "?" : `${Math.round(v * 10) / 10}%`);
  if (current === "sub") {
    if (p7 !== undefined && p7 >= cfg.threshold7d)
      return { mode: "api", changed: true, reason: `7d ${f(p7)} >= ${cfg.threshold7d}%` };
    if (cfg.threshold5h !== null && p5 !== undefined && p5 >= cfg.threshold5h)
      return { mode: "api", changed: true, reason: `5h ${f(p5)} >= ${cfg.threshold5h}%` };
    return { mode: "sub", changed: false };
  }
  // current === "api": 戻り条件(ヒステリシス)。データ無し(取得失敗)は現状維持=api のまま。
  if (now < blockUntil) return { mode: "api", changed: false };
  if (!usage) return { mode: "api", changed: false };
  const ok7 = p7 === undefined || p7 < cfg.resume7d;
  const ok5 = cfg.threshold5h === null || p5 === undefined || p5 < (cfg.resume5h ?? cfg.threshold5h);
  if (ok7 && ok5) {
    const why: string[] = [];
    if (usage.w7d) why.push(now >= usage.w7d.resetsAt && usage.w7d.resetsAt > 0 ? "7d reset passed" : `7d ${f(p7)} < ${cfg.resume7d}%`);
    if (cfg.threshold5h !== null && usage.w5h)
      why.push(now >= usage.w5h.resetsAt && usage.w5h.resetsAt > 0 ? "5h reset passed" : `5h ${f(p5)} < ${cfg.resume5h}%`);
    return { mode: "sub", changed: true, reason: why.join(", ") || "usage ok" };
  }
  return { mode: "api", changed: false };
}

/** 429 後に api を維持する時刻: 満杯(>=99%)の枠の resetsAt のうち最も遅いもの。無ければ now+cooldown。 */
export function computeBlockUntil(usage: Usage | null, now: number, cooldownSec: number): number {
  let until = 0;
  for (const w of [usage?.w5h, usage?.w7d]) {
    if (w && w.percent >= 99 && w.resetsAt > now) until = Math.max(until, w.resetsAt);
  }
  return until || now + cooldownSec * 1000;
}

/** TTL + stale-while-revalidate キャッシュ。fetcher は例外/ null で失敗を表し、失敗時は直前値を保持する。 */
export class UsageCache {
  data: Usage | null = null;
  lastOkAt = 0;
  lastAttemptAt = 0;
  lastError: string | null = null;
  lastFetchMs: number | null = null;
  inflight: Promise<Usage | null> | null = null;
  attempts = 0;
  nextAllowedAt = 0;
  private fetcher: () => Promise<Usage | null>;
  private ttlMs: () => number;
  private clock: () => number;
  private onUpdate?: (u: Usage | null) => void;
  constructor(
    fetcher: () => Promise<Usage | null>,
    ttlMs: () => number,
    clock: () => number = Date.now,
    onUpdate?: (u: Usage | null) => void,
  ) {
    this.fetcher = fetcher;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.onUpdate = onUpdate;
  }
  /** 常に即時 return。TTL 切れなら裏で再取得を開始する(待たない)。 */
  peek(): Usage | null {
    const now = this.clock();
    if (!this.inflight && now - this.lastAttemptAt >= this.ttlMs() && now >= this.nextAllowedAt) void this.refresh();
    return this.data;
  }
  refresh(): Promise<Usage | null> {
    if (this.inflight) return this.inflight;
    this.lastAttemptAt = this.clock();
    this.attempts++;
    const t0 = Date.now();
    this.inflight = (async () => {
      try {
        const u = await this.fetcher();
        if (!u) throw new Error("empty usage response");
        this.data = u;
        this.lastOkAt = u.fetchedAt || this.clock();
        this.lastError = null;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e); // fail-open: data は直前値のまま
        const ra = (e as { retryAfterMs?: number } | null)?.retryAfterMs; // usage endpoint の 429 Retry-After を尊重
        if (typeof ra === "number" && ra > 0) this.nextAllowedAt = this.clock() + Math.min(ra, 10 * 60_000);
      } finally {
        this.lastFetchMs = Date.now() - t0;
        this.inflight = null;
      }
      try {
        this.onUpdate?.(this.data);
      } catch {
        /* ignore */
      }
      return this.data;
    })();
    return this.inflight;
  }
}

// ───────────────────────────── ランタイム ─────────────────────────────

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "claude-quota-router.json");
const DEFAULT_LOG = join(AGENT_DIR, "claude-quota-router.log");
const SHARED_CACHE_PATH = join(AGENT_DIR, "claude-quota-router.cache.json"); // プロセス間で使用率を共有(usage endpoint の 429 対策)
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const G_KEY = Symbol.for("claude-quota-router.state");
const RT_KEY = Symbol.for("claude-quota-router.runtime");

interface LogEntry {
  t: number;
  from: Mode;
  to: Mode;
  reason: string;
  p5h?: number;
  p7d?: number;
  resets7d?: number;
}
/** reload / 子セッションの再ロードをまたいで共有するプロセス内状態(globalThis)。 */
interface Shared {
  cfg: Config;
  mode: Mode;
  pin: Mode | null;
  blockUntil: number;
  reason: string;
  switchedAt: number;
  log: LogEntry[];
  cache: UsageCache | null;
  runtime: any;
  stats: { subAuth: number; apiAuth: number; apiFallback: number; signals429: number; thinkingDropped: number };
  impl: ((self: any, orig: any, pom: any, overrides: any) => Promise<any>) | null;
  ui: ExtensionContext["ui"] | null;
  lastSubAt: number;
  lastRouteAt: number;
  envPinApplied: boolean;
}
function shared(): Shared {
  const g = globalThis as any;
  return (g[G_KEY] ??= {
    cfg: { ...DEFAULT_CONFIG },
    mode: "sub",
    pin: null,
    blockUntil: 0,
    reason: "initial",
    switchedAt: 0,
    log: [],
    cache: null,
    runtime: null,
    stats: { subAuth: 0, apiAuth: 0, apiFallback: 0, signals429: 0, thinkingDropped: 0 },
    impl: null,
    ui: null,
    lastSubAt: 0,
    lastRouteAt: 0,
    envPinApplied: false,
  } satisfies Shared);
}

function loadConfig(): Config {
  try {
    return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** API キー等が万一混ざっても出さない。 */
function mask(s: string): string {
  return s.replace(/sk-ant-[A-Za-z0-9_-]{4,}/g, (m) => `${m.slice(0, 10)}…(masked)`);
}
function dlog(S: Shared, msg: string) {
  if (!S.cfg.debug) return;
  try {
    appendFileSync(S.cfg.logFile || DEFAULT_LOG, `${new Date().toISOString()} ${mask(msg)}\n`);
  } catch {
    /* ignore */
  }
}

const pct = (v: number | undefined) => (v === undefined ? "—" : `${Math.round(v * 10) / 10}%`);
const hhmm = (t: number) => {
  if (!t) return "—";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function statusLine(S: Shared): string {
  const now = Date.now();
  const u = S.cache?.data ?? null;
  const p5 = effectivePercent(u?.w5h, now);
  const p7 = effectivePercent(u?.w7d, now);
  const m = S.mode === "api" ? "API課金" : "sub";
  return `Claude:${m}${S.pin ? "📌" : ""} 5h${pct(p5)} 7d${pct(p7)}`;
}
function refreshUi(S: Shared) {
  try {
    S.ui?.setStatus("claude-router", S.cfg.enabled ? statusLine(S) : undefined);
  } catch {
    S.ui = null; // stale ctx (reload)
  }
}

/** 現在の使用率で mode を再評価し、変化があれば記録・通知する。 */
function evaluate(S: Shared, forced?: { mode: Mode; reason: string }) {
  const now = Date.now();
  const usage = S.cache?.data ?? null;
  const d: Decision = forced
    ? { mode: forced.mode, changed: forced.mode !== S.mode, reason: forced.reason }
    : decideMode({ current: S.mode, usage, now, cfg: S.cfg, pin: S.pin, blockUntil: S.blockUntil });
  if (!d.changed) {
    refreshUi(S);
    return;
  }
  const entry: LogEntry = {
    t: now,
    from: S.mode,
    to: d.mode,
    reason: d.reason ?? "",
    p5h: effectivePercent(usage?.w5h, now),
    p7d: effectivePercent(usage?.w7d, now),
    resets7d: usage?.w7d?.resetsAt,
  };
  S.mode = d.mode;
  S.reason = entry.reason;
  S.switchedAt = now;
  S.log.push(entry);
  if (S.log.length > 30) S.log.shift();
  dlog(S, `switch ${entry.from}->${entry.to}: ${entry.reason} (5h=${pct(entry.p5h)} 7d=${pct(entry.p7d)} resets7d=${hhmm(entry.resets7d ?? 0)})`);
  if (S.cfg.notify && S.ui) {
    try {
      S.ui.notify(
        d.mode === "api"
          ? `Claude を API課金(${S.cfg.apiProvider})に切替: ${entry.reason}`
          : `Claude をサブスクに復帰: ${entry.reason}`,
        d.mode === "api" ? "warning" : "info",
      );
    } catch {
      S.ui = null;
    }
  }
  refreshUi(S);
}

function readSharedCache(): Usage | null {
  try {
    const j = JSON.parse(readFileSync(SHARED_CACHE_PATH, "utf8"));
    if (j && typeof j === "object" && typeof j.fetchedAt === "number" && (j.w5h || j.w7d)) return j as Usage;
  } catch {
    /* none */
  }
  return null;
}
function writeSharedCache(u: Usage) {
  try {
    const tmp = `${SHARED_CACHE_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(u));
    renameSync(tmp, SHARED_CACHE_PATH);
  } catch {
    /* ignore */
  }
}

/** OAuth token を pi のモデルレジストリ(リフレッシュ込み)経由で取り /api/oauth/usage を叩く。 */
function makeFetcher(S: Shared, orig: () => ((p: any, o?: any) => Promise<any>) | undefined) {
  return async (): Promise<Usage | null> => {
    // 他プロセスが TTL 内に取得済みならそれを採用(ネットワークに出ない)
    const shared = readSharedCache();
    if (shared && Date.now() - shared.fetchedAt < S.cfg.cacheTtlSec * 1000) return shared;
    const getAuth = orig();
    if (!getAuth || !S.runtime) throw new Error("runtime not ready");
    const res = await Promise.race([
      getAuth.call(S.runtime, S.cfg.sourceProvider),
      new Promise((_, rej) => setTimeout(() => rej(new Error("auth timeout")), 10_000).unref?.()),
    ]);
    const token: string | undefined = (res as any)?.auth?.apiKey;
    if (!token) throw new Error(`no credential for ${S.cfg.sourceProvider}`);
    if (!token.includes("sk-ant-oat")) throw new Error(`${S.cfg.sourceProvider} is not using OAuth (no subscription usage)`);
    const r = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(S.cfg.fetchTimeoutMs),
    });
    if (!r.ok) {
      const ra = Number(r.headers.get("retry-after"));
      throw Object.assign(new Error(`usage HTTP ${r.status}${Number.isFinite(ra) && ra > 0 ? ` (retry-after ${ra}s)` : ""}`), {
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : r.status === 429 ? 300_000 : 0,
      });
    }
    const u = parseUsage(await r.json(), Date.now());
    if (!u) throw new Error("unrecognized usage payload");
    writeSharedCache(u);
    return u;
  };
}

/** runtime.getAuth を 1 回だけトランポリンに差し替える。中身は S.impl(最新ロードのコード)。 */
function installPatch(S: Shared, runtime: any): boolean {
  if (!runtime || typeof runtime.getAuth !== "function") return false;
  S.runtime = runtime;
  if (!runtime[RT_KEY]) {
    const orig = runtime.getAuth;
    runtime[RT_KEY] = { orig };
    runtime.getAuth = function (this: any, pom: any, overrides: any) {
      const impl = shared().impl;
      return impl ? impl(this, orig, pom, overrides) : orig.call(this, pom, overrides);
    };
  }
  return true;
}
const origGetAuth = (S: Shared) => S.runtime?.[RT_KEY]?.orig as ((p: any, o?: any) => Promise<any>) | undefined;

function makeImpl(S: Shared) {
  return async (self: any, orig: any, pom: any, overrides: any) => {
    const provider: string | undefined = typeof pom === "string" ? pom : pom?.provider;
    if (!S.cfg.enabled || provider !== S.cfg.sourceProvider) return orig.call(self, pom, overrides);
    const c = S.cache;
    c?.peek(); // 期限切れなら裏で再取得(待たない)
    // 起動直後の最初の 1 回だけ、データが全く無いので短時間(既定1.5s)だけ待つ。以降は絶対に待たない。
    if (c && !c.data && c.inflight && c.attempts === 1 && S.cfg.firstFetchWaitMs > 0) {
      await Promise.race([c.inflight, new Promise((r) => setTimeout(r, S.cfg.firstFetchWaitMs))]);
    }
    evaluate(S); // resetsAt 経過・pin 変更をキャッシュ値で反映
    if (S.mode === "api") {
      try {
        const target = typeof pom === "string" ? S.cfg.apiProvider : { ...pom, provider: S.cfg.apiProvider };
        const res = await orig.call(self, target, overrides);
        if (res?.auth?.apiKey) {
          S.stats.apiAuth++;
          S.lastRouteAt = Date.now();
          dlog(S, `route ${provider} -> ${S.cfg.apiProvider} (api key ${String(res.auth.apiKey).slice(0, 10)}…masked)`);
          return res;
        }
      } catch (e) {
        dlog(S, `api auth failed: ${e instanceof Error ? e.message : e}`);
      }
      // API キーが解決できない場合はサブスクのまま続行(止めない)
      S.stats.apiFallback++;
      dlog(S, `api key unavailable for ${S.cfg.apiProvider}; falling back to ${provider}`);
    }
    S.stats.subAuth++;
    S.lastSubAt = Date.now();
    return orig.call(self, pom, overrides);
  };
}

/** 429 / クォータ枯渇シグナル → 即 api へ。pin 中は何もしない。 */
function onQuotaSignal(S: Shared, why: string) {
  if (!S.cfg.enabled || S.pin || S.mode === "api") return;
  S.stats.signals429++;
  // いったん即 api に倒し、再取得結果で復帰時刻(blockUntil)を決める。
  S.blockUntil = Date.now() + S.cfg.limitCooldownSec * 1000;
  evaluate(S, { mode: "api", reason: `${why} (即時切替)` });
  const c = S.cache;
  if (!c || Date.now() < c.nextAllowedAt) return; // usage endpoint 自体が 429 中は叩かない(cooldown は固定値のまま)
  void c.refresh().then((u) => {
    S.blockUntil = computeBlockUntil(u, Date.now(), S.cfg.limitCooldownSec);
    dlog(S, `blockUntil=${hhmm(S.blockUntil)}`);
  });
}

function renderStatus(S: Shared): string {
  const now = Date.now();
  const c = S.cache;
  const u = c?.data ?? null;
  const L: string[] = [];
  L.push(`mode: ${S.mode === "api" ? `api (${S.cfg.apiProvider})` : `sub (${S.cfg.sourceProvider} OAuth)`}${S.cfg.enabled ? "" : "  [disabled]"}`);
  L.push(`pin: ${S.pin ? `${S.pin} (手動。自動切替は停止中)` : "なし (auto)"}`);
  const w = (name: string, win: Window | undefined) =>
    win
      ? `${name}: ${pct(effectivePercent(win, now))}${now >= win.resetsAt && win.resetsAt ? ` (取得時 ${pct(win.percent)}, reset済)` : ""}  resetsAt ${hhmm(win.resetsAt)}`
      : `${name}: —`;
  L.push(w("5h", u?.w5h) + (S.cfg.threshold5h !== null ? `  [閾値 ${S.cfg.threshold5h}% / 復帰 ${S.cfg.resume5h}%]` : "  [判定: off]"));
  L.push(w("7d", u?.w7d) + `  [閾値 ${S.cfg.threshold7d}% / 復帰 ${S.cfg.resume7d}%]`);
  L.push(
    `usage取得: ${u ? `${Math.round((now - (c?.lastOkAt ?? now)) / 1000)}秒前 (TTL ${S.cfg.cacheTtlSec}s, ${c?.lastFetchMs ?? "?"}ms)` : "未取得"}${c?.lastError ? `  直近エラー: ${c.lastError}` : ""}`,
  );
  L.push(`最後の切替: ${S.switchedAt ? `${hhmm(S.switchedAt)} → ${S.mode} / 理由: ${S.reason}` : "なし"}`);
  if (S.blockUntil > now) L.push(`429クールダウン: ${hhmm(S.blockUntil)} まで api 維持`);
  L.push(`ルーティング実績: sub ${S.stats.subAuth} / api ${S.stats.apiAuth} / apiキー無しfallback ${S.stats.apiFallback} / 429検知 ${S.stats.signals429} / 切替前thinking破棄 ${S.stats.thinkingDropped}`);
  if (S.log.length) {
    L.push("履歴(新しい順, 最大5件):");
    for (const e of S.log.slice(-5).reverse())
      L.push(`  ${hhmm(e.t)} ${e.from}→${e.to}  ${e.reason}  [5h ${pct(e.p5h)} / 7d ${pct(e.p7d)} / resets7d ${hhmm(e.resets7d ?? 0)}]`);
  }
  return L.join("\n");
}

export default function (pi: ExtensionAPI) {
  const S = shared();
  S.impl = makeImpl(S);

  pi.on("session_start", async (_event, ctx) => {
    S.cfg = loadConfig();
    if (ctx.hasUI) S.ui = ctx.ui; // 子セッション(hasUI=false)で親の UI 参照を消さない
    const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
    const ok = installPatch(S, runtime);
    if (!ok) {
      dlog(S, "ModelRuntime.getAuth not found: routing disabled (pi internals changed?)");
      try {
        ctx.ui?.notify?.("claude-quota-router: ModelRuntime が見つからず無効化されました", "warning");
      } catch {
        /* ignore */
      }
      return;
    }
    S.impl = makeImpl(S);
    if (!S.cache) {
      S.cache = new UsageCache(
        makeFetcher(S, () => origGetAuth(S)),
        () => S.cfg.cacheTtlSec * 1000,
        Date.now,
        () => evaluate(S),
      );
    }
    const force = process.env.CLAUDE_ROUTER_FORCE;
    if (!S.envPinApplied && (force === "sub" || force === "api")) {
      S.pin = force;
      S.envPinApplied = true;
    }
    if (!S.cache.data) {
      const seed = readSharedCache(); // コールドスタート: 前回プロセスの値(stale でも)で即判定できるように
      if (seed && Date.now() - seed.fetchedAt < S.cfg.staleMaxSec * 1000) {
        S.cache.data = seed;
        S.cache.lastOkAt = seed.fetchedAt;
      }
    }
    if (S.cfg.enabled) void S.cache.peek();
    evaluate(S);
    refreshUi(S);
  });

  // 切替(sub<->api)より前に作られた anthropic の thinking ブロックは、次のリクエストから外す。
  // thinking の署名はアカウント(組織)/会話/tools に束縛され得るため、認証先を替えた直後の
  // 2 ターン目で "Invalid signature in thinking block" の 400 になるのを防ぐ。
  // tool_use 途中のメッセージから外しても API は受理する(検証済み: haiku-5-5)。
  pi.on("context", async (event) => {
    if (!S.cfg.enabled || !S.cfg.dropThinkingOnSwitch || !S.switchedAt) return;
    let n = 0;
    const messages = event.messages.map((m: any) => {
      if (m?.role !== "assistant" || m.provider !== S.cfg.sourceProvider || !Array.isArray(m.content)) return m;
      if (typeof m.timestamp !== "number" || m.timestamp >= S.switchedAt) return m;
      const content = m.content.filter((c: any) => c?.type !== "thinking" && c?.type !== "redacted_thinking");
      if (content.length === m.content.length || content.length === 0) return m; // 何も無い/空になるなら触らない
      n += m.content.length - content.length;
      return { ...m, content };
    });
    if (!n) return;
    S.stats.thinkingDropped += n;
    dlog(S, `dropped ${n} pre-switch thinking block(s) from request context`);
    return { messages };
  });

  // 429 即時検知(Anthropic のレスポンスで、サブスク経路のとき)
  pi.on("after_provider_response", async (event) => {
    if (event.status !== 429 || S.mode !== "sub") return;
    const keys = Object.keys(event.headers ?? {}).map((k) => k.toLowerCase());
    const isAnthropic = keys.some((k) => k.startsWith("anthropic-") || k === "request-id");
    const isApiKeyStyle = keys.includes("anthropic-ratelimit-requests-limit") && !keys.some((k) => k.startsWith("anthropic-ratelimit-unified"));
    if (isAnthropic && !isApiKeyStyle && Date.now() - S.lastSubAt < 15 * 60_000) onQuotaSignal(S, "Anthropic 429");
  });

  // 保険: アシスタントメッセージがクォータ系エラーで終わった場合
  pi.on("message_end", async (event) => {
    const m = event.message as any;
    if (m?.role !== "assistant" || m.stopReason !== "error" || m.provider !== S.cfg.sourceProvider) return;
    if (S.mode !== "sub") return;
    const text = String(m.errorMessage ?? "");
    if (/\b429\b|extra usage|plan limit|usage limit|rate[_ ]limit|quota|limit reached|exceeded your/i.test(text)) onQuotaSignal(S, "quota error");
  });

  pi.registerCommand("claude-router", {
    description: "Claude subscription/API quota router: status | auto | sub | api | refresh",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "auto", "sub", "api", "refresh"].filter((x) => x.startsWith(prefix.trim()));
      return items.length ? items.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const out = (text: string, level: "info" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else process.stderr.write(text + "\n");
      };
      const a = (args ?? "").trim().toLowerCase() || "status";
      if (a === "sub" || a === "api") {
        S.pin = a;
        evaluate(S);
        out(`pin: ${a}(手動)。自動切替は停止中。\n${renderStatus(S)}`);
      } else if (a === "auto") {
        S.pin = null;
        S.blockUntil = 0;
        await S.cache?.refresh();
        evaluate(S);
        out(`pin 解除。\n${renderStatus(S)}`);
      } else if (a === "refresh") {
        await S.cache?.refresh();
        evaluate(S);
        out(renderStatus(S));
      } else if (a === "status") {
        // 未取得 or 古い場合は(待てる範囲で)一度だけ取得してから表示
        if (S.cache && (!S.cache.data || Date.now() - S.cache.lastOkAt > S.cfg.cacheTtlSec * 1000)) await S.cache.refresh();
        evaluate(S);
        out(renderStatus(S));
      } else {
        out("usage: /claude-router [status|auto|sub|api|refresh]", "warning");
      }
    },
  });
}
