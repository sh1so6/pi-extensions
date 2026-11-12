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
const FOOTER_RESERVE = 1500; // room for the footer incl. a continuation cursor

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
  regex?: boolean;
  cursor?: string;
  tail?: number;
  around?: { entryId?: string; before?: number; after?: number };
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

const QUERY_MAX = 200; // longer queries get no continuation cursor (it embeds the query)
const SEARCH_BUDGET_MS = 3000;
const REGEX_TEXT_MAX = 200_000; // regex mode tests at most this many leading chars of one item
const TAIL_MAX = 50;
const AROUND_MAX = 10;

/** Where a search stopped: everything up to and including this entry (item `i`) / note was processed. */
export interface Position {
  s: string; // source prefix ("" = current session)
  k: "e" | "n"; // entry | relay note
  id: string; // entry id | note number
  i?: number; // item index inside the entry; undefined = the whole entry was processed
}
interface CursorData {
  v: 1;
  q: string;
  rx?: true;
  sc?: "lineage";
  p: Position;
}

function encodeCursor(c: CursorData): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: unknown): CursorData | undefined {
  if (typeof raw !== "string" || !raw || raw.length > 4000) return;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const p = c?.p;
    if (c?.v !== 1 || typeof c.q !== "string" || !c.q.trim() || !p || typeof p.s !== "string" || (p.k !== "e" && p.k !== "n") || typeof p.id !== "string") return;
    if (p.i !== undefined && !Number.isInteger(p.i)) return;
    return { v: 1, q: c.q.slice(0, QUERY_MAX), rx: c.rx === true ? true : undefined, sc: c.sc === "lineage" ? "lineage" : undefined, p: { s: p.s, k: p.k, id: p.id, i: p.i } };
  } catch {
    return;
  }
}

/** Whether the caller must load parent sessions (scope:"lineage", or a cursor taken from such a search). */
export function wantsLineage(params: RecallParams): boolean {
  return params.scope === "lineage" || decodeCursor(params.cursor)?.sc === "lineage";
}

interface Match {
  pos: number;
  len: number;
}
type Matcher = (text: string) => Match | undefined;

function termsMatcher(ts: string[]): Matcher {
  return (text) => {
    const lower = text.toLowerCase();
    if (!ts.every((t) => lower.includes(t))) return;
    return { pos: Math.max(0, lower.indexOf(ts[0])), len: ts[0].length };
  };
}

function regexMatcher(rx: RegExp): Matcher {
  return (text) => {
    const m = rx.exec(text.length > REGEX_TEXT_MAX ? text.slice(0, REGEX_TEXT_MAX) : text);
    return m ? { pos: m.index, len: Math.max(1, m[0].length) } : undefined;
  };
}

function snippet(text: string, m: Match): string {
  const from = Math.max(0, m.pos - SNIPPET_RADIUS);
  const to = Math.min(text.length, m.pos + Math.min(m.len, SNIPPET_RADIUS) + SNIPPET_RADIUS);
  const body = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

interface Hit {
  id: string;
  kind: string;
  ts: string;
  text: string;
  m: Match;
  pos: Position;
}

export interface SearchOptions {
  /** Treat `query` as a case-insensitive regular expression instead of AND terms. */
  regex?: boolean;
  /** Continue after this position (from a cursor). */
  resume?: Position;
  /** Searching parent sessions too (recorded in the cursor). */
  lineage?: boolean;
  /** Wall-clock budget for one call; a cut always returns a cursor. At least one entry is processed. */
  budgetMs?: number;
  now?: () => number;
}

export function recallSearch(sources: Source[], query: string, limit = 8, opts: SearchOptions = {}): string {
  query = query.trim();
  const shownQuery = cap(query, ECHO_MAX);
  let matcher: Matcher;
  if (opts.regex) {
    if (!query) return "recall: empty query.";
    try {
      matcher = regexMatcher(new RegExp(query, "i"));
    } catch (error) {
      return `recall: invalid regex "${shownQuery}": ${cap(String((error as Error)?.message ?? error), 160)}`;
    }
  } else {
    const ts = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!ts.length) return "recall: empty query.";
    matcher = termsMatcher(ts);
  }
  limit = Math.min(Math.max(Math.floor(Number(limit)) || 8, 1), 30);
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? SEARCH_BUDGET_MS;
  const start = now();
  const currentIds = new Set((sources[0]?.entries ?? []).map((e) => e.id));
  const resume = opts.resume;
  let resumed = !resume;
  let skipItems = -1; // items of the resume entry that were already shown
  const hits: Hit[] = [];
  let total = 0;
  let searched = 0;
  let timedOut = false;
  let last: Position | undefined;
  const reached = (prefix: string, k: "e" | "n", id: string): boolean => resume!.s === prefix && resume!.k === k && resume!.id === id;

  scan: for (const [si, src] of sources.entries()) {
    if (src.searchEnd <= 0 && !(src.notes?.length)) continue;
    for (let i = src.searchEnd - 1; i >= 0; i--) {
      const e = src.entries[i];
      if (si > 0 && currentIds.has(e.id)) continue; // fork copies: reachable through the current session
      if (!resumed) {
        if (!reached(src.prefix, "e", String(e.id))) continue;
        resumed = true;
        if (resume!.i === undefined) continue; // that entry was finished last time
        skipItems = resume!.i;
      }
      if (searched > 0 && now() - start > budget) {
        timedOut = true;
        break scan;
      }
      searched++;
      for (const [idx, item] of entryItems(e).entries()) {
        if (idx <= skipItems) continue;
        const m = matcher(item.text);
        if (!m) continue;
        total++;
        if (hits.length < limit) hits.push({ id: `${src.prefix}${e.id}`, kind: item.kind, ts: e.timestamp ?? "", text: item.text, m, pos: { s: src.prefix, k: "e", id: String(e.id), i: idx } });
      }
      skipItems = -1;
      last = { s: src.prefix, k: "e", id: String(e.id) };
    }
    for (const note of [...(src.notes ?? [])].reverse()) {
      if (!resumed) {
        if (!reached(src.prefix, "n", String(note.n))) continue;
        resumed = true;
        continue; // notes are single items: already processed
      }
      if (searched > 0 && now() - start > budget) {
        timedOut = true;
        break scan;
      }
      searched++;
      const m = matcher(note.text);
      if (m) {
        total++;
        if (hits.length < limit) hits.push({ id: `${src.prefix}note:${note.n}`, kind: "relayNote", ts: "", text: note.text, m, pos: { s: src.prefix, k: "n", id: String(note.n) } });
      }
      last = { s: src.prefix, k: "n", id: String(note.n) };
    }
  }
  if (!resumed) return "recall: the cursor no longer matches this session (the entry it points to is gone); start the search again.";
  const cursorFor = (p: Position): string | undefined => query.length > QUERY_MAX ? undefined : encodeCursor({ v: 1, q: query, rx: opts.regex ? true : undefined, sc: opts.lineage ? "lineage" : undefined, p });
  if (!hits.length) {
    const resumeAt = timedOut && last ? cursorFor(last) : undefined;
    if (resumeAt) return `recall: no match for "${shownQuery}" in the ${searched} entries scanned before the time budget ran out; continue: recall({cursor:"${resumeAt}"})`;
    return searched || sources.some((s) => s.notes?.length)
      ? `recall: no match for "${shownQuery}" in ${searched} entries outside the current context.`
      : "recall: nothing to search — no compaction/relay has happened yet, so the whole history is still in your context.";
  }
  const lines: string[] = [];
  let size = 0;
  let shown = 0;
  for (const h of hits) {
    const line = cap(`[${h.id}] ${cap(h.kind, 60)}${h.ts ? ` @ ${h.ts}` : ""}\n  ${snippet(h.text, h.m)}`, HIT_MAX);
    if (size + line.length > SEARCH_CAP - FOOTER_RESERVE) break; // also guards the first hit
    lines.push(line);
    size += line.length + 1;
    shown++;
  }
  if (shown === 0) return `recall: matches exist but do not fit the output budget; refine the query "${shownQuery}".`;
  const more = total - shown;
  const cont = more > 0 ? cursorFor(hits[shown - 1].pos) : timedOut && last ? cursorFor(last) : undefined;
  const plus = timedOut ? "+" : "";
  const next = cont ? `; continue: recall({cursor:"${cont}"})` : "";
  if (more > 0) lines.push(`(${shown} of ${total}${plus} matches shown, newest first${next}; or refine the query / use recall({entryId}) to read one)`);
  else if (timedOut) lines.push(`(${shown} match${shown === 1 ? "" : "es"} so far; the time budget ran out after ${searched} entries${next})`);
  else lines.push(`(${shown} match${shown === 1 ? "" : "es"}; use recall({entryId}) to read one)`);
  return lines.join("\n");
}

/** The last `count` text-bearing entries outside the context (before the newest compaction), oldest first. */
export function recallTail(sources: Source[], count: number): string {
  const src = sources[0];
  count = Math.min(Math.max(Math.floor(Number(count)) || 20, 1), TAIL_MAX);
  if (!src || src.searchEnd <= 0) return "recall: nothing to review — no compaction/relay has happened yet, so the whole history is still in your context.";
  const picked: { e: Entry; items: ReturnType<typeof entryItems> }[] = [];
  for (let i = src.searchEnd - 1; i >= 0 && picked.length < count; i--) {
    const items = entryItems(src.entries[i]);
    if (items.length) picked.push({ e: src.entries[i], items });
  }
  const blocks = picked.reverse().map(({ e, items }) => {
    const body = items.slice(0, 4).map((it) => `  ${cap(it.kind, 60)}: ${cap(it.text.replace(/\s+/g, " ").trim(), 240)}`).join("\n");
    return cap(`[${e.id}]${e.timestamp ? ` @ ${e.timestamp}` : ""}\n${body}${items.length > 4 ? `\n  (+${items.length - 4} more items)` : ""}`, HIT_MAX);
  });
  // Over budget: drop the oldest blocks (the tail is about the most recent steps).
  let size = 0;
  let from = blocks.length;
  while (from > 0 && size + blocks[from - 1].length + 1 <= SEARCH_CAP - FOOTER_RESERVE) size += blocks[--from].length + 1;
  const shown = blocks.slice(from);
  return `${shown.join("\n")}\n(last ${shown.length} entries before the newest compaction, oldest first; read one with recall({entryId}) or its neighbours with recall({around:{entryId}}))`;
}

/** An entry plus its neighbours (file order), each shown as text, for "what happened around here". */
export function recallAround(sources: Source[], entryId: string, before?: number, after?: number): string {
  const shownId = cap(entryId, ECHO_MAX);
  let src = sources.find((s) => s.prefix !== "" && entryId.startsWith(s.prefix)) ?? sources[0];
  if (!src) return "recall: no session.";
  const bare = src.prefix && entryId.startsWith(src.prefix) ? entryId.slice(src.prefix.length) : entryId;
  let idx = src.entries.findIndex((e) => e.id === bare);
  if (idx < 0 && src.prefix === "") {
    for (const s of sources.slice(1)) {
      idx = s.entries.findIndex((e) => e.id === bare);
      if (idx >= 0) {
        src = s;
        break;
      }
    }
  }
  if (idx < 0) return `recall: entry ${shownId} not found.`;
  const clamp = (n: unknown): number => {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) ? Math.min(Math.max(v, 0), AROUND_MAX) : 3;
  };
  const from = Math.max(0, idx - clamp(before));
  const to = Math.min(src.entries.length - 1, idx + clamp(after));
  const n = to - from + 1;
  const unit = Math.max(80, Math.floor((FETCH_CAP - 300 - n * 170) / (n + 2)));
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    const e = src.entries[i];
    const mid = i === idx;
    out.push(`${mid ? ">> " : ""}[${src.prefix}${e.id}] ${e.type}${e.timestamp ? ` @ ${e.timestamp}` : ""}\n${clip(entryText(e), mid ? unit * 3 : unit)}`);
  }
  return cap(`${out.join("\n\n")}\n\n(${n} entries around ${cap(src.prefix + bare, ECHO_MAX)}; ">>" marks the requested one; full text: recall({entryId}))`, FETCH_CAP);
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

/**
 * Dispatch (first match wins): `entryId` (read one entry) > `around` (entry + neighbours) > `cursor` (continue a search)
 * > `tail` (recent steps) > `query` (search; `regex:true` for a regular expression). Wrong-typed args are ignored.
 */
export function recall(sources: Source[], params: RecallParams): string {
  if (typeof params.entryId === "string" && params.entryId) return recallFetch(sources, params.entryId, params.offset);
  const around = params.around;
  if (around && typeof around === "object" && typeof around.entryId === "string" && around.entryId) return recallAround(sources, around.entryId, around.before, around.after);
  if (typeof params.cursor === "string" && params.cursor) {
    const cursor = decodeCursor(params.cursor);
    if (!cursor) return "recall: invalid cursor (pass it back exactly as returned).";
    const lineage = cursor.sc === "lineage";
    return recallSearch(lineage ? sources : sources.slice(0, 1), cursor.q, params.limit, { regex: cursor.rx === true, resume: cursor.p, lineage });
  }
  if (typeof params.tail === "number" && params.tail > 0) return recallTail(sources, params.tail);
  if (typeof params.query === "string" && params.query.trim()) {
    const lineage = params.scope === "lineage";
    return recallSearch(lineage ? sources : sources.slice(0, 1), params.query, params.limit, { regex: params.regex === true, lineage });
  }
  return clip("recall: pass `query` (search), `entryId` (read), `around`, `tail` or `cursor`.", 200);
}
