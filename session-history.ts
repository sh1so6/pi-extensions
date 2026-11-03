/**
 * session-history (launcher): `/history [stop|all|<project substring>]` runs the standalone `pi-history` app
 * (Rust, G:/Dev/Rust/pi-history) with the same arguments. All logic (scan, cache, server, UI) lives in the app;
 * this file only starts it and shows its output. Place in ~/.pi/agent/extensions/session-history.ts and run /reload.
 *
 * The exe is found via PI_HISTORY_EXE, then `pi-history` on PATH (e.g. ~/.pi/agent/bin), then
 * G:/Dev/Rust/pi-history/target/release/pi-history.exe. The app daemonizes itself, so Pi can exit independently.
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

export function splitArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("history", {
    description: "過去セッション一覧をブラウザで開く（pi-history アプリを起動） [stop|all|<プロジェクト>]",
    handler: async (args, ctx) => {
      const exe = resolveExe();
      const out: string[] = [];
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(exe, splitArgs(args ?? ""), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
