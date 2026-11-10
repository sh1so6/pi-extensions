/**
 * Pi 1.x "fold all" button: collapse / expand every AI response at once.
 * Install: pi install npm:@sh1so6/pi-fold-buttons (or copy to ~/.pi/agent/extensions/<name>.ts and run /reload).
 * Requires fullscreen TUI for mouse clicks.
 *
 * A one-line bar below the editor shows a single toggle button:
 *   [▾ 全て畳む]  when something is expanded  -> hides thinking blocks AND collapses tool outputs
 *                                                to the header only (see "Header-only tool frames")
 *   [▸ 全て展開]  when everything is collapsed -> shows thinking blocks AND expands tool outputs
 * /fold-all          toggle (same as clicking the button)
 * /fold-all on       collapse everything
 * /fold-all off      expand everything
 * /fold-all toggle   toggle
 *
 * Tool outputs use the public ctx.ui.getToolsExpanded()/setToolsExpanded() API.
 * Thinking blocks have no public API, so this walks the TUI component tree (only on
 * click/command/a few events, never in render) and calls the editor's
 * "app.thinking.toggle" action handler (identical to Ctrl+T: global + persisted to
 * settings.json). If that handler cannot be found it falls back to calling
 * setHideThinkingBlock() on every assistant message (not persisted) and warns once.
 * Per-message overrides (clicked individual blocks) are reset on every fold/unfold.
 *
 * Header-only tool frames:
 * Pi's collapsed tool view still shows a result preview (bash: last 5 lines, codemode: last calls +
 * 5 lines, read/grep/...: first lines). While "header-only" mode is on, a collapsed, finished tool
 * frame shows only its renderCall output (the colored box keeps its pending/success/error
 * background). It is implemented with the public pi.registerToolRenderer(): every tool whose
 * renderers use the default shell and have a renderResult gets a wrapper whose renderResult returns
 * an empty (0-line) component when header-only && !expanded && !isPartial; otherwise it renders
 * normally. So:
 *   - 全て畳む / /fold-all on   -> header-only ON  (+ tools collapsed)
 *   - 全て展開 / /fold-all off  -> header-only OFF (+ tools expanded, full output)
 *   - clicking a tool frame or Ctrl+O still expands it fully; collapsing it again goes back to the
 *     header only while the mode is on.
 *   - running tools (isPartial) keep their live streaming output.
 * Not wrapped: tools with renderShell "self" (they draw their own framing, e.g. edit's diff or
 * ask_advisor) and tools without renderResult (Pi's fallback text). Content drawn by renderCall
 * itself (codemode's script preview, write's file preview) is part of the header and stays.
 * The button shows [▸ 全て展開] only when thinking is hidden, tools are collapsed AND header-only is
 * on; e.g. right after a restart with thinking hidden it shows [▾ 全て畳む] (one click = header-only).
 * The mode is NOT persisted: it starts OFF on every Pi start and on /reload (normal previews until
 * the button is pressed). Its flag lives on globalThis so tool frames created by a previous load of
 * this extension follow the current state after /reload.
 * Cost: the wrapper adds an O(1) flag check per tool render (no tree walk in render). On toggle,
 * every tool frame is re-rendered once (O(n), click/command only).
 * HTML export (/export) resolves renderers through the same hook, so exporting while header-only is
 * on produces header-only "collapsed" views in the HTML (the expanded views are unaffected).
 *
 * Shared toolbar buttons:
 * Other extensions can add buttons to this bar (after the fold toggle) through a registry on
 * globalThis, without importing this file:
 *   const KEY = Symbol.for("pi.toolbar.buttons");
 *   const buttons = (globalThis[KEY] ??= new Map());   // Map<string, ToolbarButton>
 *   buttons.set("my-ext.action", { label: "[Do it]", order: 10, onClick: () => { ... } });
 *   buttons.delete("my-ext.action");                  // on session_shutdown
 * Buttons are drawn in accent color, sorted by `order` (default 0) then id, two spaces apart;
 * a button that does not fit the width is skipped. The registry is read on every render, so call
 * tui.requestRender() after changing it. onClick runs on a left click (press is claimed too); it is
 * not awaited, and a thrown error or rejected promise is reported via notify.
 */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const THINKING_TOGGLE_ACTION = "app.thinking.toggle";
const MAX_WALK_DEPTH = 64;

/** AssistantMessageComponent duck type (non-public Pi internals). */
export type ThinkingHost = { hideThinkingBlock: boolean; setHideThinkingBlock(hide: boolean): void };
/** Tool execution / bash / summary components (anything Pi treats as "expandable"). */
export type ExpandableHost = { setExpanded(expanded: boolean): void; expanded?: unknown; _expanded?: unknown };

export type FoldScan = {
  /** The editor's app.thinking.toggle handler (Ctrl+T), if found. */
  thinkingToggle?: () => void;
  /** Assistant message components (only the first one if `firstThinkingOnly`). */
  thinkingHosts: ThinkingHost[];
  /** Expandable components (empty if `firstThinkingOnly`). */
  expandables: ExpandableHost[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isThinkingHost(value: unknown): value is ThinkingHost {
  return (
    isObject(value) &&
    typeof value.hideThinkingBlock === "boolean" &&
    typeof value.setHideThinkingBlock === "function"
  );
}

export function isExpandableHost(value: unknown): value is ExpandableHost {
  return isObject(value) && typeof value.setExpanded === "function";
}

/** Returns the current expanded flag of an expandable, or undefined if it is not readable. */
export function expandedStateOf(host: ExpandableHost): boolean | undefined {
  if (typeof host.expanded === "boolean") return host.expanded;
  if (typeof host._expanded === "boolean") return host._expanded;
  return undefined;
}

function getThinkingToggle(value: Record<string, unknown>): (() => void) | undefined {
  const handlers = value.actionHandlers;
  if (!(handlers instanceof Map)) return undefined;
  const handler = handlers.get(THINKING_TOGGLE_ACTION);
  return typeof handler === "function" ? (handler as () => void) : undefined;
}

/**
 * Iterative DFS over a Pi component tree. Follows `children` arrays (Container/TUI)
 * and a `child` object (MouseRegion/ScrollView). Cycle-safe and depth-limited.
 * Does not descend into assistant messages or expandables (their insides are irrelevant).
 * With `firstThinkingOnly`, stops at the first assistant message and skips everything else.
 */
export function scanFoldTargets(root: unknown, options: { firstThinkingOnly?: boolean } = {}): FoldScan {
  const result: FoldScan = { thinkingHosts: [], expandables: [] };
  if (!isObject(root)) return result;
  const seen = new Set<object>();
  // Stack of [node, depth]; push children in reverse so traversal is in document order.
  const stack: Array<[Record<string, unknown>, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (isThinkingHost(node)) {
      result.thinkingHosts.push(node);
      if (options.firstThinkingOnly) return result;
      continue;
    }
    if (!options.firstThinkingOnly && !result.thinkingToggle) {
      const toggle = getThinkingToggle(node);
      if (toggle) result.thinkingToggle = toggle;
    }
    if (isExpandableHost(node)) {
      // Never descend into tool components (keeps the probe walk shallow too).
      if (!options.firstThinkingOnly) result.expandables.push(node);
      continue;
    }
    if (depth >= MAX_WALK_DEPTH) continue;

    const next: Record<string, unknown>[] = [];
    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) if (isObject(child)) next.push(child);
    }
    const single = node.child;
    if (isObject(single)) next.push(single);
    for (let i = next.length - 1; i >= 0; i--) stack.push([next[i], depth + 1]);
  }
  return result;
}

/** Reads hideThinkingBlock from a settings.json file; undefined if missing/invalid. */
export function readHideThinkingSetting(path: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (isObject(parsed) && typeof parsed.hideThinkingBlock === "boolean") return parsed.hideThinkingBlock;
  } catch {
    // Missing or malformed settings: fall through to the default.
  }
  return undefined;
}

/** Tool execution component duck type (ToolExecutionComponent: `toolName` + boolean `expanded`). */
export function isToolExecutionHost(host: ExpandableHost): boolean {
  return typeof (host as { toolName?: unknown }).toolName === "string" && typeof host.expanded === "boolean";
}

// ---- header-only tool frames ----

const HEADER_ONLY_KEY = Symbol.for("pi.fold-buttons.headerOnly");
type HeaderOnlyState = { on: boolean };

/**
 * Shared across reloads of this extension (globalThis), so wrappers held by tool components that
 * were created by an earlier load read the current value. Reset to OFF by every load.
 */
function headerOnlyState(): HeaderOnlyState {
  const store = globalThis as unknown as Record<symbol, HeaderOnlyState | undefined>;
  let state = store[HEADER_ONLY_KEY];
  if (!state) {
    state = { on: false };
    store[HEADER_ONLY_KEY] = state;
  }
  return state;
}

export function isHeaderOnly(): boolean {
  return headerOnlyState().on;
}

export function setHeaderOnly(on: boolean): void {
  headerOnlyState().on = on;
}

/**
 * 0-line stand-in for a hidden result. Remembers the component the real renderer returned, so the
 * real renderer keeps receiving its own `lastComponent` (read/grep/... expect a Text there).
 */
export class HeaderOnlyResult implements Component {
  readonly inner: unknown;
  constructor(inner: unknown) {
    this.inner = inner;
  }
  render(_width: number): string[] {
    return [];
  }
  invalidate(): void {}
}

type RenderResult = NonNullable<ToolRenderers["renderResult"]>;

/**
 * Wraps a tool's renderers so a finished, collapsed result renders as 0 lines while header-only
 * mode is on. Passes through undefined, "self"-shell renderers and renderers without renderResult.
 * The flag is read at render time (resolvers run once per tool component).
 */
export function wrapHeaderOnly(
  base: ToolRenderers | undefined,
  headerOnly: () => boolean = isHeaderOnly,
): ToolRenderers | undefined {
  if (!base || base.renderShell === "self" || !base.renderResult) return base;
  const renderResult = base.renderResult;
  const wrapped: RenderResult = (result, options, theme, context) => {
    const last = context.lastComponent;
    const real = last instanceof HeaderOnlyResult ? (last.inner as typeof last) : last;
    const ctx = real === last ? context : { ...context, lastComponent: real };
    if (!headerOnly() || options.expanded || options.isPartial) return renderResult(result, options, theme, ctx);
    // Still run the real renderer (side effects such as shared renderer state stay consistent and
    // its component is reused on expand), but show nothing below the header.
    let inner: unknown;
    try {
      inner = renderResult(result, options, theme, ctx);
    } catch {
      inner = undefined;
    }
    return new HeaderOnlyResult(inner);
  };
  return { ...base, renderResult: wrapped };
}

// ---- shared toolbar button registry ----

export type ToolbarButton = { label: string; order?: number; onClick: () => void };
export const TOOLBAR_BUTTONS_KEY = Symbol.for("pi.toolbar.buttons");

/** The shared registry on globalThis (created if missing). */
export function toolbarButtons(): Map<string, ToolbarButton> {
  const store = globalThis as unknown as Record<symbol, Map<string, ToolbarButton> | undefined>;
  let map = store[TOOLBAR_BUTTONS_KEY];
  if (!(map instanceof Map)) {
    map = new Map();
    store[TOOLBAR_BUTTONS_KEY] = map;
  }
  return map;
}

function isToolbarButton(value: unknown): value is ToolbarButton {
  return (
    isObject(value) &&
    typeof value.label === "string" &&
    !/[\r\n]/.test(value.label) &&
    typeof value.onClick === "function"
  );
}

/** Registered buttons sorted by order (default 0), then id. Invalid entries are ignored. */
export function sortedToolbarButtons(map: Map<string, unknown> = toolbarButtons()): Array<[string, ToolbarButton]> {
  const list: Array<[string, ToolbarButton]> = [];
  for (const [id, button] of map) if (isToolbarButton(button)) list.push([id, button]);
  const order = (b: ToolbarButton) => (typeof b.order === "number" && Number.isFinite(b.order) ? b.order : 0);
  return list.sort(([ida, a], [idb, b]) => order(a) - order(b) || (ida < idb ? -1 : ida > idb ? 1 : 0));
}

export type FoldMode = "on" | "off" | "toggle";

/** Parses /fold-all arguments. Empty means toggle; undefined means invalid. */
export function parseFoldArg(args: string): FoldMode | undefined {
  const value = args.trim().toLowerCase();
  if (value === "" || value === "toggle") return "toggle";
  if (value === "on" || value === "collapse" || value === "fold") return "on";
  if (value === "off" || value === "expand" || value === "unfold") return "off";
  return undefined;
}

export default function foldButtons(pi: ExtensionAPI) {
  let ctxNow: ExtensionContext | undefined;
  let tuiNow: TUI | undefined;
  /** First assistant message seen; its hideThinkingBlock mirrors the global state (O(1) read). */
  let thinkingProbe: ThinkingHost | undefined;
  /** Last thinking state we set ourselves (settings.json is written asynchronously). */
  let lastKnownHidden: boolean | undefined;
  /** Last handler found; still valid while the editor is temporarily replaced by a dialog. */
  let cachedToggle: (() => void) | undefined;
  let refreshScheduled = false;
  let warnedFallback = false;

  const settingsPath = join(getAgentDir(), "settings.json");

  // Header-only mode is not persisted: every start/reload begins with normal previews.
  setHeaderOnly(false);
  pi.registerToolRenderer((_toolName, next) => wrapHeaderOnly(next()));

  function thinkingHidden(): boolean {
    if (thinkingProbe) return thinkingProbe.hideThinkingBlock;
    if (lastKnownHidden !== undefined) return lastKnownHidden;
    return readHideThinkingSetting(settingsPath) ?? false;
  }

  /** Cached state used by render(): no tree walks, no file reads. */
  let hiddenCache = false;

  function isCollapsed(ctx: ExtensionContext): boolean {
    const hidden = thinkingProbe ? thinkingProbe.hideThinkingBlock : hiddenCache;
    return hidden && !ctx.ui.getToolsExpanded() && isHeaderOnly();
  }

  /** Cheap refresh: early-exit walk to the first assistant message. */
  function refreshProbe(): void {
    if (!tuiNow) return;
    try {
      thinkingProbe = scanFoldTargets(tuiNow, { firstThinkingOnly: true }).thinkingHosts[0];
    } catch {
      thinkingProbe = undefined;
    }
    hiddenCache = thinkingHidden();
    tuiNow.requestRender();
  }

  function scheduleRefresh(): void {
    if (refreshScheduled) return;
    refreshScheduled = true;
    setTimeout(() => {
      refreshScheduled = false;
      refreshProbe();
    }, 0);
  }

  function applyFold(collapse: boolean, ctx: ExtensionContext): void {
    const tui = tuiNow;
    if (!tui) {
      ctx.ui.notify("Fold: TUI not ready", "warning");
      return;
    }
    const hide = collapse;
    const expand = !collapse;
    try {
      const scan = scanFoldTargets(tui);
      if (scan.thinkingToggle) cachedToggle = scan.thinkingToggle;
      thinkingProbe = scan.thinkingHosts[0];

      // (a) Thinking blocks.
      const current = thinkingHidden();
      const toggle = scan.thinkingToggle ?? cachedToggle;
      if (current !== hide && toggle) {
        // Same as Ctrl+T: flips the global flag, persists it and resets every message.
        toggle();
      } else {
        if (current !== hide && !warnedFallback) {
          warnedFallback = true;
          ctx.ui.notify("Fold: Ctrl+T handler not found; thinking visibility changed for this view only", "warning");
        }
        // Already in the desired global state (or fallback): reset per-message overrides.
        for (const host of scan.thinkingHosts) host.setHideThinkingBlock(hide);
      }
      lastKnownHidden = hide;

      // (b) Tool outputs. Set the header-only flag first so the re-renders below use it.
      setHeaderOnly(collapse);
      if (ctx.ui.getToolsExpanded() !== expand) {
        // Pi calls setExpanded() on every expandable in the chat, re-rendering all tool frames.
        ctx.ui.setToolsExpanded(expand);
      } else {
        // Global flag already matches. Tool frames: always setExpanded() (it re-renders, which
        // applies/removes header-only). Others: reset individually toggled ones only.
        for (const host of scan.expandables) {
          const state = expandedStateOf(host);
          if (isToolExecutionHost(host) || (state !== undefined && state !== expand)) host.setExpanded(expand);
        }
      }
    } catch (error) {
      ctx.ui.notify(`Fold failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    hiddenCache = thinkingHidden();
    tui.requestRender();
  }

  /** `button` undefined = the fold toggle itself. */
  type Hit = { start: number; end: number; id?: string; button?: ToolbarButton };

  function runToolbarButton(id: string, button: ToolbarButton): void {
    const report = (error: unknown) => {
      try {
        ctxNow?.ui.notify(`${id}: ${error instanceof Error ? error.message : String(error)}`, "error");
      } catch {
        // Session gone; nothing to report to.
      }
    };
    try {
      const result: unknown = button.onClick();
      if (isObject(result) && typeof result.then === "function") {
        (result as unknown as PromiseLike<unknown>).then(undefined, report);
      }
    } catch (error) {
      report(error);
    }
  }

  /** visibleWidth per label (labels rarely change; keeps render cheap). */
  const widthCache = new Map<string, number>();
  function labelWidth(label: string): number {
    let width = widthCache.get(label);
    if (width === undefined) {
      if (widthCache.size > 64) widthCache.clear();
      width = visibleWidth(label);
      widthCache.set(label, width);
    }
    return width;
  }

  const BUTTON_GAP = "  ";

  class FoldBar implements Component {
    private hits: Hit[] = [];

    render(width: number): string[] {
      this.hits = [];
      const ctx = ctxNow;
      if (!ctx) return [""];
      const theme = ctx.ui.theme;
      const prefix = " Fold: ";
      const collapsed = isCollapsed(ctx);
      const label = collapsed ? "[▸ 全て展開]" : "[▾ 全て畳む]";
      const prefixWidth = labelWidth(prefix);
      const foldWidth = labelWidth(label);
      if (prefixWidth + foldWidth > width) return [""];
      this.hits.push({ start: prefixWidth, end: prefixWidth + foldWidth });
      let line = theme.fg("dim", prefix) + theme.fg("accent", label);
      let column = prefixWidth + foldWidth;
      const registry = (globalThis as unknown as Record<symbol, unknown>)[TOOLBAR_BUTTONS_KEY];
      if (registry instanceof Map && registry.size > 0) {
        const gapWidth = BUTTON_GAP.length;
        for (const [id, button] of sortedToolbarButtons(registry)) {
          const w = labelWidth(button.label);
          if (w === 0 || column + gapWidth + w > width) continue;
          const start = column + gapWidth;
          this.hits.push({ start, end: start + w, id, button });
          line += BUTTON_GAP + theme.fg("accent", button.label);
          column = start + w;
        }
      }
      return [line];
    }

    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.y !== 0 || event.button !== "left") return undefined;
      if (event.type !== "press" && event.type !== "click") return undefined;
      const hit = this.hits.find((h) => event.x >= h.start && event.x < h.end);
      if (!hit) return undefined;
      // Claim press, act only on click (release).
      if (event.type === "click") {
        if (hit.button) runToolbarButton(hit.id ?? "toolbar", hit.button);
        else if (ctxNow) applyFold(!isCollapsed(ctxNow), ctxNow);
      }
      return { handled: true };
    }

    invalidate(): void {
      this.hits = [];
    }
  }

  pi.on("session_start", (_event, ctx) => {
    ctxNow = ctx;
    thinkingProbe = undefined; // the chat is rebuilt for a new/resumed session
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      "fold-buttons",
      (tui) => {
        tuiNow = tui;
        scheduleRefresh(); // after the first render, outside render()
        return new FoldBar();
      },
      { placement: "belowEditor" },
    );
    scheduleRefresh();
  });
  // Pick up a probe once the first assistant message exists, and after chat rebuilds.
  // The walk stops at the first assistant message, so this is cheap.
  pi.on("agent_end", (_event, ctx) => {
    ctxNow = ctx;
    if (ctx.hasUI) scheduleRefresh();
  });
  pi.on("session_tree", (_event, ctx) => {
    ctxNow = ctx;
    thinkingProbe = undefined;
    scheduleRefresh();
  });
  pi.on("session_compact", (_event, ctx) => {
    ctxNow = ctx;
    thinkingProbe = undefined;
    scheduleRefresh();
  });

  pi.registerCommand("fold-all", {
    description: "Collapse (thinking hidden, tool frames header-only) / expand everything: /fold-all [on|off|toggle]",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off", "toggle"]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      ctxNow = ctx;
      const mode = parseFoldArg(args);
      if (!mode) {
        ctx.ui.notify("Use: /fold-all [on|off|toggle]", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/fold-all needs the interactive TUI", "warning");
        return;
      }
      if (mode === "toggle") refreshProbe();
      applyFold(mode === "on" ? true : mode === "off" ? false : !isCollapsed(ctx), ctx);
    },
  });
}
