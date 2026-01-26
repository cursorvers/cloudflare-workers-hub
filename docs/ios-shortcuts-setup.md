# iOS Shortcuts - Limitless Sync

Pendant の録音を自動で Supabase に同期するための iOS Shortcuts 設定ガイド。

## ショートカット: Limitless Sync

### 手動実行用

1. **ショートカットApp** を開く
2. **+** で新規作成
3. 名前: `Limitless Sync`

#### アクション構成

```
1. [URLの内容を取得]
   URL: https://orchestrator-hub.masa-stage1.workers.dev/api/limitless/webhook-sync
   方法: POST
   ヘッダ:
     Content-Type: application/json
     Authorization: Bearer <MONITORING_API_KEY>
   本文: JSON
     {
       "userId": "masayuki",
       "maxAgeHours": 1
     }

2. [入力からテキストを取得]
   → 変数: result

3. [通知を表示]
   タイトル: Limitless Sync
   本文: result
```

### オートメーション (自動実行)

#### 帰宅時に自動同期

1. **オートメーション** タブ → **+**
2. トリガー: **到着** → 自宅を選択
3. **すぐに実行** をON
4. 上記の「Limitless Sync」ショートカットを実行

#### 毎時間同期 (バッテリー消費注意)

1. **オートメーション** タブ → **+**
2. トリガー: **時刻** → 毎時間
3. **すぐに実行** をON
4. 上記の「Limitless Sync」ショートカットを実行

## パラメータ

| パラメータ | 説明 | デフォルト |
|-----------|------|----------|
| `userId` | ユーザー識別子 (必須) | - |
| `triggerSource` | `ios_shortcut` / `notification` / `manual` | `ios_shortcut` |
| `maxAgeHours` | 取得する録音の時間範囲 (1-24) | `1` |
| `includeAudio` | 音声データを含む | `false` |

## 認証

| 方式 | レート制限 | 推奨 |
|------|-----------|------|
| なし | 10 req/min per IP | 開発テスト用 |
| Bearer token (MONITORING_API_KEY) | 60 req/min | 本番推奨 |
| Bearer token (ASSISTANT_API_KEY) | 60 req/min | 代替 |

## レスポンス例

### 成功
```json
{
  "success": true,
  "result": {
    "synced": 5,
    "skipped": 0,
    "errors": 0,
    "durationMs": 6557
  },
  "message": "Successfully synced 5 recording(s)"
}
```

### スキップ (最近同期済み)
```json
{
  "success": true,
  "skipped": true,
  "reason": "Recent sync already completed",
  "lastSync": "2026-01-26T06:45:00.000Z",
  "nextAllowedSync": "2026-01-26T06:55:00.000Z"
}
```

## トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| 429 Too Many Requests | レート制限 | 1分待ってリトライ、または認証を追加 |
| 500 Internal Error | KV/API エラー | 数分後にリトライ (自動フォールバックあり) |
| タイムアウト | Workers 処理時間超過 | maxAgeHours を小さくする |
