# Phase 4: エラーハンドリング強化計画

## 概要

freee領収書登録システムの本番運用に向けたエラーハンドリングとリカバリー機能の強化。

---

## 1. リトライロジック拡張

### 現状

- Gmail API: exponential backoff + 3回リトライ（実装済み）
- freee API: 基本的なリトライなし
- Web scraper: 単発実行、失敗時の自動リトライなし

### 改善策

#### 1.1 freee API リトライ

```typescript
// src/services/freee-api.ts

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableStatusCodes: number[];
}

const FREEE_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

async function freeeApiWithRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = FREEE_RETRY_CONFIG
): Promise<T> {
  let lastError: Error;
  let delayMs = config.initialDelayMs;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // 最後のリトライで失敗したら throw
      if (attempt === config.maxRetries) break;

      // リトライ可能なエラーか判定
      if (error instanceof Response) {
        if (!config.retryableStatusCodes.includes(error.status)) {
          throw error; // リトライ不可
        }
      }

      // Exponential backoff with jitter
      const jitter = Math.random() * 0.3 * delayMs;
      await new Promise(resolve => setTimeout(resolve, delayMs + jitter));
      delayMs = Math.min(delayMs * config.backoffMultiplier, config.maxDelayMs);
    }
  }

  throw lastError!;
}
```

#### 1.2 Web Scraper リトライ

```yaml
# .github/workflows/web-receipt-scraper.yml

- name: Run scraper with retry
  uses: nick-invision/retry@v2
  with:
    timeout_minutes: 10
    max_attempts: 3
    retry_wait_seconds: 60
    command: node scripts/web-receipt-scraper.js
```

---

## 2. Dead Letter Queue (DLQ) 実装

### 目的

- 複数回失敗した処理を DLQ に送り、手動介入の対象とする
- 失敗原因を分析して恒久対策を立てる

### 設計

#### 2.1 D1 テーブル

```sql
-- DLQ テーブル
CREATE TABLE IF NOT EXISTS receipt_processing_dlq (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- 'gmail' | 'web_scraper'
  original_message TEXT NOT NULL, -- JSON serialized original data
  failure_reason TEXT NOT NULL,   -- Error message
  failure_count INTEGER NOT NULL DEFAULT 1,
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'retrying' | 'resolved' | 'abandoned'
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_dlq_status ON receipt_processing_dlq(status);
CREATE INDEX idx_dlq_source ON receipt_processing_dlq(source);
```

#### 2.2 DLQ 送信ロジック

```typescript
// src/services/dlq.ts

interface DLQEntry {
  id: string;
  source: 'gmail' | 'web_scraper';
  originalMessage: unknown;
  failureReason: string;
  failureCount: number;
}

async function sendToDLQ(env: Env, entry: DLQEntry): Promise<void> {
  await env.DB!.prepare(
    `INSERT INTO receipt_processing_dlq
     (id, source, original_message, failure_reason, failure_count,
      first_failed_at, last_failed_at, status)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'pending')
     ON CONFLICT(id) DO UPDATE SET
       failure_count = failure_count + 1,
       last_failed_at = datetime('now'),
       failure_reason = ?,
       updated_at = datetime('now')`
  )
    .bind(
      entry.id,
      entry.source,
      JSON.stringify(entry.originalMessage),
      entry.failureReason,
      entry.failureCount,
      entry.failureReason
    )
    .run();

  // 閾値超過で通知
  if (entry.failureCount >= 3) {
    await notifyDLQAlert(env, entry);
  }
}
```

#### 2.3 DLQ 管理 API

```typescript
// GET /api/receipts/dlq - DLQ 一覧取得
// PATCH /api/receipts/dlq/:id - ステータス更新（resolved, retrying, abandoned）
// POST /api/receipts/dlq/:id/retry - 手動リトライ
// DELETE /api/receipts/dlq/:id - DLQ エントリ削除
```

---

## 3. エラー通知システム

### 3.1 通知レベル

| レベル | 条件 | 通知先 | 例 |
|--------|------|--------|-----|
| **CRITICAL** | 全処理が停止 | Discord + Email | Gmail API トークン失効 |
| **HIGH** | 3回以上連続失敗 | Discord | freee API 503 × 3 |
| **MEDIUM** | 単発失敗（リトライ成功） | ログのみ | 一時的な 429 |
| **LOW** | 警告（処理成功） | ログのみ | スクレイパー要素変更検知 |

### 3.2 Discord Webhook 通知

```typescript
// src/services/notifications.ts

interface ErrorNotification {
  level: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  description: string;
  source: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

async function sendDiscordAlert(
  env: Env,
  notification: ErrorNotification
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const color = {
    CRITICAL: 0xff0000, // Red
    HIGH: 0xff9900,     // Orange
    MEDIUM: 0xffff00,   // Yellow
    LOW: 0x00ff00,      // Green
  }[notification.level];

  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [
        {
          title: `[${notification.level}] ${notification.title}`,
          description: notification.description,
          color,
          fields: [
            { name: 'Source', value: notification.source, inline: true },
            { name: 'Timestamp', value: notification.timestamp, inline: true },
          ],
          footer: { text: 'freee Receipt System' },
        },
      ],
    }),
  });
}
```

---

## 4. モニタリングとアラート

### 4.1 ヘルスチェック API

```typescript
// GET /api/receipts/health

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: {
    gmail: { status: string; lastSuccessAt: string };
    freee: { status: string; lastSuccessAt: string };
    webScraper: { status: string; lastRunAt: string };
    dlqSize: number;
  };
}
```

### 4.2 メトリクス収集

- Gmail polling 成功率
- freee API レスポンスタイム
- Web scraper 成功率
- DLQ サイズ推移

---

## 5. 実装スケジュール

### Week 1: リトライロジック拡張
- [ ] freee API リトライ実装
- [ ] Web scraper リトライ設定
- [ ] 単体テスト

### Week 2: DLQ 実装
- [ ] D1 テーブル作成
- [ ] DLQ 送信ロジック実装
- [ ] DLQ 管理 API 実装
- [ ] 統合テスト

### Week 3: 通知システム
- [ ] Discord Webhook 統合
- [ ] 通知レベル実装
- [ ] アラート閾値設定
- [ ] 本番環境テスト

### Week 4: モニタリング
- [ ] ヘルスチェック API 実装
- [ ] メトリクス収集
- [ ] ダッシュボード構築（Grafana/Cloudflare Analytics）

---

## 6. 統合テストシナリオ

### シナリオ 1: Gmail API 一時エラー
1. Gmail API が 429 を返す
2. Exponential backoff でリトライ
3. 3回目で成功
4. 処理継続

### シナリオ 2: freee API 恒久エラー
1. freee API が 400 を返す（不正なデータ）
2. リトライスキップ
3. DLQ に送信
4. Discord に HIGH アラート

### シナリオ 3: Web Scraper 要素変更
1. スクレイパーが要素を発見できない
2. 3回リトライ（GitHub Actions）
3. すべて失敗
4. DLQ に送信 + CRITICAL アラート

### シナリオ 4: 全フロー正常
1. Gmail → Workers → R2 → freee → Drive
2. すべて成功
3. メトリクス記録のみ

---

## 7. 成功基準

- **可用性**: 99.5% 以上（月間 3.6 時間以内のダウンタイム）
- **リトライ成功率**: 80% 以上（一時エラーからの自動復旧）
- **DLQ 処理時間**: 平均 24 時間以内に解決
- **通知精度**: 誤検知率 5% 以下

---

作成日: 2026-02-04
バージョン: 1.0
