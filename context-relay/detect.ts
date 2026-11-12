/** Main vs subagent / headless detection: this extension must stay inert in subagent and one-shot sessions. */

// Run modes. "tui" and "rpc" are driven by a person or an RPC client: that is a main session.
// RPC DOES hand extensions a real UI context (ctx.hasUI is true there), so hasUI alone is not "interactive";
// ctx.mode says it explicitly and keeps this working if Pi ever changes what UI an RPC session gets.
const INTERACTIVE_MODES: ReadonlySet<string> = new Set(["tui", "rpc"]);
// One-shot modes. pi-subagents children are bound without a UI context, so Pi reports them as "print"
// (the default mode) with hasUI false: they land here without any naming convention.
const HEADLESS_MODES: ReadonlySet<string> = new Set(["print", "json"]);

export interface SessionShape {
  hasUI?: boolean;
  mode?: string;
}

/**
 * The session NAME is deliberately not consulted. A pi-subagents child keeps its `worker#<8hex>` name when a
 * person later resumes or takes over that session in the TUI; judging by name would switch relay / 1h cache off
 * for a session that is now the main one.
 */
export function isSubagentSession(ctx: SessionShape): boolean {
  if (typeof ctx.mode === "string") {
    if (INTERACTIVE_MODES.has(ctx.mode)) return false;
    if (HEADLESS_MODES.has(ctx.mode)) return true;
  }
  return !ctx.hasUI; // no / unknown mode (older Pi, test doubles): the original UI heuristic
}
