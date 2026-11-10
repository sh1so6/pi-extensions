# @sh1so6/pi-cmd-alias

English | [日本語](README_ja.md)

[Pi](https://github.com/earendil-works/pi) extension. Creates short aliases for slash commands (default `/z` → `/relay`).

```bash
pi install npm:@sh1so6/pi-cmd-alias
```

- Config: `~/.pi/agent/cmd-alias.json` `{ "aliases": { "z": "/relay", "z-stats": "/usage-stats" } }`
- Targets can be extension commands, prompt templates and `/skill:name`. Built-in commands (e.g. `/compact`) and aliases of aliases are not supported.
- The default `/z` assumes `/relay` from `@sh1so6/pi-context-relay`.
- See the header comment of [index.ts](index.ts) for details.
