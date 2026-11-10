# @sh1so6/pi-cmd-alias

[Pi](https://github.com/earendil-works/pi) 拡張。スラッシュコマンドの短い別名を作ります（既定 `/z` → `/relay`）。

```bash
pi install npm:@sh1so6/pi-cmd-alias
```

- 設定: `~/.pi/agent/cmd-alias.json` `{ "aliases": { "z": "/relay", "z-stats": "/usage-stats" } }`
- 別名の対象は拡張コマンド・プロンプトテンプレート・`/skill:name`。組み込みコマンド（`/compact` など）と別名の別名は不可。
- 既定の `/z` は `@sh1so6/pi-context-relay` の `/relay` が前提です。
- 詳細は [index.ts](index.ts) の冒頭コメントを参照。
