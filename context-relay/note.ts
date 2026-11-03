/**
 * Deterministic hand-off note: a pure function over the session branch (no LLM, no I/O).
 * Sections: user instructions · last assistant answer · subagents · modified files / commits · recall footer.
 * Every section has a size cap so the whole note stays around 6k tokens (≈9k chars of mixed JP/EN).
 */
import { type Entry, clip, contentText, entryItems, isUserMessage, lastCompactionIndex } from "./entries.ts";

export const NOTE_VERSION = 1;

export interface GitSection {
  label: string;
  lines: string[];
}
export interface NoteSection {
  title: string;
  body: string;
}
export interface Limits {
  total: number;
  userMessages: number;
  userMessageEach: number;
  chain: number;
  answer: number;
  subagents: number;
  files: number;
  git: number;
  extra: number;
}
export const DEFAULT_LIMITS: Limits = {
  total: 9500,
  userMessages: 3000,
  userMessageEach: 700,
  chain: 700,
  answer: 1200,
  subagents: 2200,
  files: 700,
  git: 600,
  extra: 3000,
};

export interface NoteInput {
  /** Branch entries root→leaf, before the compaction that will carry this note. */
  entries: Entry[];
  /** First entry kept verbatim after the note; everything before it is replaced by the note. */
  firstKeptEntryId: string;
  index: number;
  sessionId: string;
  sessionStart?: string;
  cwd: string;
  notePath: string;
  git?: GitSection[];
  /** M3 seam: extra sections (e.g. an LLM-written one) appended before the footer. */
  extraSections?: NoteSection[];
  now?: Date;
  limits?: Partial<Limits>;
}

/**
 * The latest user message and everything after it. Falls back to Pi's own cut when there is no user message,
 * or when that tail alone is bigger than `tailMaxChars` (a very long last turn) and Pi's cut keeps less.
 */
export function pickFirstKept(entries: Entry[], piFirstKept: string, tailMaxChars = 48000): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isUserMessage(entries[i]) || !entries[i].id) continue;
    const piAt = entries.findIndex((e) => e.id === piFirstKept);
    if (piAt > i) {
      let size = 0;
      for (let j = i; j < entries.length; j++) size += entryItems(entries[j]).reduce((n, it) => n + it.text.length, 0);
      if (size > tailMaxChars) return piFirstKept;
    }
    return entries[i].id as string;
  }
  return piFirstKept;
}

// ---------- subagents ----------

export interface SubagentInfo {
  id: string;
  type?: string;
  name?: string;
  description?: string;
  status: string; // running | completed | failed | <other>
  result?: string;
  worktree?: string;
  branch?: string;
  startedAt?: string; // spawn time (background agents), to judge stale "running" entries
  at: number; // entry index of the latest evidence (for "since last boundary")
}

const WORKTREE_PATH = /[A-Za-z]:[\\/][^\s"'`)\]>,;*|]+/g;
const BRANCH = /\bbranch[:：=\s]+`?([\w][\w./-]{1,60})`?/i;

/** Directories that look like git worktrees (".../worktrees/<name>") mentioned in free text. */
export function worktreePathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(WORKTREE_PATH)) {
    const p = m[0].replace(/[\\/]+$/, "").replace(/\\/g, "/");
    const hit = /^(.*\/worktrees?\/[^/]+)/i.exec(p);
    if (hit) out.add(hit[1]);
  }
  return [...out];
}

function norm(status: unknown): string {
  const s = String(status ?? "").toLowerCase();
  if (s === "error" || s === "failed") return "failed";
  if (s === "completed" || s === "done") return "completed";
  return s || "unknown";
}

export function collectSubagents(entries: Entry[]): SubagentInfo[] {
  const byId = new Map<string, SubagentInfo>();
  const spawnArgs = new Map<string, Record<string, any>>(); // toolCallId → Agent call arguments
  const upsert = (id: string, patch: Partial<SubagentInfo>, at: number) => {
    const prev = byId.get(id) ?? { id, status: "running", at };
    byId.set(id, { ...prev, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), at });
  };
  entries.forEach((e, at) => {
    if (e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content)) {
      for (const b of e.message.content) if (b?.type === "toolCall" && b.name === "Agent") spawnArgs.set(b.id, b.arguments ?? {});
    } else if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "Agent") {
      const d = e.message.details;
      const id = d?.agentId;
      if (id && !byId.has(id) && d.status === "background") {
        const args = spawnArgs.get(e.message.toolCallId) ?? {};
        upsert(id, { type: d.subagentType ?? args.subagent_type, name: args.name, description: d.description ?? args.description, status: "running", startedAt: typeof e.timestamp === "string" ? e.timestamp : undefined }, at);
      }
    } else if (e.type === "custom_message" && e.customType === "subagent-notification" && e.details?.id) {
      const d = e.details;
      const prev = byId.get(d.id);
      if (!prev || prev.status === "running") upsert(d.id, { description: d.description, status: norm(d.status), result: d.error ?? d.resultPreview }, at);
    } else if (e.type === "custom" && e.customType === "subagents:record" && e.data?.id) {
      const d = e.data;
      upsert(d.id, { type: d.type, description: d.description, status: norm(d.status), result: d.result ?? d.error }, at);
    }
  });
  for (const info of byId.values()) {
    const text = `${info.description ?? ""}\n${info.result ?? ""}`;
    info.worktree = worktreePathsIn(text)[0];
    info.branch = BRANCH.exec(text)?.[1];
  }
  return [...byId.values()];
}

/** All worktree directories mentioned by subagents (for the git section). */
export function subagentWorktrees(entries: Entry[]): string[] {
  return [...new Set(collectSubagents(entries).flatMap((s) => (s.worktree ? [s.worktree] : [])))];
}

// ---------- file operations ----------

export function modifiedFiles(entries: Entry[]): string[] {
  const order: string[] = []; // oldest → newest; a repeated path moves to the end
  const add = (p: unknown) => {
    if (typeof p !== "string" || !p) return;
    const key = p.replace(/\\/g, "/");
    const at = order.indexOf(key);
    if (at >= 0) order.splice(at, 1);
    order.push(key);
  };
  for (const projected of entries) {
    const e = projected.raw ?? projected; // files an omitted/replaced assistant turn edited were still edited
    if (e.type === "compaction") for (const p of e.details?.modifiedFiles ?? []) add(p);
    if (e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b?.type === "toolCall" && (b.name === "edit" || b.name === "write")) add(b.arguments?.path);
      }
    }
  }
  return order.reverse();
}

// ---------- rendering ----------

const H_USER = "## User instructions (oldest first)";
const H_ANSWER = "## Last assistant answer before the kept exchange";
const H_AGENTS = "## Subagents";
const H_FILES = "## Files modified / commits";

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}

function userSection(entries: Entry[], from: number, to: number, L: Limits): string {
  const msgs: { text: string; ts: string }[] = [];
  for (let i = from; i < to; i++) {
    if (isUserMessage(entries[i])) msgs.push({ text: contentText(entries[i].message.content).trim(), ts: entries[i].timestamp ?? "" });
  }
  // Newest first: the newest messages get the most room, older ones shrink and finally drop out.
  let left = L.userMessages;
  const lines: string[] = [];
  let omitted = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (left < 120) {
      omitted = i + 1;
      break;
    }
    const cap = left > L.userMessages / 2 ? L.userMessageEach : 200;
    const line = `- [${msgs[i].ts.slice(5, 16).replace("T", " ")}] ${clip(msgs[i].text, cap, Math.floor(cap / 4))}`;
    lines.push(line);
    left -= line.length;
  }
  lines.reverse();
  if (omitted) lines.unshift(`- (${omitted} earlier messages omitted — use recall)`);
  return lines.join("\n");
}

/** The user-instruction lines of a previous relay note, condensed; or the head of a native summary. */
function chainSection(entries: Entry[], L: Limits): string {
  const ci = lastCompactionIndex(entries);
  if (ci < 0) return "";
  const summary = String(entries[ci].summary ?? "");
  if (!entries[ci].details?.relay) return `(from an earlier compaction summary)\n${clip(summary.replace(/^#+ /gm, ""), L.chain)}`;
  const start = summary.indexOf(H_USER);
  if (start < 0) return "";
  const rest = summary.slice(start + H_USER.length);
  const end = rest.search(/^## /m);
  const lines = (end < 0 ? rest : rest.slice(0, end))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && !l.startsWith("- ("));
  const condensed = lines.map((l) => oneLine(l, 140));
  let out = condensed.slice(-12);
  while (out.length > 1 && out.join("\n").length > L.chain) out = out.slice(1);
  return out.join("\n");
}

/** The last final answer (no tool calls) before the kept exchange: the kept part already contains its own. */
function answerSection(entries: Entry[], keptIndex: number, L: Limits): string {
  let best = -1;
  for (let i = Math.min(keptIndex, entries.length) - 1; i >= 0; i--) {
    const m = entries[i].message;
    if (entries[i].type !== "message" || m?.role !== "assistant" || !contentText(m.content).trim()) continue;
    const hasCalls = Array.isArray(m.content) && m.content.some((b: any) => b?.type === "toolCall");
    if (!hasCalls) {
      best = i;
      break;
    }
    if (best < 0) best = i; // mid-turn commentary, used only when no final answer exists
  }
  if (best < 0) return "(none)";
  return clip(contentText(entries[best].message.content).trim(), L.answer, Math.floor(L.answer / 4));
}

function subagentSection(entries: Entry[], windowStart: number, L: Limits): string {
  const all = collectSubagents(entries);
  if (all.length === 0) return "(none)";
  const label = (s: SubagentInfo) => `${s.id}${s.name ? ` "${s.name}"` : ""} (${s.type ?? "?"}) ${oneLine(s.description ?? "", 90)}`;
  const place = (s: SubagentInfo) => [s.worktree ? `worktree: ${s.worktree}` : "", s.branch ? `branch: ${s.branch}` : ""].filter(Boolean).join(", ");
  const running = all.filter((s) => s.status === "running");
  const done = all.filter((s) => s.status !== "running").sort((a, b) => b.at - a.at);
  const recent = done.filter((s) => s.at >= windowStart);
  const older = done.filter((s) => s.at < windowStart);
  const head: string[] = [];
  const rest: string[] = [];
  for (const s of running) {
    head.push(`- ⚠ RUNNING${s.startedAt ? ` since ${s.startedAt.slice(5, 16).replace("T", " ")}Z` : ""} (no result yet; its completion arrives later as a notification; may be lost if pi was restarted): ${label(s)}${place(s) ? ` — ${place(s)}` : ""}`);
  }
  for (const s of recent) {
    const result = s.result ? ` → ${oneLine(s.result.split("\n").slice(0, 3).join(" "), 260)}` : "";
    rest.push(`- ${s.status.toUpperCase()}: ${label(s)}${place(s) ? ` — ${place(s)}` : ""}${result}`);
  }
  for (const s of older.slice(0, 8)) rest.push(`- ${s.status}: ${label(s)} (earlier)`);
  if (older.length > 8) rest.push(`- (+${older.length - 8} older subagents — use recall)`);
  // Running agents always survive the cap; the rest is cut from the end.
  const kept: string[] = [];
  let size = head.join("\n").length;
  for (const line of rest) {
    if (size + line.length + 1 > L.subagents) break;
    kept.push(line);
    size += line.length + 1;
  }
  const dropped = rest.length - kept.length;
  return [...head, ...kept, ...(dropped > 0 ? [`- (+${dropped} more subagent lines cut — use recall)`] : [])].join("\n");
}

function filesSection(entries: Entry[], git: GitSection[], L: Limits): string {
  const files = modifiedFiles(entries);
  const shown: string[] = [];
  let size = 0;
  for (const f of files) {
    if (size + f.length + 3 > L.files) break;
    shown.push(f);
    size += f.length + 3;
  }
  const parts: string[] = [];
  parts.push(
    files.length
      ? `Modified via edit/write (${files.length}, newest first):\n${shown.map((f) => `- ${f}`).join("\n")}${files.length > shown.length ? `\n- (+${files.length - shown.length} more)` : ""}`
      : "Modified via edit/write: (none)",
  );
  let gitLeft = L.git;
  for (const g of git) {
    if (!g.lines.length || gitLeft < 80) continue;
    const lines: string[] = [];
    for (const line of g.lines) {
      const l = clip(line, 120);
      if (gitLeft - l.length < 0) break;
      lines.push(`  ${l}`);
      gitLeft -= l.length + 3;
    }
    parts.push(`Commits since session start — ${g.label}:\n${lines.join("\n")}`);
  }
  return parts.join("\n");
}

export function buildNote(input: NoteInput): string {
  const L: Limits = { ...DEFAULT_LIMITS, ...input.limits };
  const { entries } = input;
  const cut = entries.findIndex((e) => e.id === input.firstKeptEntryId);
  const cutIndex = cut < 0 ? entries.length : cut;
  const ci = lastCompactionIndex(entries);
  let windowStart = 0;
  if (ci >= 0) {
    const fk = entries.findIndex((e) => e.id === entries[ci].firstKeptEntryId);
    windowStart = fk >= 0 && fk < ci ? fk : ci;
  }
  const when = (input.now ?? new Date()).toISOString();

  const chain = chainSection(entries, L);
  const users = userSection(entries, windowStart, cutIndex, L);
  const body: string[] = [];
  body.push(
    `# Context hand-off #${input.index}`,
    `Earlier conversation was replaced by this deterministic note (generated ${when}). Session ${input.sessionId}${input.sessionStart ? `, started ${input.sessionStart}` : ""}, cwd ${input.cwd}.`,
    "The most recent exchange follows verbatim after this note. Treat this note as established history.",
    "",
    H_USER,
  );
  if (chain) body.push("Earlier (condensed from previous notes):", chain, "Since then:");
  body.push(users || "- (none)", "", H_ANSWER, answerSection(entries, cutIndex, L), "", H_AGENTS, subagentSection(entries, windowStart, L), "", H_FILES, filesSection(entries, input.git ?? [], L));
  for (const s of input.extraSections ?? []) body.push("", `## ${s.title}`, clip(s.body, L.extra));
  const footer = [
    "",
    "",
    "## Older details",
    "Raw tool outputs, files read and earlier discussion are no longer in context but are kept in the session log. Use the `recall` tool: " +
      '`recall({query:"term1 term2"})` searches them (AND, case-insensitive); `recall({entryId})` reads one entry in full. ' +
      `This note: ${input.notePath}`,
  ].join("\n");
  const main = body.join("\n");
  const room = L.total - footer.length;
  return (main.length > room ? `${main.slice(0, room - 40)}\n…[note truncated]` : main) + footer;
}
