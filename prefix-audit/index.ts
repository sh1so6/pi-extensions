/**
 * prefix-audit: finds WHAT changed in `system`, `tools` or earlier messages between two Anthropic requests of
 * the same session. Explains the pi notice "Anthropic dropped N thinking blocks (details in session)" with reason
 * `prefix_binding_mismatch`: Anthropic binds every thinking block to the exact system prompt, tool list and earlier
 * messages it was produced under; any later difference (one word of a tool description is enough) makes the API
 * drop the block (pi sends `thinking.block_binding.prefix_mismatch_behavior = "drop_block"`) and invalidates the
 * prompt cache from the first dropped block on.
 * Install: pi install npm:@sh1so6/pi-prefix-audit (or copy to ~/.pi/agent/extensions/ and run /reload).
 *
 * How it works (observation only, never edits a payload):
 *   - before_provider_request (api "anthropic-messages", main and subagent sessions): snapshots the request
 *     (`cache_control` removed, thinking blocks reduced to a signature hash, because the API compares neither),
 *     diffs it with the previous request of the session and keeps the list of changes.
 *   - message_end (assistant): when the response reports `thinking_dropped` entries, writes a `drop` record with the
 *     changes made since the first dropped block was minted ("suspects") and shows a one-line notice.
 *   Paths in `thinking_dropped` ("messages.51.content.0") index the same `messages` array that is snapshotted.
 *
 * Log: ~/.pi/agent/prefix-audit/<sessionId>.jsonl, one JSON object per line:
 *   {type:"req",  t, seq, role, model, msgs, tools, sys, diff?}      // diff only when something changed
 *   {type:"drop", t, seq, role, count, reasons, firstIdx, lastIdx, threadFallback, suspects:[...]}
 *   diff = {system?:{at,was,now}, tools?:{added,removed,changed:[{name,at,was,now}],order?}, messages?:{shrunk?,
 *           mutated:[{idx,role,blocks,at,was,now}], mutatedCount}}. `at` is the first differing character offset.
 *
 * Optional config ~/.pi/agent/prefix-audit.json (read on session_start): { "enabled": true }
 * Command /prefix-audit: log path, requests seen, changes and drops of this session, the last changes.
 *
 * Limits: sees the request as pi builds it, i.e. after the before_provider_request handlers loaded BEFORE this one;
 * a handler loaded later that rewrites system/tools/messages (e.g. a cache or prompt rewriter) is invisible and would
 * show up as "no change seen". The log keeps the changed text (`was`/`now`, ~100 chars) of system, tool descriptions and
 * messages, and is never rotated. Anthropic message
 * threads omit system/tools on `continue` requests on the wire; the payload seen here is still the full one.
 * A change made by the provider layer after the hook (none known) would not be visible.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Role = "main" | "subagent";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Same rule as cache-ttl-main: tui / rpc = main, print / json = subagent, else hasUI. */
export function detectRole(mode: string | undefined, hasUI: boolean): Role {
  if (mode === "tui" || mode === "rpc") return "main";
  if (mode === "print" || mode === "json") return "subagent";
  return hasUI ? "main" : "subagent";
}

const sha = (text: string, length = 10) => createHash("sha1").update(text).digest("hex").slice(0, length);

/** Stable JSON: sorted keys, `cache_control` removed (the API does not compare it). */
export function canonical(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node).sort()) {
        if (key === "cache_control") continue;
        out[key] = walk(node[key]);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value)) ?? "undefined";
}

/** Thinking blocks are not compared as content (only their presence and order), so keep just a signature hash. */
function reduceMessage(message: unknown): unknown {
  if (!isRecord(message) || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((block) => {
      if (!isRecord(block)) return block;
      if (block.type === "thinking") return { type: "thinking", signature: sha(String(block.signature ?? "")) };
      if (block.type === "redacted_thinking") return { type: "redacted_thinking", data: sha(String(block.data ?? "")) };
      return block;
    }),
  };
}

export interface Snapshot {
  system: string;
  tools: Map<string, string>;
  toolOrder: string[];
  messages: string[];
  roles: string[];
  blocks: string[];
}

export function takeSnapshot(payload: Record<string, unknown>): Snapshot {
  const tools = new Map<string, string>();
  const toolOrder: string[] = [];
  if (Array.isArray(payload.tools)) {
    payload.tools.forEach((tool, index) => {
      const name = isRecord(tool) && typeof tool.name === "string" ? tool.name : `#${index}`;
      toolOrder.push(name);
      tools.set(name, canonical(tool));
    });
  }
  const list = Array.isArray(payload.messages) ? payload.messages : [];
  return {
    system: canonical(payload.system ?? null),
    tools,
    toolOrder,
    messages: list.map((m) => canonical(reduceMessage(m))),
    roles: list.map((m) => (isRecord(m) && typeof m.role === "string" ? m.role : "?")),
    blocks: list.map((m) =>
      isRecord(m) && Array.isArray(m.content)
        ? m.content.map((b) => (isRecord(b) && typeof b.type === "string" ? b.type : "?")).join(",")
        : "text",
    ),
  };
}

export interface TextDelta {
  at: number;
  was: string;
  now: string;
}

/** First differing offset with a little context from both sides. */
export function textDelta(before: string, after: string): TextDelta {
  const max = Math.min(before.length, after.length);
  let at = 0;
  while (at < max && before[at] === after[at]) at++;
  const from = Math.max(0, at - 30);
  return { at, was: before.slice(from, at + 80), now: after.slice(from, at + 80) };
}

export interface Diff {
  system?: TextDelta;
  tools?: {
    added: string[];
    removed: string[];
    changed: Array<{ name: string } & TextDelta>;
    order?: true;
  };
  messages?: {
    shrunk?: { from: number; to: number };
    mutated: Array<{ idx: number; role: string; blocks: string } & TextDelta>;
    mutatedCount: number;
  };
}

const MAX_MUTATED_DETAILS = 5;

/** What changed between two snapshots of one session. Appending messages is not a change. */
export function diffSnapshots(
  prev: Snapshot,
  cur: Snapshot,
): { diff: Diff; firstMutated: number | undefined } | undefined {
  const diff: Diff = {};
  if (prev.system !== cur.system) diff.system = textDelta(prev.system, cur.system);

  const added = cur.toolOrder.filter((name) => !prev.tools.has(name));
  const removed = prev.toolOrder.filter((name) => !cur.tools.has(name));
  const changed: Array<{ name: string } & TextDelta> = [];
  for (const name of cur.toolOrder) {
    const before = prev.tools.get(name);
    const after = cur.tools.get(name);
    if (before !== undefined && after !== undefined && before !== after) {
      changed.push({ name, ...textDelta(before, after) });
    }
  }
  const sharedPrev = prev.toolOrder.filter((n) => cur.tools.has(n));
  const sharedCur = cur.toolOrder.filter((n) => prev.tools.has(n));
  const order = sharedPrev.join("|") !== sharedCur.join("|");
  if (added.length || removed.length || changed.length || order) {
    diff.tools = { added, removed, changed, ...(order ? { order: true as const } : {}) };
  }

  const overlap = Math.min(prev.messages.length, cur.messages.length);
  const mutated: NonNullable<Diff["messages"]>["mutated"] = [];
  let mutatedCount = 0;
  let firstMutated: number | undefined;
  for (let idx = 0; idx < overlap; idx++) {
    if (prev.messages[idx] === cur.messages[idx]) continue;
    mutatedCount++;
    firstMutated ??= idx;
    if (mutated.length < MAX_MUTATED_DETAILS) {
      mutated.push({
        idx,
        role: cur.roles[idx] ?? "?",
        blocks: `${prev.blocks[idx]} -> ${cur.blocks[idx]}`,
        ...textDelta(prev.messages[idx], cur.messages[idx]),
      });
    }
  }
  const shrunk = cur.messages.length < prev.messages.length;
  if (mutatedCount > 0 || shrunk) {
    diff.messages = {
      ...(shrunk ? { shrunk: { from: prev.messages.length, to: cur.messages.length } } : {}),
      mutated,
      mutatedCount,
    };
  }
  return Object.keys(diff).length > 0 ? { diff, firstMutated } : undefined;
}

export interface Change {
  seq: number;
  kind: "system" | "tools" | "messages";
  /** Short human text. */
  summary: string;
  /** Message index of the earliest mutated message (kind "messages"). */
  idx?: number;
}

const names = (list: string[]) => `${list.slice(0, 5).join(",")}${list.length > 5 ? "…" : ""}`;

/** One entry per changed part, for the suspects list. */
export function summarizeDiff(seq: number, diff: Diff, firstMutated: number | undefined): Change[] {
  const out: Change[] = [];
  if (diff.system) out.push({ seq, kind: "system", summary: `system prompt changed at char ${diff.system.at}` });
  if (diff.tools) {
    const parts: string[] = [];
    if (diff.tools.added.length) parts.push(`added ${names(diff.tools.added)}`);
    if (diff.tools.removed.length) parts.push(`removed ${names(diff.tools.removed)}`);
    if (diff.tools.changed.length) parts.push(`changed ${names(diff.tools.changed.map((c) => c.name))}`);
    if (diff.tools.order) parts.push("reordered");
    out.push({ seq, kind: "tools", summary: `tools ${parts.join("; ")}` });
  }
  if (diff.messages) {
    const m = diff.messages;
    const parts: string[] = [];
    if (m.mutatedCount) parts.push(`${m.mutatedCount} message(s) mutated from #${firstMutated}`);
    if (m.shrunk) parts.push(`history shrunk ${m.shrunk.from}->${m.shrunk.to}`);
    out.push({ seq, kind: "messages", summary: parts.join("; "), idx: firstMutated });
  }
  return out;
}

export interface DropInfo {
  count: number;
  reasons: string[];
  /** Message indices of the dropped prefix_binding_mismatch blocks (empty when only other reasons). */
  prefixIdx: number[];
  threadFallback: boolean;
}

/** Dropped thinking entries of an assistant message's diagnostics (anthropic_input_transformations). */
export function readDrops(message: unknown): DropInfo | undefined {
  if (!isRecord(message) || !Array.isArray(message.diagnostics)) return undefined;
  let count = 0;
  const reasons = new Set<string>();
  const prefixIdx: number[] = [];
  let threadFallback = false;
  for (const diagnostic of message.diagnostics) {
    if (!isRecord(diagnostic)) continue;
    if (diagnostic.type === "anthropic_thread_fallback") threadFallback = true;
    if (diagnostic.type !== "anthropic_input_transformations" || !isRecord(diagnostic.details)) continue;
    const transformations = diagnostic.details.transformations;
    if (!Array.isArray(transformations)) continue;
    for (const item of transformations) {
      if (!isRecord(item) || item.type !== "thinking_dropped") continue;
      count++;
      const reason = typeof item.reason === "string" ? item.reason : "unknown";
      reasons.add(reason);
      const match = typeof item.path === "string" ? /^messages\.(\d+)\./.exec(item.path) : null;
      if (reason === "prefix_binding_mismatch" && match) prefixIdx.push(Number(match[1]));
    }
  }
  return count > 0 ? { count, reasons: [...reasons], prefixIdx, threadFallback } : undefined;
}

export interface Settings {
  enabled: boolean;
}

export function parseSettings(raw: unknown): Settings {
  return { enabled: isRecord(raw) && typeof raw.enabled === "boolean" ? raw.enabled : true };
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

const MAX_CHANGES = 200;
const MAX_SUSPECTS = 10;

export default function prefixAudit(pi: ExtensionAPI) {
  let settings: Settings = { enabled: true };
  let role: Role = "main";
  let prev: Snapshot | undefined;
  let seq = 0;
  let drops = 0;
  /** Request seq at which message i first appeared with its current content. */
  let firstSeen: number[] = [];
  let changes: Change[] = [];
  let logFile: string | undefined;

  const write = (ctx: ExtensionContext, record: Record<string, unknown>) => {
    try {
      if (!logFile) {
        const dir = nodePath.join(getAgentDir(), "prefix-audit");
        mkdirSync(dir, { recursive: true });
        logFile = nodePath.join(dir, `${ctx.sessionManager.getSessionId()}.jsonl`);
      }
      appendFileSync(logFile, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`);
    } catch {
      // diagnostics must never break a request
    }
  };

  pi.on("session_start", (_event, ctx) => {
    settings = parseSettings(readJson(nodePath.join(getAgentDir(), "prefix-audit.json")));
    role = detectRole(ctx.mode, ctx.hasUI);
    prev = undefined;
    seq = drops = 0;
    firstSeen = [];
    changes = [];
    logFile = undefined;
  });

  pi.on("before_provider_request", (event, ctx) => {
    try {
      if (!settings.enabled || ctx.model?.api !== "anthropic-messages" || !isRecord(event.payload)) return undefined;
      const snap = takeSnapshot(event.payload);
      seq++;
      let diffRecord: Diff | undefined;
      if (prev) {
        const result = diffSnapshots(prev, snap);
        if (result) {
          diffRecord = result.diff;
          for (const change of summarizeDiff(seq, result.diff, result.firstMutated)) changes.push(change);
          if (changes.length > MAX_CHANGES) changes = changes.slice(-MAX_CHANGES);
        }
      }
      // firstSeen: new or mutated messages restart at this request.
      const next: number[] = [];
      for (let i = 0; i < snap.messages.length; i++) {
        const same = prev !== undefined && i < prev.messages.length && prev.messages[i] === snap.messages[i];
        next[i] = same ? (firstSeen[i] ?? seq) : seq;
      }
      firstSeen = next;
      prev = snap;
      write(ctx, {
        type: "req",
        seq,
        role,
        model: ctx.model?.id,
        msgs: snap.messages.length,
        tools: snap.toolOrder.length,
        sys: sha(snap.system),
        ...(diffRecord ? { diff: diffRecord } : {}),
      });
    } catch {
      // never affect the request
    }
    return undefined;
  });

  pi.on("message_end", (event, ctx) => {
    try {
      if (!settings.enabled || event.message.role !== "assistant") return undefined;
      const info = readDrops(event.message);
      if (!info) return undefined;
      drops++;
      let suspects: Change[] = [];
      const first = info.prefixIdx.length ? Math.min(...info.prefixIdx) : undefined;
      if (first !== undefined) {
        const mintSeq = firstSeen[first] ?? 1;
        // Changes at or after the request in which the earliest dropped block first appeared.
        suspects = changes.filter((c) => c.seq >= mintSeq).slice(-MAX_SUSPECTS);
      }
      write(ctx, {
        type: "drop",
        seq,
        role,
        count: info.count,
        reasons: info.reasons,
        firstIdx: first,
        lastIdx: info.prefixIdx.length ? Math.max(...info.prefixIdx) : undefined,
        threadFallback: info.threadFallback,
        suspects,
      });
      if (ctx.hasUI && first !== undefined) {
        const text = suspects.length
          ? suspects.map((c) => `#${c.seq} ${c.summary}`).join(" | ")
          : info.threadFallback
            ? "no change seen; thread was replayed in full (thread_fallback)"
            : "no change seen in system/tools/messages between requests";
        ctx.ui.notify(`prefix-audit: ${info.count} dropped (${info.reasons.join(",")}); ${text}`, "info");
      }
    } catch {
      // never affect the session
    }
    return undefined;
  });

  pi.registerCommand("prefix-audit", {
    description: "Show what changed in system/tools/earlier messages between requests (prefix_binding_mismatch hunt)",
    handler: async (_args, ctx) => {
      const lines = [
        `prefix-audit: ${settings.enabled ? "enabled" : "disabled (config)"}, session = ${role}`,
        `requests seen: ${seq}, drop events: ${drops}, changes recorded: ${changes.length}`,
        `log: ${logFile ?? "(nothing written yet)"}`,
      ];
      const last = changes.slice(-5);
      if (last.length) lines.push("last changes:", ...last.map((c) => `  #${c.seq} ${c.summary}`));
      else lines.push("no change between requests so far");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
