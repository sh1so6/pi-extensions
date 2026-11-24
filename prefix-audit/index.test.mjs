// Tests for prefix-audit. Run: node --test index.test.mjs  (Node >= 23.6 strips TS types)
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const agentDir = mkdtempSync(path.join(tmpdir(), "prefix-audit-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const mod = await import(pathToFileURL(path.join(import.meta.dirname, "index.ts")).href);
const { canonical, takeSnapshot, diffSnapshots, summarizeDiff, readDrops, parseSettings, detectRole, default: prefixAudit } = mod;

const tool = (name, description = "d") => ({ name, description, input_schema: { type: "object", properties: {} } });
const payload = (over = {}) => ({
  system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
  tools: [tool("read"), tool("bash")],
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sigA" }, { type: "text", text: "yo" }] },
  ],
  ...over,
});

test("canonical ignores key order and cache_control", () => {
  assert.equal(canonical({ b: 1, a: { cache_control: { x: 1 }, z: 2 } }), canonical({ a: { z: 2 }, b: 1 }));
});

test("detectRole / parseSettings", () => {
  assert.equal(detectRole("tui", false), "main");
  assert.equal(detectRole("print", true), "subagent");
  assert.equal(detectRole(undefined, true), "main");
  assert.deepEqual(parseSettings({ enabled: false }), { enabled: false });
  assert.deepEqual(parseSettings(undefined), { enabled: true });
});

test("identical request and appended message are not changes; cache_control and thinking text are ignored", () => {
  const a = takeSnapshot(payload());
  const grown = payload();
  grown.messages.push({ role: "user", content: "next" });
  grown.system[0].cache_control = { type: "ephemeral", ttl: "1h" };
  grown.messages[1].content[0].thinking = "different text, same signature";
  assert.equal(diffSnapshots(a, takeSnapshot(grown)), undefined);
});

test("system, tool and message changes are located", () => {
  const a = takeSnapshot(payload());
  const p = payload();
  p.system[0].text = "sys!";
  p.tools = [tool("read", "new description"), tool("grep")];
  p.messages[0].content[0].text = "hi there";
  const result = diffSnapshots(a, takeSnapshot(p));
  assert.ok(result);
  assert.ok(result.diff.system);
  assert.deepEqual(result.diff.tools.added, ["grep"]);
  assert.deepEqual(result.diff.tools.removed, ["bash"]);
  assert.equal(result.diff.tools.changed[0].name, "read");
  assert.match(result.diff.tools.changed[0].now, /new description/);
  assert.equal(result.firstMutated, 0);
  assert.equal(result.diff.messages.mutatedCount, 1);
  const kinds = summarizeDiff(5, result.diff, result.firstMutated).map((c) => c.kind);
  assert.deepEqual(kinds, ["system", "tools", "messages"]);
});

test("a changed thinking signature, a removed thinking block and a shrunk history are detected", () => {
  const a = takeSnapshot(payload());
  const sig = payload();
  sig.messages[1].content[0].signature = "sigB";
  assert.equal(diffSnapshots(a, takeSnapshot(sig))?.firstMutated, 1);
  const noThinking = payload();
  noThinking.messages[1].content.shift();
  assert.equal(diffSnapshots(a, takeSnapshot(noThinking))?.firstMutated, 1);
  const shrunk = payload();
  shrunk.messages.pop();
  assert.deepEqual(diffSnapshots(a, takeSnapshot(shrunk))?.diff.messages.shrunk, { from: 2, to: 1 });
});

test("tool reorder alone is a change", () => {
  const a = takeSnapshot(payload());
  const p = payload();
  p.tools.reverse();
  assert.equal(diffSnapshots(a, takeSnapshot(p))?.diff.tools.order, true);
});

test("readDrops reads reasons, prefix indices and thread fallback", () => {
  assert.equal(readDrops({ role: "assistant" }), undefined);
  const drops = readDrops({
    diagnostics: [
      { type: "anthropic_thread_fallback" },
      {
        type: "anthropic_input_transformations",
        details: {
          transformations: [
            { type: "thinking_dropped", path: "messages.51.content.0", reason: "prefix_binding_mismatch" },
            { type: "thinking_dropped", path: "messages.54.content.0", reason: "prefix_binding_mismatch" },
            { type: "thinking_dropped", path: "messages.3.content.0", reason: "model_binding_mismatch" },
            { type: "other" },
          ],
        },
      },
    ],
  });
  assert.deepEqual(drops, {
    count: 3,
    reasons: ["prefix_binding_mismatch", "model_binding_mismatch"],
    prefixIdx: [51, 54],
    threadFallback: true,
  });
});

// ---- handlers on a stub pi ----
function stubPi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    pi: {
      on: (name, fn) => handlers.set(name, fn),
      registerCommand: (name, def) => commands.set(name, def),
    },
    handlers,
    commands,
  };
}
const notices = [];
const ctx = (id = "sess-1") => ({
  mode: "tui",
  hasUI: true,
  model: { api: "anthropic-messages", id: "claude-x" },
  sessionManager: { getSessionId: () => id },
  ui: { notify: (m) => notices.push(m) },
});
const readLog = (id) =>
  readFileSync(path.join(agentDir, "prefix-audit", `${id}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("end to end: tool description change between requests is named as the suspect of a later drop", async () => {
  const { pi, handlers, commands } = stubPi();
  prefixAudit(pi);
  const c = ctx("sess-1");
  handlers.get("session_start")({}, c);

  const p1 = payload(); // seq 1: 2 messages
  handlers.get("before_provider_request")({ payload: p1 }, c);
  const p2 = payload(); // seq 2: tool description changed, one more assistant turn appended
  p2.tools[0] = tool("read", "changed!");
  p2.messages.push({ role: "user", content: "more" }, { role: "assistant", content: [{ type: "thinking", signature: "sigC", thinking: "x" }] });
  assert.equal(handlers.get("before_provider_request")({ payload: p2 }, c), undefined);

  handlers.get("message_end")(
    {
      message: {
        role: "assistant",
        diagnostics: [
          {
            type: "anthropic_input_transformations",
            details: { transformations: [{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" }] },
          },
        ],
      },
    },
    c,
  );

  const log = readLog("sess-1");
  assert.deepEqual(log.map((r) => r.type), ["req", "req", "drop"]);
  assert.equal(log[0].diff, undefined);
  assert.equal(log[1].diff.tools.changed[0].name, "read");
  assert.equal(log[2].firstIdx, 1);
  assert.equal(log[2].suspects.length, 1);
  assert.match(log[2].suspects[0].summary, /tools changed read/);
  assert.match(notices.at(-1), /tools changed read/);

  await commands.get("prefix-audit").handler("", c);
  assert.match(notices.at(-1), /requests seen: 2, drop events: 1/);
});

test("drop with no change names the thread fallback; non-anthropic and disabled sessions are ignored", () => {
  const { pi, handlers } = stubPi();
  prefixAudit(pi);
  const c = ctx("sess-2");
  handlers.get("session_start")({}, c);
  handlers.get("before_provider_request")({ payload: payload() }, c);
  handlers.get("message_end")(
    {
      message: {
        role: "assistant",
        diagnostics: [
          { type: "anthropic_thread_fallback" },
          {
            type: "anthropic_input_transformations",
            details: { transformations: [{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" }] },
          },
        ],
      },
    },
    c,
  );
  const drop = readLog("sess-2").find((r) => r.type === "drop");
  assert.deepEqual(drop.suspects, []);
  assert.equal(drop.threadFallback, true);
  assert.match(notices.at(-1), /thread_fallback/);

  const other = { ...ctx("sess-3"), model: { api: "openai-completions", id: "m" } };
  handlers.get("session_start")({}, other);
  handlers.get("before_provider_request")({ payload: payload() }, other);
  assert.equal(existsSync(path.join(agentDir, "prefix-audit", "sess-3.jsonl")), false);
});

test("a failing log write never throws or changes the payload", () => {
  const { pi, handlers } = stubPi();
  prefixAudit(pi);
  const c = ctx("sess-4");
  handlers.get("session_start")({}, c);
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(agentDir, "prefix-audit", "sess-1.jsonl", "nope"); // a file in the path
  try {
    assert.equal(handlers.get("before_provider_request")({ payload: payload() }, c), undefined);
    assert.equal(handlers.get("message_end")({ message: { role: "assistant", diagnostics: [] } }, c), undefined);
    assert.equal(handlers.get("before_provider_request")({ payload: "not an object" }, c), undefined);
  } finally {
    process.env.PI_CODING_AGENT_DIR = saved;
  }
});
