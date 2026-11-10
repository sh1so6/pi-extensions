# @sh1so6/pi-cache-ttl-main

[English](README.md) | 日本語

[Pi](https://github.com/earendil-works/pi) 拡張。**メインセッションだけ** Anthropic のプロンプトキャッシュを 1 時間（ttl `1h`）にします。サブエージェントには触りません。
バックグラウンドのサブエージェントを待つ間（5〜60分）にキャッシュが切れて、毎回 ~150k トークンを書き直すのを防ぎます。

```bash
pi install npm:@sh1so6/pi-cache-ttl-main
```

- コマンド: `/cache-ttl`（有効/無効、書き込み回数、直近ターンの `cacheWrite` / `cacheWrite1h`）
- 設定（任意）: `~/.pi/agent/cache-ttl-main.json` `{ "enabled": true }`
- 動作の詳細・制限は [index.ts](index.ts) の冒頭コメントを参照。
- `@sh1so6/pi-context-relay` の期限前トリガは、この拡張が付ける 1h（`cacheWrite1h > 0`）を前提にしています。
