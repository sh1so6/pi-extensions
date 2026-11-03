// Regression tests for the M1 review findings, against a real in-process Pi session (faux provider):
//  - context_edit fidelity: omitted / replaced user text must not come back through the relay note
//  - an aborted compaction leaves no note file
// Run: node --test context-relay/review.test.mjs   (from E:\Dev\TS\Pi)
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { agentDir, ai, cleanup, load, makeSession, relayExt, skip, text, waitFor, writeConfig } from "./harness.mjs";

before(async () => {
  await load();
  writeConfig({ auto: { onInput: false, beforeExpiry: false } });
});
after(cleanup);

const userEntry = (session, needle) => session.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user" && text(e.message).includes(needle));
const noteDir = (session) => path.join(agentDir, "context-relay", session.sessionManager.getSessionId());

test("context_edit: a relay note is built from the model-visible branch (omitted / replaced user text stays gone)", { skip, timeout: 60_000 }, async () => {
  const { session, faux, notes } = await makeSession();
  faux.setResponses(["one", "two", "three"].map((w) => ai.fauxAssistantMessage(`${w} done`)));
  await session.prompt("SECRET-FIRST: the password is hunter2");
  await session.prompt("ORIGINAL-SECOND: please do the thing");
  await session.prompt("THIRD: latest instruction");
  session.sessionManager.appendContextEdit(userEntry(session, "SECRET-FIRST").id, null);
  session.sessionManager.appendContextEdit(userEntry(session, "ORIGINAL-SECOND").id, { content: "REPLACED-SECOND: [redacted]" });

  await session.prompt("/relay");
  await waitFor(() => notes.some((n) => /context-relay: (done|.*fail)/.test(n.message)), "relay result");
  const compaction = session.sessionManager.getBranch().findLast((e) => e.type === "compaction");
  assert.equal(compaction.details.relay, true);
  for (const body of [compaction.summary, readFileSync(compaction.details.notePath, "utf8")]) {
    assert.ok(!body.includes("SECRET-FIRST") && !body.includes("hunter2"), "omitted text is not in the note");
    assert.ok(!body.includes("ORIGINAL-SECOND"), "replaced text is not in the note");
    assert.match(body, /REPLACED-SECOND: \[redacted\]/);
  }
});

test("aborted compaction: no note file is left behind (aborted before the handler, or while it collects the extra sections)", { skip, timeout: 60_000 }, async () => {
  for (const abortWhen of ["before", "during-extras"]) {
    const controller = new AbortController();
    let extraCalls = 0;
    const relay = relayExt.createContextRelay({
      extraSections: async () => {
        extraCalls++;
        if (abortWhen === "during-extras") controller.abort();
        return [];
      },
    });
    const { session, faux } = await makeSession({ relay });
    faux.setResponses([ai.fauxAssistantMessage("a"), ai.fauxAssistantMessage("b")]);
    await session.prompt("one");
    await session.prompt("two");
    if (abortWhen === "before") controller.abort();
    const entries = session.sessionManager.getBranch();
    const result = await session.extensionRunner.emit({
      type: "session_before_compact",
      preparation: { firstKeptEntryId: entries[0].id, tokensBefore: 1 },
      branchEntries: entries,
      customInstructions: relayExt.RELAY_MARKER,
      reason: "manual",
      willRetry: false,
      signal: controller.signal,
    });
    assert.equal(result?.cancel, true, abortWhen);
    assert.equal(extraCalls, abortWhen === "before" ? 0 : 1, "pre-aborted relay skips note collection entirely");
    assert.ok(!existsSync(noteDir(session)) || readdirSync(noteDir(session)).length === 0, `no note file (${abortWhen})`);
  }
});
