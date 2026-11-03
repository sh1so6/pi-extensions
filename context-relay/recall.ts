/**
 * `recall`: search / read raw session entries that are no longer in the model context
 * (everything before the latest compaction's firstKeptEntryId), plus relay note files.
 * No Pi imports: callers pass entries, so this is unit-testable with fixtures.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Entry, applyContextEdits, clip, contextStartIndex, entryItems } from "./entries.ts";

export const SEARCH_CAP = 8000;
export const FETCH_CAP = 12000;
const SNIPPET_RADIUS = 200;
const ECHO_MAX = 80; // user-supplied text (query, entryId) echoed back in messages
const HIT_MAX = 900; // one search hit (header + snippet)
const FOOTER_RESERVE = 200;

/** Hard length cap (unlike `clip`, the marker is included in the budget). */
function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export interface NoteFile {
  n: number;
  path: string;
  text: string;
}
export interface Source {
  /** "" for the current session, "<id8>/" for lineage ancestors (entry ids are only unique per file). */
  prefix: string;
  entries: Entry[];
  /** Entries before this index are outside the model context and searchable. */
  searchEnd: number;
  notes?: NoteFile[];
}
export interface RecallParams {
  query?: string;
  limit?: number;
  entryId?: string;
  offset?: number;
  scope?: "session" | "lineage";
}

/** Entries are shown as the model saw them: context_edit omissions/replacements are applied (redactions stay redacted). */
export function currentSource(rawEntries: Entry[], notes: NoteFile[] = []): Source {
  const entries = applyContextEdits(rawEntries);
  return { prefix: "", entries, searchEnd: contextStartIndex(entries), notes };
}

export function readNoteFiles(dir: string): NoteFile[] {
  if (!existsSync(dir)) return [];
  const files: NoteFile[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)\.md$/.exec(name);
    if (!m) continue;
    try {
      files.push({ n: Number(m[1]), path: path.join(dir, name), text: readFileSync(path.join(dir, name), "utf8") });
    } catch {
      // unreadable note: skip
    }
  }
  return files.sort((a, b) => a.n - b.n);
}

/** Parent session files (nearest first). Entries shared with the child (fork copies) are skipped by the caller. */
export function readAncestors(parentFile: string | undefined, depth = 4, notesDir?: (sessionId: string) => string): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  let file = parentFile;
  while (file && depth-- > 0 && !seen.has(file) && existsSync(file)) {
    seen.add(file);
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    } catch {
      break;
    }
    const entries: Entry[] = [];
    let header: Entry | undefined;
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as Entry;
        if (e.type === "session") header = e;
        else entries.push(e);
      } catch {
        // partial line: skip
      }
    }
    const id = String(header?.id ?? path.basename(file)).slice(0, 8);
    out.push({ prefix: `${id}/`, entries: applyContextEdits(entries), searchEnd: entries.length, notes: header?.id && notesDir ? readNoteFiles(notesDir(String(header.id))) : [] });
    file = header?.parentSession;
  }
  return out;
}

function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function snippet(text: string, lower: string, ts: string[]): string {
  const pos = Math.max(0, lower.indexOf(ts[0]));
  const from = Math.max(0, pos - SNIPPET_RADIUS);
  const to = Math.min(text.length, pos + Math.min(ts[0].length, SNIPPET_RADIUS) + SNIPPET_RADIUS);
  const body = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

interface Hit {
  id: string;
  kind: string;
  ts: string;
  text: string;
  lower: string;
}

export function recallSearch(sources: Source[], query: string, limit = 8): string {
  const ts = terms(query);
  if (!ts.length) return "recall: empty query.";
  limit = Math.min(Math.max(Math.floor(Number(limit)) || 8, 1), 30);
  const shownQuery = cap(query.trim(), ECHO_MAX);
  const currentIds = new Set((sources[0]?.entries ?? []).map((e) => e.id));
  const hits: Hit[] = [];
  let total = 0;
  let searched = 0;
  for (const [si, src] of sources.entries()) {
    if (src.searchEnd <= 0 && !(src.notes?.length)) continue;
    for (let i = src.searchEnd - 1; i >= 0; i--) {
      const e = src.entries[i];
      if (si > 0 && currentIds.has(e.id)) continue; // fork copies: reachable through the current session
      searched++;
      for (const item of entryItems(e)) {
        const lower = item.text.toLowerCase();
        if (!ts.every((t) => lower.includes(t))) continue;
        total++;
        if (hits.length < limit) hits.push({ id: `${src.prefix}${e.id}`, kind: item.kind, ts: e.timestamp ?? "", text: item.text, lower });
      }
    }
    for (const note of [...(src.notes ?? [])].reverse()) {
      const lower = note.text.toLowerCase();
      if (!ts.every((t) => lower.includes(t))) continue;
      total++;
      if (hits.length < limit) hits.push({ id: `${src.prefix}note:${note.n}`, kind: "relayNote", ts: "", text: note.text, lower });
    }
  }
  if (!hits.length) {
    return searched || sources.some((s) => s.notes?.length)
      ? `recall: no match for "${shownQuery}" in ${searched} entries outside the current context.`
      : "recall: nothing to search — no compaction/relay has happened yet, so the whole history is still in your context.";
  }
  const lines: string[] = [];
  let size = 0;
  let shown = 0;
  for (const h of hits) {
    const line = cap(`[${h.id}] ${cap(h.kind, 60)}${h.ts ? ` @ ${h.ts}` : ""}\n  ${snippet(h.text, h.lower, ts)}`, HIT_MAX);
    if (size + line.length > SEARCH_CAP - FOOTER_RESERVE) break; // also guards the first hit
    lines.push(line);
    size += line.length + 1;
    shown++;
  }
  const more = total - shown;
  if (shown === 0) return `recall: matches exist but do not fit the output budget; refine the query "${shownQuery}".`;
  lines.push(more > 0 ? `(${shown} of ${total} matches shown, newest first; refine the query or use recall({entryId}) to read one)` : `(${shown} match${shown === 1 ? "" : "es"}; use recall({entryId}) to read one)`);
  return cap(lines.join("\n"), SEARCH_CAP);
}

function entryText(e: Entry): string {
  if (e.type === "context_omitted") return "(omitted from the model context by a context_edit; its content is not available)";
  const items = entryItems(e);
  if (!items.length) return `(entry type ${e.type} has no text)`;
  return items.map((i) => `--- ${i.kind} ---\n${i.text}`).join("\n");
}

export function recallFetch(sources: Source[], entryId: string, offset = 0): string {
  const shownId = cap(entryId, ECHO_MAX);
  let src = sources.find((s) => s.prefix !== "" && entryId.startsWith(s.prefix)) ?? sources[0];
  const bare = src && src.prefix && entryId.startsWith(src.prefix) ? entryId.slice(src.prefix.length) : entryId;
  if (!src) return "recall: no session.";
  let header: string;
  let text: string;
  const note = /^note:(\d+)$/.exec(bare);
  if (note) {
    const file = src.notes?.find((n) => n.n === Number(note[1]));
    if (!file) return `recall: relay note ${cap(bare, ECHO_MAX)} not found.`;
    entryId = `${src.prefix}note:${file.n}`; // canonicalize leading-zero IDs before echoing or paginating
    header = `[${entryId}] relayNote ${file.path}`;
    text = file.text;
  } else {
    let entry = src.entries.find((e) => e.id === bare);
    if (!entry && src.prefix === "") {
      // an id without prefix may belong to an ancestor only if it is not in the current session
      for (const s of sources.slice(1)) {
        entry = s.entries.find((e) => e.id === bare);
        if (entry) {
          src = s;
          break;
        }
      }
    }
    if (!entry) return `recall: entry ${shownId} not found.`;
    header = `[${entryId}] ${entry.type}${entry.timestamp ? ` @ ${entry.timestamp}` : ""}`;
    text = entryText(entry);
  }
  header = cap(header, 500);
  // Pi entry IDs are 8 hex chars, lineage prefixes 8 chars + slash; canonical note IDs are also <80.
  const nextId = cap(entryId, ECHO_MAX);
  offset = Math.min(Math.max(0, Math.floor(Number(offset)) || 0), Number.MAX_SAFE_INTEGER);
  if (offset >= text.length && text.length > 0) return `${header}\n(offset ${offset} is past the end: ${text.length} chars)`;
  const end = Math.min(text.length, offset + FETCH_CAP);
  const next = end < text.length ? `\n[…${text.length - end} more chars; next: recall({entryId:"${nextId}", offset:${end}})]` : "";
  return `${header} (chars ${offset}-${end} of ${text.length})\n${text.slice(offset, end)}${next}`;
}

/** `entryId` (read one entry) wins over `query` (search). Anything else gets a usage hint. Wrong-typed args are ignored. */
export function recall(sources: Source[], params: RecallParams): string {
  if (typeof params.entryId === "string" && params.entryId) return recallFetch(sources, params.entryId, params.offset);
  if (typeof params.query === "string" && params.query.trim()) return recallSearch(params.scope === "lineage" ? sources : sources.slice(0, 1), params.query, params.limit);
  return clip("recall: pass `query` (search) or `entryId` (read).", 200);
}
