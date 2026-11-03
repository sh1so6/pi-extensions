/** Session-entry helpers shared by the note builder and `recall` (pure; no Pi imports). */

// biome-ignore lint/suspicious/noExplicitAny: entries are untyped JSON read from the session file.
export type Entry = { type: string; id?: string; parentId?: string | null; timestamp?: string; [key: string]: any };

/**
 * The branch as the MODEL sees it, position for position (Pi's buildSessionProjection semantics): the latest
 * `context_edit` per target wins; an omitted entry becomes `{type:"context_omitted"}` (no text, never a user message),
 * a replaced one gets the replacement content. `raw` keeps the original entry for facts that really happened
 * (e.g. files an omitted assistant turn edited), but its text must never be shown again.
 */
export function applyContextEdits(entries: Entry[]): Entry[] {
  const edits = new Map<string, Entry>();
  for (const e of entries) if (e.type === "context_edit" && typeof e.targetId === "string") edits.set(e.targetId, e);
  if (edits.size === 0) return entries;
  return entries.map((e) => {
    const edit = e.id ? edits.get(e.id) : undefined;
    if (!edit) return e;
    const r = edit.replacement;
    if (r === null) return { ...e, type: "context_omitted", raw: e };
    if (!r || typeof r !== "object" || !("content" in r)) return e;
    if (e.type === "custom_message") return { ...e, content: r.content, raw: e };
    if (e.type === "message" && e.message) {
      const role = e.message.role;
      const content = (role === "assistant" || role === "toolResult") && typeof r.content === "string" ? [{ type: "text", text: r.content }] : r.content;
      return { ...e, message: { ...e.message, content }, raw: e };
    }
    return e;
  });
}

/** One searchable/readable piece of an entry. `kind` is user | assistant | toolCall:<name> | toolResult:<name> | … */
export interface Item {
  kind: string;
  text: string;
}

export function clip(text: string, max: number, tail = 0): string {
  if (text.length <= max) return text;
  const t = Math.min(tail, Math.floor(max / 2));
  const head = text.slice(0, max - t);
  const omitted = text.length - max;
  return t > 0 ? `${head}…[${omitted} chars cut]…${text.slice(text.length - t)}` : `${head}…[${omitted} chars cut]`;
}

/** Text of a message `content` (string or blocks). Images become "[image]"; thinking and tool calls are skipped. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

function stringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 1);
  } catch {
    return String(value);
  }
}

/** Searchable items of an entry (empty for entries without model-relevant text). */
export function entryItems(entry: Entry): Item[] {
  switch (entry.type) {
    case "message": {
      const m = entry.message;
      if (!m) return [];
      if (m.role === "user") return [{ kind: "user", text: contentText(m.content) }];
      if (m.role === "toolResult") return [{ kind: `toolResult:${m.toolName ?? "?"}`, text: contentText(m.content) }];
      if (m.role === "assistant") {
        const items: Item[] = [];
        const text = contentText(m.content);
        if (text) items.push({ kind: "assistant", text });
        if (Array.isArray(m.content)) {
          for (const block of m.content) {
            if (block?.type === "toolCall") items.push({ kind: `toolCall:${block.name}`, text: stringify(block.arguments) });
          }
        }
        return items;
      }
      return [];
    }
    case "custom_message":
      return [{ kind: `custom:${entry.customType ?? "?"}`, text: contentText(entry.content) }];
    case "custom":
      if (entry.customType === "subagents:record" && entry.data) {
        const d = entry.data;
        const head = `${d.id} ${d.type ?? ""} "${d.description ?? ""}" [${d.status}]`;
        return [{ kind: "subagent:record", text: `${head}\n${d.result ?? d.error ?? ""}` }];
      }
      return [];
    case "compaction":
    case "branch_summary":
      return typeof entry.summary === "string" ? [{ kind: entry.type, text: entry.summary }] : [];
    default:
      return [];
  }
}

export function isUserMessage(entry: Entry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

/** Index of the latest compaction entry, or -1. */
export function lastCompactionIndex(entries: Entry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "compaction") return i;
  return -1;
}

/** Index of the first entry that is still in the model context (0 when never compacted). */
export function contextStartIndex(entries: Entry[]): number {
  const ci = lastCompactionIndex(entries);
  if (ci < 0) return 0;
  const target = entries[ci].firstKeptEntryId;
  if (!target || target === entries[ci].id) return ci;
  const at = entries.findIndex((e) => e.id === target);
  return at >= 0 && at < ci ? at : ci;
}
