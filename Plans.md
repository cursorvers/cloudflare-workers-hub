# Cloudflare Workers Hub - Plans

## 概要
**MVP 完成: 82% (2026-01-29)** - 保守モード移行
**Limitless Phase 5 デプロイ完了 (2026-02-03)** - 協調的振り返りシステム稼働中
オーケストレーションレビュー結果: **8.35/10 READY** (2026-01-25)

## デプロイ情報
- URL: https://orchestrator-hub.masa-stage1.workers.dev
- Version ID: 78e92ffb-5e20-4cce-a4a1-b4bf7b95cd17 (2026-02-03)
- Previous: 5a33bb54-aa97-48cf-a2da-4207b36b717c (2026-01-29)

---

# FUGUE Cockpit - 統合 Web App

> **目的**: FUGUE システム全体を単一の Web App で管理し、移動中でも開発を進められる

## アーキテクチャ

```
FUGUE Cockpit (PWA) ← スマホ/PC
       │ WebSocket
       ▼
Cloudflare Workers Hub
├── /api/cockpit/* → タスク/Git/アラート
└── /api/ws       → リアルタイム
       │ Tunnel
       ▼
Local Agent (Mac)
├── Task Executor
├── Git Monitor
└── Log Streamer
```

## 実装状況 (2026-01-29)

| Phase | 状態 | 主要ファイル |
|-------|------|-------------|
| 1. 基盤構築 | ✅ DONE | `migrations/0005_cockpit_tables.sql`, `cockpit-api.ts`, `cockpit-websocket.ts`, `local-agent/` |
| 2. Git Dashboard | ✅ DONE | `git-dashboard.tsx` |
| 3. Kanban MVP | ✅ DONE | `task-kanban.tsx` |
| 4. Command Center | ✅ DONE | `command-center.tsx` |
| 5. リアルタイム | ✅ DONE | `CockpitWebSocket` DO |
| PWA Frontend | ✅ DONE | インライン HTML (`/cockpit`) |
| **6. Cloudflare Access** | ✅ DONE | `cloudflare-access.ts`, Google SSO |
| **7. Tunnel 設定** | ⏳ Optional | `local-agent/src/config.ts` (設定済み、cloudflared 未セットアップ) |

## 次のステップ: Local Agent 起動

```bash
# 1. API キーを設定
cd local-agent
cp .env.example .env
# .env を編集して QUEUE_API_KEY を設定

# 2. Local Agent を起動
npm run dev
```

## 残タスク

### 完了済み (最新6件、詳細は docs/ARCHIVE_2026-01-25.md)
- [x] **PWA通知統合** ✅ (2026-01-30) - notification-hub.ts追加、/broadcast-alertエンドポイント、Discord fallback対応
- [x] **FUGUE P0-P2 セキュリティ修正** ✅ (2026-01-30) - JWT環境変数化, コマンドインジェクション対策, WebSocket状態永続化, テスト91%+
- [x] **CockpitGateway FUGUE統合** ✅ (2026-01-30) - delegation-matrix.mdベースのルーティング、3者合議フラグ
- [x] **Daemon状態表示** ✅ (2026-01-30) - DaemonStatus.tsx追加、/api/daemon/health連携
- [x] **cockpit-pwa アクセシビリティ修正** ✅ (2026-01-30) - WCAG AA 準拠 (コントラスト 4.5:1+, タップターゲット 44px+)
- [x] **Agentic Vision テスト** ✅ (2026-01-30) - Gemini 3 Flash Code Execution で UI 検証動作確認

### 未完了（オプション）
- [ ] Cloudflare Tunnel 設定 - NAT 越え接続（外部ネットワークからアクセス時に必要）
- [ ] Push 通知統合 - VAPID 設定済み、フロントエンド連携待ち
- [ ] KV 使用量閾値通知 - 80%で Slack 通知（課金判断用）

---

## KV 最適化 (2026-01-29)

> Cloudflare から警告を受けて実施

### インシデント履歴

| 日時 | 警告 | 原因 | 対応 |
|------|------|------|------|
| 21:25 JST | **KV read 50% 超過** | WebSocket 5秒間隔 | 15秒に延長 |
| 22:08 JST | **KV put 1000 超過 (429)** | rate-limiter が毎リクエストで put | インメモリ優先に変更 |

### 対応済み
| 施策 | 効果 |
|------|------|
| WebSocket 再接続間隔 5秒→15秒 | KV read 66%削減 |
| **rate-limiter インメモリ優先** | **KV put 99%削減** |

### 課金判断
**ハイブリッド案を採用**: 現状維持 + 閾値監視

| 条件 | アクション |
|------|-----------|
| KV 使用 < 80% | Free プラン継続 |
| KV 使用 ≥ 80% | Workers Paid ($5/月) へ移行 |

### KV Free プラン制限

| リソース | 上限/日 | 現状 |
|---------|--------|------|
| read | 100,000 | ~50% → 最適化済み |
| put | 1,000 | **超過** → インメモリ化で解消 |
| delete | 1,000 | 未使用 |
| list | 1,000 | 未使用 |

### 未対応（必要時に実施）
- Daemon ポーリング間隔延長

---

# Limitless Phase 5: 協調的振り返りシステム

## 概要

**目的**: 人間介入必須の振り返りワークフローを実装し、責任あるAI設計を具現化

**核心思想**:
- 完全自動化を拒否、人間の振り返りを必須化
- Notify → Question → Review の3ステップ実装
- 医療情報保護（PHI検出・マスキング）

## アーキテクチャ

```
Limitless Pendant
    ↓ iOS Shortcut（ハイライトマーク）
Workers Hub（pending_review状態で保存）
    ↓ 24時間後
Notification Layer（Discord/Slack/PWA）
    ↓
User Reflection（人間の振り返り）
├─ 構造化プロンプト
├─ PHI検出・承認
└─ 公開/非公開選択
    ↓
Long-term Analysis（3ヶ月パターン分析）
```

## 実装状況 (2026-02-03)

| Phase | 状態 | 内容 |
|-------|------|------|
| Phase 1 | ✅ DONE | 基本パイプライン（Pendant → Workers AI → Supabase） |
| Phase 4 | ✅ DONE | ハイライト機能（iOS Shortcut統合） |
| **Phase 5** | ✅ **DEPLOYED** | **協調的振り返りシステム（本番稼働中）** |

## デプロイ履歴

| 日時 | Version ID | 内容 |
|------|-----------|------|
| 2026-02-03 | `78e92ffb-5e20-4cce-a4a1-b4bf7b95cd17` | Phase 5 本番デプロイ（PHI検出・通知システム） |
| 2026-01-29 | `5a33bb54-aa97-48cf-a2da-4207b36b717c` | Cockpit基盤 |

## MVP実装タスク（実施: 2026-02-02~03）

### タスク#1: PHI検出エンジン ✅
- [x] 正規表現パターン定義（氏名、生年月日、MRN、電話番号、SSN、住所、メール）
- [x] `detectPHI()` 関数実装 (`src/services/phi-detector.ts`)
- [x] `maskPHI()` 関数実装
- [x] ユニットテスト（15テスト + 統合テスト4件）

### タスク#2: 振り返りAPI ✅
- [x] `POST /api/limitless/reflection` エンドポイント (`src/handlers/limitless-reflection.ts`)
- [x] PHI検出統合（自動マスキング + contains_phi フラグ）
- [x] Zod スキーマバリデーション
- [x] エラーハンドリング

### タスク#3: 通知システム統合 ✅
- [x] Discord/Slack Webhook統合 (`src/services/reflection-notifier.ts`)
- [x] 通知頻度制御（KV 24時間スロットル）
- [x] Multi-channel notification（並列送信）

### タスク#4: Cronジョブ設定 ✅
- [x] Daily cron統合 (`src/handlers/scheduled-reflection.ts`)
- [x] 24-48時間窓でのハイライト検索
- [x] 分散ロック（重複防止）
- [x] `notified_at` タイムスタンプ更新

### タスク#5: 統合テスト ✅
- [x] PHI検出統合テスト（15/15 passed）
- [x] 通知システム基本テスト（9/11 passed, mock issues only）

## データベース設計

### 新規テーブル: `user_reflections`

```sql
CREATE TABLE user_reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id UUID REFERENCES lifelog_highlights(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  reflection_text TEXT NOT NULL,
  key_insights TEXT[],
  action_items TEXT[],
  contains_phi BOOLEAN DEFAULT FALSE,
  phi_approved BOOLEAN DEFAULT FALSE,
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 既存テーブル拡張: `lifelog_highlights`

```sql
ALTER TABLE lifelog_highlights
  ADD COLUMN status TEXT DEFAULT 'pending_review',
  ADD COLUMN notified_at TIMESTAMPTZ,
  ADD COLUMN reviewed_at TIMESTAMPTZ;
```

## Phase 6への引き継ぎ事項

**実装ファイル**:
- `src/services/phi-detector.ts` - PHI検出エンジン（正規表現ベース）
- `src/services/phi-detector.test.ts` - PHI検出テスト（統合テスト含む）
- `src/services/reflection-notifier.ts` - 通知システム
- `src/services/reflection-notifier.test.ts` - 通知テスト
- `src/handlers/limitless-reflection.ts` - 振り返りAPI
- `src/handlers/scheduled-reflection.ts` - Cron通知ハンドラ
- `src/handlers/scheduled-digest.ts` - Cron統合（修正済み）

**改善項目**:
1. **Workers AI統合** - 正規表現 → Workers AI PHI検出（精度向上）
2. **PWA Push通知** - Discord/Slack → PWA通知追加
3. **E2Eテスト** - 完全なワークフローテスト（Supabase + Webhook統合）
4. **Notification mocks** - response.text()等のモック構造改善

**アーキテクチャ決定**:
- Regex-based MVP（Phase 5）→ Workers AI（Phase 6）の段階的移行
- 人間介入必須の設計維持（Notify → Question → Review）
- 24-48時間窓での通知（48時間以上古いハイライトは通知しない）

## 成功基準

| 指標 | 目標値 | Phase 5結果 |
|------|--------|------------|
| 振り返り記入率 | 70%+ | 要検証（運用開始後） |
| PHI検出率 | 95%+ | 要検証（Workers AI移行後） |
| 通知応答時間 | 48時間以内 | ✅ 24-48時間窓で実装 |
| データ削除対応 | 24時間以内（GDPR） | ✅ Supabase RLS設定済み |

## 関連ファイル

- **サービス層**: `src/services/limitless.ts` (697行)
- **ハイライト機能**: `src/handlers/limitless-highlight.ts` (332行)
- **Webhook**: `src/handlers/limitless-webhook.ts` (358行)
- **マイグレーション**: `supabase/migrations/0010_lifelog_highlights.sql`
- **Dashboard**: `limitless-dashboard.html`
- **設定例**: `~/Desktop/limitless-highlight-shortcut.json`

## GitHub Issue

詳細設計: https://github.com/cursorvers/cloudflare-workers-hub/issues/1

---

## 運用改善タスク (2026-01-29 オーケストレーションレビュー)

> 401 エラー対応 + KV 最適化のレビュー結果から抽出

### 最新レビュー結果 (2026-01-29 22:47 JST)

**スコア: 6/10 (FIX_RECOMMENDED)**

| レビュアー | スコア | 主要指摘 |
|-----------|--------|---------|
| Codex code-reviewer | 4/7 | インメモリ rate-limiter の分散環境問題 |
| Codex security-analyst | 2/3 | ASSISTANT_API_KEY スコープ拡大リスク |

### アーキテクチャ懸念

| 課題 | 説明 | 対応方針 |
|------|------|---------|
| 所有権境界の曖昧さ | 認証ロジックは QUEUE_API_KEY 優先、Daemon は ASSISTANT_API_KEY を送信 | ドキュメント明確化 |
| ポリシー強制層の欠如 | 新クライアントが誤設定 → queue エンドポイントをスパム可能 | Paid 移行時に検討 |
| wrangler CLI 直接管理 | 集中監査なし → サイレントドリフトのリスク | シークレット一覧作成 |
| Slack 依存の可視性 | 構造化モニタリングなし → インシデント対応がスケールしない | Observability 検討 |
| **rate-limiter 分散問題** | インメモリのみ → 複数インスタンスで制限共有なし | **Free プランでは1インスタンス、問題なし** |
| **ASSISTANT_API_KEY スコープ** | 非admin全スコープで有効 → 権限拡大リスク | **運用注意、将来的にスコープ制限** |

### 改善タスク

**Paid プラン移行時（優先度: 高）**
- [ ] **rate-limiter ハイブリッド方式**: インメモリ + KV 低頻度同期
- [ ] **ASSISTANT_API_KEY スコープ制限**: 明示的なフラグまたはスコープ別設定
- [ ] **スライディングウィンドウ統一**: 固定ウィンドウからリングバッファ方式へ

**継続（優先度: 中）**
- [ ] **シークレット一覧作成**: Workers/Daemon/CI 横断でインベントリ化
- [ ] **ドリフト検出ジョブ**: 夜間に Worker シークレットとレジストリの整合性チェック
- [ ] **アラート重複排除**: Slack パイプラインにレート制限/重複排除を追加
- [ ] **Runbook 作成**: Daemon 起因トラフィック用の対応手順書
- [ ] **合成ヘルスチェック**: QUEUE_API_KEY / ASSISTANT_API_KEY 両方でテスト

### 推奨アーキテクチャ: Central Secret Authority

```
Secret Authority (1Password/Vault)
       │ provision
       ├────────────────┐
       ▼                ▼
Cloudflare Worker   Mac Mini Daemon
       ▲                │
       └── X-API-Key ───┘
```

**理由**: シークレットドリフトを根本的に防止、監査証跡が明確、スケール可能

## 成功基準

- [x] スマホから Git 状態を確認できる ✅
- [x] 移動中にタスク実行指示ができる ✅ (Commit/Push/Pull ボタン)
- [x] 1つの画面で全体を俯瞰できる ✅
- [x] 未コミット/未プッシュを見逃さない ✅ (リアルタイム更新)

## 監視対象リポジトリ

```json
["~/Dev/cloudflare-workers-hub", "~/Dev/ai-assistant-daemon", "~/Dev/note-manuscript-review", "~/Desktop/skills"]
```

---

## アーカイブ

完了タスクの詳細は `docs/ARCHIVE_2026-01-25.md` を参照。

| 日付 | 内容 |
|------|------|
| 2026-01-30 | cockpit-pwa アクセシビリティ修正(WCAG AA), Agentic Vision テスト完了 |
| 2026-01-29 | MVP完成(82%), KV最適化(put/read), Agentic Vision統合, オーケストレーションレビュー(6/10) |
| 2026-01-25 | IDOR修正, index.ts分割, Critical/High/Medium問題修正 |
