# Cloudflare Access & Tunnel セットアップガイド

FUGUE Cockpit の本番セキュリティ強化として、Cloudflare Access（Zero Trust 認証）と Tunnel（NAT 超え接続）を設定します。

## アーキテクチャ

```
PWA (iPhone/Desktop)
  ↓ Cloudflare Access (Google SSO)
Cloudflare Edge
  ↓ Cf-Access-Jwt-Assertion
Workers Hub ← JWT 検証 + 既存 RBAC
  ↑ Cloudflare Tunnel (outbound-only)
Local Agent (Mac)
```

## Phase 1: Cloudflare Access セットアップ

### 1.1 Cloudflare Dashboard 設定

1. [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) にログイン
2. **Access** → **Applications** → **Add an Application**
3. **Self-hosted** を選択
4. 設定:
   - **Application name**: `FUGUE Cockpit`
   - **Session Duration**: 24 hours
   - **Application domain**: `orchestrator-hub.masa-stage1.workers.dev`
   - **Path**: `/api/cockpit/*`

### 1.2 Identity Provider 設定

1. **Settings** → **Authentication** → **Login methods**
2. **Add new** → **Google**
3. Google Cloud Console で OAuth 2.0 クライアント ID を作成
4. Client ID と Client Secret を入力

### 1.3 Access Policy 設定

1. **Policies** → **Add a policy**
2. 設定:
   - **Policy name**: `Allowed Users`
   - **Action**: Allow
   - **Include**: Emails ending in `@gmail.com` (または特定のメールアドレス)

### 1.4 Application AUD の取得

1. Application を保存後、詳細画面を開く
2. **Application Audience (AUD) Tag** をコピー
3. Workers Hub の設定に追加:

```bash
# 開発環境 (wrangler.toml)
# CF_ACCESS_AUD = "<copied-aud>"

# 本番環境 (Cloudflare Dashboard の Secrets)
wrangler secret put CF_ACCESS_AUD
# <copied-aud> を入力
```

## Phase 2: Cloudflare Tunnel セットアップ

### 2.1 cloudflared インストール

```bash
brew install cloudflare/cloudflare/cloudflared
```

### 2.2 認証とトンネル作成

```bash
# Cloudflare にログイン
cloudflared tunnel login

# トンネル作成
cloudflared tunnel create fugue-cockpit-agent

# DNS ルート追加
cloudflared tunnel route dns fugue-cockpit-agent agent.masa-stage1.workers.dev
```

### 2.3 設定ファイルの作成

```bash
# テンプレートをコピー
cp ~/.cloudflared/config.yml.template ~/.cloudflared/config.yml

# 実際の Tunnel ID で更新
# cloudflared tunnel list で確認可能
vim ~/.cloudflared/config.yml
```

### 2.4 トンネル起動

```bash
# フォアグラウンドで起動（テスト用）
cloudflared tunnel run fugue-cockpit-agent

# バックグラウンドサービスとして登録（本番用）
sudo cloudflared service install
sudo launchctl start com.cloudflare.cloudflared
```

## Phase 3: Local Agent 設定

### 3.1 config.json の更新

`local-agent/config.json`:
```json
{
  "tunnelEnabled": true,
  "tunnelHostname": "agent.masa-stage1.workers.dev"
}
```

### 3.2 起動確認

```bash
cd local-agent
npm run start
```

期待される出力:
```
✅ FUGUE Cockpit Local Agent 初期化完了
📁 監視対象リポジトリ: 3件
🔄 チェック間隔: 60秒
🚇 Cloudflare Tunnel: agent.masa-stage1.workers.dev
📊 Observability 同期: 有効
🚀 Local Agent 起動中...
🔌 Workers Hub に接続中 (Tunnel): wss://agent.masa-stage1.workers.dev/ws
✅ Workers Hub に接続しました
```

## 検証手順

### Access 認証の検証

1. ブラウザで `https://orchestrator-hub.masa-stage1.workers.dev/api/cockpit/tasks` にアクセス
2. Google SSO 画面にリダイレクトされることを確認
3. ログイン後、タスク一覧が表示されることを確認
4. `wrangler tail` でログ確認:
   ```
   [Auth] Authenticated via Cloudflare Access { email: "...", userId: "...", role: "..." }
   ```

### Tunnel 接続の検証

```bash
# トンネル状態確認
cloudflared tunnel info fugue-cockpit-agent

# Local Agent ログ確認
# "Workers Hub に接続しました" が表示されれば成功
```

### E2E 検証

1. PWA でログイン
2. Git リポジトリステータスが表示されることを確認
3. タスク作成 → Local Agent での実行を確認

## トラブルシューティング

### Access 関連

**症状**: 401 Unauthorized
- Access Policy が正しく設定されているか確認
- ユーザーが `cockpit_users` テーブルに登録されているか確認

**症状**: 403 User not registered
- DB にユーザーを追加:
  ```sql
  INSERT INTO cockpit_users (user_id, email, role, is_active)
  VALUES ('user_001', 'your@email.com', 'admin', 1);
  ```

### Tunnel 関連

**症状**: WebSocket 接続失敗
- cloudflared が起動しているか確認: `cloudflared tunnel info`
- DNS 設定が正しいか確認: `nslookup agent.masa-stage1.workers.dev`

**症状**: 接続がすぐ切れる
- config.yml の `tcpKeepAlive` 設定を確認

## セキュリティ考慮事項

### 移行期間中の両方式サポート

現在、以下の順序で認証を試行:
1. Cloudflare Access JWT (Cf-Access-Jwt-Assertion)
2. 標準 JWT (Authorization: Bearer)

これにより:
- PWA ユーザーは Access 経由で認証
- 既存 API クライアントは従来の JWT で継続利用可能
- ロックアウトリスクを最小化

### Access 完全移行後

移行完了後、`cockpit-api.ts` の `authenticateAndAuthorize` 関数から JWT フォールバックを削除可能。

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `/src/utils/cloudflare-access.ts` | Access JWT 検証ロジック |
| `/src/handlers/cockpit-api.ts` | API ハンドラー（認証統合） |
| `/wrangler.toml` | Access 環境変数 |
| `/local-agent/src/config.ts` | Tunnel 設定スキーマ |
| `/local-agent/src/index.ts` | Tunnel 接続ロジック |
| `~/.cloudflared/config.yml` | cloudflared 設定 |
