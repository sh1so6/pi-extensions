/** Subagent / headless detection: this extension must stay inert there. */

// The subagent naming contract is #<8 hex digits>, regardless of hexadecimal letter case.
export const SUBAGENT_NAME = /#[0-9a-f]{8}$/i;

export function isSubagentSession(ctx: { hasUI?: boolean; sessionManager?: { getSessionName?: () => string | undefined } }): boolean {
  if (!ctx.hasUI) return true; // print/json mode and pi-subagents sessions have no dialog-capable UI
  let name: string | undefined;
  try {
    name = ctx.sessionManager?.getSessionName?.();
  } catch {
    name = undefined;
  }
  return !!name && SUBAGENT_NAME.test(name);
}
