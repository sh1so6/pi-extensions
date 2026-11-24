# @sh1so6/pi-prefix-audit

English | [日本語](README_ja.md)

[Pi](https://github.com/earendil-works/pi) extension for diagnosing `Anthropic dropped N thinking blocks (details in session)` with reason `prefix_binding_mismatch`.

Anthropic binds every thinking block to the exact `system` prompt, `tools` list and earlier messages it was produced under. If any of them differs when the block is sent back (one word of a tool description is enough), the API drops the block and the prompt cache is invalidated from the first dropped block on. This extension records **what** changed between consecutive requests. It only observes: payloads are never modified.

```bash
pi install npm:@sh1so6/pi-prefix-audit
```

- Each Anthropic request is snapshotted (`cache_control` removed, thinking blocks reduced to a signature hash, since the API compares neither) and diffed with the previous request of the session.
- When a response reports `thinking_dropped`, a `drop` record lists the changes made since the first dropped block was minted ("suspects"), and a one-line notice is shown.
- Command: `/prefix-audit` (requests seen, drops, last changes, log path)
- Log: `~/.pi/agent/prefix-audit/<sessionId>.jsonl` (`req` per request, `diff` only when something changed; `drop`). Main and subagent sessions are both recorded.
- Config (optional): `~/.pi/agent/prefix-audit.json` `{ "enabled": true }`
- A session resumed after a restart has no baseline for its first request.
- Limits: a `before_provider_request` handler of another extension that is loaded *after* this one and rewrites `system` / `tools` / messages is invisible (it shows up as "no change seen"). The log contains short excerpts of the changed text and is never rotated; it stays local.
- See the header comment of [index.ts](index.ts) for the log format and limitations.
