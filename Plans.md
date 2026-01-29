# Cloudflare Workers Hub - Plans

## 概要
オーケストレーションレビュー結果: **8.35/10 READY** (2026-01-25)

## デプロイ情報
- URL: https://orchestrator-hub.masa-stage1.workers.dev
- Version ID: f033646c-74b6-4506-b0ac-c79472fca6b3

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

## 実装状況 (2026-01-28)

| Phase | 状態 | 主要ファイル |
|-------|------|-------------|
| 1. 基盤構築 | ✅ DONE | `migrations/0005_cockpit_tables.sql`, `cockpit-api.ts`, `cockpit-websocket.ts`, `local-agent/` |
| 2. Git Dashboard | ✅ DONE | `git-dashboard.tsx` |
| 3. Kanban MVP | ✅ DONE | `task-kanban.tsx` |
| 4. Command Center | ✅ DONE | `command-center.tsx` |
| 5. リアルタイム | ✅ DONE | `CockpitWebSocket` DO |
| PWA Frontend | ✅ DONE | `/Users/masayuki/cockpit-pwa/` |

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

- [x] Local Agent の API キー設定 ✅ (2026-01-29)
- [x] WebSocket 認証修正 ✅ (2026-01-29) - クエリパラメータ方式
- [x] タスク実行機能 (Commit/Push/Pull) ✅ (2026-01-29)
- [x] 承認ワークフロー UI ✅ (2026-01-29) - approval-modal.tsx
- [x] Web Push 通知 ✅ (2026-01-29) - sw.js, push-notifications.ts
- [x] JWT 詳細検証 ✅ (2026-01-29) - jwt-auth.ts, jose library
- [x] RBAC 導入 ✅ (2026-01-29) - 3ロール (admin/operator/viewer)
- [x] 401 エラー対応 ✅ (2026-01-29) - QUEUE_API_KEY 設定修正
- [ ] Cloudflare Access 設定 (オプション)
- [ ] Cloudflare Tunnel 設定 (オプション)

---

## 運用改善タスク (2026-01-29 オーケストレーションレビュー)

> 401 エラー対応のレビュー結果から抽出

### アーキテクチャ懸念

| 課題 | 説明 |
|------|------|
| 所有権境界の曖昧さ | 認証ロジックは QUEUE_API_KEY 優先、Daemon は ASSISTANT_API_KEY を送信 |
| ポリシー強制層の欠如 | 新クライアントが誤設定 → queue エンドポイントをスパム可能 |
| wrangler CLI 直接管理 | 集中監査なし → サイレントドリフトのリスク |
| Slack 依存の可視性 | 構造化モニタリングなし → インシデント対応がスケールしない |

### 改善タスク

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
| 2026-01-25 | IDOR修正, index.ts分割, Daemon Health API, KV Prefix Scan移行, Critical/High/Medium問題修正 |
