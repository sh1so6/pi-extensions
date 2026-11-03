/**
 * pi-path-click: display-only clickable local file paths in Pi assistant messages.
 *
 * Install: ~/.pi/agent/extensions/path-click.ts (copy this file there)
 * Reload: /reload
 *
 * Optional environment variable:
 *   PI_PATH_CLICK_MODE=file   (default) use file:// URL to open actual file
 *   PI_PATH_CLICK_MODE=vscode use vscode://file URL (supports :line:column)
 *
 * Non-Windows-style paths (Windows only): `/E:/dir/file` is read as `E:/dir/file`;
 * `/mnt/e/...` (WSL) and `/e/...` (Git Bash) are tried too when the path as written does not exist.
 *
 * Missing paths -> Everything search (Windows, optional):
 *   When a path does not exist but a leading directory of it does (e.g. a file
 *   that was moved/renamed, or not created yet), it is linked to an Everything
 *   (voidtools) search for the file name inside that existing directory, as an
 *   `es:` URL. Prose such as `and/or` stays plain text because a link
 *   is only made when an existing directory strictly below the path's base
 *   (cwd for relative paths, ~ for ~/..., the drive/root for absolute paths) is found.
 *   Opening the link:
 *   - Fullscreen TUI, plain left click: Pi opens OSC 8 links itself; this extension
 *     hooks that (the renderer's openUrl) and starts `Everything.exe -url <es:...>`
 *     directly (a running Everything instance is reused). No protocol registration
 *     is needed. Other URLs (file:, https:, ...) still go to Pi's default opener.
 *   - Terminal's own link handling (e.g. Ctrl+click): needs Everything's
 *     "es: URL protocol" (Everything > Tools > Options > General).
 *   Everything.exe is located at load (install folders) and on each session start
 *   (also via the es: protocol's registry command, HKCR\ES), in this order:
 *     PI_EVERYTHING_EXE=<path to Everything.exe>   explicit location
 *     the es: protocol command (if registered)
 *     %ProgramFiles%\Everything\Everything.exe, %ProgramFiles(x86)%\Everything\Everything.exe,
 *     %ProgramFiles%\Everything 1.5a\Everything64.exe / Everything.exe,
 *     %LOCALAPPDATA%\Programs\Everything\Everything.exe
 *   es: links are created when Everything.exe is found or the protocol is registered:
 *   PI_PATH_CLICK_EVERYTHING=0  never create es: links (and no toolbar button)
 *   PI_PATH_CLICK_EVERYTHING=1  always create es: links (skip the check; any OS)
 *   (unset)                     auto-detect on Windows, off elsewhere
 *
 * Clipboard search button (fullscreen TUI, Everything.exe found, requires fold-buttons.ts):
 *   `[🔍 Everything]` in the Fold bar below the editor searches Everything for the
 *   current clipboard text as-is (newlines/tabs -> spaces, control characters removed,
 *   whitespace collapsed, max 1000 characters). It is registered in the shared toolbar
 *   registry (globalThis[Symbol.for("pi.toolbar.buttons")]) that fold-buttons.ts draws.
 *   The clipboard is read with pi-tui's native helper (falls back to PowerShell).
 *
 * Implementation note (click hook): extensions receive a Proxy over the current TUI
 * renderer; the real TuiAltScreen gets an own `openUrl` property that is a stable
 * trampoline (globalThis) calling the handler of the currently loaded module, so
 * /reload swaps the handler without stacking wrappers. The renderer's original openUrl
 * is kept on the renderer under Symbol.for("pi.path-click.originalOpenUrl"). The hook is
 * re-checked on session start, after each agent run and when assistant messages are
 * re-rendered (switching the TUI mode in /settings replaces the renderer and re-renders
 * everything). If the renderer has no function `openUrl` (non-fullscreen TUI) or cannot be
 * resolved, nothing is changed and Pi's default behavior stays.
 *
 * Terminal must support OSC 8 links and allow the chosen URL scheme
 * (file:/vscode:, and es: for the Everything feature).
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse, resolve, sep, win32 as pathWin32 } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// Namespace import: an older pi-tui without getNativeClipboard must not break loading.
import * as piTui from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

type Mode = "file" | "vscode";
interface LocatedPath {
  absolute: string;
  line?: number;
  column?: number;
}
export interface PartialPath {
  /** Deepest existing directory on the path (strictly below its base). */
  alive: string;
  /** Basename of the (missing) target. */
  name: string;
}
export interface TransformOptions {
  /** Link missing paths with an existing leading directory to an Everything search. */
  everything?: boolean;
}

const MAX_CHARS = 100_000;
const MAX_CHECKS = 100;
const MAX_CACHE = 1000;
const LINE_SUFFIX = /^(.*?)(?::([1-9]\d{0,7})(?::([1-9]\d{0,7}))?|#L([1-9]\d{0,7}))$/;
// Links/URLs must be protected before processing inline-code spans.
const EXISTING_LINKS_OR_URLS = /!?\[[^\]\r\n]*\]\((?:\\.|[^)\r\n])*\)|<[a-z][a-z0-9+.-]*:\/\/[^>\r\n]+>|[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|mailto:[^\s<>"']+/gi;
const INLINE_CODE = /(`+)([^`\r\n]*)\1/g;
// Bare paths should have an explicit root or slash. Simple filenames are handled in `code`.
const BARE_PATH = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/(?!\/)|[\p{L}\p{N}_@.$-]+[\\/])[^\s<>"'`|*?()\[\]{}]+/gu;

// throwIfNoEntry:false avoids the cost of building an Error for the common
// "missing" case; other failures (ENOTDIR, EACCES, ...) still throw.
function statPath(path: string): boolean {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    return !!stat && (stat.isDirectory() || stat.isFile());
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/**
 * Windows only: map non-Windows-style absolute paths onto drive paths.
 *   /E:/dir/file  (URL / file:// pathname style)  -> E:/dir/file   (always)
 *   /mnt/e/dir    (WSL)                           -> E:/dir        (loose)
 *   /e/dir        (Git Bash / MSYS)               -> E:/dir        (loose)
 * "loose" forms are ambiguous with real rooted paths, so callers try them only after the
 * original path was not found. Returns undefined when nothing applies. Pure; exported for tests.
 */
export function foreignToWindowsPath(value: string, loose = false, platform: string = process.platform): string | undefined {
  if (platform !== "win32") return;
  const strict = /^[\\/]([A-Za-z]):(?:[\\/](.*))?$/s.exec(value);
  if (strict) return `${strict[1].toUpperCase()}:/${strict[2] ?? ""}`;
  if (!loose) return;
  const loosely = /^\/(?:mnt\/)?([A-Za-z])(?:\/(.*))?$/s.exec(value);
  return loosely ? `${loosely[1].toUpperCase()}:/${loosely[2] ?? ""}` : undefined;
}

function parseExistingPath(raw: string, cwd: string): LocatedPath | undefined {
  const candidate = raw.trim();
  if (!candidate || candidate.length > 2048 || /[\0-\x1f]/.test(candidate)) return;
  if (/^(?:https?|file|mailto|vscode):/i.test(candidate)) return;

  const expand = (value: string): string => {
    if (value === "~") return homedir();
    if (value.startsWith("~/") || value.startsWith("~\\")) {
      return resolve(homedir(), value.slice(2));
    }
    const strict = foreignToWindowsPath(value);
    if (strict) return strict;
    return isAbsolute(value) ? value : resolve(cwd, value);
  };
  // Loose (WSL / MSYS) drive forms: only when the path as written does not exist.
  const expandLoose = (value: string): string | undefined => {
    const loose = foreignToWindowsPath(value, true);
    return loose && resolve(loose);
  };

  const absolute = expand(candidate);
  if (statPath(absolute)) return { absolute };
  const looseAbsolute = expandLoose(candidate);
  if (looseAbsolute && statPath(looseAbsolute)) return { absolute: looseAbsolute };

  // Only interpret line/column notation after checking the original path.
  // This allows legitimate filenames containing ':' on POSIX.
  const match = LINE_SUFFIX.exec(candidate);
  if (!match) return;
  let base = expand(match[1]);
  if (!statPath(base)) {
    const looseBase = expandLoose(match[1]);
    if (!looseBase || !statPath(looseBase)) return;
    base = looseBase;
  }
  return {
    absolute: base,
    line: Number(match[2] ?? match[4]),
    column: match[3] ? Number(match[3]) : undefined,
  };
}

// Re-renders re-run transformers; the upward walk costs several stats per path.
// Keyed by cwd + candidate; negative results are cached too.
const partialCache = new Map<string, PartialPath | undefined>();

/** Drop cached parsePartialPath results (session start, tests, benchmarks). */
export function clearPartialPathCache(): void {
  partialCache.clear();
}

/**
 * For a path that does not exist: find its deepest existing directory, which
 * must lie strictly below the path's base (absolute -> filesystem root,
 * ~/... -> home, relative -> cwd after any leading ./ and ../ segments).
 * Pure apart from filesystem stats; exported for tests.
 */
export function parsePartialPath(raw: string, cwd: string): PartialPath | undefined {
  const candidate = raw.trim();
  if (!candidate || candidate.length > 2048 || /[\0-\x1f]/.test(candidate)) return;
  // Any URL-ish scheme (2+ chars, so drive letters like C: are still allowed).
  if (/^[a-z][a-z0-9+.-]+:/i.test(candidate)) return;
  const key = cwd + "\0" + candidate;
  if (partialCache.has(key)) return partialCache.get(key);
  const result = findPartialPath(candidate, cwd);
  if (partialCache.size >= MAX_CACHE) partialCache.clear();
  partialCache.set(key, result);
  return result;
}

function findPartialPath(candidate: string, cwd: string): PartialPath | undefined {
  const rawPath = LINE_SUFFIX.exec(candidate)?.[1] ?? candidate;
  const path = foreignToWindowsPath(rawPath) ?? rawPath;
  if (!/[\\/]/.test(path)) return; // must look like a path
  // UNC / device paths: never stat (a network stat can hang).
  if (/^[\\/]{2}/.test(path)) return;

  let absolute: string;
  let boundary: string;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    boundary = resolve(homedir());
    absolute = resolve(boundary, path.slice(2));
  } else if (isAbsolute(path)) {
    absolute = resolve(path);
    boundary = parse(absolute).root;
  } else {
    const leading = /^(?:\.{1,2}[\\/]+)*/.exec(path)![0];
    boundary = resolve(cwd, leading || ".");
    absolute = resolve(cwd, path);
  }
  // UNC can also appear after resolution (e.g. a UNC cwd or home).
  if (/^[\\/]{2}/.test(absolute)) return;

  const name = basename(absolute);
  if (!name) return;
  const prefix = /[\\/]$/.test(boundary) ? boundary : boundary + sep;
  for (let dir = dirname(absolute); dir.length > prefix.length && dir.startsWith(prefix);) {
    if (isDirectory(dir)) return { alive: dir, name };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return;
}

function encodeUrlPart(value: string): string {
  return encodeURIComponent(value).replace(/[()]/g, (char) => char === "(" ? "%28" : "%29");
}

/** es: URL that makes Everything search `alive` for `name`. */
export function everythingUrl({ alive, name }: PartialPath): string {
  const dir = alive.replace(/"/g, "").replace(/[\\/]+$/, "") + sep;
  return "es:" + encodeUrlPart(`"${dir}" "${name.replace(/"/g, "")}"`);
}

function markdownLabel(str: string): string {
  return str.replace(/([\\\[\]])/g, "\\$1");
}

function urlForPath(location: LocatedPath, mode: Mode): string {
  const uri = pathToFileURL(location.absolute);
  if (mode === "vscode") {
    const suffix = location.line ? `:${location.line}:${location.column ?? 1}` : "";
    return `vscode://file${uri.pathname}${suffix}`.replace(/[()]/g, (char) =>
      char === "(" ? "%28" : "%29",
    );
  }
  return uri.href.replace(/[()]/g, (char) => char === "(" ? "%28" : "%29");
}

/** Pure output transformation; exported for the dependency-free Node tests. */
export function transformMarkdown(
  markdown: string,
  cwd: string,
  mode: Mode = "file",
  options: TransformOptions = {},
): string {
  if (!markdown || markdown.length > MAX_CHARS) return markdown;
  let checks = 0;
  let inFence: { marker: string; count: number } | undefined;

  /** URL for an existing path, else (if enabled) an Everything search URL. */
  function targetUrl(text: string): string | undefined {
    const reference = parseExistingPath(text, cwd);
    if (reference) return urlForPath(reference, mode);
    if (!options.everything) return;
    const partial = parsePartialPath(text, cwd);
    return partial && everythingUrl(partial);
  }

  function makeLink(text: string, code: boolean): string | undefined {
    if (++checks > MAX_CHECKS) return;
    const url = targetUrl(text);
    if (!url) return;
    const label = code ? `\`${text}\`` : markdownLabel(text);
    return `[${label}](${url})`;
  }

  function replaceBare(input: string): string {
    BARE_PATH.lastIndex = 0;
    return input.replace(BARE_PATH, (matched: string, offset: number) => {
      if (offset > 0 && /[\p{L}\p{N}_:\\/]/u.test(input[offset - 1])) return matched;
      // Punctuation after a path belongs to the sentence, not its target.
      const core = matched.replace(/[.,;:!]+$/, "");
      if (core.length < 2) return matched;
      return (makeLink(core, false) ?? core) + matched.slice(core.length);
    });
  }

  function replaceCodeAndBare(input: string): string {
    INLINE_CODE.lastIndex = 0;
    let out = "";
    let position = 0;
    for (const match of input.matchAll(INLINE_CODE)) {
      const start = match.index;
      out += replaceBare(input.slice(position, start));
      // Protect code styling, and support paths with spaces when code-quoted.
      const delimiters = match[1];
      const content = match[2];
      const wrapped = delimiters + content + delimiters;
      if (delimiters.length === 1 && !content.includes("`")) {
        const trim = content.trim();
        const found = makeLink(trim, true);
        out += found && trim === content ? found : wrapped;
      } else {
        out += wrapped;
      }
      position = start + match[0].length;
    }
    return out + replaceBare(input.slice(position));
  }

  function processLine(line: string): string {
    if (/^(?: {4}|\t)/.test(line)) return line; // indented code block
    EXISTING_LINKS_OR_URLS.lastIndex = 0;
    let out = "";
    let position = 0;
    for (const match of line.matchAll(EXISTING_LINKS_OR_URLS)) {
      out += replaceCodeAndBare(line.slice(position, match.index));
      // Local Markdown links need an absolute target too; ordinary URLs/images
      // remain untouched. Only rewrite simple, unambiguous Markdown links.
      const local = /^(\[[^\]\r\n]*\])\(([^\s()]+)\)$/.exec(match[0]);
      const target = local && ++checks <= MAX_CHECKS ? targetUrl(local[2]) : undefined;
      out += local && target ? `${local[1]}(${target})` : match[0];
      position = match.index + match[0].length;
    }
    return out + replaceCodeAndBare(line.slice(position));
  }

  // Preserve every original newline (including CRLF).
  return markdown.split(/(\r?\n)/).map((part) => {
    if (part === "\n" || part === "\r\n") return part;
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(part);
    if (inFence) {
      if (opening && opening[1][0] === inFence.marker &&
          opening[1].length >= inFence.count &&
          part.slice(opening[0].length).trim() === "") inFence = undefined;
      return part;
    }
    if (opening) {
      inFence = { marker: opening[1][0], count: opening[1].length };
      return part;
    }
    return processLine(part);
  }).join("");
}

// ---------------------------------------------------------------------------
// Everything (voidtools) launcher
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

export interface FindEverythingOptions {
  /** Environment (default process.env). */
  env?: Env;
  /** File existence check (default: statSync().isFile()). */
  exists?: (path: string) => boolean;
  /** Command line of the es: protocol (HKCR\ES\shell\open\command default value), if known. */
  registryCommand?: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** Expand %NAME% from `env` (case-insensitive like Windows); unknown names stay as is. */
function expandWindowsEnv(value: string, env: Env): string {
  return value.replace(/%([^%\s]+)%/g, (whole, name: string) => {
    if (env[name] !== undefined) return env[name]!;
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key !== undefined && env[key] !== undefined ? env[key]! : whole;
  });
}

/**
 * Executable path from a shell open command such as `"C:\...\Everything.exe" -url "%1"`
 * (quoted) or `C:\...\Everything.exe -url "%1"` (unquoted, cut after ".exe"). Pure; exported for tests.
 */
export function parseEsCommandExe(command: string | undefined, env: Env = process.env): string | undefined {
  if (!command) return;
  const trimmed = command.trim();
  let exe: string | undefined;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 1) exe = trimmed.slice(1, end);
  } else {
    exe = /^(.*?\.exe)(?=\s|$)/i.exec(trimmed)?.[1] ?? trimmed.split(/\s+/)[0];
  }
  if (!exe) return;
  exe = expandWindowsEnv(exe, env).trim();
  if (!exe || /[\0-\x1f"]/.test(exe) || !pathWin32.isAbsolute(exe)) return;
  return exe;
}

/**
 * The (default) value data from `reg query <key> /ve` output, e.g.
 * `    (既定)    REG_SZ    "C:\...\Everything.exe" -url "%1"`. REG_EXPAND_SZ is expanded.
 * Pure; exported for tests.
 */
export function parseRegQueryOutput(output: string, env: Env = process.env): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /\s(REG_SZ|REG_EXPAND_SZ)\s+(.*?)\s*$/.exec(line);
    if (!match || !match[2]) continue;
    return match[1] === "REG_EXPAND_SZ" ? expandWindowsEnv(match[2], env) : match[2];
  }
  return;
}

/** reg.exe writes in the OEM code page (CP932 here): UTF-8 if valid, else Shift_JIS, else latin1. */
export function decodeRegOutput(bytes: Uint8Array | string): string {
  if (typeof bytes === "string") return bytes;
  for (const encoding of ["utf-8", "shift_jis"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // Invalid for this encoding (or decoder unavailable): try the next one.
    }
  }
  return Buffer.from(bytes).toString("latin1");
}

/**
 * Locate Everything.exe (Windows). Order: PI_EVERYTHING_EXE, the es: protocol command,
 * then the usual install locations. Only paths that exist are returned. Exported for tests.
 */
export function findEverythingExe(options: FindEverythingOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const exists = options.exists ?? isFile;
  const candidates: Array<string | undefined> = [];
  const fromEnv = env.PI_EVERYTHING_EXE?.trim().replace(/^"(.*)"$/, "$1").trim();
  candidates.push(fromEnv || undefined);
  candidates.push(parseEsCommandExe(options.registryCommand, env));
  const under = (base: string | undefined, ...parts: string[]) => (base ? pathWin32.join(base, ...parts) : undefined);
  candidates.push(
    under(env.ProgramFiles, "Everything", "Everything.exe"),
    under(env["ProgramFiles(x86)"], "Everything", "Everything.exe"),
    under(env.ProgramFiles, "Everything 1.5a", "Everything64.exe"),
    under(env.ProgramFiles, "Everything 1.5a", "Everything.exe"),
    under(env.LOCALAPPDATA, "Programs", "Everything", "Everything.exe"),
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // Treat a failing check as "missing".
    }
  }
  return;
}

const SAFE_ES_URL = /^es:[A-Za-z0-9%._~!*'()-]*$/;
const MAX_ES_URL = 30_000; // CreateProcess command lines are limited to 32767 chars

/** Only already-percent-encoded es: URLs (no quotes, spaces, &, ...) are passed to Everything. */
export function isSafeEverythingUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= MAX_ES_URL && SAFE_ES_URL.test(url);
}

type SpawnLike = (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, "on" | "unref">;

export interface LaunchOptions {
  spawn?: SpawnLike;
  onError?: (error: unknown) => void;
}

/**
 * Start `Everything.exe -url <es:...>` (a running instance is reused by Everything itself).
 * Returns false (nothing started) for an invalid URL, no exe or a synchronous spawn failure.
 */
export function launchEverything(url: string, exe: string | undefined, options: LaunchOptions = {}): boolean {
  if (!exe || !isSafeEverythingUrl(url)) return false;
  const onError = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Reporting must never throw.
    }
  };
  try {
    const child = (options.spawn ?? spawn)(exe, ["-url", url], {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: false,
    });
    child.on("error", onError);
    child.unref();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

const MAX_QUERY = 1000;

/**
 * Clipboard text -> one-line Everything query: newlines/tabs become spaces, other control
 * characters are removed, whitespace is collapsed and trimmed, capped at 1000 UTF-16 units
 * (never splitting a surrogate pair). Pure; exported for tests.
 */
export function normalizeClipboardQuery(text: unknown): string {
  if (typeof text !== "string" || !text) return "";
  let value = text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text;
  value = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\0-\x1f\x7f-\x9f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length > MAX_QUERY) {
    value = value.slice(0, MAX_QUERY);
    if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
    value = value.trimEnd();
  }
  // Lone surrogates would make encodeURIComponent throw.
  const wellFormed = (value as { toWellFormed?: () => string }).toWellFormed;
  return typeof wellFormed === "function" ? wellFormed.call(value) : value.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

/** es: URL searching Everything for the (normalized) clipboard text; undefined if empty. */
export function clipboardSearchUrl(text: unknown): string | undefined {
  const query = normalizeClipboardQuery(text);
  return query ? "es:" + encodeUrlPart(query) : undefined;
}

const POWERSHELL_CLIPBOARD =
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](Get-Clipboard -Raw)))";

export interface ClipboardDeps {
  native?: () => { getText(): Promise<string | null | undefined> } | undefined;
  execFile?: typeof execFile;
}

/**
 * Clipboard text. Uses pi-tui's native clipboard helper (the one Pi uses for paste; no process
 * spawn), falling back to PowerShell (UTF-8 via base64, so the console code page cannot garble it).
 * Resolves "" / null for an empty clipboard; rejects if no reader works.
 */
export async function readClipboardText(deps: ClipboardDeps = {}): Promise<string | null> {
  try {
    const native =
      deps.native ??
      (piTui as { getNativeClipboard?: ClipboardDeps["native"] }).getNativeClipboard;
    const clipboard = typeof native === "function" ? native() : undefined;
    if (clipboard) {
      const text = await clipboard.getText();
      if (text !== undefined) return text;
    }
  } catch {
    // Native helper failed: fall back to PowerShell.
  }
  const run = deps.execFile ?? execFile;
  return new Promise((resolvePromise, reject) => {
    try {
      run(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_CLIPBOARD],
        { windowsHide: true, timeout: 5000, encoding: "utf8" },
        (error, stdout) => {
          if (error) return reject(error);
          const base64 = String(stdout).trim();
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return reject(new Error("unexpected PowerShell output"));
          resolvePromise(Buffer.from(base64, "base64").toString("utf8"));
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

/** Default value of HKCR\ES\shell\open\command (async; never throws). */
function queryEsProtocol(done: (registered: boolean, command?: string) => void): void {
  try {
    execFile(
      "reg",
      ["query", "HKCR\\ES\\shell\\open\\command", "/ve"],
      { windowsHide: true, timeout: 3000, encoding: "buffer" },
      (error, stdout) => {
        if (error) return done(false);
        let command: string | undefined;
        try {
          command = parseRegQueryOutput(decodeRegOutput(stdout));
        } catch {
          command = undefined;
        }
        done(true, command);
      },
    );
  } catch {
    done(false);
  }
}

// ---------------------------------------------------------------------------
// Plain click in fullscreen: hook the TUI's openUrl
// ---------------------------------------------------------------------------

/** The renderer's own openUrl, saved on the renderer itself (survives /reload, never our trampoline). */
export const ORIGINAL_OPEN_URL_KEY = Symbol.for("pi.path-click.originalOpenUrl");
const OPEN_URL_TRAMPOLINE_KEY = Symbol.for("pi.path-click.openUrlTrampoline");
const OPEN_URL_HANDLER_KEY = Symbol.for("pi.path-click.openUrlHandler");
const SELF_FN_KEY = Symbol.for("pi.path-click.selfFn");
const SELF_KEY = Symbol.for("pi.path-click.self");
const TOOLBAR_BUTTONS_KEY = Symbol.for("pi.toolbar.buttons");

/** `openOriginal` calls the renderer's original openUrl with the same URL. */
export type OpenUrlHandler = (url: string, openOriginal: () => void) => void;
type OpenUrl = (this: unknown, url: string) => unknown;
type Slots = Record<symbol, unknown>;
const slots = globalThis as unknown as Slots;

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

/** Stable function shared by all module instances (survives /reload). */
function getOpenUrlTrampoline(): OpenUrl {
  const existing = slots[OPEN_URL_TRAMPOLINE_KEY];
  if (typeof existing === "function") return existing as OpenUrl;
  let active = false;
  const trampoline: OpenUrl = function (this: unknown, url: string) {
    // Re-entered (e.g. another wrapper around us that was saved as "original"): stop the loop.
    if (active) return undefined;
    active = true;
    try {
      const self = this;
      const original = isObject(self) ? self[ORIGINAL_OPEN_URL_KEY] : undefined;
      const openOriginal = () => {
        if (typeof original === "function" && original !== trampoline) (original as OpenUrl).call(self, url);
      };
      const handler = slots[OPEN_URL_HANDLER_KEY];
      if (typeof handler === "function") (handler as OpenUrlHandler)(url, openOriginal);
      else openOriginal();
    } catch {
      // Never throw into the TUI's mouse handling.
    } finally {
      active = false;
    }
    return undefined;
  };
  slots[OPEN_URL_TRAMPOLINE_KEY] = trampoline;
  return trampoline;
}

function getSelfFn(): () => unknown {
  let fn = slots[SELF_FN_KEY];
  if (typeof fn !== "function") {
    fn = function (this: unknown) {
      return this;
    };
    slots[SELF_FN_KEY] = fn;
  }
  return fn as () => unknown;
}

/**
 * The real renderer behind `tui`. Pi passes extensions a Proxy over the current renderer
 * (createInteractiveTuiReference): its `set` writes to the renderer and every function read
 * through it is a bound wrapper. Calling a `function () { return this }` stored through the
 * proxy therefore returns the renderer itself. For a plain object this returns the object.
 */
export function resolveTuiInstance(tui: unknown): Record<PropertyKey, unknown> | undefined {
  if (!isObject(tui)) return;
  try {
    const host = tui as Record<PropertyKey, unknown>;
    const selfFn = getSelfFn();
    if (host[SELF_KEY] !== selfFn) host[SELF_KEY] = selfFn; // through the proxy: always "differs", same value
    const self = (host[SELF_KEY] as () => unknown)();
    return isObject(self) ? self : undefined;
  } catch {
    return;
  }
}

/**
 * Install the openUrl trampoline as an own property of the renderer, if it has a function
 * `openUrl` (only TuiAltScreen does). Idempotent: the original is saved only while the current
 * value is not our trampoline. Returns the renderer on success.
 */
export function installOpenUrlHook(tui: unknown): Record<PropertyKey, unknown> | undefined {
  const host = resolveTuiInstance(tui);
  if (!host) return;
  const current = host.openUrl;
  if (typeof current !== "function") return;
  const trampoline = getOpenUrlTrampoline();
  if (current !== trampoline) {
    host[ORIGINAL_OPEN_URL_KEY] = current;
    host.openUrl = trampoline;
  }
  return host;
}

/** Set the handler the trampoline calls (replaces the one of a previous load). */
export function setOpenUrlHandler(handler: OpenUrlHandler): void {
  slots[OPEN_URL_HANDLER_KEY] = handler;
}

/** Remove the handler only if it is `handler` (the trampoline then calls the original). */
export function clearOpenUrlHandler(handler: OpenUrlHandler): void {
  if (slots[OPEN_URL_HANDLER_KEY] === handler) delete slots[OPEN_URL_HANDLER_KEY];
}

type ToolbarButton = { label: string; order?: number; onClick: () => void };

function toolbarButtons(): Map<string, ToolbarButton> {
  let map = slots[TOOLBAR_BUTTONS_KEY];
  if (!(map instanceof Map)) {
    map = new Map();
    slots[TOOLBAR_BUTTONS_KEY] = map;
  }
  return map as Map<string, ToolbarButton>;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export const EVERYTHING_BUTTON_ID = "path-click.everything";
const PROBE_WIDGET = "path-click-probe";

/** Injection points for tests; the defaults are the real implementations. */
export interface PathClickDeps {
  platform?: NodeJS.Platform;
  env?: Env;
  /** Everything.exe lookup (registryCommand undefined = before/without the registry query). */
  findExe?: (registryCommand?: string) => string | undefined;
  /** Async es: protocol query. */
  queryEsProtocol?: (done: (registered: boolean, command?: string) => void) => void;
  launch?: (url: string, exe: string, onError: (error: unknown) => void) => boolean;
  readClipboard?: () => Promise<string | null | undefined>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPathClick(deps: PathClickDeps = {}) {
  return function pathClick(pi: ExtensionAPI): void {
    const env = deps.env ?? process.env;
    const platform = deps.platform ?? process.platform;
    const findExe = deps.findExe ?? ((registryCommand?: string) => findEverythingExe({ env, registryCommand }));
    const query = deps.queryEsProtocol ?? queryEsProtocol;
    const launch = deps.launch ?? ((url, exe, onError) => launchEverything(url, exe, { onError }));
    const readClipboard = deps.readClipboard ?? (() => readClipboardText());

    let cwd = process.cwd();
    const mode: Mode = env.PI_PATH_CLICK_MODE === "vscode" ? "vscode" : "file";
    const everythingEnv = env.PI_PATH_CLICK_EVERYTHING;
    // Install locations are cheap existsSync checks; the registry query runs async.
    let exe: string | undefined;
    try {
      exe = platform === "win32" ? findExe() : undefined;
    } catch {
      exe = undefined;
    }
    let protocol = false;
    let everything = false;
    let detection = 0;
    let ctxNow: ExtensionContext | undefined;
    /** What setWidget factories receive (Pi: a stable proxy over the current renderer). */
    let tuiRef: TUI | undefined;

    const computeEverything = () => {
      if (everythingEnv === "0") return false;
      if (everythingEnv === "1") return true;
      return platform === "win32" && (!!exe || protocol);
    };
    everything = computeEverything();

    function notify(message: string, type: "info" | "warning" | "error"): void {
      try {
        ctxNow?.ui.notify(message, type);
      } catch {
        // Session replaced/shut down meanwhile.
      }
    }
    const onLaunchError = (error: unknown) => notify(`Everything を起動できません: ${errorText(error)}`, "error");

    function requestRender(): void {
      try {
        tuiRef?.requestRender();
      } catch {
        // TUI gone.
      }
    }

    const openUrlHandler: OpenUrlHandler = (url, openOriginal) => {
      if (url.startsWith("es:") && exe && launch(url, exe, onLaunchError)) return;
      openOriginal();
    };

    function ensureHook(): void {
      if (!tuiRef) return;
      try {
        installOpenUrlHook(tuiRef);
      } catch {
        // Unknown renderer shape: plain click keeps Pi's default behavior.
      }
    }

    async function searchClipboard(): Promise<void> {
      ensureHook();
      const target = exe;
      if (!target) {
        notify("Everything が見つかりません (PI_EVERYTHING_EXE で指定できます)", "warning");
        return;
      }
      let text: string | null | undefined;
      try {
        text = await readClipboard();
      } catch (error) {
        notify(`クリップボードを読めません: ${errorText(error)}`, "error");
        return;
      }
      const url = clipboardSearchUrl(text);
      if (!url) {
        notify("クリップボードが空です", "warning");
        return;
      }
      if (!launch(url, target, onLaunchError)) notify("Everything を起動できません", "error");
    }

    const button: ToolbarButton = {
      label: "[🔍 Everything]",
      order: 100,
      onClick: () => void searchClipboard(),
    };

    function syncButton(): void {
      const ctx = ctxNow;
      const want = !!exe && everythingEnv !== "0" && !!ctx && ctx.mode === "tui" && ctx.hasUI;
      const map = toolbarButtons();
      let changed = false;
      if (want) {
        if (map.get(EVERYTHING_BUTTON_ID) !== button) {
          map.set(EVERYTHING_BUTTON_ID, button);
          changed = true;
        }
      } else if (map.get(EVERYTHING_BUTTON_ID) === button) {
        map.delete(EVERYTHING_BUTTON_ID);
        changed = true;
      }
      if (changed) requestRender();
    }

    function detect(): void {
      if (platform !== "win32") return;
      const id = ++detection;
      query((registered, command) => {
        if (id !== detection) return;
        protocol = registered;
        try {
          exe = findExe(command);
        } catch {
          // keep the previous result
        }
        everything = computeEverything();
        syncButton();
      });
    }

    function captureTui(ctx: ExtensionContext): TUI | undefined {
      let tui: TUI | undefined;
      try {
        ctx.ui.setWidget(PROBE_WIDGET, (t) => {
          tui = t;
          return { render: () => [], invalidate() {} };
        });
      } catch {
        // No widget support.
      } finally {
        try {
          ctx.ui.setWidget(PROBE_WIDGET, undefined);
        } catch {
          // ignore
        }
      }
      return tui;
    }

    detect();
    pi.on("session_start", (_event, ctx) => {
      cwd = ctx.cwd;
      ctxNow = ctx;
      clearPartialPathCache();
      if (ctx.mode === "tui" && ctx.hasUI) {
        tuiRef = captureTui(ctx);
        setOpenUrlHandler(openUrlHandler);
        ensureHook();
      }
      syncButton();
      detect();
    });
    // The renderer is replaced when the TUI mode changes (/settings); re-hook the new one.
    pi.on("agent_end", () => ensureHook());
    pi.on("session_shutdown", () => {
      detection++;
      clearOpenUrlHandler(openUrlHandler);
      ctxNow = undefined;
      syncButton(); // removes our button
      tuiRef = undefined;
    });
    pi.registerMarkdownTransformer((markdown, ctx) => {
      if (ctx.messageType !== "assistant" || ctx.isStreaming) return markdown;
      // Switching the TUI mode replaces the renderer and invalidates every component, so
      // assistant messages are re-rendered right away: re-hook a renderer not seen yet.
      // (One `in` check through Pi's proxy; no allocation.)
      if (tuiRef && !(SELF_KEY in tuiRef)) ensureHook();
      return transformMarkdown(markdown, cwd, mode, { everything });
    });
  };
}

export default createPathClick();
