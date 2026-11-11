/** Main vs subagent / headless detection: this extension must stay inert in subagent and one-shot sessions. */

// The subagent naming contract is #<8 hex digits>, regardless of hexadecimal letter case.
export const SUBAGENT_NAME = /#[0-9a-f]{8}$/i;

// One-shot modes have no long-lived session worth keeping warm: the context dies with the process.
// The interactive family is "tui" | "rpc". Note that RPC DOES hand extensions a real UI context
// (ctx.hasUI is true there), so hasUI alone cannot express "interactive" — ctx.mode can, and it also
// keeps this working if Pi ever changes what UI an RPC session gets.
const HEADLESS_MODES: ReadonlySet<string> = new Set(["print", "json"]);

export interface SessionShape {
  hasUI?: boolean;
  mode?: string;
  sessionManager?: { getSessionName?: () => string | undefined };
}

export function isSubagentSession(ctx: SessionShape): boolean {
  let name: string | undefined;
  try {
    name = ctx.sessionManager?.getSessionName?.();
  } catch {
    name = undefined;
  }
  if (name && SUBAGENT_NAME.test(name)) return true; // pi-subagents children, whatever the mode
  if (typeof ctx.mode === "string" && ctx.mode !== "") return HEADLESS_MODES.has(ctx.mode);
  return !ctx.hasUI; // no mode reported (older Pi, test doubles): the original UI heuristic
}
