# KV最適化プログラム（別プロジェクト）指示書

目的: 「KV overflow（`KV put() limit exceeded for the day`）で本番の自動処理が止まる」を再発させない。  
手段: KVを“キャッシュ用途”へ限定し、**制御プレーン（cron/ロック/状態/トークン/冪等）**をD1/DOへ段階移行する。そのための **別プロジェクト（別プログラム）** を走らせ、監査→批評→改善を継続する。

この指示書は **PDCAを3周回して検証してから実戦投入**する前提で書く。

---

## 重要な前提（誤解しがちな点）

- KV “掃除”は、KVの**日次write上限**を増やさないことが多い（上限はアカウント/プランに紐づく）。  
  したがって、最適化の主軸は「**KV put を減らす設計**」であり、掃除は補助。
- `list/delete` も KV ops を増やすため、**無計画な全件スキャンは逆効果**になり得る。

---

## 別プロジェクトの定義

### プログラム名（例）
- `kv-optimizer`（静的監査 + レポート生成 + 回帰検知）

### 配置（このrepo内の“別プログラム”として運用する例）
- `tools/kv-optimizer/`
  - `tools/kv-optimizer/kv-optimizer.mjs`（依存なし。静的監査）
  - `tools/kv-optimizer/README.md`

### 役割
1. **静的監査**: リポジトリ内の KV `put/get/delete/list` を棚卸し
2. **優先度付け**: “制御プレーン依存” と “高頻度put” を上位に上げる
3. **回帰検知**: 監査結果を定期実行して差分を検出（CI/cron）
4. **実装誘導**: 「KV→D1/DO移行」「TTL付与」「まとめ書き」「fail-open/closed方針」への改善チケットを作る

---

# PDCA Cycle 1（棚卸し）

## Plan
- KV利用箇所を**機械的に列挙**し、カテゴリ分けする
  - A: 制御プレーン（ロック、最終実行時刻、重複防止、トークン）
  - B: 高頻度（rate limiter、poller、キュー）
  - C: キャッシュ（落ちてもよい）

## Do（Sim）

静的監査（読み取りのみ）:

```bash
cd Dev/cloudflare-workers-hub
node tools/kv-optimizer/kv-optimizer.mjs scan --root .
```

ベースライン（回帰検知の基準）を更新する場合:

```bash
cd Dev/cloudflare-workers-hub
node tools/kv-optimizer/kv-optimizer.mjs scan --root . --json tools/kv-optimizer/baseline.json
```

## Check（Crit）
- `put` が多い箇所、TTLなし `put` を抽出
- `list` がホットパスにないか（特に `queue:lease:` のようなprefix-list）
- “落ちたら困る”用途がKVに乗っていないか（例: refresh token）

## Act（Solve）
- 監査ツールがKV以外（Cache API等）を誤検知していたら除外ルールを追加
- 出力を「移行候補リスト（上位10）」に絞る（アクション可能な粒度へ）

## Re-Plan
- Cycle 2 で “高頻度put” の削減案（DO/D1移行）を具体化し、検証計画を追加

---

# PDCA Cycle 2（設計検証: KV put削減）

## Plan
カテゴリ別の移行方針を確定し、1カテゴリずつ小さく置換する。

- A（制御プレーン）: **D1 or Durable Object**
  - ロック: DO（推奨） or D1（UNIQUEロックテーブル）
  - 冪等キー: D1（UNIQUE制約）
  - refresh token: D1（暗号化 + TTL/rotation）
- B（高頻度）:
  - rate limiter: DOへ（1キー=1DO or shard）
  - キューlease: DO/D1へ（KV list を避ける）
- C（キャッシュ）:
  - KV継続でOK。ただしTTL必須、put回数削減（まとめ書き/サンプル率/デバウンス）

## Do（Sim）
- ステージング（またはローカル）で「KV put が失敗しても止まらない」シナリオテストを追加
- 1つだけ移行して負荷/挙動を計測（例: rate limiter だけDOに）

## Check（Crit）
- 変更で他機能に影響していないか（レート制御やジョブ実行頻度）
- 監視がないと、止まった時に気づけない。Cycle 3 で必ず入れる。

## Act（Solve）
- 移行は feature flag で段階投入（新経路→影運用→切替→旧削除）
- KV put を完全に消せない箇所は「バッファリング」「書き込み頻度の上限」「fail-open/closed」を明文化

## Re-Plan
- Cycle 3 で “回帰防止（監査を定期実行）” と “止まり検知” を運用に組み込む

---

# PDCA Cycle 3（運用投入: 監視 + 回帰防止）

## Plan
- `kv-optimizer` を定期実行して、KV利用が増えたら検知する
- “止まった”を検知して通知する（入力ゼロ/cron未実行/エラー率）

## Do（Sim）
1. 定期実行（例: GitHub Actions の nightly / ローカルlaunchd / cron）
2. 監査結果を保存（JSONをartifact or 生成物）
3. 差分が閾値を超えたら通知（Slack/Discord）

## Check（Crit）
- 監査結果がノイズだらけなら、除外ルール・しきい値を調整
- “増えた”だけでなく “制御プレーンにKVが入った”を強く検知する

## Act（Solve）
- 監査を “ブロッカー” にする
  - 例: 新規 `env.CACHE.put` が TTLなしならCI失敗
  - 例: 新規 `kv.list` が追加されたら要レビュー

例: ベースラインからの回帰をCIで落とす（総量/put/TTLなしput/list の増加をブロック）:

```bash
cd Dev/cloudflare-workers-hub
node tools/kv-optimizer/kv-optimizer.mjs check --root . --baseline tools/kv-optimizer/baseline.json
```

推奨（実務向け）: CIのブロック対象はまず **TTLなしput と kv.list** に絞る（put総数/総量はレポートで可視化し、レビューで判断）。
例:

```bash
cd Dev/cloudflare-workers-hub
node tools/kv-optimizer/kv-optimizer.mjs check \
  --root . \
  --baseline tools/kv-optimizer/baseline.json \
  --allow-total-increase 100000 \
  --allow-puts-increase 100000
```

## Re-Plan
- 次の移行対象（上位3つ）を決めて Cycle 2 に戻る（四半期単位で継続）

---

## 実戦投入の最小チェックリスト

- [ ] 監査ツールがCI/cronで週1以上回る
- [ ] “止まった検知”が通知される（入力ゼロ or cron未実行）
- [ ] 制御プレーン（ロック/冪等/トークン）がKVに依存しない
- [ ] KVを使う箇所はTTLが付与され、put頻度の上限がある

---

## このrepoでの運用メモ（実装例）

### WorkersのURL/環境が紛らわしい問題（重要）

このrepoは `wrangler.toml` の env を使っており、**デプロイ先が複数に分かれます**:

- `npx wrangler deploy`（envなし）
  - script: `orchestrator-hub`
  - URL: `https://orchestrator-hub.masa-stage1.workers.dev`
- `npx wrangler deploy --env canary`
  - script: `orchestrator-hub-canary`
  - URL: `https://orchestrator-hub-canary.masa-stage1.workers.dev`

注意: D1 migrations は **`--remote` を付けない限りローカル**です（`--env canary` を付けても `--remote` が無ければローカルです）。

推奨（事故防止）: 手動で `wrangler` を打たずに、ラッパーを使う。

```bash
# envなし（orchestrator-hub）
npm run release:hub

# --env canary（orchestrator-hub-canary）
npm run release:canary
```

### 代表的な移行例
- rate limiter: KV put (hot path) を避けるため DO（`RateLimiter`）へ
- 外部OAuthトークン（freee）: `external_oauth_tokens`（D1）へ
- API key mapping（IDOR対策の制御プレーン）: `api_key_mappings`（D1）へ
- task queue（高頻度put + list）: `queue_tasks` / `queue_results`（D1）へ（claim/list/result をD1優先に）

### 適用手順（D1 migrations）

ローカルD1（`wrangler dev`用）:

```bash
cd Dev/cloudflare-workers-hub
npx wrangler d1 migrations apply DB --local
```

本番D1:

```bash
cd Dev/cloudflare-workers-hub
npx wrangler d1 migrations apply DB --remote
# script/envのバインディング解決まで含めて確認したい場合:
# npx wrangler d1 migrations apply DB --env canary --remote
```

### KVに残っているqueue/task/resultをD1へ移行（1回だけ）

前提: `migrations/0020_queue_d1_store.sql` を適用済みであること。

どちらのscriptに当てるか決めて `WORKERS_API_URL` をセットする（迷ったら envなし側）:

```bash
export WORKERS_API_URL="https://orchestrator-hub.masa-stage1.workers.dev"
# 代替:
# export WORKERS_API_URL="https://orchestrator-hub-canary.masa-stage1.workers.dev"
```

タスク:

```bash
curl -sS -X POST "$WORKERS_API_URL/api/admin/queue/migrate-tasks-kv-to-d1" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKERS_API_KEY" \
  -d '{"limit":200,"cleanup":false}' | jq .
```

結果:

```bash
curl -sS -X POST "$WORKERS_API_URL/api/admin/queue/migrate-results-kv-to-d1" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKERS_API_KEY" \
  -d '{"limit":200,"cleanup":false}' | jq .
```

必要なら、`cursor` をレスポンスから引き継いで複数回回す（KV list は日次上限があるので小さく刻む）。

### 適用手順（DO class追加）

`wrangler.toml` の DO migrations tag を進めた場合は通常の deploy で反映される:

```bash
cd Dev/cloudflare-workers-hub
npx wrangler deploy
# 代替:
# npx wrangler deploy --env canary
```
