/**
 * Pi 1.0 model/thinking quick-switch buttons.
 * Place in ~/.pi/agent/extensions/model-buttons.ts and run /reload.
 * Requires fullscreen TUI for mouse clicks.
 * /model-list: registered models with configured credentials
 * /model-list all: all registered models (including those without credentials)
 * /model-list <filter>: filter by provider, model ID or display name
 * /model-buttons-reload: reload modelButtons.presets from ~/.pi/agent/settings.json
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  visibleWidth,
  truncateToWidth,
  matchesKey,
  Key,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

type Thinking = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
type Preset = { label: string; provider: string; model: string; thinking: Thinking };

// Backward-compatible defaults if modelButtons.presets is absent from settings.json.
// Normal configuration belongs in ~/.pi/agent/settings.json (not this source file).
const DEFAULT_PRESETS: Preset[] = [
  { label: "Sol H", provider: "openai-codex", model: "gpt-6.1-sol", thinking: "high" },
  { label: "Sol M", provider: "openai-codex", model: "gpt-6.1-sol", thinking: "medium" },
  { label: "Luna L", provider: "openai-codex", model: "gpt-6-luna", thinking: "low" },
  { label: "Claude H", provider: "anthropic", model: "claude-opus-5-5", thinking: "high" },
];

type Hit = { start: number; end: number; preset: Preset };
const THINKING_LEVELS: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SETTINGS_PATH = join(getAgentDir(), "settings.json");

/** Read our namespaced custom key without overwriting unrelated Pi settings. */
function readPresets(): { presets: Preset[]; source: string } {
  let contents: string;
  try {
    contents = readFileSync(SETTINGS_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { presets: DEFAULT_PRESETS, source: "defaults (settings.json missing)" };
    }
    throw new Error(`Cannot read ${SETTINGS_PATH}: ${String(error)}`);
  }

  let settings: unknown;
  try {
    settings = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Invalid JSON in ${SETTINGS_PATH}: ${String(error)}`);
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error(`${SETTINGS_PATH}: the root must be a JSON object`);
  }
  const section = (settings as Record<string, unknown>).modelButtons;
  if (section === undefined) {
    return { presets: DEFAULT_PRESETS, source: "defaults (modelButtons not configured)" };
  }
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error("modelButtons must be an object with a presets array");
  }
  const entries = (section as Record<string, unknown>).presets;
  if (!Array.isArray(entries)) {
    throw new Error("modelButtons.presets must be an array");
  }

  const labels = new Set<string>();
  const presets = entries.map((value: unknown, index: number): Preset => {
    const where = `modelButtons.presets[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${where} must be an object`);
    }
    const item = value as Record<string, unknown>;
    for (const name of ["label", "provider", "model", "thinking"] as const) {
      if (typeof item[name] !== "string" || !item[name].trim()) {
        throw new Error(`${where}.${name} must be a nonempty string`);
      }
    }
    const label = (item.label as string).trim();
    if (/[\x00-\x1f\x7f]/.test(label) || label.length > 48) {
      throw new Error(`${where}.label must be <= 48 characters without control characters`);
    }
    const key = label.toLowerCase();
    if (labels.has(key)) throw new Error(`${where}.label is duplicated: ${label}`);
    labels.add(key);

    const thinking = (item.thinking as string).trim();
    if (!THINKING_LEVELS.includes(thinking as Thinking)) {
      throw new Error(`${where}.thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
    }
    return {
      label,
      provider: (item.provider as string).trim(),
      model: (item.model as string).trim(),
      thinking: thinking as Thinking,
    };
  });
  return { presets, source: SETTINGS_PATH };
}

export default function modelButtons(pi: ExtensionAPI) {
  let ctxNow: ExtensionContext | undefined;
  let tuiNow: TUI | undefined;
  let busy = false;
  let presets: Preset[] = DEFAULT_PRESETS;

  function reloadPresets(ctx: ExtensionContext, reportSuccess = false): void {
    try {
      const loaded = readPresets();
      presets = loaded.presets;
      if (reportSuccess) ctx.ui.notify(`Model buttons: ${presets.length} presets loaded (${loaded.source})`, "info");
      tuiNow?.requestRender();
    } catch (error) {
      // Keep the last good configuration if the edited JSON is malformed.
      ctx.ui.notify(`Model buttons: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function activate(preset: Preset, ctx?: ExtensionContext) {
    if (busy || !ctx) return;
    busy = true;
    try {
      const model = ctx.modelRegistry.find(preset.provider, preset.model);
      if (!model) {
        ctx.ui.notify(`Unknown model: ${preset.provider}/${preset.model}`, "error");
        return;
      }
      const ok = await pi.setModel(model);
      if (!ok) {
        ctx.ui.notify(`No credentials for ${preset.provider}/${preset.model}`, "error");
        return;
      }
      pi.setThinkingLevel(preset.thinking);
      ctx.ui.notify(`Switched to ${preset.label} (thinking: ${pi.getThinkingLevel()})`, "info");
      tuiNow?.requestRender();
    } catch (error) {
      ctx.ui.notify(`Switch failed: ${String(error)}`, "error");
    } finally {
      busy = false;
    }
  }

  class ButtonBar implements Component {
    private hits: Hit[] = [];
    constructor(private readonly tui: TUI) {}

    render(width: number): string[] {
      this.hits = [];
      const ctx = ctxNow;
      if (!ctx) return [""];

      const prefix = " Models: ";
      if (visibleWidth(prefix) >= width) return [""];
      let row = ctx.ui.theme.fg("dim", prefix);
      let cursor = visibleWidth(prefix);

      for (const preset of presets) {
        const label = `[${preset.label}]`;
        const segmentWidth = visibleWidth(label);
        // Hide buttons that cannot fully fit on the line.
        if (cursor + segmentWidth > width) break;
        const active =
          ctx.model?.provider === preset.provider &&
          ctx.model?.id === preset.model &&
          pi.getThinkingLevel() === preset.thinking;
        this.hits.push({ start: cursor, end: cursor + segmentWidth, preset });
        row += active
          ? ctx.ui.theme.bold(ctx.ui.theme.fg("accent", label))
          : ctx.ui.theme.fg("dim", label);
        cursor += segmentWidth;
        if (cursor < width) {
          row += " ";
          cursor += 1;
        }
      }
      return [row];
    }

    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.y !== 0 || event.button !== "left") return undefined;
      if (event.type !== "press" && event.type !== "click") return undefined;
      const hit = this.hits.find((button) => event.x >= button.start && event.x < button.end);
      if (!hit) return undefined;
      // Claim press, perform the switch only on click (release).
      if (event.type === "click") void activate(hit.preset, ctxNow);
      return { handled: true };
    }

    invalidate(): void {
      this.hits = [];
    }
  }

  pi.on("session_start", (_event, ctx) => {
    ctxNow = ctx;
    reloadPresets(ctx);
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      "model-buttons",
      (tui) => {
        tuiNow = tui;
        return new ButtonBar(tui);
      },
      { placement: "belowEditor" },
    );
  });
  pi.on("model_select", (_event, ctx) => {
    ctxNow = ctx;
    tuiNow?.requestRender();
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    ctxNow = ctx;
    tuiNow?.requestRender();
  });

  // Read-only, scrollable model catalog. Does not change the current model,
  // call a model, or inject anything into the conversation context.
  pi.registerCommand("model-list", {
    description: "List available models: /model-list [filter] | /model-list all [filter]",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/model-list needs interactive TUI mode (or use pi --list-models)", "warning");
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const showAll = parts[0]?.toLowerCase() === "all" || parts.includes("--all");
      const filter = parts
        .filter((part, i) => !(i === 0 && part.toLowerCase() === "all") && part !== "--all")
        .join(" ")
        .toLowerCase();

      const registryModels = showAll ? ctx.modelRegistry.getAll() : ctx.modelRegistry.getAvailable();
      const models = registryModels
        .filter((model) =>
          `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(filter),
        )
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        let offset = 0;
        const pageSize = () => Math.max(3, Math.min(22, tui.terminal.rows - 8));
        const maxOffset = () => Math.max(0, models.length - pageSize());

        return {
          render(width: number): string[] {
            const w = Math.max(1, width);
            const lines: string[] = [
              theme.fg("accent", truncateToWidth(
                `Models — ${showAll ? "all registered" : "available"} (${models.length}/${registryModels.length})`, w,
              )),
              theme.fg("dim", truncateToWidth(
                `Filter: ${filter || "(none)"}  |  * current  |  context window  |  reasoning`, w,
              )),
              "",
            ];
            const size = pageSize();
            offset = Math.max(0, Math.min(offset, maxOffset()));
            if (models.length === 0) {
              lines.push(theme.fg("warning", truncateToWidth("No matching models.", w)));
            } else {
              for (const model of models.slice(offset, offset + size)) {
                const current = ctx.model?.provider === model.provider && ctx.model?.id === model.id;
                const context = `${Math.round(model.contextWindow / 1000)}k`;
                const label = `${current ? "*" : " "} ${model.provider}/${model.id}  [${context}, ${model.reasoning ? "think" : "normal"}]`;
                const fitted = truncateToWidth(label, w);
                lines.push(current ? theme.fg("accent", fitted) : fitted);
              }
            }
            lines.push("");
            const start = models.length ? offset + 1 : 0;
            const end = Math.min(models.length, offset + size);
            lines.push(theme.fg("dim", truncateToWidth(
              `${start}-${end} / ${models.length}  |  ↑↓/j/k scroll  PgUp/PgDn pages  Esc/Enter/q close`, w,
            )));
            return lines;
          },
          invalidate() {},
          handleInput(data: string): void {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
              done();
              return;
            }
            const page = pageSize();
            if (matchesKey(data, Key.down) || data === "j") offset += 1;
            else if (matchesKey(data, Key.up) || data === "k") offset -= 1;
            else if (matchesKey(data, Key.pageDown)) offset += page;
            else if (matchesKey(data, Key.pageUp)) offset -= page;
            else if (matchesKey(data, Key.home)) offset = 0;
            else if (matchesKey(data, Key.end)) offset = maxOffset();
            else return;
            offset = Math.max(0, Math.min(maxOffset(), offset));
            tui.requestRender();
          },
        };
      });
    },
  });

  pi.registerCommand("model-buttons-reload", {
    description: "Reload quick-switch presets from ~/.pi/agent/settings.json",
    handler: async (_args, ctx) => reloadPresets(ctx, true),
  });

  // Fallback for terminals without mouse support: /model-button "Sol H"
  pi.registerCommand("model-button", {
    description: "Switch directly to a configured model/thinking preset",
    handler: async (args, ctx) => {
      const preset = presets.find((p) => p.label.toLowerCase() === args.trim().toLowerCase());
      if (!preset) {
        ctx.ui.notify(presets.length
          ? `Use: /model-button ${presets.map((p) => `"${p.label}"`).join(" | ")}`
          : "No model buttons configured in settings.json", "warning");
        return;
      }
      await activate(preset, ctx);
    },
  });
}
