# @sh1so6/pi-cache-ttl-main

English | [日本語](README_ja.md)

[Pi](https://github.com/earendil-works/pi) extension. Makes the Anthropic prompt cache last **1 hour (ttl `1h`) for the main session only**. Subagents are left untouched.
This stops the cache from expiring while you wait 5–60 minutes for background subagents, which would otherwise force a ~150k-token rewrite every time.

```bash
pi install npm:@sh1so6/pi-cache-ttl-main
```

- Command: `/cache-ttl` (on/off, write count, `cacheWrite` / `cacheWrite1h` of the latest turn)
- Config (optional): `~/.pi/agent/cache-ttl-main.json` `{ "enabled": true }`
- The before-expiry trigger of `@sh1so6/pi-context-relay` relies on the 1h cache (`cacheWrite1h > 0`) this extension enables.
- Main/subagent detection uses `ctx.mode` (`tui` / `rpc` = main, `print` / `json` = subagent; `hasUI` only when no mode is reported) and never the session name: a `worker#<8hex>` session that a person resumes is main and gets the 1h cache. This relies on pi-subagents binding children without a UI context (Pi then reports mode `print`; checked against pi-subagents 0.23.2 / Pi 1.5.1). If a future pi-subagents gives children a UI context or `mode: "tui"`, they would be treated as main (the regression tests in `index.test.mjs` pin the current rule). RPC reporting `hasUI: true` was verified on Pi 1.5.1 only (not 1.5.2); the mode-based rule does not depend on it.
- See the header comment of [index.ts](index.ts) for details and limitations.
