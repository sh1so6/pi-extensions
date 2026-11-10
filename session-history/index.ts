/**
 * session-history (launcher): `/history [stop|all|<project substring>]` runs the standalone `pi-history` app
 * (Rust, G:/Dev/Rust/pi-history) with the same arguments. All logic (scan, cache, server, UI) lives in the app;
 * this file only starts it and shows its output. Install: pi install npm:@sh1so6/pi-session-history (or copy to ~/.pi/agent/extensions/<name>.ts and run /reload).
 *
 * The exe is found via PI_HISTORY_EXE, then `pi-history` on PATH (e.g. ~/.pi/agent/bin), then
 * G:/Dev/Rust/pi-history/target/release/pi-history.exe. The app daemonizes itself, so Pi can exit independently
 * (stop it with `/history stop`, `pi-history stop`, or the STOP button in the page).
 *
 * `/history` with no arguments opens pre-filtered to the current project (cwd's last two path segments, same label as
 * pi-history's project name). Any argument is passed through unchanged (`/history all` = every project incl. sub-agents).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const FALLBACK_EXE = "G:/Dev/Rust/pi-history/target/release/pi-history.exe";

export function resolveExe(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (env.PI_HISTORY_EXE) return env.PI_HISTORY_EXE;
  // On PATH -> plain name (spawn resolves it); otherwise the dev build location.
  const dirs = (env.PATH ?? env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const d of dirs) {
    for (const n of ["pi-history.exe", "pi-history"]) if (exists(`${d}/${n}`) || exists(`${d}\${n}`)) return "pi-history";
  }
  return FALLBACK_EXE;
}

/** pi-history's project label for a cwd: last two path segments joined with "/" (scan.rs project_name); quoted if it has spaces. */
export function projectFilter(cwd: string | undefined): string {
  const name = (cwd ?? "").split(/[\\/]+/).filter(Boolean).slice(-2).join("/");
  return /\s/.test(name) ? `"${name}"` : name;
}

export function splitArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("history", {
    description: "過去セッション一覧をブラウザで開く（pi-history アプリを起動。引数なしは現在のプロジェクトで絞り込み） [stop|all|<プロジェクト>]",
    handler: async (args, ctx) => {
      const exe = resolveExe();
      const given = splitArgs(args ?? "");
      const argv = given.length ? given : [projectFilter((ctx as { cwd?: string }).cwd ?? process.cwd())].filter(Boolean);
      const out: string[] = [];
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(exe, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
          const timer = setTimeout(() => { child.kill(); }, 120_000);
          child.stdout?.on("data", (d) => out.push(String(d)));
          child.stderr?.on("data", (d) => out.push(String(d)));
          child.on("error", reject);
          child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
        });
        const text = out.join("").trim().split(/\r?\n/).slice(-3).join(" / ");
        ctx.ui.notify(`history: ${text || (code === 0 ? "ok" : `exit ${code}`)}`, code === 0 ? "info" : "warning");
      } catch (e) {
        ctx.ui.notify(`history: pi-history を起動できません (${exe}): ${String((e as Error)?.message ?? e)}`, "error");
      }
    },
  });
}
