# pi-extensions

[Pi](https://github.com/earendil-works/pi) 用の自作拡張集です。**パッケージではありません**（`package.json` なし）。
`pi install git:github.com/sh1so6/pi-extensions` で入れても何もロードされません。**使いたい拡張を1つずつ**入れてください。

> 拡張は Pi のプロセス内でコードを実行します。入れる前に、そのファイルの中身（冒頭コメントに仕様あり）を読んでください。
> 詳しい仕様・設定・連携は [PLUGINS.md](PLUGINS.md) が索引です。

## 入れ方（1拡張ずつ）

単体ファイルの拡張（`cache-ttl-main.ts` の例）:

```bash
cd ~/.pi/agent/extensions
curl -O https://raw.githubusercontent.com/sh1so6/pi-extensions/main/cache-ttl-main.ts
```

そのあと Pi で `/reload`。

フォルダの拡張（`context-relay/`）は、フォルダごと取得します:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/sh1so6/pi-extensions.git tmp-pe
cd tmp-pe && git sparse-checkout set context-relay
cp -r context-relay ~/.pi/agent/extensions/ && cd .. && rm -rf tmp-pe
```

（Windows の PowerShell では `Invoke-WebRequest -OutFile` と `Copy-Item -Recurse` で同じことができます。）

## 一覧

| 拡張 | 内容 | 依存・注意 |
|---|---|---|
| [`cache-ttl-main.ts`](cache-ttl-main.ts) | メインセッションだけ Anthropic プロンプトキャッシュを 1 時間にする | — |
| [`claude-quota-router.ts`](claude-quota-router.ts) | Claude サブスクの使用率が上限に近づいたら、同じモデルのまま API キー課金へ自動切替 | `anthro-api` プロバイダ（API キー）が必要 |
| [`context-relay/`](context-relay/) | LLM 要約の代わりに決定的な引き継ぎノートで擬似新規セッションを作る（`/relay`）。`recall` ツール付き | 期限前トリガは `cache-ttl-main` 前提 |
| [`cmd-alias.ts`](cmd-alias.ts) | 短いスラッシュコマンドの別名（既定 `/z` → `/relay`） | 既定の別名は `context-relay` が前提 |
| [`cwd-open.ts`](cwd-open.ts) | フッターの作業ディレクトリをクリックでエクスプローラ等で開く | — |
| [`fold-buttons.ts`](fold-buttons.ts) | 「全て畳む/展開」ボタン。他拡張が使える共有ツールバーの描画元 | — |
| [`path-click.ts`](path-click.ts) | 出力中のローカルパスをクリック可能にする | ボタン列は `fold-buttons` が必要 |
| [`mcp-idle-release.ts`](mcp-idle-release.ts) | アイドルな MCP stdio サーバのプロセスを止めてメモリ解放 | — |
| [`pi-model-buttons.ts`](pi-model-buttons.ts) | モデル＋thinking のクイック切替ボタン | — |
| [`pi-model-autocomplete.ts`](pi-model-autocomplete.ts) | `#` ＋モデル名の一部で補完 | — |
| [`scrollbar-markers.ts`](scrollbar-markers.ts) | スクロールバーにユーザー発言・AI 返信の印 | — |
| [`session-history.ts`](session-history.ts) | `/history` で履歴ビューア [pi-history](https://github.com/sh1so6/pi-history) を起動 | pi-history（Rust）を別途ビルドして PATH に置く |
| [`usage-stats.ts`](usage-stats.ts) | `tools/usage-analysis/` の Python でトークン／コスト集計 | `tools/usage-analysis/` を取得し、設定 `usage-stats.json` の `scriptsDir` を自分のパスにする。Python が必要 |

## テスト

`node --test <name>.test.mjs`（`context-relay` と `usage-analysis` は各 README を参照）。

## なぜ git でまとめて入らないのか

Pi は git の subpath 指定に対応していません。また、パッケージのフィルタは「パッケージが公開宣言したもの」を絞るだけです。
そこで、このリポジトリはあえて何も宣言せず、1 拡張ずつ取得する形にしています。
