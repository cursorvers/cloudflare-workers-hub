# 統合テスト セットアップガイド

## 現在の状況

### ✅ 設定済み
- Gmail OAuth (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)
- freee OAuth (CLIENT_ID, CLIENT_SECRET, ENCRYPTION_KEY)
- Discord Webhook
- Admin API Key
- Workers デプロイ完了
- D1 テーブル作成完了

### ❌ 未設定（必須）
1. **GITHUB_TOKEN** - GitHub Actions 用トークン
2. **GITHUB_REPO** - GitHub リポジトリ名
3. **RECEIPTS_API_KEY** - Receipts API アクセスキー

### ❌ 未設定（オプション）
- Google Drive OAuth (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)
- FREEE_COMPANY_ID - freee 会社 ID（通常不要。未設定なら Worker が `/companies` から自動解決して D1 に保存）

---

## セットアップ手順

### 1. GITHUB_TOKEN 設定

```bash
# GitHub Personal Access Token を作成
# https://github.com/settings/tokens/new
# Scopes: workflow (Actions workflows の読み書き)

# トークンを設定
wrangler secret put GITHUB_TOKEN
# → トークンを貼り付け

# リポジトリ名を設定
echo "cursorvers/cloudflare-workers-hub" | wrangler secret put GITHUB_REPO
```

### 2. RECEIPTS_API_KEY 生成

```bash
# API キーを生成して設定
bash /tmp/setup-api-keys.sh

# または手動で:
RECEIPTS_API_KEY=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
echo $RECEIPTS_API_KEY | wrangler secret put RECEIPTS_API_KEY
echo "Generated RECEIPTS_API_KEY: $RECEIPTS_API_KEY"
echo "Save this key to your password manager!"
```

### 3. Google Drive OAuth (オプション)

Google Drive バックアップ機能を使用する場合:

```bash
# Google Cloud Console で OAuth 2.0 認証情報を作成
# https://console.cloud.google.com/apis/credentials

# 認証フローを実行して refresh token を取得
# （src/services/google-auth.ts の手順に従う）

# 設定
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REFRESH_TOKEN
```

---

## 統合テスト実行

### ステップ 1: 環境確認

```bash
# 準備状況チェック
bash /tmp/check-integration-readiness.sh
```

すべての必須項目が ✓ になることを確認。

### ステップ 2: Gmail → freee フロー テスト

```bash
# 手動トリガー（cron の代わり）
curl -X POST https://orchestrator-hub.masa-stage1.workers.dev/api/receipts/poll \
  -H "Authorization: Bearer $ADMIN_API_KEY"

# Workers ログ確認
wrangler tail --format pretty

# 期待されるログ:
# [Gmail Poller] Starting poll
# [Gmail Poller] Found X new messages
# [Receipt Parser] Detected receipt: ...
# [R2 Storage] Stored: receipts/...
# [freee API] Created receipt: ID ...
```

### ステップ 3: Web Scraper → freee フロー テスト

```bash
# stripe ソースが有効化されているか確認
wrangler d1 execute knowledge-base --remote --command \
  "SELECT id, name, enabled FROM web_receipt_sources WHERE id='stripe'"

# 手動トリガー
bash /Users/masayuki/Dev/cloudflare-workers-hub/scripts/test-receipt-trigger.sh stripe

# 期待される出力:
# Test 1: List all sources ✓
# Test 2: Get source details (stripe) ✓
# Test 3: Trigger scraping (stripe) ✓
#   Log ID: <uuid>
#   Check GitHub Actions: https://github.com/...
```

### ステップ 4: GitHub Actions 確認

https://github.com/cursorvers/cloudflare-workers-hub/actions/workflows/web-receipt-scraper.yml

- ワークフローが実行されているか確認
- ログで取得した領収書数を確認
- R2 に保存されているか確認

### ステップ 5: R2 ストレージ確認

```bash
# R2 に保存されたファイルをリスト
wrangler r2 object list receipt-worm-storage --prefix receipts/2026/02/04/

# ファイルをダウンロードして確認
wrangler r2 object get receipt-worm-storage \
  receipts/2026/02/04/stripe_20260204_001.pdf \
  --file /tmp/test.pdf

# PDF を開いて内容確認
open /tmp/test.pdf
```

### ステップ 6: freee 確認

https://secure.freee.co.jp/receipts

- 新しい領収書が登録されているか確認
- メタデータ（金額、取引先、日付）が正確か確認
- WORM ストレージのリンクが機能するか確認

### ステップ 7: DLQ 確認

```bash
# DLQ エントリをリスト
curl -H "Authorization: Bearer $RECEIPTS_API_KEY" \
  https://orchestrator-hub.masa-stage1.workers.dev/api/receipts/dlq

# 期待される出力（初回は空）:
# {
#   "entries": [],
#   "total": 0
# }
```

### ステップ 8: エラーハンドリング テスト

#### テスト 8.1: freee API エラー

```bash
# 無効な会社 ID を一時的に設定
echo "9999999" | wrangler secret put FREEE_COMPANY_ID

# Gmail polling 実行
curl -X POST https://orchestrator-hub.masa-stage1.workers.dev/api/receipts/poll \
  -H "Authorization: Bearer $ADMIN_API_KEY"

# 期待される動作:
# - freee API が 404 を返す
# - リトライロジックが動作
# - DLQ に送信される
# - Discord に HIGH アラート送信

# 元に戻す
echo "1234567" | wrangler secret put FREEE_COMPANY_ID
```

#### テスト 8.2: GitHub Actions トリガー失敗

```bash
# GitHub Token を無効化
echo "invalid_token" | wrangler secret put GITHUB_TOKEN

# Web scraper トリガー
bash scripts/test-receipt-trigger.sh stripe

# 期待される動作:
# - HTTP 503 を返す
# - "GITHUB_TOKEN not configured" エラー
# - DLQ に送信される

# 元に戻す
wrangler secret put GITHUB_TOKEN
# → 正しいトークンを入力
```

---

## トラブルシューティング

### Gmail Polling が動かない

1. **トークン確認**
   ```bash
   # Refresh token でアクセストークン取得テスト
   curl -X POST https://oauth2.googleapis.com/token \
     -d "client_id=$GMAIL_CLIENT_ID" \
     -d "client_secret=$GMAIL_CLIENT_SECRET" \
     -d "refresh_token=$GMAIL_REFRESH_TOKEN" \
     -d "grant_type=refresh_token"
   ```

2. **OAuth スコープ確認**
   - 必要: `https://www.googleapis.com/auth/gmail.readonly`

3. **Workers ログ確認**
   ```bash
   wrangler tail --format pretty | grep Gmail
   ```

### freee API が 400 を返す

1. **company_id 確認**
   - `FREEE_COMPANY_ID` を設定していればそれが優先されます
   - 未設定なら D1（`external_oauth_tokens.company_id`）に保存されているか確認

2. **アクセストークン確認**
   ```bash
   # KV からトークンを取得
   wrangler kv:key get freee:access_token --namespace-id=...
   ```

3. **freee API ドキュメント確認**
   - https://developer.freee.co.jp/docs/accounting/reference

### Web Scraper が要素を見つけられない

1. **Playwright Trace 確認**
   - GitHub Actions のログで trace.zip をダウンロード

2. **セレクタ確認**
   - 対象サイトをブラウザで開き、DevTools でセレクタを確認

3. **ヘッドレスモード無効化でデバッグ**
   ```javascript
   // scripts/web-receipt-scraper.js
   const browser = await chromium.launch({ headless: false });
   ```

---

## 成功基準

### 機能要件
- ✅ Gmail → freee 自動登録: 100% 成功
- ✅ Web Scraper → freee 登録: 100% 成功
- ✅ R2 WORM ストレージ: 削除不可を確認
- ✅ Google Drive バックアップ: 100% 成功（オプション）
- ✅ DLQ: 失敗時に送信される
- ✅ Discord 通知: アラート送信成功

### 非機能要件
- ✅ 処理時間: 1件あたり < 3秒
- ✅ エラー率: < 1%
- ✅ リトライ成功率: > 80%

---

作成日: 2026-02-04
バージョン: 1.0
