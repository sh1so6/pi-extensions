# @sh1so6/pi-prefix-audit

[English](README.md) | 日本語

`Anthropic dropped N thinking blocks (details in session)`（理由 `prefix_binding_mismatch`）の原因を調べるための [Pi](https://github.com/earendil-works/pi) 拡張です。

Anthropic は thinking ブロックを、生成時の `system`・`tools`・それ以前のメッセージに結び付けます。送り返すときにどれか 1 つでも違うと（ツール説明の 1 語でも対象）、そのブロックは drop され、最初に drop されたブロック以降のプロンプトキャッシュも無効になります。この拡張は、連続するリクエストの間で**何が**変わったかを記録します。観測のみで、payload は変更しません。

```bash
pi install npm:@sh1so6/pi-prefix-audit
```

- Anthropic へのリクエストごとにスナップショットを取り（`cache_control` は除外、thinking ブロックは署名のハッシュだけ。API はどちらも比較しないため）、同じセッションの直前のリクエストと比べます。
- レスポンスに `thinking_dropped` があると、最初に drop されたブロックが生成された後の変更を「suspects」として `drop` レコードに記録し、1 行通知します。
- コマンド: `/prefix-audit`（リクエスト数・drop 数・直近の変更・ログの場所）
- ログ: `~/.pi/agent/prefix-audit/<sessionId>.jsonl`（`req` は毎リクエスト、`diff` は変化したときだけ。`drop`）。メインとサブの両方を記録します。
- 設定（任意）: `~/.pi/agent/prefix-audit.json` `{ "enabled": true }`
- 再起動して再開したセッションは、最初のリクエストに比較元がありません。
- ログ形式と制限は [index.ts](index.ts) の冒頭コメントを参照してください。
