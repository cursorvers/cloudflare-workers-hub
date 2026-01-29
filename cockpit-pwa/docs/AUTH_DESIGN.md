# cockpit-pwa 認証設計

## 認証フロー

```
PWA (iPhone/Desktop)
    ↓ Cloudflare Access (Google SSO)
Cloudflare Edge
    ↓ Cf-Access-Jwt-Assertion + Origin 検証
Workers Hub ← JWT 検証 + RBAC + CSRF トークン
    ↓ WebSocket 接続
Durable Object (cockpit-websocket)
```

## 認証方式

### 1. Cloudflare Access (本番・必須)

- **ヘッダー**: `Cf-Access-Jwt-Assertion`
- **取得方法**: Cloudflare Access が自動付与
- **用途**: PWA からの人間ユーザー認証
- **追加保護**: Origin 検証 + CSRF トークン

### 2. API Key (サーバー間のみ)

- **⚠️ PWA では使用禁止**
- **用途**: Local Agent、バックエンド間通信のみ
- **理由**: クライアントへの長期秘密鍵埋め込みは漏洩リスク

### 3. 短命 JWT (セッション用)

- **ヘッダー**: `Authorization: Bearer xxx`
- **有効期限**: 15分
- **リフレッシュ**: httpOnly Cookie 経由
- **用途**: WebSocket 接続認証

## PWA 実装方針

### WebSocket 接続（セキュア版）

```typescript
// 1. まず短命トークンを取得
const tokenRes = await fetch('/api/cockpit/auth/ws-token', {
  method: 'POST',
  credentials: 'include', // Access Cookie
  headers: {
    'X-CSRF-Token': csrfToken, // CSRF 対策
  },
});
const { token } = await tokenRes.json();

// 2. トークン付きで WebSocket 接続
const ws = new WebSocket(
  `wss://orchestrator-hub.masa-stage1.workers.dev/ws/cockpit?token=${token}`
);
```

### REST API 呼び出し

```typescript
fetch('/api/cockpit/tasks', {
  credentials: 'include',
  headers: {
    'X-CSRF-Token': csrfToken,
  },
});
```

## セキュリティ対策（Codex レビュー反映）

| 脅威 | 対策 | 実装箇所 |
|------|------|----------|
| **CSRF** | CSRF トークン + Origin 検証 | サーバー/クライアント |
| **XSS** | React 自動エスケープ、CSP、メッセージサニタイズ | クライアント |
| **トークン漏洩** | 短命トークン（15分）、httpOnly リフレッシュ | サーバー |
| **API Key 漏洩** | PWA にキー埋め込み禁止 | 設計 |
| **WS メッセージ改ざん** | JSON スキーマ検証、Zod バリデーション | クライアント/サーバー |

## 禁止事項

- ❌ localStorage へのトークン保存
- ❌ PWA への X-API-Key 埋め込み
- ❌ dangerouslySetInnerHTML の使用
- ❌ 未検証の WS メッセージの直接レンダリング

## 環境変数

```env
# .env.local
NEXT_PUBLIC_WS_URL=wss://orchestrator-hub.masa-stage1.workers.dev/ws/cockpit
NEXT_PUBLIC_API_URL=https://orchestrator-hub.masa-stage1.workers.dev/api
# API Key は PWA に含めない
```
