/** Commits made since the session started (cwd + subagent worktrees). Failures just omit a section. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GitSection } from "./note.ts";

function git(dir: string, args: string[], timeout: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile("git", ["-C", dir, ...args], { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? undefined : stdout.trim()));
    } catch {
      resolve(undefined);
    }
  });
}

const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
const same = (a: string, b: string) => norm(a) === norm(b);

export async function collectGit(cwd: string, sinceIso: string | undefined, worktrees: string[], opts: { timeoutMs?: number; maxLines?: number } = {}): Promise<GitSection[]> {
  if (!sinceIso) return [];
  const timeout = opts.timeoutMs ?? 4000;
  const max = String(opts.maxLines ?? 15);
  const dirs = [cwd, ...worktrees.filter((w) => !same(w, cwd) && existsSync(w)).slice(0, 6)];
  const sections = await Promise.all(
    dirs.map(async (dir): Promise<GitSection | undefined> => {
      const log = await git(dir, ["log", `--since=${sinceIso}`, "--oneline", "--no-decorate", "-n", max], timeout);
      if (!log) return undefined;
      const branch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"], timeout);
      return { label: `${dir.replace(/\\/g, "/")}${branch ? ` [${branch}]` : ""}`, lines: log.split("\n") };
    }),
  );
  return sections.filter((s): s is GitSection => !!s);
}
