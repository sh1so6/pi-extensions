// Dependency-free tests for fold-buttons.ts. Run: node index.test.mjs  (Node >= 23.6 strips TS types)
// @earendil-works/pi-coding-agent is replaced with a tiny stub via module.registerHooks.
// @earendil-works/pi-tui is the real installed package if found (for Container/MouseRegion/ScrollView
// and East-Asian-width-aware visibleWidth), otherwise a stub.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const realTui = path.join(
  process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
  "Volta/tools/image/packages/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-coding-agent",
  "node_modules/@earendil-works/pi-tui/dist/index.js",
);
const stubTui =
  "export const visibleWidth = (s) => [...s.replace(/\\x1b\\[[0-9;]*m/g, '')]" +
  ".reduce((w, c) => w + (/[\\u3000-\\u9fff\\uff00-\\uffef]/.test(c) ? 2 : 1), 0);";
const stubs = {
  "@earendil-works/pi-coding-agent": "export const getAgentDir = () => globalThis.__foldAgentDir;",
};
const tuiUrl = existsSync(realTui)
  ? pathToFileURL(realTui).href
  : "data:text/javascript," + encodeURIComponent(stubTui);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in stubs) {
      return { url: "data:text/javascript," + encodeURIComponent(stubs[specifier]), shortCircuit: true };
    }
    if (specifier === "@earendil-works/pi-tui") return { url: tuiUrl, shortCircuit: true };
    return next(specifier, context);
  },
});

const agentDir = mkdtempSync(path.join(tmpdir(), "fold-buttons-test-"));
globalThis.__foldAgentDir = agentDir;
const settingsPath = path.join(agentDir, "settings.json");
const mod = await import("./index.ts");
const { scanFoldTargets, readHideThinkingSetting, parseFoldArg, expandedStateOf } = mod;
const { wrapHeaderOnly, isHeaderOnly, setHeaderOnly, HeaderOnlyResult, isToolExecutionHost } = mod;
const tuiLib = await import(tuiUrl);
const usingRealTui = typeof tuiLib.Container === "function";

// ---- fakes mimicking Pi internals ----
class FakeAssistant {
  children = [];
  overrides = new Map([[0, false]]);
  constructor(hide) { this.hideThinkingBlock = hide; }
  setHideThinkingBlock(hide) { this.hideThinkingBlock = hide; this.overrides.clear(); }
  render() { return []; }
}
class FakeTool {
  updates = 0;
  constructor(expanded) { this.expanded = expanded; }
  setExpanded(expanded) { this.expanded = expanded; this.updates++; }
  render() { return []; }
}
class FakeEditor {
  actionHandlers = new Map();
  render() { return []; }
}
const container = (...children) => ({ children, render: () => [] });
const region = (child) => ({ child, render: () => [] });

/** Builds a tree shaped like Pi's: TUI -> [document -> [header, chat], editorContainer -> editor, widgets]. */
function buildTree({ hide = false, toolsExpanded = false, withEditor = true } = {}) {
  const app = { hideThinkingBlock: hide, toolsExpanded, toggles: 0 };
  const assistants = [new FakeAssistant(hide), new FakeAssistant(hide)];
  const tools = [new FakeTool(toolsExpanded), new FakeTool(toolsExpanded)];
  const chat = container(container(region({ render: () => [] })), assistants[0], tools[0], assistants[1], tools[1]);
  const editor = new FakeEditor();
  editor.actionHandlers.set("app.thinking.toggle", () => {
    app.toggles++;
    app.hideThinkingBlock = !app.hideThinkingBlock;
    for (const a of assistants) a.setHideThinkingBlock(app.hideThinkingBlock);
  });
  const root = container(
    container(container(), chat),
    container(withEditor ? editor : { render: () => [] }),
    container(),
  );
  root.requestRender = () => { root.renders = (root.renders ?? 0) + 1; };
  return { app, assistants, tools, chat, editor, root };
}

test("scanFoldTargets finds editor toggle, assistants and expandables in order", () => {
  const { root, assistants, tools, editor } = buildTree();
  const scan = scanFoldTargets(root);
  assert.equal(scan.thinkingToggle, editor.actionHandlers.get("app.thinking.toggle"));
  assert.deepEqual(scan.thinkingHosts, assistants);
  assert.deepEqual(scan.expandables, tools);
});

test("scanFoldTargets firstThinkingOnly stops at the first assistant", () => {
  const { root, assistants } = buildTree();
  const scan = scanFoldTargets(root, { firstThinkingOnly: true });
  assert.deepEqual(scan.thinkingHosts, [assistants[0]]);
  assert.equal(scan.thinkingToggle, undefined);
  assert.deepEqual(scan.expandables, []);
});

test("scanFoldTargets is cycle-safe, depth-limited and tolerates junk", () => {
  const a = { children: [] };
  const b = { children: [a], child: a };
  a.children.push(b, null, 42, "x");
  a.child = a;
  assert.deepEqual(scanFoldTargets(a).thinkingHosts, []);
  assert.deepEqual(scanFoldTargets(null).thinkingHosts, []);
  assert.deepEqual(scanFoldTargets(undefined).expandables, []);

  // A chain deeper than the limit: the assistant at depth 100 is not reached.
  let deep = new FakeAssistant(true);
  for (let i = 0; i < 100; i++) deep = { children: [deep] };
  assert.equal(scanFoldTargets(deep).thinkingHosts.length, 0);
  let shallow = new FakeAssistant(true);
  for (let i = 0; i < 10; i++) shallow = { child: shallow };
  assert.equal(scanFoldTargets(shallow).thinkingHosts.length, 1);
  // actionHandlers that is not a Map, or without the action, is ignored.
  assert.equal(scanFoldTargets({ actionHandlers: { "app.thinking.toggle": () => {} } }).thinkingToggle, undefined);
  assert.equal(scanFoldTargets({ actionHandlers: new Map([["x", () => {}]]) }).thinkingToggle, undefined);
});

test("scanFoldTargets walks real pi-tui Container / MouseRegion / ScrollView", { skip: !usingRealTui }, () => {
  const { Container, MouseRegion, ScrollView } = tuiLib;
  const chat = new Container();
  const assistant = new FakeAssistant(false);
  const tool = new FakeTool(false);
  chat.addChild(new MouseRegion(assistant, () => undefined));
  chat.addChild(tool);
  const doc = new Container();
  doc.addChild(chat);
  const root = new Container();
  root.addChild(new ScrollView(doc, {}));
  const scan = scanFoldTargets(root);
  assert.deepEqual(scan.thinkingHosts, [assistant]);
  assert.deepEqual(scan.expandables, [tool]);
});

test("expandedStateOf / readHideThinkingSetting / parseFoldArg", () => {
  assert.equal(expandedStateOf({ setExpanded() {}, expanded: true }), true);
  assert.equal(expandedStateOf({ setExpanded() {}, _expanded: false }), false);
  assert.equal(expandedStateOf({ setExpanded() {} }), undefined);

  const file = path.join(agentDir, "s.json");
  assert.equal(readHideThinkingSetting(path.join(agentDir, "missing.json")), undefined);
  writeFileSync(file, "\uFEFF{\"hideThinkingBlock\": true}");
  assert.equal(readHideThinkingSetting(file), true);
  writeFileSync(file, "{bad json");
  assert.equal(readHideThinkingSetting(file), undefined);
  writeFileSync(file, "{\"hideThinkingBlock\": \"yes\"}");
  assert.equal(readHideThinkingSetting(file), undefined);

  assert.equal(parseFoldArg(""), "toggle");
  assert.equal(parseFoldArg(" Toggle "), "toggle");
  assert.equal(parseFoldArg("on"), "on");
  assert.equal(parseFoldArg("OFF"), "off");
  assert.equal(parseFoldArg("maybe"), undefined);
});

// ---- end-to-end through the extension's default export with fake pi/ctx ----
const tick = () => new Promise((r) => setTimeout(r, 5));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function loadExtension(tree, { hasUI = true } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const notes = [];
  const resolvers = [];
  let widget;
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, opts) => commands.set(name, opts),
    registerToolRenderer: (resolver) => resolvers.push(resolver),
  };
  const ctx = {
    hasUI,
    ui: {
      theme: { fg: (_c, s) => s, bold: (s) => s },
      notify: (msg, level) => notes.push([level, msg]),
      getToolsExpanded: () => tree.app.toolsExpanded,
      setToolsExpanded: (v) => {
        if (v === tree.app.toolsExpanded) return;
        tree.app.toolsExpanded = v;
        for (const t of tree.tools) t.setExpanded(v);
      },
      setWidget: (key, factory, options) => {
        assert.equal(key, "fold-buttons");
        assert.deepEqual(options, { placement: "belowEditor" });
        widget = factory(tree.root, ctx.ui.theme);
      },
    },
  };
  mod.default(pi);
  handlers.get("session_start")({ type: "session_start" }, ctx);
  return { handlers, commands, notes, ctx, resolvers, widget: () => widget };
}

function click(widget, x) {
  const ev = (type) => ({ type, button: "left", x, y: 0 });
  assert.deepEqual(widget.handleMouse(ev("press")), { handled: true });
  assert.deepEqual(widget.handleMouse(ev("click")), { handled: true });
}

test("button: expanded -> click collapses thinking (via Ctrl+T handler) and tools", async () => {
  const tree = buildTree({ hide: false, toolsExpanded: true });
  const ext = loadExtension(tree);
  await tick();
  const w = ext.widget();
  const line = strip(w.render(80)[0]);
  assert.equal(line, " Fold: [▾ 全て畳む]");
  // Misses: wrong row, right button, outside label.
  assert.equal(w.handleMouse({ type: "click", button: "left", x: 8, y: 1 }), undefined);
  assert.equal(w.handleMouse({ type: "click", button: "right", x: 8, y: 0 }), undefined);
  assert.equal(w.handleMouse({ type: "click", button: "left", x: 2, y: 0 }), undefined);

  click(w, 8);
  assert.equal(tree.app.toggles, 1);
  assert.equal(tree.app.hideThinkingBlock, true);
  assert.ok(tree.assistants.every((a) => a.hideThinkingBlock && a.overrides.size === 0));
  assert.equal(tree.app.toolsExpanded, false);
  assert.ok(tree.tools.every((t) => t.expanded === false));
  assert.equal(strip(w.render(80)[0]), " Fold: [▸ 全て展開]");

  // Click again: expands both.
  click(w, 8);
  assert.equal(tree.app.toggles, 2);
  assert.equal(tree.app.hideThinkingBlock, false);
  assert.equal(tree.app.toolsExpanded, true);
  assert.equal(strip(w.render(80)[0]), " Fold: [▾ 全て畳む]");
  assert.deepEqual(ext.notes, []);
});

test("mixed state: thinking hidden but tools expanded -> collapse does not toggle thinking back", async () => {
  const tree = buildTree({ hide: true, toolsExpanded: true });
  const ext = loadExtension(tree);
  await tick();
  const w = ext.widget();
  assert.equal(strip(w.render(80)[0]), " Fold: [▾ 全て畳む]");
  tree.assistants[0].overrides.set(1, false); // a block expanded individually
  click(w, 8);
  assert.equal(tree.app.toggles, 0);
  assert.equal(tree.app.hideThinkingBlock, true);
  assert.equal(tree.assistants[0].overrides.size, 0, "per-message overrides reset");
  assert.equal(tree.app.toolsExpanded, false);
});

test("individually expanded tool is collapsed even if global flag already matches", async () => {
  const tree = buildTree({ hide: false, toolsExpanded: false });
  const ext = loadExtension(tree);
  await tick();
  tree.tools[1].expanded = true;
  await ext.commands.get("fold-all").handler("on", ext.ctx);
  assert.equal(tree.app.toggles, 1);
  assert.equal(tree.tools[1].expanded, false);
  assert.equal(tree.tools[0].updates, 0, "unchanged tools are not re-rendered");
});

test("/fold-all on|off|toggle and invalid args", async () => {
  const tree = buildTree({ hide: false, toolsExpanded: true });
  const ext = loadExtension(tree);
  await tick();
  const cmd = ext.commands.get("fold-all");
  await cmd.handler("on", ext.ctx);
  assert.equal(tree.app.hideThinkingBlock, true);
  await cmd.handler("on", ext.ctx); // idempotent
  assert.equal(tree.app.toggles, 1);
  await cmd.handler("", ext.ctx); // toggle -> expand
  assert.equal(tree.app.hideThinkingBlock, false);
  assert.equal(tree.app.toolsExpanded, true);
  await cmd.handler("off", ext.ctx);
  assert.equal(tree.app.toggles, 2);
  await cmd.handler("bogus", ext.ctx);
  assert.equal(ext.notes.at(-1)[0], "warning");
  assert.deepEqual(cmd.getArgumentCompletions("o").map((i) => i.value), ["on", "off"]);
});

test("no assistant messages yet: state from settings.json, then tracked after toggle", async () => {
  writeFileSync(settingsPath, JSON.stringify({ hideThinkingBlock: true }));
  try {
    const tree = buildTree({ hide: true, toolsExpanded: false });
    tree.chat.children = tree.chat.children.filter((c) => !(c instanceof FakeAssistant));
    const ext = loadExtension(tree);
    await tick();
    const w = ext.widget();
    // Thinking hidden + tools collapsed, but header-only mode starts OFF -> still "collapse".
    assert.equal(strip(w.render(80)[0]), " Fold: [▾ 全て畳む]");
    click(w, 8);
    assert.equal(tree.app.toggles, 0, "thinking already hidden");
    assert.equal(isHeaderOnly(), true);
    assert.equal(strip(w.render(80)[0]), " Fold: [▸ 全て展開]");
    click(w, 8);
    assert.equal(tree.app.toggles, 1);
    assert.equal(tree.app.toolsExpanded, true);
    // settings.json still says true (Pi writes asynchronously); last-known state wins.
    assert.equal(strip(w.render(80)[0]), " Fold: [▾ 全て畳む]");
  } finally {
    rmSync(settingsPath, { force: true });
  }
});

test("fallback without editor handler: per-component, warns once", async () => {
  const tree = buildTree({ hide: false, toolsExpanded: false, withEditor: false });
  const ext = loadExtension(tree);
  await tick();
  await ext.commands.get("fold-all").handler("on", ext.ctx);
  assert.ok(tree.assistants.every((a) => a.hideThinkingBlock));
  await ext.commands.get("fold-all").handler("off", ext.ctx);
  assert.ok(tree.assistants.every((a) => !a.hideThinkingBlock));
  assert.equal(ext.notes.filter(([l]) => l === "warning").length, 1);
});

test("narrow width hides the button; no UI -> no widget", async () => {
  const tree = buildTree();
  const ext = loadExtension(tree);
  await tick();
  assert.deepEqual(ext.widget().render(10), [""]);
  assert.equal(ext.widget().handleMouse({ type: "click", button: "left", x: 8, y: 0 }), undefined);
  const ext2 = loadExtension(buildTree(), { hasUI: false });
  assert.equal(ext2.widget(), undefined);
});

// ---- shared toolbar button registry ----

const TOOLBAR = Symbol.for("pi.toolbar.buttons");

test("toolbarButtons() creates and reuses the globalThis registry; sorting ignores invalid entries", () => {
  delete globalThis[TOOLBAR];
  const map = mod.toolbarButtons();
  assert.ok(map instanceof Map);
  assert.equal(globalThis[TOOLBAR], map);
  assert.equal(mod.toolbarButtons(), map);
  assert.equal(mod.TOOLBAR_BUTTONS_KEY, TOOLBAR);
  const f = () => {};
  map.set("b", { label: "[B]", onClick: f });
  map.set("a", { label: "[A]", onClick: f });
  map.set("z", { label: "[Z]", order: -1, onClick: f });
  map.set("bad1", { label: "[X]" });
  map.set("bad2", { label: "two\nlines", onClick: f });
  map.set("bad3", null);
  map.set("y", { label: "[Y]", order: 5, onClick: f });
  assert.deepEqual(mod.sortedToolbarButtons(map).map(([id]) => id), ["z", "a", "b", "y"]);
  delete globalThis[TOOLBAR];
});

test("toolbar buttons: rendered after the fold label, hit ranges from render positions, click runs onClick", async () => {
  delete globalThis[TOOLBAR];
  const map = mod.toolbarButtons();
  const clicks = [];
  map.set("x.search", { label: "[🔍 Everything]", order: 100, onClick: () => clicks.push("search") });
  map.set("x.first", { label: "[一]", order: 1, onClick: () => clicks.push("first") });
  const tree = buildTree({ hide: false, toolsExpanded: true });
  const ext = loadExtension(tree);
  await tick();
  const w = ext.widget();
  const line = strip(w.render(80)[0]);
  assert.equal(line, " Fold: [▾ 全て畳む]  [一]  [🔍 Everything]");
  // " Fold: " = 7, fold label = 12 -> 19; gap 2 -> [一] at 21..25 (一 is 2 wide); gap 2 -> 27..42
  const first = 21;
  const search = 27;
  const searchEnd = search + 15; // [ + 🔍(2) + space + Everything(10) + ]
  // gaps and the space between buttons are not clickable
  assert.equal(w.handleMouse({ type: "press", button: "left", x: 19, y: 0 }), undefined);
  assert.equal(w.handleMouse({ type: "press", button: "left", x: 20, y: 0 }), undefined);
  assert.equal(w.handleMouse({ type: "press", button: "left", x: 25, y: 0 }), undefined);
  assert.equal(w.handleMouse({ type: "press", button: "left", x: 26, y: 0 }), undefined);
  // press is claimed without acting; click runs onClick
  assert.deepEqual(w.handleMouse({ type: "press", button: "left", x: first, y: 0 }), { handled: true });
  assert.deepEqual(clicks, []);
  click(w, first + 3);
  click(w, search);
  const lastCol = searchEnd - 1;
  click(w, lastCol);
  assert.deepEqual(clicks, ["first", "search", "search"]);
  assert.equal(w.handleMouse({ type: "click", button: "left", x: lastCol + 1, y: 0 }), undefined);
  assert.equal(w.handleMouse({ type: "click", button: "right", x: search, y: 0 }), undefined);
  assert.equal(w.handleMouse({ type: "click", button: "left", x: search, y: 1 }), undefined);
  // the fold toggle still works and the fold state is unaffected by button clicks
  assert.equal(tree.app.toggles, 0);
  click(w, 8);
  assert.equal(tree.app.toggles, 1);
  assert.deepEqual(ext.notes, []);
  delete globalThis[TOOLBAR];
});

test("toolbar buttons: buttons that do not fit are skipped; later ones may still fit", async () => {
  delete globalThis[TOOLBAR];
  const map = mod.toolbarButtons();
  const clicks = [];
  map.set("a.wide", { label: "[a very wide button]", order: 1, onClick: () => clicks.push("wide") });
  map.set("b.small", { label: "[s]", order: 2, onClick: () => clicks.push("small") });
  const ext = loadExtension(buildTree());
  await tick();
  const w = ext.widget();
  // 19 + 2 + 3 = 24 fits; the wide one (19 + 2 + 20 = 41) does not.
  assert.equal(strip(w.render(30)[0]), " Fold: [▾ 全て畳む]  [s]");
  click(w, 22);
  assert.deepEqual(clicks, ["small"]);
  assert.equal(strip(w.render(24)[0]), " Fold: [▾ 全て畳む]  [s]", "exact fit");
  assert.equal(strip(w.render(23)[0]), " Fold: [▾ 全て畳む]");
  assert.equal(w.handleMouse({ type: "click", button: "left", x: 22, y: 0 }), undefined, "no stale hit range");
  assert.equal(strip(w.render(80)[0]), " Fold: [▾ 全て畳む]  [a very wide button]  [s]");
  click(w, 22);
  click(w, 43);
  assert.deepEqual(clicks, ["small", "wide", "small"]);
  // Too narrow for the fold label: nothing at all (unchanged behavior).
  assert.deepEqual(w.render(10), [""]);
  assert.equal(w.handleMouse({ type: "click", button: "left", x: 8, y: 0 }), undefined);
  // Unregistering takes effect on the next render.
  map.delete("b.small");
  assert.equal(strip(w.render(30)[0]), " Fold: [▾ 全て畳む]");
  delete globalThis[TOOLBAR];
});

test("toolbar buttons: onClick errors (sync throw / rejected promise) are notified, not thrown", async () => {
  delete globalThis[TOOLBAR];
  const map = mod.toolbarButtons();
  map.set("x.throw", { label: "[T]", onClick: () => { throw new Error("sync boom"); } });
  map.set("x.reject", { label: "[R]", order: 1, onClick: () => Promise.reject(new Error("async boom")) });
  const ext = loadExtension(buildTree());
  await tick();
  const w = ext.widget();
  assert.equal(strip(w.render(80)[0]), " Fold: [▾ 全て畳む]  [T]  [R]");
  click(w, 22);
  assert.deepEqual(ext.notes, [["error", "x.throw: sync boom"]]);
  click(w, 27);
  await tick();
  assert.deepEqual(ext.notes.at(-1), ["error", "x.reject: async boom"]);
  delete globalThis[TOOLBAR];
});

// ---- header-only tool frames ----

/** A fake result renderer that records what it got and reuses lastComponent like Pi's built-ins. */
function fakeRenderers(extra = {}) {
  const calls = [];
  return {
    calls,
    renderers: {
      renderCall: () => ({ render: () => ["$ cmd"], invalidate() {} }),
      renderResult(result, options, _theme, context) {
        calls.push({ options, last: context.lastComponent, context });
        const comp = context.lastComponent ?? { lines: [], render() { return this.lines; }, invalidate() {} };
        comp.lines = options.expanded ? ["l1", "l2", "l3"] : ["l3"];
        return comp;
      },
      ...extra,
    },
  };
}
const ctxFor = (last) => ({ lastComponent: last, state: {}, args: {}, toolCallId: "t", invalidate() {} });
const opts = (expanded, isPartial = false) => ({ expanded, isPartial });

test("extension registers a resolver that wraps default-shell renderers only", () => {
  const ext = loadExtension(buildTree());
  assert.equal(ext.resolvers.length, 1);
  const resolve = (base) => ext.resolvers[0]("bash", () => base);

  const { renderers } = fakeRenderers({ execute() {} });
  const wrapped = resolve(renderers);
  assert.notEqual(wrapped, renderers);
  assert.equal(wrapped.renderCall, renderers.renderCall, "renderCall untouched");
  assert.equal(wrapped.execute, renderers.execute, "other definition fields kept");
  assert.notEqual(wrapped.renderResult, renderers.renderResult);
  assert.equal(renderers.renderShell, undefined, "base object not mutated");

  const self = { ...fakeRenderers().renderers, renderShell: "self" };
  assert.equal(resolve(self), self);
  assert.equal(resolve(undefined), undefined);
  const noResult = { renderCall: () => ({ render: () => [], invalidate() {} }) };
  assert.equal(resolve(noResult), noResult);
  const explicitDefault = { ...fakeRenderers().renderers, renderShell: "default" };
  assert.notEqual(resolve(explicitDefault), explicitDefault);
});

test("header-only: 0 lines only when flag on && !expanded && !isPartial", () => {
  const { renderers, calls } = fakeRenderers();
  let flag = false;
  const wrapped = wrapHeaderOnly(renderers, () => flag);
  const r = { content: [{ type: "text", text: "x" }] };

  // Flag off: normal collapsed preview.
  const first = wrapped.renderResult(r, opts(false), {}, ctxFor(undefined));
  assert.deepEqual(first.render(80), ["l3"]);

  // Flag on + collapsed + finished: hidden, but the real renderer still ran with its own component.
  flag = true;
  const hidden = wrapped.renderResult(r, opts(false), {}, ctxFor(first));
  assert.ok(hidden instanceof HeaderOnlyResult);
  assert.deepEqual(hidden.render(80), []);
  assert.equal(hidden.inner, first);
  assert.equal(calls.at(-1).last, first);

  // Expanded: full output; the real renderer gets its own component back, not the placeholder.
  const full = wrapped.renderResult(r, opts(true), {}, ctxFor(hidden));
  assert.equal(full, first);
  assert.deepEqual(full.render(80), ["l1", "l2", "l3"]);
  assert.equal(calls.at(-1).last, first);
  assert.equal(typeof calls.at(-1).context.invalidate, "function", "context fields preserved");

  // Partial (still running): live output stays visible.
  const partial = wrapped.renderResult(r, opts(false, true), {}, ctxFor(hidden));
  assert.deepEqual(partial.render(80), ["l3"]);

  // Flag off again: normal preview, placeholder unwrapped.
  flag = false;
  const back = wrapped.renderResult(r, opts(false), {}, ctxFor(hidden));
  assert.equal(back, first);
  assert.deepEqual(back.render(80), ["l3"]);

  // A throwing renderer in header-only mode still yields an empty result (header only).
  flag = true;
  const throwing = wrapHeaderOnly({ renderResult: () => { throw new Error("boom"); } }, () => flag);
  const t = throwing.renderResult(r, opts(false), {}, ctxFor(undefined));
  assert.deepEqual(t.render(80), []);
  assert.equal(t.inner, undefined);
  // ...and outside header-only mode errors propagate to Pi (which shows its fallback).
  assert.throws(() => throwing.renderResult(r, opts(true), {}, ctxFor(undefined)), /boom/);
});

class FakeToolExec extends FakeTool {
  constructor(expanded, name = "bash") {
    super(expanded);
    this.toolName = name;
  }
}

test("isToolExecutionHost duck type", () => {
  assert.equal(isToolExecutionHost(new FakeToolExec(false)), true);
  assert.equal(isToolExecutionHost(new FakeTool(false)), false);
  assert.equal(isToolExecutionHost({ setExpanded() {}, toolName: "x", _expanded: false }), false);
});

test("applyFold toggles header-only and forces setExpanded on tool frames", async () => {
  const tree = buildTree({ hide: false, toolsExpanded: false });
  const tools = [new FakeToolExec(false), new FakeToolExec(false, "read"), new FakeToolExec(true)];
  const custom = { _expanded: false, updates: 0, setExpanded(v) { this._expanded = v; this.updates++; }, render: () => [] };
  tree.chat.children.push(...tools, custom);
  const ext = loadExtension(tree);
  assert.equal(isHeaderOnly(), false, "starts off on load");
  await tick();
  const cmd = ext.commands.get("fold-all");

  // Global tools flag already collapsed: tool frames are re-rendered anyway.
  await cmd.handler("on", ext.ctx);
  assert.equal(isHeaderOnly(), true);
  assert.deepEqual(tools.map((t) => t.updates), [1, 1, 1]);
  assert.ok(tools.every((t) => t.expanded === false));
  assert.equal(custom.updates, 0, "custom messages in the right state are left alone");
  assert.equal(tree.tools[0].updates, 0, "non-tool expandables are left alone");
  assert.equal(strip(ext.widget().render(80)[0]), " Fold: [▸ 全て展開]");

  // Idempotent "on": re-renders tools again (cheap, click only), state unchanged.
  await cmd.handler("on", ext.ctx);
  assert.deepEqual(tools.map((t) => t.updates), [2, 2, 2]);

  // Expand: header-only off, Pi's setToolsExpanded path.
  await cmd.handler("off", ext.ctx);
  assert.equal(isHeaderOnly(), false);
  assert.equal(tree.app.toolsExpanded, true);
  assert.equal(strip(ext.widget().render(80)[0]), " Fold: [▾ 全て畳む]");

  // Expand while the global flag already matches: header-only off and tools re-rendered.
  setHeaderOnly(true);
  const before = tools.map((t) => t.updates);
  tools.forEach((t) => (t.expanded = true));
  await cmd.handler("off", ext.ctx);
  assert.equal(isHeaderOnly(), false);
  assert.deepEqual(tools.map((t) => t.updates), before.map((n) => n + 1));
  assert.equal(custom._expanded, true, "custom message reset to the global state");

  // A fresh load (e.g. /reload) resets the mode to off.
  setHeaderOnly(true);
  loadExtension(buildTree());
  assert.equal(isHeaderOnly(), false);
});

// Real ToolExecutionComponent + real bash/read renderers from the installed Pi, if available.
const piRoot = path.resolve(path.dirname(realTui), "../../../..");
const piDist = path.join(piRoot, "dist");
const haveRealPi = usingRealTui && existsSync(path.join(piDist, "modes/interactive/components/tool-execution.js"));

test("real ToolExecutionComponent: header only inside the colored box", { skip: !haveRealPi }, async () => {
  const imp = (rel) => import(pathToFileURL(path.join(piDist, rel)).href);
  const { initTheme } = await imp("modes/interactive/theme/theme.js");
  initTheme("dark");
  const { ToolExecutionComponent } = await imp("modes/interactive/components/tool-execution.js");
  const { createShellRenderers, readRenderers } = await imp("core/tools/renderers/index.js");
  const ui = { requestRender() {} };
  const render = (c) => c.render(40).map(strip).map((l) => l.trimEnd());

  setHeaderOnly(false);
  const bash = new ToolExecutionComponent("bash", "b1", { command: "ls" }, {}, wrapHeaderOnly(createShellRenderers("$")), ui, ".");
  bash.markExecutionStarted();
  bash.updateResult({ content: [{ type: "text", text: "1\n2\n3\n4\n5\n6\n7" }], isError: false, durationMs: 5 });
  const normal = render(bash);
  assert.ok(normal.length > 6 && normal.includes(" 7"), "normal 5-line preview");

  setHeaderOnly(true);
  bash.setExpanded(false);
  assert.deepEqual(render(bash), ["", "", " $ ls", ""], "spacer + box(padding, header, padding)");
  bash.setExpanded(true);
  assert.ok(render(bash).includes(" 1"), "individually expanded: full output");
  bash.setExpanded(false);
  assert.deepEqual(render(bash), ["", "", " $ ls", ""]);

  // Running tool: streaming output stays visible.
  const running = new ToolExecutionComponent("bash", "b2", { command: "sleep" }, {}, wrapHeaderOnly(createShellRenderers("$")), ui, ".");
  running.markExecutionStarted();
  running.updateResult({ content: [{ type: "text", text: "tick" }], isError: false }, true);
  const runningLines = render(running);
  // Finish it so the renderer's 1s elapsed-time interval is cleared.
  running.updateResult({ content: [{ type: "text", text: "tick" }], isError: false, durationMs: 1 });
  assert.ok(runningLines.includes(" tick"), runningLines.join("|"));

  // read: renderResult reuses lastComponent as a Text; must survive the placeholder round trip.
  const read = new ToolExecutionComponent("read", "r1", { path: "a.txt" }, {}, wrapHeaderOnly(readRenderers), ui, ".");
  read.markExecutionStarted();
  read.updateResult({ content: [{ type: "text", text: "alpha\nbeta" }], isError: false });
  assert.equal(render(read).length, 4);
  read.setExpanded(true);
  const expanded = render(read);
  assert.ok(expanded.some((l) => l.includes("alpha")) && expanded.some((l) => l.includes("beta")), expanded.join("|"));
  // Pi's collapsed read view hides content anyway; the Text component must still work afterwards.
  setHeaderOnly(false);
  read.setExpanded(false);
  assert.ok(!render(read).some((l) => l.includes("alpha")));
  read.setExpanded(true);
  assert.ok(render(read).some((l) => l.includes("beta")));
});

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
