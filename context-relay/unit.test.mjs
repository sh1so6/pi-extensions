// Unit tests of the pure parts of context-relay: note builder, recall search/fetch, subagent detection, git section.
// Run: node --test context-relay/unit.test.mjs   (from E:\Dev\TS\Pi)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AUTO_DEFAULTS, cacheExpiry, cacheTtlMs, formatTokens, parseAuto } from "./auto.ts";
import { RESEND_ENTRY_TYPE, buildResendRecord, fingerprintHeldItem } from "./audit.ts";
import { isSubagentSession } from "./detect.ts";
import { applyContextEdits, contextStartIndex } from "./entries.ts";
import { collectGit } from "./git.ts";
import { buildNote, collectSubagents, modifiedFiles, pickFirstKept, subagentWorktrees, worktreePathsIn } from "./note.ts";
import { entryItems, isUserMessage } from "./entries.ts";
import { SEARCH_CAP, currentSource, readAncestors, recall } from "./recall.ts";

// ---------- fixtures shaped like real session entries ----------
let seq = 0;
const ts = () => `2026-10-30T10:${String(Math.floor(seq / 60) % 60).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}.000Z`;
const base = (type, extra) => {
  seq++;
  return { type, id: `e${String(seq).padStart(7, "0")}`, parentId: null, timestamp: ts(), ...extra };
};
const user = (text) => base("message", { message: { role: "user", content: text, timestamp: seq } });
const assistant = (content) => base("message", { message: { role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content, stopReason: "stop" } });
const call = (name, args, id = `call_${seq + 1}`) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (toolName, text, extra = {}) => base("message", { message: { role: "toolResult", toolCallId: "x", toolName, content: [{ type: "text", text }], ...extra } });
const record = (data) => base("custom", { customType: "subagents:record", data });
const notification = (details) => base("custom_message", { customType: "subagent-notification", content: "<task-notification/>", display: true, details });

function conversation() {
  seq = 0;
  const e = [];
  e.push(user("最初の依頼: 桟橋を作って"));
  e.push(assistant([{ type: "text", text: "調べます" }, call("bash", { command: "ls Assets/Pier" }, "c1")]));
  e.push(toolResult("bash", "PierSpec.md\nPierBuilder.cs\nSECRET-TOKEN-ALPHA appears here"));
  e.push(assistant([{ type: "text", text: "編集します" }, call("edit", { path: "E:\\proj\\Assets\\Pier\\PierBuilder.cs", edits: [] }, "c2"), call("write", { path: "E:/proj/Assets/Pier/Notes.md", content: "x" }, "c3")]));
  e.push(toolResult("edit", "ok"));
  const spawn = assistant([call("Agent", { subagent_type: "worker", name: "wt-a", description: "build pier in worktree", prompt: "..." }, "ag1")]);
  e.push(spawn);
  e.push(base("message", { message: { role: "toolResult", toolCallId: "ag1", toolName: "Agent", content: [{ type: "text", text: "Agent started in background.\nAgent ID: run-0001" }], details: { agentId: "run-0001", subagentType: "worker", description: "build pier in worktree", status: "background" } } }));
  e.push(assistant("桟橋の下準備ができました。サブエージェントを走らせています。"));
  e.push(
    record({ id: "done-0002", type: "designer", description: "Research planks", status: "completed", result: "Use 3 planks.\nSecond line\nThird line\nFourth line", startedAt: 1, completedAt: 2 }),
  );
  e.push(notification({ id: "done-0002", description: "Research planks", status: "completed", resultPreview: "Use 3 planks." }));
  e.push(record({ id: "bad-0003", type: "worker", description: "Broken job", status: "error", result: "", error: "boom", startedAt: 1, completedAt: 2 }));
  e.push(record({ id: "wt-0004", type: "worker", description: "worktree job", status: "completed", result: "Done in F:\\Dev\\Unity\\Worktrees\\proj-ai1\\Assets on branch ai/ai1 (commit abc123)", startedAt: 1, completedAt: 2 }));
  e.push(user("次の依頼: 手すりも付けて"));
  e.push(assistant([{ type: "text", text: "手すりを付けます" }, call("read", { path: "x" }, "c4")]));
  e.push(toolResult("read", "rail file contents with UNIQUE-RAIL-MARKER"));
  e.push(assistant("手すりを付けました。最終回答です。"));
  return e;
}

test("pickFirstKept: latest user message; falls back to Pi's cut", () => {
  const e = conversation();
  const lastUser = e.findLast((x) => x.type === "message" && x.message.role === "user");
  assert.equal(pickFirstKept(e, e[3].id), lastUser.id);
  assert.equal(pickFirstKept([e[1], e[2]], "fallback"), "fallback");
  // a huge last turn: Pi's later cut wins when the tail exceeds the cap
  const piCut = e.at(-1).id;
  assert.equal(pickFirstKept(e, piCut, 10), piCut);
  assert.equal(pickFirstKept(e, piCut, 1e9), lastUser.id);
});

test("collectSubagents: running / completed / failed, worktree + branch from results", () => {
  const subs = collectSubagents(conversation());
  const by = Object.fromEntries(subs.map((s) => [s.id, s]));
  assert.equal(by["run-0001"].status, "running");
  assert.equal(by["run-0001"].name, "wt-a");
  assert.equal(by["done-0002"].status, "completed");
  assert.equal(by["bad-0003"].status, "failed");
  assert.equal(by["wt-0004"].worktree, "F:/Dev/Unity/Worktrees/proj-ai1");
  assert.equal(by["wt-0004"].branch, "ai/ai1");
  assert.deepEqual(subagentWorktrees(conversation()), ["F:/Dev/Unity/Worktrees/proj-ai1"]);
  assert.deepEqual(worktreePathsIn("see C:\\x\\.claude\\worktrees\\feat-1\\src and D:\\nope\\file.txt"), ["C:/x/.claude/worktrees/feat-1"]);
});

test("a background agent that later completes is no longer running", () => {
  const e = conversation();
  e.push(record({ id: "run-0001", type: "worker", description: "build pier in worktree", status: "completed", result: "all good" }));
  assert.equal(collectSubagents(e).find((s) => s.id === "run-0001").status, "completed");
});

test("modifiedFiles: edit/write paths, normalized, newest first", () => {
  assert.deepEqual(modifiedFiles(conversation()), ["E:/proj/Assets/Pier/Notes.md", "E:/proj/Assets/Pier/PierBuilder.cs"]);
});

function noteFor(entries, extra = {}) {
  const firstKeptEntryId = pickFirstKept(entries, entries[0].id);
  return buildNote({ entries, firstKeptEntryId, index: 1, sessionId: "sess-1", sessionStart: "2026-10-30T10:00:00.000Z", cwd: "E:/proj", notePath: "C:/n/1.md", now: new Date("2026-10-30T11:00:00Z"), ...extra });
}

test("buildNote: sections, running marker, files, commits, footer", () => {
  const entries = conversation();
  const note = noteFor(entries, { git: [{ label: "E:/proj [main]", lines: ["abc1234 add pier", "def5678 add rail"] }] });
  assert.match(note, /^# Context hand-off #1/);
  assert.match(note, /最初の依頼: 桟橋を作って/);
  assert.doesNotMatch(note, /次の依頼: 手すりも付けて/, "the latest user message is kept verbatim, not duplicated in the note");
  assert.match(note, /## Last assistant answer before the kept exchange\n桟橋の下準備ができました/);
  assert.match(note, /⚠ RUNNING since 10-30 10:\d\dZ [^\n]*run-0001 "wt-a" \(worker\) build pier in worktree/);
  assert.match(note, /COMPLETED: done-0002 \(designer\) Research planks → Use 3 planks\. Second line Third line/);
  assert.match(note, /FAILED: bad-0003/);
  assert.match(note, /worktree: F:\/Dev\/Unity\/Worktrees\/proj-ai1, branch: ai\/ai1/);
  assert.match(note, /- E:\/proj\/Assets\/Pier\/PierBuilder\.cs/);
  assert.match(note, /abc1234 add pier/);
  assert.match(note, /`recall`/);
  assert.match(note, /This note: C:\/n\/1\.md/);
  assert.ok(note.length <= 9500, `note ${note.length} chars`);
  // running agents come before finished ones
  assert.ok(note.indexOf("RUNNING") < note.indexOf("COMPLETED"));
});

test("buildNote: with a later cut (long last turn) the dropped part of the last exchange is listed", () => {
  const entries = conversation();
  const cut = entries.at(-1).id; // keep only the final answer
  const note = buildNote({ entries, firstKeptEntryId: cut, index: 2, sessionId: "s", cwd: "c", notePath: "p" });
  assert.match(note, /## Last assistant answer before the kept exchange\n桟橋の下準備ができました/);
  assert.match(note, /次の依頼: 手すりも付けて/, "now dropped from context, so listed");
});

test("buildNote: caps — many long user messages and subagents stay within the budget; running agents survive", () => {
  seq = 0;
  const e = [];
  for (let i = 0; i < 40; i++) {
    e.push(user(`指示${i}: ${"あ".repeat(3000)}`));
    e.push(assistant(`回答${i}`));
    e.push(record({ id: `agent-${String(i).padStart(4, "0")}`, type: "worker", description: `job ${i} ${"d".repeat(300)}`, status: "completed", result: "r".repeat(2000) }));
  }
  e.push(base("message", { message: { role: "toolResult", toolCallId: "z", toolName: "Agent", content: [], details: { agentId: "still-running-1", subagentType: "worker", description: "long job", status: "background" } } }));
  e.push(user("最後の指示"));
  const note = noteFor(e);
  assert.ok(note.length <= 9500, `note ${note.length} chars`);
  assert.match(note, /RUNNING[^\n]*still-running-1/);
  assert.match(note, /指示39/);
  assert.match(note, /earlier messages omitted — use recall/);
  assert.doesNotMatch(note, /指示0:/);
});

test("buildNote: chains the previous relay note (condensed) and uses the window since the boundary", () => {
  const entries = conversation();
  const first = noteFor(entries);
  // simulate: compaction kept from the latest user message
  const keptId = pickFirstKept(entries, entries[0].id);
  const compaction = base("compaction", { summary: first, firstKeptEntryId: keptId, tokensBefore: 1000, details: { relay: true, version: 1, notePath: "C:/n/1.md" } });
  const more = [...entries, compaction, user("三つ目の依頼: 灯りを付けて"), assistant("付けました。"), user("四つ目の依頼")];
  const second = noteFor(more);
  assert.match(second, /Earlier \(condensed from previous notes\):\n- \[[^\]]*\] 最初の依頼: 桟橋を作って/);
  assert.match(second, /Since then:\n- \[[^\]]*\] 次の依頼: 手すりも付けて\n- \[[^\]]*\] 三つ目の依頼: 灯りを付けて/);
  assert.doesNotMatch(second, /四つ目の依頼/);
  assert.ok(second.length <= 9500);
});

test("buildNote: extraSections (M3 seam) are appended before the footer", () => {
  const note = noteFor(conversation(), { extraSections: [{ title: "LLM digest", body: "x".repeat(5000) }] });
  assert.match(note, /## LLM digest\nx+…\[\d+ chars cut\]\n\n## Older details/);
});

// ---------- recall ----------
function compactedSession() {
  const entries = conversation();
  const keptId = pickFirstKept(entries, entries[0].id);
  const compaction = base("compaction", { summary: "NOTE", firstKeptEntryId: keptId, tokensBefore: 1, details: { relay: true } });
  return { entries: [...entries, compaction, user("新しい依頼")], keptId };
}

test("contextStartIndex: entries before the latest firstKeptEntryId are out of context", () => {
  const { entries, keptId } = compactedSession();
  assert.equal(entries[contextStartIndex(entries)].id, keptId);
  assert.equal(contextStartIndex(conversation()), 0);
});

test("recall search: AND terms, case-insensitive, only outside the context, kinds + snippet, newest first", () => {
  const { entries } = compactedSession();
  const out = recall([currentSource(entries)], { query: "secret-token ALPHA" });
  assert.match(out, /\[e\d+\] toolResult:bash @ 2026-/);
  assert.match(out, /SECRET-TOKEN-ALPHA appears here/);
  assert.match(out, /\(1 match;/);
  // text that is still in the kept context is not searched
  assert.match(recall([currentSource(entries)], { query: "UNIQUE-RAIL-MARKER" }), /no match/);
  // tool call args and assistant text and subagent records
  assert.match(recall([currentSource(entries)], { query: "ls Assets/Pier" }), /toolCall:bash/);
  assert.match(recall([currentSource(entries)], { query: "調べます" }), /assistant/);
  assert.match(recall([currentSource(entries)], { query: "planks" }), /subagent:record|custom:subagent-notification/);
  // AND semantics: a term that never co-occurs gives no match
  assert.match(recall([currentSource(entries)], { query: "planks SECRET-TOKEN-ALPHA" }), /no match/);
});

test("recall search: nothing to search before any compaction; limit and output cap", () => {
  assert.match(recall([currentSource(conversation())], { query: "pier" }), /nothing to search/);
  seq = 0;
  const e = [];
  for (let i = 0; i < 100; i++) {
    e.push(user(`needle ${i} ${"filler ".repeat(200)}`));
    e.push(assistant("ok"));
  }
  e.push(base("compaction", { summary: "n", firstKeptEntryId: e.at(-1).id, tokensBefore: 1 }));
  const few = recall([currentSource(e)], { query: "needle", limit: 3 });
  assert.equal(few.match(/^\[e\d+\]/gm).length, 3);
  assert.match(few, /3 of 100 matches shown/);
  const many = recall([currentSource(e)], { query: "needle", limit: 30 });
  assert.ok(many.length <= SEARCH_CAP + 300, `search output ${many.length}`);
});

test("recall fetch: full text of an entry, offset paging, images as [image], notes", () => {
  seq = 0;
  const big = "0123456789".repeat(2500); // 25k chars
  const e = [toolResult("bash", big), base("message", { message: { role: "toolResult", toolName: "read", content: [{ type: "image", data: "AAA", mimeType: "image/png" }, { type: "text", text: "caption" }] } })];
  e.push(base("compaction", { summary: "n", firstKeptEntryId: e.at(-1).id, tokensBefore: 1 }));
  const src = currentSource(e, [{ n: 2, path: "C:/n/2.md", text: "# Context hand-off #2 — NOTEWORD" }]);
  const first = recall([src], { entryId: e[0].id });
  assert.match(first, /chars 0-12000 of 25\d+/);
  assert.match(first, new RegExp(`offset:12000`));
  const second = recall([src], { entryId: e[0].id, offset: 12000 });
  assert.match(second, /chars 12000-24000/);
  const last = recall([src], { entryId: e[0].id, offset: 24000 });
  assert.doesNotMatch(last, /more chars/);
  assert.match(recall([src], { entryId: e[1].id }), /\[image\]\ncaption/);
  assert.match(recall([src], { query: "noteword" }), /\[note:2\] relayNote/);
  assert.match(recall([src], { entryId: "note:2" }), /NOTEWORD/);
  assert.match(recall([src], { entryId: "nope" }), /not found/);
  assert.match(recall([src], {}), /pass `query`/);
});

test("recall lineage: parent session entries are searched only with scope lineage", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "relay-lineage-"));
  try {
    const parent = path.join(tmp, "parent.jsonl");
    const header = { type: "session", version: 3, id: "parentid-1234", timestamp: "2026-01-01T00:00:00Z", cwd: "x" };
    const pe = { type: "message", id: "aaaa1111", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "ancestor-only phrase ZEBRA" } };
    writeFileSync(parent, [header, pe].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const ancestors = readAncestors(parent, 4, (id) => path.join(tmp, "notes", id));
    assert.equal(ancestors.length, 1);
    seq = 0;
    const e = [user("hello"), base("compaction", { summary: "n", firstKeptEntryId: "zzz", tokensBefore: 1 })];
    const cur = currentSource(e);
    assert.match(recall([cur], { query: "zebra" }), /nothing to search|no match/);
    const hit = recall([cur, ...ancestors], { query: "zebra", scope: "lineage" });
    assert.match(hit, /\[parentid\/aaaa1111\] user/);
    assert.match(recall([cur, ...ancestors], { entryId: "parentid/aaaa1111" }), /ancestor-only phrase ZEBRA/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- detection ----------
test("isSubagentSession: without a mode, hasUI decides; the session name is not consulted", () => {
  const sm = (name) => ({ getSessionName: () => name });
  assert.equal(isSubagentSession({ hasUI: true, sessionManager: sm(undefined) }), false);
  assert.equal(isSubagentSession({ hasUI: true, sessionManager: sm("my project") }), false);
  assert.equal(isSubagentSession({ hasUI: false, sessionManager: sm(undefined) }), true);
  assert.equal(isSubagentSession({ sessionManager: sm(undefined) }), true);
  // Regression: a pi-subagents session resumed by a person keeps its name but is a main session.
  assert.equal(isSubagentSession({ hasUI: true, sessionManager: sm("designer#0a1b2c3d") }), false);
  assert.equal(isSubagentSession({ hasUI: true, sessionManager: sm("worker#AbCdEF12") }), false);
});

test("isSubagentSession: mode decides when reported (tui / rpc are main, print / json are headless)", () => {
  const sm = (name) => ({ getSessionName: () => name });
  // RPC hands extensions a real UI context (hasUI true), and it is a main session.
  assert.equal(isSubagentSession({ mode: "rpc", hasUI: true, sessionManager: sm("pi-rpc-worker") }), false);
  assert.equal(isSubagentSession({ mode: "tui", hasUI: true, sessionManager: sm(undefined) }), false);
  // One-shot modes are headless (pi-subagents children: print, no UI), even if a UI context were present.
  assert.equal(isSubagentSession({ mode: "print", hasUI: false, sessionManager: sm("worker#0a1b2c3d") }), true);
  assert.equal(isSubagentSession({ mode: "print", hasUI: true, sessionManager: sm(undefined) }), true);
  assert.equal(isSubagentSession({ mode: "json", hasUI: false, sessionManager: sm(undefined) }), true);
  // The name never overrides an interactive mode.
  assert.equal(isSubagentSession({ mode: "rpc", hasUI: true, sessionManager: sm("worker#0a1b2c3d") }), false);
  assert.equal(isSubagentSession({ mode: "tui", hasUI: true, sessionManager: sm("worker#0A1B2C3D") }), false);
});

// ---------- audit entries ----------
test("audit: held items are fingerprinted with sha256 of the exact text", () => {
  // sha256("hello") — a re-sent user entry with this text pairs with the held input deterministically.
  assert.deepEqual(fingerprintHeldItem({ text: "hello" }), {
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    chars: 5,
    images: 0,
  });
  assert.equal(fingerprintHeldItem({ text: "x", images: [{}, {}] }).images, 2);
  assert.notEqual(fingerprintHeldItem({ text: "hello" }).sha256, fingerprintHeldItem({ text: "hello " }).sha256);
});

test("audit: resend records carry the held items' fingerprints", () => {
  assert.equal(RESEND_ENTRY_TYPE, "context-relay:resend");
  const resend = buildResendRecord({ at: "2026-11-11T00:00:00.000Z", trigger: "input", items: [{ text: "a" }, { text: "bc", images: [{}] }] });
  assert.equal(resend.v, 1);
  assert.equal(resend.trigger, "input");
  assert.equal(resend.totalChars, 3);
  assert.equal(resend.items.length, 2);
  assert.equal(resend.items[1].images, 1);
  assert.equal(resend.items[0].sha256, fingerprintHeldItem({ text: "a" }).sha256);
});

// ---------- git ----------
test("collectGit: commits since session start; worktrees included; failures omitted", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "relay-git-"));
  try {
    const run = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    const repo = path.join(tmp, "repo");
    mkdirSync(repo);
    run(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "a");
    run(repo, "add", ".");
    run(repo, "commit", "-q", "-m", "first commit");
    const wt = path.join(tmp, "worktrees", "feat");
    run(repo, "worktree", "add", "-q", "-b", "ai/feat", wt);
    writeFileSync(path.join(wt, "b.txt"), "b");
    run(wt, "add", ".");
    run(wt, "commit", "-q", "-m", "worktree commit");
    const sections = await collectGit(repo, "2000-01-01T00:00:00Z", [wt, path.join(tmp, "missing")]);
    assert.equal(sections.length, 2);
    assert.match(sections[0].label, /\[main\]/);
    assert.ok(sections[0].lines.some((l) => l.includes("first commit")));
    assert.match(sections[1].label, /\[ai\/feat\]/);
    assert.ok(sections[1].lines.some((l) => l.includes("worktree commit")));
    assert.deepEqual(await collectGit(repo, new Date(Date.now() + 864e5).toISOString(), []), [], "nothing since the future");
    assert.deepEqual(await collectGit(tmp, "2000-01-01T00:00:00Z", []), [], "not a repo: omitted");
    assert.deepEqual(await collectGit(repo, undefined, []), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- M2: auto config, cache expiry ----------
const asst = (timestamp, usage, stopReason = "stop") => ({ type: "message", message: { role: "assistant", timestamp, stopReason, usage } });

test("parseAuto: defaults, overrides, wrong types fall back", () => {
  assert.deepEqual(parseAuto(undefined), AUTO_DEFAULTS);
  assert.equal(AUTO_DEFAULTS.inputMinTokens, 100_000);
  assert.equal(AUTO_DEFAULTS.expiryMinTokens, 140_000);
  const cfg = parseAuto({ onInput: false, inputMinTokens: 5, expiryMinTokens: "many", beforeExpiry: 1, minGrowthTokens: -3 });
  assert.deepEqual(cfg, { ...AUTO_DEFAULTS, onInput: false, inputMinTokens: 5 });
});

const ANTH = { api: "anthropic-messages" };

test("cacheTtlMs: anthropic 5 min / 1 h, declared promptCache (seconds), unknown providers -> undefined", () => {
  assert.equal(cacheTtlMs(ANTH, "short"), 300_000);
  assert.equal(cacheTtlMs(ANTH, "long"), 3_600_000);
  // declared lifetimes win, also on non-anthropic APIs; only the declared tier is known
  const declared = { api: "openai-responses", promptCache: { short: 1800, long: 86_400 } };
  assert.equal(cacheTtlMs(declared, "short"), 1_800_000);
  assert.equal(cacheTtlMs(declared, "long"), 86_400_000);
  assert.equal(cacheTtlMs({ api: "openai-completions", promptCache: { short: 600 } }, "long"), undefined);
  assert.equal(cacheTtlMs({ ...ANTH, promptCache: { short: 120 } }, "short"), 120_000);
  // best-effort caches (DeepSeek automatic disk cache, OpenAI without a declared lifetime, ...) and no model
  assert.equal(cacheTtlMs({ api: "openai-completions" }, "short"), undefined);
  assert.equal(cacheTtlMs({ api: "openai-responses" }, "long"), undefined);
  assert.equal(cacheTtlMs(undefined, "short"), undefined);
});

test("cacheExpiry: unknown cache lifetime (e.g. DeepSeek, undeclared OpenAI) never yields an expiry, even with cache usage", () => {
  const used = [asst(1_000_000, { cacheRead: 0, cacheWrite: 5000, cacheWrite1h: 0 })];
  assert.equal(cacheExpiry(used, { api: "openai-completions" }), undefined);
  assert.equal(cacheExpiry(used, undefined), undefined);
  assert.equal(cacheExpiry(used, { api: "openai-completions", promptCache: { short: 300 } }).expiresAt, 1_300_000);
});

test("cacheExpiry: 5 min tier by default, 1 h when the newest cache write has cacheWrite1h, model promptCache overrides", () => {
  const short = [asst(1_000_000, { cacheRead: 0, cacheWrite: 5000, cacheWrite1h: 0 })];
  assert.deepEqual(cacheExpiry(short, ANTH), { expiresAt: 1_300_000, ttlMs: 300_000, tier: "short" });
  assert.equal(cacheExpiry(short, { ...ANTH, promptCache: { short: 120 } }).expiresAt, 1_120_000);
  // a later cache READ keeps the 1 h tier of the earlier write and refreshes the timestamp
  const long = [asst(1_000_000, { cacheRead: 0, cacheWrite: 5000, cacheWrite1h: 5000 }), asst(2_000_000, { cacheRead: 5000, cacheWrite: 0 })];
  assert.deepEqual(cacheExpiry(long, ANTH), { expiresAt: 2_000_000 + 3_600_000, ttlMs: 3_600_000, tier: "long" });
  assert.equal(cacheExpiry(long, { ...ANTH, promptCache: { long: 7200 } }).ttlMs, 7_200_000);
});

test("cacheExpiry: none without cache activity, after a compaction, or with only failed requests; failed ones do not refresh", () => {
  assert.equal(cacheExpiry([], ANTH), undefined);
  assert.equal(cacheExpiry([asst(1, { cacheRead: 0, cacheWrite: 0 })], ANTH), undefined);
  assert.equal(cacheExpiry([asst(1, { cacheRead: 0, cacheWrite: 10 }), { type: "compaction" }], ANTH), undefined);
  assert.equal(cacheExpiry([asst(1, { cacheRead: 0, cacheWrite: 10 }, "error")], ANTH), undefined);
  const mixed = [asst(1_000, { cacheRead: 0, cacheWrite: 10 }), asst(9_000, { cacheRead: 0, cacheWrite: 0 }, "aborted")];
  assert.equal(cacheExpiry(mixed, ANTH).expiresAt, 1_000 + 300_000);
  const warmed = [asst(1_000, { cacheRead: 0, cacheWrite: 10 }), { type: "usage", kind: "cache_warm", timestamp: new Date(50_000).toISOString() }];
  assert.equal(cacheExpiry(warmed, ANTH).expiresAt, 50_000 + 300_000);
});

test("formatTokens", () => {
  assert.deepEqual([formatTokens(null), formatTokens(850), formatTokens(4710), formatTokens(152_300)], ["?", "850", "4.7k", "152k"]);
});

// ---------- context_edit fidelity ----------
const edit = (targetId, replacement) => base("context_edit", { targetId, replacement });

test("applyContextEdits: omitted -> no text/never a user message, replaced -> new content, latest edit wins, raw kept", () => {
  seq = 0;
  const secret = user("PASSWORD-IS-HUNTER2 please deploy");
  const fixed = user("original wording");
  const out = toolResult("bash", "SECRET-DUMP");
  const reply = assistant([{ type: "text", text: "editing" }, call("edit", { path: "E:/proj/a.cs" })]);
  const raw = [secret, fixed, reply, out, edit(secret.id, null), edit(fixed.id, { content: "first" }), edit(fixed.id, { content: "[redacted]" }), edit(out.id, { content: "dump removed" }), edit(reply.id, null)];
  const p = applyContextEdits(raw);
  assert.equal(p.length, raw.length, "positions are preserved");
  assert.equal(p[0].type, "context_omitted");
  assert.deepEqual(entryItems(p[0]), []);
  assert.equal(isUserMessage(p[0]), false);
  assert.equal(p[1].message.content, "[redacted]");
  assert.deepEqual(p[3].message.content, [{ type: "text", text: "dump removed" }], "tool results get a text block");
  assert.equal(raw[0].type, "message", "input not mutated");
  assert.deepEqual(modifiedFiles(p), ["E:/proj/a.cs"], "a file edited by an omitted assistant turn was still edited");
});

test("buildNote / recall: redacted user text does not come back through the note or recall", () => {
  seq = 0;
  const first = user("DELETE-ME-SECRET: the password is hunter2");
  const second = user("REPLACE-ME-ORIGINAL do the thing");
  const entries = [first, assistant("ok"), second, assistant("done"), user("latest instruction"), assistant("fin"), edit(first.id, null), edit(second.id, { content: "REPLACEMENT-TEXT" })];
  const projected = applyContextEdits(entries);
  const note = noteFor(projected, { firstKeptEntryId: entries[4].id });
  assert.ok(!note.includes("DELETE-ME-SECRET") && !note.includes("hunter2"), note);
  assert.ok(!note.includes("REPLACE-ME-ORIGINAL"));
  assert.match(note, /REPLACEMENT-TEXT/);
  // recall: a relay entry later, everything before the kept user message is searchable
  const comp = base("compaction", { summary: "n", firstKeptEntryId: entries[4].id, tokensBefore: 1 });
  const all = [...entries, comp];
  assert.match(recall([currentSource(all)], { query: "hunter2" }), /no match/);
  assert.match(recall([currentSource(all)], { query: "REPLACE-ME-ORIGINAL" }), /no match/);
  assert.match(recall([currentSource(all)], { query: "REPLACEMENT-TEXT" }), /\[e\d+\] user/);
  assert.match(recall([currentSource(all)], { entryId: first.id }), /omitted from the model context/);
});

// ---------- recall output budget / argument handling ----------
test("recall: output never exceeds the budget (huge query, huge snippets, no-match echo, unknown entryId)", () => {
  seq = 0;
  const huge = "a".repeat(20_000);
  const e = [user(`before ${huge} after`), assistant(huge), toolResult("bash", `${huge} ${"b".repeat(5000)}`), user("kept"), assistant("ok")];
  e.push(base("compaction", { summary: "n", firstKeptEntryId: e.at(-2).id, tokensBefore: 1 }));
  const src = [currentSource(e)];
  const hit = recall(src, { query: huge });
  assert.ok(hit.length <= SEARCH_CAP, `huge-term hit: ${hit.length}`);
  assert.match(hit, /^\[e\d+\]/);
  const miss = recall(src, { query: `${huge}z` });
  assert.ok(miss.length < 400, `no-match message echoes a clipped query: ${miss.length}`);
  assert.match(miss, /no match/);
  const lots = recall(src, { query: "a", limit: 30 });
  assert.ok(lots.length <= SEARCH_CAP, `many big hits: ${lots.length}`);
  const unknown = recall(src, { entryId: "z".repeat(20_000) });
  assert.ok(unknown.length < 400, `unknown id echo: ${unknown.length}`);
  assert.ok(recall(src, { entryId: `note:${"9".repeat(20_000)}` }).length < 400);
});

test("recall: entryId wins over query; wrong-typed / out-of-range arguments are clamped or ignored", () => {
  const { entries } = compactedSession();
  const src = [currentSource(entries)];
  const target = entries.find((x) => entryItems(x).some((i) => i.text.includes("SECRET-TOKEN-ALPHA")));
  assert.match(recall(src, { query: "planks", entryId: target.id }), /--- toolResult:bash ---/);
  assert.match(recall(src, { query: 42 }), /pass `query`/);
  assert.match(recall(src, { entryId: 7 }), /pass `query`/);
  assert.match(recall(src, { query: "secret-token", limit: -5 }), /1 match/);
  assert.match(recall(src, { query: "secret-token", limit: "lots" }), /1 match/);
  assert.match(recall(src, { entryId: target.id, offset: -10 }), /chars 0-/);
  assert.match(recall(src, { entryId: target.id, offset: Number.POSITIVE_INFINITY }), /past the end/);
  assert.match(recall(src, { entryId: target.id, offset: "abc" }), /chars 0-/);
});
