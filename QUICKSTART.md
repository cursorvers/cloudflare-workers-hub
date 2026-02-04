# freee領収書登録システム クイックスタートガイド

最終更新: 2026-02-04
ステータス: Phase 3.5 & 4 完了、環境設定 80% 完了

---

## 🚀 クイックスタート（5分で開始）

### 現在の状態
- ✅ 実装完了: 手動トリガーAPI + エラーハンドリング
- ✅ デプロイ完了: https://orchestrator-hub.masa-stage1.workers.dev
- ✅ API キー設定完了: `RECEIPTS_API_KEY`
- ⚠️ 設定必要: `FREEE_COMPANY_ID`, `GITHUB_TOKEN`（2項目）

---

## 📋 必須設定（2ステップ、7分）

### Step 1: FREEE_COMPANY_ID 設定（5分）

```bash
# 1. freee access token 取得
curl -X POST https://accounts.secure.freee.co.jp/public_api/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=refresh_token" \
  -d "client_id=$FREEE_CLIENT_ID" \
  -d "client_secret=$FREEE_CLIENT_SECRET" \
  -d "refresh_token=$FREEE_REFRESH_TOKEN"

# 2. 会社一覧取得
curl -H "Authorization: Bearer $FREEE_ACCESS_TOKEN" \
  https://api.freee.co.jp/api/1/companies

# 3. 会社 ID を設定
echo 'YOUR_COMPANY_ID' | wrangler secret put FREEE_COMPANY_ID
```

**詳細**: `/tmp/get-freee-company-id.sh`

### Step 2: GITHUB_TOKEN 設定（2分）

1. https://github.com/settings/tokens/new にアクセス
2. Note: `Web Receipt Scraper - Cloudflare Workers`
3. Scopes: ✅ `workflow` のみ選択
4. "Generate token" をクリック
5. トークンをコピー
6. 設定:
   ```bash
   wrangler secret put GITHUB_TOKEN
   # → トークンを貼り付け
   ```

**詳細**: `/tmp/github-token-creation-guide.md`

---

## 🧪 統合テスト実行（設定完了後、10分）

### Test 1: Gmail → freee 自動登録

```bash
# Gmail polling 手動トリガー
export ADMIN_API_KEY=<your_key>
curl -X POST https://orchestrator-hub.masa-stage1.workers.dev/api/admin/cron \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"schedule": "*/15 * * * *"}'

# ログ確認
wrangler tail --format pretty
```

**期待される結果**:
```
[Gmail Poller] Starting poll
[Gmail Poller] Found X new messages
[Receipt Parser] Detected receipt: Stripe (USD 29.00)
[R2 Storage] Stored: receipts/2026/02/04/stripe_20260204_001.pdf
[freee API] Created receipt: ID abc123
```

### Test 2: Web Scraper → freee 登録

```bash
# Web scraper 手動トリガー
export RECEIPTS_API_KEY=4d5VeeIym9a77QMhtstg8ssQlaox40Dn
bash scripts/test-receipt-trigger.sh stripe
```

**期待される結果**:
```
✓ List all sources
✓ Get source details (stripe)
✓ Trigger scraping (stripe)
  Log ID: <uuid>
  Check GitHub Actions: https://github.com/...
```

### Test 3: freee 確認

```bash
# freee にアクセスして確認
open https://secure.freee.co.jp/receipts
```

---

## 📊 システム概要

### アーキテクチャ

```
Gmail/Web Scraper
    ↓
Cloudflare Workers (orchestrator-hub)
    ↓
├─ R2 Storage (WORM) ← 領収書 PDF 永久保存
├─ D1 Database ← メタデータ・ログ
├─ freee API ← 領収書登録
└─ Google Drive ← バックアップ（オプション）
```

### API エンドポイント

| エンドポイント | メソッド | 用途 |
|--------------|---------|------|
| `/api/receipts/sources` | GET | ソース一覧取得 |
| `/api/receipts/sources/:id` | GET | ソース詳細取得 |
| `/api/receipts/sources/:id/trigger` | POST | 手動スクレイピング |
| `/api/receipts/dlq` | GET | DLQ 一覧取得 |
| `/api/receipts/dlq/:id` | PATCH | DLQ ステータス更新 |
| `/health` | GET | ヘルスチェック |

### 環境変数

| 変数名 | ステータス | 取得方法 |
|--------|-----------|----------|
| `RECEIPTS_API_KEY` | ✅ 設定済み | 生成済み |
| `GITHUB_REPO` | ✅ 設定済み | 設定済み |
| `GMAIL_*` | ✅ 設定済み | OAuth 済み |
| `FREEE_*` (COMPANY_ID以外) | ✅ 設定済み | OAuth 済み |
| `FREEE_COMPANY_ID` | ❌ 未設定 | API で取得 |
| `GITHUB_TOKEN` | ❌ 未設定 | GitHub で作成 |

---

## 🔧 トラブルシューティング

### Gmail Polling が動かない

**症状**: Gmail から領収書が取得できない

**確認事項**:
1. OAuth トークンが有効か確認
   ```bash
   wrangler secret list | grep GMAIL
   ```

2. Workers ログを確認
   ```bash
   wrangler tail --format pretty | grep Gmail
   ```

3. Gmail API スコープ確認
   - 必要: `https://www.googleapis.com/auth/gmail.readonly`

### freee API が 400 を返す

**症状**: freee API エラー

**確認事項**:
1. FREEE_COMPANY_ID が設定されているか
   ```bash
   wrangler secret list | grep FREEE_COMPANY_ID
   ```

2. アクセストークンが有効か
   - KV に保存されている `freee:access_token` を確認

3. リクエストボディが正しいか
   - freee API ドキュメントを参照: https://developer.freee.co.jp/docs

### Web Scraper が要素を見つけられない

**症状**: Playwright が要素を検出できない

**確認事項**:
1. 対象サイトの HTML 構造が変わっていないか
2. Playwright Trace で確認
   - GitHub Actions ログから trace.zip をダウンロード
3. セレクタを更新
   - `scripts/web-receipt-scraper.js` を編集

---

## 📚 ドキュメント

| ドキュメント | 内容 |
|------------|------|
| `docs/phase-4-error-handling.md` | Phase 4 詳細設計 |
| `docs/integration-test-plan.md` | 統合テスト計画 |
| `docs/integration-test-setup.md` | セットアップ手順 |
| `docs/integration-test-results.md` | テスト結果 |
| `QUICKSTART.md` | このファイル |

### スクリプト

| スクリプト | 用途 |
|-----------|------|
| `scripts/test-receipt-trigger.sh` | API テスト実行 |
| `/tmp/get-freee-company-id.sh` | freee 会社 ID 取得 |
| `/tmp/github-token-creation-guide.md` | GitHub Token 作成手順 |
| `/tmp/setup-api-keys.sh` | API キー生成 |

---

## 🎯 次のアクション

### 今すぐ実行（7分）
1. ✅ FREEE_COMPANY_ID 設定（5分）
2. ✅ GITHUB_TOKEN 設定（2分）

### 設定完了後（10分）
3. ✅ Gmail → freee フローテスト
4. ✅ Web Scraper → freee フローテスト
5. ✅ freee で領収書確認

### オプション（Phase 5）
6. ⏸️ Google Drive バックアップ設定
7. ⏸️ Slack 通知設定
8. ⏸️ メトリクス収集設定

---

## 💡 ヒント

### 開発時に便利なコマンド

```bash
# ログをリアルタイムで監視
wrangler tail --format pretty

# D1 データベースクエリ
wrangler d1 execute knowledge-base --remote --command "SELECT * FROM ..."

# R2 ファイル一覧
wrangler r2 object list receipt-worm-storage

# Secrets 一覧
wrangler secret list

# デプロイ
npm run deploy
```

### API テスト用エイリアス

```bash
# .bashrc または .zshrc に追加
export RECEIPTS_API_KEY=4d5VeeIym9a77QMhtstg8ssQlaox40Dn
export WORKER_URL=https://orchestrator-hub.masa-stage1.workers.dev

alias test-sources="curl -H 'Authorization: Bearer \$RECEIPTS_API_KEY' \$WORKER_URL/api/receipts/sources"
alias test-dlq="curl -H 'Authorization: Bearer \$RECEIPTS_API_KEY' \$WORKER_URL/api/receipts/dlq"
alias test-health="curl \$WORKER_URL/health | jq"
```

---

## 📞 サポート

### 問題が解決しない場合

1. **Workers ログ確認**: `wrangler tail --format pretty`
2. **GitHub Issues**: バグ報告・機能リクエスト
3. **ドキュメント**: `docs/` ディレクトリ参照
4. **Agent Memory**: `~/.claude/skills/agent-memory/memories/in-progress/freee-receipt-phase35-phase4-complete.md`

---

## ✅ チェックリスト

設定完了の確認:

- [ ] FREEE_COMPANY_ID 設定済み
- [ ] GITHUB_TOKEN 設定済み
- [ ] Gmail → freee フロー動作確認
- [ ] Web Scraper → freee フロー動作確認
- [ ] freee に領収書が登録されることを確認
- [ ] R2 に PDF が保存されることを確認
- [ ] DLQ が正常に動作することを確認

すべて ✅ になったら Phase 3.5 & 4 完全完了！

---

作成日: 2026-02-04
バージョン: 1.0
