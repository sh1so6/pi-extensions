// End-to-end test of mcp-idle-release.ts inside a REAL Pi session (installed @earendil-works/pi-coding-agent):
// faux model provider, the built-in codemode + MCP extensions, real stdio MCP server processes, and this
// extension loaded as an extension factory. The model issues `codemode` calls whose scripts call MCP tools,
// so the nested-call path (AgentSession._executeNestedToolCall → runToolCall → tool_call/tool_result hooks →
// codemode toScriptValue) is exercised exactly as in the CLI.
// Run: node --test mcp-idle-release.session.test.mjs
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

// The extension imports the package by name; point it at the installed Pi (no node_modules here).
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: pathToFileURL(indexPath).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const tmp = mkdtempSync(path.join(tmpdir(), "mcp-idle-session-"));
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
let state = "unset";
const tools = ["echo", "setup"].map((name) => ({ name, description: name,
  inputSchema: { type: "object", properties: { text: { type: "string" } } } }));
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  if (m.method === "tools/call") {
    if (m.params.name === "setup" && m.params.arguments?.text === "fail") {
      // unityMCP-style app-level failure: isError false, success false
      const payload = { success: false, error: "Instance not found" };
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload } });
    }
    if (m.params.name === "setup") state = m.params.arguments?.text ?? "set";
    const text = process.pid + ":" + state + ":" + (m.params.arguments?.text ?? "");
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], structuredContent: { pid: process.pid, state } } });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
}).on("close", () => process.exit(0));
`,
);
writeFileSync(
  path.join(agentDir, "mcp.json"),
  JSON.stringify({
    mcpServers: {
      echoA: { command: process.execPath, args: [fixture, "A"] },
      echoB: { command: process.execPath, args: [fixture, "B"] },
    },
  }),
);
writeFileSync(
  path.join(agentDir, "mcp-idle-release.json"),
  JSON.stringify({
    idleMinutes: 0, // released only through /mcp-idle release in this test
    servers: {
      echoA: { respawnNote: "NOTE-A: redo setup" },
      echoB: { respawnPolicy: "block", passThrough: ["setup"], respawnNote: "NOTE-B: call setup first" },
    },
  }),
);

let session;
let faux;
let ai;
const notes = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!havePi) return;
  const pi = await import(pathToFileURL(indexPath).href);
  ai = await import(pathToFileURL(piAiPath).href);
  const ext = await import("./index.ts");
  faux = ai.fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: path.join(tmp, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    extensionFactories: [pi.createCodemodeExtension({ mode: "on" }), pi.createMcpExtension(), ext.default],
  });
  await resourceLoader.reload();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  settingsManager.applyOverrides({ defaultTools: ["+codemode"] });
  ({ session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    settingsManager,
    sessionManager: pi.SessionManager.inMemory(),
  }));
  const noop = () => {};
  await session.bindExtensions({
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
  });
  const start = Date.now();
  const names = () => session.getAllTools().map((tool) => tool.name);
  while (!(names().includes("mcp__echoA__echo") && names().includes("mcp__echoB__setup"))) {
    if (Date.now() - start > 20_000) throw new Error(`MCP servers did not connect: ${names().join(", ")}`);
    await sleep(50);
  }
});

after(async () => {
  try {
    // What the CLI does on exit: session_shutdown closes the MCP connections (and our timer).
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
  } finally {
    await sleep(200);
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** Run one model turn that calls codemode with `code`; return the codemode result text. */
async function runScript(code) {
  const before = session.agent.state.messages.length;
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("done"),
  ]);
  await session.prompt("run the script");
  const results = session.agent.state.messages.slice(before).filter((m) => m.role === "toolResult");
  assert.equal(results.length, 1, "one codemode result");
  return results[0].content.map((block) => block.text ?? "").join("\n");
}

async function release(server) {
  const count = notes.length;
  await session.prompt(`/mcp-idle release ${server}`);
  const fresh = notes.slice(count).map((n) => n.message);
  assert.ok(fresh.some((m) => m.includes(`MCP "${server}" を停止しました`)), fresh.join("\n"));
  await sleep(300); // Pi notices the closed pipe and marks the connection disconnected
}

const clock = /\d\d:\d\d/;

test("notify: the script's CallToolResult keeps its content; notice in _meta and in the codemode result", { skip, timeout: 60_000 }, async () => {
  const warm = await runScript(`const r = await tools.mcp__echoA__echo({ text: "warm" }); return r.content[0].text;`);
  const pid1 = Number(/(\d+):unset:warm/.exec(warm)?.[1]);
  assert.ok(pid1 > 0, warm);
  assert.doesNotMatch(warm, /\[mcp-idle\]/, "no notice before any release");

  await release("echoA");
  // The script only returns content[0].text: the AI must still learn about the respawn.
  const out = await runScript(
    `const r = await tools.mcp__echoA__echo({ text: "hi" });
     return JSON.stringify({ first: r.content[0].text, blocks: r.content.length, keys: Object.keys(r).sort(), sc: r.structuredContent });`,
  );
  const value = JSON.parse(/\{"first".*\}/.exec(out)[0]);
  const pid2 = Number(value.first.split(":")[0]);
  assert.notEqual(pid2, pid1, "respawned");
  assert.equal(value.first, `${pid2}:unset:hi`, "state was reset, content untouched");
  assert.equal(value.blocks, 1, "no block appended to the CallToolResult content");
  assert.deepEqual(value.keys, ["_meta", "content", "structuredContent"]);
  assert.deepEqual(value.sc, { pid: pid2, state: "unset" }, "server structuredContent preserved");
  console.log(`# [seen by the AI, notify]\n# ${out.split("\n").join("\n# ")}`);
  const notice = out.split("\n").find((line) => line.startsWith("[mcp-idle] echoA"));
  assert.ok(notice, `notice appended to the codemode result:\n${out}`);
  assert.match(notice, new RegExp(`^\\[mcp-idle\\] echoA は ${clock.source} に /mcp-idle release で停止され、この呼び出しで再起動しました（再起動を含むこの呼び出しの所要 \\d+\\.\\d 秒）。メモリ上の状態は初期化されています。$`));
  assert.match(out, /NOTE-A: redo setup/);

  // Only the first call after a release carries it.
  const again = await runScript(`const r = await tools.mcp__echoA__echo({ text: "x" }); return JSON.stringify(r._meta ?? null);`);
  assert.doesNotMatch(again, /\[mcp-idle\]/);
  assert.match(again, /null/);

  // A script that prints the _meta notice itself: the codemode result shows it once (no duplicate).
  await release("echoA");
  const shown = await runScript(`const r = await tools.mcp__echoA__echo({ text: "m" }); return r._meta.mcpIdleRelease.notice;`);
  assert.equal(shown.split("\n").filter((line) => line.startsWith("[mcp-idle] echoA")).length, 1, shown);
  assert.match(shown, /NOTE-A/);
});

test("block: the first call is refused (script sees a rejection), not spawned; the retry respawns with a notice", { skip, timeout: 60_000 }, async () => {
  await runScript(`return (await tools.mcp__echoB__echo({ text: "warm" })).content[0].text;`);
  await release("echoB");
  const ext = await import("./index.ts");

  // The script swallows the rejection: the AI still gets the reason through the codemode result.
  const blocked = await runScript(
    `let err = "none"; try { await tools.mcp__echoB__echo({ text: "x" }); } catch (e) { err = e.message; }
     return err.startsWith("[mcp-idle]") ? "REJECTED" : "NOT-REJECTED:" + err;`,
  );
  console.log(`# [seen by the AI, block]\n# ${blocked.split("\n").join("\n# ")}`);
  assert.match(blocked, /REJECTED/);
  assert.doesNotMatch(blocked, /NOT-REJECTED/);
  assert.match(blocked, /\[mcp-idle\] echoB は \d\d:\d\d に \/mcp-idle release で停止されたため、この呼び出し（echo）は実行していません。/);
  assert.match(blocked, /NOTE-B: call setup first/);
  assert.match(blocked, /必要な状態を再設定してから、この呼び出しをやり直してください。/);
  // The refused call did not respawn the server.
  const procs = await ext.listChildProcesses(process.pid);
  const servers = [{ name: "echoB", command: process.execPath, args: [fixture, "B"] }];
  assert.deepEqual(ext.assignProcesses(procs, servers).get("echoB"), [], "echoB still stopped");

  // Blocked only once: the next call runs (respawns) and gets the notify-style notice.
  const retry = await runScript(`const r = await tools.mcp__echoB__echo({ text: "y" }); return r.content[0].text;`);
  assert.match(retry, /\d+:unset:y/);
  assert.match(retry, /\[mcp-idle\] echoB は \d\d:\d\d に \/mcp-idle release で停止され、この呼び出しで再起動しました/);
  assert.doesNotMatch(retry, /実行していません/);
});

test("block + passThrough: setup runs (and gets the notice); then the other tools are not blocked", { skip, timeout: 60_000 }, async () => {
  await release("echoB");
  const out = await runScript(
    `const s = await tools.mcp__echoB__setup({ text: "main" });
     const r = await tools.mcp__echoB__echo({ text: "z" });
     return JSON.stringify({ setupNotice: s._meta?.mcpIdleRelease?.notice ?? null, echo: r.content[0].text, echoMeta: r._meta ?? null });`,
  );
  const value = JSON.parse(/\{"setupNotice".*\}/.exec(out)[0]);
  assert.match(value.setupNotice, /^\[mcp-idle\] echoB は .*この呼び出しで再起動しました/);
  assert.match(value.echo, /^\d+:main:z$/, "echo ran on the respawned server after setup");
  assert.equal(value.echoMeta, null);
  assert.doesNotMatch(out, /実行していません/);
});

/** Lines of the codemode result that are an appended notice (the script output is JSON on its own lines). */
const appended = (out, prefix) => out.split("\n").filter((line) => line.startsWith(prefix));

test("root result: the notice is appended even when the script JSON-stringifies or swallows it", { skip, timeout: 60_000 }, async () => {
  // notify: the script returns the whole CallToolResult JSON-stringified (notice escaped inside)
  await release("echoA");
  const json = await runScript(`return JSON.stringify(await tools.mcp__echoA__echo({ text: "j" }));`);
  console.log(`# [seen by the AI, JSON-stringified]\n# ${json.split("\n").join("\n# ")}`);
  assert.match(json, /\\nNOTE-A: redo setup/, "the script's escaped copy is there");
  assert.equal(appended(json, "[mcp-idle] echoA").length, 0, "every line is visible escaped: nothing appended\n" + json);
  // cut short: the heading comes along, and the line that is not visible too
  await release("echoA");
  const cut = await runScript(`return JSON.stringify(await tools.mcp__echoA__echo({ text: "c" })).slice(0, 60);`);
  assert.equal(appended(cut, "[mcp-idle] echoA").length, 1, cut);
  assert.ok(cut.split("\n").includes("NOTE-A: redo setup"), "own block, unescaped");

  // notify: the script ignores the result and returns 42
  await release("echoA");
  const swallowed = await runScript(`await tools.mcp__echoA__echo({ text: "s" }); return 42;`);
  assert.match(swallowed, /42/);
  assert.equal(appended(swallowed, "[mcp-idle] echoA").length, 1, swallowed);

  // block: the script cuts the rejection short (`.slice(0, 60)`): heading and the lines that are not visible come along
  await release("echoB");
  const cutBlock = await runScript(
    `const out = {}; try { await tools.mcp__echoB__echo({ text: "x" }); } catch (e) { out.err = e.message.slice(0, 60); } return JSON.stringify(out);`,
  );
  assert.equal(appended(cutBlock, "[mcp-idle] echoB").length, 1, cutBlock);
  assert.ok(cutBlock.split("\n").includes("NOTE-B: call setup first"));
  await runScript(`return (await tools.mcp__echoB__echo({ text: "y" })).content[0].text;`); // retry clears it
  // block: the script JSON-stringifies the rejection (as in the field report)
  await release("echoB");
  const blocked = await runScript(
    `const out = {}; try { await tools.mcp__echoB__echo({ text: "x" }); } catch (e) { out.err = e.message; } return JSON.stringify(out);`,
  );
  assert.match(blocked, /\{"err":"\[mcp-idle\] echoB/, "the script printed the escaped reason");
  assert.equal(appended(blocked, "[mcp-idle] echoB").length, 0, "reason fully visible escaped: nothing appended\n" + blocked);
  await runScript(`return (await tools.mcp__echoB__echo({ text: "y" })).content[0].text;`); // retry clears it
});

test("block + passThrough failing at app level (success:false): block re-armed until setup succeeds", { skip, timeout: 60_000 }, async () => {
  await release("echoB");
  const out = await runScript(
    `const res = {};
     const s1 = await tools.mcp__echoB__setup({ text: "fail" });
     res.s1 = { success: s1.structuredContent.success, notice: s1._meta?.mcpIdleRelease?.notice ?? null };
     try { await tools.mcp__echoB__echo({ text: "q" }); res.e1 = "ran"; } catch (e) { res.e1 = e.message; }
     const s2 = await tools.mcp__echoB__setup({ text: "main" });
     res.s2 = s2._meta ?? null;
     res.e2 = (await tools.mcp__echoB__echo({ text: "z" })).content[0].text;
     return JSON.stringify(res);`,
  );
  console.log(`# [seen by the AI, passThrough failed]\n# ${out.split("\n").join("\n# ")}`);
  const value = JSON.parse(/\{"s1".*\}/.exec(out)[0]);
  assert.equal(value.s1.success, false);
  assert.match(value.s1.notice, /^\[mcp-idle\] echoB は .*この呼び出しで再起動しました/);
  assert.match(value.s1.notice, /\[mcp-idle\] この setup は失敗しました/);
  assert.match(value.e1, /^\[mcp-idle\] echoB は .*再起動済みですが、直前の setup が失敗したため状態の再設定がまだ成功していません。この呼び出し（echo）は実行していません。/);
  assert.equal(value.s2, null, "successful setup: no second respawn notice");
  assert.match(value.e2, /^\d+:main:z$/, "echo ran after the successful setup");
  // the script printed all of it (JSON-escaped): nothing is appended again
  assert.equal(appended(out, "[mcp-idle] ").length, 0, out);
});

test("status: /mcp-idle shows the whole process tree's memory", { skip, timeout: 60_000 }, async () => {
  const count = notes.length;
  await session.prompt("/mcp-idle");
  const status = notes.slice(count).map((n) => n.message).join("\n");
  assert.match(status, /echoA\s+running\s/);
  assert.match(status, /echoA\s.*\d+ MB/);
  console.log(`# [status]\n# ${status.split("\n").join("\n# ")}`);
});

test("unexpected exit: a server killed from outside is reported on the next call (notify / block), also from a script", { skip, timeout: 90_000 }, async () => {
  const ext = await import("./index.ts");
  const rootOf = async (name) => {
    const procs = await ext.listChildProcesses(process.pid);
    const server = { name, command: process.execPath, args: [fixture, name.slice(-1)] };
    return ext.assignProcesses(procs, [server]).get(name) ?? [];
  };
  // both servers up, no notice pending (earlier tests may have left one: setup is passThrough, so it runs)
  await runScript(`await tools.mcp__echoA__echo({ text: "w" }); await tools.mcp__echoB__setup({ text: "w" }); return (await tools.mcp__echoB__echo({ text: "w" })).content[0].text;`);
  const count = notes.length;
  await session.prompt("/mcp-idle"); // the status listing also learns the server pids
  const before = { A: await rootOf("echoA"), B: await rootOf("echoB") };
  assert.equal(before.A.length, 1);
  assert.equal(before.B.length, 1);
  assert.deepEqual(notes.slice(count).filter((n) => /予期せず終了/.test(n.message)), [], "nothing before the kill");

  // killed from outside (a crash): taskkill of the whole tree, like the extension's own release but not issued by it
  assert.equal(await ext.killProcessTree(before.A[0].pid), true);
  assert.equal(await ext.killProcessTree(before.B[0].pid), true);
  await sleep(400); // Pi notices the closed pipe: "disconnected, reconnects on next call"

  // notify policy, from a script: the pid check on the tool_call finds it; the AI is told
  const a = await runScript(`const r = await tools.mcp__echoA__echo({ text: "x" }); return r.content[0].text;`);
  console.log(`# [seen by the AI, unexpected exit, notify]\n# ${a.split("\n").join("\n# ")}`);
  const pidA = Number(/(\d+):unset:x/.exec(a)?.[1]);
  assert.ok(pidA > 0 && pidA !== before.A[0].pid, "respawned by Pi on that call: " + a);
  assert.match(a, /\[mcp-idle\] echoA は \d\d:\d\d までに予期せず終了し、この呼び出しで再起動しました（再起動を含むこの呼び出しの所要 \d+\.\d 秒）。メモリ上の状態は初期化されています。原因は/);
  assert.doesNotMatch(a, /アイドル停止/);
  assert.match(a, /NOTE-A: redo setup/);
  assert.ok(notes.slice(count).some((n) => n.level === "warning" && n.message.includes('MCP "echoA" が予期せず終了しました')), "UI line for the user");

  // block policy: the first call is refused (and does not respawn), the retry runs and carries the notice
  const b = await runScript(
    `let err = "none"; try { await tools.mcp__echoB__echo({ text: "x" }); } catch (e) { err = e.message; }
     return err.startsWith("[mcp-idle]") ? "REJECTED" : "NOT-REJECTED:" + err;`,
  );
  console.log(`# [seen by the AI, unexpected exit, block]\n# ${b.split("\n").join("\n# ")}`);
  assert.match(b, /REJECTED/);
  assert.match(b, /\[mcp-idle\] echoB は \d\d:\d\d までに予期せず終了したため、この呼び出し（echo）は実行していません。/);
  assert.match(b, /NOTE-B: call setup first/);
  assert.deepEqual(await rootOf("echoB"), [], "the refused call did not respawn it");
  const retry = await runScript(`const r = await tools.mcp__echoB__echo({ text: "y" }); return r.content[0].text;`);
  assert.match(retry, /\d+:unset:y/);
  assert.match(retry, /\[mcp-idle\] echoB は \d\d:\d\d までに予期せず終了し、この呼び出しで再起動しました/);
  assert.doesNotMatch(retry, /実行していません/);
  // and the extension's own release afterwards is still recognised as its own (idle wording, no exit)
  await session.prompt("/mcp-idle");
  await release("echoA");
  const own = await runScript(`return (await tools.mcp__echoA__echo({ text: "z" })).content[0].text;`);
  assert.match(own, /\/mcp-idle release で停止され、この呼び出しで再起動しました/);
  assert.doesNotMatch(own, /予期せず終了/);
});
