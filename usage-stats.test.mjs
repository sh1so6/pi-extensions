// Dependency-free tests for usage-stats.ts. Run: node usage-stats.test.mjs  (Node >= 23.6 strips TS types)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const stubs = {
  "@earendil-works/pi-coding-agent": "export const getAgentDir = () => globalThis.__usAgentDir;",
  "@earendil-works/pi-tui":
    "export class Text { constructor(t){this.text=t;} } export class Box { constructor(){this.children=[];} addChild(c){this.children.push(c);} }",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in stubs) return { url: "data:text/javascript," + encodeURIComponent(stubs[specifier]), shortCircuit: true };
    return next(specifier, context);
  },
});

const agentDir = mkdtempSync(path.join(tmpdir(), "usage-stats-test-"));
globalThis.__usAgentDir = agentDir;
const { default: factory, parseArgs, parseConfig, capOutput, openPath, lastLine, DEFAULT_CONFIG } = await import("./usage-stats.ts");

test("parseArgs", () => {
  assert.deepEqual(parseArgs(""), { kind: "run", script: "report", dir: undefined });
  assert.deepEqual(parseArgs("sim3.py"), { kind: "run", script: "sim3", dir: undefined });
  assert.deepEqual(parseArgs("AN2 C:/a b/c"), { kind: "run", script: "an2", dir: "C:/a b/c" });
  assert.deepEqual(parseArgs('an "C:/x y"'), { kind: "run", script: "an", dir: "C:/x y" });
  assert.deepEqual(parseArgs("html"), { kind: "run", script: "html", dir: undefined });
  assert.deepEqual(parseArgs("HTML C:/x y"), { kind: "run", script: "html", dir: "C:/x y" });
  assert.equal(parseArgs("list").kind, "list");
  assert.equal(parseArgs("help").kind, "list");
  assert.equal(parseArgs("nope").kind, "error");
  assert.equal(parseArgs("constructor").kind, "error");
});

test("parseConfig defaults and overrides", () => {
  assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig("x"), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig({ timeoutMs: -1, python: 3, scriptsDir: " " }), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig({ scriptsDir: "D:/s", python: "py", timeoutMs: 5 }), { scriptsDir: "D:/s", python: "py", timeoutMs: 5 });
});

test("capOutput", () => {
  assert.deepEqual(capOutput("a\nb\n"), { text: "a\nb", more: 0 });
  const big = Array.from({ length: 305 }, (_, i) => `l${i}`).join("\r\n");
  const r = capOutput(big);
  assert.equal(r.more, 5);
  assert.equal(r.text.split("\n").length, 300);
  assert.deepEqual(capOutput("a\nb\nc", 2), { text: "a\nb", more: 1 });
});

function setup(execImpl, deps) {
  const commands = new Map();
  const renderers = new Map();
  const execs = [];
  const entries = [];
  const notes = [];
  const pi = {
    registerCommand: (n, c) => commands.set(n, c),
    registerEntryRenderer: (t, r) => renderers.set(t, r),
    exec: async (cmd, args, opts) => (execs.push({ cmd, args, opts }), execImpl(cmd, args, opts)),
    appendEntry: (t, d) => entries.push({ t, d }),
  };
  factory(pi, deps);
  const ctx = {
    ui: { notify: (m, l) => notes.push({ m, l }) },
    sessionManager: { getSessionDir: () => agentDir },
  };
  return { cmd: commands.get("usage-stats"), renderers, execs, entries, notes, ctx };
}

test("handler runs script and appends entry", async () => {
  const s = setup(async () => ({ stdout: "report\n", stderr: "", code: 0 }));
  await s.cmd.handler("", s.ctx);
  assert.equal(s.execs.length, 1);
  assert.equal(s.execs[0].cmd, "python");
  assert.deepEqual(s.execs[0].args, [path.join(DEFAULT_CONFIG.scriptsDir, "report.py"), agentDir]);
  assert.equal(s.execs[0].opts.timeout, 120000);
  assert.equal(s.notes[0].m, "usage-stats: running report …");
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].t, "usage-stats");
  assert.equal(s.entries[0].d.exitCode, 0);
  assert.equal(s.entries[0].d.output, "report\n");
  const box = s.renderers.get("usage-stats")({ data: s.entries[0].d }, { expanded: false }, { fg: (_, t) => t, bg: (_, t) => t });
  assert.match(box.children[0].text, /^usage-stats: report — .+ \(exit 0\)$/);
  assert.equal(box.children[1].text, "report");
});

test("config file is honored; failure notifies error and still appends", async () => {
  writeFileSync(path.join(agentDir, "usage-stats.json"), JSON.stringify({ python: "py3", scriptsDir: "D:/s", timeoutMs: 7 }));
  const s = setup(async () => ({ stdout: "", stderr: "a\nboom", code: 1 }));
  await s.cmd.handler("sim4.py", s.ctx);
  assert.equal(s.execs[0].cmd, "py3");
  assert.equal(s.execs[0].args[0], path.join("D:/s", "sim4.py"));
  assert.equal(s.execs[0].opts.timeout, 7);
  assert.equal(s.notes.at(-1).l, "error");
  assert.match(s.notes.at(-1).m, /boom/);
  assert.equal(s.entries[0].d.exitCode, 1);
  assert.equal(s.entries[0].d.stderrTail, "a\nboom");
});

test("exec throwing still appends entry; busy flag resets", async () => {
  const s = setup(async () => {
    throw new Error("spawn fail");
  });
  await s.cmd.handler("an", s.ctx);
  assert.equal(s.entries[0].d.exitCode, -1);
  assert.match(s.entries[0].d.stderrTail, /spawn fail/);
  await s.cmd.handler("an", s.ctx);
  assert.equal(s.execs.length, 2);
});

test("busy flag blocks concurrent run", async () => {
  let release;
  const s = setup(() => new Promise((r) => (release = () => r({ stdout: "x", stderr: "", code: 0 }))));
  const first = s.cmd.handler("an", s.ctx);
  await s.cmd.handler("an2", s.ctx);
  assert.equal(s.execs.length, 1);
  assert.match(s.notes.at(-1).m, /already running/);
  assert.equal(s.notes.at(-1).l, "warning");
  release();
  await first;
  assert.equal(s.entries.length, 1);
});

test("list, unknown script, missing dir do not exec", async () => {
  const s = setup(async () => ({ stdout: "", stderr: "", code: 0 }));
  await s.cmd.handler("list", s.ctx);
  assert.match(s.notes.at(-1).m, /report \(default\)/);
  await s.cmd.handler("zzz", s.ctx);
  assert.equal(s.notes.at(-1).l, "warning");
  await s.cmd.handler("an " + path.join(agentDir, "missing"), s.ctx);
  assert.match(s.notes.at(-1).m, /not found/);
  assert.equal(s.execs.length, 0);
  assert.equal(s.entries.length, 0);
});

test("argument completions", () => {
  const s = setup(async () => ({}));
  const c = s.cmd.getArgumentCompletions;
  assert.deepEqual(c("sim").map((i) => i.value), ["sim3", "sim4"]);
  assert.ok(c("").some((i) => i.value === "list"));
  assert.equal(c("zz"), null);
  assert.equal(c("report "), null);
  assert.deepEqual(c("rep").map((i) => i.value), ["report"]);
});

test("html: runs report_html.py, opens last stdout line, entry shows path", async () => {
  rmSync(path.join(agentDir, "usage-stats.json"), { force: true });
  const html = path.join(agentDir, "report.html");
  writeFileSync(html, "<html></html>");
  const opened = [];
  const s = setup(async () => ({ stdout: `working...
${html}

`, stderr: "", code: 0 }), { open: (p) => opened.push(p) });
  await s.cmd.handler("html", s.ctx);
  assert.deepEqual(s.execs[0].args, [path.join(DEFAULT_CONFIG.scriptsDir, "report_html.py"), agentDir]);
  assert.deepEqual(opened, [html]);
  assert.equal(s.entries[0].d.script, "html");
  assert.equal(s.entries[0].d.exitCode, 0);
  assert.equal(s.entries[0].d.output, `HTML レポートを開きました:
${html}`);
  assert.ok(!s.notes.some((n) => n.l === "error"));
});

test("html: failure or missing file does not open", async () => {
  const opened = [];
  const deps = { open: (p) => opened.push(p) };
  const f = setup(async () => ({ stdout: "", stderr: "boom", code: 1 }), deps);
  await f.cmd.handler("html", f.ctx);
  assert.equal(f.notes.at(-1).l, "error");
  assert.match(f.notes.at(-1).m, /boom/);
  assert.equal(f.entries.length, 1);
  const m = setup(async () => ({ stdout: path.join(agentDir, "nope.html"), stderr: "", code: 0 }), deps);
  await m.cmd.handler("html", m.ctx);
  assert.equal(m.notes.at(-1).l, "error");
  assert.match(m.notes.at(-1).m, /not found/);
  assert.equal(m.entries.length, 1);
  assert.deepEqual(opened, []);
});

test("openPath builds per-platform commands", () => {
  const calls = [];
  let unref = 0;
  const spawnFn = (cmd, args, opts) => (calls.push({ cmd, args, opts }), { on() {}, unref: () => unref++ });
  openPath("C:/r/a b.html", "win32", spawnFn);
  openPath("/r/a.html", "darwin", spawnFn);
  openPath("/r/a.html", "linux", spawnFn);
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [
    ["cmd.exe", ["/c", "start", "", "C:/r/a b.html"]],
    ["open", ["/r/a.html"]],
    ["xdg-open", ["/r/a.html"]],
  ]);
  for (const c of calls) assert.deepEqual(c.opts, { detached: true, stdio: "ignore", windowsHide: true });
  assert.equal(unref, 3);
  assert.equal(lastLine("a\n b \n\n"), "b");
  assert.equal(lastLine(""), "");
});
