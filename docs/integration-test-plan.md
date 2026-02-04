# 統合テスト計画

## 概要

freee領収書登録システムの全フロー統合テスト。本番環境 API を使用した End-to-End 検証。

---

## テスト環境

- **Gmail API**: 本番アカウント（masa）
- **Cloudflare Workers**: https://orchestrator-hub.masa-stage1.workers.dev
- **R2**: receipt-worm-storage (本番バケット)
- **freee API**: 本番環境
- **Google Drive**: 本番環境

---

## テストシナリオ

### シナリオ 1: Gmail → freee 自動登録（正常系）

#### 前提条件
- Gmail アカウントに領収書メールが届いている
- freee OAuth トークンが有効
- Workers がデプロイ済み

#### テスト手順

1. **Gmail Polling 実行**
   ```bash
   # 手動トリガー（cron の代わり）
   curl -X POST https://orchestrator-hub.masa-stage1.workers.dev/api/admin/cron \
     -H "Authorization: Bearer $ADMIN_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"schedule": "*/15 * * * *"}'
   ```

2. **Workers ログ確認**
   ```bash
   wrangler tail --format pretty
   ```

   期待されるログ:
   ```
   [Gmail Poller] Starting poll
   [Gmail Poller] Found 3 new messages
   [Receipt Parser] Detected receipt: Stripe (USD 29.00)
   [R2 Storage] Stored: receipts/2026/02/04/stripe_20260204_001.pdf
   [freee API] Created receipt: ID abc123
   [Google Drive] Backed up: receipts/2026/02/04/stripe_20260204_001.pdf
   ```

3. **R2 ストレージ確認**
   ```bash
   wrangler r2 object get receipt-worm-storage receipts/2026/02/04/stripe_20260204_001.pdf --file /tmp/test.pdf
   ```

4. **freee 確認**
   - https://secure.freee.co.jp/receipts
   - 新しい領収書が登録されているか確認
   - メタデータ（金額、取引先、日付）が正確か確認

5. **Google Drive 確認**
   - https://drive.google.com/drive/folders/...
   - バックアップが存在するか確認

#### 期待結果
- ✅ Gmail から領収書メールを取得
- ✅ PDF を R2 に保存（WORM）
- ✅ freee に領収書を登録
- ✅ Google Drive にバックアップ
- ✅ D1 に処理ログを記録

---

### シナリオ 2: Web Scraper → freee 登録（正常系）

#### 前提条件
- web_receipt_sources テーブルに有効なソースがある
- GitHub Actions ワークフローが設定済み
- GITHUB_TOKEN が設定済み

#### テスト手順

1. **手動トリガー実行**
   ```bash
   curl -X POST https://orchestrator-hub.masa-stage1.workers.dev/api/receipts/sources/stripe/trigger \
     -H "Authorization: Bearer $RECEIPTS_API_KEY" \
     -H "Content-Type: application/json"
   ```

2. **GitHub Actions 確認**
   - https://github.com/cursorvers/cloudflare-workers-hub/actions
   - ワークフローが実行されているか確認

3. **実行ログ確認**
   ```bash
   wrangler d1 execute knowledge-base --remote --command \
     "SELECT * FROM web_receipt_source_logs ORDER BY started_at DESC LIMIT 5"
   ```

4. **スクレイピング結果確認**
   - GitHub Actions のログで取得した領収書数を確認
   - R2 に保存されているか確認

5. **freee 確認**
   - スクレイピングした領収書が登録されているか確認

#### 期待結果
- ✅ GitHub Actions ワークフロー起動
- ✅ Playwright でログインページにアクセス
- ✅ 領収書一覧ページから PDF ダウンロード
- ✅ R2 に保存
- ✅ freee に登録
- ✅ D1 に実行ログ記録

---

### シナリオ 3: エラーハンドリング（異常系）

#### テスト 3.1: Gmail API トークン失効

1. **Gmail refresh token を無効化**
   ```bash
   wrangler secret put GMAIL_REFRESH_TOKEN
   # → 無効なトークンを入力
   ```

2. **Polling 実行**
   ```bash
   # 15分待つか手動トリガー
   ```

3. **期待される動作**
   - ❌ Gmail API が 401 を返す
   - ✅ エラーログに記録
   - ✅ Discord に CRITICAL アラート送信
   - ✅ リトライしない（認証エラーはリトライ不可）

#### テスト 3.2: freee API レート制限

1. **短時間に大量リクエスト送信**
   ```bash
   for i in {1..100}; do
     curl -X POST ... &
   done
   ```

2. **期待される動作**
   - ❌ freee API が 429 を返す
   - ✅ Exponential backoff でリトライ
   - ✅ 3回目で成功 or DLQ 送信
   - ✅ Discord に HIGH アラート送信（3回失敗時）

#### テスト 3.3: Web Scraper 要素変更

1. **web-receipt-scraper.js のセレクタを誤ったものに変更**
   ```javascript
   const receiptLinks = await page.$$('.wrong-selector');
   ```

2. **スクレイパー実行**

3. **期待される動作**
   - ❌ 要素が見つからない
   - ✅ GitHub Actions でリトライ（3回）
   - ✅ すべて失敗
   - ✅ DLQ に送信
   - ✅ Discord に CRITICAL アラート送信

---

### シナリオ 4: 大量データ処理（性能テスト）

#### 目的
- 100件の領収書を一度に処理できるか確認
- パフォーマンスボトルネックの特定

#### テスト手順

1. **テストデータ準備**
   - Gmail アカウントに100件の領収書メールを送信
   - または web_receipt_sources に100件のダミーデータを投入

2. **処理実行**
   ```bash
   # Gmail polling
   time curl -X POST .../cron
   ```

3. **メトリクス確認**
   - 処理時間: 目標 < 5分
   - メモリ使用量: 目標 < 128MB
   - エラー率: 目標 < 1%

---

## テストチェックリスト

### 事前準備
- [ ] Gmail OAuth トークン取得・設定
- [ ] freee OAuth トークン取得・設定
- [ ] Google Drive OAuth トークン取得・設定
- [ ] GitHub Personal Access Token 取得・設定
- [ ] Discord Webhook URL 設定
- [ ] RECEIPTS_API_KEY 生成・設定
- [ ] Workers デプロイ完了
- [ ] D1 マイグレーション実行完了

### Gmail → freee フロー
- [ ] Gmail Polling 成功
- [ ] PDF 抽出成功
- [ ] R2 保存成功（WORM）
- [ ] freee 登録成功
- [ ] Google Drive バックアップ成功
- [ ] D1 ログ記録成功

### Web Scraper → freee フロー
- [ ] 手動トリガー API 成功
- [ ] GitHub Actions 起動成功
- [ ] Playwright スクレイピング成功
- [ ] R2 保存成功
- [ ] freee 登録成功
- [ ] D1 実行ログ記録成功

### エラーハンドリング
- [ ] Gmail API エラー検知・通知
- [ ] freee API エラー検知・リトライ
- [ ] Web Scraper エラー検知・DLQ送信
- [ ] Discord アラート送信成功

### 性能
- [ ] 100件処理: 5分以内
- [ ] メモリ使用量: 128MB 以内
- [ ] エラー率: 1% 以下

---

## トラブルシューティング

### Gmail Polling が動かない

1. **トークン確認**
   ```bash
   # Refresh token が有効か確認
   curl -X POST https://oauth2.googleapis.com/token \
     -d "client_id=$GMAIL_CLIENT_ID" \
     -d "client_secret=$GMAIL_CLIENT_SECRET" \
     -d "refresh_token=$GMAIL_REFRESH_TOKEN" \
     -d "grant_type=refresh_token"
   ```

2. **OAuth スコープ確認**
   - 必要なスコープ: `https://www.googleapis.com/auth/gmail.readonly`

3. **Workers ログ確認**
   ```bash
   wrangler tail --format pretty
   ```

### freee API が 400 を返す

1. **リクエストボディ確認**
   ```typescript
   console.log('freee request:', JSON.stringify(body, null, 2));
   ```

2. **freee API ドキュメント確認**
   - https://developer.freee.co.jp/docs/accounting/reference

3. **会社 ID 確認**
   ```bash
   echo $FREEE_COMPANY_ID
   ```

### Web Scraper が要素を見つけられない

1. **Playwright Trace 確認**
   ```javascript
   await context.tracing.start({ screenshots: true, snapshots: true });
   // ... スクレイピング処理
   await context.tracing.stop({ path: 'trace.zip' });
   ```

2. **セレクタ確認**
   - ブラウザで対象サイトを開き、DevTools でセレクタを確認

3. **ヘッドレスモード無効化でデバッグ**
   ```javascript
   const browser = await chromium.launch({ headless: false });
   ```

---

## 成功基準

### 機能要件
- ✅ Gmail → freee 自動登録: 100% 成功
- ✅ Web Scraper → freee 登録: 100% 成功
- ✅ R2 WORM ストレージ: 削除不可を確認
- ✅ Google Drive バックアップ: 100% 成功
- ✅ エラー通知: 100% 送信成功

### 非機能要件
- ✅ 処理時間: 1件あたり < 3秒
- ✅ 可用性: 99.5% 以上
- ✅ エラー率: < 1%
- ✅ リトライ成功率: > 80%

---

作成日: 2026-02-04
バージョン: 1.0
