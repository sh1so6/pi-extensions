// Dependency-free tests for path-click.ts. Run: node index.test.mjs  (Node >= 23.6 strips TS types)
// @earendil-works/pi-tui (only getNativeClipboard is used at runtime) is replaced with a stub.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-tui") {
      const source = "export const getNativeClipboard = () => globalThis.__pathClickNativeClipboard?.();";
      return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const mod = await import("./index.ts");
const { transformMarkdown, parsePartialPath, everythingUrl, clearPartialPathCache } = mod;

// <root>/proj is the cwd; <root>/proj/src/a.ts, <root>/proj/src/deep/, <root>/sibling/
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "path-click-test-")));
const cwd = path.join(root, "proj");
const src = path.join(cwd, "src");
mkdirSync(path.join(src, "deep"), { recursive: true });
mkdirSync(path.join(root, "sibling"));
writeFileSync(path.join(src, "a.ts"), "");

const ON = { everything: true };
const fileUrl = (p) => pathToFileURL(p).href;
const es = (alive, name) => everythingUrl({ alive, name });
const t = (md, options = ON) => {
  clearPartialPathCache();
  return transformMarkdown(md, cwd, "file", options);
};

test("everythingUrl: exact encoding", () => {
  assert.equal(
    everythingUrl({ alive: "E:\\Dev\\TS\\Pi", name: "foo.ts" }),
    path.sep === "\\" ? "es:%22E%3A%5CDev%5CTS%5CPi%5C%22%20%22foo.ts%22" : "es:%22E%3A%5CDev%5CTS%5CPi%2F%22%20%22foo.ts%22",
  );
  const sep = encodeURIComponent(path.sep);
  // exactly one trailing separator; quotes dropped from name; parentheses encoded
  assert.equal(
    everythingUrl({ alive: `/x(1)${path.sep}${path.sep}`, name: 'a"b (2).ts' }),
    `es:%22%2Fx%281%29${sep}%22%20%22ab%20%282%29.ts%22`,
  );
});

test("parsePartialPath", () => {
  clearPartialPathCache();
  assert.deepEqual(parsePartialPath("src/missing.ts", cwd), { alive: src, name: "missing.ts" });
  assert.deepEqual(parsePartialPath("src/deep/x/y/z.ts", cwd), { alive: path.join(src, "deep"), name: "z.ts" });
  assert.deepEqual(parsePartialPath("./src/missing.ts:12:3", cwd), { alive: src, name: "missing.ts" });
  assert.deepEqual(parsePartialPath("src/missing.ts#L7", cwd), { alive: src, name: "missing.ts" });
  assert.deepEqual(parsePartialPath(path.join(src, "gone.md"), cwd), { alive: src, name: "gone.md" });
  assert.deepEqual(parsePartialPath("../sibling/x.ts", cwd), { alive: path.join(root, "sibling"), name: "x.ts" });
  // alive == boundary
  assert.equal(parsePartialPath("missing/x.ts", cwd), undefined);
  assert.equal(parsePartialPath("../nope/x.ts", cwd), undefined);
  assert.equal(parsePartialPath("../x.ts", cwd), undefined);
  assert.equal(parsePartialPath(path.join(path.parse(root).root, "nonexistent-path-click", "x.ts"), cwd), undefined);
  // escaping the boundary
  assert.equal(parsePartialPath("src/../../sibling/x.ts", cwd), undefined);
  // prose and non-paths
  assert.equal(parsePartialPath("and/or", cwd), undefined);
  assert.equal(parsePartialPath("foo/bar", cwd), undefined);
  assert.equal(parsePartialPath("missing.ts", cwd), undefined);
  assert.equal(parsePartialPath("", cwd), undefined);
  assert.equal(parsePartialPath("https://example.com/src/x", cwd), undefined);
  assert.equal(parsePartialPath("es:src/x", cwd), undefined);
  assert.equal(parsePartialPath("src/a\u0001b", cwd), undefined);
  assert.equal(parsePartialPath("src/" + "x".repeat(2050), cwd), undefined);
  // UNC paths are never resolved
  assert.equal(parsePartialPath("\\\\server\\share\\x.ts", cwd), undefined);
  assert.equal(parsePartialPath("//server/share/x.ts", cwd), undefined);
  assert.equal(parsePartialPath(String.raw`\\?\C:\nope\x.ts`, cwd), undefined);
  assert.equal(parsePartialPath(String.raw`\\.\pipe\x`, cwd), undefined);
  // non-ASCII names
  assert.deepEqual(parsePartialPath("src/設定.ts", cwd), { alive: src, name: "設定.ts" });
});

test("parsePartialPath: cache (including negative results)", () => {
  clearPartialPathCache();
  assert.equal(parsePartialPath("later/x.ts", cwd), undefined);
  mkdirSync(path.join(cwd, "later"));
  assert.equal(parsePartialPath("later/x.ts", cwd), undefined, "cached negative");
  clearPartialPathCache();
  assert.deepEqual(parsePartialPath("later/x.ts", cwd), { alive: path.join(cwd, "later"), name: "x.ts" });
  rmSync(path.join(cwd, "later"), { recursive: true });
  clearPartialPathCache();
});

test("existing file still links to file://", () => {
  assert.equal(t("see src/a.ts now"), `see [src/a.ts](${fileUrl(path.join(src, "a.ts"))}) now`);
  assert.equal(t("see src/a.ts now", {}), `see [src/a.ts](${fileUrl(path.join(src, "a.ts"))}) now`);
});

test("missing file under existing subdir links to Everything", () => {
  assert.equal(
    t("see src/missing.ts now"),
    `see [src/missing.ts](${es(src, "missing.ts")}) now`,
  );
  if (path.sep === "\\") {
    const expected = "es:" + encodeURIComponent(`"${src}\\" "missing.ts"`).replace(/\(/g, "%28").replace(/\)/g, "%29");
    assert.equal(t("src/missing.ts"), `[src/missing.ts](${expected})`);
  }
});

test("non-ASCII name is percent-encoded as UTF-8", () => {
  const url = es(src, "設定.ts");
  assert.ok(url.endsWith("%22%20%22%E8%A8%AD%E5%AE%9A.ts%22"), url);
  assert.equal(t("src/設定.ts"), `[src/設定.ts](${url})`);
});

test("everything off (or omitted): unchanged", () => {
  const md = "see src/missing.ts and `src/missing.ts` and [a](src/missing.ts)";
  assert.equal(t(md, {}), md);
  assert.equal(t(md, { everything: false }), md);
  clearPartialPathCache();
  assert.equal(transformMarkdown(md, cwd), md);
  assert.equal(transformMarkdown(md, cwd, "vscode"), md);
});

test("prose and alive==boundary stay plain", () => {
  for (const md of [
    "this and/or that",
    "use foo/bar here",
    "missing/x.ts",
    "./missing/x.ts",
    "../nope/x.ts",
    `${path.join(path.parse(root).root, "nonexistent-path-click", "x.ts")}`,
    // (Code-quoted UNC is not tested here: the pre-existing parseExistingPath
    // stats it, which can take seconds on a cold network-name lookup.)
    "\\\\server\\share\\x.ts",
    "see \\\\server\\share\\dir\\x.ts.",
    "see https://example.com/src/missing.ts",
  ]) {
    assert.equal(t(md), md, md);
  }
});

test("line suffix stripped from name, kept in label", () => {
  assert.equal(t("src/missing.ts:12"), `[src/missing.ts:12](${es(src, "missing.ts")})`);
  assert.equal(t("src/missing.ts:12:3."), `[src/missing.ts:12:3](${es(src, "missing.ts")}).`);
  assert.equal(t("`src/missing.ts#L4`"), `[\`src/missing.ts#L4\`](${es(src, "missing.ts")})`);
});

test("../ relative path", () => {
  const sibling = path.join(root, "sibling");
  assert.equal(t("moved to ../sibling/new.ts"), `moved to [../sibling/new.ts](${es(sibling, "new.ts")})`);
  assert.equal(t("moved to ../sibling/new.ts?"), `moved to [../sibling/new.ts](${es(sibling, "new.ts")})?`);
});

test("inline code", () => {
  assert.equal(t("open `src/missing.ts`"), `open [\`src/missing.ts\`](${es(src, "missing.ts")})`);
  assert.equal(t("`and/or`"), "`and/or`");
  // code-quoted path with spaces
  assert.equal(t("`src/my file.ts`"), `[\`src/my file.ts\`](${es(src, "my file.ts")})`);
});

test("markdown link targets", () => {
  assert.equal(t("[a](src/missing.ts)"), `[a](${es(src, "missing.ts")})`);
  assert.equal(t("[a](src/a.ts)"), `[a](${fileUrl(path.join(src, "a.ts"))})`);
  assert.equal(t("[a](missing/x.ts)"), "[a](missing/x.ts)");
  assert.equal(t("[a](https://example.com/x)"), "[a](https://example.com/x)");
});

test("trailing punctuation after bare path", () => {
  for (const p of [".", ",", ";", ":", "!", "..."]) {
    assert.equal(t(`see src/missing.ts${p}`), `see [src/missing.ts](${es(src, "missing.ts")})${p}`, p);
  }
  assert.equal(t("(see src/missing.ts)"), `(see [src/missing.ts](${es(src, "missing.ts")}))`);
});

test("fenced code untouched", () => {
  const md = "```\nsrc/missing.ts\n```\nsrc/missing.ts";
  assert.equal(t(md), `\`\`\`\nsrc/missing.ts\n\`\`\`\n[src/missing.ts](${es(src, "missing.ts")})`);
});

test("MAX_CHECKS: one candidate is one check", () => {
  const md = Array.from({ length: 105 }, () => "src/missing.ts").join(" ");
  const out = t(md);
  assert.equal(out.split("](es:").length - 1, 100);
});

test("runtime: env switch and transformer wiring", async () => {
  const run = (envValue, exe = undefined) => {
    const handlers = {};
    let transformer;
    mod.createPathClick({
      env: { PI_PATH_CLICK_EVERYTHING: envValue },
      platform: "win32",
      findExe: () => exe,
      queryEsProtocol: (done) => done(false),
    })({
      on: (name, fn) => (handlers[name] = fn),
      registerMarkdownTransformer: (fn) => (transformer = fn),
    });
    handlers.session_start({}, { cwd });
    return (md, ctx = { messageType: "assistant", isStreaming: false }) => transformer(md, ctx);
  };
  const on = run("1");
  assert.equal(on("src/missing.ts"), `[src/missing.ts](${es(src, "missing.ts")})`);
  assert.equal(on("src/missing.ts", { messageType: "user", isStreaming: false }), "src/missing.ts");
  assert.equal(on("src/missing.ts", { messageType: "assistant", isStreaming: true }), "src/missing.ts");
  const off = run("0", "C:\Everything.exe");
  assert.equal(off("src/missing.ts"), "src/missing.ts");
  assert.equal(off("src/a.ts"), `[src/a.ts](${fileUrl(path.join(src, "a.ts"))})`);
  // auto: on when Everything.exe is found (even without the es: protocol), off otherwise
  assert.equal(run(undefined, "C:\Everything.exe")("src/missing.ts"), `[src/missing.ts](${es(src, "missing.ts")})`);
  assert.equal(run(undefined)("src/missing.ts"), "src/missing.ts");
});

// ---------------------------------------------------------------------------
// Everything launcher, clipboard search, openUrl hook
// ---------------------------------------------------------------------------

test("findEverythingExe: discovery order (injected env/exists)", () => {
  const env = {
    PI_EVERYTHING_EXE: '"D:\\Tools\\Everything.exe"',
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  };
  const registryCommand = '"E:\\Apps\\Everything\\Everything.exe" -url "%1"';
  const all = [
    "D:\\Tools\\Everything.exe",
    "E:\\Apps\\Everything\\Everything.exe",
    "C:\\Program Files\\Everything\\Everything.exe",
    "C:\\Program Files (x86)\\Everything\\Everything.exe",
    "C:\\Program Files\\Everything 1.5a\\Everything64.exe",
    "C:\\Program Files\\Everything 1.5a\\Everything.exe",
    "C:\\Users\\u\\AppData\\Local\\Programs\\Everything\\Everything.exe",
  ];
  const checked = [];
  const find = (present, opts = {}) =>
    mod.findEverythingExe({ env, registryCommand, ...opts, exists: (p) => (checked.push(p), present.includes(p)) });
  // Each candidate wins once all earlier ones are missing.
  for (let i = 0; i < all.length; i++) assert.equal(find(all.slice(i)), all[i], `candidate ${i}`);
  checked.length = 0;
  assert.equal(find([]), undefined);
  assert.deepEqual(checked, all, "checks every candidate in order");
  // Missing env vars / registry command are skipped.
  checked.length = 0;
  assert.equal(mod.findEverythingExe({ env: {}, exists: (p) => (checked.push(p), true) }), undefined);
  assert.deepEqual(checked, []);
  assert.equal(find([all[2]], { registryCommand: undefined }), all[2]);
  // A throwing check counts as missing.
  assert.equal(mod.findEverythingExe({ env, exists: () => { throw new Error("x"); } }), undefined);
});

test("parseEsCommandExe / parseRegQueryOutput / decodeRegOutput", () => {
  const { parseEsCommandExe, parseRegQueryOutput, decodeRegOutput } = mod;
  assert.equal(parseEsCommandExe('"C:\\Program Files\\Everything\\Everything.exe" -url "%1"'), "C:\\Program Files\\Everything\\Everything.exe");
  assert.equal(parseEsCommandExe('C:\\Program Files\\Everything\\Everything.exe -url "%1"'), "C:\\Program Files\\Everything\\Everything.exe");
  assert.equal(parseEsCommandExe('"%ProgramFiles%\\Everything\\Everything.exe" "%1"', { programfiles: "C:\\PF" }), "C:\\PF\\Everything\\Everything.exe");
  assert.equal(parseEsCommandExe(undefined), undefined);
  assert.equal(parseEsCommandExe('"relative\\Everything.exe" "%1"'), undefined);
  assert.equal(parseEsCommandExe('"C:\\unterminated'), undefined);
  assert.equal(parseEsCommandExe('""'), undefined);

  const ja = '\r\nHKEY_CLASSES_ROOT\\ES\\shell\\open\\command\r\n    (既定)    REG_SZ    "C:\\Program Files\\Everything\\Everything.exe" -url "%1"\r\n\r\n';
  assert.equal(parseRegQueryOutput(ja), '"C:\\Program Files\\Everything\\Everything.exe" -url "%1"');
  const en = 'HKEY_CLASSES_ROOT\\ES\\shell\\open\\command\n    (Default)    REG_EXPAND_SZ    "%LOCALAPPDATA%\\Everything.exe" "%1"\n';
  assert.equal(parseRegQueryOutput(en, { LOCALAPPDATA: "C:\\L" }), '"C:\\L\\Everything.exe" "%1"');
  assert.equal(parseRegQueryOutput("ERROR: nothing\n"), undefined);
  assert.equal(parseRegQueryOutput("    (Default)    REG_SZ    \n"), undefined, "empty value");

  // CP932 bytes of "(既定)" decode via Shift_JIS; UTF-8 and plain strings pass through.
  const sjis = Buffer.concat([
    Buffer.from("    ("),
    Buffer.from([0x8a, 0xf9, 0x92, 0xe8]),
    Buffer.from(')    REG_SZ    "C:\\E.exe" "%1"'),
  ]);
  const decoded = decodeRegOutput(sjis);
  assert.ok(decoded.includes("REG_SZ"), decoded);
  assert.equal(parseEsCommandExe(parseRegQueryOutput(decoded)), "C:\\E.exe");
  assert.equal(decodeRegOutput(Buffer.from("(既定) REG_SZ x", "utf8")), "(既定) REG_SZ x");
  assert.equal(decodeRegOutput("already text"), "already text");
});

test("isSafeEverythingUrl and launchEverything (injected spawn)", () => {
  const { isSafeEverythingUrl, launchEverything } = mod;
  for (const ok of ["es:", "es:abc", "es:%22E%3A%5C%22%20%22x.ts%22", "es:a-b_c.d~e!f*g'h(i)j", es(src, "設定.ts")]) {
    assert.equal(isSafeEverythingUrl(ok), true, ok);
  }
  const bad = ['es:"x"', "es:a b", "es:a&b", "es:a|b", "es:a^b", 'es:a"&calc', "es:a%b<c", "es:\n", "es:日本",
    "ES:abc", "es :x", "file:///C:/x", "https://x", " es:x", "es:x ", 42, undefined, "es:" + "a".repeat(30_000)];
  for (const value of bad) assert.equal(isSafeEverythingUrl(value), false, String(value));

  const calls = [];
  const errors = [];
  const listeners = {};
  const fakeSpawn = (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    return { on: (name, fn) => (listeners[name] = fn), unref: () => (call.unref = true) };
  };
  const exe = "C:\\Program Files\\Everything\\Everything.exe";
  assert.equal(launchEverything("es:pi%20test", exe, { spawn: fakeSpawn, onError: (e) => errors.push(e) }), true);
  assert.deepEqual(calls[0], {
    cmd: exe,
    args: ["-url", "es:pi%20test"],
    opts: { detached: true, stdio: "ignore", shell: false, windowsHide: false },
    unref: true,
  });
  listeners.error(new Error("ENOENT"));
  assert.equal(errors[0].message, "ENOENT");
  // Rejected without spawning: unsafe URL or no exe.
  assert.equal(launchEverything('es:"x" & calc', exe, { spawn: fakeSpawn }), false);
  assert.equal(launchEverything("es:x", undefined, { spawn: fakeSpawn }), false);
  // Quotes, %, & and spaces in a clipboard query stay inside one percent-encoded argument.
  const url = mod.clipboardSearchUrl('"C:\\a b" 100% & calc ^ | x');
  assert.equal(launchEverything(url, exe, { spawn: fakeSpawn }), true);
  assert.deepEqual(calls.at(-1).args, ["-url", "es:%22C%3A%5Ca%20b%22%20100%25%20%26%20calc%20%5E%20%7C%20x"]);
  calls.pop();
  assert.equal(calls.length, 1);
  // Synchronous spawn failure -> false + reported, never thrown.
  const thrown = [];
  const failing = () => { throw new Error("EACCES"); };
  assert.equal(launchEverything("es:x", exe, { spawn: failing, onError: (e) => thrown.push(e) }), false);
  assert.equal(thrown.length, 1);
  assert.equal(launchEverything("es:x", exe, { spawn: failing, onError: () => { throw new Error("y"); } }), false);
});

test("normalizeClipboardQuery / clipboardSearchUrl", () => {
  const { normalizeClipboardQuery: n, clipboardSearchUrl } = mod;
  assert.equal(n("  foo\r\nbar\n\tbaz  "), "foo bar baz");
  assert.equal(n("テスト abc"), "テスト abc");
  assert.equal(n("設定\nファイル\u3000.ts"), "設定 ファイル .ts", "ideographic space collapses too");
  assert.equal(n("a\u0000b\u0007c\u001bd\u007fe\u0085f"), "abcdef", "control characters removed");
  assert.equal(n("a\r\r\n\n b"), "a b");
  assert.equal(n(""), "");
  assert.equal(n(" \r\n\t "), "");
  assert.equal(n(null), "");
  assert.equal(n(undefined), "");
  assert.equal(n(42), "");
  // cap at 1000 UTF-16 units, never splitting a surrogate pair
  assert.equal(n("x".repeat(5000)).length, 1000);
  const capped = n("a" + "😀".repeat(600)); // 1 + 1200 units: the cut lands inside a pair
  assert.equal(capped.length, 999);
  assert.ok(capped.endsWith("😀"));
  assert.equal(n("x".repeat(999) + " y"), "x".repeat(999), "trailing space after the cut trimmed");
  assert.equal(n("a\uD800b"), "a\uFFFDb", "lone surrogate made well-formed");
  assert.equal(n("x".repeat(200_000)).length, 1000);

  assert.equal(clipboardSearchUrl(" \n "), undefined);
  assert.equal(clipboardSearchUrl("テスト abc"), "es:%E3%83%86%E3%82%B9%E3%83%88%20abc");
  assert.equal(clipboardSearchUrl('"C:\\x" (1) & y'), "es:%22C%3A%5Cx%22%20%281%29%20%26%20y");
  for (const text of ["テスト abc", '"a b" & | ^ %PATH% <x>', "a\uD800b", "😀".repeat(700), "設定\r\nファイル"]) {
    const url = clipboardSearchUrl(text);
    assert.equal(mod.isSafeEverythingUrl(url), true, text);
    assert.equal(decodeURIComponent(url.slice(3)), n(text));
  }
});

test("readClipboardText: native first, PowerShell base64 fallback", async () => {
  const { readClipboardText } = mod;
  let execCalls = 0;
  const fakeExec = (output, error) => (cmd, args, opts, cb) => {
    execCalls++;
    assert.equal(cmd, "powershell");
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.match(args[3], /ToBase64String.*Get-Clipboard -Raw/);
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.timeout, 5000);
    queueMicrotask(() => cb(error ?? null, output, ""));
  };
  const b64 = Buffer.from("テスト abc", "utf8").toString("base64") + "\r\n";
  const native = (getText) => () => ({ getText });
  assert.equal(await readClipboardText({ native: native(async () => "native"), execFile: fakeExec(b64) }), "native");
  assert.equal(await readClipboardText({ native: native(async () => null), execFile: fakeExec(b64) }), null);
  assert.equal(execCalls, 0, "native result (even null = empty) is final");
  assert.equal(await readClipboardText({ native: () => undefined, execFile: fakeExec(b64) }), "テスト abc");
  assert.equal(await readClipboardText({ native: native(async () => undefined), execFile: fakeExec(b64) }), "テスト abc");
  const rejecting = native(async () => { throw new Error("x"); });
  assert.equal(await readClipboardText({ native: rejecting, execFile: fakeExec(b64) }), "テスト abc");
  const loadFails = () => { throw new Error("load"); };
  assert.equal(await readClipboardText({ native: loadFails, execFile: fakeExec("\r\n") }), "");
  await assert.rejects(readClipboardText({ native: () => undefined, execFile: fakeExec("", new Error("timeout")) }), /timeout/);
  await assert.rejects(readClipboardText({ native: () => undefined, execFile: fakeExec("not base64!") }), /unexpected/);
  // The default native reader is pi-tui's getNativeClipboard (stubbed here).
  globalThis.__pathClickNativeClipboard = native(async () => "from pi-tui");
  try {
    assert.equal(await readClipboardText({ execFile: fakeExec(b64) }), "from pi-tui");
  } finally {
    delete globalThis.__pathClickNativeClipboard;
  }
});

// ---- openUrl hook (fake TUI, and a proxy like Pi's createInteractiveTuiReference) ----

const ORIGINAL = Symbol.for("pi.path-click.originalOpenUrl");
const HANDLER = Symbol.for("pi.path-click.openUrlHandler");
const TOOLBAR = Symbol.for("pi.toolbar.buttons");
const BUTTON_ID = "path-click.everything";

class FakeAltScreen {
  opened = [];
  renders = 0;
  openUrl = (url) => this.opened.push(url); // instance field like TuiAltScreen's options.openUrl
  requestRender() { this.renders++; }
  /** What TuiAltScreen does on a plain click of an OSC 8 link. */
  click(url) {
    try {
      this.openUrl(url);
    } catch {}
  }
}

/** Same traps as Pi's createInteractiveTuiReference (dist/modes/interactive/tui-renderer.js). */
function tuiReference(getTui) {
  return new Proxy({}, {
    get: (_t, property) => {
      const tui = getTui();
      const value = Reflect.get(tui, property, tui);
      if (typeof value !== "function") return value;
      let methodTui = tui;
      let method = value;
      return (...args) => {
        const current = getTui();
        if (current !== methodTui) {
          method = Reflect.get(current, property, current);
          methodTui = current;
        }
        return Reflect.apply(method, methodTui, args);
      };
    },
    set: (_t, property, value) => {
      const tui = getTui();
      return Reflect.set(tui, property, value, tui);
    },
    has: (_t, property) => Reflect.has(getTui(), property),
    getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
  });
}

function loadRuntime(tui, { exe = "C:\\Everything.exe", registered = false, mode = "tui", hasUI = true, clipboard } = {}) {
  const handlers = {};
  const launched = [];
  const notes = [];
  const widgets = [];
  let launchResult = true;
  let transformer;
  const pi = {
    on: (name, fn) => (handlers[name] = fn),
    registerMarkdownTransformer: (fn) => (transformer = fn),
  };
  const ctx = {
    cwd,
    mode,
    hasUI,
    ui: {
      notify: (msg, type) => notes.push([type, msg]),
      setWidget: (key, factory) => {
        widgets.push(key);
        if (typeof factory === "function") factory(tui, {});
      },
    },
  };
  mod.createPathClick({
    env: {},
    platform: "win32",
    findExe: () => exe,
    queryEsProtocol: (done) => done(registered),
    launch: (url, exePath, onError) => {
      launched.push([url, exePath]);
      if (launchResult === "error") onError(new Error("spawn failed"));
      return launchResult === true;
    },
    readClipboard: clipboard ?? (async () => "テスト abc"),
  })(pi);
  return {
    handlers, launched, notes, ctx, widgets,
    renderAssistant: (md) => transformer(md, { messageType: "assistant", isStreaming: false }),
    start: () => handlers.session_start({ type: "session_start" }, ctx),
    shutdown: () => handlers.session_shutdown({ type: "session_shutdown" }, ctx),
    setLaunchResult: (value) => (launchResult = value),
  };
}

function resetGlobals() {
  delete globalThis[HANDLER];
  globalThis[TOOLBAR]?.delete(BUTTON_ID);
}

test("openUrl hook: es: -> Everything, others -> original; reload does not stack; shutdown -> original", () => {
  resetGlobals();
  const screen = new FakeAltScreen();
  const original = screen.openUrl;
  const a = loadRuntime(screen);
  a.start();
  assert.deepEqual(a.widgets, ["path-click-probe", "path-click-probe"], "probe added and removed");
  const trampoline = screen.openUrl;
  assert.notEqual(trampoline, original);
  assert.ok(Object.hasOwn(screen, "openUrl"));
  assert.equal(screen[ORIGINAL], original);

  screen.click("es:%22x%22");
  assert.deepEqual(a.launched, [["es:%22x%22", "C:\\Everything.exe"]]);
  assert.deepEqual(screen.opened, []);
  screen.click("https://example.com/");
  screen.click("file:///C:/x.ts");
  assert.deepEqual(screen.opened, ["https://example.com/", "file:///C:/x.ts"]);

  // Launch refused (e.g. unsafe URL) -> original opener.
  a.setLaunchResult(false);
  screen.click("es:bad url");
  assert.equal(screen.opened.at(-1), "es:bad url");
  a.setLaunchResult(true);

  // Installing again (agent_end / another session_start) keeps original and trampoline.
  a.handlers.agent_end({}, a.ctx);
  a.start();
  assert.equal(screen.openUrl, trampoline);
  assert.equal(screen[ORIGINAL], original);
  assert.equal(mod.installOpenUrlHook(screen), screen);
  assert.equal(screen[ORIGINAL], original, "trampoline never saved as original");

  // /reload: the old module shuts down, a new module instance starts; nothing stacks.
  a.shutdown();
  assert.equal(globalThis[HANDLER], undefined);
  screen.click("es:after-shutdown");
  assert.equal(screen.opened.at(-1), "es:after-shutdown", "no handler -> original");
  const b = loadRuntime(screen);
  b.start();
  assert.equal(screen.openUrl, trampoline, "same stable trampoline");
  assert.equal(screen[ORIGINAL], original);
  screen.click("es:reloaded");
  assert.deepEqual(b.launched, [["es:reloaded", "C:\\Everything.exe"]]);
  assert.equal(a.launched.length, 2, "old module's handler is gone");
  // The old module shutting down late must not remove the new handler.
  a.shutdown();
  screen.click("es:still");
  assert.deepEqual(b.launched.at(-1), ["es:still", "C:\\Everything.exe"]);
  b.shutdown();
  resetGlobals();
});

test("openUrl hook: no exe -> original (protocol-only setup); errors never escape", () => {
  resetGlobals();
  const screen = new FakeAltScreen();
  const a = loadRuntime(screen, { exe: null, registered: true });
  a.start();
  screen.click("es:x");
  assert.deepEqual(screen.opened, ["es:x"]);
  assert.deepEqual(a.launched, []);
  globalThis[HANDLER] = () => { throw new Error("boom"); };
  assert.doesNotThrow(() => screen.openUrl("es:y"));
  delete globalThis[HANDLER];
  screen[ORIGINAL] = () => { throw new Error("orig"); };
  assert.doesNotThrow(() => screen.openUrl("https://x"));
  a.shutdown();
  resetGlobals();
});

test("openUrl hook: a wrapper around the trampoline saved as original does not loop", () => {
  resetGlobals();
  const screen = new FakeAltScreen();
  mod.installOpenUrlHook(screen);
  const trampoline = screen.openUrl;
  let wrapperCalls = 0;
  screen.openUrl = function (url) {
    wrapperCalls++;
    return trampoline.call(this, url);
  };
  mod.installOpenUrlHook(screen); // saves the wrapper as "original"
  assert.equal(screen.openUrl, trampoline);
  screen.click("https://x");
  assert.equal(wrapperCalls, 1);
  resetGlobals();
});

test("openUrl hook through Pi's renderer proxy; renderer switch re-hooks", () => {
  resetGlobals();
  let renderer = new FakeAltScreen();
  const first = renderer;
  const original = first.openUrl;
  const proxy = tuiReference(() => renderer);
  const a = loadRuntime(proxy);
  a.start();
  assert.equal(mod.resolveTuiInstance(proxy), first, "proxy unwrapped to the real renderer");
  assert.ok(Object.hasOwn(first, "openUrl"));
  assert.equal(first[ORIGINAL], original, "raw original saved, not the proxy's bound wrapper");
  first.click("es:a");
  first.click("https://a");
  assert.deepEqual(a.launched.map(([u]) => u), ["es:a"]);
  assert.deepEqual(first.opened, ["https://a"]);

  // /settings switches the TUI mode: a new renderer, hooked again after the next agent run.
  renderer = new FakeAltScreen();
  const second = renderer;
  assert.equal(Object.hasOwn(second, ORIGINAL), false);
  a.handlers.agent_end({}, a.ctx);
  second.click("es:b");
  second.click("https://b");
  assert.deepEqual(a.launched.map(([u]) => u), ["es:a", "es:b"]);
  assert.deepEqual(second.opened, ["https://b"]);

  // Switching again: the full re-render (assistant markdown transformers) re-hooks immediately.
  renderer = new FakeAltScreen();
  const third = renderer;
  assert.equal(a.renderAssistant("plain text"), "plain text");
  third.click("es:c");
  assert.deepEqual(a.launched.map(([u]) => u), ["es:a", "es:b", "es:c"]);
  const hooked = third.openUrl;
  a.renderAssistant("again");
  assert.equal(third.openUrl, hooked, "already-seen renderer is not touched again");

  // Regular (non-fullscreen) renderer has no openUrl: nothing installed.
  const main = { requestRender() {} };
  renderer = main;
  a.handlers.agent_end({}, a.ctx);
  assert.equal(main.openUrl, undefined);
  assert.equal(mod.installOpenUrlHook({}), undefined);
  assert.equal(mod.installOpenUrlHook(null), undefined);
  a.shutdown();
  resetGlobals();
});

test("toolbar button: registered in TUI with exe, clipboard search, removed on shutdown", async () => {
  resetGlobals();
  const screen = new FakeAltScreen();
  const a = loadRuntime(screen);
  assert.equal(globalThis[TOOLBAR]?.get(BUTTON_ID), undefined, "not before session_start");
  a.start();
  const map = globalThis[TOOLBAR];
  const button = map.get(BUTTON_ID);
  assert.equal(button.label, "[🔍 Everything]");
  assert.ok(screen.renders >= 1, "requestRender after registering");

  // Click: clipboard text -> es: URL -> launch
  await button.onClick();
  assert.deepEqual(a.launched, [["es:%E3%83%86%E3%82%B9%E3%83%88%20abc", "C:\\Everything.exe"]]);
  assert.deepEqual(a.notes, []);

  // Reload: the same id is overwritten by the new module (no duplicates); old shutdown leaves it alone.
  const b = loadRuntime(screen, { clipboard: async () => " \r\n " });
  b.start();
  assert.notEqual(map.get(BUTTON_ID), button);
  assert.equal([...map.keys()].filter((k) => k === BUTTON_ID).length, 1);
  a.shutdown();
  assert.ok(map.has(BUTTON_ID), "old module does not remove the new button");
  await map.get(BUTTON_ID).onClick();
  assert.deepEqual(b.launched, []);
  assert.deepEqual(b.notes, [["warning", "クリップボードが空です"]]);
  b.shutdown();

  // Clipboard error and launch error are reported.
  const c = loadRuntime(screen, { clipboard: async () => { throw new Error("locked"); } });
  c.start();
  await map.get(BUTTON_ID).onClick();
  assert.match(c.notes.at(-1)[1], /クリップボードを読めません: locked/);
  c.shutdown();
  const d = loadRuntime(screen);
  d.setLaunchResult("error");
  d.start();
  await map.get(BUTTON_ID).onClick();
  assert.match(d.notes.at(-1)[1], /Everything を起動できません/);

  const renders = screen.renders;
  d.shutdown();
  assert.equal(map.has(BUTTON_ID), false);
  assert.ok(screen.renders > renders, "requestRender after unregistering");
  resetGlobals();
});

test("toolbar button: not registered without exe, outside TUI, or with PI_PATH_CLICK_EVERYTHING=0", () => {
  resetGlobals();
  const screen = new FakeAltScreen();
  for (const opts of [{ exe: null, registered: true }, { mode: "rpc" }, { hasUI: false }]) {
    const r = loadRuntime(screen, opts);
    r.start();
    assert.equal(globalThis[TOOLBAR]?.has(BUTTON_ID) ?? false, false, JSON.stringify(opts));
    r.shutdown();
  }
  const handlers = {};
  mod.createPathClick({
    env: { PI_PATH_CLICK_EVERYTHING: "0" },
    platform: "win32",
    findExe: () => "C:\\E.exe",
    queryEsProtocol: (done) => done(true),
  })({ on: (n, f) => (handlers[n] = f), registerMarkdownTransformer: () => {} });
  handlers.session_start({}, { cwd, mode: "tui", hasUI: true, ui: { setWidget() {}, notify() {} } });
  assert.equal(globalThis[TOOLBAR]?.has(BUTTON_ID) ?? false, false);
  handlers.session_shutdown({}, {});
  resetGlobals();
});

test("detection: the button appears when the async registry query finds the exe", () => {
  resetGlobals();
  let pending;
  let found;
  const screen = new FakeAltScreen();
  const handlers = {};
  mod.createPathClick({
    env: {},
    platform: "win32",
    findExe: (command) => (found = command ? mod.parseEsCommandExe(command) : undefined),
    queryEsProtocol: (done) => (pending = done),
  })({ on: (n, f) => (handlers[n] = f), registerMarkdownTransformer: () => {} });
  handlers.session_start({}, { cwd, mode: "tui", hasUI: true, ui: { setWidget: (_k, f) => f && f(screen), notify() {} } });
  assert.equal(globalThis[TOOLBAR].has(BUTTON_ID), false);
  const renders = screen.renders;
  pending(true, '"C:\\Ev\\Everything.exe" -url "%1"');
  assert.equal(found, "C:\\Ev\\Everything.exe");
  assert.equal(globalThis[TOOLBAR].has(BUTTON_ID), true);
  assert.ok(screen.renders > renders);
  handlers.session_shutdown({}, {});
  // A stale query result after shutdown is ignored.
  pending(true, '"C:\\Ev\\Everything.exe" -url "%1"');
  assert.equal(globalThis[TOOLBAR].has(BUTTON_ID), false);
  resetGlobals();
});

test("foreignToWindowsPath: /E:/ , WSL and MSYS forms (win32 only)", () => {
  const { foreignToWindowsPath: f } = mod;
  assert.equal(f("/E:/DevTemp/a.png", false, "win32"), "E:/DevTemp/a.png");
  assert.equal(f("/e:\\x\\y", false, "win32"), "E:/x\\y");
  assert.equal(f("/E:", false, "win32"), "E:/");
  assert.equal(f("/e/Dev/a", false, "win32"), undefined);
  assert.equal(f("/e/Dev/a", true, "win32"), "E:/Dev/a");
  assert.equal(f("/mnt/e/Dev/a", true, "win32"), "E:/Dev/a");
  assert.equal(f("/usr/bin", true, "win32"), undefined);
  assert.equal(f("/E:/a", true, "linux"), undefined);
});

test("/X:/ style path links on Windows", { skip: process.platform !== "win32" }, () => {
  const abs = path.join(src, "a.ts");
  const foreign = "/" + abs.replace(/\\/g, "/");
  assert.equal(t(foreign), `[${foreign}](${fileUrl(abs)})`);
  assert.equal(t(`\`${foreign}\``), `[\`${foreign}\`](${fileUrl(abs)})`);
  assert.match(t("/" + path.join(src, "deep", "gone.md").replace(/\\/g, "/")), /\]\(es:/);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
