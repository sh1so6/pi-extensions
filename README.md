# pi-extensions

[Pi](https://github.com/earendil-works/pi) 用の自作拡張集です。各拡張は独立した npm パッケージ（`@sh1so6/pi-<name>`）で、リポジトリは npm workspaces です。
`pi install git:github.com/sh1so6/pi-extensions` で入れても何もロードされません。**使いたい拡張を1つずつ** npm から入れてください。

> 拡張は Pi のプロセス内でコードを実行します。入れる前に、そのパッケージの `index.ts`（冒頭コメントに仕様あり）を読んでください。
> 詳しい仕様・設定・連携は [PLUGINS.md](PLUGINS.md) が索引です。

## 入れ方（1拡張ずつ）

```bash
pi install npm:@sh1so6/pi-context-relay
pi install npm:@sh1so6/pi-cache-ttl-main
# ほかも同じ形式: pi install npm:@sh1so6/pi-<name>
```

`~/.pi/agent/extensions/` に同名の手動コピーがあるときは、二重ロードを避けるため削除してください。更新は `pi update --extensions`。

## 一覧

| 拡張 | 内容 | 依存・注意 |
|---|---|---|
| [`cache-ttl-main/`](cache-ttl-main/) | メインセッションだけ Anthropic プロンプトキャッシュを 1 時間にする | — |
| [`claude-quota-router/`](claude-quota-router/) | Claude サブスクの使用率が上限に近づいたら、同じモデルのまま API キー課金へ自動切替 | `anthro-api` プロバイダ（API キー）が必要 |
| [`context-relay/`](context-relay/) | LLM 要約の代わりに決定的な引き継ぎノートで擬似新規セッションを作る（`/relay`）。`recall` ツール付き | 期限前トリガは `cache-ttl-main` 前提 |
| [`cmd-alias/`](cmd-alias/) | 短いスラッシュコマンドの別名（既定 `/z` → `/relay`） | 既定の別名は `context-relay` が前提 |
| [`cwd-open/`](cwd-open/) | フッターの作業ディレクトリをクリックでエクスプローラ等で開く | — |
| [`fold-buttons/`](fold-buttons/) | 「全て畳む/展開」ボタン。他拡張が使える共有ツールバーの描画元 | — |
| [`path-click/`](path-click/) | 出力中のローカルパスをクリック可能にする | ボタン列は `fold-buttons` が必要 |
| [`mcp-idle-release/`](mcp-idle-release/) | アイドルな MCP stdio サーバのプロセスを止めてメモリ解放 | — |
| [`pi-model-buttons/`](pi-model-buttons/) | モデル＋thinking のクイック切替ボタン | — |
| [`pi-model-autocomplete/`](pi-model-autocomplete/) | `#` ＋モデル名の一部で補完 | — |
| [`scrollbar-markers/`](scrollbar-markers/) | スクロールバーにユーザー発言・AI 返信の印 | — |
| [`session-history/`](session-history/) | `/history` で履歴ビューア [pi-history](https://github.com/sh1so6/pi-history) を起動 | pi-history（Rust）を別途ビルドして PATH に置く |
| [`usage-stats/`](usage-stats/) | `/usage-stats` でトークン／コスト集計（Python スクリプト同梱） | Python が必要 |

## リリース

```bash
npm version patch -w cache-ttl-main --no-git-tag-version   # 変更した拡張だけ version を上げる
git commit -am "..." && git push                          # push すると GitHub Actions が未公開の版だけ npm へ公開
```

公開は [`publish.yml`](.github/workflows/publish.yml)（npm Trusted Publishing）が行います。公開した版は取り消せません。mac 側は `pi update --extensions`。

## テスト

各ディレクトリで `node --test *.test.mjs`（`context-relay` は README を参照）。
