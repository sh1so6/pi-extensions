# G:/Dev/TS/Pi（Pi 拡張リポジトリ）

## 最初に読む

プラグイン（拡張）に関する質問・調査・修正では、**コードを grep / 全文読みする前に必ず `PLUGINS.md` を読む**こと。
質問が曖昧でも、`PLUGINS.md` の「症状・キーワード → プラグイン」表と一覧で対象を絞れる。

1. `PLUGINS.md` で対象プラグインを特定する（コマンド・設定・依存関係もここにある）。
2. 詳細が必要なら、対象ファイルの**冒頭コメント**（仕様はそこに書いてある）か `context-relay/README.md` / `usage-stats/usage-analysis/README.md` だけを読む。
3. それでも足りない時だけ、対象ファイルに絞って grep / read する（リポジトリ全体の grep はしない）。

## 保守

- 各パッケージの README は英語が `README.md`（npm に表示）、日本語が `README_ja.md`。両方を更新し、`package.json` の `files` に両方入れる。

- プラグインの追加・削除、コマンド・設定・依存関係の変更をしたら、同じコミットで `PLUGINS.md` も更新する。
- 詳細仕様は各ファイル冒頭コメントが正。`PLUGINS.md` は短い索引として保つ。

## 配置の注意

- 全拡張が npm パッケージ（`@sh1so6/pi-*`、`<name>/index.ts`）。編集したら `npm version patch -w <name> --no-git-tag-version` → main に push。`.github/workflows/publish.yml`（Trusted Publishing / OIDC）が未公開バージョンのパッケージだけ自動公開する。公開後 `pi update --extensions` → `/reload`。`~/.pi/agent/extensions/` には置かない（二重ロード）。
- `~/.pi/agent/extensions/` にはこのリポジトリ外の拡張（`herdr-agent-state.ts`。herdr が自動生成するので管理しない）もある。
