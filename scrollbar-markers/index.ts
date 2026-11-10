/**
 * Pi 1.x scrollbar markers: blue marks on the fullscreen transcript scrollbar at every user prompt and
 * white marks at every AI reply, like VS Code's search-result marks in the editor scrollbar.
 * Install: pi install npm:@sh1so6/pi-scrollbar-markers (or copy to ~/.pi/agent/extensions/<name>.ts and run /reload).
 *
 * Requirements:
 *   - fullscreen TUI ("tuiMode": "fullscreen"); the regular (main-screen) mode has no scrollbar.
 *   - The scrollbar must be visible. Pi's default "fullscreenScrollbar": "auto" only shows it for about
 *     a second while scrolling (the marks then show only during that time). Set
 *     "fullscreenScrollbar": "always" in ~/.pi/agent/settings.json to see the marks all the time.
 *     With "hidden" nothing is drawn.
 *
 * What it draws (rightmost column of the transcript):
 *   │  normal track row             ━  (blue) track row that contains the start of a user prompt
 *   ┃  normal thumb row             ┃  (blue) thumb row that contains the start of a user prompt
 *                                   ━  (white) track row that contains the start of an AI reply
 * A row that contains both a prompt start and a reply start is blue (user wins). AI reply starts on thumb
 * rows leave the thumb unchanged (the thumb is already light).
 * Content line L maps to track row floor(L * trackHeight / contentHeight) (VS Code style, proportional
 * to the whole transcript). Nothing is marked while the whole transcript fits on the screen.
 * The blue is the theme's "mdLink" color (blue in the built-in dark/light themes); if the theme cannot
 * be read, raw ANSI bright blue (94) is used. The white is raw ANSI bright white (97), independent of the
 * theme (the theme's "text" color is often just the terminal's default fg). On light themes / light
 * terminal backgrounds the white marks are hard to see: use "/scrollbar-markers ai off" there.
 *
 * Which assistant messages count as "AI replies" (isAssistantReply; easy to change): an
 * AssistantMessageComponent that rendered >= 1 line, has `hasToolCalls === false` (the final message of a
 * turn - the same messages Pi wraps in OSC 133 zones) and whose message has non-blank text. Not marked:
 * messages with tool calls (incl. the "let me check X" text before a tool call), thinking-only messages,
 * error/abort-only messages without text. While a message streams, Pi sets `hasToolCalls` only once the
 * first tool call arrives, so text streamed before a tool call is marked white for a moment; the mark goes
 * away with the next render after the tool call shows up (marks are recomputed on every transcript render).
 *
 * /scrollbar-markers [on|off|toggle|status]   all marks (not persisted: every Pi start / /reload begins "on")
 * /scrollbar-markers ai [on|off|toggle]        AI reply marks only (user marks unaffected)
 *
 * How it works (no public API exists for this, see "Relies on internals"):
 *   1. UserMessageComponent.prototype.render and AssistantMessageComponent.prototype.render are wrapped to
 *      report the first line they return plus a kind (user prompt / AI reply / other assistant message).
 *      The output is returned unchanged (OSC 133 prompt markers are untouched).
 *   2. ScrollView.prototype.updateLayout is wrapped. The layout engine calls it once per frame for every
 *      ScrollView; the first time it runs for a `primary` ScrollView (Pi's transcript), that instance gets
 *      a) its content child's render() wrapped (own property): while the transcript renders, the
 *         first lines reported by step 1 are collected in render order, then the returned line array is
 *         scanned once for them -> line indices of user prompts and AI replies. Equal first lines (every
 *         AI reply starts with OSC 133;A + a blank line, and so does e.g. a thinking-only message) are
 *         matched first-in-first-out per text, so each line gets the kind of the component that rendered
 *         it. The lines are returned as is.
 *      b) its scrollbarTrackStyle / scrollbarThumbStyle wrapped: pi-tui's paintScrollbar calls them once
 *         per track row, top to bottom; a per-frame row counter (reset in updateLayout) tells which row
 *         is being painted, and marked rows get the blue / white glyph. The thumb/track kind of every call
 *         is checked against the thumb geometry recomputed with pi-tui's formula; on any mismatch (or row
 *         count overflow) marking stops for that frame and the original glyphs are used.
 *   Everything is restored on session_shutdown (if nothing else wrapped the same functions on top in the
 *   meantime; otherwise the wrappers become pass-through). The install is reference counted and guarded by
 *   a Symbol.for() key on globalThis, so /reload never stacks wrappers.
 *
 * Cost: per frame O(transcript lines) for one scan that finds prompts and replies together, with a cheap
 * prefix test (only lines starting with OSC 133;A are looked up in a Map) - the transcript is re-rendered
 * every frame by Pi anyway - plus O(trackHeight) for the marks. Measured with scrollbar-markers.test.mjs
 * (~20k lines, 400 prompts + 400 replies, desktop CPU): scan ~0.14 ms; the wrapped transcript render
 * (reporting + scan) costs ~0.35 ms more than the plain one, within ~0.03 ms of the user-only version.
 * With "ai off" assistant messages are not reported at all. No component tree walk.
 *
 * Limitations:
 *   - Relies on pi-tui / Pi internals (ScrollView fields `primary`, `child`, `scrollbarTrackStyle`,
 *     `scrollbarThumbStyle`; paintScrollbar calling the style functions once per row in row order;
 *     the thumb geometry formula; User/AssistantMessageComponent rendering their lines unchanged into the
 *     transcript; the private AssistantMessageComponent fields `hasToolCalls` and `lastMessage`).
 *     If any of those change, marks are silently skipped (the scrollbar falls back to normal).
 *   - The transcript is found on its first layout after loading; one extra frame is requested then.
 *   - The marked row is where the message's first rendered line (its top padding / blank line) starts.
 *   - Only UserMessageComponent prompts are marked (not skill-invocation blocks, bash "!" commands or
 *     queued/pending messages that are not in the transcript yet) and only AssistantMessageComponent
 *     replies (not custom-message renderers).
 *   - If the transcript is clipped at the top (never in Pi's layout) the row counter could be offset;
 *     the thumb/track consistency check catches most such cases.
 */
import {
  AssistantMessageComponent,
  UserMessageComponent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ScrollView } from "@earendil-works/pi-tui";

/** OSC 133;A prompt-zone start that Pi prefixes to user messages and assistant replies. */
const OSC133_A = "\x1b]133;A";
const TRACK_MARK = "\u2501"; // ━  same box-drawing block (and terminal width) as pi-tui's │ ┃
const FALLBACK_BLUE_OPEN = "\x1b[94m";
const FALLBACK_BLUE_CLOSE = "\x1b[39m";
/** AI reply mark on track rows: ANSI bright white (97), visibly white on dark themes. */
const AI_TRACK_MARK = `\x1b[97m${TRACK_MARK}\x1b[39m`;
const INSTALL_KEY = Symbol.for("pi.scrollbar-markers.install");
const EMPTY: readonly number[] = Object.freeze([]);

/** Kinds reported by the render wrappers (also the values of the per-row mark table). */
export const KIND_OTHER = 0;
export const KIND_USER = 1;
export const KIND_AI = 2;

export interface MessageStarts {
  /** Line indices of user prompt starts. */
  user: readonly number[];
  /** Line indices of AI reply starts. */
  ai: readonly number[];
}
const NO_STARTS: MessageStarts = Object.freeze({ user: EMPTY, ai: EMPTY });

type StyleFn = (text: string) => string;
type RenderFn = (width: number) => string[];
type LayoutFn = (contentHeight: number, viewportHeight: number, requestRender?: () => void) => void;
interface ColorTheme {
  fg(color: "mdLink", text: string): string;
}

/** The ScrollView members this extension touches (several are private / readonly in the d.ts). */
interface ScrollViewInternals {
  primary?: boolean;
  child?: { render?: RenderFn };
  readonly scrollTop: number;
  readonly scrollbar?: string;
  scrollbarTrackStyle: StyleFn;
  scrollbarThumbStyle: StyleFn;
}

interface Attached {
  sv: ScrollViewInternals;
  child: { render?: RenderFn };
  childHadOwnRender: boolean;
  childOwnRender: RenderFn | undefined;
  wrappedRender: RenderFn;
  origTrack: StyleFn;
  origThumb: StyleFn;
  wrappedTrack: StyleFn;
  wrappedThumb: StyleFn;
  /** Line indices of user prompt / AI reply starts in the latest transcript render. */
  starts: MessageStarts;
  /** Line count of the render `starts` belongs to (-1 = unknown). */
  startsLen: number;
  contentHeight: number;
  trackHeight: number;
  row: number;
  frameOk: boolean;
  thumbTop: number;
  thumbHeight: number;
  /** Per track row: KIND_OTHER (no mark), KIND_USER or KIND_AI. */
  rows: Uint8Array;
  requestRender: (() => void) | undefined;
}

/** First lines and kinds reported by the message render wrappers, in render order. */
interface Collected {
  texts: string[];
  kinds: number[];
}

interface Install {
  refs: number;
  active: boolean;
  /** All marks. */
  enabled: boolean;
  /** AI reply marks (only effective while `enabled`). */
  aiEnabled: boolean;
  /** Set when an AssistantMessageComponent without the expected private fields was seen. */
  aiFieldsMissing: boolean;
  theme: ColorTheme | undefined;
  /** Filled by the message render wrappers while a transcript render is running. */
  collecting: Collected | null;
  attached: Map<ScrollViewInternals, Attached>;
  undo: () => void;
}

/**
 * Which AssistantMessageComponent renders count as an "AI reply" (white mark). Current rule: rendered
 * >= 1 line, `hasToolCalls === false` (final message of a turn; Pi adds OSC 133 zones only to these) and
 * the message has non-blank text (skips thinking-only and error/abort-only messages). Fails closed: if
 * Pi renames `hasToolCalls` or `lastMessage` (private fields), nothing is marked (and the command's status
 * says so).
 */
export function isAssistantReply(component: unknown, lines: readonly string[]): boolean {
  if (lines.length === 0 || !component || typeof component !== "object") return false;
  const c = component as { hasToolCalls?: unknown; lastMessage?: { content?: unknown } };
  if (c.hasToolCalls !== false) return false;
  const content = c.lastMessage?.content;
  if (!Array.isArray(content)) return false;
  for (const part of content as unknown[]) {
    const p = part as { type?: unknown; text?: unknown } | null;
    if (p && p.type === "text" && typeof p.text === "string" && p.text.trim() !== "") return true;
  }
  return false;
}

/**
 * Line indices of message starts, by kind. `texts[i]` is the first line a message component rendered and
 * `kinds[i]` its kind (KIND_USER / KIND_AI / KIND_OTHER), in render order. Lines are matched in order,
 * first-in-first-out per distinct text, so equal first lines of different kinds are told apart by their
 * order; KIND_OTHER entries only consume their line. One O(lines) pass; when every marked text starts with
 * OSC 133;A, only lines with that prefix are looked up.
 */
export function findMessageStarts(
  lines: readonly string[],
  texts: readonly string[],
  kinds: readonly number[],
): MessageStarts {
  const queues = new Map<string, { kinds: number[]; next: number }>();
  let remaining = 0;
  let oscOnly = true;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    const kind = kinds[i] ?? KIND_OTHER;
    const queue = queues.get(text);
    if (queue) queue.kinds.push(kind);
    else queues.set(text, { kinds: [kind], next: 0 });
    if (kind !== KIND_OTHER) {
      remaining++;
      if (oscOnly && !text.startsWith(OSC133_A)) oscOnly = false;
    }
  }
  if (remaining === 0) return NO_STARTS;
  const user: number[] = [];
  const ai: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (oscOnly && (line.charCodeAt(0) !== 0x1b || !line.startsWith(OSC133_A))) continue;
    const queue = queues.get(line);
    if (!queue || queue.next >= queue.kinds.length) continue;
    const kind = queue.kinds[queue.next++]!;
    if (kind === KIND_OTHER) continue;
    if (kind === KIND_USER) user.push(i);
    else ai.push(i);
    if (--remaining === 0) break;
  }
  return { user, ai };
}

/** Line indices whose text equals one of the user-message first lines. O(lines). */
export function findUserStarts(lines: readonly string[], firsts: readonly string[]): readonly number[] {
  if (firsts.length === 0) return EMPTY;
  return findMessageStarts(lines, firsts, firsts.map(() => KIND_USER)).user;
}

/** Thumb geometry exactly as pi-tui's getScrollbarGeometry computes it (relative to the track). */
export function thumbGeometry(contentHeight: number, trackHeight: number, scrollTop: number): { top: number; height: number } {
  const minThumbHeight = Math.min(2, trackHeight);
  const height = Math.max(minThumbHeight, Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)));
  const maxScrollTop = Math.max(0, contentHeight - trackHeight);
  const maxThumbTop = trackHeight - height;
  const top = maxScrollTop === 0 ? 0 : Math.round((scrollTop / maxScrollTop) * maxThumbTop);
  return { top, height };
}

/** Track row of content line `line`. */
export function rowOfLine(line: number, contentHeight: number, trackHeight: number): number {
  return Math.min(trackHeight - 1, Math.floor((line * trackHeight) / contentHeight));
}

function blue(state: Install, text: string): string {
  const theme = state.theme;
  if (theme) {
    try {
      return theme.fg("mdLink", text);
    } catch {
      // theme not initialized / replaced: fall back to raw ANSI
    }
  }
  return `${FALLBACK_BLUE_OPEN}${text}${FALLBACK_BLUE_CLOSE}`;
}

/** First style call of a frame: compute thumb geometry and marked rows. False = do not mark this frame. */
function prepareFrame(state: Install, entry: Attached): boolean {
  const { contentHeight, trackHeight } = entry;
  if (trackHeight <= 0 || contentHeight <= trackHeight) return false;
  const user = entry.starts.user;
  const ai = state.aiEnabled ? entry.starts.ai : EMPTY;
  if (entry.startsLen !== contentHeight || (user.length === 0 && ai.length === 0)) return false;
  const thumb = thumbGeometry(contentHeight, trackHeight, entry.sv.scrollTop);
  entry.thumbTop = thumb.top;
  entry.thumbHeight = thumb.height;
  if (entry.rows.length !== trackHeight) entry.rows = new Uint8Array(trackHeight);
  else entry.rows.fill(KIND_OTHER);
  // AI first, then user: on a shared row the user (blue) mark wins.
  for (const line of ai) entry.rows[rowOfLine(line, contentHeight, trackHeight)] = KIND_AI;
  for (const line of user) entry.rows[rowOfLine(line, contentHeight, trackHeight)] = KIND_USER;
  return true;
}

function styleCall(state: Install, entry: Attached, thumb: boolean, text: string): string {
  const original = thumb ? entry.origThumb : entry.origTrack;
  if (!state.active || !state.enabled || !entry.frameOk) return original(text);
  try {
    const row = entry.row++;
    if (row === 0 && !prepareFrame(state, entry)) {
      entry.frameOk = false;
      return original(text);
    }
    const thumbRow = row >= entry.thumbTop && row < entry.thumbTop + entry.thumbHeight;
    if (row >= entry.trackHeight || thumbRow !== thumb) {
      // Calls do not line up with the expected rows (clipped track, changed internals): stop marking.
      entry.frameOk = false;
      return original(text);
    }
    const mark = entry.rows[row];
    if (mark === KIND_USER) return blue(state, thumb ? text : TRACK_MARK);
    // AI reply on a thumb row: the thumb stays as is.
    if (mark === KIND_AI && !thumb) return AI_TRACK_MARK;
    return original(text);
  } catch {
    entry.frameOk = false;
    return original(text);
  }
}

function attach(state: Install, sv: ScrollViewInternals): Attached | undefined {
  const child = sv.child;
  if (!child || typeof child.render !== "function") return undefined;
  if (typeof sv.scrollbarTrackStyle !== "function" || typeof sv.scrollbarThumbStyle !== "function") return undefined;
  const childHadOwnRender = Object.prototype.hasOwnProperty.call(child, "render");
  const childOwnRender = childHadOwnRender ? child.render : undefined;
  const entry = {
    sv,
    child,
    childHadOwnRender,
    childOwnRender,
    origTrack: sv.scrollbarTrackStyle,
    origThumb: sv.scrollbarThumbStyle,
    starts: NO_STARTS,
    startsLen: -1,
    contentHeight: 0,
    trackHeight: 0,
    row: 0,
    frameOk: false,
    thumbTop: 0,
    thumbHeight: 0,
    rows: new Uint8Array(0),
    requestRender: undefined,
  } as Omit<Attached, "wrappedRender" | "wrappedTrack" | "wrappedThumb"> as Attached;

  entry.wrappedRender = function (this: unknown, width: number): string[] {
    const render = childOwnRender ?? (Object.getPrototypeOf(child) as { render: RenderFn }).render;
    if (!state.active) return render.call(this, width);
    const previous = state.collecting;
    const collected: Collected = { texts: [], kinds: [] };
    state.collecting = collected;
    let lines: string[];
    try {
      lines = render.call(this, width);
    } finally {
      state.collecting = previous;
    }
    try {
      if (state.enabled && Array.isArray(lines)) {
        entry.starts = findMessageStarts(lines, collected.texts, collected.kinds);
        entry.startsLen = lines.length;
      } else {
        entry.starts = NO_STARTS;
        entry.startsLen = -1;
      }
    } catch {
      entry.starts = NO_STARTS;
      entry.startsLen = -1;
    }
    return lines;
  };
  entry.wrappedTrack = (text: string) => styleCall(state, entry, false, text);
  entry.wrappedThumb = (text: string) => styleCall(state, entry, true, text);
  child.render = entry.wrappedRender;
  sv.scrollbarTrackStyle = entry.wrappedTrack;
  sv.scrollbarThumbStyle = entry.wrappedThumb;
  state.attached.set(sv, entry);
  return entry;
}

function detach(entry: Attached): void {
  const { sv, child } = entry;
  if (child.render === entry.wrappedRender) {
    if (entry.childHadOwnRender) child.render = entry.childOwnRender;
    else delete child.render;
  }
  if (sv.scrollbarTrackStyle === entry.wrappedTrack) sv.scrollbarTrackStyle = entry.origTrack;
  if (sv.scrollbarThumbStyle === entry.wrappedThumb) sv.scrollbarThumbStyle = entry.origThumb;
}

function getInstall(): Install | undefined {
  const value = (globalThis as Record<symbol, unknown>)[INSTALL_KEY];
  return value && typeof value === "object" && (value as Install).active ? (value as Install) : undefined;
}

/** Patch the prototypes (once per process; reference counted). */
export function install(): Install {
  const existing = getInstall();
  if (existing) {
    existing.refs++;
    return existing;
  }
  const userProto = UserMessageComponent.prototype as unknown as { render: RenderFn };
  const assistantProto = AssistantMessageComponent.prototype as unknown as { render: RenderFn };
  const layoutProto = ScrollView.prototype as unknown as { updateLayout: LayoutFn };
  const origUserRender = userProto.render;
  const origAssistantRender = assistantProto.render;
  const origUpdateLayout = layoutProto.updateLayout;

  const state: Install = {
    refs: 1,
    active: true,
    enabled: true,
    aiEnabled: true,
    aiFieldsMissing: false,
    theme: undefined,
    collecting: null,
    attached: new Map(),
    undo: () => {},
  };

  const patchedUserRender = function (this: unknown, width: number): string[] {
    const lines = origUserRender.call(this, width);
    const collecting = state.collecting;
    if (collecting !== null && state.active && Array.isArray(lines) && typeof lines[0] === "string") {
      collecting.texts.push(lines[0]);
      collecting.kinds.push(KIND_USER);
    }
    return lines;
  };
  const patchedAssistantRender = function (this: unknown, width: number): string[] {
    const lines = origAssistantRender.call(this, width);
    const collecting = state.collecting;
    // With AI marks off nothing is reported (user first lines never equal assistant first lines: the
    // user's carries the message background), so the scan does no AI work.
    if (collecting !== null && state.active && state.aiEnabled && Array.isArray(lines) && typeof lines[0] === "string") {
      let kind = KIND_OTHER;
      try {
        const c = this as { hasToolCalls?: unknown; lastMessage?: unknown };
        if (typeof c.hasToolCalls !== "boolean" || !c.lastMessage) state.aiFieldsMissing = true;
        if (isAssistantReply(this, lines)) kind = KIND_AI;
      } catch {
        // unexpected component shape: not a reply
      }
      // Non-replies are reported too: their first line can equal a reply's (e.g. thinking-only messages).
      collecting.texts.push(lines[0]);
      collecting.kinds.push(kind);
    }
    return lines;
  };
  const patchedUpdateLayout = function (
    this: ScrollViewInternals,
    contentHeight: number,
    viewportHeight: number,
    requestRender?: () => void,
  ): void {
    origUpdateLayout.call(this, contentHeight, viewportHeight, requestRender);
    if (!state.active || this.primary !== true) return;
    try {
      let entry = state.attached.get(this);
      if (!entry) {
        entry = attach(state, this);
        if (!entry) return;
        // This frame's content render ran before the wrapper existed: ask for one more frame so the
        // marks show up right away (async, outside the current render).
        if (typeof requestRender === "function") {
          const timer = setTimeout(() => {
            try {
              if (state.active) requestRender();
            } catch {
              // ignore
            }
          }, 0);
          timer.unref?.();
        }
      }
      entry.contentHeight = Math.max(0, Math.floor(contentHeight));
      entry.trackHeight = Math.max(0, Math.floor(viewportHeight));
      entry.row = 0;
      entry.frameOk = true;
      entry.requestRender = requestRender;
    } catch {
      // never break Pi's layout
    }
  };

  userProto.render = patchedUserRender;
  if (typeof origAssistantRender === "function") assistantProto.render = patchedAssistantRender;
  layoutProto.updateLayout = patchedUpdateLayout as unknown as LayoutFn;

  state.undo = () => {
    state.active = false;
    for (const entry of state.attached.values()) detach(entry);
    state.attached.clear();
    if (userProto.render === patchedUserRender) userProto.render = origUserRender;
    if (assistantProto.render === patchedAssistantRender) assistantProto.render = origAssistantRender;
    if (layoutProto.updateLayout === (patchedUpdateLayout as unknown as LayoutFn)) layoutProto.updateLayout = origUpdateLayout;
    const g = globalThis as Record<symbol, unknown>;
    if (g[INSTALL_KEY] === state) delete g[INSTALL_KEY];
  };
  (globalThis as Record<symbol, unknown>)[INSTALL_KEY] = state;
  return state;
}

/** Drop one reference; the last one restores everything. */
export function release(state: Install): void {
  if (!state.active) return;
  state.refs--;
  if (state.refs <= 0) state.undo();
}

function requestRenderAll(state: Install): void {
  for (const entry of state.attached.values()) {
    try {
      entry.requestRender?.();
    } catch {
      // ignore
    }
  }
}

export type MarkersArg = "on" | "off" | "toggle" | "status" | "ai-on" | "ai-off" | "ai-toggle";

export function parseMarkersArg(args: string | undefined): MarkersArg | undefined {
  const value = (args ?? "").trim().toLowerCase().split(/\s+/).join(" ");
  if (value === "") return "toggle";
  if (value === "on" || value === "off" || value === "toggle" || value === "status") return value;
  if (value === "ai" || value === "ai toggle") return "ai-toggle";
  if (value === "ai on") return "ai-on";
  if (value === "ai off") return "ai-off";
  return undefined;
}

const USAGE = "/scrollbar-markers [on|off|toggle|status] or /scrollbar-markers ai [on|off|toggle]";

export default function scrollbarMarkers(pi: ExtensionAPI): void {
  let state: Install | undefined;

  const ensure = (ctx: ExtensionContext): Install | undefined => {
    if (ctx.mode !== "tui") return undefined;
    if (!state || !state.active) state = install();
    try {
      state.theme = ctx.ui.theme as unknown as ColorTheme;
    } catch {
      state.theme = undefined;
    }
    return state;
  };

  pi.on("session_start", (_event, ctx) => {
    ensure(ctx);
  });

  pi.on("session_shutdown", () => {
    if (state) release(state);
    state = undefined;
  });

  pi.registerCommand("scrollbar-markers", {
    description: `Blue prompt / white AI-reply marks on the fullscreen scrollbar: ${USAGE}`,
    getArgumentCompletions: (prefix: string) =>
      ["on", "off", "toggle", "status", "ai on", "ai off", "ai toggle"]
        .filter((value) => value.startsWith(prefix.trimStart().toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const mode = parseMarkersArg(args);
      if (!mode) {
        ctx.ui.notify(`Use: ${USAGE}`, "warning");
        return;
      }
      const current = ensure(ctx);
      if (!current) {
        ctx.ui.notify("/scrollbar-markers needs the interactive TUI", "warning");
        return;
      }
      if (mode === "on") current.enabled = true;
      else if (mode === "off") current.enabled = false;
      else if (mode === "toggle") current.enabled = !current.enabled;
      else if (mode === "ai-on") current.aiEnabled = true;
      else if (mode === "ai-off") current.aiEnabled = false;
      else if (mode === "ai-toggle") current.aiEnabled = !current.aiEnabled;
      requestRenderAll(current);
      const entry = current.attached.values().next().value as Attached | undefined;
      const scrollbar = entry?.sv.scrollbar;
      let message = `Scrollbar markers ${current.enabled ? "on" : "off"} (AI replies ${current.aiEnabled ? "on" : "off"})`;
      if (!entry) message += " (fullscreen transcript not found yet; needs tuiMode \"fullscreen\")";
      else {
        message +=
          `, ${entry.starts.user.length} prompt(s) (blue), ${entry.starts.ai.length} AI reply(s) (white), ` +
          `scrollbar "${scrollbar ?? "?"}"`;
        if (scrollbar !== "always") message += ' - set "fullscreenScrollbar": "always" in settings.json to keep it visible';
      }
      if (current.aiFieldsMissing) message += " - AI reply detection unavailable (Pi internals changed)";
      ctx.ui.notify(message, "info");
    },
  });
}
