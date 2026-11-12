// M2 (automatic triggers) end-to-end: real in-process Pi session + faux provider, assertions on what the provider
// really receives. Thresholds are set very low through ~/.pi/agent/context-relay.json (read on session_start).
// Run: node --test context-relay/auto.test.mjs   (from E:\Dev\TS\Pi)
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { agentDir, ai, cleanup, load, makeSession, relayExt, skip, sleep, text, waitFor, writeConfig } from "./harness.mjs";

/** Token threshold between "after one bulky turn" and "after two bulky turns" (measured, so it follows system-prompt changes). */
let MID = 0;
before(async () => {
  await load();
  if (skip) return;
  writeConfig({ auto: { onInput: false, beforeExpiry: false } });
  const { session, faux } = await makeSession();
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall("dump", { tag: "a" }), { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("a done"),
    ai.fauxAssistantMessage(ai.fauxToolCall("dump", { tag: "b" }), { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("b done"),
  ]);
  await session.prompt("calibrate one");
  const one = session.getContextUsage().tokens;
  await session.prompt("calibrate two");
  const two = session.getContextUsage().tokens;
  assert.ok(two > one + 500, `calibration: ${one} -> ${two}`);
  MID = Math.round((one + two) / 2);
});
after(cleanup);

const logPath = path.join(agentDir, "context-relay", "log.jsonl");
const readLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
beforeEach(() => rmSync(logPath, { force: true }));

/** Two turns with bulky tool output (~1000 tokens each) on top of the system prompt. */
async function twoBulkyTurns(session, faux) {
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall("dump", { tag: "pier" }), { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Pier inspected: all planks fine."),
    ai.fauxAssistantMessage(ai.fauxToolCall("dump", { tag: "rail" }), { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Railing inspected: needs one post."),
  ]);
  await session.prompt("FIRST-INSTRUCTION: inspect the pier");
  await session.prompt("SECOND-INSTRUCTION: inspect the railing");
}

const branch = (session) => session.sessionManager.getBranch();
const compactions = (session) => branch(session).filter((e) => e.type === "compaction");
const userTexts = (session) => branch(session).filter((e) => e.type === "message" && e.message.role === "user").map((e) => text(e.message));
const countIn = (messages, needle) => messages.filter((m) => text(m).includes(needle)).length;
const autoLow = () => ({ auto: { onInput: true, inputMinTokens: MID, beforeExpiry: false, expiryMinTokens: MID, minGrowthTokens: 0 } });
/** A faux response that records the messages the provider receives. */
const capture = (box, answer = "ok") => (context) => {
  box.messages = JSON.parse(JSON.stringify(context.messages));
  return ai.fauxAssistantMessage(answer);
};

test("A: input over the threshold relays first, then the next request = note + kept exchange + the new message exactly once", { skip, timeout: 60_000 }, async () => {
  writeConfig(autoLow());
  const { session, faux, notes } = await makeSession();
  await twoBulkyTurns(session, faux);
  assert.equal(compactions(session).length, 0);

  const box = {};
  faux.setResponses([capture(box, "Third answer.")]);
  const calls = faux.state.callCount;
  await session.prompt("THIRD-INSTRUCTION: what next?");
  await waitFor(() => box.messages, "the re-sent message to reach the provider");
  await waitFor(() => !session.isStreaming, "run end");

  const captured = box.messages;
  assert.equal(faux.state.callCount, calls + 1, "exactly one provider request for the third message");
  const all = captured.map(text);
  assert.ok(all.some((t) => t.includes("# Context hand-off #1")), "note in the payload");
  assert.equal(countIn(captured, "THIRD-INSTRUCTION"), 1, "new user text exactly once");
  assert.equal(captured.at(-1).role, "user");
  assert.match(text(captured.at(-1)), /THIRD-INSTRUCTION/);
  assert.ok(all.some((t) => t.includes("SECOND-INSTRUCTION")) && all.some((t) => t.includes("MARKER-RAIL-4471")), "kept exchange present");
  assert.ok(!all.some((t) => t.includes("MARKER-PIER-4471")), "old tool output absent");
  assert.equal(compactions(session).length, 1, "one relay only (the re-sent message did not re-trigger)");
  assert.equal(userTexts(session).filter((t) => t.includes("THIRD-INSTRUCTION")).length, 1);
  assert.ok(notes.some((n) => /context-relay: auto relay \(new message\) .* → ~.* tokens/.test(n.message)), JSON.stringify(notes));

  const [record, ...rest] = readLog();
  assert.equal(rest.length, 0);
  assert.equal(record.trigger, "input");
  assert.equal(record.ok, true);
  assert.equal(record.sessionId, session.sessionManager.getSessionId());
  assert.ok(record.tokensBefore > MID && record.noteChars > 100, JSON.stringify(record));
  assert.equal(record.keptFrom, compactions(session)[0].firstKeptEntryId);
  assert.ok(!("error" in record));
});

test("A: input arriving while the relay runs is held and sent once, merged after the triggering message", { skip, timeout: 60_000 }, async () => {
  writeConfig(autoLow());
  const { session, faux } = await makeSession();
  await twoBulkyTurns(session, faux);
  const box = {};
  faux.setResponses([capture(box)]);
  await session.prompt("THIRD-INSTRUCTION: one"); // handled: the relay is now running
  const during = await session.extensionRunner.emitInput("FOURTH-INSTRUCTION: two", undefined, "interactive", undefined);
  assert.equal(during.action, "handled", "held, not passed on");
  await waitFor(() => box.messages, "merged message");
  await waitFor(() => !session.isStreaming, "run end");
  const captured = box.messages;
  assert.equal(captured.at(-1).role, "user");
  assert.match(text(captured.at(-1)), /THIRD-INSTRUCTION: one\n\nFOURTH-INSTRUCTION: two/);
  assert.equal(countIn(captured, "THIRD-INSTRUCTION"), 1);
  assert.equal(countIn(captured, "FOURTH-INSTRUCTION"), 1);
  assert.equal(compactions(session).length, 1);
});

test("B: input under the threshold: no relay, the message goes straight through", { skip, timeout: 60_000 }, async () => {
  writeConfig({ auto: { ...autoLow().auto, inputMinTokens: 1_000_000 } });
  const { session, faux, notes } = await makeSession();
  await twoBulkyTurns(session, faux);
  const box = {};
  faux.setResponses([capture(box)]);
  await session.prompt("THIRD-INSTRUCTION");
  assert.ok(box.messages, "the request was made before prompt() returned");
  assert.equal(compactions(session).length, 0);
  assert.ok(box.messages.map(text).some((t) => t.includes("MARKER-PIER-4471")), "full history still sent");
  assert.equal(readLog().length, 0);
  assert.ok(!notes.some((n) => n.message.includes("auto relay")));
});

test("B': over the threshold but onInput:false, or a slash-prefixed text: no relay", { skip, timeout: 60_000 }, async () => {
  writeConfig({ auto: { ...autoLow().auto, onInput: false } });
  const off = await makeSession();
  await twoBulkyTurns(off.session, off.faux);
  off.faux.setResponses([ai.fauxAssistantMessage("ok")]);
  await off.session.prompt("THIRD-INSTRUCTION");
  assert.equal(compactions(off.session).length, 0);

  writeConfig(autoLow());
  const on = await makeSession();
  await twoBulkyTurns(on.session, on.faux);
  on.faux.setResponses([ai.fauxAssistantMessage("ok")]);
  await on.session.prompt("/not-a-command at all"); // unknown slash text is a normal prompt in Pi, but never auto-relayed
  await sleep(300);
  assert.equal(compactions(on.session).length, 0);
  assert.equal(readLog().length, 0);
});

test("C: extension-sourced input never triggers a relay (no loops)", { skip, timeout: 60_000 }, async () => {
  writeConfig(autoLow());
  const { session, faux } = await makeSession();
  await twoBulkyTurns(session, faux);
  const box = {};
  faux.setResponses([capture(box)]);
  await session.prompt("EXT-MESSAGE", { source: "extension" });
  assert.ok(box.messages);
  assert.equal(compactions(session).length, 0);
  assert.ok(box.messages.map(text).some((t) => t.includes("MARKER-PIER-4471")), "history untouched");
  assert.equal(readLog().length, 0);
});

test("D: relay failure still delivers the user's message (and says so)", { skip, timeout: 60_000 }, async () => {
  writeConfig(autoLow());
  // an extension registered before context-relay that cancels every compaction
  const cancelCompaction = (piApi) => piApi.on("session_before_compact", () => ({ cancel: true }));
  const { session, faux, notes } = await makeSession({ extra: [cancelCompaction] });
  await twoBulkyTurns(session, faux);
  const box = {};
  faux.setResponses([capture(box, "still answered")]);
  await session.prompt("THIRD-INSTRUCTION: please still arrive");
  await waitFor(() => box.messages, "the message to be delivered despite the failure");
  await waitFor(() => !session.isStreaming, "run end");
  assert.equal(compactions(session).length, 0);
  assert.equal(countIn(box.messages, "THIRD-INSTRUCTION"), 1);
  assert.equal(box.messages.at(-1).role, "user");
  assert.ok(notes.some((n) => /auto relay \(input\) failed: .*your message is sent anyway/.test(n.message)), JSON.stringify(notes));
  const [record] = readLog();
  assert.equal(record.ok, false);
  assert.match(record.error, /cancel/i);
  assert.equal(record.trigger, "input");
});

test("E: before cache expiry the session relays by itself (nothing re-sent; agent activity cancels the timer)", { skip, timeout: 60_000 }, async () => {
  writeConfig({ auto: { onInput: false, beforeExpiry: true, expiryMinTokens: MID, minGrowthTokens: 0 } });
  // model-declared short tier shortened to 2 s; the trigger fires 0.7 s before expiry = ~1.3 s after the last request
  const relay = relayExt.createContextRelay({ expiryLeadMs: 700 });
  const { session, faux, notes } = await makeSession({ relay, promptCache: { short: 2 } });
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall("dump", { tag: "pier" }), { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Pier inspected."),
    ai.fauxAssistantMessage(ai.fauxToolCall("dump", { tag: "rail" }), { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Railing inspected."),
  ]);
  await session.prompt("FIRST-INSTRUCTION");
  await sleep(500); // the first settle armed a timer (~1.3 s after its request) ...
  await session.prompt("SECOND-INSTRUCTION"); // ... agent_start cancelled it; this settle re-armed from the NEW request
  const callsBefore = faux.state.callCount;
  const settledAt = Date.now();
  assert.equal(compactions(session).length, 0);
  await waitFor(() => compactions(session).length > 0, "expiry relay", 8000);
  const waited = Date.now() - settledAt;
  assert.ok(waited > 700 && waited < 2500, `relay fired ~1.3 s after the last request, was ${waited} ms after it settled`);
  assert.equal(compactions(session).at(-1).details.relay, true);
  assert.equal(faux.state.callCount, callsBefore, "no provider request: nothing re-sent");
  assert.equal(userTexts(session).length, 2);
  assert.ok(notes.some((n) => /auto relay \(cache expiry\)/.test(n.message)), JSON.stringify(notes));
  const [record] = readLog();
  assert.equal(record.trigger, "expiry");
  assert.equal(record.ok, true);
  await sleep(2500); // after the relay there is no cache to protect: no second relay
  assert.equal(compactions(session).length, 1);
});

test("E': expiry trigger respects expiryMinTokens", { skip, timeout: 60_000 }, async () => {
  writeConfig({ auto: { onInput: false, beforeExpiry: true, expiryMinTokens: 1_000_000, minGrowthTokens: 0 } });
  const relay = relayExt.createContextRelay({ expiryLeadMs: 300 });
  const { session, faux } = await makeSession({ relay, promptCache: { short: 1 } });
  await twoBulkyTurns(session, faux);
  await sleep(1500);
  assert.equal(compactions(session).length, 0);
  assert.equal(readLog().length, 0);
});

test("F: subagent-marked / headless sessions: nothing happens (no input relay, no expiry relay)", { skip, timeout: 60_000 }, async () => {
  writeConfig({ auto: { onInput: true, inputMinTokens: 100, beforeExpiry: true, expiryMinTokens: 100, minGrowthTokens: 0 } });
  for (const opts of [{ name: "worker#0a1b2c3d", hasUI: false }, { hasUI: false }]) {
    const relay = relayExt.createContextRelay({ expiryLeadMs: 300 });
    const { session, faux } = await makeSession({ ...opts, relay, promptCache: { short: 1 } });
    await twoBulkyTurns(session, faux);
    const box = {};
    faux.setResponses([capture(box)]);
    await session.prompt("THIRD-INSTRUCTION");
    assert.ok(box.messages, "message went straight to the provider");
    assert.equal(countIn(box.messages, "THIRD-INSTRUCTION"), 1);
    await sleep(1500);
    assert.equal(compactions(session).length, 0, JSON.stringify(opts));
  }
  assert.equal(readLog().length, 0);
});

test("E'': unknown cache lifetime (no promptCache, not anthropic): the expiry trigger is never armed", { skip, timeout: 60_000 }, async () => {
  writeConfig({ auto: { onInput: false, beforeExpiry: true, expiryMinTokens: MID, minGrowthTokens: 0 } });
  const relay = relayExt.createContextRelay({ expiryLeadMs: 300 });
  const { session, faux, notes } = await makeSession({ relay }); // faux = best-effort cache: usage shows cache writes, lifetime unknown
  await twoBulkyTurns(session, faux);
  assert.ok(session.sessionManager.getBranch().some((e) => e.type === "message" && e.message.role === "assistant" && e.message.usage.cacheWrite > 0));
  await sleep(1500);
  assert.equal(compactions(session).length, 0);
  assert.equal(readLog().length, 0);
  assert.ok(!notes.some((n) => n.message.includes("context-relay")));
});
