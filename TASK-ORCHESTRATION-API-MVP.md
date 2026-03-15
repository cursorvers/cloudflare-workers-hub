# TASK: FUGUE Orchestration API Ultra-MVP（#3）

**優先度**: 3位
**工数**: 5日（Day 1-5）
**目的**: Claude Code の Companion 型永続オーケストレーション API を Workers Hub に実装

---

## 背景

PSCSR 3ラウンド完了、CONDITIONAL APPROVED（3条件付き）:
1. 初週は Sonnet 単一、Haiku分解はフォールバック付きで段階導入
2. auto-retry には idempotency 設計（Step入力保存・二重実行防止）が必須
3. 手動resume のために Run/Step の可観測性を MVP に含む

## アーキテクチャ

```
Dashboard (自然言語) → Workers Hub API (JWT) → Durable Object (Run)
  ├── Step 状態機械 (PENDING→RUNNING→OK/FAILED→BLOCKED)
  ├── LLM Gateway (Sonnet MVP)
  ├── Budget Guard (run/$10, monthly/$100)
  ├── Context: Working Set ≤12k tokens
  ├── D1: 構造化 Memory
  ├── R2: Full Transcript
  └── WebSocket → Dashboard
```

## 実装計画

### Day 1: スキーマ + D1 migration + API 契約

**D1 テーブル**:
```sql
-- runs
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  instruction TEXT NOT NULL,
  budget_usd REAL NOT NULL DEFAULT 10.0,
  cost_usd REAL NOT NULL DEFAULT 0.0,
  memory_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- steps
CREATE TABLE steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  agent TEXT NOT NULL,
  input_ref TEXT,
  output_ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- cost_events
CREATE TABLE cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  step_id TEXT REFERENCES steps(step_id),
  provider TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_steps_run ON steps(run_id);
CREATE INDEX idx_cost_run ON cost_events(run_id);
```

**API エンドポイント**:
```
POST /api/orchestrate          → 202 {run_id, ws_channel}
GET  /api/runs/{run_id}        → Run状態 + Steps + Cost
POST /api/runs/{run_id}/resume → 手動再開
GET  /api/runs/{run_id}/steps  → Step履歴
POST /api/approvals/{id}/decision → 承認/却下
GET  /ws?channel=run:{run_id}  → WebSocket
```

**JWT認証**: 既存の Workers Hub JWT ミドルウェアを流用。全エンドポイントで `owner_id` スコープ強制。

### Day 2: Durable Object（RunCoordinator）

```typescript
// RunCoordinator Durable Object
// 状態機械:
//   PENDING → RUNNING → SUCCEEDED
//                     → FAILED → retry(≤3) → RUNNING
//                              → BLOCKED_ERROR → manual_resume → RUNNING

export class RunCoordinator implements DurableObject {
  // alarm-based step execution
  // idempotency: step入力をR2に保存、idempotency_key で二重実行防止
  // max_steps: 20
}
```

**重要**: 不変性パターン（スプレッド構文）を使うこと。状態更新は `{ ...state, key: newValue }`。

### Day 3: LLM Gateway（Sonnet MVP）

- Anthropic SDK で Claude Sonnet を呼び出し
- Task Pack 生成: 自然言語指示 → Steps 分解
- Working Set: 直近ターン + Memory (≤12k tokens)
- **Sonnet 単一**: Haiku分解は入れない（条件1）

### Day 4: Budget Guard + WebSocket

- **Budget Guard**:
  - Run 単位: $10 上限
  - Monthly: $100 上限
  - cost_events テーブルでトラッキング
  - 超過時: Run を BLOCKED_BUDGET に遷移

- **WebSocket**:
  - Durable Object の WebSocket API を使用
  - イベント: step_started, step_completed, step_failed, run_completed, budget_warning

### Day 5: Resume API + 可観測性 + 統合テスト

- `POST /api/runs/{run_id}/resume`: BLOCKED_ERROR → RUNNING に復帰
- 可観測性: Run/Step の全状態遷移をログ（条件3）
- 統合テスト: Vitest で API E2E テスト

## セキュリティ Top 3（MVP必須）

1. 統一 JWT 認証（HTTP + WebSocket）
2. owner_id スコープ強制（全リソース）
3. Rate/Budget 制限（run/$10, monthly/$100, max_steps/20）

## コスト見積もり

| 項目 | 月額 |
|------|------|
| LLM (Sonnet) | ~$58 |
| Workers/DO/D1/R2 | ~$10 |
| **合計** | **~$68** (at 300 runs/month) |

## コーディング規約

`~/.claude/rules/coding-style.md` を遵守:
- 不変性（`{ ...obj, key: newValue }`、直接変更禁止）
- Zod でバリデーション
- ファイル 800行以下、関数 50行以下
- `any` 型禁止
- エラーハンドリング: try-catch + AppError

## コンテキスト 3層

| 層 | ストレージ | 内容 | サイズ |
|----|-----------|------|--------|
| Transcript | R2 | 全ログ (監査用) | 無制限 |
| Memory | D1 | decisions/constraints/todo/risks | ~2k tokens |
| Working Set | DO内 | 直近ターン + Memory | ≤12k tokens |

## 成功基準

- [ ] `POST /api/orchestrate` で Run 作成 → Steps 自動生成
- [ ] Step 状態機械が正常遷移（PENDING→RUNNING→OK/FAILED）
- [ ] Budget Guard が $10 超過で BLOCKED_BUDGET
- [ ] WebSocket でリアルタイムイベント配信
- [ ] `POST /resume` で BLOCKED_ERROR → RUNNING 復帰
- [ ] JWT 認証 + owner_id スコープ完全
- [ ] Vitest 統合テスト全合格

## 参照

- メモリ: `~/.claude/skills/agent-memory/memories/in-progress/fugue-orchestration-api-pscsr.md`
- Workers Hub: `/Users/masayuki/Dev/cloudflare-workers-hub/`
- Dashboard デザイン: `pencil-welcome-desktop.pen` (Node ID: buoMZ)
- CLAUDE.md: `~/.claude/CLAUDE.md`（コーディング規約・品質基準）
