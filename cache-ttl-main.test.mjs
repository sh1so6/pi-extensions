// Tests for cache-ttl-main.ts. Run: node --test cache-ttl-main.test.mjs  (Node >= 23.6 strips TS types)
// 1) pure unit tests (payload transform, role detection, usage/status helpers, handlers on a stub pi);
// 2) in-process Pi sessions (installed @earendil-works/pi-coding-agent, faux provider declared as
//    api "anthropic-messages"): a main session, a session named like a pi-subagents one and a no-UI
//    session. The faux provider NEVER calls the before_provider_request hook (real providers do via
//    onPayload), so the payload/warmer hooks are driven through the session's real ExtensionRunner
//    (emitBeforeProviderRequest / emitCacheWarmingDecision), after real turns ran with the hooks registered.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const pcaRoot = path.join(
  process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
  "Volta/tools/image/packages/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-coding-agent",
);
const indexPath = path.join(pcaRoot, "dist/index.js");
const piAiPath = path.join(pcaRoot, "node_modules/@earendil-works/pi-ai/dist/index.js");
const havePi = existsSync(indexPath) && existsSync(piAiPath);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: pathToFileURL(indexPath).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const tmp = mkdtempSync(path.join(tmpdir(), "cache-ttl-main-"));
const agentDir = path.join(tmp, "agent");
const cwd = path.join(tmp, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CACHE_RETENTION;
after(() => rmSync(tmp, { recursive: true, force: true }));

const ext = havePi ? await import("./cache-ttl-main.ts") : undefined;
const skip = !havePi && "installed Pi not found";

// ---- realistic anthropic-messages payload (what pi-ai's serializer builds with retention "short") ----
const eph = () => ({ type: "ephemeral" });
function payloadFixture() {
  return {
    model: "claude-opus-4-8",
    max_tokens: 32000,
    stream: true,
    system: [
      { type: "text", text: "You are Claude Code", cache_control: eph() },
      { type: "text", text: "You are an expert coding assistant", cache_control: eph() },
    ],
    tools: [
      { name: "read", description: "Read", input_schema: { type: "object", properties: { cache_control: { type: "string" } } } },
      { name: "bash", description: "Bash", input_schema: { type: "object", properties: {} }, cache_control: eph() },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a b" }], cache_control: eph() },
        ],
      },
      { role: "user", content: "plain string content" },
    ],
  };
}

test("applyOneHourTtl: sets ttl 1h on every existing cache_control and only there", { skip }, () => {
  const input = payloadFixture();
  const snapshot = structuredClone(input);
  const { payload, changed, total } = ext.applyOneHourTtl(input);
  assert.equal(total, 4);
  assert.equal(changed, 4);
  assert.deepEqual(input, snapshot, "input must not be mutated");
  assert.deepEqual(payload.system.map((b) => b.cache_control), [{ type: "ephemeral", ttl: "1h" }, { type: "ephemeral", ttl: "1h" }]);
  assert.equal(payload.tools[1].cache_control.ttl, "1h");
  assert.equal(payload.messages[2].content[0].cache_control.ttl, "1h");
  // nothing was added where pi had none
  assert.equal("cache_control" in payload.tools[0], false);
  assert.equal(payload.tools[0].input_schema.properties.cache_control.type, "string", "schema property untouched");
  assert.equal("cache_control" in payload.messages[0].content[0], false);
  assert.equal(payload.messages[3].content, "plain string content");
  // unchanged parts are shared (copy on write)
  assert.equal(payload.tools[0], input.tools[0]);
  assert.equal(payload.messages[0], input.messages[0]);
  assert.equal(payload.model, input.model);
});

test("applyOneHourTtl: idempotent, overwrites a 5m ttl, handles top-level cache_control", { skip }, () => {
  const once = ext.applyOneHourTtl(payloadFixture()).payload;
  const twice = ext.applyOneHourTtl(once);
  assert.equal(twice.changed, 0);
  assert.equal(twice.total, 4);
  assert.equal(twice.payload, once, "same object when nothing to change");

  const mixed = { cache_control: { type: "ephemeral", ttl: "5m" }, system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] };
  const result = ext.applyOneHourTtl(mixed);
  assert.equal(result.changed, 1);
  assert.equal(result.payload.cache_control.ttl, "1h");
  assert.equal(result.payload.system, mixed.system);
});

test("applyOneHourTtl: no cache_control / odd shapes are passed through", { skip }, () => {
  const bare = { model: "m", system: "just a string", messages: [{ role: "user", content: "x" }, null, 5] };
  const result = ext.applyOneHourTtl(bare);
  assert.equal(result.changed, 0);
  assert.equal(result.total, 0);
  assert.equal(result.payload, bare);
  assert.equal(ext.applyOneHourTtl("str").payload, "str");
  assert.equal(ext.applyOneHourTtl(null).payload, null);
  assert.equal(ext.applyOneHourTtl({ system: [{ cache_control: "weird" }] }).changed, 0);
});

test("detectRole: no UI or #<8 hex> name is a subagent", { skip }, () => {
  assert.equal(ext.detectRole(undefined, true), "main");
  assert.equal(ext.detectRole("my refactor session", true), "main");
  assert.equal(ext.detectRole("worker#a1b2c3d4", true), "subagent");
  assert.equal(ext.detectRole("general-purpose#0123abcd", true), "subagent");
  assert.equal(ext.detectRole("worker#a1b2c3d", true), "main", "7 hex chars is not an agent id");
  assert.equal(ext.detectRole("worker#A1B2C3D4", true), "main", "agent ids are lowercase hex");
  assert.equal(ext.detectRole("worker#a1b2c3d4 tail", true), "main");
  assert.equal(ext.detectRole(undefined, false), "subagent");
});

test("parseSettings / lastAssistantUsage / formatStatus", { skip }, () => {
  assert.deepEqual(ext.parseSettings(undefined), { enabled: true });
  assert.deepEqual(ext.parseSettings({ enabled: false }), { enabled: false });
  assert.deepEqual(ext.parseSettings({ enabled: "no" }), { enabled: true });

  const msg = (usage) => ({ type: "message", message: { role: "assistant", usage } });
  const entries = [
    msg({ cacheWrite: 100, cacheWrite1h: 100, cacheRead: 0 }),
    { type: "message", message: { role: "user" } },
    { type: "usage", usage: { cacheWrite: 5 } },
    msg({ cacheWrite: 0, cacheRead: 100 }),
  ];
  const usage = ext.lastAssistantUsage(entries);
  assert.equal(usage.latest.cacheRead, 100);
  assert.equal(usage.latestWrite.cacheWrite1h, 100);
  assert.equal(ext.lastAssistantUsage([]).latest, undefined);

  const base = { enabled: true, role: "main", skipReason: undefined, modified: 3, payloads: 4, warmStops: 1, usage };
  const ok = ext.formatStatus(base);
  assert.match(ok, /session = main/);
  assert.match(ok, /upgraded to 1h: 3 of 4/);
  assert.match(ok, /1h cache writes confirmed/);
  const bad = ext.formatStatus({ ...base, usage: ext.lastAssistantUsage([msg({ cacheWrite: 50, cacheWrite1h: 0 })]) });
  assert.match(bad, /WITHOUT 1h share/);
  assert.match(ext.formatStatus({ ...base, usage: {}, skipReason: "subagent session", role: "subagent" }), /inactive: subagent session/);
});

// ---- handlers on a stub pi ----
function stubPi() {
  const handlers = {};
  const commands = {};
  return {
    handlers,
    commands,
    on: (name, fn) => (handlers[name] = fn),
    registerCommand: (name, def) => (commands[name] = def),
  };
}
const ctxOf = ({ name, hasUI = true, api = "anthropic-messages", entries = [] } = {}) => ({
  hasUI,
  model: { api },
  sessionManager: { getSessionName: () => name, getEntries: () => entries },
  ui: { notify: (message) => (ctxOf.notes ??= []).push(message) },
});

test("handlers: main upgrades payload and stops the warmer; subagent / non-anthropic / env long untouched", { skip }, async () => {
  const run = async (ctx, { env, beforeStart } = {}) => {
    const pi = stubPi();
    ext.default(pi);
    if (env) process.env.PI_CACHE_RETENTION = env;
    try {
      await pi.handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
      const payload = payloadFixture();
      const out = await pi.handlers.before_provider_request({ type: "before_provider_request", payload }, ctx);
      const warm = await pi.handlers.cache_warming_decision({ type: "cache_warming_decision", action: "warm" }, ctx);
      return { out, warm, pi };
    } finally {
      delete process.env.PI_CACHE_RETENTION;
    }
  };

  const main = await run(ctxOf());
  assert.equal(main.out.system[0].cache_control.ttl, "1h");
  assert.deepEqual(main.warm, { action: "stop" });

  for (const [label, ctx, opts] of [
    ["subagent name", ctxOf({ name: "worker#a1b2c3d4" })],
    ["no UI", ctxOf({ hasUI: false })],
    ["other api", ctxOf({ api: "openai-responses" })],
    ["env long", ctxOf(), { env: "long" }],
  ]) {
    const r = await run(ctx, opts);
    assert.equal(r.out, undefined, `${label}: payload untouched`);
    assert.equal(r.warm, undefined, `${label}: warmer untouched`);
  }

  // The warmer is only stopped while the newest payload was really upgraded.
  const pi = stubPi();
  ext.default(pi);
  const ctx = ctxOf();
  await pi.handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(await pi.handlers.cache_warming_decision({ action: "warm" }, ctx), undefined, "no payload seen yet");
  await pi.handlers.before_provider_request({ payload: { model: "m", messages: [] } }, ctx);
  assert.equal(await pi.handlers.cache_warming_decision({ action: "warm" }, ctx), undefined, "payload had no breakpoints");
  await pi.handlers.before_provider_request({ payload: payloadFixture() }, ctx);
  assert.deepEqual(await pi.handlers.cache_warming_decision({ action: "warm" }, ctx), { action: "stop" });
  // idempotent second pass returns undefined (nothing to replace) but the warmer stays stopped
  const already = ext.applyOneHourTtl(payloadFixture()).payload;
  assert.equal(await pi.handlers.before_provider_request({ payload: already }, ctx), undefined);
  assert.deepEqual(await pi.handlers.cache_warming_decision({ action: "warm" }, ctx), { action: "stop" });
});

test("handlers: config disables, /cache-ttl reports counts and usage", { skip }, async () => {
  const cfg = path.join(agentDir, "cache-ttl-main.json");
  writeFileSync(cfg, JSON.stringify({ enabled: false }));
  try {
    const pi = stubPi();
    ext.default(pi);
    const ctx = ctxOf();
    await pi.handlers.session_start({}, ctx);
    assert.equal(await pi.handlers.before_provider_request({ payload: payloadFixture() }, ctx), undefined);
    assert.equal(await pi.handlers.cache_warming_decision({ action: "warm" }, ctx), undefined);
  } finally {
    rmSync(cfg);
  }

  const pi = stubPi();
  ext.default(pi);
  const entries = [{ type: "message", message: { role: "assistant", usage: { cacheWrite: 900, cacheWrite1h: 900, cacheRead: 10 } } }];
  const ctx = ctxOf({ entries });
  await pi.handlers.session_start({}, ctx);
  await pi.handlers.before_provider_request({ payload: payloadFixture() }, ctx);
  ctxOf.notes = [];
  await pi.commands["cache-ttl"].handler("", ctx);
  const text = ctxOf.notes.join("\n");
  assert.match(text, /enabled, session = main/);
  assert.match(text, /1 of 1 seen/);
  assert.match(text, /cacheWrite=900 cacheWrite1h=900/);
  assert.match(text, /confirmed/);
});

// ---- real Pi sessions ----
const noop = () => {};
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

async function makeSession({ name, ui }) {
  const pi = await import(pathToFileURL(indexPath).href);
  const ai = await import(pathToFileURL(piAiPath).href);
  const faux = ai.fauxProvider({ provider: "faux", api: "anthropic-messages", models: [{ id: "faux-model" }] });
  const modelRuntime = await pi.ModelRuntime.create({ authPath: path.join(tmp, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [ext.default] });
  await resourceLoader.reload();
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    settingsManager: pi.SettingsManager.create(cwd, agentDir),
    sessionManager: pi.SessionManager.inMemory(),
  });
  if (name) session.setSessionName(name); // pi-subagents does this before bindExtensions
  const notes = [];
  await session.bindExtensions(ui ? { uiContext: uiContext(notes) } : {});
  return { session, faux, ai, notes };
}

async function turn({ session, faux, ai }, text) {
  faux.setResponses([ai.fauxAssistantMessage("ok")]);
  await session.prompt(text);
  const last = session.agent.state.messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.stopReason, "stop");
}

const noWarm = { type: "cache_warming_decision", warmCost: 1, missCost: 2, continuationProbability: 0.2, action: "warm" };

test("session: main session turn works; payload upgraded and warmer stopped via the real runner", { skip }, async () => {
  const s = await makeSession({ ui: true });
  try {
    assert.equal(s.session.extensionRunner.hasHandlers("before_provider_request"), true);
    assert.equal(s.session.extensionRunner.hasHandlers("cache_warming_decision"), true);
    await turn(s, "hello");
    const out = await s.session.extensionRunner.emitBeforeProviderRequest(payloadFixture());
    assert.equal(out.system[0].cache_control.ttl, "1h");
    assert.equal(out.tools[1].cache_control.ttl, "1h");
    assert.equal(await s.session.extensionRunner.emitCacheWarmingDecision(noWarm), "stop");
    await s.session.prompt("/cache-ttl");
    const text = s.notes.map((n) => n.message).join("\n");
    assert.match(text, /session = main/);
    assert.match(text, /upgraded to 1h: 1 of 1/);
    assert.match(text, /last assistant usage:/);
    await turn(s, "still fine after upgrades");
  } finally {
    s.session.dispose();
  }
});

for (const [label, opts] of [
  ["named like a pi-subagents session", { name: "worker#a1b2c3d4", ui: true }],
  ["without UI", { ui: false }],
]) {
  test(`session: subagent (${label}) turn works and is left untouched`, { skip }, async () => {
    const s = await makeSession(opts);
    try {
      await turn(s, "hello");
      const payload = payloadFixture();
      const out = await s.session.extensionRunner.emitBeforeProviderRequest(payload);
      assert.equal(out, payload, "payload returned unchanged");
      assert.equal(out.system[0].cache_control.ttl, undefined);
      assert.equal(await s.session.extensionRunner.emitCacheWarmingDecision(noWarm), "warm");
      await turn(s, "again");
    } finally {
      s.session.dispose();
    }
  });
}
