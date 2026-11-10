# G:/Dev/TS/Pi（Pi 拡張リポジトリ）

## 最初に読む

プラグイン（拡張）に関する質問・調査・修正では、**コードを grep / 全文読みする前に必ず `PLUGINS.md` を読む**こと。
質問が曖昧でも、`PLUGINS.md` の「症状・キーワード → プラグイン」表と一覧で対象を絞れる。

1. `PLUGINS.md` で対象プラグインを特定する（コマンド・設定・依存関係もここにある）。
2. 詳細が必要なら、対象ファイルの**冒頭コメント**（仕様はそこに書いてある）か `context-relay/README.md` / `tools/usage-analysis/README.md` だけを読む。
3. それでも足りない時だけ、対象ファイルに絞って grep / read する（リポジトリ全体の grep はしない）。

## 保守

- プラグインの追加・削除、コマンド・設定・依存関係の変更をしたら、同じコミットで `PLUGINS.md` も更新する。
- 詳細仕様は各ファイル冒頭コメントが正。`PLUGINS.md` は短い索引として保つ。

## 配置の注意

- `cache-ttl-main` / `cmd-alias` / `context-relay` は npm パッケージ（`@sh1so6/pi-*`）。編集したら `npm version patch -w <name>` → `npm publish -w <name> --access public`（通常のターミナル、セキュリティキー認証）→ `pi update --extensions` → `/reload`。`~/.pi/agent/extensions/` には置かない（二重ロード）。
- それ以外の拡張は `~/.pi/agent/extensions/` 内のコピーが動く。編集したらコピーし直して Pi で `/reload` が必要。
- `~/.pi/agent/extensions/` にはこのリポジトリ外の拡張（`herdr-agent-state.ts`。herdr が自動生成するので管理しない）もある。
