// Tests for mcp-idle-release.ts. Run: node --test mcp-idle-release.test.mjs  (Node >= 23.6 strips TS types)
// Unit tests use a stub for @earendil-works/pi-coding-agent. The integration tests load the REAL
// McpServerConnection from the installed Pi and a tiny stdio MCP server fixture, then release the
// server with the extension's own enumeration + kill functions and check that Pi reconnects.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const pcaRoot = path.join(
  process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
  "Volta/tools/image/packages/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-coding-agent",
);
const runtimePath = path.join(pcaRoot, "dist/extensions/mcp/runtime.js");
const havePi = existsSync(runtimePath);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return {
        url: "data:text/javascript," + encodeURIComponent("export const getAgentDir = () => globalThis.__mcpIdleAgentDir;"),
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});

const tmp = mkdtempSync(path.join(tmpdir(), "mcp idle test-")); // space on purpose
globalThis.__mcpIdleAgentDir = tmp;
after(() => rmSync(tmp, { recursive: true, force: true }));

const mod = await import("./mcp-idle-release.ts");
const {
  parseSettings,
  idleThresholdMs,
  isDue,
  collectStdioServers,
  buildToolServerMap,
  serverByPrefix,
  classifyToolCall,
  tokenizeWindows,
  unwrapCmdLine,
  commandLineViews,
  matchScore,
  assignProcesses,
  parseCimJson,
  parsePsOutput,
  createReleaser,
  defaultIsAlive,
  formatStatus,
  listChildProcesses,
  killProcessTree,
  isPassThrough,
  formatClock,
  bareToolName,
  buildProcessTree,
  parsePsTable,
  listProcessTree,
} = mod;

const win = "win32";
const S = (name, command, args = []) => ({ name, command, args });

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test("tokenizeWindows follows MSVC argv rules", () => {
  assert.deepEqual(tokenizeWindows(`"C:\\Program Files\\nodejs\\node.exe" "C:\\My Server\\index.js" --port 3000`), [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\My Server\\index.js",
    "--port",
    "3000",
  ]);
  assert.deepEqual(tokenizeWindows(`a\\\\"b c" d\\"e "x\\\\"`), ["a\\b c", 'd"e', "x\\"]);
  assert.deepEqual(tokenizeWindows(`  `), []);
  assert.deepEqual(tokenizeWindows(`""`), [""]);
});

test("cmd.exe-wrapped npx (cross-spawn escaping) matches", () => {
  const line =
    `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "C:\\Program^ Files\\nodejs\\npx.cmd ^"-y^" ` +
    `^"@modelcontextprotocol/server-filesystem^" ^"C:\\Users\\me\\My^ Docs^""`;
  assert.equal(
    unwrapCmdLine(line),
    `C:\\Program^ Files\\nodejs\\npx.cmd ^"-y^" ^"@modelcontextprotocol/server-filesystem^" ^"C:\\Users\\me\\My^ Docs^"`,
  );
  const views = commandLineViews(line, win);
  assert.deepEqual(views[1], [
    "C:\\Program Files\\nodejs\\npx.cmd",
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "C:\\Users\\me\\My Docs",
  ]);
  const server = S("fs", "npx", ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me\\My Docs"]);
  assert.equal(matchScore(line, server, win), 3);
  assert.equal(matchScore(line, S("fs", "npx.cmd", server.args), win), 3);
  assert.equal(matchScore(line, S("fs", "npx", ["-y", "@other/server"]), win), 0);
  assert.equal(matchScore(line, S("fs", "uvx", server.args), win), 0);
});

test("double-escaped node_modules/.bin shim matches", () => {
  const line = `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "E:\\p\\node_modules\\.bin\\srv.cmd ^^^"--root^^^" ^^^"a^^^ b^^^""`;
  assert.equal(matchScore(line, S("s", "E:/p/node_modules/.bin/srv.cmd", ["--root", "a b"]), win), 3);
  assert.equal(matchScore(line, S("s", "srv", ["--root", "a b"]), win), 3);
});

test("quoted paths and plain command lines", () => {
  const line = `"C:\\Program Files\\nodejs\\node.exe" "C:\\My Server\\index.js" --port 3000`;
  assert.equal(matchScore(line, S("a", "node", ["C:\\My Server\\index.js", "--port", "3000"]), win), 3);
  assert.equal(matchScore(line, S("a", "node", ["C:/My Server/index.js"]), win), 2); // slash-insensitive, prefix
  assert.equal(matchScore(line, S("a", "node", ["C:\\My Server\\index.js", "3000"]), win), 1); // subsequence
  assert.equal(matchScore(line, S("a", "node", ["C:\\Other\\index.js"]), win), 0);
  assert.equal(matchScore(`node.exe server.js`, S("a", "NODE", ["server.js"]), win), 3); // case-insensitive cmd
  // explicit cmd /c in the config itself
  assert.equal(matchScore(`cmd /c npx -y foo`, S("a", "cmd", ["/c", "npx", "-y", "foo"]), win), 3);
  assert.equal(matchScore(`cmd /c npx -y foo`, S("a", "npx", ["-y", "foo"]), win), 3);
});

test("bash tool children and unrelated processes do not match", () => {
  const server = S("fs", "npx", ["-y", "@foo/bar"]);
  assert.equal(matchScore(`"C:\\Program Files\\Git\\bin\\bash.exe" -c "npx -y @foo/bar"`, server, win), 0);
  assert.equal(matchScore(`C:\\Program Files\\Git\\usr\\bin\\bash.exe -c 'npx -y @foo/bar'`, server, win), 0);
  assert.equal(matchScore(`powershell.exe -NoProfile -Command "npx -y @foo/bar"`, server, win), 0);
  assert.equal(matchScore(`C:\\x\\npxx.exe -y @foo/bar`, server, win), 0);
  assert.equal(matchScore(`node C:\\npx\\cli.js -y @foo/bar`, server, win), 0);
  assert.equal(matchScore("", server, win), 0);
});

test("two servers with the same command and different args resolve to their own process", () => {
  const procs = [
    { pid: 1, commandLine: `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx ^"-y^" ^"pkg^""` },
    { pid: 2, commandLine: `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx ^"-y^" ^"pkg^" ^"--extra^""` },
    { pid: 3, commandLine: `"C:\\Program Files\\Git\\bin\\bash.exe" -c "npx -y pkg"` },
  ];
  const a = S("a", "npx", ["-y", "pkg"]);
  const b = S("b", "npx", ["-y", "pkg", "--extra"]);
  let map = assignProcesses(procs, [a, b], win);
  assert.deepEqual(map.get("a").map((p) => p.pid), [1]);
  assert.deepEqual(map.get("b").map((p) => p.pid), [2]);
  // a not running: b's process must not be taken for a (it matches b better)
  map = assignProcesses([procs[1], procs[2]], [a, b], win);
  assert.deepEqual(map.get("a"), []);
  assert.deepEqual(map.get("b").map((p) => p.pid), [2]);
  // identical configs → ambiguous for both
  map = assignProcesses([procs[0]], [a, S("a2", "npx", ["-y", "pkg"])], win);
  assert.equal(map.get("a").length, 1);
  assert.equal(map.get("a2").length, 1);
  map = assignProcesses([procs[0], { ...procs[0], pid: 9 }], [a], win);
  assert.equal(map.get("a").length, 2);
});

test("posix ps output", () => {
  const out = [
    "  100     1  2048 /sbin/init",
    "  200   150 40960 node /srv/mcp/index.js --stdio",
    "  201   150  1024 /bin/bash -c npx -y foo",
    "  202   150  8192 uvx mcp-server-git --repository /my repo",
    "",
  ].join("\n");
  const procs = parsePsOutput(out, 150);
  assert.deepEqual(procs.map((p) => p.pid), [200, 201, 202]);
  assert.equal(procs[0].memory, 40960 * 1024);
  assert.equal(matchScore(procs[0].commandLine, S("n", "node", ["/srv/mcp/index.js", "--stdio"]), "linux"), 3);
  // `bash -c <script>` (bash tool) is never a server, even though ps shows the script unquoted
  assert.equal(matchScore(procs[1].commandLine, S("x", "npx", ["-y", "foo"]), "linux"), 0);
  assert.equal(matchScore("/bin/sh /opt/srv/run.sh --x", S("x", "/opt/srv/run.sh", ["--x"]), "linux"), 3); // shebang
  assert.equal(matchScore("bash -lc foo", S("x", "bash", ["-lc", "foo"]), "linux"), 3);
  assert.equal(matchScore("node /srv/a.js", S("x", "node", ["/srv/b.js"]), "linux"), 0);
  // spaced args are split like ps output
  assert.equal(
    matchScore(procs[2].commandLine, S("g", "uvx", ["mcp-server-git", "--repository", "/my repo"]), "linux"),
    3,
  );
});

test("parseCimJson handles empty, single object and array", () => {
  assert.deepEqual(parseCimJson(""), []);
  assert.deepEqual(parseCimJson("  \r\n"), []);
  const one = parseCimJson('{"ProcessId":12,"CommandLine":"node a.js","WorkingSetSize":1048576,"Created":0}');
  assert.deepEqual(one, [{ pid: 12, commandLine: "node a.js", memory: 1048576 }]);
  const many = parseCimJson('\uFEFF[{"ProcessId":1,"CommandLine":null},{"ProcessId":2,"CommandLine":"x","Created":133000000000000000}]');
  assert.equal(many.length, 2);
  assert.equal(many[0].commandLine, "");
  assert.equal(Math.round(many[1].created), 133000000000000000 / 10000 - 11644473600000);
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test("tool → server mapping via namespace, prefix fallback only when unambiguous", () => {
  const tools = [
    { name: "mcp__unityMCP__run", namespace: { name: "mcp__unityMCP", aliases: ["unityMCP"] } },
    { name: "mcp__my_srv__list", namespace: { name: "mcp__my_srv", aliases: ["my-srv"] } },
    { name: "mcp__a_b__x", namespace: { name: "mcp__a.b", aliases: ["a.b"] } },
    { name: "mcp__nsonly__y", namespace: { name: "mcp__nsonly" } },
    { name: "read", namespace: undefined },
  ];
  const map = buildToolServerMap(tools, ["unityMCP", "my-srv", "a.b", "nsonly"]);
  assert.equal(map.get("mcp__unityMCP__run"), "unityMCP");
  assert.equal(map.get("mcp__my_srv__list"), "my-srv");
  assert.equal(map.get("mcp__a_b__x"), "a.b");
  assert.equal(map.get("mcp__nsonly__y"), "nsonly");
  assert.equal(map.has("read"), false);

  assert.equal(serverByPrefix("mcp__a_b__x", ["a.b", "c"]), "a.b");
  assert.equal(serverByPrefix("mcp__a_b__x", ["a.b", "a-b"]), undefined); // ambiguous
  assert.equal(serverByPrefix("mcp__zzz__x", ["a.b"]), undefined);
  assert.equal(serverByPrefix("read", ["read"]), undefined);
});

test("classifyToolCall", () => {
  const resolve = (name) => (name === "mcp__u__t" ? "u" : undefined);
  assert.deepEqual(classifyToolCall("mcp__u__t", {}, resolve), { servers: ["u"], all: false, global: false });
  assert.deepEqual(classifyToolCall("mcp__x__t", {}, resolve), { servers: [], all: false, global: false });
  assert.deepEqual(classifyToolCall("codemode", {}, resolve), { servers: [], all: false, global: true });
  assert.deepEqual(classifyToolCall("tool_search", {}, resolve), { servers: [], all: false, global: true });
  assert.deepEqual(classifyToolCall("read_mcp_resource", { server: "u", uri: "x" }, resolve), {
    servers: ["u"],
    all: false,
    global: false,
  });
  assert.deepEqual(classifyToolCall("list_mcp_resources", {}, resolve), { servers: [], all: true, global: true });
  assert.deepEqual(classifyToolCall("bash", { command: "x" }, resolve), { servers: [], all: false, global: false });
});

// ---------------------------------------------------------------------------
// Config + idle decision
// ---------------------------------------------------------------------------

test("parseSettings defaults, merge and validation", () => {
  assert.deepEqual(parseSettings(undefined).settings, {
    enabled: true,
    idleMinutes: 10,
    checkIntervalSeconds: 30,
    notify: true,
    exclude: [],
    servers: {},
  });
  const { settings, errors } = parseSettings({
    enabled: false,
    idleMinutes: 5,
    checkIntervalSeconds: 1,
    notify: false,
    exclude: ["keep"],
    servers: { fast: { idleMinutes: 1 }, never: { idleMinutes: 0 }, bad: { idleMinutes: -1 } },
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.idleMinutes, 5);
  assert.equal(settings.checkIntervalSeconds, 5); // clamped
  assert.equal(settings.notify, false);
  assert.deepEqual(settings.exclude, ["keep"]);
  assert.deepEqual(settings.servers, { fast: { idleMinutes: 1 }, never: { idleMinutes: 0 } });
  assert.equal(errors.length, 1);
  assert.ok(parseSettings({ idleMinutes: "x", exclude: "y" }).errors.length === 2);
  assert.deepEqual(parseSettings([]).errors, ["root must be a JSON object"]);

  assert.equal(idleThresholdMs(settings, "other"), 5 * 60_000);
  assert.equal(idleThresholdMs(settings, "other", 2), 2 * 60_000); // session default
  assert.equal(idleThresholdMs(settings, "fast", 2), 60_000); // per-server wins
  assert.equal(idleThresholdMs(settings, "never"), 0);
  assert.equal(idleThresholdMs(settings, "keep", 2), 0);
  assert.equal(idleThresholdMs({ ...settings, idleMinutes: 0 }, "other"), 0);
});

test("isDue", () => {
  const t = { lastUse: 0, inflight: 0, status: "running" };
  assert.equal(isDue(t, 60_000, 60_000, false), true);
  assert.equal(isDue(t, 59_999, 60_000, false), false);
  assert.equal(isDue(t, 60_000, 0, false), false);
  assert.equal(isDue(t, 60_000, 60_000, true), false);
  assert.equal(isDue({ ...t, inflight: 1 }, 60_000, 60_000, false), false);
  assert.equal(isDue({ ...t, status: "released" }, 60_000, 60_000, false), false);
  assert.equal(isDue({ ...t, status: "absent" }, 60_000, 60_000, false), false);
});

test("collectStdioServers merges like Pi", () => {
  const user = {
    mcpServers: {
      a: { command: "npx", args: ["-y", "a"] },
      b: { command: "uvx", args: ["b"] },
      web: { url: "https://x" },
      off: { command: "x", enabled: false },
      home: { command: "~/bin/srv", args: ["~/data", "x~"] },
    },
  };
  const project = {
    mcpServers: {
      b: { enabled: false }, // override
      a: { command: "node", args: ["local.js"] }, // replacement
      c: { url: "https://y" },
      ghost: { enabled: true }, // override without base → ignored
    },
  };
  const registered = [
    { name: "a", config: { command: "ignored" } },
    { name: "r", config: { command: "reg", args: [] } },
  ];
  const servers = collectStdioServers({ user, project, registered });
  const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), ["a", "home", "r"]);
  assert.deepEqual(byName.a, { name: "a", command: "node", args: ["local.js"] });
  assert.equal(byName.home.command, path.join(homedir(), "bin/srv"));
  assert.deepEqual(byName.home.args, [path.join(homedir(), "data"), "x~"]);
  assert.deepEqual(collectStdioServers({}), []);
});

// ---------------------------------------------------------------------------
// Releaser core (fake clock / processes)
// ---------------------------------------------------------------------------

function fakeReleaser({ servers, settings = {}, procs = [], exit = false } = {}) {
  let now = 0;
  const notes = [];
  const killed = [];
  const state = { procs, listHook: undefined, listCalls: 0, dead: new Set(), seen: [], killHook: undefined };
  const releaser = createReleaser({
    now: () => now,
    platform: win,
    getServers: () => servers,
    getSettings: () => ({ ...parseSettings(undefined).settings, idleMinutes: 1, ...settings }),
    resolveTool: (tool, names) => names.find((n) => tool.startsWith(`mcp__${n}__`)),
    listProcesses: async () => {
      state.listCalls++;
      await state.listHook?.();
      return state.procs;
    },
    killProcess: async (pid) => {
      killed.push(pid);
      state.procs = state.procs.filter((p) => p.pid !== pid);
      state.dead.add(pid);
      await state.killHook?.(pid);
      return true;
    },
    notify: (message, level) => notes.push({ message, level }),
    exitDetection: exit,
    isAlive: (pid) => {
      state.seen.push(pid);
      return !state.dead.has(pid);
    },
  });
  releaser.reset();
  return { releaser, notes, killed, state, advance: (ms) => (now += ms), at: () => now };
}

const proc = (pid, line) => ({ pid, commandLine: line });

test("releaser: idle server is released once, then respawned on use", async () => {
  const servers = [S("u", "node", ["u.js"]), S("v", "node", ["v.js"])];
  const f = fakeReleaser({ servers, procs: [proc(10, "node u.js"), proc(11, "node v.js")] });
  await f.releaser.check();
  assert.equal(f.state.listCalls, 0, "nothing due → no enumeration");
  f.advance(30_000);
  f.releaser.onToolStart("c1", "mcp__v__x", {});
  f.releaser.onToolEnd("c1");
  f.advance(30_000);
  await f.releaser.check();
  assert.deepEqual(f.killed, [10]); // v was used 30 s ago
  assert.equal(f.releaser.getTrack("u").status, "released");
  assert.match(f.notes[0].message, /MCP "u" をアイドルのため停止しました（次回呼び出しで自動再接続）/);
  f.advance(120_000);
  await f.releaser.check();
  assert.deepEqual(f.killed, [10, 11]);
  await f.releaser.check();
  assert.equal(f.state.listCalls, 2, "released servers are not due");
  // next use → running again (Pi respawns it)
  f.state.procs.push(proc(20, "node u.js"));
  f.releaser.onToolStart("c2", "mcp__u__x", {});
  assert.equal(f.releaser.getTrack("u").status, "running");
  f.releaser.onToolEnd("c2");
  f.advance(60_000);
  await f.releaser.check();
  assert.deepEqual(f.killed, [10, 11, 20]);
});

test("releaser: inflight, codemode and resource calls block release", async () => {
  const servers = [S("u", "node", ["u.js"])];
  const f = fakeReleaser({ servers, procs: [proc(10, "node u.js")] });
  f.releaser.onToolStart("c1", "mcp__u__slow", {});
  f.advance(10 * 60_000);
  await f.releaser.check();
  assert.deepEqual(f.killed, []);
  f.releaser.onToolEnd("c1");
  f.advance(60_000);
  f.releaser.onToolStart("cm", "codemode", { code: "..." });
  await f.releaser.check();
  assert.deepEqual(f.killed, [], "codemode in flight → all busy");
  f.releaser.onToolEnd("cm");
  f.releaser.onToolStart("r", "list_mcp_resources", {});
  await f.releaser.check();
  assert.deepEqual(f.killed, [], "resource listing of all servers");
  f.releaser.onToolEnd("r");
  f.advance(60_000);
  // unknown ids / tools do nothing; agent_end clears leaked inflight counts
  f.releaser.onToolEnd("nope");
  f.releaser.onToolStart("leak", "mcp__u__x", {});
  f.advance(60_000);
  await f.releaser.check();
  assert.deepEqual(f.killed, []);
  f.releaser.clearInflight();
  await f.releaser.check();
  assert.deepEqual(f.killed, [10]);
});

test("releaser: re-checks after enumeration (call started meanwhile)", async () => {
  const servers = [S("u", "node", ["u.js"])];
  const f = fakeReleaser({ servers, procs: [proc(10, "node u.js")] });
  f.advance(60_000);
  f.state.listHook = async () => f.releaser.onToolStart("late", "mcp__u__x", {});
  await f.releaser.check();
  assert.deepEqual(f.killed, []);
  assert.equal(f.releaser.getTrack("u").status, "running");
});

test("releaser: one pass at a time", async () => {
  const servers = [S("u", "node", ["u.js"])];
  const f = fakeReleaser({ servers, procs: [proc(10, "node u.js")] });
  f.advance(60_000);
  let release;
  f.state.listHook = () => new Promise((r) => (release = r));
  const first = f.releaser.check();
  const second = f.releaser.check();
  assert.equal(f.state.listCalls, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(f.killed, [10]);
});

test("releaser: absent / ambiguous → skip (absent silently, ambiguous warns once), no re-enumeration until used", async () => {
  const servers = [S("u", "node", ["u.js"]), S("gone", "node", ["gone.js"])];
  const f = fakeReleaser({ servers, procs: [proc(10, "node u.js"), proc(11, "node.exe u.js")] });
  f.advance(60_000);
  await f.releaser.check();
  assert.deepEqual(f.killed, []);
  assert.equal(f.releaser.getTrack("u").status, "ambiguous");
  assert.equal(f.releaser.getTrack("gone").status, "absent");
  assert.equal(f.notes.filter((n) => n.level === "warning").length, 1, "absent is silent, ambiguous warns");
  await f.releaser.check();
  assert.equal(f.state.listCalls, 1);
  f.releaser.onToolStart("x", "mcp__u__t", {});
  f.releaser.onToolEnd("x");
  f.advance(60_000);
  await f.releaser.check();
  assert.equal(f.notes.filter((n) => n.level === "warning").length, 1, "warned once");
});

test("releaser: settings (disabled, notify off, exclude) and manual release", async () => {
  const servers = [S("u", "node", ["u.js"]), S("keep", "node", ["k.js"])];
  const f = fakeReleaser({
    servers,
    settings: { notify: false, exclude: ["keep"] },
    procs: [proc(10, "node u.js"), proc(11, "node k.js")],
  });
  f.releaser.setSessionEnabled(false);
  f.advance(60_000);
  await f.releaser.check();
  assert.equal(f.state.listCalls, 0);
  f.releaser.setSessionEnabled(true);
  await f.releaser.check();
  assert.deepEqual(f.killed, [10]);
  assert.equal(f.notes.length, 0, "notify: false");
  // manual release ignores idle time but not inflight
  f.releaser.onToolStart("k", "mcp__keep__t", {});
  assert.match(await f.releaser.releaseNow("keep"), /使用中/);
  f.releaser.onToolEnd("k");
  assert.equal(await f.releaser.releaseNow("keep"), "");
  assert.deepEqual(f.killed, [10, 11]);
  assert.match(await f.releaser.releaseNow("keep"), /起動していません/);
  assert.match(await f.releaser.releaseNow("nope"), /設定にありません/);
  const { rows } = await f.releaser.status(true);
  const text = formatStatus(rows, "hdr");
  assert.match(text, /^hdr\nserver\s+state/);
  assert.match(text, /keep\s+released/);
});

// ---------------------------------------------------------------------------
// Integration: real Pi McpServerConnection + real processes
// ---------------------------------------------------------------------------

const fixture = path.join(tmp, "echo-server.mjs");
writeFileSync(
  fixture,
  `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id === undefined) return; // notifications (initialized, cancelled…)
  switch (m.method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: "echo-fixture", version: "1.0.0" } } });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo text",
        inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
    case "tools/call":
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text",
        text: process.pid + ":" + (m.params.arguments?.text ?? "") }] } });
    case "ping":
      return send({ jsonrpc: "2.0", id: m.id, result: {} });
    default:
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  }
});
rl.on("close", () => process.exit(0));
`,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs, what) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const textOf = (result) => result.content.map((c) => c.text).join("");

test("integration: real McpServerConnection reconnects after the extension kills its process", { skip: !havePi && "installed Pi not found", timeout: 60_000 }, async () => {
  const runtime = await import(pathToFileURL(runtimePath).href);
  const entry = { name: "echoFixture", config: { command: process.execPath, args: [fixture] } };
  const connection = new runtime.McpServerConnection({
    entry,
    cwd: tmp,
    createTransport: runtime.createDefaultTransport,
    credentials: { forServer: () => ({}) },
    onTools: () => {},
    onChange: () => {},
  });
  const server = { name: entry.name, command: entry.config.command, args: entry.config.args };
  try {
    await connection.getClient();
    assert.equal(connection.state, "connected");
    assert.deepEqual(connection.tools.map((t) => t.name), ["echo"]);
    const first = textOf(await connection.callTool("echo", { text: "hi" }));
    const pid1 = Number(first.split(":")[0]);
    assert.equal(first, `${pid1}:hi`);

    const t0 = performance.now();
    const procs = await listChildProcesses(process.pid);
    const enumMs = performance.now() - t0;
    const found = assignProcesses(procs, [server]).get(server.name);
    assert.equal(found.length, 1, `exactly one match among ${JSON.stringify(procs)}`);
    assert.equal(found[0].pid, pid1);

    const t1 = performance.now();
    assert.equal(await killProcessTree(pid1), true);
    await waitFor(() => connection.state === "disconnected", 10_000, "disconnected state");
    const killMs = performance.now() - t1;
    assert.deepEqual(connection.tools.map((t) => t.name), ["echo"], "tools stay registered");

    const t2 = performance.now();
    const second = textOf(await connection.callTool("echo", { text: "again" }));
    const respawnMs = performance.now() - t2;
    const pid2 = Number(second.split(":")[0]);
    assert.notEqual(pid2, pid1, "new process");
    assert.equal(second, `${pid2}:again`);
    assert.equal(connection.state, "connected");

    const t3 = performance.now();
    await connection.callTool("echo", { text: "warm" });
    const warmMs = performance.now() - t3;

    // Repeated releases: Pi has no backoff / retry cap / failed state for stdio exits.
    const pids = new Set([pid1, pid2]);
    let pid = pid2;
    for (let cycle = 0; cycle < 5; cycle++) {
      const match = assignProcesses(await listChildProcesses(process.pid), [server]).get(server.name);
      assert.deepEqual(match.map((p) => p.pid), [pid]);
      assert.equal(await killProcessTree(pid), true);
      await waitFor(() => connection.state === "disconnected", 10_000, "disconnected state");
      pid = Number(textOf(await connection.callTool("echo", { text: String(cycle) })).split(":")[0]);
      assert.equal(connection.state, "connected");
      assert.ok(!pids.has(pid), "fresh process each cycle");
      pids.add(pid);
    }

    const mem = found[0].memory === undefined ? "n/a" : `${(found[0].memory / 1024 / 1024).toFixed(1)} MB`;
    console.log(
      `# [measure] enumeration ${enumMs.toFixed(0)} ms (${procs.length} children), kill→disconnected ${killMs.toFixed(0)} ms, ` +
        `first call after release (respawn) ${respawnMs.toFixed(0)} ms, warm call ${warmMs.toFixed(1)} ms, ` +
        `fixture working set ${mem}`,
    );
  } finally {
    await connection.close();
  }
});

test("integration: releaser end-to-end with the real connection", { skip: !havePi && "installed Pi not found", timeout: 60_000 }, async () => {
  const runtime = await import(pathToFileURL(runtimePath).href);
  const entry = { name: "echo-two", config: { command: process.execPath, args: [fixture, "--two"] } };
  const connection = new runtime.McpServerConnection({
    entry,
    cwd: tmp,
    createTransport: runtime.createDefaultTransport,
    credentials: { forServer: () => ({}) },
    onTools: () => {},
    onChange: () => {},
  });
  let now = Date.now();
  const notes = [];
  const releaser = createReleaser({
    now: () => now,
    platform: process.platform,
    getServers: () => [{ name: entry.name, command: entry.config.command, args: entry.config.args }],
    getSettings: () => parseSettings({ idleMinutes: 1 }).settings,
    resolveTool: (tool, names) => buildToolServerMap(
      [{ name: "mcp__echo_two__echo", namespace: { name: "mcp__echo_two", aliases: ["echo-two"] } }],
      names,
    ).get(tool),
    listProcesses: () => listChildProcesses(process.pid),
    killProcess: (pid) => killProcessTree(pid),
    notify: (message, level) => notes.push({ message, level }),
  });
  try {
    await connection.getClient();
    releaser.reset();
    releaser.onToolStart("1", "mcp__echo_two__echo", {});
    const pid1 = Number(textOf(await connection.callTool("echo", { text: "x" })).split(":")[0]);
    releaser.onToolEnd("1");
    now += 61_000;
    await releaser.check();
    assert.equal(releaser.getTrack(entry.name).status, "released", JSON.stringify(notes));
    await waitFor(() => connection.state === "disconnected", 10_000, "disconnected state");
    releaser.onToolStart("2", "mcp__echo_two__echo", {});
    const pid2 = Number(textOf(await connection.callTool("echo", { text: "y" })).split(":")[0]);
    releaser.onToolEnd("2");
    assert.notEqual(pid2, pid1);
    assert.equal(releaser.getTrack(entry.name).status, "running");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].level, "info");
  } finally {
    await connection.close();
  }
});

test("integration (Windows): real cross-spawn .cmd shims are matched and killed as a tree", { skip: (process.platform !== "win32" || !havePi) && "Windows + installed Pi only", timeout: 60_000 }, async () => {
  const crossSpawn = createRequire(path.join(pcaRoot, "package.json"))("cross-spawn");
  const binDir = path.join(tmp, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, "echo-srv.cmd");
  writeFileSync(shim, `@"${process.execPath}" "${fixture}" %*\r\n`);
  const plainShim = path.join(tmp, "plain srv.cmd");
  writeFileSync(plainShim, `@"${process.execPath}" "${fixture}" %*\r\n`);
  const children = [
    crossSpawn(shim, ["--root", "a b", "x&y"], { stdio: "pipe", windowsHide: true }),
    crossSpawn(shim, ["--root", "a b", "x&y", "--extra"], { stdio: "pipe", windowsHide: true }),
    crossSpawn(plainShim, ["--name", "100%"], { stdio: "pipe", windowsHide: true }),
  ];
  const exited = children.map((child) => new Promise((resolve) => child.once("exit", resolve)));
  try {
    await sleep(500);
    const procs = await listChildProcesses(process.pid);
    const servers = [
      S("one", "echo-srv", ["--root", "a b", "x&y"]),
      S("two", shim, ["--root", "a b", "x&y", "--extra"]),
      S("plain", "plain srv", ["--name", "100%"]),
      S("missing", "echo-srv", ["--other"]),
    ];
    const map = assignProcesses(procs, servers);
    assert.deepEqual(map.get("one").map((p) => p.pid), [children[0].pid], JSON.stringify(procs, null, 1));
    assert.deepEqual(map.get("two").map((p) => p.pid), [children[1].pid]);
    assert.deepEqual(map.get("plain").map((p) => p.pid), [children[2].pid]);
    assert.deepEqual(map.get("missing"), []);
    // cmd.exe → node.exe: taskkill /T must take the grandchild down too (stdout pipe closes)
    const grandchildren = (await Promise.all(children.map((c) => listChildProcesses(c.pid)))).flat();
    assert.ok(grandchildren.length >= 3, "node grandchildren under cmd.exe");
    for (const child of children) assert.equal(await killProcessTree(child.pid), true);
    await Promise.all(exited);
    await sleep(300);
    const alive = grandchildren.filter((g) => {
      try {
        process.kill(g.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    assert.deepEqual(alive, [], "grandchildren killed");
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
});

test("extension wiring: events, config file, /mcp-idle command and completions", { timeout: 30_000 }, async () => {
  writeFileSync(
    path.join(tmp, "mcp.json"),
    JSON.stringify({ mcpServers: { alpha: { command: "node", args: ["alpha.js"] }, web: { url: "https://x" } } }),
  );
  writeFileSync(path.join(tmp, "mcp-idle-release.json"), JSON.stringify({ idleMinutes: 3, checkIntervalSeconds: "x" }));
  const handlers = {};
  let command;
  const notes = [];
  const pi = {
    on: (event, handler) => (handlers[event] = handler),
    registerCommand: (name, options) => (command = { name, ...options }),
    getMcpServers: () => [{ name: "beta", config: { command: "uvx", args: ["beta"] }, extensionPath: "x" }],
    getAllTools: () => [{ name: "mcp__alpha__go", namespace: { name: "mcp__alpha", aliases: ["alpha"] } }],
  };
  const ctx = { cwd: tmp, isProjectTrusted: () => false, ui: { notify: (message, level) => notes.push({ message, level }) } };
  mod.default(pi);
  assert.equal(command.name, "mcp-idle");
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  try {
    assert.match(notes[0].message, /checkIntervalSeconds must be a number/);
    assert.deepEqual(command.getArgumentCompletions("").map((i) => i.label), ["release", "on", "off", "minutes"]);
    assert.deepEqual(command.getArgumentCompletions("re").map((i) => i.value), ["release "]);
    assert.deepEqual(command.getArgumentCompletions("release ").map((i) => i.value).sort(), ["release alpha", "release beta"]);
    assert.equal(command.getArgumentCompletions("minutes 3 x"), null);
    handlers.tool_execution_start({ toolCallId: "1", toolName: "mcp__alpha__go", args: {} }, ctx);
    await command.handler("", ctx);
    const status = notes.at(-1).message;
    assert.match(status, /MCP idle release: on \(default 3 min/);
    assert.match(status, /alpha\s+(not running|running), busy\s+0s\s+3m/);
    assert.match(status, /beta\s+/);
    assert.doesNotMatch(status, /web/);
    handlers.tool_execution_end({ toolCallId: "1", toolName: "mcp__alpha__go" }, ctx);
    await command.handler("minutes 0.5", ctx);
    await command.handler("off", ctx);
    await command.handler("", ctx);
    assert.match(notes.at(-1).message, /MCP idle release: off \(default 0.5 min/);
    assert.match(notes.at(-1).message, /alpha\s+not running\s+\d+s\s+0\.5m/);
    await command.handler("bogus", ctx);
    assert.match(notes.at(-1).message, /^Usage/);
  } finally {
    handlers.session_shutdown({ type: "session_shutdown" }, ctx);
  }
});

test("timers are per instance: a second (subagent) session's start/shutdown keeps the first one's timer", { timeout: 30_000 }, async () => {
  const live = new Set();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (...args) => {
    const timer = realSet(...args);
    live.add(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    live.delete(timer);
    return realClear(timer);
  };
  const instance = () => {
    const handlers = {};
    mod.default({ on: (event, handler) => (handlers[event] = handler), registerCommand: () => {}, getMcpServers: () => [], getAllTools: () => [] });
    return handlers;
  };
  const ctx = { cwd: tmp, isProjectTrusted: () => false, ui: { notify: () => {} } };
  try {
    const main = instance();
    await main.session_start({ type: "session_start", reason: "startup" }, ctx);
    const [mainTimer] = live;
    assert.ok(mainTimer, "main session timer");
    const sub = instance();
    await sub.session_start({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(live.size, 2, "both run");
    sub.session_shutdown({ type: "session_shutdown" }, ctx);
    assert.deepEqual([...live], [mainTimer], "the subagent's shutdown stopped only its own timer");
    await main.session_start({ type: "session_start", reason: "new" }, ctx);
    assert.equal(live.size, 1, "restart replaces its own timer");
    main.session_shutdown({ type: "session_shutdown" }, ctx);
    assert.equal(live.size, 0);
  } finally {
    for (const timer of live) realClear(timer);
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

// ---------------------------------------------------------------------------
// Respawn notice / block policy (releaser core, event order as in Pi:
// tool_execution_start → tool_call → [execute → tool_result] → tool_execution_end)
// ---------------------------------------------------------------------------

const OK_RESULT = { content: [{ type: "text", text: "ok" }], structuredContent: { content: [{ type: "text", text: "ok" }] }, isError: false };

/** One call as Pi runs it. A blocked call gets no tool_result. */
function call(r, { id, tool, parent, input = {}, result = OK_RESULT, advance }) {
  r.releaser.onToolStart(id, tool, input);
  const decision = r.releaser.onToolCall({ toolCallId: id, toolName: tool, input, parentToolCallId: parent });
  let patch;
  if (!decision?.block) {
    advance?.();
    patch = r.releaser.onToolResult({ toolCallId: id, toolName: tool, parentToolCallId: parent, ...result });
  }
  r.releaser.onToolEnd(id);
  return { decision, patch };
}
/** A codemode root call around `body` (its nested calls); returns the patch of the root's own result. */
function rootCall(r, id, body, content = [{ type: "text", text: "Script completed\nOutput:\n" }]) {
  r.releaser.onToolStart(id, "codemode", {});
  r.releaser.onToolCall({ toolCallId: id, toolName: "codemode", input: {} });
  const inner = body();
  const shown = typeof content === "function" ? content(inner) : content;
  const patch = r.releaser.onToolResult({ toolCallId: id, toolName: "codemode", content: shown, isError: false });
  r.releaser.onToolEnd(id);
  return { inner, patch };
}

async function rerelease(f) {
  if (!f.state.procs.some((p) => p.pid === 10 || p.commandLine === "node u.js")) f.state.procs.push(proc(100 + f.killed.length, "node u.js"));
  f.advance(60_000);
  await f.releaser.check();
  assert.equal(f.releaser.getTrack("u").status, "released");
}

async function released(settings = {}) {
  const servers = [S("u", "node", ["u.js"]), S("v", "node", ["v.js"])];
  const f = fakeReleaser({ servers, settings, procs: [proc(10, "node u.js"), proc(11, "node v.js")] });
  await rerelease(f);
  assert.equal(f.releaser.getTrack("u").status, "released");
  return f;
}

test("notice: never on release, once on the first call (top-level); structuredContent preserved", async () => {
  const f = await released({ servers: { u: { respawnNote: "redo set_active_instance" } } });
  const releasedAt = f.at();
  assert.equal(f.notes.some((n) => /\[mcp-idle\]/.test(n.message)), false, "nothing for the AI at release time");
  f.advance(5_000);
  const sc = { content: [{ type: "text", text: "ok" }], structuredContent: { a: 1 }, isError: false };
  const { decision, patch } = call(f, {
    id: "c1",
    tool: "mcp__u__run",
    result: { content: [{ type: "text", text: "ok" }], structuredContent: sc, isError: false },
    advance: () => f.advance(3_400),
  });
  assert.equal(decision, undefined);
  assert.equal(patch.content.length, 2);
  assert.equal(patch.content[0].text, "ok");
  assert.equal(
    patch.content[1].text,
    `[mcp-idle] u は ${formatClock(releasedAt)} にアイドル停止され、この呼び出しで再起動しました（再起動を含むこの呼び出しの所要 3.4 秒）。メモリ上の状態は初期化されています。\nredo set_active_instance`,
  );
  assert.deepEqual(patch.structuredContent.content, sc.content, "script-visible content untouched");
  assert.deepEqual(patch.structuredContent.structuredContent, { a: 1 });
  assert.equal(patch.structuredContent._meta.mcpIdleRelease.notice, patch.content[1].text);
  assert.equal(call(f, { id: "c2", tool: "mcp__u__run" }).patch, undefined, "only once");
  assert.equal(call(f, { id: "c3", tool: "mcp__v__run" }).patch.content.length, 2, "v has its own notice");
  assert.equal(call(f, { id: "c4", tool: "read" }).patch, undefined);
});

test("notice: nested call → _meta only on the CallToolResult, text appended to the root codemode result", async () => {
  const f = await released();
  const { inner, patch } = rootCall(f, "cm", () => call(f, { id: "cm/1", tool: "mcp__u__run", parent: "cm" }));
  assert.deepEqual(inner.patch.structuredContent.content, [{ type: "text", text: "ok" }]);
  assert.match(inner.patch.structuredContent._meta.mcpIdleRelease.notice, /^\[mcp-idle\] u は \d\d:\d\d にアイドル停止され、この呼び出しで再起動しました/);
  assert.equal(patch.content.length, 2);
  assert.equal(patch.content[1].text, inner.patch.structuredContent._meta.mcpIdleRelease.notice);
  assert.equal("structuredContent" in patch, false, "codemode result has none, none invented");
  // nested-in-nested resolves to the model-issued root
  await rerelease(f);
  const deep = rootCall(f, "cm2", () => {
    f.releaser.onToolCall({ toolCallId: "cm2/1", toolName: "some_tool", input: {}, parentToolCallId: "cm2" });
    const r = call(f, { id: "cm2/1/1", tool: "mcp__u__run", parent: "cm2/1" });
    f.releaser.onToolEnd("cm2/1");
    return r;
  });
  assert.match(deep.patch.content.at(-1).text, /^\[mcp-idle\] u /);
});

test("notice: no duplicate when the script printed it; non-object structuredContent untouched", async () => {
  const f = await released();
  let notice;
  const first = rootCall(
    f,
    "cm",
    () => {
      const r = call(f, { id: "cm/1", tool: "mcp__u__run", parent: "cm" });
      notice = r.patch.structuredContent._meta.mcpIdleRelease.notice;
      return r;
    },
    [{ type: "text", text: "placeholder" }],
  );
  assert.ok(first.patch, "notice not in the output → appended");
  await rerelease(f);
  const again = rootCall(
    f,
    "cm2",
    () => call(f, { id: "cm2/1", tool: "mcp__u__run", parent: "cm2" }),
    (inner) => [{ type: "text", text: `Output:\n{"n":"${inner.patch.structuredContent._meta.mcpIdleRelease.notice.split("\n")[0]}"}` }],
  );
  assert.equal(again.patch, undefined, "script printed it already");
  await rerelease(f);
  const plain = rootCall(f, "cm3", () =>
    call(f, { id: "cm3/1", tool: "mcp__u__run", parent: "cm3", result: { content: [{ type: "text", text: "t" }], isError: false } }),
  );
  assert.equal(plain.inner.patch, undefined, "no structuredContent → the script's text value is left alone");
  assert.match(plain.patch.content.at(-1).text, /^\[mcp-idle\] u /);
});

test("notice: thrown failure keeps it pending; concurrent calls; unseen respawn; claimer without result", async () => {
  const f = await released();
  const failed = call(f, { id: "c1", tool: "mcp__u__run", result: { content: [{ type: "text", text: "spawn failed" }], isError: true } });
  assert.equal(failed.patch, undefined);
  assert.ok(f.releaser.getTrack("u").respawn, "still pending");
  // MCP-level isError (structuredContent present) did reach the respawned server → consumes it
  const mcpError = call(f, {
    id: "c2",
    tool: "mcp__u__run",
    result: { content: [{ type: "text", text: "bad args" }], structuredContent: { content: [], isError: true }, isError: true },
  });
  assert.match(mcpError.patch.content[1].text, /この呼び出しで再起動しました/);

  await rerelease(f);
  // two concurrent calls: the first tool_call claims
  f.releaser.onToolStart("a", "mcp__u__x", {});
  f.releaser.onToolStart("b", "mcp__u__y", {});
  f.releaser.onToolCall({ toolCallId: "a", toolName: "mcp__u__x", input: {} });
  f.releaser.onToolCall({ toolCallId: "b", toolName: "mcp__u__y", input: {} });
  const ok = { content: [{ type: "text", text: "ok" }], isError: false };
  assert.equal(f.releaser.onToolResult({ toolCallId: "b", toolName: "mcp__u__y", ...ok }), undefined);
  assert.equal(f.releaser.onToolResult({ toolCallId: "a", toolName: "mcp__u__x", ...ok }).content.length, 2);
  f.releaser.onToolEnd("a");
  f.releaser.onToolEnd("b");

  // nested call outliving its script: respawned unseen → the next call says so, without a duration
  await rerelease(f);
  f.releaser.onToolStart("cm", "codemode", {});
  f.releaser.onToolCall({ toolCallId: "cm", toolName: "codemode", input: {} });
  f.releaser.onToolStart("cm/1", "mcp__u__x", {});
  f.releaser.onToolCall({ toolCallId: "cm/1", toolName: "mcp__u__x", input: {}, parentToolCallId: "cm" });
  f.releaser.onToolResult({ toolCallId: "cm", toolName: "codemode", content: [], isError: true });
  const late = f.releaser.onToolResult({ toolCallId: "cm/1", toolName: "mcp__u__x", parentToolCallId: "cm", ...ok, structuredContent: { content: [] } });
  assert.equal(late, undefined);
  f.releaser.onToolEnd("cm/1");
  f.releaser.onToolEnd("cm");
  const next = call(f, { id: "n", tool: "mcp__u__x" });
  assert.match(next.patch.content[1].text, /アイドル停止され、その後再起動されました。メモリ上の状態は初期化されています。$/);

  // a claimer that never gets a tool_result (blocked by another extension) gives up its claim
  await rerelease(f);
  f.releaser.onToolStart("z", "mcp__u__x", {});
  f.releaser.onToolCall({ toolCallId: "z", toolName: "mcp__u__x", input: {} });
  f.releaser.onToolEnd("z");
  assert.match(call(f, { id: "z2", tool: "mcp__u__x" }).patch.content[1].text, /この呼び出しで再起動しました/);
});

test("block policy: refused once (server stays released), retry respawns with notice; passThrough", async () => {
  const settings = { servers: { u: { respawnPolicy: "block", passThrough: ["set_active_instance"], respawnNote: "main を選び直す" } } };
  const f = await released(settings);
  const releasedAt = f.at();
  const { decision } = call(f, { id: "c1", tool: "mcp__u__manage_scene" });
  assert.equal(decision.block, true);
  assert.equal(
    decision.reason,
    `[mcp-idle] u は ${formatClock(releasedAt)} にアイドル停止されたため、この呼び出し（manage_scene）は実行していません。` +
      "サーバーは次の呼び出しで自動的に再起動しますが、メモリ上の状態は初期化されています。\nmain を選び直す\n" +
      "必要な状態を再設定してから、この呼び出しをやり直してください。",
  );
  assert.equal(f.releaser.getTrack("u").status, "released", "the refused call did not respawn it");
  await rerelease(f);
  assert.equal(f.killed.length, 2, "a released server is not killed again");
  const retry = call(f, { id: "c2", tool: "mcp__u__manage_scene" });
  assert.equal(retry.decision, undefined, "blocked only once");
  assert.match(retry.patch.content[1].text, /この呼び出しで再起動しました/);

  // passThrough: never blocked, gets the notify notice, clears the pending block
  await rerelease(f);
  const pass = call(f, { id: "p1", tool: "mcp__u__set_active_instance" });
  assert.equal(pass.decision, undefined);
  assert.match(pass.patch.content[1].text, /この呼び出しで再起動しました/);
  assert.equal(call(f, { id: "p2", tool: "mcp__u__manage_scene" }).decision, undefined, "block cleared");

  // a failing passThrough call does not clear it
  await rerelease(f);
  const bad = call(f, { id: "p3", tool: "mcp__u__set_active_instance", result: { content: [], isError: true } });
  assert.equal(bad.decision, undefined);
  assert.equal(call(f, { id: "p4", tool: "mcp__u__manage_scene" }).decision.block, true);
  call(f, { id: "p5", tool: "mcp__u__manage_scene" });

  // nested blocked call: the reason is queued for the root too
  await rerelease(f);
  const nested = rootCall(f, "cm", () => call(f, { id: "cm/1", tool: "mcp__u__manage_scene", parent: "cm" }));
  assert.equal(nested.inner.decision.block, true);
  assert.equal(nested.patch.content.at(-1).text, nested.inner.decision.reason);

  // v (notify policy) is never blocked
  assert.equal(call(f, { id: "v1", tool: "mcp__v__run" }).decision, undefined);
});

test("block policy: list-all resource call in between; resource call with server is targeted", async () => {
  const f = await released({ servers: { u: { respawnPolicy: "block" } } });
  call(f, { id: "r", tool: "list_mcp_resources", result: { content: [], isError: false } });
  const blocked = call(f, { id: "c", tool: "read_mcp_resource", input: { server: "u", uri: "x" } });
  assert.equal(blocked.decision.block, true, "state is lost either way: still refused once");
  assert.match(blocked.decision.reason, /この呼び出し（read_mcp_resource）/);
  const next = call(f, { id: "d", tool: "mcp__u__x" });
  assert.match(next.patch.content[1].text, /その後再起動されました/);
});

/** A CallToolResult as unityMCP returns an app-level failure: isError false, success false. */
const appFail = (error = "Instance 'x' not found") => {
  const payload = { success: false, error };
  const text = JSON.stringify(payload);
  return {
    content: [{ type: "text", text }],
    structuredContent: { content: [{ type: "text", text }], structuredContent: payload, isError: false },
    isError: false,
  };
};
const appOk = () => {
  const payload = { success: true, message: "Active instance set" };
  const text = JSON.stringify(payload);
  return {
    content: [{ type: "text", text }],
    structuredContent: { content: [{ type: "text", text }], structuredContent: payload, isError: false },
    isError: false,
  };
};

test("isAppLevelFailure: isError, success:false at both levels, JSON text fallback", () => {
  const f = mod.isAppLevelFailure;
  const call = (sc, extra = {}) => ({ content: [], structuredContent: sc, isError: false, ...extra });
  assert.equal(f(appFail()), true, "unityMCP shape");
  assert.equal(f(appOk()), false);
  assert.equal(f({ content: [], isError: true }), true, "Pi-level isError (thrown)");
  assert.equal(f(call({ content: [], isError: true })), true, "CallToolResult isError");
  assert.equal(f(call({ success: false })), true, "Pi structuredContent itself (non-MCP tool)");
  assert.equal(f(call({ success: true })), false);
  assert.equal(f(call({ content: [{ type: "text", text: '{"success":false}' }], structuredContent: { success: true } })), false, "payload wins over text");
  // no payload: the CallToolResult's first text block as JSON
  assert.equal(f(call({ content: [{ type: "text", text: ' {"success": false, "error": "x"} ' }] })), true);
  assert.equal(f(call({ content: [{ type: "text", text: '{"success": true}' }] })), false);
  assert.equal(f(call({ content: [{ type: "text", text: 'not json "success": false' }] })), false);
  assert.equal(f(call({ content: [{ type: "text", text: '{"success": false' }] })), false, "broken JSON is not a failure");
  assert.equal(f(call({ content: [{ type: "text", text: '[{"success": false}]' }] })), false, "arrays are not inspected");
  assert.equal(f(call({ content: [{ type: "text", text: `{"success":false,"pad":"${"x".repeat(70_000)}"}` }] })), false, "big texts are not parsed");
  assert.equal(f(call({ content: [{ type: "image", data: "" }] })), false);
  assert.equal(f(call({ server: "u", uri: "x", contents: [] })), false, "resource result");
  // no structuredContent at all: Pi's own first text block
  assert.equal(f({ content: [{ type: "text", text: '{"success":false}' }], isError: false }), true);
  assert.equal(f({ content: [{ type: "text", text: "ok" }], isError: false }), false);
  assert.equal(f({ content: [], structuredContent: "text", isError: false }), false);
});

test("block policy: a passThrough that fails at app level re-arms the block (notice once, failure line)", async () => {
  const settings = { servers: { u: { respawnPolicy: "block", passThrough: ["set_active_instance"], respawnNote: "main \u3092\u9078\u3073\u76f4\u3059" } } };
  const f = await released(settings);
  const releasedAt = f.at();
  const SET = "mcp__u__set_active_instance";

  // block \u2192 passThrough fails \u2192 other call blocked \u2192 passThrough succeeds \u2192 other call runs
  assert.equal(call(f, { id: "a1", tool: "mcp__u__read_console" }).decision.block, true);
  const bad = call(f, { id: "a2", tool: SET, result: appFail() });
  assert.equal(bad.decision, undefined, "passThrough never blocked");
  const shown = bad.patch.content.at(-1).text.split("\n");
  assert.match(shown[0], /^\[mcp-idle\] u \u306f \d\d:\d\d \u306b\u30a2\u30a4\u30c9\u30eb\u505c\u6b62\u3055\u308c\u3001\u3053\u306e\u547c\u3073\u51fa\u3057\u3067\u518d\u8d77\u52d5\u3057\u307e\u3057\u305f/);
  assert.equal(shown[1], "main \u3092\u9078\u3073\u76f4\u3059");
  assert.equal(shown[2], mod.passThroughFailedNotice("u", "set_active_instance"));
  assert.equal(bad.patch.structuredContent.structuredContent.success, false, "payload preserved");
  assert.equal(bad.patch.structuredContent._meta.mcpIdleRelease.notice, bad.patch.content.at(-1).text);
  assert.equal(f.releaser.getTrack("u").status, "running");
  const again = call(f, { id: "a3", tool: "mcp__u__read_console" });
  assert.equal(again.decision.block, true, "blocked again: setup has not succeeded");
  assert.equal(
    again.decision.reason,
    `[mcp-idle] u \u306f ${formatClock(releasedAt)} \u306b\u30a2\u30a4\u30c9\u30eb\u505c\u6b62\u3055\u308c\u518d\u8d77\u52d5\u6e08\u307f\u3067\u3059\u304c\u3001\u76f4\u524d\u306e set_active_instance \u304c\u5931\u6557\u3057\u305f\u305f\u3081\u72b6\u614b\u306e\u518d\u8a2d\u5b9a\u304c\u307e\u3060\u6210\u529f\u3057\u3066\u3044\u307e\u305b\u3093\u3002` +
      "\u3053\u306e\u547c\u3073\u51fa\u3057\uff08read_console\uff09\u306f\u5b9f\u884c\u3057\u3066\u3044\u307e\u305b\u3093\u3002\nmain \u3092\u9078\u3073\u76f4\u3059\n\u5fc5\u8981\u306a\u72b6\u614b\u3092\u518d\u8a2d\u5b9a\u3057\u3066\u304b\u3089\u3001\u3053\u306e\u547c\u3073\u51fa\u3057\u3092\u3084\u308a\u76f4\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
  );
  assert.equal(f.releaser.getTrack("u").status, "running", "server is up: not marked released by the block");
  assert.match(formatStatus((await f.releaser.status(false)).rows, "h"), /u\s+running, block pending/);
  const good = call(f, { id: "a4", tool: SET, result: appOk() });
  assert.equal(good.patch, undefined, "no second respawn notice");
  assert.equal(f.releaser.getTrack("u").respawn, undefined, "cleared");
  const run = call(f, { id: "a5", tool: "mcp__u__read_console" });
  assert.equal(run.decision, undefined);
  assert.equal(run.patch, undefined);

  // passThrough fails first (no block yet) \u2192 other call blocked once \u2192 its retry runs, without a notice
  await rerelease(f);
  const first = call(f, { id: "b1", tool: SET, result: appFail() });
  assert.match(first.patch.content.at(-1).text, /\u3053\u306e\u547c\u3073\u51fa\u3057\u3067\u518d\u8d77\u52d5\u3057\u307e\u3057\u305f[\s\S]*\u3053\u306e set_active_instance \u306f\u5931\u6557\u3057\u307e\u3057\u305f/);
  assert.equal(call(f, { id: "b2", tool: "mcp__u__read_console" }).decision.block, true);
  const retry = call(f, { id: "b3", tool: "mcp__u__read_console" });
  assert.equal(retry.decision, undefined, "blocked once per failure");
  assert.equal(retry.patch, undefined, "respawn notice not repeated");
  assert.equal(f.releaser.getTrack("u").respawn, undefined);

  // repeated failures: each re-arms the block once; the failure line comes without a new respawn notice
  await rerelease(f);
  call(f, { id: "c1", tool: SET, result: appFail() });
  const second = call(f, { id: "c2", tool: SET, result: { ...appFail(), isError: true } });
  assert.equal(second.patch.content.at(-1).text, mod.passThroughFailedNotice("u", "set_active_instance"));
  assert.equal(call(f, { id: "c3", tool: "mcp__u__x" }).decision.block, true);
  assert.equal(call(f, { id: "c4", tool: "mcp__u__x" }).decision, undefined);

  // a new release while only the block is pending starts over (new time, full notice again)
  await rerelease(f);
  call(f, { id: "d1", tool: SET, result: appFail() });
  f.advance(120_000);
  await rerelease(f);
  assert.equal(f.releaser.getTrack("u").respawn.releasedAt, f.at());
  assert.equal(f.releaser.getTrack("u").respawn.noticeDelivered, undefined);
  const blocked = call(f, { id: "d2", tool: "mcp__u__x" });
  assert.match(blocked.decision.reason, /\u306b\u30a2\u30a4\u30c9\u30eb\u505c\u6b62\u3055\u308c\u305f\u305f\u3081/);
  assert.equal(f.releaser.getTrack("u").status, "released");
  assert.match(call(f, { id: "d3", tool: "mcp__u__x" }).patch.content.at(-1).text, /\u3053\u306e\u547c\u3073\u51fa\u3057\u3067\u518d\u8d77\u52d5\u3057\u307e\u3057\u305f/);

  // nested (codemode): failure line and the second block reason both reach the root result
  await rerelease(f);
  const nested = rootCall(f, "cm", () => {
    const s = call(f, { id: "cm/1", tool: SET, parent: "cm", result: appFail() });
    const r = call(f, { id: "cm/2", tool: "mcp__u__read_console", parent: "cm" });
    return { s, r };
  });
  assert.equal(nested.inner.r.decision.block, true);
  const rootText = nested.patch.content.at(-1).text;
  assert.match(rootText, /\u3053\u306e\u547c\u3073\u51fa\u3057\u3067\u518d\u8d77\u52d5\u3057\u307e\u3057\u305f/);
  assert.match(rootText, /\u3053\u306e set_active_instance \u306f\u5931\u6557\u3057\u307e\u3057\u305f/);
  // the block reason: its heading and last line (the respawnNote line was already appended with the first notice)
  const reasonLines = nested.inner.r.decision.reason.split("\n");
  assert.ok(rootText.includes(reasonLines[0]) && rootText.includes(reasonLines.at(-1)));

  // notify policy: a failing passThrough-listed tool simply consumes the notice
  const n = await released({ servers: { u: { passThrough: ["set_active_instance"] } } });
  call(n, { id: "e1", tool: SET, result: appFail() });
  assert.equal(n.releaser.getTrack("u").respawn, undefined);
});

test("root codemode result: the notice is appended unless every line is already visible in the output", async () => {
  const settings = { servers: { u: { respawnNote: "line two" } } };
  const f = await released(settings);
  const outputOf = (text) => [{ type: "text", text: "Script completed\nOutput:\n" }, { type: "text", text }];
  const noticeOf = (inner) => inner.patch.structuredContent._meta.mcpIdleRelease.notice;
  // JSON.stringify'd notice (escaped newline): every line is visible in escaped form
  const json = rootCall(f, "j", () => call(f, { id: "j/1", tool: "mcp__u__run", parent: "j" }), (inner) =>
    outputOf(JSON.stringify({ meta: inner.patch.structuredContent._meta })),
  );
  assert.equal(json.patch, undefined, "every line is visible in escaped form: nothing appended");
  // truncated copy (`.slice(0, n)`)
  await rerelease(f);
  const cut = rootCall(f, "t", () => call(f, { id: "t/1", tool: "mcp__u__run", parent: "t" }), (inner) =>
    outputOf(noticeOf(inner).slice(0, 40)),
  );
  assert.equal(cut.patch.content.at(-1).text, noticeOf(cut.inner));
  // swallowed: script returns 42
  await rerelease(f);
  const swallowed = rootCall(f, "s", () => call(f, { id: "s/1", tool: "mcp__u__run", parent: "s" }), () => outputOf("42"));
  assert.equal(swallowed.patch.content.at(-1).text, noticeOf(swallowed.inner));
  // the verbatim notice (all lines): not repeated
  await rerelease(f);
  const verbatim = rootCall(f, "v", () => call(f, { id: "v/1", tool: "mcp__u__run", parent: "v" }), (inner) =>
    outputOf(`prefix ${noticeOf(inner)} suffix`),
  );
  assert.equal(verbatim.patch, undefined);
  // block reason JSON.stringify'd by the script (the field report): fully visible, nothing appended
  const b = await released({ servers: { u: { respawnPolicy: "block", respawnNote: "note" } } });
  const blocked = rootCall(b, "k", () => call(b, { id: "k/1", tool: "mcp__u__read_console", parent: "k" }), (inner) =>
    outputOf(JSON.stringify({ call1: { ok: false, err: inner.decision.reason } })),
  );
  assert.equal(blocked.patch, undefined);
  // ... but cut short (`.slice(0, 60)`): heading and the lines that are not visible come along
  const b2 = await released({ servers: { u: { respawnPolicy: "block", respawnNote: "note" } } });
  const cutReason = rootCall(b2, "k2", () => call(b2, { id: "k2/1", tool: "mcp__u__read_console", parent: "k2" }), (inner) =>
    outputOf(JSON.stringify({ err: inner.decision.reason.slice(0, 60) })),
  );
  assert.equal(cutReason.patch.content.at(-1).text, cutReason.inner.decision.reason);
});

test("root codemode result: notice lines are deduplicated against the output and each other", async () => {
  const NOTE = "\u65e2\u5b9a\u306f main \u3092\u9078\u3073\u76f4\u3059\u3002" + "x".repeat(60); // long one-line respawnNote
  const settings = { servers: { u: { respawnPolicy: "block", respawnNote: NOTE, passThrough: ["set_active_instance"] } } };
  const outputOf = (text) => [{ type: "text", text: "Script completed\nOutput:\n" }, { type: "text", text }];
  const SET = "mcp__u__set_active_instance";
  const failed = { isError: false, content: [{ type: "text", text: '{"success":false}' }], structuredContent: { success: false } };

  // (a) the field report: escaped whole notice + a block reason cut at 200 chars
  const a = await released(settings);
  let notice;
  let reason;
  const ra = rootCall(
    a,
    "a",
    () => {
      const s = call(a, { id: "a/1", tool: SET, parent: "a", result: failed });
      notice = s.patch.structuredContent._meta.mcpIdleRelease.notice;
      const r = call(a, { id: "a/2", tool: "mcp__u__read_console", parent: "a" });
      reason = r.decision.reason;
      return { s, r };
    },
    () => outputOf(JSON.stringify({ notice, call1: reason.slice(0, 200) }, null, 2)),
  );
  const reasonLines = reason.split("\n");
  assert.ok(notice.includes(NOTE) && reason.includes(NOTE), "premise: both carry the respawnNote");
  assert.equal(ra.patch.content.length, 3);
  assert.equal(ra.patch.content[2].text, [reasonLines[0], reasonLines.at(-1)].join("\n"));
  assert.equal(ra.patch.content[2].text.includes(NOTE), false, "respawnNote not repeated");
  assert.equal(ra.inner.s.patch.structuredContent._meta.mcpIdleRelease.notice, notice, "_meta unchanged");

  // (b) two notices sharing the respawnNote line, nothing printed: the second one loses the line
  const b = await released({ servers: { u: { respawnNote: NOTE }, v: { respawnNote: NOTE } } });
  const rb = rootCall(
    b,
    "b",
    () => ({ u: call(b, { id: "b/1", tool: "mcp__u__run", parent: "b" }), v: call(b, { id: "b/2", tool: "mcp__v__run", parent: "b" }) }),
    () => outputOf("42"),
  );
  const nu = rb.inner.u.patch.structuredContent._meta.mcpIdleRelease.notice;
  const nv = rb.inner.v.patch.structuredContent._meta.mcpIdleRelease.notice;
  assert.equal(rb.patch.content[2].text, [nu, nv.split("\n")[0]].join("\n"));
  assert.equal(rb.patch.content[2].text.split(NOTE).length, 2, "respawnNote once");
  // direct (model-issued) calls keep the full notice
  await rerelease(b);
  const direct = call(b, { id: "b3", tool: "mcp__u__run" });
  assert.equal(direct.patch.content.at(-1).text.includes(NOTE), true);

  // (c) everything visible (verbatim, escaped, double-escaped): nothing appended
  const c = await released(settings);
  const rc = rootCall(
    c,
    "c",
    () => call(c, { id: "c/1", tool: SET, parent: "c", result: failed }),
    (inner) => {
      const lines = inner.patch.structuredContent._meta.mcpIdleRelease.notice.split("\n");
      return outputOf([lines[0], JSON.stringify(lines[1]).slice(1, -1), JSON.stringify(JSON.stringify(lines[2])).slice(1, -1)].join("\n"));
    },
  );
  assert.equal(rc.patch, undefined);

  // (d) only the heading is visible: heading and body both come along
  const notify = { servers: { u: { respawnNote: NOTE } } };
  const d = await released(notify);
  const rd = rootCall(
    d,
    "d",
    () => call(d, { id: "d/1", tool: "mcp__u__run", parent: "d" }),
    (inner) => outputOf(inner.patch.structuredContent._meta.mcpIdleRelease.notice.split("\n")[0]),
  );
  assert.equal(rd.patch.content.at(-1).text, rd.inner.patch.structuredContent._meta.mcpIdleRelease.notice);
  // heading unseen but the body line visible: heading only
  const e = await released(notify);
  const re = rootCall(
    e,
    "e",
    () => call(e, { id: "e/1", tool: "mcp__u__run", parent: "e" }),
    () => outputOf(NOTE),
  );
  assert.equal(re.patch.content.at(-1).text, re.inner.patch.structuredContent._meta.mcpIdleRelease.notice.split("\n")[0]);
});

// ---------------------------------------------------------------------------
// Unexpected exit of a server process (not stopped by this extension)
// ---------------------------------------------------------------------------

const EXIT_RE = /^\[mcp-idle\] (\S+) は \d\d:\d\d までに予期せず終了/;

test("defaultIsAlive: ESRCH = gone, EPERM = alive, own pid alive", () => {
  assert.equal(defaultIsAlive(process.pid), true);
  const real = process.kill;
  try {
    process.kill = () => {
      throw Object.assign(new Error("no"), { code: "ESRCH" });
    };
    assert.equal(defaultIsAlive(4242), false);
    process.kill = () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    };
    assert.equal(defaultIsAlive(4242), true, "no permission: the process exists");
    process.kill = () => {
      throw new Error("odd");
    };
    assert.equal(defaultIsAlive(4242), true, "unknown error: not taken for an exit");
  } finally {
    process.kill = real;
  }
});

/** Learned (one enumeration), then the server process dies on its own. */
async function learned(settings = {}, extra = {}) {
  const servers = [S("u", "node", ["u.js"]), S("v", "node", ["v.js"])];
  const f = fakeReleaser({
    servers,
    settings: { idleMinutes: 0, ...settings }, // never idle-released unless a test asks
    procs: [{ ...proc(10, "node u.js"), created: 1000 }, { ...proc(11, "node v.js"), created: 1001 }],
    exit: true,
    ...extra,
  });
  f.advance(31_000);
  await f.releaser.check();
  assert.equal(f.state.listCalls, 1, "pids learned by one enumeration");
  assert.deepEqual(f.killed, []);
  return f;
}

test("exit: learned once per interval at most; found on the next call: notify policy (notice + UI line)", async () => {
  const f = await learned({ servers: { u: { respawnNote: "NOTE-U" } } });
  f.advance(120_000);
  await f.releaser.check();
  assert.equal(f.state.listCalls, 1, "everything learned: no more enumerations");
  assert.deepEqual(f.notes, []);
  f.state.dead.add(10); // crashed
  const r = call(f, { id: "c1", tool: "mcp__u__run" });
  assert.equal(r.decision, undefined);
  const text = r.patch.content.at(-1).text;
  assert.match(text, /^\[mcp-idle\] u は \d\d:\d\d までに予期せず終了し、この呼び出しで再起動しました（再起動を含むこの呼び出しの所要 \d+\.\d 秒）。メモリ上の状態は初期化されています。原因は/);
  assert.match(text, /このセッションのサーバーとは限りません/);
  assert.ok(text.endsWith("\nNOTE-U"));
  assert.doesNotMatch(text, /アイドル停止/);
  assert.equal(f.releaser.getTrack("u").status, "running", "this call respawns it");
  assert.equal(f.releaser.getTrack("u").respawn, undefined);
  assert.deepEqual(f.notes.map((n) => [n.level, n.message]), [["warning", 'MCP "u" が予期せず終了しました（次回呼び出しで自動再接続。メモリ上の状態は初期化されます）']]);
  assert.equal(call(f, { id: "c2", tool: "mcp__u__run" }).patch, undefined, "told once");
  assert.equal(call(f, { id: "c3", tool: "mcp__v__run" }).patch, undefined, "other server unaffected");
  // the new process is learned by the next tick (the old copy is forgotten), not before
  f.state.procs = [{ ...proc(20, "node u.js"), created: 2000 }, { ...proc(11, "node v.js"), created: 1001 }];
  f.advance(31_000);
  await f.releaser.check();
  assert.equal(f.state.listCalls, 2);
  f.state.dead.add(20);
  assert.match(call(f, { id: "c4", tool: "mcp__u__run" }).patch.content.at(-1).text, EXIT_RE);
});

test("exit: block policy refuses the first call (also nested in codemode), passThrough runs and gets the notice", async () => {
  const f = await learned({ servers: { u: { respawnPolicy: "block", respawnNote: "NOTE-U", passThrough: ["setup"] } } });
  f.state.dead.add(10);
  const blocked = call(f, { id: "b1", tool: "mcp__u__run" });
  assert.equal(blocked.decision.block, true);
  assert.match(blocked.decision.reason, /^\[mcp-idle\] u は \d\d:\d\d までに予期せず終了したため、この呼び出し（run）は実行していません。/);
  assert.match(blocked.decision.reason, /NOTE-U\n必要な状態を再設定してから、この呼び出しをやり直してください。$/);
  assert.equal(f.releaser.getTrack("u").status, "released", "a refused call does not respawn");
  const retry = call(f, { id: "b2", tool: "mcp__u__run" });
  assert.equal(retry.decision, undefined);
  assert.match(retry.patch.content.at(-1).text, EXIT_RE);
  // nested in a codemode script: the reason reaches the root result as well
  await f.releaser.check();
  f.state.procs = [{ ...proc(21, "node u.js"), created: 2100 }, { ...proc(11, "node v.js"), created: 1001 }];
  f.advance(31_000);
  await f.releaser.check();
  f.state.dead.add(21);
  const nested = rootCall(f, "cm", () => call(f, { id: "cm/1", tool: "mcp__u__run", parent: "cm" }));
  assert.equal(nested.inner.decision.block, true);
  assert.ok(nested.patch.content.at(-1).text.includes("予期せず終了したため"));
  // passThrough: runs, carries the notice
  f.advance(31_000);
  f.state.procs = [{ ...proc(22, "node u.js"), created: 2200 }, { ...proc(11, "node v.js"), created: 1001 }];
  await f.releaser.check();
  f.state.dead.add(22);
  const setup = call(f, { id: "s1", tool: "mcp__u__setup" });
  assert.equal(setup.decision, undefined);
  assert.match(setup.patch.content.at(-1).text, EXIT_RE);
  assert.equal(call(f, { id: "s2", tool: "mcp__u__run" }).decision, undefined, "setup succeeded: block cleared");
});

test("exit: the tick reports it for a session that makes no calls; one UI line", async () => {
  const f = await learned();
  f.state.dead.add(11);
  await f.releaser.check();
  assert.equal(f.releaser.getTrack("v").respawn.reason, "exit");
  assert.equal(f.releaser.getTrack("v").status, "released");
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].message, /MCP "v" が予期せず終了しました/);
  f.advance(31_000);
  await f.releaser.check();
  assert.equal(f.notes.length, 1, "reported once");
  assert.match(call(f, { id: "v1", tool: "mcp__v__run" }).patch.content.at(-1).text, EXIT_RE);
});

test("exit: no pids known (not learned yet) or nothing remembered: free and silent", async () => {
  const f = fakeReleaser({ servers: [S("u", "node", ["u.js"])], procs: [proc(10, "node u.js")], exit: true });
  f.state.dead.add(10);
  assert.equal(call(f, { id: "a", tool: "mcp__u__run" }).patch, undefined);
  assert.deepEqual(f.state.seen, [], "no kill(pid, 0) without memo");
});

test("exit: the extension's own kill is never an exit (also while the kill is awaited)", async () => {
  const f = await learned({ idleMinutes: 1 });
  f.advance(120_000);
  let tick;
  let once = false;
  f.state.killHook = async () => {
    tick ??= f.releaser.check(); // a tick while taskkill runs; also a call to the server being killed
    if (once) return;
    once = true;
    const during = call(f, { id: "during", tool: "mcp__u__run" });
    assert.ok(during.patch === undefined || !EXIT_RE.test(during.patch.content.at(-1).text), "no exit notice during the kill");
  };
  await f.releaser.check();
  await tick;
  f.state.killHook = undefined;
  assert.deepEqual(f.killed.sort(), [10, 11]);
  for (const name of ["u", "v"]) {
    const pending = f.releaser.getTrack(name).respawn;
    assert.ok(pending === undefined || pending.reason === "idle", name + " is an idle release, not an exit");
  }
  // a call that was running on the server when it was stopped fails with Pi's connection-closed error: still an idle stop
  call(f, { id: "late", tool: "mcp__u__run", result: { content: [{ type: "text", text: "MCP connection closed" }], isError: true } });
  assert.equal(f.releaser.getTrack("u").respawn.reason, "idle");
  assert.equal(f.releaser.getTrack("v").respawn.reason, "idle");
  f.advance(31_000);
  // later ticks / calls: the killed pids are gone from the memo
  f.advance(31_000);
  await f.releaser.check();
  f.state.procs = [{ ...proc(30, "node u.js"), created: 3000 }];
  const next = call(f, { id: "n1", tool: "mcp__u__run" });
  assert.ok(!next.patch || /アイドル停止/.test(next.patch.content.at(-1).text), "idle wording");
  // a stale process list listing the killed pid must not bring it back
  f.state.procs = [{ ...proc(10, "node u.js"), created: 1000 }, { ...proc(30, "node u.js"), created: 3000 }];
  await f.releaser.status(true);
  assert.equal(f.releaser.getTrack("u").respawn, undefined);
});

test("exit: a failed kill clears the stopping flag: a later death of that process counts", async () => {
  const c = cluster([{ ...proc(10, "node u.js"), created: 1 }]);
  const a = c.make({ servers: [S("u", "node", ["u.js"])], hasUI: true, exit: true });
  c.advance(31_000);
  await a.releaser.check(); // learned
  c.state.killResult = () => false; // taskkill fails
  let during;
  c.state.killHook = (ok) => {
    during = [...c.registry.copies.values()][0][0].stopping;
    return Promise.resolve(ok);
  };
  c.advance(120_000);
  await a.releaser.check();
  assert.deepEqual(c.state.killed, [10]);
  assert.equal(during, true, "flagged while the kill is awaited");
  assert.equal([...c.registry.copies.values()][0][0].stopping, undefined, "flag removed: the kill failed");
  assert.equal(a.releaser.getTrack("u").respawn, undefined, "marks undone");
  c.state.dead.add(10); // it dies later on its own
  assert.match(call(a, { id: "k1", tool: "mcp__u__run" }).patch.content.at(-1).text, EXIT_RE);
});

test("exit: a leaving session (session_shutdown) and mcp_servers_change are not exits", async () => {
  const c = cluster([{ ...proc(10, "uvx unity-mcp"), created: 1 }, { ...proc(11, "uvx.exe unity-mcp"), created: 2 }]);
  const a = c.make({ servers: [S("unity", "uvx", ["unity-mcp"])], hasUI: true, exit: true });
  const b = c.make({ servers: [S("unityMCP", "C:\\tools\\uvx.exe", ["unity-mcp"])], exit: true });
  c.advance(31_000);
  await a.releaser.check();
  assert.equal(c.state.listCalls, 1);
  assert.equal([...c.registry.copies.values()][0].length, 2, "both copies learned (E = 2)");
  // b leaves: Pi closes its copy asynchronously
  b.releaser.unregister();
  assert.equal(c.registry.copies.size, 0, "memo forgotten");
  c.state.dead.add(11);
  c.state.procs = [{ ...proc(10, "uvx unity-mcp"), created: 1 }];
  assert.equal(call(a, { id: "a1", tool: "mcp__unity__run" }).patch, undefined, "the closed copy of a session that left is no exit");
  await a.releaser.check();
  assert.equal(a.releaser.getTrack("unity").respawn, undefined);
  assert.equal(c.registry.copies.size, 0, "not learned during the grace");
  // after the grace the key is learned again
  c.advance(31_000);
  await a.releaser.check();
  assert.equal(c.state.listCalls, 2);
  assert.equal([...c.registry.copies.values()].flat().length, 1);
  // mcp_servers_change: forget everything (Pi closes / reopens servers itself)
  a.releaser.forgetProcesses();
  assert.equal(c.registry.copies.size, 0);
  c.state.dead.add(10);
  assert.equal(call(a, { id: "a2", tool: "mcp__unity__run" }).patch, undefined);
  // a disposed session (ctx gone) is pruned: its copies' end is no exit either
  const d = cluster([{ ...proc(10, "node u.js"), created: 1 }, { ...proc(11, "node u.js"), created: 2 }]);
  let gone = false;
  const m = d.make({ servers: [S("u", "node", ["u.js"])], hasUI: true, exit: true });
  const x = d.make({ servers: [S("u", "node", ["u.js"])], alive: () => !gone, exit: true });
  d.advance(31_000);
  await m.releaser.check();
  assert.equal([...d.registry.copies.values()][0].length, 2);
  gone = true;
  d.state.dead.add(11);
  await m.releaser.check(); // prunes x (collectGroups) and forgets the key
  assert.equal(m.releaser.getTrack("u").respawn, undefined);
  assert.equal(d.registry.copies.size, 0);
});

test("exit: pid reuse (same pid, other creation time) on a later enumeration counts as an exit", async () => {
  const f = await learned();
  f.state.procs = [{ ...proc(10, "node u.js"), created: 5555 }, { ...proc(11, "node v.js"), created: 1001 }]; // 10 was reused by a new server
  await f.releaser.status(true);
  assert.equal(f.releaser.getTrack("u").respawn.reason, "exit");
  assert.equal(f.releaser.getTrack("v").respawn, undefined);
  assert.match(call(f, { id: "r1", tool: "mcp__u__run" }).patch.content.at(-1).text, EXIT_RE);
});

test("exit: repeated ticks and status listings of live servers keep the memo and raise nothing", async () => {
  const f = await learned();
  for (let i = 0; i < 3; i++) {
    f.advance(31_000);
    await f.releaser.check();
    await f.releaser.status(true);
  }
  assert.equal(f.releaser.getTrack("u").respawn, undefined);
  assert.equal(f.releaser.getTrack("v").respawn, undefined);
  assert.equal(f.notes.length, 0);
  assert.equal([...f.releaser.registry.copies.values()].flat().length, 2);
});

test("exit: every session using the server is told; its copy count (E) is untouched; no M<E warning meanwhile", async () => {
  const c = cluster([{ ...proc(10, "uvx unity-mcp"), created: 1 }, { ...proc(11, "uvx.exe unity-mcp"), created: 2 }]);
  const a = c.make({ servers: [S("unity", "uvx", ["unity-mcp"])], hasUI: true, exit: true });
  const b = c.make({ servers: [S("unityMCP", "C:\\tools\\uvx.exe", ["unity-mcp"])], exit: true });
  c.advance(31_000);
  await a.releaser.check();
  c.state.dead.add(11); // one of the two copies died
  const first = call(a, { id: "a1", tool: "mcp__unity__x" });
  assert.match(first.patch.content.at(-1).text, EXIT_RE);
  assert.equal(b.releaser.getTrack("unityMCP").respawn.reason, "exit", "told as well (which session's copy it was is unknown)");
  assert.equal(a.notes.length, 1, "one UI line");
  // a respawned (new copy 12); b has not called yet: E = 1 (a) vs 2 processes → suppressed, not parked, no warning
  c.state.procs = [{ ...proc(10, "uvx unity-mcp"), created: 1 }, { ...proc(12, "uvx unity-mcp"), created: 3 }];
  c.advance(31_000);
  await a.releaser.check();
  c.advance(120_000);
  await a.releaser.check();
  assert.equal(c.registry.parked.size, 0);
  assert.equal(a.notes.filter((n) => /一致するプロセス/.test(n.message)).length, 0, "no ambiguity warning while b has an exit notice pending");
  assert.deepEqual(c.state.killed, []);
  // b calls: its notice is delivered; the suppression ends with it
  assert.match(call(b, { id: "b1", tool: "mcp__unityMCP__x" }).patch.content.at(-1).text, /^\[mcp-idle\] unityMCP は \d\d:\d\d までに予期せず終了/);
  c.state.procs.push(proc(13, "uvx unity-mcp")); // now a genuinely foreign copy
  c.advance(31_000);
  await a.releaser.check();
  c.advance(120_000);
  await a.releaser.check();
  assert.equal(a.notes.filter((n) => /一致するプロセス/.test(n.message)).length, 1, "real mismatch is reported again");
});

test("exit: merges with an idle stop into one pending; the 'exit' wording wins", async () => {
  const f = await learned();
  f.state.dead.add(10);
  await f.releaser.check();
  const track = f.releaser.getTrack("u");
  const at = track.respawn.releasedAt;
  f.releaser.onToolStart("x", "mcp__u__run", {}); // a call started (status running) but no tool_call yet
  f.advance(60_000);
  f.releaser.participant.markReleased("u", f.at(), "idle");
  assert.equal(track.respawn.reason, "exit");
  assert.equal(track.respawn.releasedAt, at);
  f.releaser.onToolEnd("x");
});

test("exit: the call that respawns the server dies again (claimed) → the pending notice stays for the next call", async () => {
  const f = await learned({ servers: { u: { respawnNote: "NOTE-U" } } });
  f.state.dead.add(10);
  await f.releaser.check(); // tick finds the exit
  assert.equal(f.releaser.getTrack("u").respawn.reason, "exit");
  // call A claims the respawn and fails: the connection closed under it (no structuredContent)
  const a = call(f, {
    id: "A",
    tool: "mcp__u__run",
    result: { content: [{ type: "text", text: "MCP connection closed" }], isError: true },
  });
  assert.equal(a.patch, undefined);
  assert.equal(f.releaser.getTrack("u").respawn.reason, "exit", "kept");
  assert.equal(f.releaser.getTrack("u").respawn.claimedBy, undefined);
  const b = call(f, { id: "B", tool: "mcp__u__run" });
  assert.match(b.patch.content.at(-1).text, EXIT_RE);
  assert.equal(f.releaser.getTrack("u").respawn, undefined);
});

test("exit: a call whose connection closed under it (Pi's own error) is an exit even without remembered pids", async () => {
  const f = fakeReleaser({ servers: [S("u", "node", ["u.js"])], procs: [proc(10, "node u.js")], exit: true });
  // another error: nothing
  call(f, { id: "e1", tool: "mcp__u__run", result: { content: [{ type: "text", text: "boom" }], isError: true } });
  assert.equal(f.releaser.getTrack("u").respawn, undefined);
  call(f, { id: "e2", tool: "mcp__u__run", result: { content: [{ type: "text", text: "MCP connection closed" }], isError: true } });
  assert.equal(f.releaser.getTrack("u").respawn.reason, "exit");
  assert.equal(f.notes.length, 1);
  assert.match(call(f, { id: "e3", tool: "mcp__u__run" }).patch.content.at(-1).text, EXIT_RE);
  // an error that carries structuredContent (the server answered) is not one
  call(f, { id: "e4", tool: "mcp__u__run", result: { content: [{ type: "text", text: "MCP connection closed" }], structuredContent: {}, isError: true } });
  assert.equal(f.releaser.getTrack("u").respawn, undefined);
  // the extension's own release: its pending notice stays "idle"
  f.advance(120_000);
  f.state.procs = [proc(10, "node u.js")];
  f.releaser.participant.markReleased("u", f.at(), "idle");
  call(f, { id: "e5", tool: "mcp__u__run", result: { content: [{ type: "text", text: "MCP connection closed" }], isError: true } });
  assert.equal(f.releaser.getTrack("u").respawn.reason, "idle");
});

test("exit: learning is retried only when something changes (a server that never starts costs one enumeration)", async () => {
  const f = fakeReleaser({ servers: [S("u", "node", ["u.js"])], settings: { idleMinutes: 0 }, procs: [], exit: true });
  for (let i = 0; i < 5; i++) {
    f.advance(31_000);
    await f.releaser.check();
  }
  assert.equal(f.state.listCalls, 1, "nothing found: not enumerated again every interval");
  f.state.procs = [{ ...proc(10, "node u.js"), created: 1 }];
  f.advance(11 * 60_000);
  await f.releaser.check();
  assert.equal(f.state.listCalls, 2, "retried after PARK_RETRY_MS");
  assert.equal([...f.releaser.registry.copies.values()][0].length, 1);
  // exitDetection: false → nothing is learned or enumerated at all
  const off = fakeReleaser({ servers: [S("u", "node", ["u.js"])], procs: [proc(10, "node u.js")], exit: false });
  off.advance(31_000);
  await off.releaser.check();
  assert.equal(off.state.listCalls, 0);
});

test("measure: exit detection cost per tool_call (memo present, process alive)", () => {
  const servers = [S("u", "node", ["u.js"])];
  const registry = mod.createRegistry();
  registry.copies.set(mod.identityKey(servers[0], win), [{ pid: process.pid, created: 1 }]);
  const mk = (isAlive) =>
    createReleaser({
      now: () => 0,
      platform: win,
      getServers: () => servers,
      getSettings: () => parseSettings(undefined).settings,
      resolveTool: (tool, names) => names.find((n) => tool.startsWith("mcp__" + n + "__")),
      listProcesses: async () => [],
      killProcess: async () => true,
      notify: () => {},
      registry,
      ...(isAlive ? { isAlive } : { exitDetection: false }),
    });
  const run = (r, n) => {
    const t = performance.now();
    for (let i = 0; i < n; i++) {
      r.onToolStart("c", "mcp__u__run", {});
      r.onToolCall({ toolCallId: "c", toolName: "mcp__u__run", input: {} });
      r.onToolResult({ toolCallId: "c", toolName: "mcp__u__run", content: [], structuredContent: {}, isError: false });
      r.onToolEnd("c");
    }
    return ((performance.now() - t) / n) * 1000;
  };
  const off = mk(undefined);
  const stub = mk(() => true);
  const real = mk(mod.defaultIsAlive); // process.kill(pid, 0) on this process
  run(off, 2000);
  run(real, 2000);
  const a = run(off, 20000);
  const b = run(stub, 20000);
  const d = run(real, 20000);
  let dead = performance.now();
  for (let i = 0; i < 20000; i++) mod.defaultIsAlive(2147483000);
  dead = ((performance.now() - dead) / 20000) * 1000;
  console.log("# [measure] tool_call cycle without exit detection " + a.toFixed(2) + " µs; with memo (stub isAlive) " + b.toFixed(2) + " µs; with memo + process.kill(pid, 0) " + d.toFixed(2) + " µs; kill(pid, 0) of a dead pid " + dead.toFixed(2) + " µs");
  assert.ok(d - a < 200, "adds well under 200 µs per call (got " + (d - a).toFixed(1) + ")");
});

test("passThrough matching, bareToolName, formatClock", () => {
  const settings = parseSettings({
    servers: { unityMCP: { passThrough: ["set_active_instance", "mcp__unityMCP__ping", "get_*"] }, "my-srv": { passThrough: ["a-b"] } },
  }).settings;
  assert.equal(isPassThrough(settings, "unityMCP", "mcp__unityMCP__set_active_instance"), true);
  assert.equal(isPassThrough(settings, "unityMCP", "mcp__unityMCP__ping"), true);
  assert.equal(isPassThrough(settings, "unityMCP", "mcp__unityMCP__get_state"), true);
  assert.equal(isPassThrough(settings, "unityMCP", "mcp__unityMCP__manage_scene"), false);
  assert.equal(isPassThrough(settings, "unityMCP", "mcp__unityMCP__set_active_instance_x"), false);
  assert.equal(isPassThrough(settings, "my-srv", "mcp__my_srv__a_b"), true, "sanitized like Pi's tool names");
  assert.equal(isPassThrough(settings, "other", "mcp__other__x"), false);
  assert.equal(bareToolName("mcp__my_srv__a_b", "my-srv"), "a_b");
  assert.equal(bareToolName("read_mcp_resource", "u"), "read_mcp_resource");
  assert.match(formatClock(Date.now()), /^\d\d:\d\d$/);
  assert.equal(formatClock(new Date(2024, 0, 1, 7, 5).getTime()), "07:05");
});

test("parseSettings: respawnNote / respawnPolicy / passThrough; replayTools reported as unsupported", () => {
  const { settings, errors } = parseSettings({
    servers: {
      unityMCP: { idleMinutes: 10, respawnNote: " 既定は main ", respawnPolicy: "block", passThrough: ["set_active_instance"] },
      bad: { respawnPolicy: "maybe", passThrough: "x", respawnNote: 3 },
      partial: { idleMinutes: 2, respawnPolicy: "nope" },
      replay: { replayTools: ["x"] },
    },
  });
  assert.deepEqual(settings.servers.unityMCP, {
    idleMinutes: 10,
    respawnNote: "既定は main",
    respawnPolicy: "block",
    passThrough: ["set_active_instance"],
  });
  assert.equal("bad" in settings.servers, false);
  assert.deepEqual(settings.servers.partial, { idleMinutes: 2 });
  assert.equal("replay" in settings.servers, false);
  assert.equal(errors.length, 5, errors.join("\n"));
  assert.ok(errors.some((e) => /replayTools is not supported/.test(e)));
  assert.equal(mod.respawnPolicy(settings, "partial"), "notify");
  assert.equal(mod.respawnPolicy(settings, "unityMCP"), "block");
});

// ---------------------------------------------------------------------------
// Process tree memory
// ---------------------------------------------------------------------------

test("buildProcessTree sums the whole subtree, ignores reused pids and cycles", () => {
  const MB = 1024 * 1024;
  const table = [
    { pid: 1, ppid: 0, commandLine: "", memory: 100 * MB, created: 1000 }, // pi
    { pid: 10, ppid: 1, commandLine: "uvx unity", memory: 12 * MB, created: 2000 },
    { pid: 11, ppid: 10, commandLine: "", memory: 150 * MB, created: 2100 }, // python
    { pid: 12, ppid: 11, commandLine: "", memory: 28 * MB, created: 2200 },
    { pid: 13, ppid: 10, commandLine: "", memory: 5 * MB, created: 1500 }, // created before its "parent": pid reuse
    { pid: 20, ppid: 1, commandLine: "node x", memory: 40 * MB, created: 3000 },
    { pid: 30, ppid: 1, commandLine: "old orphan", memory: 1 * MB, created: 500 }, // older than pi
    { pid: 21, ppid: 22, commandLine: "", memory: 1 * MB, created: 3100 }, // unreachable cycle
    { pid: 22, ppid: 21, commandLine: "", memory: 1 * MB, created: 3100 },
  ];
  const tree = buildProcessTree(table, 1, 0);
  const byPid = Object.fromEntries(tree.map((p) => [p.pid, p]));
  assert.deepEqual(Object.keys(byPid).map(Number).sort((a, b) => a - b), [10, 20]);
  assert.equal(byPid[10].treeMemory, 190 * MB);
  assert.equal(byPid[10].treeCount, 3);
  assert.equal(byPid[10].commandLine, "uvx unity");
  assert.equal(byPid[20].treeMemory, 40 * MB);
  // posix rows (no creation times)
  const ps = parsePsTable(" 1 0 100 init\n 5 1 2048 uvx srv\n 6 5 4096 python -m srv\n 7 6 1024 child\n");
  const posix = buildProcessTree(ps, 1);
  assert.equal(posix.length, 1);
  assert.equal(posix[0].treeMemory, (2048 + 4096 + 1024) * 1024);
  assert.equal(posix[0].treeCount, 3);
  // self-parented entries (pid 0 "System Idle Process" on Windows) do not loop
  assert.deepEqual(buildProcessTree([{ pid: 0, ppid: 0, commandLine: "" }], 0), []);
  // CIM rows carry ParentProcessId
  assert.equal(parseCimJson('[{"ProcessId":5,"ParentProcessId":1,"CommandLine":null,"WorkingSetSize":10}]')[0].ppid, 1);
});

test("status uses the tree listing: memory of the whole tree, procs count, notice pending", async () => {
  const servers = [S("u", "uvx", ["unity"])];
  let now = 0;
  const releaser = createReleaser({
    now: () => now,
    platform: win,
    getServers: () => servers,
    getSettings: () => parseSettings({ idleMinutes: 1 }).settings,
    resolveTool: () => "u",
    listProcesses: async () => [{ pid: 10, commandLine: "uvx unity", memory: 12 * 1024 * 1024 }],
    listProcessTree: async () => [
      { pid: 10, commandLine: "uvx unity", memory: 12 * 1024 * 1024, treeMemory: 190 * 1024 * 1024, treeCount: 4 },
    ],
    killProcess: async () => true,
    notify: () => {},
  });
  releaser.reset();
  const { rows } = await releaser.status(true);
  assert.equal(rows[0].memory, 190 * 1024 * 1024);
  assert.match(formatStatus(rows, "h"), /u\s+running\s+0s\s+1m\s+10\s+190 MB \(4 procs\)/);
  now += 60_000;
  await releaser.check();
  const later = await releaser.status(false);
  assert.match(formatStatus(later.rows, "h"), /u\s+released, notice pending/);
});

test("extension wiring registers tool_call / tool_result; no-ops for other tools", { timeout: 30_000 }, async () => {
  const handlers = {};
  const pi = {
    on: (event, handler) => (handlers[event] = handler),
    registerCommand: () => {},
    getMcpServers: () => [],
    getAllTools: () => [],
  };
  const ctx = { cwd: tmp, isProjectTrusted: () => false, ui: { notify: () => {} } };
  mod.default(pi);
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  try {
    assert.equal(typeof handlers.tool_call, "function");
    assert.equal(typeof handlers.tool_result, "function");
    assert.equal(handlers.tool_call({ type: "tool_call", toolCallId: "1", toolName: "read", input: {} }, ctx), undefined);
    assert.equal(
      handlers.tool_result({ type: "tool_result", toolCallId: "1", toolName: "read", input: {}, content: [], isError: false }, ctx),
      undefined,
    );
  } finally {
    handlers.session_shutdown({ type: "session_shutdown" }, ctx);
  }
});

test("measure: per-call overhead of the new handlers", () => {
  const servers = [S("u", "node", ["u.js"]), S("v", "node", ["v.js"]), S("w", "uvx", ["w"])];
  const f = fakeReleaser({ servers });
  const N = 100_000;
  const bench = (tool) => {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const id = `c${i}`;
      f.releaser.onToolCall({ toolCallId: id, toolName: tool, input: {}, parentToolCallId: "root" });
      f.releaser.onToolResult({ toolCallId: id, toolName: tool, parentToolCallId: "root", ...OK_RESULT });
      f.releaser.onToolEnd(id);
    }
    return ((performance.now() - t0) * 1000) / N;
  };
  bench("mcp__u__x"); // warm-up
  const mcp = bench("mcp__u__x");
  const other = bench("read");
  console.log(
    `# [measure] tool_call + tool_result handlers (+ end bookkeeping): MCP tool ${mcp.toFixed(2)} µs/call, ` +
      `other tool ${other.toFixed(2)} µs/call (no notice pending; the fake resolver is cheaper than the real one)`,
  );
  assert.ok(mcp < 1000, "well under a millisecond");

  // isAppLevelFailure (only evaluated for the claiming passThrough call under "block")
  const time = (result) => {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) mod.isAppLevelFailure(result);
    return ((performance.now() - t0) * 1000) / N;
  };
  const textOnly = { content: [], structuredContent: { content: [{ type: "text", text: JSON.stringify({ success: false, error: "x".repeat(200) }) }] }, isError: false };
  time(appFail());
  const payload = time(appFail());
  const text = time(textOnly);
  // a whole release cycle: block \u2192 failed passThrough (notice) \u2192 block \u2192 successful passThrough
  const g = fakeReleaser({ servers: [S("u", "node", ["u.js"])], settings: { servers: { u: { respawnPolicy: "block", passThrough: ["set"] } } } });
  const M = 20_000;
  const t0 = performance.now();
  for (let i = 0; i < M; i++) {
    g.releaser.getTrack("u").respawn = { releasedAt: 0, reason: "idle", blocked: false };
    call(g, { id: `a${i}`, tool: "mcp__u__x" });
    call(g, { id: `b${i}`, tool: "mcp__u__set", result: appFail() });
    call(g, { id: `c${i}`, tool: "mcp__u__x" });
    call(g, { id: `d${i}`, tool: "mcp__u__set", result: appOk() });
  }
  const cycle = ((performance.now() - t0) * 1000) / M / 4;
  assert.equal(g.releaser.getTrack("u").respawn, undefined, "the cycle ends cleared");
  console.log(
    `# [measure] isAppLevelFailure: payload ${payload.toFixed(2)} \u00b5s, JSON-text fallback ${text.toFixed(2)} \u00b5s; ` +
      `block/passThrough-fail/block/passThrough-ok cycle ${cycle.toFixed(2)} \u00b5s per call (incl. notice text)`,
  );
  assert.ok(payload < 100 && text < 1000 && cycle < 1000);
});

test("integration: listProcessTree vs listChildProcesses (cost, same matching, tree memory)", { skip: !havePi && "installed Pi not found", timeout: 60_000 }, async () => {
  const runtime = await import(pathToFileURL(runtimePath).href);
  const entry = { name: "treeFixture", config: { command: process.execPath, args: [fixture, "--tree"] } };
  const connection = new runtime.McpServerConnection({
    entry,
    cwd: tmp,
    createTransport: runtime.createDefaultTransport,
    credentials: { forServer: () => ({}) },
    onTools: () => {},
    onChange: () => {},
  });
  try {
    await connection.getClient();
    const server = { name: entry.name, command: entry.config.command, args: entry.config.args };
    const times = { filtered: [], all: [] };
    let tree;
    let flat;
    for (let i = 0; i < 3; i++) {
      let t = performance.now();
      flat = await listChildProcesses(process.pid);
      times.filtered.push(performance.now() - t);
      t = performance.now();
      tree = await listProcessTree(process.pid);
      times.all.push(performance.now() - t);
    }
    const a = assignProcesses(flat, [server]).get(server.name);
    const b = assignProcesses(tree, [server]).get(server.name);
    assert.equal(a.length, 1);
    assert.deepEqual(b.map((p) => p.pid), a.map((p) => p.pid), "same matching on both listings");
    assert.ok(b[0].treeMemory >= b[0].memory);
    const med = (xs) => xs.sort((x, y) => x - y)[1].toFixed(0);
    console.log(
      `# [measure] filtered children query ${med(times.filtered)} ms, all-process tree query ${med(times.all)} ms (median of 3); ` +
        `fixture: own ${(b[0].memory / 1048576).toFixed(1)} MB, tree ${(b[0].treeMemory / 1048576).toFixed(1)} MB in ${b[0].treeCount} procs`,
    );
  } finally {
    await connection.close();
  }
});

test("session start (reset) drops pending notices: Pi reconnects every server then", async () => {
  const f = await released({ servers: { u: { respawnPolicy: "block" } } });
  f.releaser.reset();
  const r = call(f, { id: "c", tool: "mcp__u__x" });
  assert.equal(r.decision, undefined);
  assert.equal(r.patch, undefined);
});

// ---------------------------------------------------------------------------
// Shared registry: several sessions (main + in-process subagents) in one process
// ---------------------------------------------------------------------------

/** Several releasers on one registry, one clock and one process table (like sessions in one Pi process). */
function cluster(procs = []) {
  const registry = mod.createRegistry();
  let now = 0;
  const state = { procs, listCalls: 0, listHook: undefined, killed: [], killResult: () => true, killHook: undefined, dead: new Set() };
  const make = ({ servers, settings = {}, hasUI = false, alive = () => true, agentIdle = () => undefined, exit = false } = {}) => {
    const notes = [];
    const releaser = createReleaser({
      now: () => now,
      platform: win,
      getServers: () => servers,
      getSettings: () => ({ ...parseSettings(undefined).settings, idleMinutes: 1, ...settings }),
      resolveTool: (tool, names) => names.find((n) => tool.startsWith(`mcp__${n}__`)),
      listProcesses: async () => {
        state.listCalls++;
        await state.listHook?.();
        return state.procs;
      },
      killProcess: (pid) => {
        state.killed.push(pid);
        const ok = state.killResult(pid);
        if (ok) {
          state.procs = state.procs.filter((p) => p.pid !== pid);
          state.dead.add(pid);
        }
        return state.killHook ? state.killHook(ok) : Promise.resolve(ok);
      },
      notify: (message, level) => notes.push({ message, level }),
      registry,
      exitDetection: exit,
      isAlive: (pid) => !state.dead.has(pid),
      hasUI: () => hasUI,
      alive: () => alive(),
      agentIdle: () => agentIdle(),
    });
    releaser.reset();
    return { releaser, notes };
  };
  return { registry, state, make, advance: (ms) => (now += ms), at: () => now };
}

/** Main session (UI) "unity" and a subagent session "unityMCP": same command line, different names. */
function twoSessions(extraProcs = []) {
  const c = cluster([proc(10, "uvx unity-mcp"), proc(11, "uvx.exe unity-mcp"), ...extraProcs]);
  const a = c.make({ servers: [S("unity", "uvx", ["unity-mcp"])], hasUI: true });
  const b = c.make({ servers: [S("unityMCP", "C:\\tools\\uvx.exe", ["unity-mcp"])] });
  return { c, a, b };
}

test("identityKey follows the matcher's normalization", () => {
  const { identityKey } = mod;
  assert.equal(identityKey(S("a", "uvx", ["x/y"]), win), identityKey(S("b", "C:\\bin\\UVX.EXE", ["x\\y"]), win));
  assert.notEqual(identityKey(S("a", "uvx", ["x"]), win), identityKey(S("a", "uvx", ["X"]), win));
  assert.equal(identityKey(S("a", "/usr/bin/node", ["a b"]), "linux"), identityKey(S("b", "node", ["a", "b"]), "linux"));
});

test("registry: both sessions idle → every copy killed, each session gets its own notice, one UI line", async () => {
  const { c, a, b } = twoSessions();
  c.advance(30_000);
  call(b, { id: "b1", tool: "mcp__unityMCP__x" }); // the subagent used it 30 s later
  c.advance(40_000);
  await a.releaser.check();
  assert.equal(c.state.listCalls, 0, "b is not idle yet: nothing due, no enumeration");
  c.advance(30_000);
  await b.releaser.check(); // the subagent's timer drives the pass
  assert.deepEqual(c.state.killed.sort(), [10, 11]);
  assert.equal(a.releaser.getTrack("unity").status, "released");
  assert.equal(b.releaser.getTrack("unityMCP").status, "released");
  assert.deepEqual(b.notes, [], "no UI line from the subagent session");
  assert.deepEqual(a.notes.map((n) => n.message), ['MCP "unity" をアイドルのため停止しました（次回呼び出しで自動再接続）（2 セッション分）']);
  // each session: its own first call carries its own notice (with its own server name)
  assert.match(call(a, { id: "a2", tool: "mcp__unity__x" }).patch.content[1].text, /^\[mcp-idle\] unity は \d\d:\d\d にアイドル停止され/);
  assert.match(call(b, { id: "b2", tool: "mcp__unityMCP__x" }).patch.content[1].text, /^\[mcp-idle\] unityMCP は \d\d:\d\d にアイドル停止され/);
  assert.equal(call(a, { id: "a3", tool: "mcp__unity__x" }).patch, undefined, "once per session");
});

test("registry: one session busy (call in flight, codemode, or not idle long enough) → nothing is killed", async () => {
  const { c, a, b } = twoSessions();
  b.releaser.onToolStart("slow", "mcp__unityMCP__run", {});
  c.advance(10 * 60_000);
  await a.releaser.check();
  assert.equal(c.state.listCalls, 0);
  b.releaser.onToolEnd("slow");
  await a.releaser.check();
  assert.equal(c.state.listCalls, 0, "b just finished: not idle");
  b.releaser.onToolStart("cm", "codemode", {});
  c.advance(10 * 60_000);
  await a.releaser.check();
  assert.equal(c.state.listCalls, 0, "codemode in the other session counts as busy");
  b.releaser.onToolEnd("cm");
  // a session that is off (or excludes it / has a longer threshold) holds the release for everyone
  b.releaser.setSessionEnabled(false);
  await a.releaser.check();
  assert.equal(c.state.listCalls, 0, "disabled in the other session");
  b.releaser.setSessionEnabled(true);
  await a.releaser.check();
  assert.deepEqual(c.state.killed.sort(), [10, 11]);
});

test("registry: a copy nobody accounts for (M ≠ E) → no kill, one warning, parked until something changes", async () => {
  const { c, a, b } = twoSessions([proc(12, "uvx unity-mcp")]); // e.g. a subagent without this extension
  c.advance(60_000);
  await b.releaser.check();
  assert.deepEqual(c.state.killed, []);
  const warnings = () => a.notes.filter((n) => n.level === "warning");
  assert.equal(warnings().length, 1, "warned via the UI session");
  assert.match(warnings()[0].message, /一致するプロセスが 3 個ありますが、このプロセス内のセッションが把握しているのは 2 個です/);
  assert.equal(a.releaser.getTrack("unity").status, "ambiguous");
  c.advance(60_000);
  await a.releaser.check();
  assert.equal(c.state.listCalls, 1, "parked: no enumeration while nothing changed");
  c.advance(mod.PARK_RETRY_MS);
  await a.releaser.check();
  assert.equal(c.state.listCalls, 2, "retried after PARK_RETRY_MS");
  assert.equal(warnings().length, 1, "still warned once");
  // the foreign copy went away and a session used it → released normally
  c.state.procs = c.state.procs.filter((p) => p.pid !== 12);
  call(a, { id: "u", tool: "mcp__unity__x" });
  c.advance(60_000);
  await a.releaser.check();
  assert.deepEqual(c.state.killed.sort(), [10, 11]);
  // fewer copies than expected (one died on its own): whose is unknown → skipped too
  const d = twoSessions();
  d.c.state.procs = [proc(10, "uvx unity-mcp")];
  d.c.advance(60_000);
  await d.a.releaser.check();
  assert.deepEqual(d.c.state.killed, []);
  assert.equal(d.a.notes.filter((n) => n.level === "warning").length, 1);
});

test("registry: a session that just left (its copy still closing) → key skipped silently for the grace, then released", async () => {
  const { c, a, b } = twoSessions();
  c.advance(60_000);
  b.releaser.unregister(); // session_shutdown: E drops to 1 now, its copy (pid 11) closes asynchronously
  await a.releaser.check(); // M = 2, E = 1
  assert.equal(c.state.listCalls, 0, "in grace: not even enumerated");
  assert.deepEqual(c.state.killed, []);
  assert.equal(a.notes.filter((n) => n.level === "warning").length, 0, "no ambiguous warning");
  assert.equal(c.registry.parked.size, 0, "not parked");
  assert.equal(a.releaser.getTrack("unity").status, "running", "status unchanged");
  c.state.procs = c.state.procs.filter((p) => p.pid !== 11); // the child's copy exited
  const grace = Math.max(parseSettings(undefined).settings.checkIntervalSeconds * 1000, mod.UNREGISTER_GRACE_MS);
  c.advance(grace);
  await a.releaser.check(); // M = E = 1
  assert.deepEqual(c.state.killed, [10]);
  assert.equal(a.releaser.getTrack("unity").status, "released");
  assert.equal(a.notes.filter((n) => n.level === "warning").length, 0);

  // a session leaving while the pass enumerates: the re-check before the kills skips silently
  const d = twoSessions([proc(12, "uvx unity-mcp")]);
  const e = d.c.make({ servers: [S("unity", "uvx", ["unity-mcp"])] });
  d.c.advance(60_000);
  d.c.state.listHook = async () => {
    e.releaser.unregister();
  };
  await d.a.releaser.check(); // found M = 3, E = 2 after it left
  assert.equal(d.c.state.listCalls, 1);
  assert.deepEqual(d.c.state.killed, []);
  assert.equal(d.a.notes.filter((n) => n.level === "warning").length, 0);
  assert.equal(d.c.registry.parked.size, 0);
  assert.equal(d.a.releaser.getTrack("unity").status, "running");
});

test("registry: a parked key is re-evaluated after a participant leaves (park cleared)", async () => {
  const { c, a, b } = twoSessions([proc(12, "uvx unity-mcp")]);
  c.advance(60_000);
  await a.releaser.check(); // M = 3, E = 2 → parked
  assert.equal(c.registry.parked.size, 1);
  b.releaser.unregister();
  assert.equal(c.registry.parked.size, 0, "park cleared");
  c.state.procs = c.state.procs.filter((p) => p.pid !== 11 && p.pid !== 12); // b's copy and the stray one exited
  c.advance(mod.UNREGISTER_GRACE_MS + 30_000);
  await a.releaser.check();
  assert.deepEqual(c.state.killed, [10], "re-evaluated well before PARK_RETRY_MS");
  assert.equal(a.releaser.getTrack("unity").status, "released");
});

test("registry: dead or stuck participants do not block forever", async () => {
  // dead: a disposed session (stale ctx) with a leaked in-flight count is pruned
  let bAlive = true;
  const c = cluster([proc(10, "uvx unity-mcp")]);
  const a = c.make({ servers: [S("unity", "uvx", ["unity-mcp"])], hasUI: true });
  const b = c.make({ servers: [S("unity", "uvx", ["unity-mcp"])], alive: () => bAlive });
  b.releaser.onToolStart("leak", "mcp__unity__x", {});
  b.releaser.getTrack("unity").status = "released"; // its copy is gone (connections closed)
  c.advance(10 * 60_000);
  await a.releaser.check();
  assert.equal(c.state.listCalls, 0, "b counts while alive");
  bAlive = false;
  await a.releaser.check();
  assert.deepEqual(c.state.killed, [10]);
  assert.equal(c.registry.instances.has(b.releaser.participant.id), false, "pruned");

  // stuck: alive, no agent run active, no tool event for STALE_INFLIGHT_MS → cleared
  const d = cluster([proc(10, "uvx unity-mcp"), proc(11, "uvx unity-mcp")]);
  let agentIdle = false;
  const m = d.make({ servers: [S("unity", "uvx", ["unity-mcp"])], hasUI: true });
  const s = d.make({ servers: [S("unity", "uvx", ["unity-mcp"])], agentIdle: () => agentIdle });
  s.releaser.onToolStart("leak", "codemode", {});
  d.advance(mod.STALE_INFLIGHT_MS + 60_000);
  await m.releaser.check();
  assert.equal(d.state.listCalls, 0, "agent still running: a long call is legitimate");
  agentIdle = true;
  await m.releaser.check();
  assert.deepEqual(d.state.killed.sort(), [10, 11], "agent idle + no activity for long: stale counts cleared");
});

test("registry: a call during the pass prevents the kill; a call after the kills sees the release", async () => {
  const { c, a, b } = twoSessions();
  c.advance(60_000);
  c.state.listHook = async () => b.releaser.onToolStart("late", "mcp__unityMCP__x", {});
  await a.releaser.check();
  assert.deepEqual(c.state.killed, [], "b started a call while the pass enumerated");
  assert.equal(b.releaser.getTrack("unityMCP").status, "running");
  b.releaser.onToolEnd("late");
  c.state.listHook = undefined;

  // kills issued, still in progress: the participants are already marked, a call claims the notice
  c.advance(60_000);
  const finishers = [];
  c.state.killHook = (ok) => new Promise((r) => finishers.push(() => r(ok)));
  const pass = a.releaser.check();
  await sleep(0);
  assert.deepEqual(c.state.killed.sort(), [10, 11], "both kills issued in one turn");
  const r = call(b, { id: "during", tool: "mcp__unityMCP__x" });
  assert.match(r.patch.content[1].text, /^\[mcp-idle\] unityMCP は .*この呼び出しで再起動しました/);
  for (const finish of finishers) finish();
  await pass;
  assert.equal(b.releaser.getTrack("unityMCP").respawn, undefined, "not re-armed after the kill finished");
  assert.ok(a.releaser.getTrack("unity").respawn, "a still has its own notice pending");
});

test("registry: the lock is released after a throw; a hung driver is taken over after LOCK_TIMEOUT_MS", async () => {
  const { c, a, b } = twoSessions();
  c.advance(60_000);
  c.state.listHook = async () => {
    throw new Error("boom");
  };
  await a.releaser.check();
  assert.equal(c.registry.lock, undefined);
  assert.match(a.notes.at(-1).message, /プロセス一覧の取得に失敗しました: boom/);
  // a kill that throws synchronously counts as failed: marks undone, warned
  c.state.listHook = undefined;
  c.advance(30_000);
  c.state.killResult = () => false;
  c.state.killHook = () => {
    throw new Error("spawn failed");
  };
  await b.releaser.check();
  assert.equal(c.registry.lock, undefined);
  assert.equal(a.releaser.getTrack("unity").status, "running", "undone: nothing was killed");
  assert.equal(a.releaser.getTrack("unity").respawn, undefined);
  assert.match(a.notes.at(-1).message, /を停止できませんでした/);
  // hung driver
  c.state.killHook = undefined;
  c.advance(30_000);
  let resumeHung;
  c.state.listHook = () => new Promise((r) => (resumeHung = r));
  void a.releaser.check();
  assert.ok(c.registry.lock);
  c.advance(30_000);
  await Promise.race([b.releaser.check(), sleep(0)]);
  assert.equal(c.state.listCalls, 3, "lock held: no second pass");
  c.advance(mod.LOCK_TIMEOUT_MS);
  c.state.listHook = undefined;
  const before = c.state.killed.length;
  await b.releaser.check(); // its kills fail too: the group stays due
  assert.equal(c.state.listCalls, 4, "taken over");
  assert.deepEqual(c.state.killed.slice(before).sort(), [10, 11]);
  assert.equal(c.registry.lock, undefined);
  const afterTakeover = c.state.killed.length;
  c.state.killResult = () => true;
  resumeHung();
  await sleep(10);
  assert.equal(c.state.killed.length, afterTakeover, "the resumed stale pass does not act on its old list");
  assert.equal(a.releaser.getTrack("unity").status, "running");
});

test("registry: N sessions → one enumeration per interval", async () => {
  const c = cluster([proc(10, "uvx m"), proc(11, "uvx m"), proc(12, "uvx m")]);
  const xs = [0, 1, 2].map((i) => c.make({ servers: [S(`m${i}`, "uvx", ["m"])], hasUI: i === 0 }));
  c.state.killResult = () => false; // kills fail → still due on every tick
  c.advance(60_000);
  await Promise.all(xs.map((x) => x.releaser.check()));
  assert.equal(c.state.listCalls, 1);
  assert.equal(c.state.killed.length, 3);
  await Promise.all(xs.map((x) => x.releaser.check()));
  assert.equal(c.state.listCalls, 1, "throttled");
  c.advance(26_000);
  await Promise.all(xs.map((x) => x.releaser.check()));
  assert.equal(c.state.listCalls, 1, "< 90 % of the 30 s interval");
  c.advance(2_000);
  await Promise.all(xs.map((x) => x.releaser.check()));
  assert.equal(c.state.listCalls, 2);
  assert.equal(xs[0].notes.filter((n) => /停止できませんでした/.test(n.message)).length, 1, "warned once");
  assert.equal(xs[1].releaser.getTrack("m1").status, "running", "failed kills undone");
});

test("registry: manual release refuses while any session uses it, then kills every copy", async () => {
  const { c, a, b } = twoSessions();
  b.releaser.onToolStart("s", "mcp__unityMCP__x", {});
  assert.equal(await a.releaser.releaseNow("unity"), 'MCP "unity" はサブエージェントのセッション（1 件）が使用中のため停止しません');
  b.releaser.onToolEnd("s");
  a.releaser.onToolStart("o", "codemode", {});
  assert.equal(await a.releaser.releaseNow("unity"), 'MCP "unity" は使用中のため停止しません');
  a.releaser.onToolEnd("o");
  const { rows } = await a.releaser.status(true);
  assert.match(formatStatus(rows, "h"), /unity\s+running\s+0s\s+1m\s+10,11\s+0 MB \(2 procs\)\s+2\/2/);
  assert.equal(await a.releaser.releaseNow("unity"), "");
  assert.deepEqual(c.state.killed.sort(), [10, 11]);
  assert.match(a.notes.at(-1).message, /MCP "unity" を停止しました（次回呼び出しで自動再接続）（2 セッション分）/);
  assert.match(call(b, { id: "b", tool: "mcp__unityMCP__x" }).patch.content[1].text, /unityMCP は .* \/mcp-idle release で停止され/);
  assert.match(await a.releaser.releaseNow("unity"), /起動していません/);
  // a foreign copy: refused with the counts
  c.state.procs = [proc(20, "uvx unity-mcp"), proc(21, "uvx unity-mcp")];
  assert.match(await a.releaser.releaseNow("unity"), /一致するプロセスが 2 個ありますが、このプロセス内のセッションが把握しているのは 1 個のため停止しません/);
});

test("extension wiring: instances join the shared registry on session_start and leave on shutdown; stale ctx pruned", { timeout: 30_000 }, async () => {
  const registry = mod.sharedRegistry();
  assert.equal(globalThis[Symbol.for("mcp-idle-release.registry.v1")], registry);
  const base = registry.instances.size;
  const instance = (servers = []) => {
    const handlers = {};
    mod.default({ on: (event, handler) => (handlers[event] = handler), registerCommand: () => {}, getMcpServers: () => servers, getAllTools: () => [] });
    return handlers;
  };
  let stale = false;
  const ctx = { cwd: tmp, isProjectTrusted: () => false, ui: { notify: () => {} }, hasUI: true, isIdle: () => true };
  const subCtx = {
    cwd: tmp,
    isProjectTrusted: () => false,
    ui: { notify: () => {} },
    hasUI: false,
    isIdle: () => {
      if (stale) throw new Error("This extension ctx is stale");
      return true;
    },
  };
  const main = instance();
  const probe = { name: "graceProbe", config: { command: "uvx", args: ["grace-probe-unique"] }, extensionPath: "x" };
  const sub = instance([probe]);
  await main.session_start({ type: "session_start", reason: "startup" }, ctx);
  await sub.session_start({ type: "session_start", reason: "startup" }, subCtx);
  try {
    assert.equal(registry.instances.size, base + 2);
    const subId = [...registry.instances.values()].at(-1).id;
    stale = true; // disposed without session_shutdown
    mod.collectGroups(registry, process.platform, Date.now());
    assert.equal(registry.instances.has(subId), false, "pruned");
    assert.equal(registry.instances.size, base + 1);
  } finally {
    sub.session_shutdown({ type: "session_shutdown" }, subCtx);
    main.session_shutdown({ type: "session_shutdown" }, ctx);
  }
  assert.equal(registry.instances.size, base);
  const probeKey = mod.identityKey({ name: "graceProbe", command: "uvx", args: ["grace-probe-unique"] }, process.platform);
  assert.equal(typeof registry.unregisteredAt.get(probeKey), "number", "session_shutdown starts the grace for its servers' keys");
  registry.unregisteredAt.delete(probeKey);
});

test("measure: registry walk per timer tick", () => {
  const time = (sessions, perSession) => {
    const c = cluster();
    const xs = Array.from({ length: sessions }, (_, i) =>
      c.make({ servers: Array.from({ length: perSession }, (_, k) => S(`s${k}`, "uvx", [`srv${k}`])), hasUI: i === 0 }),
    );
    // recently used everywhere: the walk runs on every tick but nothing is due (no enumeration)
    const N = 20_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      c.advance(1);
      void xs[i % sessions].releaser.check();
    }
    assert.equal(c.state.listCalls, 0);
    return ((performance.now() - t0) * 1000) / N;
  };
  time(3, 4);
  const small = time(3, 4);
  const big = time(10, 8);
  console.log(
    `# [measure] registry walk per tick (nothing due): 3 sessions × 4 servers ${small.toFixed(2)} µs, 10 × 8 ${big.toFixed(2)} µs ` +
      "(fake getServers; the real one re-reads mcp.json at most once per second per session)",
  );
  assert.ok(small < 1000 && big < 5000);
});
