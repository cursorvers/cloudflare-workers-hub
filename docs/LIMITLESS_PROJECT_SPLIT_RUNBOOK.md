# Limitless Sync: Separate Project Split Runbook (KV-Free)

目的: Limitless → Supabase → Obsidian の経路を、他用途（Gmail/freee等）と切り離した **別Workerプロジェクト** として運用し、KV overflow / 設定ドリフトで同期が止まる確率を下げる。

このRunbookは「PDCAを3周回して検証し、その後に実戦投入する」ための作業指示書。

## 背景（今回の事故から抽出した要件）

- iPhone（Shortcuts）の自動実行が止まっても、サーバ側のバックアップ同期が継続すること
- **KV put 失敗で“止まらない”**（制御プレーンをKVに依存させない）
- 設定ドリフトで全停止しない（例: `SCHEDULED_GMAIL_ONLY=true` のような全停止級フラグを排除/局所化）
- 既存システム（orchestrator-hub）へ影響ゼロで段階導入できること（rollback容易）

## 最終形（Target）

- 新Worker: `limitless-sync`（名前は変更可）
  - 役割: Limitless lifelogs を Supabase `processed_lifelogs` に同期（webhook + cron）
  - 依存: `AI` binding, `LIMITLESS_API_KEY`, `SUPABASE_*`, `OPENAI_API_KEY`（任意）
  - **KV bindingなし**
  - cron: `0 * * * *`（毎時 :00 にバックアップ同期）
  - webhook: `POST /api/limitless/webhook-sync`（任意、認証必須）
    - `LIMITLESS_SYNC_WEBHOOK_KEY` が設定されている場合、このキーのみ許可（共有キー流用の誤爆を防ぐ）
- 既存Worker: `orchestrator-hub`
  - 当面は現状維持。Limitless系cronは停止できる状態にしておく（切替後に無効化）

## 安全設計の要点

- 冪等性: `processed_lifelogs` は `limitless_id` で upsert（重複しても壊れない）
- “止まらない”優先: ロック/最終同期時刻の保存を目的にKVを使わない（必要ならD1/DO/DBへ）
- 全停止級フラグ排除: Limitless専用Workerには `SCHEDULED_GMAIL_ONLY` のようなモードスイッチを持ち込まない

---

# PDCA Cycle 1: Project Split（最小で切り出して動く）

## Plan

1. 同一リポジトリ内に「別Workerプロジェクト」を追加する
   - `wrangler-limitless.toml`（新Worker用設定）
   - `src/limitless-only.ts`（新entrypoint: fetch + scheduled）
   - `src/handlers/limitless-webhook-simple.ts`（KV依存なし webhook）
2. cron で毎時バックアップ同期する（iPhone無しでも動く）

## Do (Sim)

ローカル:

```bash
cd Dev/cloudflare-workers-hub
npx wrangler dev -c wrangler-limitless.toml
curl -sS http://localhost:8787/__scheduled?cron=0+*+*+*+*
```

本番に触れない前提で、レスポンス/ログの流れのみ確認する（外部APIやSupabaseはモックでもよい）。

## Check (Crit)

チェック観点:

- KV binding が不要（コード参照/ビルドにKVが出てこない）
- cron `scheduled` が確実に `syncToSupabase()` を呼ぶ導線になっている
- webhook は「認証必須」で公開攻撃面を広げない

## Act (Solve)

Cycle 1 で見つかりがちな問題と対処:

- 依存が大きすぎる: entrypointから参照するモジュールを Limitless 系に限定し、既存の巨大routerを読まない
- KV参照が混入: rate limiter / last sync gating を入れない（またはD1/DOへ移す）

## Re-Plan（次周への繰り越し）

- “止まる”要素（KV/フラグ/cron設定）を更に局所化する
- 監視（Inputゼロ検知）を必須要件として追加

---

# PDCA Cycle 2: Failure Simulation（KV枯渇/設定ドリフト/並列実行を潰す）

## Plan

1. 「KV put が失敗しても動く」ことをテストで担保する（= KV参照ゼロの確認）
2. cron が重複発火しても壊れない（= upsert冪等 + 例外時の挙動）
3. “設定ドリフト”を検知する（起動時ログで重要変数を明示し、監視で異常を拾う）

## Do (Sim)

- `vitest` で:
  - scheduled handler が `syncToSupabase` を呼ぶ
  - webhook が Authorization なしで 401/403
  - `LIMITLESS_API_KEY` や `SUPABASE_*` 欠落で安全に失敗する（明確なログ/ステータス）

## Check (Crit)

リスク:

- Cloudflare cron trigger の上限（アカウント/プラン依存）に引っかかる
- `OPENAI_API_KEY` が無い時の AI fallback（Workers AI）品質/コスト
- Supabase service role を別Workerへ展開すること自体の権限境界

## Act (Solve)

- cron は最小（1本）に絞る（例: `0 * * * *`）
- secrets は `limitless-sync` に必要最小限のみ投入（Gmail/freee系は持たせない）
- 監視を入れる（Cycle 3 で実装）

## Re-Plan

- 監視/通知・運用手順（切替/rollback/定期点検）を固めて実戦投入へ

---

# PDCA Cycle 3: Production Rollout（実戦投入・監視・rollback）

## Plan

1. 新Workerを **既存に影響ゼロ** でデプロイ
2. 24時間 “影” 運用（cronだけで同期が継続するか観測）
3. 切替: iPhone webhook を新Workerへ（任意）、旧Worker側Limitless cronは無効化
4. 監視: 「N時間入力ゼロ」「cron未実行」を通知

## Do (Sim)

デプロイ（新Workerのみ）:

```bash
cd Dev/cloudflare-workers-hub
npx wrangler deploy -c wrangler-limitless.toml
```

secrets投入（例。値はローカル環境から渡す）:

```bash
# 例: .env.local を source して pipe で投入（値は表示しない）
# NOTE: LIMITLESS_API_KEY は .env.local に無い場合がある（今回そうだった）。
#       その場合は Limitless のダッシュボードから取得して手動で環境変数に入れてから実行する。
set -a
source .env.local
set +a

test -n \"$LIMITLESS_API_KEY\" || (echo 'LIMITLESS_API_KEY is missing' && exit 1)
printf '%s' \"$LIMITLESS_API_KEY\" | npx wrangler secret put LIMITLESS_API_KEY -c wrangler-limitless.toml --env \"\"
printf '%s' \"$SUPABASE_URL\" | npx wrangler secret put SUPABASE_URL -c wrangler-limitless.toml --env \"\"
printf '%s' \"$SUPABASE_SERVICE_ROLE_KEY\" | npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c wrangler-limitless.toml --env \"\"
printf '%s' \"$OPENAI_API_KEY\" | npx wrangler secret put OPENAI_API_KEY -c wrangler-limitless.toml --env \"\"

# Webhook 用の専用キー（推奨）
WEBHOOK_KEY=$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"base64url\"))')
printf '%s' \"$WEBHOOK_KEY\" | npx wrangler secret put LIMITLESS_SYNC_WEBHOOK_KEY -c wrangler-limitless.toml --env \"\"
```

ログ確認:

```bash
npx wrangler tail limitless-sync --format pretty
```

## Check (Crit)

成功判定（最低限）:

- 毎時 :00（UTC）に `[Scheduled] Starting Limitless scheduled sync` が出る
  - 注: Supabase の `processed_lifelogs.sync_source` 制約に合わせ、cron でも `sync_source='webhook'` を書き込みます（起動経路の識別は Worker ログ側で行う）
- Supabase `processed_lifelogs` に新規行が入り、Obsidian同期が追従する

## Act (Solve)

問題が出た場合の切り戻し:

- iPhone webhook は旧worker URLに戻す（必要なら）
- cronは新worker側を止める（`triggers.crons=[]` へ変更して再デプロイ）
- 旧workerのLimitless cronを復活（既存設定へ戻す）

---

# 実装ファイル（このRunbookが想定する構成）

- `wrangler-limitless.toml`
- `src/limitless-only.ts`
- `src/handlers/limitless-webhook-simple.ts`

---

# 運用チェックリスト（毎週5分）

- `wrangler tail limitless-sync` で直近24hのエラー率を見る
- Supabaseで `processed_lifelogs` の最終 `start_time` が更新されているか確認
- Obsidianの `04_Journals/Pendant/YYYY/MM/YYYY-MM-DD.md` が増えているか確認
