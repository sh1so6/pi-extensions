/**
 * cache-ttl-main: 1-hour Anthropic prompt cache for the MAIN pi session only.
 * Install: pi install npm:@sh1so6/pi-cache-ttl-main (or copy to ~/.pi/agent/extensions/ and run /reload).
 *
 * Why: the main orchestrator session often waits 5-60 minutes for background subagents. Anthropic's
 * default prompt cache lives 5 minutes, so the next turn rewrites the whole (~150k token) prefix.
 * With ttl "1h" it becomes a cache read. PI_CACHE_RETENTION=long would do the same, but it is a
 * process-wide env var: in-process subagents (pi-subagents) share it, would pay the 2x write price,
 * and pi's cache warmer would assume a 1h TTL for them and stop warming at 4.5 minutes.
 * So this extension acts per session instead:
 *
 *   - before_provider_request (main session, api "anthropic-messages"): adds ttl "1h" to EVERY existing
 *     cache_control object (top level, system blocks, tools, message content blocks, tool_result
 *     content). Anthropic rejects a longer-TTL breakpoint after a shorter one, so all or none.
 *     cache_control is never added where pi did not put one. Idempotent, the input is not mutated.
 *   - cache_warming_decision (main session, while the last payload was upgraded): returns "stop".
 *     Pi's warmer would refresh at 4.5 minutes (it sees a 5 minute TTL) which is pure waste now.
 *   - Subagent sessions are left completely untouched (their warmer keeps working on the 5 minute TTL).
 *   - Skipped when PI_CACHE_RETENTION=long (pi already does it everywhere, warmer included).
 *
 * Main vs subagent (decided per session on session_start, state is per extension instance):
 * by ctx.mode: tui / rpc = main, print / json = subagent (pi-subagents children are bound without a UI
 * context, which Pi reports as mode "print", hasUI false); without a mode, ctx.hasUI decides. The session
 * name (`worker#<8hex>`) is NOT used: a person who resumes a subagent session makes it a main session.
 *
 * Optional config ~/.pi/agent/cache-ttl-main.json (read on session_start; missing = defaults):
 *   { "enabled": true }
 *
 * Command /cache-ttl: enabled, main/sub detection, payloads modified, and the usage of the last
 * assistant turn (cacheWrite / cacheWrite1h). Whether the Claude subscription (OAuth) honors ttl 1h
 * is not documented: after a deploy, cacheWrite1h > 0 on a turn that wrote the cache proves it;
 * cacheWrite > 0 with cacheWrite1h = 0 means the 1h request was ignored (5 minute entry).
 *
 * Limits: only the payload is edited (no headers, no model options); a provider that accepts the
 * anthropic-messages format but rejects ttl would fail requests in the main session - set
 * { "enabled": false } or use /cache-ttl to check. The cache entry written before this extension
 * was active (5 minutes) is not upgraded retroactively.
 * Role detection assumes pi-subagents binds children without a UI context (Pi reports mode "print", hasUI false;
 * checked with pi-subagents 0.23.2 / Pi 1.5.1). If children ever get a UI context or mode "tui" they would count
 * as main. RPC hasUI=true was verified on Pi 1.5.1 only; the mode-based rule does not depend on it.
 */
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Role = "main" | "subagent";

const INTERACTIVE_MODES: ReadonlySet<string> = new Set(["tui", "rpc"]);
const HEADLESS_MODES: ReadonlySet<string> = new Set(["print", "json"]);
const TTL = "1h";

/**
 * Main/subagent classification from the run mode and UI availability. The session NAME is not used: a
 * pi-subagents child keeps its `worker#<8hex>` name when a person resumes it, and that session is main then.
 * pi-subagents children are bound without a UI context, so Pi reports them as mode "print" with hasUI false.
 * tui and rpc (RPC provides a real UI context, hasUI true) are main.
 */
export function detectRole(mode: string | undefined, hasUI: boolean): Role {
  if (typeof mode === "string") {
    if (INTERACTIVE_MODES.has(mode)) return "main";
    if (HEADLESS_MODES.has(mode)) return "subagent";
  }
  return hasUI ? "main" : "subagent";
}

export interface TtlResult {
  payload: unknown;
  /** cache_control objects that were changed (0 = payload returned as is). */
  changed: number;
  /** cache_control objects found. */
  total: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Returns a copy of an Anthropic Messages payload in which every existing cache_control has ttl "1h".
 * Copy-on-write: untouched parts are shared with the input, which is never mutated.
 */
export function applyOneHourTtl(payload: unknown): TtlResult {
  let changed = 0;
  let total = 0;

  const fixControl = (control: unknown): unknown => {
    if (!isRecord(control)) return control;
    total++;
    if (control.ttl === TTL) return control;
    changed++;
    return { ...control, ttl: TTL };
  };

  /** One content/system/tool block; nested `content` arrays (tool_result) are followed. */
  const fixBlock = (block: unknown): unknown => {
    if (!isRecord(block)) return block;
    let out = block;
    if (isRecord(block.cache_control)) {
      const control = fixControl(block.cache_control);
      if (control !== block.cache_control) out = { ...out, cache_control: control };
    }
    if (Array.isArray(block.content)) {
      const content = fixList(block.content);
      if (content !== block.content) out = { ...out, content };
    }
    return out;
  };

  const fixList = (list: unknown[]): unknown[] => {
    let out: unknown[] | undefined;
    list.forEach((item, index) => {
      const fixed = fixBlock(item);
      if (fixed !== item) (out ??= list.slice())[index] = fixed;
    });
    return out ?? list;
  };

  if (!isRecord(payload)) return { payload, changed, total };
  let out: Record<string, unknown> = payload;
  const set = (key: string, value: unknown) => {
    if (value !== payload[key]) out = { ...out, [key]: value };
  };
  if (isRecord(payload.cache_control)) set("cache_control", fixControl(payload.cache_control));
  if (Array.isArray(payload.system)) set("system", fixList(payload.system));
  if (Array.isArray(payload.tools)) set("tools", fixList(payload.tools));
  if (Array.isArray(payload.messages)) {
    // Messages carry their blocks in `content`; fixBlock on the message handles it.
    set("messages", fixList(payload.messages));
  }
  return { payload: out, changed, total };
}

export interface Settings {
  enabled: boolean;
}

export function parseSettings(raw: unknown): Settings {
  const enabled = isRecord(raw) && typeof raw.enabled === "boolean" ? raw.enabled : true;
  return { enabled };
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

export interface UsageLike {
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

/** Newest assistant usage in the session entries (`latestWrite`: newest one that wrote the cache). */
export function lastAssistantUsage(entries: readonly unknown[]): { latest?: UsageLike; latestWrite?: UsageLike } {
  let latest: UsageLike | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role !== "assistant" || !isRecord(entry.message.usage)) continue;
    const usage = entry.message.usage as UsageLike;
    latest ??= usage;
    if ((usage.cacheWrite ?? 0) > 0) return { latest, latestWrite: usage };
  }
  return { latest };
}

const fmt = (usage: UsageLike) =>
  `cacheWrite=${usage.cacheWrite ?? 0} cacheWrite1h=${usage.cacheWrite1h ?? 0} cacheRead=${usage.cacheRead ?? 0}`;

export function formatStatus(info: {
  enabled: boolean;
  role: Role | undefined;
  skipReason: string | undefined;
  modified: number;
  payloads: number;
  warmStops: number;
  usage: { latest?: UsageLike; latestWrite?: UsageLike };
}): string {
  const lines = [
    `cache-ttl-main: ${info.enabled ? "enabled" : "disabled (config)"}, session = ${info.role ?? "unknown (before session_start)"}`,
    info.skipReason ? `inactive: ${info.skipReason}` : "active for this session",
    `payloads upgraded to 1h: ${info.modified} of ${info.payloads} seen, warmer stopped: ${info.warmStops}x`,
  ];
  const { latest, latestWrite } = info.usage;
  if (!latest) lines.push("last assistant usage: none yet");
  else lines.push(`last assistant usage: ${fmt(latest)}`);
  if (latestWrite && latestWrite !== latest) lines.push(`last cache-writing turn: ${fmt(latestWrite)}`);
  if (latestWrite) {
    lines.push(
      (latestWrite.cacheWrite1h ?? 0) > 0
        ? "verdict: 1h cache writes confirmed (provider honors ttl 1h)"
        : "verdict: cache written WITHOUT 1h share (5 min entry): ttl 1h ignored, or written before activation",
    );
  } else lines.push("verdict: no cache-writing turn yet");
  return lines.join("\n");
}

export default function cacheTtlMain(pi: ExtensionAPI) {
  let settings: Settings = { enabled: true };
  let role: Role | undefined;
  let payloads = 0;
  let modified = 0;
  let warmStops = 0;
  /** Whether the newest anthropic payload of this session was sent with 1h breakpoints. */
  let lastUpgraded = false;

  /** Why this instance does nothing for the given context, if it does not. */
  const inactiveReason = (ctx: ExtensionContext): string | undefined => {
    if (!settings.enabled) return "disabled in cache-ttl-main.json";
    if ((role ?? detectRole(ctx.mode, ctx.hasUI)) !== "main") return "subagent session";
    if (process.env.PI_CACHE_RETENTION === "long") return "PI_CACHE_RETENTION=long (pi already uses 1h)";
    if (ctx.model && ctx.model.api !== "anthropic-messages") return `model api ${ctx.model.api} is not anthropic-messages`;
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    settings = parseSettings(readJson(nodePath.join(getAgentDir(), "cache-ttl-main.json")));
    role = detectRole(ctx.mode, ctx.hasUI);
    payloads = modified = warmStops = 0;
    lastUpgraded = false;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (inactiveReason(ctx) !== undefined || ctx.model?.api !== "anthropic-messages") return undefined;
    if (!isRecord(event.payload)) return undefined;
    const result = applyOneHourTtl(event.payload);
    payloads++;
    lastUpgraded = result.total > 0;
    if (result.changed === 0) return undefined;
    modified++;
    return result.payload;
  });

  pi.on("cache_warming_decision", (_event, ctx) => {
    if (!lastUpgraded || inactiveReason(ctx) !== undefined) return undefined;
    warmStops++;
    return { action: "stop" };
  });

  pi.registerCommand("cache-ttl", {
    description: "Main-session 1h prompt cache: status and whether cacheWrite1h is reported",
    handler: async (_args, ctx) => {
      const skipReason = inactiveReason(ctx);
      const usage = lastAssistantUsage(ctx.sessionManager.getEntries());
      ctx.ui.notify(
        formatStatus({ enabled: settings.enabled, role, skipReason, modified, payloads, warmStops, usage }),
        "info",
      );
    },
  });
}
