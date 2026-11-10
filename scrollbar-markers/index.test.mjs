// Tests for scrollbar-markers.ts. Run: node --test index.test.mjs   (Node >= 23.6 strips TS types)
// Uses the REAL installed Pi modules: pi-tui (ScrollView, VStack, Container, Text, Spacer, layout.js
// renderLayoutFrame/getScrollbarGeometry) and pi-coding-agent (UserMessageComponent,
// AssistantMessageComponent, initTheme). Both bare specifiers are mapped to the installed files, so the
// extension, the components and the layout engine share one module instance - like in Pi itself, where
// the bundled CLI hands extensions its own (virtual) module instances.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const pcaRoot = path.join(
  process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
  "Volta/tools/image/packages/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-coding-agent",
);
const pcaIndex = path.join(pcaRoot, "dist/index.js");
const tuiDist = path.join(pcaRoot, "node_modules/@earendil-works/pi-tui/dist");
if (!existsSync(pcaIndex) || !existsSync(path.join(tuiDist, "index.js"))) {
  console.error("Installed Pi not found at " + pcaRoot);
  process.exit(1);
}
const pcaUrl = pathToFileURL(pcaIndex).href;
const tuiUrl = pathToFileURL(path.join(tuiDist, "index.js")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: pcaUrl, shortCircuit: true };
    if (specifier === "@earendil-works/pi-tui") return { url: tuiUrl, shortCircuit: true };
    return next(specifier, context);
  },
});

const pca = await import(pcaUrl);
const tui = await import(tuiUrl);
const layout = await import(pathToFileURL(path.join(tuiDist, "layout.js")).href);
pca.initTheme("dark", false);
const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
assert.ok(theme && typeof theme.fg === "function", "theme initialized");

// SBM_EXT=<path> runs the suite (e.g. the perf test) against another copy of the extension.
const ext = await import(process.env.SBM_EXT ? pathToFileURL(path.resolve(process.env.SBM_EXT)).href : "./index.ts");
const { ScrollView, VStack, Container, Text, Spacer } = tui;
const { UserMessageComponent, AssistantMessageComponent } = pca;

const ORIGINAL_USER_RENDER = UserMessageComponent.prototype.render;
const ORIGINAL_ASSISTANT_RENDER = AssistantMessageComponent.prototype.render;
const ORIGINAL_UPDATE_LAYOUT = ScrollView.prototype.updateLayout;

// Same styles Pi passes to createChatViewport.
const trackStyle = (t) => theme.fg("scrollbarTrack", t);
const thumbStyle = (t) => theme.fg("scrollbarThumb", t);
const blue = (t) => theme.fg("mdLink", t);
const white = (t) => `\x1b[97m${t}\x1b[39m`;

// ---- fake extension host ----
function loadExtension() {
  const handlers = new Map();
  const commands = new Map();
  const notes = [];
  ext.default({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, def) => commands.set(name, def),
  });
  const ctx = { mode: "tui", hasUI: true, ui: { theme, notify: (message, level) => notes.push([message, level]) } };
  return {
    start: () => handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx),
    shutdown: () => handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx),
    command: (args) => commands.get("scrollbar-markers").handler(args, ctx),
    notes,
  };
}
async function withExtension(fn) {
  const host = loadExtension();
  host.start();
  try {
    return await fn(host);
  } finally {
    host.shutdown();
  }
}

// ---- transcript like Pi's: document -> [header, chat -> messages] inside a primary ScrollView ----
const assistantMsg = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolCallMsg = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } }],
});
const thinkingMsg = (thinking) => ({ role: "assistant", content: [{ type: "thinking", thinking }] });
const filler = (n, tag) => new Text(Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join("\n"), 1, 0);

/** items: ["user", text] | ["assistant", text] | ["assistantTool", text] | ["thinking", text] | ["filler", n] */
function buildTranscript(items, { scrollbar = "always", primary = true } = {}) {
  const document = new Container();
  const chat = new Container();
  document.addChild(new Text("pi header", 0, 0));
  document.addChild(chat);
  const kinds = [];
  for (const [kind, arg] of items) {
    if (chat.children.length > 0) {
      chat.addChild(new Spacer(1));
      kinds.push(["spacer"]);
    }
    const component =
      kind === "user" ? new UserMessageComponent(arg)
      : kind === "assistant" ? new AssistantMessageComponent(assistantMsg(arg))
      : kind === "assistantTool" ? new AssistantMessageComponent(toolCallMsg(arg))
      : kind === "thinking" ? new AssistantMessageComponent(thinkingMsg(arg))
      : filler(arg, "f");
    chat.addChild(component);
    kinds.push([kind, component]);
  }
  const transcript = new ScrollView(document, {
    follow: "end",
    primary,
    overscroll: "chain",
    scrollbar,
    scrollbarTrackStyle: trackStyle,
    scrollbarThumbStyle: thumbStyle,
  });
  const dock = new Text("editor line 1\neditor line 2", 0, 0);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  return { document, chat, transcript, root, kinds };
}

/** Start line (in the document) of every chat item of the given kind, computed independently. */
function startLines(t, kind, width) {
  let line = t.document.children[0].render(width).length;
  const out = [];
  for (const child of t.chat.children) {
    const entry = t.kinds[t.chat.children.indexOf(child)];
    if (entry[0] === kind) out.push(line);
    line += child.render(width).length;
  }
  return out;
}

function frame(t, width, height) {
  const f = layout.renderLayoutFrame(t.root, width, height, () => {});
  const box = layout.getScrollViewBox(f, t.transcript);
  return { lines: f.lines, box, geometry: layout.getScrollbarGeometry(box) };
}

/** Classify the last cell of a screen line. */
function cell(line) {
  for (const [name, s] of [
    ["mark", blue("\u2501")],
    ["aiMark", white("\u2501")],
    ["thumbMark", blue("\u2503")],
    ["thumbMark", blue("\u2588")],
    ["track", trackStyle("\u2502")],
    ["thumb", thumbStyle("\u2503")],
    ["thumb", thumbStyle("\u2588")],
  ]) {
    if (line.endsWith(s)) return name;
  }
  return "none";
}

/** Undo the marker glyph so a marked screen line can be compared to the unmarked one. */
function unmark(line) {
  if (line.endsWith(blue("\u2501"))) return line.slice(0, -blue("\u2501").length) + trackStyle("\u2502");
  if (line.endsWith(white("\u2501"))) return line.slice(0, -white("\u2501").length) + trackStyle("\u2502");
  if (line.endsWith(blue("\u2503"))) return line.slice(0, -blue("\u2503").length) + thumbStyle("\u2503");
  return line;
}

const W = 60;
const H = 24;
const ITEMS = [
  ["filler", 30],
  ["user", "first prompt"],
  ["filler", 40],
  ["assistant", "answer one"],
  ["filler", 60],
  ["user", "second prompt\nwith two lines"],
  ["assistant", "answer two"],
  ["filler", 80],
  ["assistant", "far away answer"],
  ["filler", 50],
  ["user", "third prompt"],
  ["filler", 20],
];

test("blue marks at user prompt rows, white at AI reply rows (not on the thumb), user wins", async () => {
  await withExtension(async () => {
    const t = buildTranscript(ITEMS);
    frame(t, W, H); // first frame finds the transcript
    const thumbRowsSeen = new Set();
    // follow-end, then various scroll positions (thumb moves over marked and unmarked rows)
    for (const scroll of [undefined, 0, 25, 60, 120, 200, 10_000]) {
      if (scroll !== undefined) t.transcript.scrollTo(scroll);
      const { lines, box, geometry } = frame(t, W, H);
      const contentWidth = W - 1;
      const contentHeight = t.document.render(contentWidth).length;
      const track = box.rect.height;
      assert.equal(geometry.trackHeight, track);
      assert.ok(contentHeight > track);
      const rowOf = (l) => Math.min(track - 1, Math.floor((l * track) / contentHeight));
      const userRows = new Set(startLines(t, "user", contentWidth).map(rowOf));
      const assistantRows = new Set(startLines(t, "assistant", contentWidth).map(rowOf));
      assert.equal(userRows.size, 3);
      assert.ok([...assistantRows].some((r) => !userRows.has(r)), "test needs an assistant on its own row");
      for (let r = 0; r < track; r++) {
        const isThumb = r >= geometry.thumbTop && r < geometry.thumbTop + geometry.thumbHeight;
        const expected =
          userRows.has(r) ? (isThumb ? "thumbMark" : "mark")
          : isThumb ? "thumb"
          : assistantRows.has(r) ? "aiMark"
          : "track";
        if (isThumb && userRows.has(r)) thumbRowsSeen.add(r);
        assert.equal(cell(lines[r]), expected, `scroll ${scroll} row ${r}`);
      }
      // Rows below the transcript (dock) are untouched.
      for (let r = track; r < H; r++) assert.equal(cell(lines[r]), "none");
    }
    assert.ok(thumbRowsSeen.size > 0, "some scroll position put the thumb over a mark");
    // Extra style calls without a new layout (double paint) overflow the row counter -> original glyphs.
    for (let i = 0; i < H; i++) t.transcript.scrollbarTrackStyle("\u2502");
    assert.equal(t.transcript.scrollbarTrackStyle("\u2502"), trackStyle("\u2502"));
    assert.equal(t.transcript.scrollbarThumbStyle("\u2503"), thumbStyle("\u2503"));
  });
});

test("attaching requests one extra frame (async) so marks show without waiting for input", async () => {
  await withExtension(async () => {
    const t = buildTranscript(ITEMS);
    let requests = 0;
    layout.renderLayoutFrame(t.root, W, H, () => requests++);
    assert.equal(requests, 0, "not synchronous");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requests, 1);
    layout.renderLayoutFrame(t.root, W, H, () => requests++);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requests, 1, "only once per attach");
  });
});

test("thumb row containing a prompt start is drawn as a blue thumb", async () => {
  await withExtension(async () => {
    const t = buildTranscript([["user", "at the top"], ["filler", 200]]);
    frame(t, W, H);
    t.transcript.scrollToStart();
    const { lines, geometry } = frame(t, W, H);
    assert.equal(geometry.thumbTop, 0);
    assert.equal(cell(lines[0]), "thumbMark");
    assert.equal(cell(lines[1]), "thumb");
  });
});

test("transcript content and screen are unchanged except the marked scrollbar cells", async () => {
  const t = buildTranscript(ITEMS);
  const before = t.document.render(W - 1).slice();
  frame(t, W, H);
  const offFrame = frame(t, W, H).lines;
  await withExtension(async (host) => {
    frame(t, W, H);
    assert.deepEqual(t.document.render(W - 1), before, "document lines identical (incl. OSC 133)");
    const onFrame = frame(t, W, H).lines;
    assert.ok(onFrame.some((l) => cell(l) === "mark"));
    assert.deepEqual(onFrame.map(unmark), offFrame);
    await host.command("off");
    assert.deepEqual(frame(t, W, H).lines, offFrame, "off -> identical to no extension");
    await host.command("on");
    assert.deepEqual(frame(t, W, H).lines, onFrame);
  });
  assert.deepEqual(frame(t, W, H).lines, offFrame, "after shutdown identical to no extension");
});

test("no marks when the transcript fits, when the scrollbar is hidden, or for non-primary ScrollViews", async () => {
  await withExtension(async () => {
    const small = buildTranscript([["user", "hi"], ["assistant", "hello"]]);
    frame(small, W, H);
    const smallLines = frame(small, W, H).lines;
    assert.ok(smallLines.some((l) => cell(l) === "thumb"), "always-scrollbar is drawn");
    assert.ok(!smallLines.some((l) => ["mark", "thumbMark", "aiMark"].includes(cell(l))));

    const hidden = buildTranscript(ITEMS, { scrollbar: "hidden" });
    frame(hidden, W, H);
    const hiddenLines = frame(hidden, W, H).lines;
    assert.ok(hiddenLines.every((l) => cell(l) === "none"));

    const secondary = buildTranscript(ITEMS, { primary: false });
    frame(secondary, W, H);
    assert.ok(!frame(secondary, W, H).lines.some((l) => ["mark", "thumbMark", "aiMark"].includes(cell(l))));
    assert.equal(Object.prototype.hasOwnProperty.call(secondary.document, "render"), false);
  });
});

test('"auto" scrollbar: marks appear while the scrollbar is shown', async () => {
  await withExtension(async () => {
    const t = buildTranscript(ITEMS, { scrollbar: "auto" });
    frame(t, W, H);
    assert.ok(frame(t, W, H).lines.every((l) => cell(l) === "none"), "auto scrollbar hidden when idle");
    t.transcript.scrollBy(-5); // marks scrollbar activity (1s timer, unref'd)
    const lines = frame(t, W, H).lines;
    assert.ok(lines.some((l) => cell(l) === "mark"));
  });
});

test("command: on/off/toggle/status and bad args", async () => {
  await withExtension(async (host) => {
    const t = buildTranscript(ITEMS);
    frame(t, W, H);
    frame(t, W, H);
    await host.command("status");
    assert.match(
      host.notes.at(-1)[0],
      /^Scrollbar markers on \(AI replies on\), 3 prompt\(s\) \(blue\), 3 AI reply\(s\) \(white\), scrollbar "always"/,
    );
    await host.command("");
    assert.match(host.notes.at(-1)[0], /^Scrollbar markers off/);
    assert.ok(!frame(t, W, H).lines.some((l) => cell(l) === "mark" || cell(l) === "aiMark"));
    await host.command("toggle");
    assert.ok(frame(t, W, H).lines.some((l) => cell(l) === "mark"));
    await host.command("bogus");
    assert.equal(host.notes.at(-1)[1], "warning");
    // AI marks only
    assert.ok(frame(t, W, H).lines.some((l) => cell(l) === "aiMark"));
    await host.command("ai off");
    assert.match(host.notes.at(-1)[0], /^Scrollbar markers on \(AI replies off\)/);
    let lines = frame(t, W, H).lines;
    await host.command("status");
    assert.match(host.notes.at(-1)[0], /3 prompt\(s\) \(blue\), 0 AI reply\(s\)/, "ai off: no AI work in the scan");
    assert.ok(!lines.some((l) => cell(l) === "aiMark"), "ai off: no white marks");
    assert.ok(lines.some((l) => cell(l) === "mark"), "ai off: blue marks stay");
    await host.command("ai");
    assert.ok(frame(t, W, H).lines.some((l) => cell(l) === "aiMark"), "ai toggles back on");
    await host.command("ai toggle");
    await host.command("AI  ON");
    lines = frame(t, W, H).lines;
    assert.ok(lines.some((l) => cell(l) === "aiMark") && lines.some((l) => cell(l) === "mark"));
    await host.command("ai bogus");
    assert.equal(host.notes.at(-1)[1], "warning");
  });
  assert.equal(ext.parseMarkersArg(" OFF "), "off");
  assert.equal(ext.parseMarkersArg(undefined), "toggle");
  assert.equal(ext.parseMarkersArg("ai"), "ai-toggle");
  assert.equal(ext.parseMarkersArg(" ai   off "), "ai-off");
  assert.equal(ext.parseMarkersArg("ai on"), "ai-on");
  assert.equal(ext.parseMarkersArg("aion"), undefined);
});

test("reload: no stacked wrappers, last shutdown restores prototypes and instance fields", async () => {
  const t = buildTranscript(ITEMS);
  const origTrack = t.transcript.scrollbarTrackStyle;
  const a = loadExtension();
  a.start();
  const patchedLayout = ScrollView.prototype.updateLayout;
  const patchedUser = UserMessageComponent.prototype.render;
  const patchedAssistant = AssistantMessageComponent.prototype.render;
  assert.notEqual(patchedLayout, ORIGINAL_UPDATE_LAYOUT);
  assert.notEqual(patchedAssistant, ORIGINAL_ASSISTANT_RENDER);
  frame(t, W, H);
  const b = loadExtension(); // /reload: the new instance starts before/after the old one shuts down
  b.start();
  assert.equal(ScrollView.prototype.updateLayout, patchedLayout, "not patched twice");
  assert.equal(UserMessageComponent.prototype.render, patchedUser);
  assert.equal(AssistantMessageComponent.prototype.render, patchedAssistant);
  a.shutdown();
  frame(t, W, H);
  const lines = frame(t, W, H).lines;
  assert.ok(lines.some((l) => cell(l) === "mark"), "still active after the old instance shut down");
  assert.ok(lines.some((l) => cell(l) === "aiMark"));
  assert.ok(!lines.some((l) => l.includes(blue(blue("\u2501")))), "no double styling");
  b.shutdown();
  assert.equal(ScrollView.prototype.updateLayout, ORIGINAL_UPDATE_LAYOUT);
  assert.equal(UserMessageComponent.prototype.render, ORIGINAL_USER_RENDER);
  assert.equal(AssistantMessageComponent.prototype.render, ORIGINAL_ASSISTANT_RENDER, "assistant patch removed");
  assert.equal(t.transcript.scrollbarTrackStyle, origTrack);
  assert.equal(Object.prototype.hasOwnProperty.call(t.document, "render"), false);
  assert.equal(globalThis[Symbol.for("pi.scrollbar-markers.install")], undefined);
  // A fresh start after a full shutdown works again.
  await withExtension(async () => {
    frame(t, W, H);
    assert.ok(frame(t, W, H).lines.some((l) => cell(l) === "mark"));
  });
});

test("non-tui modes do not install anything", () => {
  const handlers = new Map();
  ext.default({ on: (n, h) => handlers.set(n, h), registerCommand: () => {} });
  handlers.get("session_start")({}, { mode: "print", hasUI: false, ui: {} });
  assert.equal(ScrollView.prototype.updateLayout, ORIGINAL_UPDATE_LAYOUT);
  assert.equal(AssistantMessageComponent.prototype.render, ORIGINAL_ASSISTANT_RENDER);
  handlers.get("session_shutdown")({}, {});
});

/** Track rows of the start lines of the given kind, for the current frame. */
function rowsOf(t, kind, box) {
  const contentWidth = W - 1;
  const contentHeight = t.document.render(contentWidth).length;
  const track = box.rect.height;
  return startLines(t, kind, contentWidth).map((l) => Math.min(track - 1, Math.floor((l * track) / contentHeight)));
}

/** Screen line `row` with the marks switched off (same scroll position). */
function frameWithoutMarks(t, row) {
  const state = globalThis[Symbol.for("pi.scrollbar-markers.install")];
  state.enabled = false;
  try {
    return frame(t, W, H).lines[row];
  } finally {
    state.enabled = true;
  }
}

test("AI reply without tool calls gets a white mark; tool-call and thinking-only messages do not", async () => {
  await withExtension(async (host) => {
    const t = buildTranscript([
      ["filler", 60],
      ["assistantTool", "let me read the file"],
      ["filler", 60],
      ["thinking", "only thinking, same first line as a reply"],
      ["filler", 60],
      ["assistant", "the actual reply"],
      ["filler", 60],
    ]);
    frame(t, W, H);
    t.transcript.scrollToStart();
    const { lines, box, geometry } = frame(t, W, H);
    const [toolRow] = rowsOf(t, "assistantTool", box);
    const [thinkingRow] = rowsOf(t, "thinking", box);
    const [replyRow] = rowsOf(t, "assistant", box);
    assert.equal(new Set([toolRow, thinkingRow, replyRow]).size, 3, "distinct rows");
    const isThumb = (r) => r >= geometry.thumbTop && r < geometry.thumbTop + geometry.thumbHeight;
    assert.ok(![toolRow, thinkingRow, replyRow].some(isThumb), "none of them under the thumb");
    // The thinking-only message also starts with OSC 133;A + a blank line (same text as the reply's first
    // line); the FIFO matching must still put the white mark on the reply, not on the thinking message.
    const thinkingFirst = t.kinds.find((k) => k[0] === "thinking")[1].render(W - 1)[0];
    const replyFirst = t.kinds.find((k) => k[0] === "assistant")[1].render(W - 1)[0];
    assert.equal(thinkingFirst, replyFirst, "test premise: identical first lines");
    assert.ok(replyFirst.startsWith("\x1b]133;A"));
    assert.equal(cell(lines[replyRow]), "aiMark");
    assert.equal(cell(lines[toolRow]), "track");
    assert.equal(cell(lines[thinkingRow]), "track");
    assert.deepEqual(
      lines.map((l, r) => [r, cell(l)]).filter(([, c]) => c === "aiMark").map(([r]) => r),
      [replyRow],
      "exactly one white mark",
    );
    await host.command("status");
    assert.match(host.notes.at(-1)[0], /0 prompt\(s\) \(blue\), 1 AI reply\(s\) \(white\)/);
  });
});

test("renders outside the transcript are ignored; missing private fields fail closed and are reported", async () => {
  await withExtension(async (host) => {
    const t = buildTranscript([["filler", 80], ["assistant", "reply one"], ["filler", 80], ["assistant", "reply two"], ["filler", 80]]);
    frame(t, W, H);
    const before = frame(t, W, H).lines;
    // A reply rendered elsewhere (another view, export, ...) between transcript frames is not collected.
    const outside = new AssistantMessageComponent(assistantMsg("elsewhere"));
    outside.render(W - 1);
    assert.deepEqual(frame(t, W, H).lines, before);
    await host.command("status");
    assert.match(host.notes.at(-1)[0], /2 AI reply\(s\)/);
    assert.doesNotMatch(host.notes.at(-1)[0], /detection unavailable/);
    // Simulate a Pi update that renamed the private field: that message is no longer marked.
    const [, first] = t.kinds.find((k) => k[0] === "assistant");
    first.hasToolCalls = undefined;
    frame(t, W, H);
    const lines = frame(t, W, H).lines;
    assert.equal(lines.filter((l) => cell(l) === "aiMark").length, 1, "only the intact reply is marked");
    await host.command("status");
    assert.match(host.notes.at(-1)[0], /1 AI reply\(s\).*AI reply detection unavailable/);
  });
});

test("user (blue) wins when a prompt and a reply share a row", async () => {
  await withExtension(async () => {
    // Pick a lead-in so that the prompt and the reply right after it fall into the same track row.
    let t, lines, box, geometry, userRow, sharedReplyRow, lonelyRow;
    for (let lead = 200; lead < 240; lead += 3) {
      t = buildTranscript([
        ["filler", lead],
        ["user", "question"],
        ["assistant", "short answer"],
        ["filler", 200],
        ["assistant", "lonely answer"],
        ["filler", 40],
      ]);
      frame(t, W, H);
      t.transcript.scrollToStart();
      ({ lines, box, geometry } = frame(t, W, H));
      [userRow] = rowsOf(t, "user", box);
      [sharedReplyRow, lonelyRow] = rowsOf(t, "assistant", box);
      if (userRow === sharedReplyRow) break;
    }
    assert.equal(userRow, sharedReplyRow, "test premise: same row");
    assert.notEqual(lonelyRow, userRow);
    assert.ok(userRow >= geometry.thumbTop + geometry.thumbHeight, "not under the thumb");
    assert.equal(cell(lines[userRow]), "mark");
    assert.equal(cell(lines[lonelyRow]), "aiMark");
  });
});

test("AI reply on a thumb row leaves the thumb unchanged", async () => {
  await withExtension(async () => {
    const t = buildTranscript([["assistant", "reply at the top"], ["filler", 200], ["assistant", "later reply"], ["filler", 100]]);
    frame(t, W, H);
    t.transcript.scrollToStart();
    const { lines, box, geometry } = frame(t, W, H);
    const [topRow, laterRow] = rowsOf(t, "assistant", box);
    assert.equal(topRow, 0);
    assert.equal(geometry.thumbTop, 0);
    assert.equal(cell(lines[0]), "thumb");
    assert.equal(lines[0], frameWithoutMarks(t, 0), "thumb row identical to the unmarked one");
    assert.equal(cell(lines[laterRow]), "aiMark", "off-thumb reply still marked");
  });
});

test("helpers: isAssistantReply, findMessageStarts", () => {
  const reply = new AssistantMessageComponent(assistantMsg("hi"));
  const tool = new AssistantMessageComponent(toolCallMsg("checking"));
  const thinking = new AssistantMessageComponent(thinkingMsg("hmm"));
  const empty = new AssistantMessageComponent();
  assert.equal(ext.isAssistantReply(reply, reply.render(40)), true);
  assert.equal(ext.isAssistantReply(tool, tool.render(40)), false);
  assert.equal(ext.isAssistantReply(thinking, thinking.render(40)), false);
  assert.equal(ext.isAssistantReply(empty, empty.render(40)), false, "no lines");
  assert.equal(ext.isAssistantReply({}, ["x"]), false, "no hasToolCalls field");
  assert.equal(ext.isAssistantReply({ hasToolCalls: false }, ["x"]), false, "no lastMessage: fail closed");
  assert.equal(ext.isAssistantReply({ hasToolCalls: false, lastMessage: assistantMsg(" ") }, ["x"]), false, "blank text");
  const osc = "\x1b]133;A\x07";
  const { KIND_USER: U, KIND_AI: A, KIND_OTHER: O } = ext;
  // FIFO per text: [other, ai] for the same text -> the 2nd occurrence is the AI reply.
  assert.deepEqual(
    ext.findMessageStarts(["a", osc, "b", osc + "u", osc, osc], [osc, osc + "u", osc], [O, U, A]),
    { user: [3], ai: [4] },
  );
  assert.deepEqual(ext.findMessageStarts(["a"], [osc], [O]), { user: [], ai: [] });
  assert.deepEqual(ext.findMessageStarts(["", "x", ""], ["", ""], [O, A]), { user: [], ai: [2] }, "without OSC prefix");
});

test("helpers: geometry matches pi-tui, findUserStarts", () => {
  const t = buildTranscript(ITEMS);
  for (const scroll of [0, 7, 1000]) {
    t.transcript.scrollTo(scroll);
    const { geometry, box } = frame(t, W, H);
    const contentHeight = box.children[0].rect.height;
    const g = ext.thumbGeometry(contentHeight, geometry.trackHeight, t.transcript.scrollTop);
    assert.deepEqual([g.top, g.height], [geometry.thumbTop - geometry.trackTop, geometry.thumbHeight]);
  }
  const osc = "\x1b]133;A\x07";
  assert.deepEqual(ext.findUserStarts(["a", osc + "u", osc, "b", osc + "u"], [osc + "u", osc + "u"]), [1, 4]);
  assert.deepEqual(ext.findUserStarts(["a", "b"], []), []);
  assert.deepEqual(ext.findUserStarts(["x", "u"], ["u"]), [1], "works without the OSC prefix too");
});

test("perf: 20k-line transcript", async () => {
  const items = [];
  for (let i = 0; i < 400; i++) items.push(["user", `prompt ${i}`], ["filler", 21], ["assistant", `reply ${i}`], ["filler", 21]);
  const t = buildTranscript(items);
  const width = 120;
  const height = 50;
  const median = (fn, n) => {
    const times = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(n / 2)];
  };
  for (let i = 0; i < 5; i++) frame(t, width, height);
  const off = median(() => frame(t, width, height), 40);
  const lines = t.document.render(width - 1);
  await withExtension(async () => {
    for (let i = 0; i < 5; i++) frame(t, width, height);
    const on = median(() => frame(t, width, height), 40);
    const userFirst = lines[startLines(t, "user", width - 1)[0]];
    const firsts = Array.from({ length: 400 }, () => userFirst);
    const scan = median(() => ext.findUserStarts(lines, firsts), 200);
    let both = NaN;
    if (ext.findMessageStarts) {
      const replyFirst = lines[startLines(t, "assistant", width - 1)[0]];
      const texts = [];
      const kinds = [];
      for (let i = 0; i < 400; i++) texts.push(userFirst, replyFirst), kinds.push(ext.KIND_USER, ext.KIND_AI);
      both = median(() => ext.findMessageStarts(lines, texts, kinds), 200);
      const found = ext.findMessageStarts(lines, texts, kinds);
      assert.equal(found.user.length, 400);
      assert.equal(found.ai.length, 400);
    }
    // In-process attribution: transcript render through the wrapper (collect + report + scan) vs the plain
    // Container render (message wrappers only do a null check then), interleaved to cancel drift.
    const state = globalThis[Symbol.for("pi.scrollbar-markers.install")];
    const plainRender = Object.getPrototypeOf(t.document).render;
    const wrapped = [];
    const plain = [];
    const wrappedAiOff = [];
    for (let i = 0; i < 60; i++) {
      let t0 = performance.now();
      t.document.render(width - 1);
      wrapped.push(performance.now() - t0);
      t0 = performance.now();
      plainRender.call(t.document, width - 1);
      plain.push(performance.now() - t0);
      state.aiEnabled = false;
      t0 = performance.now();
      t.document.render(width - 1);
      wrappedAiOff.push(performance.now() - t0);
      state.aiEnabled = true;
    }
    const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(
      `# ${lines.length} lines, 400 prompts + 400 replies: frame off ${off.toFixed(2)} ms, on ${on.toFixed(2)} ms, ` +
        `user-only scan ${(scan * 1000).toFixed(0)} us, user+ai scan ${(both * 1000).toFixed(0)} us; ` +
        `transcript render plain ${med(plain).toFixed(2)} ms, wrapped ${med(wrapped).toFixed(2)} ms, ` +
        `wrapped ai-off ${med(wrappedAiOff).toFixed(2)} ms`,
    );
    assert.ok(lines.length >= 20000);
    assert.equal(ext.findUserStarts(lines, firsts).length, 400);
    assert.ok(scan < 5, "scan well below a frame budget");
  });
});
