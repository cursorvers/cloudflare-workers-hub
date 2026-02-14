# freee × Gmail 自動登録: 証憑(添付)欠落 / 外貨(要手動) 対応 申し送り

作成日: 2026-02-14

## 目的
Gmailからfreeeへ自動登録するパイプラインで、以下を継続的に解消する。

- **取引(Deal)は作成されるが証憑(Receipt)が紐づかない** ことで、freee上に「根拠(添付)なし取引」が残る
- **外貨建** は自動で取引作成すると誤爆しやすいので、アップロードはしつつ **人間が最終突合** できる導線を作る

## 重要な結論
1. freee側の紐付けは「Receipt更新」より、**Dealを `PUT /deals/{id}?company_id=...` で更新して `receipt_ids` を付与**するほうが安定。
2. freee側で **「証憑は既に削除されています」** が出ることがある。この場合は **R2から再アップロード(またはHTMLなら再PDF化)して新しい `freee_receipt_id` に差し替え**、再リンクが必要。
3. 外貨建は、実際の日本円決済額(多くはカード明細)と突合が必要なため、原則 **自動でDealを確定させない**。代わりに **Gmailで日次レポート**して手動処理に回す。

## 実装(Cloudflare Workers)の所在
リポジトリ: `cursorvers/cloudflare-workers-hub`

- Gmail receipt poller: `src/handlers/receipt-gmail-poller.ts`
- Deal↔Receiptの自己修復(ウォッチドッグ): `src/handlers/receipt-link-watchdog.ts`
- freeeクライアント(Deal更新時の `company_id`): `src/services/freee-client.ts`

## 現状確認(本番D1)
未突合(外貨/要手動の典型):
```sql
SELECT COUNT(*) AS cnt
FROM receipts
WHERE freee_receipt_id IS NOT NULL
  AND freee_receipt_id != ''
  AND (freee_deal_id IS NULL OR status='needs_review')
  AND UPPER(currency) != 'JPY';
```

「Dealはあるが根拠が無い」疑い(自己修復対象):
```sql
SELECT COUNT(*) AS cnt
FROM receipts
WHERE freee_receipt_id IS NOT NULL
  AND freee_receipt_id != ''
  AND freee_deal_id IS NOT NULL
  AND status IN ('completed','needs_review');
```

## エラーの典型と対処
### 1) freee API 400: 証憑削除済み
症状:
- Dealへ `receipt_ids` を付けようとして freee が「証憑は既に削除されています」を返す

対処:
- R2から同一証憑(PDF)をfreeeへ再アップロードし、`receipts.freee_receipt_id` を更新
- その後、Dealへ `receipt_ids` を付与して再リンク
- HTML証憑の場合は、R2の `receipt.html` を再PDF化してから再アップロード

### 2) 外貨/金額0/分類品質低
誤爆しやすいので、原則 `needs_review` に倒す。


### 3) Gmail送信スコープ不足 (403)
症状:
- 日次レポート送信が `Gmail send failed: 403 ...` で失敗する
- 典型: `GMAIL_REFRESH_TOKEN` が `gmail.send` スコープ無しで発行されている

対処:
- WorkerのOAuth再認可エンドポイントを踏んで refresh token を取り直す
  - `GET /api/gmail/auth` → Google同意画面へ
  - 完了後、refresh token は **D1 (external_oauth_tokens provider='gmail')** に保存され、以後は **D1優先** で利用される
- 送信が失敗してもパイプライン自体は落とさずログに残してスキップする(フェイルソフト)

注意:
- Driveバックアップも同じrefresh tokenを使用するため、OAuth同意では `drive.file` も要求する(権限を狭めるとバックアップだけ失敗する可能性あり)


## 運用: 自動回復を止めたい場合
以下のfeature flagで停止できるようにする(実装側の env var 名はソース参照)。

- Deal↔Receipt自己修復: `RECEIPT_LINK_WATCHDOG_ENABLED=false`
- 日次レポート送信: `RECEIPT_DAILY_REPORT_ENABLED=false`

## 注意点
- 自動化は「漏れをゼロに近づける」目的で、**完全な会計確定**はしない(外貨・複数決済日は特に)。
- PII/本文全文をログに出さない(レポート本文はGmailへ、ログはメタデータ中心)。
