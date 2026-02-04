#!/bin/bash
set -e

echo "🚀 PWA Push Notifications - 全自動デプロイ"
echo "============================================"

# 環境変数の確認
ENV=${1:-default}
if [ "$ENV" = "development" ]; then
  ENV="default"
  echo "📍 Environment: default (development settings in wrangler.toml)"
else
  echo "📍 Environment: $ENV"
fi

# VAPID鍵の生成または読み込み
VAPID_FILE=".vapid-keys.json"

if [ ! -f "$VAPID_FILE" ]; then
  echo "🔑 VAPID鍵を生成中..."
  npx web-push generate-vapid-keys --json > "$VAPID_FILE"
  echo "✅ VAPID鍵を生成しました: $VAPID_FILE"
  echo "⚠️  このファイルは gitignore に追加済みです（漏洩防止）"
else
  echo "✅ 既存のVAPID鍵を使用: $VAPID_FILE"
fi

# VAPID鍵を読み込み
VAPID_PUBLIC=$(jq -r '.publicKey' "$VAPID_FILE")
VAPID_PRIVATE=$(jq -r '.privateKey' "$VAPID_FILE")
VAPID_SUBJECT="${VAPID_SUBJECT:-mailto:admin@example.com}"

echo "📦 D1マイグレーションを実行中..."
if [ "$ENV" = "default" ]; then
  npx wrangler d1 migrations apply knowledge-base --remote
else
  npx wrangler d1 migrations apply knowledge-base --env "$ENV" --remote
fi

echo "🔐 VAPID秘密鍵をCloudflareに設定中..."
if [ "$ENV" = "default" ]; then
  echo "$VAPID_PUBLIC" | npx wrangler secret put VAPID_PUBLIC_KEY
  echo "$VAPID_PRIVATE" | npx wrangler secret put VAPID_PRIVATE_KEY
  echo "$VAPID_SUBJECT" | npx wrangler secret put VAPID_SUBJECT
else
  echo "$VAPID_PUBLIC" | npx wrangler secret put VAPID_PUBLIC_KEY --env "$ENV"
  echo "$VAPID_PRIVATE" | npx wrangler secret put VAPID_PRIVATE_KEY --env "$ENV"
  echo "$VAPID_SUBJECT" | npx wrangler secret put VAPID_SUBJECT --env "$ENV"
fi

echo "🚀 Cloudflare Workersにデプロイ中..."
if [ "$ENV" = "default" ]; then
  npx wrangler deploy
else
  npx wrangler deploy --env "$ENV"
fi

# デプロイ後のURL取得
if [ "$ENV" = "production" ]; then
  WORKER_URL="https://orchestrator-hub.your-subdomain.workers.dev"
else
  WORKER_URL="http://localhost:8787"
fi

echo ""
echo "✅ デプロイ完了！"
echo "============================================"
echo "📱 Cockpit PWA: $WORKER_URL/cockpit"
echo "🔔 Push API: $WORKER_URL/api/cockpit/subscribe"
echo "📋 Service Worker: $WORKER_URL/sw.js"
echo ""
echo "🔑 VAPID公開鍵（クライアント用）:"
echo "$VAPID_PUBLIC"
echo ""
echo "📖 使い方:"
echo "1. $WORKER_URL/cockpit にアクセス"
echo "2. 認証を完了（Google SSO or JWT）"
echo "3. 'Enable Push' ボタンをクリック"
echo "4. ブラウザの許可ダイアログで「許可」を選択"
echo ""
echo "🧪 通知テスト（curlで送信）:"
echo "curl -X POST $WORKER_URL/api/cockpit/notifications/send \\"
echo "  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"title\":\"Test\",\"body\":\"Hello from PWA!\"}'"
