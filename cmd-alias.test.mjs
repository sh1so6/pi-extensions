// Dependency-free tests for cmd-alias.ts. Run: node cmd-alias.test.mjs  (Node >= 23.6 strips TS types)
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const stubs = {
  "@earendil-works/pi-coding-agent": "export const getAgentDir = () => globalThis.__cmdAliasAgentDir;",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in stubs) {
      return { url: "data:text/javascript," + encodeURIComponent(stubs[specifier]), shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const agentDir = mkdtempSync(path.join(tmpdir(), "cmd-alias-test-"));
globalThis.__cmdAliasAgentDir = agentDir;
const { default: factory, parseAliases, buildForward, commandNameOf } = await import("./cmd-alias.ts");
const cfg = path.join(agentDir, "cmd-alias.json");
const obj = (m) => Object.fromEntries(m);

test("commandNameOf / buildForward", () => {
  assert.equal(commandNameOf("/relay foo"), "relay");
  assert.equal(commandNameOf("  /skill:x"), "skill:x");
  assert.equal(commandNameOf("relay"), "");
  assert.equal(commandNameOf("/"), "");
  assert.equal(buildForward("/relay", ""), "/relay");
  assert.equal(buildForward("/relay", "  a b "), "/relay a b");
  assert.equal(buildForward("/x --f", "a"), "/x --f a");
});

test("parseAliases defaults and normalization", () => {
  assert.deepEqual(obj(parseAliases(undefined)), { z: "/relay" });
  assert.deepEqual(obj(parseAliases(null)), { z: "/relay" });
  assert.deepEqual(obj(parseAliases({})), { z: "/relay" });
  assert.deepEqual(obj(parseAliases({ aliases: [] })), { z: "/relay" });
  assert.deepEqual(obj(parseAliases({ aliases: {} })), {});
  assert.deepEqual(
    obj(parseAliases({ aliases: { "/a": "relay", " b ": " /x --f ", "z-pay": "/pay" } })),
    { a: "/relay", b: "/x --f", "z-pay": "/pay" },
  );
});

test("parseAliases ignores invalid entries and rejects alias targets", () => {
  const r = parseAliases({
    aliases: { "": "/x", "a b": "/x", "a:b": "/x", n: 5, e: "", slash: "/", ok: "/real", self: "/self", p: "/q", q: "/p", c: "/ok" },
  });
  assert.deepEqual(obj(r), { ok: "/real" });
});

function setup() {
  const commands = new Map();
  const sent = [];
  let list = [{ name: "relay" }, { name: "other" }];
  const pi = {
    registerCommand: (n, o) => commands.set(n, o),
    getCommands: () => list,
    sendUserMessage: (t, o) => sent.push([t, o]),
    on: (e, h) => commands.set(`on:${e}`, h),
  };
  const notes = [];
  const ctx = (idle = true) => ({ isIdle: () => idle, ui: { notify: (m, l) => notes.push([m, l]) } });
  return { commands, sent, pi, notes, ctx, setList: (l) => (list = l) };
}

test("factory loads config file; missing/malformed falls back to defaults", () => {
  rmSync(cfg, { force: true });
  let s = setup();
  factory(s.pi);
  assert.deepEqual([...s.commands.keys()].filter((k) => !k.startsWith("on:")), ["z"]);
  assert.equal(s.commands.get("z").description, "alias → /relay");
  writeFileSync(cfg, "{ nope");
  s = setup();
  factory(s.pi);
  assert.ok(s.commands.has("z"));
  writeFileSync(cfg, "\uFEFF" + JSON.stringify({ aliases: { z: "/relay", zp: "/other --f" } }));
  s = setup();
  factory(s.pi);
  assert.ok(s.commands.has("z") && s.commands.has("zp"));
});

test("handler forwards extension command with args", async () => {
  writeFileSync(cfg, JSON.stringify({ aliases: { z: "/relay", zp: "/other --f" } }));
  const s = setup();
  factory(s.pi);
  await s.commands.get("z").handler("  hello world ", s.ctx());
  await s.commands.get("zp").handler("", s.ctx());
  assert.deepEqual(s.sent, [
    ["/relay hello world", { expandPromptTemplates: true }],
    ["/other --f", { expandPromptTemplates: true }],
  ]);
  assert.equal(s.notes.length, 0);
});

test("handler passes deliverAs followUp when not idle", async () => {
  writeFileSync(cfg, JSON.stringify({ aliases: { z: "/relay" } }));
  const s = setup();
  factory(s.pi);
  await s.commands.get("z").handler("x", s.ctx(false));
  assert.deepEqual(s.sent, [["/relay x", { expandPromptTemplates: true, deliverAs: "followUp" }]]);
});

test("handler refuses unknown/built-in target and alias-named target with a warning", async () => {
  writeFileSync(cfg, JSON.stringify({ aliases: { c: "/compact", z: "/relay" } }));
  const s = setup();
  factory(s.pi);
  await s.commands.get("c").handler("", s.ctx());
  assert.equal(s.sent.length, 0);
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0][1], "warning");
  assert.match(s.notes[0][0], /\/compact is not an extension command/);
  // a command named like an alias must not satisfy validation
  s.setList([{ name: "z" }]);
  await s.commands.get("z").handler("", s.ctx());
  assert.equal(s.sent.length, 0);
  assert.equal(s.notes.length, 2);
});

test("session_start warns about renamed duplicate alias commands", async () => {
  writeFileSync(cfg, JSON.stringify({ aliases: { z: "/relay" } }));
  let s = setup();
  factory(s.pi);
  await s.commands.get("on:session_start")({}, s.ctx());
  assert.equal(s.notes.length, 0);
  s = setup();
  s.setList([{ name: "relay" }, { name: "z:1" }, { name: "z:2" }]);
  factory(s.pi);
  await s.commands.get("on:session_start")({}, s.ctx());
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0][0], /\/z\b/);
});

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
