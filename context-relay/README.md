# context-relay

LLM 要約によるコンパクションの代わりに、**擬似的な新セッション**を作る Pi 拡張です（M1: 手動 `/relay` と `recall` ツール、M2: 自動トリガ）。

- 履歴を「決定的に生成した引き継ぎノート」＋「直近のやり取り」に置き換えます。LLM は使いません（コスト 0・毎回同じ結果）。
- 古い生ログ（bash / read / codemode の出力など）は **セッションファイルにそのまま残る**ので、モデルは `recall` ツールで必要な時だけ取りに行けます。
- メイン（オーケストレーター）セッション専用です。サブエージェント／ヘッドレス（`!ctx.hasUI`、またはセッション名が `…#<8桁hex>`）では何もしません（ツールもコマンドも登録されず、ハンドラも素通り）。

## インストール

```bash
pi install npm:@sh1so6/pi-context-relay
```

期限前トリガ（自動 B）は `@sh1so6/pi-cache-ttl-main` が付ける 1h キャッシュを前提にしています。`/z` などの別名は `@sh1so6/pi-cmd-alias`。

## 使い方

| 操作 | 内容 |
|---|---|
| `/relay` | アイドル時に実行。`ctx.compact()` 経由で圧縮し、`session_before_compact` で結果を差し替えます |
| `recall({query, limit?, scope?})` | 文脈から外れた過去のエントリを大文字小文字無視・AND で検索。`entryId`・種別・時刻・±200 文字のスニペットを返す（既定 8 件、出力 ~8k 文字上限） |
| `recall({entryId, offset?})` | そのエントリの全文（~12k 文字ごと、続きの offset を案内）。`note:<n>` で引き継ぎノート自体も読める |

`/relay` 以外の圧縮（`/compact`・自動圧縮）には介入せず、Pi 標準（または他拡張）がそのまま動きます。
`/relay` は私的マーカーを `customInstructions` に載せて呼ぶので、それを検出した時だけノートを返します。

`recall` は **`query` か `entryId` のどちらか**（両方なら `entryId` 優先）。`limit` は 1〜30、`offset` は 0 以上に丸め、型違いの引数は無視。
出力は上限付き（検索 8000 文字、全文 ~12k 文字。入力した query / entryId のエコーも切り詰め）。
ノートも `recall` も **`context_edit` 適用後（モデルから見えている）の内容**が基準です。omit された発言はノートにも検索結果にも出ず（`entryId` 指定では「omit 済み」と表示）、置換された発言は置換後の本文を使います。
圧縮（キャンセル）の `AbortSignal` を尊重し、中断時にノートファイルを残しません。

## 圧縮後の文脈

`system` ＋ ノート（compaction summary）＋ **最後のユーザーメッセージ以降すべて**。
最後のユーザーメッセージ以降が `tailMaxChars`（既定 48000 文字）を超え、かつ Pi 標準の切り位置のほうが後ろなら Pi の位置を使います。
ユーザーメッセージが無ければ Pi の `preparation.firstKeptEntryId` を使います。
`details` は `{ relay: true, version, notePath }`。

## ノートの中身（上限付き、合計 ≈ 6k トークン目安 / 9500 文字）

1. ユーザー指示（直前の relay / compaction 境界以降の全件。古い順。新しいほど長く残し、古いものは短縮→省略。前回ノートの指示は 1 行に圧縮して連結）
2. 保持される直近のやり取りの**直前**の最終回答（保持分に最終回答は含まれるので重複させない）
3. サブエージェント（`subagents:record` / `subagent-notification` / `Agent` 起動結果から。**RUNNING は最上部に明示**。id・type・説明・状態・worktree/branch・結果冒頭）
4. 変更ファイル（`edit` / `write` の path）と、セッション開始以降の git コミット（cwd と、サブエージェント結果に現れる `…/worktrees/<name>` を `git log --since`。タイムアウト付き、失敗時は省略）
5. フッター（`recall` の使い方とノートのパス）

保存先: `~/.pi/agent/context-relay/<sessionId>/<n>.md`（プロジェクト cwd には書きません）。

## 自動トリガ（M2）

どちらもメイン（オーケストレーター）セッションのみ。サブエージェント／ヘッドレスでは何もしません。

| トリガ | 条件 | 動作 |
|---|---|---|
| A. 入力時 | ユーザー入力（`source` が `interactive` / `rpc`。`extension` は無視＝ループしない）、アイドル中（`streamingBehavior` なし）、`/` で始まらない、文脈 ≥ `inputMinTokens`（既定 100000） | 入力を保留（`{action:"handled"}`）→ relay → 完了後に**元の text+images を 1 回だけ** `pi.sendUserMessage` で再送。relay が失敗/キャンセルでも再送（通知に明記）。relay 中に届いた入力は保留し、完了後に 1 通へ結合（空行区切り・順序維持）して送る |
| B. キャッシュ期限前 | エージェントが落ち着いた（`agent_settled`）時点で、最後の実リクエスト時刻＋TTL から期限を計算。TTL は**プロバイダ依存で、寿命が確実に分かる場合のみ**: モデルが `promptCache`（short / long 秒。`PI_CACHE_RETENTION` と直近の書き込みの `usage.cacheWrite1h` で段を選ぶ。Pi のキャッシュウォーマーと同じ読み方）を宣言していればそれ、なければ Anthropic（`anthropic-messages`）の 1 時間（`cacheWrite1h > 0`。cache-ttl-main.ts がメインに付ける）／5 分。DeepSeek の自動ディスクキャッシュや `promptCache` 未宣言の OpenAI など寿命不明・ベストエフォートのモデルではタイマーを張りません（通知・ログも出さない）。トリガ A はプロバイダ非依存。期限の 20 秒前にアイドル・保留メッセージなし・文脈 ≥ `expiryMinTokens`（既定 140000） | relay のみ（再送なし）。`agent_start` / セッション切替 / 終了でタイマーは解除（`unref` 済み）。キャッシュ活動が無い・relay 後は計時しない |

relay 直後は、文脈が `minGrowthTokens`（既定 30000）以上増えるまで自動 relay しません（保持部分が大きい時の連発防止）。
自動 relay の完了時に 1 行通知（`context-relay: auto relay (new message) 152k → ~9k tokens`）。
全 relay（手動・自動）は `~/.pi/agent/context-relay/log.jsonl` に 1 行ずつ追記されます:
`{at, sessionId, trigger: "manual"|"input"|"expiry", tokensBefore, noteChars, keptFrom, ok, error?}`。

## 設定（任意） `~/.pi/agent/context-relay.json`

```json
{
  "enabled": true, "tailMaxChars": 48000, "gitTimeoutMs": 4000, "limits": { "total": 9500, "userMessages": 3000 },
  "auto": { "onInput": true, "inputMinTokens": 100000, "beforeExpiry": true, "expiryMinTokens": 140000, "minGrowthTokens": 30000 }
}
```

`auto` は `session_start` で読み込み（ファイルなし／キー欠落＝既定値。型が違う値も既定値）。自動を止めるには `"auto": {"onInput": false, "beforeExpiry": false}`。

`limits` のキーは `note.ts` の `Limits`（total / userMessages / userMessageEach / chain / answer / subagents / files / git / extra）。

## 制限

- Pi の `prepareCompaction` が圧縮不可と判断する場合（直前が compaction、履歴が短すぎる等）は `/relay` もエラー通知になります。
- RUNNING 表示は「起動結果があり完了記録が無い」ことからの推定です（Pi 再起動で失われたエージェントも残り得る。開始時刻付きで表示）。
- worktree 検出は `…/worktrees/<name>` 形式のパス文字列のヒューリスティックです。
- `recall` は現在のブランチ上のエントリのみ（`scope:"lineage"` で `parentSession` 祖先も）。画像は `[image]`。
- 圧縮中に落ちた場合、ノートファイルだけ残ることがあります（無害）。

## テスト

```
node --test context-relay/unit.test.mjs      # ノート / recall / 検出 / git
node --test context-relay/session.test.mjs   # 実 Pi セッション + faux プロバイダの E2E（次リクエストのペイロードを検証）
node --test context-relay/review.test.mjs    # context_edit 反映・中断時にノートを残さない
node --test context-relay/auto.test.mjs      # M2 自動トリガの E2E（しきい値は実測から決定。キャッシュ期限は promptCache.short を数秒にして検証）
node --test context-relay/verification.test.mjs # 独立検証: 画像 / 通知競合 / streaming / Pi 自動圧縮 / lifecycle / 出力上限
```

## 既知の制限・未検証（M2）

- 入力保留中に別の入力が input ハンドラへ届くと、保留分は 1 通に結合して送る（空行区切り・順序維持）。画像 2 枚付きの結合は faux プロバイダのペイロードで E2E 検証済み。ただし Pi 本体の TUI compaction queue は text/mode のみ保持し、RPC の prompt は compaction 中に input ハンドラへ届く前に拒否されるため、その経路の画像・入力保全は本拡張だけでは保証できない。
- relay 直後は `ctx.getContextUsage().tokens` が null（次の応答まで）。その間は自動 relay しない（推定値で補う案は未実装）。
- セッション切替・終了と relay 完了が競合した場合、保留テキストは新セッションへ送らずエディタへ既存ドラフトと共に書き戻す（世代カウンタ・relay ごとの保留配列）。画像はエディタ API では復元できないため再添付枚数を警告。fake-state 回帰テスト済み、実 TUI では未確認。
- キャッシュ期限は Pi の usage（`cacheWrite` / `cacheWrite1h`）と `promptCache` 宣言に依存。実プロバイダでの 1h 反映は cache-ttl-main の `/cache-ttl` で確認する。

## M3 への継ぎ目

- M2（自動トリガ）: 実装済み（`runRelay` が `startRelay` を包み、ログ・通知・保留入力の再送を行う）。
- M3（LLM 執筆セクション）: `createContextRelay({ extraSections })` で `NoteSection[]` を返すとノートのフッター前に追記（`limits.extra` で上限）。

## 残課題

- M3: キャッシュ温時は同一モデル(cached path)、冷時は設定可能な軽量モデル(Haiku / DeepSeek flash 等)で短い「未解決・決定事項」欄を追記。
- `session.test.mjs` と `harness.mjs` のテスト準備コードの重複を整理。
- 実 TUI での `/relay`・自動 relay・セッション切替競合のスモーク確認。
