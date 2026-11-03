/**
 * usage-stats: `/usage-stats [script] [dir]` runs the Python analysis scripts in
 * tools/usage-analysis/ against a session directory and shows the report in the transcript.
 * The output is stored with pi.appendEntry (a custom entry), so it is NOT sent to the LLM.
 * Place in ~/.pi/agent/extensions/usage-stats.ts and run /reload.
 *
 *   /usage-stats            -> report (readable summary: breakdown, 1h cache effect, sub savings, relay) on the current project's session dir
 *   /usage-stats an5        -> another script ("list" shows all)
 *   /usage-stats an2 <dir>  -> another session directory
 *   /usage-stats html [dir] -> chart HTML report (tools/usage-analysis/report_html.py), opened in the default browser
 *                              (set PI_USAGE_STATS_NO_OPEN=1 to only generate it)
 *
 * Optional config <agentDir>/usage-stats.json (read on every run):
 *   { "scriptsDir": "E:/Dev/TS/Pi/tools/usage-analysis", "python": "python", "timeoutMs": 120000 }
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

export const SCRIPTS: Record<string, string> = {
  report: "わかりやすいまとめ（内訳・1hキャッシュ効果・サブの節約・relay）",
  html: "グラフ付きHTMLレポートを生成してブラウザで開く（内訳・1hキャッシュ・サブ節約・サブスク使用率・relay）",
  an: "セッション別集計、よく読まれるファイル、着手前の文脈量",
  an2: "system prompt 内訳、bash 出力量、エラー分類",
  an3: "サブの初動の読込、画像数、文脈帯別コスト",
  an4: "ツール結果の「持ち越しコスト」推定 (tokens × 残りターン × cacheRead 単価)",
  an5: "コスト内訳、cacheWrite スパイクと直前ギャップ",
  sim3: "メインのキャッシュ方式比較 (1h TTL / idle warming / 失効前 compaction)",
  sim4: "疑似新規セッション (relay) の閾値別試算",
};
export const DEFAULT_SCRIPT = "report";
export const MAX_LINES = 300;
const ENTRY_TYPE = "usage-stats";

export interface Config { scriptsDir: string; python: string; timeoutMs: number }
export const DEFAULT_CONFIG: Config = { scriptsDir: "E:/Dev/TS/Pi/tools/usage-analysis", python: "python", timeoutMs: 120000 };

export type ParsedArgs =
  | { kind: "list" }
  | { kind: "error"; message: string }
  | { kind: "run"; script: string; dir?: string };

export function parseArgs(args: string): ParsedArgs {
  const [first, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const word = (first ?? DEFAULT_SCRIPT).toLowerCase();
  if (word === "list" || word === "help") return { kind: "list" };
  const script = word.replace(/\.py$/, "");
  if (!Object.hasOwn(SCRIPTS, script)) return { kind: "error", message: `unknown script "${first}" (try: ${Object.keys(SCRIPTS).join(", ")}, list)` };
  const dir = rest.join(" ").replace(/^"(.*)"$/, "$1");
  return { kind: "run", script, dir: dir || undefined };
}

export function parseConfig(raw: unknown): Config {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim() : d);
  const t = o.timeoutMs;
  return {
    scriptsDir: str(o.scriptsDir, DEFAULT_CONFIG.scriptsDir),
    python: str(o.python, DEFAULT_CONFIG.python),
    timeoutMs: typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_CONFIG.timeoutMs,
  };
}

function loadConfig(): Config {
  try {
    return parseConfig(JSON.parse(readFileSync(nodePath.join(getAgentDir(), "usage-stats.json"), "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function capOutput(output: string, max = MAX_LINES): { text: string; more: number } {
  const lines = output.replace(/\s+$/, "").split(/\r?\n/);
  if (lines.length <= max) return { text: lines.join("\n"), more: 0 };
  return { text: lines.slice(0, max).join("\n"), more: lines.length - max };
}

export function tail(text: string, n = 10): string {
  return text.replace(/\s+$/, "").split(/\r?\n/).slice(-n).join("\n");
}

/** Open a file with the OS default handler (detached, no window). spawnFn is injectable for tests. */
export function openPath(path: string, platform: string = process.platform, spawnFn: typeof spawn = spawn): void {
  const [cmd, args] =
    platform === "win32" ? ["cmd.exe", ["/c", "start", "", path]] as const
    : platform === "darwin" ? ["open", [path]] as const
    : ["xdg-open", [path]] as const;
  const child = spawnFn(cmd, [...args], { detached: true, stdio: "ignore", windowsHide: true });
  child.on?.("error", () => {});
  child.unref?.();
}

/** Last non-empty stdout line (report_html.py prints the absolute output path last). */
export function lastLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
}

export function listText(): string {
  return Object.entries(SCRIPTS).map(([k, v]) => `${k}${k === DEFAULT_SCRIPT ? " (default)" : ""}: ${v}`).join("\n");
}

interface StatsData { script: string; dir: string; exitCode: number | null; output: string; stderrTail: string; at: number }

export default function (pi: ExtensionAPI, deps: { open?: (path: string) => void } = {}) {
  const open = deps.open ?? ((p: string) => openPath(p));
  let busy = false;

  pi.registerEntryRenderer<StatsData>(ENTRY_TYPE, (entry, _opts, theme) => {
    const d = entry.data;
    if (!d) return undefined;
    const name = nodePath.basename(d.dir.replace(/[\/]+$/, "")) || d.dir;
    const { text, more } = capOutput(d.output);
    const body = [text, more ? theme.fg("dim", `… ${more} more lines`) : "", d.exitCode ? theme.fg("error", d.stderrTail) : ""].filter(Boolean).join("\n");
    const box = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
    box.addChild(new Text(theme.fg("accent", `usage-stats: ${d.script} — ${name} (exit ${d.exitCode})`), 0, 0));
    if (body) box.addChild(new Text(body, 0, 0));
    return box;
  });

  pi.registerCommand("usage-stats", {
    description: "Run a usage-analysis script (report = readable summary by default; 'list' shows all) and show the report",
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix)) return null;
      const items = [...Object.keys(SCRIPTS), "list"]
        .filter((k) => k.startsWith(prefix.toLowerCase()))
        .map((k) => ({ value: k, label: k, description: SCRIPTS[k] }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const p = parseArgs(args);
      if (p.kind === "list") return ctx.ui.notify(listText(), "info");
      if (p.kind === "error") return ctx.ui.notify(`usage-stats: ${p.message}`, "warning");
      if (busy) return ctx.ui.notify("usage-stats: already running", "warning");
      const dir = p.dir ?? ctx.sessionManager.getSessionDir();
      if (!dir || !existsSync(dir)) return ctx.ui.notify(`usage-stats: directory not found: ${dir}`, "warning");
      const cfg = loadConfig();
      const scriptPath = nodePath.join(cfg.scriptsDir, p.script === "html" ? "report_html.py" : `${p.script}.py`);
      busy = true;
      try {
        ctx.ui.notify(`usage-stats: running ${p.script} …`, "info");
        let data: StatsData;
        try {
          const r = await pi.exec(cfg.python, [scriptPath, dir], { timeout: cfg.timeoutMs });
          data = { script: p.script, dir, exitCode: r.code, output: r.stdout, stderrTail: tail(r.stderr), at: Date.now() };
        } catch (e) {
          data = { script: p.script, dir, exitCode: -1, output: "", stderrTail: String((e as Error)?.message ?? e), at: Date.now() };
        }
        if (p.script === "html" && data.exitCode === 0) {
          const htmlPath = lastLine(data.output);
          if (!htmlPath || !existsSync(htmlPath)) {
            data = { ...data, exitCode: -1, stderrTail: `HTML report not found: ${htmlPath || "(no path in output)"}` };
          } else {
            if (!process.env.PI_USAGE_STATS_NO_OPEN) {
              try { open(htmlPath); } catch (e) { ctx.ui.notify(`usage-stats: could not open browser: ${String((e as Error)?.message ?? e)}`, "warning"); }
            }
            data = { ...data, output: `HTML レポートを開きました:
${htmlPath}` };
          }
        }
        if (data.exitCode !== 0) ctx.ui.notify(`usage-stats: ${p.script} failed (exit ${data.exitCode})\n${data.stderrTail}`, "error");
        pi.appendEntry(ENTRY_TYPE, data);
      } finally {
        busy = false;
      }
    },
  });
}
