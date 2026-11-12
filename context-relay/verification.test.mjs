// Independent installed-Pi 1.4.0 regression checks. No network, live-session writes or deployment.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { agentDir, ai, cleanup, load, makeSession, relayExt, skip, sleep, text, waitFor, writeConfig } from "./harness.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";

before(load);
after(cleanup);
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const compactions = (s) => s.sessionManager.getBranch().filter((e) => e.type === "compaction");
const users = (s) => s.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "user");
const low = { auto: { inputMinTokens: 0, beforeExpiry: false, minGrowthTokens: 30000 } };
async function seed(s, f) {
  f.setResponses([ai.fauxAssistantMessage("first answer"), ai.fauxAssistantMessage("latest answer")]);
  await s.prompt("FIRST"); await s.prompt("LATEST");
}
async function gatedSession() {
  writeConfig({ auto: { onInput: false, beforeExpiry: false } });
  const entered = gate(), release = gate();
  const relay = relayExt.createContextRelay({ extraSections: async () => { entered.resolve(); await release.promise; return []; } });
  const out = await makeSession({ relay });
  await seed(out.session, out.faux);
  writeConfig(low);
  await out.session.extensionRunner.emit({ type: "session_start" });
  return { ...out, entered, release };
}

test("config: null/scalar/array roots default safely; session_start remains active", { skip }, async () => {
  for (const raw of ["null", "42", '"text"', "[]"]) {
    writeFileSync(path.join(agentDir, "context-relay.json"), raw);
    assert.equal(relayExt.loadConfig(agentDir).enabled, true, raw);
  }
  writeFileSync(path.join(agentDir, "context-relay.json"), "null");
  const { session } = await makeSession();
  assert.ok(session.extensionRunner.getCommand("relay"));
});

test("A: merged image attachments and rpc text arrive exactly once", { skip, timeout: 20000 }, async () => {
  const { session, faux, entered, release } = await gatedSession();
  // Valid 1x1 PNG. Pi may normalize image data, so assert count/mime rather than base64 identity.
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC" };
  let captured;
  faux.setResponses([(ctx) => { captured = ctx.messages; return ai.fauxAssistantMessage("ok"); }]);
  await session.prompt("IMAGE-ONE", { images: [image], source: "rpc" });
  await entered.promise;
  const result = await session.extensionRunner.emitInput("IMAGE-TWO", [image], "interactive", undefined);
  assert.equal(result.action, "handled");
  release.resolve();
  await waitFor(() => captured, "image resend"); await session.waitForIdle();
  const msg = captured.at(-1);
  assert.match(text(msg), /IMAGE-ONE\n\nIMAGE-TWO/);
  assert.equal(msg.content.filter((b) => b.type === "image").length, 2);
  assert.equal(users(session).filter((e) => text(e.message).includes("IMAGE-ONE")).length, 1);
  assert.equal(compactions(session).length, 1);
});

test("streaming: steer/followUp stay queued, never initiate relay", { skip, timeout: 20000 }, async () => {
  for (const behavior of ["steer", "followUp"]) {
    writeConfig({ auto: { onInput: false, beforeExpiry: false } });
    const { session, faux } = await makeSession(); await seed(session, faux);
    writeConfig(low); await session.extensionRunner.emit({ type: "session_start" });
    const entered = gate(), release = gate();
    faux.setResponses([async () => { entered.resolve(); await release.promise; return ai.fauxAssistantMessage("stream end"); }, ai.fauxAssistantMessage("queued answer")]);
    const run = session.prompt("STREAM", { source: "extension" });
    await entered.promise;
    await session.prompt(`QUEUED-${behavior}`, { streamingBehavior: behavior });
    release.resolve(); await run; await session.waitForIdle();
    assert.equal(compactions(session).length, 0);
    assert.equal(users(session).filter((e) => text(e.message).includes(`QUEUED-${behavior}`)).length, 1);
  }
});

test("notification triggerTurn mid-relay: notification and held user both survive exactly once", { skip, timeout: 20000 }, async () => {
  const { session, faux, notes, entered, release } = await gatedSession();
  const notificationEntered = gate(), notificationRelease = gate();
  const payloads = [];
  faux.setResponses([async (ctx) => { payloads.push(structuredClone(ctx.messages)); notificationEntered.resolve(); await notificationRelease.promise; return ai.fauxAssistantMessage("notification handled"); }, (ctx) => { payloads.push(structuredClone(ctx.messages)); return ai.fauxAssistantMessage("user handled"); }]);
  await session.prompt("HELD-USER"); await entered.promise;
  const notification = session.sendCustomMessage({ customType: "subagent-notification", content: "WORKER-DONE", display: true, details: { id: "worker", status: "completed" } }, { triggerTurn: true });
  await notificationEntered.promise;
  release.resolve();
  await waitFor(() => notes.some((n) => n.message.includes("auto relay (new message)")), "relay finish");
  notificationRelease.resolve(); await notification; await session.waitForIdle(); await sleep(100);
  assert.equal(users(session).filter((e) => text(e.message).includes("HELD-USER")).length, 1, "held user is not rejected while notification streams");
  const notifications = session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "subagent-notification");
  assert.equal(notifications.length, 1);
  assert.equal(payloads.length, 2);
  assert.equal(payloads.at(-1).filter((m) => text(m).includes("WORKER-DONE")).length, 1);
  assert.equal(payloads.at(-1).filter((m) => text(m).includes("HELD-USER")).length, 1);
});

test("Pi threshold enabled at run start: Trigger A does not double compact stale assistant usage", { skip, timeout: 20000 }, async () => {
  const { session, faux, entered, release } = await gatedSession();
  let builtin = 0;
  const original = session._runAutoCompaction.bind(session);
  session._runAutoCompaction = async (...args) => { builtin++; return original(...args); };
  session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: session.model.contextWindow - 1, keepRecentTokens: 1 } });
  let captured;
  faux.setResponses([(ctx) => { captured = ctx.messages; session.settingsManager.applyOverrides({ compaction: { enabled: false } }); return ai.fauxAssistantMessage("ok"); }]);
  await session.prompt("AFTER-RELAY"); await entered.promise; release.resolve();
  await waitFor(() => captured, "post-relay request"); await session.waitForIdle();
  assert.equal(builtin, 0);
  assert.equal(compactions(session).length, 1);
});

test("expiry timer is cleared on shutdown/session_start and agent_start", { skip, timeout: 20000 }, async () => {
  for (const lifecycle of ["session_shutdown", "session_start", "agent_start"]) {
    writeConfig({ auto: { onInput: false, beforeExpiry: true, expiryMinTokens: 0 } });
    const { session, faux } = await makeSession({ relay: relayExt.createContextRelay({ expiryLeadMs: 100 }), promptCache: { short: 0.6 } });
    await seed(session, faux);
    await session.extensionRunner.emit({ type: lifecycle, reason: "quit" });
    await sleep(750);
    assert.equal(compactions(session).length, 0, lifecycle);
  }
});

test("session switch/shutdown restores held text without old callback consuming new input", { skip }, async () => {
  writeConfig(low);
  for (const lifecycle of ["session_start", "session_shutdown"]) {
    const handlers = new Map(), sends = [], completions = [];
    const api = { on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerTool() {}, sendUserMessage: (...args) => sends.push(args) };
    relayExt.createContextRelay()(api);
    let editor = "draft", id = "old";
    const warnings = [];
    const ctx = { hasUI: true, isIdle: () => true, getContextUsage: () => ({ tokens: 200000 }),
      sessionManager: { getSessionId: () => id, getSessionName: () => "main" },
      compact: (opts) => completions.push(opts),
      ui: { notify: (m) => warnings.push(m), getEditorText: () => editor, setEditorText: (value) => { editor = value; } } };
    await handlers.get("session_start")({}, ctx);
    const input = { source: "interactive", text: "OLD-HELD", images: [{ type: "image", mimeType: "image/png", data: "old" }] };
    assert.equal(handlers.get("input")(input, ctx).action, "handled");
    id = "new"; await handlers.get(lifecycle)({}, ctx);
    assert.equal(editor, "OLD-HELD\n\ndraft");
    assert.ok(warnings.some((m) => m.includes("reattach 1")));
    assert.equal(handlers.get("input")({ source: "interactive", text: "NEW-DURING-OLD" }, ctx).action, "continue");
    const warningCount = warnings.length;
    completions[0].onError(new Error("old cancelled"));
    assert.equal(warnings.length, warningCount, "old callback does not notify the new session");
    assert.equal(sends.length, 0);
    await handlers.get("session_start")({}, ctx);
    assert.equal(handlers.get("input")({ source: "interactive", text: "NEW-HELD" }, ctx).action, "handled");
    completions[1].onError(new Error("new cancelled"));
    assert.deepEqual(sends.map((s) => s[0]), ["NEW-HELD"]);
    assert.equal(editor, "OLD-HELD\n\ndraft");
  }
});

test("recall: valid 20k leading-zero note IDs are capped on fetch, pagination and past-end branches", async () => {
  const { recall } = await import("./recall.ts");
  const sources = [{ prefix: "", entries: [], searchEnd: 0, notes: [{ n: 1, path: "test.md", text: "a".repeat(24000) }] }];
  const entryId = `note:${"0".repeat(20000)}1`;
  for (const offset of [0, 12000, 999999]) {
    const output = recall(sources, { entryId, offset });
    assert.ok(output.length < 13000, String(output.length));
    assert.match(output, /^\[note:1\]/);
  }
});

test("expiry: failed/aborted writes cannot change the last successful cache tier", async () => {
  const { cacheExpiry, ANTHROPIC_LONG_TTL_MS } = await import("./auto.ts");
  for (const stopReason of ["error", "aborted"]) {
    const message = (timestamp, usage, reason = "stop") => ({ type: "message", message: { role: "assistant", timestamp, usage, stopReason: reason } });
    const result = cacheExpiry([message(1000, { cacheWrite: 100, cacheWrite1h: 100 }), message(2000, { cacheWrite: 100 }, stopReason)], { api: "anthropic-messages" });
    assert.equal(result.tier, "long");
    assert.equal(result.expiresAt, 1000 + ANTHROPIC_LONG_TTL_MS);
  }
});

test("a #<8hex>-named session driven by a person (tui) is main; the name is not consulted", async () => {
  const { isSubagentSession } = await import("./detect.ts");
  assert.equal(isSubagentSession({ mode: "tui", hasUI: true, sessionManager: { getSessionName: () => "worker#AbCdEF12" } }), false);
});
