# @sh1so6/pi-context-relay

English | [日本語](README_ja.md)

A Pi extension that creates a **pseudo new session** instead of LLM-summarized compaction (M1: manual `/relay` and the `recall` tool; M2: automatic triggers).

- It replaces the history with a "deterministically generated handoff note" plus "the most recent exchanges". No LLM is used (zero cost, same result every time).
- Old raw logs (output of bash / read / codemode, etc.) **stay in the session file as they are**, so the model can fetch them with the `recall` tool only when needed.
- It is for the main (orchestrator) session only. In subagent / headless sessions — a session name ending in `…#<8 hex digits>` (the pi-subagents contract), or a one-shot mode (`ctx.mode` is `print` / `json`; `tui` and `rpc` count as main, since RPC does provide a UI context) — it does nothing (no tools or commands are registered, and handlers pass straight through).

## Installation

```bash
pi install npm:@sh1so6/pi-context-relay
```

The pre-expiry trigger (automatic B) assumes the 1h cache that `@sh1so6/pi-cache-ttl-main` attaches. Command aliases such as `/z` come from `@sh1so6/pi-cmd-alias`.

## Usage

| Action | Description |
|---|---|
| `/relay` | Run it while idle. It compacts via `ctx.compact()` and swaps in the result in `session_before_compact` |
| `recall({query, limit?, scope?})` | Searches past entries that have fallen out of context, case-insensitively with AND. Returns `entryId`, kind, time, and a ±200-character snippet (default 8 results, output capped at ~8k characters) |
| `recall({entryId, offset?})` | Returns the full text of that entry (in chunks of ~12k characters, with the next offset indicated). `note:<n>` reads a handoff note itself |

Compactions other than `/relay` (`/compact`, automatic compaction) are left alone, and Pi's default (or another extension) handles them as usual.
`/relay` calls compaction with a private marker in `customInstructions`, and the note is returned only when that marker is detected.

`recall` takes **either `query` or `entryId`** (if both are given, `entryId` wins). `limit` is clamped to 1–30 and `offset` to 0 or more; arguments of the wrong type are ignored.
Output is capped (8000 characters for search, ~12k characters for full text; the echoed query / entryId is also truncated).
Both the note and `recall` are based on the content **after `context_edit` has been applied (what the model actually sees)**. Omitted messages appear in neither the note nor search results (with `entryId` they show as "omitted"), and replaced messages use their replacement text.
It respects the `AbortSignal` of the compaction (cancellation) and leaves no note file behind when aborted.

## Context after compaction

`system` + the note (compaction summary) + **everything from the last user message onward**.
If the part from the last user message onward exceeds `tailMaxChars` (default 48000 characters) and Pi's default cut point is later, Pi's position is used.
If there is no user message, Pi's `preparation.firstKeptEntryId` is used.
`details` is `{ relay: true, version, notePath }`.

## Note contents (capped; total ≈ 6k tokens / 9500 characters)

1. User instructions (all of them since the previous relay / compaction boundary, oldest first. The newer ones are kept longer; older ones are shortened, then omitted. Instructions from the previous note are condensed to one line and concatenated)
2. The final answer **immediately before** the retained recent exchanges (the retained part already contains its own final answer, so it is not duplicated)
3. Subagents (from `subagents:record` / `subagent-notification` / `Agent` launch results. **RUNNING ones are shown at the very top**. id, type, description, state, worktree/branch, start of the result)
4. Changed files (the `path` of `edit` / `write`) and git commits since the session started (`git log --since` in the cwd and in any `…/worktrees/<name>` that appears in subagent results. With a timeout; omitted on failure)
5. Footer (how to use `recall` and the note path)

Storage location: `~/.pi/agent/context-relay/<sessionId>/<n>.md` (nothing is written to the project cwd).

## Automatic triggers (M2)

Both apply to the main (orchestrator) session only. They do nothing in subagent / headless sessions.

| Trigger | Condition | Behavior |
|---|---|---|
| A. On input | User input (`source` is `interactive` / `rpc`; `extension` is ignored, so no loop), while idle (no `streamingBehavior`), not starting with `/`, context ≥ `inputMinTokens` (default 100000) | Holds the input (`{action:"handled"}`) → relay → after it finishes, **resends the original text+images exactly once** with `pi.sendUserMessage`. The input is resent even if the relay fails or is cancelled (stated in the notification). Input that arrives during the relay is held and, after it finishes, merged into a single message (blank-line separated, order preserved) and sent |
| B. Before cache expiry | When the agent settles (`agent_settled`), the expiry is computed from the time of the last real request plus the TTL. The TTL is **provider-dependent, and used only when the lifetime is reliably known**: if the model declares `promptCache` (short / long seconds; the tier is chosen from `PI_CACHE_RETENTION` and the latest write's `usage.cacheWrite1h`, read the same way as Pi's cache warmer), that is used; otherwise Anthropic (`anthropic-messages`) gets 1 hour (`cacheWrite1h > 0`; `@sh1so6/pi-cache-ttl-main` attaches it to the main session) or 5 minutes. For models with unknown or best-effort lifetimes, such as DeepSeek's automatic disk cache or OpenAI without a `promptCache` declaration, no timer is set (and no notification or log is emitted). Trigger A is provider-independent. 20 seconds before expiry, while idle, with no pending message, and context ≥ `expiryMinTokens` (default 140000) | Relay only (no resend). The timer is cleared on `agent_start` / session switch / shutdown (and is `unref`'d). Nothing is timed when there is no cache activity or right after a relay |

Right after a relay, no automatic relay runs until the context has grown by at least `minGrowthTokens` (default 30000) (to prevent back-to-back relays when the retained part is large).
When an automatic relay completes, a one-line notification is shown (`context-relay: auto relay (new message) 152k → ~9k tokens`).
Every relay (manual and automatic) is appended, one line each, to `~/.pi/agent/context-relay/log.jsonl`:
`{at, sessionId, trigger: "manual"|"input"|"expiry", tokensBefore, noteChars, keptFrom, ok, error?}`.
Input held by a relay is re-sent right after a `context-relay:resend` audit entry in the session file (`custom` entry; never part of the model context). It fingerprints each held item (sha256 of its text), so an outside reader — e.g. an RPC client whose prompt was answered `handled` and therefore started no run — can pair the re-sent user message with the prompt that was held, deterministically instead of by timestamp.

## Configuration (optional) `~/.pi/agent/context-relay.json`

```json
{
  "enabled": true, "tailMaxChars": 48000, "gitTimeoutMs": 4000, "limits": { "total": 9500, "userMessages": 3000 },
  "auto": { "onInput": true, "inputMinTokens": 100000, "beforeExpiry": true, "expiryMinTokens": 140000, "minGrowthTokens": 30000 }
}
```

`auto` is read at `session_start` (no file / missing keys = defaults; values of the wrong type also fall back to defaults). To turn automatic triggers off, use `"auto": {"onInput": false, "beforeExpiry": false}`.

The keys of `limits` are those of `Limits` in `note.ts` (total / userMessages / userMessageEach / chain / answer / subagents / files / git / extra).

## Limitations

- When Pi's `prepareCompaction` decides compaction is not possible (the previous entry is a compaction, the history is too short, etc.), `/relay` also ends in an error notification.
- The RUNNING display is an inference from "a launch result exists but no completion record does" (agents lost when Pi restarted may remain; shown with the start time).
- Worktree detection is a heuristic on path strings of the form `…/worktrees/<name>`.
- `recall` covers only entries on the current branch (with `scope:"lineage"`, ancestors via `parentSession` too). Images appear as `[image]`.
- If Pi crashes during compaction, only the note file may be left behind (harmless).

## Tests

```
node --test context-relay/unit.test.mjs      # note / recall / detection / git
node --test context-relay/session.test.mjs   # E2E with a real Pi session + faux provider (verifies the next request's payload)
node --test context-relay/review.test.mjs    # context_edit is reflected; no note left behind on abort
node --test context-relay/auto.test.mjs      # E2E of the M2 automatic triggers (thresholds chosen from measurements; cache expiry verified by setting promptCache.short to a few seconds)
node --test context-relay/verification.test.mjs # independent verification: images / notification races / streaming / Pi automatic compaction / lifecycle / output caps
```

## Known limitations / unverified (M2)

- If another input reaches the input handler while one is held, the held inputs are merged into a single message (blank-line separated, order preserved). Merging with two images attached has been verified E2E against the faux provider's payload. However, Pi's own TUI compaction queue keeps only text/mode, and RPC prompts are rejected during compaction before they reach the input handler, so this extension alone cannot guarantee that images and inputs are preserved on those paths.
- Right after a relay, `ctx.getContextUsage().tokens` is null (until the next response). No automatic relay runs in the meantime (a plan to fill in with an estimate is not implemented).
- If a session switch or shutdown races with the relay finishing, the held text is not sent to the new session but written back to the editor together with any existing draft (generation counter, per-relay pending array). Images cannot be restored through the editor API, so a warning gives the number to re-attach. Covered by a fake-state regression test; not confirmed in a real TUI.
- Cache expiry depends on Pi's usage (`cacheWrite` / `cacheWrite1h`) and the `promptCache` declaration. To confirm that 1h is applied with a real provider, use `/cache-ttl` from `@sh1so6/pi-cache-ttl-main`.

## Seams toward M3

- M2 (automatic triggers): implemented (`runRelay` wraps `startRelay` and handles logging, notification, and resending held input).
- M3 (LLM-written sections): if `createContextRelay({ extraSections })` returns `NoteSection[]`, they are appended before the note footer (capped by `limits.extra`).

## Remaining work

- M3: when the cache is warm, use the same model (cached path); when cold, use a configurable lightweight model (Haiku / DeepSeek flash, etc.) to append a short "unresolved items / decisions" section.
- Deduplicate the test setup code in `session.test.mjs` and `harness.mjs`.
- Smoke-test `/relay`, automatic relay, and session-switch races in a real TUI.
