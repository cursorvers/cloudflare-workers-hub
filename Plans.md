# Cloudflare Workers Hub - Plans

## 概要
**MVP 完成: 82% (2026-01-29)** - 保守モード移行
オーケストレーションレビュー結果: **8.35/10 READY** (2026-01-25)

## デプロイ情報
- URL: https://orchestrator-hub.masa-stage1.workers.dev
- Version ID: 5a33bb54-aa97-48cf-a2da-4207b36b717c (2026-01-29)

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

### 完了済み (最新5件、詳細は docs/ARCHIVE_2026-01-25.md)
- [x] **cockpit-pwa アクセシビリティ修正** ✅ (2026-01-30) - WCAG AA 準拠 (コントラスト 4.5:1+, タップターゲット 44px+)
- [x] **Agentic Vision テスト** ✅ (2026-01-30) - Gemini 3 Flash Code Execution で UI 検証動作確認
- [x] **KV put 超過対応** ✅ (2026-01-29) - rate-limiter をインメモリ優先に変更 (KV put 99%削減)
- [x] **KV 最適化** ✅ (2026-01-29) - WebSocket 再接続間隔 5秒→15秒 (KV read 66%削減)
- [x] **401 エラー根本修正** ✅ (2026-01-29) - 複数キー認証対応

### 未完了（オプション）
- [ ] Cloudflare Tunnel 設定 - NAT 越え接続（外部ネットワークからアクセス時に必要）
- [ ] PWA 機能拡張 - タスク一覧、Daemon 状態表示
- [ ] Push 通知統合 - VAPID 設定済み、フロントエンド連携待ち
- [ ] Observability ダッシュボード - コスト/レイテンシ表示
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
