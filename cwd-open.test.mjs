// Dependency-free tests for cwd-open.ts. Run: node cwd-open.test.mjs  (Node >= 23.6 strips TS types)
// Pi packages are replaced with tiny stubs via module.registerHooks, so nothing from pi is loaded.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const stubs = {
  "@earendil-works/pi-coding-agent": "export const getAgentDir = () => globalThis.__cwdOpenAgentDir;",
  "@earendil-works/pi-tui":
    "export const visibleWidth = (s) => [...s.replace(/\\x1b\\[[0-9;]*m/g, '')].length;",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in stubs) {
      return { url: "data:text/javascript," + encodeURIComponent(stubs[specifier]), shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const agentDir = mkdtempSync(path.join(tmpdir(), "cwd-open-test-"));
globalThis.__cwdOpenAgentDir = agentDir;
const mod = await import("./cwd-open.ts");
const { formatCwd, stripAnsi, computeClickableWidth, parseOpeners, buildArgs, preparePath } = mod;

test("formatCwd (win32 + posix)", () => {
  const w = path.win32, p = path.posix;
  assert.equal(formatCwd("C:\\Users\\me\\proj", "C:\\Users\\me", w), "~\\proj");
  assert.equal(formatCwd("C:\\Users\\me", "C:\\Users\\me", w), "~");
  assert.equal(formatCwd("C:\\Users\\meow", "C:\\Users\\me", w), "C:\\Users\\meow");
  assert.equal(formatCwd("E:\\Dev\\TS\\Pi", "C:\\Users\\me", w), "E:\\Dev\\TS\\Pi");
  assert.equal(formatCwd("/home/me/a/b", "/home/me", p), "~/a/b");
  assert.equal(formatCwd("/home/me/..x", "/home/me", p), "~/..x");
  assert.equal(formatCwd("/srv", "/home/me", p), "/srv");
  assert.equal(formatCwd("/srv", undefined, p), "/srv");
});

test("stripAnsi removes SGR, OSC 8 links, APC and 2-byte ESC", () => {
  assert.equal(stripAnsi("\x1b[2m~\\proj\x1b[22m"), "~\\proj");
  assert.equal(stripAnsi("\x1b]8;;file:///x\x07link\x1b]8;;\x07"), "link");
  assert.equal(stripAnsi("\x1b]8;;u\x1b\\a\x1b]8;;\x1b\\b"), "ab");
  assert.equal(stripAnsi("\x1b_pi:c\x07\x1b\\x"), "x");
  assert.equal(stripAnsi("\x1b7a\x1b8"), "a");
  assert.equal(stripAnsi("\x1b(Bb\x1b[m"), "b");
  assert.equal(stripAnsi("plain"), "plain");
});

test("computeClickableWidth", () => {
  const dim = (s) => `\x1b[2m${s}\x1b[22m`;
  assert.equal(computeClickableWidth(dim("~\\proj (main) • name"), "~\\proj"), 6);
  assert.equal(computeClickableWidth(dim("~\\proj"), "~\\proj"), 6);
  // truncated: only the visible prefix (without "...") is clickable
  assert.equal(computeClickableWidth(dim("E:\\Dev\\very") + dim("..."), "E:\\Dev\\very\\long\\path"), 11);
  // mismatch fallback: whole line minus trailing spaces
  assert.equal(computeClickableWidth("other   ", "~\\proj"), 5);
  assert.equal(computeClickableWidth("", "~"), 0);
});

test("parseOpeners: defaults only when absent", () => {
  assert.deepEqual(parseOpeners(undefined, "win32"), [
    { label: "Explorer", command: "explorer.exe", args: ["{path}"], shell: false },
  ]);
  assert.equal(parseOpeners({}, "darwin")[0].command, "open");
  assert.equal(parseOpeners({ other: 1 }, "linux")[0].command, "xdg-open");
});

test("parseOpeners: valid config", () => {
  const openers = parseOpeners(
    {
      cwdOpener: {
        openers: [
          { label: " Explorer ", command: "explorer.exe" },
          { label: "VS Code", command: "code", args: ["-n", "{path}"], shell: true },
        ],
      },
    },
    "win32",
  );
  assert.deepEqual(openers, [
    { label: "Explorer", command: "explorer.exe", args: ["{path}"], shell: false },
    { label: "VS Code", command: "code", args: ["-n", "{path}"], shell: true },
  ]);
});

test("parseOpeners: validation errors throw", () => {
  const bad = (cfg, re) => assert.throws(() => parseOpeners(cfg, "win32"), re);
  bad([], /root must be a JSON object/);
  bad({ cwdOpener: [] }, /must be an object/);
  bad({ cwdOpener: {} }, /nonempty array/);
  bad({ cwdOpener: { openers: [] } }, /nonempty array/);
  bad({ cwdOpener: { openers: ["x"] } }, /\[0\] must be an object/);
  bad({ cwdOpener: { openers: [{ label: "", command: "x" }] } }, /label must be a nonempty string/);
  bad({ cwdOpener: { openers: [{ label: "a", command: 1 }] } }, /command must be a nonempty string/);
  bad({ cwdOpener: { openers: [{ label: "a", command: "x", args: "{path}" }] } }, /args must be an array of strings/);
  bad({ cwdOpener: { openers: [{ label: "a", command: "x", args: [1] }] } }, /args must be an array of strings/);
  bad({ cwdOpener: { openers: [{ label: "a", command: "x", shell: "yes" }] } }, /shell must be a boolean/);
  bad({ cwdOpener: { openers: [{ label: "A", command: "x" }, { label: "a", command: "y" }] } }, /duplicated/);
});

test("buildArgs / preparePath", () => {
  const plain = { args: ["{path}"], shell: false };
  const sh = { args: ["--folder={path}", "{path}", "-x"], shell: true };
  assert.deepEqual(buildArgs(plain, "C:/Users/me/My Dir", "win32"), ["C:\\Users\\me\\My Dir"]);
  assert.deepEqual(buildArgs(plain, "C:\\a\\b\\", "win32"), ["C:\\a\\b"]);
  assert.equal(preparePath("C:\\", "win32", false), "C:\\");
  assert.equal(preparePath("\\\\srv\\share\\", "win32", false), "\\\\srv\\share\\");
  assert.deepEqual(buildArgs(sh, "C:/x y", "win32"), ['--folder="C:\\x y"', '"C:\\x y"', "-x"]);
  assert.deepEqual(buildArgs({ args: ["{path}"], shell: true }, "C:\\", "win32"), ['"C:\\\\"']);
  assert.deepEqual(buildArgs(plain, "/home/me/a b", "linux"), ["/home/me/a b"]);
  assert.deepEqual(buildArgs({ args: ["{path}"], shell: true }, "/tmp/it's", "darwin"), ["'/tmp/it'\\''s'"]);
});

// --- Runtime wiring with a fake pi / TUI / footer -------------------------------------------
function makeHarness({ withFooter = true, sharedFooter } = {}) {
  const handlers = {};
  const commands = {};
  const notes = [];
  const selects = [];
  const pi = {
    on: (name, fn) => (handlers[name] = fn),
    registerCommand: (name, def) => (commands[name] = def),
  };
  const footer = sharedFooter ?? {
    session: { sessionManager: { getCwd: () => agentDir } },
    footerData: {},
    setAutoCompactEnabled() {},
    render: (width) => [`\x1b[2m${formatCwd(agentDir, process.env.HOME || process.env.USERPROFILE)} (main)\x1b[22m`, "stats"],
  };
  const footerContainer = { children: withFooter ? [footer] : [] };
  const tui = { children: [{ children: [] }, { children: [] }, footerContainer] };
  const widgets = {};
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: agentDir,
    ui: {
      notify: (msg, type) => notes.push([type, msg]),
      select: async (title, labels) => (selects.push([title, labels]), labels[1]),
      setWidget: (key, factory) => {
        if (factory) widgets[key] = factory(tui, {});
        else delete widgets[key];
      },
    },
  };
  mod.default(pi);
  return { handlers, commands, notes, selects, footer, ctx, widgets };
}

const ev = (type, button, x, y = 0) => ({ type, button, x, y, screenX: x, screenY: 40 + y, width: 200, height: 3, shift: false, alt: false, ctrl: false });
const waitFor = async (pred) => {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
};

test("runtime: installs trampoline, hit-tests, launches, cleans up", async () => {
  // Harmless opener: node -e "" <path>
  const settings = {
    cwdOpener: {
      openers: [
        { label: "NodeA", command: process.execPath, args: ["-e", "", "{path}"] },
        { label: "NodeB", command: process.execPath, args: ["-e", "", "{path}"] },
      ],
    },
  };
  writeFileSync(path.join(agentDir, "settings.json"), "\uFEFF" + JSON.stringify(settings));

  const h = makeHarness();
  h.handlers.session_start({}, h.ctx);
  assert.equal(typeof h.footer.handleMouse, "function");
  assert.deepEqual(h.widgets, {}, "probe widget removed");
  const expectedWidth = formatCwd(agentDir, process.env.HOME || process.env.USERPROFILE).length;

  assert.equal(h.footer.handleMouse(ev("press", "left", 0, 1)), undefined, "line 1 ignored");
  assert.equal(h.footer.handleMouse(ev("press", "left", expectedWidth)), undefined, "branch text ignored");
  assert.equal(h.footer.handleMouse(ev("press", "middle", 0)), undefined, "middle ignored");
  assert.equal(h.footer.handleMouse(ev("move", "none", 0)), undefined, "move ignored");
  assert.deepEqual(h.footer.handleMouse(ev("press", "left", expectedWidth - 1)), { handled: true });
  assert.deepEqual(h.footer.handleMouse(ev("click", "left", 0)), { handled: true });
  await waitFor(() => h.notes.length > 0);
  assert.deepEqual(h.notes.at(-1), ["info", `Opened ${process.platform === "win32" ? path.win32.normalize(agentDir) : agentDir} with NodeA`]);

  assert.deepEqual(h.footer.handleMouse(ev("click", "right", 0)), { handled: true });
  await waitFor(() => h.notes.length > 1);
  assert.deepEqual(h.selects, [["Open directory with", ["NodeA", "NodeB"]]]);
  assert.match(h.notes.at(-1)[1], /with NodeB$/);

  // /reload: a second module instance replaces the handler without stacking the wrapper
  const trampoline = h.footer.handleMouse;
  h.handlers.session_shutdown({}, h.ctx);
  assert.equal(Object.hasOwn(h.footer, "handleMouse"), false, "trampoline removed on shutdown");
  const h2 = makeHarness();
  h2.handlers.session_start({}, h2.ctx);
  assert.equal(h2.footer.handleMouse, trampoline, "same stable trampoline");
  h2.handlers.session_shutdown({}, h2.ctx);
});

test("runtime: /reload ordering on the same footer instance", () => {
  const h1 = makeHarness();
  h1.handlers.session_start({}, h1.ctx);
  const trampoline = h1.footer.handleMouse;
  // start1 -> start2 -> shutdown1: the old shutdown must not remove the new handler
  const h2 = makeHarness({ sharedFooter: h1.footer });
  h2.handlers.session_start({}, h2.ctx);
  assert.equal(h1.footer.handleMouse, trampoline);
  h1.handlers.session_shutdown({}, h1.ctx);
  assert.equal(h1.footer.handleMouse, trampoline, "still installed after stale shutdown");
  assert.deepEqual(h1.footer.handleMouse(ev("press", "left", 0)), { handled: true }, "new handler active");
  // start2 -> shutdown2 -> start3
  h2.handlers.session_shutdown({}, h2.ctx);
  assert.equal(Object.hasOwn(h1.footer, "handleMouse"), false);
  assert.equal(h1.footer.handleMouse, undefined);
  const h3 = makeHarness({ sharedFooter: h1.footer });
  h3.handlers.session_start({}, h3.ctx);
  assert.equal(h1.footer.handleMouse, trampoline, "no stacking: same trampoline");
  h3.handlers.session_shutdown({}, h3.ctx);
});

test("runtime: falls through to an inherited handleMouse when not hit", () => {
  const calls = [];
  const proto = { handleMouse(e) { calls.push(e.type); return { handled: true, from: "proto" }; } };
  const h0 = makeHarness();
  const footer = Object.assign(Object.create(proto), h0.footer);
  const h = makeHarness({ sharedFooter: footer });
  h.handlers.session_start({}, h.ctx);
  assert.deepEqual(footer.handleMouse(ev("press", "left", 0, 1)), { handled: true, from: "proto" });
  assert.deepEqual(calls, ["press"]);
  h.handlers.session_shutdown({}, h.ctx);
  assert.equal(footer.handleMouse, proto.handleMouse);
});

test("runtime: invalid config reports error and does not launch", async () => {
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ cwdOpener: { openers: [{ label: "x" }] } }));
  const h = makeHarness();
  h.handlers.session_start({}, h.ctx);
  assert.deepEqual(h.footer.handleMouse(ev("click", "left", 0)), { handled: true });
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0][0], "error");
  assert.match(h.notes[0][1], /command must be a nonempty string/);
  h.handlers.session_shutdown({}, h.ctx);
});

test("runtime: /open-cwd command", async () => {
  writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ cwdOpener: { openers: [{ label: "Node A", command: process.execPath, args: ["-e", "", "{path}"] }] } }),
  );
  const h = makeHarness();
  h.handlers.session_start({}, h.ctx);
  await h.commands["open-cwd"].handler('"node a"', h.ctx);
  await waitFor(() => h.notes.length > 0);
  assert.match(h.notes.at(-1)[1], /with Node A$/);
  await h.commands["open-cwd"].handler("nope", h.ctx);
  assert.deepEqual(h.notes.at(-1), ["warning", 'Unknown opener "nope". Use: /open-cwd "Node A"']);
  h.handlers.session_shutdown({}, h.ctx);
});

test("runtime: missing footer warns after retries", async () => {
  const h = makeHarness({ withFooter: false });
  h.handlers.session_start({}, h.ctx);
  await waitFor(() => h.notes.length > 0);
  assert.deepEqual(h.notes, [["warning", "cwd-open: built-in footer not found (custom footer active?)"]]);
  h.handlers.session_shutdown({}, h.ctx);
});

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
