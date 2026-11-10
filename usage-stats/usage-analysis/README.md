# usage-analysis

pi のセッションログ (`~/.pi/agent/sessions/<project>/*.jsonl`) からトークン/コストの内訳を集計するスクリプト群。
context-relay / cache-ttl-main の導入前後比較用。引数にセッションディレクトリを渡す (省略時は myproject)。

| script | 内容 |
|---|---|
| report.py | 日本語のまとめ (内訳・1hキャッシュ効果・サブの節約・relay)。`/usage-stats` の既定。テストは `python -m unittest` |
| an.py | セッション別集計、よく読まれるファイル、着手前の文脈量 |
| an2.py | system prompt 内訳、bash 出力量、エラー分類 |
| an3.py | サブの初動の読込、画像数、文脈帯別コスト |
| an4.py | ツール結果の「持ち越しコスト」推定 (tokens × 残りターン × cacheRead 単価) |
| an5.py | コスト内訳、cacheWrite スパイクと直前ギャップ |
| sim3.py | メインのキャッシュ方式比較 (1h TTL / idle warming / 失効前 compaction) |
| sim4.py | 疑似新規セッション (relay) の閾値別試算 |
| cache-eval.mjs | キャッシュ運用 (1h TTL / ウォーマー / relay) の損得を再計算する node スクリプト。`--since DATE` で区間指定。手順・基準値・判断基準は EVALUATE.md |
