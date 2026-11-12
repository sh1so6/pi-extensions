# @sh1so6/pi-cache-ttl-main

[English](README.md) | 日本語

[Pi](https://github.com/earendil-works/pi) 拡張。**メインセッションだけ** Anthropic のプロンプトキャッシュを 1 時間（ttl `1h`）にします。サブエージェントには触りません。
バックグラウンドのサブエージェントを待つ間（5〜60分）にキャッシュが切れて、毎回 ~150k トークンを書き直すのを防ぎます。

```bash
pi install npm:@sh1so6/pi-cache-ttl-main
```

- コマンド: `/cache-ttl`（有効/無効、書き込み回数、直近ターンの `cacheWrite` / `cacheWrite1h`）
- 設定（任意）: `~/.pi/agent/cache-ttl-main.json` `{ "enabled": true }`
- main/サブの判定は `ctx.mode`（`tui` / `rpc` = メイン、`print` / `json` = サブ。mode が取れない時だけ `hasUI`）で行い、セッション名は見ない。人が再開した `worker#<8hex>` のセッションはメイン扱いで 1h キャッシュになる。前提は pi-subagents が子を UI コンテキストなしで起動する（Pi は mode `print` と報告する）こと（pi-subagents 0.23.2 / Pi 1.5.1 で確認）。将来 pi-subagents が子へ UI コンテキストや `mode: "tui"` を渡すと、子がメイン扱いになる（現行ルールは `index.test.mjs` の回帰テストで固定）。RPC が `hasUI: true` を返すことは Pi 1.5.1 でのみ確認（1.5.2 は未確認）。mode ベースなのでこの値には依存しない。
- 動作の詳細・制限は [index.ts](index.ts) の冒頭コメントを参照。
- `@sh1so6/pi-context-relay` の期限前トリガは、この拡張が付ける 1h（`cacheWrite1h > 0`）を前提にしています。
