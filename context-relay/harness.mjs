// Shared harness for E2E tests that run a REAL in-process Pi session (installed @earendil-works/pi-coding-agent)
// with a faux model provider. (session.test.mjs keeps its own copy of the same pattern.)
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pcaRoot = path.join(
  process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
  "Volta/tools/image/packages/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-coding-agent",
);
const indexPath = path.join(pcaRoot, "dist/index.js");
const piAiPath = path.join(pcaRoot, "node_modules/@earendil-works/pi-ai/dist/index.js");
export const havePi = existsSync(indexPath) && existsSync(piAiPath);
export const skip = !havePi && "installed Pi not found";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: pathToFileURL(indexPath).href, shortCircuit: true };
    return next(specifier, context);
  },
});

export const tmp = mkdtempSync(path.join(tmpdir(), "context-relay-auto-"));
export const agentDir = path.join(tmp, "agent");
export const cwd = path.join(tmp, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};
export let pi;
export let ai;
export let relayExt;
const sessions = [];

export async function load() {
  if (!havePi) return;
  pi = await import(pathToFileURL(indexPath).href);
  ai = await import(pathToFileURL(piAiPath).href);
  relayExt = await import("./index.ts");
}

export async function cleanup() {
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
}

/** Write ~/.pi/agent/context-relay.json (read by the extension on session_start). */
export function writeConfig(config) {
  writeFileSync(path.join(agentDir, "context-relay.json"), JSON.stringify(config));
}

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
export function dumpTool(piApi) {
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

/**
 * @param {{ hasUI?: boolean, name?: string, mode?: string, relay?: Function, extra?: Function[], promptCache?: {short?: number, long?: number} }} opts
 *   relay = extension factory under test (default: relayExt.default); extra = factories registered BEFORE it.
 */
export async function makeSession({ hasUI = true, name, mode = "tui", relay, extra = [], promptCache } = {}) {
  const notes = [];
  const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  const model = faux.getModel();
  if (promptCache) model.promptCache = promptCache;
  const modelRuntime = await pi.ModelRuntime.create({ authPath: path.join(tmp, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [dumpTool, ...extra, relay ?? relayExt.default] });
  await resourceLoader.reload();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, enabled: false } });
  const { session } = await pi.createAgentSession({ cwd, agentDir, modelRuntime, model, resourceLoader, settingsManager, sessionManager: pi.SessionManager.inMemory() });
  if (name) session.setSessionName(name);
  await session.bindExtensions(hasUI ? { uiContext: uiContext(notes), mode } : {}); // no UI = pi-subagents child: mode stays "print"
  sessions.push(session);
  return { session, faux, notes };
}

export const text = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.text ?? (b.type === "toolCall" ? `<call ${b.name} ${JSON.stringify(b.arguments)}>` : "")).join("\n"));

export async function waitFor(cond, what, ms = 10_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}
