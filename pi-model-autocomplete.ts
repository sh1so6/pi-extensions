/**
 * Pi TUI inline model-name completion.
 *
 * Type `#` (or full-width `＃`) followed by part of a model name, e.g.
 * `#deep`, `#sonnet`, `#openai/gpt`, then pick a suggestion with Tab/Enter.
 * The token is replaced with the full `provider/model-id`, WITHOUT changing
 * Pi's active model. Works with pi-subagents because it only edits prompt text.
 *
 * The popup opens automatically when `#` follows the start of a line, a space,
 * a bracket or CJK punctuation. Directly after other text (e.g. `これを#deep`)
 * the editor does not auto-open it; press Tab to open it there.
 *
 * Settings (~/.pi/agent/settings.json, read on every lookup, no /reload needed):
 *   "modelAutocomplete": { "scopedOnly": true }
 *   scopedOnly: true  -> only scoped models (enabledModels / --models / /scoped-models);
 *                        falls back to all available models when no scope is set
 *   scopedOnly: false -> all models with configured credentials (default)
 *
 * Install: copy this file to ~/.pi/agent/extensions/pi-model-autocomplete.ts
 * Then run /reload in Pi.
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_SUGGESTIONS = 20;
const SETTINGS_PATH = join(getAgentDir(), "settings.json");

type Settings = { scopedOnly: boolean };
const DEFAULT_SETTINGS: Settings = { scopedOnly: false };

let cache: { mtimeMs: number; settings: Settings; error?: string } | undefined;

/** Read our namespaced key; cached by mtime so per-keystroke calls stay cheap. */
function readSettings(): { settings: Settings; error?: string } {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(SETTINGS_PATH).mtimeMs;
  } catch {
    return { settings: DEFAULT_SETTINGS }; // settings.json missing
  }
  if (cache?.mtimeMs === mtimeMs) return cache;

  let settings = DEFAULT_SETTINGS;
  let error: string | undefined;
  try {
    const root = JSON.parse(readFileSync(SETTINGS_PATH, "utf8").replace(/^\uFEFF/, ""));
    const section = root?.modelAutocomplete;
    if (section !== undefined) {
      if (typeof section !== "object" || section === null || Array.isArray(section)) {
        error = "modelAutocomplete must be an object";
      } else if (section.scopedOnly !== undefined && typeof section.scopedOnly !== "boolean") {
        error = "modelAutocomplete.scopedOnly must be true or false";
      } else {
        settings = { scopedOnly: section.scopedOnly ?? DEFAULT_SETTINGS.scopedOnly };
      }
    }
  } catch (e) {
    error = `Cannot parse ${SETTINGS_PATH}: ${String(e)}`;
  }
  cache = { mtimeMs, settings, error };
  return cache;
}

// `#query` right before the cursor. The negative lookbehind keeps ordinary
// ASCII words from triggering: `C#`, `page.html#anchor`, `a#b`, `&#123;`.
// CJK text directly before `#` is allowed (`これを#deep`).
const MODEL_TOKEN = /(?<![A-Za-z0-9_./:#&\-])([#＃])([^\s#＃]*)$/u;

type ModelCandidate = {
  provider: string;
  id: string;
  name?: string;
};

function matchScore(model: ModelCandidate, rawQuery: string): number {
  const query = rawQuery.toLowerCase();
  if (!query) return 0;

  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();
  const name = (model.name ?? "").toLowerCase();
  const full = `${provider}/${id}`;

  if (query === full || query === id) return 0;
  if (id.startsWith(query)) return 1;
  if (provider.startsWith(query)) return 2;
  if (full.startsWith(query)) return 3;
  if (name.startsWith(query)) return 4;
  if (id.includes(query)) return 5;
  if (full.includes(query)) return 6;
  if (name.includes(query)) return 7;
  return Number.POSITIVE_INFINITY;
}

export default function modelAutocomplete(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // Items we produced, so applyCompletion knows which completions are ours
    // without guessing from the prefix alone.
    const ownItems = new WeakSet<object>();
    let reportedError: string | undefined;

    const candidateModels = (): readonly ModelCandidate[] => {
      const { settings, error } = readSettings();
      if (error && error !== reportedError) {
        reportedError = error;
        ctx.ui.notify(`pi-model-autocomplete: ${error} (using defaults)`, "warning");
      }
      if (settings.scopedOnly) {
        try {
          const scoped = ctx.scopedModels.map((s) => s.model);
          // Same rule as Pi: no scope configured means every available model.
          if (scoped.length > 0) return scoped;
        } catch {
          // Stale context (session replaced); fall through to all available.
        }
      }
      return ctx.modelRegistry.getAvailable();
    };

    ctx.ui.addAutocompleteProvider((current) => ({
      // `#` is already a default editor trigger; add full-width `＃` for IME input.
      triggerCharacters: ["＃"],

      async getSuggestions(lines, line, col, options) {
        const beforeCursor = (lines[line] ?? "").slice(0, col);
        const match = MODEL_TOKEN.exec(beforeCursor);
        if (!match) return current.getSuggestions(lines, line, col, options);
        if (options.signal.aborted) return null;

        const prefix = match[1] + match[2];
        const query = match[2];
        const seen = new Set<string>();
        const items = candidateModels()
          .map((model) => ({
            model,
            value: `${model.provider}/${model.id}`,
            score: matchScore(model, query),
          }))
          .filter((item) => Number.isFinite(item.score) && !seen.has(item.value) && seen.add(item.value))
          .sort((a, b) => a.score - b.score || a.value.localeCompare(b.value))
          .slice(0, MAX_SUGGESTIONS)
          .map(({ model, value }) => {
            const item = {
              value,
              label: value,
              description: model.name && model.name !== model.id ? model.name : undefined,
            };
            ownItems.add(item);
            return item;
          });

        // No match (e.g. `#123` issue numbers): let other providers decide.
        if (!items.length) return current.getSuggestions(lines, line, col, options);
        return { prefix, items };
      },

      applyCompletion(lines, line, col, item, prefix) {
        if (!ownItems.has(item)) {
          return current.applyCompletion(lines, line, col, item, prefix);
        }

        // Replace only the `#query` token right before the cursor; keep the
        // rest of this line and all other lines.
        const original = lines[line] ?? "";
        const before = original.slice(0, col - prefix.length);
        const after = original.slice(col);
        const space = /^\s/.test(after) ? "" : " ";
        const replacement = `${item.value}${space}`;
        const updated = [...lines];
        updated[line] = before + replacement + after;
        return { lines: updated, cursorLine: line, cursorCol: before.length + replacement.length };
      },

      shouldTriggerFileCompletion(lines, line, col) {
        return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
      },
    }));
  });
}
