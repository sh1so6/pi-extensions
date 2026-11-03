/** M2 helpers: auto-trigger config, prompt-cache expiry estimate, relay log. Pure / side-effect-light, no Pi runtime needed. */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface AutoConfig {
  /** Relay when a new user message arrives and the context is already big. */
  onInput: boolean;
  inputMinTokens: number;
  /** Relay shortly before the prompt cache expires (the next turn would re-write the whole prefix anyway). */
  beforeExpiry: boolean;
  expiryMinTokens: number;
  /** After a relay, do not auto-relay again until the context grew by this many tokens (guards against relay loops when the kept tail is huge). */
  minGrowthTokens: number;
}

export const AUTO_DEFAULTS: AutoConfig = { onInput: true, inputMinTokens: 100_000, beforeExpiry: true, expiryMinTokens: 140_000, minGrowthTokens: 30_000 };

/** Merge the `auto` section of context-relay.json over the defaults; wrong types fall back to the default. */
export function parseAuto(raw: unknown): AutoConfig {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bool = (key: keyof AutoConfig) => (typeof src[key] === "boolean" ? (src[key] as boolean) : (AUTO_DEFAULTS[key] as boolean));
  const num = (key: keyof AutoConfig) => (typeof src[key] === "number" && Number.isFinite(src[key]) && (src[key] as number) >= 0 ? (src[key] as number) : (AUTO_DEFAULTS[key] as number));
  return { onInput: bool("onInput"), inputMinTokens: num("inputMinTokens"), beforeExpiry: bool("beforeExpiry"), expiryMinTokens: num("expiryMinTokens"), minGrowthTokens: num("minGrowthTokens") };
}

export const ANTHROPIC_SHORT_TTL_MS = 5 * 60_000;
export const ANTHROPIC_LONG_TTL_MS = 60 * 60_000;

export interface ModelLike {
  api?: string;
  promptCache?: { short?: number; long?: number };
}

/**
 * Prompt-cache lifetime for a tier, or undefined when it is not actually known (provider-aware on purpose:
 * a timer for a best-effort cache, e.g. DeepSeek's automatic disk cache or OpenAI without a declared lifetime, would be a guess).
 * Known: a model that declares `promptCache` for the tier (seconds, as pi's cache warmer reads it), or Anthropic
 * (`anthropic-messages`: 1 h tier / 5 min tier).
 */
export function cacheTtlMs(model: ModelLike | undefined, tier: "short" | "long"): number | undefined {
  const declared = model?.promptCache?.[tier];
  if (declared !== undefined) return declared * 1000;
  if (model?.api === "anthropic-messages") return tier === "long" ? ANTHROPIC_LONG_TTL_MS : ANTHROPIC_SHORT_TTL_MS;
  return undefined;
}

export interface CacheExpiry {
  expiresAt: number;
  ttlMs: number;
  tier: "short" | "long";
}

interface EntryLike {
  type?: string;
  timestamp?: string;
  kind?: string;
  message?: { role?: string; stopReason?: string; timestamp?: number; usage?: { cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number } };
}

/**
 * When the prompt cache written by the newest real assistant request expires, or undefined when there is none
 * (no cache activity, compaction since, only failed requests) or the lifetime is unknown for this model (see cacheTtlMs).
 * Tier: "long" (1 h) when the newest cache-writing request has usage.cacheWrite1h > 0, "short" when it wrote without it,
 * and before any write is seen PI_CACHE_RETENTION decides (as pi's cache warmer does).
 * Pi's own cache-warm entries refresh the timestamp (same bookkeeping as pi-cached-compaction).
 */
export function cacheExpiry(entries: readonly unknown[], model: ModelLike | undefined): CacheExpiry | undefined {
  let refreshedAt: number | undefined;
  const initialTier = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
  let tier: "short" | "long" = initialTier;
  for (const entry of entries as EntryLike[]) {
    if (entry.type === "compaction") {
      refreshedAt = undefined;
      tier = initialTier;
    } else if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
      const { cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0 } = entry.message.usage;
      if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue; // may not have reached the cache
      if (cacheWrite > 0) tier = cacheWrite1h > 0 ? "long" : "short";
      refreshedAt = cacheRead + cacheWrite > 0 ? entry.message.timestamp : undefined;
    } else if (entry.type === "usage" && entry.kind === "cache_warm" && refreshedAt !== undefined && entry.timestamp) {
      const warmed = Date.parse(entry.timestamp);
      if (Number.isFinite(warmed)) refreshedAt = Math.max(refreshedAt, warmed);
    }
  }
  if (refreshedAt === undefined) return undefined;
  const ttlMs = cacheTtlMs(model, tier);
  if (ttlMs === undefined) return undefined;
  return { expiresAt: refreshedAt + ttlMs, ttlMs, tier };
}

export interface RelayLogRecord {
  at: string;
  sessionId: string;
  trigger: "manual" | "input" | "expiry";
  tokensBefore: number | null;
  noteChars?: number;
  keptFrom?: string;
  ok: boolean;
  error?: string;
}

/** Append one JSON line to <agentDir>/context-relay/log.jsonl. Never throws. */
export function appendRelayLog(agentDir: string, record: RelayLogRecord): void {
  try {
    const dir = path.join(agentDir, "context-relay");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "log.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // measurement only: ignore
  }
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "?";
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
