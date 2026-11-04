# プラグイン一覧（Pi 拡張）

このリポジトリの Pi 拡張の**索引**です。曖昧な質問を受けたら、まずここで該当プラグインを絞り、
その後に該当ファイルの**冒頭コメント（仕様の詳細が書いてある）**だけを読んでください。全ファイルの grep は不要です。

- 配置: 各 `.ts` を `~/.pi/agent/extensions/` にコピー → Pi で `/reload`（`context-relay/` はフォルダごと）。
- 設定ファイルの場所: `~/.pi/agent/`（`settings.json` ほか。下表の「設定」列）。
- 注意: `~/.pi/agent/extensions/` には**このリポジトリ外**の拡張もある（`claude-quota-router.ts`, `herdr-agent-state.ts`）。ここには載っていない。
- テスト: `node --test <name>.test.mjs`（`context-relay` は下記、`usage-analysis` は `python -m unittest`）。

## 症状・キーワード → プラグイン

| こう聞かれたら | 見るもの |
|---|---|
| キャッシュ / 1h / TTL / cacheWrite | cache-ttl-main（＋ context-relay の期限前トリガ） |
| コンパクション / 圧縮 / 文脈が大きい / 引き継ぎ / recall | context-relay |
| コスト / トークン集計 / 使用量レポート | usage-stats → tools/usage-analysis |
| MCP サーバが落ちる・再起動された・メモリ | mcp-idle-release |
| 使用量・コストのグラフ / HTMLレポート / サブスク何%使った | usage-stats（`/usage-stats html`） → tools/usage-analysis |
| 全部畳む / 展開 / ツール出力の表示 / 下部ボタン列 | fold-buttons |
| パスをクリック / Everything 検索 | path-click（ボタン列は fold-buttons に依存） |
| フッターの cwd クリック / エクスプローラで開く | cwd-open |
| モデル切替ボタン / `#` でモデル名補完 | pi-model-buttons / pi-model-autocomplete |
| スクロールバーの青・白の印 | scrollbar-markers |
| `/z` などの短縮コマンド | cmd-alias |
| 過去の履歴を探す / セッション一覧 / カレンダー / 過去セッションをHTMLで見たい / cache miss・relay の履歴とグラフ | session-history |

## 一覧

| プラグイン（ファイル） | 何をする | コマンド | 設定 | 補足・依存 |
|---|---|---|---|---|
| **cache-ttl-main** (`cache-ttl-main.ts`) | **メインセッションだけ** Anthropic プロンプトキャッシュを 1h にする（`before_provider_request` で既存の `cache_control` に `ttl:"1h"` を付与）。1h 中は Pi のキャッシュウォーマーを止める。サブエージェントは触らない | `/cache-ttl`（状態・直近の cacheWrite/cacheWrite1h） | `cache-ttl-main.json` `{enabled}` | `PI_CACHE_RETENTION=long` なら何もしない。main/sub 判定は UI の有無とセッション名 `#<8hex>`。1h が効くかは `cacheWrite1h>0` で確認 |
| **cmd-alias** (`cmd-alias.ts`) | 短いスラッシュコマンドの別名（既定 `/z` → `/relay`） | 設定した別名 | `cmd-alias.json` `{aliases:{z:"/relay"}}` | 別名の別名・組み込みコマンド（/compact 等）は不可 |
| **context-relay** (`context-relay/`) | LLM 要約の代わりに**決定的な引き継ぎノート**で擬似新規セッションを作る（コスト0）。古い生ログは `recall` ツールで取得。メインセッション専用 | `/relay`、ツール `recall` | `context-relay.json`（`auto`: onInput / beforeExpiry、各トークン閾値） | 詳細は `context-relay/README.md`。自動トリガ: 入力時（≥100k）／キャッシュ期限 20 秒前（≥140k）。ログ `~/.pi/agent/context-relay/log.jsonl`。ノート `~/.pi/agent/context-relay/<sessionId>/<n>.md`。ファイル: `index.ts`(本体) `note.ts`(ノート生成) `recall.ts` `auto.ts`(M2設定・期限推定・ログ) `entries.ts` `detect.ts` `git.ts` |
| **cwd-open** (`cwd-open.ts`) | フッター 0 行目の作業ディレクトリをクリックで Explorer 等で開く（左=既定、右=メニュー） | `/open-cwd [label\|?]` | `settings.json` の `cwdOpener.openers` | フルスクリーン TUI 必須。フッターを置換せず `handleMouse` を差し込む |
| **fold-buttons** (`fold-buttons.ts`) | エディタ下のバーに「全て畳む/展開」ボタン。thinking を隠し、ツール枠をヘッダーのみにする。**他拡張が使える共有ツールバー**（`globalThis[Symbol.for("pi.toolbar.buttons")]`）の描画元 | `/fold-all [on\|off\|toggle]` | なし（状態は非永続） | フルスクリーン TUI 必須。path-click の `[🔍 Everything]` ボタンはここに載る |
| **mcp-idle-release** (`mcp-idle-release.ts`、約 2500 行) | アイドルな MCP **stdio** サーバのプロセスを止めてメモリ解放。次の呼び出しで Pi が遅延再接続。再起動後の最初の呼び出しに通知（`respawnPolicy: notify\|block`） | `/mcp-idle [release <server>\|on\|off\|minutes <n>]` | `mcp-idle-release.json`（`idleMinutes` 既定10, `exclude`, `servers.<name>`…） | 冒頭コメントが長い（通知の仕様・codemode 内呼び出しの扱い）。HTTP サーバは対象外。テスト 3 ファイル（`.test` / `.session.test` / `.shared.test`） |
| **path-click** (`path-click.ts`) | アシスタント出力中のローカルパスをクリック可能にする（OSC 8）。`/E:/…`・`/mnt/e/…`・`/e/…` 形式も Windows パスとして解釈。存在しないパスは Everything(voidtools) 検索リンクに。クリップボード検索ボタン | なし | 環境変数 `PI_PATH_CLICK_MODE`(file\|vscode)、`PI_PATH_CLICK_EVERYTHING`(0\|1)、`PI_EVERYTHING_EXE` | 描画のみ（表示専用）。TUI の `openUrl` をフック。ボタンは fold-buttons の共有ツールバー経由。ベンチ: `node path-click.bench.mjs` |
| **pi-model-autocomplete** (`pi-model-autocomplete.ts`) | `#`＋モデル名の一部で `provider/model-id` に補完（アクティブモデルは変えない） | なし（`#` 入力） | `settings.json` `modelAutocomplete.scopedOnly` | テストなし。入力テキストを編集するだけなので pi-subagents でも使える |
| **pi-model-buttons** (`pi-model-buttons.ts`) | モデル＋thinking のクイック切替ボタン | `/model-list [all\|filter]`、`/model-buttons-reload`、`/model-button "<label>"` | `settings.json` `modelButtons.presets` | フルスクリーン TUI 必須。テストなし |
| **scrollbar-markers** (`scrollbar-markers.ts`) | スクロールバーに、ユーザー発言(青)・AI 返信(白)の印 | `/scrollbar-markers [on\|off\|toggle\|status]`、`… ai [on\|off\|toggle]` | `settings.json` の `fullscreenScrollbar: "always"` 推奨 | Pi 内部（`ScrollView` 等）への差し込みで壊れやすい。非永続 |
| **session-history** (`session-history.ts`) | **薄いランチャ**。`/history` で単体アプリ **pi-history**（Rust、`G:/Dev/Rust/pi-history`）を同じ引数で起動し、出力を notify するだけ。一覧・検索・カレンダー・個別セッションHTML（`pi --export` 子プロセス）はすべてアプリ側（一覧の下に支出パネルと「キャッシュ（miss / relay）」パネル。判定の定義は pi-history README の「キャッシュ統計」）。アプリは自分でデーモン化し、Pi 終了後も残る（`/history stop` か `pi-history stop` で停止） | `/history [stop\|all\|<プロジェクト部分一致>]` | アプリ側 `session-history.json` `{includeSubagents, port}` | exe 探索: `PI_HISTORY_EXE` → PATH の `pi-history`（`~/.pi/agent/bin` に配置済み）→ `G:/Dev/Rust/pi-history/target/release/pi-history.exe`。詳細は `G:/Dev/Rust/pi-history/README.md`。キャッシュ `~/.pi/agent/session-history/cache.json`。テスト: `node --test session-history.test.mjs` |
| **usage-stats** (`usage-stats.ts`) | `tools/usage-analysis/` の Python スクリプトを実行し、結果を transcript に表示（`appendEntry` なので **LLM には送られない**） | `/usage-stats [script] [dir]`（`list` で一覧。`html` はグラフ付きHTMLを生成してブラウザで開く。`PI_USAGE_STATS_NO_OPEN=1` で開かない） | `usage-stats.json` `{scriptsDir, python, timeoutMs}` | `scriptsDir` 既定は `E:/Dev/TS/Pi/tools/usage-analysis`（このリポジトリの場所と違う場合は要設定） |
| **usage-analysis** (`tools/usage-analysis/`) | セッションログ(`~/.pi/agent/sessions/<project>/*.jsonl`)からトークン／コスト集計。`report.py` が日本語まとめ（内訳・1hキャッシュ効果・サブの節約・relay）、`report_html.py` が同じ内容のSVGグラフ付きHTML（＋サブスク7d使用率ゲージ。※5時間枠は廃止されたため扱わない。出力 `~/.pi/agent/usage-report/<project>.html`）。`an*.py` は個別分析、`sim3/sim4` は方式比較の試算、`cache-eval.mjs`（node）は 1h TTL/ウォーマー/relay の損得再計算（手順・基準値・判断基準は `EVALUATE.md`、2週間ごとの再評価用） | （usage-stats 経由） | — | 詳細は `tools/usage-analysis/README.md`。`sessions.json`（リポジトリ直下）は `an.py` の出力 |

## 連携関係

- `cache-ttl-main` → `context-relay`: 期限前トリガは `cacheWrite1h>0` で 1h を判定（cache-ttl-main がメインに 1h を付ける前提）。
- `fold-buttons` ← `path-click`: 共有ツールバーのレジストリ経由（fold-buttons がないとボタンは出ない）。
- `usage-stats` → `tools/usage-analysis`: スクリプトを子プロセスで実行。
- `cmd-alias`: 既定で `/z` → `/relay`（context-relay）。

## このファイルの保守

プラグインの追加・コマンド／設定の変更・削除をしたら、この表も同じコミットで更新してください。
詳細仕様は各ファイル冒頭コメントが正で、ここは**索引**として短く保ちます。
