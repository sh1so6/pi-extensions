/**
 * cmd-alias: short slash-command aliases, e.g. `/z` -> `/relay`.
 * Place in ~/.pi/agent/extensions/cmd-alias.ts and run /reload.
 *
 * Config (read when the extension loads): <agentDir>/cmd-alias.json
 *   { "aliases": { "z": "/relay", "z-pay": "/something --flag" } }
 * Missing/malformed file -> default { "z": "/relay" }. Invalid entries are ignored.
 * A target must be an extension command, prompt template or skill (`/skill:name`);
 * built-in commands (/compact, /model, ...) can't be aliased. Aliases may not point at
 * other aliases. Pick alias names that no other extension uses (duplicates get renamed).
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";

export const DEFAULT_ALIASES: Record<string, string> = { z: "/relay" };

/** "/relay foo" -> "relay"; non-slash text -> "". */
export function commandNameOf(text: string): string {
  const m = /^\/(\S*)/.exec(text.trim());
  return m ? m[1] : "";
}

export function buildForward(target: string, args: string): string {
  const a = args.trim();
  return a ? `${target} ${a}` : target;
}

/** raw: parsed JSON of the config file (anything). Returns alias name -> normalized target ("/cmd ..."). */
export function parseAliases(raw: unknown): Map<string, string> {
  const src = (raw as { aliases?: unknown } | null | undefined)?.aliases;
  const entries =
    src && typeof src === "object" && !Array.isArray(src) ? Object.entries(src) : Object.entries(DEFAULT_ALIASES);
  const out = new Map<string, string>();
  for (const [key, value] of entries) {
    if (typeof key !== "string" || typeof value !== "string") continue;
    const name = key.trim().replace(/^\//, "");
    if (!name || /[\s:/]/.test(name)) continue;
    let target = value.trim();
    if (!target.startsWith("/")) target = `/${target}`;
    if (!commandNameOf(target)) continue;
    out.set(name, target);
  }
  // Reject targets that are (or chain to) alias names, including self-references.
  const names = new Set(out.keys());
  for (const [name, target] of [...out]) if (names.has(commandNameOf(target))) out.delete(name);
  return out;
}

function loadAliases(): Map<string, string> {
  try {
    const text = readFileSync(nodePath.join(getAgentDir(), "cmd-alias.json"), "utf8");
    return parseAliases(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch {
    return parseAliases(undefined);
  }
}

export default function (pi: ExtensionAPI) {
  const aliases = loadAliases();

  for (const [name, target] of aliases) {
    pi.registerCommand(name, {
      description: `alias → ${target}`,
      handler: async (args, ctx) => {
        const targetName = commandNameOf(target);
        const known = pi.getCommands().some((c) => c.name === targetName && !aliases.has(c.name));
        if (!known) {
          ctx.ui.notify(
            `cmd-alias: /${targetName} is not an extension command, prompt template or skill (built-in commands can't be aliased)`,
            "warning",
          );
          return;
        }
        pi.sendUserMessage(buildForward(target, args), {
          expandPromptTemplates: true,
          ...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }),
        });
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      const clashes = new Set<string>();
      for (const c of pi.getCommands()) {
        const m = /^(.+):\d+$/.exec(c.name);
        if (m && aliases.has(m[1])) clashes.add(m[1]);
      }
      if (clashes.size > 0) {
        ctx.ui.notify(
          `cmd-alias: alias name(s) also used by another command: ${[...clashes].map((n) => `/${n}`).join(", ")}. Rename the alias in cmd-alias.json.`,
          "warning",
        );
      }
    } catch {
      // best effort
    }
  });
}
