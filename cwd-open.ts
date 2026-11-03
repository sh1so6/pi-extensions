/**
 * cwd-open: click the working-directory path on line 0 of Pi's built-in footer
 * to open it in Explorer (or another configured file manager).
 * Place in ~/.pi/agent/extensions/cwd-open.ts and run /reload.
 * Requires the fullscreen TUI for mouse clicks.
 *
 * Left click on the path  -> first (default) opener
 * Right click on the path -> menu of all configured openers
 * /open-cwd               -> default opener
 * /open-cwd <label>       -> opener by label (case-insensitive)
 * /open-cwd ?             -> menu of all configured openers
 *
 * Optional config in ~/.pi/agent/settings.json (read on every use):
 *   "cwdOpener": {
 *     "openers": [
 *       { "label": "Explorer", "command": "explorer.exe", "args": ["{path}"] },
 *       { "label": "VS Code", "command": "code", "args": ["{path}"], "shell": true }
 *     ]
 *   }
 * args defaults to ["{path}"]; "{path}" is replaced with the directory in every arg.
 * shell: true runs the command through the system shell (cmd.exe / sh). The path is
 * quoted, but the rest of the command line (and cmd.exe %VAR% expansion) is your
 * responsibility. Commands are spawned detached; on Windows a non-shell console program
 * gets its own console window (GUI programs such as Explorer are unaffected).
 * Without config: Explorer (win32), Finder via `open` (macOS), `xdg-open` (others).
 *
 * Implementation note: instead of replacing the footer (setFooter) this installs an
 * own `handleMouse` property on the existing built-in FooterComponent instance, so
 * the footer keeps rendering exactly as before. The installed function is a stable
 * trampoline that calls the handler currently stored on globalThis, so /reload swaps
 * the handler without stacking wrappers.
 *
 * Debug: PI_CWD_OPEN_DEBUG=1 notifies footer discovery and mouse events on line 0.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";

export type Opener = { label: string; command: string; args: string[]; shell: boolean };
type PathApi = Pick<typeof nodePath, "resolve" | "relative" | "isAbsolute" | "sep">;
type MouseHandler = (footer: FooterLike, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
type FooterLike = {
  render(width: number): string[];
  setAutoCompactEnabled(enabled: boolean): void;
  session?: { sessionManager?: { getCwd?: () => string } };
  footerData?: unknown;
  handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
};

const HANDLER_KEY = Symbol.for("pi.cwd-open.handler");
const TRAMPOLINE_KEY = Symbol.for("pi.cwd-open.trampoline");
const PROBE_WIDGET = "cwd-open-probe";
const DEBUG = process.env.PI_CWD_OPEN_DEBUG === "1";
const MAX_LABEL = 48;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Same logic as Pi's (non-exported) formatCwdForFooter: replace the home prefix with "~". */
export function formatCwd(cwd: string, home: string | undefined, p: PathApi = nodePath): string {
  if (!home) return cwd;
  const rel = p.relative(p.resolve(home), p.resolve(cwd));
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? "~" : `~${p.sep}${rel}`;
}

/** Remove OSC/DCS/PM/APC strings, CSI sequences and remaining two-byte ESC sequences. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "");
}

/**
 * Number of leading columns of the footer's pwd line that belong to the cwd.
 * `line0` may contain ANSI codes; `expected` is formatCwd(cwd, home).
 */
export function computeClickableWidth(line0: string, expected: string): number {
  const plain = stripAnsi(line0).replace(/\s+$/, "");
  if (expected && plain.startsWith(expected)) return visibleWidth(expected);
  // Truncated by the footer ("...") or formatted differently: take the visible prefix.
  const prefix = plain.endsWith("...") ? plain.slice(0, -3) : plain;
  return visibleWidth(prefix.replace(/\s+$/, ""));
}

export function defaultOpeners(platform: NodeJS.Platform): Opener[] {
  if (platform === "win32") return [{ label: "Explorer", command: "explorer.exe", args: ["{path}"], shell: false }];
  if (platform === "darwin") return [{ label: "Finder", command: "open", args: ["{path}"], shell: false }];
  return [{ label: "File manager", command: "xdg-open", args: ["{path}"], shell: false }];
}

/**
 * Validate the `cwdOpener` section of a parsed settings.json object.
 * Returns platform defaults only when settings or the key is absent; throws on invalid config.
 */
export function parseOpeners(settings: unknown, platform: NodeJS.Platform): Opener[] {
  if (settings === undefined) return defaultOpeners(platform);
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("settings.json: the root must be a JSON object");
  }
  const section = (settings as Record<string, unknown>).cwdOpener;
  if (section === undefined) return defaultOpeners(platform);
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error("cwdOpener must be an object with an openers array");
  }
  const entries = (section as Record<string, unknown>).openers;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("cwdOpener.openers must be a nonempty array");
  }
  const seen = new Set<string>();
  return entries.map((value: unknown, index: number): Opener => {
    const where = `cwdOpener.openers[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${where} must be an object`);
    }
    const item = value as Record<string, unknown>;
    for (const name of ["label", "command"] as const) {
      const field = item[name];
      if (typeof field !== "string" || !field.trim()) throw new Error(`${where}.${name} must be a nonempty string`);
    }
    const label = (item.label as string).trim();
    if (/[\x00-\x1f\x7f]/.test(label) || label.length > MAX_LABEL) {
      throw new Error(`${where}.label must be <= ${MAX_LABEL} characters without control characters`);
    }
    if (seen.has(label.toLowerCase())) throw new Error(`${where}.label is duplicated: ${label}`);
    seen.add(label.toLowerCase());
    let args = ["{path}"];
    if (item.args !== undefined) {
      if (!Array.isArray(item.args) || !item.args.every((a) => typeof a === "string")) {
        throw new Error(`${where}.args must be an array of strings`);
      }
      args = [...(item.args as string[])];
    }
    if (item.shell !== undefined && typeof item.shell !== "boolean") {
      throw new Error(`${where}.shell must be a boolean`);
    }
    return { label, command: (item.command as string).trim(), args, shell: item.shell === true };
  });
}

/** Normalize the directory for the platform and quote it when a shell will parse it. */
export function preparePath(dir: string, platform: NodeJS.Platform, shell: boolean): string {
  let value = dir;
  if (platform === "win32") {
    value = nodePath.win32.normalize(value);
    // "C:\foo\" -> "C:\foo" (a trailing backslash before a closing quote confuses some parsers); keep roots.
    if (value.length > 1 && /[\\]$/.test(value) && !/^[A-Za-z]:\\$/.test(value) && !/^\\\\[^\\]+\\[^\\]+\\$/.test(value)) {
      value = value.replace(/\\+$/, "");
    }
    if (!shell) return value; // Node/libuv quotes arguments for CreateProcess itself.
    // Windows paths cannot contain '"', so plain double quotes are enough for cmd.exe.
    // Double a trailing backslash (roots like C:\) so `\"` is not read as an escaped quote.
    // Note: cmd.exe still expands %VAR% inside quotes (shell mode is user responsibility).
    return `"${value.replace(/\\$/, "\\\\")}"`;
  }
  return shell ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}

/** Substitute "{path}" in every argument of the opener. */
export function buildArgs(opener: Pick<Opener, "args" | "shell">, dir: string, platform: NodeJS.Platform): string[] {
  const value = preparePath(dir, platform, opener.shell);
  return opener.args.map((arg) => arg.split("{path}").join(value));
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

function readSettings(): unknown {
  const file = nodePath.join(getAgentDir(), "settings.json");
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${file}: ${String(error)}`);
  }
  try {
    return JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${String(error)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFooter(value: unknown): value is FooterLike {
  const v = value as Record<string, unknown> | null;
  return (
    typeof v === "object" && v !== null &&
    typeof v.setAutoCompactEnabled === "function" &&
    typeof v.render === "function" &&
    v.footerData !== undefined && v.session !== undefined
  );
}

function findFooter(node: unknown, depth = 0): FooterLike | undefined {
  if (isFooter(node)) return node;
  if (depth >= 4 || typeof node !== "object" || node === null) return undefined;
  const children = (node as { children?: unknown }).children;
  if (!Array.isArray(children)) return undefined;
  for (const child of children) {
    const found = findFooter(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

type GlobalSlots = { [HANDLER_KEY]?: MouseHandler; [TRAMPOLINE_KEY]?: (this: FooterLike, e: TuiMouseEvent) => TuiMouseEventResult | undefined };
const slots = globalThis as unknown as GlobalSlots;

/** Stable function shared by all module instances (survives /reload). */
function getTrampoline() {
  let trampoline = slots[TRAMPOLINE_KEY];
  if (!trampoline) {
    trampoline = function (this: FooterLike, event: TuiMouseEvent) {
      const handler = slots[HANDLER_KEY];
      const result = handler?.(this, event);
      if (result) return result;
      // Fall through to a class-level handler if a future footer version adds one.
      const inherited = Object.getPrototypeOf(this)?.handleMouse;
      return typeof inherited === "function" ? inherited.call(this, event) : undefined;
    };
    slots[TRAMPOLINE_KEY] = trampoline;
  }
  return trampoline;
}

export default function cwdOpen(pi: ExtensionAPI) {
  let ctxNow: ExtensionContext | undefined;
  let footerNow: FooterLike | undefined;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Notify via the latest ctx; async callbacks must never touch a stale ctx or throw. */
  function notify(fallback: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
    try {
      (ctxNow ?? fallback).ui.notify(message, type);
    } catch {
      // Session was replaced/shut down meanwhile; nothing useful to report to.
    }
  }

  function loadOpeners(ctx: ExtensionContext): Opener[] | undefined {
    try {
      return parseOpeners(readSettings(), process.platform);
    } catch (error) {
      notify(ctx, `cwd-open: ${errorText(error)}`, "error");
      return undefined;
    }
  }

  function launch(opener: Opener, dir: string, ctx: ExtensionContext): void {
    const shown = process.platform === "win32" ? nodePath.win32.normalize(dir) : dir;
    try {
      const child = spawn(opener.command, buildArgs(opener, dir, process.platform), {
        detached: true,
        stdio: "ignore",
        shell: opener.shell,
        // Only hide the intermediate cmd.exe console; hiding a GUI app (e.g. Explorer)
        // can pass SW_HIDE to its first window.
        windowsHide: opener.shell,
      });
      child.once("spawn", () => notify(ctx, `Opened ${shown} with ${opener.label}`, "info"));
      // Exit codes are ignored (explorer.exe returns 1 on success).
      child.once("error", (error) => notify(ctx, `cwd-open: ${opener.label} failed: ${errorText(error)}`, "error"));
      child.unref();
    } catch (error) {
      notify(ctx, `cwd-open: ${opener.label} failed: ${errorText(error)}`, "error");
    }
  }

  async function chooseAndLaunch(openers: Opener[], dir: string, ctx: ExtensionContext): Promise<void> {
    const label = await ctx.ui.select("Open directory with", openers.map((o) => o.label));
    const opener = openers.find((o) => o.label === label);
    if (opener) launch(opener, dir, ctx);
  }

  function clickableWidth(footer: FooterLike, width: number, cwd: string): number {
    const line0 = footer.render(width)[0] ?? "";
    return computeClickableWidth(line0, formatCwd(cwd, process.env.HOME || process.env.USERPROFILE));
  }

  const handler: MouseHandler = (footer, event) => {
    if (event.y !== 0) return undefined;
    const ctx = ctxNow;
    if (!ctx) return undefined;
    if (event.type !== "press" && event.type !== "click") return undefined;
    if (event.button !== "left" && event.button !== "right") return undefined;
    if (event.shift) return undefined; // leave shift-click to selection
    let cwd: string;
    let clickable: number;
    try {
      cwd = footer.session?.sessionManager?.getCwd?.() ?? ctx.cwd;
      clickable = clickableWidth(footer, event.width, cwd);
    } catch (error) {
      if (DEBUG) notify(ctx, `cwd-open: hit test failed: ${errorText(error)}`, "warning");
      return undefined;
    }
    if (DEBUG) notify(ctx, `cwd-open: ${event.type} ${event.button} x=${event.x} y=${event.y} clickable<${clickable}`, "info");
    if (event.x < 0 || event.x >= clickable) return undefined;
    if (event.type === "press") return { handled: true };

    const openers = loadOpeners(ctx);
    if (!openers) return { handled: true };
    if (event.button === "left") {
      launch(openers[0]!, cwd, ctx);
    } else {
      chooseAndLaunch(openers, cwd, ctx).catch((error) => notify(ctx, `cwd-open: ${errorText(error)}`, "error"));
    }
    return { handled: true };
  };

  function captureTui(ctx: ExtensionContext): TUI | undefined {
    let tui: TUI | undefined;
    try {
      ctx.ui.setWidget(PROBE_WIDGET, (t) => {
        tui = t;
        return { render: () => [], invalidate() {} };
      });
    } finally {
      ctx.ui.setWidget(PROBE_WIDGET, undefined);
    }
    return tui;
  }

  function install(gen: number, attempt: number): void {
    retryTimer = undefined;
    const ctx = ctxNow;
    if (gen !== generation || !ctx) return;
    let footer: FooterLike | undefined;
    try {
      footer = findFooter(captureTui(ctx));
    } catch (error) {
      if (DEBUG) notify(ctx, `cwd-open: discovery error: ${errorText(error)}`, "warning");
    }
    if (!footer) {
      if (attempt < 3) {
        retryTimer = setTimeout(() => install(gen, attempt + 1), 200);
      } else {
        notify(ctx, "cwd-open: built-in footer not found (custom footer active?)", "warning");
      }
      return;
    }
    footerNow = footer;
    slots[HANDLER_KEY] = handler;
    footer.handleMouse = getTrampoline();
    if (DEBUG) notify(ctx, `cwd-open: footer found (attempt ${attempt + 1})`, "info");
  }

  pi.on("session_start", (_event, ctx) => {
    ctxNow = ctx;
    generation++;
    if (retryTimer) clearTimeout(retryTimer);
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    install(generation, 0);
  });

  pi.on("session_shutdown", () => {
    generation++;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    // Only tear down what this module instance installed.
    if (slots[HANDLER_KEY] === handler) {
      delete slots[HANDLER_KEY];
      if (footerNow && Object.prototype.hasOwnProperty.call(footerNow, "handleMouse") && footerNow.handleMouse === slots[TRAMPOLINE_KEY]) {
        delete footerNow.handleMouse;
      }
    }
    footerNow = undefined;
    ctxNow = undefined;
  });

  pi.registerCommand("open-cwd", {
    description: "Open the working directory: /open-cwd [label | ?]",
    handler: async (args, ctx) => {
      const openers = loadOpeners(ctx);
      if (!openers) return;
      const query = args.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
      if (!query) return launch(openers[0]!, ctx.cwd, ctx);
      if (query === "?") return chooseAndLaunch(openers, ctx.cwd, ctx);
      const opener = openers.find((o) => o.label.toLowerCase() === query.toLowerCase());
      if (!opener) {
        notify(ctx, `Unknown opener "${query}". Use: /open-cwd ${openers.map((o) => `"${o.label}"`).join(" | ")}`, "warning");
        return;
      }
      launch(opener, ctx.cwd, ctx);
    },
  });
}
