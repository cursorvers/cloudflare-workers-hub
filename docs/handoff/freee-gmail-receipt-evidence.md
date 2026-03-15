# freee × Gmail 自動登録: 証憑(添付)欠落 対応 申し送り

作成日: 2026-02-14

## 目的
Gmailからfreeeへ自動登録するパイプラインで、**取引(Deal)は作成されるが証憑(Receipt)が紐づかず**、freee上で「根拠(添付)なし取引」が残る問題の調査・修正・既存データ補正の申し送り。

このドキュメントは **freee側の開発は別で進める** 前提で、現状と運用ポイントだけを共有する。

## 重要な結論
1. 紐付けは「Receipt を更新」ではなく、**Deal を `PUT /deals/{dealId}` で更新して `receipt_ids` を付ける**のが安定。
2. freee側で **「証憑は既に削除されています」** が出るケースがあり、この場合は **R2から再アップロードして新しい `freee_receipt_id` に差し替えたうえで再リンク** が必要。
3. freee APIは更新系で `company_id` がクエリに必要なケースがあるため、`PUT /deals/{id}?company_id=...` に寄せる。

## 実装(Cloudflare Workers)の所在
リポジトリ: `cursorvers/cloudflare-workers-hub`

- PR: `#28` (branch: `fix/receipt-deal-link-backfill`)
  - Deal↔Receiptリンクのバックフィル・検証用のD1カラム追加
  - freee 400 の詳細ボディ取得
  - 「証憑削除済み」時の再アップロード → 再リンク
  - 一時的に `*/5 * * * *` の加速cronを追加して回復速度を上げた

注: PRがmainにマージされていない状態でも、手動デプロイで本番に反映されている可能性がある(Version IDで確認)。

## D1スキーマ変更
`receipt_deals` にリンク検証用カラムを追加:
- `link_verified_at`
- `link_retry_count`
- `link_last_attempt_at`
- `link_last_error`

## 現状確認(本番D1)
以下は **Cloudflare Workers Hub (production / envless)** のD1を前提。

未検証件数:
```sql
SELECT COUNT(*) AS unverified
FROM receipt_deals
WHERE deal_id IS NOT NULL
  AND freee_receipt_id IS NOT NULL
  AND freee_receipt_id != ''
  AND link_verified_at IS NULL;
```

進捗(例):
- 2026-02-13 17:16 UTC 時点: `unverified=16`, `verified=2`
- 2026-02-13 17:21 UTC 時点: `unverified=14`, `verified=4`

検証済み件数:
```sql
SELECT COUNT(*) AS verified
FROM receipt_deals
WHERE link_verified_at IS NOT NULL;
```

直近のバックフィル実行ログ(cron):
```sql
SELECT job_name, status, executed_at, details, error_message
FROM cron_runs
WHERE job_name IN ('cron:*/5 * * * *', 'cron:0 * * * *')
ORDER BY executed_at DESC
LIMIT 20;
```

## エラーの典型と対処
### 1) freee API 400: 証憑削除済み
例: `link_last_error` に以下が入る
- `... "証憑は既に削除されています。" ...`

対処:
- R2から同一PDFをfreeeへ再アップロードし、`receipts.freee_receipt_id` を更新
- その後、Dealへ `receipt_ids` を付与して再リンク

### 2) 外貨/金額0
自動でDeal作成やリンクを進めると誤爆するため、原則 `needs_review` に倒す。

## 運用: 自動バックフィル(cron)を止めたい場合
freee側を別で触る/事故リスクを下げたい場合、以下を検討:
1. `*/5 * * * *` の一時加速cronを削除して再デプロイ
2. `receipt_deal_link_backfill` 自体をfeature flag化して本番はOFF

少なくとも「freeeへの自動ミューテーション」を止めるなら、`wrangler.toml` のcronと `scheduled.ts` の quick-job を外す。

## 2026-03-10 時点の追加注意
- scheduled Gmail poll / backfill は `default` tenant に自動フォールバックしない。
- 複数 active tenant がある環境では `RECEIPT_OPERATIONAL_TENANT_ID` を Workers secret/env に設定しないと fail-closed する。
- freee OAuth callback は複数 company で「先頭を採用」しない。`/api/freee/auth?company_id=<freee_company_id>` で開始する。
- token 保存先は D1 の `external_oauth_tokens(tenant_id, provider, company_id)`。
- migration `0029_harden_freee_tokens_and_audit.sql` を適用してから dry-run smoke を行うこと。

## GitHub Actions (検証/修復)
`Verify Receipt Evidence` workflow が存在し、schedule/dispatchで以下の管理用エンドポイントを叩く:
- `/api/receipts/repair-freee-links`
- `/api/receipts/repair-html-text`
- `/api/receipts/retry?dry_run=false&confirm=execute-retry`

このworkflowは `WORKERS_API_KEY` を用いて本番へリクエストするため、freee運用を別系統にする場合は **無効化/停止** を検討。

## 参考: 影響範囲
- Cloudflare Worker: `orchestrator-hub` (production)
- データ: D1 `knowledge-base` (`receipts`, `receipt_deals`, `cron_runs`)
- 保存: R2 `receipt-worm-storage`
