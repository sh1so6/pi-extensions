// End-to-end test of context-relay inside a REAL Pi session (installed @earendil-works/pi-coding-agent) with a faux
// model provider. After /relay, the NEXT provider request is inspected at payload level (what the faux provider
// really receives): system prompt + hand-off note + the latest exchange + the new user message. `recall` is then
// called by the (scripted) model and must retrieve text from before the boundary.
// Run: node --test context-relay/session.test.mjs   (from E:\Dev\TS\Pi)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    if (specifier === "@earendil-works/pi-coding-agent") return { url: pathToFileURL(indexPath).href, shortCircuit: true };
    return next(specifier, context);
  },
});

const tmp = mkdtempSync(path.join(tmpdir(), "context-relay-session-"));
const agentDir = path.join(tmp, "agent");
const cwd = path.join(tmp, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const noop = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pi;
let ai;
let relayExt;
const sessions = [];

const uiContext = (notes) => ({
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
});

/** A tool that returns bulky output, like bash/read do in real sessions. */
function dumpTool(piApi) {
  piApi.registerTool({
    name: "dump",
    label: "Dump",
    description: "Return bulky output for a tag",
    parameters: { type: "object", properties: { tag: { type: "string" } } },
    async execute(_id, params) {
      return { content: [{ type: "text", text: `DUMP[${params.tag}] ${"lorem ipsum ".repeat(300)} MARKER-${String(params.tag).toUpperCase()}-4471 tail` }], details: {} };
    },
  });
}

async function makeSession({ hasUI = true, name, mode = "tui" } = {}) {
  const notes = [];
  const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  const modelRuntime = await pi.ModelRuntime.create({ authPath: path.join(tmp, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [dumpTool, relayExt.default] });
  await resourceLoader.reload();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, enabled: false } });
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    settingsManager,
    sessionManager: pi.SessionManager.inMemory(),
  });
  if (name) session.setSessionName(name);
  await session.bindExtensions(hasUI ? { uiContext: uiContext(notes), mode } : {}); // no UI = pi-subagents child: mode stays "print"
  sessions.push(session);
  return { session, faux, notes };
}

before(async () => {
  if (!havePi) return;
  pi = await import(pathToFileURL(indexPath).href);
  ai = await import(pathToFileURL(piAiPath).href);
  relayExt = await import("./index.ts");
});

after(async () => {
  for (const s of sessions) {
    try {
      await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      s.dispose();
    } catch {
      // ignore
    }
  }
  await sleep(100);
  rmSync(tmp, { recursive: true, force: true });
});

const text = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.text ?? (b.type === "toolCall" ? `<call ${b.name} ${JSON.stringify(b.arguments)}>` : "")).join("\n"));
const reply = (msg) => () => msg;

async function waitFor(cond, what, ms = 10_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}

test("relay: the next provider request = system + hand-off note + latest exchange + new user message; recall reaches pre-boundary text", { skip, timeout: 60_000 }, async () => {
  const { session, faux, notes } = await makeSession();
  const toolNames = session.getAllTools().map((t) => t.name);
  assert.ok(toolNames.includes("recall"), `recall registered in the main session: ${toolNames}`);
  assert.ok(session.getActiveToolNames().includes("recall"), "recall is active");

  // two turns with bulky tool results
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall("dump", { tag: "pier" }), { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Pier inspected: all planks fine."),
    ai.fauxAssistantMessage(ai.fauxToolCall("dump", { tag: "rail" }), { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Railing inspected: needs one post."),
  ]);
  await session.prompt("FIRST-INSTRUCTION: inspect the pier");
  await session.prompt("SECOND-INSTRUCTION: inspect the railing");

  const before = session.sessionManager.getBranch().length;
  await session.prompt("/relay");
  await waitFor(() => notes.some((n) => /context-relay: (done|.*fail|.*busy)/.test(n.message)), "relay result");
  const done = notes.find((n) => n.message.startsWith("context-relay:"));
  assert.match(done.message, /context-relay: done \(\d+ → ~\d+ tokens\)\. Note: .*[\\/]context-relay[\\/].*[\\/]1\.md/, done.message);

  // session state: a relay compaction keeping from the latest user message
  const entries = session.sessionManager.getBranch();
  assert.equal(entries.length, before + 1);
  const compaction = entries.at(-1);
  assert.equal(compaction.type, "compaction");
  assert.equal(compaction.details.relay, true);
  assert.equal(compaction.details.version, 1);
  assert.ok(existsSync(compaction.details.notePath), "note file written under the agent dir");
  assert.ok(compaction.details.notePath.startsWith(agentDir), "note is outside the project cwd");
  assert.equal(readFileSync(compaction.details.notePath, "utf8"), compaction.summary);
  const secondUser = entries.find((e) => e.type === "message" && e.message.role === "user" && text(e.message).includes("SECOND-INSTRUCTION"));
  assert.equal(compaction.firstKeptEntryId, secondUser.id);

  // next request, captured at the provider
  let captured;
  faux.setResponses([
    (context) => {
      captured = JSON.parse(JSON.stringify(context.messages));
      return ai.fauxAssistantMessage(ai.fauxToolCall("recall", { query: "marker-pier" }), { stopReason: "toolUse" });
    },
    (context) => {
      captured2 = JSON.parse(JSON.stringify(context.messages));
      return ai.fauxAssistantMessage("The pier marker is MARKER-PIER-4471.");
    },
  ]);
  let captured2;
  await session.prompt("THIRD-INSTRUCTION: what was the pier marker?");

  const roles = captured.map((m) => m.role);
  console.log(`# request roles: ${roles.join(", ")}`);
  const all = captured.map(text);
  const noteMsg = captured.find((m) => text(m).includes("# Context hand-off #1"));
  assert.ok(noteMsg, `hand-off note is in the payload:\n${all.map((t) => t.slice(0, 80)).join("\n")}`);
  const noteText = text(noteMsg);
  assert.match(noteText, /FIRST-INSTRUCTION: inspect the pier/);
  assert.match(noteText, /Pier inspected: all planks fine\./, "last answer before the kept exchange");
  assert.doesNotMatch(noteText, /SECOND-INSTRUCTION/, "the kept latest user message is not duplicated in the note");
  assert.match(noteText, /`recall`/);
  // old raw output is gone from the payload; the latest exchange is intact
  assert.ok(!all.some((t) => t.includes("MARKER-PIER-4471")), "stale tool output is not sent");
  assert.ok(all.some((t) => t.includes("MARKER-RAIL-4471")), "latest exchange's tool output is kept");
  assert.ok(!all.some((t) => t.includes("FIRST-INSTRUCTION") && t !== noteText), "first user message only appears inside the note");
  // order: system … note → kept user → … → new user
  const idx = (needle) => captured.findIndex((m) => text(m).includes(needle));
  assert.ok(idx("# Context hand-off #1") < idx("SECOND-INSTRUCTION") && idx("SECOND-INSTRUCTION") < idx("MARKER-RAIL-4471") && idx("MARKER-RAIL-4471") < idx("THIRD-INSTRUCTION"));
  assert.equal(captured.at(-1).role, "user");
  assert.match(text(captured.at(-1)), /THIRD-INSTRUCTION/);
  const nonSystem = captured.filter((m) => m.role !== "system");
  // note, user, assistant(call), toolResult, assistant(final), user
  assert.equal(nonSystem.length, 6, nonSystem.map((m) => `${m.role}:${text(m).slice(0, 40)}`).join(" | "));
  assert.ok(captured.some((m) => m.role === "system"), "system prompt still present");

  // recall result as the model saw it in the following request
  const recallResult = captured2.findLast((m) => m.role === "toolResult");
  assert.match(text(recallResult), /toolResult:dump/);
  assert.match(text(recallResult), /MARKER-PIER-4471/);
  const entryId = /^\[([0-9a-f]+)\] toolResult:dump/m.exec(text(recallResult))?.[1];
  assert.ok(entryId, text(recallResult));
  // recall by entryId: the model reads the whole entry
  faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("recall", { entryId }), { stopReason: "toolUse" }), ai.fauxAssistantMessage("read it")]);
  await session.prompt("FOURTH-INSTRUCTION: show me that entry");
  const fetched = session.agent.state.messages.findLast((m) => m.role === "toolResult");
  assert.ok(text(fetched).startsWith(`[${entryId}] message`), text(fetched).slice(0, 100));
  assert.ok(text(fetched).includes("--- toolResult:dump ---\nDUMP[pier]"));
  assert.match(text(fetched), /MARKER-PIER-4471 tail/);
  // text still in the context is not "recalled" (it is already visible)
  faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("recall", { query: "MARKER-RAIL" }), { stopReason: "toolUse" }), ai.fauxAssistantMessage("ok")]);
  await session.prompt("FIFTH-INSTRUCTION");
  assert.match(text(session.agent.state.messages.findLast((m) => m.role === "toolResult")), /no match/);
});

test("subagent / headless sessions: no recall tool, no /relay command, handlers inert", { skip, timeout: 60_000 }, async () => {
  for (const opts of [{ name: "worker#0a1b2c3d", hasUI: false }, { hasUI: false }, { mode: "print" }]) {
    const { session, faux } = await makeSession(opts);
    const names = session.getAllTools().map((t) => t.name);
    assert.ok(!names.includes("recall"), `no recall for ${JSON.stringify(opts)}: ${names}`);
    assert.ok(!session.extensionRunner.getRegisteredCommands().some((c) => c.name === "relay"), "no /relay command");
    faux.setResponses([ai.fauxAssistantMessage("hi"), ai.fauxAssistantMessage("again")]);
    await session.prompt("hello");
    await session.prompt("again");
    // even a compaction carrying our private marker is ignored here: Pi's default summarizer runs (faux model)
    // Pi's default summarizer may issue several requests (history + turn prefix): queue a few
    faux.setResponses([1, 2, 3].map(() => ai.fauxAssistantMessage("DEFAULT-SUMMARY-SUB")));
    const result = await session.compact(relayExt.RELAY_MARKER);
    assert.match(result.summary, /DEFAULT-SUMMARY-SUB/);
    assert.notEqual(result.details?.relay, true);
  }
});

test("main session: a normal compaction (not /relay) is left to Pi's default summarizer", { skip, timeout: 60_000 }, async () => {
  const { session, faux } = await makeSession();
  faux.setResponses([ai.fauxAssistantMessage("a"), ai.fauxAssistantMessage("b")]);
  await session.prompt("one");
  await session.prompt("two");
    // Pi's default summarizer may issue several requests (history + turn prefix): queue a few
    faux.setResponses([1, 2, 3].map(() => ai.fauxAssistantMessage("DEFAULT-SUMMARY-MAIN")));
  const result = await session.compact("focus on x");
  assert.match(result.summary, /DEFAULT-SUMMARY-MAIN/);
  assert.notEqual(result.details?.relay, true);
  const entry = session.sessionManager.getBranch().at(-1);
  assert.equal(entry.type, "compaction");
  assert.ok(!entry.details?.relay);
});
