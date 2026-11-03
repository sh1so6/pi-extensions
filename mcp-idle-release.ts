/**
 * mcp-idle-release: stop idle MCP stdio server processes to free memory/CPU.
 * Place in ~/.pi/agent/extensions/mcp-idle-release.ts and run /reload.
 *
 * Pi's built-in MCP client reconnects lazily: when a stdio server process exits, the
 * connection becomes "disconnected", its tools stay registered, and the next call to one
 * of them spawns the server again. This extension relies on that: it tracks when each
 * stdio server was last used and kills the process tree of servers that have been idle
 * longer than the threshold. Nothing in Pi is patched; HTTP servers are never touched.
 *
 * Usage is tracked from tool_execution_start/end (MCP tools `mcp__<server>__<tool>`,
 * the resource tools with their `server` argument, and calls nested in codemode scripts).
 * While a `codemode` or `tool_search` call is running, every server counts as busy.
 *
 * Optional config ~/.pi/agent/mcp-idle-release.json (read on every session start):
 *   {
 *     "enabled": true,              // default true
 *     "idleMinutes": 10,            // default 10; 0 = never release
 *     "checkIntervalSeconds": 30,   // default 30 (min 5)
 *     "notify": true,               // one-line UI notice (for the user) after each idle release
 *     "exclude": ["server-name"],   // never released
 *     "servers": {
 *       "name": {
 *         "idleMinutes": 5,          // per-server threshold (0 = never)
 *         "respawnNote": "",         // extra line for the AI's respawn / block notice
 *         "respawnPolicy": "notify", // "notify" (default) | "block"
 *         "passThrough": ["tool"]    // never blocked: bare tool names, full mcp__ names, `*` glob
 *       }
 *     }
 *   }
 *
 * Respawn notice (what the AI is told): never when a server is stopped, only on the first call that
 * reaches it afterwards (tool_call + tool_result handlers; they also run for calls nested in
 * codemode scripts, see agent-session.js _executeNestedToolCall). The notice reads e.g.
 *   [mcp-idle] unityMCP は 17:20 にアイドル停止され、この呼び出しで再起動しました（再起動を含むこの呼び出しの所要 3.4 秒）。メモリ上の状態は初期化されています。
 *   <respawnNote>
 * HH:MM is the local release time. The duration is tool_call → tool_result of that call, so it
 * includes the server's cold start AND the tool's own work (Pi does not expose the reconnect).
 *   - Model-issued call: one text block appended to the result content; structuredContent is passed
 *     through (with the notice under `_meta.mcpIdleRelease.notice`).
 *   - Call from a codemode script: the script receives the MCP CallToolResult (Pi's structuredContent).
 *     Its `content` is left untouched (scripts that parse `content[0].text` or join the text keep
 *     working); the notice is added as `_meta.mcpIdleRelease.notice`. The notice is ALSO appended as an
 *     own text block to the codemode call's own result (the model-issued root), so the AI sees it whatever
 *     the script does with the nested result (swallows the error, returns another value, prints a
 *     JSON.stringify'd or truncated copy). That block is deduplicated per line: a line the script's
 *     output already shows (verbatim or JSON-escaped, once or twice) or that an earlier notice in the
 *     block already carries (e.g. a long respawnNote) is left out; a notice keeps its heading line while
 *     any of its lines is still unseen, and is omitted whole when all its lines are visible (nothing
 *     is appended then). A line cut short (`.slice(0, n)`) counts as unseen, so it is shown again.
 *   - A call that throws (no structuredContent, isError: e.g. the respawn failed) does not consume the
 *     notice; the next call carries it. A script that ended before its call returned (cancelled) does
 *     not either: the next call says "その後再起動されました" without a duration.
 * respawnPolicy "block": the first call after a release is NOT executed (tool_call returns
 *   { block, reason }, so the server is not respawned by it). The AI gets the reason as an error tool
 *   result; inside a script the call's promise rejects with Error(reason) (and the reason is appended to
 *   the codemode result as above, in case the script swallows the error). Only one call is refused per
 *   release: retrying the same call (also from a catch in the same script) runs it. passThrough tools are
 *   never refused; they respawn the server and get the notify-style notice, and a successful one clears
 *   the pending block. A passThrough that fails at app level (isError, or `success: false` in the server
 *   payload / its JSON text: unityMCP reports "Instance not found" with isError false) still gets the
 *   notice (the server did respawn) plus a line saying the setup failed, and re-arms the block: the next
 *   other call to that server is refused once more, with a reason naming the failed tool; a retry of it
 *   then runs, and a successful passThrough clears it. The "respawned" notice is never repeated.
 *   A resource listing without `server` may respawn released servers unseen; the next call then gets
 *   the "その後再起動されました" wording.
 * Not supported: re-running remembered tool calls after a respawn ("replayTools"): event handlers get no
 * executeTool() and ToolInfo carries no execute(), so it would need Pi internals; it is reported as a
 * config error and ignored. Describe the steps in respawnNote instead.
 * Pending notices are dropped on session start (/reload, /new, resume): Pi reconnects every server then.
 *
 * Unexpected exit (a server process that ends without this extension stopping it: crash, killed from
 * outside, /mcp "Reconnect"): Pi reconnects lazily here too (pi-mcp: the stdio transport only watches the
 * direct child; when it ends and its pipes close, every in-flight call fails at once with "MCP connection
 * closed" and the connection becomes "disconnected"; the next call reconnects), so the in-memory state is
 * lost silently. It is handled like an idle stop (respawnPolicy notify / block, passThrough, respawnNote,
 * the root codemode result), worded "予期せず終了" with the possible causes.
 *   - Detection: the direct child (root) of each server copy is remembered (pid + creation time) from the
 *     process lists that are fetched anyway (idle pass, /mcp-idle status, release) and from one learning
 *     enumeration per check interval at most, only while a session expects a copy whose pid is unknown
 *     (session start, after a respawn; a group that stays short of copies is not retried for 10 min).
 *     On every tool_call to the server (the main path: otherwise Pi would respawn it silently before the
 *     next tick) and on every tick, each remembered root gets a kill(pid, 0): ESRCH = gone, EPERM = alive
 *     (about 3 µs per live process, nothing when no pid is remembered). A known pid whose creation time
 *     changed on a later listing is a reused pid = exit. A call that fails with Pi's own "MCP connection
 *     closed" error (no structuredContent) is an exit even when no pid was known.
 *   - Only the root counts, not the rest of the tree (uvx shim → python …): Pi's transport sees an end only
 *     when the root has ended, so a dead leaf under a living shim is not a reconnect (calls just time out).
 *   - Not an exit: kills issued by this extension (the pid is flagged BEFORE the kill is issued, and kept in a
 *     2 min tombstone list), a session that leaves (session_shutdown / disposed) and mcp_servers_change (the
 *     remembered pids of the key are dropped and not learned for max(check interval, 15 s)), session start.
 *     After an own kill the "connection closed" signal of that key is ignored for 10 s (calls that were running
 *     on the stopped server fail that way).
 *   - Who is told: Pi cannot say which session's connection a pid belonged to, so every session that expects a
 *     running copy of that command line gets the notice / block once (one block more than necessary is
 *     accepted; the wording says it may not be this session's server). The number of copies a release expects
 *     (E) is unchanged; while such a notice is still pending, a count mismatch (M ≠ E) is not warned about or
 *     parked. A pending exit and an idle stop merge into one notice worded as an exit. A call that dies again
 *     while it respawns the server keeps the pending notice for the next call (as for idle stops).
 *   - Limits: a copy whose pid was never learned (a crash within one interval after start / respawn) is only
 *     seen when a call fails with the connection-closed error (not within 10 s of an own kill);
 *     kill(pid, 0) on Windows may still succeed for an exited process while some handle to it is open (the
 *     exit is then noticed later, by the connection-closed error or a listing); a reused pid with the same creation time
 *     (or none, on non-Windows lists) is not noticed; /mcp → Reconnect looks like an exit (the state is
 *     reset, so the notice is true; only the cause is a guess); the exit time shown is when it was noticed.
 *
 * /mcp-idle                  status table (state, idle time, threshold, pid, memory of the whole tree)
 * /mcp-idle release <server> stop that server now (refused while it is in use)
 * /mcp-idle off | on         disable / enable for this session
 * /mcp-idle minutes <n>      default threshold for this session
 *
 * on/off/minutes only affect the current session (not saved); edit the JSON file to persist.
 *
 * Caveats: releasing a server discards its in-memory state (browser pages of a Playwright
 * server, sessions, caches); put such servers in "exclude". The kill is forced (taskkill /T /F
 * on Windows, SIGTERM to the process group elsewhere). The first call after a release pays the
 * server's cold start (npx/uvx can take seconds).
 *
 * Process discovery: only direct children of the Pi process are considered
 * (Windows: Win32_Process via PowerShell/CIM, ~0.5 s, otherwise `ps`), run asynchronously and only
 * when a server is due. `/mcp-idle` status runs one query of ALL processes instead and sums the
 * working set of each server's whole process tree (uvx → python …; shared pages counted per process).
 * The periodic check keeps the filtered children-only query.
 *
 * Several sessions in one process (shared registry): in-process subagent sessions
 * (npm:@tintinweb/pi-subagents, `extensions: true` by default) load Pi's MCP extension and this one again,
 * so every session starts its own copy of each stdio server under the same Pi process, with the same
 * command line. Pi does not tell extensions which pid belongs to which session's connection, so the
 * instances coordinate through one registry per process (globalThis[Symbol.for("mcp-idle-release.registry.v1")];
 * each session may load its own copy of this module). An instance joins on session_start and leaves on
 * session_shutdown; a session whose ctx went stale (disposed) is pruned on the next walk. pi-subagents keeps
 * a finished child session (and its server copies) until its record is removed (10 min after completion,
 * at session boundaries, or on quit) and emits session_shutdown to it then; until that, the child counts
 * as a participant that is idle, so the copies are released together once the threshold has passed.
 *   - Servers are grouped by their command line as the matcher sees it (identityKey; names may differ
 *     between sessions). A session "expects" a running copy from its start (Pi connects every enabled
 *     server eagerly) and again from its next call after a release; not after a release or when no copy
 *     was found.
 *   - A group is due only when EVERY live session using it is idle: enabled, no codemode/tool_search
 *     running, no call to it in flight, idle for its own threshold (exclude / 0 in any session = never).
 *     An in-flight count is treated as stale (cleared) when that session has no agent run active
 *     (ctx.isIdle()) and no tool event for STALE_INFLIGHT_MS (2 min); a disposed session is dropped.
 *   - Every instance keeps its timer, but a pass that enumerates runs only when no other pass holds the
 *     registry lock and the last one started ≥ 90 % of the interval ago: one enumeration per interval
 *     for all sessions together. The lock is released in finally; one older than LOCK_TIMEOUT_MS (90 s)
 *     is taken over.
 *   - Per due group: M = matching children, E = sessions expecting a copy. M === E ≥ 1: the group is
 *     re-checked, all M kills are issued and every expecting session is marked released, in one
 *     synchronous turn; each of them gets its own respawn notice / block on its next call. M === 0: not
 *     running, skipped silently. Otherwise (a copy of a session without this extension, or one that died
 *     on its own) nothing is killed: one warning, and the group is not enumerated again until one of its
 *     sessions changes (or after 10 min). If every kill fails, the marks no call acted on are undone.
 *   - A session that leaves (session_shutdown) closes its copies asynchronously afterwards, so its keys
 *     are not judged for max(check interval, UNREGISTER_GRACE_MS = 15 s) (skipped silently, no park,
 *     no warning), and a parked key is un-parked (re-evaluated after the grace).
 *   - A call that starts while the processes are being killed already sees the release: it respawns the
 *     server (Pi reconnects) and carries the notice; one that fails on the dying connection leaves the
 *     notice to the next call.
 *   - The one-line UI notice comes from the session with a UI (the top-level session) only.
 *   - /mcp-idle release <server> follows the same M === E rule and is refused while any session is
 *     using the server ("サブエージェントのセッション（n 件）が使用中"). /mcp-idle shows per server
 *     "sessions: using / expecting a copy".
 *   Limitations: a copy started by a session that does not load this extension is only detected when the
 *   counts differ; if such a copy happens to make up for one that died on its own (M === E), it is killed
 *   as if it were ours. A session whose server failed to start still "expects" a copy until its next call
 *   (M < E: skipped with the warning). If only some of the kills fail, the sessions stay marked released
 *   (their next call gets a notice, possibly needlessly) and the surviving copy is not released again
 *   automatically (nobody expects it; once a session respawns its own, it counts as a foreign copy).
 */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RespawnPolicy = "notify" | "block";

export type ServerSettings = {
  idleMinutes?: number;
  /** Extra line appended to the respawn / block notice the AI sees. */
  respawnNote?: string;
  /** "notify" (default): annotate the first call after a release; "block": refuse it once. */
  respawnPolicy?: RespawnPolicy;
  /** Tools never blocked by "block" (bare server tool names, full `mcp__…` names, `*` glob). */
  passThrough?: string[];
};

export type Settings = {
  enabled: boolean;
  idleMinutes: number;
  checkIntervalSeconds: number;
  notify: boolean;
  exclude: string[];
  servers: Record<string, ServerSettings>;
};

/** A configured stdio MCP server (url servers are never included). */
export type StdioServer = { name: string; command: string; args: string[] };

/**
 * A process (usually a direct child of Pi). `created`/`memory` are optional (ms epoch / bytes).
 * `treeMemory`/`treeCount`: working set sum / number of processes of the whole tree rooted here.
 */
export type ChildProc = {
  pid: number;
  commandLine: string;
  memory?: number;
  created?: number;
  ppid?: number;
  treeMemory?: number;
  treeCount?: number;
};

export type ServerStatus = "running" | "released" | "absent" | "ambiguous";

/** A release the AI has not been told about yet (cleared by the call that sees the notice). */
export type RespawnPending = {
  /** When it was stopped ("exit": when the exit was noticed, not when it happened). */
  releasedAt: number;
  /** "exit": the server process ended without this extension stopping it (crash, killed from outside). */
  reason: "idle" | "manual" | "exit";
  /** "block" policy: the one refused call already happened. */
  blocked: boolean;
  /** The call that will respawn the server and carry the notice, and when its tool_call ran. */
  claimedBy?: string;
  claimedAt?: number;
  /** Respawned already by a call whose result nobody sees (cancelled script, list-all resource call). */
  respawnedUnseen?: boolean;
  /**
   * "block" policy: the respawn notice was delivered, but the passThrough call that carried it (or a
   * later one) failed at app level (see isAppLevelFailure), so only the block is still pending.
   */
  noticeDelivered?: boolean;
  /** Bare name of that failed passThrough tool (worded into the block reason). */
  failedPassThrough?: string;
};

export type ServerTrack = {
  lastUse: number;
  inflight: number;
  status: ServerStatus;
  releasedAt?: number;
  /** Released by this extension at least once this session (absence is then expected). */
  everReleased?: boolean;
  respawn?: RespawnPending;
};

/** Minimal shape of pi.getAllTools() entries that the mapping needs. */
export type ToolInfoLike = { name: string; namespace?: { name: string; aliases?: readonly string[] } };

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  idleMinutes: 10,
  checkIntervalSeconds: 30,
  notify: true,
  exclude: [],
  servers: {},
};

const MIN_CHECK_SECONDS = 5;
const CODEMODE_TOOLS = new Set(["codemode", "tool_search"]);
const RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
const ENUM_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Validate ~/.pi/agent/mcp-idle-release.json; invalid fields fall back to defaults and are reported. */
export function parseSettings(raw: unknown): { settings: Settings; errors: string[] } {
  const settings: Settings = { ...DEFAULT_SETTINGS, exclude: [], servers: {} };
  const errors: string[] = [];
  if (raw === undefined) return { settings, errors };
  if (!isRecord(raw)) return { settings, errors: ["root must be a JSON object"] };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") settings.enabled = raw.enabled;
    else errors.push("enabled must be a boolean");
  }
  if (raw.notify !== undefined) {
    if (typeof raw.notify === "boolean") settings.notify = raw.notify;
    else errors.push("notify must be a boolean");
  }
  if (raw.idleMinutes !== undefined) {
    if (isMinutes(raw.idleMinutes)) settings.idleMinutes = raw.idleMinutes;
    else errors.push("idleMinutes must be a number >= 0");
  }
  if (raw.checkIntervalSeconds !== undefined) {
    const value = raw.checkIntervalSeconds;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      settings.checkIntervalSeconds = Math.max(MIN_CHECK_SECONDS, value);
    } else errors.push("checkIntervalSeconds must be a number > 0");
  }
  if (raw.exclude !== undefined) {
    if (Array.isArray(raw.exclude) && raw.exclude.every((item) => typeof item === "string")) {
      settings.exclude = [...(raw.exclude as string[])];
    } else errors.push("exclude must be an array of strings");
  }
  if (raw.servers !== undefined) {
    if (!isRecord(raw.servers)) errors.push("servers must be an object");
    else {
      for (const [name, value] of Object.entries(raw.servers)) {
        if (!isRecord(value)) {
          errors.push(`servers.${name} must be an object`);
          continue;
        }
        const entry: ServerSettings = {};
        const before = errors.length;
        if (value.idleMinutes !== undefined) {
          if (isMinutes(value.idleMinutes)) entry.idleMinutes = value.idleMinutes;
          else errors.push(`servers.${name}.idleMinutes must be a number >= 0`);
        }
        if (value.respawnNote !== undefined) {
          if (typeof value.respawnNote === "string") {
            if (value.respawnNote.trim()) entry.respawnNote = value.respawnNote.trim();
          } else errors.push(`servers.${name}.respawnNote must be a string`);
        }
        if (value.respawnPolicy !== undefined) {
          if (value.respawnPolicy === "notify" || value.respawnPolicy === "block") entry.respawnPolicy = value.respawnPolicy;
          else errors.push(`servers.${name}.respawnPolicy must be "notify" or "block"`);
        }
        if (value.passThrough !== undefined) {
          if (Array.isArray(value.passThrough) && value.passThrough.every((item) => typeof item === "string")) {
            entry.passThrough = (value.passThrough as string[]).filter((item) => item.trim() !== "");
          } else errors.push(`servers.${name}.passThrough must be an array of strings`);
        }
        if (value.replayTools !== undefined) {
          errors.push(`servers.${name}.replayTools is not supported (ignored); describe the steps in respawnNote instead`);
        }
        // An entry whose only fields were invalid is dropped (as before), otherwise its valid fields apply.
        if (errors.length === before || Object.keys(entry).length > 0) settings.servers[name] = entry;
      }
    }
  }
  return { settings, errors };
}

/**
 * Idle threshold of `server` in ms; 0 means never release. Order: exclude > per-server >
 * session default (`/mcp-idle minutes`) > config default.
 */
export function idleThresholdMs(settings: Settings, server: string, sessionMinutes?: number): number {
  if (settings.exclude.includes(server)) return 0;
  const own = settings.servers[server]?.idleMinutes;
  const minutes = own ?? sessionMinutes ?? settings.idleMinutes;
  return minutes > 0 ? Math.round(minutes * 60_000) : 0;
}

export function respawnPolicy(settings: Settings, server: string): RespawnPolicy {
  return settings.servers[server]?.respawnPolicy ?? "notify";
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/**
 * Whether the pi tool `toolName` of `server` is in its `passThrough` list. Entries are bare server
 * tool names (`set_active_instance`) or full pi names (`mcp__unityMCP__set_active_instance`); `*`
 * matches any characters. Names are compared after Pi's sanitizing (`[^A-Za-z0-9_]` → `_`).
 */
export function isPassThrough(settings: Settings, server: string, toolName: string): boolean {
  const list = settings.servers[server]?.passThrough;
  if (!list || list.length === 0) return false;
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_*]/g, "_");
  return list.some((entry) => {
    const full = entry.startsWith("mcp__") ? entry : `mcp__${server}__${entry}`;
    return globToRegExp(sanitize(full)).test(toolName);
  });
}

/** Local wall-clock time `HH:MM`. */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The server tool name inside a pi MCP tool name (`mcp__<server>__<tool>` → `<tool>`). */
export function bareToolName(toolName: string, server: string): string {
  const prefix = `mcp__${server}__`.replace(/[^A-Za-z0-9_]/g, "_");
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

const NOTICE_PREFIX = "[mcp-idle]";

function stoppedPhrase(server: string, pending: RespawnPending): string {
  if (pending.reason === "exit") return `${server} は ${formatClock(pending.releasedAt)} までに予期せず終了`;
  const how = pending.reason === "manual" ? " /mcp-idle release で停止" : "アイドル停止";
  return `${server} は ${formatClock(pending.releasedAt)} に${how}`;
}

/** Passive ending that follows stoppedPhrase: `され` / `されたため` (stopped here), `し` / `したため` (exited). */
function stoppedVerb(pending: RespawnPending, because = false): string {
  if (pending.reason === "exit") return because ? "したため" : "し";
  return because ? "されたため" : "され";
}

/**
 * Added to the notices of an unexpected exit. Pi cannot tell which session's server a pid belongs to
 * and also restarts servers on `/mcp` → Reconnect, so the cause is stated as a possibility.
 */
const EXIT_CAUSE = "原因はクラッシュ・Pi 外からの終了・/mcp での再接続など（このセッションのサーバーとは限りません）。";

/** Notice appended to the result of the call that respawned a released server. */
export function respawnNotice(server: string, pending: RespawnPending, elapsedMs: number | undefined, note?: string): string {
  const first =
    pending.respawnedUnseen || elapsedMs === undefined
      ? `${NOTICE_PREFIX} ${stoppedPhrase(server, pending)}${stoppedVerb(pending)}、その後再起動されました。メモリ上の状態は初期化されています。`
      : `${NOTICE_PREFIX} ${stoppedPhrase(server, pending)}${stoppedVerb(pending)}、この呼び出しで再起動しました` +
        `（再起動を含むこの呼び出しの所要 ${(elapsedMs / 1000).toFixed(1)} 秒）。メモリ上の状態は初期化されています。`;
  const head = pending.reason === "exit" ? `${first}${EXIT_CAUSE}` : first;
  return note ? `${head}\n${note}` : head;
}

/**
 * Reason of a call refused by the "block" policy (the script's Error message / the AI's tool result).
 * After a failed passThrough (`pending.failedPassThrough`) the server is running again; the reason says
 * that the state setup has not succeeded yet.
 */
export function blockNotice(server: string, tool: string, pending: RespawnPending, note?: string): string {
  return [
    pending.failedPassThrough !== undefined
      ? `${NOTICE_PREFIX} ${stoppedPhrase(server, pending)}${stoppedVerb(pending)}再起動済みですが、直前の ${pending.failedPassThrough} が失敗したため` +
        `状態の再設定がまだ成功していません。この呼び出し（${tool}）は実行していません。`
      : `${NOTICE_PREFIX} ${stoppedPhrase(server, pending)}${stoppedVerb(pending, true)}、この呼び出し（${tool}）は実行していません。` +
        "サーバーは次の呼び出しで自動的に再起動しますが、メモリ上の状態は初期化されています。" +
        (pending.reason === "exit" ? EXIT_CAUSE : ""),
    ...(note ? [note] : []),
    "必要な状態を再設定してから、この呼び出しをやり直してください。",
  ].join("\n");
}

/** Line added to the result of a failed passThrough call under the "block" policy. */
export function passThroughFailedNotice(server: string, tool: string): string {
  return (
    `${NOTICE_PREFIX} この ${tool} は失敗しました（isError / success: false）。${server} の状態はまだ再設定されていません。` +
    `${server} の他のツールへの次の呼び出しは 1 回だけ実行せずに返します（やり直せば実行されます）。先に ${tool} を成功させてください。`
  );
}

const MAX_JSON_PROBE = 64 * 1024;

/** `success === false` of a small JSON object text (`{"success": false, …}`), else false. Never throws. */
function textSaysFailure(text: unknown): boolean {
  if (typeof text !== "string" || text.length > MAX_JSON_PROBE || !text.includes('"success"')) return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) && value.success === false;
  } catch {
    return false;
  }
}

function firstText(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined;
  const block: unknown = content[0];
  return isRecord(block) && block.type === "text" ? block.text : undefined;
}

/**
 * Whether a tool result reports a failure at the application level, not only as `isError`. Some
 * servers (unityMCP) answer e.g. "Instance … not found" with `isError: false` and a payload
 * `{ "success": false, "error": … }`. For MCP tools Pi's structuredContent is the CallToolResult
 * `{ content, structuredContent?, isError? }` and the server payload is its own `structuredContent`.
 * Failure when: `isError === true` (Pi's or the CallToolResult's), `success === false` on Pi's
 * structuredContent or on the server payload; only when the payload has no boolean `success`, the
 * first text block (the CallToolResult's, else Pi's) parsed as a JSON object (≤ 64 KB) with
 * `success === false`.
 */
export function isAppLevelFailure(result: { isError?: boolean; structuredContent?: unknown; content?: readonly unknown[] }): boolean {
  if (result.isError === true) return true;
  const outer = result.structuredContent;
  if (isRecord(outer)) {
    if (outer.isError === true || outer.success === false) return true;
    const payload = outer.structuredContent;
    if (isRecord(payload) && typeof payload.success === "boolean") return payload.success === false;
    if (typeof outer.success === "boolean") return false;
    const text = firstText(outer.content);
    if (text !== undefined) return textSaysFailure(text);
  }
  return textSaysFailure(firstText(result.content));
}

/** Whether a tracked server should be released now. */
export function isDue(track: ServerTrack, now: number, thresholdMs: number, globalBusy: boolean): boolean {
  return (
    thresholdMs > 0 &&
    !globalBusy &&
    track.status === "running" &&
    track.inflight === 0 &&
    now - track.lastUse >= thresholdMs
  );
}

/** `~` and `~/…` (also `~\…` on Windows) name the home directory, as in Pi's MCP runtime. */
export function expandHome(value: string, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\"))) {
    return nodePath.join(home, value.slice(2));
  }
  return value;
}

function stdioFromEntry(name: string, value: unknown): StdioServer | undefined {
  if (!isRecord(value) || value.enabled === false) return undefined;
  if (typeof value.url === "string" || typeof value.command !== "string" || !value.command.trim()) return undefined;
  const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
  return { name, command: expandHome(value.command), args: args.map((arg) => expandHome(arg)) };
}

/**
 * Enabled stdio servers in effect, merged like Pi does: extension-registered servers, replaced by
 * same-named user `mcp.json` entries, replaced by project entries. A project entry without
 * command/url/type only overrides `enabled`/exposure of a user entry.
 */
export function collectStdioServers(sources: {
  user?: unknown;
  project?: unknown;
  registered?: readonly { name: string; config: unknown }[];
}): StdioServer[] {
  const merged = new Map<string, unknown>();
  for (const server of sources.registered ?? []) merged.set(server.name, server.config);
  const fromFile = new Map<string, unknown>();
  const userServers = isRecord(sources.user) && isRecord(sources.user.mcpServers) ? sources.user.mcpServers : {};
  for (const [name, value] of Object.entries(userServers)) fromFile.set(name, value);
  const projectServers =
    isRecord(sources.project) && isRecord(sources.project.mcpServers) ? sources.project.mcpServers : {};
  for (const [name, value] of Object.entries(projectServers)) {
    const isOverride =
      isRecord(value) && value.command === undefined && value.url === undefined && value.type === undefined;
    if (isOverride) {
      const base = fromFile.get(name);
      if (isRecord(base)) fromFile.set(name, { ...base, ...(value as Record<string, unknown>) });
      continue;
    }
    fromFile.set(name, value);
  }
  for (const [name, value] of fromFile) merged.set(name, value);
  const result: StdioServer[] = [];
  for (const [name, value] of merged) {
    const server = stdioFromEntry(name, value);
    if (server) result.push(server);
  }
  return result;
}

/** Pi's MCP namespace name (`mcp__<server>` with `-` → `_`). */
export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, "_")}`;
}

/** Map pi tool names to their MCP server, using each tool's namespace (exact). */
export function buildToolServerMap(tools: readonly ToolInfoLike[], serverNames: readonly string[]): Map<string, string> {
  const byNamespace = new Map<string, string>();
  for (const name of serverNames) byNamespace.set(mcpNamespace(name), name);
  const map = new Map<string, string>();
  for (const tool of tools) {
    const ns = tool.namespace;
    if (!ns || !ns.name.startsWith("mcp__")) continue;
    const server =
      ns.aliases?.find((alias) => mcpNamespace(alias) === ns.name) ?? byNamespace.get(ns.name) ?? undefined;
    if (server) map.set(tool.name, server);
  }
  return map;
}

/**
 * Server of an `mcp__…` tool that is not in the namespace map: the configured server whose
 * sanitized prefix `mcp__<server>__` starts the name, only when exactly one does.
 */
export function serverByPrefix(toolName: string, serverNames: readonly string[]): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const hits = serverNames.filter((name) =>
    toolName.startsWith(`mcp__${name}__`.replace(/[^A-Za-z0-9_]/g, "_")),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * What a tool call touches: `servers` it uses, `all` when it reaches every server (resource tools
 * without `server`), `global` when every server must count as busy while it runs (codemode).
 */
export function classifyToolCall(
  toolName: string,
  args: unknown,
  resolve: (toolName: string) => string | undefined,
): { servers: string[]; all: boolean; global: boolean } {
  if (CODEMODE_TOOLS.has(toolName)) return { servers: [], all: false, global: true };
  if (RESOURCE_TOOLS.has(toolName)) {
    const server = isRecord(args) && typeof args.server === "string" && args.server ? args.server : undefined;
    return server ? { servers: [server], all: false, global: false } : { servers: [], all: true, global: true };
  }
  if (!toolName.startsWith("mcp__")) return { servers: [], all: false, global: false };
  const server = resolve(toolName);
  return { servers: server ? [server] : [], all: false, global: false };
}

// --- command-line tokenizing / matching ---------------------------------------------------

/**
 * Split a Windows command line with the MSVC argv rules (quotes group, backslashes before a
 * quote escape it). `split: false` only removes quoting from a single token.
 */
export function tokenizeWindows(input: string, split = true): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "\\") {
      let n = 0;
      while (input[i + n] === "\\") n++;
      if (input[i + n] === '"') {
        current += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) {
          current += '"';
          i += n; // skip the backslashes and the escaped quote
        } else {
          i += n - 1; // the quote is handled by the next iteration
        }
      } else {
        current += "\\".repeat(n);
        i += n - 1;
      }
      hasToken = true;
    } else if (char === '"') {
      if (inQuotes && input[i + 1] === '"') {
        current += '"';
        i++;
      } else inQuotes = !inQuotes;
      hasToken = true;
    } else if (split && !inQuotes && (char === " " || char === "\t" || char === "\n" || char === "\r")) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** Split a cmd.exe command at unescaped whitespace outside quotes; `^x` becomes `x`. */
function tokenizeCmd(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "^" && !inQuotes && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      hasToken = true;
    } else if (!inQuotes && (char === " " || char === "\t")) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function winBase(token: string): string {
  const base = token.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? token;
  return base.toLowerCase();
}

/**
 * The command run by a `cmd.exe … /c <command>` line (cross-spawn wraps `.cmd` shims as
 * `cmd.exe /d /s /c "<escaped command>"`), or undefined when the line is not a cmd wrapper.
 */
export function unwrapCmdLine(commandLine: string): string | undefined {
  const tokens = tokenizeWindows(commandLine);
  if (tokens.length === 0 || !/^cmd(\.exe)?$/.test(winBase(tokens[0]))) return undefined;
  const match = /\s\/[cCkK](?:\s+|$)([\s\S]*)$/.exec(commandLine);
  if (!match) return undefined;
  const switches = commandLine.slice(0, match.index);
  let inner = match[1].trim();
  if (/\s\/[sS](?=\s|$)/.test(switches) && inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"')) {
    inner = inner.slice(1, -1);
  }
  return inner;
}

/**
 * Token views of a process command line. Windows: the raw MSVC argv, plus for cmd.exe
 * wrappers the inner command with cmd's `^` escapes removed (twice for cross-spawn's double
 * escaping of `node_modules/.bin` shims). Others: whitespace split of `ps` args.
 */
export function commandLineViews(commandLine: string, platform: NodeJS.Platform = process.platform): string[][] {
  if (platform !== "win32") return [commandLine.trim().split(/\s+/).filter(Boolean)];
  const views = [tokenizeWindows(commandLine)];
  let inner = unwrapCmdLine(commandLine);
  for (let depth = 0; inner !== undefined && depth < 3; depth++) {
    const tokens = tokenizeCmd(inner).map((token) => {
      // Double-escaped shims leave a second level of `^` escapes after cmd's own pass.
      const once = token.includes("^") ? token.replace(/\^(.)/g, "$1") : token;
      return tokenizeWindows(once, false)[0] ?? "";
    });
    views.push(tokens);
    inner = unwrapCmdLine(tokens.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(" "));
  }
  return views;
}

const WIN_EXTENSIONS = /\.(cmd|exe|bat|com|ps1)$/i;
const SHELLS = /^(ba|z|da|k|fi|c|tc|a)?sh(\.exe)?$|^(pwsh|powershell)(\.exe)?$/i;

/** Whether `token` names the configured command (basename, with or without .cmd/.exe on Windows). */
export function commandMatches(token: string, command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    const a = winBase(token);
    const b = winBase(command);
    return a === b || a.replace(WIN_EXTENSIONS, "") === b.replace(WIN_EXTENSIONS, "");
  }
  return nodePath.posix.basename(token) === nodePath.posix.basename(command);
}

function argEquals(token: string, arg: string, platform: NodeJS.Platform): boolean {
  if (token === arg) return true;
  return platform === "win32" && token.replace(/\//g, "\\") === arg.replace(/\//g, "\\");
}

/**
 * How well a token list matches command+args: 3 = the args are exactly the rest of the line,
 * 2 = they follow the command directly, 1 = they follow in order with gaps, 0 = no match.
 */
export function matchTokens(
  tokens: readonly string[],
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): number {
  let expected = [...args];
  if (platform !== "win32") expected = expected.flatMap((arg) => arg.split(/\s+/).filter(Boolean));
  // `bash -c "<command>"` (Pi's bash tool): `ps` shows the script unquoted, so its words would
  // look like a server command line.
  if (
    tokens.length > 1 &&
    SHELLS.test(nodePath.win32.basename(tokens[0])) &&
    /^-\w*c$/.test(tokens[1]) &&
    !commandMatches(tokens[0], command, platform)
  ) {
    return 0;
  }
  let best = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!commandMatches(tokens[i], command, platform)) continue;
    const rest = tokens.slice(i + 1);
    if (rest.length === expected.length && rest.every((token, k) => argEquals(token, expected[k], platform))) return 3;
    if (expected.every((arg, k) => rest[k] !== undefined && argEquals(rest[k], arg, platform))) {
      best = Math.max(best, 2);
      continue;
    }
    let k = 0;
    for (const token of rest) if (k < expected.length && argEquals(token, expected[k], platform)) k++;
    if (k === expected.length) best = Math.max(best, 1);
  }
  return best;
}

export function matchScore(commandLine: string, server: StdioServer, platform: NodeJS.Platform = process.platform): number {
  let best = 0;
  for (const tokens of commandLineViews(commandLine, platform)) {
    best = Math.max(best, matchTokens(tokens, server.command, server.args, platform));
  }
  return best;
}

/**
 * Assign processes to servers. Each process goes to the server(s) it matches best; each server
 * keeps the processes of its best tier. A server is resolved only with exactly one process.
 */
export function assignProcesses(
  procs: readonly ChildProc[],
  servers: readonly StdioServer[],
  platform: NodeJS.Platform = process.platform,
): Map<string, ChildProc[]> {
  const scores = procs.map((proc) => servers.map((server) => matchScore(proc.commandLine, server, platform)));
  const result = new Map<string, ChildProc[]>();
  servers.forEach((server, s) => {
    let tier = 0;
    let picked: ChildProc[] = [];
    procs.forEach((proc, p) => {
      const score = scores[p][s];
      if (score === 0 || score < Math.max(...scores[p])) return; // another server matches it better
      if (score > tier) {
        tier = score;
        picked = [proc];
      } else if (score === tier) picked.push(proc);
    });
    result.set(server.name, picked);
  });
  return result;
}

/** Parse `ConvertTo-Json` output of the CIM query (empty, one object, or an array). */
export function parseCimJson(stdout: string): ChildProc[] {
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const result: ChildProc[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.ProcessId !== "number") continue;
    const proc: ChildProc = { pid: item.ProcessId, commandLine: typeof item.CommandLine === "string" ? item.CommandLine : "" };
    if (typeof item.WorkingSetSize === "number") proc.memory = item.WorkingSetSize;
    if (typeof item.ParentProcessId === "number") proc.ppid = item.ParentProcessId;
    if (typeof item.Created === "number" && item.Created > 0) proc.created = item.Created / 10_000 - 11_644_473_600_000;
    result.push(proc);
  }
  return result;
}

/** Parse `ps -A -o pid=,ppid=,rss=,args=` and keep the children of `parentPid`. */
export function parsePsOutput(stdout: string, parentPid: number): ChildProc[] {
  const result: ChildProc[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[2]) !== parentPid) continue;
    result.push({ pid: Number(match[1]), commandLine: match[4].trim(), memory: Number(match[3]) * 1024 });
  }
  return result;
}

/** Parse `ps -A -o pid=,ppid=,rss=,args=` (every process, with `ppid`). */
export function parsePsTable(stdout: string): ChildProc[] {
  const result: ChildProc[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    result.push({ pid: Number(match[1]), ppid: Number(match[2]), commandLine: match[4].trim(), memory: Number(match[3]) * 1024 });
  }
  return result;
}

/**
 * Direct children of `rootPid` in a full process table, each with the working set sum and process
 * count of its whole subtree. A process only counts as a child when it was not created before its
 * parent (Windows reuses pids; an orphan keeps its dead parent's pid as ParentProcessId).
 * Children created before `startedAt` (ms epoch) are dropped, like listChildProcesses does.
 */
export function buildProcessTree(table: readonly ChildProc[], rootPid: number, startedAt = 0): ChildProc[] {
  const byParent = new Map<number, ChildProc[]>();
  for (const proc of table) {
    if (proc.ppid === undefined || proc.ppid === proc.pid) continue;
    let list = byParent.get(proc.ppid);
    if (!list) byParent.set(proc.ppid, (list = []));
    list.push(proc);
  }
  const childrenOf = (parent: ChildProc | undefined, pid: number) =>
    (byParent.get(pid) ?? []).filter(
      (child) => parent?.created === undefined || child.created === undefined || child.created >= parent.created,
    );
  const root = table.find((proc) => proc.pid === rootPid);
  return childrenOf(root, rootPid)
    .filter((child) => child.created === undefined || child.created >= startedAt)
    .map((child) => {
      let memory = 0;
      let count = 0;
      const seen = new Set<number>([rootPid]);
      const stack = [child];
      while (stack.length > 0) {
        const proc = stack.pop() as ChildProc;
        if (seen.has(proc.pid)) continue;
        seen.add(proc.pid);
        memory += proc.memory ?? 0;
        count++;
        stack.push(...childrenOf(proc, proc.pid));
      }
      return { ...child, treeMemory: memory, treeCount: count };
    });
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function formatMinutes(ms: number): string {
  if (ms <= 0) return "never";
  const minutes = ms / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
}

// ---------------------------------------------------------------------------
// Process enumeration / killing (async; never blocks the TUI)
// ---------------------------------------------------------------------------

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

function systemExe(name: string, ...dirs: string[]): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  return root ? nodePath.win32.join(root, ...dirs, name) : name;
}

/**
 * Direct child processes of `parentPid` (default: this process). Windows filters out processes
 * created before this process started (a reused parent pid of an orphan).
 */
export async function listChildProcesses(
  parentPid: number = process.pid,
  platform: NodeJS.Platform = process.platform,
): Promise<ChildProc[]> {
  if (platform === "win32") {
    const script =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Math.trunc(parentPid)}' | ` +
      "Select-Object ProcessId,CommandLine,WorkingSetSize,@{n='Created';e={if($_.CreationDate){$_.CreationDate.ToFileTimeUtc()}else{0}}} | " +
      "ConvertTo-Json -Compress";
    const powershell = systemExe("powershell.exe", "System32", "WindowsPowerShell", "v1.0");
    const { code, stdout, stderr } = await run(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      ENUM_TIMEOUT_MS,
    );
    if (code !== 0) throw new Error(`process query failed (${code}): ${stderr.trim().slice(0, 200)}`);
    const startedAt = parentPid === process.pid ? performance.timeOrigin - 2_000 : 0;
    return parseCimJson(stdout).filter((proc) => proc.created === undefined || proc.created >= startedAt);
  }
  const { code, stdout, stderr } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,args="], ENUM_TIMEOUT_MS);
  if (code !== 0) throw new Error(`ps failed (${code}): ${stderr.trim().slice(0, 200)}`);
  return parsePsOutput(stdout, parentPid);
}

/**
 * Direct children of `parentPid` with the memory of their whole process trees: one query of all
 * processes (Windows: one CIM query; command lines only for the direct children), then a tree walk.
 * Used by `/mcp-idle` status; the periodic check uses the cheaper filtered listChildProcesses().
 */
export async function listProcessTree(
  parentPid: number = process.pid,
  platform: NodeJS.Platform = process.platform,
): Promise<ChildProc[]> {
  const startedAt = parentPid === process.pid ? performance.timeOrigin - 2_000 : 0;
  if (platform === "win32") {
    const pid = Math.trunc(parentPid);
    const script =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,CommandLine,CreationDate | " +
      `Select-Object ProcessId,ParentProcessId,WorkingSetSize,@{n='CommandLine';e={if($_.ParentProcessId -eq ${pid}){$_.CommandLine}else{$null}}},` +
      "@{n='Created';e={if($_.CreationDate){$_.CreationDate.ToFileTimeUtc()}else{0}}} | " +
      "ConvertTo-Json -Compress";
    const powershell = systemExe("powershell.exe", "System32", "WindowsPowerShell", "v1.0");
    const { code, stdout, stderr } = await run(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      ENUM_TIMEOUT_MS,
    );
    if (code !== 0) throw new Error(`process query failed (${code}): ${stderr.trim().slice(0, 200)}`);
    return buildProcessTree(parseCimJson(stdout), parentPid, startedAt);
  }
  const { code, stdout, stderr } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,args="], ENUM_TIMEOUT_MS);
  if (code !== 0) throw new Error(`ps failed (${code}): ${stderr.trim().slice(0, 200)}`);
  return buildProcessTree(parsePsTable(stdout), parentPid);
}

/** Kill a process and its children. Resolves true when the kill was issued successfully. */
export async function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === "win32") {
    const { code } = await run(systemExe("taskkill.exe", "System32"), ["/pid", String(pid), "/T", "/F"], ENUM_TIMEOUT_MS);
    return code === 0;
  }
  try {
    process.kill(-pid, "SIGTERM"); // Pi starts stdio servers in their own process group
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

/** `process.kill(pid, 0)`: false only when the process does not exist (ESRCH); EPERM and others count as alive. */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

// ---------------------------------------------------------------------------
// Shared registry: one per Pi process, across sessions (main + in-process subagents)
// ---------------------------------------------------------------------------

/**
 * What one extension instance (one session) exposes to the process-wide registry. Plain functions and
 * data only: every session may load its own copy of this module (jiti), so nothing here may rely on
 * module identity (instanceof, module-level constants of another copy).
 */
export type Participant = {
  id: number;
  /** The session has a UI (the top-level TUI session; subagent sessions bind none). */
  hasUI: () => boolean;
  /** False once the session was disposed (its ctx is stale): the instance is pruned. */
  alive: () => boolean;
  /** ctx.isIdle(): no agent run is active (undefined: unknown). Used for stale in-flight counts. */
  agentIdle: () => boolean | undefined;
  enabled: () => boolean;
  servers: () => StdioServer[];
  /** The live track object of one of its servers (created on first access). */
  track: (name: string) => ServerTrack;
  threshold: (name: string) => number;
  /** A codemode / tool_search / list-all resource call is running: every server counts as busy. */
  globalBusy: () => boolean;
  /** Calls in flight in this session (any server, or global). */
  inflight: () => number;
  /** Time of its last tool event (start, call, end). */
  lastActivity: () => number;
  clearInflight: () => void;
  /** Mark its server released (pending respawn notice / block). Returns an undo for a failed kill. */
  markReleased: (name: string, at: number, reason: "idle" | "manual" | "exit") => () => void;
  notify: (message: string, level: "info" | "warning" | "error") => void;
  /** settings.notify of that session (the one-line UI notice after an idle release). */
  notifyReleases: () => boolean;
};

export type RegistryLock = { at: number; done: Promise<void>; release: () => void };

export type Registry = {
  instances: Map<number, Participant>;
  nextId: number;
  /** Held while a pass (or a manual release) enumerates and kills. */
  lock: RegistryLock | undefined;
  /** When the last pass that enumerated processes started: at most one enumeration per interval. */
  lastPassAt: number;
  /** Keys skipped as ambiguous: not enumerated again until a participant changes (or PARK_RETRY_MS). */
  parked: Map<string, { signature: string; at: number }>;
  /**
   * Key → when a participant using it last left (session_shutdown). Its server copy is closed
   * asynchronously after that, so for UNREGISTER_GRACE_MS the key is not judged (M may still be E + 1).
   */
  unregisteredAt: Map<string, number>;
  /** One-time warnings ("ambiguous:<key>", "enum:<key>", "kill:<key>"). */
  warned: Set<string>;
  /**
   * Key → the server processes (direct children of Pi) seen running, for unexpected-exit detection.
   * Only the root of each copy is kept: Pi's transport watches the direct child alone.
   */
  copies: Map<string, ServerCopy[]>;
  /** Root pids this extension killed (pid → when): a stale process list must not bring them back. */
  stopped: Map<number, { at: number; created?: number }>;
  /** Key → last learning enumeration that found fewer copies than sessions expect (not retried until the signature changes). */
  learnTried: Map<string, { signature: string; at: number }>;
  /** Key → when Pi started closing its copies (session left / servers changed): exit detection waits for the grace. */
  exitQuietAt: Map<string, number>;
  /** Key → when this extension last killed its processes (see KILLED_QUIET_MS). */
  killedAt: Map<string, number>;
};

/** A running server process as remembered for exit detection. */
export type ServerCopy = {
  pid: number;
  /** Creation time (ms epoch) when known: the same pid with another one is a reused pid. */
  created?: number;
  /** A kill of it was issued by this extension: its death is expected. */
  stopping?: boolean;
};

/** globalThis key of the registry. Bump the version when Participant/Registry change incompatibly. */
export const REGISTRY_KEY = Symbol.for("mcp-idle-release.registry.v1");
/** A lock older than this is taken over (a driver that hung or was torn down mid-pass). */
export const LOCK_TIMEOUT_MS = 90_000;
/**
 * In-flight counts of a session with no agent run active (ctx.isIdle()) and no tool event for this long
 * are stale (a run that ended without tool_execution_end / agent_end) and are cleared.
 */
export const STALE_INFLIGHT_MS = 120_000;
/** An ambiguous key is enumerated again after this long even when nothing changed. */
export const PARK_RETRY_MS = 10 * 60_000;
/**
 * After a participant of a key unregisters, the key is skipped (silently, status unchanged) for
 * max(check interval, this): its copy is closed asynchronously after session_shutdown (taskkill, and
 * pi-subagents allows the shutdown 3 s before dispose), so M = E + 1 meanwhile is expected, not foreign.
 */
export const UNREGISTER_GRACE_MS = 15_000;
/** How long a killed root pid is ignored when a (stale) process list shows it. */
const STOPPED_TTL_MS = 2 * 60_000;
/** After this extension stopped a server, "connection closed" errors of its running calls are expected for this long. */
const KILLED_QUIET_MS = 10_000;
/** Text of the error a call fails with when Pi's connection to the server closed under it. */
const CONNECTION_CLOSED = /\bMCP (?:connection closed|client is (?:closed|closing))\b/;
/** Timer jitter: a pass may run once 90 % of the interval has passed since the last one. */
const THROTTLE_SLACK = 0.9;

export function createRegistry(): Registry {
  return {
    instances: new Map(),
    nextId: 1,
    lock: undefined,
    lastPassAt: Number.NEGATIVE_INFINITY,
    parked: new Map(),
    unregisteredAt: new Map(),
    warned: new Set(),
    copies: new Map(),
    stopped: new Map(),
    learnTried: new Map(),
    exitQuietAt: new Map(),
    killedAt: new Map(),
  };
}

/** The process-wide registry on globalThis (created on first use). */
export function sharedRegistry(): Registry {
  const store = globalThis as unknown as Record<symbol, Registry | undefined>;
  let registry = store[REGISTRY_KEY];
  if (!registry || !(registry.instances instanceof Map)) {
    registry = createRegistry();
    store[REGISTRY_KEY] = registry;
  }
  // A registry created by an older copy of this module (same version symbol) lacks newer fields.
  if (!(registry.unregisteredAt instanceof Map)) registry.unregisteredAt = new Map();
  if (!(registry.copies instanceof Map)) registry.copies = new Map();
  if (!(registry.stopped instanceof Map)) registry.stopped = new Map();
  if (!(registry.learnTried instanceof Map)) registry.learnTried = new Map();
  if (!(registry.exitQuietAt instanceof Map)) registry.exitQuietAt = new Map();
  if (!(registry.killedAt instanceof Map)) registry.killedAt = new Map();
  return registry;
}

/**
 * Identity of a stdio server process: the command and args exactly as the matcher compares them
 * (Windows: lower-case basename without .cmd/.exe/…, `/` = `\` in args; elsewhere: basename, args split
 * at whitespace). cwd and env are not part of it (the matcher only sees the command line). Servers with
 * the same key run identical processes, whichever session (and server name) started them.
 */
export function identityKey(server: StdioServer, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return JSON.stringify([
      winBase(server.command).replace(WIN_EXTENSIONS, ""),
      ...server.args.map((arg) => arg.replace(/\//g, "\\")),
    ]);
  }
  return JSON.stringify([
    nodePath.posix.basename(server.command),
    ...server.args.flatMap((arg) => arg.split(/\s+/).filter(Boolean)),
  ]);
}

type Part = { inst: Participant; name: string };
type Group = { key: string; server: StdioServer; parts: Part[] };

/** A process is expected for this participant: running since session start or since its last call. */
const expectsLive = (track: ServerTrack) => track.status === "running" || track.status === "ambiguous";

function partIdle(part: Part, now: number): boolean {
  const track = part.inst.track(part.name);
  const threshold = part.inst.threshold(part.name);
  return (
    part.inst.enabled() &&
    !part.inst.globalBusy() &&
    track.inflight === 0 &&
    threshold > 0 &&
    now - track.lastUse >= threshold
  );
}

function partBusy(part: Part): boolean {
  return part.inst.globalBusy() || part.inst.track(part.name).inflight > 0;
}

/**
 * Walk the registry: prune dead instances, clear stale in-flight counts, and group the participants of
 * every stdio server by identity key. An instance that throws (disposed meanwhile, incompatible copy)
 * is left out; its processes then count as foreign, which only ever prevents a kill.
 */
export function collectGroups(registry: Registry, platform: NodeJS.Platform, now: number): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const [id, inst] of registry.instances) {
    let alive: boolean;
    try {
      alive = inst.alive();
    } catch {
      alive = false;
    }
    if (!alive) {
      registry.instances.delete(id);
      // A disposed session closes its server copies: do not take their end for an unexpected exit.
      try {
        for (const server of inst.servers()) forgetKey(registry, identityKey(server, platform), now, false);
      } catch {
        // its servers are unknown: the copies are recognised as gone by the next enumeration
      }
      continue;
    }
    try {
      if (inst.inflight() > 0 && inst.agentIdle() === true && now - inst.lastActivity() >= STALE_INFLIGHT_MS) {
        inst.clearInflight();
      }
      for (const server of inst.servers()) {
        const key = identityKey(server, platform);
        let group = groups.get(key);
        if (!group) groups.set(key, (group = { key, server, parts: [] }));
        group.parts.push({ inst, name: server.name });
      }
    } catch {
      // skipped (see above)
    }
  }
  return groups;
}

function groupSignature(group: Group): string {
  return group.parts
    .map((part) => {
      const track = part.inst.track(part.name);
      return `${part.inst.id}:${part.name}:${track.lastUse}:${track.status}`;
    })
    .sort()
    .join("|");
}

/** Due iff some participant expects a process and EVERY live participant is idle past its own threshold. */
function groupDue(group: Group, now: number): boolean {
  try {
    return (
      group.parts.some((part) => expectsLive(part.inst.track(part.name))) &&
      group.parts.every((part) => partIdle(part, now))
    );
  } catch {
    return false;
  }
}

function isParked(registry: Registry, group: Group, now: number): boolean {
  const park = registry.parked.get(group.key);
  if (!park) return false;
  if (now - park.at < PARK_RETRY_MS && park.signature === groupSignature(group)) return true;
  registry.parked.delete(group.key);
  return false;
}

/** A participant of `key` left less than `graceMs` ago: its copy may still be closing. */
function inUnregisterGrace(registry: Registry, key: string, now: number, graceMs: number): boolean {
  const at = registry.unregisteredAt.get(key);
  if (at === undefined) return false;
  if (now - at < graceMs) return true;
  registry.unregisteredAt.delete(key);
  return false;
}

/**
 * Stop watching a key's server processes: Pi is closing its copies (a session left, servers changed), so
 * their end is no unexpected exit, and they are not learned again for a while (exitQuietAt). `judge`:
 * also hold the idle / M-vs-E judgement of the key for the unregister grace (a session that left).
 */
function forgetKey(registry: Registry, key: string, now: number, judge: boolean): void {
  registry.copies.delete(key);
  registry.learnTried.delete(key);
  registry.exitQuietAt.set(key, now);
  if (judge) {
    registry.parked.delete(key);
    registry.unregisteredAt.set(key, now);
  }
}

/** Exit detection is quiet for this key (see forgetKey). */
function inExitQuiet(registry: Registry, key: string, now: number, graceMs: number): boolean {
  const at = registry.exitQuietAt.get(key);
  if (at === undefined) return false;
  if (now - at < graceMs) return true;
  registry.exitQuietAt.delete(key);
  return false;
}

/** The session that shows UI notices (the top-level TUI session), else `fallback`. */
function uiParticipant(registry: Registry, fallback: Participant): Participant {
  for (const inst of registry.instances.values()) {
    try {
      if (inst.hasUI() && inst.alive()) return inst;
    } catch {
      // next
    }
  }
  return fallback;
}

function safeNotify(inst: Participant, message: string, level: "info" | "warning" | "error"): void {
  try {
    inst.notify(message, level);
  } catch {
    // session gone meanwhile
  }
}

/** The name `inst` uses for the group's server (names may differ between sessions), else the first one. */
function nameIn(group: Group, inst: Participant): string {
  return (group.parts.find((part) => part.inst === inst) ?? group.parts[0]).name;
}

function takeLock(registry: Registry, at: number): RegistryLock {
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = { at, done, release };
  registry.lock = lock;
  return lock;
}

function dropLock(registry: Registry, lock: RegistryLock): void {
  if (registry.lock === lock) registry.lock = undefined;
  lock.release();
}

// ---------------------------------------------------------------------------
// Releaser core (dependency-injected so tests can drive it)
// ---------------------------------------------------------------------------

export type ReleaserDeps = {
  now: () => number;
  platform: NodeJS.Platform;
  getServers: () => StdioServer[];
  getSettings: () => Settings;
  resolveTool: (toolName: string, serverNames: readonly string[]) => string | undefined;
  listProcesses: () => Promise<ChildProc[]>;
  /** Children with whole-tree memory, for status. Falls back to listProcesses. */
  listProcessTree?: () => Promise<ChildProc[]>;
  /** Kill a process tree. Must start the kill synchronously (before its first await). */
  killProcess: (pid: number) => Promise<boolean>;
  notify: (message: string, level: "info" | "warning" | "error") => void;
  /** Process-wide registry shared with the other sessions' instances (default: a private one). */
  registry?: Registry;
  /** See Participant. Defaults: alive, agentIdle unknown, hasUI true. */
  alive?: () => boolean;
  agentIdle?: () => boolean | undefined;
  hasUI?: () => boolean;
  /** Whether a process exists (`kill(pid, 0)`: ESRCH = gone, EPERM = alive). Default: defaultIsAlive. */
  isAlive?: (pid: number) => boolean;
  /** Unexpected-exit detection (remember server pids, check them on each call). Default: on. */
  exitDetection?: boolean;
};

export type StatusRow = {
  name: string;
  status: ServerStatus;
  idleMs: number;
  thresholdMs: number;
  inflight: number;
  pid?: number;
  /** Pids when several processes match (one per session). */
  pids?: number[];
  /** Working set of the server's whole process tree when known, else of its direct child. */
  memory?: number;
  procCount?: number;
  matches?: number;
  /** A release the AI has not been told about yet. */
  noticePending?: boolean;
  /** Notice delivered, but a block is still pending ("block" policy, a passThrough failed). */
  blockPending?: boolean;
  /** Live sessions using a server with the same command line (this one included). */
  participants?: number;
  /** How many of them expect a running process (= processes a release kills). */
  expected?: number;
  /** Another session's call to it is in flight. */
  othersBusy?: boolean;
};

/** Minimal shapes of the tool_call / tool_result events the releaser needs. */
export type ToolCallLike = { toolCallId: string; toolName: string; input: unknown; parentToolCallId?: string };
export type ToolResultLike = {
  toolCallId: string;
  toolName: string;
  content: readonly unknown[];
  structuredContent?: unknown;
  isError: boolean;
  parentToolCallId?: string;
};
export type ToolResultPatch = { content: unknown[]; structuredContent?: unknown };

/** Key under `_meta` of the CallToolResult a codemode script receives. */
export const META_KEY = "mcpIdleRelease";

function textBlocks(content: readonly unknown[]): string {
  return content
    .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/**
 * What to append to the root codemode result for the queued notices, given the text the script
 * already printed (`shown`). Works per line: a line that is already visible (verbatim, or as a
 * JSON.stringify'd copy, once or twice escaped) or was already emitted is dropped. A notice whose
 * lines are all visible is omitted; otherwise its heading (first line) is kept as context. A notice
 * with nothing dropped is kept as is. Returns "" when nothing is left. Only runs for results that
 * carry a notice: the cost is a few `includes` scans of the output per notice line.
 */
export function dedupeNoticeLines(notices: readonly string[], shown: string): string {
  const emitted = new Set<string>();
  const visible = (line: string): boolean => {
    if (shown.includes(line)) return true;
    const once = JSON.stringify(line).slice(1, -1);
    if (once !== line && shown.includes(once)) return true;
    const twice = JSON.stringify(once).slice(1, -1);
    return twice !== once && shown.includes(twice);
  };
  const parts: string[] = [];
  for (const notice of notices) {
    const lines = notice.split("\n");
    const kept = lines.map((line) => line.trim() !== "" && !emitted.has(line) && !visible(line));
    if (!kept.some(Boolean)) continue; // everything visible / already appended: omit the notice
    if (lines[0].trim() !== "" && !emitted.has(lines[0])) kept[0] = true; // heading stays as context
    const out = lines.filter((_, i) => kept[i]);
    for (const line of out) emitted.add(line);
    parts.push(out.length === lines.length ? notice : out.join("\n"));
  }
  return parts.join("\n");
}

/**
 * The CallToolResult object scripts receive, with the notice under `_meta.mcpIdleRelease.notice`
 * (content blocks untouched, so scripts that parse `content[0].text` or join the text keep working).
 * Non-object structured content is returned unchanged.
 */
function withMetaNotice(structured: unknown, notice: string): unknown {
  if (!isRecord(structured)) return structured;
  const meta = isRecord(structured._meta) ? structured._meta : {};
  return { ...structured, _meta: { ...meta, [META_KEY]: { notice } } };
}

export function createReleaser(deps: ReleaserDeps) {
  const tracks = new Map<string, ServerTrack>();
  /** toolCallId → what its start incremented, so its end undoes exactly that. */
  const calls = new Map<string, { servers: string[]; global: boolean }>();
  /** Nested call id → caller id (from tool_call), to find the model-issued root call. */
  const parentOf = new Map<string, string>();
  /** Calls between their tool_call and tool_execution_end. */
  const open = new Set<string>();
  /** Root call id → notices of its nested calls, appended to the root's own result. */
  const rootNotices = new Map<string, string[]>();
  let globalInflight = 0;
  let sessionEnabled: boolean | undefined;
  let sessionMinutes: number | undefined;
  let lastActivity = deps.now();
  const registry = deps.registry ?? createRegistry();
  const touch = () => {
    lastActivity = deps.now();
  };

  const track = (name: string): ServerTrack => {
    let entry = tracks.get(name);
    if (!entry) {
      entry = { lastUse: deps.now(), inflight: 0, status: "running" };
      tracks.set(name, entry);
    }
    return entry;
  };
  const enabled = () => sessionEnabled ?? deps.getSettings().enabled;
  const threshold = (name: string) => idleThresholdMs(deps.getSettings(), name, sessionMinutes);
  const use = (name: string) => {
    const entry = track(name);
    entry.lastUse = deps.now();
    if (entry.status !== "running") {
      entry.status = "running"; // Pi reconnects (respawns) on this call
      entry.releasedAt = undefined;
    }
  };

  function reset(): void {
    const now = deps.now();
    lastActivity = now;
    registry.instances.set(participant.id, participant);
    tracks.clear();
    calls.clear();
    parentOf.clear();
    open.clear();
    rootNotices.clear();
    globalInflight = 0;
    for (const server of deps.getServers()) {
      tracks.set(server.name, { lastUse: now, inflight: 0, status: "running" });
      // Pi reconnects every server at session start: copies seen before belong to a closed connection.
      const key = keyOf(server);
      registry.copies.delete(key);
      registry.learnTried.delete(key);
    }
  }

  function onToolStart(toolCallId: string, toolName: string, args: unknown): void {
    const names = deps.getServers().map((server) => server.name);
    const kind = classifyToolCall(toolName, args, (tool) => deps.resolveTool(tool, names));
    const servers = kind.all ? names : kind.servers;
    if (servers.length === 0 && !kind.global) return;
    touch();
    for (const name of servers) {
      use(name);
      const entry = track(name);
      entry.inflight++;
      // A resource call to every server may respawn released ones without anyone seeing a notice.
      if (kind.all && entry.respawn) entry.respawn.respawnedUnseen = true;
    }
    if (kind.global) globalInflight++;
    calls.set(toolCallId, { servers, global: kind.global });
  }

  const rootOf = (toolCallId: string): string => {
    let id = toolCallId;
    for (let depth = 0; depth < 64; depth++) {
      const parent = parentOf.get(id);
      if (parent === undefined) break;
      id = parent;
    }
    return id;
  };

  /** The one server a call targets (MCP tool or resource tool with `server`), else undefined. */
  const targetOf = (toolName: string, input: unknown): string | undefined => {
    if (!toolName.startsWith("mcp__") && !RESOURCE_TOOLS.has(toolName)) return undefined;
    const names = deps.getServers().map((server) => server.name);
    const kind = classifyToolCall(toolName, input, (tool) => deps.resolveTool(tool, names));
    return !kind.all && kind.servers.length === 1 && names.includes(kind.servers[0]) ? kind.servers[0] : undefined;
  };

  const queueForRoot = (toolCallId: string, notice: string) => {
    if (!parentOf.has(toolCallId)) return; // model-issued call: its own result carries the notice
    const root = rootOf(toolCallId);
    if (!open.has(root)) return;
    const list = rootNotices.get(root) ?? [];
    if (!list.includes(notice)) list.push(notice);
    rootNotices.set(root, list);
  };

  /**
   * tool_call: the first call to a server released by this extension claims the notice (it is the
   * call that respawns the server), or is refused once under the "block" policy.
   */
  function onToolCall(event: ToolCallLike): { block: true; reason: string } | undefined {
    open.add(event.toolCallId);
    if (event.parentToolCallId !== undefined) parentOf.set(event.toolCallId, event.parentToolCallId);
    const server = targetOf(event.toolName, event.input);
    if (!server) return undefined;
    touch();
    const entry = track(server);
    // The server may have exited on its own since the last call (Pi would respawn it silently).
    const exitedNow = checkExit(server) && entry.respawn?.reason === "exit";
    const pending = entry.respawn;
    if (!pending) return undefined;
    const settings = deps.getSettings();
    // Also while a passThrough call is respawning the server: only a *successful* one clears the block.
    if (
      respawnPolicy(settings, server) === "block" &&
      !pending.blocked &&
      !isPassThrough(settings, server, event.toolName)
    ) {
      pending.blocked = true;
      // The refused call does not reach the server: it stays released (tool_execution_start marked it running).
      // After a failed passThrough the server is running again.
      if (pending.claimedBy === undefined && !pending.respawnedUnseen && !pending.noticeDelivered) {
        entry.status = "released";
        entry.releasedAt = pending.releasedAt;
      }
      const reason = blockNotice(server, bareToolName(event.toolName, server), pending, settings.servers[server]?.respawnNote);
      queueForRoot(event.toolCallId, reason);
      return { block: true, reason };
    }
    if (pending.claimedBy !== undefined) return undefined; // a concurrent call is respawning it
    pending.claimedBy = event.toolCallId;
    pending.claimedAt = deps.now();
    if (exitedNow && entry.status === "released") {
      // tool_execution_start had marked it running before the exit was noticed: this call respawns it.
      entry.status = "running";
      entry.releasedAt = undefined;
    }
    return undefined;
  }

  /**
   * tool_result of the claiming call: append the notice. A result without structured content that
   * is an error was thrown (spawn / transport failure): the notice stays pending for the next call.
   * "block" policy: a passThrough call that failed at app level (isAppLevelFailure) still delivers
   * the notice (the server did respawn) but re-arms the block for the next other call.
   */
  function onToolResult(event: ToolResultLike): ToolResultPatch | undefined {
    let patch: ToolResultPatch | undefined;
    const server = findClaimed(event.toolCallId);
    const entry = server ? tracks.get(server) : undefined;
    const pending = entry?.respawn;
    if (server && entry && pending && pending.claimedBy === event.toolCallId) {
      const failed = event.isError && event.structuredContent === undefined;
      const nested = parentOf.has(event.toolCallId);
      const unseen = nested && !open.has(rootOf(event.toolCallId));
      if (failed || unseen) {
        pending.claimedBy = undefined;
        pending.claimedAt = undefined;
        if (!failed) pending.respawnedUnseen = true;
      } else {
        const settings = deps.getSettings();
        const lines: string[] = [];
        if (!pending.noticeDelivered) {
          const elapsed = pending.claimedAt === undefined ? undefined : deps.now() - pending.claimedAt;
          lines.push(respawnNotice(server, pending, elapsed, settings.servers[server]?.respawnNote));
        }
        const setupFailed =
          respawnPolicy(settings, server) === "block" &&
          isPassThrough(settings, server, event.toolName) &&
          isAppLevelFailure(event);
        if (setupFailed) {
          const tool = bareToolName(event.toolName, server);
          lines.push(passThroughFailedNotice(server, tool));
          entry.respawn = {
            releasedAt: pending.releasedAt,
            reason: pending.reason,
            blocked: false,
            noticeDelivered: true,
            failedPassThrough: tool,
          };
        } else {
          entry.respawn = undefined;
        }
        const notice = lines.join("\n");
        if (notice === "") {
          // Only the block was pending (notice delivered before) and this call cleared it.
        } else if (nested) {
          queueForRoot(event.toolCallId, notice);
          // Scripts get the CallToolResult (structuredContent): the notice goes to its _meta only.
          if (isRecord(event.structuredContent)) {
            patch = {
              content: [...event.content, { type: "text", text: notice }],
              structuredContent: withMetaNotice(event.structuredContent, notice),
            };
          }
        } else {
          patch = {
            content: [...event.content, { type: "text", text: notice }],
            // Passed explicitly: replacing content alone would drop the structured content.
            ...(event.structuredContent === undefined
              ? {}
              : { structuredContent: withMetaNotice(event.structuredContent, notice) }),
          };
        }
      }
    }
    if (event.isError && event.structuredContent === undefined && exitDetection()) {
      // Pi's own signal: the connection closed under the call (the server process ended). A server this
      // extension stopped already has its pending notice; any other exit is announced from here.
      const target = targetOf(event.toolName, {});
      if (target && CONNECTION_CLOSED.test(textBlocks(event.content))) noteConnectionClosed(target);
    }
    const queued = rootNotices.get(event.toolCallId);
    if (queued && queued.length > 0) {
      rootNotices.delete(event.toolCallId);
      const base = patch?.content ?? [...event.content];
      const shown = textBlocks(base);
      // Appended as an own text block, line-deduplicated: a line already visible in the script's
      // output (verbatim, or JSON-escaped once / twice) or already appended is left out; a notice
      // keeps its heading line while any of its lines is still unseen. Cut lines count as unseen.
      const missing = dedupeNoticeLines(queued, shown);
      if (missing !== "") {
        patch = {
          content: [...base, { type: "text", text: missing }],
          ...(patch?.structuredContent !== undefined
            ? { structuredContent: patch.structuredContent }
            : event.structuredContent === undefined
              ? {}
              : { structuredContent: event.structuredContent }),
        };
      }
    }
    // Results produced after this point (a nested call outliving its script) cannot reach the root.
    open.delete(event.toolCallId);
    return patch;
  }

  function findClaimed(toolCallId: string): string | undefined {
    for (const [name, entry] of tracks) if (entry.respawn?.claimedBy === toolCallId) return name;
    return undefined;
  }

  function onToolEnd(toolCallId: string): void {
    open.delete(toolCallId);
    parentOf.delete(toolCallId);
    rootNotices.delete(toolCallId);
    // A claiming call that never produced a tool_result (blocked by another extension, aborted).
    const claimed = findClaimed(toolCallId);
    const pending = claimed ? tracks.get(claimed)?.respawn : undefined;
    if (pending) {
      pending.claimedBy = undefined;
      pending.claimedAt = undefined;
    }
    const call = calls.get(toolCallId);
    if (!call) return;
    touch();
    calls.delete(toolCallId);
    for (const name of call.servers) {
      const entry = track(name);
      entry.inflight = Math.max(0, entry.inflight - 1);
      entry.lastUse = deps.now();
    }
    if (call.global) globalInflight = Math.max(0, globalInflight - 1);
  }

  /** Safety valve: no tool can be running once the agent loop ended. */
  function clearInflight(): void {
    calls.clear();
    parentOf.clear();
    open.clear();
    rootNotices.clear();
    for (const entry of tracks.values()) {
      if (entry.respawn) {
        entry.respawn.claimedBy = undefined;
        entry.respawn.claimedAt = undefined;
      }
    }
    globalInflight = 0;
    for (const entry of tracks.values()) entry.inflight = 0;
  }

  /** Its own servers that are individually due (ignores other sessions; for diagnostics). */
  function dueServers(): StdioServer[] {
    const now = deps.now();
    const busy = globalInflight > 0;
    return deps.getServers().filter((server) => isDue(track(server.name), now, threshold(server.name), busy));
  }

  function markReleased(name: string, at: number, reason: "idle" | "manual" | "exit"): () => void {
    const entry = track(name);
    const before = { status: entry.status, releasedAt: entry.releasedAt, everReleased: entry.everReleased, respawn: entry.respawn };
    entry.status = "released";
    entry.releasedAt = at;
    entry.everReleased = true;
    // An earlier release the AI never heard of (respawned unseen) keeps its time: state is lost since then.
    // One it was told about (only a block left after a failed passThrough) is replaced.
    const previous = entry.respawn?.noticeDelivered ? undefined : entry.respawn;
    // One pending for both: "exit" (not stopped by us) wins the wording over a later idle stop.
    const merged = previous?.reason === "exit" || reason === "exit" ? "exit" : (previous?.reason ?? reason);
    const pending: RespawnPending = { releasedAt: previous?.releasedAt ?? at, reason: merged, blocked: false };
    entry.respawn = pending;
    return () => {
      // Undo only while nobody acted on it (no call claimed, was blocked or respawned it meanwhile).
      if (entry.respawn !== pending || entry.status !== "released") return;
      if (pending.claimedBy !== undefined || pending.blocked || pending.respawnedUnseen) return;
      Object.assign(entry, before);
    };
  }

  // -------------------------------------------------------------------------
  // Unexpected exit of a server process (not stopped by this extension)
  // -------------------------------------------------------------------------

  const exitDetection = () => deps.exitDetection !== false;
  const aliveFn = (pid: number): boolean => {
    try {
      return (deps.isAlive ?? defaultIsAlive)(pid);
    } catch {
      return true;
    }
  };
  const keyCache = new WeakMap<object, string>();
  function keyOf(server: StdioServer): string {
    let key = keyCache.get(server);
    if (key === undefined) {
      key = identityKey(server, deps.platform);
      keyCache.set(server, key);
    }
    return key;
  }

  const learnSignature = (group: Group): string =>
    group.parts
      .map((part) => `${part.inst.id}:${part.name}:${part.inst.track(part.name).status}`)
      .sort()
      .join("|");

  /** Sessions that expect a running copy of the group (and have the extension enabled). */
  function expectingParts(group: Group): Part[] {
    return group.parts.filter((part) => {
      try {
        return expectsLive(part.inst.track(part.name)) && part.inst.enabled();
      } catch {
        return false;
      }
    });
  }

  /** The group's server pids are not (all) remembered, and a learning enumeration is worthwhile. */
  function needsLearn(group: Group, now: number): boolean {
    if (!exitDetection() || inExitQuiet(registry, group.key, now, unregisterGraceMs())) return false;
    const expected = expectingParts(group).length;
    if (expected === 0 || (registry.copies.get(group.key)?.length ?? 0) >= expected) return false;
    const tried = registry.learnTried.get(group.key);
    return !(tried && now - tried.at < PARK_RETRY_MS && tried.signature === learnSignature(group));
  }

  /** A pending "exit" notice that no session has consumed yet (recent): the copy counts are unreliable meanwhile. */
  function hasExitPending(group: Group, now: number): boolean {
    return group.parts.some((part) => {
      try {
        const pending = part.inst.track(part.name).respawn;
        return pending?.reason === "exit" && !pending.noticeDelivered && now - pending.releasedAt < PARK_RETRY_MS;
      } catch {
        return false;
      }
    });
  }

  /**
   * An exit was found for `group`: every session that expects a running copy gets a pending notice (Pi
   * does not say which session's connection a pid belongs to; one block more than needed is accepted).
   * Sessions that already have a notice / a respawn in flight are left alone. Returns how many.
   */
  function raiseExit(group: Group, now: number): number {
    let marked = 0;
    for (const part of group.parts) {
      try {
        const entry = part.inst.track(part.name);
        if (!expectsLive(entry) || !part.inst.enabled()) continue;
        if (entry.respawn && (entry.respawn.claimedBy !== undefined || !entry.respawn.noticeDelivered)) continue;
        part.inst.markReleased(part.name, now, "exit");
        marked++;
      } catch {
        // session gone meanwhile
      }
    }
    registry.parked.delete(group.key);
    registry.warned.delete(`ambiguous:${group.key}`);
    if (marked > 0) {
      const ui = uiParticipant(registry, participant);
      safeNotify(
        ui,
        `MCP "${nameIn(group, ui)}" が予期せず終了しました（次回呼び出しで自動再接続。メモリ上の状態は初期化されます）`,
        "warning",
      );
    }
    return marked;
  }

  /** Drop the dead server processes of `key` from the memo (ones being stopped by us do not count). */
  function reapDead(key: string): boolean {
    const copies = registry.copies.get(key);
    if (!copies) return false;
    let dead: ServerCopy[] | undefined;
    for (const copy of copies) if (!copy.stopping && !aliveFn(copy.pid)) (dead ??= []).push(copy);
    if (!dead) return false;
    const gone = dead;
    const rest = copies.filter((copy) => !gone.includes(copy));
    if (rest.length > 0) registry.copies.set(key, rest);
    else registry.copies.delete(key);
    return true;
  }

  /** tool_call: has a process of this server exited since it was seen? True when sessions were told. */
  function checkExit(serverName: string): boolean {
    if (registry.copies.size === 0 || !exitDetection()) return false; // nothing remembered: free
    const server = deps.getServers().find((candidate) => candidate.name === serverName);
    if (!server) return false;
    const key = keyOf(server);
    if (!reapDead(key)) return false;
    const now = deps.now();
    const group = collectGroups(registry, deps.platform, now).get(key); // also prunes disposed sessions
    return group !== undefined && !inExitQuiet(registry, key, now, unregisterGraceMs()) && raiseExit(group, now) > 0;
  }

  /** Pi's connection closed under a call: the server process ended (or was closed by Pi itself). */
  function noteConnectionClosed(serverName: string): void {
    const server = deps.getServers().find((candidate) => candidate.name === serverName);
    if (!server) return;
    const key = keyOf(server);
    reapDead(key);
    const now = deps.now();
    if (inExitQuiet(registry, key, now, unregisterGraceMs())) return;
    const killed = registry.killedAt.get(key);
    if (killed !== undefined && now - killed < KILLED_QUIET_MS) return; // running calls fail when we stop the server
    const group = collectGroups(registry, deps.platform, now).get(key);
    if (group) raiseExit(group, now);
  }

  /** Tick: the same check for every remembered key (sessions that make no calls). */
  function detectExits(now: number): void {
    if (registry.copies.size === 0 || !exitDetection()) return;
    let groups: Map<string, Group> | undefined;
    for (const key of [...registry.copies.keys()]) {
      if (!reapDead(key)) continue;
      groups ??= collectGroups(registry, deps.platform, now); // also prunes disposed sessions
      const group = groups.get(key);
      if (group && !inExitQuiet(registry, key, now, unregisterGraceMs())) raiseExit(group, now);
    }
  }

  /**
   * Learn the server processes from a process list that was fetched anyway (idle pass, /mcp-idle status,
   * release). Adds the roots of each group (only when no more than the sessions expect: otherwise some
   * are foreign), refreshes creation times, and treats a known pid with another creation time as a reused
   * pid, i.e. the old process exited.
   */
  function absorb(procs: readonly ChildProc[], assigned: Map<string, ChildProc[]>, groups: Map<string, Group>): void {
    if (!exitDetection()) return;
    const now = deps.now();
    for (const [pid, stop] of registry.stopped) if (now - stop.at > STOPPED_TTL_MS) registry.stopped.delete(pid);
    const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
    const graceMs = unregisterGraceMs();
    for (const [key, group] of groups) {
      const found = assigned.get(key);
      if (!found || inExitQuiet(registry, key, now, graceMs)) continue;
      const expected = expectingParts(group).length;
      let reused = false;
      const copies = (registry.copies.get(key) ?? []).filter((copy) => {
        const seen = byPid.get(copy.pid);
        if (copy.stopping || !seen || seen.created === undefined || copy.created === undefined || seen.created === copy.created) return true;
        reused = true;
        return false;
      });
      if (found.length <= expected) {
        for (const proc of found) {
          const stop = registry.stopped.get(proc.pid);
          if (stop && (stop.created === undefined || proc.created === undefined || stop.created === proc.created)) continue; // our own kill
          const known = copies.find((copy) => copy.pid === proc.pid);
          if (known) known.created ??= proc.created;
          else if (aliveFn(proc.pid)) copies.push({ pid: proc.pid, created: proc.created });
        }
      }
      if (copies.length > 0) registry.copies.set(key, copies);
      else registry.copies.delete(key);
      if (reused) raiseExit(group, now);
      if (expected > 0 && copies.length < expected) registry.learnTried.set(key, { signature: learnSignature(group), at: now });
      else registry.learnTried.delete(key);
    }
  }

  const participant: Participant = {
    id: registry.nextId++,
    hasUI: () => deps.hasUI?.() ?? true,
    alive: () => deps.alive?.() ?? true,
    agentIdle: () => deps.agentIdle?.(),
    enabled,
    servers: () => deps.getServers(),
    track,
    threshold,
    globalBusy: () => globalInflight > 0,
    inflight: () => {
      let count = globalInflight;
      for (const entry of tracks.values()) count += entry.inflight;
      return count;
    },
    lastActivity: () => lastActivity,
    clearInflight: () => clearInflight(),
    markReleased,
    notify: (message, level) => deps.notify(message, level),
    notifyReleases: () => deps.getSettings().notify,
  };

  const warnOnce = (key: string, message: string) => {
    if (registry.warned.has(key)) return;
    registry.warned.add(key);
    safeNotify(uiParticipant(registry, participant), message, "warning");
  };

  /** Representatives of every key (named by key) for one assignProcesses() over all sessions' servers. */
  const representatives = (groups: Map<string, Group>): StdioServer[] => {
    const reps = [...groups.values()].map((group) => ({ ...group.server, name: group.key }));
    // Own servers when this instance is not registered (before session_start / after shutdown).
    for (const server of deps.getServers()) {
      const key = identityKey(server, deps.platform);
      if (!groups.has(key) && !reps.some((rep) => rep.name === key)) reps.push({ ...server, name: key });
    }
    return reps;
  };

  /** A kill that never throws; the kill itself starts synchronously (deps.killProcess contract). */
  const startKill = (pid: number): Promise<boolean> => {
    try {
      return Promise.resolve(deps.killProcess(pid)).catch(() => false);
    } catch {
      return Promise.resolve(false);
    }
  };

  /**
   * Kill the `found` processes of `group` and mark every participant that expected one released. The
   * caller re-checked the group in the same synchronous turn; the kills are issued and the participants
   * marked before the first await, so a call that starts afterwards already sees the pending notice
   * (and respawns the server). Resolves whether any kill succeeded; when none did, the marks that no call
   * acted on yet are undone.
   */
  async function killGroup(group: Group, found: readonly ChildProc[], reason: "idle" | "manual", at: number): Promise<boolean> {
    const expected = group.parts.filter((part) => expectsLive(part.inst.track(part.name)));
    // Flagged BEFORE each kill is issued: a tick or call that runs while it is awaited must not take
    // the death for an unexpected exit.
    const kills = found.map((proc) => {
      registry.stopped.set(proc.pid, { at: deps.now(), created: proc.created });
      const copy = registry.copies.get(group.key)?.find((candidate) => candidate.pid === proc.pid);
      if (copy) copy.stopping = true;
      return startKill(proc.pid);
    });
    const undos = expected.map((part) => part.inst.markReleased(part.name, at, reason));
    registry.parked.delete(group.key);
    registry.warned.delete(`ambiguous:${group.key}`);
    // The connection-closed errors of calls that were running on the killed server are no exit either.
    registry.killedAt.set(group.key, deps.now());
    const results = await Promise.all(kills);
    found.forEach((proc, i) => {
      const copies = registry.copies.get(group.key);
      if (results[i]) {
        if (copies) {
          const rest = copies.filter((candidate) => candidate.pid !== proc.pid);
          if (rest.length > 0) registry.copies.set(group.key, rest);
          else registry.copies.delete(group.key);
        }
      } else {
        registry.stopped.delete(proc.pid);
        const copy = copies?.find((candidate) => candidate.pid === proc.pid);
        if (copy) copy.stopping = undefined;
      }
    });
    const failed = found.filter((_, i) => !results[i]).map((proc) => proc.pid);
    if (failed.length === found.length) {
      for (const undo of undos) undo();
    }
    if (failed.length > 0) {
      warnOnce(
        `kill:${group.key}`,
        `mcp-idle: MCP "${nameIn(group, uiParticipant(registry, participant))}" (pid ${failed.join(", ")}) を停止できませんでした`,
      );
    }
    return failed.length < found.length;
  }

  const unregisterGraceMs = () => Math.max(deps.getSettings().checkIntervalSeconds * 1000, UNREGISTER_GRACE_MS);

  const sessionsSuffix = (count: number) => (count > 1 ? `（${count} セッション分）` : "");

  /** Final decision for one due key, after enumeration: re-checked synchronously right before the kills. */
  async function releaseIdle(key: string, found: readonly ChildProc[], lock: RegistryLock): Promise<void> {
    // A pass that hung and was taken over (LOCK_TIMEOUT_MS) must not act on its old process list.
    if (registry.lock !== lock) return;
    const now = deps.now();
    const group = collectGroups(registry, deps.platform, now).get(key);
    if (!group || !groupDue(group, now)) return; // a call started (or a session joined) while we enumerated
    if (inUnregisterGrace(registry, key, now, unregisterGraceMs())) return; // a session left meanwhile
    const expected = group.parts.filter((part) => expectsLive(part.inst.track(part.name)));
    if (found.length === 0) {
      // Not running (failed to start, disabled via /mcp, already gone): skip silently until the next use.
      for (const part of expected) part.inst.track(part.name).status = "absent";
      return;
    }
    if (found.length !== expected.length) {
      // Sessions that were told about an unexpected exit have not called yet: their copies are not
      // accounted for, so the counts differ for a while. Not a foreign copy; judged again later.
      if (hasExitPending(group, now)) return;
      // A copy nobody here accounts for (a session that runs MCP without this extension), or one that
      // died on its own: whose is which is unknown, so nothing is killed.
      for (const part of expected) part.inst.track(part.name).status = "ambiguous";
      registry.parked.set(key, { signature: groupSignature(group), at: now });
      const ui = uiParticipant(registry, participant);
      warnOnce(
        `ambiguous:${key}`,
        `mcp-idle: MCP "${nameIn(group, ui)}" に一致するプロセスが ${found.length} 個ありますが、` +
          `このプロセス内のセッションが把握しているのは ${expected.length} 個です（mcp-idle-release を読み込んでいないセッションのコピー、` +
          `または起動に失敗した・自然終了したコピーがある可能性）。どれがどのセッションのものか区別できないため自動停止をスキップします`,
      );
      return;
    }
    if (!(await killGroup(group, found, "idle", now))) return;
    const ui = uiParticipant(registry, participant);
    let notifyOn = true;
    try {
      notifyOn = ui.notifyReleases();
    } catch {
      notifyOn = true;
    }
    if (notifyOn) {
      safeNotify(ui, `MCP "${nameIn(group, ui)}" をアイドルのため停止しました（次回呼び出しで自動再接続）${sessionsSuffix(found.length)}`, "info");
    }
  }

  /**
   * One timer tick. Cheap unless something is due: a pass that enumerates runs only when no pass is in
   * progress (registry lock) and the last one started at least one interval ago, so N sessions cause at
   * most one enumeration per interval. The process list is fetched once for all due keys.
   */
  function check(): Promise<void> {
    const now = deps.now();
    detectExits(now); // synchronous and cheap: one kill(pid, 0) per remembered server process
    const held = registry.lock;
    if (held && now - held.at < LOCK_TIMEOUT_MS) return held.done;
    if (now - registry.lastPassAt < deps.getSettings().checkIntervalSeconds * 1000 * THROTTLE_SLACK) return Promise.resolve();
    const graceMs = unregisterGraceMs();
    for (const [key, at] of registry.unregisteredAt) if (now - at >= graceMs) registry.unregisteredAt.delete(key);
    const groups = [...collectGroups(registry, deps.platform, now).values()];
    const due = groups.filter(
      (group) => groupDue(group, now) && !inUnregisterGrace(registry, group.key, now, graceMs) && !isParked(registry, group, now),
    );
    // Groups whose server pids are not remembered yet (session start, after a respawn): the same
    // enumeration learns them. At most one pass per interval, and not again until something changes.
    const learn = groups.filter((group) => needsLearn(group, now));
    if (due.length === 0 && learn.length === 0) return Promise.resolve();
    const lock = takeLock(registry, now);
    registry.lastPassAt = now;
    return (async () => {
      let procs: ChildProc[];
      try {
        procs = await deps.listProcesses();
      } catch (error) {
        for (const group of learn) registry.learnTried.set(group.key, { signature: learnSignature(group), at: now });
        for (const group of due) {
          warnOnce(`enum:${group.key}`, `mcp-idle: プロセス一覧の取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      const groupsNow = collectGroups(registry, deps.platform, deps.now());
      const assigned = assignProcesses(procs, representatives(groupsNow), deps.platform);
      absorb(procs, assigned, groupsNow);
      for (const group of due) await releaseIdle(group.key, assigned.get(group.key) ?? [], lock);
    })()
      .catch(() => undefined)
      .finally(() => dropLock(registry, lock));
  }

  /** Wait for a pass in progress (a lock older than LOCK_TIMEOUT_MS is taken over), then hold the lock. */
  async function acquireLock(): Promise<RegistryLock> {
    for (;;) {
      const held = registry.lock;
      if (!held || deps.now() - held.at >= LOCK_TIMEOUT_MS) break;
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), LOCK_TIMEOUT_MS);
        timer.unref?.();
        void held.done.then(() => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      if (timedOut) break;
    }
    return takeLock(registry, deps.now());
  }

  /** Why `/mcp-idle release` must not stop the processes of `key` now (a session is using it), or "". */
  function busyReason(name: string, key: string): string {
    const group = collectGroups(registry, deps.platform, deps.now()).get(key);
    const own =
      globalInflight > 0 ||
      track(name).inflight > 0 ||
      (group?.parts.some((part) => part.inst === participant && partBusy(part)) ?? false);
    if (own) return `MCP "${name}" は使用中のため停止しません`;
    const others = new Set((group?.parts ?? []).filter((part) => part.inst !== participant && partBusy(part)).map((part) => part.inst));
    if (others.size === 0) return "";
    const who = [...others].every((inst) => !inst.hasUI()) ? "サブエージェントのセッション" : "別のセッション";
    return `MCP "${name}" は${who}（${others.size} 件）が使用中のため停止しません`;
  }

  /**
   * `/mcp-idle release <server>`: release now regardless of idle time, but never while any session uses
   * it; like the idle pass, only when the matching processes are exactly the ones the sessions expect.
   */
  async function releaseNow(name: string): Promise<string> {
    const server = deps.getServers().find((candidate) => candidate.name === name);
    if (!server) return `stdio MCP サーバー "${name}" は設定にありません`;
    const key = identityKey(server, deps.platform);
    const lock = await acquireLock();
    try {
      const early = busyReason(name, key);
      if (early) return early;
      const procs = await deps.listProcesses();
      if (registry.lock !== lock) return `MCP "${name}" の停止は時間切れのため中止しました`;
      const now = deps.now();
      const groups = collectGroups(registry, deps.platform, now);
      const assignedNow = assignProcesses(procs, representatives(groups), deps.platform);
      const found = assignedNow.get(key) ?? [];
      absorb(procs, assignedNow, groups);
      // Re-checked in the same synchronous turn as the kills below.
      const busy = busyReason(name, key);
      if (busy) return busy;
      const group = groups.get(key) ?? { key, server, parts: [{ inst: participant, name }] };
      const expected = group.parts.filter((part) => expectsLive(part.inst.track(part.name))).length;
      if (found.length === 0) return `MCP "${name}" のプロセスは起動していません`;
      if (found.length !== expected) {
        return `MCP "${name}" に一致するプロセスが ${found.length} 個ありますが、このプロセス内のセッションが把握しているのは ${expected} 個のため停止しません`;
      }
      if (!(await killGroup(group, found, "manual", now))) return `MCP "${name}" を停止できませんでした`;
      deps.notify(`MCP "${name}" を停止しました（次回呼び出しで自動再接続）${sessionsSuffix(found.length)}`, "info");
      return "";
    } finally {
      dropLock(registry, lock);
    }
  }

  async function status(withProcesses: boolean): Promise<{ rows: StatusRow[]; error?: string }> {
    const now = deps.now();
    const groups = collectGroups(registry, deps.platform, now);
    let assigned: Map<string, ChildProc[]> | undefined;
    let error: string | undefined;
    if (withProcesses) {
      try {
        const procs = await (deps.listProcessTree ?? deps.listProcesses)();
        assigned = assignProcesses(procs, representatives(groups), deps.platform);
        absorb(procs, assigned, groups);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const rows = deps.getServers().map((server): StatusRow => {
      const entry = track(server.name);
      const key = identityKey(server, deps.platform);
      const parts = groups.get(key)?.parts ?? [{ inst: participant, name: server.name }];
      const found = assigned?.get(key);
      return {
        name: server.name,
        status: entry.status,
        idleMs: entry.inflight > 0 || globalInflight > 0 ? 0 : now - entry.lastUse,
        thresholdMs: threshold(server.name),
        inflight: entry.inflight,
        ...(found ? { matches: found.length } : {}),
        ...(found?.length === 1 ? { pid: found[0].pid } : {}),
        ...(found && found.length > 1 ? { pids: found.map((proc) => proc.pid) } : {}),
        ...(found && found.length > 0
          ? {
              memory: found.reduce((sum, proc) => sum + (proc.treeMemory ?? proc.memory ?? 0), 0),
              procCount: found.reduce((sum, proc) => sum + (proc.treeCount ?? 1), 0),
            }
          : {}),
        ...(entry.respawn && !entry.respawn.noticeDelivered ? { noticePending: true } : {}),
        ...(entry.respawn?.noticeDelivered ? { blockPending: true } : {}),
        participants: parts.length,
        expected: parts.filter((part) => expectsLive(part.inst.track(part.name))).length,
        ...(parts.some((part) => part.inst !== participant && partBusy(part)) ? { othersBusy: true } : {}),
      };
    });
    return { rows, ...(error ? { error } : {}) };
  }

  return {
    reset,
    onToolStart,
    onToolEnd,
    onToolCall,
    onToolResult,
    clearInflight,
    check,
    releaseNow,
    status,
    dueServers,
    isEnabled: enabled,
    setSessionEnabled: (value: boolean | undefined) => {
      sessionEnabled = value;
    },
    setSessionMinutes: (value: number | undefined) => {
      sessionMinutes = value;
    },
    getSessionMinutes: () => sessionMinutes,
    getTrack: (name: string) => tracks.get(name),
    isGlobalBusy: () => globalInflight > 0,
    /** mcp_servers_change: Pi closes / reopens servers itself; forget the remembered pids of all keys. */
    forgetProcesses: () => {
      const now = deps.now();
      const keys = new Set(registry.copies.keys());
      try {
        for (const server of deps.getServers()) keys.add(keyOf(server));
      } catch {
        // servers unknown: the remembered keys are enough
      }
      for (const key of keys) forgetKey(registry, key, now, false);
    },
    /** session_shutdown: leave the shared registry. */
    unregister: () => {
      // Its copies close asynchronously after this: hold judging these keys for the grace period, and
      // re-evaluate a parked key afterwards (E just changed).
      const now = deps.now();
      let servers: StdioServer[] = [];
      try {
        servers = deps.getServers();
      } catch {
        servers = [];
      }
      for (const server of servers) {
        const key = identityKey(server, deps.platform);
        forgetKey(registry, key, now, true); // its copies are closed by Pi now: no unexpected exit
      }
      registry.instances.delete(participant.id);
    },
    participant,
    registry,
  };
}

export function formatStatus(rows: readonly StatusRow[], header: string, error?: string): string {
  const table = [["server", "state", "idle", "threshold", "pid", "mem", "sessions"]];
  for (const row of rows) {
    let state: string;
    if (row.matches === undefined) state = row.status;
    else if (row.matches === 0) state = row.status === "released" ? "released" : "not running";
    else if (row.expected === undefined) {
      state = row.matches === 1 ? (row.status === "released" ? "running (respawned)" : "running") : `ambiguous (${row.matches})`;
    } else if (row.matches === row.expected) {
      // Own copy released while other sessions still run theirs: `released`, the sessions column tells.
      state = row.status === "released" ? "released" : "running";
    } else state = `ambiguous (${row.matches} procs, ${row.expected} expected)`;
    table.push([
      row.name,
      `${state}${row.inflight > 0 ? ", busy" : ""}${row.othersBusy ? ", busy (other session)" : ""}${row.noticePending ? ", notice pending" : ""}${row.blockPending ? ", block pending" : ""}`,
      formatDuration(row.idleMs),
      formatMinutes(row.thresholdMs),
      row.pid !== undefined ? String(row.pid) : row.pids ? row.pids.join(",") : "-",
      row.memory === undefined
        ? "-"
        : `${Math.round(row.memory / 1024 / 1024)} MB${row.procCount !== undefined && row.procCount > 1 ? ` (${row.procCount} procs)` : ""}`,
      row.participants === undefined ? "-" : `${row.participants}/${row.expected ?? "-"}`,
    ]);
  }
  const widths = table[0].map((_, c) => Math.max(...table.map((r) => r[c].length)));
  const lines = table.map((r) => r.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd());
  if (rows.length === 0) lines.push("(stdio MCP サーバーの設定がありません)");
  return [header, ...lines, ...(error ? [`process query failed: ${error}`] : [])].join("\n");
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

export default function mcpIdleRelease(pi: ExtensionAPI) {
  let ctxNow: ExtensionContext | undefined;
  let settings: Settings = DEFAULT_SETTINGS;
  let toolMap = new Map<string, string>();
  let serversCache: { at: number; servers: StdioServer[] } | undefined;

  const notify = (message: string, level: "info" | "warning" | "error") => {
    try {
      ctxNow?.ui.notify(message, level);
    } catch {
      // Session replaced or shut down meanwhile.
    }
  };

  const loadServers = (): StdioServer[] => {
    // Re-read at most once per second: mcp.json can change through /mcp while Pi runs.
    const now = Date.now();
    if (serversCache && now - serversCache.at < 1_000) return serversCache.servers;
    const agentDir = getAgentDir();
    let project: unknown;
    try {
      if (ctxNow?.isProjectTrusted()) project = readJson(nodePath.join(ctxNow.cwd, ".pi", "mcp.json"));
    } catch {
      project = undefined;
    }
    let registered: { name: string; config: unknown }[] = [];
    try {
      registered = pi.getMcpServers();
    } catch {
      registered = [];
    }
    const servers = collectStdioServers({ user: readJson(nodePath.join(agentDir, "mcp.json")), project, registered });
    serversCache = { at: now, servers };
    return servers;
  };

  const resolveTool = (toolName: string, serverNames: readonly string[]): string | undefined => {
    let server = toolMap.get(toolName);
    if (server) return server;
    try {
      toolMap = buildToolServerMap(pi.getAllTools(), serverNames);
    } catch {
      // keep the old map
    }
    server = toolMap.get(toolName);
    return server ?? serverByPrefix(toolName, serverNames);
  };

  const releaser = createReleaser({
    now: () => Date.now(),
    platform: process.platform,
    getServers: loadServers,
    getSettings: () => settings,
    resolveTool,
    listProcesses: () => listChildProcesses(process.pid),
    listProcessTree: () => listProcessTree(process.pid),
    killProcess: (pid) => killProcessTree(pid),
    notify,
    registry: sharedRegistry(),
    // A disposed session invalidates its ctx: every getter / method then throws.
    alive: () => {
      if (!ctxNow) return false;
      try {
        if (typeof ctxNow.isIdle === "function") ctxNow.isIdle();
        return true;
      } catch {
        return false;
      }
    },
    agentIdle: () => {
      try {
        return typeof ctxNow?.isIdle === "function" ? ctxNow.isIdle() : undefined;
      } catch {
        return undefined;
      }
    },
    hasUI: () => {
      try {
        return ctxNow?.hasUI === true;
      } catch {
        return false;
      }
    },
  });

  // One timer per extension instance. Several instances live in one process at once: in-process
  // subagent sessions (pi-subagents) load this extension again, and their session_start/shutdown must
  // not stop the main session's timer. /reload emits session_shutdown to the old instance first.
  // Every timer only drives the shared pass (registry lock + throttle: one enumeration per interval).
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const startTimer = () => {
    stopTimer();
    timer = setInterval(() => {
      releaser.check().catch(() => undefined);
    }, settings.checkIntervalSeconds * 1000);
    timer.unref?.();
  };

  pi.on("session_start", (_event, ctx) => {
    ctxNow = ctx;
    serversCache = undefined;
    toolMap = new Map();
    const parsed = parseSettings(readJson(nodePath.join(getAgentDir(), "mcp-idle-release.json")));
    settings = parsed.settings;
    if (parsed.errors.length > 0) notify(`mcp-idle-release.json: ${parsed.errors.join("; ")}`, "warning");
    releaser.reset(); // servers connect at startup: start their idle clocks now
    startTimer();
  });

  pi.on("session_shutdown", () => {
    stopTimer();
    releaser.unregister();
    ctxNow = undefined;
  });

  pi.on("tool_execution_start", (event) => {
    releaser.onToolStart(event.toolCallId, event.toolName, event.args);
  });
  pi.on("tool_execution_end", (event) => {
    releaser.onToolEnd(event.toolCallId);
  });
  // Respawn notices: tool_call / tool_result also run for calls nested in codemode scripts.
  pi.on("tool_call", (event) => releaser.onToolCall(event));
  pi.on("tool_result", (event) => releaser.onToolResult(event) as ToolResultEventResult | undefined);
  pi.on("agent_end", () => {
    releaser.clearInflight();
  });
  // Pi opens / closes extension-registered servers itself: their pids ending is not an unexpected exit.
  pi.on("mcp_servers_change", () => {
    releaser.forgetProcesses();
  });

  const SUBCOMMANDS = ["release", "on", "off", "minutes"];
  pi.registerCommand("mcp-idle", {
    description: "Idle release of MCP stdio servers: status, release <server>, on, off, minutes <n>",
    getArgumentCompletions: (prefix: string) => {
      const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
      if (rest.length > 0) return null;
      if (server === undefined) {
        const items = SUBCOMMANDS.filter((item) => item.startsWith(action ?? "")).map((item) => ({
          value: item === "on" || item === "off" ? item : `${item} `,
          label: item,
        }));
        return items.length > 0 ? items : null;
      }
      if (action !== "release") return null;
      const items = loadServers()
        .filter((candidate) => candidate.name.startsWith(server))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((candidate) => ({ value: `release ${candidate.name}`, label: candidate.name }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      ctxNow = ctx;
      const [action, value, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      const usage = "Usage: /mcp-idle [release <server> | on | off | minutes <n>]";
      if (action === undefined) {
        const { rows, error } = await releaser.status(true);
        const minutes = releaser.getSessionMinutes() ?? settings.idleMinutes;
        const header =
          `MCP idle release: ${releaser.isEnabled() ? "on" : "off"}` +
          ` (default ${minutes} min, check every ${settings.checkIntervalSeconds} s` +
          `${releaser.isGlobalBusy() ? ", codemode running" : ""}` +
          `${releaser.registry.instances.size > 1 ? `, ${releaser.registry.instances.size} sessions in this process` : ""})`;
        const legend = rows.some((row) => (row.participants ?? 1) > 1)
          ? "\nsessions: sessions using it / of them expecting a running copy (a release kills that many processes)"
          : "";
        ctx.ui.notify(formatStatus(rows, header, error) + legend, "info");
        return;
      }
      if (extra.length > 0) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      if (action === "on" || action === "off") {
        releaser.setSessionEnabled(action === "on");
        ctx.ui.notify(`MCP idle release: ${action} (this session)`, "info");
        if (action === "on") void releaser.check().catch(() => undefined);
        return;
      }
      if (action === "minutes") {
        const minutes = Number(value);
        if (value === undefined || !Number.isFinite(minutes) || minutes < 0) {
          ctx.ui.notify("Usage: /mcp-idle minutes <n>  (0 = never)", "warning");
          return;
        }
        releaser.setSessionMinutes(minutes);
        ctx.ui.notify(`MCP idle release: default ${minutes} min (this session; per-server settings still apply)`, "info");
        return;
      }
      if (action === "release") {
        if (!value) {
          ctx.ui.notify("Usage: /mcp-idle release <server>", "warning");
          return;
        }
        try {
          const failure = await releaser.releaseNow(value);
          if (failure) ctx.ui.notify(failure, "warning");
        } catch (error) {
          ctx.ui.notify(`mcp-idle: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      ctx.ui.notify(usage, "warning");
    },
  });
}
