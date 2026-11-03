// End-to-end test of the shared registry: TWO real Pi sessions in one process (as npm:@tintinweb/pi-subagents
// runs its child sessions), each with the built-in codemode + MCP extensions and this extension, both
// configured with the same stdio server. Each session spawns its own copy of the server; the idle release
// must wait until BOTH sessions are idle, kill both copies, and give each session its own respawn notice.
// The second session is bound without a UI, like a subagent session.
// Run: node --test mcp-idle-release.shared.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const pcaRoot = path.join(
  process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
  "Volta/tools/image/packages/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-coding-agent",
);
const indexPath = path.join(pcaRoot, "dist/index.js");
const piAiPath = path.join(pcaRoot, "node_modules/@earendil-works/pi-ai/dist/index.js");
const havePi = existsSync(indexPath) && existsSync(piAiPath);
const skip = !havePi && "installed Pi not found";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: pathToFileURL(indexPath).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const tmp = mkdtempSync(path.join(tmpdir(), "mcp-idle-shared-"));
const agentDir = path.join(tmp, "agent");
const cwd = path.join(tmp, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const fixture = path.join(tmp, "server.mjs");
writeFileSync(
  fixture,
  `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const tools = ["echo", "slow"].map((name) => ({ name, description: name,
  inputSchema: { type: "object", properties: { text: { type: "string" }, ms: { type: "number" } } } }));
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  if (m.method === "tools/call") {
    const reply = () => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: process.pid + ":" + (m.params.arguments?.text ?? "") }] } });
    if (m.params.name === "slow") return setTimeout(reply, m.params.arguments?.ms ?? 1000);
    return reply();
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
}).on("close", () => process.exit(0));
`,
);
writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: process.execPath, args: [fixture, "S"] } } }));
const IDLE_MS = 3_000;
writeFileSync(
  path.join(agentDir, "mcp-idle-release.json"),
  JSON.stringify({ idleMinutes: IDLE_MS / 60_000, checkIntervalSeconds: 5, servers: { shared: { respawnNote: "NOTE: redo setup" } } }),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ai;
let ext;
let faux;
const sessions = {};
const notes = [];

async function createSession(pi, modelRuntime, withUI) {
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    // Fresh factories per session, as pi-subagents does (MCP state lives in the factory's closure).
    extensionFactories: [pi.createCodemodeExtension({ mode: "on" }), pi.createMcpExtension(), ext.default],
  });
  await resourceLoader.reload();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  settingsManager.applyOverrides({ defaultTools: ["+codemode"] });
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    settingsManager,
    sessionManager: pi.SessionManager.inMemory(),
  });
  const noop = () => {};
  // The subagent session binds no UI (pi-subagents: bindExtensions({ onError })), so ctx.hasUI is false.
  await session.bindExtensions(
    withUI
      ? {
          uiContext: {
            select: async () => undefined,
            confirm: async () => false,
            input: async () => undefined,
            notify: (message, level) => notes.push({ message, level }),
            onTerminalInput: () => noop,
            setStatus: noop,
            setWorkingMessage: noop,
            setWorkingVisible: noop,
            setWorkingIndicator: noop,
            setHiddenThinkingLabel: noop,
            setWidget: noop,
            setFooter: noop,
            setHeader: noop,
            setTitle: noop,
            custom: async () => undefined,
            pasteToEditor: noop,
            setEditorText: noop,
            getEditorText: () => "",
            editor: async () => undefined,
            addAutocompleteProvider: noop,
            setEditorComponent: noop,
            getEditorComponent: () => undefined,
            theme: undefined,
            getAllThemes: () => [],
            getTheme: () => undefined,
            setTheme: () => ({ success: false, error: "UI not available" }),
            getToolsExpanded: () => false,
            setToolsExpanded: noop,
          },
        }
      : {},
  );
  const start = Date.now();
  while (!session.getAllTools().some((tool) => tool.name === "mcp__shared__echo")) {
    if (Date.now() - start > 20_000) throw new Error("MCP server did not connect");
    await sleep(50);
  }
  return session;
}

before(async () => {
  if (!havePi) return;
  const pi = await import(pathToFileURL(indexPath).href);
  ai = await import(pathToFileURL(piAiPath).href);
  ext = await import("./mcp-idle-release.ts");
  faux = ai.fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  const modelRuntime = await pi.ModelRuntime.create({ authPath: path.join(tmp, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  sessions.main = await createSession(pi, modelRuntime, true);
  sessions.sub = await createSession(pi, modelRuntime, false);
});

after(async () => {
  try {
    for (const session of Object.values(sessions)) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    await sleep(200);
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** One model turn of `session` that runs `code` in codemode; returns the codemode result text. */
async function runScript(session, code) {
  const before = session.agent.state.messages.length;
  faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code }), { stopReason: "toolUse" }), ai.fauxAssistantMessage("done")]);
  await session.prompt("run the script");
  const results = session.agent.state.messages.slice(before).filter((m) => m.role === "toolResult");
  assert.equal(results.length, 1, "one codemode result");
  return results[0].content.map((block) => block.text ?? "").join("\n");
}

const pidOf = (out, tag) => Number(new RegExp(`(\\d+):${tag}`).exec(out)?.[1]);
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const server = () => ({ name: "shared", command: process.execPath, args: [fixture, "S"] });

test("two sessions in one process: released only when both are idle, both copies killed, each session notified", { skip, timeout: 90_000 }, async () => {
  const registry = ext.sharedRegistry();
  assert.equal(registry.instances.size, 2, "both sessions joined the shared registry");

  // Each session runs its own copy of the server.
  const mainPid = pidOf(await runScript(sessions.main, `return (await tools.mcp__shared__echo({ text: "m" })).content[0].text;`), "m");
  const subPid = pidOf(await runScript(sessions.sub, `return (await tools.mcp__shared__echo({ text: "s" })).content[0].text;`), "s");
  assert.ok(mainPid > 0 && subPid > 0);
  assert.notEqual(mainPid, subPid, "one copy per session");
  const copies = ext.assignProcesses(await ext.listChildProcesses(process.pid), [server()]).get("shared");
  assert.deepEqual(copies.map((p) => p.pid).sort(), [mainPid, subPid].sort(), "both are children of this process");

  // The subagent works for a while (one long call); the main session is idle far beyond the threshold
  // and its timer ticks meanwhile: nothing may be killed.
  const busyFor = 9_000;
  const t0 = Date.now();
  const slow = await runScript(sessions.sub, `return (await tools.mcp__shared__slow({ text: "z", ms: ${busyFor} })).content[0].text;`);
  assert.ok(Date.now() - t0 >= busyFor - 100);
  assert.equal(pidOf(slow, "z"), subPid, "the subagent's copy served the long call");
  assert.ok(isAlive(mainPid) && isAlive(subPid), "nothing killed while the subagent was busy");
  assert.equal(notes.filter((n) => /停止しました/.test(n.message)).length, 0);

  // Both idle now: the next pass kills both copies.
  const released = Date.now();
  while (isAlive(mainPid) || isAlive(subPid)) {
    if (Date.now() - released > 20_000) throw new Error(`not released: main ${isAlive(mainPid)}, sub ${isAlive(subPid)}`);
    await sleep(100);
  }
  const waited = Date.now() - released;
  console.log(`# [measure] both copies gone ${waited} ms after the subagent's last call (threshold ${IDLE_MS} ms, check every 5 s)`);
  assert.ok(waited >= IDLE_MS - 500, "not before the threshold");
  await sleep(300);
  const uiLines = notes.filter((n) => /停止しました/.test(n.message)).map((n) => n.message);
  assert.deepEqual(uiLines, ['MCP "shared" をアイドルのため停止しました（次回呼び出しで自動再接続）（2 セッション分）'], "one UI line, from the main session");

  // Each session's next call respawns its own copy and carries its own notice.
  const outMain = await runScript(sessions.main, `return (await tools.mcp__shared__echo({ text: "m2" })).content[0].text;`);
  const outSub = await runScript(sessions.sub, `return (await tools.mcp__shared__echo({ text: "s2" })).content[0].text;`);
  console.log(`# [seen by the main session's AI]\n# ${outMain.split("\n").join("\n# ")}`);
  console.log(`# [seen by the subagent's AI]\n# ${outSub.split("\n").join("\n# ")}`);
  for (const out of [outMain, outSub]) {
    assert.match(out, /\[mcp-idle\] shared は \d\d:\d\d にアイドル停止され、この呼び出しで再起動しました（再起動を含むこの呼び出しの所要 \d+\.\d 秒）。/);
    assert.match(out, /NOTE: redo setup/);
  }
  const newMain = pidOf(outMain, "m2");
  const newSub = pidOf(outSub, "s2");
  assert.ok(![mainPid, subPid].includes(newMain) && ![mainPid, subPid].includes(newSub), "respawned");
  assert.notEqual(newMain, newSub, "again one copy per session");
  // Only once per session.
  const again = await runScript(sessions.sub, `return (await tools.mcp__shared__echo({ text: "s3" })).content[0].text;`);
  assert.doesNotMatch(again, /\[mcp-idle\]/);

  // Status of the main session lists both sessions.
  const count = notes.length;
  await sessions.main.prompt("/mcp-idle");
  const status = notes.slice(count).map((n) => n.message).join("\n");
  console.log(`# [status]\n# ${status.split("\n").join("\n# ")}`);
  assert.match(status, /2 sessions in this process/);
  assert.match(status, /shared\s+running\s.*\s2\/2$/m);

  // A session shutdown leaves the registry.
  await sessions.sub.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  sessions.sub.dispose();
  delete sessions.sub;
  assert.equal(registry.instances.size, 1);
});
