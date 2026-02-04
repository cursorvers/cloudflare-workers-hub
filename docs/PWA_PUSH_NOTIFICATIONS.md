# PWA Push Notifications - 使い方ガイド

## 概要

Cloudflare Workers + D1 Database を使った、セキュアで軽量な PWA Push 通知システム。

### 主な機能

- ✅ **認証必須**: JWT or Cloudflare Access で保護
- ✅ **SSRF防止**: エンドポイントのホワイトリスト検証
- ✅ **型安全**: TypeScript + Zod で厳格なバリデーション
- ✅ **RFC 8030準拠**: VAPID JWT署名による標準的な実装
- ✅ **レート制限**: IP + userId 二重制限

---

## クイックスタート（全自動）

### ワンコマンドでデプロイ

```bash
# 開発環境にデプロイ
./scripts/deploy-push.sh development

# 本番環境にデプロイ
./scripts/deploy-push.sh production
```

**このスクリプトが自動実行:**
1. VAPID鍵の生成（初回のみ）
2. D1マイグレーションの実行
3. Cloudflare Secretsの設定
4. Workers へのデプロイ

---

## 使い方（エンドユーザー）

### 1. Cockpit PWA にアクセス

```
https://your-workers.dev/cockpit
```

### 2. 認証を完了

- **Google SSO**（推奨）: Cloudflare Access経由
- **JWT認証**: `/api/cockpit/auth/login` でトークン取得

### 3. 通知を有効化

1. 画面に「Enable Push」ボタンが表示される
2. クリックすると、ブラウザの許可ダイアログが表示
3. 「許可」を選択
4. 自動的に購読が完了

### 4. 通知を受信

サーバーから通知が送信されると、ブラウザに表示されます。

---

## サーバー側からの通知送信

### API エンドポイント経由

```bash
curl -X POST https://your-workers.dev/api/cockpit/notifications/send \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "タスク完了",
    "body": "データ処理が完了しました",
    "severity": "info",
    "url": "/cockpit/tasks/123",
    "userId": "user-123"
  }'
```

### プログラムから直接呼び出し

```typescript
import { sendPushNotification } from './handlers/push-notifications';

await sendPushNotification(env, {
  title: 'Cockpit Alert',
  body: 'システムエラーが発生しました',
  severity: 'critical',
  url: '/cockpit/errors/456',
  // userId省略時は、全購読者に送信
});
```

---

## セキュリティ

### 実装済みの対策

| 対策 | 内容 |
|------|------|
| **認証/認可** | subscribe/unsubscribe は認証必須 |
| **SSRF防止** | エンドポイントのホワイトリスト検証 |
| **CSRF対策** | Origin/Sec-Fetch-Site 検証 |
| **レート制限** | IP + userId 二重制限 |
| **ペイロードバリデーション** | Zod スキーマで厳格な検証 |

### VAPID鍵の管理

```bash
# 鍵はローカルファイル（gitignore済み）に保存
.vapid-keys.json

# または Cloudflare Secrets に直接設定
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_SUBJECT
```

---

## トラブルシューティング

### 通知が届かない

1. **権限を確認**: ブラウザの通知設定で「許可」になっているか
2. **Service Worker**: `/sw.js` が正しく登録されているか（DevTools → Application → Service Workers）
3. **購読状態**: `/api/cockpit/subscribe` で購読が完了しているか

### iOS (Safari) で動作しない

- iOS では「ホーム画面に追加」したPWAでのみ Push通知が利用可能
- 現在の実装では、ホーム画面追加のガイダンスは未実装（今後実装予定）

### デプロイエラー

```bash
# D1マイグレーションを手動実行
npx wrangler d1 migrations apply knowledge-base --remote

# Secretsを再設定
./scripts/deploy-push.sh development
```

---

## 開発者向け

### アーキテクチャ

```
┌─────────────────────────────────────────┐
│  Cockpit PWA (/cockpit)                 │
│  ├─ Service Worker (/sw.js)             │
│  ├─ Client SDK (push-notifications.ts)  │
│  └─ Enable Push Button                  │
└─────────────────────────────────────────┘
              ↓ HTTPS
┌─────────────────────────────────────────┐
│  Cloudflare Workers                     │
│  ├─ /api/cockpit/subscribe (JWT必須)    │
│  ├─ /api/cockpit/unsubscribe (JWT必須)  │
│  ├─ /api/cockpit/vapid-public-key       │
│  └─ VAPID JWT Signing (vapid.ts)        │
└─────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│  D1 Database                            │
│  └─ push_subscriptions table            │
└─────────────────────────────────────────┘
              ↓ Web Push Protocol
┌─────────────────────────────────────────┐
│  Push Service (FCM, Mozilla, Apple)    │
│  └─ Browser Push Notification           │
└─────────────────────────────────────────┘
```

### テスト

```bash
# 単体テスト
npm test

# E2Eテスト（Playwright）
npx playwright test

# ローカルで動作確認
npx wrangler dev
# → http://localhost:8787/cockpit
```

### ログ監視

```bash
# リアルタイムログ
npx wrangler tail

# D1クエリログ
npx wrangler d1 execute knowledge-base \
  --command "SELECT * FROM push_notification_log ORDER BY created_at DESC LIMIT 10"
```

---

## 実装済み機能（2026-02-04）

### パフォーマンス最適化（CRITICAL - 完了）

- [x] **通知送信の並列処理化（N+1問題の解決）** - Promise.allSettled + バッチ DB 操作
  - パフォーマンス改善: **10-50倍高速化**（Codex 見積もり）
  - 並列送信、バッチ UPDATE/INSERT、410 Gone 一括クリーンアップ
  - GLM レビュー: 7/7 PASSED

### UI/UX改善（HIGH - 完了）

- [x] **Pre-permission Dialog（事前説明）** - `showPrePermissionDialog()`
  - ブラウザプロンプト前に通知の利点を説明
  - 許可率改善見込み: +10-20%（Codex 見積もり）
- [x] **権限拒否時の視覚的フィードバック** - `showPermissionDeniedDialog()`
  - 回復手順を具体的に案内（ブラウザ設定 → サイト設定 → 通知）
  - iOS 特有の案内も含む
- [x] **Subscribe ボタンのローディング状態** - `onLoadingStart/End` コールバック
  - UI 拡張可能な設計（スピナー連携）
  - `subscribe()` 内で try-finally 保証
- [x] **iOS A2HS（ホーム画面追加）ガイダンス** - `detectIOSAndPromptA2HS()`
  - iOS Safari 検出（iPad も含む）
  - Standalone モード判定
  - A2HS 手順を視覚的に案内

### 追加実装（2026-02-04）

- [x] **Cloudflare Queues 統合（スパイク対策）** - 50購読以上で自動的にQueue委譲
  - `PUSH_NOTIFICATION_QUEUE` バインディング追加
  - Queue Consumer (`push-queue-consumer.ts`) でバッチ処理
  - Worker タイムアウト回避、スケーラビリティ向上
- [x] **購読の自動失効（定期クリーンアップ Cron）** - 毎日 02:00 UTC (11:00 JST) 実行
  - 30日間未通知の購読を自動的に inactive 化
  - 90日間未使用の購読を自動削除
  - `handleSubscriptionCleanup` in `scheduled.ts`
- [x] **WCAG 2.1 AA コンプライアンス（UI アクセシビリティ）**
  - キーボードナビゲーションガイダンス（Enter/Esc）
  - スクリーンリーダー向けの明確な文言
  - すべてのダイアログで操作手順を明示
- [x] **ダークモードのコントラスト改善**
  - `PUSH_NOTIFICATION_DARK_MODE_CONTRAST` 定数追加
  - WCAG 2.1 AA 準拠のコントラスト比: 17.06:1 (primary), 6.96:1 (secondary)
  - ホスト UI 向けの配色ガイダンス提供

---

## 参考資料

- [Web Push Protocol (RFC 8030)](https://datatracker.ietf.org/doc/html/rfc8030)
- [VAPID (RFC 8292)](https://datatracker.ietf.org/doc/html/rfc8292)
- [MDN: Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
