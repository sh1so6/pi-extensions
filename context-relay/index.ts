/**
 * context-relay: a deterministic "pseudo new session" instead of LLM-summarizing compaction.
 * Place the folder in ~/.pi/agent/extensions/context-relay/ and run /reload. See README.md.
 *
 * /relay compacts the main session through Pi's compaction pipeline, but session_before_compact supplies the
 * result: summary = a deterministic hand-off note (note.ts), firstKeptEntryId = the latest user message, so the
 * model context becomes system + note + the latest exchange. Older raw entries stay in the session file and are
 * searchable with the `recall` tool (recall.ts). Subagent / headless sessions: this extension does nothing.
 *
 * Automatic triggers (M2, config `auto` in context-relay.json):
 *   A. `input`: a new user message arrives while the context is big -> hold the message ({ action: "handled" }), relay,
 *      then re-send the message exactly once (also when the relay fails: the user's message is never lost).
 *   B. cache expiry: when the session settles, a timer fires 20 s before the prompt cache expires and relays if the
 *      context is big (the next turn would re-write the whole prefix anyway). No message to re-send.
 *   Every relay appends a line to <agentDir>/context-relay/log.jsonl.
 *   Held input is preceded by a `context-relay:resend` audit entry in the session file (audit.ts), so an
 *   outside reader (e.g. an RPC client) can pair the re-sent run with the prompt that was held instead of
 *   guessing from timestamps. A relay adds exactly one entry otherwise: the compaction entry itself.
 *
 * Seams:
 *   M3 (LLM-written section): pass `hooks.extraSections` to createContextRelay; the sections are appended to the
 *       note (capped by limits.extra) before the footer.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { type AutoConfig, appendRelayLog, cacheExpiry, formatTokens, parseAuto, type RelayLogRecord } from "./auto.ts";
import { RESEND_ENTRY_TYPE, buildResendRecord } from "./audit.ts";
import { isSubagentSession } from "./detect.ts";
import { type Entry, applyContextEdits } from "./entries.ts";
import { collectGit } from "./git.ts";
import { type Limits, NOTE_VERSION, type NoteSection, buildNote, pickFirstKept, subagentWorktrees } from "./note.ts";
import { currentSource, readAncestors, readNoteFiles, recall } from "./recall.ts";

/** Private marker passed as customInstructions so session_before_compact can tell a relay from a normal compaction. */
export const RELAY_MARKER = "\u0001context-relay:v1\u0001";

export interface Config {
  enabled: boolean;
  tailMaxChars: number;
  gitTimeoutMs: number;
  limits: Partial<Limits>;
  auto: AutoConfig;
}

/** Optional ~/.pi/agent/context-relay.json, read on every use. */
export function loadConfig(agentDir = getAgentDir()): Config {
  let raw: Partial<Config> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(agentDir, "context-relay.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Partial<Config>;
  } catch {
    // no config: defaults
  }
  return { enabled: raw.enabled !== false, tailMaxChars: raw.tailMaxChars ?? 48000, gitTimeoutMs: raw.gitTimeoutMs ?? 4000, limits: raw.limits ?? {}, auto: parseAuto((raw as { auto?: unknown }).auto) };
}

export interface RelayHooks {
  /** M3 seam: extra note sections (e.g. an LLM-written one). Failures are ignored. */
  extraSections?: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<NoteSection[]>;
  /** How long before the cache expires the expiry trigger fires (default 20 s; tests use a small value). */
  expiryLeadMs?: number;
}

type Trigger = RelayLogRecord["trigger"];
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
interface PendingInput {
  text: string;
  images?: ImageContent[];
}

export interface StartRelayOptions {
  onComplete?: (result: CompactionResult) => void;
  onError?: (error: Error) => void;
}

export function notesDir(sessionId: string, agentDir = getAgentDir()): string {
  return path.join(agentDir, "context-relay", sessionId);
}

function nextNoteNumber(dir: string): number {
  try {
    const nums = readdirSync(dir).flatMap((f) => (/^(\d+)\.md$/.test(f) ? [Number.parseInt(f, 10)] : []));
    return nums.length ? Math.max(...nums) + 1 : 1;
  } catch {
    return 1;
  }
}

export function createContextRelay(hooks: RelayHooks = {}) {
  return function contextRelay(pi: ExtensionAPI): void {
    let inFlight = false;

    /** Compact the session as a relay. Returns false (and does nothing) when one is already running. */
    function startRelay(ctx: ExtensionContext, options: StartRelayOptions = {}): boolean {
      if (inFlight) return false;
      inFlight = true;
      ctx.compact({
        customInstructions: RELAY_MARKER,
        onComplete: (result) => {
          inFlight = false;
          options.onComplete?.(result);
        },
        onError: (error) => {
          inFlight = false;
          options.onError?.(error);
        },
      });
      return true;
    }

    // ---- M2: automatic triggers -------------------------------------------------------------------------------------
    /** Auto settings of this session; undefined = inactive (subagent / headless / disabled). Read on session_start. */
    let auto: AutoConfig | undefined;
    /** Bumped on session_start / session_shutdown: a relay finishing for an older session must not touch the new one. */
    let generation = 0;
    /** User messages that arrived while a relay was running; sent (merged, in order) when it ends. */
    let held: PendingInput[] = [];
    let relayGeneration = -1;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    /** Context size right after the last relay (growth guard against relay loops). */
    let tokensAfterLastRelay: number | undefined;
    const expiryLeadMs = hooks.expiryLeadMs ?? 20_000;

    const safe = <T>(fn: () => T): T | undefined => {
      try {
        return fn();
      } catch {
        return undefined; // stale ctx after a session switch
      }
    };
    const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => void safe(() => ctx.ui.notify(message, level));
    /** Best-effort audit entry (audit.ts); never let bookkeeping break a relay or a re-send. */
    const appendAudit = (customType: string, data: Record<string, unknown>) => void safe(() => pi.appendEntry(customType, data));
    const contextTokens = (ctx: ExtensionContext): number | undefined => safe(() => ctx.getContextUsage()?.tokens) ?? undefined;
    const cancelExpiryTimer = () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = undefined;
    };
    /** Big enough to be worth relaying, and not just relayed. */
    const worthRelaying = (tokens: number | undefined, minTokens: number): tokens is number =>
      tokens !== undefined && tokens >= minTokens && (tokensAfterLastRelay === undefined || tokens >= tokensAfterLastRelay + (auto?.minGrowthTokens ?? 0));

    /** Send the user messages held during a relay as ONE user message (same text/images, same order). */
    function releaseHeld(ctx: ExtensionContext, gen: number, pending = held, trigger?: Trigger): void {
      // Each completion owns its array: an old callback must never drain a newer session's input.
      const items = pending.splice(0);
      if (pending === held) held = [];
      if (items.length === 0) return;
      if (gen !== generation) {
        if (!isSubagentSession(ctx)) {
          const text = items.map((i) => i.text).join("\n\n");
          safe(() => ctx.ui.setEditorText([text, ctx.ui.getEditorText()].filter(Boolean).join("\n\n")));
          const images = items.reduce((n, i) => n + (i.images?.length ?? 0), 0);
          if (images) notify(ctx, `context-relay: restored held text; reattach ${images} image(s) after the session change.`, "warning");
        }
        return;
      }
      const text = items.map((i) => i.text).join("\n\n");
      const images = items.flatMap((i) => i.images ?? []);
      // Correlation marker (audit.ts): the user entry written by the re-send is the next one after this.
      if (trigger) appendAudit(RESEND_ENTRY_TYPE, buildResendRecord({ at: new Date().toISOString(), trigger, items }));
      // A background notification (triggerTurn) or the TUI's compaction queue may already have
      // started a run. Without deliverAs Pi rejects the resend and silently loses the held input.
      // followUp is also valid when idle, and preserves exactly-once delivery in either state.
      pi.sendUserMessage(images.length ? [{ type: "text", text }, ...images] : text, { deliverAs: "followUp" });
    }

    /**
     * Relay with logging, notification and release of held input. `first` = the message that triggered it (re-sent
     * after completion, also on failure). Returns false when a relay is already running.
     */
    function runRelay(ctx: ExtensionContext, trigger: Trigger, first?: PendingInput): boolean {
      if (inFlight) return false;
      const gen = generation;
      relayGeneration = gen;
      const pending = first ? [first] : [];
      const tokensBefore = contextTokens(ctx) ?? null;
      const sessionId = ctx.sessionManager.getSessionId();
      const finish = (result: CompactionResult | undefined, error?: Error) => {
        appendRelayLog(getAgentDir(), {
          at: new Date().toISOString(),
          sessionId,
          trigger,
          tokensBefore: result?.tokensBefore ?? tokensBefore,
          noteChars: result?.summary.length,
          keptFrom: result?.firstKeptEntryId,
          ok: !!result,
          error: error?.message,
        });
        if (gen !== generation) {
          releaseHeld(ctx, gen, pending);
          return; // old results may be logged, but must not update or notify the new session
        }
        tokensAfterLastRelay = result?.estimatedTokensAfter;
        if (trigger === "manual") {
          notify(ctx, result ? `context-relay: done (${result.tokensBefore} → ~${result.estimatedTokensAfter ?? "?"} tokens). Note: ${(result.details as { notePath?: string } | undefined)?.notePath ?? "?"}` : `context-relay: ${error?.message}`, result ? "info" : "error");
        } else if (result) {
          notify(ctx, `context-relay: auto relay (${trigger === "input" ? "new message" : "cache expiry"}) ${formatTokens(result.tokensBefore)} → ~${formatTokens(result.estimatedTokensAfter)} tokens`);
        } else {
          notify(ctx, `context-relay: auto relay (${trigger}) failed: ${error?.message}${pending.length ? " — your message is sent anyway." : ""}`, "warning");
        }
        releaseHeld(ctx, gen, pending, trigger);
      };
      held = pending;
      return startRelay(ctx, { onComplete: (r) => finish(r), onError: (e) => finish(undefined, e) });
    }

    pi.on("input", (event, ctx) => {
      if (!auto || event.source === "extension" || isSubagentSession(ctx)) return { action: "continue" };
      const message: PendingInput = { text: event.text, ...(event.images?.length ? { images: event.images as ImageContent[] } : {}) };
      if (inFlight) {
        if (relayGeneration !== generation) return { action: "continue" };
        // arrived between a relay's start and Pi's compaction guard (or right after it): hold, send afterwards
        held.push(message);
        return { action: "handled" };
      }
      if (!auto.onInput || event.streamingBehavior || !ctx.isIdle()) return { action: "continue" };
      if (event.text.startsWith("/") || (!event.text.trim() && !event.images?.length)) return { action: "continue" };
      if (!worthRelaying(contextTokens(ctx), auto.inputMinTokens)) return { action: "continue" };
      return runRelay(ctx, "input", message) ? { action: "handled" } : { action: "continue" };
    });

    function armExpiryTimer(ctx: ExtensionContext): void {
      cancelExpiryTimer();
      if (!auto?.beforeExpiry || isSubagentSession(ctx)) return;
      const expiry = safe(() => cacheExpiry(ctx.sessionManager.getBranch(), ctx.model));
      if (!expiry || expiry.expiresAt <= Date.now()) return;
      const gen = generation;
      expiryTimer = setTimeout(() => {
        expiryTimer = undefined;
        if (gen !== generation || !auto) return;
        const again = safe(() => cacheExpiry(ctx.sessionManager.getBranch(), ctx.model)); // e.g. a cache warmer refreshed it meanwhile
        if (!again || again.expiresAt - expiryLeadMs > Date.now() + 1000) return armExpiryTimer(ctx);
        if (inFlight || safe(() => !ctx.isIdle() || ctx.hasPendingMessages())) return;
        if (!worthRelaying(contextTokens(ctx), auto.expiryMinTokens)) return;
        runRelay(ctx, "expiry");
      }, Math.max(0, expiry.expiresAt - expiryLeadMs - Date.now()));
      expiryTimer.unref?.();
    }

    pi.on("agent_start", () => cancelExpiryTimer());
    pi.on("session_compact", () => cancelExpiryTimer());
    pi.on("agent_settled", (_event, ctx) => armExpiryTimer(ctx));
    pi.on("session_shutdown", (_event, ctx) => {
      generation++;
      cancelExpiryTimer();
      releaseHeld(ctx, generation - 1);
    });

    pi.on("session_before_compact", async (event, ctx) => {
      if (event.customInstructions !== RELAY_MARKER || isSubagentSession(ctx)) return undefined; // not ours: Pi's default runs
      try {
        if (event.signal?.aborted) return { cancel: true };
        const config = loadConfig();
        // the model-visible branch: context_edit omissions/replacements (e.g. redacted user text) must not come back via the note
        const entries = applyContextEdits(event.branchEntries as Entry[]);
        const firstKeptEntryId = pickFirstKept(entries, event.preparation.firstKeptEntryId, config.tailMaxChars);
        const sessionId = ctx.sessionManager.getSessionId();
        const dir = notesDir(sessionId);
        const index = nextNoteNumber(dir);
        const notePath = path.join(dir, `${index}.md`);
        const sessionStart = ctx.sessionManager.getHeader()?.timestamp;
        const git = await collectGit(ctx.cwd, sessionStart, subagentWorktrees(entries), { timeoutMs: config.gitTimeoutMs });
        let extraSections: NoteSection[] = [];
        try {
          extraSections = (await hooks.extraSections?.(event, ctx)) ?? [];
        } catch {
          // optional section: ignore
        }
        if (event.signal?.aborted) return { cancel: true }; // aborted while collecting: leave no note file behind
        const note = buildNote({ entries, firstKeptEntryId, index, sessionId, sessionStart, cwd: ctx.cwd, notePath, git, extraSections, limits: config.limits });
        mkdirSync(dir, { recursive: true });
        writeFileSync(notePath, note, "utf8");
        return {
          compaction: {
            summary: note,
            firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: { relay: true, version: NOTE_VERSION, notePath },
          },
        };
      } catch (error) {
        ctx.ui.notify(`context-relay: could not build the note, relay cancelled (${error instanceof Error ? error.message : error})`, "error");
        return { cancel: true };
      }
    });

    pi.on("session_start", async (_event, ctx) => {
      generation++;
      cancelExpiryTimer();
      releaseHeld(ctx, generation - 1);
      tokensAfterLastRelay = undefined;
      const config = loadConfig();
      auto = isSubagentSession(ctx) || !config.enabled ? undefined : config.auto;
      if (isSubagentSession(ctx) || !config.enabled) return;

      pi.registerCommand("relay", {
        description: "Replace the context with a deterministic hand-off note + the latest exchange (details stay available via recall)",
        handler: async (_args, cmdCtx) => {
          if (isSubagentSession(cmdCtx)) return;
          if (!cmdCtx.isIdle()) {
            cmdCtx.ui.notify("context-relay: the agent is busy — run /relay when the turn has ended.", "warning");
            return;
          }
          const started = runRelay(cmdCtx, "manual");
          if (!started) cmdCtx.ui.notify("context-relay: a relay is already running.", "warning");
        },
      });

      pi.registerTool({
        name: "recall",
        label: "Recall",
        description:
          "Look up older conversation details that were removed from context by a relay/compaction (tool outputs, files read, earlier turns). " +
          "Pass EITHER query OR entryId (entryId wins if both). recall({query, limit?}) = case-insensitive AND search → entryIds + snippets. recall({entryId, offset?}) = full text of one entry. scope:'lineage' also searches parent sessions.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search terms (all must match)" },
            limit: { type: "number", description: "Max hits, 1-30 (default 8); clamped" },
            entryId: { type: "string", description: "Read this entry in full (from a search hit or note:<n>)" },
            offset: { type: "number", description: "Char offset when reading a long entry (>= 0; clamped)" },
            scope: { type: "string", enum: ["session", "lineage"], description: "session (default) or lineage (+ parent sessions)" },
          },
        },
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const sm = ctx.sessionManager;
          const dir = notesDir(sm.getSessionId());
          const sources = [currentSource(sm.getBranch() as Entry[], readNoteFiles(dir))];
          if ((params as { scope?: string }).scope === "lineage") sources.push(...readAncestors(sm.getHeader()?.parentSession, 4, (id) => notesDir(id)));
          const text = recall(sources, params as Parameters<typeof recall>[1]);
          return { content: [{ type: "text", text }], details: {} };
        },
      });
    });
  };
}

export default createContextRelay();
