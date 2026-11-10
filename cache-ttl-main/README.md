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
- See the header comment of [index.ts](index.ts) for details and limitations.
